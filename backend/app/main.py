# backend/app/main.py
"""
Application factory for the English Shadowing backend.

Startup sequence
----------------
1. Load and validate settings (pydantic-settings from .env)
2. Bootstrap API token if missing (generate + write to .env)
3. Configure structured logging
4. Open SQLite cache connection
5. Ensure audio_files directory exists
6. Mount all routers (new + legacy backward-compat routes)

Running
-------
    # From the project root with .venv active:
    uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import importlib
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from backend.app.config import bootstrap_token, get_settings
from backend.app.core.cache import close_cache, open_cache
from backend.app.core.errors import register_error_handlers
from backend.app.core.logging_conf import configure_logging

logger = structlog.get_logger(__name__)

# Route label -> module/attribute, used by _mount_legacy_routes
ROUTES = ("/api/meaning", "/api/phonetics", "/api/audio", "/api/pronunciation")


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Single lifespan context manager — runs startup then teardown."""

    # 1. Load settings
    settings = get_settings()

    # 2. Configure logging first so everything after is captured
    configure_logging(level=settings.LOG_LEVEL, fmt=settings.LOG_FORMAT)

    # 3. Auto-generate API token if missing (updates module-level singleton)
    settings = bootstrap_token(settings)

    logger.info(
        "app.starting",
        name=settings.APP_NAME,
        version=settings.APP_VERSION,
        debug=settings.DEBUG,
    )

    # 4. Open SQLite cache
    await open_cache(settings.DB_PATH)

    # 5. Ensure audio directory exists
    Path(settings.AUDIO_DIR).mkdir(parents=True, exist_ok=True)

    logger.info("app.ready", host=settings.HOST, port=settings.PORT)

    yield  # ← server is live here

    # ── Teardown ──────────────────────────────────────────────────────────────
    logger.info("app.stopping")
    await close_cache()
    logger.info("app.stopped")


# ── Request ID middleware ─────────────────────────────────────────────────────

async def request_id_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Attach a unique request_id to every request for log correlation."""
    request_id = str(uuid.uuid4())
    request.state.request_id = request_id
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(request_id=request_id)
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response


# ── App factory ───────────────────────────────────────────────────────────────

def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        docs_url="/docs" if settings.DEBUG else None,
        redoc_url="/redoc" if settings.DEBUG else None,
        lifespan=lifespan,
    )

    # ── Middleware ────────────────────────────────────────────────────────────
    app.middleware("http")(request_id_middleware)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Error handlers ────────────────────────────────────────────────────────
    register_error_handlers(app)

    # ── Routers — new ─────────────────────────────────────────────────────────
    from backend.app.api.health import router as health_router
    app.include_router(health_router)

    # ── Routers — legacy (backward-compatible) ────────────────────────────────
    # These are the four existing routes the Chrome extension already calls.
    # They are mounted under the new app so the extension needs no changes.
    _mount_legacy_routes(app)

    # ── Root probe ────────────────────────────────────────────────────────────
    @app.get("/", include_in_schema=False)
    async def root() -> dict:
        return {
            "message": f"{settings.APP_NAME} v{settings.APP_VERSION}",
            "health": "/api/health",
            "docs": "/docs" if settings.DEBUG else None,
        }

    return app


def _mount_legacy_routes(app: FastAPI) -> None:
    """
    Wire the original four routers.

    Each legacy service may fail to import (e.g. missing google-genai, cmudict,
    coqui). We catch those errors and log them so the server still starts —
    a degraded backend is better than a crash.

    These failures are logged at ERROR level on purpose: a route that silently
    fails to mount just 404s later, which looks like "the button is broken".
    """
    from backend.app.core.auth import require_api_token
    from fastapi import Depends

    def mount(module_path: str, attr: str, route: str) -> bool:
        try:
            module = importlib.import_module(module_path)
            app.include_router(
                getattr(module, attr), dependencies=[Depends(require_api_token)]
            )
            logger.info("legacy.route.mounted", route=route)
            return True
        except Exception as exc:
            logger.error(
                "legacy.route.failed",
                route=route,
                error=str(exc),
                hint="This endpoint will return 404 until the dependency is installed.",
            )
            return False

    mounted = [
        mount("backend.api.routes.api_meaning", "router", "/api/meaning"),
        mount("backend.api.routes.api_phonetic", "router", "/api/phonetics"),
        mount("backend.api.routes.api_audio", "router", "/api/audio"),
        mount("backend.api.routes.api_pronunciation", "router", "/api/pronunciation"),
    ]

    missing = [r for r, ok in zip(ROUTES, mounted) if not ok]
    if missing:
        logger.error(
            "legacy.routes.missing",
            routes=missing,
            hint="The Chrome extension will show an error for these features.",
        )


# ── Module-level app instance (used by uvicorn) ───────────────────────────────
app = create_app()


# ── CLI entry point (Phase 7) ─────────────────────────────────────────────────
def cli_serve() -> None:  # pragma: no cover
    import uvicorn
    settings = get_settings()
    uvicorn.run(
        "backend.app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        log_config=None,  # We manage logging ourselves
    )


if __name__ == "__main__":  # pragma: no cover
    cli_serve()
