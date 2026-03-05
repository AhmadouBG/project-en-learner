# backend/api/routes/audio.py - UPDATE

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from pathlib import Path

from backend.api.schemas.api_schemas import AudioGenerateRequest, AudioGenerateResponse
from backend.api.dependencies import get_coqui_tts_service  # ✅ CHANGED
from backend.services.coqui_tts_service import CoquiTTSService  # ✅ CHANGED

router = APIRouter(prefix="/api/audio", tags=["Audio"])

@router.post("/generate", response_model=AudioGenerateResponse)
async def generate_audio(
    request: AudioGenerateRequest,
    service: CoquiTTSService = Depends(get_coqui_tts_service)  # ✅ CHANGED
) -> AudioGenerateResponse:
    """
    Generate audio from text using Coqui TTS
    
    - **text**: Text to convert to speech (max 500 chars)
    - **voice_preset**: Voice style (default)
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
    """Get generated audio file"""
    filepath = Path("audio_files") / filename
    
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    
    return FileResponse(
        filepath,
        media_type="audio/wav",
        filename=filename,
        headers={
            "Access-Control-Allow-Origin": "*"
        }
    )

@router.delete("/files/{filename}")
async def delete_audio_file(filename: str):
    """Delete audio file"""
    try:
        filepath = Path("audio_files") / filename
        
        if filepath.exists():
            filepath.unlink()
            return {"success": True, "message": f"Deleted {filename}"}
        
        return {"success": True, "message": "File not found"}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/stats")
async def get_stats(
    service: CoquiTTSService = Depends(get_coqui_tts_service)
):
    """Get audio generation statistics"""
    return service.get_cache_stats()
