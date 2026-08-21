"""POST /api/onboarding — Save the user's race goal via form data."""

from fastapi import Form
from fastapi.responses import JSONResponse
from datetime import datetime
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_session, _save_sessions_to_disk, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/onboarding so routes at "/" match)
app = create_app("onboarding")


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
