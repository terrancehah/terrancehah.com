"""DELETE /api/logout — End a session and remove it from disk persistence."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from lib._shared import _race_sessions, _save_sessions_to_disk

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


@app.delete("/")
async def logout(token: str = ""):
    """End a session and remove it from disk persistence."""
    if token in _race_sessions:
        del _race_sessions[token]
        _save_sessions_to_disk()
    return JSONResponse(content={"message": "Logged out."})
