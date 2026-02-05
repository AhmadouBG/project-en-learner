# backend/api/routes/meaning.py
from fastapi import APIRouter, HTTPException
from backend.api.schemas.api_schemas import MeaningRequest, MeaningResponse
from backend.services.meaning_service import MeaningService

router = APIRouter(prefix="/api", tags=["Meaning"])

# Singleton service instance (reused across requests)
_service = None

def get_service():
    global _service
    if _service is None:
        _service = MeaningService()
    return _service

@router.post("/meaning", response_model=MeaningResponse)
async def get_meaning(request: MeaningRequest) -> MeaningResponse:
    """
    Get meaning of word/phrase
    
    - Input: { "text": "example" }
    - Output: { "text": "example", "meaning": "...", "synonyms": [...], "examples": [...] }
    """
    try:
        service = get_service()
        return await service.get_meaning(request.text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))