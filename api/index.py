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

class StreamRequest(BaseModel):
    text_summary: str

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


def create_persona_prompt(text_summary: str) -> str:
    return f"""
        
        You are an expert tutor creating a student persona to assess education needs.

        Student Information: {text_summary}

        Based on the information above, generate a single-paragraph persona summary (maximum 400 words). 
        Describe the student's possible personality, study preferences and life vision. 
        From this persona, infer potential learning preferences with the famous 6-types of learning styles,
        Feynman, Mnemonic, Visualisation, Contextual, Key points, and Repitition Learning Methods.
        Explain the rationale for each within the same paragraph.
        
        Apply this preferred language rule:
        - If the student's name is in Malay and studying in SMK, conclude that the student has already mastered Malay as the studying language.
        - Otherwise, conclude that the student is open to non-takaful or conventional products.

        Do not use bullet points or separate sections. 
        Produce the output in English only, and do not add information not present in the customer data.
        
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
        model_kwargs={"reasoning_effort": "minimal"}
    )

# ----------------------
# Endpoints
# ----------------------
@app.get("/", response_class=HTMLResponse)
async def show_form(request: Request):
    return templates.TemplateResponse("form.html", {"request": request})

@app.post("/", response_class=HTMLResponse)
@observe()
def render_result_page(
    request: Request,
    name: str = Form(...),
    gender: str = Form(...),
    form: str = Form(...),
    school: str = Form(...),
    preferred_language: str = Form(...),
    favourite_subjects: Optional[List[str]] = Form(None),
    study_frequency: str = Form(...)
):
    # Create StudentInfo object
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
    
    # Create student text summary
    text_summary = student_text(student)

    # Return the result page immediately with the text summary
    return templates.TemplateResponse("result.html", {
        "request": request,
        "student_text": text_summary,
        "timestamp": datetime.now().strftime("%B %d, %Y at %I:%M %p")
    })

@app.post("/generate-stream")
async def generate_stream(request: StreamRequest):
    # Initialize LLM here
    llm = get_llm()
    if not llm:
        return StreamingResponse(
            iter(["Error: OpenAI API Key is missing in environment variables."]), 
            media_type="text/plain"
        )

    # Build prompt
    prompt_str = create_persona_prompt(request.text_summary)
    
    # Build LCEL chain
    chain = (
        PromptTemplate.from_template(prompt_str)
        | llm
    )

    # Generator function for streaming
    async def event_generator():
        try:
            async for chunk in chain.astream({"text_summary": request.text_summary}):
                if hasattr(chunk, 'content'):
                    yield chunk.content
                else:
                    yield str(chunk)
        except Exception as e:
            yield f"Error during generation: {str(e)}"

    return StreamingResponse(event_generator(), media_type="text/plain")