"""POST /api/onboarding — Save the user's race goal via form data."""

from fastapi import FastAPI, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from datetime import datetime
from lib._shared import _get_session, _save_sessions_to_disk

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://*.vercel.app",
        "https://terrancehah.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/")
async def onboarding(
    token: str = Form(""),
    purpose: str = Form(""),
    distance: str = Form(""),
    time_target: str = Form(""),
    race_date: str = Form(""),
    experience: str = Form(""),
    weekly_mileage: str = Form(""),
    mileage_unit: str = Form("km"),
    gender: str = Form(""),
    age: str = Form(""),
):
    """Save the user's race goal to their session.

    Accepts form data (multipart/form-data) from the dashboard onboarding form.
    The race goal is stored in the session and persisted to disk so it survives
    server restarts. All fields except token are optional with empty defaults.
    """
    sess = _get_session(token)
    goal = {
        "purpose": purpose,
        "distance": distance,
        "time_target": time_target,
        "race_date": race_date,
        "experience": experience,
        "weekly_mileage": weekly_mileage,
        "mileage_unit": mileage_unit,
        "gender": gender,
        "age": age,
        "saved_at": datetime.now().isoformat(),
    }
    sess["race_goal"] = goal
    # Persist updated race goal to disk
    _save_sessions_to_disk()
    return JSONResponse(content={"message": "Race goal saved.", "goal": goal})
