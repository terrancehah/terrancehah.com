"""Shared module for all race-goal API endpoints.

This file lives in api/lib/ so Vercel doesn't treat it as a serverless
function (only .py files directly in api/ become functions). It contains
the session store (backed by Upstash Redis), Garmin client helpers, and
Pydantic models used across all race-goal endpoint files.

Session storage architecture:
  In Vercel's file-based serverless mode, each api/*.py file is a separate
  function with its own isolated memory and /tmp directory. To share session
  state across functions, we use Upstash Redis as an external store. Only
  serializable data (credentials, race goal, profile info) is stored — the
  live Garmin client object is re-created from credentials on each request
  that needs it (see _get_garmin_client).

  For local development without Redis configured, an in-memory dict fallback
  is used automatically when UPSTASH env vars are not present.
"""

import os
import json
import uuid
from datetime import datetime, date, timedelta
from typing import Dict, Optional
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from garminconnect import (
    Garmin,
    GarminConnectConnectionError,
    GarminConnectAuthenticationError,
    GarminConnectTooManyRequestsError,
)


class _StripPrefixMiddleware:
    """ASGI middleware that strips path prefixes ending with the function name.

    In Vercel file-based mode, the full request path is passed to each
    function's ASGI app. For direct routes this is /api/<function_name>; for
    rewritten routes (e.g. /projects/runassist/api/<function_name>)
    Vercel passes the ORIGINAL pre-rewrite path. Both need to be stripped
    down to "/" so routes defined at @app.get("/") or @app.post("/") match.

    This middleware strips any prefix that ends with /<function_name>,
    handling both direct /api/<name> and rewritten /projects/.../api/<name>
    paths.
    """

    def __init__(self, app, function_name):
        self.app = app
        # The suffix to match: e.g. "/check-session"
        self.suffix = f"/{function_name}"

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            # If the path ends with /<function_name>, strip the entire path
            # down to "/" so routes at @app.get("/") match. This handles both
            # direct /api/<name> and rewritten /projects/.../api/<name> paths
            # since Vercel passes the original pre-rewrite path to the function.
            if path.endswith(self.suffix):
                scope["path"] = "/"
                scope["raw_path"] = b"/"
        await self.app(scope, receive, send)


def create_app(function_name: str) -> FastAPI:
    """Create a FastAPI app configured for Vercel file-based serverless mode.

    Wraps the app with two middlewares (CORS outermost, prefix-stripping inner):
    1. CORSMiddleware — handles cross-origin requests from the frontend.
    2. _StripPrefixMiddleware — strips any path prefix ending with
       /<function_name> so routes defined at "/" match what Vercel sends,
       whether from direct /api/<name> or rewritten /projects/.../api/<name>.

    Args:
        function_name: The filename without .py (e.g. "garmin-auth"). Used to
                       match the suffix to strip from the request path.
    """
    app = FastAPI()

    # Add prefix-stripping first (becomes inner middleware — runs after CORS,
    # before FastAPI's router sees the path).
    app.add_middleware(_StripPrefixMiddleware, function_name=function_name)

    # Add CORS second (becomes outer middleware — handles preflight OPTIONS
    # and injects CORS headers on all responses).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://*.vercel.app",
            "https://terrancehah.com",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return app

# Load environment variables (from .env locally, from Vercel dashboard in production)
load_dotenv()

# --- Pydantic models ---

class GarminAuthRequest(BaseModel):
    email: str
    password: str

class RaceGoalRequest(BaseModel):
    purpose: str
    distance: str
    time_target: str
    race_date: str = ""
    experience: str = ""
    weekly_mileage: str = ""

class AnalysisRequest(BaseModel):
    session_token: str

# --- Redis-backed session store ---
#
# Upstash Redis is used as the shared session store so that all serverless
# functions can read/write session state. The Vercel KV / Upstash integration
# injects env vars — the exact names depend on the integration used and any
# custom prefix configured in the Vercel dashboard. We check all known names:
#   KV_REST_API_URL / KV_REST_API_TOKEN          (Vercel KV integration)
#   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash direct)
#   STORAGE_REDIS_REST_URL / STORAGE_REDIS_REST_TOKEN  (custom STORAGE prefix)
_redis_url = (
    os.getenv("KV_REST_API_URL")
    or os.getenv("UPSTASH_REDIS_REST_URL")
    or os.getenv("STORAGE_REDIS_REST_URL")
)
_redis_token = (
    os.getenv("KV_REST_API_TOKEN")
    or os.getenv("UPSTASH_REDIS_REST_TOKEN")
    or os.getenv("STORAGE_REDIS_REST_TOKEN")
)

# Initialize Redis client if env vars are present (production / preview envs).
# Falls back to None for local dev — _local_sessions dict is used instead.
_redis = None
if _redis_url and _redis_token:
    from upstash_redis import Redis
    _redis = Redis(url=_redis_url, token=_redis_token)

# In-memory fallback for local development when Redis is not configured.
# This is NOT shared across processes — only use for local testing.
_local_sessions: Dict[str, dict] = {}

# Redis key prefix and session TTL (sliding expiration)
SESSION_PREFIX = "race:session:"
SESSION_TTL = 3600 * 12  # 12 hours — refreshed on each successful access


def _save_session(token: str, data: dict, ttl: int = SESSION_TTL):
    """Save a session to Redis (or local fallback).

    Strips the garmin_client field before saving since the Garmin client
    object is not JSON-serializable. The client is lazily re-created from
    stored credentials by _get_garmin_client when needed.
    """
    # Remove any non-serializable fields before persisting
    clean = {k: v for k, v in data.items() if k != "garmin_client"}
    if _redis:
        _redis.set(f"{SESSION_PREFIX}{token}", json.dumps(clean), ex=ttl)
    else:
        _local_sessions[token] = clean


def _get_session(token: str) -> dict:
    """Retrieve a session from Redis (or local fallback).

    Raises HTTPException(401) if the token doesn't exist or has expired.
    Refreshes the TTL on each successful access (sliding expiration) so
    active sessions stay alive while inactive ones expire after 12 hours.
    """
    if _redis:
        raw = _redis.get(f"{SESSION_PREFIX}{token}")
        if not raw:
            raise HTTPException(
                status_code=401,
                detail="Session expired or invalid. Please log in again."
            )
        # upstash-redis may return the value as a string or bytes
        if isinstance(raw, bytes):
            raw = raw.decode()
        sess = json.loads(raw)
        # Sliding expiration — refresh TTL on each successful access
        _redis.expire(f"{SESSION_PREFIX}{token}", SESSION_TTL)
        return sess
    else:
        sess = _local_sessions.get(token)
        if not sess:
            raise HTTPException(
                status_code=401,
                detail="Session expired or invalid. Please log in again."
            )
        return sess


def _update_session(token: str, updates: dict):
    """Merge updates into an existing session and re-save.

    Reads the current session, applies the updates dict, and saves back.
    Used by endpoints like onboarding that modify part of a session
    (e.g. setting race_goal after the session was created by garmin-auth).
    """
    sess = _get_session(token)
    sess.update({k: v for k, v in updates.items() if k != "garmin_client"})
    if _redis:
        _redis.set(f"{SESSION_PREFIX}{token}", json.dumps(sess), ex=SESSION_TTL)
    else:
        _local_sessions[token] = sess


def _delete_session(token: str):
    """Remove a session from Redis (or local fallback)."""
    if _redis:
        _redis.delete(f"{SESSION_PREFIX}{token}")
    else:
        _local_sessions.pop(token, None)


def _session_exists(token: str) -> bool:
    """Check if a session token exists without raising 401.

    Used by check-session which returns a JSON {valid: false} response
    instead of an error when the token is missing.
    """
    if _redis:
        return _redis.exists(f"{SESSION_PREFIX}{token}") > 0
    else:
        return token in _local_sessions


def _get_garmin_client(token: str) -> Garmin:
    """Re-create an authenticated Garmin client from stored session state.

    The Garmin client object cannot be serialized, so it is NOT stored in
    Redis. Sessions store the serialized OAuth token bundle (di_token +
    di_refresh_token) instead of the password; the client is re-created from
    tokens via login(tokenstore=...), which never sends the password and
    auto-refreshes the DI token. This avoids credential logins that trip
    Garmin's login-attempt rate limit.

    Legacy sessions created before token storage still carry a password and
    fall back to credential login for backward compatibility.

    Raises HTTPException(401) if session state is missing or login fails.
    """
    sess = _get_session(token)
    email = sess.get("email", "")
    tokens_json = sess.get("tokens")
    password = sess.get("password", "")  # legacy sessions only

    if not email:
        raise HTTPException(
            status_code=401,
            detail="Garmin session not found. Please log in again."
        )

    try:
        if tokens_json:
            # Token-based re-auth — no password involved. If the tokens are
            # rejected/expired, login() raises and the user re-logs in.
            client = Garmin(email)
            client.login(tokenstore=tokens_json)
            return client
        if password:
            # Legacy session (created before OAuth token storage)
            client = Garmin(email, password)
            client.login()
            return client
        raise HTTPException(
            status_code=401,
            detail="Garmin session has no credentials. Please log in again."
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=401,
            detail="Garmin re-authentication failed. Please log in again."
        )


# --- Garmin data cache (Redis) ---
#
# To avoid hitting Garmin's rate limits when multiple serverless functions
# (metrics.py, ai-radar.py) fire in the same page load, we cache the raw
# Garmin API responses in Redis with a short TTL. metrics.py fetches and
# caches; ai-radar.py reads from cache instead of calling Garmin directly.
#
# This is separate from the session store — session stores auth/user state
# (long-lived, 12h TTL), while this cache stores transient API data
# (short-lived, 5min TTL). Different keys, different lifecycles.

GARMIN_CACHE_PREFIX = "race:garmin-cache:"
# 1 hour — the cache is re-populated on every /metrics dashboard load, so this
# TTL is a safety net that lets ai-radar, /activities and /weekly-mileage reuse
# the fetched bundle instead of calling Garmin again within the hour. Garmin
# data changes on watch sync, not in real time, so an hour of reuse is safe.
GARMIN_CACHE_TTL = 3600  # 1 hour


def _cache_garmin_data(token: str, data: dict):
    """Store fetched Garmin data in Redis so other endpoints can reuse it.

    Used by metrics.py to cache activities + physiological trends so
    ai-radar.py can read them without making its own Garmin API calls.
    Falls back to in-memory dict for local dev without Redis.
    """
    if _redis:
        _redis.set(
            f"{GARMIN_CACHE_PREFIX}{token}",
            json.dumps(data),
            ex=GARMIN_CACHE_TTL,
        )
    else:
        _local_sessions[f"{GARMIN_CACHE_PREFIX}{token}"] = data


def _get_cached_garmin_data(token: str) -> dict | None:
    """Read cached Garmin data from Redis. Returns None on miss.

    Does NOT raise on cache miss — callers should fall back to fetching
    directly from Garmin when this returns None.
    """
    if _redis:
        raw = _redis.get(f"{GARMIN_CACHE_PREFIX}{token}")
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        return json.loads(raw)
    else:
        return _local_sessions.get(f"{GARMIN_CACHE_PREFIX}{token}")


def _fetch_physio_trends(client, days: int = 60) -> dict:
    """Fetch 60-day physiological trend data from Garmin for AI analysis.

    Fetches VO2max, HRV, resting HR, sleep, lactate threshold, and endurance
    score. Each fetch is independently wrapped — one failure won't block the
    others. Returns a dict with None for any metric that couldn't be fetched.

    This is a shared helper used by both metrics.py (to populate the cache)
    and ai-radar.py (as a fallback when the cache is empty).
    """
    from datetime import date, timedelta

    today_str = date.today().isoformat()
    start_str = (date.today() - timedelta(days=days)).isoformat()
    physio = {}

    # VO2max trend — shows whether aerobic capacity is rising, plateauing,
    # or declining over the training block
    try:
        vo2_range = client.get_max_metrics_range(start_str, today_str)
        vo2_trend = []
        # The daily max-metrix endpoint returns a plain LIST of entries (one
        # per date), each shaped {"generic": {"vo2MaxValue": ..., "calendarDate": ...}}.
        # Some API revisions return a wrapped dict {"maxMetrics": [...]} or a
        # single unwrapped entry instead — handle all three shapes so the
        # trend is never silently empty (this mirrors metrics.py's parsing).
        if isinstance(vo2_range, list):
            entries = vo2_range
        elif isinstance(vo2_range, dict):
            entries = (
                vo2_range.get("maxMetrics")
                or vo2_range.get("maxMetricList")
                or vo2_range.get("values")
                or []
            )
            # Unwrapped single entry: {"generic": {"vo2MaxValue": ...}}
            if not entries and vo2_range.get("generic", {}).get("vo2MaxValue") is not None:
                entries = [vo2_range]
        else:
            entries = []
        for entry in entries:
            vo2_val = entry.get("generic", {}).get("vo2MaxValue")
            # Date may live at the top level or nested inside "generic"
            cal_date = entry.get("calendarDate") or entry.get("generic", {}).get("calendarDate", "")
            if vo2_val is not None:
                vo2_trend.append({"date": cal_date, "vo2max": vo2_val})
        physio["vo2max_trend"] = vo2_trend if vo2_trend else None
    except Exception:
        physio["vo2max_trend"] = None

    # HRV trend — nightly heart rate variability reveals recovery quality
    try:
        hrv_range = client.get_hrv_data_range(start_str, today_str)
        hrv_trend = []
        # Range endpoint typically returns {"hrvSummaryList": [...]} — also
        # accept a plain list or a single "hrvSummary" dict as fallbacks so
        # shape differences across API revisions never silently drop the trend.
        if isinstance(hrv_range, list):
            hrv_entries = hrv_range
        elif isinstance(hrv_range, dict):
            hrv_entries = (
                hrv_range.get("hrvSummaryList")
                or hrv_range.get("values")
                or ([hrv_range["hrvSummary"]] if hrv_range.get("hrvSummary") else [])
            )
        else:
            hrv_entries = []
        if isinstance(hrv_entries, list):
            for entry in hrv_entries:
                if isinstance(entry, dict):
                    nightly = entry.get("lastNightAvg")
                    status = entry.get("status")
                    cal_date = entry.get("calendarDate", "")
                    if nightly is not None:
                        hrv_trend.append({
                            "date": cal_date,
                            "last_night_avg": nightly,
                            "status": status,
                        })
        physio["hrv_trend"] = hrv_trend if hrv_trend else None
    except Exception:
        physio["hrv_trend"] = None

    # Resting HR trend — declining RHR = improving fitness; rising = overtraining
    try:
        rhr_daily = client.get_rhr_daily(start_str, today_str)
        rhr_trend = []
        if isinstance(rhr_daily, list):
            for entry in rhr_daily:
                rhr_val = (
                    entry.get("restingHeartRate")
                    or entry.get("value")
                )
                cal_date = entry.get("calendarDate", "")
                if rhr_val is not None:
                    rhr_trend.append({"date": cal_date, "resting_hr": rhr_val})
        physio["rhr_trend"] = rhr_trend if rhr_trend else None
    except Exception:
        physio["rhr_trend"] = None

    # Sleep trend — sleep quality and duration impact recovery
    try:
        sleep_daily = client.get_sleep_daily(start_str, today_str)
        sleep_trend = []
        if isinstance(sleep_daily, list):
            for entry in sleep_daily:
                cal_date = entry.get("calendarDate", "")
                score = None
                duration_sec = entry.get("sleepTimeSeconds") or entry.get("sleepDuration")
                scores = entry.get("sleepScores", {})
                if isinstance(scores, dict):
                    overall = scores.get("overall", {})
                    score = overall.get("value") if isinstance(overall, dict) else overall
                if score is None:
                    score = entry.get("sleepScore") or entry.get("overallSleepScore")
                if cal_date and (score is not None or duration_sec is not None):
                    sleep_trend.append({
                        "date": cal_date,
                        "sleep_score": score,
                        "sleep_duration_hrs": round(duration_sec / 3600, 1) if duration_sec else None,
                    })
        physio["sleep_trend"] = sleep_trend if sleep_trend else None
    except Exception:
        physio["sleep_trend"] = None

    # Lactate Threshold — Garmin estimate (requires chest strap; null for most)
    try:
        lt_data = client.get_lactate_threshold(latest=True)
        lt_speed = None
        lt_hr = None
        if isinstance(lt_data, dict):
            sah = lt_data.get("speed_and_heart_rate", {})
            if isinstance(sah, dict):
                lt_speed = sah.get("speed")
                lt_hr = sah.get("heartRate")
        physio["lactate_threshold"] = {
            "speed_ms": lt_speed,
            "heart_rate_bpm": lt_hr,
        } if (lt_speed is not None or lt_hr is not None) else None
    except Exception:
        physio["lactate_threshold"] = None

    # Endurance Score — Garmin's composite aerobic endurance estimate
    try:
        endurance = client.get_endurance_score(start_str, today_str)
        endurance_trend = []
        # Stats endpoint returns a dict wrapping the entry list — also accept
        # a plain list response for API shape differences across revisions.
        if isinstance(endurance, list):
            entries = endurance
        elif isinstance(endurance, dict):
            entries = (
                endurance.get("enduranceScoreList")
                or endurance.get("values")
                or [endurance]
            )
        else:
            entries = []
        if isinstance(entries, list):
            for entry in entries:
                es_val = (
                    entry.get("enduranceScore")
                    or entry.get("value")
                    or entry.get("score")
                )
                cal_date = entry.get("calendarDate", "")
                if es_val is not None:
                    endurance_trend.append({"date": cal_date, "endurance_score": es_val})
        physio["endurance_trend"] = endurance_trend if endurance_trend else None
    except Exception:
        physio["endurance_trend"] = None

    # Heart Rate Profile — the runner's personalized zones + max/resting/
    # threshold HR from Garmin. This is the anchor the AI needs to interpret
    # heart-rate readings: a given bpm is only "high" or "low" relative to
    # the individual's zones, never by population averages.
    try:
        zones_data = client.get_heart_rate_zones()
        # Response is a list of per-sport profiles — prefer RUNNING, fall
        # back to the first available profile (or a single dict if present)
        if isinstance(zones_data, list) and zones_data:
            profile = next(
                (p for p in zones_data if isinstance(p, dict) and str(p.get("sport", "")).upper() == "RUNNING"),
                None,
            )
            if profile is None:
                profile = next((p for p in zones_data if isinstance(p, dict)), None)
        elif isinstance(zones_data, dict):
            profile = zones_data
        else:
            profile = None

        hr_profile = None
        if isinstance(profile, dict):
            # Garmin's current heartRateZones shape uses "XxxUsed" fields plus
            # flat zone floors, e.g. {"maxHeartRateUsed": 194,
            # "restingHeartRateUsed": 48, "lactateThresholdHeartRateUsed": 172,
            # "zone1Floor": 120, ..., "zone5Floor": 179}. Older revisions used
            # maxHeartRate/restingHeartRate/... with a zones list — parse both
            # so the profile is never silently dropped.
            max_hr = (
                profile.get("maxHeartRateUsed")
                or profile.get("maxHeartRate")
            )
            resting_hr = (
                profile.get("restingHeartRateUsed")
                or profile.get("restingHeartRate")
            )
            threshold_hr = (
                profile.get("lactateThresholdHeartRateUsed")
                or profile.get("thresholdHeartRate")
                or profile.get("lactateThresholdHeartRate")
            )

            # Build zones from the flat floor fields (current shape): each
            # zoneNFloor is the lower bound of zone N; zone 5's upper bound is
            # the max HR, so Z1 = [zone1Floor, zone2Floor), ..., Z5 = [zone5Floor, max].
            zones = []
            floors = [
                profile.get(f"zone{i}Floor") for i in range(1, 6)
            ]
            if all(isinstance(f, (int, float)) for f in floors):
                for i in range(5):
                    zmin = floors[i]
                    zmax = floors[i + 1] if i < 4 else max_hr
                    if zmax is not None and zmax > zmin:
                        zones.append({"zone": i + 1, "min": zmin, "max": zmax})
            else:
                # List shape (older revisions): [{"zone": n, "min": .., "max": ..}]
                zone_rows = (
                    profile.get("hrZones")
                    or profile.get("zones")
                    or profile.get("heartRateZones")
                    or []
                )
                if isinstance(zone_rows, list):
                    for z in zone_rows:
                        if not isinstance(z, dict):
                            continue
                        znum = z.get("zone")
                        zmin = z.get("min")
                        zmax = z.get("max")
                        # Some revisions nest the bounds under "heartRateZone"
                        nested = z.get("heartRateZone")
                        if (zmin is None or zmax is None) and isinstance(nested, dict):
                            zmin = zmin if zmin is not None else nested.get("min")
                            zmax = zmax if zmax is not None else nested.get("max")
                        if znum is not None and zmin is not None and zmax is not None:
                            zones.append({"zone": znum, "min": zmin, "max": zmax})
            zones.sort(key=lambda z: z["zone"])

            hr_profile = {
                "max_hr": max_hr,
                "resting_hr": resting_hr,
                "threshold_hr": threshold_hr,
                "zones": zones,
            }
        # Only keep the profile if it carries at least one usable anchor
        physio["heart_rate_profile"] = hr_profile if (
            hr_profile and (
                hr_profile.get("max_hr") is not None
                or hr_profile.get("threshold_hr") is not None
                or hr_profile.get("zones")
            )
        ) else None
    except Exception:
        physio["heart_rate_profile"] = None

    return physio


def _compute_goal_pace_ms(goal: dict | None) -> float:
    """Compute the race goal pace in m/s from a race_goal dict.

    Mirrors the frontend's computeGoalPaceMs: distance from the race purpose
    (or explicit distance), time target parsed as H:MM:SS or MM:SS.
    Returns 0 when the goal is missing or unparseable.
    """
    if not goal or not goal.get("time_target"):
        return 0
    distance_map = {
        "5K": 5, "10K": 10, "Half Marathon": 21.1,
        "Marathon": 42.2, "Ultra Marathon": 50, "Triathlon": 40,
    }
    dist_km = distance_map.get(goal.get("purpose")) or _parse_float(goal.get("distance")) or 0
    if not dist_km:
        return 0
    # Parse H:MM:SS or MM:SS
    total_sec = 0
    try:
        vals = [int(x) for x in str(goal["time_target"]).split(":")]
        if len(vals) == 3:
            total_sec = vals[0] * 3600 + vals[1] * 60 + vals[2]
        elif len(vals) == 2:
            total_sec = vals[0] * 60 + vals[1]
    except (ValueError, TypeError):
        return 0
    if total_sec <= 0:
        return 0
    return (dist_km * 1000) / total_sec


def _parse_float(val) -> float | None:
    """Safely parse a value to float, returning None on failure."""
    try:
        if val is None or val == "":
            return None
        return float(val)
    except (ValueError, TypeError):
        return None


def _slim_activity(a: dict, goal_pace_ms: float = 0) -> dict:
    """Convert a raw Garmin activity summary into the frontend's slim format.

    This is the single definition of the UI activity shape — /activities and
    the cached ui_activities bundle both use it. The run_tag is computed here
    by the single classifier (same one the AI lap-selection uses), so the UI
    tag and the AI selection can never disagree.
    """
    slim = {
        "id": a.get("activityId"),
        "name": a.get("activityName", "Unnamed"),
        "type": a.get("activityType", {}).get("typeKey", "unknown"),
        "start_time": a.get("startTimeLocal"),
        "distance": round(a.get("distance", 0) / 1000, 2),
        "duration": round(a.get("duration", 0) / 60, 1),
        "avg_pace": a.get("averageSpeed", 0),
        "max_pace": a.get("maxSpeed"),
        "avg_hr": a.get("averageHR"),
        "max_hr": a.get("maxHR"),
        "calories": a.get("calories"),
        "elevation_gain": round(a.get("elevationGain", 0), 1),
        "training_effect": a.get("aerobicTrainingEffect"),
        "anaerobic_training_effect": a.get("anaerobicTrainingEffect"),
        "avg_cadence": a.get("averageRunningCadenceInStepsPerMinute"),
        "elapsed_duration": round(a.get("elapsedDuration", 0) / 60, 1) if a.get("elapsedDuration") else None,
    }
    slim["run_tag"] = _classify_run(a, goal_pace_ms)
    return slim


def _classify_run(a: dict, goal_pace_ms: float) -> str:
    """Full run classification — the SINGLE classifier for the UI tag and the
    AI lap-selection. Returns one of: Run / Warmup / Tempo Long / LSD /
    Speedwork / Easy.
    """
    avg_speed = a.get("averageSpeed") or 0
    dist_km = (a.get("distance") or 0) / 1000
    if avg_speed <= 0:
        return "Run"
    # Warmup: runs shorter than 2km
    if dist_km < 2:
        return "Warmup"
    speedwork = _is_speedwork_candidate(a, goal_pace_ms)
    # Long runs are split by speedwork character
    if dist_km > 12:
        return "Tempo Long" if speedwork else "LSD"
    return "Speedwork" if speedwork else "Easy"


def _compute_weekly_mileage(client, weeks: int = 12) -> list[dict]:
    """Group recent running activities by week (Monday-start), matching the
    /weekly-mileage endpoint's response format. Uses get_activities_by_date
    so it can run inside the /metrics session for caching.
    """
    from datetime import date, timedelta, datetime as _dt

    today = date.today()
    start_date = today - timedelta(days=today.weekday() + (weeks - 1) * 7)
    start_str = start_date.isoformat()
    end_str = today.isoformat()

    try:
        activities = client.get_activities_by_date(start_str, end_str, activitytype="running")
    except Exception:
        return []

    week_buckets = {}
    for i in range(weeks):
        week_start = start_date + timedelta(days=i * 7)
        week_buckets[week_start.isoformat()] = {
            "week_start": week_start.isoformat(),
            "mileage_km": 0.0,
            "run_count": 0,
        }

    for a in activities:
        start_time = a.get("startTimeLocal") or a.get("startTimeGMT") or ""
        try:
            act_dt = _dt.strptime(start_time[:19], "%Y-%m-%d %H:%M:%S")
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
    return result


# How many speedwork sessions we fetch lap details for (keeps Garmin request
# count low — details are per-activity API calls)
LAP_DETAIL_CAP = 10


def _is_speedwork_candidate(a: dict, goal_pace_ms: float) -> bool:
    """Detect likely tempo/interval sessions from summary fields only.

    Decision hierarchy (shared with the frontend tag — same goal, same rule):
      - pace signal alone: avg pace >= 10s/km faster than goal (primary)
      - anaerobic signal alone: Garmin's anaerobic training effect >= 1.5
      - ratio AND spread together: max/avg speed ratio >= 1.15 AND
        maxHR - avgHR >= 30 — the interval-rep signature. Neither decides
        alone: max HR spikes and pace drift (fast finishing lap, downhill)
        are common in easy runs, so they only count when both fire together.
      - name keyword: last resort.
    """
    avg_speed = a.get("averageSpeed") or 0
    max_speed = a.get("maxSpeed") or 0
    avg_hr = a.get("averageHR") or 0
    max_hr = a.get("maxHR") or 0
    anaerobic = a.get("anaerobicTrainingEffect") or 0
    name = (a.get("activityName") or "").lower()

    # Primary: pace >= 10s/km faster than goal pace (m/s threshold)
    if goal_pace_ms > 0 and avg_speed > 0:
        goal_sec_per_km = 1000 / goal_pace_ms
        speedwork_sec_per_km = goal_sec_per_km - 10
        if speedwork_sec_per_km > 0 and avg_speed > 1000 / speedwork_sec_per_km:
            return True

    # Strong standalone: Garmin's anaerobic training effect
    if anaerobic >= 1.5:
        return True

    # Weak pair — must BOTH fire (interval-rep signature: pace spikes AND
    # HR swings in the same session). A fast last km or a hilly drift trips
    # only one of them and stays classified as easy.
    ratio = (max_speed / avg_speed) if (avg_speed > 0 and max_speed > 0) else 0
    spread = (max_hr - avg_hr) if (avg_hr > 0 and max_hr > 0) else 0
    if ratio >= 1.15 and spread >= 30:
        return True

    # Last resort: name keywords (user-set names can be unreliable alone)
    if any(kw in name for kw in ("tempo", "interval", "fartlek", "threshold",
                                 "speed", "repeat", "800", "400", "200")):
        return True

    return False


def _fetch_lap_summaries(client, activity_id, goal_pace_ms: float = 0) -> dict | None:
    """Fetch compact lap-level data for one activity via split_summaries.

    Returns {"laps": [...], "work_lap_count", "rest_lap_count",
    "work_avg_pace_ms", "rest_avg_pace_ms"} where work laps are those at or
    faster than goal pace (the actual reps) and rest laps are the recovery
    between them. This surfaces the true session structure that blended
    averages hide.
    """
    try:
        data = client.get_activity_split_summaries(str(activity_id))
    except Exception:
        return None

    # Defensive: accept {"splitSummaries": [...]} or a bare list
    if isinstance(data, dict):
        splits = data.get("splitSummaries") or data.get("splits") or []
    elif isinstance(data, list):
        splits = data
    else:
        splits = []

    laps = []
    work_paces, rest_paces = [], []
    for s in splits:
        if not isinstance(s, dict):
            continue
        lap_speed = s.get("averageSpeed") or s.get("speed")
        if lap_speed is None or lap_speed <= 0:
            continue
        lap = {
            "duration_s": s.get("duration") or s.get("durationSec") or 0,
            "distance_m": s.get("distance") or 0,
            "avg_pace_ms": round(lap_speed, 2),
            "avg_hr": s.get("averageHr") or s.get("averageHR"),
            "max_hr": s.get("maxHr") or s.get("maxHR"),
        }
        laps.append(lap)
        # Work lap = at/faster than goal pace; rest = slower (recovery)
        if goal_pace_ms > 0 and lap_speed >= goal_pace_ms:
            work_paces.append(lap_speed)
        else:
            rest_paces.append(lap_speed)

    if not laps:
        return None

    def _avg(vals):
        return round(sum(vals) / len(vals), 2) if vals else None

    return {
        "laps": laps,
        "work_lap_count": len(work_paces),
        "rest_lap_count": len(rest_paces),
        "work_avg_pace_ms": _avg(work_paces),
        "rest_avg_pace_ms": _avg(rest_paces),
    }


def _fetch_activities_for_ai(client, limit: int = 30, goal_pace_ms: float = 0) -> list[dict]:
    """Fetch recent activities in the format ai-radar.py needs for its prompt.

    Returns a list of dicts with the same keys ai-radar.py uses:
    name, type, date, distance_km, duration_min, avg_hr, max_hr, calories,
    elevation_gain, avg_pace_ms, avg_cadence, training_effect.

    When goal_pace_ms is provided, sessions flagged as speedwork (tempo/
    interval) get lap-level details attached (capped at LAP_DETAIL_CAP) so the
    AI can see work/rest structure instead of rest-diluted averages.
    """
    activities_data = []
    acts = client.get_activities(0, limit)
    # Track how many lap fetches we've done to respect the cap
    lap_fetches = 0
    for a in acts:
        entry = {
            "name": a.get("activityName", ""),
            "type": a.get("activityType", {}).get("typeKey", ""),
            "date": a.get("startTimeLocal", ""),
            "distance_km": round(a.get("distance", 0) / 1000, 2),
            "duration_min": round(a.get("duration", 0) / 60, 1),
            "avg_hr": a.get("averageHR"),
            "max_hr": a.get("maxHR"),
            "calories": a.get("calories"),
            "elevation_gain": round(a.get("elevationGain", 0), 1),
            "avg_pace_ms": a.get("averageSpeed"),
            "avg_cadence": a.get("averageRunningCadenceInStepsPerMinute"),
            "training_effect": a.get("aerobicTrainingEffect"),
        }
        # Attach lap details only for speedwork-tagged sessions (same single
        # classifier as the UI tag), up to the cap — each lap fetch is one
        # extra Garmin API call, so keep the count low
        if (
            goal_pace_ms > 0
            and lap_fetches < LAP_DETAIL_CAP
            and _classify_run(a, goal_pace_ms) in ("Speedwork", "Tempo Long")
            and a.get("activityId")
        ):
            laps = _fetch_lap_summaries(client, a["activityId"], goal_pace_ms)
            if laps:
                entry["laps"] = laps
                lap_fetches += 1
        activities_data.append(entry)
    return activities_data


# --- Coach plan helpers ---

# Running activity types accepted by the coach plan feature (same set as
# activities.py — keeps the "last 2 weeks" history consistent with the
# Activities page).
RUNNING_TYPES = {"running", "trail_running", "track_running", "treadmill_running", "virtual_run"}


def _fetch_recent_activities_with_laps(client, days: int = 14, goal_pace_ms: float = 0) -> list[dict]:
    """Fetch the last `days` of running activities with lap detail for every run.

    Reuses _fetch_lap_summaries — the same per-activity lap fetcher ai-radar
    already uses — but applies it to ALL runs inside a date-bounded window
    (not just speedwork, and without ai-radar's 10-session cap). This powers
    the coach plan page's "Last 2 Weeks" history (expandable lap detail) and
    gives GPT full lap structure for plan generation.
    """
    from datetime import date, timedelta

    today = date.today()
    start_str = (today - timedelta(days=days - 1)).isoformat()
    end_str = today.isoformat()
    try:
        activities = client.get_activities_by_date(start_str, end_str, activitytype="running")
    except Exception:
        return []

    result = []
    for a in activities:
        type_key = (a.get("activityType") or {}).get("typeKey", "unknown")
        if type_key.lower() not in RUNNING_TYPES:
            continue
        # Reuse the shared slim shape (same UI fields + single run classifier)
        entry = _slim_activity(a, goal_pace_ms)
        entry["laps"] = (
            _fetch_lap_summaries(client, a["activityId"], goal_pace_ms)
            if a.get("activityId")
            else None
        )
        result.append(entry)

    # Newest first so the timeline reads most-recent at the top
    result.sort(key=lambda x: x.get("start_time") or "", reverse=True)
    return result


def _build_running_workout(workout: dict):
    """Build a Garmin running workout from a coach-plan workout spec.

    The spec carries: type, title, description, distance_km, duration_min,
    target_pace_min_per_km, intensity. Maps the common session types into a
    structured RunningWorkout (warmup/main/cooldown, with a repeat group for
    interval work). Returns a RunningWorkout instance ready for
    client.upload_running_workout(). Steps use distance/time end conditions;
    pace targets are carried in the description for v1 (pace-zone targets can
    be layered in later once the Garmin target shape is confirmed).
    """
    from garminconnect.workout import (
        RunningWorkout,
        WorkoutSegment,
        create_warmup_step,
        create_interval_step,
        create_distance_interval_step,
        create_recovery_step,
        create_cooldown_step,
        create_repeat_group,
    )

    wtype = (workout.get("type") or "Easy").strip().lower()
    title = workout.get("title") or "Run"
    description = workout.get("description") or ""
    # Pace targets are carried in the workout description so they appear on the
    # watch alongside the structured distance/time steps (pace-zone steps can
    # be layered in once the Garmin target shape is confirmed).
    target_pace = workout.get("target_pace_min_per_km")
    if target_pace:
        description = f"{description} Target pace: {target_pace}/km." if description else f"Target pace: {target_pace}/km."
    distance_km = _parse_float(workout.get("distance_km"))
    duration_min = _parse_float(workout.get("duration_min"))

    # Helper: distance-based main step (meters) or time-based fallback
    def main_step(order):
        if distance_km:
            return create_distance_interval_step(distance_km * 1000.0, order)
        return create_interval_step((duration_min or 30.0) * 60.0, order)

    if wtype in ("tempo", "threshold"):
        # 10' easy + a sustained main block + 5' easy
        steps = [
            create_warmup_step(600.0, 1),
            main_step(2),
            create_cooldown_step(300.0, 3),
        ]
    elif wtype in ("intervals", "speedwork", "speed", "interval", "fartlek"):
        # 10' easy + 6 x (2' hard / 2' recovery) + 5' easy
        repeat = create_repeat_group(
            6,
            [create_interval_step(120.0, 1), create_recovery_step(120.0, 2)],
            2,
        )
        steps = [
            create_warmup_step(600.0, 1),
            repeat,
            create_cooldown_step(300.0, 3),
        ]
    else:
        # Easy / long run / recovery / default: single distance/time step
        steps = [main_step(1)]

    if duration_min:
        est_secs = int(duration_min * 60)
    elif distance_km:
        est_secs = int(distance_km * 360)  # ~6:00/km average
    else:
        est_secs = 1800

    segment = WorkoutSegment(
        segmentOrder=1,
        sportType={"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1},
        workoutSteps=steps,
    )
    return RunningWorkout(
        workoutName=title,
        estimatedDurationInSecs=est_secs,
        workoutSegments=[segment],
        description=description,
    )


def _median(vals: list) -> float | None:
    """Return the median of a numeric list, or None when empty."""
    if not vals:
        return None
    s = sorted(vals)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


def _format_pace_min_km(sec_per_km) -> str | None:
    """Format seconds-per-km as "M:SS", or None for an invalid value."""
    if sec_per_km is None or sec_per_km <= 0:
        return None
    mins = int(sec_per_km // 60)
    secs = int(round(sec_per_km % 60))
    if secs >= 60:
        mins += 1
        secs -= 60
    return f"{mins}:{secs:02d}"


def _compute_pace_zones(goal_pace_ms: float, history: list[dict]) -> dict:
    """Derive per-workout-type target paces from recent fitness + race goal.

    Follows Runna's "train at current fitness, not a rigid goal time" principle:
    recent easy/fast paces are the primary anchor, and the race-goal pace plus
    fixed offsets is only a fallback when recent data is sparse. Returns
    {workout_type: "M:SS"} so the frontend can show (and re-derive) pace without
    letting the user edit it directly.
    """
    goal_sec = 1000 / goal_pace_ms if (goal_pace_ms and goal_pace_ms > 0) else None

    easy_secs, fast_secs = [], []
    for a in history:
        pace_ms = a.get("avg_pace") or 0
        if not pace_ms or pace_ms <= 0:
            continue
        tag = a.get("run_tag") or ""
        sec = 1000 / pace_ms
        if tag in ("Easy", "Recovery", "Warmup", "LSD"):
            easy_secs.append(sec)
        elif tag in ("Speedwork", "Tempo Long"):
            fast_secs.append(sec)

    easy_sec = _median(easy_secs)
    fast_sec = _median(fast_secs)

    # Offsets from goal race pace (positive = slower), used only as fallback
    offsets = {
        "Recovery": 75,
        "Easy": 50,
        "Long Run": 35,
        "Tempo": 5,
        "Intervals": -30,
        "Speedwork": -35,
    }
    zones = {}
    for wtype, off in offsets.items():
        if wtype == "Recovery" and easy_sec:
            zones[wtype] = _format_pace_min_km(easy_sec + 15)
        elif wtype in ("Easy", "Recovery", "Long Run") and easy_sec:
            zones[wtype] = _format_pace_min_km(easy_sec)
        elif wtype in ("Tempo", "Intervals", "Speedwork") and fast_sec:
            zones[wtype] = _format_pace_min_km(fast_sec)
        elif goal_sec:
            zones[wtype] = _format_pace_min_km(goal_sec + off)
        else:
            zones[wtype] = None
    return zones
