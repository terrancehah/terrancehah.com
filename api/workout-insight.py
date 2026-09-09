"""POST /api/workout-insight — On-demand AI coach insight for a single workout."""

from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime as _dt
import os
import sys
import json
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root)
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import (
    _get_session, create_app, _get_persistent_ai_cache, _get_cached_garmin_data,
    RUNNING_TYPES, _call_ai, _phase_for_days_left,
)

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/workout-insight so routes at "/" match)
app = create_app("workout-insight")


class WorkoutInsightRequest(BaseModel):
    token: str = ""
    date: str = ""
    workout: Optional[dict] = None
    # Plan context from the frontend — which week of the block this session
    # sits in, and the previous planned session, so the insight is written
    # for the week, not the workout in isolation.
    context: Optional[dict] = None
    # kind == "plan" renders the one-line race-card overview insight from
    # context (race goal + fitness + phase + trajectory) instead of a
    # workout insight. Kept in this file so no extra serverless function
    # is needed for the plan page line.
    kind: str = "workout"


# Plan workout types -> run_tag classes from the runner's actual history.
# Used to find "previous similar sessions" so the insight can compare this
# session against real runs of the same kind, not just the plan.
TYPE_TAG_MAP = {
    "Long Run": ("LSD",),
    "Tempo": ("Tempo Long",),
    "Intervals": ("Speedwork",),
    "Speedwork": ("Speedwork",),
    "Easy": ("Easy", "Warmup"),
    "Recovery": ("Recovery",),
    "Race": ("LSD", "Tempo Long"),
}


def _fmt_pace_ms(pace_ms) -> str:
    """Format m/s as "M:SS" per km for user-facing strings."""
    if not pace_ms or pace_ms <= 0:
        return "--"
    sec = 1000 / pace_ms
    mins = int(sec // 60)
    secs = int(round(sec % 60))
    if secs >= 60:
        mins += 1
        secs -= 60
    return f"{mins}:{secs:02d}"


def _similar_sessions(token: str, workout_type: str, limit: int = 2) -> list[dict]:
    """Pull the most recent actual runs of a similar type from the Garmin data
    cache, so the insight can reference real sessions. Returns [] when the
    cache is cold or nothing matches — the insight then simply skips the
    comparison instead of inventing one."""
    tags = TYPE_TAG_MAP.get(workout_type, ())
    if not tags:
        return []
    cached = _get_cached_garmin_data(token)
    if not cached:
        return []
    matches = []
    for a in cached.get("activities", []):
        if (a.get("type") or "").lower() not in RUNNING_TYPES:
            continue
        if (a.get("run_tag") or "") in tags:
            matches.append(a)
    matches.sort(key=lambda x: x.get("start_time") or "", reverse=True)
    return matches[:limit]


# Phase labels with the job of each phase — same boundaries as the plan.
PHASE_LABELS = {
    "build": "Build — base volume and controlled quality, laying the aerobic foundation",
    "specificity": "Specificity — race-pace work at peak volume, sharpening toward the goal",
    "sharpen": "Sharpen — volume trimmed, one short race-pace session to keep the edge",
    "taper": "Taper — light week, arrive at the line fresh",
    "post_race": "Post-race recovery",
}


async def _plan_overview_insight(ctx: dict):
    """One short coach line for the plan page race card (kind == "plan").

    Uses the same context the plan page already has — race goal, current
    fitness numbers, phase, and trajectory — so it is cheap to call once
    per plan load.
    """
    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    race = ctx.get("race_goal") or {}
    fitness = ctx.get("fitness") or {}
    trajectory_status = ctx.get("trajectory_status") or "on_track"
    trajectory_note = ctx.get("trajectory_note") or ""

    race_label = race.get("race_name") or race.get("purpose") or "your goal race"
    prompt = f"""You are an expert running coach. Write ONE short coach line (1-2 sentences, warm and direct — like a coach texting a club runner) for the overview of the runner's plan page.

RACE: {race_label} — {race.get('purpose', '')} {race.get('distance', '') or ''}, target {race.get('time_target', '')} (goal pace {fitness.get('goal_pace', '--')}/km) on {race.get('race_date', '')}.

CURRENT FITNESS (from recent runs): long-run pace {fitness.get('current_easy_pace', '--')}/km, quality pace {fitness.get('current_quality_pace', '--')}/km. The goal's quality reference is {fitness.get('goal_quality_pace', '--')}/km.

PLAN: {ctx.get('race_phase', '')} phase, {ctx.get('days_to_race', '')} days to race.

TRAJECTORY: {trajectory_status}. {trajectory_note}

Write the line so it:
- names the gap or the strength in ONE concrete number where useful ("your recent quality pace is 20s off the goal", "your long runs already sit at goal shape"),
- says what this week's focus is (from the phase),
- gives the runner one thing to trust.
Do not invent numbers. Do not repeat the race date as filler. Keep it 1-2 sentences. Never write m/s.

Return ONLY valid JSON:
{{"insight": "..."}}"""

    try:
        result = await _call_ai(prompt, api_key)
        insight = (result.get("insight") or "").strip()
    except Exception:
        insight = ""
    if not insight:
        return JSONResponse(status_code=500, content={"error": "Could not generate insight."})
    return JSONResponse(content={"insight": insight})


@app.post("/")
async def workout_insight(body: WorkoutInsightRequest):
    """Write the coach insight paragraph for one workout — or the plan
    overview line when kind == "plan" — on demand.

    The full-block plan is generated without per-workout insight text so the
    payload stays light. Tapping a workout card calls this endpoint, which
    writes the paragraph with real context: where the session sits in the
    block (week number, phase at THAT date, previous session), the race goal,
    and the runner's readiness analysis when one exists.
    """
    sess = _get_session(body.token)
    if body.kind == "plan":
        return await _plan_overview_insight(body.context or {})
    race_goal = sess.get("race_goal")
    email = sess.get("email", "")
    workout = body.workout or {}
    context = body.context or {}
    if not workout.get("type"):
        return JSONResponse(status_code=400, content={"error": "Workout type required."})

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    # Phase + days left computed from the WORKOUT's date, not today — a week-14
    # session in a 20-week block must be read as specificity, not whatever
    # phase "today" happens to be. Falls back to today when the date is bad.
    workout_date = None
    if body.date:
        try:
            workout_date = _dt.strptime(body.date, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            workout_date = None
    race_phase_text = ""
    days_left = None
    dow_label = (workout_date or date.today()).strftime("%A")
    race_date_str = race_goal.get("race_date") if race_goal else None
    if race_date_str:
        try:
            race_date = _dt.strptime(race_date_str, "%Y-%m-%d").date()
            anchor = workout_date or date.today()
            days_left = (race_date - anchor).days
            phase = _phase_for_days_left(days_left) if days_left is not None else None
            if phase:
                race_phase_text = f"{PHASE_LABELS.get(phase, phase)} ({days_left} days after this session)."
        except (ValueError, TypeError):
            pass

    # Week position inside the block — sent by the frontend from the plan.
    week_index = context.get("week_index")
    total_weeks = context.get("total_weeks")
    week_text = ""
    if isinstance(week_index, int) and isinstance(total_weeks, int) and total_weeks > 0:
        week_text = f"This workout sits in week {week_index} of {total_weeks} of the training block."
    else:
        week_text = "This workout is part of the training block leading to your race."
    week_text += f" It is scheduled on a {dow_label}."

    # Previous planned session — lets the insight say "after yesterday's easy
    # run" or "the day before your long run", instead of reading standalone.
    prev_text = "None — this is the first planned session." if not context.get("prev_workout") else str(context.get("prev_workout"))

    # Readiness analysis (cached ai-radar, read-only) — ties the insight to
    # the diagnosis so sessions that work the top gap say so.
    readiness_line = ""
    if email:
        cached_ai = _get_persistent_ai_cache(email)
        if cached_ai:
            overall = (cached_ai.get("data") or {}).get("overall") or {}
            top_gap = overall.get("topGap") or {}
            if overall.get("verdict"):
                readiness_line = (
                    "Your last readiness analysis said: "
                    f"{overall.get('verdict')} ({overall.get('score')}/10), "
                    f"top gap: {top_gap.get('label') or 'n/a'}. "
                    "If this session works that gap, call it out; otherwise keep the focus on the phase."
                )

    race_week_extra = ""
    if days_left is not None and 0 <= days_left < 7:
        race_week_extra = (" This is race week — the only job is arriving at the line fresh, "
                           "so keep everything short and easy except brief goal-pace touches.")

    goal_text = ""
    if race_goal:
        goal_text = (
            f"RACE GOAL: {race_goal.get('purpose', 'N/A')} in "
            f"{race_goal.get('time_target', 'N/A')} on {race_goal.get('race_date', 'N/A')}."
        )

    workout_spec = {
        k: workout.get(k)
        for k in ("type", "title", "description", "distance_km", "duration_min", "intensity", "target_pace_min_per_km")
    }

    # The runner's actual recent runs of the same type — lets the insight say
    # "your last long run drifted in the final third, hold the effort earlier"
    # instead of describing the session in a vacuum.
    similar = _similar_sessions(body.token, workout.get("type") or "")
    similar_section = ""
    if similar:
        rows = []
        for a in similar:
            date_label = (a.get("start_time") or "")[:10]
            pace = _fmt_pace_ms(a.get("avg_pace"))
            hr = f", avg HR {a['avg_hr']}" if a.get("avg_hr") else ""
            rows.append(f"{date_label}: {a.get('distance')} km @ {pace}/km{hr} ({a.get('run_tag')})")
        similar_section = (
            "PREVIOUS SIMILAR SESSIONS (your actual runs of this type, most recent first):\n"
            + "\n".join(rows)
            + "\n\nReference them only when it genuinely helps: compare this session's target to your "
            + "recent pace on the same type of run, or note HR drift late in a long run. Never invent numbers."
        )

    prompt = f"""You are an expert running coach. Write ONE coach insight paragraph for a single workout.

PLAN CONTEXT (this is the heart of the insight — write for the week, not the workout in isolation):
- {week_text}
- Race phase at this session: {race_phase_text or 'no race context yet'}.
- Previous session in the plan: {prev_text}.

{similar_section}

RACE CONTEXT (internal reference only — do not lead with numbers from this):
- {goal_text}

WORKOUT:
{json.dumps(workout_spec, indent=2)}

Write a short paragraph (2-4 sentences):
- Lead with why THIS session exists in this week of the block and how it fits the phase. The week placement and the sessions around it are the context — not the race date.
- Say what to notice during the run: the target effort (RPE or the sensation to hold), and where the hard part sits.
- One practical tip: hydration / fuelling / recovery-between-efforts relevant to this session.
- Refer to the race as "your goal race", "race day", or "the {race_goal.get('purpose', 'goal') if race_goal else 'goal'} goal". Mention the exact goal time or race date at most once, and only when it sharpens the point. Prefer phase and week context over numbers.{race_week_extra}

{readiness_line}

Do NOT mention missing data. Do not repeat the race date or goal time as filler. Keep it warm and direct, like a good coach texting a club runner. Never write m/s.

Return ONLY valid JSON:
{{"insight": "..."}}"""

    try:
        result = await _call_ai(prompt, api_key)
        insight = (result.get("insight") or "").strip()
    except Exception:
        insight = ""
    if not insight:
        return JSONResponse(status_code=500, content={"error": "Could not generate insight."})
    return JSONResponse(content={"insight": insight})
