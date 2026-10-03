import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("LLM_PROVIDER", "demo")
    monkeypatch.setenv("PAYMENT_PROVIDER", "fake")
    monkeypatch.setenv("TTS_ENABLED", os.environ.get("TEST_TTS", "false"))
    monkeypatch.setenv("BASE_URL", "http://testserver")
    monkeypatch.setenv("ADMIN_PASSWORD", "segredo")
    monkeypatch.setenv("ADMIN_EMAIL", "admin@example.com")
    monkeypatch.delenv("SMTP_HOST", raising=False)
    from historinhas.config import reload_settings
    from historinhas.db import init_db

    settings = reload_settings()
    init_db()
    yield settings


@pytest.fixture
def conn(env):
    from historinhas.db import connect

    c = connect()
    yield c
    c.close()


@pytest.fixture
def client(env):
    from fastapi.testclient import TestClient

    from historinhas.web import app

    with TestClient(app) as c:
        yield c


def outbox(settings) -> list[str]:
    if not settings.outbox_dir.exists():
        return []
    return sorted(p.read_text(errors="ignore") for p in settings.outbox_dir.glob("*.eml"))


CHILD_FORM = {
    "child_name": "Theo",
    "age": "5",
    "gender": "menino",
    "skin": "media",
    "hair_style": "cacheado",
    "hair_color": "castanho",
    "eyes": "verdes",
    "glasses": "1",
    "fav_color": "verde",
    "pet_type": "gato",
    "pet_name": "Bolinha",
    "interests": ["dinossauros", "espaço e foguetes"],
    "interests_extra": "adora panqueca",
    "themes": ["coragem", "amizade"],
}
