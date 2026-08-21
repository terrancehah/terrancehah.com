"""DELETE /api/logout — End a session and remove it from disk persistence."""

from fastapi.responses import JSONResponse
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _race_sessions, _save_sessions_to_disk, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/logout so routes at "/" match)
app = create_app("logout")


@app.delete("/")
async def logout(token: str = ""):
    """End a session and remove it from disk persistence."""
    if token in _race_sessions:
        del _race_sessions[token]
        _save_sessions_to_disk()
    return JSONResponse(content={"message": "Logged out."})
