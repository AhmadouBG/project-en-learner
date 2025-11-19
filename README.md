# project_en_learner

This repository was scaffolded to follow a layered architecture:

- frontend/ - UI layer (placeholder)
- backend/ - Backend API and services (FastAPI scaffold)
- ml/ - Machine learning experiments and models
- shared/ - Shared config, docs and scripts

How to run (backend quick start):

1. Create a virtual environment and install dependencies:

   python -m venv .venv
   .\.venv\Scripts\activate; pip install -r requirements.txt

2. Run the backend:

   python -m uvicorn backend.main:app --reload --port 8000

API endpoints:

- GET /api/health -> health check

Notes:
- This is a minimal scaffold. Add your frontend stack into `frontend/` and ML experiments into `ml/`.
