"""POST /api/coach-plan — AI coaching plan from recent training + user preferences."""

from fastapi.responses import JSONResponse
from datetime import date, timedelta, datetime as _dt
from typing import Optional
from pydantic import BaseModel
import os
import json
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import (
    _get_session, _get_garmin_client, create_app,
    _compute_goal_pace_ms, _fetch_physio_trends, _fetch_recent_activities_with_laps,
    _compute_pace_zones, _build_running_workout, _flatten_workout_steps,
    _get_persistent_coach_cache, _save_persistent_coach_cache, _delete_persistent_coach_cache,
    _get_persistent_ai_cache, _get_cached_garmin_data, _call_ai, _phase_for_days_left,
    RUNNING_TYPES,
)

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/coach-plan so routes at "/" match)
app = create_app("coach-plan")

# ---------------------------------------------------------------------------
# Full-block plan helpers — the marathon companion generates the whole
# remaining block to race day, one week (chunk) at a time, so the AI keeps
# each week coherent without exceeding the JSON response token limit.
# ---------------------------------------------------------------------------

MAX_PLAN_DAYS = 26 * 7  # cap the season block at 26 weeks (~6 months)

# The AI's weeks are trusted as generated — no backfill or cap. The prompt
# (see _build_chunk_prompt) carries the workout-count, partial-week, and
# race-week rules instead.

# Honesty rules for every generated week — these answer the verified amateur
# complaints about plan products (long runs too short, race-week stacking,
# no pause after illness, fake marathon-pace work).
HONESTY_RULES = """HONESTY RULES (mechanical — apply before anything else):
- Long runs must progress toward a traditional peak (about 29-32 km / 18-20 miles
  or 2-3 hours) when time-to-race allows. Do not keep long runs short forever.
- Race week: never stack a long or hard session next to the race. The race day
  itself is the hard session.
- Marathon-pace work must be real: genuine 15-30 minute blocks at goal pace inside
  long runs or dedicated MP sessions. Do not fake it with short tempos then
  auto-shift by RPE.
- If recent recovery signals are poor (HRV down, RHR up, bad sleep), this week's
  quality session becomes easy and the long run stays conversational."""


def _split_windows(plan_start, plan_end):
    """Split [plan_start, plan_end] into AI-sized chunks.

    The first chunk runs tomorrow through the current Mon-Sun week (up to 13
    days); each later chunk is one full Mon-Sun week; the final chunk ends on
    race day, so it may be partial.
    """
    windows = []
    first_end = plan_start + timedelta(days=((7 - plan_start.weekday()) % 7) + 6)
    if first_end > plan_end:
        first_end = plan_end
    windows.append((plan_start, first_end))
    cursor = first_end + timedelta(days=1)
    while cursor <= plan_end:
        chunk_end = min(cursor + timedelta(days=6), plan_end)
        windows.append((cursor, chunk_end))
        cursor = chunk_end + timedelta(days=1)
    return windows


def _summarize_days(days):
    """Compact summary of one generated chunk, fed to the next week's prompt
    so the plan progresses (long runs grow, volume ramps, taper lands)
    instead of repeating the same week."""
    lines = []
    weekly_km = 0.0
    for d in days:
        w = d.get("workout")
        if not w:
            lines.append(f"{d.get('date')}: Rest")
            continue
        km = w.get("distance_km") or 0
        weekly_km += km
        lines.append(f"{d.get('date')}: {w.get('type')} - {w.get('title')} ({km} km, {w.get('duration_min')} min)")
    long_km = [d["workout"].get("distance_km") or 0 for d in days
               if d.get("workout") and (d["workout"].get("type") or "").lower() == "long run"]
    return "\n".join(lines), round(weekly_km, 1), (max(long_km) if long_km else None)


def _format_sec_km(sec_per_km) -> str:
    """Format seconds-per-km as "M:SS" for user-facing strings."""
    if not sec_per_km or sec_per_km <= 0:
        return "--"
    mins = int(sec_per_km // 60)
    secs = int(round(sec_per_km % 60))
    if secs >= 60:
        mins += 1
        secs -= 60
    return f"{mins}:{secs:02d}"


def _format_marathon_time(sec_per_km) -> str:
    """Convert a per-km pace to a total marathon time "H:MM:SS"."""
    total_sec = int(round(sec_per_km * 42.195))
    h, rem = divmod(total_sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}"


def _estimate_feasibility(history: list[dict], goal_pace_ms: float, days_to_race: int) -> dict | None:
    """Estimate whether the runner's current running pace + remaining block
    can reach the typed goal pace.

    Current fitness pace = best Riegel projection to marathon distance from
    recent runs (>= 5 km, falling back to >= 3 km). The remaining block is
    assumed to improve pace by roughly 1.5% per 4 weeks of structured work
    (conservative trained-runner rate). Verdict tiers:
      on_track  — estimate already at or faster than goal pace
      at_risk   — reachable with a strong, consistent block
      unlikely  — gap larger than a realistic block can close
    Returns None when there is not enough data to estimate.
    """
    if not history or not goal_pace_ms or goal_pace_ms <= 0:
        return None
    goal_sec = 1000 / goal_pace_ms

    # Best Riegel projection: t_marathon = t_run * (42.195 / d_run) ^ 1.06.
    # Prefer longer runs (>= 8 km): short runs over-project and inflate the
    # estimate. Training runs are rarely all-out, so this is a conservative
    # estimator — it errs toward "check your goal", which is the safe
    # direction for a warning feature.
    def _best_projection(min_dist):
        best = None
        for a in history:
            pace_ms = a.get("avg_pace") or 0
            dist_km = a.get("distance") or 0
            if pace_ms <= 0 or dist_km < min_dist:
                continue
            run_min = (dist_km * 1000 / pace_ms) / 60
            est_marathon_min = run_min * (42.195 / dist_km) ** 1.06
            est_sec = est_marathon_min * 60 / 42.195
            best = est_sec if best is None else min(best, est_sec)
        return best

    best_est_sec = _best_projection(8)
    if best_est_sec is None:
        best_est_sec = _best_projection(5)
    if best_est_sec is None:
        best_est_sec = _best_projection(3)
    if best_est_sec is None:
        return None

    gap_pct = (best_est_sec - goal_sec) / goal_sec * 100
    weeks = max(days_to_race, 1) / 7.0
    improvement_pct = 1.5 * weeks / 4.0  # ~1.5% pace gain per 4 weeks of training
    if gap_pct <= 0:
        status = "on_track"
    elif weeks < 4 and gap_pct > 0:
        status = "unlikely"
    elif gap_pct <= improvement_pct + 2:
        status = "at_risk"
    else:
        status = "unlikely"

    # Realistic goal for this block: current estimate improved by 70% of the
    # assumed capacity (never faster than the estimate itself).
    realistic_sec = best_est_sec * (1 - min(0.7 * improvement_pct / 100, 0.15))

    goal_str = _format_sec_km(goal_sec)
    est_str = _format_sec_km(best_est_sec)
    if status == "on_track":
        note = (f"Your recent training pace ({est_str}/km) already supports the goal pace "
                f"of {goal_str}/km — keep the block on plan.")
    elif status == "at_risk":
        note = (f"Goal pace {goal_str}/km vs estimated {est_str}/km from recent runs "
                f"({gap_pct:+.0f}%). Reachable with a strong, consistent block "
                f"({weeks:.0f} weeks left).")
    else:
        note = (f"Recent training pace ({est_str}/km) is {gap_pct:+.0f}% off the goal pace "
                f"({goal_str}/km). With {weeks:.0f} weeks left, a realistic target is "
                f"about {_format_sec_km(realistic_sec)}/km ({_format_marathon_time(realistic_sec)}).")

    return {
        "status": status,
        "goal_pace_sec_km": round(goal_sec, 1),
        "estimated_marathon_pace_sec_km": round(best_est_sec, 1),
        "gap_pct": round(gap_pct, 1),
        "weeks_to_race": round(weeks, 1),
        "improvement_assumption_pct": round(improvement_pct, 1),
        "realistic_goal_pace_sec_km": round(realistic_sec, 1),
        "realistic_goal_time": _format_marathon_time(realistic_sec),
        "note": note,
    }


def _progression_guide(phase, prev_long_km, race_day_chunk):
    """Phase-specific progression targets so week N+1 builds on week N."""
    peak = "about 29-32 km (18-20 miles) or 2-3 hours"
    if race_day_chunk:
        return (
            "- This chunk ends on race day. Put a \"Race\" workout (42.195 km) on the final day.\n"
            "- No long run or hard session in the 3 days before race day; the day before is a very short easy run or rest.\n"
            "- Race week volume is roughly half of peak, all easy."
        )
    if phase == "build":
        base = (f"Long run was {prev_long_km} km last week; grow it no more than 10% this week."
                if prev_long_km else "Long run starts modest; grow it no more than 10% per week.")
        return f"- {base}\n- Ramp total weekly volume gradually toward the peak block."
    if phase == "specificity":
        return (
            f"- Peak block. Long run reaches {peak}.\n"
            "- Include goal-pace segments in the final kilometres of the long run.\n"
            "- One MP session (15-30 min at goal pace) inside a workout or the long run."
        )
    if phase == "sharpen":
        return (
            f"- Volume about 20-30% below peak. Long run about 70% of peak ({peak}).\n"
            "- Keep one short race-pace session; no long intervals.\n"
            "- Last long run should be 10-14 days before race day."
        )
    if phase == "taper":
        return (
            f"- Volume about 40-60% below peak. Mostly easy with short race-pace touches.\n"
            f"- No long run beyond 60% of peak ({peak})."
        )
    return ""


def _attach_workout_details(days, pace_zones):
    """Override each workout's pace with the deterministic zone for its type,
    attach the coaching insight, and build the native Garmin step breakdown
    for the detail sheet (pace is derived, never user- or AI-editable)."""
    for day in days:
        w = day.get("workout")
        if not isinstance(w, dict):
            continue
        wtype = w.get("type") or "Easy"
        w["target_pace_min_per_km"] = pace_zones.get(wtype)
        # Coach insight is generated on demand when the runner opens the
        # workout card (see /api/workout-insight) — keep it null here so the
        # full-block plan payload stays light and fast.
        w.setdefault("insight", None)
        # Native Garmin steps — the exact steps that will be sent to the
        # watch, flattened into readable {type, detail} rows. Pace zones are
        # passed so each step's detail includes a target pace.
        try:
            w["steps"] = _flatten_workout_steps(
                _build_running_workout(w).to_dict(),
                pace_zones=pace_zones,
                workout_type=wtype,
            )
        except Exception:
            w["steps"] = [{"type": "Run", "detail": f"{w.get('distance_km') or '--'} km"}]


def _find_week_entry(week_plan, target_start):
    """Match a requested week_start to a generated window.

    Exact start, then a window that contains the date, then the closest
    start within one day (local vs UTC off-by-one on Vercel).
    """
    exact = next((e for e in week_plan if e[0] == target_start), None)
    if exact:
        return exact
    containing = next((e for e in week_plan if e[0] <= target_start <= e[1]), None)
    if containing:
        return containing
    closest = None
    closest_delta = None
    for e in week_plan:
        delta = abs((e[0] - target_start).days)
        if delta <= 1 and (closest_delta is None or delta < closest_delta):
            closest = e
            closest_delta = delta
    return closest


def _history_from_garmin_cache(cached):
    """Reuse the metrics Garmin cache so week-by-week plan calls don't
    each log into Garmin and refetch 14 days of activities."""
    if not cached:
        return None, {}
    physio = cached.get("physio") or {}
    ui = cached.get("ui_activities") or []
    cutoff = (date.today() - timedelta(days=13)).isoformat()
    history = []
    for a in ui:
        start = (a.get("start_time") or "")[:10]
        if not start or start < cutoff:
            continue
        type_key = (a.get("type") or "").lower()
        if type_key and type_key not in RUNNING_TYPES and type_key != "unknown":
            continue
        history.append(dict(a))
    if not history:
        return None, physio
    laps_by_date = {}
    for act in cached.get("activities") or []:
        d = (act.get("date") or act.get("start_time") or "")[:10]
        if d and act.get("laps"):
            laps_by_date[d] = act["laps"]
    for a in history:
        d = (a.get("start_time") or "")[:10]
        if d in laps_by_date and not a.get("laps"):
            a["laps"] = laps_by_date[d]
    return history, physio


def _build_chunk_prompt(chunk_start, chunk_end, chunk_days_count, race_goal_text, phase_text,
                        progression_text, week_position_text, window_structure_text, coach_insight_text,
                        intensity_text, days_per_week, mix_guide, distance_guide, physio_text, pace_zones,
                        history, week_targets_text, goal_pace_text):
    """Prompt for one week of the full-block plan. Carries the same context
    as the short-window prompt (goal, phases, prefs, recovery, zones) plus
    standardised week identity — week N of M, phase at that date, goal pace
    anchor, deterministic per-week progression targets (long run km, volume
    anchor) — so every week knows where it sits in the block and can be
    generated concurrently, plus the readiness insight (when available)."""
    return f"""You are an expert running coach. Study the runner's last 2 weeks of training
(with per-lap detail) and their recovery signals, then propose the week of training below.
This is one week inside a longer marathon block — progress it, do not reset it.

{race_goal_text}

PLAN WINDOW (this week):
- {week_position_text}
- Cover exactly {chunk_days_count} consecutive days from {chunk_start.isoformat()} to {chunk_end.isoformat()}.
- {window_structure_text}
- Put the long run on Saturday or Sunday when it falls inside the window.
- Put the quality session mid-week (Tuesday or Wednesday), with at least one easy or rest day
  before the long run.
- Never schedule two hard days back to back.

{phase_text}

{progression_text}

{coach_insight_text}

{week_targets_text}

{HONESTY_RULES}

{intensity_text}

PLAN PREFERENCES (the runner chose these — follow them):
- Number of workout days per week: {days_per_week} (the other days are rest days).
- Do not pad: if this week's phase or window shape calls for fewer workouts (partial week, taper,
  race week, or poor recovery), scheduling fewer is CORRECT — never invent extra workouts to reach
  the count.
- Workout mix: {mix_guide}.
{distance_guide}

RECOVERY SIGNALS (latest available):
{physio_text}

RECENT ACTIVITIES (last 2 weeks, newest first; each may include a "laps" array with per-lap
duration_s, distance_m, avg_pace_ms, avg_hr, max_hr, plus work/rest lap breakdown):
{json.dumps(history, indent=2)}

NOTE ON PACES: avg_pace_ms inside laps are metres per second. Convert to runner-friendly MM:SS/km
when quoting. A session that includes "laps" with work_lap_count > 0 was interval/tempo work —
read the work-lap paces as the true effort, not the blended average.

WORKOUT REQUIREMENTS:
- Each non-rest day's workout must have: "type" (one of Easy, Recovery, Long Run, Tempo, Intervals,
  Speedwork, Race), "title", "description" (1-2 sentences on intent), "distance_km" (number or null),
  "duration_min" (number or null), and "intensity" (easy, moderate, or hard). Do NOT set
  "target_pace_min_per_km" — it is assigned automatically from the target pace zones below. Do NOT
  set "insight" — it is generated on demand when the runner opens the workout, so leave it out.
- Scale distances and durations to the runner's recent training load, the weekly distance target,
  and this week's phase.

TARGET PACE ZONES (computed from the runner's recent fitness + race goal — use these paces when
writing descriptions; the numeric pace field is set automatically):
{json.dumps(pace_zones, indent=2)}

{goal_pace_text}

Return ONLY valid JSON:
{{"days": [{{"date": "YYYY-MM-DD", "day_of_week": "Mon", "is_rest": false, "workout": {{...}}}}, ...]}}"""


class CoachPlanRequest(BaseModel):
    token: str = ""
    days_per_week: int = 3        # number of workout days to schedule (2-6)
    intensity: str = "moderate"   # easy | moderate | hard
    distance_adj: str = "keep"    # reduce | keep | increase (relative to last week)
    force: str = ""               # when "1", skip the persistent cache and regenerate
    week_start: str = ""          # ISO date of a block week: when set, generate ONLY
                                  # that week (Hobby-friendly single-call mode)


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
    race_date_str = race_goal.get("race_date") if race_goal else None
    email = sess.get("email", "")

    # --- Persistent coach plan cache check (keyed by email, shared across devices) ---
    # The plan is week-specific — it starts tomorrow and covers the current
    # planning window. If we have a cached plan for this email with the same
    # plan_start (tomorrow) and the same preferences, return it immediately.
    # This prevents different devices from showing different plans.
    # Skip the cache entirely when force=1 (manual regeneration).
    forceRefresh = body.force in ("1", "true", "yes")
    current_prefs = {
        "days_per_week": days_per_week,
        "intensity": intensity,
        "distance_adj": distance_adj,
    }
    if email and not forceRefresh:
        cached_entry = _get_persistent_coach_cache(email)
        if cached_entry:
            cached_week_start = cached_entry.get("week_start", "")
            cached_race_date = cached_entry.get("race_date", "")
            cached_prefs = cached_entry.get("preferences", {})
            # Compute tomorrow's date the same way as below
            tomorrow = (date.today() + timedelta(days=1)).isoformat()
            # Return cached plan only if the block start, the race date, and
            # the preferences all match — a season plan is stale once the
            # race date changes or the block start moves. Also require the
            # cache to cover the WHOLE block: week-by-week generation merges
            # into the cache incrementally, and a partial cache must fall
            # through so the frontend keeps requesting the missing weeks.
            if (cached_week_start == tomorrow
                    and cached_race_date == (race_date_str or "")
                    and cached_prefs.get("days_per_week") == days_per_week
                    and cached_prefs.get("intensity") == intensity
                    and cached_prefs.get("distance_adj") == distance_adj):
                cached_days = ((cached_entry.get("data") or {}).get("plan") or {}).get("days") or []
                expected_total = None
                if race_date_str:
                    try:
                        rdate = _dt.strptime(race_date_str, "%Y-%m-%d").date()
                        plan_start_t = date.today() + timedelta(days=1)
                        exp_end = min(rdate, plan_start_t + timedelta(days=MAX_PLAN_DAYS))
                        expected_total = (exp_end - plan_start_t).days + 1
                    except (ValueError, TypeError):
                        pass
                if expected_total is None or len(cached_days) >= expected_total:
                    return JSONResponse(content=cached_entry["data"])

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    goal_pace_ms = _compute_goal_pace_ms(race_goal)

    cached_garmin = _get_cached_garmin_data(token)
    history = None
    physio = {}
    if cached_garmin:
        history, physio = _history_from_garmin_cache(cached_garmin)
    if history is None:
        client = _get_garmin_client(token)
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

    # ------------------------------------------------------------------
    # Full remaining-block plan (marathon companion)
    # ------------------------------------------------------------------
    # When the runner has a future race date, the plan covers the entire
    # block from tomorrow to race day instead of a short week window. The
    # block is generated chunk by chunk (first chunk = the current week,
    # then one full Mon-Sun week per AI call) so every week stays coherent
    # and the JSON stays within the response token limit. The final chunk
    # ends on race day, which gets a Race workout and no stacked hard or
    # long session.
    if race_date_str and days_to_race is not None and days_to_race > 0:
        plan_start = date.today() + timedelta(days=1)
        plan_end = race_date
        # Cap the block so a race far in the future does not generate months
        # of speculative weeks (marathon seasons run about 12-26 weeks).
        max_end = plan_start + timedelta(days=MAX_PLAN_DAYS)
        if plan_end > max_end:
            plan_end = max_end
        total_plan_days = (plan_end - plan_start).days + 1

        # Feasibility: can the runner's current pace + the remaining block
        # reach the typed goal pace? Computed from the same data the plan
        # uses (recent runs + goal pace), no extra AI call.
        feasibility = _estimate_feasibility(history, goal_pace_ms, days_to_race)

        # Readiness insight from the cached AI radar (read-only, cheap): the
        # plan should treat the diagnosed top gap as the prescription focus.
        ai_insight = None
        if email:
            cached_ai = _get_persistent_ai_cache(email)
            if cached_ai:
                overall = (cached_ai.get("data") or {}).get("overall") or {}
                top_gap = overall.get("topGap") or {}
                if overall.get("verdict"):
                    ai_insight = {
                        "verdict": overall.get("verdict"),
                        "score": overall.get("score"),
                        "top_gap_label": top_gap.get("label"),
                        "top_gap_note": (top_gap.get("note") or "")[:300],
                    }
        coach_insight_text = ""
        if ai_insight:
            coach_insight_text = (
                "COACH INSIGHT (readiness analysis of the same data — bias this week toward the top gap):\n"
                f"- Verdict: {ai_insight['verdict']} ({ai_insight['score']}/10)\n"
                f"- Top gap: {ai_insight['top_gap_label']} — {ai_insight['top_gap_note']}"
            )

        windows = _split_windows(plan_start, plan_end)

        # Per-week progression anchors computed deterministically from recent
        # history, so every week can be generated CONCURRENTLY — 26 sequential
        # AI calls would blow past the serverless function timeout. Long runs
        # ramp ~10% per week in build, peak in specificity, then cut for
        # sharpen/taper; the phase text + honesty rules keep each week coherent.
        base_long_km = 12.0
        for a in history:
            if (a.get("run_tag") or "") == "LSD":
                base_long_km = max(base_long_km, a.get("distance") or 0)
        base_weekly_km = prev_week_km if prev_week_km and prev_week_km > 0 else 25.0

        # Standardised goal-pace anchor — race-pace work in specificity /
        # sharpen / taper must use THIS pace, volume work never does.
        goal_pace_text = ""
        if goal_pace_ms and goal_pace_ms > 0:
            goal_pace_text = (
                "GOAL PACE: " + _format_sec_km(1000 / goal_pace_ms) + "/km — use it ONLY for "
                "race-pace work: MP blocks in specificity, short race-pace touches in sharpen, "
                "brief strides in taper. Never use it for easy, recovery, or long-run volume pacing."
            )

        next_monday = plan_start + timedelta(days=(7 - plan_start.weekday()) % 7)
        phase_counts = {}
        # (window, chunk_days_count, phase_text, progression_text, targets_text,
        #  week_position_text, window_structure_text)
        week_plan = []
        for week_idx, (w_start, w_end) in enumerate(windows):
            chunk_days_count = (w_end - w_start).days + 1
            # Window shape: gap days (the tail of the current week before the
            # first full Monday) get at most 1-2 easy runs; full weeks get
            # days_per_week; partial weeks scale proportionally. The AI sees
            # this as explicit context instead of mechanical enforcement.
            gap_days_count = max(0, min(chunk_days_count, (next_monday - w_start).days))
            if gap_days_count > 0 and chunk_days_count > gap_days_count:
                gap_sunday = w_start + timedelta(days=gap_days_count - 1)
                window_structure_text = (
                    f"Monday starts a new training block, but this window begins mid-week: the "
                    f"first {gap_days_count} days (through {gap_sunday.isoformat()}) are the tail "
                    f"of the current week — at most 1-2 easy or recovery runs there, never a long "
                    f"run or hard session. The remaining {chunk_days_count - gap_days_count} days "
                    f"form a full Mon-Sun training week with exactly {days_per_week} workout days; "
                    f"the rest are rest days."
                )
            elif chunk_days_count == 7:
                window_structure_text = (
                    f"This is a full Mon-Sun training week: exactly {days_per_week} workout days; "
                    f"the rest are rest days."
                )
            else:
                partial_target = min(days_per_week, max(1, (chunk_days_count * days_per_week + 6) // 7))
                window_structure_text = (
                    f"This window is a partial week of {chunk_days_count} days: at most "
                    f"{partial_target} workout days (never more than the number of days in the "
                    f"window), never two hard days back to back."
                )
            # Days remaining at the end of this chunk decide its phase, so a
            # long block moves build -> specificity -> sharpen -> taper.
            days_left = (race_date - w_end).days
            chunk_phase = _phase_for_days_left(days_left)
            phase_counts[chunk_phase] = phase_counts.get(chunk_phase, 0) + 1
            idx_in_phase = phase_counts[chunk_phase] - 1
            race_day_chunk = w_end >= race_date
            phase_text_chunk = phase_instructions.get(chunk_phase, "").format(days=days_left) if chunk_phase else ""
            progression_text = _progression_guide(chunk_phase, None, race_day_chunk)
            if race_day_chunk:
                progression_text += (
                    f"\n- The Race workout on the final day counts as one of the {days_per_week} "
                    f"sessions — do not add sessions to make up the count."
                )
            if race_day_chunk:
                targets_text = ("THIS WEEK'S PROGRESSION TARGETS: race week — no long run; the Race "
                                "workout on race day is the session. Keep everything else short and easy.")
            else:
                if chunk_phase == "build":
                    long_km = min(24.0, round(base_long_km * (1.1 ** idx_in_phase), 1))
                elif chunk_phase == "specificity":
                    long_km = 30.0
                elif chunk_phase == "sharpen":
                    long_km = 21.0
                else:
                    long_km = 12.0
                targets_text = (
                    "THIS WEEK'S PROGRESSION TARGETS (computed from your recent training — follow them):\n"
                    f"- Long run: about {long_km:g} km.\n"
                    f"- Recent weekly volume: about {base_weekly_km:g} km — scale this week to the phase guidance."
                )
            week_position_text = f"This is week {week_idx + 1} of {len(windows)} of the training block."
            week_plan.append((w_start, w_end, chunk_days_count, phase_text_chunk, progression_text,
                              targets_text, week_position_text, window_structure_text))

        # Always generate one week per request (Hobby 60s cap). The frontend
        # asks for each week separately and merges. If week_start is omitted
        # (old client, or no race date on the client), generate the first week
        # only — never fan out the whole season in one serverless invocation.
        target_start_str = body.week_start or week_plan[0][0].isoformat()
        try:
            target_start = _dt.strptime(target_start_str, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            return JSONResponse(status_code=400, content={"error": "Invalid week_start."})
        entry = _find_week_entry(week_plan, target_start)
        if entry is None:
            return JSONResponse(status_code=400, content={"error": "week_start does not match the plan block."})
        w_start, w_end, chunk_days_count, phase_text_chunk, progression_text, targets_text, week_position_text, window_structure_text = entry
        prompt = _build_chunk_prompt(
            w_start, w_end, chunk_days_count, race_goal_text, phase_text_chunk,
            progression_text, week_position_text, window_structure_text, coach_insight_text,
            intensity_text, days_per_week, mix_guide, distance_guide, physio_text, pace_zones,
            history, targets_text, goal_pace_text,
        )
        plan_chunk = None
        for attempt in range(2):
            try:
                plan_chunk = await _call_ai(prompt, api_key)
                break
            except json.JSONDecodeError:
                if attempt == 0:
                    continue
                return JSONResponse(status_code=500, content={"error": "AI returned unparseable response."})
            except Exception as e:
                if attempt == 0:
                    continue
                return JSONResponse(status_code=500, content={"error": f"Coach plan failed: {str(e)}"})
        if not isinstance(plan_chunk, dict):
            plan_chunk = {}
        chunk_days = plan_chunk.get("days") or []
        if not isinstance(chunk_days, list):
            chunk_days = []
        # Defensive: fix missing or incorrect dates from the known window
        # so the frontend can always schedule each day reliably.
        for i in range(chunk_days_count):
            expected_date = (w_start + timedelta(days=i)).isoformat()
            if i < len(chunk_days) and isinstance(chunk_days[i], dict):
                chunk_days[i]["date"] = expected_date
            elif i < len(chunk_days):
                chunk_days[i] = {"date": expected_date, "day_of_week": None, "is_rest": True, "workout": None}
            else:
                chunk_days.append({"date": expected_date, "day_of_week": None, "is_rest": True, "workout": None})
        chunk_days = chunk_days[:chunk_days_count]
        # Trust the AI's week as generated — no backfill or cap. Only complete
        # the schema so the frontend contract (is_rest = no workout) holds.
        for d in chunk_days:
            if isinstance(d, dict):
                d["is_rest"] = not bool(d.get("workout"))
        _attach_workout_details(chunk_days, pace_zones)

        plan = {
            "week_start": plan_start.isoformat(),
            "plan_start": plan_start.isoformat(),
            "plan_end": plan_end.isoformat(),
            "total_plan_days": total_plan_days,
            "race_date": race_date_str,
            "race_phase": race_phase or "build",
            "days_to_race": days_to_race,
            "pace_zones": pace_zones,
            "preferences": {
                "days_per_week": days_per_week,
                "intensity": intensity,
                "distance_adj": distance_adj,
                "weekly_distance_km": weekly_distance_km,
            },
            "days": chunk_days,
        }
        if feasibility:
            feasibility["readiness"] = ai_insight
        plan["feasibility"] = feasibility

        slim_history = [{k: v for k, v in a.items() if k != "laps"} for a in history]
        response_data = {"history": slim_history, "plan": plan}

        # Merge this week into the persistent email-keyed cache so the
        # block accumulates across requests and other devices.
        if email:
            cached = _get_persistent_coach_cache(email)
            merged = response_data
            if cached:
                cached_data = cached.get("data") or {}
                if (cached.get("week_start") == plan_start.isoformat()
                        and (cached.get("race_date") or "") == (race_date_str or "")
                        and (cached.get("preferences") or {}) == current_prefs):
                    merged = dict(cached_data)
                    merged_plan = dict(merged.get("plan") or {})
                    merged_days = {d.get("date"): d for d in merged_plan.get("days") or []}
                    for d in chunk_days:
                        merged_days[d["date"]] = d
                    merged_plan["days"] = [merged_days[k] for k in sorted(merged_days)]
                    merged["plan"] = merged_plan
            _save_persistent_coach_cache(
                email, merged,
                week_start=plan_start.isoformat(),
                preferences=current_prefs,
                race_date=race_date_str or "",
            )
        return JSONResponse(content=response_data)

    prompt = f"""You are an expert running coach. Study the runner's last 2 weeks of training
(with per-lap detail) and their recovery signals, then propose a training plan that honours the
runner's preferences and progresses them toward their race goal.

{race_goal_text}

PLAN WINDOW:
- Start on {plan_start.isoformat()} (tomorrow). Cover exactly {total_plan_days} consecutive days
  from that date, ending on {plan_end.isoformat()}.
- Do not wait for the next Monday. The plan starts tomorrow.
- Monday starts a new training block. The days between tomorrow and the next Monday
  ({next_monday.isoformat()}) complete the current week — schedule at most 1-2 easy runs there,
  never a long run or hard session. From {next_monday.isoformat()} onward, build the full
  Mon-Sun training block with exactly {days_per_week} workout days; the remaining days are rest.
- Do not pad: if the window is short or recovery is poor, fewer workouts is correct — never
  invent extra workouts to reach the count.
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
  "duration_min" (number or null), and "intensity" (easy, moderate, or hard). Do NOT set
  "target_pace_min_per_km" — it is assigned automatically from the target pace zones below. Do NOT
  set "insight" — it is generated on demand when the runner opens the workout, so leave it out.
- Scale distances/durations to the runner's recent training load, the weekly distance target, and
  the race phase (sharpen and taper phases must reduce volume).

TARGET PACE ZONES (computed from the runner's recent fitness + race goal — use these paces when
writing descriptions; the numeric pace field is set automatically):
{json.dumps(pace_zones, indent=2)}

Return ONLY valid JSON:
{{"week_start": "{plan_start.isoformat()}", "days": [{{"date": "YYYY-MM-DD", "day_of_week": "Mon", "is_rest": false, "workout": {{...}}}}, ...]}}"""

    try:
        plan = await _call_ai(prompt, api_key)
        if not isinstance(plan, dict):
            plan = {}
    except json.JSONDecodeError:
        return JSONResponse(status_code=500, content={"error": "AI returned unparseable response."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Coach plan failed: {str(e)}"})

    # Defensive: fill any missing/incorrect dates from the known plan window
    # so the frontend can always schedule each day reliably. The plan covers
    # total_plan_days from plan_start to plan_end.
    plan["week_start"] = plan_start.isoformat()
    days = plan.get("days") or []
    if not isinstance(days, list):
        days = []
    for i in range(total_plan_days):
        expected_date = (plan_start + timedelta(days=i)).isoformat()
        if i < len(days) and isinstance(days[i], dict):
            days[i]["date"] = expected_date
        elif i < len(days):
            days[i] = {"date": expected_date, "day_of_week": None, "is_rest": True, "workout": None}
        else:
            days.append({"date": expected_date, "day_of_week": None, "is_rest": True, "workout": None})
    plan["days"] = days[:total_plan_days]

    # Trust the AI's week as generated — no backfill or cap. Only complete
    # the schema so the frontend contract (is_rest = no workout) holds.
    for d in plan["days"]:
        if isinstance(d, dict):
            d["is_rest"] = not bool(d.get("workout"))

    # Override each workout's pace with the deterministic zone for its type,
    # attach the coaching insight, and build the native Garmin step breakdown
    # (pace is derived, never user- or AI-editable).
    _attach_workout_details(plan["days"], pace_zones)

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

    response_data = {"history": slim_history, "plan": plan}

    # Save to the persistent email-keyed cache so the same plan appears on
    # other devices. Store the plan_start, race_date, and preferences for
    # invalidation.
    if email:
        _save_persistent_coach_cache(
            email, response_data,
            week_start=plan_start.isoformat(),
            preferences=current_prefs,
            race_date=race_date_str or "",
        )

    return JSONResponse(content=response_data)
