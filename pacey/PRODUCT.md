# Pacey — Product Scope

Source of truth for what Pacey is and is not. Update this file when product consensus changes. User-facing voice still follows `pacey-writing-style.md`.

Last updated: 2026-09-15.

## One-line job

Tell the runner: can you hit this marathon time, which part of fitness is the limiter, and what to do across the whole block until race day.

## What it is

- A **pre-race companion** for marathon prep: diagnosis plus a training plan covering the full remaining block from today to the entered race date, re-projected as training and body-signal data change.
- Six-area fitness score **against the time the runner typed in**, from recent runs plus Garmin body-signal trends.
- A calm coach verdict, with the radar and charts as the evidence behind it.
- The plan is the **prescription for the diagnosed limiter** — the top gap from the readiness read is injected into every week of generation.

## What it is not

- Not an in-run / on-watch product. No live coaching during the session. The conversational coach surface exists in the UI but stays locked.
- Not a clone of Garmin Run Coach (daily adaptive week, no goal-time limiter map).
- Not Expert Coach's colour gauge (that one measures workout adherence on 5K–half plans; Pacey's scores are goal readiness against the typed time).
- Not a finish-time predictor. The trajectory verdict (ahead / on track / behind / not proven) is a goal-relative readiness judgement from current fitness. It never outputs a predicted race time — that is what COROS EvoLab, Polar Running Index and VDOT do.
- Not a second Garmin calendar. Workouts reach Connect only when the runner presses sync, and what they carry is the limiter prescription for the block. Pacey never reschedules the runner's Garmin calendar on its own.
- Not competing with Strava on distribution, TrainingPeaks on CTL / human-coach marketplace, or Runna on plan-catalogue breadth.

## Race and plan

- Primary distance: **marathon**. Race date and goal time are first-class inputs.
- Plan length: **full remaining block** to race day, generated one chunk at a time, capped at 26 weeks. When the race is further out than 26 weeks the block ends mid-season and does not reach race day; the runner is shown the block, not promised the race.
- Phases: build / specificity / sharpen / taper. The final chunk is always the 7 days before race day; the chunk before it is always sharpen.
- Plan must stay honest vs amateur complaints:
  - Long runs grow toward a distance-aware peak (marathon ~30 km / 18.6 mi), ramped about 10% per week from the runner's real long-run baseline. A duration ceiling (about 2–3 hours) is not yet enforced — see Open items.
  - Race week never stacks a long or hard session next to the race; race day itself is the Race workout.
  - Marathon-pace work must be real: genuine 15–30 minute blocks at goal pace, verified from lap-level work paces. There is no RPE mechanism anywhere in the pipeline, so MP sessions cannot be faked by auto-shifting effort.
  - Poor recovery signals (HRV down, RHR up, sleep poor) downgrade the week's quality session and keep the long run conversational.
  - Illness / injury should pause or rebuild the remaining block, not keep the old week. **Not implemented** — see Open items.

## Behaviour to be deliberate about

- **The block is re-projected daily.** The plan cache is keyed on tomorrow's date, so each new day regenerates every chunk. This is how the plan stays current, but it also means the plan has no stable identity across days, and a workout already synced to Garmin can change underneath the runner.
- The overview leads with the Race Goal card and the readiness radar; the verdict sits in The Big Picture directly beneath them.
- **Demo mode** is the default landing state for a visitor with no session. It is a real acquisition surface, not a placeholder.

## Garmin

- Official path is **OAuth / Connected Apps** and the Training API onto the Connect calendar. Not yet built — still first on the list.
- Unofficial `python-garminconnect` email+password is a wedge, not the scale path. The current implementation already stores serialised OAuth tokens instead of the password and rotates them on re-auth; do not deepen password login further. The one deliberate exception is two-factor sign-in (see Open items), added because 2FA accounts could not sign in at all.
- Runna, TrainingPeaks, TrainAsONE, RunMotion all go through Connect permissions. Match that bar when auth is rebuilt.

## Competitive notes (verified 2026 research, status: partial)

- Garmin Connect has two adaptive coaches: Run Coach (5K–marathon, no confidence-vs-goal gauge) and Expert (5K/10K/half, colour gauge vs pace goal). Hole: marathon plan without a limiter breakdown vs typed time.
- Runna was acquired by Strava, not Nike. US dual bundle ~$149.99/year. Premium still separate.
- Garmin bought TrainingPeaks (22 Jul 2026). TrainingPeaks remains paid analytics + human-coach marketplace, not an AI running coach.
- Closest AI-plan rival for daily rebuild: TrainAsONE (Garmin OAuth redirect, cheaper). Polar Running Program is a free periodized plan. Neither owns the limiter map.

## Cannot own without becoming a different company

Official OAuth at Garmin-partner scale, native watch glance, full-block periodization as a standalone coaching brand, community.

## Open items

1. **Illness / injury state** — an explicit honesty rule with no implementation. Needs an input surface (something like "I'm out this week"), not just prompting.
2. **Official Garmin Connect OAuth.**
3. **Stable plan identity** — decide whether daily re-projection is the product or an artefact of the cache key, so a committed plan stops moving under the runner.
4. **Long-run duration ceiling** (about 2–3 hours), not just distance.
5. **Phase proportions** are fixed thresholds (42 / 20 / 7 days) and do not scale with block length; a 26-week block gets roughly 3 weeks of specificity.
6. **Garmin two-factor sign-in is built, but best-effort.** The two-step flow exists: the password step answers 409 with an `mfa_token` and the code step completes it with `resume_login()`. It requires `garminconnect>=0.3.13`, which keeps the pending session alive after a wrong code so a mistyped code is retryable instead of restarting the whole login. The remaining gap is state — `resume_login()` completes on the same client instance, which holds the live TLS-impersonating session from the password step and is not serialisable, so the pending login is held in memory on the function instance (5-minute TTL, capped). That works when the same warm instance serves both requests and fails otherwise, in which case the runner is asked to start again rather than told their password is wrong. A reliable version needs a stateful service, or official OAuth (item 2).

## Implementation order

1. Official Garmin Connect OAuth (when tackling auth).
2. Overview as diagnosis of **this race** — verdict ahead of the radar.
3. Plan page: block identity and progress, so a synced plan stays put.
4. Illness / injury pause and rebuild.
5. Still no in-run features.
