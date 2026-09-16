"""POST /api/garmin-auth — Authenticate with Garmin Connect and create a session."""

from fastapi.responses import JSONResponse
from datetime import datetime
import uuid
import re
import time
import logging
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

from lib._shared import GarminAuthRequest, _save_session, _update_session, _get_persistent_race_goal, _get_persistent_ai_cache, _get_persistent_coach_cache, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/garmin-auth so routes at "/" match)
app = create_app("garmin-auth")


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------
#
# GarminConnectAuthenticationError is NOT a synonym for "wrong password". The
# library raises that same class for a locked account, for session-setup
# failures ("JWT_WEB cookie not set after ticket consumption") and for
# token-exchange failures ("DI token exchange failed for all client IDs").
# Reporting those as bad credentials is simply false, so we only claim bad
# credentials on positive evidence and report everything else as Garmin having
# refused the sign-in.

_CREDENTIAL_HINTS = (
    "invalid username or password",
    "invalid username",
    "invalid user credentials",
    "incorrect username",
)
_LOCKED_HINTS = ("locked", "account error", "disabled", "suspended")


def _classify_auth_error(message: str) -> str:
    """Classify an authentication failure: mfa | locked | credentials | refused."""
    msg = (message or "").lower()
    if "mfa" in msg:
        return "mfa"
    if any(h in msg for h in _LOCKED_HINTS):
        return "locked"
    if any(h in msg for h in _CREDENTIAL_HINTS):
        return "credentials"
    # The widget flow quotes the page title verbatim, e.g.
    # "Widget authentication failed: 'Invalid'".
    if "widget authentication failed" in msg and ("invalid" in msg or "incorrect" in msg):
        return "credentials"
    return "refused"


def _rate_limited_response():
    return JSONResponse(status_code=429, content={
        "error": "Garmin is temporarily blocking login attempts.",
        "detail": "Too many attempts. Please wait 10–15 minutes before trying again."
    })


def _connection_error_response(err: Exception):
    """Turn a connection-layer failure into the right answer.

    Rate limiting is checked first because the library reports it through this
    class too when only some strategies were throttled.
    """
    msg = str(err).lower()
    if "429" in msg or "rate limit" in msg or "rate-limit" in msg:
        return _rate_limited_response()
    print(f"garmin-auth: all login strategies exhausted: {err}")
    return JSONResponse(status_code=502, content={
        "error": "Garmin turned the sign-in away.",
        "detail": "This is usually Garmin's bot protection rather than your password. Wait a few minutes and try again."
    })


def _auth_error_response(err: Exception):
    """Turn an authentication failure into honest, specific copy."""
    kind = _classify_auth_error(str(err))
    if kind == "mfa":
        # An MFA problem that is not a wrong code — usually a stale or missing
        # session. The runner starts the login again rather than being told
        # their password is wrong.
        return _mfa_expired_response()
    if kind == "locked":
        return JSONResponse(status_code=403, content={
            "error": "Garmin has locked this account.",
            "detail": "Garmin is refusing sign-in for this account. Reset it at Garmin Connect, then try again."
        })
    if kind == "credentials":
        return JSONResponse(status_code=401, content={
            "error": "Invalid Garmin credentials.",
            "detail": "Please double-check your email and password."
        })
    print(f"garmin-auth: authentication failed for a non-credential reason: {err}")
    return JSONResponse(status_code=502, content={
        "error": "Garmin refused the sign-in.",
        "detail": "This is not your password — Garmin turned the request away. Wait a few minutes and try again."
    })


# ---------------------------------------------------------------------------
# Pending two-factor logins
# ---------------------------------------------------------------------------
#
# The password step can come back needing a code, and the library completes that
# on the SAME client instance: it holds the live TLS-impersonating session from
# the password step, which is not serializable. A serverless function has no
# general way to carry that between two requests, so it is held on the instance
# here. Instances are reused for a while, so this works most of the time; when
# it doesn't (cold start, or a different instance), the runner is told to start
# again rather than left with an obscure failure.
_MFA_PENDING: dict = {}
_MFA_TTL_SECONDS = 300
_MFA_MAX_PENDING = 50


def _stash_mfa_client(client, email: str) -> str:
    """Hold a half-finished login until the code comes back.

    Keyed by a random token rather than the email, so one runner's pending login
    cannot be resumed by anyone else. Expired entries are dropped on every stash
    so a busy instance cannot grow without bound.
    """
    now = time.time()
    for stale in [k for k, v in _MFA_PENDING.items() if now - v["at"] > _MFA_TTL_SECONDS]:
        _MFA_PENDING.pop(stale, None)
    while len(_MFA_PENDING) >= _MFA_MAX_PENDING:
        _MFA_PENDING.pop(next(iter(_MFA_PENDING)), None)

    token = uuid.uuid4().hex
    _MFA_PENDING[token] = {"client": client, "email": email, "at": now}
    return token


def _mfa_challenge_response(client, email: str):
    """The password step succeeded, but Garmin wants a two-factor code."""
    return JSONResponse(status_code=409, content={
        "error": "Garmin sent you a two-factor code.",
        "detail": "Enter the code Garmin just sent you to finish signing in.",
        "mfa_required": True,
        "mfa_token": _stash_mfa_client(client, email),
    })


def _mfa_expired_response():
    return JSONResponse(status_code=409, content={
        "error": "That two-factor step expired.",
        "detail": "Please enter your email and password again to get a new code.",
        "mfa_expired": True,
    })


@app.post("/")
async def garmin_auth(body: GarminAuthRequest):
    """Authenticate with Garmin Connect and create a session.

    Two calls for an account with two-factor enabled: the password step answers
    409 with an mfa_token, and the code step sends that token back along with
    the code. Accounts without 2FA finish in one call, exactly as before.
    """
    # Second step — a code for a login already in progress.
    if body.mfa_token:
        return await _resume_mfa_login(body)

    if not body.email or not body.password:
        return JSONResponse(status_code=400, content={
            "error": "Email and password are required."
        })

    try:
        # return_on_mfa is a CONSTRUCTOR argument on Garmin, not a login() one:
        # the wrapper stores it and forwards it to the inner client's login().
        # Calling client.login(return_on_mfa=True) raises TypeError.
        client = Garmin(body.email, body.password, return_on_mfa=True)
        # In this mode the wrapper returns early with ("needs_mfa", None) when
        # Garmin wants a code, instead of blocking on a prompt. So two-factor is
        # a value we handle rather than an error we have to interpret.
        outcome, _ = client.login()
    except GarminConnectAuthenticationError as e:
        return _auth_error_response(e)
    except GarminConnectTooManyRequestsError:
        return _rate_limited_response()
    except GarminConnectConnectionError as e:
        return _connection_error_response(e)
    except Exception as e:
        # Log the raw exception for debugging, but keep the user-facing
        # message plain — tracebacks are not runner-facing copy.
        print(f"garmin-auth unexpected error: {e}")
        return JSONResponse(status_code=500, content={
            "error": "Could not reach Garmin. Please try again in a few minutes."
        })

    if outcome == "needs_mfa":
        return _mfa_challenge_response(client, body.email)

    return await _finish_login(client, body.email)


async def _resume_mfa_login(body: GarminAuthRequest):
    """Complete a two-factor login with the code Garmin sent."""
    # One shot: popped so the same token cannot be replayed.
    entry = _MFA_PENDING.pop(body.mfa_token, None)
    if not entry:
        return _mfa_expired_response()

    client = entry["client"]
    try:
        client.resume_login(None, body.mfa_code)
    except GarminConnectAuthenticationError as e:
        # garminconnect >= 0.3.13 keeps the pending session alive after a bad
        # code, so a corrected retry works on the same instance. Put it back and
        # let the runner fix the code rather than restarting the whole login.
        _MFA_PENDING[body.mfa_token] = entry
        if "mfa" in str(e).lower() or "verification" in str(e).lower():
            return JSONResponse(status_code=409, content={
                "error": "That code did not work.",
                "detail": "Check the code Garmin sent and try again.",
                "mfa_required": True,
                "mfa_token": body.mfa_token,
            })
        return _auth_error_response(e)
    except GarminConnectTooManyRequestsError:
        _MFA_PENDING[body.mfa_token] = entry
        return _rate_limited_response()
    except GarminConnectConnectionError as e:
        return _connection_error_response(e)
    except Exception as e:
        print(f"garmin-auth mfa resume error: {e}")
        return JSONResponse(status_code=500, content={
            "error": "Could not finish the two-factor step. Please start again."
        })

    return await _finish_login(client, body.email or entry.get("email", ""))


async def _finish_login(client, email: str):
    """Create the session from an authenticated Garmin client.

    Stores OAuth tokens (NOT the password) for lazy re-authentication. The
    Garmin client object is not serializable, but its token state is: serialized
    via client.dumps() and restored via login(tokenstore=...) without ever
    sending the password again. The library auto-refreshes the DI token, so
    sessions stay alive long-term and we avoid credential logins that trip
    Garmin's login-attempt rate limit.
    """
    tokens_json = None
    try:
        tokens_json = client.client.dumps()
    except Exception:
        # Token serialization is a simple json.dumps of three fields — if it
        # ever fails, log and proceed without credentials so the user must
        # re-login rather than us storing the plaintext password.
        logging.getLogger("garmin-auth").exception("Failed to serialize Garmin tokens")

    token = str(uuid.uuid4())
    # Check if the user already has a race goal from a previous session.
    # Race goals are persisted by email in Redis, decoupled from the session
    # lifecycle, so they survive logout and session expiry. If found, load
    # it into the new session so the user skips onboarding on re-login.
    existing_goal = _get_persistent_race_goal(email)
    session_data = {
        "email": email,
        "race_goal": existing_goal,
        "created_at": datetime.now().isoformat(),
    }
    if tokens_json:
        session_data["tokens"] = tokens_json
    _save_session(token, session_data)

    # Fetch display name — fallback to email username if Garmin doesn't provide one
    display_name = getattr(client, "display_name", None) or email.split("@")[0]
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
    _update_session(token, {
        "display_name": display_name,
        "full_name": full_name,
        "profile_image_url": profile_image_url,
        "device_name": device_name,
    })

    # Fetch cached AI insights and coach plan from the persistent email-keyed
    # stores so a new device can render the full dashboard instantly without
    # waiting for expensive AI calls. These may be None if no cache exists yet.
    cached_ai = _get_persistent_ai_cache(email) if existing_goal else None
    cached_coach = _get_persistent_coach_cache(email) if existing_goal else None

    return JSONResponse(content={
        "session_token": token,
        "display_name": display_name,
        "full_name": full_name,
        "profile_image_url": profile_image_url,
        "device_name": device_name,
        "has_race_goal": existing_goal is not None,
        "race_goal": existing_goal,
        "cached_ai_insights": cached_ai["data"] if cached_ai else None,
        "cached_coach_plan": cached_coach["data"] if cached_coach else None,
        "message": "Authenticated successfully."
    })
