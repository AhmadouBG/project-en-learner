"""Service layer to load and call the Bark model from `ml.models.bark_model`.

Keeping a small service layer decouples the API code from model details and
makes it easier to mock in tests.
"""
from typing import Dict

from ml.models.bark_model import load_model, generate


def ensure_model() -> None:
    """Ensure model is loaded into memory. Idempotent."""
    load_model()


def synthesize(text: str, voice_preset: str = "v2/en_speaker_3") -> Dict[str, object]:
    """Generate speech for `text` using the bark model wrapper.

    Returns the dict produced by `ml.models.bark_model.generate`.
    """
    return generate(text, voice_preset=voice_preset)
