"""Livrinho em PDF da história (WeasyPrint: HTML -> PDF, roda local)."""

import base64
import logging
from pathlib import Path

from .config import settings
from .templating import render

log = logging.getLogger(__name__)


def _data_uri(svg: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


def render_pdf(story: dict, child_name: str, svgs: list[str], out: Path) -> Path | None:
    if not settings.pdf_enabled:
        return None
    try:
        from weasyprint import HTML
    except (ImportError, OSError) as exc:
        log.warning("WeasyPrint indisponível (%s); história sairá sem PDF.", exc)
        return None
    html = render(
        "story_pdf.html",
        story=story,
        child_name=child_name,
        images=[_data_uri(svg) for svg in svgs],
    )
    HTML(string=html).write_pdf(out)
    return out
