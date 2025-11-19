from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.services import model_service

router = APIRouter(prefix="/api")


class TTSRequest(BaseModel):
    text: str
    voice_preset: Optional[str] = "v2/en_speaker_3"


@router.post("/tts")
def tts(req: TTSRequest):
    """Endpoint that synthesizes speech for the provided text.

    Returns a JSON payload containing a base64-encoded numpy file with the
    raw model output and some metadata. The client can decode and process
    the numpy contents as needed.
    """
    try:
        result = model_service.synthesize(req.text, voice_preset=req.voice_preset)
    except ImportError as ie:
        # helpful error if dependencies are missing
        raise HTTPException(status_code=500, detail=str(ie))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Model error: {e}")

    return result
