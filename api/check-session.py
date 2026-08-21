"""GET /api/check-session — Check if a session token is still valid."""

from fastapi.responses import JSONResponse
import re
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _session_exists, _get_session, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/check-session so routes at "/" match)
app = create_app("check-session")


@app.get("/")
async def check_session(token: str = ""):
    """Check if a session token is still valid and return profile info.

    Used by the dashboard on page load to determine whether to show the login
    screen or skip straight to the dashboard. Also applies a UUID check on
    display_name — if it looks like a UUID, fall back to full_name instead.
    This fixes sessions created before the UUID detection was added.
    """
    if not token or not _session_exists(token):
        return JSONResponse(content={"valid": False})
    sess = _get_session(token)
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
