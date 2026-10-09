/* =====================================================================
   PACEY SAMPLE DATA — window.PACEY_SAMPLE
   ---------------------------------------------------------------------
   The single source for the demo runner's readiness read. The app's demo
   mode renders it through getMockPillars(); the landing's "Sample runner
   data" previews render the same values so what a visitor sees is what a
   demo run actually shows. Classic script — no imports, no fetch.
   ===================================================================== */

window.PACEY_SAMPLE = {
    /* Six-area readiness read, calibrated to the demo goal (KL Half
       Marathon, 2:10:00, ~6:10/km goal pace, 35km/week, VO2max 52). Text
       follows the coach voice: plain words, then the proof from the
       runner's own log. scores are integers on the 0–10 scale. */
    pillars: {
        dimensions: [
            { name: 'Lactate Threshold', score: 6, summary: 'Your threshold blocks are too short to prove you can hold race effort for 21km. This is your biggest limiter.', strengths: 'You have a foundation of threshold work to build on, which means your body knows what race effort feels like. Your 3x2km repeat session at 5:00/km shows you can hold a gear faster than race pace for short blocks. That is a useful starting point for extending the duration.', gaps: 'The thing to fix is simple — your threshold blocks are too short to confirm you can hold goal pace under fatigue. A 2km repeat at 5:00/km is faster than race pace but only lasts about 10 minutes. Holding 6:10/km for 21km is a different demand entirely, and it is the one your race will actually make. This is the gap that costs you the most time on race day.' },
            { name: 'Aerobic Endurance', score: 7, summary: 'Volume and long-run distance are where a half marathon needs them. On track — a small bump in the final weeks would seal it.', strengths: 'Your aerobic base is solid enough to carry you through race day. You are running 35km per week with long runs reaching 21km, and most of your easy running sits at 6:40/km in an easy zone — that is good discipline. The consistent 4 to 5 runs per week tells me your body is absorbing the load well.', gaps: 'One small push would make you race-ready — your longest run matches race distance but has not gone past it. Twenty-one kilometres on fresh legs in training is not the same as twenty-one on race day, where a taper has you rested but the pace is faster and the last 5km arrives with nothing left to draw on. Going past race distance is less about fitness than about removing the unknown.' },
            { name: 'Running Economy', score: 6, summary: 'Steady cadence, but no work at goal race pace. Race pace costs you more than it should.', strengths: 'Your form is stable and efficient at the paces you run most often. Cadence sits around 168 to 172 spm across your easy and long runs, which is a good range for your pace. You are not wasting energy bouncing between strides, and that consistency matters over 21km.', gaps: 'The missing piece is neuromuscular sharpness at race pace — most of your runs are either faster tempo work or slower easy efforts. You have no strides or drills in your recent history, so nothing has taught your legs to turn over efficiently at 6:10/km. That inefficiency shows up as a higher cost per kilometre, and you pay it on top of the aerobic work rather than instead of it.' },
            { name: 'Strength / Durability', score: 6, summary: 'Consistent frequency, no strength work behind it. That gap only shows late, when your legs lose shape over the final 5km.', strengths: 'Your body is handling the running load well, which is the first box to tick. You are running 4 to 5 times a week with no gaps in frequency, and your trail runs add some elevation variety — up to 120m of gain in a session. That gives you a reasonable base of durability to build on.', gaps: 'The gap here is not the running — it is everything around it. There is nothing in your history beyond running, and weak hips and glutes are the most common reason half marathoners fade late: when they give out, your form goes with them and the pace drops no matter how fit the engine is. It is the kind of gap that stays invisible until the final 5km, when everything else has already been spent.' },
            { name: 'VO₂max / Speed', score: 7, summary: 'Useful speed reserve above goal pace, but you visit it too rarely to hold on to it.', strengths: 'Your raw aerobic capacity gives you a comfortable cushion above race pace. Your VO2max of 52 is solid for your age, and your 400m intervals at 4:40/km show you can access a gear well faster than 6:10/km. That gap between your interval pace and goal pace is exactly what you want.', gaps: 'The risk is not a lack of speed — it is that you are not visiting it often enough. Your interval sessions show up only once or twice a month, and without regular stimulus that ceiling drifts down across a training block rather than holding where it is. That reserve above race pace is worth protecting: it is what makes 6:10/km feel like a gear you can reach for rather than a ceiling you are pressed against.' },
            { name: 'Fatigue Resistance', score: 6, summary: 'You recover well day to day, but fade 8–12% late in long runs. That is what turns a 2:10 into a 2:15.', strengths: 'You bounce back the next day well, which tells me your body handles consecutive training stimuli. The day after a tempo session you are still running your easy run at the right pace, not grinding through it. That hard-easy pattern is building real resistance.', gaps: 'The thing to fix is your late-run pace — you are dropping off 8 to 12 percent in the final third of long runs. For a 2:10:00 target you need to hold 6:10/km the whole way, and an 8 percent fade over the closing 7km is roughly three minutes lost. That is the difference between 2:10 and 2:13, and it is the part of the race your training has not rehearsed yet.' },
        ]
    },

    /* One compact week taken from the demo plan's own template — the
       mockWeekSchedule layout (quality Tue, easy Thu, long Sat) padded
       out to the full seven days with rest between every session, with
       MOCK_WORKOUT_DEFS titles/distances and the demo pace zones.
       Landing-only: the app generates its weeks dynamically. */
    week: [
        { day: 'Mon', title: 'Rest day', rest: true },
        { day: 'Tue', title: '6 x 400m', type: 'Speedwork', tagClass: 'pacey-run-tag--speedwork', distance_km: 6, pace: '5:35' },
        { day: 'Wed', title: 'Rest day', rest: true },
        { day: 'Thu', title: 'Easy 6km', type: 'Easy', tagClass: 'pacey-run-tag--easy', distance_km: 6, pace: '6:30' },
        { day: 'Fri', title: 'Rest day', rest: true },
        { day: 'Sat', title: 'Long 16km', type: 'Long Run', tagClass: 'pacey-run-tag--lsd', distance_km: 16, pace: '6:25' },
        { day: 'Sun', title: 'Rest day', rest: true },
    ],

    /* All nine vitals the app's tile list renders, in the app's own order,
       kept verbatim from the demo's getMockMetrics() fixture. colorToken
       is the frozen display sample's zone hue — blue is Garmin's normal
       tier, green the strong one; it names --pacey-metric-zone-* tokens,
       not a recomputed assessment. icon is the symbol METRIC_ICONS maps
       the label to, so the tile can't drift from the app. Landing-only
       display data — the app builds its tiles straight from the fixture. */
    metrics: [
        { label: 'Readiness', value: '72', unit: 'Moderate', colorToken: 'blue', icon: 'pacey-icon-readiness-score' },
        { label: 'Sleep', value: '81', unit: '/100', colorToken: 'blue', icon: 'pacey-icon-sleep', stroke: true },
        { label: 'Recovery', value: '18', unit: 'hrs', colorToken: 'blue', icon: 'pacey-icon-stopwatch' },
        { label: 'Body Battery', value: '72', unit: '%', colorToken: 'blue', icon: 'pacey-icon-battery', stroke: true },
        { label: 'VO₂max', value: '52', unit: 'ml/kg/min', colorToken: 'green', icon: 'pacey-icon-lungs' },
        { label: 'HRV', value: '34', unit: 'ms', colorToken: 'green', icon: 'pacey-icon-hrv' },
        { label: 'Resting HR', value: '48', unit: 'bpm', colorToken: 'green', icon: 'pacey-icon-heart' },
        { label: 'Stress', value: '28', unit: '/100', colorToken: 'blue', icon: 'pacey-icon-stress', stroke: true },
        { label: 'Fitness Age', value: '25', unit: 'years', colorToken: 'green', icon: 'pacey-icon-calendar' },
    ],
};
