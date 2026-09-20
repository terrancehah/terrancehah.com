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
import traceback
from datetime import datetime, date, timedelta
from typing import Dict, Optional
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from openai import AsyncOpenAI
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
    rewritten routes (e.g. /projects/pacey/api/<function_name>)
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

    # Any unhandled exception would otherwise surface as Vercel's opaque
    # non-JSON "Internal Server Error", which the client cannot parse (Safari
    # reports that as "The string did not match the expected pattern") and
    # which hides the cause. Log the traceback and answer with JSON instead.
    @app.exception_handler(Exception)
    async def _unhandled_exception(request, exc):
        print("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
        return JSONResponse(
            status_code=500,
            content={"error": f"{type(exc).__name__}: {exc}"},
        )

    return app

# Load environment variables (from .env locally, from Vercel dashboard in production)
load_dotenv()

# --- Pydantic models ---

class GarminAuthRequest(BaseModel):
    """Credentials for a fresh login, or a code for the second step.

    Two-factor accounts take two calls: the password step answers with
    mfa_required plus an mfa_token, and the code step sends that token back with
    the code. Only one pair is used per request, so all four are optional and
    the endpoint validates.
    """
    email: str = ""
    password: str = ""
    mfa_token: str = ""
    mfa_code: str = ""

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
SESSION_TTL = 3600 * 24 * 7  # 7 days — refreshed on each successful access


def _save_session(token: str, data: dict, ttl: int = SESSION_TTL):
    """Save a session to Redis (or local fallback).

    Strips the garmin_client field before saving since the Garmin client
    object is not JSON-serializable. The client is lazily re-created from the
    session's stored OAuth token bundle by _get_garmin_client when needed — a
    password is never part of a session.
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
    active sessions stay alive while inactive ones expire after 7 days.
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
    auto-refreshes the DI token.

    There is deliberately NO credential fallback here. A credential login is
    the only thing that can trigger Garmin's two-factor challenge, and this
    function runs on every background data fetch — so a fallback would mean a
    runner being asked for a code in the middle of a page refresh, for a fetch
    they never asked for. It also keeps us off Garmin's login-attempt rate
    limit. When the tokens cannot be used, this raises 401 and the runner logs
    in again through the modal, which is the one place a code is expected.

    Raises HTTPException(401) if session state is missing or login fails.
    """
    sess = _get_session(token)
    email = sess.get("email", "")
    tokens_json = sess.get("tokens")

    if not email:
        raise HTTPException(
            status_code=401,
            detail="Garmin session not found. Please log in again."
        )

    try:
        if not tokens_json:
            raise HTTPException(
                status_code=401,
                detail="Garmin session has no credentials. Please log in again."
            )
        # Token-based re-auth — no password involved. If the tokens are
        # rejected/expired, login() raises and the user re-logs in.
        client = Garmin(email)
        client.login(tokenstore=tokens_json)
        # Persist the rotated token bundle. garminconnect refreshes AND
        # rotates the DI refresh token on login, but only writes it back
        # when it was given a file path — we pass inline JSON, so without
        # this the stored refresh token would go stale and every later
        # request would fail re-auth. Best-effort, and only written when
        # it actually changed (avoids a Redis write on every request).
        try:
            refreshed = client.client.dumps()
            if refreshed and refreshed != tokens_json:
                sess["tokens"] = refreshed
                _save_session(token, sess)
        except Exception:
            pass
        return client
    except HTTPException:
        raise
    except GarminConnectTooManyRequestsError:
        # Garmin is rate-limiting — a TRANSIENT condition, not an auth
        # failure. Surface 429 so callers can retry instead of prompting the
        # runner to log in again.
        raise HTTPException(
            status_code=429,
            detail="Garmin is temporarily rate-limiting requests. Please try again shortly."
        )
    except GarminConnectConnectionError:
        # Network / Garmin-side outage — also transient, not an auth failure.
        raise HTTPException(
            status_code=502,
            detail="Could not reach Garmin. Please try again shortly."
        )
    except GarminConnectAuthenticationError:
        raise HTTPException(
            status_code=401,
            detail="Garmin re-authentication failed. Please log in again."
        )
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

# Cache version suffix — bump this when the cache shape changes (e.g. new
# fields, new tag logic, new filtering) so stale entries from older code
# are automatically ignored. The key becomes race:garmin-cache:v2:{token}.
GARMIN_CACHE_VERSION = "v2"
GARMIN_CACHE_PREFIX = f"race:garmin-cache:{GARMIN_CACHE_VERSION}:"
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


# --- Persistent race goal store (Redis) ---
#
# Race goals are stored separately from sessions, keyed by Garmin account
# email rather than session token. This decouples the race goal from the
# session lifecycle so it survives logout, session expiry, and re-login.
# When a user logs back in, garmin-auth.py checks this store and loads the
# existing race goal into the new session, skipping onboarding.
#
# No TTL — the user explicitly set this goal and it persists indefinitely
# until they change it. A reminder popup on the frontend lets them review,
# edit, or replace it when they return.

RACE_GOAL_PREFIX = "race:goal:"


def _save_persistent_race_goal(email: str, goal: dict):
    """Store a race goal keyed by Garmin account email.

    Called by onboarding.py when the user sets or updates their race goal.
    Overwrites any previous goal for this email. No TTL — the goal persists
    until the user explicitly changes it.
    """
    if not email:
        return
    key = f"{RACE_GOAL_PREFIX}{email}"
    if _redis:
        _redis.set(key, json.dumps(goal))
    else:
        _local_sessions[key] = goal


def _get_persistent_race_goal(email: str) -> dict | None:
    """Read a persisted race goal by Garmin account email.

    Called by garmin-auth.py on login to check if the user already has a
    race goal from a previous session. Returns None if no goal exists.
    """
    if not email:
        return None
    key = f"{RACE_GOAL_PREFIX}{email}"
    if _redis:
        raw = _redis.get(key)
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        return json.loads(raw)
    else:
        return _local_sessions.get(key)


# --- Persistent AI radar cache (Redis, keyed by email) ---
#
# Stores the full AI response (six dimensions + overall insight) so it can be
# shared across devices and sessions for the same user. Invalidated when new
# activities are recorded or after 7 days (whichever comes first).
#
# The cache entry includes:
#   - data: the full AI response (dimensions + overall)
#   - generated_at: ISO timestamp of when the AI call was made
#   - latest_activity_date: the date of the most recent Garmin activity at
#     generation time — used to detect new runs and invalidate the cache

AI_CACHE_PREFIX = "race:ai-cache:"
AI_CACHE_TTL = 7 * 24 * 3600  # 7 days — hard fallback expiry


def _save_persistent_ai_cache(email: str, data: dict, latest_activity_date: str = "",
                              generated_at: str = "") -> str:
    """Store AI radar results keyed by email so they sync across devices.

    Called by ai-radar.py after a successful AI call. Stores the full response
    along with metadata for activity-based invalidation. The 7-day TTL is a
    safety net — the activity-date check is the primary invalidation mechanism.

    Returns the generated_at timestamp stored with the entry (the caller passes
    it in, or it defaults to now) so the same value can be surfaced to the
    client for its "last updated" line.
    """
    if not email:
        return ""
    key = f"{AI_CACHE_PREFIX}{email}"
    generated_at = generated_at or datetime.now().isoformat()
    entry = {
        "data": data,
        "generated_at": generated_at,
        "latest_activity_date": latest_activity_date,
    }
    if _redis:
        _redis.set(key, json.dumps(entry), ex=AI_CACHE_TTL)
    else:
        _local_sessions[key] = entry
    return generated_at


def _get_persistent_ai_cache(email: str) -> dict | None:
    """Read a persisted AI radar cache by email. Returns None if no cache exists.

    Returns the full cache entry including metadata, not just the AI data.
    The caller is responsible for checking the latest_activity_date against
    current Garmin data to decide whether the cache is still valid.
    """
    if not email:
        return None
    key = f"{AI_CACHE_PREFIX}{email}"
    if _redis:
        raw = _redis.get(key)
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        return json.loads(raw)
    else:
        return _local_sessions.get(key)


def _delete_persistent_ai_cache(email: str):
    """Remove a persisted AI radar cache by email.

    Called when the user refreshes insights manually or when the race goal
    changes (a different goal means the old scores are no longer relevant).
    """
    if not email:
        return
    key = f"{AI_CACHE_PREFIX}{email}"
    if _redis:
        _redis.delete(key)
    else:
        _local_sessions.pop(key, None)


# --- Persistent coach plan cache (Redis, keyed by email) ---
#
# Stores the full coach plan so the same plan appears on every device. The
# plan is forward-looking and week-specific, so invalidation is based on the
# plan's week_start date — a new week means a new plan.
#
# The cache entry includes:
#   - data: the full coach plan response ({ history, plan })
#   - generated_at: ISO timestamp
#   - week_start: the plan's starting date (used for week-based invalidation)
#   - preferences: the prefs used to generate the plan (for comparison)
#   - race_date: the race date the plan targets (invalidates when it changes)

COACH_CACHE_PREFIX = "race:coach-cache:"
COACH_CACHE_TTL = 7 * 24 * 3600  # 7 days — plans regenerate weekly


# --- Persistent fitness snapshot (Redis, keyed by email) ---
#
# The trajectory verdict and the fitness summary are computed from the runner's
# recent activity history. That history lives in the Garmin data cache, which
# is keyed by SESSION TOKEN — so a second device (or one whose cache has
# expired) would show a stale fitness card and no trajectory at all.
#
# Mirroring the same activity history under an email key means every device
# computes the trajectory from identical inputs. We share the INPUTS, never the
# verdict: the verdict stays a single deterministic computation on each read, so
# it can't go stale (it reflects current fitness and days-to-race).
FITNESS_CACHE_PREFIX = "race:fitness:"
# 6 hours — longer than the 1h Garmin cache so another device can use it, short
# enough that "current fitness" stays honest.
FITNESS_CACHE_TTL = 3600 * 6


def _save_fitness_snapshot(email: str, ui_activities: list, activities: list):
    """Store the recent-run history keyed by email for cross-device fitness.

    Mirrors the two activity lists the Garmin cache holds — the slim UI list
    (every recent run) and the lap-detailed AI list (laps merged by date) — so
    `_history_from_garmin_cache` can read the snapshot unchanged.
    """
    if not email or not ui_activities:
        return
    latest = ""
    for a in ui_activities:
        d = (a.get("start_time") or "")[:10]
        if d and d > latest:
            latest = d
    key = f"{FITNESS_CACHE_PREFIX}{email}"
    entry = {
        "ui_activities": ui_activities,
        "activities": activities or [],
        "generated_at": datetime.now().isoformat(),
        "latest_activity_date": latest,
    }
    if _redis:
        _redis.set(key, json.dumps(entry), ex=FITNESS_CACHE_TTL)
    else:
        _local_sessions[key] = entry


def _get_fitness_snapshot(email: str) -> dict | None:
    """Read the email-keyed fitness snapshot, or None on a miss.

    Callers fall back to the token-scoped Garmin cache when this returns None.
    """
    if not email:
        return None
    key = f"{FITNESS_CACHE_PREFIX}{email}"
    if _redis:
        raw = _redis.get(key)
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        return json.loads(raw)
    else:
        return _local_sessions.get(key)


# --- Persistent race course (Redis, keyed by email) ---
#
# An uploaded GPX is parsed in the browser and the file itself is never sent
# anywhere. What we store is the distilled record the UI renders and the coach
# reads: distance, the hysteresis-filtered elevation gain/loss, the grade
# distribution, a downsampled elevation profile, and a simplified route outline.
#
# Keyed by email rather than session token so a course added on one device is
# available on the runner's other devices, matching the fitness snapshot.
COURSE_CACHE_PREFIX = "race:course:"
# 90 days — a race course does not change; it only needs to outlive the training
# block it belongs to. The frontend clears it explicitly on removal.
COURSE_CACHE_TTL = 90 * 24 * 3600

# How much hillier than the runner's own training a course must be before the
# coach mentions the gap. The comparison is deliberately one-directional: a
# course hillier than their training is the case where they are underprepared
# and it matters; a course FLATTER than their training is good news and warning
# them about it is noise.
COURSE_TERRAIN_GAP = 1.5

# Gain per km at which a road course counts as hilly, matching
# HILLY_GAIN_PER_KM in pacey-course.js. Below this the coach is told not to
# prescribe hill work, because there is nothing on the course it would prepare
# the runner for.
COURSE_HILLY_GAIN_PER_KM = 10


def _save_persistent_course(email: str, course: dict | None):
    """Store (or clear) the runner's race course record, keyed by email.

    Passing None removes the stored course — the frontend calls this when the
    runner removes the course from the Race Goal card.
    """
    if not email:
        return
    key = f"{COURSE_CACHE_PREFIX}{email}"
    if course is None:
        if _redis:
            _redis.delete(key)
        else:
            _local_sessions.pop(key, None)
        return
    if _redis:
        _redis.set(key, json.dumps(course), ex=COURSE_CACHE_TTL)
    else:
        _local_sessions[key] = course


def _get_persistent_course(email: str) -> dict | None:
    """Read the stored race course for an email, or None if there is none."""
    if not email:
        return None
    key = f"{COURSE_CACHE_PREFIX}{email}"
    if _redis:
        raw = _redis.get(key)
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        return json.loads(raw)
    else:
        return _local_sessions.get(key)


def _training_gain_per_km(activities: list) -> float | None:
    """Median metres of climb per kilometre across the runner's recent runs.

    This is what makes the course comparison land: a runner whose long runs
    average 5 m/km is not prepared for a 22 m/km course, and that is more
    useful to say than any description of the course on its own.
    """
    ratios = []
    for a in activities or []:
        if not isinstance(a, dict):
            continue
        gain = a.get("elevation_gain")
        # Two activity shapes reach this helper: the slim UI list uses
        # "distance", the AI activity list uses "distance_km". Reading only one
        # of them silently disables the comparison for the other.
        dist = a.get("distance")
        if dist is None:
            dist = a.get("distance_km")
        # Runs only, and long enough for the ratio to mean anything.
        if not gain or not dist or dist < 3:
            continue
        ratios.append(gain / dist)
    if not ratios:
        return None
    ratios.sort()
    mid = len(ratios) // 2
    return ratios[mid] if len(ratios) % 2 else (ratios[mid - 1] + ratios[mid]) / 2


def _course_prompt_block(course: dict | None, training_gain_per_km: float | None = None) -> str:
    """Format a stored race course for a coach prompt.

    The course tells the coach the terrain the runner will actually race on, so
    hill work and late-race advice can be specific instead of generic. The
    structure handed over is deliberately derived rather than raw: distance,
    filtered gain, where the climbing falls, how rolling the course is, what the
    hills cost in flat-equivalent terms, and the climbs with their position.

    It is advisory only — it must not change the goal time or the pace zones,
    which the runner set explicitly.

    Returns "" when no course has been uploaded, so prompts are unchanged for
    runners who have not used the feature.
    """
    if not course:
        return ""
    summary = course.get("aiSummary") or {}
    if not summary:
        return ""

    if not summary.get("has_elevation"):
        return (
            "RACE COURSE (the runner uploaded their race route):\n"
            f"- Distance: {summary.get('distance_km')} km.\n"
            "- The file carried NO elevation data, so do not comment on hills, grades or climbing."
        )

    lines = [
        "RACE COURSE (the runner uploaded their race route — this is the terrain they will race on):",
        f"- Distance: {summary.get('distance_km')} km.",
        f"- Climbing: {summary.get('elevation_gain_m')} m of gain and {summary.get('elevation_loss_m')} m of "
        f"loss ({summary.get('gain_per_km')} m per km — {summary.get('terrain')} terrain).",
        f"- Grades: average {summary.get('avg_grade_pct')}%, steepest sustained {summary.get('max_grade_pct')}%.",
    ]

    shape = summary.get("shape") or {}
    if shape.get("character"):
        lines.append(
            f"- Shape: {shape.get('character')}. {shape.get('gain_first_half_m')} m of the gain falls in the "
            f"first half and {shape.get('gain_last_third_m')} m ({shape.get('gain_last_third_pct')}% of the "
            f"course's climbing) in the last third. The course finishes "
            f"{shape.get('net_elevation_m')} m relative to the start."
        )
        # A late concentration is the thing most worth naming, and it matters
        # most on a course whose absolute numbers are small: 20 m in the final
        # kilometre of a flat half is over 40% of that course's total climbing.
        ltp = shape.get("gain_last_third_pct")
        if ltp is not None and ltp >= 45:
            lines.append(
                "- The climbing is concentrated late — most of it sits in the last third. Name that, with "
                "its numbers, as the stretch that will decide the race."
            )
        # A high point inside the closing few percent is an artefact of where
        # the trace ends, not a climb — on a closed loop it is the finish line,
        # and describing it as a "rise to watch" is nonsense.
        hp = shape.get("high_point_pct")
        if hp is not None and hp < 95:
            lines.append(
                f"- The high point is at {shape.get('high_point_km')} km, {hp}% of the way in."
            )

    # The hardest kilometre in each direction, found by a sliding window rather
    # than the climb thresholds — so a decisive rise is still named on a course
    # too flat to register any "climbs" at all.
    steepest = summary.get("steepest_km") or {}
    if steepest.get("gain_m"):
        lines.append(
            f"- Hardest kilometre: {steepest.get('start_km')}–{steepest.get('end_km')} km, climbing "
            f"{steepest.get('gain_m')} m at {steepest.get('avg_grade_pct')}% average. This is the steepest "
            "single kilometre anywhere on the course — if the runner should know about one stretch in "
            "particular, it is this one, so give it its numbers."
        )
    descent = summary.get("steepest_descent_km") or {}
    if descent.get("gain_m"):
        lines.append(
            f"- Fastest descent: {descent.get('start_km')}–{descent.get('end_km')} km, dropping "
            f"{descent.get('gain_m')} m at {descent.get('avg_grade_pct')}% — a stretch worth running."
        )

    alt = summary.get("altitude_m") or {}
    if alt.get("max") is not None:
        lines.append(
            f"- Altitude: starts at {alt.get('start')} m, ranges from {alt.get('min')} m to {alt.get('max')} m."
        )

    if summary.get("rolling_index_per_km") is not None:
        lines.append(
            f"- Rolling index: {summary.get('rolling_index_per_km')} direction changes per km. A high number "
            "means repeated rollers rather than one climb — rhythm-breaking, and harder than the raw gain "
            "figure suggests."
        )

    if summary.get("flat_equivalent_km") is not None:
        lines.append(
            f"- Flat-equivalent distance: {summary.get('flat_equivalent_km')} km, i.e. the hills make this "
            f"course cost roughly {summary.get('hill_penalty_pct')}% more effort than the same distance on "
            "the flat (Minetti energy-cost model)."
        )

    climbs = summary.get("climbs") or []
    if climbs:
        lines.append("- Climbs that will shape the race (each with where it falls):")
        for c in climbs:
            lines.append(
                f"    - {c.get('start_km')}–{c.get('end_km')} km ({c.get('position_pct')}% into the race): "
                f"{c.get('gain_m')} m over {c.get('length_km')} km at {c.get('avg_grade_pct')}% average, "
                f"steepest sustained {c.get('max_grade_pct')}%."
            )

    dist = summary.get("grade_distribution") or []
    if dist:
        lines.append("- Distance by gradient: " + ", ".join(
            f"{d.get('km')} km {str(d.get('band', '')).lower()}" for d in dist
        ) + ".")

    # The course against the terrain they actually train on. Deliberately
    # one-directional and only on a material gap: a course HILLIER than their
    # training is where they are underprepared and it matters; a course flatter
    # than their training is good news, and warning them about it is noise.
    # Phrased from the runner's side, in plain words — an earlier version said
    # "0.5x the climbing they train on" under a heading of "THE RUNNER'S OWN
    # TERRAIN", and the model echoed the heading straight back at the runner.
    course_gain_per_km = summary.get("gain_per_km")
    hillier_than_training = (
        training_gain_per_km is not None
        and training_gain_per_km > 0
        and course_gain_per_km
        and course_gain_per_km >= training_gain_per_km * COURSE_TERRAIN_GAP
    )
    if hillier_than_training:
        lines.append(
            f"- This course is noticeably hillier than the runner's recent training: their runs average "
            f"{round(training_gain_per_km, 1)} m of climb per km, this course is {course_gain_per_km}. Say "
            "that plainly, in those terms, and treat it as the one thing most likely to catch them out."
        )

    # Hill work is only worth prescribing when the course actually demands it.
    if course_gain_per_km and course_gain_per_km >= COURSE_HILLY_GAIN_PER_KM:
        lines.append(
            "- This course is hilly enough to reward hill work, so say what kind would help."
        )
    else:
        lines.append(
            "- This is a flat or rolling course. Do NOT suggest hill training — there is nothing on it that "
            "hill work would prepare them for."
        )

    lines.append(
        "- Where the climbing falls is what makes it matter: a climb at 30 km of a marathon is the decisive "
        "point of the race; the same climb at 5 km is not. Tie any pacing advice to that."
    )
    lines.append(
        "- Keep it readable. Quote a number only when it changes the advice — a course with 47 m of climbing "
        "does not need five figures to describe it."
    )
    lines.append(
        "- The course is ADVISORY. Do NOT change the goal time or the pace zones because of it."
    )
    return "\n".join(lines)


# --- Course insight cache (Redis, keyed by email) ---
#
# The coach's read on the uploaded race course. Cached so the card does not
# re-run the model on every page load, and keyed by a fingerprint of the course
# record (its savedAt) so re-uploading a course regenerates the read rather
# than serving the old one.
COURSE_INSIGHT_PREFIX = "race:course-insight:"
COURSE_INSIGHT_TTL = 90 * 24 * 3600


def _save_course_insight(email: str, insight: str, fingerprint: str):
    """Cache the coach's read on the course, keyed by email."""
    if not email or not insight:
        return
    key = f"{COURSE_INSIGHT_PREFIX}{email}"
    entry = {
        "insight": insight,
        "fingerprint": fingerprint or "",
        "generated_at": datetime.now().isoformat(),
    }
    if _redis:
        _redis.set(key, json.dumps(entry), ex=COURSE_INSIGHT_TTL)
    else:
        _local_sessions[key] = entry


def _get_course_insight(email: str, fingerprint: str) -> str | None:
    """Read the cached course insight, or None if absent or stale.

    A fingerprint mismatch means the course was replaced, so the cached read
    describes a course the runner no longer has.
    """
    if not email:
        return None
    key = f"{COURSE_INSIGHT_PREFIX}{email}"
    raw = _redis.get(key) if _redis else _local_sessions.get(key)
    if not raw:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode()
    entry = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(entry, dict) or entry.get("fingerprint") != (fingerprint or ""):
        return None
    return entry.get("insight")


def _save_persistent_coach_cache(email: str, data: dict, week_start: str = "", preferences: dict = None, race_date: str = ""):
    """Store a coach plan keyed by email so it syncs across devices.

    Called by coach-plan.py after a successful plan generation. Stores the
    full response along with the plan's week_start, the race date it targets,
    and the preferences used.
    """
    if not email:
        return
    key = f"{COACH_CACHE_PREFIX}{email}"
    entry = {
        "data": data,
        "generated_at": datetime.now().isoformat(),
        "week_start": week_start,
        "race_date": race_date,
        "preferences": preferences or {},
    }
    if _redis:
        _redis.set(key, json.dumps(entry), ex=COACH_CACHE_TTL)
    else:
        _local_sessions[key] = entry


def _get_persistent_coach_cache(email: str) -> dict | None:
    """Read a persisted coach plan by email. Returns None if no cache exists.

    Returns the full cache entry including metadata. The caller checks
    week_start to decide whether the plan is still for the current week.
    """
    if not email:
        return None
    key = f"{COACH_CACHE_PREFIX}{email}"
    if _redis:
        raw = _redis.get(key)
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        return json.loads(raw)
    else:
        return _local_sessions.get(key)


def _delete_persistent_coach_cache(email: str):
    """Remove a persisted coach plan by email.

    Called when the user changes preferences or manually regenerates the plan.
    """
    if not email:
        return
    key = f"{COACH_CACHE_PREFIX}{email}"
    if _redis:
        _redis.delete(key)
    else:
        _local_sessions.pop(key, None)


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


def _race_distance_km(goal: dict | None) -> float:
    """Race distance in km from a race_goal dict (purpose or explicit distance)."""
    if not goal:
        return 0
    distance_map = {
        "5K": 5, "10K": 10, "Half Marathon": 21.1,
        "Marathon": 42.2, "Ultra Marathon": 50, "Triathlon": 40,
    }
    return distance_map.get(goal.get("purpose")) or _parse_float(goal.get("distance")) or 0


def _compute_goal_pace_ms(goal: dict | None) -> float:
    """Compute the race goal pace in m/s from a race_goal dict.

    Mirrors the frontend's computeGoalPaceMs: distance from the race purpose
    (or explicit distance), time target parsed as H:MM:SS or MM:SS.
    Returns 0 when the goal is missing or unparseable.
    """
    if not goal or not goal.get("time_target"):
        return 0
    dist_km = _race_distance_km(goal)
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


def _goal_target_seconds(goal: dict | None) -> int:
    """The goal's target time in seconds, from H:MM:SS or MM:SS.

    Shares its parsing with _compute_goal_pace_ms. Returns 0 when there is no
    usable target, so callers can treat "no target set" and "unparseable" alike
    and skip the comparison rather than report a bogus delta.
    """
    if not goal or not goal.get("time_target"):
        return 0
    try:
        vals = [int(x) for x in str(goal["time_target"]).split(":")]
    except (ValueError, TypeError):
        return 0
    if len(vals) == 3:
        return vals[0] * 3600 + vals[1] * 60 + vals[2]
    if len(vals) == 2:
        return vals[0] * 60 + vals[1]
    return 0


def _format_finish_time(duration_min) -> str:
    """A finish time as H:MM:SS (MM:SS under an hour) from stored minutes.

    Returns "" when the figure is missing or nonsense, so a prompt can drop the
    line instead of stating a time that was never run.
    """
    try:
        total = int(round(float(duration_min) * 60))
    except (TypeError, ValueError):
        return ""
    if total <= 0:
        return ""
    hours, rem = divmod(total, 3600)
    minutes, seconds = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"


def _format_pace_per_km(pace_ms) -> str:
    """Average pace as M:SS per km from m/s. Empty when the figure is unusable."""
    try:
        ms = float(pace_ms)
    except (TypeError, ValueError):
        return ""
    if ms <= 0:
        return ""
    sec = int(round(1000 / ms))
    return f"{sec // 60}:{sec % 60:02d}"


def _parse_float(val) -> float | None:
    """Safely parse a value to float, returning None on failure."""
    try:
        if val is None or val == "":
            return None
        return float(val)
    except (ValueError, TypeError):
        return None


# Running activity types — shared across activities.py, _slim_activity,
# _fetch_recent_activities_with_laps, and the coach plan. Defined here so
# _slim_activity can reference it without forward-dependency concerns.
#
# These are Garmin's own typeKeys, taken from
# connect.garmin.com/activity-service/activity/activityTypes, where everything
# running sits under parentTypeId 1: running (1), trail_running (6),
# street_running (7), treadmill_running (18), virtual_run (153),
# indoor_running (156), ultra_run (181). Note the keys are NOT the tidy names
# third-party APIs use — Garmin says "virtual_run", not "virtual_running", and
# "ultra_run", not "ultra_running".
RUNNING_TYPES = {
    "running",
    "street_running",
    "trail_running",
    "track_running",
    "treadmill_running",
    "indoor_running",
    "virtual_run",
    "ultra_run",
    # Obstacle racing ships under both spellings depending on where Garmin
    # surfaces it; neither costs anything to list.
    "obstacle_run",
    "obstacle_course_racing",
}

# Activity types shown in the activities list. This is a running-focused app,
# so we include running plus cross-training that runners commonly do:
# strength training, hiking/rucking, and walking. Other sports (cycling,
# swimming, yoga, etc.) are excluded from the UI but may still appear in the
# AI radar prompt for context.
ALLOWED_ACTIVITY_TYPES = RUNNING_TYPES | {
    "strength_training", "hiit", "indoor_cardio", "fitness_equipment",
    "hiking", "rucking", "walking",
}


def _slim_activity(a: dict, goal_pace_ms: float = 0) -> dict:
    """Convert a raw Garmin activity summary into the frontend's slim format.

    This is the single definition of the UI activity shape — /activities and
    the cached ui_activities bundle both use it. The run_tag is computed here
    by the single classifier (same one the AI lap-selection uses), so the UI
    tag and the AI selection can never disagree.

    Non-running activities (strength training, hiking, cycling, etc.) get a
    tag based on their Garmin typeKey rather than the pace-based run classifier.
    """
    type_key = a.get("activityType", {}).get("typeKey", "unknown")
    slim = {
        "id": a.get("activityId"),
        "name": a.get("activityName", "Unnamed"),
        "type": type_key,
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
    # Non-running activities get a type-based tag instead of the pace-based
    # run classifier. This ensures strength training shows as "Strength",
    # hiking as "Hike", etc., rather than getting a misleading run tag.
    if type_key.lower() in RUNNING_TYPES:
        slim["run_tag"] = _classify_run(a, goal_pace_ms)
    else:
        slim["run_tag"] = _classify_non_running(type_key)
    return slim


# Mapping from Garmin typeKey to display tags for non-running activities.
# Only covers the allowed cross-training types (strength, hiking, walking).
# Unmapped types fall back to a humanised version of the typeKey.
NON_RUNNING_TAGS = {
    "strength_training": "Strength",
    "hiit": "HIIT",
    "indoor_cardio": "Cardio",
    "fitness_equipment": "Strength",
    "hiking": "Hike",
    "walking": "Walk",
    "rucking": "Ruck",
}


def _classify_non_running(type_key: str) -> str:
    """Return a display tag for a non-running activity type.

    Looks up the Garmin typeKey in NON_RUNNING_TAGS. Falls back to a
    humanised version of the key (e.g. "fitness_equipment" → "Fitness
    Equipment") so unmapped types still get a readable label.
    """
    key = (type_key or "other").lower()
    if key in NON_RUNNING_TAGS:
        return NON_RUNNING_TAGS[key]
    # Humanise: "strength_training" → "Strength Training"
    return key.replace("_", " ").title()


def _classify_run(a: dict, goal_pace_ms: float) -> str:
    """Full run classification — the SINGLE classifier for the UI tag and the
    AI lap-selection. Returns one of: Run / Warmup / Tempo Long / LSD /
    Speedwork / Tempo / Easy.
    """
    avg_speed = a.get("averageSpeed") or 0
    dist_km = (a.get("distance") or 0) / 1000
    if avg_speed <= 0:
        return "Run"
    # Warmup: runs shorter than 2km
    if dist_km < 2:
        return "Warmup"
    quality = _is_speedwork_candidate(a, goal_pace_ms)
    # Long runs are split by quality character — a long run with race-pace or
    # threshold work inside it is "Tempo Long" (the long-run-with-quality
    # session), everything else is plain LSD.
    if dist_km > 12:
        return "Tempo Long" if quality else "LSD"
    if not quality:
        return "Easy"
    # Short quality runs split by SHAPE, not distance: interval reps (fast pace
    # spikes + HR swings within the session) are Speedwork; a continuous
    # sustained effort with a steady pace/HR is Tempo. This is the real
    # coaching distinction the old distance cutoff could not make.
    return "Speedwork" if _is_interval_shaped(a) else "Tempo"


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
        # No activitytype filter here on purpose. Garmin's semantics for that
        # parameter are ambiguous — the library docstring lists top-level groups
        # (running, cycling, …), but 'running' is also a concrete typeKey, and
        # the endpoint does not clearly say which it matches. It was silently
        # dropping treadmill runs from this chart while the activities list,
        # which has never used the filter, still showed them. Fetching the range
        # and filtering on typeKey below makes the chart and the list agree by
        # construction instead of by Garmin's interpretation.
        activities = client.get_activities_by_date(start_str, end_str)
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
        type_key = ((a.get("activityType") or {}).get("typeKey") or "").lower()
        if type_key not in RUNNING_TYPES:
            continue
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


# How many recent weeks feed the mileage median handed to the coach prompts.
RECENT_MILEAGE_WEEKS = 6


def _recent_mileage_median(weekly_mileage=None, activities=None,
                           weeks: int = RECENT_MILEAGE_WEEKS):
    """Median weekly running distance over the most recent `weeks` weeks.

    Median rather than mean on purpose: a taper, an injury layoff or post-race
    down weeks all drag a mean below the runner's real base, and the coach would
    then be handed a figure they have already moved past. Weeks with no running
    are skipped rather than counted as zero, for the same reason.

    Accepts either the pre-bucketed `weekly_mileage` list from the Garmin cache
    or a flat activity list to bucket here — the AI radar's cache-miss path has
    the activities but not the buckets, and an extra Garmin call just to get
    them would not be worth it. Returns None when there is nothing to measure.
    """
    distances = []
    if weekly_mileage:
        distances = [w.get("mileage_km") or 0 for w in weekly_mileage]
    elif activities:
        buckets = {}
        for a in activities:
            # Two activity shapes reach here: _fetch_activities_for_ai emits
            # date/distance_km, _slim_activity emits start_time/distance.
            day = (a.get("date") or a.get("start_time") or "")[:10]
            km = a.get("distance_km")
            if km is None:
                km = a.get("distance")
            if not day or km is None:
                continue
            try:
                d = datetime.strptime(day, "%Y-%m-%d").date()
            except ValueError:
                continue
            monday = (d - timedelta(days=d.weekday())).isoformat()
            buckets[monday] = buckets.get(monday, 0) + km
        distances = [buckets[k] for k in sorted(buckets)]

    nonzero = [d for d in distances if d > 0]
    if not nonzero:
        return None
    recent = sorted(nonzero[-weeks:])
    mid = len(recent) // 2
    return recent[mid] if len(recent) % 2 else (recent[mid - 1] + recent[mid]) / 2


def _mileage_prompt_lines(race_goal: dict | None, weekly_mileage=None, activities=None) -> list[str]:
    """The weekly-mileage lines handed to a coach prompt.

    Both figures are passed because they routinely disagree, and each is wrong
    in a different direction. The reported one is what the runner typed at
    onboarding — possibly aspirational, possibly remembered wrong. The computed
    one is what their activities actually show, which under-counts for anyone
    who does not wear the watch for every run, or whose treadmill sessions
    record no distance.

    Giving the model a single number invites it to reason from a fact that may
    be false; giving it both lets it see the gap and decide which to lean on.
    """
    goal = race_goal or {}
    lines = []

    stated = goal.get("weekly_mileage")
    if stated:
        lines.append(f"- Weekly mileage the runner reported: {stated} {goal.get('mileage_unit', 'km')}")

    actual = _recent_mileage_median(weekly_mileage, activities)
    if actual is not None:
        lines.append(
            f"- Weekly mileage their recent activities show: {round(actual, 1)} km "
            f"(median of the last {RECENT_MILEAGE_WEEKS} weeks that had any running)"
        )

    if len(lines) == 2:
        lines.append(
            "- These are given separately on purpose. Where they disagree, treat the activity "
            "figure as what the runner has actually been doing and the reported one as intent — "
            "do not average them, and do not assume either is wrong."
        )
    return lines


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
    if _is_interval_shaped(a):
        return True

    # Last resort: name keywords (user-set names can be unreliable alone)
    if any(kw in name for kw in ("tempo", "interval", "fartlek", "threshold",
                                 "speed", "repeat", "800", "400", "200")):
        return True

    return False


def _is_interval_shaped(a: dict) -> bool:
    """True when the session looks like interval reps rather than a continuous
    effort: the pace spiked well above the average AND the heart rate swung
    well above the average within the same run. Neither alone is enough (a
    fast finish or a hilly drift trips only one), so both must fire. This is
    what separates Speedwork from Tempo among short quality runs.
    """
    avg_speed = a.get("averageSpeed") or 0
    max_speed = a.get("maxSpeed") or 0
    avg_hr = a.get("averageHR") or 0
    max_hr = a.get("maxHR") or 0
    ratio = (max_speed / avg_speed) if (avg_speed > 0 and max_speed > 0) else 0
    spread = (max_hr - avg_hr) if (avg_hr > 0 and max_hr > 0) else 0
    return ratio >= 1.15 and spread >= 30


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
        # Attach lap details only for quality-tagged sessions (same single
        # classifier as the UI tag), up to the cap — each lap fetch is one
        # extra Garmin API call, so keep the count low
        if (
            goal_pace_ms > 0
            and lap_fetches < LAP_DETAIL_CAP
            and _classify_run(a, goal_pace_ms) in ("Speedwork", "Tempo", "Tempo Long")
            and a.get("activityId")
        ):
            laps = _fetch_lap_summaries(client, a["activityId"], goal_pace_ms)
            if laps:
                entry["laps"] = laps
                lap_fetches += 1
        activities_data.append(entry)
    return activities_data


# --- Coach plan helpers ---


def _phase_for_days_left(days_left):
    """Map days remaining to a training phase (mirrors the fallback logic)."""
    if days_left < 0:
        return "post_race"
    # Taper applies only to the final race week (days_left 0-6); the full
    # week before it is still sharpen (last long run + race-pace touch).
    if days_left < 7:
        return "taper"
    if days_left <= 20:
        return "sharpen"
    if days_left <= 42:
        return "specificity"
    return "build"


async def _call_ai(prompt, api_key):
    """One AI call returning parsed JSON (the chunk's days array)."""
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
    content = response.choices[0].message.content if response.choices else None
    if not content:
        raise ValueError("AI returned empty response")
    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        raise ValueError("AI returned a non-object JSON payload")
    return parsed


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
        # No activitytype filter — see _compute_weekly_mileage. The typeKey
        # check in the loop below is the single source of truth for what counts
        # as a run, so a Garmin-side filter can only ever disagree with it.
        activities = client.get_activities_by_date(start_str, end_str)
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


# ---------------------------------------------------------------------------
# Canonical workout model
# ---------------------------------------------------------------------------
# One structured object is shared by every consumer of a planned workout: the
# plan card, the detail sheet, the Garmin upload, and the coach insight. The
# AI proposes a session SHAPE (segments, each with a role and an effort); the
# compiler below resolves each segment's pace from the runner's CURRENT
# fitness zones (_compute_pace_zones — easy / long-run pace from recent easy
# runs, quality pace from recent fast work, ramped toward goal pace across the
# block) and computes every distance / duration / total exactly once. Because
# the totals are DERIVED from the segments, the consumers can never disagree:
# what the card shows is what the watch gets and what the insight describes.

# Segment role -> Garmin step type key
SEGMENT_STEP_TYPE = {
    "warmup": "warmup",
    "main": "interval",
    "recovery": "recovery",
    "cooldown": "cooldown",
    "rest": "rest",
}

# Garmin step type ids (mirrors garminconnect.workout.StepType)
_STEP_TYPE_IDS = {
    "warmup": 1, "cooldown": 2, "interval": 3, "recovery": 4,
    "rest": 5, "repeat": 6, "other": 7, "main": 8,
}

# Segment effort -> pace-zone name produced by _compute_pace_zones. This is
# how a segment inherits the runner's current fitness pace (easy, long-run,
# tempo, intervals, speedwork) or the race-goal pace — the paces come from
# the runner's recent training + the block ramp, not a fixed guess.
EFFORT_TO_ZONE = {
    "recovery": "Recovery",
    "easy": "Easy",
    "long_run": "Long Run",
    "tempo": "Tempo",
    "intervals": "Intervals",
    "speed": "Speedwork",
    "goal_pace": "Race",
}

# Display labels for the detail sheet
_STEP_KIND_LABEL = {
    "warmup": "Warm up", "main": "Run", "recovery": "Recover",
    "cooldown": "Cool down", "rest": "Rest", "interval": "Run",
}


def _segment_zone_pace(effort: str, zones: dict):
    """Return (pace_str, pace_sec) for a segment effort from the pace zones."""
    zone = EFFORT_TO_ZONE.get((effort or "").strip().lower())
    if not zone or not zones:
        return None, None
    pace_str = zones.get(zone)
    if not pace_str:
        return None, None
    return pace_str, _pace_str_sec(pace_str)


def _default_segments(spec: dict, wtype: str) -> list:
    """Synthesize a segment list for a spec with no explicit segments.

    Used for plans generated before the AI emitted segments (cached plans)
    and for legacy callers. The AI's distance_km/duration_min is treated as
    the SESSION TOTAL and split into warm-up / main / cool-down, so the main
    block is never inflated to the whole session (the old template bug).
    """
    total_km = _parse_float(spec.get("distance_km"))
    total_min = _parse_float(spec.get("duration_min"))
    t = (wtype or "Easy").strip().lower()
    desc = (spec.get("description") or "").lower()

    if t == "recovery":
        effort = "recovery"
    elif t == "long run":
        effort = "long_run"
    elif t == "race":
        effort = "goal_pace"
    elif t in ("tempo", "threshold"):
        effort = "goal_pace" if ("goal pace" in desc or "race pace" in desc) else "tempo"
    elif t in ("intervals", "interval", "fartlek"):
        effort = "intervals"
    elif t in ("speedwork", "speed"):
        effort = "speed"
    else:
        effort = "easy"

    # Steady types: the whole session is one block at the type's pace.
    if t in ("easy", "recovery", "long run", "race") or not total_km:
        seg = {"role": "main", "end": "distance", "effort": effort}
        if total_km:
            seg["distance_km"] = total_km
        elif total_min:
            seg["end"] = "time"
            seg["duration_min"] = total_min
        else:
            seg["distance_km"] = 5.0
        return [seg]

    # Quality types: split the total into warm-up / main / cool-down so the
    # main block is the remainder, never the whole distance.
    warm = min(2.0, round(total_km * 0.30, 2))
    cool = min(2.0, round(total_km * 0.20, 2))
    main_km = round(total_km - warm - cool, 2)
    if main_km <= 0:
        warm, cool, main_km = 0.0, 0.0, total_km
    segs = []
    if warm > 0:
        segs.append({"role": "warmup", "end": "distance", "distance_km": warm, "effort": "easy"})
    segs.append({"role": "main", "end": "distance", "distance_km": main_km, "effort": effort})
    if cool > 0:
        segs.append({"role": "cooldown", "end": "distance", "distance_km": cool, "effort": "easy"})
    return segs


def _resolve_segment(seg, zones: dict, order: int):
    """Resolve one raw segment into a concrete step: pace from its effort, and
    BOTH distance and duration filled in (whichever the segment did not
    declare is computed from its pace), so the totals always reconcile."""
    if not isinstance(seg, dict):
        return None
    role = (seg.get("role") or "main").strip().lower()
    if role not in SEGMENT_STEP_TYPE:
        role = "main"
    effort = (seg.get("effort") or "").strip().lower()
    pace_str, pace_sec = _segment_zone_pace(effort, zones)

    distance_km = _parse_float(seg.get("distance_km"))
    duration_min = _parse_float(seg.get("duration_min"))
    end = (seg.get("end") or "").strip().lower()
    if end not in ("distance", "time"):
        end = "time" if (duration_min and not distance_km) else "distance"

    # Fill the missing dimension from the resolved pace so every segment
    # carries both units and the session total is exact in distance and time.
    if pace_sec:
        if end == "distance" and distance_km and not duration_min:
            duration_min = round(distance_km * pace_sec / 60.0, 1)
        elif end == "time" and duration_min and not distance_km:
            distance_km = round(duration_min * 60.0 / pace_sec, 2)
    if distance_km is None and duration_min is None:
        return None

    reps = int(seg.get("reps") or 1)
    if reps < 1:
        reps = 1

    resolved = {
        "role": role,
        "step": SEGMENT_STEP_TYPE[role],
        "end": end,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "effort": effort or None,
        "pace_min_per_km": pace_str,
        "pace_ms": round(1000.0 / pace_sec, 4) if pace_sec else None,
        "reps": reps,
        "order": order,
    }
    # Optional recovery between reps (interval sessions). Force a recovery
    # role/effort when the caller left them out.
    rec = seg.get("recovery")
    if reps > 1 and isinstance(rec, dict):
        rec = dict(rec)
        rec.setdefault("role", "recovery")
        rec.setdefault("effort", "recovery")
        resolved["recovery"] = _resolve_segment(rec, zones, order + 1)
    return resolved


def _segment_contribution(seg: dict) -> tuple:
    """Distance (km) and duration (min) a segment contributes to the total,
    accounting for reps and the recovery between them."""
    reps = seg.get("reps") or 1
    km = (seg.get("distance_km") or 0) * reps
    mins = (seg.get("duration_min") or 0) * reps
    rec = seg.get("recovery")
    if isinstance(rec, dict):
        km += (rec.get("distance_km") or 0) * reps
        mins += (rec.get("duration_min") or 0) * reps
    return km, mins


def _segment_detail(seg: dict) -> str:
    """Human detail for a step: distance in km (or m under 1 km) or a time."""
    if seg.get("end") == "distance":
        km = seg.get("distance_km")
        if km is None:
            return ""
        return f"{int(km * 1000)} m" if km < 1 else f"{km:g} km"
    mins = seg.get("duration_min")
    if mins is None:
        return ""
    if mins < 1:
        return f"{int(round(mins * 60))} s"
    return f"{mins:g} min"


def _segments_to_steps(segments: list) -> list:
    """Flatten resolved segments into the detail sheet's step rows, so the
    displayed breakdown IS the compiled structure (the same data the watch
    gets), not a re-derived approximation."""
    out = []
    for seg in segments:
        reps = seg.get("reps") or 1
        label = _STEP_KIND_LABEL.get(seg.get("role"), "Run")
        if reps > 1:
            out.append({"type": "Repeat", "detail": f"{reps}×", "level": 0, "pace": None})
            out.append({"type": label, "detail": _segment_detail(seg),
                        "level": 1, "pace": seg.get("pace_min_per_km")})
            rec = seg.get("recovery")
            if isinstance(rec, dict):
                out.append({"type": _STEP_KIND_LABEL.get(rec.get("role"), "Recover"),
                            "detail": _segment_detail(rec), "level": 1,
                            "pace": rec.get("pace_min_per_km")})
        else:
            out.append({"type": label, "detail": _segment_detail(seg),
                        "level": 0, "pace": seg.get("pace_min_per_km")})
    return out


def _compile_workout(spec: dict, pace_zones: dict, workout_type: str = "") -> dict:
    """Turn a workout spec into the canonical object every consumer reads.

    Resolves each segment's pace from the runner's current fitness zones,
    fills in both distance and duration per segment, and computes the session
    totals once. Also emits the flat `steps` rows for the detail sheet. The
    result carries the fields the frontend already renders (distance_km,
    duration_min, target_pace_min_per_km, steps) plus the new `segments` and
    `totals`, all derived from the same structure.
    """
    spec = dict(spec or {})
    zones = pace_zones or {}
    wtype = (workout_type or spec.get("type") or "Easy").strip()

    raw = spec.get("segments")
    if not isinstance(raw, list) or not raw:
        raw = _default_segments(spec, wtype)

    resolved = []
    for i, seg in enumerate(raw):
        r = _resolve_segment(seg, zones, i + 1)
        if r:
            resolved.append(r)
    if not resolved:
        resolved = [{
            "role": "main", "step": "interval", "end": "distance",
            "distance_km": _parse_float(spec.get("distance_km")) or 5.0,
            "duration_min": None, "effort": None, "pace_min_per_km": None,
            "pace_ms": None, "reps": 1, "order": 1,
        }]

    total_km = round(sum(_segment_contribution(s)[0] for s in resolved), 2)
    total_min = round(sum(_segment_contribution(s)[1] for s in resolved), 1)
    avg_pace = _format_pace_min_km((total_min * 60.0 / total_km) if total_km > 0 else None)

    # Headline pace = the main block's pace (what the session is "about"),
    # falling back to the first paced segment.
    main = next((s for s in resolved if s.get("role") == "main" and s.get("pace_min_per_km")), None)
    headline = (main or next((s for s in resolved if s.get("pace_min_per_km")), {})).get("pace_min_per_km")

    out = dict(spec)
    out["segments"] = resolved
    out["totals"] = {
        "distance_km": total_km or None,
        "duration_min": round(total_min) if total_min else None,
        "avg_pace_min_per_km": avg_pace,
    }
    if total_km:
        out["distance_km"] = total_km
    if total_min:
        out["duration_min"] = round(total_min)
    if headline:
        out["target_pace_min_per_km"] = headline
    out["steps"] = _segments_to_steps(resolved)
    return out


def _build_running_workout(workout: dict):
    """Build a Garmin running workout from a compiled coach-plan workout.

    Steps come straight from the workout's compiled `segments` — the same
    structure the card and detail sheet show — so the watch gets exactly what
    the runner saw. Warm-up / cool-down / recovery steps can end on distance
    OR time, per the segment, and every step carries a pace-zone target
    derived from the runner's current fitness (m/s range, so the pace shows
    on the watch during the run). Returns a RunningWorkout ready for
    client.upload_running_workout().
    """
    from garminconnect.workout import (
        RunningWorkout,
        WorkoutSegment,
        ExecutableStep,
        RepeatGroup,
    )

    title = workout.get("title") or "Run"
    description = workout.get("description") or ""
    segments = workout.get("segments")
    if not isinstance(segments, list) or not segments:
        # Legacy spec without compiled segments — compile it with no zones so
        # the structure is still internally consistent.
        segments = _compile_workout(workout, {}).get("segments") or []

    # Carry the headline pace in the description too, so the watch shows it as
    # text even before the run starts.
    headline = workout.get("target_pace_min_per_km")
    if headline:
        description = (f"{description} Target pace: {headline}/km." if description
                       else f"Target pace: {headline}/km.")

    def make_step(seg, order):
        """One ExecutableStep from a resolved segment. Distance-based steps
        are built directly (the library's warm-up/cool-down helpers only offer
        time), so any role can end on distance or time."""
        step_key = seg.get("step") or "interval"
        if seg.get("end") == "time":
            value = (seg.get("duration_min") or 0) * 60.0
            cond = {"conditionTypeId": 2, "conditionTypeKey": "time",
                    "displayOrder": 2, "displayable": True}
        else:
            value = (seg.get("distance_km") or 0) * 1000.0
            cond = {"conditionTypeId": 3, "conditionTypeKey": "distance",
                    "displayOrder": 3, "displayable": True}
        step = ExecutableStep(
            stepOrder=order,
            stepType={
                "stepTypeId": _STEP_TYPE_IDS.get(step_key, 3),
                "stepTypeKey": step_key,
                "displayOrder": _STEP_TYPE_IDS.get(step_key, 3),
            },
            endCondition=cond,
            endConditionValue=value,
        )
        # Pace target lives ON the step (targetValueOne/Two), not nested in
        # targetType — Garmin discards nested values. valueOne is the faster
        # bound, valueTwo the slower bound.
        pace_ms = seg.get("pace_ms")
        if pace_ms:
            step.targetType = {"workoutTargetTypeId": 6,
                               "workoutTargetTypeKey": "pace.zone", "displayOrder": 1}
            step.targetValueOne = round(pace_ms * 1.06, 4)
            step.targetValueTwo = round(pace_ms * 0.94, 4)
        return step

    steps = []
    order = 1
    for seg in segments:
        reps = seg.get("reps") or 1
        if reps > 1:
            children = [make_step(seg, 1)]
            rec = seg.get("recovery")
            if isinstance(rec, dict):
                children.append(make_step(rec, 2))
            steps.append(RepeatGroup(
                stepOrder=order,
                stepType={"stepTypeId": 6, "stepTypeKey": "repeat", "displayOrder": 6},
                numberOfIterations=reps,
                workoutSteps=children,
            ))
        else:
            steps.append(make_step(seg, order))
        order += 1

    est_min = (workout.get("totals") or {}).get("duration_min") or workout.get("duration_min")
    est_secs = int(est_min * 60) if est_min else 1800

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


def _race_result_paces(goal: dict | None) -> dict | None:
    """Derive training paces from the runner's latest race result — the
    fitness anchor used only when recent history is sparse (live Garmin
    data always wins). Returns a {workout_type: "M:SS"} map, or None when
    no usable race result is stored.

    Uses the same per-type offsets as the goal fallback, but anchored to
    the ACTUAL race pace instead of the aspirational goal pace.
    """
    if not goal:
        return None
    label = (goal.get("fitness_race_distance") or "").strip()
    dist_km = _parse_float(label)
    if not dist_km:
        dist_km = {
            "5K": 5, "10K": 10, "15K": 15, "21.1K": 21.1,
            "Half Marathon": 21.1, "Marathon": 42.2, "42.2K": 42.2,
        }.get(label, 0)
    if not dist_km:
        return None
    total_sec = 0
    try:
        vals = [int(x) for x in str(goal.get("fitness_race_time") or "").split(":")]
        if len(vals) == 3:
            total_sec = vals[0] * 3600 + vals[1] * 60 + vals[2]
        elif len(vals) == 2:
            total_sec = vals[0] * 60 + vals[1]
    except (ValueError, TypeError):
        return None
    if total_sec <= 0:
        return None
    race_sec_per_km = total_sec / dist_km
    offsets = {
        "Recovery": 75, "Easy": 50, "Long Run": 35,
        "Tempo": 5, "Intervals": -30, "Speedwork": -35,
    }
    return {
        t: p for t, p in (
            (t, _format_pace_min_km(race_sec_per_km + off)) for t, off in offsets.items()
        ) if p
    }


def _fitness_samples(history: list[dict]) -> tuple:
    """Bucket recent runs into easy and quality samples, each carrying the
    run itself (so the UI can show which runs produced a pace).

    Quality samples use the lap-level work-rep pace when available — immune
    to stops/pauses between sets dragging a blended average down and
    mis-tagging the session as easy. Returns (easy_samples, fast_samples),
    each a list of {"sec": seconds-per-km, "run": activity}.
    """
    easy, fast = [], []
    for a in history:
        tag = a.get("run_tag") or ""
        laps = a.get("laps")
        if isinstance(laps, dict) and (laps.get("work_lap_count") or 0) > 0:
            work_pace_ms = laps.get("work_avg_pace_ms")
            if work_pace_ms and work_pace_ms > 0:
                fast.append({"sec": 1000 / work_pace_ms, "run": a})
                continue
        pace_ms = a.get("avg_pace") or 0
        if not pace_ms or pace_ms <= 0:
            continue
        sec = 1000 / pace_ms
        # Quality = the classifier's hard sessions; everything else counts as
        # easy. This must cover _classify_run's FULL output domain
        # (Run / Warmup / Tempo Long / LSD / Speedwork / Tempo / Easy).
        # Previously the easy bucket only accepted Easy/Recovery/Warmup/LSD,
        # so a run tagged "Run" (emitted whenever the activity carries no speed
        # data) was dropped from BOTH buckets and surfaced in the UI as
        # "no recent easy/quality runs — goal-based reference only".
        if tag in ("Speedwork", "Tempo", "Tempo Long"):
            fast.append({"sec": sec, "run": a})
        else:
            easy.append({"sec": sec, "run": a})
    return easy, fast


def _long_run_samples(history: list[dict]) -> list:
    """Long-run (endurance) samples — the easy long runs only.

    Endurance is judged on the long runs, not the whole easy bucket: a short
    recovery jog shouldn't stand in for long-run durability. Prefers the
    classifier's long-run tag; falls back to a distance floor. Returns [] when
    the history has no long runs, so the caller can fall back to the easy set.
    """
    out = []
    for a in history:
        tag = a.get("run_tag") or ""
        # Quality sessions and warmups aren't aerobic-endurance evidence
        if tag in ("Speedwork", "Tempo", "Tempo Long", "Warmup"):
            continue
        dist = a.get("distance") or 0
        if tag == "LSD" or (dist and dist >= 12):
            pace_ms = a.get("avg_pace") or 0
            if pace_ms and pace_ms > 0:
                out.append({"sec": 1000 / pace_ms, "run": a})
    return out


def _cap_recent(samples: list, limit: int) -> list:
    """Keep only the most recent `limit` samples.

    History arrives newest-first from both the Garmin fetch and the cache, but
    sort defensively so the cap always drops the OLDEST runs rather than an
    arbitrary slice.
    """
    if not limit or len(samples) <= limit:
        return samples
    return sorted(
        samples,
        key=lambda s: ((s.get("run") or {}).get("start_time") or ""),
        reverse=True,
    )[:limit]


def _fitness_medians(history: list[dict]) -> tuple:
    """Median easy and quality paces (sec/km) from recent runs.

    Quality work uses the lap-level work-rep pace when available — immune to
    stops/pauses between sets dragging a blended average down and mis-tagging
    the session as easy. Returns (easy_sec, fast_sec); either may be None.
    """
    easy, fast = _fitness_samples(history)
    return _median([s["sec"] for s in easy]), _median([s["sec"] for s in fast])


def _pace_range_sec(secs) -> tuple | None:
    """(lo, hi) pace range in seconds-per-km for a sample list.

    Interquartile range (25th-75th percentile) for >= 5 samples so a single
    outlier run cannot stretch it; plain min-max for 2-4 samples (the whole
    spread is honest at that size); None below 2 samples.
    """
    s = sorted(secs)
    n = len(s)
    if n < 2:
        return None
    if n < 5:
        return s[0], s[-1]
    return s[(n - 1) // 4], s[(3 * (n - 1)) // 4]


def _pace_str_sec(pace_str) -> float | None:
    """Parse "M:SS" back to seconds-per-km (for ramp interpolation)."""
    try:
        parts = [int(x) for x in str(pace_str).split(":")]
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
    except (ValueError, TypeError):
        pass
    return None


def _compute_pace_zones(goal_pace_ms: float, history: list[dict], fitness_anchor: dict | None = None, ramp_fraction: float = 0.0) -> dict:
    """Derive per-workout-type target paces from recent fitness + race goal.

    Follows Runna's "train at current fitness, not a rigid goal time" principle:
    recent easy/fast paces are the primary anchor, and the race-goal pace plus
    fixed offsets is only a fallback when recent data is sparse. Fast paces use
    the lap-level work-rep pace when available — immune to stops/pauses between
    sets dragging a session's blended average down and mis-tagging it as easy.

    ramp_fraction (0..1) interpolates every zone linearly from current fitness
    (0) toward the goal-derived value (1) across the block, so training paces
    progress toward the goal instead of staying static. Returns
    {workout_type: "M:SS"} for display; the numeric values are never
    user- or AI-editable.
    """
    goal_sec = 1000 / goal_pace_ms if (goal_pace_ms and goal_pace_ms > 0) else None

    easy_sec, fast_sec = _fitness_medians(history)

    # Offsets from race pace (positive = slower): they define both the
    # goal-derived values (what paces should be at race readiness) and the
    # fallback when a category has no recent runs — anchored to the goal
    # pace, or to the runner's latest race result (fitness anchor).
    offsets = {
        "Recovery": 75,
        "Easy": 50,
        "Long Run": 35,
        "Tempo": 5,
        "Intervals": -30,
        "Speedwork": -35,
    }

    # Current-fitness values (seconds per km)
    fitness = {}
    for wtype, off in offsets.items():
        if wtype == "Recovery" and easy_sec:
            fitness[wtype] = easy_sec + 15
        elif wtype in ("Easy", "Recovery", "Long Run") and easy_sec:
            fitness[wtype] = easy_sec
        elif wtype in ("Tempo", "Intervals", "Speedwork") and fast_sec:
            fitness[wtype] = fast_sec
        elif fitness_anchor and fitness_anchor.get(wtype):
            fitness[wtype] = _pace_str_sec(fitness_anchor[wtype])
        elif goal_sec:
            fitness[wtype] = goal_sec + off  # no data — start at goal-derived
        else:
            fitness[wtype] = None

    # Linear interpolation: fitness at 0, goal-derived at 1
    frac = min(1.0, max(0.0, ramp_fraction))
    zones = {}
    for wtype, off in offsets.items():
        f = fitness.get(wtype)
        if f is None or goal_sec is None:
            zones[wtype] = _format_pace_min_km(f) if f else None
            continue
        g = goal_sec + off
        zones[wtype] = _format_pace_min_km(f + (g - f) * frac)
    # The race-day workout always targets the goal pace itself — a Race
    # workout is the goal effort by definition, never a derived zone.
    if goal_sec:
        zones["Race"] = _format_pace_min_km(goal_sec)
    return zones


def _flatten_workout_steps(workout_dict: dict, pace_zones: dict | None = None, workout_type: str = "", main_pace: str | None = None) -> list[dict]:
    """Flatten a native Garmin workout into readable steps for the UI.

    Garmin's native workout model is workoutSegments -> workoutSteps, where each
    step carries a stepType (warmup/interval/recovery/cooldown/repeat), an
    endCondition (time/distance), and a target. This walks that structure and
    returns a flat list of {type, detail, level} rows the detail sheet can
    render as a numbered procedure. Steps inside a repeat group get level 1 so
    the UI can indent them beneath the "Repeat N×" marker.

    Pace zones (optional) are used to append a target pace to each step's
    detail string, so the runner knows how fast each segment should be:
    - Warm up / Cool down → Easy pace
    - Run (main) → main_pace when given (goal-pace sessions / race day),
      otherwise the workout type's target pace
    - Recover → Recovery pace
    - Rest → no pace (complete rest)
    """
    out = []
    for segment in workout_dict.get("workoutSegments") or []:
        for step in segment.get("workoutSteps") or []:
            _append_workout_step(step, out, 0, pace_zones, workout_type, main_pace)
    return out


def _append_workout_step(step: dict, out: list, level: int, pace_zones: dict | None = None, workout_type: str = "", main_pace: str | None = None):
    step_type = (step.get("stepType") or {}).get("stepTypeKey", "")
    # Repeat groups carry nested workoutSteps and a number of iterations
    if step_type == "repeat":
        iterations = step.get("numberOfIterations", 1)
        out.append({"type": "Repeat", "detail": f"{iterations}×", "level": level, "pace": None})
        for child in step.get("workoutSteps") or []:
            _append_workout_step(child, out, level + 1, pace_zones, workout_type, main_pace)
        return

    cond = (step.get("endCondition") or {}).get("conditionTypeKey", "")
    value = step.get("endConditionValue")
    if cond == "distance":
        detail = f"{value / 1000:g} km"
    elif cond == "time":
        secs = int(value or 0)
        detail = f"{secs // 60} min" if secs >= 60 else f"{secs} s"
    else:
        detail = ""
    kind_map = {
        "warmup": "Warm up",
        "cooldown": "Cool down",
        "interval": "Run",
        "recovery": "Recover",
        "rest": "Rest",
        "main": "Run",
        "other": "Run",
    }
    kind = kind_map.get(step_type, step_type.title())

    # Determine the target pace for this step based on its type:
    # - Warm up / Cool down → Easy pace (always easy effort)
    # - Run (main interval) → the workout type's target pace
    # - Recover → Recovery pace
    # - Rest → no pace (complete rest)
    step_pace = None
    if pace_zones and kind != "Rest":
        if kind in ("Warm up", "Cool down"):
            step_pace = pace_zones.get("Easy")
        elif kind == "Recover":
            step_pace = pace_zones.get("Recovery")
        else:
            step_pace = main_pace or pace_zones.get(workout_type) or pace_zones.get("Easy")

    out.append({"type": kind, "detail": detail, "level": level, "pace": step_pace})
