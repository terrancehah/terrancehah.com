# FastAPI Experiment

This is a FastAPI project that uses LangChain and LangFuse to generate student personas.

## Setup

1.  Navigate to this directory:
    ```bash
    cd projects/fastapi-experiment
    ```

2.  Create a virtual environment:
    ```bash
    python3 -m venv venv
    source venv/bin/activate
    ```

3.  Install dependencies:
    ```bash
    pip install -r requirements.txt
    ```

4.  Run the application:
    ```bash
    uvicorn main:app --reload
    ```

## Vercel Deployment

This project is configured to run on Vercel as a Serverless Function. The entry point is `api/fastapi_app.py`, and rewrites are handled in `vercel.json` at the root of the repository.
