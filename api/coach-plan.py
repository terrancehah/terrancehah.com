"""POST /api/coach-plan — the plan cluster.

Four operations share this one serverless function, dispatched by the request's
`action` field, so the plan cluster stays within the Vercel Hobby function limit:
  - "plan"     generate the AI coaching block (default)
  - "compile"  recompile one workout into the canonical object after an edit
  - "schedule" upload workouts to Garmin as templates and schedule them
  - "insight"  write the coach insight for one workout (or the plan card line)
"""

from fastapi.responses import JSONResponse
from datetime import date, timedelta, datetime as _dt
from typing import Optional, List, Any
from pydantic import BaseModel
import os
import json
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import (
    _get_session, _get_garmin_client, create_app,
    _update_session, _save_persistent_race_goal,
    _compute_goal_pace_ms, _race_distance_km, _race_result_paces, _fetch_physio_trends,
    _fetch_recent_activities_with_laps,
    _compute_pace_zones, _build_running_workout, _flatten_workout_steps,
    _compile_workout,
    _get_persistent_coach_cache, _save_persistent_coach_cache, _delete_persistent_coach_cache,
    _get_persistent_ai_cache, _get_cached_garmin_data, _get_fitness_snapshot,
    _save_persistent_course, _get_persistent_course, _course_prompt_block,
    _training_gain_per_km, _save_course_insight, _get_course_insight,
    _mileage_prompt_lines,
    _call_ai, _phase_for_days_left,
    _goal_target_seconds, _format_finish_time, _format_pace_per_km,
    _median, _fitness_medians, _fitness_samples, _long_run_samples, _cap_recent,
    _pace_str_sec, _pace_range_sec,
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

# Distance-aware LSD caps (km) — long runs never exceed the cap for the typed
# race distance. A half-marathon block peaks ~18 km, a marathon ~30 km.
PEAK_LONG_KM = {5.0: 14.0, 10.0: 16.0, 21.1: 18.0, 42.2: 30.0}

# The AI's weeks are trusted as generated — no backfill or cap. The prompt
# (see _build_chunk_prompt) carries the workout-count, partial-week, and
# race-week rules instead.

# Honesty rules for every generated week — these answer the verified amateur
# complaints about plan products (long runs too short, race-week stacking,
# no pause after illness, fake goal-pace work). The long-run peak is injected
# per race distance so a half block never chases marathon-sized longs.
def _honesty_rules(peak_long_km):
    return f"""HONESTY RULES (mechanical — apply before anything else):
- Long runs must progress toward this goal's peak (about {peak_long_km:g} km) when
  time-to-race allows. Do not keep long runs short forever, and never exceed the peak.
- Race week: never stack a long or hard session next to the race. The race day
  itself is the hard session.
- Goal-pace work must be real: genuine 15-30 minute blocks at goal pace inside
  long runs or dedicated goal-pace sessions. Do not fake it with short tempos then
  auto-shift by RPE.
- If recent recovery signals are poor (HRV down, RHR up, bad sleep), this week's
  quality session becomes easy and the long run stays conversational."""


def _fitness_summary(history, goal_pace_ms):
    """Current fitness for the plan overview card: the runner's recent
    long-run (easy) and quality (work-lap) paces as a median + an IQR range
    (min-max for small samples), plus the runs that produced them and the
    goal-derived reference paces. None when there is not enough data."""
    if not history or not goal_pace_ms or goal_pace_ms <= 0:
        return None
    easy_samples, fast_samples = _fitness_samples(history)
    # The card labels this bucket "Long", so show the LONG runs specifically —
    # a short easy run shouldn't stand in for long-run pace. Falls back to the
    # full easy bucket when the history has no long runs yet. Both buckets are
    # capped to the most recent runs, matching the trajectory read.
    long_samples = (_cap_recent(_long_run_samples(history), MAX_SAMPLES_PER_TYPE)
                    or _cap_recent(easy_samples, MAX_SAMPLES_PER_TYPE))
    fast_samples = _cap_recent(fast_samples, MAX_SAMPLES_PER_TYPE)
    easy_secs = [s["sec"] for s in long_samples]
    fast_secs = [s["sec"] for s in fast_samples]
    goal_sec = 1000 / goal_pace_ms

    def _range_str(secs):
        r = _pace_range_sec(secs)
        if not r:
            return None
        return f"{_format_sec_km(r[0])}–{_format_sec_km(r[1])}"

    def _slim_runs(samples):
        runs = []
        for s in samples:
            a = s["run"]
            runs.append({
                "id": a.get("id"),
                "name": a.get("name") or "Run",
                "date": (a.get("start_time") or "")[:10],
                "distance": a.get("distance"),
                "avg_pace": a.get("avg_pace"),
                "run_tag": a.get("run_tag") or "Easy",
            })
        runs.sort(key=lambda r: r["date"] or "", reverse=True)
        return runs

    return {
        "current_easy_pace": _format_sec_km(_median(easy_secs)) if easy_secs else None,
        "current_easy_range": _range_str(easy_secs),
        "current_easy_runs": _slim_runs(long_samples),
        "current_quality_pace": _format_sec_km(_median(fast_secs)) if fast_secs else None,
        "current_quality_range": _range_str(fast_secs),
        "current_quality_runs": _slim_runs(fast_samples),
        "goal_quality_pace": _format_sec_km(goal_sec + 5),
        "goal_pace": _format_sec_km(goal_sec),
    }


# Fitness/trajectory window. The plan prompt only wants the last 2 weeks, but
# that window often holds just one or two long runs — too few for a stable
# endurance read — so the trajectory and fitness summary look further back.
# Six weeks is enough for several long runs without dragging in fitness from
# months ago.
FITNESS_WINDOW_DAYS = 42

# Most recent runs per bucket (long runs, quality runs) used for the fitness
# read. A dozen quality sessions spanning two months would otherwise all count
# equally, even though the oldest no longer describe current fitness.
MAX_SAMPLES_PER_TYPE = 8

# How close (seconds per km) a sustained effort must be to goal pace to count
# as goal-pace work.
GOAL_PACE_TOLERANCE_SEC = 12


def _pretty_date(iso: str) -> str:
    """'2026-08-30' -> 'Aug 30' for user-facing copy."""
    try:
        d = _dt.strptime(iso, "%Y-%m-%d")
    except (ValueError, TypeError):
        return iso or ""
    return f"{d.strftime('%b')} {d.day}"


def _goal_pace_endurance(history, goal_pace_ms, race_distance_km):
    """The longest recent sustained effort at/near goal pace.

    This is the strongest endurance signal for a race goal — a run (or a work
    block inside one) that already held goal pace for a meaningful distance.
    It outranks the long-run median, which averages a race-pace long run away
    against a slow recovery-paced one. Uses lap-level work paces when present,
    and otherwise a steady run whose average pace sits near goal pace (a
    race-pace long run has no single goal-pace lap). Returns
    {"distance_km", "pace", "date"} or None.
    """
    if not history or not goal_pace_ms or goal_pace_ms <= 0:
        return None
    goal_sec = 1000 / goal_pace_ms
    best = None

    def _consider(dist_m, pace_ms, a):
        nonlocal best
        if not dist_m or not pace_ms:
            return
        if best is None or dist_m > best["_dist_m"]:
            best = {
                "_dist_m": dist_m,
                "distance_km": round(dist_m / 1000, 1),
                "pace": _format_sec_km(1000 / pace_ms),
                # How far off goal pace this effort actually was, so the copy can
                # say "goal pace" only when it truly was.
                "delta_sec": int(round(abs((1000 / pace_ms) - goal_sec))),
                "date": (a.get("start_time") or "")[:10],
            }

    for a in history:
        laps = a.get("laps")
        if isinstance(laps, dict):
            for lap in laps.get("laps") or []:
                if not isinstance(lap, dict):
                    continue
                lap_pace_ms = lap.get("avg_pace_ms") or 0
                dist_m = lap.get("distance_m") or 0
                if not lap_pace_ms or not dist_m:
                    continue
                if abs((1000 / lap_pace_ms) - goal_sec) <= GOAL_PACE_TOLERANCE_SEC:
                    _consider(dist_m, lap_pace_ms, a)
        # Also consider the run's own average — a steady race-pace long run is
        # goal-pace work even though it has no single goal-pace lap.
        pace_ms = a.get("avg_pace") or 0
        dist_km = a.get("distance") or 0
        if pace_ms and dist_km and abs((1000 / pace_ms) - goal_sec) <= GOAL_PACE_TOLERANCE_SEC:
            _consider(dist_km * 1000, pace_ms, a)

    if not best:
        return None
    # Only a meaningful distance counts as proof: half the race distance,
    # floored at 5 km so short-race goals aren't held to an impossible bar.
    threshold_km = max(5.0, 0.5 * (race_distance_km or 0))
    if best["distance_km"] < threshold_km:
        return None
    best.pop("_dist_m", None)
    return best


def _build_trajectory(history, goal_pace_ms, cached_plan=None, days_to_race=None,
                      race_distance_km=None):
    """Compare the runner's CURRENT fitness against the goal and — when a
    cached plan exists — against the pace that plan projected for today.

    Judged on MEDIANS, not extremes. A runner is "ahead" only when their
    typical quality work beats the goal's tempo demand AND their typical long
    run sits at goal shape; "behind" when either typical pace is well off.
    When the two disagree — fast quality work but long-run endurance that
    doesn't yet support the goal — the verdict is "mixed" rather than
    defaulting to on_track, so the card never claims readiness the data hasn't
    shown. The note is phase-aware, so a race-week verdict doesn't tell the
    runner to keep training.

    Returns a {status, note} dict, or None when there isn't enough data.
    """
    if not history or not goal_pace_ms or goal_pace_ms <= 0:
        return None
    easy_samples, fast_samples = _fitness_samples(history)
    # Cap each bucket to the most recent runs — a six-week window can hold a
    # dozen quality sessions, and the oldest no longer describe current fitness.
    fast_samples = _cap_recent(fast_samples, MAX_SAMPLES_PER_TYPE)
    fast_secs = sorted(s["sec"] for s in fast_samples)
    if not fast_secs:
        return None
    fast_med = _median(fast_secs)

    # Endurance evidence: the LONG runs, not the whole easy bucket — a short
    # easy run shouldn't stand in for long-run durability. Fall back to the
    # easy bucket only when the history has no long runs at all.
    long_samples = (_cap_recent(_long_run_samples(history), MAX_SAMPLES_PER_TYPE)
                    or _cap_recent(easy_samples, MAX_SAMPLES_PER_TYPE))
    long_secs = sorted(s["sec"] for s in long_samples)
    long_med = _median(long_secs) if long_secs else None

    # Goal-pace endurance proof — direct evidence the runner can hold the pace
    # the race demands. This outranks the long-run median: a race-pace long run
    # tagged as "easy" would otherwise be averaged away by a slow LSD.
    proof = _goal_pace_endurance(history, goal_pace_ms, race_distance_km)

    # User-facing phrase for that proof. Only call it "goal pace" when it really
    # was: a 5:18/km run against a 5:13/km goal is "within 5s/km of goal pace",
    # not "goal pace".
    proof_phrase = None
    if proof:
        delta = proof.get("delta_sec") or 0
        when = _pretty_date(proof["date"])
        if delta <= 2:
            proof_phrase = (f"already held goal pace for {proof['distance_km']:g} km "
                            f"({proof['pace']}/km on {when})")
        else:
            proof_phrase = (f"already covered {proof['distance_km']:g} km at {proof['pace']}/km "
                            f"— within {delta}s/km of goal pace — on {when}")

    def _range_str(secs):
        r = _pace_range_sec(secs)
        if not r:
            return None
        return f"{_format_sec_km(r[0])}–{_format_sec_km(r[1])}"

    goal_sec = 1000 / goal_pace_ms
    goal_pace_str = _format_sec_km(goal_sec)
    # The goal demands tempo work ~5s slower than race pace, and an aerobic
    # base ~50s slower — those are the references the runner's paces are
    # compared against (the goal pace itself is for display).
    goal_tempo_sec = goal_sec + 5
    goal_tempo_str = _format_sec_km(goal_tempo_sec)
    goal_easy_sec = goal_sec + 50
    goal_easy_str = _format_sec_km(goal_easy_sec)

    fast_range_str = _range_str(fast_secs)
    long_range_str = _range_str(long_secs) if long_secs else None
    fast_med_str = _format_sec_km(fast_med)
    long_med_str = _format_sec_km(long_med) if long_med else None

    # Quality side — typical quality work vs the goal's tempo demand.
    quality_behind = fast_med > goal_tempo_sec + 25
    quality_ahead = fast_med < goal_tempo_sec - 10
    # Endurance side — typical long-run pace vs the goal's aerobic reference.
    # A goal-pace proof settles the endurance side outright; otherwise judge the
    # typical long run against the goal's aerobic reference (goal + 50s) —
    # being merely close to it is adequate, not ahead.
    endurance_behind = (proof is None and long_med is not None
                        and long_med > goal_easy_sec + 45)
    endurance_ahead = proof is not None or (long_med is not None and long_med <= goal_easy_sec)

    # Race week (the final 7 days): the block is over, so advice shifts from
    # "keep building" to "arrive fresh and execute".
    race_week = days_to_race is not None and 0 <= days_to_race < 7

    # Plan staleness: compare the fitness the plan was BUILT with (stored in the
    # plan's own "fitness" block at generation time) against the runner's
    # current medians. If they've moved materially, the remaining block was
    # projected from older fitness and is worth rebuilding. Once rebuilt the
    # stored values match again and this flag clears — so the rebuild button
    # reflects a real state rather than being a permanent badge.
    rebuild = False
    stored_fitness = (cached_plan or {}).get("fitness") or {}
    stored_quality = _pace_str_sec(stored_fitness.get("current_quality_pace"))
    stored_easy = _pace_str_sec(stored_fitness.get("current_easy_pace"))
    if stored_quality and fast_med and abs(fast_med - stored_quality) > 10:
        rebuild = True
    if stored_easy and long_med and abs(long_med - stored_easy) > 15:
        rebuild = True

    # Behind — typical quality work OR typical long-run pace is well off.
    if quality_behind or endurance_behind:
        # Name only the side(s) that actually fell short — a runner with fast
        # quality work and slow long runs shouldn't be told their speed is off.
        if quality_behind and endurance_behind:
            note = (f"Your recent quality work ({fast_range_str or fast_med_str}) is off the "
                    f"~{goal_tempo_str}/km tempo your {goal_pace_str}/km goal demands, and your long "
                    f"runs ({long_range_str or long_med_str}) sit short of the ~{goal_easy_str}/km "
                    f"aerobic base this goal expects")
        elif quality_behind:
            note = (f"Your recent quality work ({fast_range_str or fast_med_str}) is off the "
                    f"~{goal_tempo_str}/km tempo your {goal_pace_str}/km goal demands")
        else:
            note = (f"Your long runs ({long_range_str or long_med_str}) sit short of the "
                    f"~{goal_easy_str}/km aerobic base your {goal_pace_str}/km goal expects")
        note += (". The race is days away, so there is no time to close that gap — treat the goal "
                 "as a stretch and run to current fitness." if race_week else
                 ". The plan ramps toward it, but the gap is large — a more conservative goal time "
                 "or a longer block is worth considering.")
        return {"status": "behind", "note": note, "rebuild": rebuild}

    # Ahead — typical quality work beats the tempo demand AND typical long runs
    # sit at goal shape (fast intervals alone don't make the goal conservative).
    if quality_ahead and (long_med is None or endurance_ahead):
        note = (f"Your recent quality work ({fast_range_str or fast_med_str}) is quicker than the "
                f"~{goal_tempo_str}/km tempo your {goal_pace_str}/km goal demands")
        if proof_phrase:
            note += f". You've {proof_phrase}"
        elif endurance_ahead:
            note += f", and your long runs ({long_range_str or long_med_str}) sit at goal shape"
        note += (". The work is banked — race week is about arriving fresh, not adding more."
                 if race_week else ". The goal may be conservative.")
        return {"status": "ahead", "note": note, "rebuild": rebuild}

    # Mixed — the speed is there, but the long runs don't yet prove the
    # endurance to hold goal pace for the distance. Honest middle ground
    # instead of defaulting to on_track.
    if quality_ahead and long_med is not None and not endurance_ahead:
        note = (f"Your speed is ahead of the goal — recent quality work at "
                f"{fast_range_str or fast_med_str} is quicker than the {goal_tempo_str}/km tempo it "
                f"demands. But the endurance to hold {goal_pace_str}/km for the race distance isn't "
                f"proven: no recent run has held goal pace for a meaningful distance, and your long "
                f"runs ({long_range_str or long_med_str}) aren't yet at the "
                f"~{goal_easy_str}/km shape this goal expects.")
        note += (" With the race days away, that is about even pacing and fuelling on the day, not "
                 "more training." if race_week else
                 " Build the long runs toward that shape before race day.")
        return {"status": "mixed", "note": note, "rebuild": rebuild}

    # On track — typical quality work is where the plan expects it and the long
    # runs sit at a sustainable aerobic shape.
    note = f"Your recent quality work ({fast_range_str or fast_med_str}) is where the plan expects it"
    if proof_phrase:
        note += f", and you've {proof_phrase}"
    elif long_med is not None:
        note += (f", and your long runs ({long_range_str or long_med_str}) sit at a sustainable "
                 f"aerobic shape")
    note += (". The block is done — race week is about arriving fresh and executing the plan."
             if race_week else ". Keep the block moving.")
    return {"status": "on_track", "note": note, "rebuild": rebuild}


def _split_windows(plan_start, plan_end):
    """Split [plan_start, plan_end] into AI-sized chunks.

    The final chunk is always the 7 days before race day — the only taper
    chunk — no matter which weekday the race falls on. For a Monday race
    that window crosses the Mon-Sun boundary, so the chunk before it is
    truncated at the day before the taper window (no overlap, no override
    needed). The first chunk runs tomorrow through the Sunday after the
    next Monday (up to 13 days); each later chunk is a full Mon-Sun week.
    """
    windows = []
    taper_start = plan_end - timedelta(days=6)
    if plan_start >= taper_start:
        # The whole remaining block is inside the taper window.
        return [(plan_start, plan_end)]
    first_end = plan_start + timedelta(days=((7 - plan_start.weekday()) % 7) + 6)
    # Never extend into the taper window — the taper chunk is always its own.
    first_end = min(first_end, taper_start - timedelta(days=1), plan_end)
    windows.append((plan_start, first_end))
    cursor = first_end + timedelta(days=1)
    while cursor <= plan_end:
        if cursor >= taper_start:
            # The final taper chunk — the 7 days before race day.
            chunk_end = plan_end
        else:
            chunk_end = min(cursor + timedelta(days=6), taper_start - timedelta(days=1), plan_end)
        windows.append((cursor, chunk_end))
        cursor = chunk_end + timedelta(days=1)
    # A 1-2 day leftover can appear right before the taper window (the days
    # between the last Mon-Sun chunk and the taper start, e.g. the Monday
    # before a Tuesday taper). Merge it into the previous chunk so the AI
    # sees the whole pre-taper block — a standalone 1-day chunk would be
    # generated blind, risking a workout sandwiched between workouts its
    # neighbours scheduled that it cannot see.
    if len(windows) >= 3:
        pre_taper_start, pre_taper_end = windows[-2]
        prev_start, _ = windows[-3]
        leftover_days = (pre_taper_end - pre_taper_start).days + 1
        merged_days = (pre_taper_end - prev_start).days + 1
        if leftover_days <= 2 and merged_days <= 13:
            windows[-3] = (prev_start, pre_taper_end)
            windows.pop(-2)
    return windows


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


def _progression_guide(phase, prev_long_km, race_day_chunk, peak_long_km, race_distance_km):
    """Phase-specific progression targets so week N+1 builds on week N.

    Peak long-run and race-day distances are injected per race goal — a
    half-marathon block peaks ~18 km and races 21.1 km, never 30/42.2.
    """
    peak = f"about {peak_long_km:g} km"
    if race_day_chunk:
        return (
            f"- This chunk ends on race day. Put a \"Race\" workout ({race_distance_km:g} km) on the final day.\n"
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
            "- One goal-pace session (15-30 min) inside a workout or the long run."
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
    """Compile each workout into the canonical object every consumer reads:
    paces resolved from the runner's current fitness zones, distances /
    durations / totals computed once, and the detail-sheet steps derived from
    the same segments the watch gets. The plan card, the detail sheet, the
    Garmin upload, and the coach insight all read this one structure, so they
    cannot disagree (pace is derived, never user- or AI-editable)."""
    for day in days:
        w = day.get("workout")
        if not isinstance(w, dict):
            continue
        # Coach insight is generated on demand when the runner opens the
        # workout card (see the "insight" action below) — keep it null here so
        # the full-block plan payload stays light and fast.
        w.setdefault("insight", None)
        try:
            w.update(_compile_workout(w, pace_zones, workout_type=w.get("type")))
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


def _history_from_garmin_cache(cached, days=14):
    """Reuse the metrics Garmin cache so week-by-week plan calls don't each
    log into Garmin and refetch activities.

    `days` bounds the window. The plan prompt wants the last 2 weeks, but the
    fitness/trajectory read uses a much longer window (see FITNESS_WINDOW_DAYS)
    so the endurance verdict rests on several long runs, not just the last two.
    """
    if not cached:
        return None, {}
    physio = cached.get("physio") or {}
    ui = cached.get("ui_activities") or []
    cutoff = (date.today() - timedelta(days=days - 1)).isoformat()
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


def _ui_history_from_cache(cached):
    """Every activity the Garmin cache holds, for the calendar to page through.

    Deliberately separate from `_history_from_garmin_cache`, which feeds the
    plan prompt. That history is two weeks, and every number derived from it —
    pace zones, previous weekly mileage, training gain — is computed over the
    same window, so widening it would change the plan itself. Browsing back
    through old weeks must not do that.

    The calendar only needs these for display, and having them up front is what
    lets the past-history window extend without a round trip. The cache is
    already populated with the last 60 activities by the metrics call, so this
    costs nothing extra: no Garmin login, no AI call.

    Laps are left alone — the client-facing payload strips them anyway.
    """
    if not cached:
        return None
    out = []
    for a in cached.get("ui_activities") or []:
        type_key = (a.get("type") or "").lower()
        if type_key and type_key not in RUNNING_TYPES and type_key != "unknown":
            continue
        out.append(dict(a))
    return out or None


def _build_chunk_prompt(chunk_start, chunk_end, chunk_days_count, race_goal_text, course_text, phase_text,
                        progression_text, week_position_text, window_structure_text, coach_insight_text,
                        intensity_text, days_per_week, mix_guide, distance_guide, physio_text, pace_zones,
                        history, week_targets_text, goal_pace_text, honesty_rules):
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

{course_text}

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

{honesty_rules}

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
  Speedwork, Race), "title", "description" (1-2 sentences on intent), "intensity" (easy, moderate,
  or hard), and "segments" — the exact session structure (see below).
- "segments" is an ordered list of the session's parts. Each segment has:
    - "role": "warmup" | "main" | "recovery" | "cooldown"
    - "effort": "easy" | "recovery" | "long_run" | "tempo" | "intervals" | "speed" | "goal_pace"
    - exactly one of "distance_km" (number) or "duration_min" (number) — that segment's length
    - "reps" (integer, optional — only for interval reps; the segment length is ONE rep)
    - "recovery" (optional object, only when "reps" > 1): the rest between reps, with "distance_km"
      or "duration_min" and "effort": "recovery"
  Examples: a tempo tune-up is [warmup easy 2 km, main goal_pace 1.5 km, cooldown easy 2 km];
  intervals are [warmup easy 2 km, main intervals 0.4 km reps 6 with recovery 2 min, cooldown easy 1 km].
- The segments ARE the session — their lengths sum to the session total, so do NOT also declare a
  separate "distance_km"/"duration_min" total (the totals are computed from the segments).
- Do NOT set "target_pace_min_per_km" — each segment's pace is assigned automatically from its
  "effort" using the target pace zones below. Do NOT set "insight" — it is generated on demand when
  the runner opens the workout, so leave it out.
- Scale segment lengths to the runner's recent training load, the weekly distance target, and this
  week's phase.

TARGET PACE ZONES (computed from the runner's recent fitness + race goal — the "effort" you pick for
each segment maps to one of these zones; the numeric pace is set automatically):
{json.dumps(pace_zones, indent=2)}

EFFORT → ZONE: "easy"→Easy, "recovery"→Recovery, "long_run"→Long Run, "tempo"→Tempo,
"intervals"→Intervals, "speed"→Speedwork, "goal_pace"→Race (the race goal pace).

{goal_pace_text}

Return ONLY valid JSON:
{{"days": [{{"date": "YYYY-MM-DD", "day_of_week": "Mon", "is_rest": false, "workout": {{...}}}}, ...]}}"""


# ---------------------------------------------------------------------------
# Insight helpers (moved from workout-insight.py)
# ---------------------------------------------------------------------------

# Plan workout types -> run_tag classes from the runner's actual history.
# Used to find "previous similar sessions" so the insight can compare this
# session against real runs of the same kind, not just the plan.
TYPE_TAG_MAP = {
    "Long Run": ("LSD",),
    "Tempo": ("Tempo Long", "Tempo"),
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


def _similar_sessions(token: str, workout_type: str, limit: int = 2) -> list:
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

CURRENT FITNESS (from recent runs): long-run pace {fitness.get('current_easy_pace', '--')}/km, quality pace {fitness.get('current_quality_pace', '--')}/km. The race goal pace is {fitness.get('goal_pace', '--')}/km (tempo work around {fitness.get('goal_quality_pace', '--')}/km).

PLAN: {ctx.get('race_phase', '')} phase, {ctx.get('days_to_race', '')} days to race.

TRAJECTORY: {trajectory_status}. {trajectory_note}

{ctx.get('course_text', '')}

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


# ---------------------------------------------------------------------------
# Scheduling helpers (moved from schedule-plan.py)
# ---------------------------------------------------------------------------

class ScheduleDay(BaseModel):
    date: str
    workout: Optional[dict] = None


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


class CoachPlanRequest(BaseModel):
    token: str = ""
    # Which operation this request is: "plan" (default, generate the block),
    # "compile" (recompile one workout), "schedule" (push workouts to Garmin),
    # or "insight" (write the coach insight for one workout / the plan card).
    # The four plan-cluster operations share this one serverless function to
    # stay within the Vercel Hobby function limit.
    action: str = "plan"
    # --- plan ---
    days_per_week: int = 3        # number of workout days to schedule (2-6)
    intensity: str = "moderate"   # easy | moderate | hard
    distance_adj: str = "keep"    # reduce | keep | increase (relative to last week)
    force: str = ""               # when "1", skip the persistent cache and regenerate
    week_start: str = ""          # ISO date of a block week: when set, generate ONLY
                                  # that week (Hobby-friendly single-call mode)
    # --- compile ---
    workout: Optional[dict] = None
    zones: Optional[dict] = None
    # --- schedule ---
    days: List[ScheduleDay] = []
    # --- insight ---
    date: str = ""
    context: Optional[dict] = None
    kind: str = "workout"         # "workout" (single session) | "plan" (race card line)
    # --- course ---
    # The distilled race-course record (or None to clear it). The GPX itself is
    # parsed in the browser and never uploaded; this carries only the summary.
    course: Optional[dict] = None
    # --- race-recap ---
    # The finished race's result, as the frontend has it: duration_min,
    # distance_km, avg_pace_ms, avg_hr, elevation_gain. Sent rather than read
    # from Garmin because the run may have been linked by hand (a watch that
    # never synced, or an uploaded GPX), and because the recap must describe the
    # race the runner acknowledged, not whatever sits on race day.
    race_result: Optional[dict] = None


@app.get("/")
async def coach_plan_get(token: str = "", action: str = ""):
    """GET side of the plan cluster — currently only the race course.

    The course is fetched on dashboard load so a course added on one device
    appears on the runner's other devices. Everything else in this cluster is
    a POST.
    """
    if (action or "").strip().lower() != "course":
        return JSONResponse(status_code=400, content={"error": "Unsupported action for GET."})
    try:
        sess = _get_session(token) or {}
    except Exception:
        sess = {}
    email = sess.get("email", "") if isinstance(sess, dict) else ""
    return JSONResponse(content={"course": _get_persistent_course(email)})


@app.post("/")
async def coach_plan(body: CoachPlanRequest):
    """Plan-cluster endpoint — dispatches on `action` (see CoachPlanRequest).

    Plan / compile / schedule / insight / course share this one function so the
    plan cluster stays within the Vercel Hobby function limit. The heavy plan
    generation lives in _generate_plan below.
    """
    action = (body.action or "plan").strip().lower()
    if action == "compile":
        return await _compile_workout_action(body)
    if action == "schedule":
        return await _schedule_plan_action(body)
    if action == "insight":
        return await _workout_insight_action(body)
    if action == "course":
        return await _save_course_action(body)
    if action == "course-insight":
        return await _course_insight_action(body)
    if action == "race-recap":
        return await _race_recap_action(body)
    if action == "race-result":
        return await _save_race_result_action(body)
    return await _generate_plan(body)


async def _save_course_action(body: CoachPlanRequest):
    """Store (or clear) the runner's race course.

    The GPX is parsed in the browser, so only the distilled record arrives here
    (distance, filtered elevation, climbs, profile, route outline). Keyed by
    email so the course follows the runner across devices. Passing a null
    course clears the stored one.
    """
    sess = _get_session(body.token) or {}
    email = sess.get("email", "") if isinstance(sess, dict) else ""
    if not email:
        return JSONResponse(status_code=401, content={"error": "Session expired."})
    _save_persistent_course(email, body.course)
    return JSONResponse(content={"ok": True, "saved": body.course is not None})


def _build_course_insight_prompt(course: dict, race_goal: dict | None, training_gain_per_km: float | None) -> str:
    """Prompt for the coach's read on the race course.

    Deliberately short output: this sits in the course card, so it has to read
    as a coach's aside rather than a report. The course structure itself comes
    from _course_prompt_block so the coached numbers cannot drift from the
    numbers shown on the card.
    """
    goal_text = ""
    if race_goal:
        goal_text = (
            f"RACE GOAL: {race_goal.get('purpose', 'N/A')} in "
            f"{race_goal.get('time_target', 'N/A')} on {race_goal.get('race_date', 'N/A')}."
        )

    return f"""You are an expert running coach. Write your read on the runner's race course.

{_course_prompt_block(course, training_gain_per_km)}

{goal_text}

Write 4-5 sentences of plain prose — no lists, no headings, no bullet points — in this order:

1. What kind of race this is, in one sentence. Plain language rather than numbers.
2. One or two sentences on what to notice out on the course — the stretch that will decide the
   race, and any descent worth running. Name the stretch and give its numbers: where it starts,
   how much it climbs, how steep. This is what the runner will remember on the day, so the figures
   earn their place even when they are small — 20 m in the final kilometre is a real feature of a
   flat half.
3. One sentence on how it compares with what the runner already does. If the course is hillier
   than their training, say so plainly — their usual runs are flatter and this will ask more of
   them. If it is NOT hillier, reassure them instead: the climbing is within what they already do.
4. One closing sentence with the suggestion: add hill work, or keep doing what they are doing.

Rules:
- Quote numbers for the stretch you name, and for the training comparison if there is one. Leave
  the rest out — too many figures bury the point, and a flat course does not need five of them.
- Never write "your own terrain", "the runner's terrain" or "flat-equivalent" — those are our
  internal labels, not something a coach would say.
- Do not repeat the race date or goal time as filler. Never write m/s.
- Use only the numbers you were given; never invent any.

Return ONLY valid JSON:
{{"insight": "..."}}"""


async def _course_insight_action(body: CoachPlanRequest):
    """Write (or return the cached) coach's read on the uploaded race course.

    The course comes from the request when the frontend just uploaded one, so
    this cannot race the save; otherwise it falls back to the stored copy.
    """
    sess = _get_session(body.token)
    email = sess.get("email", "") if isinstance(sess, dict) else ""
    race_goal = sess.get("race_goal") if isinstance(sess, dict) else None

    course = body.course or _get_persistent_course(email)
    if not course or not (course.get("aiSummary") or {}):
        return JSONResponse(status_code=404, content={"error": "No race course uploaded."})

    # The course record's savedAt changes on every upload, so a re-upload
    # regenerates the read rather than serving one for a course they replaced.
    fingerprint = course.get("savedAt") or ""

    if not body.force:
        cached = _get_course_insight(email, fingerprint)
        if cached:
            return JSONResponse(content={"insight": cached, "cached": True})

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    training = _training_gain_per_km((_get_fitness_snapshot(email) or {}).get("ui_activities"))
    prompt = _build_course_insight_prompt(course, race_goal, training)

    try:
        result = await _call_ai(prompt, api_key)
        insight = (result.get("insight") or "").strip()
    except Exception:
        insight = ""
    if not insight:
        return JSONResponse(status_code=500, content={"error": "Could not read the course."})

    _save_course_insight(email, insight, fingerprint)
    return JSONResponse(content={"insight": insight, "cached": False})


def _race_delta_line(goal: dict | None, result: dict) -> str:
    """How the finish compared to the target, as one phrase for the prompt.

    Returns "" when either side is missing or nonsense, so the prompt omits the
    comparison rather than asserting a delta that was never measured.
    """
    target_sec = _goal_target_seconds(goal)
    try:
        finish_sec = int(round(float(result.get("duration_min") or 0) * 60))
    except (TypeError, ValueError):
        return ""
    if target_sec <= 0 or finish_sec <= 0:
        return ""
    delta = finish_sec - target_sec
    # Under a minute reads as noise rather than a result worth naming.
    if abs(delta) < 60:
        return "level with the target."
    return f"{_format_finish_time(abs(delta) / 60)} {'faster' if delta < 0 else 'slower'} than target."


# Sessions worth naming when crediting the training behind a race result. The
# recap's middle sentences point at the work that produced the result, and these
# are the sessions a runner would recognise as having done it: the long runs that
# built the endurance, the threshold and interval work that built the pace.
_RECAP_CREDITABLE_TAGS = ("LSD", "Tempo", "Tempo Long", "Speedwork")
# How far back to look for those sessions, and how many to name. This block is a
# credit, not a training log — a handful of the freshest sessions before race day
# is enough to give the coach something specific to point at.
_RECAP_TRAINING_WEEKS = 10
_RECAP_TRAINING_LIMIT = 6


def _race_training_block(activities: list[dict], race_date: str) -> str:
    """The sessions that built the race, formatted for the recap prompt.

    The recap is meant to reassure the runner that the result came out of their
    own work, which only means anything if the coach can name that work. This
    lists the notable sessions from the weeks leading into race day — long runs
    and quality work — with dates, distances and paces, so the praise can be tied
    to something real rather than invented.

    Returns "" when there is nothing to cite, so the prompt can tell the model to
    skip the credit rather than praise training it cannot see.
    """
    if not activities or not race_date:
        return ""
    try:
        cutoff = (date.fromisoformat(race_date) - timedelta(days=_RECAP_TRAINING_WEEKS * 7)).isoformat()
    except ValueError:
        return ""

    rows = []
    for a in activities:
        if (a.get("type") or "").lower() not in RUNNING_TYPES:
            continue
        day = (a.get("start_time") or "")[:10]
        # Only the build into this race: nothing after race day, and nothing from
        # before the window, or the credit would reach back into another season.
        if not day or day > race_date or day < cutoff:
            continue
        tag = a.get("run_tag") or ""
        if tag not in _RECAP_CREDITABLE_TAGS:
            continue
        km = a.get("distance") or 0
        pace = _format_pace_per_km(a.get("avg_pace"))
        if not km or not pace:
            continue
        rows.append((day, f"- {day} · {a.get('name') or 'Run'} · {km} km at {pace}/km ({tag})"))

    if not rows:
        return ""
    # Newest first, then capped — the freshest sessions are the ones that built
    # the race the runner just ran.
    rows.sort(key=lambda r: r[0], reverse=True)
    return (
        "THE TRAINING THAT LED INTO IT (the runner's own sessions, most recent "
        "first — cite these specifically, and only these):\n"
        + "\n".join(r[1] for r in rows[:_RECAP_TRAINING_LIMIT])
    )


def _build_race_recap_prompt(goal: dict | None, result: dict, course: dict | None,
                             training_block: str = "") -> str:
    """Prompt for the coach's read on a finished race.

    The one place the coach speaks after the race. It has the target, the actual
    result and — when the runner uploaded one — the course, so a slow day can be
    accounted for by the terrain instead of read as a fitness verdict.

    Output is deliberately a single paragraph. The figures are already computed
    and displayed beside this text, so the prose only has to say what they mean
    and what comes next. Splits, weather and how the runner felt are not known
    here and must not be invented.
    """
    goal = goal or {}
    lines = [
        "The runner has finished the race they were training for. Write the coach's read on it.",
        "",
        "THE GOAL THEY WERE TRAINING FOR:",
        f"- Race: {goal.get('race_name') or goal.get('purpose') or 'their goal race'}.",
    ]
    if goal.get("distance"):
        lines.append(f"- Distance: {goal['distance']} {goal.get('distance_unit') or 'km'}.")
    if goal.get("time_target"):
        lines.append(f"- Target time: {goal['time_target']}.")
    if goal.get("race_date"):
        lines.append(f"- Race date: {goal['race_date']}.")

    lines += ["", "WHAT THEY ACTUALLY RAN:"]
    finish = _format_finish_time(result.get("duration_min"))
    lines.append(f"- Finish time: {finish or 'unknown'}.")
    if result.get("distance_km"):
        lines.append(f"- Distance covered: {result['distance_km']} km.")
    pace = _format_pace_per_km(result.get("avg_pace_ms"))
    if pace:
        lines.append(f"- Average pace: {pace} per km.")
    if result.get("avg_hr"):
        lines.append(f"- Average heart rate: {result['avg_hr']} bpm.")
    if result.get("elevation_gain"):
        lines.append(f"- Elevation gain: {result['elevation_gain']} m.")

    delta = _race_delta_line(goal, result)
    if delta:
        lines.append(f"- Against the target: {delta}")

    course_block = _course_prompt_block(course)
    if course_block:
        lines += ["", course_block]

    if training_block:
        lines += ["", training_block]

    lines += [
        "",
        "Write ONE paragraph of 4-6 sentences, in the coach's voice:",
        "- Open on how the race went against the target, and sound like a coach who is pleased to be "
        "reading it. If they hit the target, say so warmly and without hedging. If they missed it, be "
        "honest and proportionate — a few minutes on a half marathon is a normal day, not a failure — "
        "and lead with what the result does show rather than what it lacks.",
        "- Then spend one or two sentences connecting the result back to the training listed above. This "
        "is the reassurance, and it needs to be earned: name the specific sessions that built this race "
        "and say what each one bought them — the long runs that built the endurance to hold pace late, "
        "the threshold work that made the pace sustainable, the intervals that gave them the speed "
        "reserve. Quote the distances and paces from the list so the credit has proof behind it, and "
        "make clear the result came out of that work rather than out of luck or a good day.",
        "- If a course was provided, use the terrain to explain the result only where it genuinely explains it.",
        "- This race is the END of the block the runner was following. Do NOT prescribe training: no next "
        "block, no sessions, no paces, no \"work on this next\", and no advice about what to do from here. "
        "The plan is over, and a new goal is set separately if the runner wants one. Close on the race itself.",
        "- Do not invent splits, weather, race conditions, or how the runner felt. None of that is known here.",
        "- Only cite sessions from the training list above, and only if it is present. If it is absent, "
        "skip the credit sentences entirely rather than praising training you cannot see.",
        "- Do not restate the finish time or the goal time as a list — those figures are displayed beside this text.",
        "",
        'Return JSON: {"recap": "<the paragraph>"}',
    ]
    return "\n".join(lines)


def _js_number(value) -> str:
    """Format a number the way JavaScript's String() would.

    The frontend builds the same fingerprint as _race_recap_key, and the two have
    to agree character for character: JS prints a whole number as "119" where
    Python prints "119.0", and that single mismatch would make the client reject
    a perfectly good stored paragraph and regenerate it. Only the integral case
    is normalised — durations and distances never reach the exponents, where the
    two languages do diverge.
    """
    try:
        n = float(value)
    except (TypeError, ValueError):
        return str(value or "")
    return str(int(n)) if n.is_integer() else repr(n)


def _race_recap_key(result: dict | None) -> str:
    """Fingerprint of the result a recap was written against.

    Mirrors the frontend's raceRecapCacheKey exactly, so both sides agree on
    whether a stored paragraph still describes the current result. A re-linked
    race changes it, and a recap written for the old run must not be served for
    the new one — which is the whole point of keying it rather than just storing
    the text.
    """
    r = result or {}
    parts = []
    for field in ("date", "duration_min", "distance_km"):
        value = r.get(field)
        # `not value` rather than a None check, to match the frontend's `|| ''`:
        # a zero duration or distance is treated as absent on both sides.
        if not value:
            parts.append("")
        elif field == "date":
            parts.append(str(value))
        else:
            parts.append(_js_number(value))
    return "|".join(parts)


def _race_readiness_snapshot(email: str) -> dict | None:
    """Copy the pre-race six-area analysis into a form the goal can carry.

    The analysis lives in `race:ai-cache:{email}`, which is deleted whenever the
    goal changes and expires after 7 days. Nothing regenerates it after the race
    — the six areas score fitness toward a race that has already happened — so
    without this copy the runner could not look back at what the numbers said
    before they ran. Returns None when there is nothing to freeze, which leaves
    any snapshot already taken in place rather than overwriting it with nothing.
    """
    if not email:
        return None
    cached = _get_persistent_ai_cache(email)
    data = (cached or {}).get("data") or {}
    if not (data.get("dimensions") or []):
        return None
    return {
        "data": data,
        "generated_at": (cached or {}).get("generated_at", ""),
    }


async def _race_recap_action(body: CoachPlanRequest):
    """Write — or return the already written — coach's read on a finished race.

    The result arrives in the request rather than being looked up, because a race
    can be linked by hand — a watch that never synced, or an uploaded GPX — and
    the recap has to describe the race the runner acknowledged rather than
    whatever activity happens to sit on race day.

    The paragraph is stored on the goal, beside the result it describes, so it
    rides the goal's existing session + persistent paths and reaches the runner's
    other devices through check-session. That is why there is no cache key of its
    own: `race:goal:{email}` already syncs, and a second store would only be
    another thing to keep in step.

    The same call freezes the pre-race six-area analysis onto the goal (see
    _race_readiness_snapshot), so the runner can still review the readiness that
    stood before the race after the recap has taken its place on the pages.
    """
    sess = _get_session(body.token) or {}
    email = sess.get("email", "") if isinstance(sess, dict) else ""
    race_goal = sess.get("race_goal") if isinstance(sess, dict) else None

    result = body.race_result or {}
    if not result.get("duration_min"):
        return JSONResponse(status_code=400, content={"error": "Race result required."})

    key = _race_recap_key(result)

    # Freeze the pre-race readiness before anything else, and before the cached
    # early return, so it is captured even when the paragraph was written on a
    # previous load. Only taken once — a snapshot already on the goal is left
    # alone, because the cache it is copied from can expire while the runner is
    # still looking back at it.
    if race_goal and email and not (race_goal.get("race_readiness") or {}).get("data"):
        snapshot = _race_readiness_snapshot(email)
        if snapshot:
            race_goal = dict(race_goal)
            race_goal["race_readiness"] = snapshot
            _update_session(body.token, {"race_goal": race_goal})
            _save_persistent_race_goal(email, race_goal)

    # A paragraph written for this exact result is served as-is — that is what
    # makes a second device instant instead of spending an AI call to rewrite
    # the same words. A different result misses and falls through.
    stored = (race_goal or {}).get("race_recap") or {}
    if stored.get("text") and stored.get("key") == key:
        return JSONResponse(content={"recap": stored["text"], "cached": True})

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    course = body.course or _get_persistent_course(email)
    # The sessions that built the race, so the coach's reassurance can point at
    # real work. Read from the email-keyed fitness snapshot rather than Garmin:
    # it is already warm from the dashboard load, so this costs no fetch and no
    # chance of tripping the rate limit for a paragraph.
    training_block = _race_training_block(
        (_get_fitness_snapshot(email) or {}).get("ui_activities") or [],
        (race_goal or {}).get("race_date", ""),
    )
    prompt = _build_race_recap_prompt(race_goal, result, course, training_block)

    try:
        parsed = await _call_ai(prompt, api_key)
        recap = (parsed.get("recap") or "").strip()
    except Exception as e:
        # Logged, unlike the AI-radar handler: a bare 500 with no trace made that
        # failure undiagnosable from the server side.
        print(f"race-recap failed: {e}")
        recap = ""
    if not recap:
        return JSONResponse(status_code=500, content={"error": "Could not write the race recap."})

    # Store the paragraph on the goal, keyed to the result it describes, so the
    # runner's other devices read it from the goal they already fetch rather
    # than each spending an AI call to rewrite it. Written to both the session
    # and the persistent goal, exactly as the result itself is.
    if race_goal and email:
        updated = dict(race_goal)
        updated["race_recap"] = {
            "text": recap,
            "key": key,
            "generated_at": _dt.now().isoformat(),
        }
        _update_session(body.token, {"race_goal": updated})
        _save_persistent_race_goal(email, updated)

    return JSONResponse(content={"recap": recap, "cached": False})


async def _save_race_result_action(body: CoachPlanRequest):
    """Attach the finished race's result to the runner's goal.

    Stored on the goal rather than in a store of its own so it travels with the
    goal through the existing session and persistent-goal paths — which already
    sync across devices via check-session — instead of adding another key to keep
    in step. Passing a null result clears it, which is what happens when a new
    goal is set and the old race is filed to history.
    """
    sess = _get_session(body.token) or {}
    email = sess.get("email", "") if isinstance(sess, dict) else ""
    if not email:
        return JSONResponse(status_code=401, content={"error": "Session expired."})
    goal = sess.get("race_goal") if isinstance(sess, dict) else None
    if not goal:
        return JSONResponse(status_code=400, content={"error": "No race goal set."})

    updated = dict(goal)
    if body.race_result:
        updated["race_result"] = body.race_result
        # A recap written for a different result is stale the moment the result
        # changes. The key would catch it on read anyway, but dropping it here
        # keeps the stored goal honest instead of carrying a paragraph nothing
        # matches.
        if (goal.get("race_recap") or {}).get("key") != _race_recap_key(body.race_result):
            updated.pop("race_recap", None)
        # The race has now happened, so freeze the readiness analysis the runner
        # trained against. Taken once, and only when the goal does not already
        # carry it, so re-linking a run never loses an earlier snapshot.
        if not (updated.get("race_readiness") or {}).get("data"):
            snapshot = _race_readiness_snapshot(email)
            if snapshot:
                updated["race_readiness"] = snapshot
    else:
        updated.pop("race_result", None)
        # No result means no recap: the paragraph describes a race that is no
        # longer attached to this goal.
        updated.pop("race_recap", None)

    _update_session(body.token, {"race_goal": updated})
    _save_persistent_race_goal(email, updated)
    return JSONResponse(content={"ok": True, "goal": updated})


async def _compile_workout_action(body: CoachPlanRequest):
    """Recompile one workout into the canonical object (see _compile_workout).

    Called by the frontend after the runner edits a workout, so the paces,
    distances, durations, totals and step breakdown are recomputed together
    instead of mutating one raw field and letting the consumers drift apart.
    """
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


async def _schedule_plan_action(body: CoachPlanRequest):
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


async def _workout_insight_action(body: CoachPlanRequest):
    """Write the coach insight paragraph for one workout — or the plan
    overview line when kind == "plan" — on demand.

    The full-block plan is generated without per-workout insight text so the
    payload stays light. Tapping a workout card calls this action, which
    writes the paragraph with real context: where the session sits in the
    block (week number, phase at THAT date, previous session), the race goal,
    and the runner's readiness analysis when one exists.
    """
    sess = _get_session(body.token)
    if body.kind == "plan":
        # The race course (when uploaded) is advisory context for the plan line.
        plan_ctx = dict(body.context or {})
        plan_email = sess.get("email", "") if isinstance(sess, dict) else ""
        plan_ctx["course_text"] = _course_prompt_block(
            _get_persistent_course(plan_email),
            _training_gain_per_km((_get_fitness_snapshot(plan_email) or {}).get("ui_activities")),
        )
        return await _plan_overview_insight(plan_ctx)
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
                    # Coach-language prompt context — the model may echo this
                    # back to the runner, so it must not use internal terms
                    # like "analysis" (see pacey-writing-style.md).
                    "Your last readiness check said: "
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

    # The compiled structure — `segments` is the exact session the watch gets
    # and `totals` is the reconciled summary. Handing both to the model means
    # the insight describes the real session, not a re-imagined one.
    workout_spec = {
        k: workout.get(k)
        for k in ("type", "title", "description", "distance_km", "duration_min",
                  "intensity", "target_pace_min_per_km", "totals", "segments")
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

    # The uploaded race course, when there is one — lets a hill session say
    # which climb it is preparing for. Advisory only; it never changes paces.
    course_line = _course_prompt_block(
        _get_persistent_course(email),
        _training_gain_per_km((_get_fitness_snapshot(email) or {}).get("ui_activities")),
    )

    prompt = f"""You are an expert running coach. Write ONE coach insight paragraph for a single workout.

PLAN CONTEXT (this is the heart of the insight — write for the week, not the workout in isolation):
- {week_text}
- Race phase at this session: {race_phase_text or 'no race context yet'}.
- Previous session in the plan: {prev_text}.

{similar_section}

RACE CONTEXT (internal reference only — do not lead with numbers from this):
- {goal_text}

{course_line}

WORKOUT:
{json.dumps(workout_spec, indent=2)}

NOTE: "segments" is the EXACT structure that will be sent to the watch (each with a role, a distance or time, and a pace), and "totals" is the reconciled summary (distance, duration, average pace). Describe THAT session — do not invent a different structure, and do not describe a segment as longer or shorter than it is.

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


async def _generate_plan(body: CoachPlanRequest):
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
        # The fitness anchor shapes the zones — changing it invalidates
        # the cached plan.
        "fitness_race_distance": (race_goal or {}).get("fitness_race_distance", ""),
        "fitness_race_time": (race_goal or {}).get("fitness_race_time", ""),
        # The goal itself shapes the whole plan (phases, target paces, race
        # week). A changed time target, purpose, distance or weekly mileage
        # must invalidate the cached block — otherwise a runner who edits
        # 1:50 → 1:45 with the same race date keeps getting the 1:50 plan.
        "purpose": (race_goal or {}).get("purpose", ""),
        "distance": (race_goal or {}).get("distance", ""),
        "time_target": (race_goal or {}).get("time_target", ""),
        "weekly_mileage": (race_goal or {}).get("weekly_mileage", ""),
    }
    goal_pace_ms = _compute_goal_pace_ms(race_goal)
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
                    and cached_prefs.get("distance_adj") == distance_adj
                    and cached_prefs.get("fitness_race_distance") == current_prefs["fitness_race_distance"]
                    and cached_prefs.get("fitness_race_time") == current_prefs["fitness_race_time"]
                    and cached_prefs.get("purpose", "") == current_prefs["purpose"]
                    and cached_prefs.get("distance", "") == current_prefs["distance"]
                    and cached_prefs.get("time_target", "") == current_prefs["time_target"]
                    and cached_prefs.get("weekly_mileage", "") == current_prefs["weekly_mileage"]):
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
                    data = cached_entry["data"]
                    # Never serve a STORED trajectory verdict — it is
                    # transient (reflects current fitness) and old entries
                    # may carry stale text. Recomputed below from the warm
                    # Garmin cache only (never triggers a fresh login on a
                    # cache hit); when the Garmin cache is cold, the card
                    # simply shows no status row rather than a stale one.
                    data = dict(data)
                    plan_data = dict(data.get("plan") or {})
                    plan_data.pop("trajectory", None)
                    # Drop a stored fitness that predates the run lists. An old
                    # payload has the pace values but no current_*_runs, so the
                    # UI would render "no recent runs — goal-based reference
                    # only" even though the runner plainly has recent runs.
                    stored_fitness = plan_data.get("fitness")
                    if stored_fitness is not None and "current_easy_runs" not in stored_fitness:
                        plan_data.pop("fitness", None)
                    data["plan"] = plan_data
                    # Prefer the email-keyed fitness snapshot so every device
                    # reads the SAME activity history (the token-scoped Garmin
                    # cache can be cold on a second device); fall back to it.
                    fitness_source = _get_fitness_snapshot(email) or _get_cached_garmin_data(token)
                    if fitness_source:
                        # Fitness/trajectory read a LONGER window than the plan
                        # prompt's 2 weeks, so the endurance verdict rests on
                        # several long runs rather than the last couple.
                        check_history, _ = _history_from_garmin_cache(
                            fitness_source, days=FITNESS_WINDOW_DAYS)
                        # Days to race drives the phase-aware verdict wording
                        days_left = None
                        if race_date_str:
                            try:
                                days_left = (_dt.strptime(race_date_str, "%Y-%m-%d").date()
                                             - date.today()).days
                            except (ValueError, TypeError):
                                days_left = None
                        trajectory = _build_trajectory(
                            check_history, goal_pace_ms,
                            cached_plan=plan_data, days_to_race=days_left,
                            race_distance_km=_race_distance_km(race_goal),
                        )
                        fitness = _fitness_summary(check_history, goal_pace_ms)
                        if trajectory or fitness:
                            data["plan"] = dict(data["plan"])
                            if trajectory:
                                data["plan"]["trajectory"] = trajectory
                            if fitness:
                                data["plan"]["fitness"] = fitness
                    # A plan cached before the calendar could page back would
                    # otherwise keep serving the old two-week history, so the
                    # stored list is refreshed from the Garmin cache on the way
                    # out. This is a cache read, not a Garmin call.
                    wide = _ui_history_from_cache(_get_cached_garmin_data(token))
                    if wide:
                        data["history"] = [{k: v for k, v in a.items() if k != "laps"}
                                           for a in wide]
                    return JSONResponse(content=data)

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

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

    # The calendar gets its own, wider history — see _ui_history_from_cache for
    # why it is not simply the prompt's window. Falls back to the prompt window
    # when the Garmin cache was cold and we fetched from the API instead.
    ui_history = _ui_history_from_cache(cached_garmin) or history

    # The fitness/trajectory read wants a longer window than the plan prompt's
    # 2 weeks. Prefer the cached window; fall back to the plan history when the
    # Garmin cache is cold.
    # Prefer the email-keyed fitness snapshot so every device reads the same
    # history; fall back to this session's Garmin cache, then to the plan
    # history (which is fetched fresh when both caches are cold).
    fitness_source = _get_fitness_snapshot(email) or cached_garmin
    fitness_history = None
    if fitness_source:
        fitness_history, _ = _history_from_garmin_cache(fitness_source, days=FITNESS_WINDOW_DAYS)
    if not fitness_history:
        fitness_history = history

    # Derive per-workout-type pace targets from recent fitness + goal pace.
    # The runner's latest race result is the fallback fitness anchor, used
    # only when a category has no recent runs — live Garmin data wins.
    fitness_anchor = _race_result_paces(race_goal)
    pace_zones = _compute_pace_zones(goal_pace_ms, history, fitness_anchor=fitness_anchor)

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
        # Both the reported and the computed weekly mileage go in — see
        # _mileage_prompt_lines. Note this is prompt context only: the reported
        # figure stays in the plan cache key (current_prefs), so the cached
        # block does not churn every time the computed figure moves.
        mileage_lines = _mileage_prompt_lines(
            race_goal,
            (cached_garmin or {}).get("weekly_mileage"),
            history,
        )
        race_goal_text = (
            f"RACE GOAL: {race_goal.get('purpose', 'N/A')} in "
            f"{race_goal.get('time_target', 'N/A')} on {race_goal.get('race_date', 'N/A')}.\n"
            + "\n".join(mileage_lines)
        )

    # Race course context — the uploaded GPX summary, when there is one. This
    # is advisory: it sharpens hill and late-race advice but never changes the
    # goal time or the pace zones.
    course_text = _course_prompt_block(
        _get_persistent_course(email),
        _training_gain_per_km(history),
    )

    # --- Race phase detection ---
    # Determine which training phase the runner is in based on days remaining
    # to race day. The phases follow standard periodization:
    #   build (6+ weeks):  easy volume, controlled quality
    #   specificity (3-6 weeks / 21-42 days):  race-pace work, long runs peak
    #   sharpen (7-20 days):  volume down 20-30%, one short race-pace session
    #   taper (race week, <7 days):  volume down 40-60%, mostly easy, arrive fresh
    race_phase = None
    days_to_race = None
    if race_date_str:
        try:
            race_date = _dt.strptime(race_date_str, "%Y-%m-%d").date()
            days_to_race = (race_date - date.today()).days
            if days_to_race < 0:
                race_phase = "post_race"
            elif days_to_race < 7:
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
            "- No new fitness gains expected — maintain what you have.\n"
            "- Tapering starts only in race week (the final 7 days) — this week still trains."
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

    # Quality (hard) days per week — computed, not left to the model to
    # invent. At least one hard day is always scheduled (even for an easy
    # preference); hard intensity gets two; moderate gets a second once the
    # week has 4+ workout days. Capped so the long run always fits.
    if intensity == "hard":
        quality_days = 2
    elif intensity == "moderate" and days_per_week >= 4:
        quality_days = 2
    else:
        quality_days = 1
    quality_days = min(quality_days, max(1, days_per_week - 1))

    mix_guide = (
        f"{quality_days} quality day(s) (tempo or intervals), one long run (LSD), "
        f"and the remaining workout days easy or recovery"
    )

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
            f"- {quality_days} quality day(s) this week — at least one hard day is always scheduled.\n"
            "- Long run pace sits 10-15% slower than goal race pace.\n"
            "- Quality sessions are controlled — not all-out."
        ),
        "moderate": (
            "INTENSITY: MODERATE\n"
            f"- {quality_days} quality day(s) this week.\n"
            "- Long run pace can sit 5-10% slower than goal race pace.\n"
            "- Quality sessions are purposeful but not maximal."
        ),
        "hard": (
            "INTENSITY: HARD\n"
            f"- {quality_days} quality days this week.\n"
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

        # Distance-aware block parameters: the LSD cap and race-day distance
        # come from the typed goal, so a half-marathon block never asks for
        # 30 km longs or a 42.2 km race workout.
        race_distance_km = _race_distance_km(race_goal)
        peak_long_km = PEAK_LONG_KM.get(race_distance_km, 24.0)

        # Whether the plan actually reaches race day — a block capped at
        # MAX_PLAN_DAYS ends mid-season with no race week, so the pre-taper
        # sharpen override must not apply there.
        reaches_race = plan_end >= race_date

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
        # ramp ~10% per week from the runner's real LSD baseline up to the
        # distance-aware cap, then cut for sharpen/taper; the phase text +
        # honesty rules keep each week coherent.
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
                "race-pace work: goal-pace blocks in specificity, short race-pace touches in "
                "sharpen, brief strides in taper. Never use it for easy, recovery, or long-run "
                "volume pacing."
            )

        next_monday = plan_start + timedelta(days=(7 - plan_start.weekday()) % 7)
        phase_counts = {}
        total_chunks = len(windows)
        # (window, chunk_days_count, phase_text, progression_text, targets_text,
        #  week_position_text, window_structure_text)
        week_plan = []
        for week_idx, (w_start, w_end) in enumerate(windows):
            chunk_days_count = (w_end - w_start).days + 1
            # Paces ramp linearly across the block: current fitness at week 1
            # → goal-derived paces by race week. Each chunk gets its own zone
            # set (prompt + steps), so training paces progress toward the goal.
            ramp_fraction = week_idx / (total_chunks - 1) if total_chunks > 1 else 0.0
            chunk_zones = _compute_pace_zones(
                goal_pace_ms, history, fitness_anchor=fitness_anchor, ramp_fraction=ramp_fraction
            )
            # Window shape: gap days (the tail of the current week before the
            # first full Monday) get at most 1-2 easy runs; full weeks get
            # days_per_week; partial weeks scale proportionally. The AI sees
            # this as explicit context instead of mechanical enforcement.
            gap_days_count = max(0, min(chunk_days_count, (next_monday - w_start).days))
            if gap_days_count > 0 and chunk_days_count > gap_days_count:
                gap_sunday = w_start + timedelta(days=gap_days_count - 1)
                remaining = chunk_days_count - gap_days_count
                if remaining == 7:
                    remaining_text = (
                        f"The remaining 7 days form a full Mon-Sun training week with exactly "
                        f"{days_per_week} workout days; the rest are rest days."
                    )
                else:
                    # A merged pre-taper chunk can leave a "remaining" span
                    # that is not a full week — scale the quota to it.
                    remaining_target = min(days_per_week, max(1, (remaining * days_per_week + 6) // 7))
                    remaining_text = (
                        f"The remaining {remaining} days are the start of the next training week: "
                        f"at most {remaining_target} workout days."
                    )
                window_structure_text = (
                    f"Monday starts a new training block, but this window begins mid-week: the "
                    f"first {gap_days_count} days (through {gap_sunday.isoformat()}) are the tail "
                    f"of the current week — at most 1-2 easy or recovery runs there, never a long "
                    f"run or hard session. {remaining_text}"
                )
            elif chunk_days_count == 7:
                # The final chunk is the 7 days before race day, which may
                # cross the Mon-Sun boundary for a non-Sunday race.
                week_label = "Mon-Sun training week" if w_start.weekday() == 0 else "7-day window"
                window_structure_text = (
                    f"This is a full {week_label}: exactly {days_per_week} workout days; "
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
            # long block moves build -> specificity -> sharpen -> taper. The
            # race week itself is always taper; the week right before it is
            # always sharpen (never taper, even for a Monday/Tuesday race) —
            # but only when the plan actually reaches the race (a block
            # capped at MAX_PLAN_DAYS ends mid-season with no race week).
            days_left = (race_date - w_end).days
            race_day_chunk = w_end >= race_date
            if race_day_chunk:
                chunk_phase = "taper"
            elif reaches_race and week_idx == len(windows) - 2:
                chunk_phase = "sharpen"
            else:
                chunk_phase = _phase_for_days_left(days_left)
            phase_counts[chunk_phase] = phase_counts.get(chunk_phase, 0) + 1
            phase_text_chunk = phase_instructions.get(chunk_phase, "").format(days=days_left) if chunk_phase else ""
            progression_text = _progression_guide(chunk_phase, None, race_day_chunk, peak_long_km, race_distance_km)
            if race_day_chunk:
                progression_text += (
                    f"\n- The Race workout on the final day counts as one of the {days_per_week} "
                    f"sessions — do not add sessions to make up the count."
                )
            if race_day_chunk:
                targets_text = ("THIS WEEK'S PROGRESSION TARGETS: race week — no long run; the Race "
                                "workout on race day is the session. Keep everything else short and easy.")
            else:
                if chunk_phase in ("build", "specificity"):
                    # Ramp ~10% per week from the runner's real LSD baseline,
                    # capped at this goal's peak — no jumps, and no ramp at
                    # all once the runner is already at the cap.
                    block_idx = phase_counts.get("build", 0) + phase_counts.get("specificity", 0)
                    long_km = min(peak_long_km, round(base_long_km * (1.1 ** block_idx), 1))
                elif chunk_phase == "sharpen":
                    long_km = round(0.7 * peak_long_km, 1)
                else:  # taper
                    long_km = round(0.5 * peak_long_km, 1)
                targets_text = (
                    "THIS WEEK'S PROGRESSION TARGETS (computed from your recent training — follow them):\n"
                    f"- Long run: about {long_km:g} km.\n"
                    f"- Recent weekly volume: about {base_weekly_km:g} km — scale this week to the phase guidance."
                )
            week_position_text = f"This is week {week_idx + 1} of {len(windows)} of the training block."
            week_plan.append((w_start, w_end, chunk_days_count, phase_text_chunk, progression_text,
                              targets_text, week_position_text, window_structure_text, chunk_zones))

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
        w_start, w_end, chunk_days_count, phase_text_chunk, progression_text, targets_text, week_position_text, window_structure_text, chunk_zones = entry
        prompt = _build_chunk_prompt(
            w_start, w_end, chunk_days_count, race_goal_text, course_text, phase_text_chunk,
            progression_text, week_position_text, window_structure_text, coach_insight_text,
            intensity_text, days_per_week, mix_guide, distance_guide, physio_text, chunk_zones,
            history, targets_text, goal_pace_text, _honesty_rules(peak_long_km),
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
        _attach_workout_details(chunk_days, chunk_zones)

        plan = {
            "week_start": plan_start.isoformat(),
            "plan_start": plan_start.isoformat(),
            "plan_end": plan_end.isoformat(),
            "total_plan_days": total_plan_days,
            "race_date": race_date_str,
            "race_phase": race_phase or "build",
            "days_to_race": days_to_race,
            "pace_zones": chunk_zones,
            "zones": chunk_zones,
            "preferences": {
                "days_per_week": days_per_week,
                "intensity": intensity,
                "distance_adj": distance_adj,
                "weekly_distance_km": weekly_distance_km,
            },
            "days": chunk_days,
        }

        # Trajectory note + fitness summary: current fitness vs the goal
        # (and vs the ramp at today's position on cache hits). Attached per
        # chunk — the frontend takes them from the first response.
        trajectory = _build_trajectory(fitness_history, goal_pace_ms, days_to_race=days_to_race,
                                       race_distance_km=_race_distance_km(race_goal))
        if trajectory:
            plan["trajectory"] = trajectory
        fitness_summary = _fitness_summary(fitness_history, goal_pace_ms)
        if fitness_summary:
            plan["fitness"] = fitness_summary

# The calendar pages through ui_history (the whole cache), not the
        # prompt's two-week window.
        slim_history = [{k: v for k, v in a.items() if k != "laps"} for a in ui_history]
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
            # The trajectory verdict is transient — it reflects CURRENT
            # fitness and is recomputed on every read (warm Garmin cache),
            # so it must never be persisted with the plan. Storing it would
            # serve stale advice (e.g. an old "ahead" verdict) from cache.
            merged_plan = dict(merged.get("plan") or {})
            merged_plan.pop("trajectory", None)
            cache_data = dict(merged)
            cache_data["plan"] = merged_plan
            _save_persistent_coach_cache(
                email, cache_data,
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
  Speedwork), "title", "description" (1-2 sentences on intent), "intensity" (easy, moderate, or
  hard), and "segments" — the exact session structure (see below).
- "segments" is an ordered list of the session's parts. Each segment has:
    - "role": "warmup" | "main" | "recovery" | "cooldown"
    - "effort": "easy" | "recovery" | "long_run" | "tempo" | "intervals" | "speed" | "goal_pace"
    - exactly one of "distance_km" (number) or "duration_min" (number) — that segment's length
    - "reps" (integer, optional — only for interval reps; the segment length is ONE rep)
    - "recovery" (optional object, only when "reps" > 1): the rest between reps, with "distance_km"
      or "duration_min" and "effort": "recovery"
  Examples: a tempo tune-up is [warmup easy 2 km, main goal_pace 1.5 km, cooldown easy 2 km];
  intervals are [warmup easy 2 km, main intervals 0.4 km reps 6 with recovery 2 min, cooldown easy 1 km].
- The segments ARE the session — their lengths sum to the session total, so do NOT also declare a
  separate "distance_km"/"duration_min" total (the totals are computed from the segments).
- Do NOT set "target_pace_min_per_km" — each segment's pace is assigned automatically from its
  "effort" using the target pace zones below. Do NOT set "insight" — it is generated on demand when
  the runner opens the workout, so leave it out.
- Scale segment lengths to the runner's recent training load, the weekly distance target, and the
  race phase (sharpen and taper phases must reduce volume).

TARGET PACE ZONES (computed from the runner's recent fitness + race goal — the "effort" you pick for
each segment maps to one of these zones; the numeric pace is set automatically):
{json.dumps(pace_zones, indent=2)}

EFFORT → ZONE: "easy"→Easy, "recovery"→Recovery, "long_run"→Long Run, "tempo"→Tempo,
"intervals"→Intervals, "speed"→Speedwork, "goal_pace"→Race (the race goal pace).

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
    # The calendar pages through ui_history (the whole cache), not the
    # prompt's two-week window.
    slim_history = [{k: v for k, v in a.items() if k != "laps"} for a in ui_history]

    response_data = {"history": slim_history, "plan": plan}

    # Save to the persistent email-keyed cache so the same plan appears on
    # other devices. Store the plan_start, race_date, and preferences for
    # invalidation. The trajectory verdict is never persisted — it is
    # transient (recomputed on reads) and must not go stale in the cache.
    if email:
        cache_plan = dict(plan)
        cache_plan.pop("trajectory", None)
        cache_data = {"history": slim_history, "plan": cache_plan}
        _save_persistent_coach_cache(
            email, cache_data,
            week_start=plan_start.isoformat(),
            preferences=current_prefs,
            race_date=race_date_str or "",
        )

    return JSONResponse(content=response_data)
