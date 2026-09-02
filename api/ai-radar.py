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

{race_goal_text}

RECENT ACTIVITIES (last 30):
{json.dumps(activities_data, indent=2)}

PACE: avg_pace_ms is metres per second. Convert before writing: sec/km = 1000 / avg_pace_ms, then MM:SS/km. Never write m/s. Check the maths before saying faster or slower than goal pace.

LAPS: If a session has laps, work_avg_pace_ms / rest_avg_pace_ms, use work-lap pace as the real effort. Do not treat a session as easy just because the blended average looks slow.

PHYSIOLOGICAL DATA (60-day trends):
{physio_text}

DIMENSIONS
For each dimension, use only its primary evidence as the lead proof. Do not let the same run anchor more than two dimensions.

1. Lactate Threshold — holding near-race effort without fading.
    Primary evidence: continuous or near-continuous running at/near goal pace, how long it lasted, and whether the effort stayed controlled. Ignore interval sessions with rest breaks here.
    9–10: several recent blocks at goal pace (or faster) for a meaningful stretch, effort staying controlled.
    7–8: solid tempo work near goal pace, or 20–40 min at goal pace.
    5–6: some threshold work, but too short, too slow, or the effort drifts.
    ≤4: almost no work near goal intensity.
    If a lactate-threshold measurement exists, use it to anchor the score. If it does not, do not mention that absence.

2. Aerobic Endurance — easy long-running base.
    Primary evidence: long runs, weekly mileage, and whether easy days were actually easy. Do not use speed sessions here.
    9–10: strong volume, consistent long runs, and a stable or rising VO2max that supports the race.
    7–8: adequate volume and long-run frequency; most easy running is controlled; VO2max stable or rising.
    5–6: volume or long-run quality only borderline for the goal.
    ≤4: not enough aerobic work for this race.

3. Running Economy — how expensive a pace feels.
    Primary evidence: cadence stability and heart-rate cost at a similar pace, especially near goal pace or when tired. Physiological trends help little here.
    9–10: stable, efficient form at or near goal pace across several runs.
    7–8: generally economical on easy/moderate runs, reasonable at goal pace.
    5–6: cadence jumps around, or the same pace costs much more heart rate.
    ≤4: clearly expensive or messy at relevant paces.

4. Strength / Durability — legs and body handling load.
    Primary evidence: hills/elevation, strength or hike sessions, and whether training continued after hard days without a break in the log. Use RHR/HRV/sleep after hard load only if present.
    9–10: consistent load, useful hill/strength work, recovery looking solid.
    7–8: regular load plus some hills or longer efforts; recovery mostly stable.
    5–6: little variety, or recovery starting to look strained.
    ≤4: inconsistent load or clear breakdown patterns.

5. VO2max / Speed — speed reserve above race pace.
    Primary evidence: how much faster than goal pace the runner can run, and whether those fast reps were repeated in-session. Use VO2max trend as the physiological check.
    9–10: repeated fast work well quicker than goal pace, with VO2max rising.
    7–8: some real interval/speed work and a useful gap above goal pace; VO2max stable or slightly up.
    5–6: little true speed work, or the reserve is unclear.
    ≤4: almost no speed development; weak or falling VO2max pulls this down.

6. Fatigue Resistance — quality when already tired.
    Primary evidence: back-to-back days, next-day session quality, and late-run splits if they exist. Use RHR/HRV/sleep trends if present; if they are missing, score from session sequencing only and do not mention the missing fields.
    9–10: holds pace on tired legs; recovery trends look good.
    7–8: can train the next day and still perform; recovery varies normally.
    5–6: quality drops when sessions stack; recovery trend is mixed or rising strain.
    ≤4: cannot handle consecutive quality days.

OUTPUT
Return ONLY valid JSON:
{{"dimensions": [{{"name": "Lactate Threshold", "score": 0, "summary": "", "strengths": "", "gaps": ""}}, ...]}}

Each dimension:
- score: integer 0–10
- summary: 2-3 sentences, no numbers. What this score means for the race. If score >= 7, sound reassuring.
- strengths: 2-3 sentences. Sentence 1 = what this means for the race, in plain words. Sentence 2 = one proof (one date + one number, or one comparison).
- gaps: 2-3 sentences. Sentence 1 = the single most useful thing to improve, in plain words. Sentence 2 = one proof and a concrete next session.

WRITING
- Write like a good running coach texting a club runner, not like a sports scientist writing a report.
- Make the tone constructive. If the score is 7.0 or higher, the summary should feel reassuring and forward-looking.
- Meaning first, proof second. Max two numbers per sentence; one is better.
- First sentence of strengths and gaps must make sense with zero jargon.
- Use runner words: easy / conversational, comfortably hard / race effort, a gear faster than race pace, bounced back the next day.
- If you mention a zone, write "Zone 2 (easy)" not "Z2".
- Never write m/s. Always MM:SS/km or "X seconds per km quicker/slower than goal pace".
- Do not cite missing data as a weakness. No "HRV was not provided", "lactate threshold estimate unavailable", "sleep data missing".
- Do not use jargons like ground truth, physiological validation, training effect 4.5, profile value, blended session data, accumulated load.
- Strengths answer: what does this mean for the race goal?
- Gaps answer: what should they do next, and why?
- Do not invent data.
- Keep each dimension to its own evidence. Spread citations across the 30 activities. Before citing a run, ask whether it is the best proof for THIS dimension.

HEART RATE IN THE TEXT
Pick one only: "easy", "comfortably hard", "about 80% of your max", or "164 bpm". Never stack datas or specific like bpm + % + zone + date + pace in one sentence.
"""

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
