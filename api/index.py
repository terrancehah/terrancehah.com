import sys
from pathlib import Path as _Path

# Add _lib/ to Python path so the langchain shim is found by Langfuse.
# The shim lives in _lib/ (not api/) to avoid Vercel treating it as a serverless function.
sys.path.insert(0, str(_Path(__file__).resolve().parent.parent / "_lib"))

from fastapi import FastAPI, Request, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, StreamingResponse
from langchain_core.prompts import PromptTemplate
from langchain_openai import ChatOpenAI
from langfuse import get_client
from langfuse.langchain import CallbackHandler as LangfuseCallbackHandler
from dotenv import load_dotenv
import os
from datetime import datetime
from typing import List, Optional
from pathlib import Path
from pydantic import BaseModel
import asyncio
import json
from langchain_core.callbacks import AsyncCallbackHandler

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

# Determine root_path based on environment
# In production (Vercel), we're served at /projects/persona
# Locally, we might be at /api or root
root_path = os.getenv("ROOT_PATH", "/projects/persona")

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

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

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
@app.get("/", response_class=HTMLResponse)
async def show_form(request: Request):
    return templates.TemplateResponse("form.html", {"request": request})

@app.post("/persona/stream/", name="generate_persona_stream")
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