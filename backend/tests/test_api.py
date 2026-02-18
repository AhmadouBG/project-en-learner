from unittest.mock import Mock
from aiohttp import request
from fastapi.testclient import TestClient

# from api_meaning import get_meaning
from backend.main import app
from backend.services.meaning_service import MeaningService
from routes.api_meaning import get_meaning
from schemas import MeaningResponse
# # Test service independently
def test_meaning_service():
    service = MeaningService()
    
    result = service.get_meaning("hello")
    
    assert result.text == "hello"
    assert result.meaning is not None
    # Testing ONLY business logic 😊
