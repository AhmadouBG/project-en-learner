# tests/test_health.py
"""
Phase 1 acceptance tests — /api/health endpoint.

Checks:
- Returns 200 with no token (public route)
- Returns correct schema fields
- version matches APP_VERSION in config
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_no_token_returns_200(client: AsyncClient) -> None:
    """GET /api/health must succeed without any authentication header."""
    response = await client.get("/api/health")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_health_response_schema(client: AsyncClient) -> None:
    """Response must contain status, version, models dict and ready flag."""
    response = await client.get("/api/health")
    data = response.json()

    assert "status" in data
    assert "version" in data
    assert "models" in data
    assert "ready" in data

    models = data["models"]
    for slot in ("asr", "phoneme", "tts", "llm"):
        assert slot in models, f"Model slot '{slot}' missing from health response"
        assert "ready" in models[slot]


@pytest.mark.asyncio
async def test_health_version_matches_config(client: AsyncClient) -> None:
    """Version in response must match APP_VERSION from settings."""
    from backend.app.config import get_settings
    settings = get_settings()

    response = await client.get("/api/health")
    data = response.json()

    assert data["version"] == settings.APP_VERSION


@pytest.mark.asyncio
async def test_health_status_starting_before_models(client: AsyncClient) -> None:
    """Status should be 'starting' when no models are loaded yet."""
    response = await client.get("/api/health")
    data = response.json()

    # In Phase 1 no models are loaded
    assert data["status"] in ("starting", "ok")
    assert data["ready"] is False


@pytest.mark.asyncio
async def test_health_request_id_header(client: AsyncClient) -> None:
    """Response must include an X-Request-Id header for log correlation."""
    response = await client.get("/api/health")
    assert "x-request-id" in response.headers
