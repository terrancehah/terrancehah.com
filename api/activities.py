"""GET /api/activities — Fetch recent running activities from Garmin,
and (mode=mileage) running activities grouped by week.
POST /api/activities — Write the coach's read on one completed run.

The weekly-mileage endpoint was merged here so both Garmin-data readers
share one serverless function; mode=mileage serves the weekly buckets.
The per-run insight lives here too, beside the list it is asked from.
"""

from fastapi.responses import JSONResponse
from datetime import datetime, date, timedelta
from typing import Optional
from pydantic import BaseModel
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import (
    _get_garmin_client, _get_session, _get_cached_garmin_data,
    _slim_activity, _compute_goal_pace_ms, ALLOWED_ACTIVITY_TYPES, RUNNING_TYPES, create_app,
    _call_ai, _fetch_lap_summaries, _format_finish_time, _format_pace_per_km,
    _get_activity_insight, _save_activity_insight,
    _get_race_history, _race_distance_km, _goal_target_seconds, _parse_float,
    _activity_insight_context_key,
)

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/activities so routes at "/" match)
app = create_app("activities")


@app.get("/")
async def activities(token: str = "", limit: int = 10, offset: int = 0, mode: str = "activities", weeks: int = 12):
    """Fetch recent activities (default) or weekly mileage (mode=mileage).

    Supports pagination via the offset parameter. The Garmin API's
    get_activities(start, limit) uses 0-based indexing, so offset maps
    directly to the start parameter. We fetch more than requested to
    account for non-running activities that get filtered out.
    """
    # Weekly-mileage mode (merged from weekly-mileage.py) — grouped buckets
    # served from the Redis bundle when available, else a Garmin fetch.
    if mode == "mileage":
        cached = _get_cached_garmin_data(token)
        if cached and cached.get("weekly_mileage"):
            return JSONResponse(content={"weeks": cached["weekly_mileage"]})

        client = _get_garmin_client(token)
        today = date.today()
        start_date = today - timedelta(days=today.weekday() + (weeks - 1) * 7)
        start_str = start_date.isoformat()
        end_str = today.isoformat()
        try:
            # No activitytype filter — see _compute_weekly_mileage in
            # lib/_shared.py. Garmin's semantics for it are ambiguous and it was
            # dropping treadmill runs from this chart; filtering on typeKey
            # below keeps this in step with the activities list.
            mileage_activities = client.get_activities_by_date(start_str, end_str)
        except Exception as e:
            return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

        week_buckets = {}
        for i in range(weeks):
            week_start = start_date + timedelta(days=i * 7)
            week_buckets[week_start.isoformat()] = {
                "week_start": week_start.isoformat(),
                "mileage_km": 0.0,
                "run_count": 0,
            }
        for a in mileage_activities:
            # Only runs count toward running mileage — the typeKey check is the
            # source of truth now that Garmin is no longer filtering for us.
            type_key = ((a.get("activityType") or {}).get("typeKey") or "").lower()
            if type_key not in RUNNING_TYPES:
                continue
            start_time = a.get("startTimeLocal") or a.get("startTimeGMT") or ""
            try:
                act_dt = datetime.strptime(start_time[:19], "%Y-%m-%d %H:%M:%S")
            except (ValueError, IndexError):
                continue
            act_monday = act_dt - timedelta(days=act_dt.weekday())
            key = act_monday.date().isoformat()
            if key in week_buckets:
                week_buckets[key]["mileage_km"] += a.get("distance", 0) / 1000
                week_buckets[key]["run_count"] += 1

        result = []
        for key in sorted(week_buckets.keys()):
            bucket = week_buckets[key]
            result.append({
                "week_start": bucket["week_start"],
                "mileage_km": round(bucket["mileage_km"], 1),
                "run_count": bucket["run_count"],
            })
        return JSONResponse(content={"weeks": result})

    # Serve the first page from the Redis bundle populated by /metrics —
    # zero logins / Garmin calls on the common path. Pagination (offset > 0)
    # always goes to Garmin since the cache only holds the first batch.
    # The cache is pre-filtered to ALLOWED_ACTIVITY_TYPES by metrics.py.
    if offset == 0:
        cached = _get_cached_garmin_data(token)
        if cached and cached.get("ui_activities"):
            return JSONResponse(content={"activities": cached["ui_activities"][:limit]})

    client = _get_garmin_client(token)
    # Over-fetch to compensate for excluded activities that get filtered out.
    fetch_limit = max(limit * 3, 30) if offset == 0 else limit * 3
    try:
        activities = client.get_activities(offset, fetch_limit)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    # Filter to allowed activity types (running + cross-training) and convert
    # to slim format. _slim_activity handles both running (pace-based tag) and
    # non-running (type-based tag) activities.
    sess = _get_session(token)
    goal_pace_ms = _compute_goal_pace_ms(sess.get("race_goal"))
    slim = []
    for a in activities:
        type_key = a.get("activityType", {}).get("typeKey", "unknown")
        if type_key.lower() not in ALLOWED_ACTIVITY_TYPES:
            continue
        slim.append(_slim_activity(a, goal_pace_ms))
    # Trim to the requested limit after filtering
    slim = slim[:limit]
    return JSONResponse(content={"activities": slim})


# Tolerance for calling a run "the race" by date and distance alone — mirrors
# the frontend's findRaceActivity (RACE_DISTANCE_TOLERANCE). Deliberately tight:
# a same-day run that misses the goal distance by more than 5% stays a training
# run rather than a misattributed result.
RACE_DISTANCE_TOLERANCE = 0.05


def _resolve_insight_context(email: str, race_goal, activity: dict) -> dict:
    """Decide what a completed run was, in the runner's own terms.

    Returns {"kind", "goal", "result"}:

    - "linked_race" — the run is the explicitly saved result of the current
      goal, or of a goal since filed to history. Linked wins over inferred:
      the runner's own statement beats any date/distance guess, and it
      survives the goal being archived because the whole goal travels with
      its result.
    - "matched_race" — the run matches the current goal's race date, is a
      running activity, and lands within the distance tolerance, but was
      never linked. Never reached when the current goal already carries a
      DIFFERENT explicit result: the runner already said which run was the
      race, so a similar-looking run stays training.
    - "training" — everything else. The current goal is still returned so the
      prompt can frame the session against it.

    IDs compare as strings and never match when either side is missing.
    """
    activity_id = activity.get("id")
    goal = race_goal if isinstance(race_goal, dict) else None
    current_result = (goal or {}).get("race_result")

    def _is_result_of(result) -> bool:
        rid = result.get("activity_id") if isinstance(result, dict) else None
        return activity_id is not None and rid is not None and str(rid) == str(activity_id)

    if _is_result_of(current_result):
        return {"kind": "linked_race", "goal": goal, "result": current_result}

    # History is stored oldest first, so walk it newest first — a re-run of
    # the same race resolves to the most recent account of it.
    for archived in reversed(_get_race_history(email)):
        if not isinstance(archived, dict):
            continue
        result = archived.get("race_result")
        if _is_result_of(result):
            return {"kind": "linked_race", "goal": archived, "result": result}

    # An explicit result on the current goal — whatever it is — blocks the
    # heuristic: the runner already named their race run.
    if goal and not isinstance(current_result, dict):
        race_day = str(goal.get("race_date") or "")[:10]
        act_day = str(activity.get("start_time") or "")[:10]
        goal_km = _race_distance_km(goal)
        act_km = _parse_float(activity.get("distance")) or 0
        type_key = str(activity.get("type") or "").lower()
        if (race_day and act_day == race_day and type_key in RUNNING_TYPES
                and goal_km > 0
                and abs(act_km - goal_km) <= goal_km * RACE_DISTANCE_TOLERANCE):
            # The inferred result is rebuilt from the slim activity in the same
            # field names the saved shape uses, so both kinds of race context
            # feed the prompt and fingerprint identically.
            result = {
                "activity_id": activity_id,
                "date": act_day,
                "distance_km": act_km,
                "duration_min": _parse_float(activity.get("duration")) or 0,
                "avg_pace_ms": _parse_float(activity.get("avg_pace")) or 0,
                "avg_hr": activity.get("avg_hr"),
                "elevation_gain": activity.get("elevation_gain") or 0,
            }
            return {"kind": "matched_race", "goal": goal, "result": result}

    return {"kind": "training", "goal": goal, "result": None}


class ActivityInsightRequest(BaseModel):
    token: str = ""
    # One completed run, in the activities list's slim shape. The figures come
    # from the client because it already holds them; the laps are fetched here.
    activity: Optional[dict] = None


@app.post("/")
async def activity_insight(body: ActivityInsightRequest):
    """Write — or return the already written — coach's read on one run.

    The figures arrive from the client (the list already holds them); the laps
    are fetched here, because the list does not carry them and they are what
    make a session legible — a blended average hides the reps entirely.

    Cached per activity and per account — but keyed to the context the read
    was written against, because a finished run's numbers never change while
    its meaning can: a training read and the read on "the race" are different
    paragraphs for the same run. A stored read is served only when the
    resolved context still matches; otherwise the run is re-read.
    """
    sess = _get_session(body.token)
    email = sess.get("email", "") if isinstance(sess, dict) else ""
    race_goal = sess.get("race_goal") if isinstance(sess, dict) else None
    activity = body.activity or {}
    activity_id = activity.get("id")
    if not activity_id:
        return JSONResponse(status_code=400, content={"error": "Activity required."})

    # Resolve the run's context first: the cache check and the prompt both
    # depend on whether this run was the goal race, an apparent race-day
    # match, or a training session.
    context = _resolve_insight_context(email, race_goal, activity)
    context_kind = context["kind"]
    context_goal = context["goal"]
    context_result = context["result"]
    # "" for training — there is nothing to fingerprint — so the stored key
    # names the context instead.
    context_key = _activity_insight_context_key(context_goal, context_result) or "training"

    cached = _get_activity_insight(email, activity_id)
    if cached and cached.get("text"):
        cached_kind = cached.get("context_kind")
        if context_kind == "training":
            # A stored race read must never survive losing its race context —
            # serving it would have the coach talking about the wrong story.
            # Legacy entries (no kind) and training reads stay valid across
            # goal changes: the run did not change because the target did.
            if cached_kind in (None, "training"):
                return JSONResponse(content={"insight": cached["text"], "cached": True})
        elif cached_kind in ("linked_race", "matched_race") \
                and cached.get("context_key") == context_key:
            # The fingerprint is kind-independent, so a read written before
            # the race was linked, or before the goal was archived, still
            # counts — only an edited goal or corrected result misses here.
            # Legacy entries have no key and regenerate once.
            return JSONResponse(content={"insight": cached["text"], "cached": True})

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    is_race = context_kind in ("linked_race", "matched_race")
    goal_pace_ms = _compute_goal_pace_ms(context_goal)

    # Best-effort: a run with no splits still gets a read, just a flatter one.
    laps = None
    try:
        client = _get_garmin_client(body.token)
        laps = _fetch_lap_summaries(client, activity_id, goal_pace_ms)
    except Exception as e:
        print(f"activity-insight lap fetch failed: {e}")

    lines = [
        "The runner has finished a run. Write the coach's read on it.",
        "",
        "THE COMPLETED GOAL RACE:" if is_race else "THE RACE THEY ARE TRAINING FOR:",
    ]
    if context_goal:
        lines.append(f"- Race: {context_goal.get('race_name') or context_goal.get('purpose') or 'their goal race'}.")
        if context_goal.get("distance"):
            lines.append(f"- Distance: {context_goal['distance']} {context_goal.get('distance_unit') or 'km'}.")
        if context_goal.get("time_target"):
            lines.append(f"- Target time: {context_goal['time_target']}.")
        if context_goal.get("race_date"):
            lines.append(f"- Race date: {context_goal['race_date']}.")
    else:
        lines.append("- No race goal set yet.")
    if goal_pace_ms > 0:
        lines.append(f"- Goal pace: {_format_pace_per_km(goal_pace_ms)} per km.")

    if is_race and context_result:
        # The race is finished business: the recorded figures are stated up
        # front so the read compares a real result with the target instead of
        # framing the run as preparation for a future race.
        finish_time = _format_finish_time(context_result.get("duration_min"))
        lines.append(f"- Recorded finish time: {finish_time or 'not recorded'}.")
        if not (context_goal and context_goal.get("time_target")):
            lines.append("- Target time: none set.")
        target_sec = _goal_target_seconds(context_goal)
        finish_sec = int(round((_parse_float(context_result.get("duration_min")) or 0) * 60))
        if target_sec > 0 and finish_sec > 0:
            delta = finish_sec - target_sec
            if delta < 0:
                outcome = f"Target achieved, {-delta} seconds under target."
            elif delta == 0:
                outcome = "Target achieved, exactly on target."
            else:
                outcome = f"Finished {delta} seconds over target."
        else:
            outcome = "No comparable target time."
        lines.append(f"- Outcome: {outcome}")

    lines += ["", "THE RUN THEY JUST DID:"]
    # Say plainly which story the coach is reading, before the figures — the
    # same numbers mean something different as a race than as a training run.
    if context_kind == "linked_race":
        lines.append("This activity is the saved result of this goal race. Review the completed race, not preparation for a future race.")
    elif context_kind == "matched_race":
        lines.append("This activity matches the current goal race date and distance, but has not been explicitly linked. Treat it as an apparent race result and acknowledge that association briefly without claiming confirmation.")
    else:
        lines.append("This activity has not been identified as the goal race. Review the session without claiming it was a race.")

    lines.append(f"- Name: {activity.get('name') or 'Run'}.")
    if activity.get("start_time"):
        lines.append(f"- Date: {str(activity['start_time'])[:10]}.")
    # A generic activity tag would tell the coach a race run was 'tempo', so
    # race contexts drop it — the context line above is the classification.
    if not is_race and activity.get("run_tag"):
        lines.append(f"- Classified as: {activity['run_tag']}.")
    # On a race the saved/matched result's figures win over the activity
    # summary — the runner's own record is authoritative, and it is allowed to
    # disagree with moving-time averages.
    shown_distance = (context_result or {}).get("distance_km") if is_race else activity.get("distance")
    shown_duration = (context_result or {}).get("duration_min") if is_race else activity.get("duration")
    shown_pace = (context_result or {}).get("avg_pace_ms") if is_race else activity.get("avg_pace")
    shown_hr = (context_result or {}).get("avg_hr") if is_race else activity.get("avg_hr")
    shown_elevation = (context_result or {}).get("elevation_gain") if is_race else activity.get("elevation_gain")
    if shown_distance:
        lines.append(f"- Distance: {shown_distance} km.")
    if shown_duration:
        lines.append(
            f"- {'Duration' if is_race else 'Moving time'}: {_format_finish_time(shown_duration)}."
        )
    if shown_pace:
        lines.append(f"- Average pace: {_format_pace_per_km(shown_pace)} per km.")
    if shown_hr:
        lines.append(f"- Average heart rate: {shown_hr} bpm.")
    if activity.get("max_hr"):
        lines.append(f"- Max heart rate: {activity['max_hr']} bpm.")
    if activity.get("avg_cadence"):
        lines.append(f"- Average cadence: {round(activity['avg_cadence'])} spm.")
    if shown_elevation:
        lines.append(f"- Elevation gain: {shown_elevation} m.")
    if activity.get("training_effect"):
        lines.append(f"- Aerobic training effect: {activity['training_effect']}.")

    if laps and laps.get("laps"):
        # Individual laps only — aggregating them into work/rest buckets would
        # assert a rest structure the watch never recorded (see the prompt
        # rules below), so the raw splits are what the coach reads.
        lines += ["", "LAPS (the session's real structure — the average above hides it):"]
        for i, lap in enumerate(laps["laps"][:12], 1):
            lap_pace = _format_pace_per_km(lap.get("avg_pace_ms")) or "n/a"
            bits = [f"{round((lap.get('distance_m') or 0) / 1000, 2)} km at {lap_pace}/km"]
            if lap.get("avg_hr"):
                bits.append(f"avg HR {lap['avg_hr']}")
            lines.append(f"  Lap {i}: " + ", ".join(bits) + ".")

    lines += [
        "",
        "Write ONE paragraph of 3-5 sentences, in the coach's voice:",
        "- Open with what this session was and how it went, in plain words.",
    ]
    if is_race:
        lines.append(
            "- Explain how the recorded finish compares with the target. This race has already "
            "happened: never predict whether they will achieve this same target on race day, and "
            "do not call it a tempo training run because of a generic activity tag."
        )
    else:
        lines.append("- Then say what it brings to the race goal — how it moves them toward the target time.")
    lines += [
        "- Close on one number worth noticing: either a strength this run shows, or something to "
        "watch next. Pick whichever matters more and say what it means.",
        "",
        "STYLE:",
        "- Write like a coach talking to the runner afterwards, not a training report.",
        "- Plain runner words. No jargon — no 'threshold', 'VO₂max', 'lactate', 'aerobic', 'cadence drift'.",
        "- Cite real numbers from the session above and never invent data. At most one number per sentence.",
        "- Judge the numbers against the race goal and its goal pace, not against population averages.",
        "- If there are no laps, work from the summary figures and say nothing about splits.",
        "- Do not mention missing data, and do not comment on the absence of a race goal.",
        "- Slower laps do not prove rest, recovery, stops, or resets. Do not describe those unless explicitly recorded; describe pace variation instead.",
        "- Do not call heart rate high, low, unsafe, or unusually hard from an absolute bpm number alone. Without personal heart-rate zones or a reliable personal baseline, report the value without judging its intensity.",
        "",
        'Return JSON: {"insight": "<the paragraph>"}',
    ]

    try:
        parsed = await _call_ai("\n".join(lines), api_key)
        insight = (parsed.get("insight") or "").strip()
    except Exception as e:
        print(f"activity-insight failed: {e}")
        insight = ""
    if not insight:
        return JSONResponse(status_code=500, content={"error": "Could not write the insight."})

    _save_activity_insight(
        email, activity_id, insight,
        context_kind=context_kind,
        context_key=context_key,
        context={"goal": context_goal, "result": context_result},
    )
    return JSONResponse(content={"insight": insight, "cached": False})
