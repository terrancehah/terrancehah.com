"""GET /api/ai-radar — AI-powered 6-dimension race readiness ratings from GPT."""

from fastapi.responses import JSONResponse
import os
import json
from openai import AsyncOpenAI
# Add the api/ directory to Python's search path so lib._shared can be found
# when running as a Vercel serverless function (cwd is project root, not api/)
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lib._shared import (
    _get_session, _get_garmin_client, create_app,
    _get_cached_garmin_data, _fetch_physio_trends, _fetch_activities_for_ai,
)

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
    # Validate session and get race goal (no Garmin client needed yet)
    sess = _get_session(token)
    race_goal = sess.get("race_goal")

    api_key = os.getenv("RACE_GOAL_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse(status_code=500, content={"error": "OpenAI API key not configured."})

    # Try the Redis cache first — metrics.py populates this cache during the
    # same page load, so in the common case we read from Redis and make zero
    # Garmin API calls. On cache miss (first visit, expiry, local dev without
    # Redis), we fall back to fetching directly from Garmin.
    cached = _get_cached_garmin_data(token)

    if cached:
        activities_data = cached.get("activities", [])
        physio = cached.get("physio", {})
    else:
        # Cache miss — create a Garmin client and fetch everything directly.
        # This is the fallback path; the common path is the cache hit above.
        client = _get_garmin_client(token)
        try:
            activities_data = _fetch_activities_for_ai(client, limit=30)
        except Exception as e:
            return JSONResponse(status_code=502, content={"error": f"Failed to fetch activities: {str(e)}"})
        physio = _fetch_physio_trends(client, days=60)

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

    # Build physiological data text for the prompt — only include sections
    # that have actual data (non-null, non-empty) to keep the prompt lean
    physio_parts = []

    if physio.get("vo2max_trend"):
        physio_parts.append(f"VO2MAX TREND (60-day history — shows aerobic capacity direction):\n{json.dumps(physio['vo2max_trend'], indent=2)}")

    if physio.get("hrv_trend"):
        physio_parts.append(f"HRV TREND (60-day history — nightly heart rate variability; declining trend signals accumulating fatigue):\n{json.dumps(physio['hrv_trend'], indent=2)}")

    if physio.get("rhr_trend"):
        physio_parts.append(f"RESTING HR TREND (60-day history — declining RHR = improving fitness; rising RHR = possible overtraining/illness):\n{json.dumps(physio['rhr_trend'], indent=2)}")

    if physio.get("sleep_trend"):
        physio_parts.append(f"SLEEP TREND (60-day history — sleep quality and duration impact recovery):\n{json.dumps(physio['sleep_trend'], indent=2)}")

    if physio.get("lactate_threshold"):
        physio_parts.append(f"LACTATE THRESHOLD (latest Garmin estimate — requires chest strap; null values mean not measured):\n{json.dumps(physio['lactate_threshold'], indent=2)}")

    if physio.get("endurance_trend"):
        physio_parts.append(f"ENDURANCE SCORE TREND (60-day history — Garmin's composite aerobic endurance estimate):\n{json.dumps(physio['endurance_trend'], indent=2)}")

    physio_text = "\n\n".join(physio_parts) if physio_parts else "No physiological trend data available."

    prompt = f"""You are an expert running coach and sports scientist. 
Evaluate this runner's recent training data and rate their readiness across 6 performance dimensions on a scale of 0–10 (no decimals allowed). 
Address the runner directly as "you" throughout your analysis.

SCORING PHILOSOPHY (strictly follow this):
- Be conservative and evidence-based. Only award high scores when the data (both activities AND physiological trends) clearly supports them.
- A score of 7.0 means the runner is roughly on track for the stated race goal with normal training progression.
- 8.0 means they are ahead of schedule or showing strong specific fitness for the goal.
- 9.0+ is rare and requires clear, repeated evidence of superior readiness.
- Below 6.0 indicates a meaningful gap that needs addressing before race day.
- Do not inflate scores out of politeness. Prefer under-rating when evidence is weak, missing, or inconsistent.
- Always interpret the data relative to the specific race goal and time target provided above.
- Use physiological trend data (VO2max, HRV, RHR, sleep) to validate or question what the activity data suggests. If physiological trends contradict activity data, weigh the physiological data more heavily — the body's recovery signals don't lie.
- Prioritise multi-day or weekly trends in HRV, RHR and sleep over single-day values. A single bad night of sleep or one low-HRV reading is noise; a week-long decline is a signal.

TONE & FEEDBACK STYLE (important):
- Be honest but constructive and supportive. You are a coach who wants the runner to succeed.
- When the score is 7.0 or above, the overall tone should feel encouraging and affirming.
- When writing "gaps", frame them as clear opportunities for improvement rather than pure shortcomings. Focus on what can be developed next and why it will help the race goal.
- Avoid overly critical or discouraging language. Even when pointing out limitations, keep the tone forward-looking.
- Strengths should feel genuinely positive and specific.

{race_goal_text}

RECENT ACTIVITIES (last 30):
{json.dumps(activities_data, indent=2)}

PHYSIOLOGICAL DATA (60-day history — use these trends to cross-reference and deepen your analysis):
{physio_text}

1. **Lactate Threshold** — Ability to sustain near-goal intensity without excessive fatigue accumulation.
   Primary evidence: continuous or near-continuous work at/near goal pace, HR control at that intensity, and the duration of threshold efforts. Prioritise sessions where the runner held a sustained pace — not intervals with rest breaks.
   Scoring anchors:
   - 9–10: Multiple recent sessions clearly showing ability to hold goal race pace (or faster) for meaningful durations with controlled heart rate.
   - 7–8: Solid tempo/threshold work near goal pace, or ability to hold goal pace for 20–40 minutes.
   - 5–6: Some threshold work exists but is too short, too slow relative to goal, or shows significant HR drift.
   - ≤4: Little to no quality work near goal intensity.
   - If lactate threshold data is present, use it as ground truth to anchor your assessment.

2. **Aerobic Endurance** — Cardiovascular base and ability to sustain long-duration efforts at conversational effort.
   Primary evidence: long run quality at controlled effort, weekly volume, and how easy the easy runs actually are (pace + HR on easy days). Focus on the longest runs and the weekly mileage pattern — not speed sessions.
   Scoring anchors:
   - 9–10: Strong weekly volume + consistent long runs + improving or stable VO2max trend that clearly supports the race distance and time goal.
   - 7–8: Adequate volume and long-run frequency for the goal, with mostly controlled easy effort. VO2max trend is stable or improving.
   - 5–6: Volume or long-run quality is only borderline for the goal distance/time. VO2max may be flat or declining.
   - ≤4: Clearly insufficient aerobic volume or long-run stimulus for the target race, with weak or declining VO2max trend.
   - Use the endurance score trend and VO2max trend to validate your assessment of aerobic development.

3. **Running Economy** — Movement efficiency at a given pace, especially near goal pace.
   Primary evidence: cadence stability across runs, HR cost at a given pace (HR-to-pace ratio), and consistency of mechanics — especially near goal pace or on tired legs. Compare the HR required to hold a similar pace across different sessions to detect efficiency changes.
   Physiological data has limited value for this dimension — rely primarily on activity efficiency signals (cadence stability, HR-to-pace ratio, pace consistency).
   Scoring anchors:
   - 9–10: Stable, efficient mechanics (cadence + pace consistency) at or near goal pace across multiple sessions.
   - 7–8: Generally good efficiency on easy and moderate runs, with reasonable economy at goal intensity.
   - 5–6: Noticeable variability in cadence or rising HR at paces close to goal.
   - ≤4: Clear signs of poor efficiency or high energy cost at relevant paces.

4. **Strength / Durability** — Musculoskeletal resilience and ability to handle training load without breakdown.
   Primary evidence: elevation gain, back-to-back loading (hard session followed by another session), ability to absorb hard sessions without breaking down, and recovery signals (HRV/RHR/sleep) in the days after high load. Look for hill work and consecutive training days — not single flat easy runs.
   Scoring anchors:
   - 9–10: Consistent training load, good hill work, and strong recovery capacity in HRV/sleep trends.
   - 7–8: Solid load consistency and some strength stimulus (hills, longer efforts). Recovery metrics are generally stable.
   - 5–6: Training lacks variety or progression, or shows early strain in HRV/sleep data.
   - ≤4: Inconsistent load, limited strength stimulus, or concerning fatigue patterns in physiological data.

5. **VO₂max / Speed** — Maximal aerobic capacity and speed reserve above goal pace.
   Primary evidence: clear speed reserve (how much faster than goal pace the runner can run), quality of high-intensity work (intervals, repeats), and repeatability of fast efforts within a session. Focus on the fastest sessions and the gap between those paces and goal pace — not endurance volume.
   Scoring anchors:
   - 9–10: Clear, repeated high-intensity work showing meaningful speed reserve above goal pace, supported by an improving VO2max trend.
   - 7–8: Some quality interval or speed work that demonstrates useful speed reserve. VO2max trend is stable or slightly improving.
   - 5–6: Limited true high-intensity stimulus; speed reserve is unclear or marginal. VO2max trend may be flat.
   - ≤4: Almost no dedicated speed/VO₂max development relevant to the goal, with weak or declining VO2max.
   - The VO2max trend is the primary physiological validator for this dimension — a declining VO2max should pull the score down even if workouts look decent.

6. **Fatigue Resistance** — Ability to maintain performance quality under accumulated fatigue.
   Primary evidence: performance on consecutive days (back-to-back sessions), late-run pace maintenance (does pace hold in the final third of long runs?), and how well the runner bounces back — cross-reference HRV/RHR/sleep trends with next-day performance. Look for patterns across multiple days, not single workouts.
   Scoring anchors:
   - 9–10: Maintains pace/effort on tired legs (back-to-back hard days, late-run stability). HRV balanced/improving, RHR stable or declining, sleep consistently good.
   - 7–8: Absorbs training and performs on subsequent days. Recovery metrics show normal variation without concerning trends.
   - 5–6: Performance drops when fatigue accumulates. HRV declining, RHR rising, or sleep inconsistent.
   - ≤4: Cannot handle consecutive quality sessions. Recovery metrics show strong negative trends.
   - HRV, RHR, and sleep trends are the PRIMARY evidence sources here. Cross-reference recovery with workout quality on days following poor recovery.

For each dimension, provide:
- "score": integer from 0–10 (no decimals)
- "summary": 2–3 sentences giving a high-level overview of your rating. Keep it general and qualitative (no specific paces, distances, or heart rates). Make the tone constructive. If the score is 7.0 or higher, the summary should feel reassuring and forward-looking.
- "strengths": 2–3 sentences describing what the recent data shows as positive. You must reference specific data from the activities AND/OR physiological trends above (paces, distances, heart rates, cadences, VO2max values, HRV trends, RHR trends, sleep scores).
- "gaps": 2–3 sentences describing the areas that can still be improved relative to the race goal. Reference specific data. Frame these as clear next opportunities rather than pure shortcomings.

Important rules:
- Be specific in strengths and gaps. Generic comments without numbers from the data are not acceptable.
- Keep the summary general — no specific numbers.
- Keep strengths and gaps focused only on that dimension.
- Do not invent data that is not present in the activities list or physiological data.
- When physiological data contradicts activity data, explain the tension and explain why you weighted one more heavily.
- If physiological data is sparse or missing for a dimension, note that in your assessment and rely more heavily on activity data.
- Maintain a supportive coaching tone throughout.

EVIDENCE SELECTION (critical — follow strictly):
- Each dimension has a "Primary evidence" line above. When choosing which sessions and data points to cite in strengths/gaps, prioritise evidence that matches that dimension's primary focus.
- Minimise repeating the same workout across dimensions. If a session is the best evidence for dimension A, try your best not to also use it as the lead evidence for dimension B — find a different session or physiological trend instead. Some overlap is unavoidable, but the same run should not anchor more than two or three dimensions.
- Before citing a session, ask: "Is this the most relevant proof for THIS dimension, or am I just picking the most impressive/recent run?" If another session is more dimension-specific, use that instead.
- Spread your evidence across the available activities. With 30 activities provided, there should be enough variety to give each dimension its own supporting sessions rather than defaulting to the same 2–3 runs for everything.

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
        # Enforce integer scores (0–10) — the prompt asks for no decimals, but
        # round defensively in case the model returns 0.5 increments anyway.
        for dim in result.get("dimensions", []):
            if isinstance(dim.get("score"), (int, float)):
                dim["score"] = max(0, min(10, round(dim["score"])))
        return JSONResponse(content=result)
    except json.JSONDecodeError:
        return JSONResponse(status_code=500, content={"error": "AI returned unparseable response."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"AI radar failed: {str(e)}"})
