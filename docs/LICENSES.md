# Licence Inventory

Every library and model used in this project is listed below.
GPL components are flagged and usage mode documented.

| Component | Version | Licence | Usage mode | Redistribution? |
|-----------|---------|---------|------------|-----------------|
| FastAPI | ≥ 0.111 | MIT | Import | Yes |
| Uvicorn | ≥ 0.29 | BSD-3 | Import | Yes |
| Pydantic v2 | ≥ 2.7 | MIT | Import | Yes |
| pydantic-settings | ≥ 2.3 | MIT | Import | Yes |
| python-dotenv | ≥ 1.0 | BSD-3 | Import | Yes |
| aiosqlite | ≥ 0.20 | MIT | Import | Yes |
| structlog | ≥ 24.1 | MIT/Apache-2 | Import | Yes |
| httpx | ≥ 0.27 | BSD-3 | Import | Yes |
| NLTK | ≥ 3.8 | Apache-2 | Import | Yes |
| WordNet data | 3.1 | WordNet licence (permissive) | Data file | See note 1 |
| phonemizer | ≥ 3.2 | GPL-3 ⚠️ | Subprocess | See note 2 |
| espeak-ng | current | GPL-3 ⚠️ | Subprocess via phonemizer | See note 2 |
| faster-whisper | ≥ 1.0 | MIT | Import | Yes |
| CTranslate2 | ≥ 4.0 | MIT | Transitive | Yes |
| Whisper small.en | — | MIT | Downloaded model | Yes |
| wav2vec2-lv-60-espeak-cv-ft | — | Apache-2 | ONNX export | Yes |
| ONNX Runtime | ≥ 1.18 | MIT | Import | Yes |
| Kokoro-82M | — | Apache-2 | ONNX | Yes |
| kokoro-onnx | — | Apache-2 | Import | Yes |
| praat-parselmouth | ≥ 0.4 | GPL-3 ⚠️ | Import (compiled ext) | See note 3 |
| librosa | ≥ 0.10 | ISC | Import | Yes |
| PyAV | ≥ 12 | BSD-3 | Import | Yes |
| panphon | current | MIT | Import | Yes |
| eng-to-ipa | 0.0.2 | MIT | Import | Yes |
| google-genai | ≥ 0.1 | Apache-2 | Optional import | Yes |
| CMUdict | current | BSD-2 | NLTK data download | Yes |

---

### Note 1 — WordNet licence

The Princeton WordNet licence is permissive and allows redistribution with
attribution. Full text: https://wordnet.princeton.edu/license-and-commercial-use

### Note 2 — espeak-ng / phonemizer (GPL-3)

`phonemizer` calls `espeak-ng` as an **external subprocess** — it is not
statically or dynamically linked.  Calling a GPL program via subprocess does
not create a derived work under GPL case law (it is comparable to calling a
command-line tool from a script).

The backend does **not** distribute espeak-ng binaries.  Users install it
independently via their system package manager (`winget install espeak-ng` /
`apt install espeak-ng`).

If redistribution of a bundled binary is ever required, replace phonemizer
with `gruut` (MIT) or `g2p_en` (MIT) and document the accuracy trade-off.

### Note 3 — praat-parselmouth (GPL-3)

`parselmouth` compiles Praat's source into a Python C-extension.  The compiled
`.pyd`/`.so` wheel is GPL-3 licensed.  Distribution of a product that *links*
this library must comply with GPL-3.

For this project:
- The backend runs locally on the user's machine — not distributed as a SaaS.
- If a packaged binary (PyInstaller, Docker) is ever shipped to end-users, the
  GPL-3 source of Praat must be offered alongside it.

Alternative if GPL is a blocker: replace parselmouth with `pyworld` (MIT) for
F0 tracking and `scipy.signal` for energy. Accuracy will be lower.

### Note 4 — YouGlish

YouGlish content is NOT fetched, proxied, cached or distributed by the backend.
The frontend uses the official YouGlish JS widget exclusively.  This complies
with YouGlish's Terms of Service.
