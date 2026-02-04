import json
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import os
from google import genai

app = FastAPI()

load_dotenv()

# 🔑 API key
api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise ValueError("❌ API Key not found")

genai.configure(api_key=api_key)


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

    model = genai.GenerativeModel("gemini-2.5-flash")
    response = model.generate_content(prompt)

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
