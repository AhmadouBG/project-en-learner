# backend/api/routes/meaning.py
from fastapi import APIRouter, Depends, HTTPException
from backend.api.schemas.api_schemas import MeaningRequest, MeaningResponse
from backend.services.meaning_service import MeaningService
from backend.api.dependencies import get_meaning_service

router = APIRouter(prefix="/api", tags=["Meaning"])

# Singleton service instance (reused across requests)

@router.post("/meaning", response_model=MeaningResponse)
async def get_meaning(request: MeaningRequest, service: MeaningService = 
                      Depends(get_meaning_service)) -> MeaningResponse:
    """
    Get meaning of word/phrase
    
    - Input: { "text": "example" }
    - Output: { "text": "example", "meaning": "...", "synonyms": [...], "examples": [...] }
    """
    try:
        return await service.get_meaning(request.text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))