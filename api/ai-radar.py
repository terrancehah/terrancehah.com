"""GET /api/ai-radar — AI-powered 6-dimension race readiness ratings from GPT."""

from fastapi.responses import JSONResponse
import os
import json
from openai import AsyncOpenAI
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import _get_session, _get_garmin_client, create_app

# create_app() wraps the app with prefix-stripping + CORS middleware for
# Vercel file-based mode (strips /api/ai-radar so routes at "/" match)
app = create_app("ai-radar")


@app.get("/")
async def ai_radar(token: str = ""):
    """Send recent workout history to GPT for 6-dimension race readiness ratings.

    Fetches the last 30 activities from Garmin, builds a prompt that asks the AI
    to rate the runner on a 0–10 scale across 6 performance dimensions (lactate
    threshold, aerobic endurance, running economy, strength/durability, VO2max/speed,
    fatigue resistance), each with specific strengths and gaps referencing real data.
    """
    # _get_garmin_client re-creates the Garmin client from stored credentials
    # (raises 401 if the session is invalid or credentials are missing)
    client = _get_garmin_client(token)
    sess = _get_session(token)
    race_goal = sess.get("race_goal")

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    # Gather recent activities for AI context — send 30 for richer analysis
    activities_data = []
    try:
        acts = client.get_activities(0, 30)
        for a in acts:
            activities_data.append({
                "name": a.get("activityName", ""),
                "type": a.get("activityType", {}).get("typeKey", ""),
                "date": a.get("startTimeLocal", ""),
                "distance_km": round(a.get("distance", 0) / 1000, 2),
                "duration_min": round(a.get("duration", 0) / 60, 1),
                "avg_hr": a.get("averageHR"),
                "max_hr": a.get("maxHR"),
                "calories": a.get("calories"),
                "elevation_gain": round(a.get("elevationGain", 0), 1),
                "avg_pace_ms": a.get("averageSpeed"),
                "avg_cadence": a.get("averageRunningCadenceInStepsPerMinute"),
                "training_effect": a.get("aerobicTrainingEffect"),
            })
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})

    # Build race goal context for the prompt if the user has set one
    race_goal_text = ""
    if race_goal:
        race_goal_text = f"""
RACE GOAL (this is the target the runner is training toward — evaluate all dimensions in context of this goal):
- Race Type: {race_goal.get('purpose', 'N/A')}
- Distance: {race_goal.get('distance', 'N/A')}
- Time Target: {race_goal.get('time_target', 'N/A')}
- Race Date: {race_goal.get('race_date', 'N/A')}
- Experience Level: {race_goal.get('experience', 'N/A')}
- Current Weekly Mileage: {race_goal.get('weekly_mileage', 'N/A')} {race_goal.get('mileage_unit', 'km')}
"""

    prompt = f"""You are an expert running coach and sports scientist. Evaluate this runner's recent training data and rate their readiness across 6 performance dimensions on a scale of 0–10 (decimals allowed, e.g. 7.5). Address the runner directly as "you" throughout your analysis.

{race_goal_text}
RECENT ACTIVITIES (last 30):
{json.dumps(activities_data, indent=2)}

RATE THESE 6 DIMENSIONS (0–10):
1. **Lactate Threshold** — ability to sustain high-intensity effort without accumulating fatigue. Consider recent tempo/threshold workouts, HR data, and pace consistency at high effort.
2. **Aerobic Endurance** — cardiovascular base and ability to sustain long-duration efforts. Consider weekly volume, long-run frequency, and average HR on easy runs.
3. **Running Economy** — efficiency of movement at a given pace. Consider cadence trends, pace variability, and training consistency.
4. **Strength / Durability** — musculoskeletal resilience and injury resistance. Consider training load consistency, elevation work, and activity variety.
5. **VO₂max / Speed** — maximal oxygen uptake and raw speed potential. Consider high-intensity work, interval sessions, max HR data, and pace peaks.
6. **Fatigue Resistance** — ability to maintain performance under accumulated fatigue. Consider back-to-back workout patterns, recovery indicators, and late-workout pace maintenance.

For each dimension, provide:
- "score": a number from 0–10 (decimals allowed)
- "strengths": 2–3 sentences describing what your recent workout data shows as positive for this dimension — what you are doing well and how it contributes to your race goal. Be specific — reference actual paces, distances, HR values, or workout patterns from the data above.
- "gaps": 2–3 sentences describing where you are falling short for this dimension — what is missing or needs improvement, and how far you are from where you need to be for the race goal and time target. Be specific with data references.

Return ONLY valid JSON:
{{"dimensions": [{{"name": "Lactate Threshold", "score": 0, "strengths": "", "gaps": ""}}, ...]}}"""

    try:
        ai_client = AsyncOpenAI(api_key=api_key)
        response = await ai_client.chat.completions.create(
            model="gpt-5.6-luna",
            messages=[
                {"role": "system", "content": "You are an expert running coach and sports scientist. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            # gpt-5.6-luna only supports max_completion_tokens + reasoning_effort (no temperature)
            # Increased from 1024 to 4096 — 6 dimensions × 4-5 sentences each requires more tokens
            max_completion_tokens=4096,
            reasoning_effort="medium"
        )
        result = json.loads(response.choices[0].message.content)
        return JSONResponse(content=result)
    except json.JSONDecodeError:
        return JSONResponse(status_code=500, content={"error": "AI returned unparseable response."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"AI radar failed: {str(e)}"})
