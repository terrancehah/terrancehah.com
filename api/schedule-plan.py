"""POST /api/schedule-plan — Schedule coach-suggested workouts to Garmin."""

from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional, Any
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_session, _get_garmin_client, create_app, _build_running_workout

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/schedule-plan so routes at "/" match)
app = create_app("schedule-plan")


class ScheduleDay(BaseModel):
    date: str
    workout: Optional[dict] = None


class SchedulePlanRequest(BaseModel):
    token: str = ""
    days: List[ScheduleDay] = []


def _extract_workout_id(resp: Any):
    """Pull a workout id out of a Garmin upload response, defensively.

    Garmin's response shape has varied across revisions, so accept the common
    locations: a top-level workoutId/id, or a nested workout object.
    """
    if isinstance(resp, dict):
        for key in ("workoutId", "id"):
            if resp.get(key):
                return resp[key]
        nested = resp.get("workout") or resp.get("workouts")
        if isinstance(nested, dict):
            return nested.get("workoutId") or nested.get("id")
        if isinstance(nested, list) and nested and isinstance(nested[0], dict):
            return nested[0].get("workoutId") or nested[0].get("id")
    return None


@app.post("/")
async def schedule_plan(body: SchedulePlanRequest):
    """Upload each workout as a Garmin template and schedule it on its date."""
    _get_session(body.token)
    client = _get_garmin_client(body.token)

    scheduled = []
    errors = []

    for day in body.days:
        # Rest days / empty slots are skipped — nothing to write
        if not day.workout:
            continue
        try:
            workout = _build_running_workout(day.workout)
            upload_resp = client.upload_running_workout(workout)
            # garminconnect's client returns the raw requests.Response (not a
            # parsed dict), so read the JSON body before extracting the id.
            # Without this the id is never found and the workout gets uploaded
            # but is never scheduled onto its date (no date in Garmin).
            upload_data = upload_resp.json() if hasattr(upload_resp, "json") else upload_resp
            workout_id = _extract_workout_id(upload_data)
            if not workout_id:
                errors.append({"date": day.date, "error": "Garmin did not return a workout id."})
                continue
            schedule_resp = client.schedule_workout(workout_id, day.date)
            # Keep only the JSON body of the schedule response too, so the
            # API response payload stays JSON-serializable.
            schedule_data = schedule_resp.json() if hasattr(schedule_resp, "json") else schedule_resp
            scheduled.append({
                "date": day.date,
                "workout_id": workout_id,
                "schedule": schedule_data,
            })
        except Exception as e:
            errors.append({"date": day.date, "error": str(e)})

    return JSONResponse(content={"scheduled": scheduled, "errors": errors})
