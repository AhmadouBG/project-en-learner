# backend/api/routes/phonetics.py - NEW FILE

from fastapi import APIRouter, HTTPException, Depends
from backend.api.schemas.api_schemas import PhoneticsRequest, PhoneticsResponse
from backend.api.dependencies import get_phonetic_service
from backend.services.phonetic_service import PhoneticService

router = APIRouter(prefix="/api", tags=["Phonetics"])

@router.post("/phonetics", response_model=PhoneticsResponse)
async def get_phonetics(
    request: PhoneticsRequest,
    service: PhoneticService = Depends(get_phonetic_service)  # Singleton + DI
) -> PhoneticsResponse:
    """
    Get phonetic breakdown of text
    
    - Input: { "text": "hello world", "include_ipa": true, "include_syllables": true }
    - Output: { "text": "hello world", "words": [...], "word_count": 2 }
    """
    try:
        return await service.get_phonetics(
            request.text,
            request.include_ipa,
            request.include_syllables
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/phonetics/stats")
async def get_cache_stats(
    service: PhoneticService = Depends(get_phonetic_service)
):
    """Get phonetic cache statistics"""
    return service.get_cache_stats()