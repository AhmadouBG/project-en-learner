# tests/conftest.py
"""
Shared pytest fixtures for the English Shadowing backend test suite.

AsyncClient is configured to use the ASGI transport so no real server starts.
A test-specific .env with a known API_TOKEN is injected via monkeypatch.
"""
from __future__ import annotations

import os
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# ── Ensure a stable token for all tests ───────────────────────────────────────
TEST_TOKEN = "test-token-phase1"


@pytest.fixture(autouse=True)
def patch_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Inject environment variables before the settings singleton is created.
    Also resets the module-level _live_settings so each test starts fresh.
    """
    monkeypatch.setenv("API_TOKEN", TEST_TOKEN)
    monkeypatch.setenv("API_KEY_GEMINI", "fake-gemini-key-for-tests")
    monkeypatch.setenv("DEBUG", "true")
    monkeypatch.setenv("DB_PATH", ":memory:")   # in-memory SQLite for tests

    # Reset the live settings singleton so patched env vars are picked up
    import backend.app.config as cfg
    cfg._live_settings = None

    yield

    # Teardown: reset again so next test is not polluted
    cfg._live_settings = None


@pytest_asyncio.fixture
async def client() -> AsyncClient:
    """
    Async HTTP client wired directly to the ASGI app (no real server).
    Uses a fresh app instance per test to avoid state bleed.
    """
    from backend.app.main import create_app
    app = create_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as ac:
        yield ac


@pytest.fixture
def auth_headers() -> dict[str, str]:
    """Headers with the test API token."""
    return {"X-API-Token": TEST_TOKEN}
