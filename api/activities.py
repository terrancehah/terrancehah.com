"""GET /api/activities — Fetch recent running activities from Garmin."""

from fastapi.responses import JSONResponse
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import (
    _get_garmin_client, _get_session, _get_cached_garmin_data,
    _slim_activity, _compute_goal_pace_ms, ALLOWED_ACTIVITY_TYPES, create_app,
)

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
    # The cache is pre-filtered to ALLOWED_ACTIVITY_TYPES by metrics.py.
    if offset == 0:
        cached = _get_cached_garmin_data(token)
        if cached and cached.get("ui_activities"):
            return JSONResponse(content={"activities": cached["ui_activities"][:limit]})

    client = _get_garmin_client(token)
    # Over-fetch to compensate for excluded activities that get filtered out.
    fetch_limit = max(limit * 3, 30) if offset == 0 else limit * 3
    try:
        activities = client.get_activities(offset, fetch_limit)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    # Filter to allowed activity types (running + cross-training) and convert
    # to slim format. _slim_activity handles both running (pace-based tag) and
    # non-running (type-based tag) activities.
    sess = _get_session(token)
    goal_pace_ms = _compute_goal_pace_ms(sess.get("race_goal"))
    slim = []
    for a in activities:
        type_key = a.get("activityType", {}).get("typeKey", "unknown")
        if type_key.lower() not in ALLOWED_ACTIVITY_TYPES:
            continue
        slim.append(_slim_activity(a, goal_pace_ms))
    # Trim to the requested limit after filtering
    slim = slim[:limit]
    return JSONResponse(content={"activities": slim})
