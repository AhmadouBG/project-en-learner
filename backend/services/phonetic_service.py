# backend/services/phonetic_service.py - NEW FILE

import logging
import re
from typing import List, Dict
from google import genai
import json
import asyncio
from concurrent.futures import ThreadPoolExecutor

from backend.core.config import get_settings
from backend.core.exceptions import ExternalServiceError, ValidationError
from backend.api.schemas.api_schemas import PhoneticsResponse, PhoneticWord

logger = logging.getLogger(__name__)

class PhoneticService:
    """
    Service for generating phonetic transcriptions
    Uses Gemini AI for IPA generation
    """
    
    def __init__(self):
        logger.info("🔤 Initializing PhoneticService...")
        self.settings = get_settings()
        self._initialize_gemini()
        self.cache = {}  # Cache phonetics
        logger.info("✅ PhoneticService ready")
    
    def _initialize_gemini(self):
        """Initialize Gemini API"""
        try:
            print("🔧 Initializing Gemini API...")
            api_key = getattr(self.settings, "API_KEY_GEMINI", None)
            if not api_key:
                raise ValueError("GEMINI API key (API_KEY_GEMINI) not configured")
            try:
                print(f"🔑 Using API Key: {api_key[:10]}...")
            except Exception:
                # safe-print in case key is not a string
                print("🔑 Using API Key: <redacted>")
            self.client =genai.Client(api_key=api_key)
            logger.info("✅ Gemini API configured for phonetics")
        except Exception as e:
            logger.error(f"❌ Gemini init failed: {e}")
            raise ExternalServiceError(
                "Failed to initialize AI service",
                "Gemini"
            )
    
    async def get_phonetics(
        self, 
        text: str,
        include_ipa: bool = True,
        include_syllables: bool = True
    ) -> PhoneticsResponse:
        """
        Get phonetic breakdown for text
        
        Args:
            text: Text to analyze
            include_ipa: Include IPA transcription
            include_syllables: Include syllable breakdown
            
        Returns:
            PhoneticsResponse with phonetic data
        """
        if not text or not text.strip():
            raise ValidationError("Text cannot be empty")
        
        text = text.strip()
        logger.info(f"🔤 Getting phonetics for: {text[:50]}...")
        
        try:
            # Split into words
            words = self._extract_words(text)
            
            # Get phonetics for each word
            phonetic_words = []
            for word in words:
                phonetic_data = await self._get_word_phonetics(
                    word,
                    include_ipa,
                    include_syllables
                )
                phonetic_words.append(phonetic_data)
            
            result = PhoneticsResponse(
                text=text,
                words=phonetic_words,
                word_count=len(phonetic_words)
            )
            
            logger.info(f"✅ Phonetics generated for {len(phonetic_words)} words")
            return result
            
        except Exception as e:
            logger.error(f"❌ Error getting phonetics: {e}")
            raise ExternalServiceError(str(e), "PhoneticService")
    
    def _extract_words(self, text: str) -> List[str]:
        """Extract words from text"""
        # Remove punctuation and split
        words = re.findall(r'\b[a-zA-Z]+\b', text)
        return [w.lower() for w in words if w]
    
    async def _get_word_phonetics(
        self,
        word: str,
        include_ipa: bool,
        include_syllables: bool
    ) -> PhoneticWord:
        """Get phonetic data for a single word"""
        
        # Check cache
        cache_key = f"{word}_{include_ipa}_{include_syllables}"
        if cache_key in self.cache:
            logger.info(f"💾 Cache hit for: {word}")
            return self.cache[cache_key]
        
        try:
            # Build prompt
            prompt = self._build_phonetic_prompt(word, include_ipa, include_syllables)
            
            # Call Gemini
            response = await self._call_gemini(prompt)
            
            # Parse response
            phonetic_data = self._parse_phonetic_response(
                response,
                word,
                include_ipa,
                include_syllables
            )
            
            # Cache result
            self.cache[cache_key] = phonetic_data
            
            return phonetic_data
            
        except Exception as e:
            logger.warning(f"⚠️ Error for word '{word}': {e}", exc_info=True)
            # Return basic data
            return PhoneticWord(
                word=word,
                ipa="",
                syllables=[word],
                stress_pattern=None
            )
    
    def _build_phonetic_prompt(
        self,
        word: str,
        include_ipa: bool,
        include_syllables: bool
    ) -> str:
        """Build prompt for Gemini"""
        
        prompt = f"""You are a phonetics expert.

Return ONLY valid JSON. NO markdown, NO explanation.

Word: "{word}"

Format:
{{
  "word": "{word}",
  "ipa": "/IPA transcription here/",
  "syllables": ["syl", "la", "bles"],
  "stress_pattern": "010" (0=unstressed, 1=stressed)
}}

Requirements:
- IPA: Use International Phonetic Alphabet notation
- Syllables: Break word into syllables
- Stress: Mark stressed syllables (1) and unstressed (0)
"""
        
        return prompt
    
    def _parse_phonetic_response(
        self,
        response: str,
        word: str,
        include_ipa: bool,
        include_syllables: bool
    ) -> PhoneticWord:
        """Parse Gemini response"""
        
        try:
            logger.debug(f"Raw Gemini response for '{word}': {response[:200]}")
            # Clean response
            clean = response.strip()
            if clean.startswith("```json"):
                clean = clean[7:]
            if clean.startswith("```"):
                clean = clean[3:]
            if clean.endswith("```"):
                clean = clean[:-3]
            clean = clean.strip()
            logger.debug(f"Cleaned response for '{word}': {clean[:200]}")
            
            # Parse JSON
            data = json.loads(clean)
            logger.debug(f"Parsed JSON for '{word}': {data}")
            
            return PhoneticWord(
                word=word,
                ipa=data.get("ipa", "") if include_ipa else "",
                syllables=data.get("syllables", [word]) if include_syllables else [],
                stress_pattern=data.get("stress_pattern")
            )
            
        except json.JSONDecodeError as e:
            logger.warning(f"JSON parse failed for '{word}': {e}")
            # Fallback
            return PhoneticWord(
                word=word,
                ipa="",
                syllables=[word],
                stress_pattern=None
            )
    
    def get_cache_stats(self) -> Dict:
        """Get cache statistics"""
        return {
            "cached_words": len(self.cache),
            "cache_size_bytes": sum(
                len(str(v)) for v in self.cache.values()
            )
        }
    async def _call_gemini(self, prompt: str) -> str:
        """
        Call Gemini API - synchronous API wrapped in async
        """
        try:
            # Run blocking call in thread pool
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=prompt
                )
            )
            logger.debug(f"Gemini raw response: {response}")
            logger.debug(f"Gemini response.text: {response.text}")
            return response.text
        except Exception as e:
            logger.error(f"Gemini API error: {e}", exc_info=True)
            raise ExternalServiceError(
                message="AI service temporarily unavailable",
                service_name="Gemini"
            )