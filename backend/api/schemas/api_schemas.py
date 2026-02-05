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