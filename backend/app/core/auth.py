# backend/app/core/auth.py
"""
Local API token authentication.

Every route (except GET /api/health) must include the header:
  X-API-Token: <token>

The token is compared using secrets.compare_digest to prevent timing attacks.
Token is stored in settings.API_TOKEN (auto-generated on first run).
"""
from __future__ import annotations

import secrets

import structlog
from fastapi import Depends, Security
from fastapi.security import APIKeyHeader

from backend.app.config import Settings, get_settings
from backend.app.core.errors import UnauthorizedError

logger = structlog.get_logger(__name__)

_API_KEY_HEADER = APIKeyHeader(name="X-API-Token", auto_error=False)


async def require_api_token(
    token: str | None = Security(_API_KEY_HEADER),
    settings: Settings = Depends(get_settings),
) -> None:
    """
    FastAPI dependency that enforces the X-API-Token header.

    Usage:
        @router.get("/some-route", dependencies=[Depends(require_api_token)])

    Or on the whole router:
        router = APIRouter(dependencies=[Depends(require_api_token)])
    """
    if not token:
        raise UnauthorizedError("Missing X-API-Token header")

    expected = settings.API_TOKEN
    if not expected:
        # Should never happen after bootstrap_token() runs in lifespan,
        # but guard defensively.
        logger.error("API_TOKEN is not configured — rejecting all requests")
        raise UnauthorizedError("Server token not configured")

    if not secrets.compare_digest(token.encode(), expected.encode()):
        raise UnauthorizedError("Invalid API token")
