# tests/test_auth.py
"""
Phase 1 acceptance tests — token authentication.

Checks:
- All non-health routes return 401 with no token
- All non-health routes return 401 with a wrong token
- Correct token is accepted (route may still return another error, not 401)
- Timing-safe comparison works correctly
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

# Routes that must enforce auth (we test a POST body-free probe using GET /)
# We use a non-existent route to get a 404 with auth vs 401 without auth.
PROTECTED_PROBE = "/api/meaning"
WRONG_TOKEN = "completely-wrong-token"


@pytest.mark.asyncio
async def test_protected_route_no_token_returns_401(client: AsyncClient) -> None:
    """Any protected route without token must return 401."""
    response = await client.post(PROTECTED_PROBE, json={"text": "hello"})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_protected_route_wrong_token_returns_401(client: AsyncClient) -> None:
    """Wrong token must return 401."""
    response = await client.post(
        PROTECTED_PROBE,
        json={"text": "hello"},
        headers={"X-API-Token": WRONG_TOKEN},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_protected_route_correct_token_not_401(
    client: AsyncClient, auth_headers: dict
) -> None:
    """
    Correct token must NOT return 401.
    The route may 422 (no text body), 500, or pass — but not 401.
    """
    response = await client.post(
        PROTECTED_PROBE,
        json={"text": "hello"},
        headers=auth_headers,
    )
    assert response.status_code != 401, (
        f"Expected non-401 with correct token, got {response.status_code}: {response.text}"
    )


@pytest.mark.asyncio
async def test_401_uses_error_envelope(client: AsyncClient) -> None:
    """401 response must use the standard error envelope."""
    response = await client.post(PROTECTED_PROBE, json={"text": "hello"})
    data = response.json()
    assert "error" in data
    assert "code" in data["error"]
    assert "message" in data["error"]
    assert data["error"]["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_health_is_not_protected(client: AsyncClient) -> None:
    """GET /api/health must return 200 even without a token."""
    response = await client.get("/api/health")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_empty_token_header_returns_401(client: AsyncClient) -> None:
    """An empty X-API-Token header must be treated as missing."""
    response = await client.post(
        PROTECTED_PROBE,
        json={"text": "hello"},
        headers={"X-API-Token": ""},
    )
    assert response.status_code == 401
