"""GET /api/activities — Fetch recent running activities from Garmin,
and (mode=mileage) running activities grouped by week.

The weekly-mileage endpoint was merged here so both Garmin-data readers
share one serverless function; mode=mileage serves the weekly buckets.
"""

from fastapi.responses import JSONResponse
from datetime import datetime, date, timedelta
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
async def activities(token: str = "", limit: int = 10, offset: int = 0, mode: str = "activities", weeks: int = 12):
    """Fetch recent activities (default) or weekly mileage (mode=mileage).

    Supports pagination via the offset parameter. The Garmin API's
    get_activities(start, limit) uses 0-based indexing, so offset maps
    directly to the start parameter. We fetch more than requested to
    account for non-running activities that get filtered out.
    """
    # Weekly-mileage mode (merged from weekly-mileage.py) — grouped buckets
    # served from the Redis bundle when available, else a Garmin fetch.
    if mode == "mileage":
        cached = _get_cached_garmin_data(token)
        if cached and cached.get("weekly_mileage"):
            return JSONResponse(content={"weeks": cached["weekly_mileage"]})

        client = _get_garmin_client(token)
        today = date.today()
        start_date = today - timedelta(days=today.weekday() + (weeks - 1) * 7)
        start_str = start_date.isoformat()
        end_str = today.isoformat()
        try:
            mileage_activities = client.get_activities_by_date(start_str, end_str, activitytype="running")
        except Exception as e:
            return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

        week_buckets = {}
        for i in range(weeks):
            week_start = start_date + timedelta(days=i * 7)
            week_buckets[week_start.isoformat()] = {
                "week_start": week_start.isoformat(),
                "mileage_km": 0.0,
                "run_count": 0,
            }
        for a in mileage_activities:
            start_time = a.get("startTimeLocal") or a.get("startTimeGMT") or ""
            try:
                act_dt = datetime.strptime(start_time[:19], "%Y-%m-%d %H:%M:%S")
            except (ValueError, IndexError):
                continue
            act_monday = act_dt - timedelta(days=act_dt.weekday())
            key = act_monday.date().isoformat()
            if key in week_buckets:
                week_buckets[key]["mileage_km"] += a.get("distance", 0) / 1000
                week_buckets[key]["run_count"] += 1

        result = []
        for key in sorted(week_buckets.keys()):
            bucket = week_buckets[key]
            result.append({
                "week_start": bucket["week_start"],
                "mileage_km": round(bucket["mileage_km"], 1),
                "run_count": bucket["run_count"],
            })
        return JSONResponse(content={"weeks": result})

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
