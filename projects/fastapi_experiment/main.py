from fastapi import FastAPI, Request, Form
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from langchain_core.prompts import PromptTemplate
from langchain_openai import ChatOpenAI
from langfuse import observe
from dotenv import load_dotenv
import os
from datetime import datetime
from typing import List, Optional
from pathlib import Path

try:
    from .models import StudentInfo
    from .utils import student_text, create_persona_prompt
except ImportError:
    from models import StudentInfo
    from utils import student_text, create_persona_prompt

# Handle Vercel's path structure
BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(root_path="/projects/fastapi-experiment")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# ----------------------
# Load environment variables from root
# ----------------------
load_dotenv(dotenv_path=BASE_DIR.parent.parent / ".env")

# ----------------------
# LLM setup
# ----------------------
llm = ChatOpenAI(
    openai_api_key=os.getenv("OPENAI_API_KEY"),
    temperature=0.8,
    model_name="gpt-5-nano"
)


@app.get("/", response_class=HTMLResponse)
async def show_form(request: Request):
    return templates.TemplateResponse("form.html", {"request": request})

# ----------------------
# Endpoint
# ----------------------
@app.post("/persona/", response_class=HTMLResponse)
@observe()  # Langfuse observation decorator for monitoring 
def generate_persona(
    request: Request,
    name: str = Form(...),
    gender: str = Form(...),
    form: str = Form(...),
    school: str = Form(...),
    preferred_language: str = Form(...),
    favourite_subjects: Optional[List[str]] = Form(None),
    study_frequency: str = Form(...)
):

    # Step 1: Create StudentInfo object
    # Ensure favourite_subjects is a list (handle None case)
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

    # Step 3: Build prompt
    prompt_str = create_persona_prompt(text_summary)
    
    # Step 4: Build LCEL chain
    chain = (
        PromptTemplate.from_template(
            prompt_str
        )
        | llm
    )

    # Step 5: Run chain with Langfuse callback
    result = chain.invoke({"text_summary": text_summary})
    
    # Step 6: Extract the AI-generated text from result
    persona_text = result.content if hasattr(result, 'content') else str(result)

    # Step 7: Render the result template
    return templates.TemplateResponse("result.html", {
        "request": request,
        "student_text": text_summary,
        "persona_result": persona_text,
        "timestamp": datetime.now().strftime("%B %d, %Y at %I:%M %p")
    })
