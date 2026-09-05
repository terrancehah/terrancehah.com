// RunAssist — full rewrite.
// Single-page dashboard: metric tiles, column chart, calendar,
// activity history, AI radar, AI summary. Collapsible sidebar.

document.addEventListener('DOMContentLoaded', function () {

    // =========================================================================
    // Config
    // =========================================================================
    const API_BASE = '/projects/runassist/api';

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // Screens — login is now a modal, not a full screen
    const loginModal = $('#rgd-login-modal');
    const loginModalClose = $('#rgd-login-modal-close');
    const onboardScreen = $('#rgd-onboarding-screen');
    const onboardPlanScreen = $('#rgd-onboarding-plan-screen');
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
    const onboardPlanForm = $('#rgd-onboard-plan-form');
    const onboardPlanBtn = $('#rgd-onboard-plan-btn');

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
    // Pillars content appears on both overview and readiness pages — use class
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
    let lastPaceDistActivities = null; // stored for theme-change re-render
    let hrPaceScatter = null; // HR vs Pace scatter plot
    let lastHrPaceActivities = null; // stored for theme-change re-render
    let lastHrvStatus = null; // Garmin HRV status string — used for color-coding

    // Track when training vitals were last fetched from the API, so the
    // auto-refresh mechanism (visibilitychange + setInterval) can decide
    // whether enough time has passed to warrant a background re-fetch.
    let lastDataFetchTime = 0;

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

    // Rotating loading messages — cycles through motivational phrases while data loads.
    // The overlay text is wrapped in a .rgd-shimmer-text span so the shimmer
    // animation persists even as the text content rotates.
    const LOADING_MESSAGES = [
        'Loading your training data…',
        'Crunching the numbers…',
        'Reviewing your progress…',
        'Almost there…',
        'Preparing your dashboard…',
        'Syncing with Garmin…',
    ];
    let loadingMsgTimer = null;

    // Update the shimmer text inside the overlay — preserves the span element
    // so the CSS animation isn't interrupted on each message rotation.
    function setOverlayText(text) {
        const shimmer = overlayText.querySelector('.rgd-shimmer-text');
        if (shimmer) {
            shimmer.textContent = text;
        } else {
            overlayText.innerHTML = `<span class="rgd-shimmer-text">${escapeHtml(text)}</span>`;
        }
    }

    function showOverlay(text) {
        setOverlayText(text);
        overlay.hidden = false;
        // Start rotating through messages every 4 seconds
        let idx = 0;
        if (loadingMsgTimer) clearInterval(loadingMsgTimer);
        loadingMsgTimer = setInterval(() => {
            idx = (idx + 1) % LOADING_MESSAGES.length;
            setOverlayText(LOADING_MESSAGES[idx]);
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
        [onboardScreen, onboardPlanScreen, dashboardScreen].forEach(s => s.hidden = true);
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
        // Reposition the sidebar nav indicator after the collapse/expand
        // transition completes — the nav items change width so the indicator
        // needs to follow. Disable the ready class during the layout change
        // so the indicator tracks smoothly with the collapsing items rather
        // than lagging behind, then re-enable after.
        if (navIndicator) {
            navIndicator.classList.remove('rgd-indicator-ready');
            // Track the nav width during the CSS transition (0.2s)
            const trackInterval = setInterval(() => positionIndicators(), 16);
            setTimeout(() => {
                clearInterval(trackInterval);
                positionIndicators();
                navIndicator.classList.add('rgd-indicator-ready');
            }, 250);
        }
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
            if (lastPaceDistActivities) {
                renderPaceDistribution(lastPaceDistActivities);
            }
            if (lastHrPaceActivities) {
                renderHrPaceScatter(lastHrPaceActivities);
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
        // Position the sliding indicators behind the now-active items
        positionIndicators();
    }

    // Sliding indicators — frosted/tinted backgrounds that animate their
    // position to sit behind whichever nav item or tab is active.
    // On first render the indicators jump without transition; after that
    // the .rgd-indicator-ready class enables smooth sliding.
    const tabIndicator = $('#rgd-tab-indicator');
    const navIndicator = $('#rgd-nav-indicator');
    let indicatorsReady = false;

    function positionIndicators() {
        // Mobile tab bar indicator — match the active tab item's rect
        if (tabIndicator) {
            const activeTab = document.querySelector('.rgd-tab-item.active');
            if (activeTab) {
                const tabRect = activeTab.getBoundingClientRect();
                const barRect = activeTab.parentElement.getBoundingClientRect();
                tabIndicator.style.left = `${tabRect.left - barRect.left}px`;
                tabIndicator.style.top = `${tabRect.top - barRect.top}px`;
                tabIndicator.style.width = `${tabRect.width}px`;
                tabIndicator.style.height = `${tabRect.height}px`;
            }
        }
        // Sidebar nav indicator — match the active nav item's rect
        if (navIndicator) {
            const activeNav = document.querySelector('.rgd-nav-item.active');
            if (activeNav) {
                const navRect = activeNav.getBoundingClientRect();
                const parentRect = activeNav.parentElement.getBoundingClientRect();
                navIndicator.style.left = `${navRect.left - parentRect.left}px`;
                navIndicator.style.top = `${navRect.top - parentRect.top}px`;
                navIndicator.style.width = `${navRect.width}px`;
                navIndicator.style.height = `${navRect.height}px`;
            }
        }
        // Enable transitions after the first positioning so the indicator
        // doesn't slide in from the top-left on initial load
        if (!indicatorsReady) {
            requestAnimationFrame(() => {
                tabIndicator?.classList.add('rgd-indicator-ready');
                navIndicator?.classList.add('rgd-indicator-ready');
                indicatorsReady = true;
            });
        }
    }

    // Listen for hash changes
    window.addEventListener('hashchange', () => navigateTo(getPageFromHash()));

    // Re-tap active tab scrolls to top — when the user taps the tab that
    // is already active, the hash doesn't change so hashchange never fires.
    // This click listener detects that case and scrolls to the top of the
    // page so the user can quickly get back to the start of a long page.
    $$('.rgd-tab-item[href]').forEach(item => {
        item.addEventListener('click', (e) => {
            const targetPage = item.getAttribute('href').replace('#', '');
            const currentPage = getPageFromHash();
            // Only scroll to top if the tapped tab is already the active page.
            // If it's a different page, let the normal hashchange flow handle it.
            if (targetPage === currentPage) {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    });

    // Reposition indicators on viewport resize — the tab bar and sidebar
    // nav item dimensions change across breakpoints, so the indicators
    // need to follow. Debounced via requestAnimationFrame to avoid
    // excessive calls during drag-resize.
    let resizeRaf = null;
    window.addEventListener('resize', () => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
            positionIndicators();
            resizeRaf = null;
        });
    });

    // Scroll-direction handler — drives two scroll-aware UI behaviours:
    //   1. The mobile tab bar slides down below the bottom edge when the
    //      user scrolls down and slides back up when they scroll up.
    //   2. The demo banner collapses into a slim "Demo Mode · Connect"
    //      pill when scrolling down and recovers to the full banner when
    //      scrolling up. Both are toggled by adding/removing a single
    //      modifier class so the CSS transitions handle the animation.
    //
    // Implementation follows the industry-standard pattern used by
    // Safari-style scroll-to-hide bars: deltas ACCUMULATE in the current
    // direction and only commit past a threshold. This reacts to intent,
    // not every pixel — a trackpad's jittery micro-scrolls and Safari's
    // momentum tail (where the delta sign wobbles frame to frame) can't
    // flip the state. The accumulator resets on direction change and at
    // the top of the page, and the first scroll event is ignored so
    // scroll restoration doesn't read as a jump.
    const SCROLL_COMMIT_PX = 24;   // accumulated px before committing a hide/show
    const SCROLL_TOP_PX = 24;      // always visible within this distance from top
    // Always visible within this distance from the bottom. Matches the
    // mobile content's padding-bottom (7rem ≈ 112px) so the tab bar
    // reappears just as the user enters the padded zone, keeping the
    // gap justified instead of leaving empty space below content.
    const SCROLL_BOTTOM_PX = 120;
    let lastScrollY = window.scrollY;
    let scrollDir = 'up';          // currently applied direction
    let scrollAccum = 0;           // accumulated px in the candidate direction
    let scrollTicking = false;
    let firstScroll = true;
    function updateScrollDirection() {
        const currentY = window.scrollY;
        const delta = currentY - lastScrollY;

        // Demo banner slim — shrink only when the banner has reached its
        // sticky position at the top of the viewport. The banner is
        // position:sticky with top: clamp(1rem, 2vw, 1.5rem).
        //
        // CRITICAL: we must NOT read the banner's own getBoundingClientRect
        // for the threshold. When the banner shrinks to a pill, its height
        // decreases, which shifts the content below it, which changes the
        // banner's rect.top, which can cross back past the exit threshold,
        // which expands the banner, which shifts content back, which
        // crosses the enter threshold again — an infinite flicker loop.
        // No amount of hysteresis on the banner's rect.top fixes this
        // because the signal (rect.top) is coupled to the action (shrink).
        //
        // Instead, we read the CONTENT container's rect.top — a stable
        // signal that does NOT change when the banner shrinks. The banner
        // is the first child inside .rgd-content, so the banner's natural
        // top = contentRect.top + contentPaddingTop. The banner sticks
        // when this natural top <= the sticky top offset. With content
        // padding of clamp(1rem, 3vw, 2rem) (16-32px) and sticky top of
        // clamp(1rem, 2vw, 1.5rem) (16-24px), the banner sticks when
        // contentRect.top reaches roughly 0 to -8px. Using contentRect.top
        // <= 0 as the enter threshold covers the full clamp range.
        //
        // Hysteresis (40px gap) prevents edge-case flicker at the boundary,
        // though the signal is already stable so this is just insurance.
        const banner = $('#rgd-demo-banner');
        if (banner && !banner.hidden) {
            const content = $('#rgd-content');
            if (content) {
                const contentTop = content.getBoundingClientRect().top;
                const isSlim = banner.classList.contains('rgd-demo-banner--slim');
                if (!isSlim && contentTop <= 0) {
                    banner.classList.add('rgd-demo-banner--slim');
                } else if (isSlim && contentTop > 40) {
                    banner.classList.remove('rgd-demo-banner--slim');
                }
            }
        }

        // Ignore the very first scroll event so scroll restoration on
        // page load doesn't register as a downward jump.
        if (firstScroll) {
            firstScroll = false;
            lastScrollY = currentY;
            scrollTicking = false;
            return;
        }

        // Always visible near the top — reset to "up" (shown) state.
        if (currentY <= SCROLL_TOP_PX) {
            scrollAccum = 0;
            if (scrollDir !== 'up') {
                scrollDir = 'up';
                applyScrollDirection(false);
            }
            lastScrollY = currentY;
            scrollTicking = false;
            return;
        }

        // Always visible near the bottom — the content has a large
        // padding-bottom on mobile to clear the floating tab bar. If the
        // tab bar is hidden (from scrolling down) but the user reaches
        // the bottom, that padding becomes a huge empty gap. Forcing the
        // tab bar to show near the bottom keeps the padding justified and
        // gives the user navigation options after finishing the page.
        const scrollHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.innerHeight;
        const distanceFromBottom = scrollHeight - currentY - viewportHeight;
        if (distanceFromBottom <= SCROLL_BOTTOM_PX) {
            scrollAccum = 0;
            if (scrollDir !== 'up') {
                scrollDir = 'up';
                applyScrollDirection(false);
            }
            lastScrollY = currentY;
            scrollTicking = false;
            return;
        }

        // Determine the candidate direction from this frame's delta.
        // If it matches the current direction, accumulate; if it flips,
        // reset the accumulator to this delta (starting fresh in the new
        // direction). Near-zero deltas (momentum tail) don't accumulate
        // or reset — they're just noise.
        if (Math.abs(delta) < 1) {
            // Noise — don't touch the accumulator
        } else if (delta > 0) {
            // Scrolling down
            if (scrollDir === 'down') {
                scrollAccum += delta;
            } else {
                // Direction change candidate — reset accumulator
                scrollAccum = delta;
            }
        } else {
            // Scrolling up
            if (scrollDir === 'up') {
                scrollAccum += delta; // delta is negative, so this accumulates upward
            } else {
                scrollAccum = delta;
            }
        }

        // Commit a direction change only when the accumulated movement
        // in the candidate direction clears the threshold. This is the
        // key to preventing flicker: one deliberate scroll flick hides,
        // but jitter around zero does nothing.
        if (scrollDir === 'up' && scrollAccum >= SCROLL_COMMIT_PX) {
            scrollDir = 'down';
            applyScrollDirection(true);
        } else if (scrollDir === 'down' && scrollAccum <= -SCROLL_COMMIT_PX) {
            scrollDir = 'up';
            applyScrollDirection(false);
        }

        lastScrollY = currentY;
        scrollTicking = false;
    }

    // Apply the scroll direction to the DOM — toggles the tab bar hide
    // class only. The demo banner slim state is handled separately in
    // updateScrollDirection based on whether the banner has reached its
    // sticky position at the top of the viewport, not on scroll direction.
    function applyScrollDirection(hide) {
        const tabbar = $('#rgd-tabbar');
        if (tabbar) tabbar.classList.toggle('rgd-tabbar--hidden', hide);
    }

    window.addEventListener('scroll', () => {
        if (!scrollTicking) {
            scrollTicking = true;
            requestAnimationFrame(updateScrollDirection);
        }
    }, { passive: true });

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
            // run_tag is hardcoded per mock type — demo mode has no server to
            // run the classifier, so the tag is stamped at generation time
            { type: 'running', icon: 'RUN', basePace: 400, baseHR: 145, cadence: 168, maxPaceRatio: 1.08, anaerobic: 0.5, tag: 'Easy' },  // Easy 6:40/km
            { type: 'running', icon: 'RUN', basePace: 390, baseHR: 149, cadence: 166, maxPaceRatio: 1.1, anaerobic: 0.6, tag: 'LSD' },  // Long 6:30/km
            { type: 'running', icon: 'RUN', basePace: 350, baseHR: 158, cadence: 172, maxPaceRatio: 1.12, anaerobic: 1.6, tag: 'Speedwork' },  // Tempo 5:50/km
            { type: 'running', icon: 'RUN', basePace: 300, baseHR: 166, cadence: 176, maxPaceRatio: 1.3, anaerobic: 2.5, tag: 'Speedwork' },  // Interval 5:00/km
            { type: 'trail_running', icon: 'TRL', basePace: 430, baseHR: 138, cadence: 164, maxPaceRatio: 1.1, anaerobic: 0.4, tag: 'Easy' }, // Recovery 7:10/km
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

        // Realistic weekly run schedule — 5 runs per week with rest days
        // between each. Pattern repeats every 7 days going back from today.
        // Day offsets within each week: Tue(1), Wed(2), Thu(3), Sat(5), Sun(6)
        // — Mon and Fri are rest days, giving gaps between every run.
        const weeklyOffsets = [1, 2, 3, 5, 6];

        for (let i = 0; i < 20; i++) {
            const weekBack = Math.floor(i / weeklyOffsets.length);
            const dayInWeek = i % weeklyOffsets.length;
            const daysAgo = weekBack * 7 + weeklyOffsets[dayInWeek];
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
                max_pace: parseFloat((paceMs * t.maxPaceRatio).toFixed(2)), // m/s — for speed ratio signal
                avg_hr: hr,
                max_hr: maxHr,
                calories: Math.round(durMin * (7 + Math.random() * 3)),
                elevation_gain: parseFloat(elev.toFixed(1)),
                training_effect: parseFloat((2 + Math.random() * 2.5).toFixed(1)),
                anaerobic_training_effect: t.anaerobic, // feeds the anaerobic signal
                avg_cadence: cad,
                run_tag: t.tag, // hardcoded tag for demo mode (no server classifier)
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
            device_name: 'Forerunner 165',
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
    // Scores on 0-10 scale, integers only per the AI prompt's scoring rules.
    // Mock data is calibrated to the demo race goal (KL Half Marathon, 2:10:00,
    // ~6:10/km goal pace, 35km/week, VO2max 52) and references paces, HR,
    // cadence, and distances from generateMockActivities(). Writing style
    // matches the renewed AI prompt: coach-like, no jargon, one HR form per
    // sentence, strengths/gaps follow the plain-words-then-proof structure.
    function getMockPillars() {
        return {
            dimensions: [
                { name: 'Lactate Threshold', score: 6, summary: 'You can hold a comfortably hard pace for short blocks, but you have not yet stretched that effort to race distance. This is a real limiter for your goal — the question is whether you can stay at race effort without fading over 21km. Targeted work here will make the biggest difference on race day.', strengths: 'You have a foundation of threshold work to build on, which means your body knows what race effort feels like. Your 3x2km repeat session at 5:00/km shows you can hold a gear faster than race pace for short blocks. That is a useful starting point for extending the duration.', gaps: 'The thing to fix is simple — your threshold blocks are too short to confirm you can hold goal pace under fatigue. A 2km repeat at 5:00/km is faster than race pace but only lasts about 10 minutes. Add one session of 3x3km at 6:00/km each week so your body learns to hold race effort for longer stretches.' },
                { name: 'Aerobic Endurance', score: 7, summary: 'Your weekly volume and long-run distance are where they need to be for a half marathon. You are keeping your easy days genuinely easy, which is building the base without overcooking it. You are on track — a small volume bump in the final weeks would seal it.', strengths: 'Your aerobic base is solid enough to carry you through race day. You are running 35km per week with long runs reaching 21km, and most of your easy running sits at 6:40/km in an easy zone — that is good discipline. The consistent 4 to 5 runs per week tells me your body is absorbing the load well.', gaps: 'One small push would make you race-ready — your longest run matches race distance but has not gone past it. A single 22 to 24km long run in the next few weeks would give you that extra buffer. Bumping weekly volume to around 40km would also help without adding much risk.' },
                { name: 'Running Economy', score: 6, summary: 'Your cadence is steady and your easy-day pacing is consistent, but you have not tested your efficiency at goal race pace enough. You are missing the small neuromuscular work that makes race pace feel cheaper. This is a moderate gap that a few strides would fix quickly.', strengths: 'Your form is stable and efficient at the paces you run most often. Cadence sits around 168 to 172 spm across your easy and long runs, which is a good range for your pace. You are not wasting energy bouncing between strides, and that consistency matters over 21km.', gaps: 'The missing piece is neuromuscular sharpness at race pace — most of your runs are either faster tempo work or slower easy efforts. You have no strides or drills in your recent history. Add 4 to 6x100m strides after two easy runs per week to make 6:10/km feel lighter on race day.' },
                { name: 'Strength / Durability', score: 6, summary: 'Your training frequency is consistent, but you have no dedicated strength work or hill sessions to back it up. This is the kind of gap that does not show up until the late stages of a race, when your legs start to lose shape. Sorting this out now will keep you strong through the final 5km.', strengths: 'Your body is handling the running load well, which is the first box to tick. You are running 4 to 5 times a week with no gaps in frequency, and your trail runs add some elevation variety — up to 120m of gain in a session. That gives you a reasonable base of durability to build on.', gaps: 'The single most useful thing you can add is a weekly strength session — there is nothing in your history beyond running. Weak hips and glutes are the most common reason half marathoners fade late. Add one 20-minute session of single-leg squats, calf raises, and core holds each week to keep your form intact past 15km.' },
                { name: 'VO₂max / Speed', score: 7, summary: 'You have a useful speed reserve above your goal pace, and your aerobic capacity supports the race. The concern is that your high-intensity work is too sparse to hold onto it. Keep the stimulus weekly and you will arrive on race day with enough in the tank.', strengths: 'Your raw aerobic capacity gives you a comfortable cushion above race pace. Your VO2max of 52 is solid for your age, and your 400m intervals at 4:40/km show you can access a gear well faster than 6:10/km. That gap between your interval pace and goal pace is exactly what you want.', gaps: 'The risk is not a lack of speed — it is that you are not visiting it often enough. Your interval sessions show up only once or twice a month, and without weekly stimulus your VO2max will drift down. Add one short interval session per week, even just 6x400m, to keep that speed reserve locked in.' },
                { name: 'Fatigue Resistance', score: 6, summary: 'You can train back-to-back days without breaking down, but your pace drops off in the late stages of long runs. That fade is the kind of thing that turns a 2:10 into a 2:15 on race day. The good news is this responds quickly to targeted late-run pace work.', strengths: 'You bounce back the next day well, which tells me your body handles consecutive training stimuli. The day after a tempo session you are still running your easy run at the right pace, not grinding through it. That hard-easy pattern is building real resistance.', gaps: 'The thing to fix is your late-run pace — you are dropping off 8 to 12 percent in the final third of long runs. For a 2:10:00 target you need to hold 6:10/km all the way through. Add one negative-split long run per week where you run the final 5km at goal pace to train your legs to finish strong.' },
            ]
        };
    }

    // Mock overall insight — the coach's top-level assessment that synthesizes
    // across all six dimensions into a single narrative. Unlike the per-pillar
    // insights, this does not focus on one dimension but tells the runner where
    // they stand overall, what their biggest strength is, what their biggest
    // gap is, and what to focus on next. Calibrated to the demo race goal
    // (KL Half Marathon, 2:10:00, 35km/week, VO2max 52).
    function getMockOverallInsight() {
        return {
            // Overall verdict — a short label that summarises readiness
            verdict: 'On track, with work to do',
            // Overall readiness score — average of the six dimension scores
            score: 6,
            // Summary paragraph — the coach's opening assessment
            summary: 'Your aerobic base and speed reserve are solid for a 2:10 half marathon, and your training consistency tells me you are taking this seriously. The gap between where you are and where you need to be is closeable in the time you have left — but only if you shift your focus from logging miles to targeted work. Your threshold blocks are too short, your long-run pace fades late, and you have no strength work to keep your form intact past 15km. Fix those three things and you will arrive on race day ready.',
            // Key takeaways — the single biggest strength and biggest gap
            topStrength: {
                label: 'Aerobic Endurance',
                note: 'Your weekly volume and long-run distance are exactly where they need to be. You are running 35km per week with long runs reaching 21km, and your easy days are genuinely easy. This base will carry you through race day.',
            },
            topGap: {
                label: 'Lactate Threshold',
                note: 'Your threshold blocks are too short to confirm you can hold race pace under fatigue. A 2km repeat at 5:00/km is faster than race pace but only lasts 10 minutes. Add 3x3km at 6:00/km each week to stretch that effort to race distance.',
            },
            // What to focus on next — the single most impactful action
            focus: 'Add one 3x3km threshold session per week at 6:00/km. This is the highest-impact change you can make — it directly addresses your biggest gap and builds the specific fitness you need to hold race pace for 21km.',
        };
    }

    // Start demo mode — used as the default landing and after logout
    function startDemoMode() {
        sessionToken = 'demo';
        displayName = 'Demo Runner';
        raceGoal = {
            race_name: 'Kuala Lumpur Standard Chartered Half Marathon',
            purpose: 'Half Marathon',
            distance: 'Half Marathon',
            time_target: '02:10:00',
            race_date: '2026-10-03',
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
            // Pre-seed the AI insights and coach plan caches from the server's
            // persistent store so a new device renders instantly without
            // waiting for expensive AI calls. The background refresh will
            // validate and update these if new activities exist.
            if (data.cached_ai_insights) {
                writeAICache(data.cached_ai_insights);
            }
            if (data.cached_coach_plan) {
                writeCoachCache(data.cached_coach_plan);
            }
            // Close modal and proceed — if the user has a persisted race goal
            // from a previous session, show a reminder popup so they can keep,
            // edit, or replace it. Otherwise go to onboarding as before.
            closeLoginModal();
            window.__demoMode = false;
            if (data.has_race_goal && data.race_goal) {
                // Store the restored goal so the dashboard can use it
                raceGoal = data.race_goal;
                localStorage.setItem('rgd_race_goal', JSON.stringify(raceGoal));
                // Show the reminder popup instead of going straight to the
                // dashboard or onboarding — the user should consciously
                // decide whether to keep their old goal.
                showGoalReminderPopup(data.race_goal);
            } else {
                // New user or no persisted goal — go to onboarding
                showScreen(onboardScreen);
            }
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
            race_name: $('#rgd-race-name').value,
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
            // Proceed to Step 3 — planning preferences
            showScreen(onboardPlanScreen);
        } catch (err) { alert('Network error. Please try again.'); }
        finally { setButtonLoading(onboardBtn, false); }
    });

    // Step 3 — planning preferences. Saves the runner's plan prefs and
    // proceeds to the dashboard. The prefs are stored locally and used
    // when the coach plan is first generated on the Plan page.
    onboardPlanForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const prefs = {
            days_per_week: Number($('#rgd-onboard-pref-days').value) || 3,
            intensity: $('#rgd-onboard-pref-intensity').value || 'moderate',
            distance_adj: DISTANCE_ADJ[Number($('#rgd-onboard-pref-distance').value)] || 'keep',
        };
        coachPrefs = prefs;
        writeCoachPrefs(prefs);
        // Force AI refresh — the user just set a new goal, so any cached
        // insights from a previous goal are no longer valid.
        showDashboard(true);
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

    function showDashboard(forceAIRefresh = false) {
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

        loadAllData(forceAIRefresh);
        // If the user landed directly on the Plan page, kick off its load too
        if (getPageFromHash() === 'plan') openPlanPage();

        // Re-position the sidebar/tab indicators now that the dashboard is
        // visible. On initial page load, navigateTo() runs before the
        // dashboard screen is unhidden, so getBoundingClientRect() returns
        // zeros and the indicator is invisible until the next page change.
        // Calling it here ensures the active nav highlight appears immediately.
        requestAnimationFrame(() => positionIndicators());
    }

    // Render the Race Goal panel with key metrics + countdown
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
        // Race name is shown first (if set) as a full-width row, then the
        // remaining stats fill the 2-column grid: 1-2-2 layout
        const stats = [
            ...(goal.race_name ? [{ label: 'Race Name', value: goal.race_name, unit: '', fullWidth: true }] : []),
            { label: 'Race Type', value: goal.purpose || '--', unit: '' },
            { label: 'Race Date', value: goal.race_date ? new Date(goal.race_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '--', unit: '' },
            { label: 'Target Time', value: goal.time_target || '--', unit: '' },
            { label: 'Target Pace', value: targetPace, unit: targetPace === '--' ? '' : '/km' },
        ];

        grid.innerHTML = stats.map(s => `
            <div class="rgd-goal-stat${s.fullWidth ? ' rgd-goal-stat--full' : ''}">
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

    async function loadAllData(forceAIRefresh = false) {
        const isDemo = window.__demoMode;

        if (isDemo) {
            // Use mock data — no API calls. Metrics/activity list/calendar
            // render immediately; the charts + AI pillars show a loading
            // state for DEMO_CHART_LOADING_MS to simulate the real fetch
            // before their values appear.
            renderMetrics(getMockMetrics());
            const mockActs = generateMockActivities();
            // Overview shows 5 latest; full page shows all mock activities
            renderActivities(mockActs);
            renderCalendar(mockActs);
            // Hide the "Load more" button in demo mode — all 20 mock
            // activities are already shown
            const loadMoreBtn = $('#rgd-load-more-activities');
            if (loadMoreBtn) loadMoreBtn.hidden = true;
            // Charts + pillars load after a simulated 3s delay in demo mode
            setDemoChartsLoading(true);
            showPillarsSkeleton();
            showOverallInsightSkeleton(true);
            setTimeout(() => {
                // Destroy loading charts first so the canvases are free
                // for the real chart instances to render on
                setDemoChartsLoading(false);
                renderMileageChart(getMockWeeklyMileage());
                renderPaceDistribution(mockActs);
                renderHrPaceScatter(mockActs);
                renderRadarChart(getMockRadarData());
                renderPillars(getMockPillars());
                renderOverallInsight(getMockOverallInsight());
            }, DEMO_CHART_LOADING_MS);
            return;
        }

        // Transitioning from demo to real mode — destroy any chart instances
        // left over from demo mock data so the user doesn't see stale values
        // while the real data loads. Show the skeleton immediately so the
        // radar enters a clear loading state.
        radarCharts.forEach(c => c.destroy());
        radarCharts = [];
        lastRadarData = null;
        if (mileageChart) { mileageChart.destroy(); mileageChart = null; }
        lastMileageWeeks = null;
        if (paceDistChart) { paceDistChart.destroy(); paceDistChart = null; }
        lastPaceDistActivities = null;
        if (hrPaceScatter) { hrPaceScatter.destroy(); hrPaceScatter = null; }
        lastHrPaceActivities = null;
        showRadarSkeleton(true);
        // Hide pillars content until real AI data arrives
        pillarsContents.forEach(el => el.hidden = true);

        showOverlay('Loading your training data...');

        // Stale-while-revalidate: render cached metrics + mileage instantly
        // so the dashboard appears without waiting for the API round-trip.
        // The fresh fetch below will re-render if the data has changed.
        const cachedMetrics = readSWRCache(METRICS_CACHE_KEY);
        if (cachedMetrics.data) renderMetrics(cachedMetrics.data);
        const cachedMileage = readSWRCache(MILEAGE_CACHE_KEY);
        if (cachedMileage.data) renderMileageChart(cachedMileage.data);

        // Mileage data is rendered AFTER the overlay hides so the bar
        // grow-from-zero animation is visible to the user (creating the
        // chart under the overlay would play the animation invisibly).
        let mileageWeeks = null;
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
            if (metricsResp.ok && metricsData.metrics) {
                renderMetrics(metricsData.metrics);
                writeSWRCache(METRICS_CACHE_KEY, metricsData.metrics);
            }
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
                mileageWeeks = mileageData.weeks;
                writeSWRCache(MILEAGE_CACHE_KEY, mileageData.weeks);
            }
        } catch (err) { console.error('Load error:', err); }
        hideOverlay();
        // Record the fetch time so the auto-refresh mechanism knows when
        // the data was last refreshed from the API.
        lastDataFetchTime = Date.now();

        // Render the mileage chart now that the overlay is gone — its bars
        // grow from the x-axis to their final height as a visible entrance.
        // Skip if already rendered from cache (stale-while-revalidate) to
        // avoid replaying the entrance animation when fresh data matches.
        if (mileageWeeks && !cachedMileage.data) renderMileageChart(mileageWeeks);

        // AI radar + insight text load together — AI scores are the single
        // source of truth for both the radar chart and the pillar analysis.
        // When forceAIRefresh is true (e.g. after a goal change), pass the
        // force flag so the server skips its persistent cache and regenerates.
        loadAISummary(forceAIRefresh);
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
            explanation: 'Stress Level is derived from HRV, heart rate, and other body signals. Garmin classifies stress as Rest (0-25), Low (26-50), Medium (51-75), and High (76-100). Lower stress levels are better for recovery.',
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

        // Display "Last Garmin sync" inline with the section title, aligned right.
        // Uses fetched_at (server timestamp) for the time, and metrics_date
        // to decide whether to show "today", "yesterday", or the calendar date.
        // "Sync" (not "updated") makes it clear the timestamp reflects when
        // Garmin last synced the watch — not when our site fetched the data.
        // Format: "Last Garmin sync: today, 3:45 PM" or
        //         "Last Garmin sync: yesterday, 9:30 AM" or
        //         "Last Garmin sync: Aug 15, 9:30 AM"
        const metricsDateEl = $('#rgd-metrics-date');
        if (metricsDateEl && m.metrics_date) {
            const dataDate = new Date(m.metrics_date + 'T00:00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const isToday = dataDate.getTime() === today.getTime();
            const isYesterday = dataDate.getTime() === yesterday.getTime();
            // Use fetched_at for the time component; fall back to metrics_date if missing
            const fetchedAt = m.fetched_at ? new Date(m.fetched_at) : dataDate;
            const timeStr = fetchedAt.toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit'
            });
            const dateStr = isToday
                ? 'today'
                : isYesterday
                ? 'yesterday'
                : dataDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            metricsDateEl.textContent = `Last Garmin sync: ${dateStr}, ${timeStr}`;
            metricsDateEl.hidden = false;
        }

        // Build tile data — values are color-coded based on Garmin's official
        // tier zones. HRV color-coding uses the Garmin status field.
        // Tile order matters: the first 4 are "primary" vitals shown on
        // mobile by default (Readiness, Sleep, Recovery, Body Battery).
        // The remaining 5 are "extra" vitals hidden behind a Show More
        // button on mobile (max-width: 30rem), and always visible on
        // larger screens.
        const tiles = [
            { label: 'Readiness', value: m.training_readiness_score || '--', unit: m.training_readiness_level ? m.training_readiness_level.charAt(0) + m.training_readiness_level.slice(1).toLowerCase() : '' },
            { label: 'Sleep', value: m.sleep_score || '--', unit: '/100' },
            { label: 'Recovery', value: m.recovery_time_hrs || '--', unit: 'hrs' },
            { label: 'Body Battery', value: m.body_battery || '--', unit: '%' },
            { label: 'VO₂max', value: m.vo2max || '--', unit: 'ml/kg/min' },
            { label: 'HRV', value: m.hrv_last_night_avg || '--', unit: 'ms' },
            { label: 'Resting HR', value: m.resting_hr || '--', unit: 'bpm' },
            { label: 'Stress', value: m.stress_level || '--', unit: '/100' },
            { label: 'Fitness Age', value: m.fitness_age || '--', unit: 'years' },
        ];
        // Number of primary vitals shown on mobile before the Show More button
        const MOBILE_PRIMARY_VITALS = 4;
        // Render primary tiles as direct grid children, then wrap extra tiles
        // in a collapsible container (.rgd-metrics-extra > .rgd-metrics-extra-inner).
        // On desktop, both wrappers use display:contents so all tiles flow in
        // the parent grid as before. On mobile, the outer wrapper animates its
        // grid-template-rows from 0fr to 1fr for a smooth expand/collapse.
        const primaryTiles = tiles.slice(0, MOBILE_PRIMARY_VITALS);
        const extraTiles = tiles.slice(MOBILE_PRIMARY_VITALS);

        const renderTile = (t) => {
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
        };

        metricsGrid.innerHTML =
            primaryTiles.map(renderTile).join('') +
            `<div class="rgd-metrics-extra"><div class="rgd-metrics-extra-inner">` +
            extraTiles.map(renderTile).join('') +
            `</div></div>`;

        // Chevron disclosure toggle — mobile only. Toggles the --expanded
        // class on the grid to reveal/hide the extra tiles. Updates
        // aria-expanded for screen reader state and swaps the label text.
        const vitalsToggle = $('#rgd-vitals-show-more');
        if (vitalsToggle) {
            // Check if we're on a mobile viewport (matches the CSS breakpoint)
            const isMobile = window.matchMedia('(max-width: 30rem)').matches;
            vitalsToggle.hidden = !isMobile;
            // Reset to collapsed state on each render
            metricsGrid.classList.remove('rgd-metrics-grid--expanded');
            vitalsToggle.setAttribute('aria-expanded', 'false');
            const toggleLabel = vitalsToggle.querySelector('.rgd-vitals-toggle-label');
            if (toggleLabel) toggleLabel.textContent = 'More vitals';
            vitalsToggle.onclick = () => {
                const expanded = metricsGrid.classList.toggle('rgd-metrics-grid--expanded');
                vitalsToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                if (toggleLabel) toggleLabel.textContent = expanded ? 'Fewer vitals' : 'More vitals';
            };
        }

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
    // Scoring guide modal — explains the 0-10 AI score scale. Same open/close
    // behaviour as the metric popup: close button, overlay click, or Escape.
    // =========================================================================

    const scoreModal = $('#rgd-score-modal');
    const scoreModalClose = $('#rgd-score-modal-close');
    let scoreModalTrigger = null;

    function openScoreModal() {
        if (!scoreModal) return;
        scoreModalTrigger = document.activeElement;
        scoreModal.hidden = false;
        // Move focus to the close button so keyboard users can dismiss
        // the modal immediately without tabbing through the full content
        scoreModalClose.focus();
    }

    function closeScoreModal() {
        if (!scoreModal) return;
        scoreModal.hidden = true;
        // Return focus to the info button that opened the modal
        if (scoreModalTrigger) scoreModalTrigger.focus();
    }

    scoreModalClose.addEventListener('click', closeScoreModal);
    // Close modal when clicking the overlay background
    scoreModal.addEventListener('click', (e) => {
        if (e.target === scoreModal) closeScoreModal();
    });
    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !scoreModal.hidden) closeScoreModal();
    });
    // Wire up every scoring info button (overview section + readiness page) to the modal
    document.querySelectorAll('.rgd-score-info-btn').forEach(btn => {
        btn.addEventListener('click', openScoreModal);
    });

    // Dimensions explainer modal — explains the six radar dimensions.
    // Mirrors the scoring guide modal's open/close behaviour so both info
    // modals respond to the close button, overlay click, and Escape key.
    const dimensionModal = $('#rgd-dimension-modal');
    const dimensionModalClose = $('#rgd-dimension-modal-close');
    let dimensionModalTrigger = null;

    function openDimensionModal() {
        if (!dimensionModal) return;
        dimensionModalTrigger = document.activeElement;
        dimensionModal.hidden = false;
        // Move focus to the close button so keyboard users can dismiss
        // the modal immediately without tabbing through the full content
        dimensionModalClose.focus();
    }

    function closeDimensionModal() {
        if (!dimensionModal) return;
        dimensionModal.hidden = true;
        // Return focus to the info button that opened the modal
        if (dimensionModalTrigger) dimensionModalTrigger.focus();
    }

    dimensionModalClose.addEventListener('click', closeDimensionModal);
    // Close modal when clicking the overlay background
    dimensionModal.addEventListener('click', (e) => {
        if (e.target === dimensionModal) closeDimensionModal();
    });
    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dimensionModal.hidden) closeDimensionModal();
    });
    // Wire up every dimensions info button to the modal
    document.querySelectorAll('.rgd-dimension-info-btn').forEach(btn => {
        btn.addEventListener('click', openDimensionModal);
    });

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

        // Flag so the stagger only plays on the initial render, not on
        // chart.update() calls (e.g. theme-driven data swaps)
        let mileageDelayed = false;
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
                // Entrance animation: bars grow from zero at the x-axis and
                // rise one after another (left → right) in a staggered wave.
                // Chart.js animates bar height from the scale base (0) by
                // default; the per-bar delay creates the cascade effect.
                animation: {
                    duration: 700,
                    easing: 'easeOutQuart',
                    delay: (ctx) => {
                        if (ctx.type === 'data' && ctx.mode === 'default' && !mileageDelayed) {
                            return ctx.dataIndex * 45;
                        }
                        return 0;
                    },
                    onComplete: () => { mileageDelayed = true; },
                },
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
                        // Standardized tooltip properties — shared across all
                        // Chart.js tooltips so they look identical regardless
                        // of chart type (bar, scatter, etc.)
                        displayColors: false,
                        padding: 8,
                        cornerRadius: 6,
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

        // Collect every run for each day of the current month, keeping each
        // run's tag so dots can be coloured by run type. A day with two
        // different run types gets a split (left/right halves) dot.
        const dayRuns = {}; // day -> [{ name, tag, distance, pace, hr }]
        activities.forEach(a => {
            if (!isRunningActivity(a)) return;
            const d = parseDate(a.start_time);
            if (isNaN(d.getTime())) return;
            if (d.getMonth() === month && d.getFullYear() === year) {
                const day = d.getDate();
                const tag = a.run_tag || 'Easy';
                (dayRuns[day] = dayRuns[day] || []).push({
                    name: a.name || 'Run',
                    tag,
                    distance: a.distance || 0,
                    pace: a.avg_pace ? formatPace(a.avg_pace) : '--',
                    hr: a.avg_hr || null,
                });
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

        // Day dots — coloured by run type (solid) or split when a day has
        // two different run types. data-day lets the click handler look up
        // the day's runs for the tooltip.
        for (let day = 1; day <= daysInMonth; day++) {
            const runs = dayRuns[day];
            const isToday = day === today;

            let cls = 'rgd-calendar-dot';
            let style = '';
            if (runs) {
                cls += ' has-runs';
                // Distinct run types on this day (preserve first-seen order)
                const tags = [];
                runs.forEach(r => { if (!tags.includes(r.tag)) tags.push(r.tag); });
                if (tags.length >= 2) {
                    // Two different run types — side-by-side halves
                    const c1 = RUN_TAG_COLOR[tags[0]] || RUN_TAG_COLOR['Easy'];
                    const c2 = RUN_TAG_COLOR[tags[1]] || RUN_TAG_COLOR['Easy'];
                    style = `style="background: linear-gradient(to right, ${c1} 50%, ${c2} 50%);"`;
                } else {
                    const c = RUN_TAG_COLOR[tags[0]] || RUN_TAG_COLOR['Easy'];
                    style = `style="background: ${c};"`;
                }
            }
            if (isToday) cls += ' today';

            const dataAttr = runs ? `data-day="${day}"` : '';
            html += `<span class="${cls}" ${style} ${dataAttr}></span>`;
        }

        html += '</div>';
        calendarEl.innerHTML = html;

        // Wire click handlers on dots that have runs — show a tooltip
        // listing the day's runs (display-only, standardized styling).
        calendarEl.querySelectorAll('.rgd-calendar-dot.has-runs').forEach(dot => {
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                showCalendarTooltip(e.currentTarget, dayRuns, monthName);
            });
        });
    }

    // Calendar day tooltip — shown when a dot is clicked. Lists the runs
    // on that day (display-only, no navigation). Reuses a single DOM
    // element and the shared .rgd-chart-tooltip styling so it matches the
    // radar chart tooltip design.
    let calendarTooltipEl = null;
    let calendarTooltipDismissBound = false;
    function showCalendarTooltip(dot, dayRuns, monthName) {
        const day = parseInt(dot.getAttribute('data-day'), 10);
        const runs = dayRuns[day] || [];
        if (!runs.length) return;

        // Reuse a single tooltip element across clicks
        if (!calendarTooltipEl) {
            calendarTooltipEl = document.createElement('div');
            calendarTooltipEl.className = 'rgd-chart-tooltip rgd-calendar-tooltip';
            document.body.appendChild(calendarTooltipEl);
        }

        // Bind dismiss handlers once — close when clicking outside, on
        // scroll, or on Escape so the tooltip never lingers stale.
        if (!calendarTooltipDismissBound) {
            calendarTooltipDismissBound = true;
            document.addEventListener('click', (e) => {
                if (!calendarTooltipEl) return;
                if (calendarTooltipEl.contains(e.target)) return;
                if (e.target && e.target.classList && e.target.classList.contains('rgd-calendar-dot')) return;
                calendarTooltipEl.style.opacity = 0;
            }, true);
            window.addEventListener('scroll', () => {
                if (calendarTooltipEl) calendarTooltipEl.style.opacity = 0;
            }, { passive: true });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && calendarTooltipEl) calendarTooltipEl.style.opacity = 0;
            });
        }

        const monthShort = monthName.split(' ')[0];
        calendarTooltipEl.innerHTML = `
            <div class="rgd-calendar-tooltip-date">${monthShort} ${day}</div>
            ${runs.map(r => {
                const color = RUN_TAG_COLOR[r.tag] || RUN_TAG_COLOR['Easy'];
                const meta = `${r.distance} km · ${r.pace}/km${r.hr ? ' · ' + r.hr + ' bpm' : ''}`;
                return `
                    <div class="rgd-calendar-tooltip-run">
                        <span class="rgd-calendar-tooltip-run-dot" style="background:${color}"></span>
                        <span class="rgd-calendar-tooltip-run-name">${escapeHtml(r.name)}</span>
                        <span class="rgd-calendar-tooltip-run-meta">${meta}</span>
                    </div>
                `;
            }).join('')}
        `;

        // Position below the dot, clamped to the viewport horizontally.
        // Measure after content is set so width is accurate.
        const rect = dot.getBoundingClientRect();
        const tw = calendarTooltipEl.offsetWidth || 160;
        let left = rect.left + rect.width / 2 - tw / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
        const top = rect.bottom + window.scrollY + 8;
        calendarTooltipEl.style.left = `${left}px`;
        calendarTooltipEl.style.top = `${top}px`;
        calendarTooltipEl.style.opacity = 1;
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

    // Run tag styling lookup — the classifier itself lives server-side
    // (single source of truth, shared with the AI lap-selection); the backend
    // sends run_tag with every activity and we only map the label to CSS.
    const RUN_TAG_CLASS = {
        'Run': 'rgd-run-tag--easy',
        'Warmup': 'rgd-run-tag--warmup',
        'Tempo Long': 'rgd-run-tag--tempo-long',
        'LSD': 'rgd-run-tag--lsd',
        'Speedwork': 'rgd-run-tag--speedwork',
        'Easy': 'rgd-run-tag--easy',
    };

    // Run type → dot fill colour. Reads the tokenised CSS custom properties
    // (--rgd-run-*) so calendar dots match the run-tag colours and respect
    // dark mode automatically. Falls back to hardcoded hex if the token is
    // missing (e.g. older browsers without CSS variable support).
    const cssVar = (name, fallback) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    const RUN_TAG_COLOR = {
        'Run': cssVar('--rgd-run-easy', '#388e8e'),
        'Easy': cssVar('--rgd-run-easy', '#388e8e'),
        'Warmup': cssVar('--rgd-run-warmup', '#7a7a7a'),
        'Tempo Long': cssVar('--rgd-run-tempo', '#8a6313'),
        'LSD': cssVar('--rgd-run-lsd', '#5d6db0'),
        'Speedwork': cssVar('--rgd-run-speedwork', '#c44b4b'),
    };

    function buildActivityItem(a, i) {
        const date = a.start_time ? parseDate(a.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '--';
        const pace = a.avg_pace ? formatPace(a.avg_pace) : '--';
        const hr = a.avg_hr ? `${a.avg_hr} bpm` : '--';
        const iconSvg = getActivityIcon(a.type);
        const ascent = a.elevation_gain ? `${a.elevation_gain}m` : '--';
        const cadence = a.avg_cadence ? `${Math.round(a.avg_cadence)} spm` : '--';
        const elapsedMin = a.elapsed_duration ? a.elapsed_duration : a.duration;
        const elapsed = elapsedMin ? formatDuration(elapsedMin) : '--';
        // Render the tag computed server-side by the single classifier
        const runTagLabel = a.run_tag || 'Easy';
        const runTag = {
            label: runTagLabel,
            className: RUN_TAG_CLASS[runTagLabel] || 'rgd-run-tag--easy',
        };

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
        // Store activities for theme-change re-render
        lastPaceDistActivities = activities;

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
            // Goal bucket — the "(Race Pace)" caption is part of the label
            // itself (as a second line via Chart.js multi-line array) so it
            // renders naturally under the pace range without a custom plugin.
            { label: [`${formatPaceLabel(secToMin(goalBucketMinSec))}–${formatPaceLabel(secToMin(goalBucketMaxSec))}`, '(Race Pace)'], min: secToMin(goalBucketMinSec), max: secToMin(goalBucketMaxSec) },
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
        // Standardized theme-aware tooltip colours — shared with the weekly
        // mileage, HR vs pace, and calendar tooltips so all charts match.
        const chartSurface = getComputedStyle(document.documentElement).getPropertyValue('--rgd-surface').trim() || '#ffffff';
        const chartText = getComputedStyle(document.documentElement).getPropertyValue('--rgd-text').trim() || '#1d3557';
        const chartIsDark = document.documentElement.getAttribute('data-theme') === 'dark';

        // Update the card title to reflect the number of activities analysed
        const paceTitleEl = canvas.closest('.rgd-chart-card')?.querySelector('.rgd-card-title');
        if (paceTitleEl) paceTitleEl.textContent = `Pace Distribution Over Last ${runs.length} Activities`;

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
                        // Standardized theme-aware tooltip styling
                        backgroundColor: chartSurface,
                        titleColor: chartText,
                        bodyColor: chartText,
                        borderColor: chartIsDark ? '#2a3f56' : '#dce8f2',
                        borderWidth: 1,
                        titleFont: { family: 'Raleway', size: 12 },
                        bodyFont: { family: 'Lato', size: 14 },
                        displayColors: false,
                        padding: 8,
                        cornerRadius: 6,
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
            }
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
        // Store activities for theme-change re-render
        lastHrPaceActivities = activities;

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
        // Standardized theme-aware tooltip colours — shared across all charts
        const chartSurface = getComputedStyle(document.documentElement).getPropertyValue('--rgd-surface').trim() || '#ffffff';
        const chartText = getComputedStyle(document.documentElement).getPropertyValue('--rgd-text').trim() || '#1d3557';
        const chartIsDark = document.documentElement.getAttribute('data-theme') === 'dark';

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
                        // Standardized theme-aware tooltip styling
                        backgroundColor: chartSurface,
                        titleColor: chartText,
                        bodyColor: chartText,
                        borderColor: chartIsDark ? '#2a3f56' : '#dce8f2',
                        borderWidth: 1,
                        titleFont: { family: 'Raleway', size: 12 },
                        bodyFont: { family: 'Lato', size: 14 },
                        displayColors: false,
                        padding: 8,
                        cornerRadius: 6,
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
                        // Multi-line axis title: the main label plus
                        // directional hints at each end. Chart.js renders
                        // the title array as stacked lines, and align:
                        // 'center' keeps it centered under the axis.
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
    // Radar dimension colours — read from the same tokens used by the
    // dimension explainer dots so the radar and the explainer modal stay
    // in sync. Uses rgba via color-mix fallback parsing: since Chart.js
    // needs rgba strings (not CSS variables), we read the computed hex
    // tokens and apply 0.7 alpha inline.
    const radarHex = (name, fallback) => {
        const hex = cssVar(name, fallback);
        // Convert hex (#rrggbb) to rgba(r,g,b,0.7)
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, 0.7)`;
    };
    const RADAR_COLORS = [
        radarHex('--rgd-run-speedwork', '#c44b4b'),  // lactate threshold — red
        radarHex('--rgd-accent-green', '#3f7b4f'),   // aerobic endurance — green
        radarHex('--rgd-run-tempo', '#8a6313'),      // running economy — amber
        radarHex('--rgd-run-lsd', '#5d6db0'),        // strength/durability — purple
        radarHex('--rgd-blue', '#457b9d'),           // vo2max/speed — blue
        radarHex('--rgd-run-easy', '#388e8e'),       // fatigue resistance — teal
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
    // that jumps to the corresponding pillar in the readiness section.
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
                <a class="rgd-radar-tooltip-link" href="#readiness" data-pillar-index="${dimIndex}">
                    ${escapeHtml(dimName)}
                </a>
                <span class="rgd-radar-tooltip-score">${score}/10</span>
            `;

            // Wire up the link click — scroll to the corresponding pillar card
            // within the currently visible page's pillars container.
            // Uses data-pillar-index attribute to find the right card.
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
        // Build values in RADAR_DIMENSIONS order, using normalized lookup.
        // Scores are integers 0–10 (the AI prompt disallows decimals) — round
        // to whole numbers so no fractional scores ever render on the chart.
        const values10 = RADAR_DIMENSIONS.map(name => {
            const score = scoreMap[normalizeName(name)];
            return score !== undefined ? Math.round(score) : 0;
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
    // Stale-while-revalidate cache for metrics + weekly mileage
    // Renders cached data instantly on page load, then fetches fresh data
    // from the API in the background and re-renders if it changed. Cache
    // is scoped by session token so different users never cross-pollute.
    // =========================================================================

    const METRICS_CACHE_KEY = 'rgd_metrics_cache';
    const MILEAGE_CACHE_KEY = 'rgd_mileage_cache';
    // 1-hour TTL — Garmin data changes on watch sync, not in real time, so
    // an hour of reuse is safe. After TTL, the cache is still shown (stale)
    // while a fresh fetch is triggered (revalidate).
    const SWR_TTL_MS = 60 * 60 * 1000; // 1 hour

    // Read a stale-while-revalidate cache entry. Returns { data, isStale }
    // — data is the cached payload (or null), isStale is true if the TTL
    // has elapsed (caller should fetch fresh data in the background).
    function readSWRCache(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return { data: null, isStale: true };
            const entry = JSON.parse(raw);
            // Invalidate cache if the session token changed
            const scopeKey = sessionToken || 'demo';
            if (entry.scope !== scopeKey) return { data: null, isStale: true };
            const isStale = Date.now() - entry.timestamp > SWR_TTL_MS;
            return { data: entry.data, isStale };
        } catch (e) {
            return { data: null, isStale: true };
        }
    }

    // Write a stale-while-revalidate cache entry, scoped by session token.
    function writeSWRCache(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify({
                scope: sessionToken || 'demo',
                timestamp: Date.now(),
                data: data,
            }));
        } catch (e) {
            // localStorage full or unavailable — silently skip
        }
    }

    // Clear all SWR caches (called on logout)
    function clearSWRCaches() {
        localStorage.removeItem(METRICS_CACHE_KEY);
        localStorage.removeItem(MILEAGE_CACHE_KEY);
    }

    // =========================================================================
    // 6-Pillar AI Summary — uses /race-goal/ai-radar with localStorage cache
    // Cache keyed by session token + race goal hash, 24-hour TTL
    // =========================================================================

    const AI_CACHE_KEY = 'rgd_ai_radar_cache';
    const AI_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
            // Use the AI-provided overall insight if present; fall back to
            // deriveOverallInsight for cached responses from before the
            // overall field was added to the API response.
            renderOverallInsight(cached.overall || deriveOverallInsight(cached));
            // Hide the regenerate button in demo mode — there's no real AI
            // call to refresh, so the action is meaningless for demo users.
            refreshAnalysisBtn.hidden = window.__demoMode;
            return;
        }

        // No valid cache — show radar + pillars skeletons and fetch from API
        showRadarSkeleton(true);
        showPillarsSkeleton();
        showOverallInsightSkeleton(true);
        summaryErrors.forEach(el => el.hidden = true);
        refreshAnalysisBtn.hidden = true;

        try {
            // Pass force=1 when forceRefresh is true so the server skips its
            // persistent email-keyed cache and regenerates from scratch.
            const url = forceRefresh ? 'ai-radar?force=1' : 'ai-radar';
            const resp = await apiCall('GET', url);
            const data = await resp.json();
            if (!resp.ok) {
                showRadarSkeleton(false);
                summaryErrors.forEach(el => {
                    el.textContent = data.error || 'Failed to load insights.';
                    el.hidden = false;
                });
                pillarsContents.forEach(el => el.hidden = true);
                refreshAnalysisBtn.hidden = window.__demoMode;
                return;
            }
            // Cache the successful response for future loads
            writeAICache(data);
            // Render both the radar chart and the insight text from the same AI data
            showRadarSkeleton(false);
            renderRadarChart(data);
            renderPillars(data);
            // Use the AI-provided overall insight; fall back to client-side
            // derivation if the API response doesn't include it.
            renderOverallInsight(data.overall || deriveOverallInsight(data));
        } catch (err) {
            showRadarSkeleton(false);
            summaryErrors.forEach(el => {
                el.textContent = 'Network error.';
                el.hidden = false;
            });
            pillarsContents.forEach(el => el.hidden = true);
            refreshAnalysisBtn.hidden = window.__demoMode;
        }
    }

    // Show/hide all radar skeleton overlays (overview + readiness page).
    // When hiding, fades the skeleton out via CSS opacity transition before
    // setting hidden=true — this creates a smooth crossfade with the chart
    // canvas which fades in simultaneously.
    // When showing, destroys any existing radar chart instances so the old
    // chart numbers and labels don't overlap with the skeleton overlay.
    function showRadarSkeleton(show) {
        if (show) {
            // Destroy existing charts so old numbers/labels don't bleed
            // through the semi-transparent skeleton overlay
            radarCharts.forEach(c => c.destroy());
            radarCharts = [];
            // Reset the canvas opacity so it can fade in again when the
            // new chart is created
            document.querySelectorAll('.rgd-radar-chart').forEach(canvas => {
                canvas.classList.remove('rgd-radar-loaded');
            });
            startRadarMorph();
        } else {
            stopRadarMorph();
        }
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

    // Radar loading morph — while the skeleton is visible, the data polygon
    // keeps morphing between random shapes (vertices eased toward random
    // radii), suggesting values are still being computed. The hexagon grid
    // stays static; only the data shape + its vertex dots move.
    let radarMorphRaf = null;
    // Per-skeleton state: [polygon element, dot elements, current radii, target radii]
    let radarMorphStates = [];
    // Vertex angles (radians) for the 6 dimensions, starting at top (12 o'clock)
    const RADAR_MORPH_ANGLES = [-Math.PI / 2, -Math.PI / 6, Math.PI / 6, Math.PI / 2, (5 * Math.PI) / 6, (7 * Math.PI) / 6];
    const RADAR_MORPH_CENTER = 100;      // hexagon centre in the 200x200 viewBox
    const RADAR_MORPH_MIN_R = 24;        // min vertex radius (stays inside the grid)
    const RADAR_MORPH_MAX_R = 76;        // max vertex radius (stays inside the grid)
    const RADAR_MORPH_EASE = 0.12;       // per-frame ease toward the target radius
    // Hold frames (1-2s at 60fps) a vertex stays at its target radius before
    // morphing again — sets the interval between shape changes
    const RADAR_MORPH_HOLD_MIN = 60;
    const RADAR_MORPH_HOLD_MAX = 120;

    function startRadarMorph() {
        if (radarMorphRaf !== null) return; // already running
        radarMorphStates = [];
        document.querySelectorAll('.rgd-radar-skeleton').forEach(skel => {
            const poly = skel.querySelector('.rgd-radar-morph');
            const dots = Array.from(skel.querySelectorAll('.rgd-radar-morph-dot'));
            if (!poly) return;
            const radii = Array.from({ length: 6 }, () => RADAR_MORPH_MIN_R + Math.random() * (RADAR_MORPH_MAX_R - RADAR_MORPH_MIN_R));
            const targets = Array.from({ length: 6 }, () => RADAR_MORPH_MIN_R + Math.random() * (RADAR_MORPH_MAX_R - RADAR_MORPH_MIN_R));
            // Frames remaining before each vertex may morph again — starts at 0
            // so vertices move on load, then desync via random holds
            const holds = Array(6).fill(0);
            radarMorphStates.push({ poly, dots, radii, targets, holds });
        });
        if (!radarMorphStates.length) return;

        const tick = () => {
            radarMorphStates.forEach(state => {
                for (let i = 0; i < state.radii.length; i++) {
                    const diff = state.targets[i] - state.radii[i];
                    if (state.holds[i] > 0) {
                        // Holding at the current target — no movement
                        state.holds[i]--;
                        if (state.holds[i] === 0) {
                            state.targets[i] = RADAR_MORPH_MIN_R + Math.random() * (RADAR_MORPH_MAX_R - RADAR_MORPH_MIN_R);
                        }
                    } else {
                        // Moving toward the target
                        state.radii[i] += diff * RADAR_MORPH_EASE;
                        if (Math.abs(diff) < 0.6) {
                            // Reached the target — hold before the next morph
                            state.holds[i] = RADAR_MORPH_HOLD_MIN + Math.floor(Math.random() * (RADAR_MORPH_HOLD_MAX - RADAR_MORPH_HOLD_MIN));
                        }
                    }
                }
                // Rebuild the polygon points and move the vertex dots with it
                const pts = state.radii.map((r, i) => {
                    const x = RADAR_MORPH_CENTER + r * Math.cos(RADAR_MORPH_ANGLES[i]);
                    const y = RADAR_MORPH_CENTER + r * Math.sin(RADAR_MORPH_ANGLES[i]);
                    if (state.dots[i]) {
                        state.dots[i].setAttribute('cx', x.toFixed(1));
                        state.dots[i].setAttribute('cy', y.toFixed(1));
                    }
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                }).join(' ');
                state.poly.setAttribute('points', pts);
            });
            radarMorphRaf = requestAnimationFrame(tick);
        };
        tick();
    }

    function stopRadarMorph() {
        if (radarMorphRaf !== null) cancelAnimationFrame(radarMorphRaf);
        radarMorphRaf = null;
        radarMorphStates = [];
    }

    // Simulated fetch duration for demo mode — charts show a loading state
    // for this long before their mock values render
    const DEMO_CHART_LOADING_MS = 3000;
    // Loading chart instances — created with randomised data, morphed in
    // place, then destroyed and replaced with real data after the delay
    let loadingCharts = [];
    let chartMorphRaf = null;
    // Morph state per chart: { chart, type, current[], targets[], holds[] }
    let chartMorphStates = [];
    const CHART_MORPH_EASE = 0.12;
    const CHART_MORPH_HOLD_MIN = 60;
    const CHART_MORPH_HOLD_MAX = 120;

    // Demo-mode chart loading: creates actual Chart.js instances with
    // randomised data that morphs in place (same easing + hold pattern as
    // the radar skeleton), then destroys them and renders the real charts
    // when the 3s simulated fetch completes.
    function setDemoChartsLoading(show) {
        // Radar uses its existing SVG skeleton
        showRadarSkeleton(show);

        if (!show) {
            stopChartMorph();
            loadingCharts.forEach(c => c.destroy());
            loadingCharts = [];
            return;
        }

        // Read theme-aware colors shared by all loading charts
        const chartMuted = getComputedStyle(document.documentElement).getPropertyValue('--rgd-muted').trim() || '#5a7184';
        const chartGridColor = getComputedStyle(document.documentElement).getPropertyValue('--rgd-border').trim() || '#dce8f2';

        // --- Mileage chart: 12 randomised bars ---
        const mileageCanvas = document.getElementById('rgd-mileage-chart');
        if (mileageCanvas) {
            if (mileageChart) { mileageChart.destroy(); mileageChart = null; }
            const mileageLabels = Array.from({ length: 12 }, (_, i) => {
                const d = new Date();
                d.setDate(d.getDate() - (11 - i) * 7);
                return d.toLocaleDateString('en-US', { month: 'short' });
            });
            // Deduplicate month labels like the real chart does
            const seen = new Set();
            for (let i = 0; i < mileageLabels.length; i++) {
                if (seen.has(mileageLabels[i])) mileageLabels[i] = '';
                else seen.add(mileageLabels[i]);
            }
            const mileageData = Array.from({ length: 12 }, () => Math.random() * 40 + 5);
            const mChart = new Chart(mileageCanvas, {
                type: 'bar',
                data: {
                    labels: mileageLabels,
                    datasets: [{
                        data: mileageData,
                        backgroundColor: 'rgba(69, 123, 157, 0.35)',
                        borderColor: 'rgba(69, 123, 157, 0.5)',
                        borderWidth: 1,
                        borderRadius: 4,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                    scales: {
                        x: { ticks: { font: { family: 'Raleway', size: 10 }, color: chartMuted } },
                        y: { beginAtZero: true, max: 50, ticks: { display: false }, grid: { color: chartGridColor } }
                    }
                }
            });
            loadingCharts.push(mChart);
            chartMorphStates.push({
                chart: mChart, type: 'bar',
                current: mileageData.slice(),
                targets: Array.from({ length: 12 }, () => Math.random() * 40 + 5),
                holds: Array(12).fill(0),
                min: 5, max: 45,
            });
        }

        // --- Pace distribution chart: 5 randomised bars ---
        const paceCanvas = document.getElementById('rgd-pace-distribution-chart');
        if (paceCanvas) {
            if (paceDistChart) { paceDistChart.destroy(); paceDistChart = null; }
            const paceLabels = ['', '', '', '', ''];
            const paceData = Array.from({ length: 5 }, () => Math.random() * 30 + 2);
            const barColors = [
                'rgba(196, 75, 75, 0.35)', 'rgba(204, 182, 42, 0.35)',
                'rgba(63, 123, 79, 0.35)', 'rgba(38, 139, 139, 0.35)',
                'rgba(69, 123, 157, 0.35)',
            ];
            const pChart = new Chart(paceCanvas, {
                type: 'bar',
                data: {
                    labels: paceLabels,
                    datasets: [{
                        data: paceData,
                        backgroundColor: barColors,
                        borderColor: barColors.map(c => c.replace('0.35', '0.5')),
                        borderWidth: 1,
                        borderRadius: 4,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                    scales: {
                        x: { ticks: { display: false }, grid: { display: false } },
                        y: { beginAtZero: true, max: 40, ticks: { display: false }, grid: { color: chartGridColor } }
                    }
                }
            });
            loadingCharts.push(pChart);
            chartMorphStates.push({
                chart: pChart, type: 'bar',
                current: paceData.slice(),
                targets: Array.from({ length: 5 }, () => Math.random() * 30 + 2),
                holds: Array(5).fill(0),
                min: 2, max: 35,
            });
        }

        // --- HR vs pace scatter: 15 randomised dots ---
        const hrCanvas = document.getElementById('rgd-hr-pace-scatter');
        if (hrCanvas) {
            if (hrPaceScatter) { hrPaceScatter.destroy(); hrPaceScatter = null; }
            const scatterData = Array.from({ length: 15 }, () => ({
                x: Math.random() * 3 + 4,
                y: Math.random() * 60 + 100,
            }));
            const dotColors = Array.from({ length: 15 }, () => 'rgba(61, 122, 175, 0.25)');
            const hChart = new Chart(hrCanvas, {
                type: 'scatter',
                data: {
                    datasets: [{
                        data: scatterData,
                        pointBackgroundColor: dotColors,
                        pointBorderColor: dotColors,
                        pointRadius: 6,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                    scales: {
                        x: {
                            title: { display: true, text: 'Pace (min/km)', font: { family: 'Raleway', size: 11 }, color: chartMuted },
                            ticks: { font: { family: 'Raleway', size: 10 }, color: chartMuted },
                            grid: { color: chartGridColor },
                            reverse: true,
                            min: 4, max: 7,
                        },
                        y: {
                            title: { display: true, text: 'Avg Heart Rate (bpm)', font: { family: 'Raleway', size: 11 }, color: chartMuted },
                            ticks: { font: { family: 'Raleway', size: 10 }, color: chartMuted },
                            grid: { color: chartGridColor },
                            min: 100, max: 180,
                        }
                    }
                }
            });
            loadingCharts.push(hChart);
            chartMorphStates.push({
                chart: hChart, type: 'scatter',
                current: scatterData.map(p => ({ x: p.x, y: p.y })),
                targets: scatterData.map(() => ({ x: Math.random() * 3 + 4, y: Math.random() * 60 + 100 })),
                holds: Array(15).fill(0),
                xMin: 4, xMax: 7, yMin: 100, yMax: 180,
            });
        }

        startChartMorph();
    }

    // Morph loop — eases each chart's data values toward random targets,
    // holds for 1-2s, then picks new targets. Same pattern as the radar morph.
    function startChartMorph() {
        if (chartMorphRaf !== null) return;
        const tick = () => {
            chartMorphStates.forEach(state => {
                let changed = false;
                for (let i = 0; i < state.current.length; i++) {
                    if (state.holds[i] > 0) {
                        state.holds[i]--;
                        if (state.holds[i] === 0) {
                            if (state.type === 'bar') {
                                state.targets[i] = state.min + Math.random() * (state.max - state.min);
                            } else {
                                state.targets[i] = {
                                    x: state.xMin + Math.random() * (state.xMax - state.xMin),
                                    y: state.yMin + Math.random() * (state.yMax - state.yMin),
                                };
                            }
                        }
                    } else {
                        if (state.type === 'bar') {
                            const diff = state.targets[i] - state.current[i];
                            state.current[i] += diff * CHART_MORPH_EASE;
                            if (Math.abs(diff) < 0.5) {
                                state.holds[i] = CHART_MORPH_HOLD_MIN + Math.floor(Math.random() * (CHART_MORPH_HOLD_MAX - CHART_MORPH_HOLD_MIN));
                            }
                        } else {
                            const dx = state.targets[i].x - state.current[i].x;
                            const dy = state.targets[i].y - state.current[i].y;
                            state.current[i].x += dx * CHART_MORPH_EASE;
                            state.current[i].y += dy * CHART_MORPH_EASE;
                            if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.5) {
                                state.holds[i] = CHART_MORPH_HOLD_MIN + Math.floor(Math.random() * (CHART_MORPH_HOLD_MAX - CHART_MORPH_HOLD_MIN));
                            }
                        }
                        changed = true;
                    }
                }
                if (changed) {
                    // Update chart data in place — 'none' skips Chart.js animation
                    // so the morph loop controls all motion via requestAnimationFrame
                    state.chart.data.datasets[0].data = state.current.map(c =>
                        state.type === 'bar' ? c : { x: c.x, y: c.y }
                    );
                    state.chart.update('none');
                }
            });
            chartMorphRaf = requestAnimationFrame(tick);
        };
        tick();
    }

    function stopChartMorph() {
        if (chartMorphRaf !== null) cancelAnimationFrame(chartMorphRaf);
        chartMorphRaf = null;
        chartMorphStates = [];
    }

    // Skeleton placeholder cards shown while AI is generating insights.
    // Each card shows animated skeleton lines for the summary text.
    // No loading text label — the skeleton cards themselves are the
    // visual feedback, and a text label would push the first real
    // card down when it loads.
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

    // =========================================================================
    // The Big Picture — the coach's top-level synthesized assessment
    // =========================================================================

    const overallInsightEl = $('#rgd-overall-insight');
    const overallInsightSkeleton = $('#rgd-overall-insight-skeleton');

    // Derive an overall insight from pillars data when a dedicated overall
    // insight isn't available from the API. Computes the average score,
    // picks the highest-scoring dimension as top strength and the lowest
    // as top gap, and generates a summary from the dimension summaries.
    function deriveOverallInsight(pillarsData) {
        const dims = (pillarsData.dimensions || []).filter(d => typeof d.score === 'number');
        if (dims.length === 0) return null;

        const scores = dims.map(d => d.score);
        const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
        const sorted = [...dims].sort((a, b) => b.score - a.score);
        const top = sorted[0];
        const bottom = sorted[sorted.length - 1];

        // Verdict based on average score — matches the 0-10 AI score scale
        let verdict;
        if (avgScore >= 8) verdict = 'Ahead of schedule';
        else if (avgScore >= 7) verdict = 'On track';
        else if (avgScore >= 6) verdict = 'On track, with work to do';
        else if (avgScore >= 5) verdict = 'Slightly behind';
        else verdict = 'Significant gap to close';

        return {
            verdict,
            score: avgScore,
            summary: dims.map(d => d.summary).join(' '),
            topStrength: {
                label: top.name,
                note: top.strengths || top.summary || '',
            },
            topGap: {
                label: bottom.name,
                note: bottom.gaps || bottom.summary || '',
            },
            focus: bottom.gaps || bottom.summary || '',
        };
    }

    // Show/hide the overall insight skeleton loading state
    function showOverallInsightSkeleton(show) {
        if (overallInsightSkeleton) overallInsightSkeleton.hidden = !show;
        if (overallInsightEl) overallInsightEl.hidden = show;
    }

    function renderOverallInsight(data) {
        if (!overallInsightEl || !data) return;
        showOverallInsightSkeleton(false);

        // Score color — matches the AI score scale used in the dimension modal
        const scoreColor = data.score >= 8 ? 'var(--rgd-accent-green)'
            : data.score >= 7 ? 'var(--rgd-accent-green)'
            : data.score >= 6 ? 'var(--rgd-accent-amber)'
            : data.score >= 5 ? 'var(--rgd-accent-amber)'
            : 'var(--rgd-accent-red)';

        overallInsightEl.innerHTML = `
            <div class="rgd-overall-insight-header">
                <div class="rgd-overall-insight-verdict">${escapeHtml(data.verdict)}</div>
                <div class="rgd-overall-insight-score" style="color: ${scoreColor};">${data.score}<span class="rgd-overall-insight-score-max">/10</span></div>
            </div>
            <p class="rgd-overall-insight-summary">${escapeHtml(data.summary)}</p>
            <div class="rgd-overall-insight-takeaways">
                <div class="rgd-overall-insight-takeaway rgd-overall-insight-takeaway--strength">
                    <span class="rgd-overall-insight-takeaway-label">Top strength</span>
                    <span class="rgd-overall-insight-takeaway-name">${escapeHtml(data.topStrength.label)}</span>
                    <p class="rgd-overall-insight-takeaway-note">${escapeHtml(data.topStrength.note)}</p>
                </div>
                <div class="rgd-overall-insight-takeaway rgd-overall-insight-takeaway--gap">
                    <span class="rgd-overall-insight-takeaway-label">Biggest gap</span>
                    <span class="rgd-overall-insight-takeaway-name">${escapeHtml(data.topGap.label)}</span>
                    <p class="rgd-overall-insight-takeaway-note">${escapeHtml(data.topGap.note)}</p>
                </div>
            </div>
            <div class="rgd-overall-insight-focus">
                <span class="rgd-overall-insight-focus-label">What to focus on next</span>
                <p class="rgd-overall-insight-focus-text">${escapeHtml(data.focus)}</p>
            </div>
        `;
    }

    function renderPillars(data) {
        // Show content on all instances (overview + readiness pages)
        pillarsContents.forEach(el => el.hidden = false);
        summaryErrors.forEach(el => el.hidden = true);
        // Hide the regenerate button in demo mode — demo insights are mock
        // data, so regenerating has no effect and shouldn't be offered.
        refreshAnalysisBtn.hidden = window.__demoMode;

        const dims = data.dimensions || [];

        // Overview page: quick summary only — no concrete data references.
        // Cards are clickable and navigate to the full insight on the
        // readiness page, scrolling to the corresponding pillar card.
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

        // Readiness page: full breakdown with strengths and gaps, each
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
        // readiness page — determined by which page element contains them.
        const overviewPage = document.getElementById('rgd-page-overview');
        const readinessPage = document.getElementById('rgd-page-readiness');
        pillarsContents.forEach(el => {
            if (overviewPage && overviewPage.contains(el)) {
                el.innerHTML = overviewHtml;
            } else if (readinessPage && readinessPage.contains(el)) {
                el.innerHTML = insightsHtml;
            } else {
                // Fallback: use the full insights HTML for any unknown container
                el.innerHTML = insightsHtml;
            }
        });

        // Wire up click handlers on the overview summary cards — clicking
        // a card navigates to the readiness page and scrolls the matching
        // pillar card into view with a brief highlight pulse
        if (overviewPage) {
            overviewPage.querySelectorAll('.rgd-pillar-card--summary').forEach(card => {
                card.addEventListener('click', () => {
                    const idx = card.getAttribute('data-pillar-index');
                    // Navigate to the readiness page via hash routing
                    window.location.hash = 'readiness';
                    // Scroll the corresponding pillar into view after the
                    // page is shown — short delay to allow the page to unhide
                    setTimeout(() => {
                        const pillar = readinessPage.querySelector(
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
            $('#rgd-edit-race-name').value = raceGoal.race_name || '';
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
            race_name: $('#rgd-edit-race-name').value,
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
            // Clear stored chart data so stale values aren't re-rendered
            // during the reload (e.g. by a theme toggle mid-fetch)
            lastRadarData = null;
            lastMileageWeeks = null;
            lastPaceDistActivities = null;
            lastHrPaceActivities = null;
            // Update the sidebar goal display
            sidebarGoalEl.textContent = `${raceGoal.purpose} — ${raceGoal.time_target}`;
            // Update the goal specifics panel
            renderGoalSpecifics(raceGoal);
            // Reload all data with the new goal (charts, radar, insights).
            // Pass forceAIRefresh=true so the server regenerates AI insights
            // against the new goal instead of returning the stale cache.
            loadAllData(true);
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
    // Race goal reminder popup — shown when a returning user logs in and has
    // a persisted race goal from a previous session. Lets them keep the
    // existing goal, edit it, or start fresh with the onboarding flow.
    // =========================================================================

    const goalReminderPopup = $('#rgd-goal-reminder-popup');
    const goalReminderClose = $('#rgd-goal-reminder-close');
    const goalReminderKeep = $('#rgd-goal-reminder-keep');
    const goalReminderEdit = $('#rgd-goal-reminder-edit');
    const goalReminderNew = $('#rgd-goal-reminder-new');
    const goalReminderSummary = $('#rgd-goal-reminder-summary');
    let goalReminderTrigger = null;

    // Populate the summary card with the saved race goal details and show
    // the popup. Called from the login handler when data.has_race_goal is true.
    function showGoalReminderPopup(goal) {
        if (!goalReminderPopup || !goal) return;
        goalReminderTrigger = document.activeElement;

        // Build the summary rows — only show fields that have values
        const rows = [];
        if (goal.race_name) rows.push(['Race', goal.race_name]);
        if (goal.distance) rows.push(['Distance', goal.distance]);
        if (goal.time_target) rows.push(['Time target', goal.time_target]);
        if (goal.race_date) rows.push(['Race date', goal.race_date]);
        if (goal.weekly_mileage) {
            rows.push(['Weekly mileage', `${goal.weekly_mileage} ${goal.mileage_unit || 'km'}`]);
        }
        if (goal.saved_at) {
            // Show when the goal was last saved — helps the user decide if
            // it's still relevant
            const savedDate = new Date(goal.saved_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            });
            rows.push(['Last updated', savedDate]);
        }

        goalReminderSummary.innerHTML = rows.map(([label, value]) => `
            <div class="rgd-goal-reminder-summary-row">
                <span class="rgd-goal-reminder-summary-label">${escapeHtml(label)}</span>
                <span class="rgd-goal-reminder-summary-value">${escapeHtml(String(value))}</span>
            </div>
        `).join('');

        goalReminderPopup.hidden = false;
        goalReminderClose.focus();
    }

    function closeGoalReminderPopup() {
        if (!goalReminderPopup) return;
        goalReminderPopup.hidden = true;
        if (goalReminderTrigger) goalReminderTrigger.focus();
    }

    // Keep — go straight to the dashboard with the existing goal
    goalReminderKeep.addEventListener('click', () => {
        closeGoalReminderPopup();
        showDashboard();
    });

    // Edit — open the edit-goal popup pre-filled with the existing goal
    goalReminderEdit.addEventListener('click', () => {
        closeGoalReminderPopup();
        // Show the dashboard first so the edit-goal popup has the right
        // context, then open the edit popup
        showDashboard();
        setTimeout(() => openEditGoalPopup(), 100);
    });

    // New — clear the existing goal and go to onboarding. Also clear the
    // AI and coach caches so the server regenerates against the new goal
    // instead of returning stale insights from the old goal.
    goalReminderNew.addEventListener('click', () => {
        closeGoalReminderPopup();
        raceGoal = null;
        localStorage.removeItem('rgd_race_goal');
        clearAICache();
        clearCoachCache();
        showScreen(onboardScreen);
    });

    // Close on close button, overlay click, or Escape
    goalReminderClose.addEventListener('click', closeGoalReminderPopup);
    goalReminderPopup.addEventListener('click', (e) => {
        if (e.target === goalReminderPopup) closeGoalReminderPopup();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && goalReminderPopup && !goalReminderPopup.hidden) {
            closeGoalReminderPopup();
        }
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
            // Demo mode — show placeholder + connect button. Assign a
            // realistic Garmin device (Forerunner 165) rather than a
            // "Demo Device" label so the settings read naturally.
            $('#rgd-settings-name').textContent = 'Demo Runner';
            $('#rgd-settings-email').textContent = 'demo@example.com';
            $('#rgd-settings-device').textContent = 'Forerunner 165';
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
    const demoBannerSlimCta = $('#rgd-demo-banner-slim-cta');
    const demoPageCtaBtn = $('#rgd-demo-cta-btn');
    if (demoBannerCta) demoBannerCta.addEventListener('click', openLoginModal);
    // Slim pill "Connect" link — same behaviour as the full banner CTA
    if (demoBannerSlimCta) demoBannerSlimCta.addEventListener('click', openLoginModal);
    if (demoPageCtaBtn) demoPageCtaBtn.addEventListener('click', openLoginModal);

    // "Show more" button on the overview page — navigates to the full
    // activities page and scrolls to the top so users land on the most
    // recent activities first. On desktop the body is the scroll
    // container (.rgd-content has overflow:clip, not auto), so we use
    // window.scrollTo rather than scrollIntoView on a child element.
    // A short setTimeout lets the hashchange → navigateTo() run first
    // so the activities page is visible before we scroll.
    const showMoreActivitiesBtn = $('#rgd-show-more-activities');
    if (showMoreActivitiesBtn) {
        showMoreActivitiesBtn.addEventListener('click', () => {
            window.location.hash = 'activities';
            setTimeout(() => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }, 50);
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
        // Reset stored chart data so theme-toggle doesn't re-render stale charts
        lastMileageWeeks = null;
        lastRadarData = null;
        lastPaceDistActivities = null;
        lastHrPaceActivities = null;
        // Reset coach plan state so the Plan page loads fresh after re-login
        coachLoaded = false;
        coachPlanData = null;
        coachEditingDate = null;
        coachScheduledDates.clear();
        // Clear all cached session data so the next load starts fresh
        localStorage.removeItem('rgd_session_token');
        localStorage.removeItem('rgd_race_goal');
        localStorage.removeItem('rgd_display_name');
        localStorage.removeItem('rgd_profile_image_url');
        clearAICache(); // clear cached AI insights when logging out
        clearCoachCache(); // clear cached coach plan when logging out
        clearSWRCaches(); // clear cached metrics + mileage when logging out
        loginForm.reset(); onboardForm.reset();
        // Return to demo mode instead of login screen
        startDemoMode();
    }

    // =========================================================================
    // Coach Plan — study the last 2 weeks, propose + customise + schedule a week
    // =========================================================================

    const coachCalendarEl = $('#rgd-coach-calendar');
    const coachErrorEl = $('#rgd-coach-error');
    const planEditBtn = $('#rgd-plan-edit-btn');
    const planPrefsModal = $('#rgd-plan-prefs-modal');
    const planPrefsModalClose = $('#rgd-plan-prefs-close');
    const planPrefsCancelBtn = $('#rgd-plan-prefs-cancel');
    const planPrefsForm = $('#rgd-plan-prefs-form');
    const prefDaysEl = $('#rgd-pref-days');
    const prefIntensityEl = $('#rgd-pref-intensity');
    const prefDistanceEl = $('#rgd-pref-distance');
    const schedulePlanBtn = $('#rgd-schedule-plan');
    const scheduleStatusEl = $('#rgd-coach-schedule-status');
    const workoutSheet = $('#rgd-workout-sheet');
    const workoutSheetClose = $('#rgd-workout-sheet-close');
    const workoutSheetBody = $('#rgd-workout-sheet-body');

    const COACH_CACHE_KEY = 'rgd_coach_plan_cache';
    const COACH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    let coachPlanData = null;   // { history: [...], plan: { days: [...], pace_zones: {...} } }
    let coachLoaded = false;    // whether the plan has been fetched this session
    let coachEditingDate = null; // the day currently in edit mode (or null)
    const coachScheduledDates = new Set(); // dates already pushed to Garmin

    // Plan page history pagination — how many days of past activities to
    // render before the current date. Starts at 2 weeks (14 days); the
    // "Show more" button extends this by 14 days per click. Reset to 14
    // every time the plan page is opened so it always leads to today.
    let planPastDays = 14;
    const planShowMoreBtn = $('#rgd-plan-show-more');

    const WORKOUT_TYPES = ['Easy', 'Recovery', 'Long Run', 'Tempo', 'Intervals', 'Speedwork'];

    // Suggested workouts reuse the run-tag colour scheme, but saturated
    const WORKOUT_TAG_CLASS = {
        'Easy': 'rgd-run-tag--easy',
        'Recovery': 'rgd-run-tag--easy',
        'Long Run': 'rgd-run-tag--lsd',
        'Tempo': 'rgd-run-tag--tempo-long',
        'Intervals': 'rgd-run-tag--speedwork',
        'Speedwork': 'rgd-run-tag--speedwork',
    };

    // Plan-level preferences — persisted so they stay the same until changed
    const COACH_PREFS_KEY = 'rgd_coach_prefs';
    function readCoachPrefs() {
        try {
            const raw = localStorage.getItem(COACH_PREFS_KEY);
            if (!raw) return { days_per_week: 3, intensity: 'moderate', distance_adj: 'keep' };
            const p = JSON.parse(raw);
            return {
                days_per_week: p.days_per_week || 3,
                intensity: p.intensity || 'moderate',
                distance_adj: p.distance_adj || 'keep',
            };
        } catch (e) {
            return { days_per_week: 3, intensity: 'moderate', distance_adj: 'keep' };
        }
    }
    function writeCoachPrefs(prefs) {
        try {
            localStorage.setItem(COACH_PREFS_KEY, JSON.stringify(prefs));
        } catch (e) {
            // localStorage unavailable — silently skip
        }
    }
    let coachPrefs = readCoachPrefs();

    // Cache key is scoped by session + goal + day so a stale plan never bleeds
    // across users or across week boundaries.
    function getCoachCacheKey() {
        const goalFingerprint = raceGoal ? `${raceGoal.purpose || ''}|${raceGoal.time_target || ''}|${raceGoal.race_date || ''}` : 'no-goal';
        const today = new Date().toISOString().slice(0, 10);
        return `${sessionToken || 'demo'}::${goalFingerprint}::${today}`;
    }

    function readCoachCache() {
        try {
            const raw = localStorage.getItem(COACH_CACHE_KEY);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (entry.key !== getCoachCacheKey()) return null;
            if (Date.now() - entry.timestamp > COACH_CACHE_TTL_MS) return null;
            return entry.data;
        } catch (e) {
            return null;
        }
    }

    function writeCoachCache(data) {
        try {
            localStorage.setItem(COACH_CACHE_KEY, JSON.stringify({
                key: getCoachCacheKey(),
                timestamp: Date.now(),
                data: data,
            }));
        } catch (e) {
            // localStorage full or unavailable — silently skip caching
        }
    }

    function clearCoachCache() {
        localStorage.removeItem(COACH_CACHE_KEY);
    }

    // Mock 2-week history for demo mode — ~10 recent runs spread across
    // 2 weeks with rest days between runs (same weekly pattern as
    // generateMockActivities: Tue, Wed, Thu, Sat, Sun).
    function getMockCoachHistory() {
        const now = new Date();
        const names = ['Easy Morning', 'Weekend Long Run', 'Tempo Session', 'Interval 400s', 'Recovery Jog'];
        const tags = ['Easy', 'LSD', 'Speedwork', 'Speedwork', 'Easy'];
        const secPerKm = [400, 420, 350, 330, 450]; // easy, long, tempo, interval, recovery
        const distances = [6, 18, 10, 8, 5];
        // Same weekly offsets as generateMockActivities: Tue(1), Wed(2),
        // Thu(3), Sat(5), Sun(6) — Mon and Fri are rest days.
        const weeklyOffsets = [1, 2, 3, 5, 6];
        const results = [];
        for (let i = 0; i < 10; i++) {
            const weekBack = Math.floor(i / weeklyOffsets.length);
            const dayInWeek = i % weeklyOffsets.length;
            const daysAgo = weekBack * 7 + weeklyOffsets[dayInWeek];
            const d = new Date(now);
            d.setDate(d.getDate() - daysAgo);
            const idx = i % names.length;
            const p = secPerKm[idx];
            const dist = distances[idx];
            results.push({
                id: 30000000 + i,
                name: names[idx],
                type: 'running',
                start_time: `${localDateKey(d)} 08:00:00`,
                distance: dist,
                duration: Math.round((dist * p / 60) * 10) / 10,
                avg_pace: parseFloat((1000 / p).toFixed(2)),
                max_pace: parseFloat((1000 / (p - 20)).toFixed(2)),
                avg_hr: 145,
                max_hr: 165,
                calories: 400 + i * 15,
                elevation_gain: 20 + (i % 4) * 10,
                training_effect: 2.5,
                anaerobic_training_effect: idx === 2 || idx === 3 ? 2.2 : 0.8,
                avg_cadence: 166,
                run_tag: tags[idx],
                elapsed_duration: null,
            });
        }
        return results;
    }

    // Mock plan for demo mode — mirrors the new coach-plan.py logic:
    // starts tomorrow, extends through the end of the next full Mon–Sun
    // week (up to 13 days), places the long run on Sat/Sun, quality
    // mid-week (Tue/Wed), and never schedules two hard days back to back.
    function getMockCoachPlan(prefs) {
        const p = prefs || {};
        const daysPerWeek = p.days_per_week || 3;
        const today = new Date();
        // Plan starts tomorrow
        const planStart = new Date(today);
        planStart.setDate(today.getDate() + 1);
        // Find the next Monday after (or on) planStart
        const daysUntilMonday = (8 - planStart.getDay()) % 7; // 0=Sun..6=Sat → Mon=1
        const nextMonday = new Date(planStart);
        nextMonday.setDate(planStart.getDate() + (daysUntilMonday === 0 ? 0 : daysUntilMonday));
        // Plan ends on the Sunday at the end of that full week
        const planEnd = new Date(nextMonday);
        planEnd.setDate(nextMonday.getDate() + 6);
        const totalDays = Math.round((planEnd - planStart) / 86400000) + 1;

        const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const paceZones = { Recovery: '6:50', Easy: '6:30', 'Long Run': '6:25', Tempo: '6:10', Intervals: '5:40', Speedwork: '5:35' };

        // Placement: long run on Sat or Sun, quality on Tue or Wed,
        // easy/recovery fill the remaining days. No two hard days
        // back to back. The gap days (before nextMonday) get at most
        // one easy run to complete the current week.
        const gapDays = Math.round((nextMonday - planStart) / 86400000);

        // Build the workout schedule as a map of day-index → workout type
        // Day indices are 0-based from planStart.
        const schedule = {};

        // Gap days: at most 1 easy run if there are 3+ gap days
        if (gapDays >= 3) {
            // Place an easy run mid-gap (e.g. 2 days after planStart)
            schedule[Math.min(2, gapDays - 1)] = 'Easy';
        }

        // Full Mon–Sun block: place workouts on the right days
        // nextMonday is at index `gapDays` in the plan
        const monIdx = gapDays;       // Monday index in the plan
        const tueIdx = gapDays + 1;
        const wedIdx = gapDays + 2;
        const thuIdx = gapDays + 3;
        const friIdx = gapDays + 4;
        const satIdx = gapDays + 5;
        const sunIdx = gapDays + 6;

        // Always place the long run on Saturday (or Sunday if Sat is
        // outside the window — but it never is since we cover a full week)
        schedule[satIdx] = 'Long Run';

        // Place the quality session on Tuesday or Wednesday
        const qualityIdx = tueIdx; // Tuesday — mid-week, rest day before long run
        schedule[qualityIdx] = 'Speedwork';

        // Fill remaining workout days based on daysPerWeek
        // Already placed: long run (Sat) + quality (Tue) = 2 workouts
        // Gap easy run (if any) is separate from the weekly count
        const remaining = daysPerWeek - 2;
        // Fill easy/recovery on Mon, Wed, Thu, Sun in that order
        const fillOrder = [wedIdx, monIdx, thuIdx, sunIdx];
        const fillTypes = ['Easy', 'Recovery', 'Easy', 'Easy'];
        for (let i = 0; i < remaining && i < fillOrder.length; i++) {
            schedule[fillOrder[i]] = fillTypes[i];
        }

        // Build the days array
        const days = [];
        for (let i = 0; i < totalDays; i++) {
            const d = new Date(planStart);
            d.setDate(planStart.getDate() + i);
            const wType = schedule[i];
            const workout = wType ? makeMockWorkout(wType, paceZones) : null;
            days.push({
                date: localDateKey(d),
                day_of_week: dow[d.getDay()],
                is_rest: !workout,
                workout,
            });
        }

        return {
            week_start: localDateKey(planStart),
            plan_start: localDateKey(planStart),
            plan_end: localDateKey(planEnd),
            total_plan_days: totalDays,
            pace_zones: paceZones,
            days,
        };
    }

    function makeMockWorkout(type, zones) {
        const defs = {
            'Easy': { title: 'Easy 6km', distance_km: 6, duration_min: 40, intensity: 'easy', description: 'Relaxed aerobic run.', insight: 'Build aerobic base and aid recovery without adding fatigue. Sip water as needed and keep it conversational; hold RPE 3-4 so you can talk comfortably throughout.' },
            'Recovery': { title: 'Recovery 5km', distance_km: 5, duration_min: 35, intensity: 'easy', description: 'Very easy shakeout.', insight: 'Flush the legs and keep moving between harder days. Stay hydrated, keep the effort very light, and hold RPE 2-3 with a short, bouncy stride.' },
            'Long Run': { title: 'Long 16km', distance_km: 16, duration_min: 105, intensity: 'moderate', description: 'Endurance builder.', insight: 'Extend aerobic endurance so race distance feels manageable. Drink every 15-20 min and consider a gel past 90 min; keep RPE 4-5 early and save energy for the final third.' },
            'Tempo': { title: 'Tempo 8km', distance_km: 8, duration_min: 50, intensity: 'moderate', description: 'Sustained threshold effort.', insight: 'Train to hold goal pace under fatigue. Hydrate beforehand and take a breather only if form breaks; hold a "comfortably hard" RPE 7.' },
            'Speedwork': { title: '6 x 400m', distance_km: 6, duration_min: 45, intensity: 'hard', description: 'Short, fast repeats.', insight: 'Raise your speed reserve above goal pace. Walk or jog the recoveries and sip water between sets; run each rep at RPE 8-9 with a relaxed upper body.' },
            'Intervals': { title: '5 x 1km', distance_km: 7, duration_min: 50, intensity: 'hard', description: 'Longer repeats at threshold.', insight: 'Sharpen your ability to sustain faster paces in blocks. Use full recovery and hydrate during rest; keep RPE 8 and a consistent rhythm across all reps.' },
        };
        const d = defs[type] || defs['Easy'];
        const pace = zones[type] || '6:30';
        return { type, title: d.title, description: d.description, insight: d.insight, distance_km: d.distance_km, duration_min: d.duration_min, intensity: d.intensity, target_pace_min_per_km: pace, steps: makeMockSteps(type, pace, zones) };
    }

    function makeMockSteps(type, pace, zones) {
        // zones is the full pace_zones dict so each step can carry the
        // appropriate pace for its effort level as a separate field:
        // - Warm up / Cool down → Easy pace
        // - Run (main) → the workout type's target pace
        // - Recover → Recovery pace
        // - Rest → no pace
        const easyPace = (zones && zones['Easy']) || '6:30';
        const recoveryPace = (zones && zones['Recovery']) || '6:50';
        const typePace = pace; // the workout type's own target pace

        if (type === 'Intervals' || type === 'Speedwork') {
            return [
                { type: 'Warm up', detail: '10 min', level: 0, pace: easyPace },
                { type: 'Repeat', detail: '6×', level: 0, pace: null },
                { type: 'Run', detail: '2 min', level: 1, pace: typePace },
                { type: 'Recover', detail: '2 min', level: 1, pace: recoveryPace },
                { type: 'Cool down', detail: '5 min', level: 0, pace: easyPace },
            ];
        }
        if (type === 'Tempo') {
            return [
                { type: 'Warm up', detail: '10 min', level: 0, pace: easyPace },
                { type: 'Run', detail: '8 km', level: 0, pace: typePace },
                { type: 'Cool down', detail: '5 min', level: 0, pace: easyPace },
            ];
        }
        if (type === 'Long Run') {
            return [{ type: 'Run', detail: '16 km', level: 0, pace: typePace }];
        }
        if (type === 'Recovery') {
            return [{ type: 'Run', detail: '5 km', level: 0, pace: recoveryPace }];
        }
        return [{ type: 'Run', detail: '6 km', level: 0, pace: typePace }];
    }

    async function generateCoachPlan(prefs, force) {
        // Auto-load is guarded; an explicit Save & Generate always regenerates.
        if (coachLoaded && !force) return;
        if (prefs) {
            coachPrefs = {
                days_per_week: Number(prefs.days_per_week) || 3,
                intensity: prefs.intensity || 'moderate',
                distance_adj: prefs.distance_adj || 'keep',
            };
        }

        coachErrorEl.hidden = true;
        scheduleStatusEl.hidden = true;
        coachCalendarEl.innerHTML = '<div class="rgd-coach-loading rgd-coach-loading--active"><span class="rgd-shimmer-text">Building your plan…</span></div>';
        schedulePlanBtn.hidden = true;

        // Demo mode uses local mocks — no API calls. A 3-second delay
        // (matching DEMO_CHART_LOADING_MS) lets the shimmer loading state
        // appear so the placeholder is visible instead of flashing away
        // instantly.
        if (window.__demoMode) {
            setTimeout(() => {
                coachPlanData = { history: getMockCoachHistory(), plan: getMockCoachPlan(coachPrefs) };
                renderCoachCalendar(coachPlanData);
                coachLoaded = true;
            }, DEMO_CHART_LOADING_MS);
            return;
        }

        try {
            // Pass force=1 when the user explicitly regenerates so the server
            // skips its persistent email-keyed cache and generates a fresh plan.
            const body = { ...coachPrefs };
            if (force) body.force = '1';
            const resp = await apiCall('POST', 'coach-plan', body);
            const data = await resp.json();
            if (!resp.ok) {
                coachErrorEl.textContent = data.error || 'Failed to generate plan.';
                coachErrorEl.hidden = false;
                coachCalendarEl.innerHTML = '';
                return;
            }
            coachPlanData = data;
            renderCoachCalendar(coachPlanData);
            coachLoaded = true;
        } catch (err) {
            coachErrorEl.textContent = 'Network error.';
            coachErrorEl.hidden = false;
        }
    }

    // Open the plan page — resets the past history window to 2 weeks and
    // always leads to the current date. Called every time the user
    // navigates to the Plan tab. If the plan is already loaded, we just
    // re-render from the cached data (no refetch); otherwise we kick off
    // the initial generation, which renders + scrolls to today on done.
    function openPlanPage() {
        planPastDays = 14;
        if (coachLoaded && coachPlanData) {
            renderCoachCalendar(coachPlanData, true);
        } else {
            generateCoachPlan(coachPrefs, false);
        }
    }

    // "Show more" on the plan page — extends the past history window by
    // 2 weeks and re-renders. Keeps the scroll near the top of the
    // calendar so the newly loaded older weeks are visible (does not
    // jump back to today, since the user is deliberately browsing back).
    if (planShowMoreBtn) {
        planShowMoreBtn.addEventListener('click', () => {
            if (!coachPlanData) return;
            planShowMoreBtn.textContent = 'Loading…';
            planShowMoreBtn.disabled = true;
            planPastDays += 14;
            renderCoachCalendar(coachPlanData, false);
            // Scroll the calendar top into view so the older weeks appear
            requestAnimationFrame(() => {
                const firstRow = coachCalendarEl.querySelector('.rgd-cal-row');
                if (firstRow) firstRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
    }

    function renderCoachCalendar(data, scrollToToday = true) {
        if (!coachCalendarEl) return;
        const history = data.history || [];
        const plan = data.plan || {};
        const planDays = plan.days || [];

        // Index history and plan by local date
        const historyByDate = {};
        history.forEach(r => {
            const key = r.start_time ? localDateKey(parseDate(r.start_time)) : null;
            if (!key) return;
            (historyByDate[key] = historyByDate[key] || []).push(r);
        });
        const planByDate = {};
        planDays.forEach(d => { planByDate[d.date] = d; });

        // Vertical agenda grouped into weeks (Monday start). The past
        // window is controlled by planPastDays (default 14 = 2 weeks);
        // the "Show more" button extends it. We go back to the Monday of
        // the oldest visible week, through the Sunday of the upcoming
        // week (always strictly after today — matching the backend's
        // next-Monday anchor).
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const start = new Date(today);
        start.setDate(start.getDate() - (planPastDays - 1));
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday

        const daysUntilMonday = ((8 - today.getDay()) % 7) || 7;
        const nextMonday = new Date(today);
        nextMonday.setDate(today.getDate() + daysUntilMonday);
        const end = new Date(nextMonday);
        end.setDate(nextMonday.getDate() + 6); // Sunday of the upcoming week

        const weeks = [];
        const cursor = new Date(start);
        while (cursor <= end) {
            const week = [];
            for (let i = 0; i < 7; i++) {
                const key = localDateKey(cursor);
                week.push({ date: key, history: historyByDate[key] || [], plan: planByDate[key] || null });
                cursor.setDate(cursor.getDate() + 1);
            }
            weeks.push(week);
        }

        coachCalendarEl.innerHTML = weeks.map(week => `
            <div class="rgd-cal-week-block">
                ${week.map(day => renderDayRow(day)).join('')}
            </div>
        `).join('');
        schedulePlanBtn.hidden = false;

        // Show the "Show more" button only if there's older history beyond
        // the currently rendered past window. Determines the oldest history
        // date and compares it against the rendered start.
        if (planShowMoreBtn) {
            let oldestKey = null;
            Object.keys(historyByDate).forEach(k => {
                if (!oldestKey || k < oldestKey) oldestKey = k;
            });
            const startKey = localDateKey(start);
            const hasOlder = oldestKey && oldestKey < startKey;
            planShowMoreBtn.hidden = !hasOlder;
            planShowMoreBtn.textContent = 'Show more';
            planShowMoreBtn.disabled = false;
        }

        // Lead to the current date — scroll today's row into the centre of
        // the viewport so the plan always opens on today, not the top.
        // Skipped when loading more history (the user is browsing older
        // weeks and expects to stay near the newly added content).
        if (scrollToToday) {
            requestAnimationFrame(() => {
                const todayRow = coachCalendarEl.querySelector('.rgd-cal-row--today');
                if (todayRow) todayRow.scrollIntoView({ behavior: 'auto', block: 'center' });
            });
        }
    }

    function renderDayRow(day) {
        // Date label derived from the string directly to avoid timezone shifts
        const parts = day.date.split('-').map(Number);
        const dayNum = parts[2];
        const dow = new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-US', { weekday: 'short' });
        const monthShort = new Date(parts[0], parts[1] - 1, 1).toLocaleDateString('en-US', { month: 'short' });
        const todayKey = localDateKey(new Date());
        const isPast = day.date < todayKey;
        const isToday = day.date === todayKey;

        const cards = day.history.map(r => renderHistoryCard(r));
        if (day.plan) cards.push(renderPlanCard(day.plan));

        return `
            <div class="rgd-cal-row ${isToday ? 'rgd-cal-row--today' : ''} ${isPast ? 'rgd-cal-row--past' : ''}" data-date="${day.date}">
                <div class="rgd-cal-date">
                    <span class="rgd-cal-date-dow">${dow}</span>
                    <span class="rgd-cal-date-value">
                        <span class="rgd-cal-date-num">${dayNum}</span>
                        <span class="rgd-cal-date-month">${monthShort}</span>
                    </span>
                </div>
                <div class="rgd-cal-cards">${cards.join('')}</div>
            </div>
        `;
    }

    function renderHistoryCard(r) {
        const pace = formatPace(r.avg_pace);
        const tagClass = RUN_TAG_CLASS[r.run_tag] || 'rgd-run-tag--easy';
        return `
            <div class="rgd-cal-card rgd-cal-card--past">
                <div class="rgd-cal-card-title-row">
                    <span class="rgd-cal-card-title">${escapeHtml(r.name || 'Run')}</span>
                    <span class="rgd-run-tag ${tagClass}">${escapeHtml(r.run_tag || 'Easy')}</span>
                </div>
                <div class="rgd-cal-card-row">
                    <span class="rgd-cal-card-meta">${r.distance} km · ${pace}/km</span>
                </div>
            </div>
        `;
    }

    function renderPlanCard(d) {
        const scheduled = coachScheduledDates.has(d.date);
        const editing = coachEditingDate === d.date;

        if (d.is_rest || !d.workout) {
            return `
                <div class="rgd-cal-card rgd-cal-card--rest">
                    <span class="rgd-cal-rest-label">Rest</span>
                </div>
            `;
        }

        const w = d.workout;
        const pace = w.target_pace_min_per_km || '--';
        const tagClass = WORKOUT_TAG_CLASS[w.type] || 'rgd-run-tag--easy';

        if (editing) {
            return `
                <div class="rgd-cal-card rgd-cal-card--editing">
                    <div class="rgd-cal-card-top">
                        <span class="rgd-run-tag ${tagClass}">${escapeHtml(w.type)}</span>
                        ${scheduled ? '<span class="rgd-plan-scheduled-badge">Scheduled</span>' : ''}
                    </div>
                    <div class="rgd-plan-controls">
                        <label class="rgd-plan-control">
                            <span class="rgd-plan-control-label">Type</span>
                            <select data-field="type" data-date="${d.date}">
                                ${WORKOUT_TYPES.map(t => `<option ${t === w.type ? 'selected' : ''}>${t}</option>`).join('')}
                            </select>
                        </label>
                        <label class="rgd-plan-control">
                            <span class="rgd-plan-control-label">Distance (km)</span>
                            <input type="number" data-field="distance_km" data-date="${d.date}" value="${w.distance_km ?? ''}" min="0" step="0.5">
                        </label>
                        <label class="rgd-plan-control">
                            <span class="rgd-plan-control-label">Duration (min)</span>
                            <input type="number" data-field="duration_min" data-date="${d.date}" value="${w.duration_min ?? ''}" min="0" step="5">
                        </label>
                    </div>
                    <p class="rgd-cal-card-pace">Target pace: ${pace}/km</p>
                    <p class="rgd-cal-card-desc">${escapeHtml(w.description || '')}</p>
                    <div class="rgd-cal-card-actions">
                        <button class="rgd-cal-save-btn" type="button" data-action="save" data-date="${d.date}">Done</button>
                        <button class="rgd-cal-rest-toggle" type="button" data-action="mark-rest" data-date="${d.date}">Rest day</button>
                    </div>
                </div>
            `;
        }

        return `
            <div class="rgd-cal-card rgd-cal-card--suggested ${scheduled ? 'rgd-cal-card--scheduled' : ''}" draggable="true" data-action="view" data-date="${d.date}">
                <span class="rgd-drag-handle" title="Drag to rearrange" aria-hidden="true">
                    <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor"><circle cx="4" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="4" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="4" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>
                </span>
                <div class="rgd-cal-card-body">
                    <div class="rgd-cal-card-title-row">
                        <span class="rgd-cal-card-title">${escapeHtml(w.title || w.type)}</span>
                        <span class="rgd-run-tag ${tagClass}">${escapeHtml(w.type)}</span>
                    </div>
                    <div class="rgd-cal-card-row">
                        <span class="rgd-cal-card-meta">${w.distance_km ? `${w.distance_km} km · ` : ''}${pace}/km</span>
                        ${scheduled ? '<span class="rgd-plan-scheduled-badge">Scheduled</span>' : ''}
                    </div>
                </div>
            </div>
        `;
    }

    function updatePlanDay(dateKey, field, value) {
        if (!coachPlanData || !coachPlanData.plan) return;
        const day = coachPlanData.plan.days.find(x => x.date === dateKey);
        if (!day || !day.workout) return;
        if (field === 'date') {
            day.date = value;
        } else if (field === 'distance_km' || field === 'duration_min') {
            day.workout[field] = value === '' || value === null ? null : Number(value);
        } else if (field === 'type') {
            day.workout.type = value;
            // Pace is derived from the workout type — recompute from pace_zones
            const zones = coachPlanData.plan.pace_zones || {};
            if (zones[value]) day.workout.target_pace_min_per_km = zones[value];
        } else {
            day.workout[field] = value;
        }
        renderCoachCalendar(coachPlanData);
    }

    // Event delegation — edits re-render the whole calendar, keyed by date
    coachCalendarEl.addEventListener('change', (e) => {
        const input = e.target.closest('[data-field]');
        if (!input) return;
        updatePlanDay(input.getAttribute('data-date'), input.getAttribute('data-field'), input.value);
    });

    // Drag-and-drop: rearrange suggested workouts across the upcoming week.
    let dragDate = null;
    let coachLastDragEnd = 0;

    coachCalendarEl.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.rgd-cal-card[draggable="true"]');
        if (!card) return;
        dragDate = card.getAttribute('data-date');
        card.classList.add('rgd-cal-card--dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragDate); } catch (err) {}
    });

    coachCalendarEl.addEventListener('dragend', (e) => {
        const card = e.target.closest('.rgd-cal-card');
        if (card) card.classList.remove('rgd-cal-card--dragging');
        coachLastDragEnd = Date.now();
        dragDate = null;
    });

    coachCalendarEl.addEventListener('dragover', (e) => {
        const row = e.target.closest('.rgd-cal-row');
        if (!row || !dragDate) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('rgd-cal-row--drop-target');
    });

    coachCalendarEl.addEventListener('dragleave', (e) => {
        const row = e.target.closest('.rgd-cal-row');
        if (row) row.classList.remove('rgd-cal-row--drop-target');
    });

    coachCalendarEl.addEventListener('drop', (e) => {
        const row = e.target.closest('.rgd-cal-row');
        if (!row) return;
        row.classList.remove('rgd-cal-row--drop-target');
        const targetDate = row.getAttribute('data-date');
        const sourceDate = dragDate || e.dataTransfer.getData('text/plain');
        if (sourceDate && targetDate) moveWorkout(sourceDate, targetDate);
        dragDate = null;
    });

    function moveWorkout(sourceDate, targetDate) {
        if (!coachPlanData || !coachPlanData.plan || sourceDate === targetDate) return;
        const days = coachPlanData.plan.days;
        const sourceDay = days.find(x => x.date === sourceDate);
        const targetDay = days.find(x => x.date === targetDate);
        if (!sourceDay || !targetDay || !sourceDay.workout) return;
        // Swap the workout and rest state between the two days
        const workout = sourceDay.workout;
        const isRest = sourceDay.is_rest;
        sourceDay.workout = targetDay.workout;
        sourceDay.is_rest = targetDay.is_rest;
        targetDay.workout = workout;
        targetDay.is_rest = isRest;
        renderCoachCalendar(coachPlanData);
    }

    coachCalendarEl.addEventListener('click', (e) => {
        if (Date.now() - coachLastDragEnd < 250) return; // suppress click after a drag
        const btn = e.target.closest('[data-action]');
        if (!btn || !coachPlanData || !coachPlanData.plan) return;
        const dateKey = btn.getAttribute('data-date');
        const action = btn.getAttribute('data-action');

        if (action === 'view') {
            openWorkoutSheet(dateKey);
            return;
        }
        if (action === 'edit') {
            coachEditingDate = dateKey;
            renderCoachCalendar(coachPlanData);
            return;
        }
        if (action === 'save') {
            coachEditingDate = null;
            renderCoachCalendar(coachPlanData);
            return;
        }

        const day = coachPlanData.plan.days.find(x => x.date === dateKey);
        if (!day) return;
        if (action === 'mark-rest') {
            day.is_rest = true;
            day.workout = null;
            coachEditingDate = null;
        } else if (action === 'add-workout') {
            const zones = coachPlanData.plan.pace_zones || {};
            day.is_rest = false;
            day.workout = { type: 'Easy', title: 'Easy Run', description: 'Easy aerobic run.', distance_km: 5, duration_min: 35, intensity: 'easy', target_pace_min_per_km: zones['Easy'] || '6:30' };
        }
        renderCoachCalendar(coachPlanData);
    });

    // Workout detail sheet — slides up from the bottom when a suggested
    // workout is tapped.
    function openWorkoutSheet(dateKey) {
        const day = coachPlanData && coachPlanData.plan ? coachPlanData.plan.days.find(x => x.date === dateKey) : null;
        if (!day || !day.workout) return;
        const w = day.workout;
        const pace = w.target_pace_min_per_km || '--';
        const tagClass = WORKOUT_TAG_CLASS[w.type] || 'rgd-run-tag--easy';
        const sheetDate = parseDate(dateKey + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

        // Build a numbered procedure: top-level steps get a step number, steps
        // inside a repeat group are indented beneath the "Repeat N×" marker.
        // Each step's pace is rendered as a separate element with its own
        // spacing so the time/distance and pace don't run together.
        const steps = w.steps || [];
        let stepNum = 0;
        const stepsHtml = steps.map(s => {
            const paceHtml = s.pace ? `<span class="rgd-sheet-step-pace">${escapeHtml(s.pace)}/km</span>` : '';
            if (s.level === 1) {
                return `<div class="rgd-sheet-step rgd-sheet-step--sub"><span class="rgd-sheet-step-type">↳ ${escapeHtml(s.type || 'Run')}</span><span class="rgd-sheet-step-detail">${escapeHtml(s.detail || '')}</span>${paceHtml}</div>`;
            }
            stepNum += 1;
            const isRepeat = s.type === 'Repeat';
            return `<div class="rgd-sheet-step ${isRepeat ? 'rgd-sheet-step--repeat' : ''}"><span class="rgd-sheet-step-num">${stepNum}</span><span class="rgd-sheet-step-type">${escapeHtml(s.type || 'Run')}</span><span class="rgd-sheet-step-detail">${escapeHtml(s.detail || '')}</span>${paceHtml}</div>`;
        }).join('');

        // Workout description — the short 1-2 sentence intent summary that
        // is also sent to Garmin as the workout description. Shown before
        // the AI coach insight so the runner sees the session purpose first.
        const descriptionHtml = w.description ? `
            <div class="rgd-sheet-section">
                <span class="rgd-sheet-section-title">Description</span>
                <p class="rgd-sheet-description">${escapeHtml(w.description)}</p>
            </div>` : '';

        const insightHtml = w.insight ? `
            <div class="rgd-sheet-section">
                <span class="rgd-sheet-section-title">Coach insight</span>
                <p class="rgd-sheet-insight">${escapeHtml(w.insight)}</p>
            </div>` : '';

        workoutSheetBody.innerHTML = `
            <div class="rgd-sheet-header">
                <h3 class="rgd-sheet-title">${escapeHtml(w.title || w.type)}</h3>
                <span class="rgd-run-tag ${tagClass}">${escapeHtml(w.type)}</span>
            </div>
            <div class="rgd-sheet-meta">
                ${w.distance_km ? `<span class="rgd-sheet-meta-item"><strong>${w.distance_km}</strong> km</span>` : ''}
                ${w.duration_min ? `<span class="rgd-sheet-meta-item"><strong>${w.duration_min}</strong> min</span>` : ''}
                <span class="rgd-sheet-meta-item"><strong>${pace}</strong>/km</span>
                <span class="rgd-sheet-meta-item">${sheetDate}</span>
            </div>
            ${descriptionHtml}
            ${insightHtml}
            ${stepsHtml ? `<div class="rgd-sheet-section"><span class="rgd-sheet-section-title">Workout breakdown</span><div class="rgd-sheet-steps">${stepsHtml}</div></div>` : ''}
        `;
        workoutSheet.hidden = false;
        // Force reflow so the initial transform applies before the slide-up
        void workoutSheet.offsetHeight;
        workoutSheet.classList.add('rgd-sheet-overlay--open');
        workoutSheetClose.focus();
    }

    function closeWorkoutSheet() {
        workoutSheet.classList.remove('rgd-sheet-overlay--open');
        // Wait for the exit animation before hiding — listen on the sheet
        // element since both the slide-down (mobile) and scale-out (desktop)
        // transitions happen there via transform
        const sheet = workoutSheet.querySelector('.rgd-workout-sheet');
        const onEnd = () => {
            workoutSheet.hidden = true;
            sheet.removeEventListener('transitionend', onEnd);
        };
        sheet.addEventListener('transitionend', onEnd);
        // Safety fallback: if transitionend never fires (e.g. prefers-reduced-motion),
        // hide after a timeout matching the longest transition
        setTimeout(() => { workoutSheet.hidden = true; }, 400);
    }

    workoutSheetClose.addEventListener('click', closeWorkoutSheet);
    workoutSheet.addEventListener('click', (e) => {
        if (e.target === workoutSheet) closeWorkoutSheet();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !workoutSheet.hidden) closeWorkoutSheet();
    });

    // The 3-position distance slider maps to a direction, not a raw number
    const DISTANCE_ADJ = ['reduce', 'keep', 'increase'];

    function openPlanPrefsModal() {
        // Pre-fill the form from the persisted preferences
        prefDaysEl.value = String(coachPrefs.days_per_week || 3);
        prefIntensityEl.value = coachPrefs.intensity || 'moderate';
        const sliderIdx = DISTANCE_ADJ.indexOf(coachPrefs.distance_adj);
        prefDistanceEl.value = String(sliderIdx >= 0 ? sliderIdx : 1);
        planPrefsModal.hidden = false;
        planPrefsModalClose.focus();
    }

    function closePlanPrefsModal() {
        planPrefsModal.hidden = true;
    }

    planEditBtn.addEventListener('click', openPlanPrefsModal);
    planPrefsModalClose.addEventListener('click', closePlanPrefsModal);
    planPrefsCancelBtn.addEventListener('click', closePlanPrefsModal);
    planPrefsModal.addEventListener('click', (e) => {
        if (e.target === planPrefsModal) closePlanPrefsModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !planPrefsModal.hidden) closePlanPrefsModal();
    });

    planPrefsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const prefs = {
            days_per_week: Number(prefDaysEl.value) || 3,
            intensity: prefIntensityEl.value || 'moderate',
            distance_adj: DISTANCE_ADJ[Number(prefDistanceEl.value)] || 'keep',
        };
        coachPrefs = prefs;
        writeCoachPrefs(prefs);
        closePlanPrefsModal();
        generateCoachPlan(prefs, true);
    });

    schedulePlanBtn.addEventListener('click', schedulePlan);

    async function schedulePlan() {
        if (!coachPlanData || !coachPlanData.plan) return;
        const days = coachPlanData.plan.days
            .filter(d => !d.is_rest && d.workout && !coachScheduledDates.has(d.date))
            .map(d => ({ date: d.date, workout: d.workout }));

        if (!days.length) {
            scheduleStatusEl.textContent = 'No unscheduled workouts to send.';
            scheduleStatusEl.hidden = false;
            return;
        }

        schedulePlanBtn.disabled = true;
        scheduleStatusEl.hidden = false;
        scheduleStatusEl.textContent = 'Sending workouts to Garmin…';

        // Demo mode: simulate success without touching Garmin
        if (window.__demoMode) {
            days.forEach(d => coachScheduledDates.add(d.date));
            scheduleStatusEl.textContent = `Sent ${days.length} workouts (demo — nothing written to Garmin).`;
            schedulePlanBtn.disabled = false;
            schedulePlanBtn.hidden = true;
            renderCoachCalendar(coachPlanData);
            return;
        }

        try {
            const resp = await apiCall('POST', 'schedule-plan', { days });
            const data = await resp.json();
            if (!resp.ok) {
                scheduleStatusEl.textContent = data.error || 'Failed to schedule workouts.';
            } else {
                (data.scheduled || []).forEach(s => coachScheduledDates.add(s.date));
                const scheduledCount = (data.scheduled || []).length;
                const errorCount = (data.errors || []).length;
                scheduleStatusEl.textContent = errorCount
                    ? `Sent ${scheduledCount} workouts; ${errorCount} failed.`
                    : `Sent ${scheduledCount} workouts to Garmin.`;
                if (!errorCount) schedulePlanBtn.hidden = true;
                renderCoachCalendar(coachPlanData);
            }
        } catch (err) {
            scheduleStatusEl.textContent = 'Network error.';
        } finally {
            schedulePlanBtn.disabled = false;
        }
    }

    // Load the plan when the Plan page is navigated to — openPlanPage
    // resets to 2 weeks of history and scrolls to today on every open
    window.addEventListener('hashchange', () => {
        if (getPageFromHash() === 'plan') openPlanPage();
    });

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
                // If race goal state changed on the server, sync the frontend.
                // The server now returns the actual race_goal data (not just a
                // boolean), so we can restore it if localStorage is missing it
                // (e.g. user cleared cache, or is on a new device).
                if (data.has_race_goal && data.race_goal) {
                    if (!raceGoal) {
                        // Server has a goal but frontend doesn't — restore it
                        raceGoal = data.race_goal;
                        localStorage.setItem('rgd_race_goal', JSON.stringify(raceGoal));
                        showDashboard();
                    }
                    // If both have the goal, stay on the dashboard — no change needed
                } else if (!data.has_race_goal && raceGoal) {
                    // Server has no goal but frontend thinks it has one — the
                    // persisted goal was removed (shouldn't happen normally,
                    // but handle it gracefully)
                    showScreen(onboardScreen);
                }
                // Pre-seed AI insights and coach plan caches from the server's
                // persistent store if the frontend doesn't have them. This
                // covers the new-device case where localStorage is empty but
                // the server has cached data from another device.
                if (data.cached_ai_insights && !readAICache()) {
                    writeAICache(data.cached_ai_insights);
                }
                if (data.cached_coach_plan && !readCoachCache()) {
                    writeCoachCache(data.cached_coach_plan);
                }
            } else {
                // Session expired — clear cache and fall back to demo mode
                sessionToken = '';
                localStorage.removeItem('rgd_session_token');
                localStorage.removeItem('rgd_display_name');
                localStorage.removeItem('rgd_profile_image_url');
                clearSWRCaches();
                clearAICache();
                clearCoachCache();
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

    // =========================================================================
    // Auto-refresh — re-fetch training vitals when the tab regains focus
    // or on a periodic interval, so a user who stays logged in sees fresh
    // data without manually reloading the page. Skipped in demo mode (no
    // real API to call) and only triggers if at least 1 hour has passed
    // since the last fetch, avoiding redundant calls on rapid tab switches.
    // =========================================================================

    const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour — matches SWR TTL

    // Re-fetch if enough time has passed since the last fetch. Guards
    // against concurrent refreshes and demo mode.
    let isRefreshing = false;
    function refreshDataIfStale() {
        if (window.__demoMode || isRefreshing) return;
        if (Date.now() - lastDataFetchTime < AUTO_REFRESH_INTERVAL_MS) return;
        isRefreshing = true;
        lastDataFetchTime = Date.now();
        // Silently re-fetch — no overlay, just update the data in place.
        // loadAllData shows the overlay which is disruptive for a background
        // refresh, so we fetch metrics + activities + mileage directly and
        // re-render without the loading state.
        (async () => {
            try {
                const [metricsResp, activitiesResp, mileageResp] = await Promise.all([
                    apiCall('GET', 'metrics'),
                    apiCall('GET', `activities?limit=${ACTIVITIES_PAGE_SIZE}&offset=0`),
                    apiCall('GET', 'weekly-mileage?weeks=12'),
                ]);
                const metricsData = await metricsResp.json();
                const activitiesData = await activitiesResp.json();
                const mileageData = await mileageResp.json();
                if (metricsResp.ok && metricsData.metrics) {
                    renderMetrics(metricsData.metrics);
                    writeSWRCache(METRICS_CACHE_KEY, metricsData.metrics);
                }
                if (activitiesResp.ok && activitiesData.activities) {
                    const acts = activitiesData.activities;
                    fullActivitiesLoaded = acts;
                    activitiesOffset = acts.length;
                    renderActivities(acts);
                    renderCalendar(acts);
                    renderPaceDistribution(acts);
                    renderHrPaceScatter(acts);
                }
                if (mileageResp.ok && mileageData.weeks) {
                    renderMileageChart(mileageData.weeks);
                    writeSWRCache(MILEAGE_CACHE_KEY, mileageData.weeks);
                }
            } catch (err) {
                // Network error during background refresh — silently skip.
                // The user still sees the cached data; next manual reload
                // or tab switch will retry.
                console.warn('Background refresh failed:', err);
            } finally {
                isRefreshing = false;
            }
        })();
    }

    // Re-fetch when the tab becomes visible again (user switches back
    // from another tab or app). This is the primary refresh trigger for
    // most users — they leave the tab open, check other things, come back.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            refreshDataIfStale();
        }
    });

    // Periodic fallback — if the user never switches tabs, re-fetch every
    // hour. This covers long idle sessions where the tab stays visible.
    setInterval(refreshDataIfStale, AUTO_REFRESH_INTERVAL_MS);

});
