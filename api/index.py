from projects.fastapi_experiment.main import app

# Vercel auto-detects ASGI applications by looking for an 'app' variable
# No need for Mangum - Vercel handles ASGI natively
