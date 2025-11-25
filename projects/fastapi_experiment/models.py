from pydantic import BaseModel
from typing import Optional, List

# ----------------------
# Pydantic Model
# ----------------------
class CustomerInfo(BaseModel):
    name: str
    gender: str
    occupation: str
    occupation_field: str
    income: float
    age: int
    insurance_type: Optional[str] = None
    insurance_coverage: Optional[float] = None

class StudentInfo(BaseModel):
    name: str
    gender: str
    form: str
    school: str
    preferred_language: str
    favourite_subjects: List[str]
    study_frequency: str
