# backend/api/dependencies.py
from functools import lru_cache
from backend.services.coqui_tts_service import CoquiTTSService
from backend.services.meaning_service import MeaningService
from backend.core.config import get_settings
from backend.services.phonetic_service import PhoneticService
from backend.services.pronunciation_service import PronunciationService

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
def get_coqui_tts_service() -> CoquiTTSService:  # NEW
    """Singleton CoquiService for audio generation"""
    return CoquiTTSService()

@lru_cache()
def get_pronunciation_service() -> PronunciationService:
    """Singleton Pronunciation Service"""
    return PronunciationService()

@lru_cache()
def get_settings_dependency():
    return get_settings()

