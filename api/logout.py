"""DELETE /api/logout — End a session and remove it from Redis."""

from fastapi.responses import JSONResponse
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys, os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _delete_session, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/logout so routes at "/" match)
app = create_app("logout")


@app.delete("/")
async def logout(token: str = ""):
    """End a session and remove it from the session store (Redis or local)."""
    _delete_session(token)
    return JSONResponse(content={"message": "Logged out."})
