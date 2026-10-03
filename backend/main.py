# backend/main.py
"""
Thin shim — kept so that:
  uvicorn backend.main:app --reload
continues to work without any changes to Docker, scripts or README.

All real logic lives in backend/app/main.py.
"""
from backend.app.main import app  # noqa: F401  re-exported for uvicorn

__all__ = ["app"]