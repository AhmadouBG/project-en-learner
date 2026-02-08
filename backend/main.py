# backend/main.py
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.core.config import get_settings
from backend.api.routes.api_meaning import router as meaning_router
from backend.api.routes.api_phonetic import router as phonetic_router  # NEW
# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Get settings
settings = get_settings()

# Create app
app = FastAPI(
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

# Startup event
@app.on_event("startup")
async def startup_event():
    logger.info("🚀 Application starting...")
    logger.info(f"📝 App: {settings.APP_NAME} v{settings.APP_VERSION}")
    logger.info(f"🔧 Debug mode: {settings.DEBUG}")
# Shutdown event
@app.on_event("shutdown")
async def shutdown_event():
    logger.info("👋 Application shutting down...")

# Routes
app.include_router(meaning_router)
app.include_router(phonetic_router) 



@app.get("/")
async def root():
    return {
        "message": "TTS Learning Extension API",
        "version": settings.APP_VERSION,
        "endpoints": {
            "meaning": "/api/meaning",
            "phonetics": "/api/phonetics",  # NEW
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