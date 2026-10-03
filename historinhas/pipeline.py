"""Linha de produção de uma história: texto -> ilustrações -> áudio -> PDF."""

import json
import logging
import shutil
import sqlite3
from pathlib import Path

from . import llm, pdf, tts
from .config import settings
from .content import THEMES
from .db import child_dict, now_iso
from .illustrate import scene_svg

log = logging.getLogger(__name__)


def story_dir(story_id: int) -> Path:
    return settings.stories_dir / str(story_id)


def remove_story_files(story_id: int) -> None:
    shutil.rmtree(story_dir(story_id), ignore_errors=True)


def pick_theme(conn: sqlite3.Connection, child: dict) -> str:
    """Escolhe o tema usado há mais tempo entre os escolhidos pelos pais."""
    options = [t for t in child["themes"] if t in THEMES] or list(THEMES)
    rows = conn.execute(
        "SELECT theme, MAX(id) AS last FROM stories WHERE child_id = ? AND status = 'ready' GROUP BY theme",
        (child["id"],),
    ).fetchall()
    last_used = {r["theme"]: r["last"] for r in rows}
    return min(options, key=lambda t: (last_used.get(t, 0), options.index(t)))


def previous_stories(conn: sqlite3.Connection, child_id: int, limit: int = 6) -> list[dict]:
    rows = conn.execute(
        "SELECT title, summary FROM stories WHERE child_id = ? AND status = 'ready' ORDER BY id DESC LIMIT ?",
        (child_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def narration_text(story: dict) -> str:
    return f"{story['titulo']}.\n\n" + llm.story_text(story) + "\n\nFim."


def render_assets(story_id: int, story: dict, child: dict) -> dict:
    """Desenha as cenas e gera áudio e PDF. Falhas de áudio/PDF não derrubam a história."""
    folder = story_dir(story_id)
    folder.mkdir(parents=True, exist_ok=True)
    svgs = []
    for i, scene in enumerate(story["cenas"]):
        svg = scene_svg(scene["cenario"], scene["noite"], child["appearance"], child.get("pet_type", ""),
                        seed=f"{story_id}-{i}")
        (folder / f"cena{i + 1}.svg").write_text(svg, encoding="utf-8")
        svgs.append(svg)

    assets = {"audio": None, "pdf": None}
    try:
        audio = tts.narrate(narration_text(story), folder / "historia.mp3")
        assets["audio"] = audio.name if audio else None
    except Exception:
        log.exception("Falha ao gerar áudio da história %s", story_id)
    try:
        out = pdf.render_pdf(story, child["name"], svgs, folder / "historia.pdf")
        assets["pdf"] = out.name if out else None
    except Exception:
        log.exception("Falha ao gerar PDF da história %s", story_id)
    return assets


def produce_story(conn: sqlite3.Connection, story_id: int) -> bool:
    """Produz uma história da fila. Devolve True se ficou pronta."""
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
    child = child_dict(conn.execute("SELECT * FROM children WHERE id = ?", (row["child_id"],)).fetchone())
    theme = row["theme"] or pick_theme(conn, child)
    conn.execute(
        "UPDATE stories SET status = 'generating', theme = ?, attempts = attempts + 1, started_at = ?, error = NULL "
        "WHERE id = ?",
        (theme, now_iso(), story_id),
    )
    log.info("Gerando história %s para %s (tema: %s)", story_id, child["name"], theme)
    try:
        story = llm.generate_story(child, theme, previous_stories(conn, child["id"]))
        assets = render_assets(story_id, story, child)
    except Exception as exc:
        log.exception("História %s falhou", story_id)
        conn.execute("UPDATE stories SET status = 'failed', error = ? WHERE id = ?", (str(exc)[:1000], story_id))
        return False

    story["audio_file"] = assets["audio"]
    conn.execute(
        "UPDATE stories SET status = 'ready', title = ?, summary = ?, content_json = ?, has_audio = ?, has_pdf = ?, "
        "ready_at = ?, error = NULL WHERE id = ?",
        (story["titulo"], story["resumo"], json.dumps(story, ensure_ascii=False),
         int(bool(assets["audio"])), int(bool(assets["pdf"])), now_iso(), story_id),
    )
    log.info("História %s pronta: %s", story_id, story["titulo"])
    return True
