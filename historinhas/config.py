"""Configuração lida de variáveis de ambiente (arquivo .env no docker compose)."""

import os
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    value = _env(name)
    return int(value) if value else default


def _env_bool(name: str, default: bool) -> bool:
    value = _env(name).lower()
    if not value:
        return default
    return value in ("1", "true", "sim", "yes", "on")


class Settings:
    def __init__(self) -> None:
        # Site
        self.site_name = _env("SITE_NAME", "Era Uma Vez Eu")
        self.base_url = _env("BASE_URL", "http://localhost:8000").rstrip("/")
        self.support_email = _env("SUPPORT_EMAIL", "contato@example.com")
        self.data_dir = Path(_env("DATA_DIR", "data")).resolve()

        # Admin (HTTP Basic). Sem senha => painel desativado.
        self.admin_user = _env("ADMIN_USER", "admin")
        self.admin_password = _env("ADMIN_PASSWORD")
        self.admin_email = _env("ADMIN_EMAIL")

        # IA de texto: "ollama" (local, grátis), "openai" (qualquer API compatível) ou "demo".
        self.llm_provider = _env("LLM_PROVIDER", "ollama").lower()
        self.ollama_url = _env("OLLAMA_URL", "http://ollama:11434").rstrip("/")
        self.llm_model = _env("LLM_MODEL", "gemma3:4b")
        self.llm_num_ctx = _env_int("LLM_NUM_CTX", 8192)
        self.llm_timeout = _env_int("LLM_TIMEOUT_SECONDS", 1200)
        self.openai_base_url = _env("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.openai_api_key = _env("OPENAI_API_KEY")
        self.llm_review = _env_bool("LLM_REVIEW", True)

        # Voz (Piper TTS, roda local na CPU)
        self.tts_enabled = _env_bool("TTS_ENABLED", True)
        self.piper_voice = _env("PIPER_VOICE", "pt_BR-faber-medium")
        self.piper_length_scale = float(_env("PIPER_LENGTH_SCALE", "1.15"))

        self.pdf_enabled = _env_bool("PDF_ENABLED", True)

        # Pagamento: "mercadopago" ou "fake" (testes, aprova sem cobrar)
        self.payment_provider = _env("PAYMENT_PROVIDER", "fake").lower()
        self.mp_access_token = _env("MP_ACCESS_TOKEN")
        self.mp_statement_descriptor = _env("MP_STATEMENT_DESCRIPTOR", "HISTORINHAS")

        # E-mail (SMTP). Sem SMTP_HOST => e-mails vão para data/outbox (modo teste).
        self.smtp_host = _env("SMTP_HOST")
        self.smtp_port = _env_int("SMTP_PORT", 587)
        self.smtp_user = _env("SMTP_USER")
        self.smtp_password = _env("SMTP_PASSWORD")
        self.smtp_from = _env("SMTP_FROM", f"{self.site_name} <{self.support_email}>")
        self.smtp_ssl = _env_bool("SMTP_SSL", False)

        # Produto
        self.story_interval_days = _env_int("STORY_INTERVAL_DAYS", 7)
        self.renewal_reminder_days = _env_int("RENEWAL_REMINDER_DAYS", 3)
        self.price_mensal = _env_int("PRICE_MENSAL_CENTS", 2490)
        self.price_trimestral = _env_int("PRICE_TRIMESTRAL_CENTS", 5990)
        self.price_anual = _env_int("PRICE_ANUAL_CENTS", 19990)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "historinhas.db"

    @property
    def stories_dir(self) -> Path:
        return self.data_dir / "stories"

    @property
    def voices_dir(self) -> Path:
        return self.data_dir / "voices"

    @property
    def outbox_dir(self) -> Path:
        return self.data_dir / "outbox"

    def plans(self) -> dict:
        return {
            "mensal": {"name": "Mensal", "days": 30, "price_cents": self.price_mensal},
            "trimestral": {"name": "Trimestral", "days": 90, "price_cents": self.price_trimestral},
            "anual": {"name": "Anual", "days": 365, "price_cents": self.price_anual},
        }


settings = Settings()


def reload_settings() -> Settings:
    """Relê o ambiente no mesmo objeto (usado nos testes)."""
    settings.__init__()
    return settings
