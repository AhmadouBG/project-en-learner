# backend/api/dependencies.py
from functools import lru_cache
from backend.services.bark_service import BarkService
from backend.services.meaning_service import MeaningService
from backend.core.config import get_settings
from backend.services.phonetic_service import PhoneticService

@lru_cache()
def get_meaning_service() -> MeaningService:
    """
    Singleton MeaningService
    Only creates once, reuses forever
    """
    print("🔧 Initializing MeaningService (should see this only once)")
    return MeaningService()

@lru_cache()
def get_phonetic_service() -> PhoneticService:  # NEW
    """Singleton PhoneticService"""
    print("🔤 Initializing PhoneticService singleton")
    return PhoneticService()

@lru_cache()
def get_bark_service() -> BarkService:  # NEW
    """Singleton BarkService"""
    return BarkService()
# Optional: Add more dependencies
@lru_cache()
def get_settings_dependency():
    return get_settings()

