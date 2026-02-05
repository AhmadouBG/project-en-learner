from unittest.mock import Mock
from fastapi.testclient import TestClient

# from api_meaning import get_meaning
from backend.main import app
from backend.services.meaning_service import MeaningService
from schemas import MeaningResponse
# # Test service independently
# def test_meaning_service():
#     service = MeaningService()
#     service.model = MockGeminiModel()  # Mock AI
    
#     result = await service.get_meaning("hello")
    
#     assert result.text == "hello"
#     assert result.meaning is not None
#     # Testing ONLY business logic 😊

# # Test route independently
# def test_meaning_route():
#     mock_service = Mock(spec=MeaningService)
#     mock_service.get_meaning.return_value = MeaningResponse(...)
    
#     response = await get_meaning(request, service=mock_service)
    
#     assert response.status_code == 200
#     # Testing ONLY HTTP layer 😊