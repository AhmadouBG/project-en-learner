# backend/api/routes/pronunciation.py

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from pathlib import Path
import shutil

from backend.services.pronunciation_service import PronunciationService
from backend.api.dependencies import get_pronunciation_service

router = APIRouter(prefix="/api/pronunciation", tags=["Pronunciation"])

@router.post("/analyze")
async def analyze_pronunciation(
    audio: UploadFile = File(...),
    text: str = Form(...),
    service: PronunciationService = Depends(get_pronunciation_service)
):
    """
    Analyze pronunciation from uploaded audio
    
    - **audio**: WAV audio file of user speaking
    - **text**: Expected text (what user was supposed to say)
    
    Returns analysis with MIR score and feedback
    """
    try:
        # Save uploaded audio
        audio_dir = Path("temp_audio")
        audio_dir.mkdir(exist_ok=True)
        
        audio_path = audio_dir / f"recording_{audio.filename}"
        
        with audio_path.open("wb") as buffer:
            shutil.copyfileobj(audio.file, buffer)
        
        # Analyze
        result = await service.analyze_pronunciation(
            str(audio_path),
            text
        )
        
        # Clean up
        audio_path.unlink()
        
        return result
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/word/{word}")
async def get_word_pronunciation(
    word: str,
    service: PronunciationService = Depends(get_pronunciation_service)
):
    """Get pronunciation for a word"""
    return service.get_word_pronunciation(word)