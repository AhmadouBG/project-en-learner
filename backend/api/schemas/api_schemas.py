# backend/api/schemas/api_schemas.py
from pydantic import BaseModel, Field, field_validator, validator
from typing import List, Optional

class MeaningRequest(BaseModel):
    """Input from client"""
    text: str = Field(..., min_length=1, max_length=5000)
    
    @field_validator('text')
    def text_not_empty(cls, v):
        if not v.strip():
            raise ValueError('Text cannot be empty')
        return v.strip()

class MeaningResponse(BaseModel):
    """Output to client"""
    text: str
    meaning: str
    synonyms: List[str] = []
    examples: List[str] = []
    word_type: Optional[str] = None
    difficulty_level: Optional[str] = None


class PhoneticWord(BaseModel):
    """Phonetic breakdown for a single word"""
    word: str
    ipa: str = ""
    syllables: List[str] = []
    stress_pattern: Optional[str] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "word": "hello",
                "ipa": "/həˈloʊ/",
                "syllables": ["hel", "lo"],
                "stress_pattern": "01"
            }
        }

class PhoneticsRequest(BaseModel):
    """Request for phonetic breakdown"""
    text: str = Field(..., min_length=1, max_length=5000)
    include_ipa: bool = Field(default=True)
    include_syllables: bool = Field(default=True)
    
    @field_validator('text')
    def text_not_empty(cls, v):
        if not v.strip():
            raise ValueError('Text cannot be empty')
        return v.strip()

class PhoneticsResponse(BaseModel):
    """Response with phonetic breakdown"""
    text: str
    words: List[PhoneticWord]
    word_count: int
    
    class Config:
        json_schema_extra = {
            "example": {
                "text": "hello world",
                "words": [
                    {
                        "word": "hello",
                        "ipa": "/həˈloʊ/",
                        "syllables": ["hel", "lo"],
                        "stress_pattern": "01"
                    },
                    {
                        "word": "world",
                        "ipa": "/wɜrld/",
                        "syllables": ["world"],
                        "stress_pattern": "1"
                    }
                ],
                "word_count": 2
            }
        }


class AudioGenerateRequest(BaseModel):
    """Request for audio generation"""
    text: str = Field(..., min_length=1, max_length=500)
    voice_preset: Optional[str] = Field(default="v2/en_speaker_6")
    
    @field_validator('text')
    def text_not_empty(cls, v):
        if not v.strip():
            raise ValueError('Text cannot be empty')
        return v.strip()
    
    class Config:
        json_schema_extra = {
            "example": {
                "text": "Hello, how are you?",
                "voice_preset": "v2/en_speaker_6"
            }
        }

class AudioGenerateResponse(BaseModel):
    """Response with audio file URL"""
    text: str
    audio_url: str
    duration: Optional[float] = None
    voice_preset: str
    
    class Config:
        json_schema_extra = {
            "example": {
                "text": "Hello, how are you?",
                "audio_url": "/api/audio/files/audio_123456.wav",
                "duration": 2.5,
                "voice_preset": "v2/en_speaker_6"
            }
        }