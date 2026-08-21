from fastapi import FastAPI, Request, Form, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from langchain_core.prompts import PromptTemplate
from langchain_openai import ChatOpenAI
from langfuse import get_client
from langfuse.langchain import CallbackHandler as LangfuseCallbackHandler
from dotenv import load_dotenv
import os
import base64
import math
from datetime import datetime, date, timedelta
from typing import List, Optional, Dict
from pathlib import Path
from pydantic import BaseModel
import asyncio
import json
import uuid
import traceback
from langchain_core.callbacks import AsyncCallbackHandler
from openai import AsyncOpenAI
from garminconnect import (
    Garmin,
    GarminConnectConnectionError,
    GarminConnectAuthenticationError,
    GarminConnectTooManyRequestsError,
)

# Load environment variables (from .env locally, from Vercel dashboard in production)
load_dotenv()  # Don't specify path - works with both local .env and Vercel env vars

# ----------------------
# Models
# ----------------------
class StudentInfo(BaseModel):
    name: str
    gender: str
    form: str
    school: str
    preferred_language: str
    favourite_subjects: List[str]
    study_frequency: str

# Structured Output Models
class LearningMethod(BaseModel):
    """Individual learning method recommendation"""
    name: str
    icon: str
    rationale: str
    example: str

class PersonaResponse(BaseModel):
    """Complete persona analysis response"""
    persona_summary: str
    learning_methods: List[LearningMethod]

# ----------------------
# Utility Functions
# ----------------------
def student_text(c: StudentInfo) -> str:
    # gender
    gender = (c.gender or "UNDISCLOSED").lower()
    if gender == "male":
        pronoun = "he"
        pronoun2 = "his"
    elif gender == "female":
        pronoun = "she"
        pronoun2 = "her"
    else:
        pronoun = "they"
        pronoun2 = "their"

    intro = (
        f"{c.name} is a {c.gender} student in {c.form}. "
        f"{pronoun.capitalize()} is currently studying in {c.school}."
    )

    # favourite subjects
    favourite_subjects = ""
    if c.favourite_subjects:
        favourite_subjects = f" {pronoun.capitalize()} likes {', '.join(c.favourite_subjects)} subjects."
    
    # study frequency
    study_frequency = ""
    if c.study_frequency:
        study_frequency = f" {pronoun.capitalize()} studies {c.study_frequency}."
    
    # preferred language
    preferred_language = ""
    if c.preferred_language:
        preferred_language = f" {pronoun.capitalize()} prefers {c.preferred_language} as the preferred language."
    
    # final
    paragraph = intro + favourite_subjects + study_frequency + preferred_language
    return paragraph


def create_persona_prompt() -> str:
    return """
You are an expert tutor creating a student persona to assess education needs.

Student Information: {text_summary}

Generate a student persona analysis with this structure:

## Student Persona Summary
[Write a concise paragraph describing the student's personality, study preferences, and life vision]

## Learning Methods Recommendations

For each of the 6 learning methods below, provide analysis:

### 1) Feynman Technique 🧠
**Rationale:** [Why this suits the student based on their subjects/interests]
**Example:** [Specific example using their actual subjects]

### 2) Mnemonic 🎯
**Rationale:** [Why this suits the student]
**Example:** [Specific example with their subjects]

### 3) Visualisation 👁️
**Rationale:** [Why this suits the student]
**Example:** [Specific example with their subjects]

### 4) Contextual 🌍
**Rationale:** [Why this suits the student]
**Example:** [Specific example with their subjects]

### 5) Key Points 🔑
**Rationale:** [Why this suits the student]
**Example:** [Specific example with their subjects]

### 6) Spaced Repetition ⏰
**Rationale:** [Why this suits the student]
**Example:** [Specific example with their subjects]

Rules:
- If student's name is Malay and studying in SMK, conclude Malay is the studying language
- Use English only
- Base recommendations on provided student data only
- Make examples specific to their subjects
    """

# ----------------------
# FastAPI Setup
# ----------------------
BASE_DIR = Path(__file__).resolve().parent
# Templates directory is inside api/ alongside this file
TEMPLATES_DIR = BASE_DIR / "templates"

# Determine root_path based on environment
# In production (Vercel), the FastAPI function is mounted at /api, so all
# incoming paths start with /api — FastAPI strips this prefix before route
# matching (e.g. /api/race-goal/auth becomes /race-goal/auth).
# Locally, we might be at /api or root
root_path = os.getenv("ROOT_PATH", "/api")

app = FastAPI(root_path=root_path)

# Add CORS middleware for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://*.vercel.app",
        "https://terrancehah.com"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# ----------------------
# Running Posture Analyser — GPT-4o Vision
# ----------------------

# System instruction telling the model its role and hard constraints.
POSTURE_SYSTEM_INSTRUCTION = """You are an expert running coach and sports biomechanics analyst.
You analyse side-view running photographs to provide qualitative, actionable feedback on running form.
You base all observations strictly on what is visually evident in the provided images.
You never invent data and never output precise degree measurements.
You always return valid JSON exactly as instructed."""


def build_profile_text(profile: dict) -> str:
    """Convert the runner profile dict into a human-readable text block for the prompt."""
    lines = []
    h = profile.get('height', {})
    if h.get('cm'):
        lines.append(f"Height: {h['cm']} cm")
    w = profile.get('weight', {})
    if w.get('value'):
        lines.append(f"Weight: {w['value']} kg")
    if profile.get('age'):
        lines.append(f"Age: {profile['age']}")
    if profile.get('gender'):
        lines.append(f"Gender: {profile['gender']}")
    vol = profile.get('monthlyVolume', {})
    if vol.get('value'):
        lines.append(f"Monthly running volume: {vol['value']} {vol.get('unit', '')}")
    pace = profile.get('pace', {})
    if pace.get('value'):
        lines.append(f"Training pace: {pace['value']} per {pace.get('unit', '')}")
    if profile.get('experience'):
        lines.append(f"Running experience: {profile['experience']}")
    if profile.get('goal'):
        goal = profile['goal']
        if profile.get('raceDistance'):
            goal += f" ({profile['raceDistance'].upper()}"
            if profile.get('raceDate'):
                goal += f", {profile['raceDate']}"
            goal += ")"
        lines.append(f"Goal: {goal}")
    return "\n".join(lines) if lines else "No profile provided."


def build_posture_prompt(profile_text: str, n_images: int) -> str:
    """Build the structured analysis prompt sent to GPT-4o."""
    return f"""I am providing you with {n_images} side-view running photo(s).

RUNNER PROFILE:
{profile_text}

TASK:

Step 1 — Phase identification: Examine each photo and determine which phase of the running gait cycle it most closely represents:
  • Initial Ground Contact — lead foot first touches the ground
  • Full Stance — body weight directly over the planted foot
  • Toe-Off — trailing foot at maximum extension behind the body
  • Swing Phase — trailing leg swinging forward with the knee raised

Step 2 — Analysis: For each of the 6 elements below, write a qualitative observation based on the most relevant photo(s). Use plain English — no degree angle numbers.
  1. Head & Neck Alignment
  2. Overall Posture & Torso Lean
  3. Arm Swing Mechanics — check elbow angle, whether arms are compact and driving backwards, and specifically whether the hands are carried too high (toward the chest or chin) or crossing the body centreline, as these cause unnecessary shoulder tension.
  4. Hip Extension at Toe-Off
  5. Knee Drive in Swing Phase
  6. Foot Strike Pattern — foot strike type (forefoot / midfoot / heel) and overstriding are TWO SEPARATE findings. First identify the strike type from the ground-contact photo. Then separately assess whether the foot contacts ahead of the centre of mass. Do not automatically assign a worse status just because overstriding is present — a midfoot strike with minor overstriding is "fair", not "attention".

Step 3 — Status per element:
  "good" — efficient technique, no immediate action needed
  "fair" — minor issue worth noting, can be improved gradually
  "attention" — clear issue affecting performance or injury risk

Step 4 — Overall summary: 2–3 sentences covering the runner's main strength and primary area to improve.

Return ONLY valid JSON in exactly this structure. No markdown, no extra text:
{{
  "overall": "string",
  "elements": [
    {{
      "name": "Head & Neck Alignment",
      "status": "good|fair|attention",
      "observation": "2-4 sentences describing what you observe with specific detail",
      "insights": [
        {{ "title": "short label", "chip": "brief descriptor", "text": "1-2 sentences with specific detail" }},
        {{ "title": "short label", "chip": "brief descriptor", "text": "1-2 sentences with specific detail" }}
      ]
    }},
    {{ "name": "Overall Posture & Torso Lean", "status": "...", "observation": "...", "insights": [...] }},
    {{ "name": "Arm Swing Mechanics", "status": "...", "observation": "...", "insights": [...] }},
    {{ "name": "Hip Extension at Toe-Off", "status": "...", "observation": "...", "insights": [...] }},
    {{ "name": "Knee Drive in Swing Phase", "status": "...", "observation": "...", "insights": [...] }},
    {{ "name": "Foot Strike Pattern", "status": "...", "observation": "Must explicitly state forefoot / midfoot / heel strike. Note overstriding if present.", "insights": [...] }}
  ]
}}

If an element cannot be assessed from the available images, note this briefly in the observation field."""


@app.post("/analyse")
async def analyse_posture(
    images: List[UploadFile] = File(...),
    profile: str = Form(default='{}')
):
    """Accept up to 4 side-view running photos and a JSON runner profile, return GPT-4o posture analysis."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OPENAI_API_KEY is not configured."})

    # Cap at 4 images to match the four gait phase slots.
    capped_images = images[:4]
    if not capped_images:
        return JSONResponse(status_code=400, content={"error": "At least one image is required."})

    # Read and base64-encode each image for the vision message.
    image_content = []
    for image_file in capped_images:
        image_bytes = await image_file.read()
        mime = image_file.content_type or "image/jpeg"
        b64 = base64.b64encode(image_bytes).decode("utf-8")
        image_content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{mime};base64,{b64}",
                "detail": "high"
            }
        })

    try:
        profile_obj = json.loads(profile)
    except (json.JSONDecodeError, TypeError):
        profile_obj = {}

    profile_text = build_profile_text(profile_obj)
    prompt_text = build_posture_prompt(profile_text, len(capped_images))

    # Combine the text prompt and all images into a single user turn.
    user_content = [{"type": "text", "text": prompt_text}] + image_content

    try:
        client = AsyncOpenAI(api_key=api_key)
        response = await client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": POSTURE_SYSTEM_INSTRUCTION},
                {"role": "user", "content": user_content}
            ],
            response_format={"type": "json_object"},
            max_tokens=4096,
            temperature=0.3
        )
        result = json.loads(response.choices[0].message.content)
        return JSONResponse(content=result)
    except json.JSONDecodeError as e:
        return JSONResponse(status_code=500, content={"error": "AI returned unparseable JSON.", "detail": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# Debug route to verify path handling
@app.get("/debug")
async def debug_request(request: Request):
    return {
        "base_url": str(request.base_url),
        "url": str(request.url),
        "scope_path": request.scope.get("path"),
        "root_path": request.scope.get("root_path"),
        "env_root_path": os.getenv("ROOT_PATH")
    }

# LLM setup
# We initialize this lazily or inside the function to avoid startup crashes if env vars are missing
def get_llm():
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("WARNING: OPENAI_API_KEY is missing")
        return None
    return ChatOpenAI(
        openai_api_key=api_key,
        temperature=0.8,
        model_name="gpt-5.4-nano",
        streaming=True
    )

@app.get("/", response_class=HTMLResponse)
async def show_form(request: Request):
    return templates.TemplateResponse("form.html", {"request": request})

class SimpleStreamingCallback(AsyncCallbackHandler):
    """Callback for streaming tokens and status updates"""
    
    def __init__(self, event_queue):
        self.event_queue = event_queue
        self.start_time = None
        self.word_count = 0
    
    async def on_llm_start(self, serialized, prompts, **kwargs) -> None:
        self.start_time = datetime.now()
        await self.event_queue.put({
            'type': 'stage',
            'stage': 'thinking',
            'message': 'AI is analyzing your profile...'
        })
    
    async def on_llm_new_token(self, token: str, **kwargs) -> None:
        if self.word_count == 0:
            await self.event_queue.put({
                'type': 'stage',
                'stage': 'streaming',
                'message': 'Generating persona...'
            })
        
        if token.strip():
            self.word_count += len(token.split())
        
        # Send token to frontend
        await self.event_queue.put({
            'type': 'token',
            'content': token
        })
    
    async def on_llm_end(self, response, **kwargs) -> None:
        elapsed = (datetime.now() - self.start_time).total_seconds() if self.start_time else 0
        await self.event_queue.put({
            'type': 'stage',
            'stage': 'complete',
            'message': 'Complete!',
            'elapsed': elapsed
        })

# ----------------------
# Streaming Endpoints
# ----------------------
@app.post("/", name="generate_persona_stream")
async def generate_persona_stream(
    request: Request,
    name: str = Form(...),
    gender: str = Form(...),
    form: str = Form(...),
    school: str = Form(...),
    preferred_language: str = Form(...),
    favourite_subjects: Optional[List[str]] = Form(None),
    study_frequency: str = Form(...)
):
    """Streaming version of persona generation for Vercel timeout handling"""
    
    async def generate_stream():
        try:
            # Stage 2: Processing
            yield f"data: {json.dumps({
                'type': 'stage',
                'stage': 'processing',
                'message': 'Processing student information...'
            })}\n\n"
            
            # Step 1: Create StudentInfo object
            subjects_list = favourite_subjects or []
            
            student = StudentInfo(
                name=name,
                gender=gender,
                form=form,
                school=school,
                preferred_language=preferred_language,
                favourite_subjects=subjects_list,
                study_frequency=study_frequency
            )
            
            # Step 2: Create student text summary
            text_summary = student_text(student)
            
            # Step 3: Send student summary
            yield f"data: {json.dumps({'type': 'summary', 'content': text_summary})}\n\n"
            
            # Step 4: Setup callback and queue
            event_queue = asyncio.Queue()
            callback = SimpleStreamingCallback(event_queue)
            
            # Initialize Langfuse LangChain callback handler for tracing
            langfuse_handler = LangfuseCallbackHandler()
            
            # Step 5: Build prompt
            prompt_str = create_persona_prompt()
            
            # Initialize LLM
            llm = get_llm()
            if not llm:
                raise ValueError("OpenAI API Key not found")
            
            # Step 6: Build LCEL chain (simple text streaming)
            chain = (
                PromptTemplate.from_template(prompt_str)
                | llm
            )
            
            # Step 7: Run chain in background task
            async def run_chain():
                try:
                    # Simple streaming - callback handles tokens
                    # Pass both callbacks: SimpleStreamingCallback for frontend streaming,
                    # LangfuseCallbackHandler for LLM tracing (prompt, output, tokens, cost)
                    async for _ in chain.astream(
                        {"text_summary": text_summary},
                        config={'callbacks': [callback, langfuse_handler]}
                    ):
                        pass
                except Exception as e:
                    await event_queue.put({
                        'type': 'error',
                        'message': str(e)
                    })
                finally:
                    # Flush Langfuse events in serverless environment (Vercel)
                    get_client().flush()

            task = asyncio.create_task(run_chain())
            
            # Step 8: Consume queue and yield events
            while not task.done() or not event_queue.empty():
                try:
                    # Wait for next event
                    event = await asyncio.wait_for(
                        event_queue.get(),
                        timeout=0.1
                    )
                    
                    yield f"data: {json.dumps(event)}\n\n"
                    
                    # If complete or error, we can break after sending
                    if event['type'] == 'stage' and event['stage'] == 'complete':
                        # Send final done marker with timestamp
                        timestamp = datetime.now().strftime("%B %d, %Y at %I:%M %p")
                        yield f"data: {json.dumps({'type': 'done', 'timestamp': timestamp})}\n\n"
                        break
                    
                    if event['type'] == 'error':
                        break
                        
                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
                    break
            
        except Exception as e:
            # Send error to client
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
    
    return StreamingResponse(
        generate_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # Disable nginx buffering
        }
    )


# =============================================================================
# Race Goal Assistant — Garmin + GPT Dashboard
# =============================================================================

# --- In-memory session store ---
# Key: session_token (str), Value: dict with garmin_client, race_goal, etc.
# Sessions are persisted to disk so they survive server restarts.
# The Garmin client object can't be serialized, so it's stored only in memory
# and lazily re-created from saved credentials on the first API call after a restart.
_race_sessions: Dict[str, dict] = {}

# Path to the session persistence file (stored alongside the app, restricted permissions)
_RACE_SESSIONS_FILE = Path(__file__).parent / ".race_sessions.json"


def _save_sessions_to_disk():
    """Persist session metadata (excluding the live Garmin client) to disk.

    Stores email + password so the Garmin client can be re-created after a
    server restart. File permissions are set to 0o600 (owner read/write only)
    to protect credentials, matching the Bodily repo's config.json pattern.
    """
    # Build a serializable copy — exclude the non-serializable Garmin client object
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
        # Restrict permissions — file contains Garmin credentials
        os.chmod(_RACE_SESSIONS_FILE, 0o600)
    except Exception:
        pass  # Non-fatal — sessions still work in-memory


def _load_sessions_from_disk():
    """Load saved sessions from disk on server startup.

    The Garmin client is NOT restored here — it's lazily re-created on the
    first API call that needs it (see _get_garmin_client). This avoids
    re-authenticating all users on startup, which would hit Garmin rate limits.
    """
    if not _RACE_SESSIONS_FILE.exists():
        return
    try:
        with open(_RACE_SESSIONS_FILE, "r") as f:
            saved = json.load(f)
        for token, sess in saved.items():
            # Restore session without the live client — garmin_client is None
            # until _get_garmin_client re-creates it from email + password
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

# --- Pydantic models ---

class GarminAuthRequest(BaseModel):
    email: str
    password: str

class RaceGoalRequest(BaseModel):
    purpose: str          # e.g. "Marathon", "Half Marathon", "10K", "5K"
    distance: str         # e.g. "42.2 km", "21.1 km"
    time_target: str      # e.g. "3:30:00", "1:45:00"
    race_date: str = ""   # optional, ISO format YYYY-MM-DD
    experience: str = ""  # e.g. "intermediate", "beginner", "advanced"
    weekly_mileage: str = ""  # e.g. "40-50 km"

class AnalysisRequest(BaseModel):
    session_token: str

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
    by re-authenticating with the stored credentials. This is lazy — only
    happens on the first API call after a restart, not on startup.
    """
    sess = _get_session(token)
    client = sess.get("garmin_client")
    if client:
        return client

    # Client missing — try to re-create from stored credentials
    email = sess.get("email", "")
    password = sess.get("password", "")
    if not email or not password:
        raise HTTPException(status_code=401, detail="Garmin session not found. Please log in again.")

    try:
        client = Garmin(email, password)
        client.login()
        # Cache the re-created client so subsequent calls don't re-authenticate
        sess["garmin_client"] = client
        return client
    except Exception:
        raise HTTPException(status_code=401, detail="Garmin re-authentication failed. Please log in again.")


# --- POST /race-goal/auth ---
@app.post("/garmin-auth")
async def race_goal_auth(body: GarminAuthRequest):
    """Authenticate with Garmin Connect and create a session."""
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

    # Fetch display name — Bodily pattern: client.display_name + social profile
    display_name = getattr(client, "display_name", None) or body.email.split("@")[0]
    full_name = ""
    profile_image_url = ""
    device_name = ""

    # Social profile for full name + profile image (Bodily pattern)
    try:
        profile = client.connectapi("/userprofile-service/socialProfile")
        if isinstance(profile, dict):
            raw_display = profile.get("displayName") or ""
            full_name = profile.get("fullName") or ""
            # Garmin sometimes returns a UUID as displayName instead of a real name.
            # If displayName looks like a UUID, prefer full_name as the display name.
            import re
            if raw_display and not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', raw_display, re.I):
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

    # Device info — prefer primary device (Bodily pattern)
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


# --- GET /race-goal/check-session ---
@app.get("/check-session")
async def race_goal_check_session(token: str = ""):
    """Check if a session token is still valid."""
    if not token or token not in _race_sessions:
        return JSONResponse(content={"valid": False})
    sess = _race_sessions[token]
    # Apply UUID check — if display_name looks like a UUID, use full_name instead
    # This fixes sessions that were created before the UUID detection was added
    import re
    raw_display = sess.get("display_name", "")
    full_name = sess.get("full_name", "")
    if raw_display and re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', raw_display, re.I):
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


# --- GET /race-goal/activities ---
@app.get("/activities")
async def race_goal_activities(token: str = "", limit: int = 10):
    """Fetch recent activities from Garmin."""
    client = _get_garmin_client(token)
    try:
        activities = client.get_activities(0, limit)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    # Filter to running activities only — exclude hiking, cycling, walking, etc.
    running_types = {"running", "trail_running", "track_running", "treadmill_running", "virtual_run"}
    slim = []
    for a in activities:
        type_key = a.get("activityType", {}).get("typeKey", "unknown")
        if type_key.lower() not in running_types:
            continue
        slim.append({
            "id": a.get("activityId"),
            "name": a.get("activityName", "Unnamed"),
            "type": type_key,
            "start_time": a.get("startTimeLocal"),
            "distance": round(a.get("distance", 0) / 1000, 2),  # metres → km
            "duration": round(a.get("duration", 0) / 60, 1),    # seconds → minutes
            "avg_pace": a.get("averageSpeed", 0),               # m/s
            "avg_hr": a.get("averageHR"),
            "max_hr": a.get("maxHR"),
            "calories": a.get("calories"),
            "elevation_gain": round(a.get("elevationGain", 0), 1),
            "training_effect": a.get("aerobicTrainingEffect"),
            "avg_cadence": a.get("averageRunningCadenceInStepsPerMinute"),
            "elapsed_duration": round(a.get("elapsedDuration", 0) / 60, 1) if a.get("elapsedDuration") else None,
        })
    return JSONResponse(content={"activities": slim})


# --- GET /race-goal/weekly-mileage ---
@app.get("/weekly-mileage")
async def race_goal_weekly_mileage(token: str = "", weeks: int = 12):
    """Fetch running activities for the last N weeks and group by week.

    Uses get_activities_by_date with a date range + running filter so we only
    fetch what's needed for the mileage chart — no need to pull 50+ activities
    just for weekly sums. Returns per-week mileage (km) and run count.
    """
    client = _get_garmin_client(token)

    # Calculate the Monday of 12 weeks ago as the start date
    today = date.today()
    start_date = today - timedelta(days=today.weekday() + (weeks - 1) * 7)
    start_str = start_date.isoformat()
    end_str = today.isoformat()

    try:
        # Fetch only running activities within the date range (built-in pagination)
        activities = client.get_activities_by_date(start_str, end_str, activitytype="running")
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    # Build week buckets keyed by Monday date
    week_buckets = {}
    for i in range(weeks):
        week_start = start_date + timedelta(days=i * 7)
        week_buckets[week_start.isoformat()] = {
            "week_start": week_start.isoformat(),
            "mileage_km": 0.0,
            "run_count": 0,
        }

    # Sum distance and count per week for each running activity
    for a in activities:
        start_time = a.get("startTimeLocal") or a.get("startTimeGMT") or ""
        try:
            act_dt = datetime.strptime(start_time[:19], "%Y-%m-%d %H:%M:%S")
        except (ValueError, IndexError):
            continue
        # Find the Monday of the activity's week
        act_monday = act_dt - timedelta(days=act_dt.weekday())
        key = act_monday.date().isoformat()
        if key in week_buckets:
            week_buckets[key]["mileage_km"] += a.get("distance", 0) / 1000  # m -> km
            week_buckets[key]["run_count"] += 1

    # Round mileage and return as a sorted list (oldest first)
    result = []
    for key in sorted(week_buckets.keys()):
        bucket = week_buckets[key]
        result.append({
            "week_start": bucket["week_start"],
            "mileage_km": round(bucket["mileage_km"], 1),
            "run_count": bucket["run_count"],
        })

    return JSONResponse(content={"weeks": result})


# --- GET /race-goal/metrics ---
@app.get("/metrics")
async def race_goal_metrics(token: str = ""):
    """Fetch aggregated performance metrics — Bodily patterns for Garmin data."""
    client = _get_garmin_client(token)
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    metrics = {
        "vo2max": None,
        "vo2max_date": None,
        "fitness_age": None,
        "training_readiness_score": None,
        "training_readiness_level": None,
        "recovery_time_hrs": None,
        "hrv_status": None,
        "hrv_last_night_avg": None,
        "hrv_weekly_avg": None,
        "resting_hr": None,
        "body_battery": None,
        "sleep_score": None,
        "stress_level": None,
        "weekly_distance": 0,
        "weekly_duration": 0,
        "weekly_runs": 0,
        "total_activities": 0,
        "device_name": "",
    }

    # VO2max — Bodily pattern: 30-day fallback via get_max_metrics
    try:
        for days_back in range(0, 30):
            qdate = (date.today() - timedelta(days=days_back)).isoformat()
            mm = client.get_max_metrics(qdate)
            vo2_val = None
            if isinstance(mm, list) and mm:
                vo2_val = mm[0].get("generic", {}).get("vo2MaxValue")
            elif isinstance(mm, dict):
                vo2_val = mm.get("generic", {}).get("vo2MaxValue")
            if vo2_val is not None:
                metrics["vo2max"] = vo2_val
                metrics["vo2max_date"] = qdate
                break
    except Exception:
        pass

    # Fitness Age — Bodily pattern: get_fitnessage_data with today → yesterday fallback
    # Garmin's /fitnessage-service returns fitnessAge as a decimal (e.g. 22.99).
    # Floor to nearest 0.5 to match Garmin Connect's display (e.g. 22.99 → 22.5).
    try:
        for qdate in [today, yesterday]:
            age_data = client.get_fitnessage_data(qdate)
            if isinstance(age_data, dict):
                fitness_age = age_data.get("fitnessAge")
                if fitness_age is not None:
                    # Floor to nearest 0.5 — mirrors Garmin Connect app display
                    metrics["fitness_age"] = math.floor(fitness_age * 2) / 2
                    break
    except Exception:
        pass

    # Training readiness — Bodily pattern: today → yesterday fallback
    try:
        for qdate in [today, yesterday]:
            tr = client.get_training_readiness(qdate)
            if isinstance(tr, list) and tr:
                score = tr[0].get("score")
                if score is not None:
                    metrics["training_readiness_score"] = score
                    metrics["training_readiness_level"] = tr[0].get("level")
                    recovery_sec = tr[0].get("recoveryTime", 0)
                    metrics["recovery_time_hrs"] = round(recovery_sec / 3600, 1) if recovery_sec else None
                    break
    except Exception:
        pass

    # HRV — Bodily pattern: today → yesterday fallback, capture status + lastNightAvg
    try:
        for qdate in [today, yesterday]:
            hrv = client.get_hrv_data(qdate)
            if isinstance(hrv, dict) and "hrvSummary" in hrv:
                s = hrv["hrvSummary"]
                avg = s.get("lastNightAvg") or s.get("weeklyAvg")
                if avg is not None:
                    metrics["hrv_last_night_avg"] = s.get("lastNightAvg")
                    metrics["hrv_weekly_avg"] = s.get("weeklyAvg")
                    metrics["hrv_status"] = s.get("status")
                    break
    except Exception:
        pass

    # Body Battery — Bodily pattern: today → yesterday fallback, last non-null value
    try:
        for qdate in [today, yesterday]:
            bb = client.get_body_battery(qdate)
            if isinstance(bb, list) and bb:
                values = bb[0].get("bodyBatteryValuesArray", [])
                for pair in reversed(values):
                    if len(pair) >= 2 and pair[1] is not None:
                        metrics["body_battery"] = pair[1]
                        break
                if metrics["body_battery"] is not None:
                    break
    except Exception:
        pass

    # Sleep Score — Bodily pattern: today → yesterday fallback
    try:
        for qdate in [today, yesterday]:
            sleep = client.get_sleep_data(qdate)
            if isinstance(sleep, dict):
                overall = sleep.get("sleepScores", {}).get("overall")
                if isinstance(overall, dict):
                    score = overall.get("value")
                elif isinstance(overall, (int, float)):
                    score = overall
                else:
                    dto = sleep.get("dailySleepDTO", {})
                    overall = dto.get("sleepScores", {}).get("overall", {})
                    score = overall.get("value") if isinstance(overall, dict) else overall
                if score is not None:
                    metrics["sleep_score"] = score
                    break
    except Exception:
        pass

    # Stress Level — Bodily pattern: today → yesterday fallback
    try:
        for qdate in [today, yesterday]:
            stress = client.get_all_day_stress(qdate)
            if isinstance(stress, dict):
                avg = stress.get("avgStressLevel")
                if avg is not None and avg > 0:
                    metrics["stress_level"] = avg
                    break
    except Exception:
        pass

    # Resting HR — from daily summary
    try:
        summary = client.get_user_summary(today)
        metrics["resting_hr"] = summary.get("restingHeartRate")
    except Exception:
        pass

    # Device name from session
    sess = _get_session(token)
    metrics["device_name"] = sess.get("device_name", "")

    # Weekly stats from recent activities
    try:
        activities = client.get_activities(0, 30)
        metrics["total_activities"] = len(activities)

        now = datetime.now()
        week_ago = now.timestamp() - 7 * 86400
        weekly_acts = []
        for a in activities:
            start_str = a.get("startTimeLocal") or a.get("startTimeGMT") or ""
            try:
                act_dt = datetime.strptime(start_str[:19], "%Y-%m-%d %H:%M:%S")
                if act_dt.timestamp() > week_ago:
                    weekly_acts.append(a)
            except (ValueError, IndexError):
                continue

        metrics["weekly_runs"] = len(weekly_acts)
        metrics["weekly_distance"] = round(sum(
            a.get("distance", 0) for a in weekly_acts
        ) / 1000, 1)
        metrics["weekly_duration"] = round(sum(
            a.get("duration", 0) for a in weekly_acts
        ) / 3600, 1)
    except Exception:
        pass

    return JSONResponse(content={"metrics": metrics})


# --- POST /race-goal/onboarding ---
@app.post("/onboarding")
async def race_goal_onboarding(token: str = Form(""), purpose: str = Form(""), distance: str = Form(""),
                                time_target: str = Form(""), race_date: str = Form(""),
                                experience: str = Form(""), weekly_mileage: str = Form(""),
                                mileage_unit: str = Form("km"), gender: str = Form(""),
                                age: str = Form("")):
    """Save the user's race goal via form data."""
    sess = _get_session(token)
    goal = {
        "purpose": purpose,
        "distance": distance,
        "time_target": time_target,
        "race_date": race_date,
        "experience": experience,
        "weekly_mileage": weekly_mileage,
        "mileage_unit": mileage_unit,
        "gender": gender,
        "age": age,
        "saved_at": datetime.now().isoformat(),
    }
    sess["race_goal"] = goal
    # Persist updated race goal to disk
    _save_sessions_to_disk()
    return JSONResponse(content={"message": "Race goal saved.", "goal": goal})


# --- GET /race-goal/analysis ---
@app.get("/analysis")
async def race_goal_analysis(token: str = ""):
    """Generate an AI-powered training analysis based on Garmin data + race goal."""
    sess = _get_session(token)
    client = sess.get("garmin_client")
    race_goal = sess.get("race_goal")

    if not client:
        return JSONResponse(status_code=401, content={"error": "Garmin session not found."})
    if not race_goal:
        return JSONResponse(status_code=400, content={"error": "Race goal not set. Please complete onboarding first."})

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key is not configured."})

    # Gather real data for the AI prompt
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    # Fetch recent activities
    activities_data = []
    weekly_km = 0
    weekly_runs = 0
    try:
        acts = client.get_activities(0, 15)
        now = datetime.now()
        week_ago = now.timestamp() - 7 * 86400

        for a in acts:
            activities_data.append({
                "name": a.get("activityName", ""),
                "type": a.get("activityType", {}).get("typeKey", ""),
                "date": a.get("startTimeLocal", ""),
                "distance_km": round(a.get("distance", 0) / 1000, 2),
                "duration_min": round(a.get("duration", 0) / 60, 1),
                "avg_hr": a.get("averageHR"),
            })

            # Calculate weekly stats
            start_str = a.get("startTimeLocal") or ""
            try:
                act_dt = datetime.strptime(start_str[:19], "%Y-%m-%d %H:%M:%S")
                if act_dt.timestamp() > week_ago:
                    weekly_km += a.get("distance", 0) / 1000
                    weekly_runs += 1
            except (ValueError, IndexError):
                continue
    except Exception as e:
        activities_data = [{"error": str(e)}]

    # VO2max — Bodily pattern: 30-day fallback
    vo2max = "N/A"
    try:
        for days_back in range(0, 30):
            qdate = (date.today() - timedelta(days=days_back)).isoformat()
            mm = client.get_max_metrics(qdate)
            vo2 = None
            if isinstance(mm, list) and mm:
                vo2 = mm[0].get("generic", {}).get("vo2MaxValue")
            elif isinstance(mm, dict):
                vo2 = mm.get("generic", {}).get("vo2MaxValue")
            if vo2 is not None:
                vo2max = vo2
                break
    except Exception:
        pass

    # Training readiness — Bodily: today → yesterday fallback
    readiness_score = "N/A"
    readiness_level = "N/A"
    recovery_hrs = "N/A"
    try:
        for qdate in [today, yesterday]:
            tr = client.get_training_readiness(qdate)
            if isinstance(tr, list) and tr:
                score = tr[0].get("score")
                if score is not None:
                    readiness_score = score
                    readiness_level = tr[0].get("level", "N/A")
                    recovery_sec = tr[0].get("recoveryTime", 0)
                    recovery_hrs = round(recovery_sec / 3600, 1) if recovery_sec else "N/A"
                    break
    except Exception:
        pass

    # HRV — Bodily: today → yesterday fallback
    hrv_status = "N/A"
    hrv_avg = "N/A"
    try:
        for qdate in [today, yesterday]:
            hrv = client.get_hrv_data(qdate)
            if hrv and "hrvSummary" in hrv:
                s = hrv["hrvSummary"]
                avg = s.get("lastNightAvg") or s.get("weeklyAvg")
                if avg is not None:
                    hrv_status = s.get("status", "N/A")
                    hrv_avg = avg
                    break
    except Exception:
        pass

    # Sleep score — Bodily pattern
    sleep_score = "N/A"
    try:
        for qdate in [today, yesterday]:
            sleep = client.get_sleep_data(qdate)
            if isinstance(sleep, dict):
                overall = sleep.get("sleepScores", {}).get("overall")
                score = overall.get("value") if isinstance(overall, dict) else overall
                if score is not None:
                    sleep_score = score
                    break
    except Exception:
        pass

    # Body battery — Bodily pattern
    body_battery = "N/A"
    try:
        for qdate in [today, yesterday]:
            bb = client.get_body_battery(qdate)
            if isinstance(bb, list) and bb:
                values = bb[0].get("bodyBatteryValuesArray", [])
                for pair in reversed(values):
                    if len(pair) >= 2 and pair[1] is not None:
                        body_battery = pair[1]
                        break
                if body_battery != "N/A":
                    break
    except Exception:
        pass

    # Stress level — Bodily pattern
    stress_level = "N/A"
    try:
        for qdate in [today, yesterday]:
            stress = client.get_all_day_stress(qdate)
            if isinstance(stress, dict):
                avg = stress.get("avgStressLevel")
                if avg is not None and avg > 0:
                    stress_level = avg
                    break
    except Exception:
        pass

    # Resting HR
    resting_hr = "N/A"
    try:
        summary = client.get_user_summary(today)
        resting_hr = summary.get("restingHeartRate", "N/A")
    except Exception:
        pass

    # Build the AI prompt
    prompt = f"""You are an expert running coach analysing a runner's recent training data in the context of their race goal.

RACE GOAL:
- Purpose: {race_goal.get('purpose', 'Not specified')}
- Distance: {race_goal.get('distance', 'Not specified')}
- Time Target: {race_goal.get('time_target', 'Not specified')}
- Race Date: {race_goal.get('race_date', 'Not specified')}
- Experience Level: {race_goal.get('experience', 'Not specified')}
- Weekly Mileage: {race_goal.get('weekly_mileage', 'Not specified')}

TRAINING METRICS:
- VO2max: {vo2max}
- Training Readiness Score: {readiness_score}/100 (Level: {readiness_level})
- Recovery Time: {recovery_hrs} hours
- Sleep Score: {sleep_score}/100
- Body Battery: {body_battery}%
- Stress Level: {stress_level}/100
- HRV Status: {hrv_status} (Last Night Avg: {hrv_avg}ms)
- Resting HR: {resting_hr} bpm
- Weekly Distance (calculated): {round(weekly_km, 1)} km
- Weekly Runs (calculated): {weekly_runs}

RECENT ACTIVITIES (last 15):
{json.dumps(activities_data, indent=2)}

TASK:
Write a personalised training summary (3-4 paragraphs) that:
1. Acknowledges the runner's recent training pattern and volume
2. Evaluates progress toward their race goal — are they on track?
3. Highlights one or two strengths visible in the data
4. Identifies one or two areas to focus on in the coming weeks
5. Ends with an encouraging, forward-looking note

Tone: clear, measured, encouraging — like a thoughtful coach. No jargon without explanation. Be honest but constructive. If the data suggests the goal is ambitious, frame it as "here's what it would take" rather than discouragement.

Return ONLY valid JSON:
{{"summary": "your multi-paragraph summary here", "verdict": "on_track|needs_work|insufficient_data", "key_strength": "short strength label", "key_focus": "short focus area label"}}"""

    try:
        ai_client = AsyncOpenAI(api_key=api_key)
        response = await ai_client.chat.completions.create(
            model="gpt-5.6-luna",
            messages=[
                {"role": "system", "content": "You are an expert running coach. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            # gpt-5.6-luna only supports max_completion_tokens + reasoning_effort (no temperature)
            max_completion_tokens=2048,
            reasoning_effort="medium"
        )
        result = json.loads(response.choices[0].message.content)
        return JSONResponse(content=result)
    except json.JSONDecodeError:
        return JSONResponse(status_code=500, content={"error": "AI returned unparseable response."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"AI analysis failed: {str(e)}"})


# --- GET /race-goal/radar ---
@app.get("/radar")
async def race_goal_radar(token: str = ""):
    """Return estimated scores for the 6 race-goal dimensions based on real Garmin data."""
    sess = _get_session(token)
    client = sess.get("garmin_client")
    if not client:
        return JSONResponse(status_code=401, content={"error": "Garmin session not found."})

    today = date.today().isoformat()
    radar = {
        "lactate_threshold": 30,
        "aerobic_endurance": 30,
        "running_economy": 30,
        "strength_durability": 30,
        "vo2max_speed": 30,
        "fatigue_resistance": 30,
    }

    # VO2max — Bodily pattern: 30-day fallback via get_max_metrics
    try:
        for days_back in range(0, 30):
            qdate = (date.today() - timedelta(days=days_back)).isoformat()
            mm = client.get_max_metrics(qdate)
            vo2 = None
            if isinstance(mm, list) and mm:
                vo2 = mm[0].get("generic", {}).get("vo2MaxValue")
            elif isinstance(mm, dict):
                vo2 = mm.get("generic", {}).get("vo2MaxValue")
            if vo2 is not None:
                # Scale: VO2max 35→20, 45→45, 55→70, 65→95
                radar["vo2max_speed"] = min(100, max(10, int((vo2 - 28) * 2.2)))
                break
    except Exception:
        pass

    # Training readiness → fatigue_resistance + running_economy
    try:
        tr = client.get_training_readiness(today)
        if isinstance(tr, list) and tr:
            score = tr[0].get("score", 0)
            radar["fatigue_resistance"] = min(100, max(10, score))
            # Readiness level also influences running economy
            level = (tr[0].get("level") or "").upper()
            if level == "HIGH":
                radar["running_economy"] = 75
            elif level == "MODERATE":
                radar["running_economy"] = 55
            else:
                radar["running_economy"] = 35
    except Exception:
        pass

    # HRV status → lactate_threshold proxy (HRV reflects autonomic balance)
    try:
        hrv = client.get_hrv_data(today)
        if hrv and "hrvSummary" in hrv:
            status = (hrv["hrvSummary"].get("status") or "").upper()
            avg = hrv["hrvSummary"].get("weeklyAvg", 0)
            if status == "BALANCED":
                radar["lactate_threshold"] = min(100, max(20, int(avg * 2.5)))
            elif status == "UNBALANCED":
                radar["lactate_threshold"] = min(70, max(15, int(avg * 2)))
            else:
                radar["lactate_threshold"] = 30
    except Exception:
        pass

    # Calculate weekly stats for aerobic_endurance + strength_durability
    try:
        activities = client.get_activities(0, 30)
        now = datetime.now()
        week_ago = now.timestamp() - 7 * 86400

        weekly_km = 0
        weekly_runs = 0
        for a in activities:
            start_str = a.get("startTimeLocal") or a.get("startTimeGMT") or ""
            try:
                act_dt = datetime.strptime(start_str[:19], "%Y-%m-%d %H:%M:%S")
                if act_dt.timestamp() > week_ago:
                    weekly_km += a.get("distance", 0) / 1000
                    weekly_runs += 1
            except (ValueError, IndexError):
                continue

        # Aerobic endurance from weekly distance: 0km→5, 40km→55, 80km→90
        radar["aerobic_endurance"] = min(100, max(5, int(weekly_km * 1.3)))
        # Strength/durability from weekly run count + distance variety
        if weekly_runs >= 5 and weekly_km > 30:
            radar["strength_durability"] = 70
        elif weekly_runs >= 3:
            radar["strength_durability"] = 50
        else:
            radar["strength_durability"] = 25
    except Exception:
        pass

    return JSONResponse(content={"radar": radar})


# --- GET /race-goal/ai-radar ---
@app.get("/ai-radar")
async def race_goal_ai_radar(token: str = ""):
    """Send recent workout history to GPT for 6-dimension race readiness ratings."""
    sess = _get_session(token)
    client = sess.get("garmin_client")
    race_goal = sess.get("race_goal")

    if not client:
        return JSONResponse(status_code=401, content={"error": "Garmin session not found."})

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    # Gather recent activities for AI context — send 30 for richer analysis
    activities_data = []
    try:
        acts = client.get_activities(0, 30)
        for a in acts:
            activities_data.append({
                "name": a.get("activityName", ""),
                "type": a.get("activityType", {}).get("typeKey", ""),
                "date": a.get("startTimeLocal", ""),
                "distance_km": round(a.get("distance", 0) / 1000, 2),
                "duration_min": round(a.get("duration", 0) / 60, 1),
                "avg_hr": a.get("averageHR"),
                "max_hr": a.get("maxHR"),
                "calories": a.get("calories"),
                "elevation_gain": round(a.get("elevationGain", 0), 1),
                "avg_pace_ms": a.get("averageSpeed"),
                "avg_cadence": a.get("averageRunningCadenceInStepsPerMinute"),
                "training_effect": a.get("aerobicTrainingEffect"),
            })
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    race_goal_text = ""
    if race_goal:
        race_goal_text = f"""
RACE GOAL (this is the target the runner is training toward — evaluate all dimensions in context of this goal):
- Race Type: {race_goal.get('purpose', 'N/A')}
- Distance: {race_goal.get('distance', 'N/A')}
- Time Target: {race_goal.get('time_target', 'N/A')}
- Race Date: {race_goal.get('race_date', 'N/A')}
- Experience Level: {race_goal.get('experience', 'N/A')}
- Current Weekly Mileage: {race_goal.get('weekly_mileage', 'N/A')} {race_goal.get('mileage_unit', 'km')}
"""

    prompt = f"""You are an expert running coach and sports scientist. Evaluate this runner's recent training data and rate their readiness across 6 performance dimensions on a scale of 0–10 (decimals allowed, e.g. 7.5). Address the runner directly as "you" throughout your analysis.

{race_goal_text}
RECENT ACTIVITIES (last 30):
{json.dumps(activities_data, indent=2)}

RATE THESE 6 DIMENSIONS (0–10):
1. **Lactate Threshold** — ability to sustain high-intensity effort without accumulating fatigue. Consider recent tempo/threshold workouts, HR data, and pace consistency at high effort.
2. **Aerobic Endurance** — cardiovascular base and ability to sustain long-duration efforts. Consider weekly volume, long-run frequency, and average HR on easy runs.
3. **Running Economy** — efficiency of movement at a given pace. Consider cadence trends, pace variability, and training consistency.
4. **Strength / Durability** — musculoskeletal resilience and injury resistance. Consider training load consistency, elevation work, and activity variety.
5. **VO₂max / Speed** — maximal oxygen uptake and raw speed potential. Consider high-intensity work, interval sessions, max HR data, and pace peaks.
6. **Fatigue Resistance** — ability to maintain performance under accumulated fatigue. Consider back-to-back workout patterns, recovery indicators, and late-workout pace maintenance.

For each dimension, provide:
- "score": a number from 0–10 (decimals allowed)
- "strengths": 2–3 sentences describing what your recent workout data shows as positive for this dimension — what you are doing well and how it contributes to your race goal. Be specific — reference actual paces, distances, HR values, or workout patterns from the data above.
- "gaps": 2–3 sentences describing where you are falling short for this dimension — what is missing or needs improvement, and how far you are from where you need to be for the race goal and time target. Be specific with data references.

Return ONLY valid JSON:
{{"dimensions": [{{"name": "Lactate Threshold", "score": 0, "strengths": "", "gaps": ""}}, ...]}}"""

    try:
        ai_client = AsyncOpenAI(api_key=api_key)
        response = await ai_client.chat.completions.create(
            model="gpt-5.6-luna",
            messages=[
                {"role": "system", "content": "You are an expert running coach and sports scientist. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            # gpt-5.6-luna only supports max_completion_tokens + reasoning_effort (no temperature)
            # Increased from 1024 to 4096 — 6 dimensions × 4-5 sentences each requires more tokens
            max_completion_tokens=4096,
            reasoning_effort="medium"
        )
        result = json.loads(response.choices[0].message.content)
        return JSONResponse(content=result)
    except json.JSONDecodeError:
        return JSONResponse(status_code=500, content={"error": "AI returned unparseable response."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"AI radar failed: {str(e)}"})


# --- DELETE /race-goal/logout ---
@app.delete("/logout")
async def race_goal_logout(token: str = ""):
    """End a session and remove it from disk persistence."""
    if token in _race_sessions:
        del _race_sessions[token]
        # Update the disk file to remove the logged-out session
        _save_sessions_to_disk()
    return JSONResponse(content={"message": "Logged out."})