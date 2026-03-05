# test_bark_small.py
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))
# test_coqui.py

from backend.services.coqui_tts_service import CoquiTTSService
import asyncio

async def test():
    service = CoquiTTSService()
    
    # Test 1: Simple generation
    print("\n1️⃣ Testing simple generation...")
    response = await service.generate_audio("Hello world, this is Coqui TTS!")
    print(f"✅ Generated: {response.audio_url}")
    print(f"   Duration: {response.duration:.2f}s")
    
    # Test 2: Cache (should be instant)
    # print("\n2️⃣ Testing cache...")
    # response2 = await service.generate_audio("Hello world, this is Coqui TTS!")
    # print(f"✅ Cached: {response2.audio_url}")
    
    # # Test 3: Different text
    # print("\n3️⃣ Testing different text...")
    # response3 = await service.generate_audio("This is a different sentence.")
    # print(f"✅ Generated: {response3.audio_url}")
    
    # Stats
    print("\n📊 Stats:")
    stats = service.get_cache_stats()
    for key, value in stats.items():
        print(f"   {key}: {value}")

asyncio.run(test())