"""Main FastAPI entrypoint — imports and mounts all API sub-apps.

Vercel's FastAPI framework preset detects this file (api/index.py) as the
single entrypoint and routes all /api/* requests to this app. In production,
Vercel strips the /api prefix from the path and sets root_path="/api" in the
ASGI scope, so a request to /api/garmin-auth arrives here as /garmin-auth.

Each sub-app (garmin-auth.py, metrics.py, etc.) is a standalone FastAPI app
with its own routes mounted at "/". We import them via importlib (to handle
hyphenated filenames) and mount each one at its respective path, e.g.:

app.mount("/garmin-auth", garminAuthApp)

When a request hits /garmin-auth, Starlette strips the mount prefix and
forwards "/" to the sub-app, which matches its @app.post("/") or @app.get("/")
route handler.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import importlib.util
import os
import sys

# Add the api/ directory to Python's search path so sub-apps can find lib._shared
# when loaded by this entrypoint (Vercel's cwd is the project root, not api/)
api_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, api_dir)

# root_path tells FastAPI about the /api prefix for URL generation (OpenAPI docs).
# In production, Vercel strips /api from the path before it reaches this app.
# Locally, uvicorn serves at root so there's no prefix to strip.
root_path = os.getenv("ROOT_PATH", "/api")

app = FastAPI(root_path=root_path)

# CORS on the parent app covers all mounted sub-apps
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


def _load_sub_app(filename):
    """Import a .py file from the api/ directory and return its FastAPI app.

    Uses importlib to handle hyphenated filenames (e.g., garmin-auth.py,
    check-session.py) that can't be imported with normal Python import
    statements, which don't allow hyphens in module names.
    """
    filepath = os.path.join(api_dir, filename)
    mod_name = filename.replace('.py', '').replace('-', '_')
    spec = importlib.util.spec_from_file_location(mod_name, filepath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.app


# Mount each sub-app at its respective path
# The mount path matches the filename (minus .py extension).
# Vercel strips /api in production → /garmin-auth matches the mount → sub-app sees /
app.mount("/garmin-auth", _load_sub_app("garmin-auth.py"))
app.mount("/check-session", _load_sub_app("check-session.py"))
app.mount("/onboarding", _load_sub_app("onboarding.py"))
app.mount("/ai-radar", _load_sub_app("ai-radar.py"))
app.mount("/metrics", _load_sub_app("metrics.py"))
app.mount("/radar", _load_sub_app("radar.py"))
app.mount("/activities", _load_sub_app("activities.py"))
app.mount("/weekly-mileage", _load_sub_app("weekly-mileage.py"))
app.mount("/logout", _load_sub_app("logout.py"))
app.mount("/analyse", _load_sub_app("analyse.py"))