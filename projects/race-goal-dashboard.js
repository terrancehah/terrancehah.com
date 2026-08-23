// Race Goal Dashboard — full rewrite.
// Single-page dashboard: metric tiles, column chart, calendar,
// activity history, AI radar, AI summary. Collapsible sidebar.

document.addEventListener('DOMContentLoaded', function () {

    // =========================================================================
    // Config
    // =========================================================================
    const API_BASE = '/projects/race-goal-dashboard/api';

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // Screens — login is now a modal, not a full screen
    const loginModal = $('#rgd-login-modal');
    const loginModalClose = $('#rgd-login-modal-close');
    const onboardScreen = $('#rgd-onboarding-screen');
    const dashboardScreen = $('#rgd-dashboard-screen');
    const overlay = $('#rgd-overlay');
    const overlayText = $('#rgd-overlay-text');

    // Login
    const loginForm = $('#rgd-login-form');
    const loginBtn = $('#rgd-login-btn');
    const authError = $('#rgd-auth-error');

    // Onboarding
    const onboardForm = $('#rgd-onboard-form');
    const onboardBtn = $('#rgd-onboard-btn');

    // Dashboard
    const greetingEl = $('#rgd-greeting');
    const avatarEl = $('#rgd-sidebar-avatar');
    let profileImageUrl = ''; // Garmin profile image URL (empty in demo mode)
    const sidebarGoalEl = $('#rgd-sidebar-goal');
    const sidebarToggle = $('#rgd-sidebar-toggle');
    const sidebar = $('#rgd-sidebar');
    const dashboardLayout = document.querySelector('.rgd-dashboard-layout');
    const settingsBtn = $('#rgd-settings-btn');
    const themeToggle = $('#rgd-theme-toggle');
    const demoBanner = $('#rgd-demo-banner');
    const metricsGrid = $('#rgd-metrics-grid');
    const activitiesList = $('#rgd-activities-list');
    const activitiesFull = $('#rgd-activities-full');
    const calendarEl = $('#rgd-calendar');
    // Remove old legend references — radar now uses clickable labels with tooltips
    // const dimensionLegends removed; labels are interactive on the chart itself

    // Store radar values for click-to-tooltip interaction (populated in renderRadarChart)
    let radarValues10 = []; // scores on 1-10 scale
    let radarLabels = [];   // dimension names, set when chart renders
    // Pillars content appears on both overview and insights pages — use class
    // selectors so both instances stay in sync (no skeleton placeholders anymore)
    const pillarsContents = $$('.rgd-pillars-content');
    const summaryErrors = $$('.rgd-summary-error');
    const refreshAnalysisBtn = $('#rgd-refresh-analysis');

    // Store all activities for show-all toggle
    let allActivities = [];

    // Pagination state for the activities page — the overview always
    // shows the 5 latest, while the full page loads in batches.
    // Charts (calendar, pace distribution, HR scatter) use the initial
    // batch only and are never updated by pagination.
    const ACTIVITIES_PAGE_SIZE = 20;
    let activitiesOffset = 0;      // Garmin API offset for next fetch
    let fullActivitiesLoaded = []; // accumulated activities on the full page
    let isLoadingMore = false;     // prevents duplicate concurrent fetches

    // State
    let sessionToken = '';
    let displayName = '';
    let raceGoal = null;
    let raceGoalPaceMs = 0; // race goal pace in m/s — used for run classification
    let mileageChart = null;
    let lastMileageWeeks = null; // stored for theme-change re-render
    let radarCharts = []; // multiple instances — overview + readiness pages
    let lastRadarData = null; // stored for theme-change re-render
    let paceDistChart = null; // pace distribution histogram
    let hrPaceScatter = null; // HR vs Pace scatter plot
    let lastHrvStatus = null; // Garmin HRV status string — used for color-coding

    // =========================================================================
    // API helpers
    // =========================================================================

    async function apiCall(method, path, body = null, isForm = false) {
        let url = `${API_BASE}/${path}`;
        if (method === 'GET' && sessionToken) {
            const sep = url.includes('?') ? '&' : '?';
            url = `${url}${sep}token=${encodeURIComponent(sessionToken)}`;
        }
        const options = { method };
        if (body && isForm) {
            const formData = new FormData();
            for (const [k, v] of Object.entries(body)) formData.append(k, v);
            if (sessionToken) formData.append('token', sessionToken);
            options.body = formData;
        } else if (body) {
            options.headers = { 'Content-Type': 'application/json' };
            const payload = sessionToken ? { ...body, token: sessionToken } : body;
            options.body = JSON.stringify(payload);
        }
        return fetch(url, options);
    }

    // Rotating loading messages — cycles through motivational phrases while data loads
    const LOADING_MESSAGES = [
        'Loading your training data…',
        'Crunching the numbers…',
        'Analysing your progress…',
        'Almost there…',
        'Preparing your dashboard…',
        'Syncing with Garmin…',
    ];
    let loadingMsgTimer = null;

    function showOverlay(text) {
        overlayText.textContent = text;
        overlay.hidden = false;
        // Start rotating through messages every 4 seconds
        let idx = 0;
        if (loadingMsgTimer) clearInterval(loadingMsgTimer);
        loadingMsgTimer = setInterval(() => {
            idx = (idx + 1) % LOADING_MESSAGES.length;
            overlayText.textContent = LOADING_MESSAGES[idx];
        }, 4000);
    }

    function hideOverlay() {
        overlay.hidden = true;
        if (loadingMsgTimer) { clearInterval(loadingMsgTimer); loadingMsgTimer = null; }
    }
    function setButtonLoading(btn, loading) {
        const t = btn.querySelector('.rgd-btn-text');
        const s = btn.querySelector('.rgd-btn-spinner');
        if (t) t.hidden = loading;
        if (s) s.hidden = !loading;
        btn.disabled = loading;
    }

    function showScreen(screen) {
        [onboardScreen, dashboardScreen].forEach(s => s.hidden = true);
        screen.hidden = false;
        // Always close the login modal when switching to a full screen
        closeLoginModal();
    }

    // Login modal open/close — replaces the old full-screen login.
    // Focus management: move focus to the email input when the modal opens
    // so keyboard users can start typing immediately. Return focus to the
    // triggering element (settings button or demo CTA) when it closes.
    let loginModalTrigger = null;
    function openLoginModal() {
        loginModalTrigger = document.activeElement;
        loginModal.hidden = false;
        // Focus the email input after the modal is visible
        const emailInput = $('#rgd-email');
        if (emailInput) emailInput.focus();
    }
    function closeLoginModal() {
        loginModal.hidden = true;
        authError.hidden = true;
        // Return focus to the element that opened the modal
        if (loginModalTrigger) loginModalTrigger.focus();
    }

    loginModalClose.addEventListener('click', closeLoginModal);
    // Close modal when clicking the overlay background
    loginModal.addEventListener('click', (e) => {
        if (e.target === loginModal) closeLoginModal();
    });
    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !loginModal.hidden) closeLoginModal();
    });

    // =========================================================================
    // Sidebar toggle + hash routing
    // =========================================================================

    // Sidebar toggle — collapse/expand the sidebar (slim version keeps toggle visible)
    const headerEl = document.querySelector('header.rgd-header-offset');
    sidebarToggle.addEventListener('click', () => {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        // Update the dashboard layout offset to match sidebar state
        if (dashboardLayout) {
            dashboardLayout.classList.toggle('sidebar-collapsed', isCollapsed);
        }
        // Update header offset to match sidebar state
        if (headerEl) {
            headerEl.classList.toggle('rgd-header-collapsed', isCollapsed);
        }
        // Update title
        sidebarToggle.title = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
    });

    // =========================================================================
    // Theme toggle (light/dark) — persisted in localStorage
    // =========================================================================

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('rgd_theme', theme);
        themeToggle.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        // Update the label to show the current mode name
        const labelEl = $('#rgd-theme-label');
        if (labelEl) labelEl.textContent = theme === 'dark' ? 'Dark' : 'Light';
    }

    // Shared toggle handler — flips theme and re-renders charts
    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(current === 'light' ? 'dark' : 'light');
        // Re-render charts so label/grid colors adapt to the new theme
        if (!dashboardScreen.hidden) {
            if (lastRadarData) {
                radarCharts.forEach(c => c.destroy());
                radarCharts = [];
                renderRadarChart(lastRadarData);
            }
            if (lastMileageWeeks) {
                renderMileageChart(lastMileageWeeks);
            }
        }
    }

    themeToggle.addEventListener('click', toggleTheme);

    // Mobile theme toggle — same behaviour, floating button on small screens
    const mobileThemeToggle = $('#rgd-theme-toggle-mobile');
    if (mobileThemeToggle) {
        mobileThemeToggle.addEventListener('click', toggleTheme);
    }

    // Auto-detect theme from browser local time:
    // Dark mode between 7pm–7am, light mode during the day.
    // If user explicitly toggled, use their saved preference instead.
    function getAutoTheme() {
        const hour = new Date().getHours();
        return (hour >= 19 || hour < 7) ? 'dark' : 'light';
    }

    const savedTheme = localStorage.getItem('rgd_theme');
    applyTheme(savedTheme || getAutoTheme());

    // Hash-based page routing
    function getPageFromHash() {
        const hash = window.location.hash.replace('#', '');
        return hash || 'overview';
    }

    function navigateTo(page) {
        // Update active nav (sidebar items + bottom tab bar items)
        $$('.rgd-nav-item').forEach(item => {
            item.classList.toggle('active', item.getAttribute('href') === `#${page}`);
        });
        $$('.rgd-tab-item').forEach(item => {
            item.classList.toggle('active', item.getAttribute('href') === `#${page}`);
        });
        // Show/hide pages
        $$('.rgd-page').forEach(p => p.hidden = true);
        const target = document.getElementById(`rgd-page-${page}`);
        if (target) target.hidden = false;
        // Scroll to top of content
        const content = $('#rgd-content');
        if (content) content.scrollTop = 0;
    }

    // Listen for hash changes
    window.addEventListener('hashchange', () => navigateTo(getPageFromHash()));

    // Initial route
    navigateTo(getPageFromHash());

    // =========================================================================
    // Demo mode — mock Garmin-format data
    // =========================================================================

    function generateMockActivities() {
        const now = new Date();
        const activities = [];
        // Training types cycle through 5 patterns aligned with the names and
        // distances arrays below. Paces are in sec/km, calibrated for a 2:10:00
        // half marathon goal (~6:10/km race pace). Most runs are easy/long
        // pace with occasional tempo and interval sessions — a realistic
        // weekly mix rather than everything at speedwork pace.
        const types = [
            { type: 'running', icon: 'RUN', basePace: 400, baseHR: 145, cadence: 168 },  // Easy 6:40/km
            { type: 'running', icon: 'RUN', basePace: 390, baseHR: 149, cadence: 166 },  // Long 6:30/km
            { type: 'running', icon: 'RUN', basePace: 350, baseHR: 158, cadence: 172 },  // Tempo 5:50/km
            { type: 'running', icon: 'RUN', basePace: 300, baseHR: 166, cadence: 176 },  // Interval 5:00/km
            { type: 'trail_running', icon: 'TRL', basePace: 430, baseHR: 138, cadence: 164 }, // Recovery 7:10/km
        ];

        // Distances aligned to the type cycle: easy 6-9km, long 16-21km,
        // tempo 9-11km, interval 5-7km, recovery 4-6km
        const distances = [7.0, 18.0, 10.0, 6.0, 5.0,
                          8.5, 21.1, 11.0, 7.0, 4.5,
                          6.5, 16.0, 9.5, 6.5, 5.5,
                          8.0, 20.0, 10.5, 5.5, 4.0];
        // Names aligned to the type cycle (easy, long, tempo, interval, recovery)
        const names = [
            'Easy Morning Run', 'Weekend Long Run', 'Tempo Session', 'Interval 400s', 'Recovery Jog',
            'Lunch Run', 'Long Run Sunday', 'Threshold 3x2km', 'Hill Repeats', 'Trail Recovery',
            'Park Loop Easy', 'Long Slow Distance', 'Progressive Tempo', 'Fartlek Session', 'Shakeout Run',
            'Evening Easy', 'Marathon Pace Long', 'Mid-Distance Steady', 'Speed 800s', 'Pre-Race Easy'
        ];

        for (let i = 0; i < 20; i++) {
            // Spread across ~10 weeks, with more density in recent 2 weeks
            const daysAgo = i < 8 ? i + Math.floor(Math.random() * 3) : i * 3 + Math.floor(Math.random() * 4);
            const d = new Date(now);
            d.setDate(d.getDate() - daysAgo);
            const t = types[i % types.length];
            const dist = distances[i];
            const durMin = (dist * (t.basePace + (Math.random() - 0.5) * 40)) / 60;
            const paceMs = 1000 / (t.basePace + (Math.random() - 0.5) * 30);
            const hr = Math.round(t.baseHR + (Math.random() - 0.5) * 20);
            const maxHr = Math.round(hr + 15 + Math.random() * 15);
            const elev = Math.round(dist * (Math.random() * 12 + 2));

            const cad = Math.round(t.cadence + (Math.random() - 0.5) * 10);

            // Build in API response format (matching /race-goal/activities endpoint)
            activities.push({
                id: 20000000 + i,
                name: names[i],
                type: t.type,
                start_time: d.toISOString().replace('T', ' ').slice(0, 19),
                distance: parseFloat(dist.toFixed(2)),        // km
                duration: parseFloat(durMin.toFixed(1)),       // minutes
                avg_pace: parseFloat(paceMs.toFixed(2)),       // m/s
                avg_hr: hr,
                max_hr: maxHr,
                calories: Math.round(durMin * (7 + Math.random() * 3)),
                elevation_gain: parseFloat(elev.toFixed(1)),
                training_effect: parseFloat((2 + Math.random() * 2.5).toFixed(1)),
                avg_cadence: cad,
                elapsed_duration: parseFloat((durMin + Math.random() * 8).toFixed(1)), // minutes
            });
        }
        return activities;
    }

    function getMockMetrics() {
        return {
            vo2max: 52, vo2max_date: '2026-08-15',
            fitness_age: 25,
            training_readiness_score: 72, training_readiness_level: 'MODERATE',
            recovery_time_hrs: 18,
            hrv_status: 'BALANCED', hrv_last_night_avg: 34, hrv_weekly_avg: 31,
            resting_hr: 48,
            body_battery: 72,
            sleep_score: 81,
            stress_level: 28,
            weekly_distance: 38, weekly_duration: 3.2, weekly_runs: 5,
            total_activities: 187,
            device_name: 'Forerunner 265',
            // Today's date in ISO format — demo mode always shows "today"
            metrics_date: new Date().toISOString().slice(0, 10),
            // Current timestamp — simulates the server fetch time
            fetched_at: new Date().toISOString(),
        };
    }

    // Generate 12 weeks of mock weekly mileage data matching the
    // /weekly-mileage endpoint format: {week_start, mileage_km, run_count}
    // Shows a progressive training build toward a half marathon peak
    function getMockWeeklyMileage() {
        const today = new Date();
        // Start from the Monday of 11 weeks ago (12 weeks total including current week)
        // getDay() returns 0=Sunday..6=Saturday; convert to 0=Monday..6=Sunday
        const daysSinceMonday = (today.getDay() + 6) % 7;
        const startMonday = new Date(today);
        startMonday.setDate(today.getDate() - daysSinceMonday - 11 * 7);
        const weekDistances = [18.5, 22.0, 25.3, 28.0, 24.5, 31.2, 33.0, 29.8, 35.5, 38.0, 36.2, 22.0];
        const weekRuns =      [3,    4,    4,    4,    3,    5,    5,    4,    5,    5,    4,    3];
        const weeks = [];
        for (let i = 0; i < 12; i++) {
            const monday = new Date(startMonday);
            monday.setDate(startMonday.getDate() + i * 7);
            weeks.push({
                week_start: monday.toISOString().slice(0, 10),
                mileage_km: weekDistances[i],
                run_count: weekRuns[i],
            });
        }
        return weeks;
    }

    // Mock radar: flat format matching /race-goal/radar endpoint
    // Mock radar data in AI radar format — dimensions array with 0-10 scores
    // Uses strengths/gaps format matching the updated AI prompt
    function getMockRadarData() {
        return getMockPillars();
    }

    // Mock pillars: dimensions format matching /race-goal/ai-radar endpoint
    // Scores on 0-10 scale in 0.5 increments per the AI prompt's scoring rules.
    // Mock data is calibrated to the demo race goal (Half Marathon, 2:10:00,
    // ~6:10/km goal pace, 35km/week, VO2max 52) and references paces, HR,
    // cadence, and distances from generateMockActivities().
    function getMockPillars() {
        return {
            dimensions: [
                { name: 'Lactate Threshold', score: 6.0, summary: 'Your threshold work is developing but the efforts are too short to confirm race-pace sustainability. You have a foundation of quality sessions but need longer blocks at goal pace. This is an area that needs targeted work before race day.', strengths: 'Your recent tempo sessions at 5:10/km with HR around 152 bpm show you are developing lactate clearance at near-threshold effort. The 3x2km repeat session at 5:00/km pace demonstrates you can hold moderately hard efforts for short blocks. You have a foundation of quality work to build on.', gaps: 'For a 2:10:00 half marathon you need to sustain 6:10/km for 21km, but your threshold sessions are only 2km blocks — too short to confirm you can hold goal pace under fatigue. Your tempo runs at 5:10/km are faster than goal pace but last only 20-25 minutes. Add one 3x3km at 6:00/km session per week to build race-specific threshold endurance.' },
                { name: 'Aerobic Endurance', score: 7.0, summary: 'Your weekly volume and long-run distance are adequate for a half marathon goal. You are maintaining good discipline with mostly easy-effort running. You are on track but could push slightly higher volume for peak readiness.', strengths: 'Your weekly volume of 35km with long runs reaching 20-21km is adequate for a half marathon goal. Most of your easy runs sit at 5:40-6:10/km with HR 142-148 bpm, showing good discipline in the aerobic zone. The consistent 4-5 runs per week pattern builds a solid cardiovascular base.', gaps: 'Your longest run is 21km which matches race distance, but you have not yet exceeded it. One or two runs of 22-24km in the final 6 weeks would build the extra durability needed for race day. Your weekly volume could also increase to 40-45km for peak readiness.' },
                { name: 'Running Economy', score: 6.0, summary: 'Your cadence is steady and your easy-run pacing is consistent, but your economy at goal race pace has not been tested enough. You are missing neuromuscular work like strides that sharpen efficiency at race pace. This is a moderate gap that can be addressed with small additions to your routine.', strengths: 'Your cadence is steady at 166-172 spm across most runs, which falls within the efficient range for your pace. Pace consistency on easy days is good with low variability between 5:40-6:10/km. You are maintaining reasonable form at sub-threshold intensities.', gaps: 'Your economy at goal race pace (6:10/km) has not been specifically tested — most of your runs are either faster tempo work or slower easy efforts. You are missing strides and drills that improve neuromuscular coordination at race pace. Add 4-6x100m strides after easy runs to sharpen efficiency at 6:10/km.' },
                { name: 'Strength / Durability', score: 5.5, summary: 'Your training frequency is consistent but you lack any dedicated strength work or cross-training. This is a meaningful gap that increases injury risk over the training block. Addressing this now will pay dividends on race day.', strengths: 'Your training load is consistent at 4-5 runs per week with no major gaps in frequency. Elevation gain on your trail runs (up to 120m per session) adds some musculoskeletal variety. You have a reasonable base of durability from regular training.', gaps: 'You have no visible strength training, cross-training, or dedicated hill sessions in your activity history. For a half marathon, weak hips and glutes are common injury risks that can derail training. Add 1-2 strength sessions per week focusing on single-leg work, calf raises, and core stability to improve structural resilience.' },
                { name: 'VO₂max / Speed', score: 6.5, summary: 'Your aerobic capacity provides a modest speed reserve above goal pace, but your high-intensity sessions are too infrequent to maintain it. Without consistent stimulus you risk losing this fitness. You have the raw potential but need more regular speed work.', strengths: 'Your VO2max of 52 is reasonable for your age and provides a modest speed reserve above your 6:10/km goal pace. The 400m interval sessions at 4:40/km pace with HR reaching 160 bpm show you can access higher intensities. You have enough raw aerobic capacity to support a 2:10 half marathon.', gaps: 'Your interval sessions are infrequent — only 1-2 per month in the recent data, which is not enough to maintain VO2max. To preserve your speed reserve for race day, you need weekly high-intensity work. Without consistent stimulus you risk losing this fitness over the remaining training block.' },
                { name: 'Fatigue Resistance', score: 5.5, summary: 'You can handle back-to-back training days but your pace drops noticeably in the later portions of long runs. This indicates fatigue accumulation that would cost you time over the full race distance. You need more targeted late-run pace work to build resistance.', strengths: 'Your back-to-back workout days show you can handle consecutive training stimuli without complete breakdown. The long run the day after a tempo session demonstrates reasonable fatigue tolerance. You have a sensible hard-easy-hard pattern that builds some resistance.', gaps: 'Your pace drops off 8-12% in the final third of long runs, indicating fatigue accumulation that would cost you significant time over 21km. For a 2:10:00 target you need to maintain 6:10/km through the full distance. Add negative-split long runs where you accelerate the final 5km to train late-race fatigue resistance.' },
            ]
        };
    }

    // Start demo mode — used as the default landing and after logout
    function startDemoMode() {
        sessionToken = 'demo';
        displayName = 'Demo Runner';
        raceGoal = {
            purpose: 'Half Marathon',
            distance: 'Half Marathon',
            time_target: '02:10:00',
            race_date: '2026-11-15',
            weekly_mileage: '35',
            mileage_unit: 'km',
            gender: 'male',
            age: '30',
        };
        localStorage.setItem('rgd_race_goal', JSON.stringify(raceGoal));
        localStorage.setItem('rgd_session_token', 'demo');
        window.__demoMode = true;
        // Show demo CTAs across all pages
        const demoCta = $('#rgd-demo-cta');
        if (demoCta) demoCta.hidden = false;
        showDashboard();
    }

    // =========================================================================
    // Login (modal form submission)
    // =========================================================================

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        authError.hidden = true;
        setButtonLoading(loginBtn, true);
        const email = $('#rgd-email').value.trim();
        const password = $('#rgd-password').value;
        try {
            const resp = await fetch(`${API_BASE}/garmin-auth`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await resp.json();
            if (!resp.ok) {
                let msg = data.error || 'Authentication failed.';
                if (data.detail) msg += ' ' + data.detail;
                if (resp.status === 429) msg = 'Too many login attempts. Garmin temporarily blocked the request. Please wait 10–15 minutes and try again.';
                authError.textContent = msg;
                authError.hidden = false;
                return;
            }
            sessionToken = data.session_token;
            displayName = data.display_name;
            profileImageUrl = data.profile_image_url || '';
            localStorage.setItem('rgd_session_token', sessionToken);
            // Cache profile data so the dashboard can render instantly on refresh
            localStorage.setItem('rgd_display_name', displayName || '');
            localStorage.setItem('rgd_profile_image_url', profileImageUrl);
            // Close modal and proceed to onboarding for real Garmin users
            closeLoginModal();
            window.__demoMode = false;
            showScreen(onboardScreen);
        } catch (err) {
            authError.textContent = 'Could not reach the server. Check that both servers are running (bash start-dev.sh).';
            authError.hidden = false;
        } finally { setButtonLoading(loginBtn, false); }
    });

    // =========================================================================
    // Onboarding
    // =========================================================================

    onboardForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        $$('.rgd-input.error').forEach(el => el.classList.remove('error'));
        $$('.rgd-field-error').forEach(el => el.hidden = true);

        const h = $('#rgd-time-h').value || '0';
        const m = $('#rgd-time-m').value || '00';
        const s = $('#rgd-time-s').value || '00';
        const timeTarget = `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;

        const required = [
            { id: 'rgd-purpose', val: $('#rgd-purpose').value },
            { id: 'rgd-time-h', val: timeTarget !== '00:00:00' ? timeTarget : '' },
            { id: 'rgd-race-date', val: $('#rgd-race-date').value },
            { id: 'rgd-mileage', val: $('#rgd-mileage').value },
            { id: 'rgd-gender', val: $('#rgd-gender').value },
            { id: 'rgd-age', val: $('#rgd-age').value },
        ];

        let hasError = false;
        for (const f of required) {
            if (!f.val) {
                const el = document.getElementById(f.id);
                if (el) el.classList.add('error');
                const fg = el && el.closest('.rgd-field');
                if (fg) { const er = fg.querySelector('.rgd-field-error'); if (er) er.hidden = false; }
                if (f.id === 'rgd-time-h') {
                    ['rgd-time-h','rgd-time-m','rgd-time-s'].forEach(id => {
                        const inp = document.getElementById(id); if (inp) inp.classList.add('error');
                    });
                    const dpErr = document.querySelector('#rgd-duration-picker').nextElementSibling;
                    if (dpErr && dpErr.classList.contains('rgd-field-error')) dpErr.hidden = false;
                }
                hasError = true;
            }
        }
        if (hasError) return;

        setButtonLoading(onboardBtn, true);
        const body = {
            purpose: $('#rgd-purpose').value,
            distance: $('#rgd-purpose').value,
            time_target: timeTarget,
            race_date: $('#rgd-race-date').value,
            weekly_mileage: $('#rgd-mileage').value,
            mileage_unit: $('#rgd-mileage-unit').value,
            gender: $('#rgd-gender').value,
            age: $('#rgd-age').value,
        };
        try {
            const resp = await apiCall('POST', 'onboarding', body, true);
            const data = await resp.json();
            if (!resp.ok) { alert(data.error || 'Failed to save race goal.'); return; }
            raceGoal = data.goal;
            localStorage.setItem('rgd_race_goal', JSON.stringify(raceGoal));
            showDashboard();
        } catch (err) { alert('Network error. Please try again.'); }
        finally { setButtonLoading(onboardBtn, false); }
    });

    // =========================================================================
    // Show dashboard + load all data
    // =========================================================================

    // Update the sidebar avatar with the Garmin profile image, or fall back to
    // the runner icon in demo mode and initials when no image URL is available
    function updateAvatar() {
        if (!avatarEl) return;
        if (profileImageUrl) {
            // Try loading the profile image; on error, fall back to initials
            avatarEl.innerHTML = `<img src="${profileImageUrl}" alt="${displayName || 'Runner'}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/><span class="rgd-avatar-initials" style="display:none">${getInitials(displayName)}</span>`;
        } else {
            // No profile image — show initials (or runner icon in demo mode)
            const initials = getInitials(displayName);
            if (initials && !window.__demoMode) {
                avatarEl.innerHTML = `<span class="rgd-avatar-initials">${initials}</span>`;
            } else {
                // Demo mode or no name — keep the default runner SVG icon
                avatarEl.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><path d="M8 22l3-8 2 2 3-2 2 8"/><path d="M9 12l-2-3"/><path d="M15 12l2-3"/></svg>`;
            }
        }
    }

    // Extract up to 2 initials from a display name (e.g. "Terrance Hah" → "TH")
    function getInitials(name) {
        if (!name) return '';
        const parts = name.trim().split(/\s+/);
        if (parts.length === 0) return '';
        if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    function showDashboard() {
        showScreen(dashboardScreen);
        // Show full display name in sidebar (not just first name)
        greetingEl.textContent = displayName || 'Runner';
        // Update avatar with profile image or initials fallback
        updateAvatar();
        // Show demo banner only in demo mode
        demoBanner.hidden = !window.__demoMode;
        // Show "Connect Garmin" footer CTA only in demo mode — hide it
        // for real Garmin sessions so users don't see a redundant prompt
        const demoCta = $('#rgd-demo-cta');
        if (demoCta) demoCta.hidden = !window.__demoMode;

        // Load race goal from localStorage if not already set
        if (!raceGoal) {
            const saved = localStorage.getItem('rgd_race_goal');
            if (saved) {
                try { raceGoal = JSON.parse(saved); } catch (e) {}
            }
        }
        if (raceGoal) {
            sidebarGoalEl.textContent = `${raceGoal.purpose} — ${raceGoal.time_target}`;
            renderGoalSpecifics(raceGoal);
        }

        loadAllData();
    }

    // Render the Race Goal Specifics panel with key metrics + countdown
    function renderGoalSpecifics(goal) {
        const grid = $('#rgd-goal-specifics-grid');
        if (!grid) return;

        // Compute countdown days to race date
        let countdownDays = '--';
        if (goal.race_date) {
            const raceDate = new Date(goal.race_date + 'T00:00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const diffMs = raceDate - today;
            const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
            countdownDays = diffDays >= 0 ? diffDays : '0';
        }

        // Derive target pace from race distance + time target
        // Standard distances in km for known race types
        const distanceMap = {
            '5K': 5, '10K': 10, 'Half Marathon': 21.1,
            'Marathon': 42.2, 'Ultra Marathon': 50, 'Triathlon': 40,
        };
        const distKm = distanceMap[goal.purpose] || parseFloat(goal.distance) || 0;
        let targetPace = '--';
        if (distKm > 0 && goal.time_target) {
            // Parse H:MM:SS or MM:SS
            const parts = goal.time_target.split(':').map(Number);
            let totalSec = 0;
            if (parts.length === 3) totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
            else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1];
            if (totalSec > 0) {
                const paceSecPerKm = totalSec / distKm;
                const min = Math.floor(paceSecPerKm / 60);
                const sec = Math.round(paceSecPerKm % 60);
                targetPace = `${min}:${String(sec).padStart(2, '0')}`;
            }
        }

        // Build stat tiles — value and unit render inline on the same line
        // Weekly target removed per design decision; countdown is rendered separately as a highlight
        const stats = [
            { label: 'Race Type', value: goal.purpose || '--', unit: '' },
            { label: 'Race Date', value: goal.race_date ? new Date(goal.race_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '--', unit: '' },
            { label: 'Target Time', value: goal.time_target || '--', unit: '' },
            { label: 'Target Pace', value: targetPace, unit: targetPace === '--' ? '' : '/km' },
        ];

        grid.innerHTML = stats.map(s => `
            <div class="rgd-goal-stat">
                <span class="rgd-goal-stat-label">${s.label}</span>
                <div class="rgd-goal-stat-value-row">
                    <span class="rgd-goal-stat-value">${s.value}</span>
                    ${s.unit ? `<span class="rgd-goal-stat-unit">${s.unit}</span>` : ''}
                </div>
            </div>
        `).join('');

        // Populate the countdown highlight in the top-right corner
        const countdownValueEl = $('#rgd-countdown-value');
        const countdownLabelEl = $('#rgd-countdown-label');
        if (countdownValueEl) countdownValueEl.textContent = countdownDays;
        if (countdownLabelEl) countdownLabelEl.textContent = countdownDays === 1 ? 'day to go' : 'days to go';
    }

    async function loadAllData() {
        const isDemo = window.__demoMode;

        if (isDemo) {
            // Use mock data — no API calls
            renderMetrics(getMockMetrics());
            const mockActs = generateMockActivities();
            // Overview shows 5 latest; full page shows all mock activities
            renderActivities(mockActs);
            // Charts use the full mock set — never affected by pagination
            renderMileageChart(getMockWeeklyMileage());
            renderCalendar(mockActs);
            renderPaceDistribution(mockActs);
            renderHrPaceScatter(mockActs);
            // Show immediately — no skeletons in demo mode
            renderRadarChart(getMockRadarData());
            renderPillars(getMockPillars());
            // Hide the "Load more" button in demo mode — all 20 mock
            // activities are already shown
            const loadMoreBtn = $('#rgd-load-more-activities');
            if (loadMoreBtn) loadMoreBtn.hidden = true;
            return;
        }

        // Transitioning from demo to real mode — destroy any radar chart
        // instances left over from demo mock data so the user doesn't see
        // stale mock scores while the real AI radar loads. Show the skeleton
        // immediately so the radar enters a clear loading state.
        radarCharts.forEach(c => c.destroy());
        radarCharts = [];
        lastRadarData = null;
        showRadarSkeleton(true);
        // Hide pillars content until real AI data arrives
        pillarsContents.forEach(el => el.hidden = true);

        showOverlay('Loading your training data...');
        try {
            // Fetch the first batch of activities for both the overview
            // (5 latest) and the activities page (first 20). Charts use
            // this same batch and are never updated by pagination.
            const [metricsResp, activitiesResp, mileageResp] = await Promise.all([
                apiCall('GET', 'metrics'),
                apiCall('GET', `activities?limit=${ACTIVITIES_PAGE_SIZE}&offset=0`),
                apiCall('GET', 'weekly-mileage?weeks=12'),
            ]);
            const metricsData = await metricsResp.json();
            const activitiesData = await activitiesResp.json();
            const mileageData = await mileageResp.json();
            if (metricsResp.ok && metricsData.metrics) renderMetrics(metricsData.metrics);
            if (activitiesResp.ok && activitiesData.activities) {
                const acts = activitiesData.activities;
                // Store for the activities page pagination
                fullActivitiesLoaded = acts;
                activitiesOffset = acts.length; // advance offset by count returned
                renderActivities(acts);
                // Charts use the initial batch only — never updated by "Load more"
                renderCalendar(acts);
                renderPaceDistribution(acts);
                renderHrPaceScatter(acts);
                // Show "Load more" button if we got a full page (more may exist)
                const loadMoreBtn = $('#rgd-load-more-activities');
                if (loadMoreBtn) {
                    loadMoreBtn.hidden = acts.length < ACTIVITIES_PAGE_SIZE;
                    loadMoreBtn.textContent = 'Load more';
                }
            }
            // Mileage chart uses dedicated weekly-mileage endpoint (not activities list)
            if (mileageResp.ok && mileageData.weeks) {
                renderMileageChart(mileageData.weeks);
            }
        } catch (err) { console.error('Load error:', err); }
        hideOverlay();

        // AI radar + insight text load together — AI scores are the single
        // source of truth for both the radar chart and the pillar analysis
        loadAISummary();
    }

    // Fetch the next batch of activities for the activities page.
    // Appends to the existing list and advances the offset. Charts are
    // never affected — this only updates the activities page list.
    async function loadMoreActivities() {
        if (isLoadingMore) return;
        isLoadingMore = true;
        const loadMoreBtn = $('#rgd-load-more-activities');
        if (loadMoreBtn) {
            loadMoreBtn.textContent = 'Loading…';
            loadMoreBtn.disabled = true;
        }
        try {
            const resp = await apiCall('GET', `activities?limit=${ACTIVITIES_PAGE_SIZE}&offset=${activitiesOffset}`);
            const data = await resp.json();
            if (resp.ok && data.activities) {
                const newActs = data.activities;
                fullActivitiesLoaded = fullActivitiesLoaded.concat(newActs);
                activitiesOffset += newActs.length;
                // Re-render the full activities list with all accumulated activities.
                // The overview list (5 latest) is not affected since it uses
                // a separate container and only shows the first 5.
                if (activitiesFull) {
                    activitiesFull.innerHTML = buildActivityListHtml(
                        fullActivitiesLoaded.filter(isRunningActivity), true
                    );
                    attachActivityHeaderHandlers(activitiesFull);
                }
                // Hide the button if we got fewer than a full page (no more data)
                if (loadMoreBtn) {
                    loadMoreBtn.hidden = newActs.length < ACTIVITIES_PAGE_SIZE;
                    loadMoreBtn.textContent = 'Load more';
                    loadMoreBtn.disabled = false;
                }
            }
        } catch (err) {
            console.error('Load more activities error:', err);
            if (loadMoreBtn) {
                loadMoreBtn.textContent = 'Load more';
                loadMoreBtn.disabled = false;
            }
        }
        isLoadingMore = false;
    }

    // =========================================================================
    // Metric tiles
    // =========================================================================

    // Monochrome SVG icons keyed by label — keeps tiles clean and consistent
    const METRIC_ICONS = {
        // Lung icon — represents oxygen utilization capacity
        'VO₂max': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 L12 6 L18 18 Z"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
        'Readiness': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
        'Sleep': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
        'Body Battery': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="10" x2="22" y2="14"/><rect x="5" y="10" width="8" height="4" fill="currentColor" stroke="none"/></svg>',
        'HRV': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 12 7 12 9 7 13 17 15 12 21 12"/></svg>',
        'Resting HR': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
        // Dumbbell/weight icon — represents stress burden/pressure
        'Stress': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5 L17.5 17.5"/><rect x="1.5" y="9" width="4" height="6" rx="1"/><rect x="18.5" y="9" width="4" height="6" rx="1"/><rect x="5.5" y="10" width="3" height="4" rx="0.5"/><rect x="15.5" y="10" width="3" height="4" rx="0.5"/></svg>',
        'Recovery': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><path d="M9 2 L15 2"/></svg>',
        // Calendar icon — represents biological age relative to chronological age
        'Fitness Age': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>',
    };

    // Metric metadata — min/max ranges, zone definitions, and explanations for the popup.
    // Zones are aligned with Garmin's official tier definitions where available.
    // Used by the metric card click-to-popup feature and for color-coding values.
    const METRIC_META = {
        'VO₂max': {
            // VO2max zones are age/gender-dependent — see getVo2maxZones() below.
            // These fallback zones are used when age/gender are unavailable.
            min: 20, max: 80, unit: 'ml/kg/min',
            zones: [
                { label: 'Poor', max: 35, color: '#e07070' },
                { label: 'Fair', max: 45, color: '#e0b840' },
                { label: 'Good', max: 55, color: '#6ba3d0' },
                { label: 'Excellent', max: 80, color: '#5fae74' },
            ],
            explanation: 'VO₂max measures the maximum volume of oxygen your body can utilize during intense exercise. Higher values indicate better aerobic capacity. Garmin classifies VO₂max using age and gender-specific tables from The Cooper Institute.',
        },
        'Readiness': {
            // Garmin official: Poor 1-24, Low 25-49, Moderate 50-74, High 75-94, Prime 95-100
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Poor', max: 24, color: '#e07070' },
                { label: 'Low', max: 49, color: '#e0b840' },
                { label: 'Moderate', max: 74, color: '#6ba3d0' },
                { label: 'High', max: 94, color: '#5fae74' },
                { label: 'Prime', max: 100, color: '#9b6dd0' },
            ],
            explanation: 'Training Readiness Score combines sleep, recovery, stress, and training load to indicate how prepared your body is for a workout. Garmin uses 5 tiers: Poor (1-24), Low (25-49), Moderate (50-74), High (75-94), and Prime (95-100).',
        },
        'Sleep': {
            // Garmin official: Poor 0-59, Fair 60-79, Good 80-89, Excellent 90-100
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Poor', max: 59, color: '#e07070' },
                { label: 'Fair', max: 79, color: '#e0b840' },
                { label: 'Good', max: 89, color: '#6ba3d0' },
                { label: 'Excellent', max: 100, color: '#5fae74' },
            ],
            explanation: 'Sleep Score evaluates the quality and duration of your sleep based on movement, heart rate, and stress data. Garmin classifies sleep as Poor (0-59), Fair (60-79), Good (80-89), or Excellent (90-100).',
        },
        'Body Battery': {
            // Garmin official: Low 0-25, Medium 26-50, High 51-75, Very High 76-100
            min: 0, max: 100, unit: '%',
            zones: [
                { label: 'Low', max: 25, color: '#e07070' },
                { label: 'Medium', max: 50, color: '#e0b840' },
                { label: 'High', max: 75, color: '#6ba3d0' },
                { label: 'Very High', max: 100, color: '#5fae74' },
            ],
            explanation: 'Body Battery estimates your available energy reserves throughout the day, draining with activity and stress, and recharging during sleep and rest. Garmin classifies levels as Low (0-25), Medium (26-50), High (51-75), and Very High (76-100).',
        },
        'HRV': {
            // HRV is highly individual — Garmin uses a personal baseline status
            // (Balanced/Unbalanced/Low/Poor) rather than absolute ms ranges.
            // The zones below are rough approximations for the popup gauge only.
            // Color-coding on the card uses the Garmin status field, not these zones.
            min: 0, max: 100, unit: 'ms',
            zones: [
                { label: 'Low', max: 20, color: '#e07070' },
                { label: 'Fair', max: 35, color: '#e0b840' },
                { label: 'Good', max: 50, color: '#6ba3d0' },
                { label: 'Excellent', max: 100, color: '#5fae74' },
            ],
            // Garmin HRV status colors — used for card color-coding instead of zones
            statusColors: {
                'BALANCED': '#5fae74',
                'UNBALANCED': '#e0b840',
                'LOW': '#e07070',
                'POOR': '#999999',
            },
            explanation: 'Heart Rate Variability (HRV) measures the variation in time between heartbeats. Garmin uses a personal baseline to classify HRV status as Balanced, Unbalanced, Low, or Poor rather than absolute ranges, since HRV varies widely by individual.',
        },
        'Resting HR': {
            min: 30, max: 90, unit: 'bpm',
            zones: [
                { label: 'High', max: 50, color: '#5fae74' },
                { label: 'Good', max: 60, color: '#6ba3d0' },
                { label: 'Fair', max: 70, color: '#e0b840' },
                { label: 'Elevated', max: 90, color: '#e07070' },
            ],
            explanation: 'Resting Heart Rate is your heart rate when fully at rest. Lower values generally indicate better cardiovascular fitness. A sudden increase may signal insufficient recovery or illness.',
        },
        'Stress': {
            // Garmin official: Rest 0-25, Low 26-50, Medium 51-75, High 76-100
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Rest', max: 25, color: '#5fae74' },
                { label: 'Low', max: 50, color: '#6ba3d0' },
                { label: 'Medium', max: 75, color: '#e0b840' },
                { label: 'High', max: 100, color: '#e07070' },
            ],
            explanation: 'Stress Level is derived from HRV, heart rate, and other physiological signals. Garmin classifies stress as Rest (0-25), Low (26-50), Medium (51-75), and High (76-100). Lower stress levels are better for recovery.',
        },
        'Recovery': {
            min: 0, max: 72, unit: 'hrs',
            zones: [
                { label: 'Ready', max: 6, color: '#5fae74' },
                { label: 'Short', max: 18, color: '#6ba3d0' },
                { label: 'Moderate', max: 36, color: '#e0b840' },
                { label: 'Long', max: 72, color: '#e07070' },
            ],
            explanation: 'Recovery Time estimates how long your body needs to fully recover from recent training before the next hard effort. Shorter times indicate you are ready for more training; longer times suggest you need more rest.',
        },
        'Fitness Age': {
            min: 15, max: 80, unit: 'years',
            zones: [
                { label: 'Young', max: 30, color: '#5fae74' },
                { label: 'Good', max: 40, color: '#6ba3d0' },
                { label: 'Average', max: 50, color: '#e0b840' },
                { label: 'Older', max: 80, color: '#e07070' },
            ],
            explanation: 'Fitness Age estimates your biological age based on fitness metrics like VO₂max and resting heart rate. A fitness age lower than your chronological age indicates above-average fitness for your age group.',
        },
    };

    // VO₂max age/gender-specific zone lookup — uses Garmin's official tables
    // from The Cooper Institute. The user's age and gender are collected
    // during onboarding and stored in the raceGoal object.
    // Returns an array of zones with label, max threshold, and color.
    // If age or gender is unavailable, falls back to the generic zones in METRIC_META.
    function getVo2maxZones() {
        if (!raceGoal || !raceGoal.age || !raceGoal.gender) {
            return METRIC_META['VO₂max'].zones;
        }
        const age = parseInt(raceGoal.age);
        const gender = raceGoal.gender.toLowerCase();
        // Garmin's official VO₂max tables — 5 tiers by age band and gender.
        // Values are the minimum VO₂max for each tier (percentile-based).
        // Source: Garmin fēnix 7 Owner's Manual / The Cooper Institute.
        const tables = {
            male: {
                '20-29': { Superior: 55.4, Excellent: 51.1, Good: 45.4, Fair: 41.7 },
                '30-39': { Superior: 54.0, Excellent: 48.3, Good: 44.0, Fair: 40.5 },
                '40-49': { Superior: 52.5, Excellent: 46.4, Good: 42.4, Fair: 38.5 },
                '50-59': { Superior: 48.9, Excellent: 43.4, Good: 39.2, Fair: 35.6 },
                '60-69': { Superior: 45.7, Excellent: 39.5, Good: 35.5, Fair: 32.3 },
                '70-79': { Superior: 42.1, Excellent: 36.7, Good: 32.3, Fair: 29.4 },
            },
            female: {
                '20-29': { Superior: 49.6, Excellent: 43.9, Good: 39.5, Fair: 36.1 },
                '30-39': { Superior: 47.4, Excellent: 42.4, Good: 37.8, Fair: 34.4 },
                '40-49': { Superior: 45.3, Excellent: 39.7, Good: 36.3, Fair: 33.0 },
                '50-59': { Superior: 41.1, Excellent: 36.7, Good: 33.0, Fair: 30.1 },
                '60-69': { Superior: 37.8, Excellent: 33.0, Good: 30.0, Fair: 27.5 },
                '70-79': { Superior: 36.7, Excellent: 30.9, Good: 28.1, Fair: 25.9 },
            },
        };
        // Find the age band
        let ageBand = null;
        if (age >= 70) ageBand = '70-79';
        else if (age >= 60) ageBand = '60-69';
        else if (age >= 50) ageBand = '50-59';
        else if (age >= 40) ageBand = '40-49';
        else if (age >= 30) ageBand = '30-39';
        else if (age >= 20) ageBand = '20-29';
        else return METRIC_META['VO₂max'].zones; // Under 20 — use generic

        const table = tables[gender] && tables[gender][ageBand];
        if (!table) return METRIC_META['VO₂max'].zones;

        // Build zones array — Poor < Fair < Good < Excellent < Superior
        return [
            { label: 'Poor', max: table.Fair, color: '#e07070' },
            { label: 'Fair', max: table.Good, color: '#e0b840' },
            { label: 'Good', max: table.Excellent, color: '#6ba3d0' },
            { label: 'Excellent', max: table.Superior, color: '#5fae74' },
            { label: 'Superior', max: 100, color: '#9b6dd0' },
        ];
    }

    // Get the zone color for a metric value — used to color-code the
    // metric value text on the card. Returns null if no zone matches
    // or the value is '--'.
    function getMetricZoneColor(label, value) {
        if (value === '--' || value === null || value === undefined) return null;
        const numValue = typeof value === 'number' ? value : parseFloat(value);
        if (isNaN(numValue)) return null;

        // HRV uses Garmin's status field instead of absolute zones
        if (label === 'HRV' && lastHrvStatus) {
            const statusColors = METRIC_META['HRV'].statusColors;
            return statusColors[lastHrvStatus] || null;
        }

        // VO₂max uses age/gender-specific zones
        const zones = label === 'VO₂max' ? getVo2maxZones() : (METRIC_META[label] ? METRIC_META[label].zones : null);
        if (!zones) return null;

        const zone = zones.find(z => numValue <= z.max);
        return zone ? zone.color : null;
    }

    function renderMetrics(m) {
        // Store HRV status for color-coding — Garmin uses a personal baseline
        // status (BALANCED/UNBALANCED/LOW/POOR) rather than absolute ms ranges
        lastHrvStatus = m.hrv_status || null;

        // Display "Last updated" inline with the section title, aligned right.
        // Uses fetched_at (server timestamp) for the time, and metrics_date
        // to decide whether to show "today" or the calendar date.
        // Format: "Last updated: today, 3:45 PM" or "Last updated: Aug 15, 9:30 AM"
        const metricsDateEl = $('#rgd-metrics-date');
        if (metricsDateEl && m.metrics_date) {
            const dataDate = new Date(m.metrics_date + 'T00:00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const isToday = dataDate.getTime() === today.getTime();
            // Use fetched_at for the time component; fall back to metrics_date if missing
            const fetchedAt = m.fetched_at ? new Date(m.fetched_at) : dataDate;
            const timeStr = fetchedAt.toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit'
            });
            const dateStr = isToday
                ? 'today'
                : dataDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            metricsDateEl.textContent = `Last updated: ${dateStr}, ${timeStr}`;
            metricsDateEl.hidden = false;
        }

        // Build tile data — values are color-coded based on Garmin's official
        // tier zones. HRV color-coding uses the Garmin status field.
        const tiles = [
            { label: 'VO₂max', value: m.vo2max || '--', unit: 'ml/kg/min' },
            { label: 'Readiness', value: m.training_readiness_score || '--', unit: m.training_readiness_level ? m.training_readiness_level.charAt(0) + m.training_readiness_level.slice(1).toLowerCase() : '' },
            { label: 'Sleep', value: m.sleep_score || '--', unit: '/100' },
            { label: 'Body Battery', value: m.body_battery || '--', unit: '%' },
            { label: 'HRV', value: m.hrv_last_night_avg || '--', unit: 'ms' },
            { label: 'Resting HR', value: m.resting_hr || '--', unit: 'bpm' },
            { label: 'Stress', value: m.stress_level || '--', unit: '/100' },
            { label: 'Recovery', value: m.recovery_time_hrs || '--', unit: 'hrs' },
            { label: 'Fitness Age', value: m.fitness_age || '--', unit: 'years' },
        ];
        metricsGrid.innerHTML = tiles.map(t => {
            // Get the zone color for this metric value — null if no match
            const color = getMetricZoneColor(t.label, t.value);
            const valueStyle = color ? `style="color: ${color};"` : '';
            return `
            <div class="rgd-metric-tile" data-metric-label="${t.label}"
                 role="button" tabindex="0"
                 aria-label="${t.label}: ${t.value}${t.unit ? ' ' + t.unit : ''}. Select for details.">
                <div class="rgd-metric-top">
                    <span class="rgd-metric-icon">${METRIC_ICONS[t.label] || ''}</span>
                    <span class="rgd-metric-label">${t.label}</span>
                </div>
                <div class="rgd-metric-value-row">
                    <span class="rgd-metric-value" ${valueStyle}>${t.value}</span>
                    ${t.unit ? `<span class="rgd-metric-unit">${t.unit}</span>` : ''}
                </div>
            </div>`;
        }).join('');

        // Attach click + keyboard handlers to each metric tile for the popup.
        // Keyboard: Enter and Space both trigger the same popup as a click.
        metricsGrid.querySelectorAll('.rgd-metric-tile').forEach(tile => {
            const openTile = () => {
                const label = tile.getAttribute('data-metric-label');
                const valueEl = tile.querySelector('.rgd-metric-value');
                const value = valueEl ? parseFloat(valueEl.textContent) : null;
                openMetricPopup(label, isNaN(value) ? null : value);
            };
            tile.addEventListener('click', openTile);
            tile.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openTile();
                }
            });
        });
    }

    // =========================================================================
    // Metric detail popup — gauge bar with color-coded zones and explanation
    // =========================================================================

    const metricPopup = $('#rgd-metric-popup');
    const metricPopupContent = $('#rgd-metric-popup-content');
    const metricPopupClose = $('#rgd-metric-popup-close');

    // Close popup on close button click, overlay click, or Escape key.
    // Focus management: move focus to the close button when the popup opens,
    // and return focus to the metric tile that triggered it when it closes.
    let metricPopupTrigger = null;
    metricPopupClose.addEventListener('click', closeMetricPopup);
    metricPopup.addEventListener('click', (e) => {
        if (e.target === metricPopup) closeMetricPopup();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !metricPopup.hidden) closeMetricPopup();
    });

    function closeMetricPopup() {
        metricPopup.hidden = true;
        // Return focus to the metric tile that opened the popup
        if (metricPopupTrigger) metricPopupTrigger.focus();
    }

    function openMetricPopup(label, currentValue) {
        const meta = METRIC_META[label];
        if (!meta) return;

        // VO₂max uses age/gender-specific zones — override the static zones
        // with the dynamic lookup so the gauge reflects the user's demographics
        let zones = label === 'VO₂max' ? getVo2maxZones() : meta.zones;

        // HRV uses Garmin's personal baseline status (Balanced/Unbalanced/Low/Poor)
        // instead of absolute ms ranges. Replace the zones with status-based zones
        // so the popup gauge matches the card color-coding. The active zone is
        // determined by the hrv_status field, not the ms value.
        let hrvActiveZone = null;
        if (label === 'HRV' && lastHrvStatus) {
            const statusKey = lastHrvStatus.toUpperCase();
            const statusColors = meta.statusColors;
            const statusLabels = {
                'BALANCED': 'Balanced',
                'UNBALANCED': 'Unbalanced',
                'LOW': 'Low',
                'POOR': 'Poor',
            };
            // Build 4 equal-width zones for the gauge, colored by Garmin status
            zones = [
                { label: 'Poor', max: 25, color: statusColors['POOR'] },
                { label: 'Low', max: 50, color: statusColors['LOW'] },
                { label: 'Unbalanced', max: 75, color: statusColors['UNBALANCED'] },
                { label: 'Balanced', max: 100, color: statusColors['BALANCED'] },
            ];
            // Determine the active zone from the Garmin status field
            const matchedLabel = statusLabels[statusKey];
            hrvActiveZone = zones.find(z => z.label === matchedLabel) || null;
        }

        // Calculate the position of the current value marker on the gauge (0-100%)
        const range = meta.max - meta.min;
        const valuePct = currentValue !== null
            ? Math.max(0, Math.min(100, ((currentValue - meta.min) / range) * 100))
            : null;

        // Build the zone segments for the gauge bar
        // Each zone is a colored segment spanning from the previous zone's max to this zone's max
        const zoneSegments = zones.map((zone, i) => {
            const prevMax = i === 0 ? meta.min : zones[i - 1].max;
            const leftPct = ((prevMax - meta.min) / range) * 100;
            const widthPct = ((zone.max - prevMax) / range) * 100;
            return { ...zone, leftPct, widthPct };
        });

        // Determine which zone the current value falls into.
        // HRV uses the Garmin status field instead of the numeric value.
        const activeZone = hrvActiveZone || (currentValue !== null
            ? zones.find(z => currentValue <= z.max) || zones[zones.length - 1]
            : null);

        // Build the zone legend items
        const zoneLegend = zones.map(z => `
            <div class="rgd-gauge-legend-item${activeZone && activeZone.label === z.label ? ' rgd-gauge-legend-item--active' : ''}">
                <span class="rgd-gauge-legend-dot" style="background:${z.color}"></span>
                <span class="rgd-gauge-legend-text">${z.label}</span>
            </div>
        `).join('');

        // Build the gauge bar with zone segments and current value marker.
        // For HRV, the marker is placed at the center of the active status zone
        // since the zones represent statuses, not numeric ranges.
        const markerPct = hrvActiveZone
            ? zoneSegments.find(zs => zs.label === hrvActiveZone.label).leftPct +
              zoneSegments.find(zs => zs.label === hrvActiveZone.label).widthPct / 2
            : valuePct;
        const gaugeBar = `
            <div class="rgd-gauge-bar">
                ${zoneSegments.map(zs => `
                    <div class="rgd-gauge-segment" style="left:${zs.leftPct}%; width:${zs.widthPct}%; background:${zs.color};"></div>
                `).join('')}
                ${markerPct !== null ? `<div class="rgd-gauge-marker" style="left:${markerPct}%;"></div>` : ''}
            </div>
            <div class="rgd-gauge-scale">
                <span class="rgd-gauge-scale-min">${meta.min}</span>
                <span class="rgd-gauge-scale-max">${meta.max} ${meta.unit}</span>
            </div>
        `;

        // Assemble the full popup content
        metricPopupContent.innerHTML = `
            <div class="rgd-metric-popup-header">
                <span class="rgd-metric-popup-icon">${METRIC_ICONS[label] || ''}</span>
                <h3 class="rgd-metric-popup-title">${label}</h3>
            </div>
            <div class="rgd-metric-popup-value-row">
                <span class="rgd-metric-popup-value">${currentValue !== null ? currentValue : '--'}</span>
                <span class="rgd-metric-popup-unit">${meta.unit}</span>
                ${activeZone ? `<span class="rgd-metric-popup-zone" style="background:${activeZone.color}">${activeZone.label}</span>` : ''}
            </div>
            <div class="rgd-gauge-section">
                ${gaugeBar}
                <div class="rgd-gauge-legend">${zoneLegend}</div>
            </div>
            <p class="rgd-metric-popup-explanation">${meta.explanation}</p>
        `;

        // Store the element that triggered this popup so we can return
        // focus to it when the popup closes
        metricPopupTrigger = document.activeElement;
        metricPopup.hidden = false;
        // Move focus to the close button so keyboard users can dismiss
        // the popup immediately without tabbing through the full content
        metricPopupClose.focus();
    }

    // =========================================================================
    // Mileage column chart
    // =========================================================================

    // Helper: format a Date as YYYY-MM-DD in local time (avoids UTC shift)
    function localDateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    // Helper: parse start_time which may use space instead of T separator
    function parseDate(s) {
        if (!s) return new Date(NaN);
        return new Date(String(s).replace(' ', 'T'));
    }

    function renderMileageChart(weekData) {
        const canvas = document.getElementById('rgd-mileage-chart');
        if (!canvas) return;
        if (mileageChart) mileageChart.destroy();
        // Store week data for theme-change re-render
        lastMileageWeeks = weekData;

        // weekData is an array of {week_start, mileage_km, run_count} from the backend
        // Build chart values and date objects from the pre-grouped weekly data
        const weeks = weekData.map(w => ({
            date: new Date(w.week_start + 'T00:00:00'),
            total: w.mileage_km || 0,
            runs: w.run_count || 0,
        }));

        const values = weeks.map(w => Math.round(w.total));
        const maxVal = Math.max(...values, 10);
        const stepSize = maxVal > 60 ? 20 : maxVal > 30 ? 10 : 5;

        // Single-row labels: month names only (no W1-W12)
        // Show one label per month — first occurrence of each month
        const monthLabels = weeks.map(w => {
            return w.date.toLocaleDateString('en-US', { month: 'short' });
        });

        // Deduplicate: keep only the first week of each month, blank out the rest
        // Only label the last week if its month hasn't already appeared — prevents
        // duplicate month labels when the current month spans multiple weeks
        const seenMonths = new Set();
        for (let i = 0; i < monthLabels.length; i++) {
            if (seenMonths.has(monthLabels[i])) {
                monthLabels[i] = '';
            } else {
                seenMonths.add(monthLabels[i]);
            }
        }

        // Read theme-aware colors from CSS variables for chart text and tooltip
        const chartMuted = getComputedStyle(document.documentElement).getPropertyValue('--rgd-muted').trim() || '#5a7184';
        const chartGridColor = getComputedStyle(document.documentElement).getPropertyValue('--rgd-border').trim() || '#dce8f2';
        // Tooltip colors — adapt to theme
        const chartSurface = getComputedStyle(document.documentElement).getPropertyValue('--rgd-surface').trim() || '#ffffff';
        const chartText = getComputedStyle(document.documentElement).getPropertyValue('--rgd-text').trim() || '#1d3557';
        const chartIsDark = document.documentElement.getAttribute('data-theme') === 'dark';

        mileageChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: monthLabels,
                datasets: [{
                    data: values,
                    // Single color for all bars regardless of value
                    backgroundColor: 'rgba(69, 123, 157, 0.65)',
                    borderColor: 'rgba(69, 123, 157, 1)',
                    borderWidth: 1,
                    borderRadius: 4,
                    hoverBackgroundColor: 'rgba(69, 123, 157, 0.85)',
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        // Theme-aware tooltip for mileage chart
                        backgroundColor: chartSurface,
                        titleColor: chartText,
                        bodyColor: chartText,
                        borderColor: chartIsDark ? '#2a3f56' : '#dce8f2',
                        borderWidth: 1,
                        titleFont: { family: 'Raleway', size: 12 },
                        bodyFont: { family: 'Lato', size: 14 },
                        callbacks: {
                            // Show the full week date range (Monday – Sunday) in the tooltip title
                            title: (ctx) => {
                                const i = ctx[0].dataIndex;
                                const weekStart = weeks[i].date;
                                const weekEnd = new Date(weekStart);
                                weekEnd.setDate(weekEnd.getDate() + 6);
                                const startStr = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                const endStr = weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                return `${startStr} – ${endStr}`;
                            },
                            // Show mileage + run count in tooltip
                            label: (ctx) => {
                                const w = weeks[ctx.dataIndex];
                                return `${ctx.raw} km · ${w.runs} run${w.runs !== 1 ? 's' : ''}`;
                            },
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: Math.ceil(maxVal / stepSize) * stepSize,
                        title: { display: true, text: 'km', font: { family: 'Raleway', size: 11 }, color: chartMuted },
                        ticks: { stepSize, font: { family: 'Raleway', size: 10 }, color: chartMuted, callback: v => Math.round(v) },
                        grid: { color: chartGridColor }
                    },
                    x: {
                        // autoSkip: false ensures all month labels are always shown,
                        // even when the chart container is narrow on certain screen sizes
                        ticks: { font: { family: 'Raleway', size: 10 }, color: chartMuted, maxRotation: 0, autoSkip: false },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    // =========================================================================
    // Activity calendar
    // =========================================================================

    function renderCalendar(activities) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const today = now.getDate();

        // Update card title
        const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const cardTitle = calendarEl.closest('.rgd-chart-card')?.querySelector('.rgd-card-title');
        if (cardTitle) cardTitle.textContent = monthName;

        // Map day → activity type (only one dot per day, prioritize longest).
        // Exclude non-running activities (hiking, cycling, etc.)
        const dayMap = {};
        activities.forEach(a => {
            if (!isRunningActivity(a)) return;
            const d = parseDate(a.start_time);
            if (isNaN(d.getTime())) return;
            if (d.getMonth() === month && d.getFullYear() === year) {
                const day = d.getDate();
                const dist = a.distance || 0;
                const type = (a.type || 'run').toLowerCase();
                const cat = dist > 15 ? 'long' : 'run';
                // Keep the "best" activity type for the day
                const priority = { 'long': 3, 'run': 2, 'other': 1 };
                if (!dayMap[day] || priority[cat] > priority[dayMap[day]]) {
                    dayMap[day] = cat;
                }
            }
        });

        // Header row
        const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        let html = '<div class="rgd-calendar-header">';
        dayNames.forEach(d => { html += `<span>${d}</span>`; });
        html += '</div><div class="rgd-calendar-grid">';

        // First day offset (0 = Sunday)
        const firstDay = new Date(year, month, 1).getDay();

        // Empty cells before 1st
        for (let i = 0; i < firstDay; i++) {
            html += '<span class="rgd-calendar-dot empty"></span>';
        }

        // Day dots
        for (let day = 1; day <= daysInMonth; day++) {
            const cat = dayMap[day];
            const isToday = day === today;

            let cls = 'rgd-calendar-dot';
            if (cat) cls += ` ${cat}`;
            if (isToday) cls += ' today';

            const title = cat ? `${cat} on ${monthName} ${day}` : `${monthName} ${day}`;
            html += `<span class="${cls}" title="${title}"></span>`;
        }

        html += '</div>';
        calendarEl.innerHTML = html;
    }

    // =========================================================================
    // Activities list
    // =========================================================================

    // Render a list of activities grouped by month with month separator headers.
    // showMonthTotal: when true (activities page), shows total km per month; hidden on overview
    // showMonthHeader: when true, renders the month name header above each group;
    //   false on the overview so the 5 activities appear as a flat list
    function buildActivityListHtml(activities, showMonthTotal = false, showMonthHeader = true) {
        if (!activities.length) return '<p class="rgd-metric-label">No activities found.</p>';

        // Group activities by month (YYYY-MM key) preserving original order
        const groups = [];
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        activities.forEach((a, idx) => {
            const d = a.start_time ? parseDate(a.start_time) : null;
            const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
            if (!groups.length || groups[groups.length - 1].key !== key) {
                groups.push({ key, month: d ? monthNames[d.getMonth()] : 'Unknown', year: d ? d.getFullYear() : '', activities: [], totalKm: 0 });
            }
            const group = groups[groups.length - 1];
            group.activities.push({ activity: a, originalIndex: idx });
            group.totalKm += a.distance || 0;
        });

        // Build HTML with optional month headers between groups.
        // Month headers + totals only shown on the full activities page.
        return groups.map(group => `
            ${showMonthHeader ? `<div class="rgd-activity-month-header">
                <span class="rgd-activity-month-name">${group.month} ${group.year}</span>
                ${showMonthTotal ? `<span class="rgd-activity-month-total">${Math.round(group.totalKm)} km</span>` : ''}
            </div>` : ''}
            ${group.activities.map(({ activity, originalIndex }) => buildActivityItem(activity, originalIndex)).join('')}
        `).join('');
    }

    function renderActivities(activities) {
        // Filter out non-running activities (hiking, cycling, etc.) — only show runs
        const runningOnly = activities.filter(isRunningActivity);
        if (!runningOnly.length) {
            activitiesList.innerHTML = '<p class="rgd-metric-label">No recent activities found.</p>';
            if (activitiesFull) activitiesFull.innerHTML = '<p class="rgd-metric-label">No activities found.</p>';
            return;
        }

        // Always recompute race goal pace for run classification — the goal
        // may have changed since the last render (e.g. after onboarding)
        raceGoalPaceMs = raceGoal ? computeGoalPaceMs(raceGoal) : 0;

        // Overview: 5 latest as a flat list — no month headers or totals
        activitiesList.innerHTML = buildActivityListHtml(runningOnly.slice(0, 5), false, false);
        // Full page: all activities, grouped by month — show month totals
        if (activitiesFull) activitiesFull.innerHTML = buildActivityListHtml(runningOnly, true);

        // Wire up expand/collapse handlers on all activity headers.
        // Replaces the old inline onclick approach — now supports keyboard
        // (Enter/Space) and updates aria-expanded for screen readers.
        attachActivityHeaderHandlers(activitiesList);
        if (activitiesFull) attachActivityHeaderHandlers(activitiesFull);
    }

    // Attach click + keyboard handlers to all activity headers within a container.
    // Toggles the .open class on the parent .rgd-activity-item and updates
    // aria-expanded so screen readers announce the expanded/collapsed state.
    function attachActivityHeaderHandlers(container) {
        container.querySelectorAll('.rgd-activity-header').forEach(header => {
            const toggleActivity = () => {
                const item = header.parentElement;
                const isOpen = item.classList.toggle('open');
                header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            };
            header.addEventListener('click', toggleActivity);
            header.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleActivity();
                }
            });
        });
    }

    // Running figure SVG used for activity icons (replaces text abbreviations)
    const RUNNING_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2" fill="currentColor" stroke="none"/><path d="M13 6 L9 11 L6 10"/><path d="M9 11 L12 14 L11 20"/><path d="M12 14 L16 12 L14 8"/></svg>';

    // Trail variant adds a small hill line under the runner
    const TRAIL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2" fill="currentColor" stroke="none"/><path d="M13 6 L9 10 L6 9"/><path d="M9 10 L12 13 L11 18"/><path d="M12 13 L16 11 L14 8"/><path d="M3 21 L8 17 L12 20 L16 16 L21 21" stroke-width="1.5"/></svg>';

    function getActivityIcon(type) {
        const t = (type || 'run').toLowerCase();
        if (t.includes('trail')) return TRAIL_ICON_SVG;
        return RUNNING_ICON_SVG;
    }

    // Classify a run into a training type tag using pace + HR heuristics.
    // Compares each run's pace, HR, and distance to the runner's median values
    // to determine the workout type. Returns { label, className } for the tag.
    //
    // Heuristic logic:
    // - Interval: fast pace (below 85% of median pace in m/s = faster), short distance
    // - Tempo: fast pace, sustained (medium distance), high HR
    // - LSD: slow pace (above median), long distance (>130% of median)
    // - Easy: slow pace, short distance, low HR
    // Compute race goal pace in m/s from the race goal data
    // Uses the same distance mapping as renderGoalSpecifics
    function computeGoalPaceMs(goal) {
        if (!goal || !goal.time_target) return 0;
        const distanceMap = {
            '5K': 5, '10K': 10, 'Half Marathon': 21.1,
            'Marathon': 42.2, 'Ultra Marathon': 50, 'Triathlon': 40,
        };
        const distKm = distanceMap[goal.purpose] || parseFloat(goal.distance) || 0;
        if (!distKm) return 0;
        // Parse H:MM:SS or MM:SS
        const parts = goal.time_target.split(':').map(Number);
        let totalSec = 0;
        if (parts.length === 3) totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1];
        if (totalSec <= 0) return 0;
        // m/s = (km * 1000) / seconds
        return (distKm * 1000) / totalSec;
    }

    // Classify a run using race-goal-based heuristics:
    // Check if an activity is a running workout (not hiking, cycling, etc.)
    function isRunningActivity(a) {
        const type = (a.type || '').toLowerCase();
        if (!type) return true; // if no type, assume running
        // Filter out known non-running types
        const nonRunning = ['hiking', 'cycling', 'swimming', 'walking', 'other', 'uncategorized'];
        return !nonRunning.some(t => type.includes(t));
    }

    // Classify a run using race-goal-based heuristics:
    // Warmup: distance < 2km
    // Tempo Long: distance > 12km AND pace meaningfully faster than goal pace
    // LSD: distance > 12km at or easier than goal pace (long slow distance)
    // Speedwork: pace meaningfully faster than goal pace (shorter runs)
    // Easy: everything else (base/recovery mileage)
    //
    // "Meaningfully faster" = at least 15 sec/km faster than the race goal
    // pace. This prevents runs only 1-2 sec/km faster than target from being
    // mislabeled as Speedwork — those are effectively at target pace and
    // belong in the Easy/LSD bucket.
    function classifyRun(a) {
        if (!a.avg_pace || a.avg_pace <= 0) return { label: 'Run', className: 'rgd-run-tag--easy' };
        const dist = a.distance || 0;

        // Warmup: runs shorter than 2km — excluded from charts
        if (dist < 2) {
            return { label: 'Warmup', className: 'rgd-run-tag--warmup' };
        }

        // Compute the Speedwork pace threshold in m/s.
        // Garmin stores avg_pace in m/s (higher = faster). To require a run
        // to be 15 sec/km faster than goal pace, convert goal pace to
        // sec/km, subtract 15, then convert back to m/s.
        let speedworkThresholdMs = 0;
        if (raceGoalPaceMs > 0) {
            const goalPaceSecPerKm = 1000 / raceGoalPaceMs;
            const speedworkPaceSecPerKm = goalPaceSecPerKm - 15;
            // Guard against division by zero if goal pace is extremely slow
            if (speedworkPaceSecPerKm > 0) {
                speedworkThresholdMs = 1000 / speedworkPaceSecPerKm;
            }
        }
        const isMeaningfullyFaster = speedworkThresholdMs > 0 && a.avg_pace > speedworkThresholdMs;

        // Long runs (> 12km) are split by pace:
        //   - Tempo Long: long AND meaningfully faster than goal pace
        //   - LSD: long at or easier than the speedwork threshold
        if (dist > 12) {
            if (isMeaningfullyFaster) {
                return { label: 'Tempo Long', className: 'rgd-run-tag--tempo-long' };
            }
            return { label: 'LSD', className: 'rgd-run-tag--lsd' };
        }

        // Speedwork: shorter runs that are meaningfully faster than goal pace
        if (isMeaningfullyFaster) {
            return { label: 'Speedwork', className: 'rgd-run-tag--speedwork' };
        }

        // Everything else is easy/base mileage
        return { label: 'Easy', className: 'rgd-run-tag--easy' };
    }

    function buildActivityItem(a, i) {
        const date = a.start_time ? parseDate(a.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '--';
        const pace = a.avg_pace ? formatPace(a.avg_pace) : '--';
        const hr = a.avg_hr ? `${a.avg_hr} bpm` : '--';
        const iconSvg = getActivityIcon(a.type);
        const ascent = a.elevation_gain ? `${a.elevation_gain}m` : '--';
        const cadence = a.avg_cadence ? `${Math.round(a.avg_cadence)} spm` : '--';
        const elapsedMin = a.elapsed_duration ? a.elapsed_duration : a.duration;
        const elapsed = elapsedMin ? formatDuration(elapsedMin) : '--';
        // Classify the run type using race-goal-based heuristics
        const runTag = classifyRun(a);

        return `
            <div class="rgd-activity-item" data-index="${i}">
                <div class="rgd-activity-header" role="button" tabindex="0" aria-expanded="false"
                     aria-label="${escapeHtml(a.name)} on ${date}, ${a.distance} km at ${pace} per km. Select to expand details.">
                    <div class="rgd-activity-summary">
                        <div class="rgd-activity-icon">${iconSvg}</div>
                        <span class="rgd-activity-name">${escapeHtml(a.name)}</span>
                        <span class="rgd-activity-date">${date}</span>
                        <span class="rgd-run-tag ${runTag.className}">${runTag.label}</span>
                    </div>
                    <div class="rgd-activity-meta">
                        <div class="rgd-activity-stat">
                            <span class="rgd-activity-stat-value">${a.distance}</span>
                            <span class="rgd-activity-stat-label">km</span>
                        </div>
                        <div class="rgd-activity-stat">
                            <span class="rgd-activity-stat-value">${pace}</span>
                            <span class="rgd-activity-stat-label">/km pace</span>
                        </div>
                        <div class="rgd-activity-stat">
                            <span class="rgd-activity-stat-value">${hr}</span>
                            <span class="rgd-activity-stat-label">avg HR</span>
                        </div>
                        <div class="rgd-activity-stat">
                            <span class="rgd-activity-stat-value">${ascent}</span>
                            <span class="rgd-activity-stat-label">ascent</span>
                        </div>
                    </div>
                    <svg class="rgd-activity-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
                <div class="rgd-activity-detail">
                    <div class="rgd-activity-detail-grid">
                        <div class="rgd-activity-detail-item">
                            <span class="rgd-activity-detail-label">Duration</span>
                            <span class="rgd-activity-detail-value">${formatDuration(a.duration)}</span>
                        </div>
                        <div class="rgd-activity-detail-item">
                            <span class="rgd-activity-detail-label">Elapsed</span>
                            <span class="rgd-activity-detail-value">${elapsed}</span>
                        </div>
                        <div class="rgd-activity-detail-item">
                            <span class="rgd-activity-detail-label">Calories</span>
                            <span class="rgd-activity-detail-value">${a.calories || '--'}</span>
                        </div>
                        <div class="rgd-activity-detail-item">
                            <span class="rgd-activity-detail-label">Max HR</span>
                            <span class="rgd-activity-detail-value">${a.max_hr ? a.max_hr + ' bpm' : '--'}</span>
                        </div>
                        <div class="rgd-activity-detail-item">
                            <span class="rgd-activity-detail-label">Cadence</span>
                            <span class="rgd-activity-detail-value">${cadence}</span>
                        </div>
                        <div class="rgd-activity-detail-item">
                            <span class="rgd-activity-detail-label">Ascent</span>
                            <span class="rgd-activity-detail-value">${ascent}</span>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    function formatPace(speedMs) {
        if (!speedMs || speedMs <= 0) return '--';
        const secPerKm = 1000 / speedMs;
        const mins = Math.floor(secPerKm / 60);
        const secs = Math.floor(secPerKm % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function formatDuration(minutes) {
        if (!minutes) return '--';
        const hrs = Math.floor(minutes / 60);
        const mins = Math.floor(minutes % 60);
        return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // =========================================================================
    // Pace Distribution vs Goal Pace — histogram of recent run paces
    // overlaid with a vertical goal pace line
    // =========================================================================

    // Format a decimal minute value as a pace label "M:SS" (e.g. 5.5 → "5:30")
    // Used by the dynamic pace distribution bucket labels
    function formatPaceLabel(decimalMin) {
        if (decimalMin <= 0) return '0:00';
        const mins = Math.floor(decimalMin);
        const secs = Math.round((decimalMin - mins) * 60);
        // Handle rounding up to 60 (e.g. 5:59.8 → 6:00)
        if (secs === 60) return `${mins + 1}:00`;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function renderPaceDistribution(activities) {
        const canvas = document.getElementById('rgd-pace-distribution-chart');
        if (!canvas || !activities.length) return;
        if (paceDistChart) paceDistChart.destroy();

        // Filter: only running activities, exclude warmup (<2km) and non-running types
        const runs = activities.filter(a => isRunningActivity(a) && (a.distance || 0) >= 2);
        if (!runs.length) return;

        // Compute goal pace in decimal min/km
        const goalPaceMinPerKm = raceGoalPaceMs > 0 ? (1000 / raceGoalPaceMs) / 60 : 0;

        // Dynamic 30-second pace buckets — 5 columns total, centered on the
        // goal pace so it always falls in the 3rd bucket (index 2, green).
        // The goal bucket spans ±15 seconds around the goal pace (30 sec
        // total), placing the target dead-center in the green bar. Two
        // faster buckets step down in 30-second increments below it, two
        // slower buckets step up above it. All calculations are done in
        // seconds for precision, then converted to decimal minutes.
        const goalPaceSec = goalPaceMinPerKm * 60; // seconds per km
        const bucketWidthSec = 30; // 30 seconds per bucket
        const goalBucketIndex = 2; // 3rd bucket — always green
        // Goal bucket: ±15 seconds around the goal pace
        const goalBucketMinSec = goalPaceSec - 15;
        const goalBucketMaxSec = goalPaceSec + 15;
        // Convert seconds to decimal minutes for bucket ranges
        const secToMin = (s) => s / 60;
        const buckets = [
            { label: `<${formatPaceLabel(secToMin(goalBucketMinSec - bucketWidthSec))}`, min: 0, max: secToMin(goalBucketMinSec - bucketWidthSec) },
            { label: `${formatPaceLabel(secToMin(goalBucketMinSec - bucketWidthSec))}–${formatPaceLabel(secToMin(goalBucketMinSec))}`, min: secToMin(goalBucketMinSec - bucketWidthSec), max: secToMin(goalBucketMinSec) },
            { label: `${formatPaceLabel(secToMin(goalBucketMinSec))}–${formatPaceLabel(secToMin(goalBucketMaxSec))}`, min: secToMin(goalBucketMinSec), max: secToMin(goalBucketMaxSec) },
            { label: `${formatPaceLabel(secToMin(goalBucketMaxSec))}–${formatPaceLabel(secToMin(goalBucketMaxSec + bucketWidthSec))}`, min: secToMin(goalBucketMaxSec), max: secToMin(goalBucketMaxSec + bucketWidthSec) },
            { label: `>${formatPaceLabel(secToMin(goalBucketMaxSec + bucketWidthSec))}`, min: secToMin(goalBucketMaxSec + bucketWidthSec), max: 99 },
        ];

        // Compute total distance and average HR per bucket
        const bucketData = buckets.map(b => ({ label: b.label, distance: 0, hrSum: 0, count: 0 }));
        runs.forEach(a => {
            if (!a.avg_pace || a.avg_pace <= 0) return;
            const paceMinPerKm = (1000 / a.avg_pace) / 60; // convert m/s → min/km
            for (let i = 0; i < buckets.length; i++) {
                if (paceMinPerKm >= buckets[i].min && paceMinPerKm < buckets[i].max) {
                    bucketData[i].distance += a.distance || 0;
                    if (a.avg_hr) bucketData[i].hrSum += a.avg_hr;
                    bucketData[i].count++;
                    break;
                }
            }
        });

        const distances = bucketData.map(b => Math.round(b.distance * 10) / 10);

        // Pace-based colour scheme — 5 buckets, goal pace always index 2
        // (3rd column, green). Hot-to-cold gradient: red (too fast) → yellow
        // (slightly fast) → green (goal) → teal (slightly slow) → blue (slow).
        const barColors = [
            'rgba(196, 75, 75, 0.8)',    // 1st — fastest, red
            'rgba(204, 182, 42, 0.8)',   // 2nd — slightly faster, yellow
            'rgba(63, 123, 79, 0.8)',    // 3rd — goal pace, green
            'rgba(38, 139, 139, 0.8)',   // 4th — slightly slower, teal
            'rgba(69, 123, 157, 0.8)',   // 5th — slowest, blue
        ];

        const chartMuted = getComputedStyle(document.documentElement).getPropertyValue('--rgd-muted').trim() || '#5a7184';
        const chartGridColor = getComputedStyle(document.documentElement).getPropertyValue('--rgd-border').trim() || '#dce8f2';

        paceDistChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: buckets.map(b => b.label),
                datasets: [{
                    label: 'Total Distance (km)',
                    data: distances,
                    backgroundColor: barColors,
                    borderColor: barColors.map(c => c.replace('0.8', '1')),
                    borderWidth: 1,
                    borderRadius: 4,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const b = bucketData[ctx.dataIndex];
                                return `${ctx.raw} km · ${b.count} run${b.count !== 1 ? 's' : ''}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: 'Pace (min/km)', font: { family: 'Raleway', size: 11 }, color: chartMuted },
                        ticks: { font: { family: 'Raleway', size: 10 }, color: chartMuted }
                    },
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: 'Total Distance (km)', font: { family: 'Raleway', size: 11 }, color: chartMuted },
                        ticks: { font: { family: 'Raleway', size: 10 }, color: chartMuted, callback: v => Math.round(v) },
                        grid: { color: chartGridColor }
                    }
                }
            },
            plugins: [{
                // Custom plugin: draw a vertical line at the goal pace bucket
                id: 'goalPaceLine',
                afterDraw(chart) {
                    if (goalBucketIndex < 0) return;
                    const meta = chart.getDatasetMeta(0);
                    if (!meta.data.length) return;
                    const x = meta.data[goalBucketIndex].x;
                    const topY = chart.scales.y.top;
                    const bottomY = chart.scales.y.bottom;
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.setLineDash([6, 4]);
                    ctx.strokeStyle = 'rgba(196, 75, 75, 0.7)';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(x, topY);
                    ctx.lineTo(x, bottomY);
                    ctx.stroke();
                    // Label above the line
                    ctx.setLineDash([]);
                    ctx.fillStyle = '#c44b4b';
                    ctx.font = '600 11px Raleway';
                    ctx.textAlign = 'center';
                    ctx.fillText('Goal pace', x, topY - 8);
                    ctx.restore();
                }
            }]
        });
    }

    // =========================================================================
    // HR vs Pace Scatter — each dot is a run from the last 12 weeks
    // X = pace (min/km), Y = average HR (bpm), colour = recency
    // =========================================================================

    function renderHrPaceScatter(activities) {
        const canvas = document.getElementById('rgd-hr-pace-scatter');
        if (!canvas || !activities.length) return;
        if (hrPaceScatter) hrPaceScatter.destroy();

        // Filter to runs only: exclude non-running types (hiking etc.), warmup runs (<2km),
        // and require both pace + HR data, within the last 12 weeks
        const now = new Date();
        const twelveWeeksAgo = new Date(now.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);
        const validRuns = activities
            .filter(a => isRunningActivity(a) && (a.distance || 0) >= 2)
            .filter(a => a.avg_pace && a.avg_pace > 0 && a.avg_hr && a.avg_hr > 0 && a.start_time)
            .map(a => ({
                pace: (1000 / a.avg_pace) / 60, // m/s → min/km
                hr: a.avg_hr,
                date: parseDate(a.start_time),
                distance: a.distance || 0,
                name: a.name || '',
            }))
            .filter(r => r.date && r.date >= twelveWeeksAgo)
            .sort((a, b) => a.date - b.date); // oldest first

        if (!validRuns.length) return;

        // Map each run to a recency colour: dark green (oldest) → light green (newest)
        const minDate = validRuns[0].date.getTime();
        const maxDate = validRuns[validRuns.length - 1].date.getTime();
        const dateRange = maxDate - minDate || 1;

        // Build point data + per-point colours in parallel arrays for Chart.js scatter
        const scatterData = [];
        const pointColors = [];
        const pointBorders = [];

        validRuns.forEach(r => {
            const t = (r.date.getTime() - minDate) / dateRange; // 0 = oldest, 1 = newest
            // Dark green (#1a472a) → light green (#7ddf90) based on recency
            const r_col = Math.round(26 + t * 99);
            const g_col = Math.round(71 + t * 152);
            const b_col = Math.round(42 + t * 102);
            scatterData.push({
                x: Math.round(r.pace * 100) / 100,
                y: r.hr,
                distance: r.distance,
                date: r.date,
                name: r.name,
            });
            pointColors.push(`rgba(${r_col}, ${g_col}, ${b_col}, 0.7)`);
            pointBorders.push(`rgba(${r_col}, ${g_col}, ${b_col}, 1)`);
        });

        const chartMuted = getComputedStyle(document.documentElement).getPropertyValue('--rgd-muted').trim() || '#5a7184';
        const chartGridColor = getComputedStyle(document.documentElement).getPropertyValue('--rgd-border').trim() || '#dce8f2';

        hrPaceScatter = new Chart(canvas, {
            type: 'scatter',
            data: {
                datasets: [{
                    label: 'Runs',
                    data: scatterData,
                    pointBackgroundColor: pointColors,
                    pointBorderColor: pointBorders,
                    pointRadius: 6,
                    pointHoverRadius: 9,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const p = scatterData[ctx.dataIndex];
                                const paceStr = `${Math.floor(p.x)}:${String(Math.round((p.x % 1) * 60)).padStart(2, '0')}/km`;
                                const dateStr = p.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                return `${p.name || 'Run'}: ${paceStr} · ${p.y} bpm · ${p.distance}km · ${dateStr}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: 'Pace (min/km)', font: { family: 'Raleway', size: 11 }, color: chartMuted },
                        ticks: { font: { family: 'Raleway', size: 10 }, color: chartMuted },
                        grid: { color: chartGridColor },
                        // Reverse so faster paces (lower min/km) are on the left
                        reverse: true,
                    },
                    y: {
                        title: { display: true, text: 'Avg Heart Rate (bpm)', font: { family: 'Raleway', size: 11 }, color: chartMuted },
                        ticks: { font: { family: 'Raleway', size: 10 }, color: chartMuted },
                        grid: { color: chartGridColor }
                    }
                }
            }
        });
    }

    // =========================================================================
    // Radar chart — non-AI, uses /race-goal/radar (calculated from metrics)
    // =========================================================================

    const RADAR_DIMENSIONS = [
        'Lactate Threshold', 'Aerobic Endurance', 'Running Economy',
        'Strength / Durability', 'VO₂max / Speed', 'Fatigue Resistance'
    ];

    // Split a dimension label into two lines at the natural break point.
    // Used by the radar chart's pointLabels callback so labels take less
    // horizontal space, allowing a larger radar polygon — especially on mobile.
    // Returns an array of two strings for Chart.js multi-line rendering.
    function splitRadarLabel(label) {
        // Labels with a slash: break at the slash
        if (label.includes(' / ')) {
            const parts = label.split(' / ');
            return [parts[0], parts.slice(1).join(' / ')];
        }
        // Labels with a space: break at the last space so the second line
        // is shorter (e.g. "Lactate Threshold" → ["Lactate", "Threshold"])
        const spaceIdx = label.lastIndexOf(' ');
        if (spaceIdx > 0) {
            return [label.slice(0, spaceIdx), label.slice(spaceIdx + 1)];
        }
        // No break point — return as single-line
        return [label];
    }
    const RADAR_COLORS = [
        'rgba(196, 75, 75, 0.7)', 'rgba(63, 123, 79, 0.7)',
        'rgba(212, 160, 23, 0.7)', 'rgba(93, 109, 176, 0.7)',
        'rgba(69, 123, 157, 0.7)', 'rgba(56, 142, 142, 0.7)',
    ];
    const RADAR_KEYS = [
        'lactate_threshold', 'aerobic_endurance', 'running_economy',
        'strength_durability', 'vo2max_speed', 'fatigue_resistance'
    ];

    async function loadRadarData() {
        // Radar chart now uses AI radar scores as the single source of truth.
        // This function is kept for backward compatibility but delegates to loadAISummary
        // which fetches ai-radar and renders both the chart and the insight text.
        loadAISummary();
    }

    // Directly show the HTML tooltip at a given canvas-relative position.
    // Used by the label-click handler since chart.tooltip.setActiveElements()
    // doesn't reliably trigger the external tooltip handler when enabled:false.
    // dimIndex is the radar dimension index to show in the tooltip.
    function showRadarHtmlTooltip(chart, canvasX, canvasY, dimIndex) {
        let tooltipEl = document.getElementById('rgd-radar-tooltip');
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'rgd-radar-tooltip';
            tooltipEl.className = 'rgd-radar-tooltip';
            document.body.appendChild(tooltipEl);
        }

        const dimName = RADAR_DIMENSIONS[dimIndex] || 'Unknown';
        const score = radarValues10[dimIndex] !== undefined ? radarValues10[dimIndex] : '--';

        tooltipEl.innerHTML = `
            <a class="rgd-radar-tooltip-link" href="#" data-pillar-index="${dimIndex}">
                ${escapeHtml(dimName)}
            </a>
            <span class="rgd-radar-tooltip-score">${score}/10</span>
        `;

        // Wire up the link click — same as in the external handler
        const link = tooltipEl.querySelector('.rgd-radar-tooltip-link');
        if (link) {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const idx = parseInt(link.getAttribute('data-pillar-index'));
                const visiblePage = document.querySelector('.rgd-page:not([hidden])');
                if (!visiblePage) return;
                const pillar = visiblePage.querySelector(
                    `.rgd-pillars-content .rgd-pillar-card[data-pillar-index="${idx}"]`
                );
                if (pillar) {
                    pillar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    pillar.classList.add('rgd-pillar-highlight');
                    setTimeout(() => pillar.classList.remove('rgd-pillar-highlight'), 2000);
                }
                tooltipEl.style.opacity = 0;
            });
        }

        // Position relative to the canvas on the page
        const canvasRect = chart.canvas.getBoundingClientRect();
        const tooltipWidth = tooltipEl.offsetWidth;
        const tooltipHeight = tooltipEl.offsetHeight;

        let left = canvasRect.left + window.scrollX + canvasX - tooltipWidth / 2;
        let top = canvasRect.top + window.scrollY + canvasY - tooltipHeight - 10;

        if (left < 8) left = 8;
        if (left + tooltipWidth > window.innerWidth - 8) {
            left = window.innerWidth - tooltipWidth - 8;
        }
        if (top < window.scrollY + 8) {
            top = canvasRect.top + window.scrollY + canvasY + 10;
        }

        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.top = `${top}px`;
        tooltipEl.style.opacity = 1;
    }

    // External HTML tooltip for the radar chart — renders a real DOM element
    // instead of drawing on the canvas, so we can include a clickable link
    // that jumps to the corresponding pillar in the insights section.
    // The tooltip shows the dimension name as a link and the score below it.
    // Flag: when true, the tooltip is "pinned" by the user's mouse hovering
    // over it — prevents the external handler from hiding it when the mouse
    // leaves the radar dot. Cleared when the mouse leaves the tooltip element.
    let radarTooltipPinned = false;

    function radarExternalTooltipHandler(context) {
        const { chart, tooltip } = context;
        // Tooltip element — shared across all radar canvases, created once
        let tooltipEl = document.getElementById('rgd-radar-tooltip');

        // Create the tooltip container on first use
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'rgd-radar-tooltip';
            tooltipEl.className = 'rgd-radar-tooltip';
            document.body.appendChild(tooltipEl);

            // Pin the tooltip when the mouse enters it — this prevents
            // the external handler from hiding it when the mouse leaves
            // the radar dot, giving the user time to click the link inside
            tooltipEl.addEventListener('mouseenter', () => {
                radarTooltipPinned = true;
            });
            tooltipEl.addEventListener('mouseleave', () => {
                radarTooltipPinned = false;
                tooltipEl.style.opacity = 0;
            });
        }

        // Hide if no tooltip data or opacity is 0 — but not if the user
        // is hovering over the tooltip itself (pinned state)
        if (tooltip.opacity === 0) {
            if (!radarTooltipPinned) {
                tooltipEl.style.opacity = 0;
            }
            return;
        }

        // Build the tooltip content from the active tooltip data points
        if (tooltip.body) {
            const dp = tooltip.dataPoints[0];
            const dimIndex = dp.dataIndex;
            const dimName = RADAR_DIMENSIONS[dimIndex] || dp.label || 'Unknown';
            const score = dp.raw;

            tooltipEl.innerHTML = `
                <a class="rgd-radar-tooltip-link" href="#insights" data-pillar-index="${dimIndex}">
                    ${escapeHtml(dimName)}
                </a>
                <span class="rgd-radar-tooltip-score">${score}/10</span>
            `;

            // Wire up the link click — scroll to the corresponding pillar card
            // on the overview page (where the radar is), not the insights page.
            // Uses data-pillar-index attribute to find the right card within
            // the currently visible page's pillars container.
            const link = tooltipEl.querySelector('.rgd-radar-tooltip-link');
            if (link) {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const idx = parseInt(link.getAttribute('data-pillar-index'));
                    // Find the pillar card on the currently visible page —
                    // query within the visible page's pillars container only
                    const visiblePage = document.querySelector('.rgd-page:not([hidden])');
                    if (!visiblePage) return;
                    const pillar = visiblePage.querySelector(
                        `.rgd-pillars-content .rgd-pillar-card[data-pillar-index="${idx}"]`
                    );
                    if (pillar) {
                        pillar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // Briefly highlight the card so the user notices it
                        pillar.classList.add('rgd-pillar-highlight');
                        setTimeout(() => pillar.classList.remove('rgd-pillar-highlight'), 2000);
                    }
                    // Hide the tooltip after clicking the link
                    tooltipEl.style.opacity = 0;
                });
            }
        }

        // Position the tooltip relative to the canvas — account for the
        // canvas's position on the page plus Chart.js's internal offset
        const canvasRect = chart.canvas.getBoundingClientRect();
        const tooltipWidth = tooltipEl.offsetWidth;
        const tooltipHeight = tooltipEl.offsetHeight;

        // Center horizontally on the tooltip position, place above the point
        let left = canvasRect.left + window.scrollX + tooltip.caretX - tooltipWidth / 2;
        let top = canvasRect.top + window.scrollY + tooltip.caretY - tooltipHeight - 10;

        // Clamp within viewport — don't let it overflow off-screen
        if (left < 8) left = 8;
        if (left + tooltipWidth > window.innerWidth - 8) {
            left = window.innerWidth - tooltipWidth - 8;
        }
        // If it would go above the viewport, flip it below the point
        if (top < window.scrollY + 8) {
            top = canvasRect.top + window.scrollY + tooltip.caretY + 10;
        }

        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.top = `${top}px`;
        tooltipEl.style.opacity = 1;
    }

    function renderRadarChart(aiData) {
        // Store last radar data so charts can be re-rendered on theme change
        lastRadarData = aiData;
        // AI radar returns dimensions as [{name, score, note}] with 0-10 scores
        // Map the AI dimension names to the chart's expected order using normalized
        // matching — the AI may return slightly different names (e.g. "VO2max" vs "VO₂max")
        const dims = aiData.dimensions || [];

        // Normalize a dimension name for fuzzy matching:
        // lowercase, remove special chars (subscripts, slashes, spaces, hyphens)
        const normalizeName = (s) => s.toLowerCase().replace(/[₂₃₁₀]/g, m => ({'₂':'2','₃':'3','₁':'1','₀':'0'}[m])).replace(/[^a-z0-9]/g, '');

        // Build a normalized score map so "VO₂max / Speed" matches "VO2max / Speed" etc.
        const scoreMap = {};
        dims.forEach(d => {
            scoreMap[normalizeName(d.name)] = d.score;
        });
        // Build values in RADAR_DIMENSIONS order, using normalized lookup
        const values10 = RADAR_DIMENSIONS.map(name => {
            const score = scoreMap[normalizeName(name)];
            return score !== undefined ? Math.round(score * 10) / 10 : 0;
        });
        radarValues10 = values10;
        radarLabels = RADAR_DIMENSIONS;

        // Destroy any existing chart instances before re-creating
        radarCharts.forEach(c => c.destroy());
        radarCharts = [];

        // Create a Chart instance for each radar canvas (overview + readiness)
        const canvases = document.querySelectorAll('.rgd-radar-chart');
        canvases.forEach(canvas => {
            // Reset the loaded class so the canvas starts at opacity 0,
            // then add it after the chart is created to trigger the fade-in
            canvas.classList.remove('rgd-radar-loaded');
            // Read theme-aware colors from CSS variables for chart text and tooltip
            const cssNavy = getComputedStyle(document.documentElement).getPropertyValue('--rgd-navy').trim() || '#1d3557';
            const cssMuted = getComputedStyle(document.documentElement).getPropertyValue('--rgd-muted').trim() || '#5a7184';
            const cssBlue = getComputedStyle(document.documentElement).getPropertyValue('--rgd-blue').trim() || '#457b9d';
            // Tooltip background — use surface color so it adapts to theme
            const cssSurface = getComputedStyle(document.documentElement).getPropertyValue('--rgd-surface').trim() || '#ffffff';
            const cssText = getComputedStyle(document.documentElement).getPropertyValue('--rgd-text').trim() || '#1d3557';
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

            // On narrow screens (phone), use a smaller point label font to prevent clipping.
            // The canvas width determines whether we're in a compact layout.
            const isNarrow = canvas.clientWidth < 320;
            const pointLabelFontSize = isNarrow ? 11 : 13;

            radarCharts.push(new Chart(canvas, {
                type: 'radar',
                data: {
                    labels: RADAR_DIMENSIONS,
                    datasets: [{
                        data: values10,
                        backgroundColor: `rgba(69, 123, 157, 0.1)`,
                        borderColor: `rgba(69, 123, 157, 0.8)`,
                        borderWidth: 2,
                        pointBackgroundColor: RADAR_COLORS,
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2,
                        pointRadius: 5,
                        pointHoverRadius: 7,
                    }]
                },
                options: {
                    responsive: true,
                    // false: the chart fills the wrapper's flex-constrained height
                    // instead of expanding to maintain a square aspect ratio
                    maintainAspectRatio: false,
                    // Animate the radar polygon from center (0) to actual values
                    // when the chart is first created — creates a smooth grow-out
                    // effect as the data fills in after the skeleton fades out
                    animation: {
                        duration: 1200,
                        easing: 'easeOutQuart',
                    },
                    scales: {
                        r: {
                            beginAtZero: true, max: 10, min: 0,
                            // Hide tick number labels — only show grid lines
                            ticks: { display: false, stepSize: 2 },
                            pointLabels: {
                                font: { size: pointLabelFontSize, family: 'Raleway', weight: '600' },
                                color: cssNavy,
                                // Center-align multi-line labels so each line
                                // is centered at its position around the radar
                                align: 'center',
                                // Break labels into two lines to save horizontal
                                // space and allow a larger radar polygon
                                callback: (label) => splitRadarLabel(label),
                            },
                            // Darker grid/angle lines for better web visibility — theme-aware
                            grid: { color: `rgba(69, 123, 157, 0.25)` },
                            angleLines: { color: `rgba(69, 123, 157, 0.25)` },
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            // Use an external HTML tooltip so we can include a
                            // clickable link to the corresponding insight pillar.
                            // The built-in canvas tooltip can't render interactive HTML.
                            enabled: false,
                            external: radarExternalTooltipHandler,
                            // Theme-aware colors passed to the external handler via
                            // CSS variables on the tooltip element
                        }
                    },
                    // Click handler: clicking a point label area shows the tooltip.
                    // Since the external HTML tooltip is used (enabled: false),
                    // chart.tooltip.setActiveElements() doesn't trigger the
                    // external handler reliably. Instead, we directly show the
                    // HTML tooltip at the label's position.
                    onClick: (e, elements, chart) => {
                        // If a point (dot) was clicked, the external tooltip
                        // handler fires via normal interaction — don't interfere.
                        if (elements.length > 0) return;
                        const dims = RADAR_DIMENSIONS;
                        const scales = chart.scales.r;
                        const pos = Chart.helpers.getRelativePosition(e, chart);
                        // Check each label position — approximate by angle
                        const centerX = scales.xCenter;
                        const centerY = scales.yCenter;
                        const radius = scales.drawingArea;
                        const angleStep = (2 * Math.PI) / dims.length;
                        for (let i = 0; i < dims.length; i++) {
                            const angle = -Math.PI / 2 + i * angleStep;
                            // Label position is just outside the chart at the same angle
                            // — slightly further out since two-line labels are taller
                            const labelX = centerX + Math.cos(angle) * (radius + 20);
                            const labelY = centerY + Math.sin(angle) * (radius + 20);
                            const dist = Math.hypot(pos.x - labelX, pos.y - labelY);
                            if (dist < 40) {
                                // Directly show the HTML tooltip at the label position
                                showRadarHtmlTooltip(chart, labelX, labelY, i);
                                return;
                            }
                        }
                    },
                }
            }));

            // Trigger the canvas fade-in after Chart.js has rendered.
            // requestAnimationFrame ensures the initial paint at opacity 0
            // happens before we add the loaded class, so the transition fires.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    canvas.classList.add('rgd-radar-loaded');
                });
            });
        });
    }

    // =========================================================================
    // 6-Pillar AI Summary — uses /race-goal/ai-radar with localStorage cache
    // Cache keyed by session token + race goal hash, 6-hour TTL
    // =========================================================================

    const AI_CACHE_KEY = 'rgd_ai_radar_cache';
    const AI_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

    // Build a deterministic cache key from the session token and race goal
    function getAICacheKey() {
        const goalFingerprint = raceGoal ? `${raceGoal.purpose || ''}|${raceGoal.distance || ''}|${raceGoal.time_target || ''}|${raceGoal.race_date || ''}` : 'no-goal';
        return `${sessionToken || 'demo'}::${goalFingerprint}`;
    }

    // Try to read cached AI radar data from localStorage; returns null if expired or missing
    function readAICache() {
        try {
            const raw = localStorage.getItem(AI_CACHE_KEY);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            // Check that the cache matches the current session + goal
            if (entry.key !== getAICacheKey()) return null;
            // Check TTL expiry
            if (Date.now() - entry.timestamp > AI_CACHE_TTL_MS) return null;
            return entry.data;
        } catch (e) {
            return null;
        }
    }

    // Write AI radar data to localStorage cache
    function writeAICache(data) {
        try {
            localStorage.setItem(AI_CACHE_KEY, JSON.stringify({
                key: getAICacheKey(),
                timestamp: Date.now(),
                data: data,
            }));
        } catch (e) {
            // localStorage full or unavailable — silently skip caching
        }
    }

    // Clear the AI cache (called when user clicks "Regenerate Insights")
    function clearAICache() {
        localStorage.removeItem(AI_CACHE_KEY);
    }

    async function loadAISummary(forceRefresh = false) {
        if (forceRefresh) clearAICache();

        // Check cache first — if valid, render immediately without API call
        const cached = !forceRefresh ? readAICache() : null;
        if (cached) {
            showRadarSkeleton(false);
            renderRadarChart(cached);
            renderPillars(cached);
            refreshAnalysisBtn.hidden = false;
            return;
        }

        // No valid cache — show radar + pillars skeletons and fetch from API
        showRadarSkeleton(true);
        showPillarsSkeleton();
        summaryErrors.forEach(el => el.hidden = true);
        refreshAnalysisBtn.hidden = true;

        try {
            const resp = await apiCall('GET', 'ai-radar');
            const data = await resp.json();
            if (!resp.ok) {
                showRadarSkeleton(false);
                summaryErrors.forEach(el => {
                    el.textContent = data.error || 'Failed to load insights.';
                    el.hidden = false;
                });
                pillarsContents.forEach(el => el.hidden = true);
                refreshAnalysisBtn.hidden = false;
                return;
            }
            // Cache the successful response for future loads
            writeAICache(data);
            // Render both the radar chart and the insight text from the same AI data
            showRadarSkeleton(false);
            renderRadarChart(data);
            renderPillars(data);
        } catch (err) {
            showRadarSkeleton(false);
            summaryErrors.forEach(el => {
                el.textContent = 'Network error.';
                el.hidden = false;
            });
            pillarsContents.forEach(el => el.hidden = true);
            refreshAnalysisBtn.hidden = false;
        }
    }

    // Show/hide all radar skeleton overlays (overview + readiness page).
    // When hiding, fades the skeleton out via CSS opacity transition before
    // setting hidden=true — this creates a smooth crossfade with the chart
    // canvas which fades in simultaneously.
    function showRadarSkeleton(show) {
        document.querySelectorAll('.rgd-radar-skeleton').forEach(el => {
            if (show) {
                // Showing: unhide immediately and fade in
                el.hidden = false;
                // Force reflow so the transition triggers from opacity 0
                requestAnimationFrame(() => { el.classList.remove('rgd-fade-out'); });
            } else {
                // Hiding: fade out via CSS, then set hidden after transition ends
                el.classList.add('rgd-fade-out');
                const onFadeEnd = () => {
                    el.hidden = true;
                    el.classList.remove('rgd-fade-out');
                    el.removeEventListener('transitionend', onFadeEnd);
                };
                el.addEventListener('transitionend', onFadeEnd);
            }
        });
    }

    // Skeleton placeholder cards shown while AI is generating insights
    function showPillarsSkeleton() {
        const skeletonHtml = RADAR_DIMENSIONS.map((name, i) => `
            <div class="rgd-pillar-card rgd-pillar-card--skeleton">
                <div class="rgd-pillar-header">
                    <span class="rgd-pillar-dot" style="background:${RADAR_COLORS[i] || RADAR_COLORS[0]}"></span>
                    <span class="rgd-pillar-name">${name}</span>
                    <span class="rgd-pillar-score rgd-skeleton-text"></span>
                </div>
                <div class="rgd-skeleton-lines">
                    <div class="rgd-skeleton-line"></div>
                    <div class="rgd-skeleton-line"></div>
                    <div class="rgd-skeleton-line rgd-skeleton-line--short"></div>
                </div>
            </div>
        `).join('');
        pillarsContents.forEach(el => {
            el.hidden = false;
            el.innerHTML = skeletonHtml;
        });
    }

    function renderPillars(data) {
        // Show content on all instances (overview + insights pages)
        pillarsContents.forEach(el => el.hidden = false);
        summaryErrors.forEach(el => el.hidden = true);
        refreshAnalysisBtn.hidden = false;

        const dims = data.dimensions || [];

        // Overview page: quick summary only — no concrete data references.
        // Cards are clickable and navigate to the full insight on the
        // insights page, scrolling to the corresponding pillar card.
        const overviewHtml = dims.map((d, i) => `
            <div class="rgd-pillar-card rgd-pillar-card--summary" data-pillar-index="${i}">
                <div class="rgd-pillar-header">
                    <span class="rgd-pillar-dot" style="background:${RADAR_COLORS[i] || RADAR_COLORS[0]}"></span>
                    <span class="rgd-pillar-name">${escapeHtml(d.name)}</span>
                    <span class="rgd-pillar-score">${d.score}/10</span>
                </div>
                <p class="rgd-pillar-summary">${escapeHtml(d.summary || '')}</p>
                <span class="rgd-pillar-view-details">View details →</span>
            </div>
        `).join('');

        // Insights page: full breakdown with strengths and gaps, each
        // referencing specific data from the runner's activities.
        const insightsHtml = dims.map((d, i) => `
            <div class="rgd-pillar-card" data-pillar-index="${i}">
                <div class="rgd-pillar-header">
                    <span class="rgd-pillar-dot" style="background:${RADAR_COLORS[i] || RADAR_COLORS[0]}"></span>
                    <span class="rgd-pillar-name">${escapeHtml(d.name)}</span>
                    <span class="rgd-pillar-score">${d.score}/10</span>
                </div>
                <div class="rgd-pillar-section rgd-pillar-section--strengths">
                    <span class="rgd-pillar-section-label rgd-pillar-section-label--strengths">Strengths</span>
                    <p class="rgd-pillar-note">${escapeHtml(d.strengths || '')}</p>
                </div>
                <div class="rgd-pillar-section rgd-pillar-section--gaps">
                    <span class="rgd-pillar-section-label rgd-pillar-section-label--gaps">Gaps</span>
                    <p class="rgd-pillar-note">${escapeHtml(d.gaps || '')}</p>
                </div>
            </div>
        `).join('');

        // Fill each pillars-content container with the appropriate HTML.
        // The first container is on the overview page, the second on the
        // insights page — determined by which page element contains them.
        const overviewPage = document.getElementById('rgd-page-overview');
        const insightsPage = document.getElementById('rgd-page-insights');
        pillarsContents.forEach(el => {
            if (overviewPage && overviewPage.contains(el)) {
                el.innerHTML = overviewHtml;
            } else if (insightsPage && insightsPage.contains(el)) {
                el.innerHTML = insightsHtml;
            } else {
                // Fallback: use the full insights HTML for any unknown container
                el.innerHTML = insightsHtml;
            }
        });

        // Wire up click handlers on the overview summary cards — clicking
        // a card navigates to the insights page and scrolls the matching
        // pillar card into view with a brief highlight pulse
        if (overviewPage) {
            overviewPage.querySelectorAll('.rgd-pillar-card--summary').forEach(card => {
                card.addEventListener('click', () => {
                    const idx = card.getAttribute('data-pillar-index');
                    // Navigate to the insights page via hash routing
                    window.location.hash = 'insights';
                    // Scroll the corresponding pillar into view after the
                    // page is shown — short delay to allow the page to unhide
                    setTimeout(() => {
                        const pillar = insightsPage.querySelector(
                            `.rgd-pillars-content .rgd-pillar-card[data-pillar-index="${idx}"]`
                        );
                        if (pillar) {
                            pillar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            pillar.classList.add('rgd-pillar-highlight');
                            setTimeout(() => pillar.classList.remove('rgd-pillar-highlight'), 2000);
                        }
                    }, 100);
                });
            });
        }
    }

    // "Regenerate Insights" button — force a fresh AI call, bypassing the cache
    refreshAnalysisBtn.addEventListener('click', () => loadAISummary(true));

    // =========================================================================
    // Reset goal
    // =========================================================================

    // =========================================================================
    // Edit race goal popup — modal for changing the race goal after onboarding.
    // Opens a popup pre-filled with current values instead of sending the user
    // back to the onboarding screen. Submits to the same /api/onboarding endpoint.
    // =========================================================================

    const editGoalPopup = $('#rgd-edit-goal-popup');
    const editGoalClose = $('#rgd-edit-goal-close');
    const editGoalForm = $('#rgd-edit-goal-form');
    const editGoalBtn = $('#rgd-edit-goal-btn');
    let editGoalTrigger = null;

    // Open the edit-goal popup — pre-fills the form with the current race goal
    function openEditGoalPopup() {
        editGoalTrigger = document.activeElement;
        // Close the settings popup if it's open (mobile edit-goal flow)
        if (settingsPopup && !settingsPopup.hidden) closeSettingsPopup();

        // Pre-fill the form with current goal values
        if (raceGoal) {
            $('#rgd-edit-purpose').value = raceGoal.purpose || '';
            // Parse time target "HH:MM:SS" into separate fields
            const parts = (raceGoal.time_target || '00:00:00').split(':');
            $('#rgd-edit-time-h').value = parts[0] || '0';
            $('#rgd-edit-time-m').value = parts[1] || '00';
            $('#rgd-edit-time-s').value = parts[2] || '00';
            $('#rgd-edit-race-date').value = raceGoal.race_date || '';
            $('#rgd-edit-mileage').value = raceGoal.weekly_mileage || '';
            $('#rgd-edit-mileage-unit').value = raceGoal.mileage_unit || 'km';
            $('#rgd-edit-gender').value = raceGoal.gender || '';
            $('#rgd-edit-age').value = raceGoal.age || '';
        }
        editGoalPopup.hidden = false;
        editGoalClose.focus();
    }

    function closeEditGoalPopup() {
        editGoalPopup.hidden = true;
        // Clear any error states
        $$('.rgd-input.error').forEach(el => {
            // Only clear errors within the edit-goal form
            if (editGoalForm.contains(el)) el.classList.remove('error');
        });
        $$('.rgd-field-error').forEach(el => {
            if (editGoalForm.contains(el)) el.hidden = true;
        });
        if (editGoalTrigger) editGoalTrigger.focus();
    }

    // Edit-goal form submission — validates, saves to API, reloads dashboard data
    editGoalForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        // Clear previous error states within this form only
        $$('.rgd-input.error').forEach(el => {
            if (editGoalForm.contains(el)) el.classList.remove('error');
        });
        $$('.rgd-field-error').forEach(el => {
            if (editGoalForm.contains(el)) el.hidden = true;
        });

        const h = $('#rgd-edit-time-h').value || '0';
        const m = $('#rgd-edit-time-m').value || '00';
        const s = $('#rgd-edit-time-s').value || '00';
        const timeTarget = `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;

        const required = [
            { id: 'rgd-edit-purpose', val: $('#rgd-edit-purpose').value },
            { id: 'rgd-edit-time-h', val: timeTarget !== '00:00:00' ? timeTarget : '' },
            { id: 'rgd-edit-race-date', val: $('#rgd-edit-race-date').value },
            { id: 'rgd-edit-mileage', val: $('#rgd-edit-mileage').value },
            { id: 'rgd-edit-gender', val: $('#rgd-edit-gender').value },
            { id: 'rgd-edit-age', val: $('#rgd-edit-age').value },
        ];

        let hasError = false;
        for (const f of required) {
            if (!f.val) {
                const el = document.getElementById(f.id);
                if (el) el.classList.add('error');
                const fg = el && el.closest('.rgd-field');
                if (fg) { const er = fg.querySelector('.rgd-field-error'); if (er) er.hidden = false; }
                if (f.id === 'rgd-edit-time-h') {
                    ['rgd-edit-time-h','rgd-edit-time-m','rgd-edit-time-s'].forEach(id => {
                        const inp = document.getElementById(id); if (inp) inp.classList.add('error');
                    });
                    const dpErr = document.querySelector('#rgd-edit-duration-picker').nextElementSibling;
                    if (dpErr && dpErr.classList.contains('rgd-field-error')) dpErr.hidden = false;
                }
                hasError = true;
            }
        }
        if (hasError) return;

        setButtonLoading(editGoalBtn, true);
        const body = {
            purpose: $('#rgd-edit-purpose').value,
            distance: $('#rgd-edit-purpose').value,
            time_target: timeTarget,
            race_date: $('#rgd-edit-race-date').value,
            weekly_mileage: $('#rgd-edit-mileage').value,
            mileage_unit: $('#rgd-edit-mileage-unit').value,
            gender: $('#rgd-edit-gender').value,
            age: $('#rgd-edit-age').value,
        };
        try {
            // In demo mode, save locally without an API call
            if (window.__demoMode) {
                raceGoal = { ...body, saved_at: new Date().toISOString() };
            } else {
                const resp = await apiCall('POST', 'onboarding', body, true);
                const data = await resp.json();
                if (!resp.ok) { alert(data.error || 'Failed to save race goal.'); return; }
                raceGoal = data.goal;
            }
            localStorage.setItem('rgd_race_goal', JSON.stringify(raceGoal));
            // Goal changed — cached AI insights are no longer valid
            clearAICache();
            // Update the sidebar goal display
            sidebarGoalEl.textContent = `${raceGoal.purpose} — ${raceGoal.time_target}`;
            // Update the goal specifics panel
            renderGoalSpecifics(raceGoal);
            // Reload all data with the new goal (charts, radar, insights)
            loadAllData();
            closeEditGoalPopup();
        } catch (err) { alert('Network error. Please try again.'); }
        finally { setButtonLoading(editGoalBtn, false); }
    });

    // Close handlers — close button, click outside, Escape key
    editGoalClose.addEventListener('click', closeEditGoalPopup);
    editGoalPopup.addEventListener('click', (e) => {
        if (e.target === editGoalPopup) closeEditGoalPopup();
    });

    // Edit race goal — shared handler used by both the sidebar edit button
    // (desktop) and the settings popup edit button (mobile). Opens the
    // edit-goal popup instead of sending the user back to onboarding.
    function editGoal() {
        openEditGoalPopup();
    }

    $('#rgd-reset-goal-btn').addEventListener('click', editGoal);
    // Settings popup edit-goal button — shown only on mobile
    const settingsResetGoalBtn = $('#rgd-settings-reset-goal-btn');
    if (settingsResetGoalBtn) settingsResetGoalBtn.addEventListener('click', editGoal);

    // =========================================================================
    // Settings button — opens the login modal for Garmin connection
    // (Also handles logout if already connected)
    // =========================================================================

    // =========================================================================
    // Settings popup — shows Garmin account details, language (disabled), logout
    // =========================================================================
    const settingsPopup = $('#rgd-settings-popup');
    const settingsPopupClose = $('#rgd-settings-popup-close');
    const settingsLogoutBtn = $('#rgd-settings-logout-btn');

    async function openSettingsPopup() {
        if (sessionToken && sessionToken !== 'demo') {
            // Populate account details from the latest check-session data
            try {
                const resp = await apiCall('GET', 'check-session');
                const data = await resp.json();
                if (data.valid) {
                    $('#rgd-settings-name').textContent = data.full_name || data.display_name || '--';
                    $('#rgd-settings-email').textContent = data.email || '--';
                    $('#rgd-settings-device').textContent = data.device_name || '--';
                }
            } catch (e) {
                // Fallback to cached data
                $('#rgd-settings-name').textContent = displayName || '--';
                $('#rgd-settings-email').textContent = '--';
                $('#rgd-settings-device').textContent = '--';
            }
            // Real session — show disconnect button
            settingsLogoutBtn.textContent = 'Disconnect Garmin';
            settingsLogoutBtn.className = 'rgd-btn rgd-btn-danger';
        } else {
            // Demo mode — show placeholder + connect button
            $('#rgd-settings-name').textContent = 'Demo Runner';
            $('#rgd-settings-email').textContent = 'demo@example.com';
            $('#rgd-settings-device').textContent = 'Demo Device';
            settingsLogoutBtn.textContent = 'Connect Garmin';
            settingsLogoutBtn.className = 'rgd-btn rgd-btn-primary';
        }

        // Populate the mobile profile section — mirrors the sidebar's
        // avatar, display name, race goal, and edit button. Only visible
        // on mobile where the sidebar is hidden.
        const settingsAvatar = $('#rgd-settings-avatar');
        const settingsProfileName = $('#rgd-settings-profile-name');
        const settingsProfileGoal = $('#rgd-settings-profile-goal');
        if (settingsAvatar) {
            // Copy the same avatar content as the sidebar
            if (profileImageUrl) {
                settingsAvatar.innerHTML = `<img src="${profileImageUrl}" alt="${displayName || 'Runner'}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/><span class="rgd-avatar-initials" style="display:none">${getInitials(displayName)}</span>`;
            } else {
                const initials = getInitials(displayName);
                if (initials && !window.__demoMode) {
                    settingsAvatar.innerHTML = `<span class="rgd-avatar-initials">${initials}</span>`;
                } else {
                    settingsAvatar.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><path d="M8 22l3-8 2 2 3-2 2 8"/><path d="M9 12l-2-3"/><path d="M15 12l2-3"/></svg>`;
                }
            }
        }
        if (settingsProfileName) {
            settingsProfileName.textContent = displayName || 'Demo Runner';
        }
        if (settingsProfileGoal && raceGoal) {
            settingsProfileGoal.textContent = `${raceGoal.purpose} — ${raceGoal.time_target}`;
        } else if (settingsProfileGoal) {
            settingsProfileGoal.textContent = '';
        }

        // Focus management: store the triggering element and move focus
        // to the close button so keyboard users can dismiss the popup
        settingsPopupTrigger = settingsBtn;
        settingsPopup.hidden = false;
        settingsPopupClose.focus();
    }

    function closeSettingsPopup() {
        settingsPopup.hidden = true;
        // Return focus to the settings button that opened the popup
        if (settingsPopupTrigger) settingsPopupTrigger.focus();
    }

    let settingsPopupTrigger = null;
    settingsBtn.addEventListener('click', openSettingsPopup);
    settingsPopupClose.addEventListener('click', closeSettingsPopup);
    // Close when clicking outside the popup
    settingsPopup.addEventListener('click', (e) => {
        if (e.target === settingsPopup) closeSettingsPopup();
    });
    // Close on Escape key — matches the login modal and metric popup behavior
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !settingsPopup.hidden) closeSettingsPopup();
    });

    // Edit-goal popup Escape key handler
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !editGoalPopup.hidden) closeEditGoalPopup();
    });

    // =========================================================================
    // AI chat floating button + popup — currently locked as "coming soon"
    // =========================================================================

    const chatFab = $('#rgd-chat-fab');
    const chatPopup = $('#rgd-chat-popup');
    const chatPopupClose = $('#rgd-chat-popup-close');
    let chatPopupOpen = false;

    // Open the chat popup — hides the FAB and expands the popup from the
    // button's position using CSS transform animation
    function openChatPopup() {
        chatFab.classList.add('rgd-chat-fab--hidden');
        chatPopup.classList.add('rgd-chat-popup--open');
        chatPopupOpen = true;
        // Focus the close button after the expand animation settles
        setTimeout(() => chatPopupClose.focus(), 300);
    }

    // Close the chat popup — collapses back toward the FAB, then shows
    // the FAB again after the animation completes
    function closeChatPopup() {
        chatPopup.classList.remove('rgd-chat-popup--open');
        chatPopupOpen = false;
        // Show the FAB after the collapse animation finishes
        setTimeout(() => {
            chatFab.classList.remove('rgd-chat-fab--hidden');
            chatFab.focus();
        }, 200);
    }

    // Stop propagation on the FAB click so the document click-outside
    // listener doesn't immediately close the popup that just opened
    chatFab.addEventListener('click', (e) => {
        e.stopPropagation();
        openChatPopup();
    });
    chatPopupClose.addEventListener('click', closeChatPopup);
    // Close when clicking outside the popup card — since the popup is not a
    // full-screen overlay, we detect outside clicks via the document
    document.addEventListener('click', (e) => {
        if (!chatPopupOpen) return;
        // If the click was inside the popup card, don't dismiss
        if (chatPopup.contains(e.target)) return;
        // If the click was on the FAB, don't dismiss — the FAB's own click
        // handler will have already opened it
        if (chatFab.contains(e.target)) return;
        closeChatPopup();
    });
    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && chatPopupOpen) closeChatPopup();
    });

    // Settings popup action button — disconnect if logged in, connect if demo
    settingsLogoutBtn.addEventListener('click', () => {
        if (sessionToken && sessionToken !== 'demo') {
            if (confirm('Disconnect your Garmin account? You will return to demo mode.')) {
                closeSettingsPopup();
                logout();
            }
        } else {
            closeSettingsPopup();
            openLoginModal();
        }
    });

    // Mobile tab bar settings button — mirrors the sidebar settings button
    const tabSettingsBtn = $('#rgd-tab-settings');
    if (tabSettingsBtn) {
        tabSettingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openSettingsPopup();
        });
    }

    // Demo CTA buttons — open the login modal to connect Garmin
    const demoBannerCta = $('#rgd-demo-banner-cta');
    const demoPageCtaBtn = $('#rgd-demo-cta-btn');
    if (demoBannerCta) demoBannerCta.addEventListener('click', openLoginModal);
    if (demoPageCtaBtn) demoPageCtaBtn.addEventListener('click', openLoginModal);

    // "Show more" button on the overview page — navigates to the full
    // activities page where pagination is available
    const showMoreActivitiesBtn = $('#rgd-show-more-activities');
    if (showMoreActivitiesBtn) {
        showMoreActivitiesBtn.addEventListener('click', () => {
            window.location.hash = 'activities';
        });
    }

    // "Load more" button on the activities page — fetches the next batch
    // of activities from the API and appends them to the list
    const loadMoreActivitiesBtn = $('#rgd-load-more-activities');
    if (loadMoreActivitiesBtn) {
        loadMoreActivitiesBtn.addEventListener('click', loadMoreActivities);
    }

    // Dismiss the radar external HTML tooltip when clicking outside the
    // radar canvas or the tooltip itself — matches the behavior the user
    // expects from the previous canvas tooltip which stayed until clicking away
    document.addEventListener('click', (e) => {
        const tooltipEl = document.getElementById('rgd-radar-tooltip');
        if (!tooltipEl || tooltipEl.style.opacity === '0') return;
        // If the click was inside the tooltip (e.g. on the link), don't dismiss
        if (tooltipEl.contains(e.target)) return;
        // If the click was on a radar canvas, don't dismiss — the chart's
        // own click handler will update the tooltip
        if (e.target.classList && e.target.classList.contains('rgd-radar-chart')) return;
        // Otherwise hide the tooltip
        tooltipEl.style.opacity = 0;
    });

    // Logout function — shared between settings and session expiry
    async function logout() {
        try { await apiCall('DELETE', 'logout'); } catch (err) {}
        sessionToken = ''; displayName = 'Demo Runner'; raceGoal = null; profileImageUrl = '';
        if (mileageChart) { mileageChart.destroy(); mileageChart = null; }
        radarCharts.forEach(c => c.destroy()); radarCharts = [];
        if (paceDistChart) { paceDistChart.destroy(); paceDistChart = null; }
        if (hrPaceScatter) { hrPaceScatter.destroy(); hrPaceScatter = null; }
        // Clear all cached session data so the next load starts fresh
        localStorage.removeItem('rgd_session_token');
        localStorage.removeItem('rgd_race_goal');
        localStorage.removeItem('rgd_display_name');
        localStorage.removeItem('rgd_profile_image_url');
        clearAICache(); // clear cached AI insights when logging out
        loginForm.reset(); onboardForm.reset();
        // Return to demo mode instead of login screen
        startDemoMode();
    }

    // =========================================================================
    // Restore session or default to demo mode
    // =========================================================================

    const savedToken = localStorage.getItem('rgd_session_token');
    if (savedToken && savedToken !== 'demo') {
        // Real Garmin session — restore cached profile data for instant render
        sessionToken = savedToken;
        displayName = localStorage.getItem('rgd_display_name') || 'Runner';
        profileImageUrl = localStorage.getItem('rgd_profile_image_url') || '';
        const cachedRaceGoal = localStorage.getItem('rgd_race_goal');
        const hasCachedRaceGoal = cachedRaceGoal && cachedRaceGoal !== 'null';
        window.__demoMode = false;
        // Hide demo CTAs since we have a real session
        const demoCta = $('#rgd-demo-cta');
        if (demoCta) demoCta.hidden = true;

        // Show dashboard immediately from cached data — no flash of demo mode
        // while waiting for the check-session network round-trip
        if (hasCachedRaceGoal) {
            try { raceGoal = JSON.parse(cachedRaceGoal); } catch (e) {}
            showDashboard();
        } else {
            showScreen(onboardScreen);
        }

        // Verify session in the background — if invalid, fall back to demo mode
        apiCall('GET', 'check-session').then(async (resp) => {
            const data = await resp.json();
            if (data.valid) {
                // Update with fresh data from the server
                displayName = data.display_name || displayName;
                profileImageUrl = data.profile_image_url || profileImageUrl;
                // Update cache with latest profile data
                localStorage.setItem('rgd_display_name', displayName);
                localStorage.setItem('rgd_profile_image_url', profileImageUrl);
                // Refresh avatar + greeting in case the data changed
                greetingEl.textContent = displayName;
                updateAvatar();
                // If race goal state changed on the server, switch screens
                if (data.has_race_goal && !raceGoal) {
                    showDashboard();
                } else if (!data.has_race_goal && raceGoal) {
                    showScreen(onboardScreen);
                }
            } else {
                // Session expired — clear cache and fall back to demo mode
                sessionToken = '';
                localStorage.removeItem('rgd_session_token');
                localStorage.removeItem('rgd_display_name');
                localStorage.removeItem('rgd_profile_image_url');
                startDemoMode();
            }
        }).catch(() => {
            // Network error — keep showing the cached dashboard.
            // The user can still see their data; API calls will retry on the
            // next interaction. Don't flash demo mode for a transient error.
            console.warn('Session check failed (network error) — showing cached data');
        });
    } else {
        // No saved session or demo token — launch demo mode as default landing
        startDemoMode();
    }

});
