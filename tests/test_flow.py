"""Fluxo completo: cadastro -> pagamento -> worker gera história -> e-mails -> área do cliente."""

from datetime import timedelta

from conftest import CHILD_FORM, outbox

from historinhas import worker
from historinhas.db import iso, utcnow
from historinhas.pipeline import story_dir


def signup(client, email="mae@example.com", plan="mensal"):
    data = {**CHILD_FORM, "email": email, "parent_name": "Ana Souza", "plan": plan, "consent": "1"}
    resp = client.post("/assinar", data=data, follow_redirects=False)
    assert resp.status_code == 303, resp.text
    return resp.headers["location"].rsplit("/", 1)[-1]


def pay(client, order_token):
    resp = client.post(f"/checkout-teste/{order_token}", follow_redirects=False)
    assert resp.status_code == 303


def test_public_pages(client):
    for url in ("/", "/exemplo", "/assinar", "/assinar?plano=anual", "/termos", "/privacidade", "/entrar", "/saude"):
        assert client.get(url).status_code == 200, url
    resp = client.get("/avatar.svg?skin=escura&hair_style=crespo&pet_type=coelho")
    assert resp.headers["content-type"].startswith("image/svg+xml")


def test_signup_validation(client):
    resp = client.post("/assinar", data={"child_name": "1", "email": "x"})
    assert resp.status_code == 422
    assert "e-mail válido" in resp.text
    assert "aceitar os termos" in resp.text


def test_full_flow(client, conn, env):
    order_token = signup(client)
    assert client.get(f"/checkout-teste/{order_token}").status_code == 200
    pay(client, order_token)

    sub = conn.execute("SELECT * FROM subscriptions").fetchone()
    assert sub["status"] == "active"
    page = client.get(f"/obrigado/{order_token}")
    assert "Pagamento confirmado" in page.text

    # O worker coloca a primeira história na fila e produz na mesma volta.
    assert worker.tick(conn) is True
    story = conn.execute("SELECT * FROM stories").fetchone()
    assert story["status"] == "ready", story["error"]
    assert story["theme"] == "coragem"
    assert (story_dir(story["id"]) / "cena1.svg").exists()
    assert story["has_pdf"] == 1
    assert (story_dir(story["id"]) / "historia.pdf").read_bytes().startswith(b"%PDF")
    assert story["emailed_at"]

    mails = outbox(env)
    assert any("Bem-vindo" in m for m in mails)
    assert any("Nova hist" in m for m in mails)

    # Não gera outra até a próxima semana.
    assert worker.tick(conn) is False
    assert conn.execute("SELECT COUNT(*) FROM stories").fetchone()[0] == 1

    # Página da história e PDF
    assert "Theo" in client.get(f"/h/{story['token']}").text
    assert client.get(f"/h/{story['token']}/pdf").status_code == 200
    assert client.get(f"/h/{story['token']}/audio").status_code == 404  # TTS desligado nos testes
    assert client.get("/h/token-invalido").status_code == 404

    # Área do cliente
    customer = conn.execute("SELECT * FROM customers").fetchone()
    account = client.get(f"/conta/{customer['token']}")
    assert account.status_code == 200 and story["title"] in account.text

    # Segunda história usa o próximo tema
    conn.execute("UPDATE subscriptions SET next_story_at = ?", (iso(utcnow() - timedelta(minutes=1)),))
    worker.tick(conn)
    second = conn.execute("SELECT * FROM stories ORDER BY id DESC").fetchone()
    assert second["status"] == "ready" and second["theme"] == "amizade"


def test_edit_child_and_renew(client, conn):
    pay(client, signup(client))
    customer = conn.execute("SELECT * FROM customers").fetchone()
    child = conn.execute("SELECT * FROM children").fetchone()
    sub = conn.execute("SELECT * FROM subscriptions").fetchone()

    url = f"/conta/{customer['token']}/editar/{child['id']}"
    assert client.get(url).status_code == 200
    resp = client.post(url, data={**CHILD_FORM, "child_name": "Theozinho", "age": "6"}, follow_redirects=False)
    assert resp.status_code == 303
    assert conn.execute("SELECT name, age FROM children").fetchone()[:] == ("Theozinho", 6)

    resp = client.post(f"/conta/{customer['token']}/renovar/{sub['id']}", data={"plan": "trimestral"},
                       follow_redirects=False)
    renewal_token = resp.headers["location"].rsplit("/", 1)[-1]
    pay(client, renewal_token)
    renewed = conn.execute("SELECT * FROM subscriptions").fetchone()
    assert renewed["paid_until"] > sub["paid_until"]


def test_login_link_and_delete_data(client, conn, env):
    pay(client, signup(client))
    customer = conn.execute("SELECT * FROM customers").fetchone()
    client.post("/entrar", data={"email": "mae@example.com"})
    assert any(customer["token"] in m for m in outbox(env))
    resp = client.post("/entrar", data={"email": "naoexiste@example.com"})
    assert "Se este e-mail tiver uma assinatura" in resp.text

    worker.tick(conn)
    story = conn.execute("SELECT * FROM stories").fetchone()
    client.post(f"/conta/{customer['token']}/apagar", data={"confirm": "APAGAR"})
    assert conn.execute("SELECT COUNT(*) FROM stories").fetchone()[0] == 0
    assert not story_dir(story["id"]).exists()
    assert client.get(f"/conta/{customer['token']}").status_code == 404
    assert conn.execute("SELECT email FROM customers").fetchone()[0].startswith("apagado-")


def test_admin_requires_password(client):
    assert client.get("/admin").status_code == 401
    assert client.get("/admin", auth=("admin", "errada")).status_code == 401
    assert client.get("/admin", auth=("admin", "segredo")).status_code == 200


def test_cross_site_post_is_blocked(client):
    resp = client.post("/entrar", data={"email": "a@b.com"}, headers={"Origin": "https://site-malicioso.com"})
    assert resp.status_code == 403
    resp = client.post("/entrar", data={"email": "a@b.com"}, headers={"Origin": "http://testserver"})
    assert resp.status_code == 200


def test_failed_story_is_retried_then_admin_alerted(client, conn, env, monkeypatch):
    pay(client, signup(client))

    def boom(*a, **k):
        raise RuntimeError("IA fora do ar")

    monkeypatch.setattr("historinhas.llm.generate_story", boom)
    worker.tick(conn)
    story = conn.execute("SELECT * FROM stories").fetchone()
    assert story["status"] == "failed" and "IA fora do ar" in story["error"]
    for _ in range(2):
        conn.execute("UPDATE stories SET started_at = ?", (iso(utcnow() - timedelta(hours=1)),))
        worker.tick(conn)
    story = conn.execute("SELECT * FROM stories").fetchone()
    assert story["attempts"] == 3 and story["admin_alerted"] == 1
    assert any("falharam" in m for m in outbox(env))
