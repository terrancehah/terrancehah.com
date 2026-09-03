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

    # --- Race phase detection ---
    # Determine which training phase the runner is in based on days remaining
    # to race day. The phases follow standard periodization:
    #   build (6+ weeks):  easy volume, controlled quality
    #   specificity (3-6 weeks / 21-42 days):  race-pace work, long runs peak
    #   sharpen (10-20 days):  volume down 20-30%, one short race-pace session
    #   taper (last 7 days):  volume down 40-60%, mostly easy, arrive fresh
    race_phase = None
    days_to_race = None
    race_date_str = race_goal.get("race_date") if race_goal else None
    if race_date_str:
        try:
            race_date = _dt.strptime(race_date_str, "%Y-%m-%d").date()
            days_to_race = (race_date - date.today()).days
            if days_to_race < 0:
                race_phase = "post_race"
            elif days_to_race <= 7:
                race_phase = "taper"
            elif days_to_race <= 20:
                race_phase = "sharpen"
            elif days_to_race <= 42:
                race_phase = "specificity"
            else:
                race_phase = "build"
        except (ValueError, TypeError):
            pass

    # Phase-specific instructions for the AI prompt. Each phase has a distinct
    # job — the plan must reflect the phase, not just the runner's preferences.
    phase_instructions = {
        "build": (
            "RACE PHASE — BUILD ({days} days to race):\n"
            "- Build easy volume gradually. Long run grows by no more than 10% per week.\n"
            "- Quality stays controlled: one session per week, tempo or intervals (not both).\n"
            "- Keep 80%+ of weekly volume at easy/conversational pace.\n"
            "- Focus on aerobic foundation, not race-pace sharpness."
        ),
        "specificity": (
            "RACE PHASE — SPECIFICITY ({days} days to race):\n"
            "- One session this week should touch goal race pace.\n"
            "- Long run can include goal-pace segments in the final kilometres.\n"
            "- Tempo or intervals at race effort, not faster.\n"
            "- This is the peak training block — volume and specificity are at their highest."
        ),
        "sharpen": (
            "RACE PHASE — SHARPEN ({days} days to race):\n"
            "- Reduce volume approximately 20-30% from peak.\n"
            "- Keep one short race-pace session (no long intervals).\n"
            "- Long run gets shorter — roughly 70% of peak distance.\n"
            "- Last long run should be 10-14 days before race day.\n"
            "- No new fitness gains expected — maintain what you have."
        ),
        "taper": (
            "RACE PHASE — TAPER ({days} days to race):\n"
            "- Reduce volume 40-60% from peak. Maintain frequency (same number of runs, shorter).\n"
            "- Mostly easy running with very short race-pace touches (strides or 1-2 km at race pace).\n"
            "- No hard sessions. No long runs beyond 60% of peak.\n"
            "- Goal: arrive at the start line fresh, not flat."
        ),
        "post_race": (
            "RACE PHASE — POST-RACE:\n"
            "- The race date has passed. Treat this as a recovery / base-building block.\n"
            "- Mostly easy running, no hard sessions unless the runner explicitly chose hard intensity."
        ),
    }
    phase_text = phase_instructions.get(race_phase, "").format(days=days_to_race) if race_phase else ""

    # Plan starts tomorrow and extends through the end of the next full
    # Mon–Sun week. This avoids a large gap when the user generates a plan
    # mid-week (e.g. on a Tuesday, the old approach would skip to next Monday
    # leaving 6 empty days). Monday is still treated as the start of a new
    # training block — the days between tomorrow and the next Monday are the
    # "gap" days that complete the current week, then the full Mon–Sun block
    # follows. Total plan length ranges from 7 days (if tomorrow is Monday)
    # up to 13 days (if today is Monday).
    plan_start = date.today() + timedelta(days=1)
    days_until_monday = (7 - plan_start.weekday()) % 7
    next_monday = plan_start + timedelta(days=days_until_monday)
    plan_end = next_monday + timedelta(days=6)  # Sunday at end of full week
    total_plan_days = (plan_end - plan_start).days + 1

    # Workout mix guidance derived from the requested number of days.
    # Quality means tempo or intervals — never both in the same week unless
    # intensity is hard and recovery is good.
    mix_guide = {
        2: "one easy run and one long run (LSD). Include quality only if intensity is hard and recovery is good",
        3: "one easy run, one long run (LSD), and one quality session (tempo or intervals — not both)",
        4: "two easy runs, one long run (LSD), and one quality session (tempo or intervals — not both)",
        5: "two easy runs, one recovery run, one long run (LSD), and one quality session",
        6: "three easy runs, one recovery run, one long run (LSD), and one quality session",
    }.get(days_per_week, "mostly easy running, one long run, at most one quality session")

    distance_guide = ""
    if weekly_distance_km:
        distance_guide = (
            f"- Total weekly distance: approximately {weekly_distance_km} km, distributed "
            f"across the {days_per_week} workout days."
        )

    # Intensity definitions — tell the model exactly what easy / moderate / hard
    # means in concrete terms so the plan's effort level is consistent.
    intensity_definitions = {
        "easy": (
            "INTENSITY: EASY\n"
            "- At most 1 hard day in the plan (the quality session, if any).\n"
            "- Long run pace sits 10-15% slower than goal race pace.\n"
            "- Quality session, if present, is controlled — not all-out."
        ),
        "moderate": (
            "INTENSITY: MODERATE\n"
            "- Exactly 1 hard day (the quality session).\n"
            "- Long run pace can sit 5-10% slower than goal race pace.\n"
            "- Quality session is purposeful but not maximal."
        ),
        "hard": (
            "INTENSITY: HARD\n"
            "- 1-2 hard days (quality session + optionally a second tempo or intervals).\n"
            "- Long run pace can sit within 5% of goal race pace.\n"
            "- Quality sessions are aggressive — the runner wants to push."
        ),
    }
    intensity_text = intensity_definitions.get(intensity, intensity_definitions["moderate"])

    prompt = f"""You are an expert running coach. Study the runner's last 2 weeks of training
(with per-lap detail) and their recovery signals, then propose a training plan that honours the
runner's preferences and progresses them toward their race goal.

{race_goal_text}

PLAN WINDOW:
- Start on {plan_start.isoformat()} (tomorrow). Cover exactly {total_plan_days} consecutive days
  from that date, ending on {plan_end.isoformat()}.
- Do not wait for the next Monday. The plan starts tomorrow.
- Monday is treated as the start of a new training block. The days between tomorrow and the next
  Monday ({next_monday.isoformat()}) complete the current week — fill them with easy runs or rest.
  From {next_monday.isoformat()} onward, build the full Mon-Sun training block.
- Exactly {days_per_week} workout days per 7-day block; remaining days are rest.
- Put the long run on Saturday or Sunday if those dates fall inside the window.
- Put the quality session mid-week (Tuesday or Wednesday), with at least one easy or rest day
  before the long run.
- Never schedule two hard days back to back.

{phase_text}

{intensity_text}

PLAN PREFERENCES (the runner chose these — follow them):
- Number of workout days per week: {days_per_week} (the other days are rest days).
- Workout mix: {mix_guide}.
{distance_guide}

RECOVERY OVERRIDE (mechanical rules — apply before anything else):
- If HRV is down, resting HR is up, or sleep has been poor for several days: the quality day
  becomes easy, and the long run stays conversational (no goal-pace segments).
- Do not add a second hard day to "make up" missed training. If recovery is poor, drop quality,
  do not double down.
- If recovery is good (HRV stable or up, RHR normal, sleep adequate): allow the one quality day
  as planned.

RECOVERY SIGNALS (latest available):
{physio_text}

RECENT ACTIVITIES (last 2 weeks, newest first; each may include a "laps" array with per-lap
duration_s, distance_m, avg_pace_ms, avg_hr, max_hr, plus work/rest lap breakdown):
{json.dumps(history, indent=2)}

NOTE ON PACES: avg_pace_ms inside laps are metres per second. Convert to runner-friendly MM:SS/km
when quoting. A session that includes "laps" with work_lap_count > 0 was interval/tempo work —
read the work-lap paces as the true effort, not the blended average.

PLAN REQUIREMENTS:
- The plan covers {total_plan_days} days from {plan_start.isoformat()} to {plan_end.isoformat()}.
- Distribute the {days_per_week} workout days across each 7-day block. Days between tomorrow and
  the next Monday should be treated as the tail of the current week — fill with easy runs or rest.
- Each non-rest day's workout must have: "type" (one of Easy, Recovery, Long Run, Tempo, Intervals,
  Speedwork), "title", "description" (1-2 sentences on intent), "distance_km" (number or null),
  "duration_min" (number or null), "insight" (a short paragraph covering the purpose of the run,
  hydration/recovery-between-efforts tips where relevant, and what to notice during the run such as
  target RPE or the sensation to hold), and "intensity" (easy, moderate, or hard). Do NOT set
  "target_pace_min_per_km" — it is assigned automatically from the target pace zones below.
- Scale distances/durations to the runner's recent training load, the weekly distance target, and
  the race phase (sharpen and taper phases must reduce volume).

TARGET PACE ZONES (computed from the runner's recent fitness + race goal — use these paces when
writing descriptions; the numeric pace field is set automatically):
{json.dumps(pace_zones, indent=2)}

Return ONLY valid JSON:
{{"week_start": "{plan_start.isoformat()}", "days": [{{"date": "YYYY-MM-DD", "day_of_week": "Mon", "is_rest": false, "workout": {{...}}}}, ...]}}"""

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

    # Defensive: fill any missing/incorrect dates from the known plan window
    # so the frontend can always schedule each day reliably. The plan covers
    # total_plan_days from plan_start to plan_end.
    plan["week_start"] = plan_start.isoformat()
    days = plan.get("days") or []
    for i in range(total_plan_days):
        expected_date = (plan_start + timedelta(days=i)).isoformat()
        if i < len(days):
            days[i]["date"] = expected_date
        else:
            days.append({"date": expected_date, "day_of_week": None, "is_rest": True, "workout": None})
    plan["days"] = days[:total_plan_days]

    # Enforce the requested number of workout days per 7-day block.
    # The plan may span up to 13 days (gap days + full Mon-Sun block), so
    # the allowed workout count scales with the number of full weeks.
    # Gap days (before next_monday) get at most 1-2 easy workouts to fill
    # the current week; the full block gets the requested days_per_week.
    full_blocks = 1  # always one full Mon-Sun block
    gap_days_count = (next_monday - plan_start).days
    # Allow up to 1 workout per 3 gap days (rounded up), capped at days_per_week
    gap_workout_allowance = min(days_per_week, (gap_days_count + 2) // 3) if gap_days_count > 0 else 0
    max_workouts = days_per_week * full_blocks + gap_workout_allowance
    workout_days = [d for d in plan["days"] if d.get("workout")]
    if len(workout_days) > max_workouts:
        excess = len(workout_days) - max_workouts
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
    needed = max_workouts - len(workout_days)
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
    # Include plan window metadata so the frontend knows the date range
    # and race phase (useful for display + scheduling logic).
    plan["plan_start"] = plan_start.isoformat()
    plan["plan_end"] = plan_end.isoformat()
    plan["total_plan_days"] = total_plan_days
    if race_phase:
        plan["race_phase"] = race_phase
        plan["days_to_race"] = days_to_race

    # Strip lap detail from the history sent to the client — laps are only for
    # the AI analysis, not the calendar cards.
    slim_history = [{k: v for k, v in a.items() if k != "laps"} for a in history]

    return JSONResponse(content={"history": slim_history, "plan": plan})
