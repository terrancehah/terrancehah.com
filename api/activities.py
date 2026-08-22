"""GET /api/activities — Fetch recent running activities from Garmin."""

from fastapi.responses import JSONResponse
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_garmin_client, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/activities so routes at "/" match)
app = create_app("activities")


@app.get("/")
async def activities(token: str = "", limit: int = 10, offset: int = 0):
    """Fetch recent activities from Garmin, filtered to running only.

    Supports pagination via the offset parameter. The Garmin API's
    get_activities(start, limit) uses 0-based indexing, so offset maps
    directly to the start parameter. We fetch more than requested to
    account for non-running activities that get filtered out.
    """
    client = _get_garmin_client(token)
    # Over-fetch to compensate for non-running activities that will be
    # filtered out. Fetch 3x the requested limit so we have a buffer.
    fetch_limit = max(limit * 3, 30) if offset == 0 else limit * 3
    try:
        activities = client.get_activities(offset, fetch_limit)
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
    # Trim to the requested limit after filtering
    slim = slim[:limit]
    return JSONResponse(content={"activities": slim})
