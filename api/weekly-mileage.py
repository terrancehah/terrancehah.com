"""GET /api/weekly-mileage — Fetch running activities grouped by week."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from datetime import datetime, date, timedelta
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
async def weekly_mileage(token: str = "", weeks: int = 12):
    """Fetch running activities for the last N weeks and group by week."""
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
