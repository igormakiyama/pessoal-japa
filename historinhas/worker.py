"""Worker: o "funcionário" que trabalha sozinho 24h.

Em loop: confere pagamentos perdidos, vence/avisa assinaturas, agenda e produz histórias,
envia os e-mails e avisa você se algo der errado.

Rodar: python -m historinhas.worker
"""

import logging
import signal
import time

import httpx

from . import pipeline, services, tts
from .config import settings
from .db import connect, init_db, kv_set, now_iso

log = logging.getLogger("historinhas.worker")

_running = True


def _stop(*_):
    global _running
    _running = False
    log.info("Encerrando worker...")


def ensure_model() -> None:
    """Garante que o modelo de IA está baixado no Ollama (baixa na primeira vez, ~3 GB)."""
    if settings.llm_provider != "ollama":
        return
    for attempt in range(30):
        try:
            tags = httpx.get(f"{settings.ollama_url}/api/tags", timeout=10).json()
            break
        except httpx.HTTPError:
            log.info("Aguardando o Ollama subir (%d)...", attempt + 1)
            time.sleep(5)
    else:
        log.error("Ollama não respondeu em %s", settings.ollama_url)
        return
    names = {m.get("name") for m in tags.get("models", [])} | {m.get("model") for m in tags.get("models", [])}
    if settings.llm_model in names or f"{settings.llm_model}:latest" in names:
        return
    log.info("Baixando o modelo %s no Ollama (só na primeira vez, pode levar alguns minutos)...", settings.llm_model)
    resp = httpx.post(f"{settings.ollama_url}/api/pull", json={"model": settings.llm_model, "stream": False},
                      timeout=httpx.Timeout(7200, connect=15))
    resp.raise_for_status()
    log.info("Modelo %s pronto.", settings.llm_model)


def tick(conn) -> bool:
    """Uma volta do loop. Devolve True se produziu alguma história (para não dormir)."""
    kv_set(conn, "worker_heartbeat", now_iso())
    services.run_periodic(conn, "last_reconcile", 600, services.reconcile_pending_orders)
    services.expire_and_remind(conn)
    services.schedule_due_stories(conn)
    services.recover_and_retry(conn)
    story_id = services.next_queued_story(conn)
    if story_id:
        pipeline.produce_story(conn, story_id)
    services.notify_ready_stories(conn)
    services.alert_admin_failures(conn)
    return story_id is not None


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "fontTools", "weasyprint"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    init_db()
    for step in (ensure_model, tts.ensure_voice if settings.tts_enabled else None):
        if step:
            try:
                step()
            except Exception:
                log.exception("Falha na preparação (%s); seguindo mesmo assim", step.__name__)
    log.info("Worker iniciado (IA: %s / %s, pagamento: %s)", settings.llm_provider, settings.llm_model,
             settings.payment_provider)
    conn = connect()
    while _running:
        try:
            worked = tick(conn)
        except Exception:
            log.exception("Erro no ciclo do worker")
            worked = False
        if not worked:
            for _ in range(20):
                if not _running:
                    break
                time.sleep(1)


if __name__ == "__main__":
    main()
