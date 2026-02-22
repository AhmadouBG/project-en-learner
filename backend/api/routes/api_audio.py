# backend/api/routes/audio.py - NEW FILE

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from pathlib import Path

from backend.api.schemas.api_schemas import AudioGenerateRequest, AudioGenerateResponse
from backend.api.dependencies import get_bark_service
from backend.services.bark_service import BarkService

router = APIRouter(prefix="/api/audio", tags=["Audio"])

@router.post("/generate", response_model=AudioGenerateResponse)
async def generate_audio(
    request: AudioGenerateRequest,
    service: BarkService = Depends(get_bark_service)
) -> AudioGenerateResponse:
    """
    Generate audio from text using Bark TTS
    
    - **text**: Text to convert to speech (max 500 chars)
    - **voice_preset**: Voice style (default: v2/en_speaker_6)
    
    Available voice presets:
    - v2/en_speaker_0 to v2/en_speaker_9 (English speakers)
    """
    try:
        return await service.generate_audio(
            request.text,
            request.voice_preset
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/files/{filename}")
async def get_audio_file(filename: str):
    """
    Get generated audio file
    
    - **filename**: Audio filename (e.g., audio_123456.wav)
    """
    filepath = Path("audio_files") / filename
    
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    
    return FileResponse(
        filepath,
        media_type="audio/wav",
        filename=filename
    )

@router.get("/stats")
async def get_stats(
    service: BarkService = Depends(get_bark_service)
):
    """Get audio generation statistics"""
    return service.get_cache_stats()

@router.post("/cleanup")
async def cleanup_old_files(
    max_age_hours: int = 24,
    service: BarkService = Depends(get_bark_service)
):
    """
    Clean up old audio files
    
    - **max_age_hours**: Delete files older than this (default: 24)
    """
    deleted = service.clear_old_files(max_age_hours)
    return {"deleted_files": deleted}