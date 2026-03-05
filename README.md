# project_en_learner

This repository was scaffolded to follow a layered architecture:

- frontend/ - UI layer (placeholder)
- backend/ - Backend API and services (FastAPI scaffold)
- ml/ - Machine learning experiments and models
- shared/ - Shared config, docs and scripts

## Text-to-Speech (Bark)

The backend supports two different Bark TTS implementations:

1. **Original `bark` package** – quick to get started but depends on
   `torchaudio`/`encodec` native wheels which often fail on Windows (see
   `WinError 127`).  This is enabled by default and uses a lightweight
   `generate_audio` function.
2. **Transformer-based model** – uses the HuggingFace `BarkModel`/
   `BarkProcessor` via the local wrapper in `ml/models/bark_model.py`.  It
   avoids the native audio library dependency and allows finer control
   (e.g. latency/memory measurement).  To enable it set
   `USE_TRANSFORMER_BARK=True` in `.env` or your environment.

### Installation Notes

Install required packages with:

```bash
pip install -r requirements.txt \
	--extra-index-url https://download.pytorch.org/whl/cpu
```

This will pull the CPU builds of `torch`, `torchaudio`, and
`torchvision` necessary for the transformer backend, along with `encodec`
and `bark`.

### Generating Audio

The service exposes the same `generate_audio(text)` interface regardless
of the backend.  Internally it will cache WAV files under `audio_files/`
and use per-text locks to prevent duplicate work.

When using the transformer backend you can also measure performance:

```python
from backend.services.bark_service import BarkService

svc = BarkService()
svc.settings.USE_TRANSFORMER_BARK = True

result = asyncio.run(svc.measure_transformer_performance(
	"Hello world",
	nb_loops=5
))
print(result)
```

The returned dict contains timing and memory stats as well as the raw
model output.



