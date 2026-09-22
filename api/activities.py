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

    Cached per activity and per account, so a run is analysed once and then
    served instantly on any device. A finished run never changes, so the cache
    needs no invalidation.
    """
    sess = _get_session(body.token)
    email = sess.get("email", "") if isinstance(sess, dict) else ""
    race_goal = sess.get("race_goal") if isinstance(sess, dict) else None
    activity = body.activity or {}
    activity_id = activity.get("id")
    if not activity_id:
        return JSONResponse(status_code=400, content={"error": "Activity required."})

    cached = _get_activity_insight(email, activity_id)
    if cached and cached.get("text"):
        return JSONResponse(content={"insight": cached["text"], "cached": True})

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    goal_pace_ms = _compute_goal_pace_ms(race_goal)

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
        "THE RACE THEY ARE TRAINING FOR:",
    ]
    if race_goal:
        lines.append(f"- Race: {race_goal.get('race_name') or race_goal.get('purpose') or 'their goal race'}.")
        if race_goal.get("distance"):
            lines.append(f"- Distance: {race_goal['distance']} {race_goal.get('distance_unit') or 'km'}.")
        if race_goal.get("time_target"):
            lines.append(f"- Target time: {race_goal['time_target']}.")
        if race_goal.get("race_date"):
            lines.append(f"- Race date: {race_goal['race_date']}.")
    else:
        lines.append("- No race goal set yet.")
    if goal_pace_ms > 0:
        lines.append(f"- Goal pace: {_format_pace_per_km(goal_pace_ms)} per km.")

    lines += ["", "THE RUN THEY JUST DID:"]
    lines.append(f"- Name: {activity.get('name') or 'Run'}.")
    if activity.get("start_time"):
        lines.append(f"- Date: {str(activity['start_time'])[:10]}.")
    if activity.get("run_tag"):
        lines.append(f"- Classified as: {activity['run_tag']}.")
    if activity.get("distance"):
        lines.append(f"- Distance: {activity['distance']} km.")
    if activity.get("duration"):
        lines.append(f"- Moving time: {_format_finish_time(activity['duration'])}.")
    if activity.get("avg_pace"):
        lines.append(f"- Average pace: {_format_pace_per_km(activity['avg_pace'])} per km.")
    if activity.get("avg_hr"):
        lines.append(f"- Average heart rate: {activity['avg_hr']} bpm.")
    if activity.get("max_hr"):
        lines.append(f"- Max heart rate: {activity['max_hr']} bpm.")
    if activity.get("avg_cadence"):
        lines.append(f"- Average cadence: {round(activity['avg_cadence'])} spm.")
    if activity.get("elevation_gain"):
        lines.append(f"- Elevation gain: {activity['elevation_gain']} m.")
    if activity.get("training_effect"):
        lines.append(f"- Aerobic training effect: {activity['training_effect']}.")

    if laps and laps.get("laps"):
        lines += ["", "LAPS (the session's real structure — the average above hides it):"]
        if laps.get("work_lap_count"):
            work_pace = _format_pace_per_km(laps["work_avg_pace_ms"]) or "n/a"
            lines.append(f"- {laps['work_lap_count']} laps at or faster than goal pace, averaging {work_pace} per km.")
        if laps.get("rest_lap_count"):
            rest_pace = _format_pace_per_km(laps["rest_avg_pace_ms"]) or "n/a"
            lines.append(f"- {laps['rest_lap_count']} slower or recovery laps, averaging {rest_pace} per km.")
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
        "- Then say what it brings to the race goal — how it moves them toward the target time.",
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

    _save_activity_insight(email, activity_id, insight)
    return JSONResponse(content={"insight": insight, "cached": False})
