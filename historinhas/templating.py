"""Ambiente Jinja2 compartilhado entre o site, os e-mails e o PDF."""

from datetime import timezone, timedelta
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .config import settings
from .db import parse

TEMPLATES_DIR = Path(__file__).parent / "templates"
BRT = timezone(timedelta(hours=-3))


def brl(cents: int) -> str:
    value = f"{cents / 100:,.2f}"
    return "R$ " + value.replace(",", "X").replace(".", ",").replace("X", ".")


def date_br(value: str | None) -> str:
    dt = parse(value)
    return dt.astimezone(BRT).strftime("%d/%m/%Y") if dt else ""


env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=select_autoescape(["html", "xml"]),
)
env.filters["brl"] = brl
env.filters["date_br"] = date_br
env.globals["settings"] = settings


def render(template: str, **context) -> str:
    return env.get_template(template).render(**context)
