"""POST /api/onboarding — Save the user's race goal via form data.

GET /api/onboarding — Evidence-based next-goal options (authored estimates,
never AI numerics); explain=true adds the coach's optional prose.
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
    _delete_persistent_plan_syncs, _get_cached_garmin_data,
    _get_persistent_race_goal, _archive_race_goal,
    _save_persistent_course, _call_ai, RUNNING_TYPES,
    _get_fitness_snapshot, _get_latest_race_reference,
)
from lib._goal_suggestions import build_goal_options, goal_explanation_prompt

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/onboarding so routes at "/" match)
app = create_app("onboarding")


def _option_activities(email: str, token: str) -> list:
    """Recent UI activities for the training-benchmark fallback.

    The email-keyed fitness snapshot wins (it is what the coach plan and the
    trajectory already read, so the benchmark matches across devices); this
    session's Garmin cache is the fallback. No new Garmin call is made here.
    """
    snapshot = _get_fitness_snapshot(email) or {}
    activities = snapshot.get("ui_activities")
    if activities:
        return activities
    cached = _get_cached_garmin_data(token) or {}
    return cached.get("ui_activities") or []


# Explanation prose is kept on a short leash — anything longer reads as a
# generated essay rather than a coach's aside.
_MAX_EXPLANATION_CHARS = 1000


@app.get("/")
async def onboarding_suggestions(token: str = "", explain: bool = False):
    """Return the four fixed next-goal options with evidence-based targets.

    Numerics come from the authored build_goal_options — the latest completed
    race's ACTUAL finish as the Riegel reference, or a clearly-labelled
    recent-training median when no race exists. explain=true asks the coach
    for prose over that same fixed evidence; an AI failure degrades to
    'unavailable', never to invented estimates.
    """
    # Authenticate first — suggestions are an account feature.
    sess = _get_session(token)
    email = sess.get("email", "") if isinstance(sess, dict) else ""

    reference = _get_latest_race_reference(sess)
    activities = _option_activities(email, token)
    options, training = build_goal_options(reference, activities, RUNNING_TYPES)

    payload = {"suggestions": options, "training": training}
    if explain:
        # The prose is optional by design: the options stand on their own, so
        # any failure — missing key, bad JSON, odd shape — degrades to an
        # explicit 'unavailable' instead of failing the whole request.
        explanation_status = "unavailable"
        api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
        if api_key:
            try:
                parsed = await _call_ai(
                    goal_explanation_prompt(options, reference, training), api_key)
                explanations = parsed.get("explanations") or {}
                attached = 0
                for option in options:
                    text = explanations.get(option["purpose"])
                    # Valid prose only: a non-empty string of sane length, and
                    # only for purposes this response actually offers.
                    if (isinstance(text, str) and text.strip()
                            and len(text.strip()) <= _MAX_EXPLANATION_CHARS):
                        option["explanation"] = text.strip()
                        attached += 1
                if attached:
                    explanation_status = "available"
            except Exception:
                pass
        payload["explanation_status"] = explanation_status
    return JSONResponse(content=payload)


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
            # The race just archived is the latest completed one, so its
            # actual finish becomes this device's pace reference directly —
            # no follow-up check-session needed to paint the chart.
            "pace_reference": _get_latest_race_reference(
                {"email": email, "race_goal": None}),
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
