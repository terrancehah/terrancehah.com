# Pacey — Product Scope

Source of truth for what Pacey is and is not. Update this file when product consensus changes. User-facing voice still follows `pacey-writing-style.md`.

Last updated: 2026-09-06.

## One-line job

Tell the runner: can you hit this marathon time, which part of fitness is the limiter, and what to do across the whole block until race day.

## What it is

- A **pre-race companion** for marathon prep: diagnosis plus a training plan that covers the weeks/season from today to the entered race date, then updates as training and body-signal data change.
- Six-area fitness score **against the time the runner typed in**, from recent runs plus Garmin body-signal trends.
- A calm coach verdict first, charts second.
- Plan is the **prescription for the limiter**, not a second Garmin calendar of “how hard today.”

## What it is not (now)

- Not an in-run / on-watch product. No live coaching during the session.
- Not a clone of Garmin Run Coach (daily adaptive week, no goal-time limiter map).
- Not Expert Coach’s colour gauge (workout adherence on Expert plans, 5K–half only).
- Not a current-fitness race predictor (COROS EvoLab, Polar Running Index, VDOT).
- Not competing with Runna on polish, Strava on distribution, or TrainingPeaks on CTL / human-coach marketplace.

## Race and plan

- Primary distance: **marathon**. Race date and goal time are first-class inputs.
- Plan length: **full remaining block** to race day (countdown, phases: build / specificity / sharpen / taper), not a one-week answer.
- Plan must stay honest vs amateur complaints:
  - Long runs must grow toward a traditional peak (about 18–20 miles / 2–3 hours), not stay short forever.
  - Race week must not stack a long or hard session next to the race.
  - Illness / injury should pause or rebuild the remaining block, not keep the old week.
  - Marathon-pace work must not be inferred only from short tempos then auto-shifted by RPE so MP sessions feel fake.
- Do not invent Garmin-calendar rescheduling as the product. If workouts are sent to Connect, they are the limiter prescription for this block.

## Garmin

- Official path is **OAuth / Connected Apps** and the Training API onto the Connect calendar.
- Unofficial `python-garminconnect` email+password is a wedge, not the scale path. Do not deepen password-dump login as strategy.
- Runna, TrainingPeaks, TrainAsONE, RunMotion all go through Connect permissions. Match that bar when auth is rebuilt.

## Competitive notes (verified 2026 research, status: partial)

- Garmin Connect has two adaptive coaches: Run Coach (5K–marathon, no confidence-vs-goal gauge) and Expert (5K/10K/half, colour gauge vs pace goal). Hole: marathon plan without a limiter breakdown vs typed time.
- Runna was acquired by Strava, not Nike. US dual bundle ~$149.99/year. Premium still separate.
- Garmin bought TrainingPeaks (22 Jul 2026). TrainingPeaks remains paid analytics + human-coach marketplace, not an AI running coach.
- Closest AI-plan rival for daily rebuild: TrainAsONE (Garmin OAuth redirect, cheaper). Polar Running Program is a free periodized plan. Neither owns the limiter map.

## Cannot own without becoming a different company

Official OAuth at Garmin-partner scale, native watch glance, full-block periodization as a standalone coaching brand, community.

## Implementation order

1. Official Garmin Connect OAuth (when tackling auth).
2. Overview as diagnosis of **this race** (verdict first, charts second).
3. Plan page: full marathon block from race date + progress + countdown; long-run and race-week honesty.
4. Still no in-run features.

## Current code vs this scope

- `api/coach-plan.py` still generates a short window (about 7–13 days from tomorrow through next Sunday). That is the gap to close: remaining-block plan keyed on race date, not “next week.”
- Radar / readiness vs typed goal time stays the diagnosis layer. Plan must serve that diagnosis across the season.
