from fastapi import FastAPI, Request, Form
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, StreamingResponse
from langchain_core.prompts import PromptTemplate
from langchain_openai import ChatOpenAI
from langfuse import observe
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

        Based on the information above, generate a student persona summary. 
        Describe the student’s possible personality, study preferences and life vision in one concise paragraph. 
        Then from this persona, infer potential learning preferences with the famous 6-types of learning styles,
        Feynman, Mnemonic, Visualisation, Contextual, Key points, and Repitition Learning Methods.
        Explain the rationale and proper examples for each learning method in suitable headings and paragraphs.
        
        Apply this preferred rule if conditions are met:
        - If the student's name is in Malay and studying in SMK, conclude that Malay is the studying language.
        - Otherwise, conclude that Malay is not the primary studying language.

        Produce the output in English only, and do not add information not present in the student data.
        
        """

# ----------------------
# FastAPI Setup
# ----------------------
BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(root_path="/api")
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
        model_name="gpt-5-nano",
        streaming=True
    )

@app.get("/", response_class=HTMLResponse)
async def show_form(request: Request):
    return templates.TemplateResponse("form.html", {"request": request})

class SimpleStreamingCallback(AsyncCallbackHandler):
    """Minimal callback for stage indicators"""
    
    def __init__(self, event_queue):
        self.event_queue = event_queue
        self.word_count = 0
        self.start_time = None
    
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
        
        # Count words
        if token.strip():
            self.word_count += len(token.split())
        
        # Send token
        await self.event_queue.put({
            'type': 'token',
            'content': token,
            'word_count': self.word_count
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
@observe()  # Langfuse observation decorator for monitoring
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
            
            # Step 5: Build prompt
            prompt_str = create_persona_prompt()
            
            # Initialize LLM
            llm = get_llm()
            if not llm:
                raise ValueError("OpenAI API Key not found")
            
            # Step 6: Build LCEL chain
            chain = (
                PromptTemplate.from_template(prompt_str)
                | llm
            )
            
            # Step 7: Run chain in background task
            async def run_chain():
                try:
                    # We use astream but rely on the callback for events
                    # We iterate to ensure execution, but ignore the direct chunks
                    # as the callback handles them
                    async for _ in chain.astream(
                        {"text_summary": text_summary},
                        config={'callbacks': [callback]}
                    ):
                        pass
                except Exception as e:
                    await event_queue.put({
                        'type': 'error',
                        'message': str(e)
                    })
                finally:
                    # Signal done if not already handled (though on_llm_end should handle it)
                    # We can send a sentinel if needed, but on_llm_end is better
                    pass

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