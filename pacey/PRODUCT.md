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

- **The block is reviewed once per calendar week.** The plan cache is keyed on the Monday of the current week, so the full block stays put for the whole Monday–Sunday span instead of regenerating daily. A plan first generated midweek starts that same day with an intentionally partial first week (today through Sunday). On the first load of a new week the whole remaining forecast regenerates from the latest 14-day run history and body signals — the completed prior week is part of that history, never something Pacey reschedules or enforces. Only the current calendar week is syncable to Garmin (in a partial first week, today through Sunday); future weeks are preview-only. Successful syncs record a per-account fingerprint + workout ID receipt that persists across reloads and devices, so an unchanged workout never asks to be sent twice — an edited one changes its fingerprint and can be pushed again. Missed sessions are inputs and history, not adherence the plan enforces.
- **The coach's read on a run knows which story the run belongs to.** A run that is the saved result of the goal race — on the current goal or an archived one — is reviewed as that completed race against its target. A run matching the current goal's race date and distance (±5%) but never linked is treated as an apparent race; everything else is reviewed as training. Stored reads carry that context, so relinking the result or correcting the target refreshes only the affected run's read — training reads and the rest of the history are never invalidated wholesale.
- **Running without a goal is an explicit choice, not a missing one.** The runner can opt out of a race goal from onboarding, the welcome-back reminder, the post-race recap, settings, or the edit-goal dialog; the choice is stored account-wide as a tombstone so every device agrees. A finished race is filed to Past Races first, only goal-derived state (readiness read, plan, course) is cleared, and no run or insight history is rewritten. The dashboard swaps the goal/readiness row for a quiet note and skips all race-specific AI work; the Plan page becomes a training log — history only, no generation or Garmin scheduling. With races in the archive the Readiness nav entry stays as **Recap**: it opens the latest archived race with a saved result (or the newest entry when none has one) rendered from that race's own stored result and read — no result means a plain "No race result saved", never a link prompt. Any archived race can be pointed at from its Past Races entry ("View recap" — the modal is the only archive picker); with a live goal that view is a temporary selection whose way back sits in a plain row beside the recap card, and it clears when the goal changes. With no goal, the next-goal actions (Explore, Set a goal) sit in that same outside-the-card row instead of inside the recap. Historical views never touch the course map, the link-result flow, or the no-goal opt-out.
- **Without a goal, the last finished race still sets the reference.** The latest completed race's actual finish — never its typed target — is the account's pacing baseline: the pace-distribution chart centres on it ("Last race pace") and activity tags compare against it. With no finished race at all, the chart centres on the median of recent running paces ("Typical running pace"); this reference is display-only and is never fed back into plans or readiness.
- **Next-goal options are estimates from evidence, not predictions.** From the no-goal note or the post-race recap the runner can explore the four fixed distances; each carries a proposed time derived from the latest race's actual finish via race-equivalent estimates (Riegel exponent 1.06), or — without a race — from recent training pace, clearly labelled as a training benchmark rather than a race prediction. These are starting targets to adjust, not readiness scores or guarantees; an option without enough evidence says more data is needed. Choosing an option only prefills the standalone goal dialog — nothing saves until the runner submits. An optional "Coach's perspective" explanation is requested only after the runner explores the options, and shows an explicit unavailable note rather than invented text when the coach cannot respond.
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

1. **Coach chat** — a post-run and planning discussion surface only, never live or in-run coaching.
2. **Additional interface languages.**
3. **Garmin two-factor sign-in is built, but best-effort.** The two-step flow exists: the password step answers 409 with an `mfa_token` and the code step completes it with `resume_login()`. It requires `garminconnect>=0.3.13`, which keeps the pending session alive after a wrong code so a mistyped code is retryable instead of restarting the whole login. The remaining gap is state — `resume_login()` completes on the same client instance, which holds the live TLS-impersonating session from the password step and is not serialisable, so the pending login is held in memory on the function instance (5-minute TTL, capped). That works when the same warm instance serves both requests and fails otherwise, in which case the runner is asked to start again rather than told their password is wrong. A reliable version needs a stateful service, or official OAuth if Garmin ever grants access.

## Implementation order

1. Post-run coach chat.
2. Additional interface languages.
3. Continue plan safety and quality refinements.
4. Still no in-run features.
