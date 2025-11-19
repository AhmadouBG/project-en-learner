from fastapi import APIRouter

router = APIRouter()


@router.get("/read")
def learner():
    """Simple read check endpoint."""
    return {"status": "ok"}
