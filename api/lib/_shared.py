"""Shared module for all race-goal API endpoints.

This file lives in api/lib/ so Vercel doesn't treat it as a serverless
function (only .py files directly in api/ become functions). It contains
the session store, Garmin client helpers, and Pydantic models used across
all race-goal endpoint files.
"""

import os
import json
import uuid
from datetime import datetime, date, timedelta
from typing import Dict
from pathlib import Path
from pydantic import BaseModel
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from garminconnect import (
    Garmin,
    GarminConnectConnectionError,
    GarminConnectAuthenticationError,
    GarminConnectTooManyRequestsError,
)

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

# --- In-memory session store ---
# Key: session_token (str), Value: dict with garmin_client, race_goal, etc.
# Sessions are persisted to disk so they survive server restarts.
# The Garmin client object can't be serialized, so it's stored only in memory
# and lazily re-created from saved credentials on the first API call after a restart.
_race_sessions: Dict[str, dict] = {}

# Path to the session persistence file (stored in /tmp for Vercel serverless,
# which is the only writable directory in production)
_RACE_SESSIONS_FILE = Path("/tmp/.race_sessions.json")


def _save_sessions_to_disk():
    """Persist session metadata (excluding the live Garmin client) to disk.

    Stores email + password so the Garmin client can be re-created after a
    server restart. In production (Vercel), /tmp is the only writable directory.
    """
    serializable = {}
    for token, sess in _race_sessions.items():
        serializable[token] = {
            "email": sess.get("email", ""),
            "password": sess.get("password", ""),
            "race_goal": sess.get("race_goal"),
            "created_at": sess.get("created_at", ""),
            "display_name": sess.get("display_name", ""),
            "full_name": sess.get("full_name", ""),
            "profile_image_url": sess.get("profile_image_url", ""),
            "device_name": sess.get("device_name", ""),
        }
    try:
        with open(_RACE_SESSIONS_FILE, "w") as f:
            json.dump(serializable, f, indent=2)
    except Exception:
        pass  # Non-fatal — sessions still work in-memory


def _load_sessions_from_disk():
    """Load saved sessions from disk on server startup.

    The Garmin client is NOT restored here — it's lazily re-created on the
    first API call that needs it (see _get_garmin_client).
    """
    if not _RACE_SESSIONS_FILE.exists():
        return
    try:
        with open(_RACE_SESSIONS_FILE, "r") as f:
            saved = json.load(f)
        for token, sess in saved.items():
            _race_sessions[token] = {
                "garmin_client": None,
                "email": sess.get("email", ""),
                "password": sess.get("password", ""),
                "race_goal": sess.get("race_goal"),
                "created_at": sess.get("created_at", ""),
                "display_name": sess.get("display_name", ""),
                "full_name": sess.get("full_name", ""),
                "profile_image_url": sess.get("profile_image_url", ""),
                "device_name": sess.get("device_name", ""),
            }
    except Exception:
        pass  # Corrupt file — start fresh


# Load persisted sessions when the module initializes
_load_sessions_from_disk()


# --- Session helpers ---

def _get_session(token: str) -> dict:
    """Retrieve session or raise 401."""
    sess = _race_sessions.get(token)
    if not sess:
        raise HTTPException(status_code=401, detail="Session expired or invalid. Please log in again.")
    return sess


def _get_garmin_client(token: str) -> Garmin:
    """Retrieve the authenticated Garmin client from a session.

    If the client is missing (e.g. after a server restart where the session
    was restored from disk but the live client couldn't be), re-create it
    by re-authenticating with the stored credentials.
    """
    sess = _get_session(token)
    client = sess.get("garmin_client")
    if client:
        return client

    email = sess.get("email", "")
    password = sess.get("password", "")
    if not email or not password:
        raise HTTPException(status_code=401, detail="Garmin session not found. Please log in again.")

    try:
        client = Garmin(email, password)
        client.login()
        sess["garmin_client"] = client
        return client
    except Exception:
        raise HTTPException(status_code=401, detail="Garmin re-authentication failed. Please log in again.")
