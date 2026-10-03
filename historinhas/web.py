"""Site: página de vendas, cadastro, checkout, área do cliente, histórias e painel admin.

Rodar: uvicorn historinhas.web:app
"""

import json
import logging
import re
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles

from . import mailer, payments, services
from .config import settings
from .content import (
    DEFAULT_APPEARANCE, EYE_COLORS, FAVORITE_COLORS, GENDERS, HAIR_COLORS, HAIR_STYLES, INTERESTS, LABELS, PETS,
    SAMPLE_CHILD, SAMPLE_STORY, SKIN_TONES, THEMES,
)
from .db import child_dict, connect, init_db, kv_get, now_iso, parse, utcnow
from .illustrate import avatar_svg, scene_svg
from .pipeline import story_dir
from .templating import env

log = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(_app):
    init_db()
    yield


app = FastAPI(title=settings.site_name, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")
security = HTTPBasic(auto_error=False)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$")
NAME_RE = re.compile(r"^[A-Za-zÀ-ÿ' -]{2,40}$")


def get_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def page(request: Request, template: str, status_code: int = 200, **context) -> HTMLResponse:
    html = env.get_template(template).render(request=request, **context)
    return HTMLResponse(html, status_code=status_code)


def message(request: Request, title: str, text: str, status_code: int = 200, link: tuple | None = None):
    return page(request, "mensagem.html", status_code=status_code, title=title, text=text, link=link)


# ---------------------------------------------------------------- proteção básica

_hits: dict[str, deque] = defaultdict(deque)


def rate_limited(request: Request, bucket: str, limit: int = 10, window: int = 3600) -> bool:
    """Limite simples por IP, em memória (evita spam de cadastro e de e-mails)."""
    key = f"{bucket}:{request.client.host if request.client else '-'}"
    now = time.time()
    hits = _hits[key]
    while hits and hits[0] < now - window:
        hits.popleft()
    if len(hits) >= limit:
        return True
    hits.append(now)
    return False


@app.middleware("http")
async def same_origin_posts(request: Request, call_next):
    """Bloqueia formulários enviados por outros sites (CSRF). O webhook fica de fora."""
    if request.method == "POST" and not request.url.path.startswith("/webhooks/"):
        origin = request.headers.get("origin")
        if origin and origin != "null" and urlparse(origin).netloc != request.headers.get("host"):
            return Response("Origem não permitida", status_code=403)
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def require_admin(credentials: HTTPBasicCredentials | None = Depends(security)) -> None:
    ok = (
        settings.admin_password
        and credentials
        and secrets.compare_digest(credentials.username.encode(), settings.admin_user.encode())
        and secrets.compare_digest(credentials.password.encode(), settings.admin_password.encode())
    )
    if not ok:
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Basic"})


# ---------------------------------------------------------------- formulário da criança

def form_options() -> dict:
    return {
        "genders": GENDERS, "skins": SKIN_TONES, "hair_colors": HAIR_COLORS, "hair_styles": HAIR_STYLES,
        "eye_colors": EYE_COLORS, "fav_colors": FAVORITE_COLORS, "pets": PETS, "interests": INTERESTS,
        "themes": THEMES, "labels": LABELS, "plans": settings.plans(),
    }


def parse_child_form(form) -> tuple[dict, list[str]]:
    errors = []
    name = " ".join(str(form.get("child_name", "")).split()).strip()
    if not NAME_RE.match(name):
        errors.append("Digite o nome (ou apelido) da criança, só com letras.")
    try:
        age = int(form.get("age", 0))
    except ValueError:
        age = 0
    if not 1 <= age <= 12:
        errors.append("A idade deve ser entre 1 e 12 anos.")

    def pick(field, options, default):
        value = str(form.get(field, default))
        return value if value in options else default

    appearance = {
        "skin": pick("skin", SKIN_TONES, DEFAULT_APPEARANCE["skin"]),
        "hair_color": pick("hair_color", HAIR_COLORS, DEFAULT_APPEARANCE["hair_color"]),
        "hair_style": pick("hair_style", HAIR_STYLES, DEFAULT_APPEARANCE["hair_style"]),
        "eyes": pick("eyes", EYE_COLORS, DEFAULT_APPEARANCE["eyes"]),
        "glasses": form.get("glasses") in ("1", "on", "true"),
        "fav_color": pick("fav_color", FAVORITE_COLORS, DEFAULT_APPEARANCE["fav_color"]),
    }
    pet_type = pick("pet_type", PETS, "")
    pet_name = " ".join(str(form.get("pet_name", "")).split())[:30]
    if pet_type and not pet_name:
        errors.append("Qual o nome do bichinho de estimação?")
    child = {
        "name": name,
        "age": age,
        "gender": pick("gender", GENDERS, "neutro"),
        "appearance": appearance,
        "interests": [i for i in form.getlist("interests") if i in INTERESTS][:5],
        "interests_extra": " ".join(str(form.get("interests_extra", "")).split())[:200],
        "themes": [t for t in form.getlist("themes") if t in THEMES][:4],
        "pet_type": pet_type,
        "pet_name": pet_name if pet_type else "",
    }
    return child, errors


# ---------------------------------------------------------------- páginas públicas

def _sample_scenes() -> list[str]:
    return [
        scene_svg(s["cenario"], s["noite"], SAMPLE_CHILD["appearance"], SAMPLE_CHILD["pet_type"], seed=f"exemplo-{i}")
        for i, s in enumerate(SAMPLE_STORY["cenas"])
    ]


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return page(request, "index.html", sample=SAMPLE_STORY, sample_scenes=_sample_scenes(), plans=settings.plans())


@app.get("/exemplo", response_class=HTMLResponse)
def example(request: Request):
    return page(request, "historia.html", story=SAMPLE_STORY, scenes=_sample_scenes(), child_name=SAMPLE_CHILD["name"],
                audio_url=None, pdf_url=None, is_sample=True)


@app.get("/avatar.svg")
def avatar_preview(request: Request):
    child, _ = parse_child_form(request.query_params)
    svg = avatar_svg(child["appearance"], child["pet_type"])
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/privacidade", response_class=HTMLResponse)
def privacy(request: Request):
    return page(request, "privacidade.html")


@app.get("/termos", response_class=HTMLResponse)
def terms(request: Request):
    return page(request, "termos.html")


@app.get("/saude")
def health(conn=Depends(get_db)):
    heartbeat = parse(kv_get(conn, "worker_heartbeat") or None)
    worker_ok = bool(heartbeat and (utcnow() - heartbeat).total_seconds() < 1800)
    return JSONResponse({"web": "ok", "worker": "ok" if worker_ok else "sem sinal"})


# ---------------------------------------------------------------- assinatura e checkout

@app.get("/assinar", response_class=HTMLResponse)
def signup_form(request: Request, plano: str = "mensal"):
    plan = plano if plano in settings.plans() else "mensal"
    return page(request, "assinar.html", values={"plan": plan, "appearance": DEFAULT_APPEARANCE}, errors=[],
                **form_options())


@app.post("/assinar", response_class=HTMLResponse)
async def signup_submit(request: Request, conn=Depends(get_db)):
    form = await request.form()
    child, errors = parse_child_form(form)
    email = str(form.get("email", "")).strip().lower()
    parent_name = " ".join(str(form.get("parent_name", "")).split())[:80]
    plan = str(form.get("plan", "mensal"))
    if not EMAIL_RE.match(email):
        errors.append("Digite um e-mail válido. É por ele que as histórias chegam.")
    if len(parent_name) < 2:
        errors.append("Digite seu nome.")
    if plan not in settings.plans():
        errors.append("Escolha um plano.")
    if not form.get("consent"):
        errors.append("É preciso aceitar os termos e autorizar o uso dos dados da criança para criar as histórias.")
    if errors:
        values = {**child, "email": email, "parent_name": parent_name, "plan": plan, "child_name": child["name"]}
        return page(request, "assinar.html", status_code=422, values=values, errors=errors, **form_options())
    if rate_limited(request, "signup"):
        return message(request, "Calma aí!", "Muitas tentativas seguidas. Tente de novo daqui a pouco.", 429)

    _, subscription_id = services.create_signup(conn, email, parent_name, child)
    try:
        _, url = services.create_order(conn, subscription_id, plan)
    except payments.PaymentError:
        log.exception("Falha ao criar checkout")
        return message(request, "Ops!", "Não conseguimos abrir o pagamento agora. Tente de novo em alguns minutos.", 502)
    return RedirectResponse(url, status_code=303)


@app.get("/checkout-teste/{token}", response_class=HTMLResponse)
def fake_checkout(request: Request, token: str, conn=Depends(get_db)):
    if settings.payment_provider != "fake":
        raise HTTPException(404)
    order = conn.execute("SELECT * FROM orders WHERE token = ?", (token,)).fetchone()
    if not order:
        raise HTTPException(404)
    return page(request, "checkout_teste.html", order=order, plan=settings.plans()[order["plan"]])


@app.post("/checkout-teste/{token}")
def fake_checkout_pay(token: str, conn=Depends(get_db)):
    if settings.payment_provider != "fake":
        raise HTTPException(404)
    order = conn.execute("SELECT * FROM orders WHERE token = ?", (token,)).fetchone()
    if not order:
        raise HTTPException(404)
    services.apply_payment(conn, token, f"teste-{order['id']}", "approved", order["amount_cents"])
    return RedirectResponse(f"/obrigado/{token}", status_code=303)


def _order_view(conn, token: str):
    return conn.execute(
        "SELECT o.*, c.token AS customer_token, ch.name AS child_name FROM orders o "
        "JOIN subscriptions s ON s.id = o.subscription_id JOIN customers c ON c.id = s.customer_id "
        "JOIN children ch ON ch.id = s.child_id WHERE o.token = ?",
        (token,),
    ).fetchone()


@app.get("/obrigado/{token}", response_class=HTMLResponse)
def thanks(request: Request, token: str, conn=Depends(get_db)):
    order = _order_view(conn, token)
    if not order:
        raise HTTPException(404)
    payment_id = request.query_params.get("payment_id", "")
    if order["status"] == "pending" and settings.payment_provider == "mercadopago" and payment_id.isdigit():
        # O cliente voltou do checkout antes do webhook chegar: consulta o pagamento direto na API.
        try:
            info = payments.normalize(payments.fetch_payment(payment_id))
            if info["order_token"] == token:
                services.apply_payment(conn, token, info["payment_id"], info["status"], info["amount_cents"])
                order = _order_view(conn, token)
        except Exception:
            log.exception("Falha ao consultar pagamento %s", payment_id)
    return page(request, "obrigado.html", order=order)


@app.post("/webhooks/mercadopago")
async def mercadopago_webhook(request: Request, conn=Depends(get_db)):
    """Aviso do Mercado Pago. Só usamos o ID: o pagamento é sempre reconsultado na API."""
    params = request.query_params
    try:
        body = await request.json()
    except Exception:
        body = {}
    topic = body.get("type") or params.get("type") or params.get("topic")
    payment_id = str((body.get("data") or {}).get("id") or params.get("data.id") or params.get("id") or "")
    if topic != "payment" or not payment_id.isdigit():
        return {"ok": True, "ignored": True}
    try:
        info = payments.normalize(payments.fetch_payment(payment_id))
    except Exception:
        log.exception("Falha ao consultar pagamento %s", payment_id)
        return JSONResponse({"ok": False}, status_code=500)  # o Mercado Pago tenta de novo
    outcome = services.apply_payment(conn, info["order_token"], info["payment_id"], info["status"], info["amount_cents"])
    log.info("Webhook pagamento %s (%s): %s", payment_id, info["status"], outcome)
    return {"ok": True}


# ---------------------------------------------------------------- área do cliente

def _customer(conn, token: str):
    customer = conn.execute("SELECT * FROM customers WHERE token = ? AND deleted_at IS NULL", (token,)).fetchone()
    if not customer:
        raise HTTPException(404)
    return customer


@app.get("/conta/{token}", response_class=HTMLResponse)
def account(request: Request, token: str, conn=Depends(get_db)):
    customer = _customer(conn, token)
    subs = services.customer_subscriptions(conn, customer["id"])
    for sub in subs:
        sub["avatar"] = avatar_svg(sub["appearance"], sub["pet_type"], size=160)
    return page(request, "conta.html", customer=customer, subs=subs, plans=settings.plans(), now=now_iso())


@app.post("/conta/{token}/renovar/{subscription_id}")
async def account_renew(request: Request, token: str, subscription_id: int, conn=Depends(get_db)):
    customer = _customer(conn, token)
    form = await request.form()
    plan = str(form.get("plan", "mensal"))
    sub = conn.execute("SELECT * FROM subscriptions WHERE id = ? AND customer_id = ?",
                       (subscription_id, customer["id"])).fetchone()
    if not sub or plan not in settings.plans() or sub["status"] == "canceled":
        raise HTTPException(404)
    try:
        _, url = services.create_order(conn, sub["id"], plan)
    except payments.PaymentError:
        log.exception("Falha ao criar checkout de renovação")
        return message(request, "Ops!", "Não conseguimos abrir o pagamento agora. Tente de novo em alguns minutos.", 502)
    return RedirectResponse(url, status_code=303)


@app.post("/conta/{token}/lembretes/{subscription_id}")
async def account_reminders(request: Request, token: str, subscription_id: int, conn=Depends(get_db)):
    customer = _customer(conn, token)
    form = await request.form()
    enabled = 1 if form.get("enabled") == "1" else 0
    conn.execute("UPDATE subscriptions SET reminders_enabled = ? WHERE id = ? AND customer_id = ?",
                 (enabled, subscription_id, customer["id"]))
    return RedirectResponse(f"/conta/{token}", status_code=303)


@app.get("/conta/{token}/editar/{child_id}", response_class=HTMLResponse)
def child_edit_form(request: Request, token: str, child_id: int, conn=Depends(get_db)):
    customer = _customer(conn, token)
    row = conn.execute("SELECT * FROM children WHERE id = ? AND customer_id = ?", (child_id, customer["id"])).fetchone()
    if not row:
        raise HTTPException(404)
    child = child_dict(row)
    values = {**child, "child_name": child["name"]}
    return page(request, "editar.html", customer=customer, child=child, values=values, errors=[], **form_options())


@app.post("/conta/{token}/editar/{child_id}", response_class=HTMLResponse)
async def child_edit_submit(request: Request, token: str, child_id: int, conn=Depends(get_db)):
    customer = _customer(conn, token)
    row = conn.execute("SELECT * FROM children WHERE id = ? AND customer_id = ?", (child_id, customer["id"])).fetchone()
    if not row:
        raise HTTPException(404)
    child, errors = parse_child_form(await request.form())
    if errors:
        values = {**child, "child_name": child["name"]}
        return page(request, "editar.html", status_code=422, customer=customer, child=child_dict(row), values=values,
                    errors=errors, **form_options())
    services.update_child(conn, child_id, child)
    return RedirectResponse(f"/conta/{token}?salvo=1", status_code=303)


@app.post("/conta/{token}/apagar", response_class=HTMLResponse)
async def account_delete(request: Request, token: str, conn=Depends(get_db)):
    customer = _customer(conn, token)
    form = await request.form()
    if form.get("confirm") != "APAGAR":
        return message(request, "Nada foi apagado", "Para apagar, digite APAGAR no campo de confirmação.", 400,
                       link=(f"/conta/{token}", "Voltar para minha conta"))
    services.delete_customer_data(conn, customer["id"])
    return message(request, "Dados apagados", "Todos os dados pessoais e histórias foram apagados. Até logo!")


@app.get("/entrar", response_class=HTMLResponse)
def login_form(request: Request):
    return page(request, "entrar.html", sent=False)


@app.post("/entrar", response_class=HTMLResponse)
async def login_submit(request: Request, conn=Depends(get_db)):
    form = await request.form()
    email = str(form.get("email", "")).strip().lower()
    if EMAIL_RE.match(email) and not rate_limited(request, "login", limit=5):
        customer = conn.execute("SELECT * FROM customers WHERE email = ? AND deleted_at IS NULL", (email,)).fetchone()
        if customer:
            try:
                mailer.send_template(email, f"Seu link de acesso - {settings.site_name}", "link_acesso",
                                     account_url=f"{settings.base_url}/conta/{customer['token']}")
            except Exception:
                log.exception("Falha ao enviar link de acesso")
    # Mesma resposta sempre, para não revelar quem é cliente.
    return page(request, "entrar.html", sent=True)


# ---------------------------------------------------------------- histórias

def _story(conn, token: str):
    row = conn.execute(
        "SELECT st.*, ch.name AS child_name FROM stories st JOIN children ch ON ch.id = st.child_id "
        "WHERE st.token = ? AND st.status = 'ready'",
        (token,),
    ).fetchone()
    if not row:
        raise HTTPException(404)
    return row


@app.get("/h/{token}", response_class=HTMLResponse)
def story_page(request: Request, token: str, conn=Depends(get_db)):
    row = _story(conn, token)
    story = json.loads(row["content_json"])
    folder = story_dir(row["id"])
    scenes = [(folder / f"cena{i + 1}.svg").read_text(encoding="utf-8") for i in range(len(story["cenas"]))]
    return page(
        request, "historia.html", story=story, scenes=scenes, child_name=row["child_name"], is_sample=False,
        audio_url=f"/h/{token}/audio" if row["has_audio"] else None,
        pdf_url=f"/h/{token}/pdf" if row["has_pdf"] else None,
    )


@app.get("/h/{token}/audio")
def story_audio(token: str, conn=Depends(get_db)):
    row = _story(conn, token)
    audio = json.loads(row["content_json"]).get("audio_file")
    path = story_dir(row["id"]) / (audio or "historia.mp3")
    if not audio or not path.exists():
        raise HTTPException(404)
    media = "audio/mpeg" if path.suffix == ".mp3" else "audio/wav"
    return FileResponse(path, media_type=media, filename=f"{row['title']}{path.suffix}")


@app.get("/h/{token}/pdf")
def story_pdf(token: str, conn=Depends(get_db)):
    row = _story(conn, token)
    path = story_dir(row["id"]) / "historia.pdf"
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="application/pdf", filename=f"{row['title']}.pdf")


# ---------------------------------------------------------------- admin

@app.get("/admin", response_class=HTMLResponse, dependencies=[Depends(require_admin)])
def admin(request: Request, conn=Depends(get_db)):
    stats = services.dashboard_stats(conn)
    subs = conn.execute(
        "SELECT s.*, c.email, ch.name AS child_name, ch.age FROM subscriptions s JOIN customers c ON c.id = s.customer_id "
        "JOIN children ch ON ch.id = s.child_id WHERE s.status != 'pending' ORDER BY s.id DESC LIMIT 100"
    ).fetchall()
    stories = conn.execute(
        "SELECT st.*, ch.name AS child_name FROM stories st JOIN children ch ON ch.id = st.child_id "
        "ORDER BY st.id DESC LIMIT 50"
    ).fetchall()
    orders = conn.execute(
        "SELECT o.*, c.email FROM orders o JOIN subscriptions s ON s.id = o.subscription_id "
        "JOIN customers c ON c.id = s.customer_id ORDER BY o.id DESC LIMIT 50"
    ).fetchall()
    return page(request, "admin.html", stats=stats, subs=subs, stories=stories, orders=orders)


@app.post("/admin/historia/{story_id}/refazer", dependencies=[Depends(require_admin)])
def admin_redo_story(story_id: int, conn=Depends(get_db)):
    conn.execute(
        "UPDATE stories SET status = 'queued', attempts = 0, admin_alerted = 0, emailed_at = NULL, error = NULL "
        "WHERE id = ?",
        (story_id,),
    )
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/assinatura/{subscription_id}/gerar", dependencies=[Depends(require_admin)])
def admin_generate_now(subscription_id: int, conn=Depends(get_db)):
    conn.execute("UPDATE subscriptions SET next_story_at = ? WHERE id = ? AND status = 'active'",
                 (now_iso(), subscription_id))
    return RedirectResponse("/admin", status_code=303)
