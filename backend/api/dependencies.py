# backend/api/dependencies.py
from functools import lru_cache
from backend.services.meaning_service import MeaningService
from backend.core.config import get_settings

@lru_cache()
def get_meaning_service() -> MeaningService:
    """
    Singleton MeaningService
    Only creates once, reuses forever
    """
    print("🔧 Initializing MeaningService (should see this only once)")
    return MeaningService()

# Optional: Add more dependencies
@lru_cache()
def get_settings_dependency():
    return get_settings()