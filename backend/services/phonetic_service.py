# backend/services/phonetic_service.py - REFACTORED VERSION

import logging
import re
from typing import List, Dict
import eng_to_ipa as ipa

from backend.core.config import get_settings
from backend.core.exceptions import ValidationError
from backend.api.schemas.api_schemas import PhoneticsResponse, PhoneticWord

logger = logging.getLogger(__name__)

class PhoneticService:
    """
    Service for generating phonetic transcriptions
    Uses eng_to_ipa library (fast, local, reliable)
    """
    
    def __init__(self):
        logger.info("🔤 Initializing PhoneticService...")
        self.settings = get_settings()
        self.cache = {}  # Cache phonetics
        logger.info("✅ PhoneticService ready (using eng_to_ipa)")
    
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
        
        # Split into words
        words = self._extract_words(text)
        
        # Get phonetics for each word
        phonetic_words = []
        for word in words:
            phonetic_data = self._get_word_phonetics(
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
    
    def _extract_words(self, text: str) -> List[str]:
        """Extract words from text"""
        # Remove punctuation and split
        words = re.findall(r'\b[a-zA-Z]+\b', text)
        return [w.lower() for w in words if w]
    
    def _get_word_phonetics(
        self,
        word: str,
        include_ipa: bool,
        include_syllables: bool
    ) -> PhoneticWord:
        """Get phonetic data for a single word using eng_to_ipa"""
        
        # Check cache
        cache_key = f"{word}_{include_ipa}_{include_syllables}"
        if cache_key in self.cache:
            logger.debug(f"💾 Cache hit for: {word}")
            return self.cache[cache_key]
        
        try:
            # Get IPA transcription
            ipa_text = ""
            if include_ipa:
                ipa_text = ipa.convert(word)
                # eng_to_ipa returns the word itself if not found
                # Add slashes for standard IPA notation
                if ipa_text and ipa_text != word:
                    ipa_text = f"/{ipa_text}/"
                else:
                    # Fallback: simple phonetic
                    ipa_text = f"/{word}/"
            
            # Get syllables
            syllables = []
            stress_pattern = None
            
            if include_syllables:
                syllables = self._split_syllables(word, ipa_text)
                stress_pattern = self._detect_stress(syllables, ipa_text)
            
            # Create phonetic word
            phonetic_data = PhoneticWord(
                word=word,
                ipa=ipa_text,
                syllables=syllables if syllables else [word],
                stress_pattern=stress_pattern
            )
            
            # Cache result
            self.cache[cache_key] = phonetic_data
            
            logger.debug(f"✅ Generated phonetics for '{word}': {ipa_text}")
            
            return phonetic_data
            
        except Exception as e:
            logger.warning(f"⚠️ Error for word '{word}': {e}")
            # Return basic fallback
            return PhoneticWord(
                word=word,
                ipa=f"/{word}/",
                syllables=[word],
                stress_pattern="1"
            )
    
    def _split_syllables(self, word: str, ipa_text: str) -> List[str]:
        """
        Split word into syllables
        Simple algorithm based on vowel patterns
        """
        # Remove IPA slashes if present
        clean_ipa = ipa_text.strip('/') if ipa_text else word
        
        # Common vowel sounds in IPA
        vowels = 'aeiouæɑɔəɛɪʊʌAEIOU'
        
        # Simple syllable splitting
        syllables = []
        current_syllable = ""
        
        for i, char in enumerate(word):
            current_syllable += char
            
            # Check if current char is vowel
            is_vowel = char.lower() in vowels
            
            # Check if next char is consonant (end of syllable)
            if is_vowel and i < len(word) - 1:
                next_char = word[i + 1]
                if next_char.lower() not in vowels:
                    # Check if there are more vowels ahead
                    remaining = word[i + 2:]
                    if any(c.lower() in vowels for c in remaining):
                        syllables.append(current_syllable)
                        current_syllable = ""
        
        # Add remaining
        if current_syllable:
            syllables.append(current_syllable)
        
        # If no syllables found, return whole word
        if not syllables:
            syllables = [word]
        
        return syllables
    
    def _detect_stress(self, syllables: List[str], ipa_text: str) -> str:
        """
        Detect stress pattern
        Simple heuristic: first syllable stressed for short words
        """
        if not syllables or len(syllables) == 0:
            return "1"
        
        # Check IPA for stress markers (ˈ or ˌ)
        if ipa_text and 'ˈ' in ipa_text:
            # Has primary stress marker
            # Try to determine which syllable
            # This is simplified - just mark first as stressed
            return "1" + "0" * (len(syllables) - 1)
        
        # Default stress patterns
        if len(syllables) == 1:
            return "1"
        elif len(syllables) == 2:
            # First syllable usually stressed in English
            return "10"
        else:
            # For longer words, stress usually on first or second syllable
            # This is a simplification
            return "1" + "0" * (len(syllables) - 1)
    
    def get_cache_stats(self) -> Dict:
        """Get cache statistics"""
        return {
            "cached_words": len(self.cache),
            "cache_size_bytes": sum(
                len(str(v.dict())) for v in self.cache.values()
            )
        }
    
    def clear_cache(self):
        """Clear phonetics cache"""
        old_size = len(self.cache)
        self.cache.clear()
        logger.info(f"🧹 Cleared phonetics cache ({old_size} entries)")