"""POST /api/analyse — Running posture analysis via GPT-4o Vision."""

from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from typing import List
import os
import base64
import json
from openai import AsyncOpenAI

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


@app.post("/")
async def analyse_posture(
    images: List[UploadFile] = File(...),
    profile: str = Form(default='{}')
):
    """Accept up to 4 side-view running photos and a JSON runner profile, return GPT-4o posture analysis."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OPENAI_API_KEY is not configured."})

    capped_images = images[:4]
    if not capped_images:
        return JSONResponse(status_code=400, content={"error": "At least one image is required."})

    image_content = []
    for image_file in capped_images:
        image_bytes = await image_file.read()
        mime = image_file.content_type or "image/jpeg"
        b64 = base64.b64encode(image_bytes).decode("utf-8")
        image_content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"}
        })

    try:
        profile_obj = json.loads(profile)
    except (json.JSONDecodeError, TypeError):
        profile_obj = {}

    profile_text = build_profile_text(profile_obj)
    prompt_text = build_posture_prompt(profile_text, len(capped_images))
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
