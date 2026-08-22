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
            - Current Weekly Mileage: {race_goal.get('weekly_mileage', 'N/A')} {race_goal.get('mileage_unit', 'km')}
        """

    prompt = f"""You are an expert running coach and sports scientist. 
    Evaluate this runner's recent training data and rate their readiness across 6 performance dimensions on a scale of 0–10 (decimals allowed in increment of 0.5, e.g. 7.5). 
    Address the runner directly as "you" throughout your analysis.

    SCORING PHILOSOPHY (strictly follow this):
- Be conservative and evidence-based. Only award high scores when the workout data clearly supports them.
- A score of 7.0 means the runner is roughly on track for the stated race goal with normal training progression.
- 8.0–8.5 means they are ahead of schedule or showing strong specific fitness for the goal.
- 9.0+ is rare and requires clear, repeated evidence of superior readiness.
- Below 6.0 indicates a meaningful gap that needs addressing before race day.
- Do not inflate scores out of politeness. Prefer under-rating when evidence is weak, missing, or inconsistent.
- Always interpret the data relative to the specific race goal and time target provided above.

{race_goal_text}

RECENT ACTIVITIES (last 30):
{json.dumps(activities_data, indent=2)}

1. **Lactate Threshold** — Ability to sustain near-goal intensity without excessive fatigue accumulation.
    Scoring anchors:
    - 9–10: Multiple recent sessions clearly showing ability to hold goal race pace (or faster) for meaningful durations with controlled heart rate.
    - 7–8: Solid tempo/threshold work near goal pace, or ability to hold goal pace for 20–40 minutes.
    - 5–6: Some threshold work exists but is too short, too slow relative to goal, or shows significant HR drift.
    - ≤4: Little to no quality work near goal intensity.

2. **Aerobic Endurance** — Cardiovascular base and ability to sustain long-duration efforts at conversational effort.
    Scoring anchors:
    - 9–10: Strong weekly volume + consistent long runs that clearly support the race distance and time goal.
    - 7–8: Adequate volume and long-run frequency for the goal, with mostly controlled easy effort.
    - 5–6: Volume or long-run quality is only borderline for the goal distance/time.
    - ≤4: Clearly insufficient aerobic volume or long-run stimulus for the target race.

3. **Running Economy** — Movement efficiency at a given pace, especially near goal pace.
    Scoring anchors:
    - 9–10: Stable, efficient mechanics (cadence + pace consistency) at or near goal pace across multiple sessions.
    - 7–8: Generally good efficiency on easy and moderate runs, with reasonable economy at goal intensity.
    - 5–6: Noticeable variability in cadence or rising HR at paces close to goal.
    - ≤4: Clear signs of poor efficiency or high energy cost at relevant paces.

4. **Strength / Durability** — Musculoskeletal resilience and ability to handle training load without breakdown.
    Scoring anchors:
    - 9–10: Consistent training load, good elevation/hill work, and evidence of structural resilience.
    - 7–8: Solid load consistency and some strength stimulus (hills, longer efforts).
    - 5–6: Training is present but lacks variety, progression, or shows early signs of strain.
    - ≤4: Inconsistent load, limited strength stimulus, or concerning fatigue patterns.

5. **VO₂max / Speed** — Maximal aerobic capacity and speed reserve above goal pace.
    Scoring anchors:
    - 9–10: Clear, repeated high-intensity work showing meaningful speed reserve above goal pace.
    - 7–8: Some quality interval or speed work that demonstrates useful speed reserve.
    - 5–6: Limited true high-intensity stimulus; speed reserve is unclear or marginal.
    - ≤4: Almost no dedicated speed/VO₂max development relevant to the goal.

6. **Fatigue Resistance** — Ability to maintain performance quality under accumulated fatigue.
    Scoring anchors:
    - 9–10: Strong evidence of maintaining pace/effort on tired legs (back-to-back hard days, late-run stability).
    - 7–8: Reasonable ability to absorb training and still perform on subsequent days.
    - 5–6: Performance drops noticeably when fatigue accumulates.
    - ≤4: Clear inability to handle consecutive quality sessions or late-race fatigue.

For each dimension, provide:
- "score": number from 0–10 (0.5 increments allowed)
- "summary": 3 sentences giving a high-level overview of your rating for this dimension. Do NOT cite specific paces, distances, heart rates, cadences, or workout names — keep it general and qualitative (e.g. "Your threshold work is developing but needs longer efforts"). This summary is shown as a quick read on the home dashboard.
- "strengths": 2–3 sentences describing what the recent data shows as positive. You must reference specific paces, distances, heart rates, cadences, or workout patterns from the activities above.
- "gaps": 2–3 sentences describing the shortfalls relative to the race goal. Again, reference specific data. Explain how far the current level is from what the goal requires.

Important rules:
- Be specific in strengths and gaps. Generic comments without numbers from the data are not acceptable.
- Keep the summary general — no specific numbers. It should give the runner a quick sense of where they stand without the detailed evidence.
- Keep strengths and gaps focused only on that dimension.
- Do not invent data that is not present in the activities list.

Return ONLY valid JSON:
{{"dimensions": [{{"name": "Lactate Threshold", "score": 0, "summary": "", "strengths": "", "gaps": ""}}, ...]}}"""

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
