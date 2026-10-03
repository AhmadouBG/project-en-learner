# backend/app/config.py
"""
Application configuration — single source of truth.

Loaded from environment variables and/or a .env file in the project root.
All new settings are additive; existing env vars (API_KEY_GEMINI, DEBUG, etc.)
remain fully backward-compatible.
"""
from __future__ import annotations

import logging
import secrets
import sys
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

# Project root = two levels up from this file (backend/app/config.py → project root)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_ENV_FILE = _PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    """All configuration, validated at startup."""

    # ── Application ──────────────────────────────────────────────────────────
    APP_NAME: str = "English Shadowing API"
    APP_VERSION: str = "2.0.0"
    DEBUG: bool = True

    # ── Server ───────────────────────────────────────────────────────────────
    HOST: str = "127.0.0.1"
    PORT: int = 8000

    # ── Security ─────────────────────────────────────────────────────────────
    # If empty, a token is auto-generated at startup and written back to .env
    API_TOKEN: str = ""

    # ── CORS ─────────────────────────────────────────────────────────────────
    # Space-separated list of allowed origins.
    # Defaults cover dev (localhost) + the extension.
    ALLOWED_ORIGINS: str = "http://localhost:* http://127.0.0.1:* chrome-extension://*"

    # ── Storage ───────────────────────────────────────────────────────────────
    DB_PATH: str = str(_PROJECT_ROOT / "shadow.db")
    AUDIO_DIR: str = str(_PROJECT_ROOT / "audio_files")
    STORE_RECORDINGS: bool = False

    # ── Logging ───────────────────────────────────────────────────────────────
    LOG_LEVEL: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    LOG_FORMAT: Literal["json", "console"] = "console"

    # ── Legacy / external keys ────────────────────────────────────────────────
    API_KEY_GEMINI: str = ""          # Optional; required only when USE_GEMINI=true
    USE_GEMINI: bool = False          # Off by default — local-first
    USE_TRANSFORMER_BARK: bool = False

    # ── Model paths (populated by Phase 2+ as models are added) ───────────────
    WHISPER_MODEL: str = "small.en"   # faster-whisper model id
    TTS_PROVIDER: str = "kokoro"      # "kokoro" | "coqui" | "none"

    # ── Scoring weights (Phase 4) ─────────────────────────────────────────────
    SCORE_WEIGHT_ACCURACY: float = 0.70
    SCORE_WEIGHT_RHYTHM: float = 0.20
    SCORE_WEIGHT_COMPLETENESS: float = 0.10

    # ── Ollama (Phase 6, optional) ────────────────────────────────────────────
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5:3b"

    # ── Database URL (legacy field kept for compat) ───────────────────────────
    DATABASE_URL: str = "sqlite+aiosqlite:///./tts_extension.db"

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    @field_validator("API_TOKEN")
    @classmethod
    def _ensure_token(cls, v: str) -> str:
        """Accept whatever is in .env; generation happens in lifespan."""
        return v

    @property
    def allowed_origins_list(self) -> list[str]:
        """Split the space-separated ALLOWED_ORIGINS string into a list."""
        return [o.strip() for o in self.ALLOWED_ORIGINS.split() if o.strip()]

    @property
    def db_path(self) -> Path:
        return Path(self.DB_PATH)

    @property
    def audio_dir(self) -> Path:
        return Path(self.AUDIO_DIR)


def _generate_and_persist_token(env_path: Path) -> str:
    """
    Generate a cryptographically secure token, append it to .env,
    and return it.  Called once at startup when API_TOKEN is missing.
    """
    token = secrets.token_urlsafe(32)
    with env_path.open("a", encoding="utf-8") as fh:
        fh.write(f"\nAPI_TOKEN={token}\n")
    logger.warning(
        "🔑 No API_TOKEN found — generated a new one and saved to %s\n"
        "   Token: %s\n"
        "   Add this to the Chrome extension's background.js as X-API-Token.",
        env_path,
        token,
    )
    return token


def bootstrap_token(settings: Settings) -> Settings:
    """
    If API_TOKEN is blank, generate one, persist it, and update the live
    singleton so every subsequent call to get_settings() sees the token.
    Returns the (possibly updated) settings.
    """
    global _live_settings  # noqa: PLW0603
    if settings.API_TOKEN:
        return settings
    token = _generate_and_persist_token(_ENV_FILE)
    patched = settings.model_copy(update={"API_TOKEN": token})
    _live_settings = patched
    return patched


from functools import lru_cache  # noqa: E402 — after class definition

# Module-level live instance (may be replaced by bootstrap_token)
_live_settings: Settings | None = None


def get_settings() -> Settings:
    """
    Return the live settings singleton.

    On first call, creates a Settings() from environment / .env.
    After bootstrap_token() runs (in lifespan), returns the patched instance
    that has a valid API_TOKEN.
    """
    global _live_settings
    if _live_settings is None:
        _live_settings = Settings()
    return _live_settings
