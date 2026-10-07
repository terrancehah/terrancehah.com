"""GET /api/check-session — Check if a session token is still valid."""

from fastapi.responses import JSONResponse
import re
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _session_exists, _get_session, _delete_session, _get_persistent_race_goal, _is_no_goal_marker, _get_latest_race_reference, _get_persistent_ai_cache, _get_persistent_coach_cache, _get_persistent_plan_syncs, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/check-session so routes at "/" match)
app = create_app("check-session")


@app.get("/")
async def check_session(token: str = ""):
    """Check if a session token is still valid and return profile info.

    Used by the dashboard on page load to determine whether to show the login
    screen or skip straight to the dashboard. Also applies a UUID check on
    display_name — if it looks like a UUID, fall back to full_name instead.
    This fixes sessions created before the UUID detection was added.
    """
    if not token or not _session_exists(token):
        return JSONResponse(content={"valid": False})
    sess = _get_session(token)
    raw_display = sess.get("display_name", "")
    full_name = sess.get("full_name", "")
    # If display_name looks like a UUID, prefer full_name
    if raw_display and re.match(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        raw_display, re.I
    ):
        display_name = full_name or raw_display
    else:
        display_name = raw_display
    # Return the race goal data if available. Check the session first, then
    # fall back to the persistent store keyed by email — this covers the case
    # where the session's race_goal is None but the user has a persisted goal
    # from a previous session (e.g. session expired and was recreated).
    email = sess.get("email", "")
    race_goal = sess.get("race_goal")
    # Canonical mode comes from the persistent record overlaid onto the
    # session: "race" for a real goal, "no_goal" for the explicit tombstone,
    # "" when nothing is persisted (legacy — the user simply has no goal yet).
    goal_mode = sess.get("goal_mode") or ""
    if not race_goal and email:
        persistent_goal = _get_persistent_race_goal(email)
        if persistent_goal and not _is_no_goal_marker(persistent_goal):
            race_goal = persistent_goal
            goal_mode = "race"
            # If we found it in the persistent store but not the session,
            # backfill the session so subsequent calls don't need to check.
            from lib._shared import _update_session
            _update_session(token, {"race_goal": race_goal})
        elif _is_no_goal_marker(persistent_goal):
            # A tombstone is a real record but not a goal — never backfill it
            # into the session as one.
            goal_mode = "no_goal"
    no_goal = goal_mode == "no_goal"

    # Fetch cached AI insights and coach plan from the persistent email-keyed
    # stores so a device with empty localStorage can render instantly. These
    # may be None if no cache exists yet. In no-goal mode they are suppressed —
    # any left behind belong to a goal that no longer exists and must not
    # repaint the dashboard.
    cached_ai = _get_persistent_ai_cache(email) if (email and not no_goal) else None
    cached_coach = _get_persistent_coach_cache(email) if (email and not no_goal) else None
    # Garmin sync receipts for the plan's badges — read-only here; this
    # endpoint never triggers a plan rebuild.
    plan_sync_history = _get_persistent_plan_syncs(email) if email else {}
    # Fold the generation time into the cached AI payload so a device with
    # empty localStorage can show the readiness "last updated" line before it
    # re-fetches (the timestamp lives on the cache entry, not inside data).
    cached_ai_payload = None
    if cached_ai:
        cached_ai_payload = dict(cached_ai.get("data") or {})
        cached_ai_payload["generated_at"] = cached_ai.get("generated_at", "")

    return JSONResponse(content={
        "valid": True,
        "display_name": display_name,
        "full_name": full_name,
        "profile_image_url": sess.get("profile_image_url", ""),
        "email": sess.get("email", ""),
        "device_name": sess.get("device_name", ""),
        "has_race_goal": race_goal is not None,
        "race_goal": race_goal,
        "goal_mode": goal_mode or None,
        # The latest completed race's actual finish pace — the UI's tag and
        # pace-chart baseline once there is no active goal.
        "pace_reference": _get_latest_race_reference(sess),
        "cached_ai_insights": cached_ai_payload,
        "cached_coach_plan": cached_coach["data"] if cached_coach else None,
        "plan_sync_history": plan_sync_history,
    })


@app.delete("/")
async def logout(token: str = ""):
    """End a session and remove it from the session store (Redis or local).

    Merged here from the old logout.py so session lifecycle (check + logout)
    lives in one serverless function.
    """
    _delete_session(token)
    return JSONResponse(content={"message": "Logged out."})
