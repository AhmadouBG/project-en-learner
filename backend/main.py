# backend/main.py
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.core.config import get_settings
from backend.api.routes.api_meaning import router as meaning_router
from backend.api.routes.api_phonetic import router as phonetic_router
from backend.api.routes.api_audio import router as audio_router
from backend.api.routes.api_pronunciation import router as pronunciation_router
from contextlib import asynccontextmanager
# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Get settings
settings = get_settings()

# Startup event
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 Application starting...")
    logger.info(f"📝 App: {settings.APP_NAME} v{settings.APP_VERSION}")
    logger.info(f"🔧 Debug mode: {settings.DEBUG}")
    yield
# Shutdown event
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("👋 Application shutting down...")
    yield

app = FastAPI(
    lifespan=lifespan,
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/docs" if settings.DEBUG else None
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Routes
app.include_router(meaning_router)
app.include_router(phonetic_router) 
app.include_router(audio_router)  # NEW
app.include_router(pronunciation_router)



@app.get("/")
async def root():
    return {
        "message": "TTS Learning Extension API",
        "version": settings.APP_VERSION,
        "endpoints": {
            "meaning": "/api/meaning",
            "phonetics": "/api/phonetics",
            "audio": "/api/audio/generate",
            "pronunciation": "/api/pronunciation",
            "docs": "/docs" if settings.DEBUG else None
        }
    
    }

if __name__ == "__main__":
    import uvicorn
    
    logger.info("🚀 Starting server...")
    
    uvicorn.run(
        "backend.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,  # Auto-reload in debug mode
        log_level="info"
    )