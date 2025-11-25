from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from projects.fastapi_experiment.main import app as fastapi_experiment_app
import os

app = FastAPI()

# Mount the FastAPI experiment app
# This handles requests to /projects/fastapi-experiment/*
app.mount("/projects/fastapi-experiment", fastapi_experiment_app)

# Mount static files (HTML, CSS, JS)
# We mount it at root "/" to serve the portfolio site.
# html=True allows serving index.html automatically.
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    print("Starting local development server at http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
