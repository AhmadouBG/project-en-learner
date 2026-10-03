# backend/app/api/health.py
"""
GET /api/health — public endpoint, no token required.

Used by the Chrome extension to detect whether the backend is running
and which models are available.
"""
from __future__ import annotations

from fastapi import APIRouter

from backend.app.config import get_settings
from backend.app.core.model_manager import model_registry
from backend.app.schemas.health import HealthResponse, ModelSlotStatus, ModelsStatus

router = APIRouter(tags=["Health"])


@router.get(
    "/api/health",
    response_model=HealthResponse,
    summary="Backend health and model status",
    description=(
        "Returns the current status of the backend and all ML models. "
        "Does **not** require an API token — the extension uses this to "
        "detect whether the backend is running."
    ),
)
async def get_health() -> HealthResponse:
    settings = get_settings()
    all_statuses = model_registry.to_dict()

    def _slot(name: str) -> ModelSlotStatus:
        s = all_statuses.get(name, {})
        return ModelSlotStatus(
            ready=s.get("ready", False),
            name=s.get("name"),
            error=s.get("error"),
        )

    models = ModelsStatus(
        asr=_slot("asr"),
        phoneme=_slot("phoneme"),
        tts=_slot("tts"),
        llm=_slot("llm"),
    )
    ready = model_registry.all_ready()

    return HealthResponse(
        status="ok" if ready else "starting",
        version=settings.APP_VERSION,
        models=models,
        ready=ready,
    )
