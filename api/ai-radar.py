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
    _compute_goal_pace_ms,
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
            # Pass goal pace so speedwork sessions get lap details attached
            goal_pace_ms = _compute_goal_pace_ms(race_goal)
            activities_data = _fetch_activities_for_ai(client, limit=30, goal_pace_ms=goal_pace_ms)
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

    # Heart-rate context — the AI must judge whether a bpm is high/low for
    # THIS runner, never by population averages. Prefer Garmin's personalized
    # zones; fall back to the highest max HR observed across recent activities.
    hr_context_parts = []
    hr_profile = physio.get("heart_rate_profile")
    if hr_profile:
        profile_bits = []
        if hr_profile.get("max_hr") is not None:
            profile_bits.append(f"Max HR: {hr_profile['max_hr']} bpm")
        if hr_profile.get("resting_hr") is not None:
            profile_bits.append(f"Resting HR: {hr_profile['resting_hr']} bpm")
        if hr_profile.get("threshold_hr") is not None:
            profile_bits.append(f"Threshold HR: {hr_profile['threshold_hr']} bpm")
        zones = hr_profile.get("zones") or []
        if zones:
            profile_bits.append("Zones: " + ", ".join(
                f"Z{z['zone']} {z['min']}-{z['max']} bpm" for z in zones
            ))
        if profile_bits:
            hr_context_parts.append(
                "HEART RATE PROFILE (personalized — judge whether a bpm is high/low FOR THIS RUNNER using these values):\n"
                + "\n".join(f"- {b}" for b in profile_bits)
            )
    if not hr_context_parts:
        # Fallback anchor: highest max HR seen in the recent activities list
        hr_values = [
            a.get("max_hr") for a in activities_data
            if isinstance(a.get("max_hr"), (int, float))
        ]
        if hr_values:
            observed_max_hr = max(hr_values)
            hr_context_parts.append(
                "HEART RATE PROFILE (observed):\n"
                f"- Highest observed max HR across recent activities: {observed_max_hr} bpm "
                "(no personalized Garmin zones available — treat this as a rough ceiling "
                "and interpret heart rates cautiously)"
            )
    if hr_context_parts:
        physio_parts.append("\n\n".join(hr_context_parts))

    physio_text = "\n\n".join(physio_parts) if physio_parts else "No physiological trend data available."

    prompt = f"""You are a running coach. Rate this runner's readiness for their race goal across 6 dimensions on a 0–10 integer scale. Address the runner as "you".

    {race_goal_text}

    RECENT ACTIVITIES (last 30):
    {json.dumps(activities_data, indent=2)}

    PHYSIOLOGICAL DATA (60-day trends):
    {physio_text}

SCORING
    - Conservative and evidence-based. Do not inflate scores.
    - 7 = on track for this goal with normal training.
    - 8 = ahead of schedule or clearly strong for the goal.
    - 9–10 = rare; needs repeated, clear evidence.
    - 6 = usable but a real limiter remains.
    - 5 or below = this area needs focused work before race day.
    - Judge everything against the race goal and time target.
    - Use physiological trends (VO2max, HRV, RHR, sleep) to confirm or challenge the workouts. If they disagree, trust the body-signal trend more than one good session.
    - Use weekly trends, not one-off days. One bad sleep or one low HRV reading is noise.
    - Interpret heart rate only against the HEART RATE PROFILE (percent of max and zones). Never call a bpm high or low in the abstract. For your own reasoning you may use % of max and zone. In the written output, pick only one form: "comfortably hard", "easy zone", or a single bpm.

PACE: avg_pace_ms is metres per second. Convert before writing: sec/km = 1000 / avg_pace_ms, then MM:SS/km. Never write m/s. Check the maths before saying faster or slower than goal pace.

LAPS: If a session has laps, work_avg_pace_ms / rest_avg_pace_ms, use work-lap pace as the real effort. Do not treat a session as easy just because the blended average looks slow.

DIMENSIONS
For each dimension, use only its primary evidence as the lead proof. Do not let the same run anchor more than two dimensions.

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

Each dimension:
    - score: integer 0–10
    - "summary": 2–3 sentences giving a high-level overview of your rating. Keep it general and qualitative (no specific paces, distances, or heart rates). Refer to the writing style section below for response style reference.
    - "strengths": 2–3 sentences describing what the recent data shows as positive. You must reference specific data from the activities AND/OR physiological trends above (paces, distances, heart rates, cadences, VO2max values, HRV trends, RHR trends, sleep scores). Refer to the writing style section below for response style reference.
    - "gaps": 2-3 sentences describing the areas that can still be improved relative to the race goal. Reference specific data if available. Frame these as clear next opportunities rather than pure shortcomings. Refer to the writing style section below for response style reference.

OVERALL INSIGHT:
After scoring all six dimensions, synthesize across them to produce a single overall assessment. This is the coach's top-level view — not a repeat of any one dimension, but a holistic judgment that weighs all six together and tells the runner where they stand overall and what to focus on next.

The "overall" object must contain:
    - "verdict": a short label (3–6 words) summarizing overall readiness. Examples: "On track, with work to do", "Ahead of schedule", "Significant gap to close".
    - "score": integer 0–10 — the overall readiness score. This is NOT a simple average of the six dimension scores. Weigh the dimensions by their importance to the specific race goal and time target. For example, aerobic endurance matters more for a marathon than a 5K.
    - "summary": 3–4 sentences synthesizing across all six dimensions into one narrative. Tell the runner where they stand overall, what their biggest asset is, and what the main gap is. Do not repeat individual dimension summaries — synthesize. Refer to the writing style section below for response style reference.
    - "topStrength": an object with "label" (the dimension name that is the runner's biggest strength) and "note" (2–3 sentences explaining why this is their top strength and what it means for race day, referencing specific data).
    - "topGap": an object with "label" (the dimension name that is the runner's biggest gap) and "note" (2–3 sentences explaining why this is their biggest gap and what fixing it would do for their race, referencing specific data).
    - "focus": 2–3 sentences describing the single most impactful action the runner should take next. Pick the one change that would most improve their race readiness. Be specific — name the session type, the pace, the frequency. Refer to the writing style section below for response style reference.

WRITING STYLE AND RULES:
    - Write like a good running coach texting a club runner, not like a sports scientist writing a report.
    - Make the tone constructive. If the score is 7 or higher, the summary should feel reassuring and forward-looking.
    - Meaning first, proof second. Max two numbers per sentence; one is better.
    - First sentence of strengths and gaps must make sense with zero jargon.
    - Use runner words: easy / conversational, comfortably hard / race effort, a gear faster than race pace, bounced back the next day.
    - If you mention a zone, write "Zone 2 (easy)" not "Z2".
    - Never write m/s. Always MM:SS/km or "X seconds per km quicker/slower than goal pace".
    - Do not cite missing data as a weakness. No "HRV was not provided", "lactate threshold estimate unavailable", "sleep data missing".
    - Do not use jargons like physiological validation, training effect 4.5, profile value, blended session data, accumulated load. Keep things simple.
    - Strengths answer: what does this mean for the race goal?
    - Gaps answer: what should they do next, and why?
    - Do not invent data.rgd-sidebar-goal
    - Keep each dimension to its own evidence. Spread citations across the 30 activities. Before citing a run, ask whether it is the best proof for THIS dimension.
    - For heart rate, pick one only: "easy", "comfortably hard", "about 80% of your max", or "164 bpm". Never stack datas or specific like bpm + % + zone + date + pace in one sentence.
    - The overall insight must not just repeat dimension summaries. It should read as a coach stepping back and looking at the whole picture.

OUTPUT FORMAT:
    Return ONLY valid JSON:
    {{"dimensions": [{{"name": "Lactate Threshold", "score": 0, "summary": "", "strengths": "", "gaps": ""}}, ...], "overall": {{"verdict": "", "score": 0, "summary": "", "topStrength": {{"label": "", "note": ""}}, "topGap": {{"label": "", "note": ""}}, "focus": ""}}}}
"""

    try:
        ai_client = AsyncOpenAI(api_key=api_key)
        response = await ai_client.chat.completions.create(
            model="gpt-5.6-luna",
            messages=[
                {"role": "system", "content": "You are an expert running coach. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            # gpt-5.6-luna only supports max_completion_tokens + reasoning_effort (no temperature)
            # 6 dimensions × 4-5 sentences each + overall insight (verdict, summary,
            # topStrength, topGap, focus) requires more tokens than the dimensions alone.
            max_completion_tokens=5120,
            reasoning_effort="medium"
        )
        result = json.loads(response.choices[0].message.content)
        # Enforce integer scores (0–10) — the prompt asks for no decimals, but
        # round defensively in case the model returns 0.5 increments anyway.
        for dim in result.get("dimensions", []):
            if isinstance(dim.get("score"), (int, float)):
                dim["score"] = max(0, min(10, round(dim["score"])))
        # Enforce integer score on the overall insight too
        overall = result.get("overall")
        if overall and isinstance(overall.get("score"), (int, float)):
            overall["score"] = max(0, min(10, round(overall["score"])))
        return JSONResponse(content=result)
    except json.JSONDecodeError:
        return JSONResponse(status_code=500, content={"error": "AI returned unparseable response."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"AI radar failed: {str(e)}"})
