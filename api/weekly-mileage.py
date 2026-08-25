"""GET /api/weekly-mileage — Fetch running activities grouped by week."""

from fastapi.responses import JSONResponse
from datetime import datetime, date, timedelta
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_garmin_client, _get_cached_garmin_data, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/weekly-mileage so routes at "/" match)
app = create_app("weekly-mileage")


@app.get("/")
async def weekly_mileage(token: str = "", weeks: int = 12):
    """Fetch running activities for the last N weeks and group by week."""
    # Serve from the Redis bundle populated by /metrics when available —
    # zero logins / Garmin calls on the common dashboard-load path.
    cached = _get_cached_garmin_data(token)
    if cached and cached.get("weekly_mileage"):
        return JSONResponse(content={"weeks": cached["weekly_mileage"]})

    client = _get_garmin_client(token)

    today = date.today()
    start_date = today - timedelta(days=today.weekday() + (weeks - 1) * 7)
    start_str = start_date.isoformat()
    end_str = today.isoformat()

    try:
        activities = client.get_activities_by_date(start_str, end_str, activitytype="running")
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    # Build week buckets keyed by Monday date
    week_buckets = {}
    for i in range(weeks):
        week_start = start_date + timedelta(days=i * 7)
        week_buckets[week_start.isoformat()] = {
            "week_start": week_start.isoformat(),
            "mileage_km": 0.0,
            "run_count": 0,
        }

    # Sum distance and count per week
    for a in activities:
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
