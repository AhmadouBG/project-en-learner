"""FastAPI app entry for the project.

Run from the project root with:
    uvicorn backend.main:app --reload
or
    python -m backend.main
"""
from fastapi import FastAPI
from backend.api.learner_api import router as learner_router
from backend.api.bark import router as bark_router

app = FastAPI(title="Project EN Learner - Backend")

app.include_router(learner_router, prefix="/api")
app.include_router(bark_router)

@app.get("/")
async def root():
    return {"message": "Project EN Learner backend is running"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
