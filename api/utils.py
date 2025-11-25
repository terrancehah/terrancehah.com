from pydantic import BaseModel
from typing import Optional
try:
    from .models import StudentInfo
except ImportError:
    from models import StudentInfo
from datetime import datetime

def student_text(c: StudentInfo) -> str:
    """
    Default values if not provided:
    gender -> 'UNDISCLOSED'
    occupation -> 'UNDISCLOSED'
    occupation_field -> 'UNDISCLOSED'
    income -> 'UNDISCLOSED'
    form -> 'UNDISCLOSED'
    school -> 'UNDISCLOSED'
    preferred_language -> 'UNDISCLOSED'
    favourite_subjects -> 'UNDISCLOSED'
    study_frequency -> 'UNDISCLOSED'
    """

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
        Describe the student’s possible personality, study preferences and life vision. 
        From this persona, infer potential learning preferences with the famous 6-types of learning styles,
        Feynman, Mnemonic, Visualisation, Contextual, Key points, and Repitition Learning Methods.
        Explain the rationale for each within the same paragraph.
        
        Apply this preferred language rule:
        - If the student's name is in Malay and studying in SMK, conclude that the student has already mastered Malay as the studying language.
        - Otherwise, conclude that the student is open to non-takaful or conventional products.

        Do not use bullet points or separate sections. 
        Produce the output in English only, and do not add information not present in the customer data.
        
        """
