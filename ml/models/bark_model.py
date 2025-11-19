"""Lightweight wrapper around the `suno/bark-small` model used by the API.

This module exposes `load_model()` and `generate()` so it can be safely
imported by the FastAPI app without executing heavy work on import.
If required libraries are missing, ImportError is raised with a helpful hint.
"""
from typing import Any, Dict

_MODEL = None
_PROCESSOR = None


def load_model(model_name: str = "suno/bark-small") -> None:
	"""Load model and processor into module-level variables.

	This is idempotent — subsequent calls do nothing.
	Raises ImportError with guidance when dependencies are missing.
	"""
	global _MODEL, _PROCESSOR
	if _MODEL is not None and _PROCESSOR is not None:
		return

	try:
		from transformers import BarkModel, BarkProcessor
	except Exception as e:  # pragma: no cover - helpful runtime message
		raise ImportError(
			"Missing dependency for Bark model. Install with: `pip install transformers` "
			"(and a backend like `torch`). Original error: %s" % (e,)
		)

	_MODEL = BarkModel.from_pretrained(model_name)
	_PROCESSOR = BarkProcessor.from_pretrained(model_name)


def generate(text: str, voice_preset: str = "v2/en_speaker_3", **kwargs: Any) -> Dict[str, Any]:
	"""Generate speech output for `text`.

	Returns a dict with minimal metadata and the raw numpy array bytes in
	base64 form under the key `audio_base64`.

	Note: The function will call `load_model()` if the model isn't available.
	"""
	if _MODEL is None or _PROCESSOR is None:
		load_model()

	inputs = _PROCESSOR(text, voice_preset=voice_preset)
	# model.generate may return a torch tensor; convert to numpy safely
	out = _MODEL.generate(**inputs)

	try:
		# attempt to convert to CPU numpy
		arr = out.cpu().numpy()
	except Exception:
		# fallback if `out` is already a numpy array
		arr = out

	# Serialize numpy array to bytes for transport; keep simple with numpy.save
	import io, base64
	import numpy as _np

	bio = io.BytesIO()
	_np.save(bio, arr, allow_pickle=False)
	bio.seek(0)
	audio_b64 = base64.b64encode(bio.read()).decode("ascii")

	return {
		"shape": getattr(getattr(arr, 'shape', None), '__str__', lambda: None)(),
		"dtype": str(getattr(getattr(arr, 'dtype', None), 'name', 'unknown')),
		"audio_base64": audio_b64,
	}


__all__ = ["load_model", "generate"]