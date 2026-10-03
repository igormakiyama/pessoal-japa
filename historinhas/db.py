"""Banco SQLite (um arquivo em data/). Sem servidor de banco: custo zero e backup simples."""

import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    parent_name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    consent_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    name TEXT NOT NULL,
    age INTEGER NOT NULL,
    gender TEXT NOT NULL,
    appearance_json TEXT NOT NULL,
    interests_json TEXT NOT NULL DEFAULT '[]',
    interests_extra TEXT NOT NULL DEFAULT '',
    themes_json TEXT NOT NULL DEFAULT '[]',
    pet_type TEXT NOT NULL DEFAULT '',
    pet_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    child_id INTEGER NOT NULL REFERENCES children(id),
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | active | expired | canceled
    paid_until TEXT,
    next_story_at TEXT,
    reminders_enabled INTEGER NOT NULL DEFAULT 1,
    reminder_sent_for TEXT,
    expired_notice_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
    plan TEXT NOT NULL,
    days INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | refunded
    provider TEXT NOT NULL,
    provider_ref TEXT,
    payment_id TEXT UNIQUE,
    created_at TEXT NOT NULL,
    paid_at TEXT
);

CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
    child_id INTEGER NOT NULL REFERENCES children(id),
    status TEXT NOT NULL DEFAULT 'queued',  -- queued | generating | ready | failed
    theme TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    content_json TEXT,
    has_audio INTEGER NOT NULL DEFAULT 0,
    has_pdf INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    admin_alerted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ready_at TEXT,
    emailed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
CREATE INDEX IF NOT EXISTS idx_stories_child ON stories(child_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def now_iso() -> str:
    return iso(utcnow())


def parse(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def plus_days(days: float, base: datetime | None = None) -> str:
    return iso((base or utcnow()) + timedelta(days=days))


def new_token() -> str:
    return secrets.token_urlsafe(18)


def connect() -> sqlite3.Connection:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: o FastAPI pode abrir e usar a conexão em threads diferentes da mesma requisição.
    conn = sqlite3.connect(settings.db_path, timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
    finally:
        conn.close()


def child_dict(row: sqlite3.Row) -> dict:
    """Converte a linha de children num dicionário com os campos JSON já decodificados."""
    child = dict(row)
    child["appearance"] = json.loads(child.pop("appearance_json"))
    child["interests"] = json.loads(child.pop("interests_json"))
    child["themes"] = json.loads(child.pop("themes_json"))
    return child


def kv_get(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def kv_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
