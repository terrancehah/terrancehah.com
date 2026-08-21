"""GET /api/metrics — Fetch aggregated performance metrics from Garmin."""

from fastapi.responses import JSONResponse
from datetime import datetime, date, timedelta
import math
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_garmin_client, _get_session, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/metrics so routes at "/" match)
app = create_app("metrics")


@app.get("/")
async def metrics(token: str = ""):
    """Fetch aggregated performance metrics — Bodily patterns for Garmin data."""
    client = _get_garmin_client(token)
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    metrics = {
        "vo2max": None, "vo2max_date": None, "fitness_age": None,
        "training_readiness_score": None, "training_readiness_level": None,
        "recovery_time_hrs": None, "hrv_status": None, "hrv_last_night_avg": None,
        "hrv_weekly_avg": None, "resting_hr": None, "body_battery": None,
        "sleep_score": None, "stress_level": None,
        "weekly_distance": 0, "weekly_duration": 0, "weekly_runs": 0,
        "total_activities": 0, "device_name": "",
    }

    # VO2max — 30-day fallback
    try:
        for days_back in range(0, 30):
            qdate = (date.today() - timedelta(days=days_back)).isoformat()
            mm = client.get_max_metrics(qdate)
            vo2_val = None
            if isinstance(mm, list) and mm:
                vo2_val = mm[0].get("generic", {}).get("vo2MaxValue")
            elif isinstance(mm, dict):
                vo2_val = mm.get("generic", {}).get("vo2MaxValue")
            if vo2_val is not None:
                metrics["vo2max"] = vo2_val
                metrics["vo2max_date"] = qdate
                break
    except Exception:
        pass

    # Fitness Age — floored to nearest 0.5
    try:
        for qdate in [today, yesterday]:
            age_data = client.get_fitnessage_data(qdate)
            if isinstance(age_data, dict):
                fitness_age = age_data.get("fitnessAge")
                if fitness_age is not None:
                    metrics["fitness_age"] = math.floor(fitness_age * 2) / 2
                    break
    except Exception:
        pass

    # Training readiness
    try:
        for qdate in [today, yesterday]:
            tr = client.get_training_readiness(qdate)
            if isinstance(tr, list) and tr:
                score = tr[0].get("score")
                if score is not None:
                    metrics["training_readiness_score"] = score
                    metrics["training_readiness_level"] = tr[0].get("level")
                    recovery_sec = tr[0].get("recoveryTime", 0)
                    metrics["recovery_time_hrs"] = round(recovery_sec / 3600, 1) if recovery_sec else None
                    break
    except Exception:
        pass

    # HRV
    try:
        for qdate in [today, yesterday]:
            hrv = client.get_hrv_data(qdate)
            if isinstance(hrv, dict) and "hrvSummary" in hrv:
                s = hrv["hrvSummary"]
                avg = s.get("lastNightAvg") or s.get("weeklyAvg")
                if avg is not None:
                    metrics["hrv_last_night_avg"] = s.get("lastNightAvg")
                    metrics["hrv_weekly_avg"] = s.get("weeklyAvg")
                    metrics["hrv_status"] = s.get("status")
                    break
    except Exception:
        pass

    # Body Battery
    try:
        for qdate in [today, yesterday]:
            bb = client.get_body_battery(qdate)
            if isinstance(bb, list) and bb:
                values = bb[0].get("bodyBatteryValuesArray", [])
                for pair in reversed(values):
                    if len(pair) >= 2 and pair[1] is not None:
                        metrics["body_battery"] = pair[1]
                        break
                if metrics["body_battery"] is not None:
                    break
    except Exception:
        pass

    # Sleep Score
    try:
        for qdate in [today, yesterday]:
            sleep = client.get_sleep_data(qdate)
            if isinstance(sleep, dict):
                overall = sleep.get("sleepScores", {}).get("overall")
                if isinstance(overall, dict):
                    score = overall.get("value")
                elif isinstance(overall, (int, float)):
                    score = overall
                else:
                    dto = sleep.get("dailySleepDTO", {})
                    overall = dto.get("sleepScores", {}).get("overall", {})
                    score = overall.get("value") if isinstance(overall, dict) else overall
                if score is not None:
                    metrics["sleep_score"] = score
                    break
    except Exception:
        pass

    # Stress Level
    try:
        for qdate in [today, yesterday]:
            stress = client.get_all_day_stress(qdate)
            if isinstance(stress, dict):
                avg = stress.get("avgStressLevel")
                if avg is not None and avg > 0:
                    metrics["stress_level"] = avg
                    break
    except Exception:
        pass

    # Resting HR
    try:
        summary = client.get_user_summary(today)
        metrics["resting_hr"] = summary.get("restingHeartRate")
    except Exception:
        pass

    # Device name from session
    sess = _get_session(token)
    metrics["device_name"] = sess.get("device_name", "")

    # Weekly stats
    try:
        activities = client.get_activities(0, 30)
        metrics["total_activities"] = len(activities)
        now = datetime.now()
        week_ago = now.timestamp() - 7 * 86400
        weekly_acts = []
        for a in activities:
            start_str = a.get("startTimeLocal") or a.get("startTimeGMT") or ""
            try:
                act_dt = datetime.strptime(start_str[:19], "%Y-%m-%d %H:%M:%S")
                if act_dt.timestamp() > week_ago:
                    weekly_acts.append(a)
            except (ValueError, IndexError):
                continue
        metrics["weekly_runs"] = len(weekly_acts)
        metrics["weekly_distance"] = round(sum(a.get("distance", 0) for a in weekly_acts) / 1000, 1)
        metrics["weekly_duration"] = round(sum(a.get("duration", 0) for a in weekly_acts) / 3600, 1)
    except Exception:
        pass

    return JSONResponse(content={"metrics": metrics})
