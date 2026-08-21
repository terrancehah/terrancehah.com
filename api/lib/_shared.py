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
    rewritten routes (e.g. /projects/race-goal-dashboard/api/<function_name>)
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
# functions can read/write session state. The Vercel Upstash integration
# injects env vars with a configurable prefix — we check multiple possible
# names to handle different prefix configurations.
#
# The custom prefix "STORAGE" was set in the Vercel dashboard, so the env
# vars are likely STORAGE_REDIS_REST_URL / STORAGE_REDIS_REST_TOKEN.
# We also check the default UPSTASH_REDIS_REST_* names as a fallback.

_redis_url = (
    os.getenv("STORAGE_REDIS_REST_URL")
    or os.getenv("STORAGE_URL")
    or os.getenv("UPSTASH_REDIS_REST_URL")
)
_redis_token = (
    os.getenv("STORAGE_REDIS_REST_TOKEN")
    or os.getenv("STORAGE_TOKEN")
    or os.getenv("UPSTASH_REDIS_REST_TOKEN")
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
    """Re-create an authenticated Garmin client from stored credentials.

    The Garmin client object cannot be serialized, so it is NOT stored in
    Redis. Each call re-creates the client by logging in with the email
    and password stored in the session. This is the correct serverless
    pattern — stateless functions with external state storage.

    Raises HTTPException(401) if credentials are missing or login fails.
    """
    sess = _get_session(token)
    email = sess.get("email", "")
    password = sess.get("password", "")
    if not email or not password:
        raise HTTPException(
            status_code=401,
            detail="Garmin session not found. Please log in again."
        )

    try:
        client = Garmin(email, password)
        client.login()
        return client
    except Exception:
        raise HTTPException(
            status_code=401,
            detail="Garmin re-authentication failed. Please log in again."
        )
