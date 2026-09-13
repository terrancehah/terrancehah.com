"""POST /api/compile-workout — Recompile a single workout after a user edit.

The plan card, the detail sheet, the Garmin upload and the coach insight all
read one canonical workout object (see _compile_workout in lib/_shared). When
the runner edits a workout's type/distance/duration, the frontend calls this
endpoint so the paces, distances, durations, totals and step breakdown are
recomputed together — instead of mutating one raw field and letting the four
consumers drift apart.

The caller passes the day's pace zones (the plan already stores them per week)
so the recomputed paces still reflect the runner's current fitness at that
point in the block. When zones are absent, the workout's existing headline
pace is used as the goal-pace fallback.
"""

from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_session, _compile_workout, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/compile-workout so routes at "/" match)
app = create_app("compile-workout")


class CompileWorkoutRequest(BaseModel):
    token: str = ""
    workout: Optional[dict] = None
    # The day's pace zones from the plan (zones_by_date), so recompiled paces
    # stay aligned with the block's ramp. Optional.
    zones: Optional[dict] = None


@app.post("/")
async def compile_workout(body: CompileWorkoutRequest):
    """Recompile one workout into the canonical object and return it."""
    _get_session(body.token)
    w = body.workout or {}
    if not w.get("type"):
        return JSONResponse(status_code=400, content={"error": "Workout type required."})

    zones = body.zones or {}
    # Fall back to the workout's own headline pace as the goal-pace anchor so
    # a recompile without zones still resolves the main block sensibly.
    if not zones and w.get("target_pace_min_per_km"):
        zones = {"Race": w.get("target_pace_min_per_km")}

    try:
        compiled = _compile_workout(w, zones, workout_type=w.get("type"))
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Could not compile workout: {str(e)}"})

    # The insight is regenerated on demand after an edit — never carry the old
    # one, which described the pre-edit session.
    compiled["insight"] = None
    return JSONResponse(content={"workout": compiled})
