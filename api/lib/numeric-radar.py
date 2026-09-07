"""GET /api/radar — Estimated scores for 6 race-goal dimensions from Garmin data."""

from fastapi.responses import JSONResponse
from datetime import datetime, date, timedelta
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_garmin_client, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/radar so routes at "/" match)
app = create_app("radar")


@app.get("/")
async def radar(token: str = ""):
    """Return estimated scores for the 6 race-goal dimensions based on real Garmin data."""
    # _get_garmin_client re-creates the Garmin client from stored credentials
    # (raises 401 if the session is invalid or credentials are missing)
    client = _get_garmin_client(token)

    today = date.today().isoformat()
    radar = {
        "lactate_threshold": 30, "aerobic_endurance": 30, "running_economy": 30,
        "strength_durability": 30, "vo2max_speed": 30, "fatigue_resistance": 30,
    }

    # VO2max
    try:
        for days_back in range(0, 30):
            qdate = (date.today() - timedelta(days=days_back)).isoformat()
            mm = client.get_max_metrics(qdate)
            vo2 = None
            if isinstance(mm, list) and mm:
                vo2 = mm[0].get("generic", {}).get("vo2MaxValue")
            elif isinstance(mm, dict):
                vo2 = mm.get("generic", {}).get("vo2MaxValue")
            if vo2 is not None:
                radar["vo2max_speed"] = min(100, max(10, int((vo2 - 28) * 2.2)))
                break
    except Exception:
        pass

    # Training readiness
    try:
        tr = client.get_training_readiness(today)
        if isinstance(tr, list) and tr:
            score = tr[0].get("score", 0)
            radar["fatigue_resistance"] = min(100, max(10, score))
            level = (tr[0].get("level") or "").upper()
            if level == "HIGH":
                radar["running_economy"] = 75
            elif level == "MODERATE":
                radar["running_economy"] = 55
            else:
                radar["running_economy"] = 35
    except Exception:
        pass

    # HRV status
    try:
        hrv = client.get_hrv_data(today)
        if hrv and "hrvSummary" in hrv:
            status = (hrv["hrvSummary"].get("status") or "").upper()
            avg = hrv["hrvSummary"].get("weeklyAvg", 0)
            if status == "BALANCED":
                radar["lactate_threshold"] = min(100, max(20, int(avg * 2.5)))
            elif status == "UNBALANCED":
                radar["lactate_threshold"] = min(70, max(15, int(avg * 2)))
            else:
                radar["lactate_threshold"] = 30
    except Exception:
        pass

    # Weekly stats
    try:
        activities = client.get_activities(0, 30)
        now = datetime.now()
        week_ago = now.timestamp() - 7 * 86400
        weekly_km = 0
        weekly_runs = 0
        for a in activities:
            start_str = a.get("startTimeLocal") or a.get("startTimeGMT") or ""
            try:
                act_dt = datetime.strptime(start_str[:19], "%Y-%m-%d %H:%M:%S")
                if act_dt.timestamp() > week_ago:
                    weekly_km += a.get("distance", 0) / 1000
                    weekly_runs += 1
            except (ValueError, IndexError):
                continue
        radar["aerobic_endurance"] = min(100, max(5, int(weekly_km * 1.3)))
        if weekly_runs >= 5 and weekly_km > 30:
            radar["strength_durability"] = 70
        elif weekly_runs >= 3:
            radar["strength_durability"] = 50
        else:
            radar["strength_durability"] = 25
    except Exception:
        pass

    return JSONResponse(content={"radar": radar})
