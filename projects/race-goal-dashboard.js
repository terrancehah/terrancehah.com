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
        // Start rotating through messages every 2.5 seconds
        let idx = 0;
        if (loadingMsgTimer) clearInterval(loadingMsgTimer);
        loadingMsgTimer = setInterval(() => {
            idx = (idx + 1) % LOADING_MESSAGES.length;
            overlayText.textContent = LOADING_MESSAGES[idx];
        }, 2500);
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

    // Login modal open/close — replaces the old full-screen login
    function openLoginModal() { loginModal.hidden = false; }
    function closeLoginModal() { loginModal.hidden = true; authError.hidden = true; }

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
        const types = [
            { type: 'running', icon: 'RUN', basePace: 320, baseHR: 148, cadence: 168 },
            { type: 'running', icon: 'RUN', basePace: 310, baseHR: 152, cadence: 170 },
            { type: 'trail_running', icon: 'TRL', basePace: 370, baseHR: 145, cadence: 162 },
            { type: 'running', icon: 'RUN', basePace: 280, baseHR: 160, cadence: 172 },
            { type: 'running', icon: 'RUN', basePace: 340, baseHR: 142, cadence: 166 },
        ];

        const distances = [5.2, 8.1, 10.0, 12.5, 6.3, 21.1, 7.0, 15.0, 4.8, 9.2,
                          11.3, 5.0, 8.7, 16.2, 6.0, 10.5, 3.5, 14.0, 7.5, 20.0];
        const names = [
            'Easy Morning Run', 'Tempo Session', 'Trail Recovery', 'Interval 400s',
            'Lunch Run', 'Long Run Sunday', 'Recovery Jog', 'Mid-Distance Steady',
            'Quick 5K', 'Hill Repeats', 'Progressive Run', 'Park Loop Easy',
            'Threshold 3x2km', 'Weekend Long Run', 'Shakeout Run', 'Fartlek Session',
            'Pre-Race Easy', 'Marathon Pace Run', 'Evening Recovery', 'Long Slow Distance'
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
            vo2max: 57, vo2max_date: '2026-08-15',
            fitness_age: 22,
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
        };
    }

    // Mock radar: flat format matching /race-goal/radar endpoint
    // Mock radar data in AI radar format — dimensions array with 0-10 scores
    // Uses strengths/gaps format matching the updated AI prompt
    function getMockRadarData() {
        return getMockPillars();
    }

    // Mock pillars: dimensions format matching /race-goal/ai-radar endpoint
    // Scores on 0-10 scale; each dimension has strengths and gaps sections
    function getMockPillars() {
        return {
            dimensions: [
                { name: 'Lactate Threshold', score: 6.8, strengths: 'Your recent tempo runs at 4:30/km show solid threshold development. The 2km repeat session last week demonstrates good lactate clearance at high effort. You are building the capacity to sustain race pace without accumulating fatigue.', gaps: 'You are missing dedicated threshold-pace intervals longer than 2km. For a 1:50 half marathon you need to sustain 5:13/km for 21km — your current threshold work is 1-2 minutes shorter than race-specific sets. Add one 3x3km at threshold pace session per week.' },
                { name: 'Aerobic Endurance', score: 7.5, strengths: 'Your weekly long runs of 16-21km are building a strong aerobic base. Consistent volume at 35km/week with 80% of runs in the easy zone shows good endurance discipline. You are close to where you need to be for the half marathon distance.', gaps: 'Your longest run is 21km but you have not yet pushed beyond race distance. For a half marathon, one or two runs of 22-24km in the final 6 weeks would build the durability you need. Your weekly volume could also increase to 40-45km for peak readiness.' },
                { name: 'Running Economy', score: 6.2, strengths: 'Your cadence is steady at 170-175 spm across most runs, which is in the efficient range. Pace consistency on easy days is good with low variability. You are maintaining form well at sub-threshold paces.', gaps: 'Your economy at race pace (5:13/km) has not been tested enough. You are missing strides and drills that improve efficiency at faster paces. Add 4-6x100m strides after easy runs to improve your neuromuscular coordination at race pace.' },
                { name: 'Strength / Durability', score: 5.5, strengths: 'Your training load is consistent with no major gaps in frequency. Elevation gain on trail runs adds musculoskeletal variety. You are running 4-5 times per week which gives a decent base of durability.', gaps: 'You have no visible strength training or cross-training in your activity history. For a half marathon, weak hips and glutes are common injury risks. You are behind where you need to be — add 1-2 strength sessions per week focusing on single-leg work and core stability.' },
                { name: 'VO₂max / Speed', score: 7.1, strengths: 'Your VO2max of 57 is strong for your age group and well above the threshold needed for a 1:50 half marathon. Interval sessions with 400m-800m repeats at 3:50-4:10/km pace show good max HR engagement. Your raw speed potential is well-developed.', gaps: 'Your interval sessions are infrequent — only 1-2 per month in the recent data. To maintain and improve VO2max for race day, you need weekly high-intensity work. You are close to where you need to be but could lose this fitness without consistent stimulus.' },
                { name: 'Fatigue Resistance', score: 5.8, strengths: 'Your back-to-back workout days show you can handle consecutive training stimuli. The long run the day after a tempo session demonstrates reasonable fatigue tolerance. You have a good pattern of hard-easy-hard that builds resistance.', gaps: 'Your pace drops off 8-12% in the final third of long runs, indicating fatigue accumulation. For race day you need to maintain pace through 21km. You are moderately prepared but need more negative-split long runs where you accelerate the final 5km to train late-race fatigue resistance.' },
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
            time_target: '01:45:00',
            race_date: '2026-11-15',
            weekly_mileage: '40',
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
            renderActivities(mockActs);
            renderMileageChart(mockActs);
            renderCalendar(mockActs);
            renderPaceDistribution(mockActs);
            // Show immediately — no skeletons in demo mode
            renderRadarChart(getMockRadarData());
            renderPillars(getMockPillars());
            return;
        }

        showOverlay('Loading your training data...');
        try {
            const [metricsResp, activitiesResp, mileageResp] = await Promise.all([
                apiCall('GET', 'metrics'),
                apiCall('GET', 'activities?limit=30'),
                apiCall('GET', 'weekly-mileage?weeks=12'),
            ]);
            const metricsData = await metricsResp.json();
            const activitiesData = await activitiesResp.json();
            const mileageData = await mileageResp.json();
            if (metricsResp.ok && metricsData.metrics) renderMetrics(metricsData.metrics);
            if (activitiesResp.ok && activitiesData.activities) {
                renderActivities(activitiesData.activities);
                renderCalendar(activitiesData.activities);
                // Pace distribution histogram + HR vs Pace scatter
                renderPaceDistribution(activitiesData.activities);
                renderHrPaceScatter(activitiesData.activities);
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
        // Lead weight icon — represents stress burden/pressure
        'Stress': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L14 8 L20 8 L15 12 L17 18 L12 14 L7 18 L9 12 L4 8 L10 8 Z"/></svg>',
        'Recovery': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><path d="M9 2 L15 2"/></svg>',
        // Calendar icon — represents biological age relative to chronological age
        'Fitness Age': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>',
    };

    // Metric metadata — min/max ranges, zone definitions, and explanations for the popup
    // Used by the metric card click-to-popup feature
    const METRIC_META = {
        'VO₂max': {
            min: 20, max: 80, unit: 'ml/kg/min',
            zones: [
                { label: 'Poor', max: 35, color: '#e07070' },
                { label: 'Fair', max: 45, color: '#e0b840' },
                { label: 'Good', max: 55, color: '#6ba3d0' },
                { label: 'Excellent', max: 80, color: '#5fae74' },
            ],
            explanation: 'VO₂max measures the maximum volume of oxygen your body can utilize during intense exercise. Higher values indicate better aerobic capacity. For marathon training, a VO₂max above 50 is generally considered good.',
        },
        'Readiness': {
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Low', max: 25, color: '#e07070' },
                { label: 'Fair', max: 50, color: '#e0b840' },
                { label: 'Good', max: 75, color: '#6ba3d0' },
                { label: 'High', max: 100, color: '#5fae74' },
            ],
            explanation: 'Training Readiness Score combines sleep, recovery, stress, and training load to indicate how prepared your body is for a workout. Higher scores mean you are more ready for intense training.',
        },
        'Sleep': {
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Poor', max: 50, color: '#e07070' },
                { label: 'Fair', max: 70, color: '#e0b840' },
                { label: 'Good', max: 85, color: '#6ba3d0' },
                { label: 'Excellent', max: 100, color: '#5fae74' },
            ],
            explanation: 'Sleep Score evaluates the quality and duration of your sleep based on movement, heart rate, and stress data. Scores above 70 indicate restorative sleep that supports recovery.',
        },
        'Body Battery': {
            min: 0, max: 100, unit: '%',
            zones: [
                { label: 'Low', max: 25, color: '#e07070' },
                { label: 'Fair', max: 50, color: '#e0b840' },
                { label: 'Good', max: 75, color: '#6ba3d0' },
                { label: 'High', max: 100, color: '#5fae74' },
            ],
            explanation: 'Body Battery estimates your available energy reserves throughout the day, draining with activity and stress, and recharging during sleep and rest. A high value means you are well-rested.',
        },
        'HRV': {
            min: 0, max: 100, unit: 'ms',
            zones: [
                { label: 'Low', max: 20, color: '#e07070' },
                { label: 'Fair', max: 35, color: '#e0b840' },
                { label: 'Good', max: 50, color: '#6ba3d0' },
                { label: 'Excellent', max: 100, color: '#5fae74' },
            ],
            explanation: 'Heart Rate Variability (HRV) measures the variation in time between heartbeats. Higher HRV typically indicates better cardiovascular fitness and recovery. A balanced HRV trend suggests your body is adapting well to training.',
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
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Low', max: 25, color: '#5fae74' },
                { label: 'Medium', max: 50, color: '#6ba3d0' },
                { label: 'High', max: 75, color: '#e0b840' },
                { label: 'Very High', max: 100, color: '#e07070' },
            ],
            explanation: 'Stress Level is derived from HRV, heart rate, and other physiological signals. Lower stress levels are better for recovery. Sustained high stress may indicate overtraining or external life stressors.',
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

    function renderMetrics(m) {
        // Removed Weekly and Runs/Week — not native Garmin-extracted metrics
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
        metricsGrid.innerHTML = tiles.map(t => `
            <div class="rgd-metric-tile" data-metric-label="${t.label}">
                <div class="rgd-metric-top">
                    <span class="rgd-metric-icon">${METRIC_ICONS[t.label] || ''}</span>
                    <span class="rgd-metric-label">${t.label}</span>
                </div>
                <div class="rgd-metric-value-row">
                    <span class="rgd-metric-value">${t.value}</span>
                    ${t.unit ? `<span class="rgd-metric-unit">${t.unit}</span>` : ''}
                </div>
            </div>
        `).join('');

        // Attach click handlers to each metric tile for the popup
        metricsGrid.querySelectorAll('.rgd-metric-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                const label = tile.getAttribute('data-metric-label');
                const valueEl = tile.querySelector('.rgd-metric-value');
                const value = valueEl ? parseFloat(valueEl.textContent) : null;
                openMetricPopup(label, isNaN(value) ? null : value);
            });
        });
    }

    // =========================================================================
    // Metric detail popup — gauge bar with color-coded zones and explanation
    // =========================================================================

    const metricPopup = $('#rgd-metric-popup');
    const metricPopupContent = $('#rgd-metric-popup-content');
    const metricPopupClose = $('#rgd-metric-popup-close');

    // Close popup on close button click, overlay click, or Escape key
    metricPopupClose.addEventListener('click', closeMetricPopup);
    metricPopup.addEventListener('click', (e) => {
        if (e.target === metricPopup) closeMetricPopup();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !metricPopup.hidden) closeMetricPopup();
    });

    function closeMetricPopup() {
        metricPopup.hidden = true;
    }

    function openMetricPopup(label, currentValue) {
        const meta = METRIC_META[label];
        if (!meta) return;

        // Calculate the position of the current value marker on the gauge (0-100%)
        const range = meta.max - meta.min;
        const valuePct = currentValue !== null
            ? Math.max(0, Math.min(100, ((currentValue - meta.min) / range) * 100))
            : null;

        // Build the zone segments for the gauge bar
        // Each zone is a colored segment spanning from the previous zone's max to this zone's max
        const zoneSegments = meta.zones.map((zone, i) => {
            const prevMax = i === 0 ? meta.min : meta.zones[i - 1].max;
            const leftPct = ((prevMax - meta.min) / range) * 100;
            const widthPct = ((zone.max - prevMax) / range) * 100;
            return { ...zone, leftPct, widthPct };
        });

        // Determine which zone the current value falls into
        const activeZone = currentValue !== null
            ? meta.zones.find(z => currentValue <= z.max) || meta.zones[meta.zones.length - 1]
            : null;

        // Build the zone legend items
        const zoneLegend = meta.zones.map(z => `
            <div class="rgd-gauge-legend-item${activeZone && activeZone.label === z.label ? ' rgd-gauge-legend-item--active' : ''}">
                <span class="rgd-gauge-legend-dot" style="background:${z.color}"></span>
                <span class="rgd-gauge-legend-text">${z.label}</span>
            </div>
        `).join('');

        // Build the gauge bar with zone segments and current value marker
        const gaugeBar = `
            <div class="rgd-gauge-bar">
                ${zoneSegments.map(zs => `
                    <div class="rgd-gauge-segment" style="left:${zs.leftPct}%; width:${zs.widthPct}%; background:${zs.color};"></div>
                `).join('')}
                ${valuePct !== null ? `<div class="rgd-gauge-marker" style="left:${valuePct}%;"></div>` : ''}
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

        metricPopup.hidden = false;
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
    function buildActivityListHtml(activities, showMonthTotal = false) {
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

        // Build HTML with month headers between groups.
        // Month totals only shown on the full activities page, not the overview.
        return groups.map(group => `
            <div class="rgd-activity-month-header">
                <span class="rgd-activity-month-name">${group.month} ${group.year}</span>
                ${showMonthTotal ? `<span class="rgd-activity-month-total">${Math.round(group.totalKm)} km</span>` : ''}
            </div>
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

        // Overview: 5 latest, grouped by month — no month totals
        activitiesList.innerHTML = buildActivityListHtml(runningOnly.slice(0, 5), false);
        // Full page: all activities, grouped by month — show month totals
        if (activitiesFull) activitiesFull.innerHTML = buildActivityListHtml(runningOnly, true);
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
    // Speedwork: pace faster than race goal pace
    // LSD: distance > 12km (long slow distance)
    // Easy: everything else (base/recovery mileage)
    function classifyRun(a) {
        if (!a.avg_pace || a.avg_pace <= 0) return { label: 'Run', className: 'rgd-run-tag--easy' };
        const dist = a.distance || 0;

        // Warmup: runs shorter than 2km — excluded from charts
        if (dist < 2) {
            return { label: 'Warmup', className: 'rgd-run-tag--warmup' };
        }
        // Speedwork: the run's average pace (m/s) is faster than the race goal pace
        if (raceGoalPaceMs > 0 && a.avg_pace > raceGoalPaceMs) {
            return { label: 'Speedwork', className: 'rgd-run-tag--speedwork' };
        }
        // LSD: distance exceeds 12km — long endurance run
        if (dist > 12) {
            return { label: 'LSD', className: 'rgd-run-tag--lsd' };
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
                <div class="rgd-activity-header" onclick="this.parentElement.classList.toggle('open')">
                    <div class="rgd-activity-summary">
                        <div class="rgd-activity-icon">${iconSvg}</div>
                        <span class="rgd-activity-name">${escapeHtml(a.name)}</span>
                        <span class="rgd-activity-date">${date}</span>
                        <span class="rgd-run-tag ${runTag.className}">${runTag.label}</span>
                    </div>
                    <div class="rgd-activity-meta">
                        <span class="rgd-activity-stat">${a.distance} <strong>km</strong></span>
                        <span class="rgd-activity-stat"><strong>${pace}</strong>/km</span>
                        <span class="rgd-activity-stat"><strong>${hr}</strong></span>
                        <span class="rgd-activity-stat">${ascent} <strong>↑</strong></span>
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

    function renderPaceDistribution(activities) {
        const canvas = document.getElementById('rgd-pace-distribution-chart');
        if (!canvas || !activities.length) return;
        if (paceDistChart) paceDistChart.destroy();

        // Filter: only running activities, exclude warmup (<2km) and non-running types
        const runs = activities.filter(a => isRunningActivity(a) && (a.distance || 0) >= 2);
        if (!runs.length) return;

        // Compute goal pace in decimal min/km to find which bucket it falls in
        const goalPaceMinPerKm = raceGoalPaceMs > 0 ? (1000 / raceGoalPaceMs) / 60 : 0;

        // Fixed 30-second pace buckets — 6 columns total
        const buckets = [
            { label: '<4:00', min: 0, max: 4.0 },
            { label: '4:00–4:30', min: 4.0, max: 4.5 },
            { label: '4:30–5:00', min: 4.5, max: 5.0 },
            { label: '5:00–5:30', min: 5.0, max: 5.5 },
            { label: '5:30–6:00', min: 5.5, max: 6.0 },
            { label: '>6:00', min: 6.0, max: 99 },
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

        // Find which bucket the goal pace falls into
        const goalBucketIndex = buckets.findIndex(b => goalPaceMinPerKm >= b.min && goalPaceMinPerKm < b.max);

        // Pace-based colour scheme for 6 fixed buckets:
        // Goal bucket: green. Faster: red → orange. Slower: dark green → blue → navy
        const pacePalette = [
            'rgba(196, 75, 75, 0.8)',    // Fastest — red
            'rgba(212, 160, 23, 0.8)',   // Faster — orange
            'rgba(63, 123, 79, 0.8)',    // Goal pace — green
            'rgba(47, 93, 59, 0.8)',     // Slightly slower — dark green
            'rgba(69, 123, 157, 0.8)',   // Slower — light blue
            'rgba(29, 53, 87, 0.8)',     // Slowest — navy
        ];

        let barColors;
        if (goalBucketIndex >= 0) {
            // Shift the palette so goal bucket always gets green (index 2)
            const shift = 2 - goalBucketIndex;
            barColors = buckets.map((_, i) => {
                const idx = Math.min(Math.max(i + shift, 0), pacePalette.length - 1);
                return pacePalette[idx];
            });
        } else {
            barColors = pacePalette;
        }

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
            const pointLabelFontSize = isNarrow ? 9 : 11;

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
                    scales: {
                        r: {
                            beginAtZero: true, max: 10, min: 0,
                            // Hide tick number labels — only show grid lines
                            ticks: { display: false, stepSize: 2 },
                            pointLabels: {
                                font: { size: pointLabelFontSize, family: 'Raleway', weight: '600' },
                                color: cssNavy,
                                // Make labels clickable via callback — we handle
                                // clicks separately on the canvas element below
                            },
                            // Darker grid/angle lines for better web visibility — theme-aware
                            grid: { color: `rgba(69, 123, 157, 0.25)` },
                            angleLines: { color: `rgba(69, 123, 157, 0.25)` },
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            // Theme-aware tooltip — surface bg with text color font
                            backgroundColor: cssSurface,
                            titleColor: cssText,
                            bodyColor: cssText,
                            borderColor: isDark ? '#2a3f56' : '#dce8f2',
                            borderWidth: 1,
                            titleFont: { family: 'Raleway', size: 12 },
                            bodyFont: { family: 'Lato', size: 14 },
                            callbacks: {
                                label: (ctx) => `${ctx.raw}/10`,
                            }
                        }
                    },
                    // Click handler: clicking a point label area shows the score
                    onClick: (e, elements, chart) => {
                        // If a point was clicked, the default tooltip handles it.
                        // Otherwise check if a label area was clicked.
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
                            const labelX = centerX + Math.cos(angle) * (radius + 18);
                            const labelY = centerY + Math.sin(angle) * (radius + 18);
                            const dist = Math.hypot(pos.x - labelX, pos.y - labelY);
                            if (dist < 35) {
                                // Show a temporary tooltip at the label position
                                chart.tooltip.setActiveElements([{
                                    datasetIndex: 0,
                                    index: i,
                                }], { x: pos.x, y: pos.y });
                                chart.update();
                                return;
                            }
                        }
                    },
                }
            }));
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

    // Show/hide all radar skeleton overlays (overview + readiness page)
    function showRadarSkeleton(show) {
        document.querySelectorAll('.rgd-radar-skeleton').forEach(el => {
            el.hidden = !show;
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
        const html = dims.map((d, i) => `
            <div class="rgd-pillar-card">
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
        // Fill every pillars-content container (overview + insights pages)
        pillarsContents.forEach(el => el.innerHTML = html);
    }

    // "Regenerate Insights" button — force a fresh AI call, bypassing the cache
    refreshAnalysisBtn.addEventListener('click', () => loadAISummary(true));

    // =========================================================================
    // Reset goal
    // =========================================================================

    $('#rgd-reset-goal-btn').addEventListener('click', () => {
        raceGoal = null;
        localStorage.removeItem('rgd_race_goal');
        clearAICache(); // goal changed — cached insights are no longer valid
        sidebarGoalEl.textContent = '';
        // Return to onboarding
        if (mileageChart) { mileageChart.destroy(); mileageChart = null; }
        radarCharts.forEach(c => c.destroy()); radarCharts = [];
        if (paceDistChart) { paceDistChart.destroy(); paceDistChart = null; }
        if (hrPaceScatter) { hrPaceScatter.destroy(); hrPaceScatter = null; }
        onboardForm.reset();
        showScreen(onboardScreen);
    });

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
        settingsPopup.hidden = false;
    }

    function closeSettingsPopup() { settingsPopup.hidden = true; }

    settingsBtn.addEventListener('click', openSettingsPopup);
    settingsPopupClose.addEventListener('click', closeSettingsPopup);
    // Close when clicking outside the popup
    settingsPopup.addEventListener('click', (e) => {
        if (e.target === settingsPopup) closeSettingsPopup();
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
