"""GET /api/activities — Fetch recent running activities from Garmin."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from lib._shared import _get_garmin_client

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


@app.get("/")
async def activities(token: str = "", limit: int = 10):
    """Fetch recent activities from Garmin, filtered to running only."""
    client = _get_garmin_client(token)
    try:
        activities = client.get_activities(0, limit)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    # Filter to running activities only — exclude hiking, cycling, walking, etc.
    running_types = {"running", "trail_running", "track_running", "treadmill_running", "virtual_run"}
    slim = []
    for a in activities:
        type_key = a.get("activityType", {}).get("typeKey", "unknown")
        if type_key.lower() not in running_types:
            continue
        slim.append({
            "id": a.get("activityId"),
            "name": a.get("activityName", "Unnamed"),
            "type": type_key,
            "start_time": a.get("startTimeLocal"),
            "distance": round(a.get("distance", 0) / 1000, 2),
            "duration": round(a.get("duration", 0) / 60, 1),
            "avg_pace": a.get("averageSpeed", 0),
            "avg_hr": a.get("averageHR"),
            "max_hr": a.get("maxHR"),
            "calories": a.get("calories"),
            "elevation_gain": round(a.get("elevationGain", 0), 1),
            "training_effect": a.get("aerobicTrainingEffect"),
            "avg_cadence": a.get("averageRunningCadenceInStepsPerMinute"),
            "elapsed_duration": round(a.get("elapsedDuration", 0) / 60, 1) if a.get("elapsedDuration") else None,
        })
    return JSONResponse(content={"activities": slim})
