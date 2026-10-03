"""Envio de e-mails por SMTP (ex.: plano grátis do Brevo, 300 e-mails/dia).

Sem SMTP configurado, os e-mails são gravados em data/outbox para conferência.
"""

import html as html_lib
import logging
import re
import smtplib
import uuid
from email.message import EmailMessage
from email.utils import make_msgid

from .config import settings
from .db import utcnow
from .templating import render

log = logging.getLogger(__name__)


def _html_to_text(html: str) -> str:
    text = re.sub(r"<(br|/p|/h\d|/li|/div)\s*/?>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r'<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', r"\2 (\1)", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<style.*?</style>|<[^>]+>", "", text, flags=re.DOTALL)
    text = html_lib.unescape(text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def send_email(to: str, subject: str, html: str) -> None:
    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid()
    msg["Reply-To"] = settings.support_email
    msg.set_content(_html_to_text(html))
    msg.add_alternative(html, subtype="html")

    if not settings.smtp_host:
        settings.outbox_dir.mkdir(parents=True, exist_ok=True)
        safe_to = re.sub(r"[^a-zA-Z0-9@._-]", "_", to)
        path = settings.outbox_dir / f"{utcnow():%Y%m%d-%H%M%S}-{safe_to}-{uuid.uuid4().hex[:6]}.eml"
        path.write_bytes(bytes(msg))
        log.info("[e-mail de teste] para %s: %s -> %s", to, subject, path)
        return

    if settings.smtp_ssl:
        server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=30)
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30)
        server.starttls()
    try:
        if settings.smtp_user:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(msg)
    finally:
        server.quit()
    log.info("E-mail enviado para %s: %s", to, subject)


def send_template(to: str, subject: str, template: str, **context) -> None:
    html = render(f"emails/{template}.html", subject=subject, **context)
    send_email(to, subject, html)
