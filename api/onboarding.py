"""POST /api/onboarding — Save the user's race goal via form data.

GET /api/onboarding — Deterministic next-goal suggestions (no AI).
"""

from fastapi import Form
from fastapi.responses import JSONResponse
from datetime import datetime
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import (
    _get_session, _update_session, _save_persistent_race_goal, create_app,
    _delete_persistent_ai_cache, _delete_persistent_coach_cache,
    _delete_persistent_plan_syncs,
    _get_persistent_race_goal, _archive_race_goal, _get_race_history,
    _is_no_goal_marker, _race_distance_km, _save_persistent_course,
)

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/onboarding so routes at "/" match)
app = create_app("onboarding")


# The fixed suggestion set — always all four, always in this order. The
# purpose is the race type the onboarding form's picker already uses; the
# title is the plain-language reason a runner would pick it. Nothing here is
# computed, scored or predicted: these are distance options, not
# recommendations.
_SUGGESTION_CANDIDATES = [
    ("5K", 5, "Build speed",
     "A shorter race to work on speed without committing to a long block."),
    ("10K", 10, "Find a steady rhythm",
     "A balanced next step for practising a sustained effort."),
    ("Half Marathon", 21.1, "Build endurance",
     "A longer-distance option if you want time to build your endurance."),
    ("Marathon", 42.2, "Take on a longer block",
     "A longer commitment. Choose it only if the training fits your life."),
]

# Saved results sit this close to the nominal distance to count as "at this
# distance" — a 42.2 marathon goal matches a 42.195 result.
_SUGGESTION_DISTANCE_TOLERANCE_KM = 0.01


def _format_suggestion_time(seconds: int) -> str:
    """H:MM:SS for a benchmark finish time, e.g. 1:48:00."""
    seconds = max(0, int(seconds))
    hours, rem = divmod(seconds, 3600)
    mins, secs = divmod(rem, 60)
    return f"{hours}:{mins:02d}:{secs:02d}"


@app.get("/")
async def onboarding_suggestions(token: str = ""):
    """Return the four fixed next-goal options, annotated with saved results.

    Deterministic — no AI, no readiness scoring, no projections. A saved race
    at the same distance is offered as the starting target only, so the runner
    can adjust it before saving; nothing is selected or stored here.
    """
    # Authenticate first — suggestions are an account feature.
    sess = _get_session(token)
    email = sess.get("email", "") if isinstance(sess, dict) else ""

    # Sources for a benchmark, in priority order: the current goal's own saved
    # result first, then archived races newest-first.
    sources = []
    current_goal = sess.get("race_goal")
    if isinstance(current_goal, dict) and not _is_no_goal_marker(current_goal):
        result = current_goal.get("race_result") or {}
        try:
            if float(result.get("duration_min") or 0) > 0:
                sources.append(current_goal)
        except (TypeError, ValueError):
            pass
    sources.extend(reversed(_get_race_history(email)))

    suggestions = []
    any_matched = False
    for purpose, distance_km, title, description in _SUGGESTION_CANDIDATES:
        benchmark_time = None
        for source in sources:
            result = source.get("race_result") or {}
            try:
                duration_min = float(result.get("duration_min") or 0)
            except (TypeError, ValueError):
                continue
            if duration_min <= 0:
                continue
            if abs(_race_distance_km(source) - distance_km) > _SUGGESTION_DISTANCE_TOLERANCE_KM:
                continue
            benchmark_time = _format_suggestion_time(round(duration_min * 60))
            break
        if benchmark_time:
            any_matched = True
            suggestions.append({
                "purpose": purpose,
                "distance_km": distance_km,
                "title": title,
                "description": (
                    f"Your saved result at this distance is {benchmark_time}. "
                    "You can use it as a starting target and adjust it before saving."
                ),
                # The saved result is the starting target verbatim — never a
                # predicted improvement.
                "benchmark_time": benchmark_time,
                "target_time": benchmark_time,
            })
        else:
            suggestions.append({
                "purpose": purpose,
                "distance_km": distance_km,
                "title": title,
                "description": description,
                "benchmark_time": None,
                "target_time": None,
            })

    return JSONResponse(content={
        "suggestions": suggestions,
        "based_on": "saved_race" if any_matched else "distance_options",
    })


@app.post("/")
async def onboarding(
    token: str = Form(""),
    mode: str = Form("race"),
    race_name: str = Form(""),
    purpose: str = Form(""),
    distance: str = Form(""),
    time_target: str = Form(""),
    race_date: str = Form(""),
    experience: str = Form(""),
    weekly_mileage: str = Form(""),
    mileage_unit: str = Form("km"),
    fitness_race_distance: str = Form(""),
    fitness_race_time: str = Form(""),
    gender: str = Form(""),
    age: str = Form(""),
):
    """Save the user's race goal to their session.

    Accepts form data (multipart/form-data) from the dashboard onboarding form.
    The race goal is stored in the session (Redis in production, in-memory
    locally) with a sliding 7-day TTL. All fields except token are optional
    with empty defaults.

    mode="no_goal" writes the explicit no-goal tombstone instead: the runner
    has chosen to train without a race, which is account-wide and survives
    logout — the persistent key is kept, not deleted, so other devices see
    the same choice.
    """
    # Validate the session exists (raises 401 if not)
    sess = _get_session(token)
    email = sess.get("email", "")
    if mode == "no_goal":
        if email:
            # A finished race is filed to history first — the tombstone
            # replaces the goal but the result, recap and readiness it earned
            # stay on the archived copy.
            _archive_race_goal(email, _get_persistent_race_goal(email))
            _save_persistent_race_goal(email, {
                "mode": "no_goal",
                "saved_at": datetime.now().isoformat(),
            })
            # Everything derived from the old goal is dropped: AI readiness,
            # the coach plan, its sync receipts, and the course — none of them
            # describe a race that no longer exists.
            _delete_persistent_ai_cache(email)
            _delete_persistent_coach_cache(email)
            _delete_persistent_plan_syncs(email)
            _save_persistent_course(email, None)
        _update_session(token, {"race_goal": None, "goal_mode": "no_goal"})
        return JSONResponse(content={
            "message": "Running without a goal.",
            "goal": None,
            "goal_mode": "no_goal",
        })
    goal = {
        "race_name": race_name,
        "purpose": purpose,
        "distance": distance,
        "time_target": time_target,
        "race_date": race_date,
        "experience": experience,
        "weekly_mileage": weekly_mileage,
        "mileage_unit": mileage_unit,
        # Latest race result — the fitness anchor for training paces, used
        # only as a fallback when Garmin history is sparse.
        "fitness_race_distance": fitness_race_distance,
        "fitness_race_time": fitness_race_time,
        "gender": gender,
        "age": age,
        "saved_at": datetime.now().isoformat(),
    }
    # Merge the race goal into the existing session and re-save to Redis
    _update_session(token, {"race_goal": goal, "goal_mode": "race"})
    # Also persist the race goal keyed by email so it survives logout and
    # session expiry. On re-login, garmin-auth.py loads it from this store
    # and the user skips onboarding. A real goal also replaces any no-goal
    # tombstone outright — the key is never left empty for another device to
    # read as "no record".
    if email:
        # A new goal replaces the old one. If the old goal was actually raced,
        # file it to history first so its result, the coach's read and the
        # pre-race readiness survive the overwrite — the goal is the only place
        # they are kept, so this is the last chance to save them.
        _archive_race_goal(email, _get_persistent_race_goal(email))
        _save_persistent_race_goal(email, goal)
        # A changed goal invalidates every DERIVED analysis: the AI readiness
        # scores and the coach plan were both generated against the old goal,
        # and their email-keyed caches would otherwise keep serving that old
        # advice. Deleting them forces the next request to regenerate from
        # scratch against the new goal.
        _delete_persistent_ai_cache(email)
        _delete_persistent_coach_cache(email)
        # The Garmin sync receipts belong to the old goal's block too — a new
        # plan puts different workouts on the same dates, so the old
        # fingerprints/workout_ids must not keep marking them synced.
        _delete_persistent_plan_syncs(email)
    return JSONResponse(content={"message": "Race goal saved.", "goal": goal, "goal_mode": "race"})
