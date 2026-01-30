import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

api_key = os.getenv("API_KEY_GEMINI")

if not api_key:
    raise ValueError("❌ API Key not found. Check your .env file!")

client = genai.Client(api_key=api_key)

response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="Explain how AI works in a few words"
)

print(response.text)
print("✅ API call successful!")

