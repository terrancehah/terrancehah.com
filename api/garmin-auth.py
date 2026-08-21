"""POST /api/garmin-auth — Authenticate with Garmin Connect and create a session."""

from fastapi.responses import JSONResponse
from datetime import datetime
import uuid
import re
from garminconnect import (
    Garmin,
    GarminConnectConnectionError,
    GarminConnectAuthenticationError,
    GarminConnectTooManyRequestsError,
)
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import GarminAuthRequest, _race_sessions, _save_sessions_to_disk, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/garmin-auth so routes at "/" match)
app = create_app("garmin-auth")


@app.post("/")
async def garmin_auth(body: GarminAuthRequest):
    """Authenticate with Garmin Connect and create a session.

    On success, stores the live Garmin client + credentials in the session store
    so the client can be lazily re-created after a server restart. Also fetches
    the user's display name, profile image, and primary device for the dashboard.
    """
    try:
        client = Garmin(body.email, body.password)
        client.login()
    except GarminConnectAuthenticationError:
        return JSONResponse(status_code=401, content={
            "error": "Invalid Garmin credentials.",
            "detail": "Please double-check your email and password."
        })
    except GarminConnectTooManyRequestsError:
        return JSONResponse(status_code=429, content={
            "error": "Garmin is temporarily blocking login attempts.",
            "detail": "Too many attempts. Please wait 10–15 minutes before trying again."
        })
    except GarminConnectConnectionError as e:
        err_msg = str(e).lower()
        if "429" in err_msg or "rate" in err_msg:
            return JSONResponse(status_code=429, content={
                "error": "Garmin is temporarily blocking login attempts.",
                "detail": "Too many attempts. Please wait 10–15 minutes before trying again."
            })
        return JSONResponse(status_code=502, content={
            "error": "Could not reach Garmin servers.",
            "detail": "Check your internet connection and try again."
        })
    except Exception as e:
        return JSONResponse(status_code=500, content={
            "error": "Something went wrong.",
            "detail": str(e)
        })

    # Create a session — store credentials for lazy re-authentication after restarts
    token = str(uuid.uuid4())
    _race_sessions[token] = {
        "garmin_client": client,
        "email": body.email,
        "password": body.password,
        "race_goal": None,
        "created_at": datetime.now().isoformat(),
    }

    # Fetch display name — fallback to email username if Garmin doesn't provide one
    display_name = getattr(client, "display_name", None) or body.email.split("@")[0]
    full_name = ""
    profile_image_url = ""
    device_name = ""

    # Social profile for full name + profile image
    try:
        profile = client.connectapi("/userprofile-service/socialProfile")
        if isinstance(profile, dict):
            raw_display = profile.get("displayName") or ""
            full_name = profile.get("fullName") or ""
            # Garmin sometimes returns a UUID as displayName instead of a real name.
            # If displayName looks like a UUID, prefer full_name as the display name.
            if raw_display and not re.match(
                r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                raw_display, re.I
            ):
                display_name = raw_display
            elif full_name:
                display_name = full_name
            # If both displayName and full_name are empty/UUID, keep the fallback (email username)
            profile_image_url = (
                profile.get("profileImageUrlLarge")
                or profile.get("profileImageUrlMedium")
                or ""
            )
    except Exception:
        pass

    # Device info — prefer primary device
    try:
        devices = client.get_devices()
        if isinstance(devices, list) and devices:
            primary = next((d for d in devices if d.get("primary")), devices[0])
            device_name = (
                primary.get("productDisplayName")
                or primary.get("deviceName")
                or ""
            )
    except Exception:
        pass

    # Store profile info in session for later use (check-session returns these)
    _race_sessions[token]["display_name"] = display_name
    _race_sessions[token]["full_name"] = full_name
    _race_sessions[token]["profile_image_url"] = profile_image_url
    _race_sessions[token]["device_name"] = device_name

    # Persist session to disk so it survives server restarts
    _save_sessions_to_disk()

    return JSONResponse(content={
        "session_token": token,
        "display_name": display_name,
        "full_name": full_name,
        "profile_image_url": profile_image_url,
        "device_name": device_name,
        "message": "Authenticated successfully."
    })
