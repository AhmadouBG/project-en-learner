# backend/core/config.py
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

class Settings(BaseSettings):
    """
    All configuration here
    Loaded from .env file
    """
    
    # Application
    APP_NAME: str = "TTS Learning Extension"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True

    HOST: str = "0.0.0.0"
    PORT: int = 8000
    
    # CORS
    ALLOWED_ORIGINS: list = [
        "*"  # Allow all origins for development
    ]

    # API Keys 
    API_KEY_GEMINI: str 
    
    # Database (future)
    DATABASE_URL: str = "sqlite+aiosqlite:///./tts_extension.db"

    
    # Pydantic v2 config
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",  # ⬅️ VERY IMPORTANT
    )

@lru_cache()
def get_settings() -> Settings:
    """
    Get cached settings instance
    Singleton pattern
    """
    return Settings()

# Test it works
if __name__ == "__main__":
    settings = get_settings()
    print(f"✅ Config loaded: {settings.APP_NAME}")
