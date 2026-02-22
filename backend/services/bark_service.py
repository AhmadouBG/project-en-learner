# backend/services/bark_service.py - NEW FILE

import os
import logging
import hashlib
from pathlib import Path
from typing import Optional
import numpy as np
from scipy.io.wavfile import write as write_wav
from bark import SAMPLE_RATE, generate_audio, preload_models

from backend.core.config import get_settings
from backend.core.exceptions import ExternalServiceError, ValidationError
from backend.api.schemas.api_schemas import AudioGenerateResponse

logger = logging.getLogger(__name__)

class BarkService:
    """
    Service for generating audio using Bark TTS model
    """
    
    def __init__(self):
        logger.info("🎙️ Initializing BarkService...")
        self.settings = get_settings()
        self.audio_dir = Path("audio_files")
        self.audio_dir.mkdir(exist_ok=True)
        self.cache = {}  # Cache generated audio
        self.models_loaded = False
        logger.info("✅ BarkService ready")
    
    def _load_models(self):
        """Load Bark models (lazy loading)"""
        if self.models_loaded:
            return
        
        try:
            logger.info("📥 Loading Bark models (this may take a while on first run)...")
            preload_models()
            self.models_loaded = True
            logger.info("✅ Bark models loaded")
        except Exception as e:
            logger.error(f"❌ Failed to load Bark models: {e}")
            raise ExternalServiceError(
                "Failed to load TTS models",
                "Bark"
            )
    
    async def generate_audio(
        self, 
        text: str,
        voice_preset: str = "v2/en_speaker_6"
    ) -> AudioGenerateResponse:
        """
        Generate audio from text using Bark
        
        Args:
            text: Text to convert to speech
            voice_preset: Voice style to use
            
        Returns:
            AudioGenerateResponse with audio file URL
        """
        if not text or not text.strip():
            raise ValidationError("Text cannot be empty")
        
        text = text.strip()
        
        # Check cache
        cache_key = hashlib.md5(f"{text}_{voice_preset}".encode()).hexdigest()
        if cache_key in self.cache:
            logger.info(f"💾 Cache hit for: {text[:30]}...")
            return self.cache[cache_key]
        
        try:
            logger.info(f"🎙️ Generating audio for: {text[:50]}...")
            
            # Load models if not loaded
            self._load_models()
            
            # Generate audio with Bark
            audio_array = generate_audio(
                text,
                history_prompt=voice_preset
            )
            
            # Generate unique filename
            filename = f"audio_{cache_key}.wav"
            filepath = self.audio_dir / filename
            
            # Save audio file
            write_wav(filepath, SAMPLE_RATE, audio_array)
            
            # Calculate duration
            duration = len(audio_array) / SAMPLE_RATE
            
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
            logger.error(f"❌ Error generating audio: {e}")
            raise ExternalServiceError(str(e), "Bark")
    
    def get_cache_stats(self):
        """Get cache statistics"""
        return {
            "cached_audio": len(self.cache),
            "audio_files": len(list(self.audio_dir.glob("*.wav"))),
            "models_loaded": self.models_loaded
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