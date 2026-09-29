# Pacey — Product Scope

Source of truth for what Pacey is and is not. Update this file when product consensus changes. User-facing voice still follows `pacey-writing-style.md`.

Last updated: 2026-09-29.

## One-line job

Tell the runner: can you hit this marathon time, which part of fitness is the limiter, and what to do across the whole block until race day.

## What it is

- A **pre-race companion** for marathon prep: diagnosis plus a training plan covering the full remaining block from today to the entered race date, re-projected as training and body-signal data change.
- Six-area fitness score **against the time the runner typed in**, from recent runs plus Garmin body-signal trends.
- A calm coach verdict, with the radar and charts as the evidence behind it.
- The plan is the **prescription for the diagnosed limiter** — the top gap from the readiness read is injected into every week of generation.

## What it is not

- Not an in-run / on-watch product. No live coaching during the session. The conversational coach surface exists in the UI and stays locked for now — it is a roadmap feature for post-run and planning discussion only, never live coaching.
- Not a clone of Garmin Run Coach (daily adaptive week, no goal-time limiter map).
- Not Expert Coach's colour gauge (that one measures workout adherence on 5K–half plans; Pacey's scores are goal readiness against the typed time).
- Not a finish-time predictor. The trajectory verdict (ahead / on track / behind / not proven) is a goal-relative readiness judgement from current fitness. It never outputs a predicted race time — that is what COROS EvoLab, Polar Running Index and VDOT do.
- Not a second Garmin calendar. Workouts reach Connect only when the runner presses sync, and what they carry is the limiter prescription for the block. Pacey never reschedules the runner's Garmin calendar on its own.
- Not competing with Strava on distribution, TrainingPeaks on CTL / human-coach marketplace, or Runna on plan-catalogue breadth.

## Race and plan

- Primary distance: **marathon**. Race date and goal time are first-class inputs.
- Plan length: **full remaining block** to race day, generated one chunk at a time, capped at 26 weeks. When the race is further out than 26 weeks the block ends mid-season and does not reach race day; the runner is shown the block, not promised the race.
- Phases: build / specificity / sharpen / taper, scaled to the race distance and block length rather than fixed day thresholds. Specificity takes about 45% of development time, clamped to 3–5 weeks for 5K/10K goals, 4–6 weeks for a half, and 6–8 weeks for a marathon or longer; sharpen is one week up to a half and two weeks beyond; the final week is always taper (the final chunk is the 7 days before race day, and the chunk before it is sharpen). Everything earlier is build.
- Plan must stay honest vs amateur complaints:
  - Long runs grow toward a deterministic distance ceiling — 14 km for 5K, 16 km for 10K, 18 km for a half, 32 km for a marathon — ramped about 10% per week from the runner's real long-run baseline and capped mechanically during compilation, not just asked for in the prompt. No universal time ceiling is used, because pace changes elapsed time.
  - Race week never stacks a long or hard session next to the race; race day itself is the Race workout.
  - Marathon-pace work must be real: genuine 15–30 minute blocks at goal pace, verified from lap-level work paces. There is no RPE mechanism anywhere in the pipeline, so MP sessions cannot be faked by auto-shifting effort.
  - Poor recovery signals (HRV down, RHR up, sleep poor) downgrade the week's quality session and keep the long run conversational.
  - Illness / injury: the runner decides whether to skip a scheduled workout. Pacey does not enforce adherence or automatically reschedule missed sessions; Garmin recovery signals may still soften generated training.

## Behaviour to be deliberate about

- **The block is re-projected daily.** The plan cache is keyed on tomorrow's date, so each new day regenerates every chunk. This is how the plan stays current, but it also means the plan has no stable identity across days, and a workout already synced to Garmin can change underneath the runner.
- The overview leads with the Race Goal card and Race Readiness first, the optional Race Course card next; the verdict sits in The Big Picture beneath them.
- **Demo mode** is the default landing state for a visitor with no session. It is a real acquisition surface, not a placeholder.

## Garmin

- Official Connect APIs (OAuth / Connected Apps, Training API) require Garmin business-program approval and are not a current roadmap item. Pacey continues on unofficial `python-garminconnect` — a wedge, not the scale path — storing serialised OAuth tokens instead of the password and rotating them on re-auth; do not deepen password login further.
- The one deliberate exception is two-factor sign-in (see Open items), added because 2FA accounts could not sign in at all. Its dependence on warm serverless instance state is a known limitation.
- Official OAuth is reconsidered only if Garmin grants access.
- Runna, TrainingPeaks, TrainAsONE, RunMotion all go through Connect permissions. Match that bar when auth is rebuilt.

## Competitive notes (verified 2026 research, status: partial)

- Garmin Connect has two adaptive coaches: Run Coach (5K–marathon, no confidence-vs-goal gauge) and Expert (5K/10K/half, colour gauge vs pace goal). Hole: marathon plan without a limiter breakdown vs typed time.
- Runna was acquired by Strava, not Nike. US dual bundle ~$149.99/year. Premium still separate.
- Garmin bought TrainingPeaks (22 Jul 2026). TrainingPeaks remains paid analytics + human-coach marketplace, not an AI running coach.
- Closest AI-plan rival for daily rebuild: TrainAsONE (Garmin OAuth redirect, cheaper). Polar Running Program is a free periodized plan. Neither owns the limiter map.

## Cannot own without becoming a different company

Official OAuth at Garmin-partner scale, native watch glance, full-block periodization as a standalone coaching brand, community.

## Open items

1. **Stable plan identity** — decide whether daily re-projection is the product or an artefact of the cache. Today the stored plan is rejected and overwritten whenever its stored `plan_start` / `week_start` no longer equals tomorrow, so the cache regenerates the block daily and a committed plan (including workouts already synced to Garmin) can move under the runner.
2. **Coach chat** — a post-run and planning discussion surface only, never live or in-run coaching.
3. **Additional interface languages.**
4. **Garmin two-factor sign-in is built, but best-effort.** The two-step flow exists: the password step answers 409 with an `mfa_token` and the code step completes it with `resume_login()`. It requires `garminconnect>=0.3.13`, which keeps the pending session alive after a wrong code so a mistyped code is retryable instead of restarting the whole login. The remaining gap is state — `resume_login()` completes on the same client instance, which holds the live TLS-impersonating session from the password step and is not serialisable, so the pending login is held in memory on the function instance (5-minute TTL, capped). That works when the same warm instance serves both requests and fails otherwise, in which case the runner is asked to start again rather than told their password is wrong. A reliable version needs a stateful service, or official OAuth if Garmin ever grants access.

## Implementation order

1. Settle stable plan identity — weekly refresh and sync history, so a committed plan stays put.
2. Post-run coach chat.
3. Additional interface languages.
4. Continue plan safety and quality refinements.
5. Still no in-run features.
