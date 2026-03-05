# backend/services/coqui_tts_service.py - VITS VERSION

import os
import logging
import hashlib
from pathlib import Path
from typing import Optional
import torch
from TTS.api import TTS

from backend.core.config import get_settings
from backend.core.exceptions import ExternalServiceError, ValidationError
from backend.api.schemas.api_schemas import AudioGenerateResponse
# backend/services/coqui_tts_service.py - Add at top

import os

# ✅ Fix for Windows
if os.name == 'nt':
    espeak_path = r"C:\Program Files\eSpeak NG"
    if os.path.exists(espeak_path):
        os.environ['PATH'] = espeak_path + os.pathsep + os.environ['PATH']
logger = logging.getLogger(__name__)

class CoquiTTSService:
    """
    Service for generating audio using Coqui TTS with VITS model
    Fast, high quality, 109 different voices
    """
    
    def __init__(self):
        logger.info("🎙️ Initializing CoquiTTSService (VITS)...")
        self.settings = get_settings()
        self.audio_dir = Path("audio_files")
        self.audio_dir.mkdir(exist_ok=True)
        
        # Model
        self.tts = None
        self.models_loaded = False
        
        # Device
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Using device: {self.device}")
        
        # Available speakers for VCTK/VITS
        self.available_speakers = [
            "p225", "p226", "p227", "p228", "p229", "p230", "p231", "p232",
            "p233", "p234", "p236", "p237", "p238", "p239", "p240", "p241",
            "p243", "p244", "p245", "p246", "p247", "p248", "p249", "p250",
            "p251", "p252", "p253", "p254", "p255", "p256", "p257", "p258",
            "p259", "p260", "p261", "p262", "p263", "p264", "p265", "p266",
            "p267", "p268", "p269", "p270", "p271", "p272", "p273", "p274",
            "p275", "p276", "p277", "p278", "p279", "p280", "p281", "p282",
            "p283", "p284", "p285", "p286", "p287", "p288", "p292", "p293",
            "p294", "p295", "p297", "p298", "p299", "p300", "p301", "p302",
            "p303", "p304", "p305", "p306", "p307", "p308", "p310", "p311",
            "p312", "p313", "p314", "p316", "p317", "p318", "p323", "p326",
            "p329", "p330", "p333", "p334", "p335", "p336", "p339", "p340",
            "p341", "p343", "p345", "p347", "p351", "p360", "p361", "p362",
            "p363", "p364", "p374", "p376"
        ]
        
        # Cache
        self.cache = {}
        
        logger.info("✅ CoquiTTSService ready")
    
    def _load_models(self):
        """Load VITS model"""
        if self.models_loaded:
            return
        
        try:
            logger.info("📥 Loading VITS model...")
            
            # ✅ VITS model - Fast and high quality
            # English only, 109 different speakers
            model_name = "tts_models/en/vctk/vits"
            
            self.tts = TTS(model_name).to(self.device)
            
            self.models_loaded = True
            logger.info(f"✅ VITS model loaded successfully")
            logger.info(f"   Available speakers: {len(self.available_speakers)}")
            
        except Exception as e:
            logger.error(f"❌ Failed to load models: {e}")
            raise ExternalServiceError(
                "Failed to load TTS models",
                "Coqui TTS"
            )
    
    def _get_speaker(self, voice_preset: str) -> str:
        """
        Map voice preset to VITS speaker ID
        
        Voice presets from Bark format (v2/en_speaker_X) to VITS speaker (pXXX)
        """
        # Default speakers for different voice types
        voice_map = {
            "v2/en_speaker_0": "p225",  # Female, soft
            "v2/en_speaker_1": "p226",  # Female, clear
            "v2/en_speaker_2": "p227",  # Male, deep
            "v2/en_speaker_3": "p228",  # Female, warm
            "v2/en_speaker_4": "p229",  # Male, energetic
            "v2/en_speaker_5": "p230",  # Female, professional
            "v2/en_speaker_6": "p231",  # Male, neutral (default)
            "v2/en_speaker_7": "p232",  # Female, friendly
            "v2/en_speaker_8": "p233",  # Male, professional
            "v2/en_speaker_9": "p234",  # Female, young
            "default": "p231",          # Default male
        }
        
        # Get speaker from map or use default
        speaker = voice_map.get(voice_preset, "p231")
        
        # If direct speaker ID provided (e.g., "p225"), use it
        if voice_preset.startswith("p") and voice_preset in self.available_speakers:
            speaker = voice_preset
        
        logger.info(f"Voice preset '{voice_preset}' → Speaker '{speaker}'")
        return speaker
    
    async def generate_audio(
        self, 
        text: str,
        voice_preset: str = "v2/en_speaker_6"
    ) -> AudioGenerateResponse:
        """
        Generate audio from text using VITS model
        
        Args:
            text: Text to convert to speech
            voice_preset: Voice style (Bark format or direct speaker ID like "p225")
            
        Returns:
            AudioGenerateResponse with audio file URL
        """
        if not text or not text.strip():
            raise ValidationError("Text cannot be empty")
        
        text = text.strip()
        
        # Limit text length for performance
        if len(text) > 200:
            text = text[:200]
            logger.warning(f"Text truncated to 200 chars")
        
        # Get speaker ID
        speaker = self._get_speaker(voice_preset)
        
        # Check cache
        cache_key = hashlib.md5(f"{text}_{speaker}".encode()).hexdigest()
        
        if cache_key in self.cache:
            logger.info(f"💾 Cache hit for: {text[:30]}...")
            return self.cache[cache_key]
        
        try:
            logger.info(f"🎙️ Generating audio for: {text[:50]}...")
            logger.info(f"   Using speaker: {speaker}")
            
            # Load models if not loaded
            self._load_models()
            
            # Generate filename
            filename = f"audio_{cache_key}.wav"
            filepath = self.audio_dir / filename
            
            # ✅ Generate audio with VITS
            logger.info("Generating speech with VITS...")
            
            self.tts.tts_to_file(
                text=text,
                file_path=str(filepath),
                speaker=speaker  # Use specific speaker
            )
            
            logger.info(f"✅ Audio file created: {filepath}")
            
            # Get audio duration
            import soundfile as sf
            audio_data, sample_rate = sf.read(filepath)
            duration = len(audio_data) / sample_rate
            
            # Create response
            audio_url = f"/api/audio/files/{filename}"
            
            response = AudioGenerateResponse(
                text=text,
                audio_url=audio_url,
                duration=duration,
                voice_preset=voice_preset
            )
            
            # Cache response
            self.cache[cache_key] = response
            
            logger.info(f"✅ Audio generated: {filename} ({duration:.2f}s)")
            
            return response
            
        except Exception as e:
            logger.error(f"❌ Error generating audio: {e}", exc_info=True)
            raise ExternalServiceError(str(e), "Coqui TTS")
    
    def list_speakers(self):
        """Get list of available speakers"""
        return {
            "model": "tts_models/en/vctk/vits",
            "total_speakers": len(self.available_speakers),
            "speakers": self.available_speakers,
            "recommended": {
                "female_soft": "p225",
                "female_clear": "p226",
                "male_deep": "p227",
                "female_warm": "p228",
                "male_energetic": "p229",
                "female_professional": "p230",
                "male_neutral": "p231",  # Default
                "female_friendly": "p232"
            }
        }
    
    def get_cache_stats(self):
        """Get cache statistics"""
        return {
            "cached_audio": len(self.cache),
            "audio_files": len(list(self.audio_dir.glob("*.wav"))),
            "models_loaded": self.models_loaded,
            "device": self.device,
            "model": "tts_models/en/vctk/vits" if self.models_loaded else None,
            "available_speakers": len(self.available_speakers)
        }
    
    def clear_old_files(self, max_age_hours: int = 24):
        """Clear audio files older than max_age_hours"""
        import time
        
        now = time.time()
        max_age_seconds = max_age_hours * 3600
        deleted = 0
        
        for filepath in self.audio_dir.glob("*.wav"):
            file_age = now - filepath.stat().st_mtime
            if file_age > max_age_seconds:
                filepath.unlink()
                deleted += 1
        
        logger.info(f"🧹 Deleted {deleted} old audio files")
        return deleted
    
    def clear_cache(self):
        """Clear in-memory cache"""
        self.cache.clear()
        logger.info("🧹 Cache cleared")