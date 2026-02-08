# backend/api/schemas/api_schemas.py
from pydantic import BaseModel, Field, field_validator
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


# backend/api/schemas.py - ADD these classes

from typing import List, Optional
from pydantic import BaseModel, Field

# ... existing schemas ...

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