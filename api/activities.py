"""GET /api/activities — Fetch recent running activities from Garmin."""

from fastapi.responses import JSONResponse
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_garmin_client, _get_cached_garmin_data, _slim_activity, create_app

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
    # Serve the first page from the Redis bundle populated by /metrics —
    # zero logins / Garmin calls on the common path. Pagination (offset > 0)
    # always goes to Garmin since the cache only holds the first batch.
    if offset == 0:
        cached = _get_cached_garmin_data(token)
        if cached and cached.get("ui_activities"):
            return JSONResponse(content={"activities": cached["ui_activities"]})

    client = _get_garmin_client(token)
    # Over-fetch to compensate for non-running activities that will be
    # filtered out. Fetch 3x the requested limit so we have a buffer.
    fetch_limit = max(limit * 3, 30) if offset == 0 else limit * 3
    try:
        activities = client.get_activities(offset, fetch_limit)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    # Filter to running activities only — exclude hiking, cycling, walking, etc.
    # Uses the shared _slim_activity so the UI shape (including the classifier
    # fields max_pace / anaerobic_training_effect) matches the cached bundle.
    running_types = {"running", "trail_running", "track_running", "treadmill_running", "virtual_run"}
    slim = []
    for a in activities:
        type_key = a.get("activityType", {}).get("typeKey", "unknown")
        if type_key.lower() not in running_types:
            continue
        slim.append(_slim_activity(a))
    # Trim to the requested limit after filtering
    slim = slim[:limit]
    return JSONResponse(content={"activities": slim})
