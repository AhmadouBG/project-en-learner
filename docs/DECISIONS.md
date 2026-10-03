# Architecture & Dependency Decisions

This document explains every non-obvious choice made during the rebuild.
Alternatives considered are listed so future maintainers understand the trade-offs.

---

## Web framework: FastAPI 0.111+

**Chosen**: FastAPI ≥ 0.111
**Rejected**: Keeping FastAPI 0.95.2 (existing)

The existing version uses the deprecated `@app.on_event("startup")` pattern and
has a duplicate `lifespan` function bug (lines 22–32 of the old `backend/main.py`
silently overwrite each other). FastAPI 0.111 stabilises the `@asynccontextmanager`
lifespan API and ships `python-multipart` support needed for Phase 4 audio upload.

---

## SQLite via aiosqlite (not SQLAlchemy, not Redis)

**Chosen**: `aiosqlite` raw queries, WAL mode
**Rejected**: SQLAlchemy (too heavy, ORM overhead), Redis (separate process,
  install friction), plain `sqlite3` (blocks the event loop)

`aiosqlite` is a thin async wrapper around the stdlib `sqlite3` module.
WAL journal mode gives concurrent readers without writer lock contention,
which matters when the cache is hit during parallel ASR + phoneme in Phase 4.

---

## Structured logging: structlog

**Chosen**: `structlog` with JSON renderer for prod and ConsoleRenderer for dev
**Rejected**: `python-json-logger` (less composable), `loguru` (non-stdlib compatible)

`structlog` context variables (`bind_contextvars`) allow every log line within
a request to carry the `request_id` without thread-local hacks — essential for
async code where multiple requests are interleaved.

---

## Token auth: custom X-API-Token (not OAuth2)

**Chosen**: static bearer token in `X-API-Token` header, compared with
  `secrets.compare_digest`
**Rejected**: OAuth2 / JWT (too heavy for a single-user local tool),
  no auth at all (unsafe even locally — any process on the machine could call it)

The token is auto-generated on first run and written to `.env` so the user never
has to manage it manually. The Chrome extension reads it from its local config.
`secrets.compare_digest` prevents timing-oracle attacks (unlikely locally but
costs nothing).

---

## ASR: faster-whisper (Phase 4)

**Chosen**: `faster-whisper` with `small.en` int8 quantised model
**Rejected**: OpenAI Whisper (PyTorch dependency, higher RAM), Vosk (lower accuracy
  on varied speech), cloud ASR (violates local-first constraint)

`faster-whisper` uses CTranslate2 under the hood — no full PyTorch stack needed.
`small.en` peak RAM is ~500 MB int8. `base.en` is a config option for slower
machines.

---

## Phoneme recognition: wav2vec2 ONNX (Phase 4)

**Chosen**: `facebook/wav2vec2-lv-60-espeak-cv-ft` exported to ONNX int8 via
  Optimum
**Rejected**: `allosaurus` (GPL, small phoneme set), espeak-only (text-based,
  not audio-based)

This model outputs IPA phonemes in the same symbol set as espeak-ng / phonemizer,
which makes alignment straightforward. The ONNX int8 export fits in ~300 MB RAM.

---

## G2P: phonemizer + espeak-ng (Phase 2)

**Chosen**: `phonemizer` backed by espeak-ng, with CMUdict as a fast-path lookup
**Rejected**: `g2p_en` (NLTK-only, no UK accent), `gruut` (licence unclear for
  some components)

espeak-ng uses a GPL licence. We call it as an external subprocess through
`phonemizer` (not linked), which is the accepted pattern for GPL tools.
CMUdict (BSD-like) covers ≈135 k words and is used first for speed.

---

## TTS: Kokoro-82M ONNX (Phase 3)

**Chosen**: Kokoro-82M via `kokoro-onnx` package (ONNX Runtime, CPU)
**Rejected**:
- Coqui TTS — the `TTS` package was archived in Jan 2024 and is no longer
  maintained. Left as a selectable provider for backward compat but not the
  default.
- Bark / HuggingFace Bark — requires full PyTorch; too slow on CPU (>30 s per
  sentence)
- Edge TTS — cloud, violates local-first constraint

Kokoro-82M achieves ~0.6× real-time on a 6-core CPU (i.e. 10-word sentence in
~1–2 s). Licence: Apache 2.0.

---

## Pitch / rhythm: praat-parselmouth + librosa DTW (Phase 5)

**Chosen**: `praat-parselmouth` for pitch, `librosa.sequence.dtw` for alignment
**Rejected**: `pyworld` (less accurate F0), custom autocorrelation (reinventing)

Praat is GPL but `parselmouth` wraps it in a compiled Python extension — we
don't distribute Praat binaries separately. Usage is local-only so GPL is
acceptable (no redistribution of a linked binary).

---

## Dictionary: NLTK WordNet (Phase 2)

**Chosen**: NLTK WordNet, fully offline after first `nltk.download()`
**Rejected**: online dictionaries (violate local-first), wiktionary scraping
  (fragile, ToS risk)

Optional Ollama enrichment (off by default) can supplement WordNet with
richer example sentences and explanations.

---

## Audio decoding: PyAV (Phase 4)

**Chosen**: `av` (PyAV) — bundles its own ffmpeg, so no system ffmpeg required
**Rejected**: `soundfile` (only PCM formats), `pydub` (requires system ffmpeg)

PyAV decodes WebM/Opus from MediaRecorder directly to float32 numpy arrays.
The bundled ffmpeg wheel is ~30 MB but eliminates a complex system dependency.

---

## YouGlish: not touched

The frontend handles YouGlish through its official JS widget.
The backend does not scrape, proxy or cache YouGlish content in any form —
doing so would violate YouGlish's Terms of Service.
