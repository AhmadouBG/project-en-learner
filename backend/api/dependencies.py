# backend/api/dependencies.py
"""
FastAPI dependencies (service singletons).

IMPORTANT: these imports are deliberately *inside* the functions. A module-level
import of every service meant that one missing heavy optional dependency (torch /
coqui-TTS for audio, eng_to_ipa for phonetics) made `import dependencies` fail —
which in turn made EVERY route fail to mount in `_mount_legacy_routes`, so
`/api/meaning` returned 404 even though it only needed google-genai.

Import lazily so each route only requires the dependencies it actually uses.
"""
from __future__ import annotations

from functools import lru_cache


@lru_cache()
def get_meaning_service():
    """Singleton MeaningService"""
    from backend.services.meaning_service import MeaningService

    print("🔧 Initializing MeaningService (should see this only once)")
    return MeaningService()


@lru_cache()
def get_phonetic_service():
    """Singleton PhoneticService"""
    from backend.services.phonetic_service import PhoneticService

    print("🔤 Initializing PhoneticService singleton")
    return PhoneticService()


@lru_cache()
def get_coqui_tts_service():
    """Singleton CoquiService for audio generation"""
    from backend.services.coqui_tts_service import CoquiTTSService

    return CoquiTTSService()


@lru_cache()
def get_pronunciation_service():
    """Singleton Pronunciation Service"""
    from backend.services.pronunciation_service import PronunciationService

    return PronunciationService()


@lru_cache()
def get_settings_dependency():
    from backend.core.config import get_settings

    return get_settings()
