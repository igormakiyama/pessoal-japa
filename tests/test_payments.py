from datetime import timedelta

from conftest import CHILD_FORM, outbox

from historinhas import payments, services
from historinhas.db import iso, parse, utcnow


def make_order(conn, env, plan="mensal"):
    child = {"name": "Lia", "age": 4, "gender": "menina", "appearance": {}, "interests": [], "interests_extra": "",
             "themes": [], "pet_type": "", "pet_name": ""}
    _, sub_id = services.create_signup(conn, "pai@example.com", "Carlos", child)
    order, _ = services.create_order(conn, sub_id, plan)
    return order, sub_id


def test_apply_payment_is_idempotent(conn, env):
    order, sub_id = make_order(conn, env)
    assert services.apply_payment(conn, order["token"], "1", "approved", 2490) == "activated"
    first = conn.execute("SELECT paid_until FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()[0]
    assert services.apply_payment(conn, order["token"], "1", "approved", 2490) == "ignored"
    assert conn.execute("SELECT paid_until FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()[0] == first
    assert len([m for m in outbox(env) if "Bem-vindo" in m]) == 1


def test_lower_amount_is_refused(conn, env):
    order, sub_id = make_order(conn, env)
    assert services.apply_payment(conn, order["token"], "1", "approved", 100) == "amount_mismatch"
    assert conn.execute("SELECT status FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()[0] == "pending"


def test_refund_removes_paid_days(conn, env):
    order, sub_id = make_order(conn, env)
    services.apply_payment(conn, order["token"], "1", "approved", 2490)
    assert services.apply_payment(conn, order["token"], "1", "refunded", 2490) == "refunded"
    sub = conn.execute("SELECT * FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()
    assert sub["status"] == "expired"


def test_renewal_extends_from_current_end(conn, env):
    order, sub_id = make_order(conn, env)
    services.apply_payment(conn, order["token"], "1", "approved", 2490)
    end1 = parse(conn.execute("SELECT paid_until FROM subscriptions").fetchone()[0])
    order2, _ = services.create_order(conn, sub_id, "trimestral")
    services.apply_payment(conn, order2["token"], "2", "approved", 5990)
    end2 = parse(conn.execute("SELECT paid_until FROM subscriptions").fetchone()[0])
    assert (end2 - end1).days == 90


def test_webhook_refetches_payment_from_api(client, conn, env, monkeypatch):
    order, sub_id = make_order(conn, env)
    seen = []

    def fake_fetch(payment_id):
        seen.append(payment_id)
        return {"id": int(payment_id), "status": "approved", "external_reference": order["token"],
                "transaction_amount": 24.90}

    monkeypatch.setattr(payments, "fetch_payment", fake_fetch)
    # Corpo forjado dizendo "approved" não importa: o que vale é a consulta à API.
    resp = client.post("/webhooks/mercadopago?data.id=123&type=payment",
                       json={"type": "payment", "data": {"id": "123"}, "status": "approved"})
    assert resp.status_code == 200 and seen == ["123"]
    assert conn.execute("SELECT status FROM subscriptions").fetchone()[0] == "active"
    assert client.post("/webhooks/mercadopago", json={"type": "merchant_order", "data": {"id": "9"}}).json()["ignored"]


def test_mercadopago_checkout_payload(conn, env, monkeypatch):
    monkeypatch.setattr(env, "payment_provider", "mercadopago")
    monkeypatch.setattr(env, "mp_access_token", "TEST-123")
    sent = {}

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"id": "pref-1", "init_point": "https://mp/checkout"}

    def fake_post(url, json, headers, timeout):
        sent.update(url=url, json=json, headers=headers)
        return Resp()

    monkeypatch.setattr(payments.httpx, "post", fake_post)
    order, _ = make_order(conn, env, "anual")
    assert sent["json"]["items"][0]["unit_price"] == 199.9
    assert sent["json"]["external_reference"] == order["token"]
    assert sent["json"]["notification_url"].endswith("/webhooks/mercadopago")
    assert sent["headers"]["Authorization"] == "Bearer TEST-123"
    assert conn.execute("SELECT provider_ref FROM orders").fetchone()[0] == "pref-1"


def test_reminder_once_then_expire(conn, env):
    order, sub_id = make_order(conn, env)
    services.apply_payment(conn, order["token"], "1", "approved", 2490)
    conn.execute("UPDATE subscriptions SET paid_until = ?", (iso(utcnow() + timedelta(days=2)),))
    services.expire_and_remind(conn)
    services.expire_and_remind(conn)
    assert len([m for m in outbox(env) if "acabam em breve" in m]) == 1

    conn.execute("UPDATE subscriptions SET paid_until = ?", (iso(utcnow() - timedelta(minutes=1)),))
    services.expire_and_remind(conn)
    assert conn.execute("SELECT status FROM subscriptions").fetchone()[0] == "expired"
    assert any("Sentimos sua falta" in m for m in outbox(env))
    assert services.schedule_due_stories(conn) == 0


def test_child_form_fixture_is_valid():
    from historinhas.web import parse_child_form

    class Form(dict):
        def getlist(self, key):
            value = self.get(key, [])
            return value if isinstance(value, list) else [value]

    child, errors = parse_child_form(Form(CHILD_FORM))
    assert errors == []
    assert child["appearance"]["glasses"] is True
    assert child["themes"] == ["coragem", "amizade"]
