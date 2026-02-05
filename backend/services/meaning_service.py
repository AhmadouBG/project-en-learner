# backend/services/meaning_service.py
import json
import logging
from typing import Dict

# import os
from google import genai
from backend.core.config import get_settings
from backend.core.exceptions import ExternalServiceError, ValidationError
from backend.api.schemas.api_schemas import MeaningResponse

logger = logging.getLogger(__name__)

class MeaningService:
    """
    This is where YOUR code lives!
    All the AI logic, prompts, parsing
    """
    
    def __init__(self):
        """Initialize with configuration"""
        self.settings = get_settings()
        self._initialize_gemini()
    
    def _initialize_gemini(self):
        """Setup Gemini API - YOUR CODE"""
        try:
            print("🔧 Initializing Gemini API...")
            api_key = getattr(self.settings, "API_KEY_GEMINI", None)
            if not api_key:
                raise ValueError("GEMINI API key (API_KEY_GEMINI) not configured")
            try:
                print(f"🔑 Using API Key: {api_key[:10]}...")
            except Exception:
                # safe-print in case key is not a string
                print("🔑 Using API Key: <redacted>")
            self.client =genai.Client(api_key=api_key)
            logger.info("✅ Gemini API initialized")
        except Exception as e:
            logger.error(f"❌ Failed to initialize Gemini: {e}")
            raise ExternalServiceError(
                message=f"Failed to initialize AI service: {e}",
                service_name="Gemini"
            )
    
    async def get_meaning(self, text: str) -> MeaningResponse:
        """
        Get meaning - YOUR MAIN FUNCTION
        This is your actual business logic
        """
        if not text or not text.strip():
            raise ValidationError("Text cannot be empty")
        
        text = text.strip()
        
        try:
            # 1. Build prompt (YOUR CODE)
            prompt = self._build_prompt(text)
            
            # 2. Call AI (YOUR CODE)
            response = await self._call_gemini(prompt)
            
            # 3. Parse response (YOUR CODE)
            meaning_data = self._parse_response(response, text)
            
            # 4. Return structured data
            return MeaningResponse(**meaning_data)
            
        except Exception as e:
            logger.error(f"Error getting meaning: {e}")
            raise ExternalServiceError(
                message=f"Failed to analyze text: {str(e)}",
                service_name="Gemini"
            )
    
    def _build_prompt(self, text: str) -> str:
        """
        Build the AI prompt - YOUR EXACT PROMPT
        """
        return f"""
You are a dictionary API.

Return ONLY valid JSON.
NO markdown.
NO explanation.
NO extra text.

JSON format:
{{
  "meaning": "short clear explanation",
  "synonyms": ["synonym1", "synonym2", "synonym3"],
  "examples": ["example sentence 1", "example sentence 2", "example sentence 3"]
}}

Text:
"{text}"
"""
    
    async def _call_gemini(self, prompt: str) -> str:
        """
        Call Gemini API - YOUR AI CALL
        """
        try:
            response = self.client.models.generate_content(
                        model="gemini-2.5-flash", 
                        contents=prompt 
                )
            return response.text
        except Exception as e:
            logger.error(f"Gemini API error: {e}")
            raise ExternalServiceError(
                message="AI service temporarily unavailable",
                service_name="Gemini"
            )
    
    def _parse_response(self, response: str, original_text: str) -> Dict:
        """
        Parse JSON response - YOUR PARSING LOGIC
        """
        try:
            # Clean response (remove markdown if present)
            clean_response = response.strip()
            if clean_response.startswith("```json"):
                clean_response = clean_response[7:]
            if clean_response.startswith("```"):
                clean_response = clean_response[3:]
            if clean_response.endswith("```"):
                clean_response = clean_response[:-3]
            clean_response = clean_response.strip()
            
            # Parse JSON
            data = json.loads(clean_response)
            
            # Validate required fields
            if "meaning" not in data:
                raise ValueError("Missing 'meaning' field")
            
            # Add original text
            data["text"] = original_text
            
            # Ensure lists exist
            data.setdefault("synonyms", [])
            data.setdefault("examples", [])
            
            # Limit list sizes
            data["synonyms"] = data["synonyms"][:8]
            data["examples"] = data["examples"][:5]
            
            return data
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse JSON: {e}")
            logger.debug(f"Response was: {response}")
            
            # Fallback
            return {
                "text": original_text,
                "meaning": response[:500],  # Use raw response
                "synonyms": [],
                "examples": []
            }
        

