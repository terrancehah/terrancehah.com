"""POST /api/coach-plan — AI coaching plan from recent training + user preferences."""

from fastapi.responses import JSONResponse
from datetime import date, timedelta, datetime as _dt
from typing import Optional
from pydantic import BaseModel
import os
import json
from openai import AsyncOpenAI
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import (
    _get_session, _get_garmin_client, create_app,
    _compute_goal_pace_ms, _fetch_physio_trends, _fetch_recent_activities_with_laps,
    _compute_pace_zones, _build_running_workout, _flatten_workout_steps,
)

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/coach-plan so routes at "/" match)
app = create_app("coach-plan")


class CoachPlanRequest(BaseModel):
    token: str = ""
    days_per_week: int = 3        # number of workout days to schedule (2-6)
    intensity: str = "moderate"   # easy | moderate | hard
    distance_adj: str = "keep"    # reduce | keep | increase (relative to last week)


@app.post("/")
async def coach_plan(body: CoachPlanRequest):
    """Return the last 2 weeks of activities plus a GPT plan honouring prefs.

    Fetches a 14-day, lap-detailed activity history and physiological trends,
    then asks GPT to propose a Mon-Sun plan shaped by the runner's chosen
    frequency, intensity, and weekly distance. Returns {history, plan}.
    """
    token = body.token
    days_per_week = max(2, min(6, int(body.days_per_week or 3)))
    intensity = body.intensity or "moderate"
    distance_adj = body.distance_adj or "keep"

    sess = _get_session(token)
    race_goal = sess.get("race_goal")

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    client = _get_garmin_client(token)
    goal_pace_ms = _compute_goal_pace_ms(race_goal)

    try:
        history = _fetch_recent_activities_with_laps(client, days=14, goal_pace_ms=goal_pace_ms)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    physio = _fetch_physio_trends(client, days=60)

    # Derive per-workout-type pace targets from recent fitness + goal pace
    pace_zones = _compute_pace_zones(goal_pace_ms, history)

    # Previous weekly mileage = distance summed over the last 7 days; the
    # distance slider moves up/down relative to this baseline.
    prev_week_km = 0.0
    week_ago = date.today() - timedelta(days=7)
    for a in history:
        start = a.get("start_time") or ""
        try:
            act_date = _dt.strptime(start[:19], "%Y-%m-%d %H:%M:%S").date()
        except (ValueError, IndexError):
            continue
        if act_date >= week_ago:
            prev_week_km += a.get("distance", 0) or 0
    distance_factors = {"reduce": 0.85, "keep": 1.0, "increase": 1.15}
    weekly_distance_km = round(prev_week_km * distance_factors.get(distance_adj, 1.0), 1) if prev_week_km > 0 else None

    # --- Compact physiological summary ---
    # Include only the recovery-relevant trends so the plan can respect fatigue,
    # without bloating the prompt (the full 60-day arrays live in ai-radar).
    physio_bits = []
    if physio.get("hrv_trend"):
        last_hrv = physio["hrv_trend"][-1]
        physio_bits.append(f"Latest HRV: {last_hrv.get('last_night_avg')} ms, status {last_hrv.get('status')}")
    if physio.get("rhr_trend"):
        physio_bits.append(f"Recent resting HR: {[e.get('resting_hr') for e in physio['rhr_trend'][-5:]]}")
    if physio.get("sleep_trend"):
        physio_bits.append(f"Recent sleep scores: {[e.get('sleep_score') for e in physio['sleep_trend'][-5:]]}")
    if physio.get("vo2max_trend"):
        physio_bits.append(f"Recent VO2max: {[e.get('vo2max') for e in physio['vo2max_trend'][-5:]]}")
    physio_text = "\n".join(physio_bits) if physio_bits else "No physiological trend data available."

    # Race goal context
    race_goal_text = ""
    if race_goal:
        race_goal_text = (
            f"RACE GOAL: {race_goal.get('purpose', 'N/A')} in "
            f"{race_goal.get('time_target', 'N/A')} on {race_goal.get('race_date', 'N/A')}. "
            f"Current weekly mileage: {race_goal.get('weekly_mileage', 'N/A')} "
            f"{race_goal.get('mileage_unit', 'km')}."
        )

    # Next Monday anchors the 7-day plan window
    days_until_monday = (7 - date.today().weekday()) % 7
    next_monday = date.today() + timedelta(days=days_until_monday if days_until_monday else 7)

    # Workout mix guidance derived from the requested number of days
    mix_guide = {
        2: "one easy run and one long run (LSD)",
        3: "one easy run, one long run (LSD), and one speedwork session",
        4: "one easy run, one long run (LSD), one speedwork session, and one tempo run",
        5: "one easy run, one long run (LSD), one speedwork session, one tempo run, and one recovery run",
        6: "one easy run, one long run (LSD), one speedwork session, one tempo run, one recovery run, and one additional easy run",
    }.get(days_per_week, "a balanced mix of easy, long, and speedwork sessions")

    distance_guide = ""
    if weekly_distance_km:
        distance_guide = (
            f"- Total weekly distance: approximately {weekly_distance_km} km, distributed "
            f"across the {days_per_week} workout days."
        )

    prompt = f"""You are an expert running coach. Study the runner's last 2 weeks of training
(with per-lap detail) and their recovery signals, then propose a 7-day training plan for the
upcoming week that honours the runner's preferences and progresses them toward their race goal.

{race_goal_text}

PLAN PREFERENCES (the runner chose these — follow them):
- Number of workout days: {days_per_week} (the other days are rest days).
- Workout mix: {mix_guide}.
- Overall intensity: {intensity}.
{distance_guide}

RECOVERY SIGNALS (latest available):
{physio_text}

RECENT ACTIVITIES (last 2 weeks, newest first; each may include a "laps" array with per-lap
duration_s, distance_m, avg_pace_ms, avg_hr, max_hr, plus work/rest lap breakdown):
{json.dumps(history, indent=2)}

NOTE ON PACES: avg_pace_ms and avg_pace_ms inside laps are metres per second. Convert to
runner-friendly MM:SS/km when quoting. A session that includes "laps" with work_lap_count > 0
was interval/tempo work — read the work-lap paces as the true effort, not the blended average.

PLAN REQUIREMENTS:
- The plan starts on {next_monday.isoformat()} (a Monday) and covers exactly 7 consecutive days.
- Exactly {days_per_week} days must have a workout; the remaining days must have "is_rest": true
  and "workout": null.
- Each non-rest day's workout must have: "type" (one of Easy, Recovery, Long Run, Tempo, Intervals,
  Speedwork), "title", "description" (1-2 sentences on intent), "distance_km" (number or null),
  "duration_min" (number or null), "insight" (a short paragraph covering the purpose of the run,
  hydration/recovery-between-efforts tips where relevant, and what to notice during the run such as
  target RPE or the sensation to hold), and "intensity" (easy, moderate, or hard). Do NOT set
  "target_pace_min_per_km" — it is assigned automatically from the target pace zones below.
- Space the workout days sensibly across the week: avoid back-to-back hard sessions, and put the
  long run and speedwork on separate days.
- Scale distances/durations to the runner's recent training load and the weekly distance target.
- Respect the recovery signals: if HRV is low, RHR rising, or sleep poor, ease off.

TARGET PACE ZONES (computed from the runner's recent fitness + race goal — use these paces when
writing descriptions; the numeric pace field is set automatically):
{json.dumps(pace_zones, indent=2)}

Return ONLY valid JSON:
{{"week_start": "{next_monday.isoformat()}", "days": [{{"date": "YYYY-MM-DD", "day_of_week": "Mon", "is_rest": false, "workout": {{...}}}}, ...]}}"""

    try:
        ai_client = AsyncOpenAI(api_key=api_key)
        response = await ai_client.chat.completions.create(
            model="gpt-5.6-luna",
            messages=[
                {"role": "system", "content": "You are an expert running coach. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            # gpt-5.6-luna only supports max_completion_tokens + reasoning_effort (no temperature)
            max_completion_tokens=4096,
            reasoning_effort="medium"
        )
        plan = json.loads(response.choices[0].message.content)
    except json.JSONDecodeError:
        return JSONResponse(status_code=500, content={"error": "AI returned unparseable response."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Coach plan failed: {str(e)}"})

    # Defensive: fill any missing/incorrect dates from the known week window so
    # the frontend can always schedule each day reliably.
    plan["week_start"] = next_monday.isoformat()
    days = plan.get("days") or []
    for i in range(7):
        expected_date = (next_monday + timedelta(days=i)).isoformat()
        if i < len(days):
            days[i]["date"] = expected_date
        else:
            days.append({"date": expected_date, "day_of_week": None, "is_rest": True, "workout": None})
    plan["days"] = days[:7]

    # Enforce the requested number of workout days — trim any extras to rest days.
    workout_days = [d for d in plan["days"] if d.get("workout")]
    if len(workout_days) > days_per_week:
        excess = len(workout_days) - days_per_week
        for d in reversed(plan["days"]):
            if excess <= 0:
                break
            if d.get("workout"):
                d["workout"] = None
                d["is_rest"] = True
                excess -= 1

    # Backfill: if the AI returned fewer workouts than requested, fill empty
    # days with a sensible default mix so the user always gets a full plan.
    default_mix = ["Easy", "Long Run", "Speedwork", "Tempo", "Recovery", "Easy"]
    default_specs = {
        "Easy": {"title": "Easy Run", "description": "Relaxed aerobic run.", "distance_km": 6, "duration_min": 40, "intensity": "easy"},
        "Recovery": {"title": "Recovery Run", "description": "Very easy shakeout run.", "distance_km": 5, "duration_min": 35, "intensity": "easy"},
        "Long Run": {"title": "Long Run", "description": "Steady endurance builder.", "distance_km": 15, "duration_min": 100, "intensity": "moderate"},
        "Tempo": {"title": "Tempo Run", "description": "Sustained threshold effort.", "distance_km": 8, "duration_min": 50, "intensity": "moderate"},
        "Speedwork": {"title": "Speedwork", "description": "Short, fast repeats.", "distance_km": 6, "duration_min": 45, "intensity": "hard"},
    }
    needed = days_per_week - len(workout_days)
    if needed > 0:
        for d in plan["days"]:
            if needed <= 0:
                break
            if not d.get("workout"):
                wtype = default_mix[len(workout_days) % len(default_mix)]
                spec = default_specs.get(wtype, default_specs["Easy"])
                d["workout"] = {
                    "type": wtype,
                    "title": spec["title"],
                    "description": spec["description"],
                    "distance_km": spec["distance_km"],
                    "duration_min": spec["duration_min"],
                    "intensity": spec["intensity"],
                }
                d["is_rest"] = False
                workout_days.append(d)
                needed -= 1

    # Override each workout's pace with the deterministic zone for its type —
    # pace is derived, never user- or AI-editable. Also attach the coaching
    # insight and the native Garmin step breakdown for the detail sheet.
    for day in plan["days"]:
        w = day.get("workout")
        if isinstance(w, dict):
            wtype = w.get("type") or "Easy"
            w["target_pace_min_per_km"] = pace_zones.get(wtype)
            if not w.get("insight"):
                w["insight"] = w.get("description") or ""
            # Native Garmin steps — the exact steps that will be sent to the
            # watch, flattened into readable {type, detail} rows.
            try:
                w["steps"] = _flatten_workout_steps(_build_running_workout(w).to_dict())
            except Exception:
                w["steps"] = [{"type": "Run", "detail": f"{w.get('distance_km') or '--'} km"}]

    plan["pace_zones"] = pace_zones
    plan["preferences"] = {
        "days_per_week": days_per_week,
        "intensity": intensity,
        "distance_adj": distance_adj,
        "weekly_distance_km": weekly_distance_km,
    }

    # Strip lap detail from the history sent to the client — laps are only for
    # the AI analysis, not the calendar cards.
    slim_history = [{k: v for k, v in a.items() if k != "laps"} for a in history]

    return JSONResponse(content={"history": slim_history, "plan": plan})
