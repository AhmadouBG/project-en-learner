import json
from dotenv import load_dotenv, find_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel
import os
from google import genai

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Load .env from project root
load_dotenv()

# 🔑 API key
api_key = os.getenv("API_KEY_GEMINI")
if not api_key:
    raise ValueError("❌ API Key not found")

client = genai.Client(api_key=api_key)


class MeaningRequest(BaseModel):
    text: str


@app.post("/meaning")
def get_meaning(payload: MeaningRequest):
    prompt = f"""
You are a dictionary API.

Return ONLY valid JSON.
NO markdown.
NO explanation.
NO extra text.

JSON format:
{{
  "meaning": "short clear explanation",
  "synonyms": ["synonym1", "synonym2"],
  "examples": ["example sentence 1", "example sentence 2"]
}}

Text:
"{payload.text}"
"""

    response = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)

    try:
        data = json.loads(response.text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Invalid JSON from Gemini")

    return {
        "text": payload.text,
        "meaning": data["meaning"],
        "synonyms": data["synonyms"],
        "examples": data["examples"]
    }
