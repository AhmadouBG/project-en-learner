# backend/core/config.py
"""
Backwards-compatible shim.

Historically this module defined its own `Settings` class with
`env_file=".env"` — a path relative to the *current working directory*. That
meant the legacy services (meaning, phonetic, coqui TTS) silently read a
different (or missing) .env than the app factory, so `API_KEY_GEMINI` came back
empty and every request failed with a config error. `ALLOWED_ORIGINS` also had
a different type (list vs str), so the two classes could not even load the same
.env file without a validation error.

There is now ONE source of truth: `backend.app.config.Settings`.
This module re-exports it so existing imports keep working.
"""
from __future__ import annotations

from backend.app.config import Settings, get_settings  # noqa: F401

__all__ = ["Settings", "get_settings"]


if __name__ == "__main__":
    settings = get_settings()
    print(f"✅ Config loaded: {settings.APP_NAME} (token configured: {bool(settings.API_TOKEN)})")
