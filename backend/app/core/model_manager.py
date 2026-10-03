# backend/app/core/model_manager.py
"""
Model manager — tracks the load state of every heavy model.

Each phase registers its models here at startup.  The /api/health endpoint
reads this registry to report which models are ready.

Usage (from a service's lifespan setup):
    from backend.app.core.model_manager import model_registry
    model_registry.set_ready("asr", "faster-whisper/small.en")
"""
from __future__ import annotations

import structlog
from dataclasses import dataclass, field

logger = structlog.get_logger(__name__)


@dataclass
class ModelStatus:
    ready: bool = False
    name: str | None = None
    error: str | None = None


@dataclass
class ModelRegistry:
    """Thread-safe (GIL protects plain dict writes) model status store."""

    _models: dict[str, ModelStatus] = field(default_factory=dict)

    def register(self, slot: str) -> None:
        """Declare a model slot as not-yet-loaded."""
        self._models.setdefault(slot, ModelStatus())

    def set_ready(self, slot: str, name: str) -> None:
        self._models[slot] = ModelStatus(ready=True, name=name)
        logger.info("model.ready", slot=slot, name=name)

    def set_error(self, slot: str, error: str) -> None:
        self._models[slot] = ModelStatus(ready=False, error=error)
        logger.error("model.error", slot=slot, error=error)

    def status(self, slot: str) -> ModelStatus:
        return self._models.get(slot, ModelStatus())

    def all_ready(self) -> bool:
        """True only when every registered slot is ready."""
        return all(m.ready for m in self._models.values()) and bool(self._models)

    def to_dict(self) -> dict[str, dict]:
        return {
            slot: {"ready": m.ready, "name": m.name, "error": m.error}
            for slot, m in self._models.items()
        }


# Singleton — import this from any service
model_registry = ModelRegistry()

# Pre-register the four model slots described in the spec
for _slot in ("asr", "phoneme", "tts", "llm"):
    model_registry.register(_slot)
