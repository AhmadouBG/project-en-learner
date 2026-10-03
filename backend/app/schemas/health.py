# backend/app/schemas/health.py
"""Pydantic models for GET /api/health."""
from __future__ import annotations

from pydantic import BaseModel


class ModelSlotStatus(BaseModel):
    ready: bool
    name: str | None = None
    error: str | None = None


class ModelsStatus(BaseModel):
    asr: ModelSlotStatus
    phoneme: ModelSlotStatus
    tts: ModelSlotStatus
    llm: ModelSlotStatus


class HealthResponse(BaseModel):
    status: str          # "ok" | "degraded" | "starting"
    version: str
    models: ModelsStatus
    ready: bool          # True only when all required models are loaded

    model_config = {"json_schema_extra": {
        "example": {
            "status": "ok",
            "version": "2.0.0",
            "models": {
                "asr":     {"ready": False, "name": None},
                "phoneme": {"ready": False, "name": None},
                "tts":     {"ready": False, "name": None},
                "llm":     {"ready": False, "name": None},
            },
            "ready": False,
        }
    }}
