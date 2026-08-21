"""GET /api/check-session — Check if a session token is still valid."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import re
from lib._shared import _race_sessions

app = FastAPI()

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


@app.get("/")
async def check_session(token: str = ""):
    """Check if a session token is still valid and return profile info.

    Used by the dashboard on page load to determine whether to show the login
    screen or skip straight to the dashboard. Also applies a UUID check on
    display_name — if it looks like a UUID, fall back to full_name instead.
    This fixes sessions created before the UUID detection was added.
    """
    if not token or token not in _race_sessions:
        return JSONResponse(content={"valid": False})
    sess = _race_sessions[token]
    raw_display = sess.get("display_name", "")
    full_name = sess.get("full_name", "")
    # If display_name looks like a UUID, prefer full_name
    if raw_display and re.match(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        raw_display, re.I
    ):
        display_name = full_name or raw_display
    else:
        display_name = raw_display
    return JSONResponse(content={
        "valid": True,
        "display_name": display_name,
        "full_name": full_name,
        "profile_image_url": sess.get("profile_image_url", ""),
        "email": sess.get("email", ""),
        "device_name": sess.get("device_name", ""),
        "has_race_goal": sess.get("race_goal") is not None,
    })
