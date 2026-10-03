"""Regras do negócio, usadas pelo site e pelo worker."""

import json
import logging
import sqlite3
from datetime import timedelta

from . import mailer, payments
from .config import settings
from .db import iso, kv_get, kv_set, new_token, now_iso, parse, plus_days, utcnow
from .pipeline import remove_story_files

log = logging.getLogger(__name__)


# ---------------------------------------------------------------- cadastro e pedidos

def get_or_create_customer(conn: sqlite3.Connection, email: str, parent_name: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM customers WHERE email = ? AND deleted_at IS NULL", (email,)).fetchone()
    if row:
        return row
    conn.execute(
        "INSERT INTO customers(email, parent_name, token, consent_at, created_at) VALUES(?, ?, ?, ?, ?)",
        (email, parent_name, new_token(), now_iso(), now_iso()),
    )
    return conn.execute("SELECT * FROM customers WHERE email = ?", (email,)).fetchone()


def create_child(conn: sqlite3.Connection, customer_id: int, child: dict) -> int:
    cur = conn.execute(
        "INSERT INTO children(customer_id, name, age, gender, appearance_json, interests_json, interests_extra, "
        "themes_json, pet_type, pet_name, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (customer_id, child["name"], child["age"], child["gender"], json.dumps(child["appearance"]),
         json.dumps(child["interests"], ensure_ascii=False), child["interests_extra"],
         json.dumps(child["themes"]), child["pet_type"], child["pet_name"], now_iso(), now_iso()),
    )
    return cur.lastrowid


def update_child(conn: sqlite3.Connection, child_id: int, child: dict) -> None:
    conn.execute(
        "UPDATE children SET name = ?, age = ?, gender = ?, appearance_json = ?, interests_json = ?, "
        "interests_extra = ?, themes_json = ?, pet_type = ?, pet_name = ?, updated_at = ? WHERE id = ?",
        (child["name"], child["age"], child["gender"], json.dumps(child["appearance"]),
         json.dumps(child["interests"], ensure_ascii=False), child["interests_extra"],
         json.dumps(child["themes"]), child["pet_type"], child["pet_name"], now_iso(), child_id),
    )


def create_signup(conn: sqlite3.Connection, email: str, parent_name: str, child: dict) -> tuple[sqlite3.Row, int]:
    """Cria cliente (se novo), criança e assinatura pendente. Devolve (cliente, id_assinatura)."""
    customer = get_or_create_customer(conn, email, parent_name)
    child_id = create_child(conn, customer["id"], child)
    cur = conn.execute(
        "INSERT INTO subscriptions(customer_id, child_id, status, created_at) VALUES(?, ?, 'pending', ?)",
        (customer["id"], child_id, now_iso()),
    )
    return customer, cur.lastrowid


def create_order(conn: sqlite3.Connection, subscription_id: int, plan_key: str) -> tuple[sqlite3.Row, str]:
    """Cria o pedido e o checkout. Devolve (pedido, url_do_checkout)."""
    plan = settings.plans()[plan_key]
    token = new_token()
    conn.execute(
        "INSERT INTO orders(token, subscription_id, plan, days, amount_cents, provider, created_at) "
        "VALUES(?, ?, ?, ?, ?, ?, ?)",
        (token, subscription_id, plan_key, plan["days"], plan["price_cents"], settings.payment_provider, now_iso()),
    )
    order = conn.execute("SELECT * FROM orders WHERE token = ?", (token,)).fetchone()
    customer = conn.execute(
        "SELECT c.* FROM customers c JOIN subscriptions s ON s.customer_id = c.id WHERE s.id = ?",
        (subscription_id,),
    ).fetchone()
    url, ref = payments.create_checkout(dict(order), dict(customer), plan)
    if ref:
        conn.execute("UPDATE orders SET provider_ref = ? WHERE id = ?", (ref, order["id"]))
    return order, url


def apply_payment(conn: sqlite3.Connection, order_token: str, payment_id: str, status: str, amount_cents: int) -> str:
    """Aplica o status de um pagamento ao pedido. Idempotente (o mesmo aviso pode chegar várias vezes)."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        outcome, order_id, first = _apply_payment_locked(conn, order_token, payment_id, status, amount_cents)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    if outcome == "activated":
        _send_payment_confirmation(conn, order_id, first=first)
    return outcome


def _apply_payment_locked(conn, order_token, payment_id, status, amount_cents) -> tuple[str, int | None, bool]:
    order = conn.execute("SELECT * FROM orders WHERE token = ?", (order_token,)).fetchone()
    if not order:
        log.warning("Pagamento %s com referência desconhecida: %s", payment_id, order_token)
        return "unknown_order", None, False
    sub = conn.execute("SELECT * FROM subscriptions WHERE id = ?", (order["subscription_id"],)).fetchone()

    if status == "approved" and order["status"] in ("pending", "rejected"):
        if amount_cents + 1 < order["amount_cents"]:
            log.error("Pagamento %s com valor menor que o pedido %s", payment_id, order_token)
            return "amount_mismatch", order["id"], False
        conn.execute(
            "UPDATE orders SET status = 'approved', payment_id = ?, paid_at = ? WHERE id = ?",
            (payment_id, now_iso(), order["id"]),
        )
        now = utcnow()
        current = parse(sub["paid_until"])
        base = current if current and current > now else now
        was_active = sub["status"] == "active"
        next_story = sub["next_story_at"] if was_active and sub["next_story_at"] else iso(now)
        conn.execute(
            "UPDATE subscriptions SET status = 'active', paid_until = ?, next_story_at = ?, "
            "expired_notice_sent = 0, reminders_enabled = 1 WHERE id = ?",
            (plus_days(order["days"], base), next_story, sub["id"]),
        )
        return "activated", order["id"], not was_active

    if status == "refunded" and order["status"] == "approved":
        conn.execute("UPDATE orders SET status = 'refunded' WHERE id = ?", (order["id"],))
        paid_until = parse(sub["paid_until"]) - timedelta(days=order["days"])
        new_status = "active" if paid_until > utcnow() else "expired"
        conn.execute(
            "UPDATE subscriptions SET paid_until = ?, status = ?, expired_notice_sent = 1 WHERE id = ?",
            (iso(paid_until), new_status, sub["id"]),
        )
        log.info("Pedido %s reembolsado; assinatura %s agora %s", order_token, sub["id"], new_status)
        return "refunded", order["id"], False

    if status == "rejected" and order["status"] == "pending":
        conn.execute("UPDATE orders SET status = 'rejected' WHERE id = ?", (order["id"],))
        return "rejected", order["id"], False
    return "ignored", order["id"], False


def _send_payment_confirmation(conn: sqlite3.Connection, order_id: int, first: bool) -> None:
    row = conn.execute(
        "SELECT c.email, c.parent_name, c.token AS customer_token, ch.name AS child_name, s.paid_until, o.plan "
        "FROM orders o JOIN subscriptions s ON s.id = o.subscription_id JOIN customers c ON c.id = s.customer_id "
        "JOIN children ch ON ch.id = s.child_id WHERE o.id = ?",
        (order_id,),
    ).fetchone()
    subject = (f"Bem-vindo(a)! A primeira história de {row['child_name']} já está sendo escrita"
               if first else f"Assinatura renovada: mais histórias para {row['child_name']}")
    try:
        mailer.send_template(row["email"], subject, "pagamento_confirmado", row=row, first=first,
                             account_url=f"{settings.base_url}/conta/{row['customer_token']}")
    except Exception:
        log.exception("Falha ao enviar confirmação de pagamento")


def reconcile_pending_orders(conn: sqlite3.Connection) -> None:
    """Rede de segurança caso algum webhook do Mercado Pago se perca."""
    if settings.payment_provider != "mercadopago":
        return
    since = plus_days(-3)
    for order in conn.execute("SELECT token FROM orders WHERE status = 'pending' AND created_at > ?", (since,)).fetchall():
        try:
            for payment in payments.search_payments(order["token"]):
                info = payments.normalize(payment)
                apply_payment(conn, order["token"], info["payment_id"], info["status"], info["amount_cents"])
        except Exception:
            log.exception("Falha ao conciliar pedido %s", order["token"])


# ---------------------------------------------------------------- rotina do worker

def schedule_due_stories(conn: sqlite3.Connection) -> int:
    """Coloca na fila as histórias das assinaturas ativas que chegaram na data."""
    now = utcnow()
    created = 0
    due = conn.execute(
        "SELECT * FROM subscriptions WHERE status = 'active' AND next_story_at <= ? AND paid_until > ?",
        (iso(now), iso(now)),
    ).fetchall()
    for sub in due:
        busy = conn.execute(
            "SELECT 1 FROM stories WHERE subscription_id = ? AND status IN ('queued', 'generating')", (sub["id"],)
        ).fetchone()
        if busy:
            continue
        conn.execute(
            "INSERT INTO stories(token, subscription_id, child_id, created_at) VALUES(?, ?, ?, ?)",
            (new_token(), sub["id"], sub["child_id"], now_iso()),
        )
        nxt = parse(sub["next_story_at"])
        while nxt <= now:
            nxt += timedelta(days=settings.story_interval_days)
        conn.execute("UPDATE subscriptions SET next_story_at = ? WHERE id = ?", (iso(nxt), sub["id"]))
        created += 1
    return created


def recover_and_retry(conn: sqlite3.Connection) -> None:
    """Destrava histórias presas (worker reiniciado) e tenta de novo as que falharam."""
    conn.execute(
        "UPDATE stories SET status = 'queued' WHERE status = 'generating' AND started_at < ?",
        (iso(utcnow() - timedelta(hours=1)),),
    )
    conn.execute(
        "UPDATE stories SET status = 'queued' WHERE status = 'failed' AND attempts < 3 AND started_at < ?",
        (iso(utcnow() - timedelta(minutes=20)),),
    )


def next_queued_story(conn: sqlite3.Connection) -> int | None:
    row = conn.execute("SELECT id FROM stories WHERE status = 'queued' ORDER BY id LIMIT 1").fetchone()
    return row["id"] if row else None


def notify_ready_stories(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT st.id, st.token, st.title, st.summary, ch.name AS child_name, c.email, c.token AS customer_token "
        "FROM stories st JOIN children ch ON ch.id = st.child_id JOIN subscriptions s ON s.id = st.subscription_id "
        "JOIN customers c ON c.id = s.customer_id WHERE st.status = 'ready' AND st.emailed_at IS NULL"
    ).fetchall()
    for row in rows:
        try:
            mailer.send_template(
                row["email"], f"Nova história para {row['child_name']}: {row['title']}", "historia_pronta",
                row=row, story_url=f"{settings.base_url}/h/{row['token']}",
                account_url=f"{settings.base_url}/conta/{row['customer_token']}",
            )
        except Exception:
            log.exception("Falha ao enviar e-mail da história %s", row["id"])
            continue
        conn.execute("UPDATE stories SET emailed_at = ? WHERE id = ?", (now_iso(), row["id"]))


def alert_admin_failures(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT id, error FROM stories WHERE status = 'failed' AND attempts >= 3 AND admin_alerted = 0"
    ).fetchall()
    if not rows:
        return
    if settings.admin_email:
        try:
            mailer.send_template(settings.admin_email, f"[{settings.site_name}] {len(rows)} história(s) falharam",
                                 "alerta_admin", rows=rows, admin_url=f"{settings.base_url}/admin")
        except Exception:
            log.exception("Falha ao enviar alerta ao admin")
            return
    conn.execute(f"UPDATE stories SET admin_alerted = 1 WHERE id IN ({','.join(str(r['id']) for r in rows)})")


def expire_and_remind(conn: sqlite3.Connection) -> None:
    now = utcnow()
    # Lembrete de renovação alguns dias antes de vencer (uma vez por vencimento)
    limit = iso(now + timedelta(days=settings.renewal_reminder_days))
    rows = conn.execute(
        "SELECT s.id, s.paid_until, c.email, c.token AS customer_token, ch.name AS child_name "
        "FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN children ch ON ch.id = s.child_id "
        "WHERE s.status = 'active' AND s.reminders_enabled = 1 AND s.paid_until <= ? "
        "AND (s.reminder_sent_for IS NULL OR s.reminder_sent_for != s.paid_until)",
        (limit,),
    ).fetchall()
    for row in rows:
        try:
            mailer.send_template(
                row["email"], f"As histórias de {row['child_name']} acabam em breve", "lembrete_renovacao",
                row=row, account_url=f"{settings.base_url}/conta/{row['customer_token']}#renovar",
            )
        except Exception:
            log.exception("Falha ao enviar lembrete de renovação")
            continue
        conn.execute("UPDATE subscriptions SET reminder_sent_for = paid_until WHERE id = ?", (row["id"],))

    # Expira o que venceu
    rows = conn.execute(
        "SELECT s.id, s.reminders_enabled, c.email, c.token AS customer_token, ch.name AS child_name "
        "FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN children ch ON ch.id = s.child_id "
        "WHERE s.status = 'active' AND s.paid_until <= ?",
        (iso(now),),
    ).fetchall()
    for row in rows:
        conn.execute("UPDATE subscriptions SET status = 'expired', expired_notice_sent = 1 WHERE id = ?", (row["id"],))
        if not row["reminders_enabled"]:
            continue
        try:
            mailer.send_template(
                row["email"], f"Sentimos sua falta! Renove as histórias de {row['child_name']}", "plano_expirou",
                row=row, account_url=f"{settings.base_url}/conta/{row['customer_token']}#renovar",
            )
        except Exception:
            log.exception("Falha ao enviar aviso de expiração")


def run_periodic(conn: sqlite3.Connection, key: str, every_seconds: int, fn) -> None:
    """Executa fn no máximo uma vez a cada every_seconds (controle salvo no banco)."""
    last = parse(kv_get(conn, key) or None)
    if last and (utcnow() - last).total_seconds() < every_seconds:
        return
    kv_set(conn, key, now_iso())
    fn(conn)


# ---------------------------------------------------------------- área do cliente e LGPD

def customer_subscriptions(conn: sqlite3.Connection, customer_id: int) -> list[dict]:
    subs = conn.execute(
        "SELECT s.*, ch.name AS child_name, ch.appearance_json, ch.pet_type FROM subscriptions s "
        "JOIN children ch ON ch.id = s.child_id WHERE s.customer_id = ? AND s.status != 'pending' ORDER BY s.id",
        (customer_id,),
    ).fetchall()
    result = []
    for sub in subs:
        item = dict(sub)
        item["appearance"] = json.loads(item.pop("appearance_json"))
        item["stories"] = [dict(r) for r in conn.execute(
            "SELECT id, token, title, summary, status, ready_at, has_audio, has_pdf FROM stories "
            "WHERE subscription_id = ? AND status IN ('ready', 'queued', 'generating', 'failed') ORDER BY id DESC",
            (sub["id"],),
        ).fetchall()]
        result.append(item)
    return result


def delete_customer_data(conn: sqlite3.Connection, customer_id: int) -> None:
    """Apaga os dados pessoais (LGPD). Pedidos ficam anonimizados para fins fiscais."""
    story_ids = [r["id"] for r in conn.execute(
        "SELECT st.id FROM stories st JOIN subscriptions s ON s.id = st.subscription_id WHERE s.customer_id = ?",
        (customer_id,),
    ).fetchall()]
    for story_id in story_ids:
        remove_story_files(story_id)
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "DELETE FROM stories WHERE subscription_id IN (SELECT id FROM subscriptions WHERE customer_id = ?)",
            (customer_id,),
        )
        conn.execute("UPDATE subscriptions SET status = 'canceled', reminders_enabled = 0 WHERE customer_id = ?",
                     (customer_id,))
        conn.execute(
            "UPDATE children SET name = 'apagado', appearance_json = '{}', interests_json = '[]', interests_extra = '', "
            "themes_json = '[]', pet_name = '' WHERE customer_id = ?",
            (customer_id,),
        )
        conn.execute(
            "UPDATE customers SET email = 'apagado-' || id || '@invalid', parent_name = 'apagado', token = ?, "
            "deleted_at = ? WHERE id = ?",
            (new_token(), now_iso(), customer_id),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def dashboard_stats(conn: sqlite3.Connection) -> dict:
    now = iso(utcnow())
    month_ago = plus_days(-30)
    one = lambda sql, *args: conn.execute(sql, args).fetchone()[0]  # noqa: E731
    return {
        "active": one("SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND paid_until > ?", now),
        "expired": one("SELECT COUNT(*) FROM subscriptions WHERE status = 'expired'"),
        "revenue_30d": one("SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE status = 'approved' AND paid_at > ?",
                           month_ago),
        "orders_30d": one("SELECT COUNT(*) FROM orders WHERE status = 'approved' AND paid_at > ?", month_ago),
        "stories_ready": one("SELECT COUNT(*) FROM stories WHERE status = 'ready'"),
        "stories_queued": one("SELECT COUNT(*) FROM stories WHERE status IN ('queued', 'generating')"),
        "stories_failed": one("SELECT COUNT(*) FROM stories WHERE status = 'failed'"),
        "worker_heartbeat": kv_get(conn, "worker_heartbeat"),
    }
