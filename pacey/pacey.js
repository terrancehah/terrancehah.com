// Pacey — full rewrite.
// Single-page dashboard: metric tiles, column chart, calendar,
// activity history, AI radar, AI summary. Collapsible sidebar.

document.addEventListener('DOMContentLoaded', function () {

    // =========================================================================
    // Config
    // =========================================================================
    const API_BASE = '/pacey/api';

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // Screens — login is now a modal, not a full screen
    const loginModal = $('#pacey-login-modal');
    const loginModalClose = $('#pacey-login-modal-close');
    const onboardScreen = $('#pacey-onboarding-screen');
    const onboardFitnessScreen = $('#pacey-onboarding-fitness-screen');
    const onboardPlanScreen = $('#pacey-onboarding-plan-screen');
    const dashboardScreen = $('#pacey-dashboard-screen');
    const overlay = $('#pacey-overlay');
    const overlayStroke = $('#pacey-overlay-stroke');

    // Login
    const loginForm = $('#pacey-login-form');
    const loginBtn = $('#pacey-login-btn');
    const authError = $('#pacey-auth-error');

    // Onboarding
    const onboardForm = $('#pacey-onboard-form');
    const onboardBtn = $('#pacey-onboard-btn');
    const onboardFitnessForm = $('#pacey-onboard-fitness-form');
    const onboardFitnessBtn = $('#pacey-onboard-fitness-btn');
    const onboardPlanForm = $('#pacey-onboard-plan-form');
    const onboardPlanBtn = $('#pacey-onboard-plan-btn');

    // Dashboard
    const greetingEl = $('#pacey-greeting');
    const avatarEl = $('#pacey-sidebar-avatar');
    let profileImageUrl = ''; // Garmin profile image URL (empty in demo mode)
    const sidebarGoalEl = $('#pacey-sidebar-goal');
    const sidebarToggle = $('#pacey-sidebar-toggle');
    const sidebar = $('#pacey-sidebar');
    const dashboardLayout = document.querySelector('.pacey-dashboard-layout');
    const settingsBtn = $('#pacey-settings-btn');
    const themeToggle = $('#pacey-theme-toggle');
    const demoBanner = $('#pacey-demo-banner');
    const metricsGrid = $('#pacey-metrics-grid');
    const activitiesList = $('#pacey-activities-list');
    const activitiesFull = $('#pacey-activities-full');
    const calendarEl = $('#pacey-calendar');
    // Remove old legend references — radar now uses clickable labels with tooltips
    // const dimensionLegends removed; labels are interactive on the chart itself

    // Store radar values for click-to-tooltip interaction (populated in renderRadarChart)
    let radarValues10 = []; // scores on 1-10 scale
    let radarLabels = [];   // dimension names, set when chart renders
    // Pillars content appears on both overview and readiness pages — use class
    // selectors so both instances stay in sync (no skeleton placeholders anymore)
    const pillarsContents = $$('.pacey-pillars-content');
    const summaryErrors = $$('.pacey-summary-error');
    const refreshAnalysisBtn = $('#pacey-refresh-analysis');
    // Readiness page "last updated" label (readiness page only)
    const readinessUpdatedEl = $('#pacey-readiness-updated');

    // Store all activities for show-all toggle
    let allActivities = [];

    // Pagination state for the activities page — the overview always
    // shows the 5 latest, while the full page loads in batches.
    // Charts (calendar, pace distribution, HR scatter) use the initial
    // batch only and are never updated by pagination.
    const ACTIVITIES_PAGE_SIZE = 20;
    let activitiesOffset = 0;      // Garmin API offset for next fetch
    let fullActivitiesLoaded = []; // accumulated activities on the full page
    // Whether the first activity batch has arrived. Post-race detection needs it:
    // before the fetch, "no run matched the goal" and "no data yet" are
    // indistinguishable, and the recap should not ask a question the data may
    // already answer.
    let activitiesLoaded = false;
    let isLoadingMore = false;     // prevents duplicate concurrent fetches

    // State
    let sessionToken = '';
    let displayName = '';
    let raceGoal = null;
    let raceGoalPaceMs = 0; // race goal pace in m/s — used for run classification
    // Two-factor login state, declared with the rest of the module state rather
    // than down in the login section: closeLoginModal() resets it, and that
    // function is defined earlier, so a `let` down there could be read before
    // its declaration runs.
    let mfaToken = '';
    let mfaEmail = '';
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

    // Retry a data request once on 401. The backend silently refreshes the
    // Garmin tokens, so a lone 401 is usually a transient rotation/rate-limit
    // blip — one retry resolves it without interrupting the runner. Only a
    // second consecutive 401 is treated as a genuine re-login case, keeping
    // prompts to a minimum.
    async function apiCallWithAuthRetry(method, path, body = null) {
        let resp = await apiCall(method, path, body);
        if (resp.status === 401) {
            // Brief pause lets a concurrent token rotation settle before retry
            await new Promise(resolve => setTimeout(resolve, 800));
            resp = await apiCall(method, path, body);
        }
        return resp;
    }

    // Rotating loading messages — the overlay strokes on a hand-drawn SVG for
    // each phrase (generated with Tegaki from the app's Caveat face). Each SVG
    // bakes its OWN draw duration into its CSS, so we read that duration and
    // start the next phrase the moment the current one finishes writing.
    const LOADING_MESSAGES = [
        'Loading your training data…',
        'Crunching the numbers…',
        'Reviewing your progress…',
        'Almost there…',
        'Preparing your dashboard…',
        'Syncing with Garmin…',
    ];
    const LOADING_STROKES = LOADING_MESSAGES.map((_, i) => `/pacey/assets/loading/loading-${i + 1}.svg`);
    // Warm the cache for the first phrase so the overlay paints immediately;
    // the rest load as the phrases rotate.
    fetch(LOADING_STROKES[0]).catch(() => { /* offline — the fallback covers it */ });

    let loadingMsgTimer = null;   // timeout chain, not an interval
    let loadingRunToken = 0;      // bumped to stop a running chain

    // Fetch a phrase's SVG and read its draw duration (seconds) out of its own
    // stylesheet, so the next phrase starts exactly when this one finishes.
    // Cached per src — the markup is cached too, since it gets injected inline.
    const strokeSources = new Map();
    async function strokeSource(src) {
        if (strokeSources.has(src)) return strokeSources.get(src);
        let entry = { markup: '', secs: 4 };
        try {
            const text = await (await fetch(src)).text();
            const m = text.match(/tk-d0\s+([\d.]+)s/);
            entry = { markup: text, secs: m ? parseFloat(m[1]) : 4 };
        } catch (e) { /* keep the fallback entry */ }
        strokeSources.set(src, entry);
        return entry;
    }

    // Inject a stroke SVG inline into any host element — used by the loading
    // overlay and by the plan build's headline. Inline rather than an <img>
    // because iOS WebKit doesn't run CSS animations inside an SVG used as an
    // image. Leaves the host empty if the fetch fails.
    async function injectStroke(host, src) {
        if (!host) return;
        try {
            const entry = await strokeSource(src);
            if (entry.markup) host.innerHTML = entry.markup;
        } catch (e) { /* leave the host empty */ }
    }

    // Swap in a phrase by replacing the injected SVG. Re-creating the elements
    // restarts the stroke animation from the start, even for the same file.
    function setOverlayStroke(entry, msgIndex) {
        if (!overlayStroke) return;
        const label = LOADING_MESSAGES[msgIndex].replace('…', '');
        if (entry.markup) {
            overlayStroke.innerHTML = entry.markup;
        } else {
            // Fetch failed — fall back to the phrase as plain handwriting.
            overlayStroke.textContent = '';
            const span = document.createElement('span');
            span.className = 'pacey-overlay-stroke-fallback';
            span.textContent = label;
            overlayStroke.appendChild(span);
        }
        overlayStroke.setAttribute('aria-label', label);
    }

    // Chain the phrases: when a stroke finishes writing, hold briefly so the
    // finished sentence reads, then start the next one.
    const STROKE_HOLD_MS = 600;
    async function runLoadingStrokes() {
        const token = ++loadingRunToken;
        let i = 0;
        const step = async () => {
            if (token !== loadingRunToken) return;
            const idx = i % LOADING_STROKES.length;
            const entry = await strokeSource(LOADING_STROKES[idx]);
            if (token !== loadingRunToken) return;
            setOverlayStroke(entry, idx);
            loadingMsgTimer = setTimeout(() => { i++; step(); }, entry.secs * 1000 + STROKE_HOLD_MS);
        };
        step();
    }

    function showOverlay() {
        overlay.hidden = false;
        runLoadingStrokes();
    }

    function hideOverlay() {
        overlay.hidden = true;
        loadingRunToken++;   // stop the chain
        if (loadingMsgTimer) { clearTimeout(loadingMsgTimer); loadingMsgTimer = null; }
    }

    function setButtonLoading(btn, loading) {
        const t = btn.querySelector('.pacey-btn-text');
        const s = btn.querySelector('.pacey-btn-spinner');
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
        const emailInput = $('#pacey-email');
        if (emailInput) emailInput.focus();
    }
    function closeLoginModal() {
        loginModal.hidden = true;
        authError.hidden = true;
        // Drop any half-finished two-factor step, so reopening the modal starts
        // from the password rather than showing a stale code field.
        resetMfaStep();
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
    const headerEl = document.querySelector('header.pacey-header-offset');
    sidebarToggle.addEventListener('click', () => {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        // Update the dashboard layout offset to match sidebar state
        if (dashboardLayout) {
            dashboardLayout.classList.toggle('sidebar-collapsed', isCollapsed);
        }
        // Update header offset to match sidebar state
        if (headerEl) {
            headerEl.classList.toggle('pacey-header-collapsed', isCollapsed);
        }
        // Update title
        sidebarToggle.title = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
        // Reposition the sidebar nav indicator after the collapse/expand
        // transition completes — the nav items change width so the indicator
        // needs to follow. Disable the ready class during the layout change
        // so the indicator tracks smoothly with the collapsing items rather
        // than lagging behind, then re-enable after.
        if (navIndicator) {
            navIndicator.classList.remove('pacey-indicator-ready');
            // Track the nav width during the CSS transition (0.2s)
            const trackInterval = setInterval(() => positionIndicators(), 16);
            setTimeout(() => {
                clearInterval(trackInterval);
                positionIndicators();
                navIndicator.classList.add('pacey-indicator-ready');
            }, 250);
        }
    });

    // =========================================================================
    // Theme toggle (light/dark) — persisted in localStorage
    // =========================================================================

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('pacey_theme', theme);
        themeToggle.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        // Update the label to show the current mode name
        const labelEl = $('#pacey-theme-label');
        if (labelEl) labelEl.textContent = theme === 'dark' ? 'Dark' : 'Light';
    }

    // Shared toggle handler — flips theme and re-renders charts
    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(current === 'light' ? 'dark' : 'light');
        // Re-resolve metric zone colours from the new theme's tokens so
        // popups opened after the toggle use the correct palette.
        resolveMetricZoneColors();
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
            // Course elevation profile — re-render so its grid/label colours
            // follow the new theme like the other charts.
            if (courseRecord) {
                renderCourseChart(courseRecord);
            }
        }
    }

    themeToggle.addEventListener('click', toggleTheme);

    // Mobile theme toggle — same behaviour, floating button on small screens
    const mobileThemeToggle = $('#pacey-theme-toggle-mobile');
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

    const savedTheme = localStorage.getItem('pacey_theme');
    applyTheme(savedTheme || getAutoTheme());

    // Hash-based page routing
    function getPageFromHash() {
        const hash = window.location.hash.replace('#', '');
        return hash || 'overview';
    }

    function navigateTo(page) {
        // Update active nav (sidebar items + bottom tab bar items)
        $$('.pacey-nav-item').forEach(item => {
            item.classList.toggle('active', item.getAttribute('href') === `#${page}`);
        });
        $$('.pacey-tab-item').forEach(item => {
            item.classList.toggle('active', item.getAttribute('href') === `#${page}`);
        });
        // Show/hide pages
        $$('.pacey-page').forEach(p => p.hidden = true);
        const target = document.getElementById(`pacey-page-${page}`);
        if (target) target.hidden = false;
        // A radar canvas that was hidden when the chart was last built (the
        // readiness page during the overview load) has no chart yet — it gets
        // one now that the page is visible and the canvas has a size.
        if (lastRadarData && radarCanvasesToRender().some(c => !Chart.getChart(c))) {
            renderRadarChart(lastRadarData);
        }
        // Post-race the course preview lives in the recap, and there is a recap
        // on each of the two pages — so it follows the runner across. Guarded on
        // the mode because pre-race it stays put in the goal card.
        if (postRaceState(raceGoal, fullActivitiesLoaded).isPostRace) {
            placeGoalMapNote(true);
        }
        // Scroll to the top of the new page. The window is the actual scroll
        // container (.pacey-content has overflow:clip — the page scrolls
        // naturally), so setting content.scrollTop alone does nothing and the
        // previous page's scroll position would carry over. Reset both so
        // every page opens at the top.
        const content = $('#pacey-content');
        if (content) content.scrollTop = 0;
        window.scrollTo(0, 0);
        // Position the sliding indicators behind the now-active items
        positionIndicators();
    }

    // Sliding indicators — frosted/tinted backgrounds that animate their
    // position to sit behind whichever nav item or tab is active.
    // On first render the indicators jump without transition; after that
    // the .pacey-indicator-ready class enables smooth sliding.
    const tabIndicator = $('#pacey-tab-indicator');
    const navIndicator = $('#pacey-nav-indicator');
    let indicatorsReady = false;

    function positionIndicators() {
        // Mobile tab bar indicator — match the active tab item's rect
        if (tabIndicator) {
            const activeTab = document.querySelector('.pacey-tab-item.active');
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
            const activeNav = document.querySelector('.pacey-nav-item.active');
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
                tabIndicator?.classList.add('pacey-indicator-ready');
                navIndicator?.classList.add('pacey-indicator-ready');
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
    $$('.pacey-tab-item[href]').forEach(item => {
        item.addEventListener('click', (e) => {
            const targetPage = item.getAttribute('href').replace('#', '');
            const currentPage = getPageFromHash();
            // Only act when the tapped tab is already the active page. If it's
            // a different page, let the normal hashchange flow handle it.
            if (targetPage !== currentPage) return;
            e.preventDefault();
            // Same page: tap once to scroll to the top, and tap again once
            // you're already there to reload. Home-screen (standalone) PWAs
            // have no browser chrome and no pull-to-refresh, so this gives
            // them a refresh path that Safari users also get for free.
            if (window.scrollY > 4) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                // Play the refresh animation before reloading so the refresh
                // reads as deliberate instead of a white blink.
                playRefreshAnimation(() => {
                    clearClientPlanCache();
                    window.location.reload();
                });
            }
        });
    });

    // =========================================================================
    // Refresh paths for home-screen (standalone) web apps
    // =========================================================================
    // iOS strips Safari's pull-to-refresh and the reload button when a site
    // is added to the Home Screen. Everything below fills that gap; Safari
    // keeps its own native mechanisms, so the pull gesture is standalone-only.
    const isStandalone = window.navigator.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches;

    // --- Refresh animation ---
    // A quick "pull down and spring back" dip of the page CONTENT (not the
    // fixed chrome — the tab bar and FAB stay put, like Safari's pull), so a
    // refresh reads as deliberate. The callback (a reload) fires once the
    // spring-back settles.
    const refreshSurface = $('#pacey-content') || document.documentElement;

    // Spinner shown while a refresh is in flight (tab re-tap) or while the
    // page is pulled past the trigger point (standalone gesture).
    const refreshSpinner = document.createElement('div');
    refreshSpinner.className = 'pacey-refresh-spinner';
    refreshSpinner.setAttribute('aria-hidden', 'true');
    document.body.appendChild(refreshSpinner);
    const showRefreshSpinner = (on) =>
        refreshSpinner.classList.toggle('pacey-refresh-spinner--visible', on);

    let refreshAnimating = false;

    // A user-initiated refresh should actually re-pull the plan (the server
    // serves its own persistent cache cheaply), not hand back the 24h client
    // copy — otherwise a run finished today never shows up until tomorrow.
    function clearClientPlanCache() {
        try { localStorage.removeItem('pacey_coach_plan_cache_v2'); } catch (e) { /* ignore */ }
    }

    function playRefreshAnimation(done) {
        if (refreshAnimating) return;
        refreshAnimating = true;
        showRefreshSpinner(true);
        refreshSurface.style.transition = 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)';
        refreshSurface.style.transform = 'translateY(56px)';
        setTimeout(() => {
            refreshSurface.style.transition = 'transform 0.22s ease-out';
            refreshSurface.style.transform = 'translateY(0)';
            // Leave the spinner up through the reload so it covers the swap.
            setTimeout(done, 220);
        }, 300);
    }

    // --- Pull-to-refresh (standalone only) ---
    // A rubber-band pull at the top of the page, matching how Safari feels:
    // drag the page down with damping, and reload if released past a
    // threshold. The page itself is the indicator — no extra UI.
    if (isStandalone) {
        const PULL_TRIGGER_PX = 80;   // release past this to reload
        const PULL_MAX_PX = 140;      // clamp so the page can't be dragged away
        let pullStartY = null;
        let pullActive = false;
        let pullDistance = 0;

        const endPull = () => {
            const shouldReload = pullActive && pullDistance >= PULL_TRIGGER_PX;
            pullStartY = null;
            pullActive = false;
            pullDistance = 0;
            // Spring back, then reload so the animation isn't cut short.
            refreshSurface.style.transition = 'transform 0.25s ease-out';
            refreshSurface.style.transform = 'translateY(0)';
            if (shouldReload) {
                clearClientPlanCache();
                setTimeout(() => window.location.reload(), 260);
            } else {
                showRefreshSpinner(false);
            }
        };

        window.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1 || window.scrollY > 0) return;
            pullStartY = e.touches[0].clientY;
            pullActive = false;
            pullDistance = 0;
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (pullStartY === null) return;
            const dy = e.touches[0].clientY - pullStartY;
            if (dy <= 0 || window.scrollY > 0) {
                if (pullActive) endPull();
                pullStartY = null;
                return;
            }
            pullActive = true;
            // Damped so the drag gets progressively harder, like Safari's.
            pullDistance = Math.min(PULL_MAX_PX, Math.pow(dy, 0.85));
            // Spin once the pull is past the point that will trigger a reload.
            showRefreshSpinner(pullDistance >= PULL_TRIGGER_PX);
            refreshSurface.style.transition = 'none';
            refreshSurface.style.transform = `translateY(${pullDistance}px)`;
            if (e.cancelable) e.preventDefault();
        }, { passive: false });

        window.addEventListener('touchend', endPull, { passive: true });
        window.addEventListener('touchcancel', endPull, { passive: true });
    }

    // --- Refresh on resume (after a long gap) ---
    // Coming back to the app after it's been backgrounded for a while (e.g.
    // after finishing a run) should show fresh data without a manual reload.
    // Short app-switches are ignored so we don't refetch constantly, and the
    // reload is skipped while onboarding/login is on screen so it can't wipe
    // a half-finished form.
    const RESUME_REFRESH_MS = 10 * 60 * 1000;
    let backgroundedAt = null;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            backgroundedAt = Date.now();
            return;
        }
        const gap = backgroundedAt ? Date.now() - backgroundedAt : 0;
        backgroundedAt = null;
        if (gap < RESUME_REFRESH_MS) return;
        const dashboard = $('#pacey-dashboard-screen');
        if (dashboard && !dashboard.hidden) window.location.reload();
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

        // Demo banner slim — shrink to the compact pill once the user has
        // scrolled away from the top, and expand back when they return.
        //
        // This used to key off #pacey-content's rect.top (i.e. the banner
        // reaching its sticky position). That worked while the site header
        // sat above the content, because the content only reached the top
        // after scrolling past the header. The header has since been removed
        // for the Pacey app, so the content now starts at the very top of the
        // page and that signal is permanently true — the banner shrank on
        // load and never expanded. The scroll offset is the right signal now.
        //
        // Reading the banner's own rect is still avoided: its height changes
        // when it shrinks, which shifts the content below it and can cause an
        // expand/shrink flicker loop.
        const banner = $('#pacey-demo-banner');
        if (banner && !banner.hidden) {
            const isSlim = banner.classList.contains('pacey-demo-banner--slim');
            if (!isSlim && currentY > 64) {
                banner.classList.add('pacey-demo-banner--slim');
            } else if (isSlim && currentY < 16) {
                banner.classList.remove('pacey-demo-banner--slim');
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
        const tabbar = $('#pacey-tabbar');
        if (tabbar) tabbar.classList.toggle('pacey-tabbar--hidden', hide);
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

        // Realistic weekly run schedule — 4 runs per week with rest days
        // between each. Pattern repeats every 7 days going back from today.
        // Day offsets within each week: Tue(1), Thu(3), Sat(5), Sun(6)
        // — Mon, Wed, Fri are rest days; only the weekend long run +
        // recovery are back to back.
        const weeklyOffsets = [1, 3, 5, 6];

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

        // The race itself, dated today. The demo's goal is a half marathon run
        // today, so the post-race recap has something to recognise — and it is
        // what makes the demo land in recap mode rather than on a countdown.
        //
        // Figures are the real ones from the Brooks Half Marathon GPX that also
        // supplies the demo course, so the activity list, the recap and the
        // course card all describe the same run: 21.27 km in 1:49:47.
        activities.unshift({
            id: 24000001,
            name: 'Brooks Half Marathon',
            type: 'running',
            start_time: `${localDateIso(now)} 07:15:00`,
            distance: 21.27,
            duration: 109.8,                                    // minutes
            avg_pace: 3.23,                                     // m/s
            max_pace: 3.9,
            avg_hr: 172,
            max_hr: 184,
            calories: 1480,
            elevation_gain: 63,
            training_effect: 4.6,
            anaerobic_training_effect: 1.8,
            avg_cadence: 178,
            // Over 12 km and run at goal pace, which is what the server's
            // classifier calls a long run with quality. Hardcoded because demo
            // mode has no server to run the classifier.
            run_tag: 'Tempo Long',
            elapsed_duration: 110.5,
        });
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

    // Mock race recap — the coach's read on a finished race, for demo mode. The
    // real one is written by the race-recap action on the backend from the target,
    // the result, the uploaded course and the runner's own recent sessions; this
    // stands in for it because demo mode makes no API calls. Written against the
    // demo's own result: the Brooks Half Marathon, run under the 1:52:00 target.
    //
    // Kept deliberately plain, matching what the real prompt now asks for: it
    // credits the training by kind rather than reciting sessions and figures, and
    // closes on the race without prescribing anything — the race is the end of the
    // plan, so advice about "the next block" would be advice about a block that
    // does not exist.
    function getMockRaceRecap() {
        return 'You ran this one the way you wanted to — under your target, and it never looked like slipping away. That margin was not luck. It came out of the long runs that taught your legs to keep going when the closing kilometres got hard, and the tempo work that made race pace feel like something you could hold rather than something you were clinging to. You did that work, and this is what it bought. Take the win — you earned it.';
    }

    // Start demo mode — used as the default landing and after logout
    function startDemoMode() {
        sessionToken = 'demo';
        displayName = 'Demo Runner';
        raceGoal = {
            race_name: 'Brooks Half Marathon',
            purpose: 'Half Marathon',
            distance: 21.1,
            distance_unit: 'km',
            time_target: '01:52:00',
            // Today, so the demo lands in post-race mode — the race has been run
            // and the recap is what there is to show. Computed rather than
            // hardcoded so the demo does not go stale after this week.
            race_date: localDateIso(),
            weekly_mileage: '35',
            mileage_unit: 'km',
            gender: 'male',
            age: '30',
        };
        localStorage.setItem('pacey_race_goal', JSON.stringify(raceGoal));
        localStorage.setItem('pacey_session_token', 'demo');
        window.__demoMode = true;
        // Show demo CTAs across all pages
        const demoCta = $('#pacey-demo-cta');
        if (demoCta) demoCta.hidden = false;
        // Fill the race-course card with the generated demo course, so the
        // feature is visible without an upload.
        loadDemoCourse();
        showDashboard();
    }

    // =========================================================================
    // Login (modal form submission)
    // =========================================================================

    function setLoginButtonLabel(label) {
        const text = loginBtn && loginBtn.querySelector('.pacey-btn-text');
        if (text) text.textContent = label;
    }

    /**
     * Lock the credential fields while a two-factor code is pending.
     *
     * Disabled rather than merely hidden: a `required` input that is not
     * rendered still blocks submission in browsers ("An invalid form control is
     * not focusable"), and `disabled` bars it from validation while keeping the
     * value the second step needs.
     */
    function setLoginFieldsLocked(locked) {
        ['#pacey-email', '#pacey-password'].forEach((sel) => {
            const field = $(sel);
            if (field) field.disabled = locked;
        });
    }

    function showMfaStep(token, email) {
        mfaToken = token;
        mfaEmail = email;
        const step = $('#pacey-mfa-step');
        if (step) step.hidden = false;
        setLoginFieldsLocked(true);
        setLoginButtonLabel('Verify code');
        const code = $('#pacey-mfa-code');
        if (code) code.focus();
    }

    function resetMfaStep() {
        mfaToken = '';
        mfaEmail = '';
        const step = $('#pacey-mfa-step');
        if (step) step.hidden = true;
        const code = $('#pacey-mfa-code');
        if (code) code.value = '';
        setLoginFieldsLocked(false);
        setLoginButtonLabel('Connect Garmin');
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        authError.hidden = true;
        setButtonLoading(loginBtn, true);
        const email = $('#pacey-email').value.trim();
        const password = $('#pacey-password').value;
        const mfaCode = $('#pacey-mfa-code') ? $('#pacey-mfa-code').value.trim() : '';
        // Second pass: send the code against the token Garmin handed back,
        // rather than the password again.
        const payload = mfaToken
            ? { email: mfaEmail, mfa_token: mfaToken, mfa_code: mfaCode }
            : { email, password };
        try {
            const resp = await fetch(`${API_BASE}/garmin-auth`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await resp.json();
            if (!resp.ok) {
                // Garmin wants a two-factor code — or the one just entered was
                // wrong. Either way this is not a failure to report, it is the
                // next step to show.
                if (data.mfa_required) {
                    const wasInMfa = !!mfaToken;
                    showMfaStep(data.mfa_token, email);
                    if (wasInMfa) {
                        authError.textContent = data.error || 'That code did not work.';
                        authError.hidden = false;
                    }
                    return;
                }
                if (data.mfa_expired) resetMfaStep();
                // The server distinguishes the cases — bad credentials, a
                // locked account, Garmin's rate limit, its bot protection — so
                // its copy is used as-is.
                const msg = [data.error, data.detail]
                    .filter(s => typeof s === 'string' && s.trim())
                    .join(' ');
                authError.textContent = msg || 'Could not sign in. Please try again.';
                authError.hidden = false;
                return;
            }
            resetMfaStep();
            sessionToken = data.session_token;
            displayName = data.display_name;
            profileImageUrl = data.profile_image_url || '';
            localStorage.setItem('pacey_session_token', sessionToken);
            // Cache profile data so the dashboard can render instantly on refresh
            localStorage.setItem('pacey_display_name', displayName || '');
            localStorage.setItem('pacey_profile_image_url', profileImageUrl);
            // Restore the persisted race goal BEFORE seeding caches — the
            // cache keys embed the goal fingerprint, so writing with a null
            // raceGoal produces a key that never matches a later read and the
            // cross-device seed is dead on arrival (every device falls back
            // to the network).
            if (data.has_race_goal && data.race_goal) {
                raceGoal = data.race_goal;
                localStorage.setItem('pacey_race_goal', JSON.stringify(raceGoal));
            }
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
            // Drop the demo course from memory (never from the server) so the
            // runner's own course can load in its place.
            resetCourseLocal();
            if (data.has_race_goal && data.race_goal) {
                // Show the reminder popup instead of going straight to the
                // dashboard or onboarding — the user should consciously
                // decide whether to keep their old goal.
                showGoalReminderPopup(data.race_goal);
            } else {
                // New user or no persisted goal — go to onboarding
                showScreen(onboardScreen);
            }
        } catch (err) {
            // User-facing copy stays plain — the dev hint (which local server
            // to start) is logged to the console instead of shown to visitors.
            authError.textContent = 'Could not reach Garmin. Please try again in a moment.';
            console.warn('Login request failed. Is the local server running? (bash start-dev.sh)', err);
            authError.hidden = false;
        } finally { setButtonLoading(loginBtn, false); }
    });

    // =========================================================================
    // Onboarding
    // =========================================================================

    // Build the onboarding POST body from the race-goal form fields.
    function buildOnboardingBody() {
        const h = $('#pacey-time-h').value || '0';
        const m = $('#pacey-time-m').value || '00';
        const s = $('#pacey-time-s').value || '00';
        const timeTarget = `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;
        const purpose = $('#pacey-purpose').value;
        const dist = formGoalDistance(purpose, $('#pacey-custom-distance').value, $('#pacey-custom-distance-unit').value);
        return {
            race_name: $('#pacey-race-name').value.trim(),
            // The type is kept so the forms can re-open on it, but every
            // read-only view of the goal works from the distance instead.
            purpose,
            distance: dist ? dist.distance : 0,
            distance_unit: dist ? dist.distance_unit : 'km',
            time_target: timeTarget,
            race_date: $('#pacey-race-date').value,
            weekly_mileage: $('#pacey-mileage').value,
            mileage_unit: $('#pacey-mileage-unit').value,
            gender: $('#pacey-gender').value,
            age: $('#pacey-age').value,
        };
    }

    onboardForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        $$('.pacey-input.error').forEach(el => el.classList.remove('error'));
        $$('.pacey-field-error').forEach(el => el.hidden = true);

        const h = $('#pacey-time-h').value || '0';
        const m = $('#pacey-time-m').value || '00';
        const s = $('#pacey-time-s').value || '00';
        const timeTarget = `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;

        const purposeValue = $('#pacey-purpose').value;
        const required = [
            { id: 'pacey-race-name', val: $('#pacey-race-name').value.trim() },
            { id: 'pacey-purpose', val: purposeValue },
            // The custom distance only matters when Custom is picked. The field
            // is hidden otherwise, so requiring it unconditionally would block
            // the four standard types.
            ...(purposeValue === 'Custom'
                ? [{ id: 'pacey-custom-distance', val: $('#pacey-custom-distance').value }]
                : []),
            { id: 'pacey-time-h', val: timeTarget !== '00:00:00' ? timeTarget : '' },
            { id: 'pacey-race-date', val: $('#pacey-race-date').value },
            { id: 'pacey-mileage', val: $('#pacey-mileage').value },
            { id: 'pacey-gender', val: $('#pacey-gender').value },
            { id: 'pacey-age', val: $('#pacey-age').value },
        ];

        let hasError = false;
        for (const f of required) {
            if (!f.val) {
                const el = document.getElementById(f.id);
                if (el) el.classList.add('error');
                const fg = el && el.closest('.pacey-field');
                if (fg) { const er = fg.querySelector('.pacey-field-error'); if (er) er.hidden = false; }
                if (f.id === 'pacey-time-h') {
                    ['pacey-time-h','pacey-time-m','pacey-time-s'].forEach(id => {
                        const inp = document.getElementById(id); if (inp) inp.classList.add('error');
                    });
                    const dpErr = document.querySelector('#pacey-duration-picker').nextElementSibling;
                    if (dpErr && dpErr.classList.contains('pacey-field-error')) dpErr.hidden = false;
                }
                hasError = true;
            }
        }
        if (hasError) return;

        setButtonLoading(onboardBtn, true);
        const body = buildOnboardingBody();
        try {
            const resp = await apiCall('POST', 'onboarding', body, true);
            const data = await resp.json();
            if (!resp.ok) { alert(data.error || 'Failed to save race goal.'); return; }
            fileRaceResultToHistory(raceGoal);
            raceGoal = data.goal;
            localStorage.setItem('pacey_race_goal', JSON.stringify(raceGoal));
            // Proceed to Step 3 — latest race result (current fitness)
            showScreen(onboardFitnessScreen);
        } catch (err) { alert('Network error. Please try again.'); }
        finally { setButtonLoading(onboardBtn, false); }
    });

    // ---- Latest race result helpers -------------------------------------
    // Race type -> distance in km, used only for the pace readout. Types
    // without a fixed distance (Ultra, Triathlon) are absent, so the pace
    // clause is dropped and we just state the time.
    const RACE_TYPE_KM = { '5K': 5, '10K': 10, 'Half Marathon': 21.0975, 'Marathon': 42.195 };

    // Read the H/M/S duration picker into a total-second count.
    function readDurationSeconds(hId, mId, sId) {
        const h = parseInt($(hId).value, 10) || 0;
        const m = parseInt($(mId).value, 10) || 0;
        const s = parseInt($(sId).value, 10) || 0;
        return h * 3600 + m * 60 + s;
    }

    // Format total seconds as "H:MM:SS" (or "MM:SS" under an hour). Named
    // distinctly because an existing formatDuration(minutes) lives further
    // down the same scope and would otherwise win via hoisting.
    function formatRaceTime(totalSec) {
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = n => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    // Format a per-km pace from total seconds and a distance in km.
    function formatPacePerKm(totalSec, km) {
        const secPerKm = Math.round(totalSec / km);
        let m = Math.floor(secPerKm / 60);
        let s = secPerKm % 60;
        if (s === 60) { m += 1; s = 0; }
        return `${m}:${String(s).padStart(2, '0')}/km`;
    }

    // Live sentence under the race-result inputs, e.g.
    // "You completed your latest race of Half Marathon in 1:48:00, which
    //  converts to 5:07/km pace."
    function updateFitnessSummary() {
        const el = $('#pacey-fitness-summary');
        if (!el) return;
        const type = $('#pacey-fitness-distance').value;
        const totalSec = readDurationSeconds('#pacey-fitness-time-h', '#pacey-fitness-time-m', '#pacey-fitness-time-s');
        if (!type || !totalSec) { el.hidden = true; el.textContent = ''; return; }
        const time = formatRaceTime(totalSec);
        const km = RACE_TYPE_KM[type];
        el.textContent = km
            ? `You completed your latest race of ${type} in ${time}, which converts to ${formatPacePerKm(totalSec, km)} pace.`
            : `You completed your latest race of ${type} in ${time}.`;
        el.hidden = false;
    }

    ['#pacey-fitness-distance', '#pacey-fitness-time-h', '#pacey-fitness-time-m', '#pacey-fitness-time-s'].forEach(sel => {
        const el = $(sel);
        if (el) { el.addEventListener('input', updateFitnessSummary); el.addEventListener('change', updateFitnessSummary); }
    });

    // Step 3 — latest race result (current fitness anchor). Saves the full
    // goal with the fitness fields, then proceeds to planning preferences.
    onboardFitnessForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        $$('.pacey-input.error').forEach(el => el.classList.remove('error'));
        $$('.pacey-field-error').forEach(el => el.hidden = true);

        const raceType = $('#pacey-fitness-distance').value;
        const totalSec = readDurationSeconds('#pacey-fitness-time-h', '#pacey-fitness-time-m', '#pacey-fitness-time-s');
        // A race type and a non-zero time are both required.
        const checks = [
            { el: $('#pacey-fitness-distance'), bad: !raceType },
            { el: $('#pacey-fitness-time-m'), bad: !totalSec },
        ];
        let hasError = false;
        for (const c of checks) {
            if (!c.bad) continue;
            if (c.el) c.el.classList.add('error');
            const fg = c.el && c.el.closest('.pacey-field');
            if (fg) { const er = fg.querySelector('.pacey-field-error'); if (er) er.hidden = false; }
            hasError = true;
        }
        if (hasError) return;

        setButtonLoading(onboardFitnessBtn, true);
        const body = buildOnboardingBody();
        body.fitness_race_distance = raceType;
        body.fitness_race_time = formatRaceTime(totalSec);
        try {
            const resp = await apiCall('POST', 'onboarding', body, true);
            const data = await resp.json();
            if (!resp.ok) { alert(data.error || 'Failed to save race goal.'); return; }
            fileRaceResultToHistory(raceGoal);
            raceGoal = data.goal;
            localStorage.setItem('pacey_race_goal', JSON.stringify(raceGoal));
            // Proceed to Step 4 — planning preferences
            showScreen(onboardPlanScreen);
        } catch (err) { alert('Network error. Please try again.'); }
        finally { setButtonLoading(onboardFitnessBtn, false); }
    });

    // Step 3 — planning preferences. Saves the runner's plan prefs and
    // proceeds to the dashboard. The prefs are stored locally and used
    // when the coach plan is first generated on the Plan page.
    onboardPlanForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const prefs = {
            days_per_week: Number($('#pacey-onboard-pref-days').value) || 3,
            intensity: $('#pacey-onboard-pref-intensity').value || 'moderate',
            distance_adj: DISTANCE_ADJ[Number($('#pacey-onboard-pref-distance').value)] || 'keep',
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
            avatarEl.innerHTML = `<img src="${profileImageUrl}" alt="${displayName || 'Runner'}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/><span class="pacey-avatar-initials" style="display:none">${getInitials(displayName)}</span>`;
        } else {
            // No profile image — show initials (or runner icon in demo mode)
            const initials = getInitials(displayName);
            if (initials && !window.__demoMode) {
                avatarEl.innerHTML = `<span class="pacey-avatar-initials">${initials}</span>`;
            } else {
                // Demo mode or no name — use the Lucide "user" icon as the
                // profile placeholder (cleaner than a hand-drawn runner figure)
                avatarEl.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
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
        const demoCta = $('#pacey-demo-cta');
        if (demoCta) demoCta.hidden = !window.__demoMode;

        // Load race goal from localStorage if not already set
        if (!raceGoal) {
            const saved = localStorage.getItem('pacey_race_goal');
            if (saved) {
                try { raceGoal = JSON.parse(saved); } catch (e) {}
            }
        }
        if (raceGoal) {
            sidebarGoalEl.textContent = `${goalTypeLabel(raceGoal)} - ${raceGoal.time_target}`;
            renderGoalSpecifics(raceGoal);
            renderRaceDetail(raceGoal);
            // Post-race the readiness elements give way to the recap. Applied here
            // as well as from loadAISummary so demo mode and the session-restore
            // path — neither of which reaches the AI fetch — land in the same mode.
            applyRaceRecapMode(postRaceState(raceGoal, fullActivitiesLoaded), raceGoal);
        }
        // The course is titled after the race goal, and a cached course is
        // restored before the goal is known — re-title it now.
        if (courseRecord) updateCourseHead();
        // The board was hidden when the map was built, so re-measure it now
        // that it has a real size.
        requestAnimationFrame(resizeCourseMap);

        loadAllData(forceAIRefresh);
        // Pull any course stored against this account (cross-device). No-op
        // when a local copy already exists or the user is signed out.
        loadCourseRemote();
        // If the user landed directly on the Plan page, kick off its load too
        if (getPageFromHash() === 'plan') openPlanPage();

        // Re-position the sidebar/tab indicators now that the dashboard is
        // visible. On initial page load, navigateTo() runs before the
        // dashboard screen is unhidden, so getBoundingClientRect() returns
        // zeros and the indicator is invisible until the next page change.
        // Calling it here ensures the active nav highlight appears immediately.
        requestAnimationFrame(() => positionIndicators());
    }

    // Standard race distances in km, used to turn the race type picked in the
    // two forms into a number. Everything outside those forms works in distance
    // rather than type, so this table is the only place the type names live.
    //
    // Ultra and Triathlon are deliberately absent from the pickers — their
    // distances vary too much to assume for the runner — but they stay listed
    // here so goals saved before the pickers changed still resolve.
    const RACE_DISTANCE_KM = {
        '5K': 5, '10K': 10, 'Half Marathon': 21.1,
        'Marathon': 42.2, 'Ultra Marathon': 50, 'Triathlon': 40,
    };

    const KM_PER_MILE = 1.609344;

    // Distance in km for a goal, whichever shape it was saved in:
    //   - current: goal.distance is a number, in goal.distance_unit
    //   - legacy:  goal.distance (and goal.purpose) hold a race-type label
    function goalDistanceKm(goal) {
        const n = parseFloat(goal.distance);
        if (isFinite(n) && n > 0) return goal.distance_unit === 'mi' ? n * KM_PER_MILE : n;
        return RACE_DISTANCE_KM[goal.distance] || RACE_DISTANCE_KM[goal.purpose] || 0;
    }

    // The distance as it should read on screen. Always in km, so it agrees with
    // the /km pace shown beside it and with the pace the API sends the plan page
    // — the unit picker on the forms is an input convenience, not a display
    // preference. Rounded to one decimal so a converted 13.1 mi does not read as
    // 21.084096 km.
    function goalDistanceLabel(goal) {
        const km = goalDistanceKm(goal);
        if (km > 0) return `${Math.round(km * 10) / 10} km`;
        return goal.distance || goal.purpose || '';
    }

    // The sidebar and the settings panel name the race by its TYPE ("Half
    // Marathon") rather than a bare distance, because that is what the runner
    // recognises at a glance — a number needs reading, the type does not.
    // "Custom" is a picker value rather than a race type, so it falls through to
    // the distance the runner actually entered instead of showing the word.
    function goalTypeLabel(goal) {
        const type = goal.purpose;
        if (type && type !== 'Custom') return type;
        return goalDistanceLabel(goal) || '';
    }

    // How far the race run's distance may sit from the goal and still count as
    // the race itself. GPS-measured courses read 1-3% long routinely (a marathon
    // logs 42.4-42.6 km), so exact equality would never fire; 5% accepts a
    // properly measured course while still rejecting a short shakeout run on the
    // same morning.
    const RACE_DISTANCE_TOLERANCE = 0.05;

    // The goal's target time in seconds, from H:MM:SS or MM:SS.
    function goalTargetSeconds(goal) {
        if (!goal || !goal.time_target) return 0;
        const parts = String(goal.time_target).split(':').map(Number);
        let totalSec = 0;
        if (parts.length === 3) totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1];
        return totalSec > 0 ? totalSec : 0;
    }

    // Local YYYY-MM-DD. toISOString() is UTC, which would put a runner in UTC+8
    // on the previous day for the first eight hours of their race morning.
    function localDateIso(d = new Date()) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // A race finish time as H:MM:SS (MM:SS under an hour), which is how runners
    // read a result — not the "1h 58m" shape formatDuration uses for the
    // activity list, where the seconds are noise.
    function formatFinishTime(totalSeconds) {
        const sec = Math.max(0, Math.round(totalSeconds));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const mm = String(m).padStart(2, '0');
        const ss = String(s).padStart(2, '0');
        return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
    }

    // The run that was the race: on race day, a running activity, within the
    // distance tolerance of the goal. Deliberately no date window — a watch that
    // syncs late, or a runner who uploads afterwards, does not move the race to
    // another day, and the runner's own race-day upload is authoritative.
    function findRaceActivity(goal, activities) {
        if (!goal || !goal.race_date || !Array.isArray(activities)) return null;
        const goalKm = goalDistanceKm(goal);
        if (!(goalKm > 0)) return null;
        const raceDay = String(goal.race_date).slice(0, 10);
        const tolerance = goalKm * RACE_DISTANCE_TOLERANCE;
        return activities.find(a => {
            if (!isRunningActivity(a)) return false;
            if (String(a.start_time || '').slice(0, 10) !== raceDay) return false;
            const km = parseFloat(a.distance);
            return isFinite(km) && Math.abs(km - goalKm) <= tolerance;
        }) || null;
    }

    // Normalise a slim activity into the race-result shape we persist, so a
    // linked result and a matched one are interchangeable downstream.
    function raceResultFromActivity(a) {
        return {
            activity_id: a.id || null,
            date: String(a.start_time || '').slice(0, 10),
            distance_km: parseFloat(a.distance) || 0,
            duration_min: parseFloat(a.duration) || 0,
            avg_pace_ms: parseFloat(a.avg_pace) || 0,
            avg_hr: a.avg_hr || null,
            elevation_gain: a.elevation_gain || 0,
            source: 'garmin',
            linked_at: new Date().toISOString(),
        };
    }

    // Where the goal sits relative to today. Post-race is a distinct mode: the
    // readiness analysis scores six areas of fitness against a race that has
    // already happened, so the radar, the six areas and the Big Picture are
    // replaced by the race recap.
    //
    //   detected — we have a result, either linked by the runner or matched from
    //              the activity list. False after race day means "ask them".
    //   achieved — finish time at or under the target; null when there is no
    //              target to compare against.
    function postRaceState(goal, activities) {
        if (!goal || !goal.race_date) return { isPostRace: false };
        const raceDay = String(goal.race_date).slice(0, 10);
        const today = localDateIso();
        if (raceDay > today) return { isPostRace: false };
        // Race day itself counts only once the race has been run. A matching run
        // dated race day is proof it is over — nobody logs their goal distance on
        // race morning by accident — and until then the countdown is still the
        // right thing to show, because race morning is when it matters most.
        if (raceDay === today) {
            const done = (goal.race_result && goal.race_result.date === raceDay)
                || !!findRaceActivity(goal, activities);
            if (!done) return { isPostRace: false };
        }

        // A persisted result wins. It is what the runner explicitly linked, and
        // it survives the activity ageing out of the cached first page.
        let result = goal.race_result || null;
        if (!result) {
            const matched = findRaceActivity(goal, activities);
            if (matched) result = raceResultFromActivity(matched);
        }
        if (!result) {
            // Before the activity fetch lands, "no run matched" and "no data yet"
            // are the same state — reporting the first would ask the runner a
            // question the data may already answer. `pending` lets the caller hold
            // the recap back instead of flashing a prompt it has to retract.
            return { isPostRace: true, detected: false, pending: !activitiesLoaded, raceResult: null };
        }

        const targetSec = goalTargetSeconds(goal);
        const finishSec = Math.round((result.duration_min || 0) * 60);
        const comparable = targetSec > 0 && finishSec > 0;
        return {
            isPostRace: true,
            detected: true,
            raceResult: result,
            achieved: comparable ? finishSec <= targetSec : null,
            deltaSeconds: comparable ? finishSec - targetSec : null,
        };
    }

    // =========================================================================
    // Race Recap (post-race mode)
    // =========================================================================
    //
    // Once race day passes the readiness analysis has nothing left to measure:
    // the six areas score fitness toward a race that has already happened, and
    // the countdown counts nothing. In its place the overview and the readiness
    // page show the result — or, when no run could be matched, ask the runner
    // to link one.
    //
    // The figures here are arithmetic, not AI. Only the written paragraph comes
    // from the backend's race-recap action, so the numbers appear instantly and
    // the prose fills in when it arrives.

    // Average pace in min/km from a stored m/s figure.
    function paceFromMs(ms) {
        if (!(ms > 0)) return '';
        const paceSec = Math.round(1000 / ms);
        return `${Math.floor(paceSec / 60)}:${String(paceSec % 60).padStart(2, '0')}`;
    }

    // The goal's own facts, kept after the race because they are what the result
    // is read against — a finish time means nothing without the target it was
    // chasing, and the recap replaces the card that used to carry them.
    //
    // The race name is deliberately absent: it is the recap's heading, and
    // printing it again as a labelled row below itself would just be repetition.
    function raceGoalFacts(goal) {
        const facts = [];
        if (goal.race_date) {
            facts.push({
                label: 'Date',
                value: new Date(goal.race_date + 'T00:00:00')
                    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            });
        }
        const distance = goalDistanceLabel(goal);
        if (distance) facts.push({ label: 'Distance', value: distance });
        // The target time and the target pace are separate figures to a runner —
        // one is the goal, the other is what it demands per kilometre — so they
        // get their own labels rather than sharing one row.
        if (goal.time_target) {
            facts.push({ label: 'Target time', value: goal.time_target });
            const pace = goalPacePerKm(goal);
            if (pace) facts.push({ label: 'Target pace', value: `${pace} /km` });
        }
        return facts;
    }

    // The figures the run produced, in the order a runner reads them. Distance
    // is deliberately absent: the goal group already carries the race distance,
    // and printing the GPS-measured one beside it reads as a discrepancy rather
    // than as information.
    function raceRecapStats(state) {
        const r = state.raceResult || {};
        const finishSec = Math.round((r.duration_min || 0) * 60);
        const stats = [];
        if (finishSec) stats.push({ label: 'Finish time', value: formatFinishTime(finishSec) });
        const pace = paceFromMs(r.avg_pace_ms);
        if (pace) stats.push({ label: 'Average pace', value: `${pace} /km` });
        if (r.avg_hr) stats.push({ label: 'Average HR', value: `${r.avg_hr} bpm` });
        if (r.elevation_gain) stats.push({ label: 'Elevation gain', value: `${Math.round(r.elevation_gain)} m` });
        return stats;
    }

    // The delta against the target, phrased the way a runner would say it. A
    // margin under a minute is not worth a sentence — it reads as noise.
    function raceVerdict(state) {
        if (state.deltaSeconds === null || state.achieved === null) return '';
        const d = Math.abs(state.deltaSeconds);
        if (d < 60) return 'Goal achieved';
        return state.achieved
            ? `Goal achieved — ${formatFinishTime(d)} under target`
            : `Missed target by ${formatFinishTime(d)}`;
    }

    // One recap, rendered in two places: the overview's goal section (which it
    // replaces outright) and the whole Readiness page. Both get the same markup
    // so the two can never report different numbers.
    function raceRecapHtml(state, goal) {
        if (!state.detected) {
            return `
                <p class="pacey-race-recap-question">Did you run the race?</p>
                <p class="pacey-race-recap-note">We couldn't find a run on race day that matches your goal distance.</p>
                <button class="pacey-btn pacey-btn-primary pacey-race-recap-link-btn" type="button" data-recap-action="link">Link your race</button>
            `;
        }
        const r = state.raceResult || {};
        const verdict = raceVerdict(state);

        // One labelled block per question: what the runner set out to do, and
        // what they actually did. Keeping them apart is the point — the gap
        // between the two is the story the recap tells.
        const group = (label, facts) => facts.length ? `
            <div class="pacey-race-recap-group">
                <span class="pacey-race-recap-group-label">${label}</span>
                <div class="pacey-race-recap-stats">${facts.map(s => `
                    <div class="pacey-race-recap-stat">
                        <span class="pacey-race-recap-stat-label">${escapeHtml(s.label)}</span>
                        <span class="pacey-race-recap-stat-value">${escapeHtml(s.value)}</span>
                    </div>`).join('')}
                </div>
            </div>` : '';

        // Reading order: which race it was, then how it went, then the figures,
        // then the coach's prose. The course preview takes the top-right corner
        // beside the race name — it is what the runner raced, so it belongs with
        // the identity of the race rather than buried among the numbers.
        return `
            <div class="pacey-race-recap-top">
                <div class="pacey-race-recap-id">
                    <span class="pacey-race-recap-name">${escapeHtml(goal.race_name || goalTypeLabel(goal) || 'Your race')}</span>
                    ${verdict ? `<span class="pacey-race-recap-verdict${state.achieved ? ' is-achieved' : ''}">${escapeHtml(verdict)}</span>` : ''}
                </div>
                <!-- The course preview is moved in here from the goal card by
                     placeGoalMapNote() — it holds a live map, so it cannot be
                     duplicated and has to be relocated rather than rebuilt. -->
                <div class="pacey-race-recap-map" data-recap-map></div>
            </div>
            <!-- Goal and result sit side by side so the comparison is direct —
                 what was set against what was run. Each is its own panel, so
                 eight figures read as two answers rather than one list. -->
            <div class="pacey-race-recap-figures">
                ${group('The goal', raceGoalFacts(goal))}
                ${group('The result', raceRecapStats(state))}
            </div>
            <!-- The coach's read closes the recap: it is the only prose here, and
                 it reads as the last word rather than as an introduction. Filled
                 by loadRaceRecapProse(). -->
            <div class="pacey-race-recap-read">
                <span class="pacey-race-recap-group-label">The coach's read</span>
                <!-- The placeholder is the paragraph's own shape rather than a
                     label: a few full lines and a short last one, so the block
                     does not change height when the prose lands. -->
                <div class="pacey-race-recap-prose" data-recap-prose>
                    <div class="pacey-race-recap-prose-skeleton">
                        <div class="pacey-skeleton-line"></div>
                        <div class="pacey-skeleton-line"></div>
                        <div class="pacey-skeleton-line"></div>
                        <div class="pacey-skeleton-line"></div>
                        <div class="pacey-skeleton-line pacey-skeleton-line--short"></div>
                    </div>
                </div>
            </div>
            <div class="pacey-race-recap-actions">
                <!-- The six-area analysis gives way to the recap post-race, so
                     this keeps it reachable: it opens the readiness that stood
                     before the race, frozen on the goal on race day. -->
                <button class="pacey-btn pacey-btn-secondary" type="button" data-recap-action="review-readiness">Review race readiness</button>
                <button class="pacey-btn pacey-btn-secondary" type="button" data-recap-action="new-goal">Set a new goal</button>
            </div>
        `;
    }

    // Put the overview and the readiness page into post-race mode, or back out of
    // it. Driven from one place so the two pages cannot disagree about which mode
    // they are in — the elements they swap are the same ones the readiness
    // analysis fills, so this has to run before that analysis renders.
    function applyRaceRecapMode(state, goal) {
        const post = !!(state && state.isPostRace);
        // The readiness elements give way as soon as race day passes — there is
        // nothing left for them to measure. The recap itself waits for the
        // activity fetch, so it never shows a prompt it may have to retract.
        const showRecap = post && !state.pending;
        const recapHtml = showRecap ? raceRecapHtml(state, goal) : '';

        // Both recap containers are rebuilt below. The course preview holds a live
        // map, so it would be destroyed if it happened to be inside one — it is
        // moved home first and re-placed at the end.
        const note = $('#pacey-goal-map-note');
        const mapHome = $('#pacey-goal-map-home');
        if (note && mapHome && note.parentElement !== mapHome) mapHome.appendChild(note);

        // --- Overview: one section replaces both cards ---
        const goalRow = $('#pacey-goal-row');
        if (goalRow) goalRow.hidden = post;
        const goalTitle = $('#pacey-goal-section-title');
        if (goalTitle) goalTitle.textContent = post ? 'Race Recap' : 'Race Goal & Readiness';
        const overviewRecap = $('#pacey-overview-recap');
        if (overviewRecap) {
            overviewRecap.innerHTML = recapHtml;
            overviewRecap.hidden = !showRecap;
        }
        // The six-area verdict and the pillars are what the recap replaces.
        // Only ever hidden here — renderOverallInsight decides their pre-race
        // visibility, and forcing it back would race with the AI fetch.
        if (post) {
            const overallInsight = $('#pacey-overall-insight');
            if (overallInsight) overallInsight.hidden = true;
            const overallSkeleton = $('#pacey-overall-insight-skeleton');
            if (overallSkeleton) overallSkeleton.hidden = true;
        }
        // The Big Picture is the six-area verdict in prose, so it goes with them.
        const bigPicture = $('#pacey-big-picture-section');
        if (bigPicture) bigPicture.hidden = post;
        const pillarsSection = $('#pacey-overview-pillars-section');
        if (pillarsSection) pillarsSection.hidden = post;

        // --- Readiness page: the whole analysis becomes the recap ---
        const readinessTitle = $('#pacey-readiness-title');
        if (readinessTitle) readinessTitle.textContent = post ? 'Recap' : 'Race Readiness';
        const readinessSub = $('#pacey-readiness-sub');
        if (readinessSub) {
            if (!readinessSub.dataset.defaultHtml) readinessSub.dataset.defaultHtml = readinessSub.innerHTML;
            readinessSub.innerHTML = post
                ? 'How the race went, and what comes next.'
                : readinessSub.dataset.defaultHtml;
        }
        // The six-dimension explainer has nothing to explain once the six areas
        // are gone; the summary mark takes its place beside the title.
        const dimensionBtn = $('#pacey-dimension-info-btn');
        if (dimensionBtn) dimensionBtn.hidden = post;
        const recapMark = $('#pacey-recap-mark');
        if (recapMark) recapMark.hidden = !post;
        // The "last analysed" stamp belongs to the six-area analysis, not the recap.
        const readinessUpdated = $('#pacey-readiness-updated');
        if (readinessUpdated && post) readinessUpdated.hidden = true;
        const readinessRecap = $('#pacey-readiness-recap');
        if (readinessRecap) {
            readinessRecap.innerHTML = recapHtml;
            readinessRecap.hidden = !showRecap;
        }
        const readinessAnalysis = $('#pacey-readiness-analysis');
        if (readinessAnalysis) readinessAnalysis.hidden = post;

        // The nav points at the same page under both names, so its glyph and
        // label follow the mode rather than being fixed to one of them — a tab
        // reading "Readiness" that opens a recap would be a lie. Both glyphs are
        // stroked sketchyicons shapes on the same 24-unit grid, so they share the
        // nav's weight rule and swap cleanly.
        const navLabel = $('#pacey-nav-readiness-label');
        if (navLabel) navLabel.textContent = post ? 'Recap' : 'Readiness';
        ['#pacey-nav-readiness-icon', '#pacey-tab-readiness-icon'].forEach((sel) => {
            const use = document.querySelector(`${sel} use`);
            if (use) use.setAttribute('href', post ? '#pacey-icon-recap' : '#pacey-icon-readiness');
        });

        // Finally, put the course preview in whichever recap is on screen.
        placeGoalMapNote(showRecap);
    }

    /**
     * Move the course preview into the recap, or back into the goal card.
     *
     * The preview holds a live MapLibre instance, so there is exactly one of it
     * and it cannot be shown in two places. Only one page is ever visible, so
     * relocating the node is the honest way to do this rather than a compromise —
     * and courseEls() re-queries the DOM on every call, so the map code follows
     * it without knowing it moved.
     */
    function placeGoalMapNote(useRecapHost) {
        const note = $('#pacey-goal-map-note');
        const home = $('#pacey-goal-map-home');
        if (!note || !home) return;

        let host = home;
        if (useRecapHost) {
            // Whichever recap sits on a visible page. Array.from because $$ is
            // querySelectorAll — a NodeList has forEach but no filter.
            const recaps = Array.from($$('[data-recap-map]')).filter((el) => {
                const page = el.closest('.pacey-page');
                return !page || !page.hidden;
            });
            if (recaps.length) host = recaps[0];
        }
        if (note.parentElement === host) return;

        const moved = host !== home;
        host.appendChild(note);
        note.classList.toggle('pacey-goal-map-note--recap', moved);
        // The map measures its container, so it has to be told the box changed.
        // layoutGoalNote re-runs the note's own sizing and position.
        requestAnimationFrame(() => {
            layoutGoalNote();
            resizeCourseMap();
        });
    }

    // The written recap, cached in localStorage against the result it describes.
    // Keyed on the result rather than the goal so linking a different run
    // regenerates, and so a stale paragraph cannot follow a corrected time.
    const RACE_RECAP_CACHE_KEY = 'pacey_race_recap_v1';

    // Shown in place of the coach's read when it cannot be written. Deliberately
    // plain and short: the result figures beside it are the substance, so this
    // only has to say why the paragraph is missing rather than apologise at length.
    const RACE_RECAP_UNAVAILABLE = "The coach's read isn't available right now.";

    function raceRecapCacheKey(state) {
        const r = state.raceResult || {};
        return `${r.date || ''}|${r.duration_min || ''}|${r.distance_km || ''}`;
    }

    function readRaceRecapCache(state) {
        try {
            const raw = localStorage.getItem(RACE_RECAP_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && parsed.key === raceRecapCacheKey(state) ? parsed.text : null;
        } catch (err) {
            return null;
        }
    }

    function writeRaceRecapCache(state, text) {
        try {
            localStorage.setItem(RACE_RECAP_CACHE_KEY, JSON.stringify({
                key: raceRecapCacheKey(state),
                text,
            }));
        } catch (err) {
            // Quota or private mode — the recap simply regenerates next time.
        }
    }

    // Fill the recap paragraph. Both the overview and the readiness page carry a
    // [data-recap-prose] container, so one fetch fills whichever is on screen.
    //
    // The container starts with a placeholder rather than being hidden, because
    // the coach's read is a labelled part of the recap — leaving it out entirely
    // made the whole thing read as a results table. So every exit path here has
    // to replace that placeholder, including the failure one.
    async function loadRaceRecapProse(state, goal) {
        if (!state.detected) return;
        const targets = $$('[data-recap-prose]');
        if (!targets.length) return;

        const setText = (text) => targets.forEach(el => { el.textContent = text; });

        // The server keeps the paragraph on the goal, so a second device already
        // has it: check-session hands the goal over with the recap attached. This
        // is the copy that survives a cleared browser, and it is checked before
        // the local cache for that reason.
        //
        // The key is verified rather than trusted — a goal can arrive carrying a
        // recap written for a run that has since been re-linked, and showing the
        // old paragraph for the new result would be worse than showing nothing.
        const fromGoal = goal && goal.race_recap;
        if (fromGoal && fromGoal.text && fromGoal.key === raceRecapCacheKey(state)) {
            // Warm the local copy on the way through, so a later load that cannot
            // reach the server still renders the paragraph.
            writeRaceRecapCache(state, fromGoal.text);
            setText(fromGoal.text);
            return;
        }

        const cached = readRaceRecapCache(state);
        if (cached) {
            setText(cached);
            return;
        }

        // Demo mode has no server to write the paragraph, so the showcase uses a
        // fixed one — the rest of the demo's AI content is mocked the same way.
        if (window.__demoMode) {
            setText(getMockRaceRecap());
            return;
        }

        try {
            const resp = await apiCall('POST', 'coach-plan', {
                action: 'race-recap',
                race_result: state.raceResult,
            });
            const data = await resp.json();
            if (!resp.ok || !data.recap) {
                setText(RACE_RECAP_UNAVAILABLE);
                return;
            }
            writeRaceRecapCache(state, data.recap);
            setText(data.recap);
            // The server stored this paragraph on the goal; mirror it locally so
            // a re-render — a theme change, a page switch — reads it without a
            // second call, and so it survives a reload.
            if (raceGoal && !data.cached) {
                raceGoal.race_recap = { text: data.recap, key: raceRecapCacheKey(state) };
                try {
                    localStorage.setItem('pacey_race_goal', JSON.stringify(raceGoal));
                } catch (err) {
                    // Quota or private mode — the server copy is the durable one.
                }
            }
        } catch (err) {
            // The figures stand on their own, so this is not worth an alert — but
            // it should not leave the block shimmering forever either.
            console.warn('Race recap unavailable:', err);
            setText(RACE_RECAP_UNAVAILABLE);
        }
    }

    // =========================================================================
    // Linking a race result
    // =========================================================================
    //
    // Reached from the recap when no run matched the goal: the runner points at
    // the right activity, or uploads the GPX for a run that never reached
    // Garmin. Either way the result is theirs rather than an inference from a
    // date, and it is attached to the goal so it survives the activity ageing
    // out of the cached first page — and reaches their other devices through the
    // existing goal sync.

    // Attach a result to the goal, locally and on the server, then re-render the
    // recap in place. The local copy is written first so the UI is correct even
    // if the sync fails.
    async function saveRaceResult(result) {
        if (!raceGoal) return;
        if (result) raceGoal.race_result = result;
        else delete raceGoal.race_result;
        // The stored paragraph describes the old result, so it goes with it. The
        // key check in loadRaceRecapProse would catch the mismatch anyway, but
        // dropping it here keeps the local goal honest rather than carrying a
        // recap nothing matches.
        delete raceGoal.race_recap;
        try {
            localStorage.setItem('pacey_race_goal', JSON.stringify(raceGoal));
            localStorage.removeItem(RACE_RECAP_CACHE_KEY);
        } catch (err) {
            // Quota or private mode — the server copy below is the durable one.
        }

        const state = postRaceState(raceGoal, fullActivitiesLoaded);
        renderGoalSpecifics(raceGoal);
        applyRaceRecapMode(state, raceGoal);
        loadRaceRecapProse(state, raceGoal);

        if (window.__demoMode) return;
        try {
            await apiCall('POST', 'coach-plan', { action: 'race-result', race_result: result });
        } catch (err) {
            // Offline — the local copy stands and the next link retries.
        }
    }

    // Keep a finished race when the runner moves on to a new goal. The goal is
    // overwritten on every save, so without this the result would vanish the
    // moment they set the next target — and the race they just ran is exactly
    // what they would want to look back at.
    const RACE_HISTORY_KEY = 'pacey_race_history_v1';

    function fileRaceResultToHistory(goal) {
        if (!goal || !goal.race_result) return;
        try {
            const raw = localStorage.getItem(RACE_HISTORY_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            const history = Array.isArray(parsed) ? parsed : [];
            const entry = {
                ...goal.race_result,
                race_name: goal.race_name || goal.purpose || '',
                time_target: goal.time_target || '',
            };
            // Keyed on date + finish time so re-saving an unchanged goal does not
            // stack duplicates.
            const key = `${entry.date}|${entry.duration_min}`;
            if (!history.some(h => `${h.date}|${h.duration_min}` === key)) {
                history.push(entry);
                localStorage.setItem(RACE_HISTORY_KEY, JSON.stringify(history));
            }
        } catch (err) {
            // Quota or private mode — the recap simply does not carry forward.
        }
    }

    // Candidate runs for the manual link: running activities within a week of
    // race day, whether or not they matched the distance. The point of this
    // screen is that the automatic match found nothing, so it deliberately does
    // not pre-filter by distance — it flags a close one instead.
    function raceLinkCandidates(goal) {
        if (!goal || !goal.race_date) return [];
        const raceMs = new Date(String(goal.race_date).slice(0, 10) + 'T00:00:00').getTime();
        const dayMs = 86400000;
        const dayOf = (a) => new Date(String(a.start_time || '').slice(0, 10) + 'T00:00:00').getTime();
        return fullActivitiesLoaded
            .filter(a => {
                if (!isRunningActivity(a) || !a.start_time) return false;
                const t = dayOf(a);
                return isFinite(t) && Math.abs(t - raceMs) <= 7 * dayMs;
            })
            .sort((a, b) => {
                // Nearest to race day first, then longest — the race is both.
                const da = Math.abs(dayOf(a) - raceMs);
                const db = Math.abs(dayOf(b) - raceMs);
                return da !== db ? da - db : (b.distance || 0) - (a.distance || 0);
            });
    }

    function openLinkRaceModal() {
        const modal = $('#pacey-link-race-modal');
        const list = $('#pacey-link-race-list');
        if (!modal || !list) return;

        const goalKm = raceGoal ? goalDistanceKm(raceGoal) : 0;
        const candidates = raceLinkCandidates(raceGoal);

        if (!candidates.length) {
            list.innerHTML = '<p class="pacey-link-race-empty">No runs from that week are loaded. Upload the GPX below, or open Activities and load more first.</p>';
        } else {
            list.innerHTML = candidates.map(a => {
                const km = parseFloat(a.distance) || 0;
                // Flagged, not filtered — the runner decides, but the goal
                // distance is the likeliest one so it should not need hunting for.
                const near = goalKm > 0 && Math.abs(km - goalKm) <= goalKm * RACE_DISTANCE_TOLERANCE;
                const date = a.start_time ? parseDate(a.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
                return `
                    <button class="pacey-link-race-item${near ? ' is-near' : ''}" type="button" data-link-index="${fullActivitiesLoaded.indexOf(a)}">
                        <span class="pacey-link-race-item-date">${escapeHtml(date)}</span>
                        <span class="pacey-link-race-item-name">${escapeHtml(a.name || 'Run')}</span>
                        <span class="pacey-link-race-item-meta">${km ? `${Math.round(km * 10) / 10} km` : '—'} · ${formatDuration(a.duration)}</span>
                    </button>`;
            }).join('');
        }

        const status = $('#pacey-link-race-status');
        if (status) status.hidden = true;
        modal.hidden = false;
    }

    function closeLinkRaceModal() {
        const modal = $('#pacey-link-race-modal');
        if (modal) modal.hidden = true;
    }

    // A run recorded on something that never reached Garmin. Parsed in the
    // browser with the same parser as the course card, and the finish time is
    // taken from the first and last trackpoint timestamps.
    async function linkRaceFromGpx(file) {
        const status = $('#pacey-link-race-status');
        const setStatus = (msg) => {
            if (!status) return;
            status.textContent = msg;
            status.hidden = !msg;
        };
        if (!file || !window.PaceyCourse) return;
        if (file.size > COURSE_MAX_BYTES) {
            setStatus('That file is too large to read.');
            return;
        }

        setStatus('Reading the file…');
        try {
            const parsed = PaceyCourse.parseGpx(await file.text());
            if (!parsed.points || parsed.points.length < 2) {
                setStatus('That file has no track points we can read.');
                return;
            }
            // computeCourse takes the point list, not the parse result.
            const course = PaceyCourse.computeCourse(parsed.points);
            const times = parsed.points.map(p => p.time).filter(Boolean);
            const startMs = times.length ? Date.parse(times[0]) : NaN;
            const endMs = times.length ? Date.parse(times[times.length - 1]) : NaN;
            const durationMin = isFinite(startMs) && isFinite(endMs) && endMs > startMs
                ? (endMs - startMs) / 60000
                : 0;
            if (!durationMin) {
                setStatus('That file has no timestamps, so we cannot read a finish time from it.');
                return;
            }

            const distanceKm = course.distanceKm || 0;
            await saveRaceResult({
                activity_id: null,
                date: times.length ? String(times[0]).slice(0, 10) : localDateIso(),
                distance_km: distanceKm,
                duration_min: durationMin,
                avg_pace_ms: distanceKm > 0 ? (distanceKm * 1000) / (durationMin * 60) : 0,
                avg_hr: null,
                elevation_gain: course.gainM || 0,
                source: 'gpx',
                linked_at: new Date().toISOString(),
            });
            closeLinkRaceModal();
        } catch (err) {
            setStatus('We could not read that file.');
        }
    }

    // =========================================================================
    // Readiness review modal
    // =========================================================================
    //
    // Post-race the six-area analysis gives way to the recap on both pages, so
    // this is the only way back to it. The data is the snapshot the server froze
    // onto the goal on race day (`race_readiness`), which survives the AI cache
    // expiring; the local AI cache is the fallback for goals saved before the
    // snapshot existed.

    // The pre-race analysis to show, or null when there is nothing to review.
    // Shape matches the AI radar payload: { dimensions, overall }.
    function readinessReviewData() {
        const snapshot = raceGoal && raceGoal.race_readiness;
        const snapData = (snapshot || {}).data || {};
        if ((snapData.dimensions || []).length) {
            return { data: snapData, generatedAt: snapshot.generated_at || snapData.generated_at || '' };
        }
        // Demo mode has no server snapshot, so it reviews the same mocks the rest
        // of the demo's readiness content is built from.
        if (window.__demoMode) {
            return { data: { dimensions: getMockPillars().dimensions, overall: getMockOverallInsight() }, generatedAt: '' };
        }
        const cached = readAICache();
        if (cached && (cached.dimensions || []).length) {
            return { data: cached, generatedAt: cached.generated_at || '' };
        }
        return null;
    }

    // The date the analysis was written, as a short "Aug 30". Empty when the
    // timestamp is missing or unparseable, so the line simply omits it.
    function formatReviewDate(iso) {
        const d = iso ? new Date(iso) : null;
        if (!d || isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    // A radar chart built for the modal, kept out of radarCharts so a page
    // re-render can never tear it down. Destroyed when the modal closes.
    let reviewRadarChart = null;

    function openReadinessReviewModal() {
        const modal = $('#pacey-readiness-review-modal');
        if (!modal) return;

        const review = readinessReviewData();
        const empty = $('#pacey-readiness-review-empty');
        const radarWrap = modal.querySelector('.pacey-readiness-review-radar');
        const overallEl = $('#pacey-readiness-review-overall');
        const pillarsEl = $('#pacey-readiness-review-pillars');
        const whenEl = $('#pacey-readiness-review-when');

        if (!review) {
            // Nothing to show — say so plainly rather than opening an empty card.
            if (empty) empty.hidden = false;
            if (radarWrap) radarWrap.hidden = true;
            if (overallEl) { overallEl.hidden = true; overallEl.innerHTML = ''; }
            if (pillarsEl) { pillarsEl.hidden = true; pillarsEl.innerHTML = ''; }
            if (whenEl) whenEl.textContent = '';
            modal.hidden = false;
            return;
        }

        if (empty) empty.hidden = true;
        if (radarWrap) radarWrap.hidden = false;
        // The CTA is dropped here: it points at the readiness page, which now
        // shows the recap rather than the analysis.
        if (overallEl) { overallEl.hidden = false; overallEl.innerHTML = overallInsightHtml(review.data.overall || {}, false); }
        if (pillarsEl) { pillarsEl.hidden = false; pillarsEl.innerHTML = pillarInsightsHtml(review.data.dimensions || []); }
        // The intro line carries the analysis date when we have one.
        const dateStr = formatReviewDate(review.generatedAt);
        if (whenEl) whenEl.textContent = dateStr ? `, analysed ${dateStr}` : '';

        modal.hidden = false;

        // The radar needs a laid-out canvas, so it is built after the modal is
        // visible — a hidden canvas measures 0x0 and would draw NaN coordinates.
        if (reviewRadarChart) { reviewRadarChart.destroy(); reviewRadarChart = null; }
        const canvas = modal.querySelector('.pacey-readiness-review-canvas');
        if (canvas) reviewRadarChart = buildRadarChart(canvas, radarValuesFromData(review.data));
    }

    function closeReadinessReviewModal() {
        const modal = $('#pacey-readiness-review-modal');
        if (modal) modal.hidden = true;
        // Free the chart; the canvas is rebuilt on the next open.
        if (reviewRadarChart) { reviewRadarChart.destroy(); reviewRadarChart = null; }
    }

    // Wiring — the recap blocks are re-rendered on every mode change, so the
    // buttons are handled by delegation rather than bound per render.
    (function bindRaceRecapControls() {
        document.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('[data-recap-action]');
            if (actionBtn) {
                const action = actionBtn.getAttribute('data-recap-action');
                if (action === 'link') openLinkRaceModal();
                if (action === 'new-goal') openEditGoalPopup();
                if (action === 'review-readiness') openReadinessReviewModal();
                return;
            }
            // A candidate run in the link modal — the index points back into the
            // loaded list, so the result carries the activity's own figures.
            const item = e.target.closest('[data-link-index]');
            if (item) {
                const activity = fullActivitiesLoaded[Number(item.getAttribute('data-link-index'))];
                if (activity) {
                    saveRaceResult(raceResultFromActivity(activity));
                    closeLinkRaceModal();
                }
            }
        });

        const closeBtn = $('#pacey-link-race-close');
        if (closeBtn) closeBtn.addEventListener('click', closeLinkRaceModal);
        const modal = $('#pacey-link-race-modal');
        if (modal) {
            modal.addEventListener('click', (e) => { if (e.target === modal) closeLinkRaceModal(); });
        }
        const skipBtn = $('#pacey-link-race-skip');
        if (skipBtn) skipBtn.addEventListener('click', () => { closeLinkRaceModal(); openEditGoalPopup(); });
        const fileInput = $('#pacey-link-race-file');
        if (fileInput) {
            fileInput.addEventListener('change', () => {
                const file = fileInput.files && fileInput.files[0];
                // Reset so re-picking the same file fires change again.
                fileInput.value = '';
                if (file) linkRaceFromGpx(file);
            });
        }

        // Readiness review modal — close button and backdrop, the same pattern
        // as the link-race modal above.
        const reviewClose = $('#pacey-readiness-review-close');
        if (reviewClose) reviewClose.addEventListener('click', closeReadinessReviewModal);
        const reviewModal = $('#pacey-readiness-review-modal');
        if (reviewModal) {
            reviewModal.addEventListener('click', (e) => { if (e.target === reviewModal) closeReadinessReviewModal(); });
        }
    })();

    // Turn the two form pickers into the stored pair. The four standard types
    // carry their own distance; "Custom" takes the number and unit the runner
    // typed. Returns null when Custom is picked with no usable number, so the
    // caller fails validation rather than saving a zero distance.
    function formGoalDistance(purposeValue, customValue, customUnit) {
        if (purposeValue === 'Custom') {
            const n = parseFloat(customValue);
            if (!isFinite(n) || n <= 0) return null;
            return { distance: n, distance_unit: customUnit || 'km' };
        }
        const km = RACE_DISTANCE_KM[purposeValue];
        return km ? { distance: km, distance_unit: 'km' } : null;
    }

    // The custom distance field only exists for the "Custom" race type, so it is
    // revealed on demand instead of sitting there for the four standard types.
    function bindCustomDistanceToggle(selectId, fieldId) {
        const select = document.getElementById(selectId);
        const field = document.getElementById(fieldId);
        if (!select || !field) return;
        const sync = () => { field.hidden = select.value !== 'Custom'; };
        select.addEventListener('change', sync);
        sync();
    }

    bindCustomDistanceToggle('pacey-purpose', 'pacey-custom-distance-field');
    bindCustomDistanceToggle('pacey-edit-purpose', 'pacey-edit-custom-distance-field');

    // Target pace as M:SS per km, or '' when the distance or time is missing or
    // unparseable — each caller decides what an absent pace should look like,
    // rather than this having to guess for both of them.
    function goalPacePerKm(goal) {
        const distKm = goalDistanceKm(goal);
        if (!(distKm > 0) || !goal.time_target) return '';
        // Accepts H:MM:SS or MM:SS
        const parts = goal.time_target.split(':').map(Number);
        let totalSec = 0;
        if (parts.length === 3) totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1];
        if (!(totalSec > 0)) return '';
        // Round to whole seconds before splitting. Rounding the remainder on its
        // own can land on 60 and print a pace like "4:60".
        const paceSec = Math.round(totalSec / distKm);
        return `${Math.floor(paceSec / 60)}:${String(paceSec % 60).padStart(2, '0')}`;
    }

    // Race detail on the readiness page — the goal the six scores are measured
    // against, so the radar below has something to be read against before it
    // gives a verdict.
    function renderRaceDetail(goal) {
        const card = $('#pacey-race-detail');
        if (!card) return;
        if (!goal) { card.hidden = true; return; }

        const pace = goalPacePerKm(goal);

        $('#pacey-race-detail-name').textContent = goal.race_name || '—';
        $('#pacey-race-detail-date').textContent = goal.race_date
            ? new Date(goal.race_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '—';
        $('#pacey-race-detail-distance').textContent = goalDistanceLabel(goal) || '—';
        $('#pacey-race-detail-pace').textContent = pace ? `${pace} /km` : '—';

        card.hidden = false;
    }

    // Render the Race Goal panel with key metrics + countdown
    function renderGoalSpecifics(goal) {
        const grid = $('#pacey-goal-specifics-grid');
        if (!grid) return;

        // Compute countdown days to race date. This card is hidden entirely once
        // the race is done — the recap replaces it — so the countdown only ever
        // needs to count forward.
        let countdownValue = '--';
        let countdownLabel = 'days to go';
        if (goal.race_date) {
            const raceDate = new Date(goal.race_date + 'T00:00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const diffMs = raceDate - today;
            const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
            countdownValue = diffDays;
            countdownLabel = diffDays === 1 ? 'day to go' : 'days to go';
        }

        // Derive target pace from race distance + time target
        const targetPace = goalPacePerKm(goal) || '--';

        // Build stat tiles — value and unit render inline on the same line
        // Weekly target removed per design decision; countdown is rendered separately as a highlight
        // Race name is shown first (if set) as a full-width row, then the
        // remaining stats fill the 2-column grid: 1-2-2 layout
        const stats = [
            ...(goal.race_name ? [{ label: 'Race Name', value: goal.race_name, unit: '', fullWidth: true }] : []),
            { label: 'Distance', value: goalDistanceLabel(goal) || '--', unit: '' },
            { label: 'Race Date', value: goal.race_date ? new Date(goal.race_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '--', unit: '' },
            { label: 'Target Time', value: goal.time_target || '--', unit: '' },
            { label: 'Target Pace', value: targetPace, unit: targetPace === '--' ? '' : '/km' },
        ];

        grid.innerHTML = stats.map(s => `
            <div class="pacey-goal-stat${s.fullWidth ? ' pacey-goal-stat--full' : ''}">
                <span class="pacey-goal-stat-label">${s.label}</span>
                <div class="pacey-goal-stat-value-row">
                    <span class="pacey-goal-stat-value">${s.value}</span>
                    ${s.unit ? `<span class="pacey-goal-stat-unit">${s.unit}</span>` : ''}
                </div>
            </div>
        `).join('');

        // Populate the countdown highlight in the top-right corner
        const countdownValueEl = $('#pacey-countdown-value');
        const countdownLabelEl = $('#pacey-countdown-label');
        if (countdownValueEl) countdownValueEl.textContent = countdownValue;
        if (countdownLabelEl) countdownLabelEl.textContent = countdownLabel;

        // The countdown just changed, and the mini note sits under it — so
        // re-measure once that has laid out.
        requestAnimationFrame(layoutGoalNote);
    }

    // =========================================================================
    // Race Course (GPX)
    // =========================================================================
    //
    // Optional GPX upload. The file is parsed entirely in the browser by
    // PaceyCourse (pacey-course.js) — the raw track never leaves the device.
    // Only a distilled record (distance, filtered elevation, a simplified
    // route outline) is persisted and handed to the coach.
    //
    // The course is advisory: it is displayed and informs race-day advice, but
    // it deliberately does not change the goal time or the pace zones.

    const COURSE_CACHE_KEY = 'pacey_course_v1';
    // Larger files freeze the tab while parsing; a real course export is far
    // smaller than this.
    const COURSE_MAX_BYTES = 15 * 1024 * 1024;
    // The route is drawn into a fixed viewBox and scaled by CSS.
    const COURSE_VIEW_W = 300;
    const COURSE_VIEW_H = 200;
    // Points kept for the route trace. A 300x200 box can't resolve more, and
    // it keeps the stored record (local + server) small.
    const COURSE_ROUTE_POINTS = 200;

    let courseRecord = null;   // compact, renderable course record
    let courseChart = null;    // Chart.js elevation-profile instance
    let courseMap = null;      // MapLibre instance for the route map
    let goalMap = null;        // the pinned mini map in the Race Goal card
    let courseMapObserver = null;  // keeps the map canvases matched to their boxes
    let courseInsight = null;  // { text, fingerprint } — the coach's read

    // Resolve the course DOM lazily so a missing card can never throw.
    function courseEls() {
        return {
            card: $('#pacey-course-card'),
            drop: $('#pacey-course-drop'),
            input: $('#pacey-course-input'),
            loaded: $('#pacey-course-loaded'),
            name: $('#pacey-course-name'),
            meta: $('#pacey-course-meta'),
            routeLine: $('#pacey-course-route-line'),
            routeStart: $('#pacey-course-route-start'),
            routeEnd: $('#pacey-course-route-end'),
            map: $('#pacey-course-map'),
            routeSvg: $('#pacey-course-route-svg'),
            goalMapNote: $('#pacey-goal-map-note'),
            goalMap: $('#pacey-goal-map'),
            mapModal: $('#pacey-course-map-modal'),
            mapModalMap: $('#pacey-course-map-modal-map'),
            mapModalTitle: $('#pacey-course-map-modal-title'),
            mapModalClose: $('#pacey-course-map-modal-close'),
            chart: $('#pacey-course-chart'),
            stats: $('#pacey-course-stats'),
            insight: $('#pacey-course-insight'),
            insightText: $('#pacey-course-insight-text'),
            insightLoading: $('#pacey-course-insight-loading'),
            replace: $('#pacey-course-replace'),
            remove: $('#pacey-course-remove'),
            error: $('#pacey-course-error'),
        };
    }

    /** Thin the point list for the route trace (first and last always kept). */
    function downsamplePoints(points, max) {
        const limit = max || COURSE_ROUTE_POINTS;
        if (points.length <= limit) return points;
        const step = points.length / limit;
        const out = [];
        for (let i = 0; i < limit; i++) out.push(points[Math.floor(i * step)]);
        out.push(points[points.length - 1]);
        return out;
    }

    /**
     * Turn a computed course into the compact record we render and store.
     *
     * The record is deliberately self-contained — it carries the projected
     * route path and the downsampled profile, so it renders without the raw
     * track points and stays small enough for localStorage and Redis.
     */
    function makeCourseRecord(course, points, meta) {
        const routePoints = downsamplePoints(points);
        const route = PaceyCourse.buildRoutePath(routePoints, COURSE_VIEW_W, COURSE_VIEW_H, 12);
        return {
            version: 1,
            savedAt: new Date().toISOString(),
            meta: {
                name: meta.name || '',
                fileName: meta.fileName || '',
                hasElevation: !!course.hasElevation,
                source: meta.source || 'track',
                pointCount: course.pointCount,
            },
            stats: {
                distanceKm: PaceyCourse.round(course.distanceKm, 2),
                gainM: course.gainM === null ? null : Math.round(course.gainM),
                lossM: course.lossM === null ? null : Math.round(course.lossM),
                minEleM: course.minEleM === null ? null : Math.round(course.minEleM),
                maxEleM: course.maxEleM === null ? null : Math.round(course.maxEleM),
                avgGradePct: PaceyCourse.round(course.avgGradePct, 1),
                maxGradePct: PaceyCourse.round(course.maxGradePct, 1),
                gainPerKm: PaceyCourse.round(course.gainPerKm, 1),
                difficulty: course.difficulty,
            },
            gradeBuckets: course.gradeBuckets || [],
            profile: course.profile || [],
            route,
            // [longitude, latitude] pairs — the order GeoJSON and MapLibre use,
            // and the OPPOSITE of the GPX's own [lat, lon]. Rounded to ~1 m,
            // which is far tighter than any basemap, and keeps the record small.
            coords: routePoints.map(p => [PaceyCourse.round(p.lon, 5), PaceyCourse.round(p.lat, 5)]),
            aiSummary: PaceyCourse.buildAiSummary(course),
        };
    }

    /**
     * The course is titled after the race goal. The GPX's own <name> is an
     * export artefact ("Morning Run", a timestamp) and the file name is no
     * better, so neither is used.
     */
    function courseDisplayName() {
        if (raceGoal && raceGoal.race_name) return raceGoal.race_name;
        return 'Race course';
    }

    /** Name + one-line summary. Split out so the goal can re-title a course
        that was restored from cache before the goal was known. */
    function updateCourseHead() {
        const el = courseEls();
        if (!el.name || !courseRecord) return;
        el.name.textContent = courseDisplayName();
        const bits = [`${courseRecord.stats.distanceKm.toFixed(2)} km`];
        bits.push(courseRecord.meta.hasElevation
            ? `${Math.round(courseRecord.stats.gainM)} m gain`
            : 'no elevation data');
        el.meta.textContent = bits.join(' · ');
    }

    /** Paint the card from the current record. Single render path — the
        freshly parsed course and the restored one both go through here. */
    function renderCourseRecord() {
        const el = courseEls();
        if (!el.card || !courseRecord) return;
        const rec = courseRecord;

        el.drop.hidden = true;
        el.error.hidden = true;
        el.loaded.hidden = false;

        updateCourseHead();

        if (rec.route && rec.route.d) {
            el.routeLine.setAttribute('d', rec.route.d);
            // Sketched dots, matching the markers on the map. The radius is in
            // the trace's own 300x200 viewBox units, not screen pixels.
            el.routeStart.setAttribute('d', sketchyCirclePath(rec.route.start.x, rec.route.start.y, 6.5));
            el.routeEnd.setAttribute('d', sketchyCirclePath(rec.route.end.x, rec.route.end.y, 6.5));

            // Same split treatment as the map: on a loop the two dots would sit
            // on top of each other, so the start dot takes the half-and-half
            // fill and the end dot is dropped. Set via style, because the class
            // rule for the start pin would otherwise win over an attribute.
            const closed = routeCloses(rec.coords);
            el.routeEnd.hidden = closed;
            el.routeStart.style.fill = closed ? 'url(#pacey-course-split)' : '';
        }

        renderCourseStats(rec);
        renderCourseChart(rec);
        renderCourseMap(rec);
        renderGoalMap(rec);
        renderCourseInsight(rec);
    }

    /** Course statistic tiles. */
    function renderCourseStats(rec) {
        const el = courseEls();
        const s = rec.stats;
        const tiles = [{ label: 'Distance', value: s.distanceKm.toFixed(2), unit: 'km' }];

        if (rec.meta.hasElevation) {
            const cap = (w) => w ? w.charAt(0).toUpperCase() + w.slice(1) : '--';
            tiles.push({ label: 'Elevation gain', value: Math.round(s.gainM).toLocaleString(), unit: 'm' });
            tiles.push({ label: 'Elevation loss', value: Math.round(s.lossM).toLocaleString(), unit: 'm' });
            tiles.push({ label: 'High point', value: Math.round(s.maxEleM).toLocaleString(), unit: 'm' });
            tiles.push({ label: 'Low point', value: Math.round(s.minEleM).toLocaleString(), unit: 'm' });
            tiles.push({ label: 'Avg grade', value: s.avgGradePct.toFixed(1), unit: '%' });
            tiles.push({ label: 'Max grade', value: s.maxGradePct.toFixed(1), unit: '%' });
            tiles.push({ label: 'Terrain', value: cap(s.difficulty), unit: '' });
        }

        el.stats.innerHTML = tiles.map(t => `
            <div class="pacey-course-stat">
                <span class="pacey-course-stat-label">${t.label}</span>
                <span class="pacey-course-stat-value">${t.value}${t.unit ? `<span class="pacey-course-stat-unit">${t.unit}</span>` : ''}</span>
            </div>
        `).join('');
    }

    /** Elevation profile. Uses the board's chart fonts and paper tokens so it
        matches the other charts, and the global roughness plugin supplies the
        hand-drawn stroke. */
    function renderCourseChart(rec) {
        const el = courseEls();
        if (!el.chart || typeof Chart === 'undefined') return;
        if (courseChart) { courseChart.destroy(); courseChart = null; }
        if (!rec.meta.hasElevation || !rec.profile.length) return;

        const canvas = el.chart;
        const style = getComputedStyle(canvas);
        const chartFonts = pinboardChartFonts(canvas);
        // The chart sits directly on the dark board, so it reads chalk-on-slate
        // rather than the ink-on-paper tokens the other charts use. The palette
        // is defined on the card in pinboard-course.css.
        const chartText = style.getPropertyValue('--pacey-course-chart-text').trim() || '#f4f1e8';
        const chartGrid = style.getPropertyValue('--pacey-course-chart-grid').trim() || 'rgba(244, 241, 232, 0.18)';
        const chartSurface = style.getPropertyValue('--pacey-course-chart-surface').trim() || '#2f3b35';
        const accent = style.getPropertyValue('--pacey-course-chart-line').trim() || '#8fc4ea';
        const chartFill = style.getPropertyValue('--pacey-course-chart-fill').trim() || 'rgba(143, 196, 234, 0.18)';

        courseChart = new Chart(canvas, {
            type: 'line',
            data: {
                datasets: [{
                    data: rec.profile.map(p => ({ x: p.km, y: p.ele })),
                    fill: true,
                    backgroundColor: chartFill,
                    borderColor: accent,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHitRadius: 12,
                    tension: 0.2,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 600, easing: 'easeOutQuart' },
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        type: 'linear',
                        min: 0,
                        // End the axis where the course ends. Without an explicit
                        // max, Chart.js extends the scale to the next round tick
                        // (a 21.1 km course would run to 25), leaving dead space
                        // past the finish line.
                        max: rec.stats.distanceKm,
                        title: { display: true, text: 'km', color: chartText, font: { family: chartFonts.body, size: 11 } },
                        ticks: { color: chartText, font: { family: chartFonts.body, size: 10 }, maxTicksLimit: 6 },
                        grid: { color: chartGrid, drawTicks: false },
                        border: { color: chartGrid },
                    },
                    y: {
                        title: { display: true, text: 'm', color: chartText, font: { family: chartFonts.body, size: 11 } },
                        ticks: { color: chartText, font: { family: chartFonts.body, size: 10 }, maxTicksLimit: 5 },
                        grid: { color: chartGrid, drawTicks: false },
                        border: { color: chartGrid },
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        displayColors: false,
                        padding: 8,
                        cornerRadius: 3,
                        backgroundColor: chartSurface,
                        titleColor: chartText,
                        bodyColor: chartText,
                        borderColor: chartGrid,
                        borderWidth: 1,
                        titleFont: { family: chartFonts.heading, size: 12 },
                        bodyFont: { family: chartFonts.body, size: 13 },
                        titleSpacing: 4,
                        titleMarginBottom: 10,
                        bodySpacing: 10,
                        callbacks: {
                            title: (items) => items.length ? `${items[0].parsed.x.toFixed(1)} km` : '',
                            label: (item) => `${Math.round(item.parsed.y)} m`,
                        },
                    },
                },
            },
        });
    }

    /**
     * A hachure tile for MapLibre's fill-pattern / background-pattern.
     *
     * Parallel pencil strokes over a base colour — the same treatment
     * chartjs-plugin-roughness gives the charts, which fill with rough.js
     * hachure by default. A pattern REPLACES a layer's fill-colour rather than
     * compositing over it, so the base colour is baked into the tile.
     *
     * `size` and `step` must divide evenly, and size must be a power of two,
     * or the tile will not repeat seamlessly.
     */
    function makeHachureImage(baseColor, strokeColor, size, step) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, 0, size, size);
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        // 45° strokes. Drawing the family past both edges keeps each stroke
        // continuous across the tile seam.
        for (let i = -size; i < size * 2; i += step) {
            ctx.beginPath();
            // Vary the alpha a little so the shading reads as hand-drawn
            // rather than a machine-made hatch.
            ctx.globalAlpha = 0.45 + ((i / step) % 3) * 0.15;
            ctx.moveTo(i, 0);
            ctx.lineTo(i + size, size);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        return ctx.getImageData(0, 0, size, size);
    }

    /**
     * Close MapLibre's attribution panel.
     *
     * MapLibre's compact control opens itself on init — AttributionControl
     * ._updateCompact sets the `open` attribute, and only removes the compact
     * class when the map is narrower than 640px. On a wide panel that means the
     * full credit line sits on screen permanently. Closing it leaves the small
     * ⓘ button, so the credit is one tap away rather than hidden.
     */
    function collapseCourseAttribution(map) {
        if (!map) return;
        const attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
        if (!attrib) return;
        attrib.removeAttribute('open');
        attrib.classList.remove('maplibregl-compact-show');
    }

    /**
     * Re-measure the map canvas against its container.
     *
     * The card is often laid out before the board is revealed — a course
     * restored from cache renders while the dashboard is still hidden — so
     * MapLibre can latch a stale canvas width and leave a gap down its right
     * edge. Guarded on a real size, because resizing a hidden container would
     * zero the canvas instead of fixing it.
     */
    function resizeCourseMap() {
        const el = courseEls();
        [
            [courseMap, el.map],
            [goalMap, el.goalMap],
            [courseModalMap, el.mapModalMap],
        ].forEach(([map, node]) => {
            if (!map || !node || !node.clientWidth || !node.clientHeight) return;
            map.resize();

            // Maps are built during page init, while the dashboard can still be
            // hidden — and a `display: none` container measures 0x0, so
            // MapLibre's fitBounds has no box to work with and latches a
            // nonsense camera. resize() fixes the canvas but NOT the camera,
            // which is why a cached course came back zoomed in. Re-apply the
            // original framing the first time we have a real box.
            const fit = map.__paceyFit;
            if (fit && !map.__paceyFitted) {
                map.fitBounds(fit.bounds, fit.options);
                map.__paceyFitted = true;
            }
        });
    }

    /**
     * Keep every course map's canvas matched to its box.
     *
     * Created once and pointed at all three containers: they are stable for the
     * life of the page, and resizeCourseMap no-ops for a map that doesn't
     * exist or a container with no size yet.
     */
    function observeCourseMapBoxes() {
        if (typeof ResizeObserver === 'undefined' || courseMapObserver) return;
        const el = courseEls();
        courseMapObserver = new ResizeObserver(() => requestAnimationFrame(resizeCourseMap));
        [el.map, el.goalMap, el.mapModalMap].forEach((node) => {
            if (node) courseMapObserver.observe(node);
        });
    }

    /**
     * A hand-drawn-looking circle as an SVG path.
     *
     * The wobble is baked into the path rather than run through the sketch
     * filter, because that filter is tuned for the 300x200 route viewBox and
     * would be almost invisible at marker size.
     *
     * The shape is a true circle with a few gentle bulges, not a circle with
     * noise sprinkled on it. Per-point jitter is the obvious approach and it is
     * wrong: at any point count small enough to be readable it comes out as a
     * rounded polygon, because the variation happens once per point rather than
     * smoothly. Three low harmonics instead give a closed curve that stays
     * unmistakably a circle while clearly being drawn by hand — the first leans
     * the whole thing off centre (a pen circling something pushes out on one
     * side and cuts in on the other), the second makes it slightly oval, the
     * third adds the small lean of a wrist.
     *
     * Fixed amplitudes and phases, not random, so the same circle looks the
     * same on every render instead of twitching each time the map repaints.
     */
    const SKETCH_LEAN = 0.08;    // off-centre lean, 1 cycle round the circle
    const SKETCH_OVAL = 0.055;   // slightly oval, 2 cycles
    const SKETCH_WRIST = 0.03;   // wrist lean, 3 cycles

    function sketchyCirclePath(cx, cy, r) {
        const n = 16;
        const pts = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 - Math.PI / 2;
            const k = 1
                + SKETCH_LEAN * Math.cos(a - 0.6)
                + SKETCH_OVAL * Math.cos(2 * a + 1.1)
                + SKETCH_WRIST * Math.cos(3 * a + 2.4);
            pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k]);
        }
        // Smooth through the points with quadratic segments anchored at the
        // midpoints, so the outline curves instead of faceting.
        let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
        for (let i = 1; i <= n; i++) {
            const cur = pts[i % n];
            const next = pts[(i + 1) % n];
            const mx = (cur[0] + next[0]) / 2;
            const my = (cur[1] + next[1]) / 2;
            d += ` Q${cur[0].toFixed(2)} ${cur[1].toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
        }
        return d + ' Z';
    }

    /**
     * A deliberately rough ring — the mark a coach makes circling something
     * with a pen.
     *
     * Rougher than sketchyCirclePath on purpose: the radius swings much
     * further, the shape is slightly elliptical, and the sweep laps past its
     * own start, which is what a hand-drawn circle actually looks like.
     */
    function sketchyRingPath(cx, cy, r) {
        // Same harmonics as the dot, pushed harder — this is the coach's pen
        // mark circling a point, drawn quickly and loosely. The squash also
        // varies as the pen lifts and settles, because a constant squash is
        // just a clean ellipse, which is the one shape a hand-drawn circle
        // never is. Runs slightly past a full lap so the stroke crosses its own
        // start, the way a real pen circle does.
        const n = 18;
        const turns = 1.14;
        const pts = [];
        for (let i = 0; i <= n; i++) {
            const a = (i / n) * Math.PI * 2 * turns - Math.PI / 2;
            const k = 1
                + (SKETCH_LEAN * 1.5) * Math.cos(a - 0.5)
                + (SKETCH_OVAL * 1.4) * Math.cos(2 * a + 1.3)
                + (SKETCH_WRIST * 1.4) * Math.cos(3 * a + 2.2);
            const squash = 0.93 + 0.04 * Math.cos(a + 0.8);
            pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k * squash]);
        }
        let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
        for (let i = 1; i < pts.length - 1; i++) {
            const cur = pts[i];
            const next = pts[i + 1];
            const mx = (cur[0] + next[0]) / 2;
            const my = (cur[1] + next[1]) / 2;
            d += ` Q${cur[0].toFixed(2)} ${cur[1].toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
        }
        const last = pts[pts.length - 1];
        d += ` L${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
        return d;
    }

    /**
     * Whether a route starts and finishes in the same place.
     *
     * Only the straight-line gap between the first and last track point is
     * available here — a real course can pass back near its start without
     * closing, so this is a heuristic, not a proof. The number below is the
     * whole of it.
     *
     * 400 m covers the GPS drift of a closed course plus the fact that a runner
     * starts and stops at slightly different spots, while staying far below the
     * separation of a genuine point-to-point race, where the start and finish
     * are at different venues. Raise it and a point-to-point course whose
     * endpoints happen to sit close starts being drawn as a loop, with the
     * finish marker disappearing.
     *
     * Shared by the map markers and the fallback trace so both treat a loop the
     * same way.
     */
    const ROUTE_CLOSES_M = 400;

    function routeCloses(coords) {
        if (!Array.isArray(coords) || coords.length < 2) return false;
        const a = coords[0];
        const b = coords[coords.length - 1];
        return PaceyCourse.haversineM(a[1], a[0], b[1], b[0]) < ROUTE_CLOSES_M;
    }

    /** A start or end dot for a MapLibre marker, drawn as a sketched circle. */
    function makeCourseMarkerElement(kind, size) {
        const px = size || 18;
        const wrap = document.createElement('div');
        wrap.className = `pacey-course-marker pacey-course-marker--${kind}`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(px));
        svg.setAttribute('height', String(px));
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', sketchyCirclePath(12, 12, 7.6));
        svg.appendChild(path);
        wrap.appendChild(svg);
        return wrap;
    }

    // SVG ids are document-global, and several maps can be on the page at once,
    // so each split dot's gradient needs its own.
    let splitGradientSeq = 0;

    /**
     * A single dot for a course that closes on itself.
     *
     * A loop starts and finishes in the same place, so two dots would simply
     * stack there with the red hiding the green. This splits the one dot down
     * the middle instead — green for the start, red for the finish — using a
     * hard-stop gradient, so the sketchy outline stays a single hand-drawn
     * stroke rather than two clipped halves.
     */
    function makeCourseSplitMarkerElement(size) {
        const px = size || 18;
        const wrap = document.createElement('div');
        wrap.className = 'pacey-course-marker pacey-course-marker--split';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(px));
        svg.setAttribute('height', String(px));
        svg.setAttribute('aria-hidden', 'true');

        const gradId = `pacey-course-split-${splitGradientSeq++}`;
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        grad.setAttribute('id', gradId);
        grad.setAttribute('x1', '0');
        grad.setAttribute('y1', '0');
        grad.setAttribute('x2', '1');
        grad.setAttribute('y2', '0');
        // The doubled 50% stop is what makes the edge hard rather than a blend.
        [['0', '#2f8f4e'], ['0.5', '#2f8f4e'], ['0.5', '#b83b2e'], ['1', '#b83b2e']]
            .forEach(([offset, color]) => {
                const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
                stop.setAttribute('offset', offset);
                stop.setAttribute('stop-color', color);
                grad.appendChild(stop);
            });
        defs.appendChild(grad);
        svg.appendChild(defs);

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', sketchyCirclePath(12, 12, 7.6));
        path.setAttribute('fill', `url(#${gradId})`);
        svg.appendChild(path);

        wrap.appendChild(svg);
        return wrap;
    }

    /**
     * A hand-drawn red ring — the coach's pen mark circling a point on the
     * route. Hollow, and sketched like the dots so the two match.
     */
    function makeCourseRingElement(size) {
        const px = size || 44;
        const wrap = document.createElement('div');
        wrap.className = 'pacey-course-ring';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 56 56');
        svg.setAttribute('width', String(px));
        svg.setAttribute('height', String(px));
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        // Sits well inside the viewBox: the exaggerated wobble needs room, or
        // the stroke clips at the edge.
        path.setAttribute('d', sketchyRingPath(28, 28, 19));
        svg.appendChild(path);
        wrap.appendChild(svg);
        return wrap;
    }

    /**
     * Add the course route and the coloured-pencil shading to a loaded map.
     *
     * Shared by the inline card map and the full-screen modal so the two can
     * never drift apart.
     */
    function applyCourseRouteLayers(map, coords, opts) {
        const options = opts || {};
        map.addSource('pacey-course-route', {
            type: 'geojson',
            data: {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: coords },
            },
        });
        map.addLayer({
            id: 'pacey-course-route',
            type: 'line',
            source: 'pacey-course-route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#2f6fb0', 'line-width': 3 },
        });

        // Start and end dots. DOM markers rather than a MapLibre layer, so the
        // sketchy outline stays crisp at every zoom (a layer would scale with
        // the map) and the colours match the fallback trace's pins. They are
        // torn down with the map, so nothing leaks between renders.
        const markerSize = options.markerSize || 18;
        // Bigger than the dots by design: the ring is a pen mark drawn around
        // them, and the exaggerated wobble needs the clearance.
        const ringSize = options.ringSize || 44;
        const start = coords[0];
        const end = coords[coords.length - 1];

        // A loop starts and finishes in the same place, so two dots would stack
        // with the red hiding the green. A closed course gets one dot split
        // down the middle instead.
        const closes = routeCloses(coords);

        if (closes) {
            new maplibregl.Marker({ element: makeCourseSplitMarkerElement(markerSize) })
                .setLngLat(start)
                .addTo(map);
        } else {
            new maplibregl.Marker({ element: makeCourseMarkerElement('start', markerSize) })
                .setLngLat(start)
                .addTo(map);
            new maplibregl.Marker({ element: makeCourseMarkerElement('end', markerSize) })
                .setLngLat(end)
                .addTo(map);
        }

        // The coach's pen mark: one ring when the course closes on itself, two
        // when it is point-to-point, where a single ring could not cover both.
        new maplibregl.Marker({ element: makeCourseRingElement(ringSize) })
            .setLngLat(start)
            .addTo(map);
        if (!closes) {
            new maplibregl.Marker({ element: makeCourseRingElement(ringSize) })
                .setLngLat(end)
                .addTo(map);
        }

        // Shade the basemap like coloured pencil. Each surface gets a hachure
        // tile ([base colour, stroke]) built at runtime, then the layer is
        // switched to it via fill-pattern / background-pattern. Every step is
        // matched on the paint property the layer actually declares, so a style
        // revision is a no-op rather than a throw.
        const SURFACES = {
            paper: ['#f3eee3', '#e7dfcd'],
            water: ['#cfe3f1', '#a9c8dd'],
            park: ['#e6e8d4', '#c6cba9'],
            landcover: ['#e9e1cf', '#cec2a2'],
            landuse: ['#eee6d5', '#d6cbb0'],
            building: ['#e5dcc6', '#cbbfa3'],
        };
        Object.entries(SURFACES).forEach(([key, [base, stroke]]) => {
            map.addImage(`pacey-hachure-${key}`, makeHachureImage(base, stroke, 32, 8), { pixelRatio: 2 });
        });

        map.getStyle().layers.forEach((layer) => {
            try {
                const src = layer['source-layer'];
                const paint = layer.paint || {};
                if (layer.type === 'background' && 'background-color' in paint) {
                    map.setPaintProperty(layer.id, 'background-color', SURFACES.paper[0]);
                    map.setPaintProperty(layer.id, 'background-pattern', 'pacey-hachure-paper');
                } else if ('fill-color' in paint && SURFACES[src]) {
                    map.setPaintProperty(layer.id, 'fill-color', SURFACES[src][0]);
                    map.setPaintProperty(layer.id, 'fill-pattern', `pacey-hachure-${src}`);
                } else if ('line-color' in paint && src === 'transportation') {
                    map.setPaintProperty(layer.id, 'line-color', '#d8c9a8');
                }
            } catch (e) {
                // Style revision without this property — leave it alone.
            }
        });
    }

    /**
     * Build a MapLibre map for a course record.
     *
     * `interactive` is off for the inline card map, which stays a picture — an
     * embedded map otherwise swallows the page's own scrolling and pinch-zoom
     * on a phone. The modal map turns interaction back on for real exploring.
     */
    function buildCourseMap(container, rec, opts) {
        const options = opts || {};
        const coords = rec.coords;
        const bounds = coords.reduce(
            (b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0])
        );

        const map = new maplibregl.Map({
            container,
            style: 'https://tiles.openfreemap.org/styles/positron',
            bounds,
            fitBoundsOptions: { padding: options.padding || 26 },
            // OpenFreeMap's style JSON ships NO attribution of its own, so it is
            // set explicitly here — OSM data is ODbL and credit is required.
            // The thumbnail turns it off: at ~100px wide the control covers a
            // quarter of the map, and the credit is carried by the full card
            // map directly below it on the same screen.
            attributionControl: options.showAttribution === false
                ? false
                : {
                    compact: true,
                    customAttribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors',
                },
            interactive: options.interactive !== false,
            // One finger scrolls the page, two fingers move the map. Only
            // meaningful when the map is interactive at all.
            cooperativeGestures: options.interactive !== false,
        });

        // Remember how the map was framed so it can be re-applied if the
        // container turns out to have had no size at construction (see
        // resizeCourseMap). One re-fit only, so it can never fight a user who
        // has since panned the modal map.
        map.__paceyFit = { bounds, options: { padding: options.padding || 26 } };
        map.__paceyFitted = false;

        // Collapse the attribution panel, and again on resize — MapLibre
        // re-runs _updateCompact on resize.
        collapseCourseAttribution(map);
        map.on('resize', () => collapseCourseAttribution(map));
        map.on('load', () => applyCourseRouteLayers(map, coords, options));

        return map;
    }

    /**
     * The inline card map.
     *
     * Deliberately NOT interactive: it is a picture of the route, and a map
     * that pans and zooms inside a scrolling page traps the page's own
     * gestures. A click opens the full-screen modal, where the map is
     * genuinely usable.
     */
    function renderCourseMap(rec) {
        const el = courseEls();
        if (!el.map || !el.routeSvg) return;

        if (courseMap) { courseMap.remove(); courseMap = null; }

        const coords = rec.coords;
        // `coords` is [longitude, latitude] — the order GeoJSON, LngLatBounds
        // and MapLibre all use, and the opposite of the [lat, lon] order the
        // GPX itself is written in. Range-checked before use because MapLibre
        // throws on an out-of-range latitude, and a malformed record should
        // fall back to the drawn trace rather than break the card.
        const validCoords = Array.isArray(coords) && coords.length > 1 && coords.every(
            (c) => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])
                && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90
        );

        if (typeof maplibregl === 'undefined' || !validCoords) {
            el.map.hidden = true;
            el.routeSvg.hidden = false;
            return;
        }

        el.routeSvg.hidden = true;
        el.map.hidden = false;

        try {
            courseMap = buildCourseMap(el.map, rec, { interactive: false });
        } catch (err) {
            // MapLibre refused the map — show the drawn trace instead of
            // leaving an empty panel.
            el.map.hidden = true;
            el.routeSvg.hidden = false;
            courseMap = null;
            return;
        }

        // Re-measure once laid out, and again on every real size change. The
        // observer is created once: the container element is stable for the
        // life of the page, and resizeCourseMap no-ops while no map exists.
        requestAnimationFrame(resizeCourseMap);
        observeCourseMapBoxes();
    }

    /**
     * Pin the mini note under the countdown.
     *
     * The countdown's height is viewport-clamped — its padding and font size
     * both scale with width — so its lower edge can't be expressed in CSS
     * without duplicating those clamps. Measuring it is the reliable option,
     * and it re-runs on resize.
     */
    function positionGoalNote() {
        const el = courseEls();
        if (!el.goalMapNote || el.goalMapNote.hidden) return;
        const countdown = $('#pacey-countdown-highlight');
        if (!countdown || !countdown.offsetHeight) return;
        // offsetTop is relative to the card, which is also the note's offset
        // parent, so the two share a coordinate space.
        const below = countdown.offsetTop + countdown.offsetHeight;
        el.goalMapNote.style.top = `${Math.round(below + 10)}px`;
    }

    /**
     * Re-run both halves of the mini note's layout: its width (which follows
     * the map's responsive height) and its position under the countdown.
     *
     * Both depend on the viewport, so this is what the resize handler and the
     * post-render hooks call.
     */
    function layoutGoalNote() {
        const el = courseEls();
        if (!el.goalMapNote || el.goalMapNote.hidden) return;
        if (courseRecord && Array.isArray(courseRecord.coords)) {
            sizeGoalMapToRoute(courseRecord.coords);
        }
        positionGoalNote();
    }

    /**
     * Scroll the runner down to the full Race Course card, then flash it.
     *
     * The flash is a CSS class on the card, added once the smooth scroll
     * lands. There is no reliable cross-browser "scroll finished" event, so
     * the scroll listener waits for 150ms of quiet; the outer timeout is
     * the fallback for a no-op scroll (the card was already in view), which
     * produces no scroll events at all.
     */
    function goToCourseSection() {
        const el = courseEls();
        const section = $('#pacey-course-section');
        if (!section || !el.card) return;
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });

        let landed = false;
        let scrolled = false;
        let settle = null;
        const land = () => {
            if (landed) return;
            landed = true;
            document.removeEventListener('scroll', onScroll);
            // Reflow between remove and add so a re-click while the class
            // is still on replays the animation rather than doing nothing.
            el.card.classList.remove('pacey-course-card--arrive');
            void el.card.offsetWidth;
            el.card.classList.add('pacey-course-card--arrive');
            el.card.addEventListener('animationend',
                () => el.card.classList.remove('pacey-course-card--arrive'),
                { once: true });
        };
        const onScroll = () => {
            scrolled = true;
            clearTimeout(settle);
            settle = setTimeout(land, 150);
        };
        document.addEventListener('scroll', onScroll, { passive: true });
        // No scroll events at all means the section was already in view —
        // land promptly rather than waiting out a long fallback, which
        // would also risk firing mid-scroll on a long smooth scroll.
        setTimeout(() => { if (!scrolled) land(); }, 400);
    }

    /**
     * Size the mini note to the route's own shape.
     *
     * A fixed box would leave a tall loop as a thin line down the middle of a
     * wide map with dead space either side — KLSCM's route is 2.6 km by 4.8 km,
     * so it needs a portrait note. The note's height is fixed in CSS and the
     * width follows from the route's aspect, clamped so an extreme course
     * can't produce a silly shape.
     */
    function sizeGoalMapToRoute(coords) {
        const el = courseEls();
        if (!el.goalMapNote || !el.goalMap) return;

        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (const c of coords) {
            if (c[1] < minLat) minLat = c[1];
            if (c[1] > maxLat) maxLat = c[1];
            if (c[0] < minLon) minLon = c[0];
            if (c[0] > maxLon) maxLon = c[0];
        }

        // A degree of longitude is shorter away from the equator, so scale the
        // width before taking the ratio or every route comes out too wide.
        const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
        const spanW = (maxLon - minLon) * k;
        const spanH = maxLat - minLat;
        const aspect = spanH > 0 ? Math.max(0.7, Math.min(2.1, spanW / spanH)) : 1.6;

        // The map height is responsive — doubled on laptops — and it is read
        // from the CSS custom property rather than the element's computed
        // height. A course restored from cache renders while the dashboard is
        // still hidden, and a display:none element reports a zero box in some
        // browsers, which would collapse the note's width along with it.
        const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const rawHeight = getComputedStyle(el.goalMapNote)
            .getPropertyValue('--pacey-goal-map-h').trim();
        let mapH = parseFloat(rawHeight) || 3.5 * rootFont;
        if (rawHeight.endsWith('rem')) mapH *= rootFont;

        const noteStyle = getComputedStyle(el.goalMapNote);
        const padX = ((parseFloat(noteStyle.paddingLeft) || 0)
            + (parseFloat(noteStyle.paddingRight) || 0)) || 0.8 * rootFont;

        el.goalMapNote.style.width = `${Math.round(mapH * aspect + padX)}px`;

        // Portrait courses get the tall scribble: stretching the wide ring
        // onto a tall note squashes its wobble into a different, sloppier
        // hand. The class swaps which of the two drawn rings shows.
        el.goalMapNote.classList.toggle('pacey-goal-map-note--portrait', aspect < 1);
    }

    /**
     * The pinned mini map in the Race Goal card.
     *
     * A deliberately tiny, non-interactive preview of the same route, on a
     * sticky note — so the goal card shows the course the runner is training
     * for without duplicating the full Race Course card below it. Hidden
     * entirely when there is no course.
     */
    function renderGoalMap(rec) {
        const el = courseEls();
        if (!el.goalMapNote || !el.goalMap) return;

        if (goalMap) { goalMap.remove(); goalMap = null; }

        const coords = rec.coords;
        const validCoords = Array.isArray(coords) && coords.length > 1 && coords.every(
            (c) => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])
                && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90
        );

        if (typeof maplibregl === 'undefined' || !validCoords) {
            el.goalMapNote.hidden = true;
            return;
        }

        el.goalMapNote.hidden = false;
        sizeGoalMapToRoute(coords);

        // The dots and the ring scale with the map, which doubles at the laptop
        // breakpoint — a fixed size would look undersized there.
        const mapH = parseFloat(getComputedStyle(el.goalMap).height) || 56;
        const scale = Math.max(1, mapH / 56);

        // The note is absolutely positioned under the countdown, so its top
        // depends on the countdown's measured height.
        requestAnimationFrame(layoutGoalNote);
        try {
            goalMap = buildCourseMap(el.goalMap, rec, {
                interactive: false,
                // A thumbnail: no attribution control, which would otherwise
                // cover a quarter of it. The card map below carries the credit.
                showAttribution: false,
                padding: Math.round(8 * scale),
                markerSize: Math.round(6 * scale),
                ringSize: Math.round(15 * scale),
            });
        } catch (e) {
            goalMap = null;
            el.goalMapNote.hidden = true;
            return;
        }

        requestAnimationFrame(resizeCourseMap);
        observeCourseMapBoxes();
    }

    // --- Full-screen course map ------------------------------------------
    //
    // The inline map is a static picture, so this is where the route can
    // actually be read: panned, zoomed and scrolled at a useful size.

    let courseModalMap = null;

    function isCourseMapModalOpen() {
        const el = courseEls();
        return !!(el.mapModal && !el.mapModal.hidden);
    }

    function openCourseMapModal() {
        const el = courseEls();
        if (!el.mapModal || !el.mapModalMap || !courseRecord) return;
        if (!Array.isArray(courseRecord.coords) || courseRecord.coords.length < 2) return;

        el.mapModal.hidden = false;
        if (el.mapModalTitle) el.mapModalTitle.textContent = courseDisplayName();

        // Built only once the modal has a real size, or MapLibre measures a
        // zero-height box and the canvas comes out wrong.
        requestAnimationFrame(() => {
            if (courseModalMap) { courseModalMap.remove(); courseModalMap = null; }
            try {
                courseModalMap = buildCourseMap(el.mapModalMap, courseRecord, {
                    interactive: true,
                    padding: 48,
                });
            } catch (e) {
                courseModalMap = null;
            }
        });
    }

    function closeCourseMapModal() {
        const el = courseEls();
        if (el.mapModal) el.mapModal.hidden = true;
        if (courseModalMap) { courseModalMap.remove(); courseModalMap = null; }
    }

    // --- The coach's read on the course ----------------------------------
    //
    // Generated server-side from the same course structure the card displays,
    // and cached there by email. Demo mode has no server, so it stands in a
    // fixed read written against the sample course.

    // Written against the real KL Standard Chartered Half route the demo loads
    // (21.4 km, 314 m of climbing, 14.7 m/km — hilly on the road scale; hardest
    // kilometre 3.5–4.5 km at 38 m, fastest descent 8.8–9.8 km at 41 m), and
    // shaped like the read the coach now produces: overview, what to notice,
    // how it compares with the runner's training, and what to do about it.
    const DEMO_COURSE_INSIGHT =
        'This is a hilly half by road standards — 314 m of climbing across 21.4 km. The hardest kilometre '
        + 'comes early, between 3.5 and 4.5 km, climbing 38 m at nearly 4%, and there is a fast descent '
        + 'around 9 km worth running rather than braking down. Your recent runs have been far flatter than '
        + 'this, so the hills will ask more of you than your training has. Get some hill work in before '
        + 'race day.';

    function renderCourseInsight(rec) {
        const el = courseEls();
        if (!el.insight) return;
        el.insight.hidden = false;

        const fingerprint = rec.savedAt || '';

        // Already have the read for this exact course.
        if (courseInsight && courseInsight.fingerprint === fingerprint) {
            el.insightText.textContent = courseInsight.text;
            el.insightText.hidden = false;
            el.insightLoading.hidden = true;
            return;
        }

        if (window.__demoMode) {
            courseInsight = { text: DEMO_COURSE_INSIGHT, fingerprint };
            el.insightText.textContent = DEMO_COURSE_INSIGHT;
            el.insightText.hidden = false;
            el.insightLoading.hidden = true;
            return;
        }

        el.insightText.hidden = true;
        el.insightLoading.hidden = false;
        loadCourseInsight(rec);
    }

    async function loadCourseInsight(rec) {
        const el = courseEls();
        try {
            // The record is sent with the request so the read can't race the
            // save of a course that was just uploaded.
            const resp = await apiCallWithAuthRetry('POST', 'coach-plan', {
                action: 'course-insight',
                course: rec,
            });
            const data = await resp.json();
            if (resp.ok && data && data.insight) {
                courseInsight = { text: data.insight, fingerprint: rec.savedAt || '' };
                // The card may have been cleared or replaced mid-flight, so
                // only paint if the same course is still on screen.
                if (courseRecord === rec) {
                    el.insightText.textContent = data.insight;
                    el.insightText.hidden = false;
                    el.insightLoading.hidden = true;
                }
                return;
            }
        } catch (e) {
            // Offline or signed out — fall through and hide the block.
        }
        if (courseRecord === rec && el.insight) el.insight.hidden = true;
    }

    function showCourseError(msg) {
        const el = courseEls();
        if (!el.error) return;
        el.error.textContent = msg;
        el.error.hidden = false;
    }

    /** Read, parse and display a dropped or chosen GPX file. */
    async function handleCourseFile(file) {
        const el = courseEls();
        if (!file) return;
        if (!/\.gpx$/i.test(file.name)) {
            showCourseError('That is not a .gpx file. Export your course as GPX and try again.');
            return;
        }
        if (file.size > COURSE_MAX_BYTES) {
            showCourseError('That file is larger than 15 MB. Try exporting a simplified course.');
            return;
        }
        if (!window.PaceyCourse) {
            showCourseError('The course reader did not load. Please refresh the page.');
            return;
        }

        el.error.hidden = true;
        el.card.classList.add('is-busy');
        try {
            const text = await file.text();
            const parsed = PaceyCourse.parseGpx(text);
            const course = PaceyCourse.computeCourse(parsed.points);
            courseRecord = makeCourseRecord(course, parsed.points, {
                name: parsed.name, fileName: file.name, source: parsed.source,
            });
            renderCourseRecord();
            persistCourseLocal();
            saveCourseRemote();
        } catch (err) {
            showCourseError(err && err.message ? err.message : 'Could not read that GPX file.');
        } finally {
            el.card.classList.remove('is-busy');
        }
    }

    function clearCourse() {
        const el = courseEls();
        courseRecord = null;
        courseInsight = null;
        if (courseChart) { courseChart.destroy(); courseChart = null; }
        if (courseMap) { courseMap.remove(); courseMap = null; }
        if (goalMap) { goalMap.remove(); goalMap = null; }
        if (el.goalMapNote) el.goalMapNote.hidden = true;
        if (el.insight) el.insight.hidden = true;
        closeCourseMapModal();
        if (el.loaded) el.loaded.hidden = true;
        if (el.drop) el.drop.hidden = false;
        if (el.error) el.error.hidden = true;
        if (el.input) el.input.value = '';
        localStorage.removeItem(COURSE_CACHE_KEY);
        saveCourseRemote(); // null record clears the server copy too
    }

    function persistCourseLocal() {
        try {
            if (courseRecord) localStorage.setItem(COURSE_CACHE_KEY, JSON.stringify(courseRecord));
            else localStorage.removeItem(COURSE_CACHE_KEY);
        } catch (e) {
            // Quota exceeded — the course still renders for this session.
        }
    }

    function restoreCourseLocal() {
        try {
            const raw = localStorage.getItem(COURSE_CACHE_KEY);
            if (!raw) return false;
            const rec = JSON.parse(raw);
            if (!rec || rec.version !== 1) return false;
            courseRecord = rec;
            renderCourseRecord();
            return true;
        } catch (e) {
            return false;
        }
    }

    // Cross-device sync, keyed by Garmin email server-side (same pattern as
    // the fitness snapshot). Only the distilled record is sent — never the file.
    async function saveCourseRemote() {
        if (window.__demoMode) return;
        try {
            await apiCall('POST', 'coach-plan', { action: 'course', course: courseRecord });
        } catch (e) {
            // Offline or signed out — the local copy still stands.
        }
    }

    async function loadCourseRemote() {
        if (window.__demoMode || courseRecord) return;
        try {
            const resp = await apiCallWithAuthRetry('GET', 'coach-plan?action=course');
            const data = await resp.json();
            if (resp.ok && data && data.course && data.course.version === 1) {
                courseRecord = data.course;
                renderCourseRecord();
                persistCourseLocal();
            }
        } catch (e) {
            // No stored course, or offline — the empty state stays.
        }
    }

    /**
     * Fallback demo course, used only when the real demo GPX can't be fetched
     * (offline, or the asset is missing).
     *
     * A generated hilly half, run through the real PaceyCourse pipeline rather
     * than hand-written, so the demo exercises the same code as a real upload.
     */
    function buildDemoCoursePoints() {
        const points = [];
        const n = 1500;
        const lat0 = 3.1390;
        const lon0 = 101.6869;
        let seed = 7;
        const rnd = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        // Tuned to a realistic back-loaded half: 21.1 km, 338 m of climbing, one
        // 270 m climb at 6.8% (peaking near 10%) starting 14 km in, with the
        // descent returning to the start height so the loop closes.
        const climbStart = 0.72;
        const climbEnd = 0.86;
        const climbRate = 1800;
        const climbDrop = (climbEnd - climbStart) * climbRate;

        for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            const angle = t * Math.PI * 2.4;
            const radius = 0.0235 + 0.004 * Math.sin(t * Math.PI * 3);

            let ele = 40 + 14 * Math.sin(t * Math.PI * 8);          // gentle rollers
            if (t > climbStart && t < climbEnd) ele += (t - climbStart) * climbRate;
            if (t >= climbEnd) ele += climbDrop - ((t - climbEnd) / (1 - climbEnd)) * climbDrop;
            ele += (rnd() - 0.5) * 2.4;   // altimeter jitter, so the filter earns its keep

            points.push({
                lat: lat0 + radius * Math.sin(angle),
                lon: lon0 + radius * Math.cos(angle) * 1.05,
                ele,
            });
        }
        return points;
    }

    // The demo course is the real KL Standard Chartered Half route, fetched
    // from the site's own assets so the demo shows genuine data rather than a
    // generated stand-in.
    // The demo course is the race the demo runner just ran, so the course card,
    // the activity list and the recap all describe the same event. This is the
    // real Garmin export of that half marathon — 6,587 trackpoints, 21.27 km,
    // 63 m of climb. It is the largest asset the demo fetches (~2.6 MB); the
    // generated fallback below covers the offline case.
    const DEMO_COURSE_URL = '/pacey/assets/activity_24425014019.gpx';

    async function loadDemoCourse() {
        if (!window.PaceyCourse) return;

        let points = null;
        let fileName = 'activity_24425014019.gpx';
        try {
            const resp = await fetch(DEMO_COURSE_URL);
            if (resp.ok) {
                const parsed = PaceyCourse.parseGpx(await resp.text());
                if (parsed.points.length) points = parsed.points;
            }
        } catch (e) {
            // Offline, or the asset is missing — fall through to the generator.
        }
        if (!points) {
            points = buildDemoCoursePoints();
            fileName = 'demo-course.gpx';
        }

        const course = PaceyCourse.computeCourse(points);
        courseRecord = makeCourseRecord(course, points, {
            name: 'Brooks Half Marathon',
            fileName,
            source: 'track',
        });
        // Deliberately not persisted — demo data must not become the runner's
        // stored course.
        renderCourseRecord();
    }

    /**
     * Drop the in-memory course WITHOUT touching the server copy. Used when
     * leaving demo mode: the real course (if the runner has one) is fetched
     * afterwards, and clearing remotely here would delete it.
     */
    function resetCourseLocal() {
        const el = courseEls();
        courseRecord = null;
        courseInsight = null;
        if (courseChart) { courseChart.destroy(); courseChart = null; }
        if (courseMap) { courseMap.remove(); courseMap = null; }
        if (goalMap) { goalMap.remove(); goalMap = null; }
        if (el.goalMapNote) el.goalMapNote.hidden = true;
        if (el.loaded) el.loaded.hidden = true;
        if (el.insight) el.insight.hidden = true;
        if (el.drop) el.drop.hidden = false;
        if (el.error) el.error.hidden = true;
        closeCourseMapModal();
    }

    /** Wire the card once. Safe to call before any course exists. */
    function initCourseCard() {
        const el = courseEls();
        if (!el.card) return;

        // Restore before wiring so a reload lands in the loaded state.
        restoreCourseLocal();

        if (el.drop) {
            el.drop.addEventListener('click', () => el.input && el.input.click());
            el.drop.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    el.input && el.input.click();
                }
            });
        }
        if (el.input) {
            el.input.addEventListener('change', (e) => {
                const f = e.target.files && e.target.files[0];
                if (f) handleCourseFile(f);
            });
        }

        // Drag and drop. dragenter and dragover must both preventDefault, or
        // the browser navigates to the file instead of firing drop.
        ['dragenter', 'dragover'].forEach((evt) => {
            el.card.addEventListener(evt, (e) => {
                if (!e.dataTransfer) return;
                e.preventDefault();
                if (el.drop) el.drop.classList.add('is-dragover');
            });
        });
        ['dragleave', 'drop'].forEach((evt) => {
            el.card.addEventListener(evt, (e) => {
                e.preventDefault();
                if (el.drop) el.drop.classList.remove('is-dragover');
            });
        });
        el.card.addEventListener('drop', (e) => {
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (f) handleCourseFile(f);
        });

        if (el.replace) el.replace.addEventListener('click', () => el.input && el.input.click());
        if (el.remove) el.remove.addEventListener('click', clearCourse);

        // The inline map is a picture, so a click (or Enter/Space, since it is
        // reachable by keyboard) opens the full-screen one.
        if (el.map) {
            el.map.setAttribute('role', 'button');
            el.map.setAttribute('tabindex', '0');
            el.map.setAttribute('aria-label', 'Open the full-screen race course map');
            el.map.addEventListener('click', openCourseMapModal);
            el.map.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openCourseMapModal();
                }
            });
        }

        // The mini note is a pointer to the full card, so a click takes the
        // runner there instead of doing nothing. Reachable by keyboard too.
        if (el.goalMapNote) {
            el.goalMapNote.setAttribute('role', 'button');
            el.goalMapNote.setAttribute('tabindex', '0');
            el.goalMapNote.setAttribute('aria-label', 'Go to the race course');
            el.goalMapNote.addEventListener('click', goToCourseSection);
            el.goalMapNote.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    goToCourseSection();
                }
            });
        }

        // Modal dismissal: the close button, a click on the backdrop, or Escape.
        if (el.mapModalClose) el.mapModalClose.addEventListener('click', closeCourseMapModal);
        if (el.mapModal) {
            el.mapModal.addEventListener('click', (e) => {
                if (e.target === el.mapModal) closeCourseMapModal();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isCourseMapModalOpen()) closeCourseMapModal();
        });

        // The countdown above the note is sized in viewport units, and the map
        // itself doubles at the laptop breakpoint, so both have to be
        // re-measured when the layout changes.
        window.addEventListener('resize', layoutGoalNote);
    }

    // The card lives in the dashboard markup, so wire it immediately.
    initCourseCard();

    async function loadAllData(forceAIRefresh = false) {
        const isDemo = window.__demoMode;

        if (isDemo) {
            // Use mock data — no API calls. Metrics/activity list/calendar
            // render immediately; the charts + AI pillars show a loading
            // state for DEMO_CHART_LOADING_MS to simulate the real fetch
            // before their values appear.
            renderMetrics(getMockMetrics());
            const mockActs = generateMockActivities();
            // Seed the shared activity store — the post-race detection reads it,
            // and without this the demo could never recognise its own race.
            fullActivitiesLoaded = mockActs;
            activitiesLoaded = true;
            // Overview shows 5 latest; full page shows all mock activities
            renderActivities(mockActs);
            renderCalendar(mockActs);
            // Hide the "Load more" button in demo mode — the whole mock list,
            // race included, is already shown
            // activities are already shown
            const loadMoreBtn = $('#pacey-load-more-activities');
            if (loadMoreBtn) loadMoreBtn.hidden = true;
            // The demo's race is dated today and the mock list carries the run, so
            // this lands in post-race mode and the recap replaces the six areas.
            const demoPostRace = postRaceState(raceGoal, fullActivitiesLoaded);
            applyRaceRecapMode(demoPostRace, raceGoal);
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
                // Post-race there is no six-area analysis left to show: the radar
                // and the pillars stay down and the recap paragraph takes their
                // place. Demo mode never reaches loadAISummary, which is where the
                // real app fills this, so it is done here.
                if (demoPostRace.isPostRace) {
                    showRadarSkeleton(false);
                    showOverallInsightSkeleton(false);
                    loadRaceRecapProse(demoPostRace, raceGoal);
                    return;
                }
                renderRadarChart(getMockRadarData());
                renderPillars(getMockPillars());
                renderOverallInsight(getMockOverallInsight());
                // Demo mode never calls loadAISummary (which normally fills
                // this), so stamp the readiness "last updated" line here too.
                renderReadinessUpdated(new Date().toISOString());
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

        showOverlay();

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
            // Metrics runs FIRST and alone. It is the endpoint that
            // authenticates to Garmin and stocks the shared Redis cache; the
            // activities + mileage calls read from that cache. Firing all
            // three in parallel let the readers miss the still-empty cache and
            // each log into Garmin concurrently — tripping Garmin's rate limit
            // and rotating-token race, which surfaced as empty activities and
            // missing charts. Sequencing guarantees the cache is warm first.
            const metricsResp = await apiCallWithAuthRetry('GET', 'metrics');
            const metricsData = await metricsResp.json();
            if (metricsResp.ok && metricsData.metrics) {
                renderMetrics(metricsData.metrics);
                writeSWRCache(METRICS_CACHE_KEY, metricsData.metrics);
            } else if (metricsResp.status === 401) {
                // Genuine auth failure even after the silent retry — the
                // Garmin session is dead, so ask the runner to log in again.
                openLoginModal();
            }

            // Fetch the first batch of activities for both the overview
            // (5 latest) and the activities page (first 20). Charts use
            // this same batch and are never updated by pagination.
            const [activitiesResp, mileageResp] = await Promise.all([
                apiCallWithAuthRetry('GET', `activities?limit=${ACTIVITIES_PAGE_SIZE}&offset=0`),
                apiCallWithAuthRetry('GET', 'activities?mode=mileage&weeks=12'),
            ]);
            const activitiesData = await activitiesResp.json();
            const mileageData = await mileageResp.json();
            if (activitiesResp.ok && activitiesData.activities) {
                const acts = activitiesData.activities;
                // Store for the activities page pagination
                fullActivitiesLoaded = acts;
                activitiesLoaded = true;
                activitiesOffset = acts.length; // advance offset by count returned
                renderActivities(acts);
                // Charts use the initial batch only — never updated by "Load more"
                renderCalendar(acts);
                renderPaceDistribution(acts);
                renderHrPaceScatter(acts);
                // Show "Load more" button if we got a full page (more may exist)
                const loadMoreBtn = $('#pacey-load-more-activities');
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

        // The dashboard's core value is now on screen — the earliest sensible
        // moment to offer the "Add to Home Screen" instructions (the modal
        // itself waits an extra dwell, see maybeScheduleA2HS). Only reached on
        // the real (non-demo) path, so a cold demo visitor is never prompted.
        maybeScheduleA2HS();
    }

    // Fetch the next batch of activities for the activities page.
    // Appends to the existing list and advances the offset. Charts are
    // never affected — this only updates the activities page list.
    async function loadMoreActivities() {
        if (isLoadingMore) return;
        isLoadingMore = true;
        const loadMoreBtn = $('#pacey-load-more-activities');
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

    // Hand-drawn icons keyed by label. Each one points at a <symbol> in the
    // sprite at the top of index.html, so the same glyph is not inlined once
    // per tile. The class decides how it paints: plain .pacey-icon is a filled
    // ribbon glyph (Duma), .pacey-icon--stroke is an open-path one
    // (sketchyicons, which covers the three glyphs Duma has no equivalent for —
    // bed, battery and dumbbell).
    const METRIC_ICONS = {
        // Lungs — represents oxygen utilization capacity
        'VO₂max': '<svg class="pacey-icon"><use href="#pacey-icon-lungs"/></svg>',
        // Thumbs-up — represents how ready the body is to take on load
        'Readiness': '<svg class="pacey-icon"><use href="#pacey-icon-readiness-score"/></svg>',
        'Sleep': '<svg class="pacey-icon pacey-icon--stroke"><use href="#pacey-icon-sleep"/></svg>',
        'Body Battery': '<svg class="pacey-icon pacey-icon--stroke"><use href="#pacey-icon-battery"/></svg>',
        // Heartbeat trace — represents beat-to-beat variation
        'HRV': '<svg class="pacey-icon"><use href="#pacey-icon-hrv"/></svg>',
        'Resting HR': '<svg class="pacey-icon"><use href="#pacey-icon-heart"/></svg>',
        // Dumbbell — represents stress burden/pressure
        'Stress': '<svg class="pacey-icon pacey-icon--stroke"><use href="#pacey-icon-stress"/></svg>',
        'Recovery': '<svg class="pacey-icon"><use href="#pacey-icon-stopwatch"/></svg>',
        // Calendar — represents biological age relative to chronological age
        'Fitness Age': '<svg class="pacey-icon"><use href="#pacey-icon-calendar"/></svg>',
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
                { label: 'Poor', max: 35, color: '--pacey-accent-red' },
                { label: 'Fair', max: 45, color: '--pacey-accent-amber' },
                { label: 'Good', max: 55, color: '--pacey-blue' },
                { label: 'Excellent', max: 80, color: '--pacey-accent-green' },
            ],
            explanation: 'VO₂max measures the maximum volume of oxygen your body can utilize during intense exercise. Higher values indicate better aerobic capacity. Garmin classifies VO₂max using age and gender-specific tables from The Cooper Institute.',
        },
        'Readiness': {
            // Garmin official: Poor 1-24, Low 25-49, Moderate 50-74, High 75-94, Prime 95-100
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Poor', max: 24, color: '--pacey-accent-red' },
                { label: 'Low', max: 49, color: '--pacey-accent-amber' },
                { label: 'Moderate', max: 74, color: '--pacey-blue' },
                { label: 'High', max: 94, color: '--pacey-accent-green' },
                { label: 'Prime', max: 100, color: '--pacey-accent-purple' },
            ],
            explanation: 'Training Readiness Score combines sleep, recovery, stress, and training load to indicate how prepared your body is for a workout. Garmin uses 5 tiers: Poor (1-24), Low (25-49), Moderate (50-74), High (75-94), and Prime (95-100).',
        },
        'Sleep': {
            // Garmin official: Poor 0-59, Fair 60-79, Good 80-89, Excellent 90-100
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Poor', max: 59, color: '--pacey-accent-red' },
                { label: 'Fair', max: 79, color: '--pacey-accent-amber' },
                { label: 'Good', max: 89, color: '--pacey-blue' },
                { label: 'Excellent', max: 100, color: '--pacey-accent-green' },
            ],
            explanation: 'Sleep Score evaluates the quality and duration of your sleep based on movement, heart rate, and stress data. Garmin classifies sleep as Poor (0-59), Fair (60-79), Good (80-89), or Excellent (90-100).',
        },
        'Body Battery': {
            // Garmin official: Low 0-25, Medium 26-50, High 51-75, Very High 76-100
            min: 0, max: 100, unit: '%',
            zones: [
                { label: 'Low', max: 25, color: '--pacey-accent-red' },
                { label: 'Medium', max: 50, color: '--pacey-accent-amber' },
                { label: 'High', max: 75, color: '--pacey-blue' },
                { label: 'Very High', max: 100, color: '--pacey-accent-green' },
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
                { label: 'Low', max: 20, color: '--pacey-accent-red' },
                { label: 'Fair', max: 35, color: '--pacey-accent-amber' },
                { label: 'Good', max: 50, color: '--pacey-blue' },
                { label: 'Excellent', max: 100, color: '--pacey-accent-green' },
            ],
            // Garmin HRV status colors — used for card color-coding instead of zones
            statusColors: {
                'BALANCED': '--pacey-accent-green',
                'UNBALANCED': '--pacey-accent-amber',
                'LOW': '--pacey-accent-red',
                'POOR': '--pacey-accent-grey',
            },
            explanation: 'Heart Rate Variability (HRV) measures the variation in time between heartbeats. Garmin uses a personal baseline to classify HRV status as Balanced, Unbalanced, Low, or Poor rather than absolute ranges, since HRV varies widely by individual.',
        },
        'Resting HR': {
            min: 30, max: 90, unit: 'bpm',
            zones: [
                { label: 'High', max: 50, color: '--pacey-accent-green' },
                { label: 'Good', max: 60, color: '--pacey-blue' },
                { label: 'Fair', max: 70, color: '--pacey-accent-amber' },
                { label: 'Elevated', max: 90, color: '--pacey-accent-red' },
            ],
            explanation: 'Resting Heart Rate is your heart rate when fully at rest. Lower values generally indicate better cardiovascular fitness. A sudden increase may signal insufficient recovery or illness.',
        },
        'Stress': {
            // Garmin official: Rest 0-25, Low 26-50, Medium 51-75, High 76-100
            min: 0, max: 100, unit: '/100',
            zones: [
                { label: 'Rest', max: 25, color: '--pacey-accent-green' },
                { label: 'Low', max: 50, color: '--pacey-blue' },
                { label: 'Medium', max: 75, color: '--pacey-accent-amber' },
                { label: 'High', max: 100, color: '--pacey-accent-red' },
            ],
            explanation: 'Stress Level is derived from HRV, heart rate, and other body signals. Garmin classifies stress as Rest (0-25), Low (26-50), Medium (51-75), and High (76-100). Lower stress levels are better for recovery.',
        },
        'Recovery': {
            min: 0, max: 72, unit: 'hrs',
            zones: [
                { label: 'Ready', max: 6, color: '--pacey-accent-green' },
                { label: 'Short', max: 18, color: '--pacey-blue' },
                { label: 'Moderate', max: 36, color: '--pacey-accent-amber' },
                { label: 'Long', max: 72, color: '--pacey-accent-red' },
            ],
            explanation: 'Recovery Time estimates how long your body needs to fully recover from recent training before the next hard effort. Shorter times indicate you are ready for more training; longer times suggest you need more rest.',
        },
        'Fitness Age': {
            min: 15, max: 80, unit: 'years',
            zones: [
                { label: 'Young', max: 30, color: '--pacey-accent-green' },
                { label: 'Good', max: 40, color: '--pacey-blue' },
                { label: 'Average', max: 50, color: '--pacey-accent-amber' },
                { label: 'Older', max: 80, color: '--pacey-accent-red' },
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

        // Build zones array — Poor < Fair < Good < Excellent < Superior.
        // Zone colours are CSS token names resolved against the active theme
        // (same source as the METRIC_META fallback zones).
        const zones = [
            { label: 'Poor', max: table.Fair, color: '--pacey-accent-red' },
            { label: 'Fair', max: table.Good, color: '--pacey-accent-amber' },
            { label: 'Good', max: table.Excellent, color: '--pacey-blue' },
            { label: 'Excellent', max: table.Superior, color: '--pacey-accent-green' },
            { label: 'Superior', max: 100, color: '--pacey-accent-purple' },
        ];
        return zones.map(z => ({ ...z, color: cssVar(z.color, METRIC_ZONE_FALLBACKS[z.color] || z.color) }));
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
        const metricsDateEl = $('#pacey-metrics-date');
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
        // in a collapsible container (.pacey-metrics-extra > .pacey-metrics-extra-inner).
        // On desktop, both wrappers use display:contents so all tiles flow in
        // the parent grid as before. On mobile, the outer wrapper animates its
        // grid-template-rows from 0fr to 1fr for a smooth expand/collapse.
        const primaryTiles = tiles.slice(0, MOBILE_PRIMARY_VITALS);
        const extraTiles = tiles.slice(MOBILE_PRIMARY_VITALS);

        const renderTile = (t) => {
            const color = getMetricZoneColor(t.label, t.value);
            const valueStyle = color ? `style="color: ${color};"` : '';
            return `
            <div class="pacey-metric-tile" data-metric-label="${t.label}"
                 role="button" tabindex="0"
                 aria-label="${t.label}: ${t.value}${t.unit ? ' ' + t.unit : ''}. Select for details.">
                <div class="pacey-metric-top">
                    <span class="pacey-metric-icon">${METRIC_ICONS[t.label] || ''}</span>
                    <span class="pacey-metric-label">${t.label}</span>
                </div>
                <div class="pacey-metric-value-row">
                    <span class="pacey-metric-value" ${valueStyle}>${t.value}</span>
                    ${t.unit ? `<span class="pacey-metric-unit">${t.unit}</span>` : ''}
                </div>
            </div>`;
        };

        metricsGrid.innerHTML =
            primaryTiles.map(renderTile).join('') +
            `<div class="pacey-metrics-extra"><div class="pacey-metrics-extra-inner">` +
            extraTiles.map(renderTile).join('') +
            `</div></div>`;

        // Chevron disclosure toggle — mobile only. Toggles the --expanded
        // class on the grid to reveal/hide the extra tiles. Updates
        // aria-expanded for screen reader state and swaps the label text.
        const vitalsToggle = $('#pacey-vitals-show-more');
        if (vitalsToggle) {
            // Check if we're on a mobile viewport (matches the CSS breakpoint)
            const isMobile = window.matchMedia('(max-width: 30rem)').matches;
            vitalsToggle.hidden = !isMobile;
            // Reset to collapsed state on each render
            metricsGrid.classList.remove('pacey-metrics-grid--expanded');
            vitalsToggle.setAttribute('aria-expanded', 'false');
            const toggleLabel = vitalsToggle.querySelector('.pacey-vitals-toggle-label');
            if (toggleLabel) toggleLabel.textContent = 'More vitals';
            vitalsToggle.onclick = () => {
                const expanded = metricsGrid.classList.toggle('pacey-metrics-grid--expanded');
                vitalsToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                if (toggleLabel) toggleLabel.textContent = expanded ? 'Fewer vitals' : 'More vitals';
            };
        }

        // Attach click + keyboard handlers to each metric tile for the popup.
        // Keyboard: Enter and Space both trigger the same popup as a click.
        metricsGrid.querySelectorAll('.pacey-metric-tile').forEach(tile => {
            const openTile = () => {
                const label = tile.getAttribute('data-metric-label');
                const valueEl = tile.querySelector('.pacey-metric-value');
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

    const metricPopup = $('#pacey-metric-popup');
    const metricPopupContent = $('#pacey-metric-popup-content');
    const metricPopupClose = $('#pacey-metric-popup-close');

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
            <div class="pacey-gauge-legend-item${activeZone && activeZone.label === z.label ? ' pacey-gauge-legend-item--active' : ''}">
                <span class="pacey-gauge-legend-dot" style="background:${z.color}"></span>
                <span class="pacey-gauge-legend-text">${z.label}</span>
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
            <div class="pacey-gauge-bar">
                ${zoneSegments.map(zs => `
                    <div class="pacey-gauge-segment" style="left:${zs.leftPct}%; width:${zs.widthPct}%; background:${zs.color};"></div>
                `).join('')}
                ${markerPct !== null ? `<div class="pacey-gauge-marker" style="left:${markerPct}%;"></div>` : ''}
            </div>
            <div class="pacey-gauge-scale">
                <span class="pacey-gauge-scale-min">${meta.min}</span>
                <span class="pacey-gauge-scale-max">${meta.max} ${meta.unit}</span>
            </div>
        `;

        // Assemble the full popup content
        metricPopupContent.innerHTML = `
            <div class="pacey-metric-popup-header">
                <span class="pacey-metric-popup-icon">${METRIC_ICONS[label] || ''}</span>
                <h3 class="pacey-metric-popup-title">${label}</h3>
            </div>
            <div class="pacey-metric-popup-value-row">
                <span class="pacey-metric-popup-value">${currentValue !== null ? currentValue : '--'}</span>
                <span class="pacey-metric-popup-unit">${meta.unit}</span>
                ${activeZone ? `<span class="pacey-metric-popup-zone" style="background:${activeZone.color}">${activeZone.label}</span>` : ''}
            </div>
            <div class="pacey-gauge-section">
                ${gaugeBar}
                <div class="pacey-gauge-legend">${zoneLegend}</div>
            </div>
            <p class="pacey-metric-popup-explanation">${meta.explanation}</p>
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

    const scoreModal = $('#pacey-score-modal');
    const scoreModalClose = $('#pacey-score-modal-close');
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
    document.querySelectorAll('.pacey-score-info-btn').forEach(btn => {
        btn.addEventListener('click', openScoreModal);
    });

    // Dimensions explainer modal — explains the six radar dimensions.
    // Mirrors the scoring guide modal's open/close behaviour so both info
    // modals respond to the close button, overlay click, and Escape key.
    const dimensionModal = $('#pacey-dimension-modal');
    const dimensionModalClose = $('#pacey-dimension-modal-close');
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
    document.querySelectorAll('.pacey-dimension-info-btn').forEach(btn => {
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

    // Monday of the week a date key ('YYYY-MM-DD') falls in, at local midnight.
    // The plan calendar is laid out in Mon-Sun blocks, so anything that snaps a
    // date to a week has to use the same origin or the blocks drift off the grid.
    function mondayOfKey(key) {
        const d = parseDate(key + 'T00:00:00');
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return d;
    }

    // Pinboard theme helper — charts rendered inside the overview inherit the
    // handwriting faces from the scoped theme (via CSS custom properties on the
    // canvas); charts elsewhere fall back to the app's Raleway/Lato.
    function pinboardChartFonts(canvas) {
        const style = getComputedStyle(canvas);
        return {
            heading: style.getPropertyValue('--pacey-chart-heading-font').trim() || 'Raleway',
            body: style.getPropertyValue('--pacey-chart-body-font').trim() || 'Lato',
        };
    }

    // Chart.js paints tooltips straight onto the canvas and has no divider
    // option, so draw the rule ourselves after the tooltip renders — the same
    // hairline the calendar day tooltip uses under its heading. A tooltip with
    // no title (the scatter carries the run name in the body) gets its rule
    // under the first body line instead, so the name still reads as a heading.
    // Registered globally so every chart picks it up.
    const CHART_LINE_HEIGHT = 1.2;   // Chart.js's own font line-height factor
    const paceyTooltipDivider = {
        id: 'paceyTooltipDivider',
        afterDraw(chart) {
            const t = chart.tooltip;
            if (!t || !t.opacity || !t.title) return;
            const o = t.options || {};
            const pad = typeof o.padding === 'number' ? o.padding : (o.padding && o.padding.top) || 0;
            const titleSize = (o.titleFont && o.titleFont.size) || 12;
            const bodySize = (o.bodyFont && o.bodyFont.size) || 14;
            const hasTitle = t.title.length > 0;
            const titleSpacing = o.titleSpacing == null ? 2 : o.titleSpacing;
            const titleMarginBottom = o.titleMarginBottom == null ? 6 : o.titleMarginBottom;
            const bodySpacing = o.bodySpacing == null ? 2 : o.bodySpacing;
            // Chart.js stacks title lines with titleSpacing between them, so
            // the heading block is its lines plus those gaps. The rule then
            // sits in the gap that follows.
            //
            // The heading and body fonts differ in size, so their line boxes
            // leave different leading: measured on screen the heading leaves
            // ~5px below its glyphs while the body leaves ~2px above its own.
            // Offsetting by half the margin alone therefore pushes the rule
            // high — this trims that difference so the space reads even.
            const HEADING_LEADING_DIFF = 3;
            const ruleY = hasTitle
                ? t.y + pad + t.title.length * titleSize * CHART_LINE_HEIGHT
                    + (t.title.length - 1) * titleSpacing
                    + (titleMarginBottom - HEADING_LEADING_DIFF) / 2
                : t.y + pad + bodySize * CHART_LINE_HEIGHT + bodySpacing / 2;
            const ctx = chart.ctx;
            ctx.save();
            ctx.strokeStyle = o.borderColor || 'rgba(0, 0, 0, 0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            // Half-pixel offset keeps a 1px rule crisp instead of smeared
            // across two device pixels.
            const y = Math.round(ruleY) + 0.5;
            ctx.moveTo(t.x + pad, y);
            ctx.lineTo(t.x + t.width - pad, y);
            ctx.stroke();
            ctx.restore();
        },
    };
    if (window.Chart) window.Chart.register(paceyTooltipDivider);

    function renderMileageChart(weekData) {
        const canvas = document.getElementById('pacey-mileage-chart');
        if (!canvas) return;
        if (mileageChart) mileageChart.destroy();
        // Store week data for theme-change re-render
        lastMileageWeeks = weekData;
        const chartFonts = pinboardChartFonts(canvas);

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
        // Headroom above the tallest bar, so the tooltip has somewhere to sit
        // without covering the bars beneath it: round the peak up to the next
        // ten, then add one more ten. suggestedMax rather than max, so a week
        // taller than the computed value expands the scale instead of being
        // clipped by a hard ceiling.
        const suggestedMax = Math.ceil(maxVal / 10) * 10 + 10;

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

        // Read the chart colours from the canvas so they follow the surface the
        // chart actually sits on (paper) rather than the app's root theme
        const chartMuted = getComputedStyle(canvas).getPropertyValue('--pacey-muted').trim() || '#5a7184';
        const chartGridColor = getComputedStyle(canvas).getPropertyValue('--pacey-border').trim() || '#dce8f2';
        // Tooltip colors — adapt to theme
        const chartSurface = getComputedStyle(canvas).getPropertyValue('--pacey-surface').trim() || '#ffffff';
        const chartText = getComputedStyle(canvas).getPropertyValue('--pacey-text').trim() || '#1d3557';
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
                        borderColor: chartIsDark ? '#4a4034' : '#ddd0b6',
                        borderWidth: 1,
                        titleFont: { family: chartFonts.heading, size: 12 },
                        bodyFont: { family: chartFonts.body, size: 14 },
                        // Standardized tooltip properties — shared across all
                        // Chart.js tooltips so they look identical regardless
                        // of chart type (bar, scatter, etc.)
                        displayColors: false,
                        padding: 8,
                        cornerRadius: 3,
                        // Looser line spacing than Chart.js's defaults (2/6/2),
                        // which crowd the divider against the text.
                        titleSpacing: 4,
                        titleMarginBottom: 10,
                        bodySpacing: 10,
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
                        suggestedMax,
                        title: { display: true, text: 'km', font: { family: chartFonts.heading, size: 13 }, color: chartMuted },
                        ticks: { stepSize, font: { family: chartFonts.heading, size: 13 }, color: chartMuted, callback: v => Math.round(v) },
                        grid: { color: chartGridColor }
                    },
                    x: {
                        // autoSkip: false ensures all month labels are always shown,
                        // even when the chart container is narrow on certain screen sizes
                        ticks: { font: { family: chartFonts.heading, size: 13 }, color: chartMuted, maxRotation: 0, autoSkip: false },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    // =========================================================================
    // Activity calendar
    // =========================================================================

    // ---- Hand-drawn calendar dots ---------------------------------------
    // A day marker is drawn as an inline SVG so it reads like a circle
    // someone sketched and then coloured in with a pencil: a wobbly outline
    // plus a few hatch strokes. Wobble, hatch angle and stroke spacing are
    // seeded from the date, so every dot looks hand-made while a given day
    // keeps the same drawing across re-renders — a refresh must not make the
    // whole calendar twitch into a new arrangement.
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Geometry lives in a 24x24 box so the SVG scales to any dot size, and
    // stays inside the box so nothing spills past the dot's own footprint.
    // `hollow` draws just a faint sketched ring, for days with no run.
    function calendarDotSvg(colors, seed, hollow) {
        const rand = mulberry32(seed);
        const C = 12;      // centre
        const R = 8.3;     // nominal radius
        const uid = 'pcd' + seed;

        // Hand-drawn outline. Few points, each nudged radially and slightly
        // off-angle, plus a small centre offset — that gives a low-frequency
        // wobble like a real freehand circle, rather than high-frequency
        // bumpiness. The points are then smoothed into a closed curve
        // (Catmull-Rom), because straight segments read as a polygon.
        const steps = 9;
        const ox = (rand() - 0.5) * 0.7, oy = (rand() - 0.5) * 0.7;
        const pts = [];
        for (let i = 0; i < steps; i++) {
            const a = (i / steps) * Math.PI * 2 - Math.PI / 2 + (rand() - 0.5) * 0.11;
            const rr = R + (rand() - 0.5) * 1.0;
            pts.push([C + ox + Math.cos(a) * rr, C + oy + Math.sin(a) * rr]);
        }
        const at = (i) => pts[((i % steps) + steps) % steps];
        let outline = `M ${at(0)[0].toFixed(2)} ${at(0)[1].toFixed(2)}`;
        for (let i = 0; i < steps; i++) {
            const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
            outline += ` C ${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)},`
                + ` ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)},`
                + ` ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
        }
        outline += ' Z';

        // Pencil hatching: near-parallel strokes across the circle at an angle
        // that varies per dot, with per-stroke width and opacity jitter. All
        // of it is clipped to the outline, so the colour stays inside the line.
        const hatch = (color) => {
            const angle = (-34 + (rand() - 0.5) * 26) * Math.PI / 180;
            const nx = -Math.sin(angle), ny = Math.cos(angle);
            const tx = Math.cos(angle) * R, ty = Math.sin(angle) * R;
            const gap = (R * 2) / 4.2;
            let out = '';
            for (let i = 0; i < 4; i++) {
                const off = -R + gap * (i + 0.5) + (rand() - 0.5) * 0.7;
                const cx = C + nx * off, cy = C + ny * off;
                out += `<line x1="${(cx - tx).toFixed(2)}" y1="${(cy - ty).toFixed(2)}"`
                    + ` x2="${(cx + tx).toFixed(2)}" y2="${(cy + ty).toFixed(2)}"`
                    + ` stroke="${color}" stroke-width="${(1.5 + rand() * 0.7).toFixed(2)}"`
                    + ` stroke-linecap="round" opacity="${(0.5 + rand() * 0.25).toFixed(2)}"/>`;
            }
            return out;
        };

        const split = colors.length > 1;
        let defs = '', body = '';
        if (!hollow) {
            defs = `<clipPath id="${uid}"><path d="${outline}"/></clipPath>`
                + (split
                    ? `<clipPath id="${uid}L"><rect x="0" y="0" width="${C}" height="24"/></clipPath>`
                      + `<clipPath id="${uid}R"><rect x="${C}" y="0" width="${C}" height="24"/></clipPath>`
                    : '');
            // Two run types: left half in one colour, right half in the other.
            // The outer clip keeps everything inside the drawn circle; the
            // inner clips divide it, and nested clips intersect.
            body = split
                ? `<g clip-path="url(#${uid})">`
                    + `<rect x="0" y="0" width="${C}" height="24" fill="${colors[0]}" opacity="0.26"/>`
                    + `<rect x="${C}" y="0" width="${C}" height="24" fill="${colors[1]}" opacity="0.26"/>`
                    + `<g clip-path="url(#${uid}L)">${hatch(colors[0])}</g>`
                    + `<g clip-path="url(#${uid}R)">${hatch(colors[1])}</g>`
                  + `</g>`
                : `<g clip-path="url(#${uid})">`
                    + `<path d="${outline}" fill="${colors[0]}" opacity="0.26"/>`
                    + hatch(colors[0])
                  + `</g>`;
        }

        // The drawn line itself. A filled dot takes its own run colour as an
        // attribute; a hollow one gets a class so the stylesheet can supply a
        // theme-aware colour (presentation attributes can't hold var()).
        const line = hollow
            ? `<path d="${outline}" class="pacey-calendar-dot-stroke" fill="none"`
                + ` stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>`
            : `<path d="${outline}" fill="none" stroke="${colors[0]}" stroke-width="1.5"`
                + ` stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`;

        return `<svg class="pacey-calendar-dot-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
            + (defs ? `<defs>${defs}</defs>` : '') + body + line + '</svg>';
    }

    function renderCalendar(activities) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const today = now.getDate();

        // Update card title
        const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const cardTitle = calendarEl.closest('.pacey-chart-card')?.querySelector('.pacey-card-title');
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
        let html = '<div class="pacey-calendar-header">';
        dayNames.forEach(d => { html += `<span>${d}</span>`; });
        html += '</div><div class="pacey-calendar-grid">';

        // First day offset (0 = Sunday)
        const firstDay = new Date(year, month, 1).getDay();

        // Empty cells before 1st
        for (let i = 0; i < firstDay; i++) {
            html += '<span class="pacey-calendar-dot empty"></span>';
        }

        // Day dots — drawn as hand-sketched, pencil-coloured circles rather
        // than flat fills, so the calendar reads like a page someone marked
        // up. A day with two different run types is coloured in two halves.
        // data-day lets the click handler look up the day's runs for the
        // tooltip.
        for (let day = 1; day <= daysInMonth; day++) {
            const runs = dayRuns[day];
            const isToday = day === today;

            let cls = 'pacey-calendar-dot has-sketch';
            let inner = '';
            // One seed per date, so a day's plain ring and its coloured-in
            // version are the same drawn circle.
            const seed = year * 10000 + (month + 1) * 100 + day;
            if (runs) {
                cls += ' has-runs';
                // Distinct run types on this day (preserve first-seen order)
                const tags = [];
                runs.forEach(r => { if (!tags.includes(r.tag)) tags.push(r.tag); });
                const colors = tags.map(t => RUN_TAG_COLOR[t] || RUN_TAG_COLOR['Easy']);
                inner = calendarDotSvg(colors.slice(0, 2), seed, false);
            } else {
                // No run — a faint sketched ring, so the whole month reads as
                // hand-marked instead of a grid of stamped circles.
                inner = calendarDotSvg([], seed, true);
            }
            if (isToday) cls += ' today';

            const dataAttr = runs ? `data-day="${day}"` : '';
            html += `<span class="${cls}" ${dataAttr}>${inner}</span>`;
        }

        html += '</div>';
        calendarEl.innerHTML = html;

        // Wire click handlers on dots that have runs — show a tooltip
        // listing the day's runs (display-only, standardized styling).
        calendarEl.querySelectorAll('.pacey-calendar-dot.has-runs').forEach(dot => {
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                showCalendarTooltip(e.currentTarget, dayRuns, monthName);
            });
        });
    }

    // Calendar day tooltip — shown when a dot is clicked. Lists the runs
    // on that day (display-only, no navigation). Reuses a single DOM
    // element and the shared .pacey-chart-tooltip styling so it matches the
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
            calendarTooltipEl.className = 'pacey-chart-tooltip pacey-calendar-tooltip';
            document.body.appendChild(calendarTooltipEl);
        }

        // Bind dismiss handlers once — close when clicking outside, on
        // scroll, or on Escape so the tooltip never lingers stale.
        if (!calendarTooltipDismissBound) {
            calendarTooltipDismissBound = true;
            document.addEventListener('click', (e) => {
                if (!calendarTooltipEl) return;
                if (calendarTooltipEl.contains(e.target)) return;
                if (e.target && e.target.classList && e.target.classList.contains('pacey-calendar-dot')) return;
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
            <div class="pacey-calendar-tooltip-date">${monthShort} ${day}</div>
            ${runs.map(r => {
                const color = RUN_TAG_COLOR[r.tag] || RUN_TAG_COLOR['Easy'];
                const meta = `${r.distance} km · ${r.pace}/km${r.hr ? ' · ' + r.hr + ' bpm' : ''}`;
                return `
                    <div class="pacey-calendar-tooltip-run">
                        <span class="pacey-calendar-tooltip-run-dot" style="background:${color}"></span>
                        <span class="pacey-calendar-tooltip-run-text">
                            <span class="pacey-calendar-tooltip-run-name">${escapeHtml(r.name)}</span>
                            <span class="pacey-calendar-tooltip-run-meta">${meta}</span>
                        </span>
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
        if (!activities.length) return '<p class="pacey-metric-label">No activities found.</p>';

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
            ${showMonthHeader ? `<div class="pacey-activity-month-header">
                <span class="pacey-activity-month-name">${group.month} ${group.year}</span>
                ${showMonthTotal ? `<span class="pacey-activity-month-total">${Math.round(group.totalKm)} km</span>` : ''}
            </div>` : ''}
            ${group.activities.map(({ activity, originalIndex }) => buildActivityItem(activity, originalIndex)).join('')}
        `).join('');
    }

    function renderActivities(activities) {
        // Filter out non-running activities (hiking, cycling, etc.) — only show runs
        const runningOnly = activities.filter(isRunningActivity);
        if (!runningOnly.length) {
            activitiesList.innerHTML = '<p class="pacey-metric-label">No recent activities found.</p>';
            if (activitiesFull) activitiesFull.innerHTML = '<p class="pacey-metric-label">No activities found.</p>';
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
    // Toggles the .open class on the parent .pacey-activity-item and updates
    // aria-expanded so screen readers announce the expanded/collapsed state.
    function attachActivityHeaderHandlers(container) {
        container.querySelectorAll('.pacey-activity-header').forEach(header => {
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

    // Activity icons — all from Tabler Icons (MIT-licensed, 24×24 grid, 2px
    // stroke). Only activity types in the allowed set have icons; unmapped
    // types fall back to the running icon.
    // Sources: https://tabler.io/icons

    // Running — Tabler "run" icon
    const RUNNING_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M4 17l5 1l.75 -1.5"/><path d="M15 21l0 -4l-4 -3l1 -6"/><path d="M7 12l0 -3l5 -1l3 3l3 1"/></svg>';

    // Trail running — Tabler "run" + "mountain" ridge line at 50% opacity
    const TRAIL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M4 17l5 1l.75 -1.5"/><path d="M15 21l0 -4l-4 -3l1 -6"/><path d="M7 12l0 -3l5 -1l3 3l3 1"/><path d="M3 20h18l-6.921 -14.612a2.3 2.3 0 0 0 -4.158 0l-6.921 14.612" stroke-width="1.5" opacity="0.5"/></svg>';

    // Strength training — Tabler "barbell" icon
    const STRENGTH_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h1"/><path d="M6 8h-2a1 1 0 0 0 -1 1v6a1 1 0 0 0 1 1h2"/><path d="M6 7v10a1 1 0 0 0 1 1h1a1 1 0 0 0 1 -1v-10a1 1 0 0 0 -1 -1h-1a1 1 0 0 0 -1 1"/><path d="M9 12h6"/><path d="M15 7v10a1 1 0 0 0 1 1h1a1 1 0 0 0 1 -1v-10a1 1 0 0 0 -1 -1h-1a1 1 0 0 0 -1 1"/><path d="M18 8h2a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-2"/><path d="M22 12h-1"/></svg>';

    // Hiking / walking — Tabler "walk" icon
    const HIKING_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M7 21l3 -4"/><path d="M16 21l-2 -4l-3 -3l1 -6"/><path d="M6 12l2 -3l4 -1l3 3l3 1"/></svg>';

    // Map Garmin typeKey → icon. Only allowed activity types are listed;
    // unmapped types fall back to the running icon.
    const ACTIVITY_ICONS = {
        'running': RUNNING_ICON_SVG,
        'trail_running': TRAIL_ICON_SVG,
        'track_running': RUNNING_ICON_SVG,
        'treadmill_running': RUNNING_ICON_SVG,
        'virtual_run': RUNNING_ICON_SVG,
        'strength_training': STRENGTH_ICON_SVG,
        'hiit': STRENGTH_ICON_SVG,
        'indoor_cardio': STRENGTH_ICON_SVG,
        'fitness_equipment': STRENGTH_ICON_SVG,
        'hiking': HIKING_ICON_SVG,
        'rucking': HIKING_ICON_SVG,
        'walking': HIKING_ICON_SVG,
    };

    function getActivityIcon(type) {
        const t = (type || 'running').toLowerCase();
        return ACTIVITY_ICONS[t] || RUNNING_ICON_SVG;
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
    function computeGoalPaceMs(goal) {
        if (!goal || !goal.time_target) return 0;
        const distKm = goalDistanceKm(goal);
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
    // Run type → CSS class. Non-running tags use a neutral grey style so
    // they're visually distinct from run-specific tags.
    const RUN_TAG_CLASS = {
        'Run': 'pacey-run-tag--easy',
        'Warmup': 'pacey-run-tag--warmup',
        'Tempo Long': 'pacey-run-tag--tempo-long',
        'Tempo': 'pacey-run-tag--tempo-long',
        'LSD': 'pacey-run-tag--lsd',
        'Speedwork': 'pacey-run-tag--speedwork',
        'Easy': 'pacey-run-tag--easy',
        'Strength': 'pacey-run-tag--cross-train',
        'HIIT': 'pacey-run-tag--cross-train',
        'Cardio': 'pacey-run-tag--cross-train',
        'Hike': 'pacey-run-tag--cross-train',
        'Walk': 'pacey-run-tag--cross-train',
        'Ruck': 'pacey-run-tag--cross-train',
    };

    // Run type → dot fill colour. Reads the tokenised CSS custom properties
    // (--pacey-run-*) so calendar dots match the run-tag colours and respect
    // dark mode automatically. Falls back to hardcoded hex if the token is
    // missing (e.g. older browsers without CSS variable support).
    // Resolve against #pacey-content (the pinboard scope) so the paper-context
    // token values are picked up on the dashboard.
    const cssVar = (name, fallback) =>
        getComputedStyle(document.getElementById('pacey-content') || document.documentElement).getPropertyValue(name).trim() || fallback;
    const RUN_TAG_COLOR = {
        'Run': cssVar('--pacey-run-easy', '#388e8e'),
        'Easy': cssVar('--pacey-run-easy', '#388e8e'),
        'Warmup': cssVar('--pacey-run-warmup', '#7a7a7a'),
        'Tempo Long': cssVar('--pacey-run-tempo', '#8a6313'),
        'Tempo': cssVar('--pacey-run-tempo', '#8a6313'),
        'LSD': cssVar('--pacey-run-lsd', '#5d6db0'),
        'Speedwork': cssVar('--pacey-run-speedwork', '#c44b4b'),
        // Non-running activities share a neutral colour
        'Strength': cssVar('--pacey-run-cross-train', '#8a8a8a'),
        'HIIT': cssVar('--pacey-run-cross-train', '#8a8a8a'),
        'Cardio': cssVar('--pacey-run-cross-train', '#8a8a8a'),
        'Hike': cssVar('--pacey-run-cross-train', '#8a8a8a'),
        'Walk': cssVar('--pacey-run-cross-train', '#8a8a8a'),
        'Ruck': cssVar('--pacey-run-cross-train', '#8a8a8a'),
    };

    // Metric zone colours — METRIC_META defines zones with CSS token names
    // (--pacey-accent-*) instead of hex so the gauges and card value colours
    // follow the active theme, same as RUN_TAG_COLOR and the radar chart.
    // Fallbacks are the light-theme hex values; resolveMetricZoneColors()
    // patches the zone colours in place and is re-run on theme toggle.
    const METRIC_ZONE_FALLBACKS = {
        '--pacey-accent-red': '#c44b4b',
        '--pacey-accent-amber': '#d4a017',
        '--pacey-accent-green': '#3f7b4f',
        '--pacey-accent-purple': '#9b6dd0',
        '--pacey-accent-grey': '#999999',
        '--pacey-blue': '#457b9d',
    };
    const resolveMetricZoneColors = () => {
        // cssVar now resolves against the pinboard paper context, so the metric
        // marks stay dark-on-light even in dark mode (the post-its stay light).
        Object.values(METRIC_META).forEach(meta => {
            (meta.zones || []).forEach(zone => {
                if (typeof zone.color === 'string' && zone.color.startsWith('--')) {
                    zone.color = cssVar(zone.color, METRIC_ZONE_FALLBACKS[zone.color] || zone.color);
                }
            });
            if (meta.statusColors) {
                Object.keys(meta.statusColors).forEach(key => {
                    const color = meta.statusColors[key];
                    if (typeof color === 'string' && color.startsWith('--')) {
                        meta.statusColors[key] = cssVar(color, METRIC_ZONE_FALLBACKS[color] || color);
                    }
                });
            }
        });
    };
    resolveMetricZoneColors();

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
            className: RUN_TAG_CLASS[runTagLabel] || 'pacey-run-tag--easy',
        };

        return `
            <div class="pacey-activity-item" data-index="${i}" data-activity-id="${a.id != null ? a.id : ''}">
                <div class="pacey-activity-header" role="button" tabindex="0" aria-expanded="false"
                     aria-label="${escapeHtml(a.name)} on ${date}, ${a.distance} km at ${pace} per km. Select to expand details.">
                    <div class="pacey-activity-summary">
                        <div class="pacey-activity-icon">${iconSvg}</div>
                        <span class="pacey-activity-name">${escapeHtml(a.name)}</span>
                        <span class="pacey-activity-date">${date}</span>
                        <span class="pacey-run-tag ${runTag.className}">${runTag.label}</span>
                    </div>
                    <div class="pacey-activity-meta">
                        <div class="pacey-activity-stat">
                            <span class="pacey-activity-stat-value">${a.distance}</span>
                            <span class="pacey-activity-stat-label">km</span>
                        </div>
                        <div class="pacey-activity-stat">
                            <span class="pacey-activity-stat-value">${pace}</span>
                            <span class="pacey-activity-stat-label">/km pace</span>
                        </div>
                        <div class="pacey-activity-stat">
                            <span class="pacey-activity-stat-value">${hr}</span>
                            <span class="pacey-activity-stat-label">avg HR</span>
                        </div>
                        <div class="pacey-activity-stat">
                            <span class="pacey-activity-stat-value">${ascent}</span>
                            <span class="pacey-activity-stat-label">ascent</span>
                        </div>
                    </div>
                    <svg class="pacey-activity-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
                <div class="pacey-activity-detail">
                    <div class="pacey-activity-detail-grid">
                        <div class="pacey-activity-detail-item">
                            <span class="pacey-activity-detail-label">Duration</span>
                            <span class="pacey-activity-detail-value">${formatDuration(a.duration)}</span>
                        </div>
                        <div class="pacey-activity-detail-item">
                            <span class="pacey-activity-detail-label">Elapsed</span>
                            <span class="pacey-activity-detail-value">${elapsed}</span>
                        </div>
                        <div class="pacey-activity-detail-item">
                            <span class="pacey-activity-detail-label">Calories</span>
                            <span class="pacey-activity-detail-value">${a.calories || '--'}</span>
                        </div>
                        <div class="pacey-activity-detail-item">
                            <span class="pacey-activity-detail-label">Max HR</span>
                            <span class="pacey-activity-detail-value">${a.max_hr ? a.max_hr + ' bpm' : '--'}</span>
                        </div>
                        <div class="pacey-activity-detail-item">
                            <span class="pacey-activity-detail-label">Cadence</span>
                            <span class="pacey-activity-detail-value">${cadence}</span>
                        </div>
                        <div class="pacey-activity-detail-item">
                            <span class="pacey-activity-detail-label">Ascent</span>
                            <span class="pacey-activity-detail-value">${ascent}</span>
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
        div.textContent = str == null ? '' : String(str);
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
        const canvas = document.getElementById('pacey-pace-distribution-chart');
        if (!canvas || !activities.length) return;
        if (paceDistChart) paceDistChart.destroy();
        // Store activities for theme-change re-render
        lastPaceDistActivities = activities;
        const chartFonts = pinboardChartFonts(canvas);

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

        // Read colours from the canvas so labels follow the paper surface
        const chartMuted = getComputedStyle(canvas).getPropertyValue('--pacey-muted').trim() || '#5a7184';
        const chartGridColor = getComputedStyle(canvas).getPropertyValue('--pacey-border').trim() || '#dce8f2';
        // Standardized theme-aware tooltip colours — shared with the weekly
        // mileage, HR vs pace, and calendar tooltips so all charts match.
        const chartSurface = getComputedStyle(canvas).getPropertyValue('--pacey-surface').trim() || '#ffffff';
        const chartText = getComputedStyle(canvas).getPropertyValue('--pacey-text').trim() || '#1d3557';
        const chartIsDark = document.documentElement.getAttribute('data-theme') === 'dark';

        // Update the card title to reflect the number of activities analysed
        const paceTitleEl = canvas.closest('.pacey-chart-card')?.querySelector('.pacey-card-title');
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
                        borderColor: chartIsDark ? '#4a4034' : '#ddd0b6',
                        borderWidth: 1,
                        titleFont: { family: chartFonts.heading, size: 12 },
                        bodyFont: { family: chartFonts.body, size: 14 },
                        displayColors: false,
                        padding: 8,
                        cornerRadius: 3,
                        // Looser line spacing than Chart.js's defaults (2/6/2),
                        // which crowd the divider against the text.
                        titleSpacing: 4,
                        titleMarginBottom: 10,
                        bodySpacing: 10,
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
                        title: { display: true, text: 'Pace (min/km)', font: { family: chartFonts.heading, size: 11 }, color: chartMuted },
                        ticks: { font: { family: chartFonts.heading, size: 10 }, color: chartMuted }
                    },
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: 'Total Distance (km)', font: { family: chartFonts.heading, size: 11 }, color: chartMuted },
                        ticks: { font: { family: chartFonts.heading, size: 10 }, color: chartMuted, callback: v => Math.round(v) },
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
        const canvas = document.getElementById('pacey-hr-pace-scatter');
        if (!canvas || !activities.length) return;
        if (hrPaceScatter) hrPaceScatter.destroy();
        // Store activities for theme-change re-render
        lastHrPaceActivities = activities;
        const chartFonts = pinboardChartFonts(canvas);

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

        // Read colours from the canvas so labels follow the paper surface
        const chartMuted = getComputedStyle(canvas).getPropertyValue('--pacey-muted').trim() || '#5a7184';
        const chartGridColor = getComputedStyle(canvas).getPropertyValue('--pacey-border').trim() || '#dce8f2';
        // Standardized theme-aware tooltip colours — shared across all charts
        const chartSurface = getComputedStyle(canvas).getPropertyValue('--pacey-surface').trim() || '#ffffff';
        const chartText = getComputedStyle(canvas).getPropertyValue('--pacey-text').trim() || '#1d3557';
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
                        borderColor: chartIsDark ? '#4a4034' : '#ddd0b6',
                        borderWidth: 1,
                        titleFont: { family: chartFonts.heading, size: 12 },
                        bodyFont: { family: chartFonts.body, size: 14 },
                        displayColors: false,
                        padding: 8,
                        cornerRadius: 3,
                        // Looser line spacing than Chart.js's defaults (2/6/2),
                        // which crowd the divider against the text. The scatter
                        // has no title, so bodySpacing does the work there.
                        titleSpacing: 4,
                        titleMarginBottom: 10,
                        bodySpacing: 10,
                        callbacks: {
                            // Returning an array puts the run name on its own
                            // line, with the numbers beneath it.
                            label: (ctx) => {
                                const p = scatterData[ctx.dataIndex];
                                const paceStr = `${Math.floor(p.x)}:${String(Math.round((p.x % 1) * 60)).padStart(2, '0')}/km`;
                                const dateStr = p.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                return [
                                    p.name || 'Run',
                                    `${paceStr} · ${p.y} bpm · ${p.distance}km · ${dateStr}`,
                                ];
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
                        title: { display: true, text: 'Pace (min/km)', font: { family: chartFonts.heading, size: 13 }, color: chartMuted },
                        ticks: { font: { family: chartFonts.heading, size: 13 }, color: chartMuted },
                        grid: { color: chartGridColor },
                        // Reverse so faster paces (lower min/km) are on the left
                        reverse: true,
                    },
                    y: {
                        title: { display: true, text: 'Avg Heart Rate (bpm)', font: { family: chartFonts.heading, size: 13 }, color: chartMuted },
                        ticks: { font: { family: chartFonts.heading, size: 13 }, color: chartMuted },
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
        radarHex('--pacey-run-speedwork', '#c44b4b'),  // lactate threshold — red
        radarHex('--pacey-accent-green', '#3f7b4f'),   // aerobic endurance — green
        radarHex('--pacey-run-tempo', '#8a6313'),      // running economy — amber
        radarHex('--pacey-run-lsd', '#5d6db0'),        // strength/durability — purple
        radarHex('--pacey-blue', '#457b9d'),           // vo2max/speed — blue
        radarHex('--pacey-run-easy', '#388e8e'),       // fatigue resistance — teal
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
        let tooltipEl = document.getElementById('pacey-radar-tooltip');
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'pacey-radar-tooltip';
            tooltipEl.className = 'pacey-radar-tooltip';
            document.body.appendChild(tooltipEl);
        }

        const dimName = RADAR_DIMENSIONS[dimIndex] || 'Unknown';
        const score = radarValues10[dimIndex] !== undefined ? radarValues10[dimIndex] : '--';

        tooltipEl.innerHTML = `
            <a class="pacey-radar-tooltip-link" href="#" data-pillar-index="${dimIndex}">
                ${escapeHtml(dimName)}
            </a>
            <span class="pacey-radar-tooltip-score">${score}/10</span>
        `;

        // Wire up the link click — same as in the external handler
        const link = tooltipEl.querySelector('.pacey-radar-tooltip-link');
        if (link) {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const idx = parseInt(link.getAttribute('data-pillar-index'));
                const visiblePage = document.querySelector('.pacey-page:not([hidden])');
                if (!visiblePage) return;
                const pillar = visiblePage.querySelector(
                    `.pacey-pillars-content .pacey-pillar-card[data-pillar-index="${idx}"]`
                );
                if (pillar) {
                    pillar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    pillar.classList.add('pacey-pillar-highlight');
                    setTimeout(() => pillar.classList.remove('pacey-pillar-highlight'), 2000);
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
        let tooltipEl = document.getElementById('pacey-radar-tooltip');

        // Create the tooltip container on first use
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'pacey-radar-tooltip';
            tooltipEl.className = 'pacey-radar-tooltip';
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
                <a class="pacey-radar-tooltip-link" href="#readiness" data-pillar-index="${dimIndex}">
                    ${escapeHtml(dimName)}
                </a>
                <span class="pacey-radar-tooltip-score">${score}/10</span>
            `;

            // Wire up the link click — scroll to the corresponding pillar card
            // within the currently visible page's pillars container.
            // Uses data-pillar-index attribute to find the right card.
            const link = tooltipEl.querySelector('.pacey-radar-tooltip-link');
            if (link) {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const idx = parseInt(link.getAttribute('data-pillar-index'));
                    // Find the pillar card on the currently visible page —
                    // query within the visible page's pillars container only
                    const visiblePage = document.querySelector('.pacey-page:not([hidden])');
                    if (!visiblePage) return;
                    const pillar = visiblePage.querySelector(
                        `.pacey-pillars-content .pacey-pillar-card[data-pillar-index="${idx}"]`
                    );
                    if (pillar) {
                        pillar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // Briefly highlight the card so the user notices it
                        pillar.classList.add('pacey-pillar-highlight');
                        setTimeout(() => pillar.classList.remove('pacey-pillar-highlight'), 2000);
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

    // Radar canvases that are actually laid out. A canvas inside a hidden page
    // measures 0x0, and a chart drawn at that size produces NaN coordinates —
    // rough.js then throws on every frame trying to parse the path.
    function radarCanvasesToRender() {
        return Array.from(document.querySelectorAll('.pacey-radar-chart'))
            .filter(canvas => canvas.clientWidth > 0);
    }

    // Normalize a dimension name for fuzzy matching:
    // lowercase, remove special chars (subscripts, slashes, spaces, hyphens)
    function normalizeRadarName(s) {
        return s.toLowerCase().replace(/[₂₃₁₀]/g, m => ({'₂':'2','₃':'3','₁':'1','₀':'0'}[m])).replace(/[^a-z0-9]/g, '');
    }

    // Build values in RADAR_DIMENSIONS order, using normalized lookup so
    // "VO₂max / Speed" matches "VO2max / Speed" etc. Scores are integers 0–10
    // (the AI prompt disallows decimals) — round to whole numbers so no
    // fractional scores ever render on the chart. Shared by the page radars and
    // the readiness-review modal so both plot the same data.
    function radarValuesFromData(aiData) {
        // AI radar returns dimensions as [{name, score, note}] with 0-10 scores
        // and may use slightly different names (e.g. "VO2max" vs "VO₂max"), so
        // the lookup is normalized rather than exact.
        const dims = aiData.dimensions || [];
        // Build a normalized score map so "VO₂max / Speed" matches "VO2max / Speed" etc.
        const scoreMap = {};
        dims.forEach(d => {
            scoreMap[normalizeRadarName(d.name)] = d.score;
        });
        return RADAR_DIMENSIONS.map(name => {
            const score = scoreMap[normalizeRadarName(name)];
            return score !== undefined ? Math.round(score) : 0;
        });
    }

    function renderRadarChart(aiData) {        // Store last radar data so charts can be re-rendered on theme change
        lastRadarData = aiData;
        // Map the AI dimension names to the chart's expected order (see
        // radarValuesFromData).
        const values10 = radarValuesFromData(aiData);
        // Stand-in scores must never reach the tooltip, or it would report a
        // made-up number as the runner's reading.
        if (!radarLoading) radarValues10 = values10;
        radarLabels = RADAR_DIMENSIONS;

        // Destroy any existing chart instances before re-creating
        radarCharts.forEach(c => c.destroy());
        radarCharts = [];

        // Create a Chart instance for each radar canvas (overview + readiness).
        // Only canvases that have been laid out get one: the readiness radar
        // sits inside a display:none page at load, so its canvas measures 0x0,
        // and drawing a chart at zero size yields NaN coordinates. Canvas
        // silently ignored those; rough.js does not — it throws on every frame,
        // which is how this surfaced. navigateTo() calls back in once a page is
        // shown, so the hidden radar still gets its chart on first visit.
        radarCanvasesToRender().forEach(canvas => {
            radarCharts.push(buildRadarChart(canvas, values10));
        });
    }

    // Build one radar chart on a laid-out canvas. Extracted from renderRadarChart
    // so the readiness-review modal can draw its own radar without joining
    // radarCharts — a chart on that page list would be torn down by any
    // re-render of the pages, which the modal is not part of.
    function buildRadarChart(canvas, values10) {
        // Reset the loaded class so the canvas starts at opacity 0,
        // then add it after the chart is created to trigger the fade-in
        canvas.classList.remove('pacey-radar-loaded');
        // Read colours from the canvas so the radar follows the surface it
        // sits on (paper on the overview, app surface on Readiness)
        const cssNavy = getComputedStyle(canvas).getPropertyValue('--pacey-navy').trim() || '#1d3557';
        const cssMuted = getComputedStyle(canvas).getPropertyValue('--pacey-muted').trim() || '#5a7184';
        const cssBlue = getComputedStyle(canvas).getPropertyValue('--pacey-blue').trim() || '#457b9d';
        // Tooltip background — use surface color so it adapts to theme
        const cssSurface = getComputedStyle(canvas).getPropertyValue('--pacey-surface').trim() || '#ffffff';
        const cssText = getComputedStyle(canvas).getPropertyValue('--pacey-text').trim() || '#1d3557';
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        // On narrow screens (phone), use a smaller point label font to prevent clipping.
        // The canvas width determines whether we're in a compact layout.
        const isNarrow = canvas.clientWidth < 320;
        const pointLabelFontSize = isNarrow ? 11 : 13;
        const chartFonts = pinboardChartFonts(canvas);

        const chart = new Chart(canvas, {
            type: 'radar',
            data: {
                labels: RADAR_DIMENSIONS,
                datasets: [{
                    data: values10,
                    backgroundColor: radarLoading ? RADAR_LOADING_FILL : `rgba(69, 123, 157, 0.1)`,
                    borderColor: radarLoading ? RADAR_LOADING_LINE : `rgba(69, 123, 157, 0.8)`,
                    borderWidth: 2,
                    pointBackgroundColor: radarLoading ? RADAR_LOADING_POINT : RADAR_COLORS,
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
                            font: { size: pointLabelFontSize, family: chartFonts.heading, weight: '600' },
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
        });

        // Trigger the canvas fade-in after Chart.js has rendered.
        // requestAnimationFrame ensures the initial paint at opacity 0
        // happens before we add the loaded class, so the transition fires.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                canvas.classList.add('pacey-radar-loaded');
            });
        });
        return chart;
    }

    // =========================================================================
    // Stale-while-revalidate cache for metrics + weekly mileage
    // Renders cached data instantly on page load, then fetches fresh data
    // from the API in the background and re-renders if it changed. Cache
    // is scoped by session token so different users never cross-pollute.
    // =========================================================================

    const METRICS_CACHE_KEY = 'pacey_metrics_cache';
    const MILEAGE_CACHE_KEY = 'pacey_mileage_cache';
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

    const AI_CACHE_KEY = 'pacey_ai_radar_cache_v2';
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

    // The AI cache entry's own timestamp (ms). Fallback for the readiness
    // "last updated" line when the cached payload predates generated_at being
    // surfaced from the server.
    function readAICacheTimestamp() {
        try {
            const raw = localStorage.getItem(AI_CACHE_KEY);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (entry.key !== getAICacheKey()) return null;
            return entry.timestamp || null;
        } catch (e) {
            return null;
        }
    }

    // Clear the AI cache (called when user clicks "Regenerate Insights")
    function clearAICache() {
        localStorage.removeItem(AI_CACHE_KEY);
    }

    // Format the readiness "last updated" line from the AI cache's
    // generated_at timestamp. Mirrors the "Last Garmin sync" wording so the two
    // read consistently. Hidden when the timestamp is missing (e.g. an old
    // cached payload written before generated_at was surfaced).
    function renderReadinessUpdated(iso) {
        if (!readinessUpdatedEl) return;
        const d = iso ? new Date(iso) : null;
        if (!d || isNaN(d.getTime())) { readinessUpdatedEl.hidden = true; return; }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const that = new Date(d);
        that.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const isToday = that.getTime() === today.getTime();
        const isYesterday = that.getTime() === yesterday.getTime();
        const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const dateStr = isToday ? 'today'
            : isYesterday ? 'yesterday'
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        readinessUpdatedEl.textContent = `Last updated: ${dateStr}, ${timeStr}`;
        readinessUpdatedEl.hidden = false;
    }

    async function loadAISummary(forceRefresh = false) {
        // Post-race the six-area analysis has nothing left to measure: it scores
        // fitness toward a race that has already happened. The recap takes its
        // place and the AI call is skipped entirely. This is the single place the
        // decision is made, so pressing Refresh cannot resurrect the analysis —
        // and it runs before any cache read, so a cached pre-race payload cannot
        // repaint the radar either.
        const postRace = postRaceState(raceGoal, fullActivitiesLoaded);
        applyRaceRecapMode(postRace, raceGoal);
        if (postRace.isPostRace) {
            showRadarSkeleton(false);
            pillarsContents.forEach(el => el.hidden = true);
            loadRaceRecapProse(postRace, raceGoal);
            return;
        }

        if (forceRefresh) clearAICache();

        // Check cache first — if valid, render immediately without API call
        const cached = !forceRefresh ? readAICache() : null;
        if (cached) {
            try {
                showRadarSkeleton(false);
                renderRadarChart(cached);
                renderPillars(cached);
                renderReadinessUpdated(cached.generated_at || readAICacheTimestamp());
                // Use the AI-provided overall insight if present; fall back to
                // deriveOverallInsight for cached responses from before the
                // overall field was added to the API response, or when the
                // cached overall object is missing topStrength/topGap.
                renderOverallInsight(normalizeOverallInsight(cached.overall, cached));
                // Hide the regenerate button in demo mode — there's no real AI
                // call to refresh, so the action is meaningless for demo users.
                refreshAnalysisBtn.hidden = window.__demoMode;
                return;
            } catch (err) {
                console.error('Failed to render cached insights:', err);
                clearAICache();
            }
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
                // Show the coach-language fallback, not the raw server error
                // (which can contain implementation details like API keys).
                console.warn('Insights request failed:', data.error || resp.status);
                summaryErrors.forEach(el => {
                    el.textContent = 'Failed to load insights.';
                    el.hidden = false;
                });
                pillarsContents.forEach(el => el.hidden = true);
                refreshAnalysisBtn.hidden = window.__demoMode;
                return;
            }
            // Cache complete responses only — a truncated payload (one
            // pillar) would otherwise stick in localStorage for 24 hours.
            const realDims = (data.dimensions || []).filter(d => d && d.summary);
            if (realDims.length >= 6) writeAICache(data);
            // Render both the radar chart and the insight text from the same AI data
            showRadarSkeleton(false);
            renderRadarChart(data);
            renderPillars(data);
            renderReadinessUpdated(data.generated_at);
            // Use the AI-provided overall insight; fall back to client-side
            // derivation if the API response doesn't include it or is incomplete.
            renderOverallInsight(normalizeOverallInsight(data.overall, data));
        } catch (err) {
            showRadarSkeleton(false);
            summaryErrors.forEach(el => {
                el.textContent = 'Network error. Please try again.';
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
        // Toggle the skeleton overlays FIRST so a failure in the chart
        // teardown below can never leave the radar area blank.
        document.querySelectorAll('.pacey-radar-skeleton').forEach(el => {
            // A previous hide may never have completed its transition — the
            // skeleton sat inside a display:none page (e.g. the readiness
            // page during the initial overview load), so transitionend never
            // fired and its listener + fade-out class are still attached.
            // Remove that stale handler now, or it would fire at the end of
            // this show's fade-in and re-hide the skeleton.
            if (el._paceyFadeHandler) {
                el.removeEventListener('transitionend', el._paceyFadeHandler);
                el._paceyFadeHandler = null;
            }
            if (show) {
                el.classList.remove('pacey-fade-out');
                el.hidden = false;
            } else {
                el.classList.add('pacey-fade-out');
                const onFadeEnd = () => {
                    el.hidden = true;
                    el.classList.remove('pacey-fade-out');
                    el.removeEventListener('transitionend', onFadeEnd);
                    el._paceyFadeHandler = null;
                    clearTimeout(fadeTimer);
                };
                el._paceyFadeHandler = onFadeEnd;
                // Fallback: transitionend may never fire inside a hidden
                // container — force-hide after the fade window either way,
                // so no stale fade-out state survives for the next show.
                const fadeTimer = setTimeout(onFadeEnd, 500);
                el.addEventListener('transitionend', onFadeEnd);
            }
        });
        if (show) {
            // Best-effort teardown — the label is already visible, so a
            // failure here cannot leave a blank radar area.
            try {
                radarCharts.forEach(c => c.destroy());
                radarCharts = [];
                // Reset the canvas opacity so it can fade in again when the
                // placeholder chart is created
                document.querySelectorAll('.pacey-radar-chart').forEach(canvas => {
                    canvas.classList.remove('pacey-radar-loaded');
                });
                startRadarLoading();
            } catch (err) {
                console.error('Radar teardown error during refresh:', err);
                radarCharts = [];
            }
        } else {
            stopRadarLoading();
        }
    }

    // Radar loading placeholder. Rather than a separate SVG skeleton, the real
    // radar is rendered early with stand-in scores and handed new ones on a
    // timer. Chart.js tweens between data sets, so the polygon warps using the
    // library's own animation — no per-frame loop — and it is drawn by the same
    // rough.js pass as the finished chart, so placeholder and result are the
    // same object rather than two things that have to look alike.
    //
    // Two things keep it honest: the styling runs desaturated while loading,
    // and the "Analysing your readiness…" label stays up. A glance should never
    // mistake a placeholder polygon for a real reading.
    let radarLoading = false;
    let radarLoadingTimer = null;
    // Longer than the chart's 1.2s tween so each shape settles before the next,
    // and so rough.js isn't recomputing hatch geometry every frame for the whole
    // wait — it only runs while a tween is in flight.
    const RADAR_LOADING_STEP_MS = 1500;
    const RADAR_LOADING_LINE = 'rgba(122, 134, 142, 0.5)';
    const RADAR_LOADING_FILL = 'rgba(122, 134, 142, 0.07)';
    const RADAR_LOADING_POINT = 'rgba(122, 134, 142, 0.55)';

    // Plausible scores. Never an empty or a perfect radar — either would read
    // as a real result rather than a placeholder.
    function radarLoadingScores() {
        return RADAR_DIMENSIONS.map(() => 3 + Math.floor(Math.random() * 7));
    }

    function radarLoadingData() {
        const scores = radarLoadingScores();
        return { dimensions: RADAR_DIMENSIONS.map((name, i) => ({ name, score: scores[i] })) };
    }

    function startRadarLoading() {
        stopRadarLoading();
        radarLoading = true;
        // Blur the WHOLE radar (plot, grid and its axis labels) while the
        // placeholder is up, so the "Analysing your readiness…" label reads
        // clearly on top of it.
        document.querySelectorAll('.pacey-radar-chart').forEach(c => c.classList.add('pacey-radar-loading'));
        renderRadarChart(radarLoadingData());
        radarLoadingTimer = setInterval(() => {
            if (!radarCharts.length) return;
            const values = radarLoadingScores();
            radarCharts.forEach(c => {
                c.data.datasets[0].data = values;
                c.update();
            });
        }, RADAR_LOADING_STEP_MS);
    }

    function stopRadarLoading() {
        radarLoading = false;
        if (radarLoadingTimer) { clearInterval(radarLoadingTimer); radarLoadingTimer = null; }
        // Lift the blur so the real radar snaps back to sharp
        document.querySelectorAll('.pacey-radar-chart').forEach(c => c.classList.remove('pacey-radar-loading'));
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

        // Read colours from the mileage canvas so the loading charts match the
        // paper surface they render on (falls back to root if it is missing)
        const loadingSource = document.getElementById('pacey-mileage-chart') || document.documentElement;
        const chartMuted = getComputedStyle(loadingSource).getPropertyValue('--pacey-muted').trim() || '#5a7184';
        const chartGridColor = getComputedStyle(loadingSource).getPropertyValue('--pacey-border').trim() || '#dce8f2';

        // --- Mileage chart: 12 randomised bars ---
        const mileageCanvas = document.getElementById('pacey-mileage-chart');
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
        const paceCanvas = document.getElementById('pacey-pace-distribution-chart');
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
        const hrCanvas = document.getElementById('pacey-hr-pace-scatter');
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
    // Skeleton for the six pillar cards. The two pages show different cards —
    // the overview a one-paragraph summary, the readiness page a strengths and
    // gaps breakdown — so the skeleton mirrors each rather than showing one
    // generic card, which would jump as soon as the real text landed. Only the
    // prose is a placeholder: the dimension names and the Strengths/Gaps
    // labels are static, so they render for real. The cards are decorative
    // while they load, so they're hidden from screen readers.
    function showPillarsSkeleton() {
        const cardHeader = (name, i) => `
            <div class="pacey-pillar-header">
                <span class="pacey-pillar-dot" style="background:${RADAR_COLORS[i] || RADAR_COLORS[0]}"></span>
                <span class="pacey-pillar-name">${name}</span>
                <span class="pacey-pillar-score pacey-skeleton-text"></span>
            </div>`;
        // Last line short, like a real paragraph's final line.
        const textLines = (count) => `
            <span class="pacey-skeleton-lines">${Array.from({ length: count }, (_, k) =>
                `<span class="pacey-skeleton-line${k === count - 1 ? ' pacey-skeleton-line--short' : ''}"></span>`
            ).join('')}</span>`;

        const overviewHtml = RADAR_DIMENSIONS.map((name, i) => `
            <div class="pacey-pillar-card pacey-pillar-card--summary pacey-pillar-card--skeleton" aria-hidden="true">
                ${cardHeader(name, i)}
                ${textLines(3)}
                <span class="pacey-skeleton-line pacey-skeleton-line--link"></span>
            </div>`).join('');

        const insightsHtml = RADAR_DIMENSIONS.map((name, i) => `
            <div class="pacey-pillar-card pacey-pillar-card--skeleton" aria-hidden="true">
                ${cardHeader(name, i)}
                <div class="pacey-pillar-section pacey-pillar-section--strengths">
                    <span class="pacey-pillar-section-label pacey-pillar-section-label--strengths">Strengths</span>
                    ${textLines(2)}
                </div>
                <div class="pacey-pillar-section pacey-pillar-section--gaps">
                    <span class="pacey-pillar-section-label pacey-pillar-section-label--gaps">Gaps</span>
                    ${textLines(2)}
                </div>
            </div>`).join('');

        const overviewPage = document.getElementById('pacey-page-overview');
        pillarsContents.forEach(el => {
            el.hidden = false;
            el.innerHTML = (overviewPage && overviewPage.contains(el)) ? overviewHtml : insightsHtml;
        });
    }

    // =========================================================================
    // The Big Picture — the coach's top-level synthesized assessment
    // =========================================================================

    const overallInsightEl = $('#pacey-overall-insight');
    const overallInsightSkeleton = $('#pacey-overall-insight-skeleton');

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

    // Normalize an overall-insight object from the API or cache. The model
    // sometimes returns snake_case keys, a string instead of {label, note},
    // or omits topStrength/topGap entirely — any of which used to crash
    // renderOverallInsight on `.label`.
    function takeawayFrom(value, fallback) {
        const fb = fallback || { label: '', note: '' };
        if (value && typeof value === 'object') {
            const label = value.label || value.name || '';
            const note = value.note || value.summary || value.text || '';
            return { label: label || fb.label || '', note: note || fb.note || '' };
        }
        if (typeof value === 'string' && value.trim()) {
            return { label: value.trim(), note: fb.note || '' };
        }
        return { label: fb.label || '', note: fb.note || '' };
    }

    function normalizeOverallInsight(overall, pillarsData) {
        const derived = deriveOverallInsight(pillarsData) || {
            verdict: '',
            score: 0,
            summary: '',
            topStrength: { label: '', note: '' },
            topGap: { label: '', note: '' },
            focus: '',
        };
        if (!overall || typeof overall !== 'object') return derived;
        return {
            verdict: overall.verdict || derived.verdict,
            score: typeof overall.score === 'number' ? overall.score : derived.score,
            summary: overall.summary || derived.summary,
            topStrength: takeawayFrom(overall.topStrength || overall.top_strength, derived.topStrength),
            topGap: takeawayFrom(overall.topGap || overall.top_gap, derived.topGap),
            focus: overall.focus || derived.focus,
        };
    }

    // Show/hide the overall insight skeleton loading state
    function showOverallInsightSkeleton(show) {
        if (overallInsightSkeleton) overallInsightSkeleton.hidden = !show;
        if (overallInsightEl) overallInsightEl.hidden = show;
    }

    // The Big Picture card — verdict, summary, top strength/gap and focus.
    // Shared by the overview page and the readiness-review modal so the two read
    // identically. The modal passes includeCta=false: the CTA points at the
    // readiness page, which post-race shows the recap rather than the analysis.
    function overallInsightHtml(data, includeCta = true) {
        const strength = data.topStrength || { label: '', note: '' };
        const gap = data.topGap || { label: '', note: '' };

        // Score color — matches the AI score scale used in the dimension modal
        const scoreColor = data.score >= 8 ? 'var(--pacey-accent-green)'
            : data.score >= 7 ? 'var(--pacey-accent-green)'
            : data.score >= 6 ? 'var(--pacey-accent-amber)'
            : data.score >= 5 ? 'var(--pacey-accent-amber)'
            : 'var(--pacey-accent-red)';

        return `
            <div class="pacey-overall-insight-header">
                <div class="pacey-overall-insight-verdict">${escapeHtml(data.verdict)}</div>
                <div class="pacey-overall-insight-score" style="color: ${scoreColor};">${data.score}<span class="pacey-overall-insight-score-max">/10</span></div>
            </div>
            <p class="pacey-overall-insight-summary">${escapeHtml(data.summary)}</p>
            <div class="pacey-overall-insight-takeaways">
                <div class="pacey-overall-insight-takeaway pacey-overall-insight-takeaway--strength">
                    <span class="pacey-overall-insight-takeaway-label">Top strength</span>
                    <span class="pacey-overall-insight-takeaway-name">${escapeHtml(strength.label)}</span>
                    <p class="pacey-overall-insight-takeaway-note">${escapeHtml(strength.note)}</p>
                </div>
                <div class="pacey-overall-insight-takeaway pacey-overall-insight-takeaway--gap">
                    <span class="pacey-overall-insight-takeaway-label">Biggest gap</span>
                    <span class="pacey-overall-insight-takeaway-name">${escapeHtml(gap.label)}</span>
                    <p class="pacey-overall-insight-takeaway-note">${escapeHtml(gap.note)}</p>
                </div>
            </div>
            <div class="pacey-overall-insight-focus">
                <span class="pacey-overall-insight-focus-label">What to focus on next</span>
                <p class="pacey-overall-insight-focus-text">${escapeHtml(data.focus)}</p>
            </div>
            ${includeCta ? `
            <!-- CTA — takes the runner to the full race-readiness chart page -->
            <a class="pacey-overall-insight-cta" href="#readiness">
                See race readiness
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </a>` : ''}
        `;
    }

    function renderOverallInsight(data) {
        if (!overallInsightEl || !data) return;
        showOverallInsightSkeleton(false);
        overallInsightEl.innerHTML = overallInsightHtml(data);
    }

        // Score colour — one six-band scale shared by both pages, so a score reads
    // identically wherever it appears. Brighter than the old three-band
    // green/amber/red, which rendered 6 and 9 in the same colour.
    function pillarScoreColor(score) {
        if (score >= 10) return '#c026d3';   // full marks — bright magenta
        if (score >= 8) return '#2f8a3d';    // green
        if (score >= 7) return '#74a83d';    // light green
        if (score >= 5) return '#d9a300';    // yellow
        if (score >= 3) return '#e8590c';    // orange
        return '#d92d20';                    // red
    }

    // The full six-dimension cards — score, strengths and gaps — as shown on the
    // readiness page. Shared with the readiness-review modal so a card reads the
    // same wherever it appears.
    function pillarInsightsHtml(dims) {
        return dims.map((d, i) => `
            <div class="pacey-pillar-card" data-pillar-index="${i}">
                <div class="pacey-pillar-header">
                    <span class="pacey-pillar-dot" style="background:${RADAR_COLORS[i] || RADAR_COLORS[0]}"></span>
                    <span class="pacey-pillar-name">${escapeHtml(d.name)}</span>
                    <span class="pacey-pillar-score" style="color:${pillarScoreColor(d.score)}">${d.score}<span class="pacey-pillar-score-max">/10</span></span>
                </div>
                <div class="pacey-pillar-section pacey-pillar-section--strengths">
                    <span class="pacey-pillar-section-label pacey-pillar-section-label--strengths">Strengths</span>
                    <p class="pacey-pillar-note">${escapeHtml(d.strengths || '')}</p>
                </div>
                <div class="pacey-pillar-section pacey-pillar-section--gaps">
                    <span class="pacey-pillar-section-label pacey-pillar-section-label--gaps">Gaps</span>
                    <p class="pacey-pillar-note">${escapeHtml(d.gaps || '')}</p>
                </div>
            </div>
        `).join('');
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
        const overviewHtml = dims.map((d, i) => {
            // Colour-code the mark like a coach's rating — same scale as the
            // overall score. The "/10" stays quiet and inherits its own colour.
            const scoreColor = pillarScoreColor(d.score);
            return `
            <div class="pacey-pillar-card pacey-pillar-card--summary" data-pillar-index="${i}">
                <div class="pacey-pillar-header">
                    <span class="pacey-pillar-dot" style="background:${RADAR_COLORS[i] || RADAR_COLORS[0]}"></span>
                    <span class="pacey-pillar-name">${escapeHtml(d.name)}</span>
                    <span class="pacey-pillar-score" style="color:${scoreColor}">${d.score}<span class="pacey-pillar-score-max">/10</span></span>
                </div>
                <p class="pacey-pillar-summary">${escapeHtml(d.summary || '')}</p>
                <span class="pacey-pillar-view-details">View details →</span>
            </div>
        `;
        }).join('');

        // Readiness page: full breakdown with strengths and gaps, each
        // referencing specific data from the runner's activities. Shared with
        // the readiness-review modal so the two cannot render differently.
        const insightsHtml = pillarInsightsHtml(dims);

        // Fill each pillars-content container with the appropriate HTML.
        // The first container is on the overview page, the second on the
        // readiness page — determined by which page element contains them.
        const overviewPage = document.getElementById('pacey-page-overview');
        const readinessPage = document.getElementById('pacey-page-readiness');
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
            overviewPage.querySelectorAll('.pacey-pillar-card--summary').forEach(card => {
                card.addEventListener('click', () => {
                    const idx = card.getAttribute('data-pillar-index');
                    // Navigate to the readiness page via hash routing
                    window.location.hash = 'readiness';
                    // Scroll the corresponding pillar into view after the
                    // page is shown — short delay to allow the page to unhide
                    setTimeout(() => {
                        const pillar = readinessPage.querySelector(
                            `.pacey-pillars-content .pacey-pillar-card[data-pillar-index="${idx}"]`
                        );
                        if (pillar) {
                            pillar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            pillar.classList.add('pacey-pillar-highlight');
                            setTimeout(() => pillar.classList.remove('pacey-pillar-highlight'), 2000);
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

    const editGoalPopup = $('#pacey-edit-goal-popup');
    const editGoalClose = $('#pacey-edit-goal-close');
    const editGoalForm = $('#pacey-edit-goal-form');
    const editGoalBtn = $('#pacey-edit-goal-btn');
    let editGoalTrigger = null;

    // Open the edit-goal popup — pre-fills the form with the current race goal
    function openEditGoalPopup() {
        editGoalTrigger = document.activeElement;
        // Close the settings popup if it's open (mobile edit-goal flow)
        if (settingsPopup && !settingsPopup.hidden) closeSettingsPopup();

        // Pre-fill the form with current goal values
        if (raceGoal) {
            $('#pacey-edit-race-name').value = raceGoal.race_name || '';
            $('#pacey-edit-purpose').value = raceGoal.purpose || '';
            // A goal saved before the pickers changed can carry a type that no
            // longer exists in the list (Ultra Marathon, Triathlon). Fall back to
            // Custom and carry its distance across, so re-opening the modal
            // never silently loses what the runner entered.
            if (!$('#pacey-edit-purpose').value) $('#pacey-edit-purpose').value = 'Custom';
            const editIsCustom = $('#pacey-edit-purpose').value === 'Custom';
            $('#pacey-edit-custom-distance-field').hidden = !editIsCustom;
            if (editIsCustom) {
                const km = goalDistanceKm(raceGoal);
                const inMiles = raceGoal.distance_unit === 'mi';
                $('#pacey-edit-custom-distance').value = km
                    ? Math.round((inMiles ? km / KM_PER_MILE : km) * 10) / 10
                    : '';
                $('#pacey-edit-custom-distance-unit').value = inMiles ? 'mi' : 'km';
            }
            // Parse time target "HH:MM:SS" into separate fields
            const parts = (raceGoal.time_target || '00:00:00').split(':');
            $('#pacey-edit-time-h').value = parts[0] || '0';
            $('#pacey-edit-time-m').value = parts[1] || '00';
            $('#pacey-edit-time-s').value = parts[2] || '00';
            $('#pacey-edit-race-date').value = raceGoal.race_date || '';
            $('#pacey-edit-mileage').value = raceGoal.weekly_mileage || '';
            $('#pacey-edit-mileage-unit').value = raceGoal.mileage_unit || 'km';
            $('#pacey-edit-gender').value = raceGoal.gender || '';
            $('#pacey-edit-age').value = raceGoal.age || '';
        }
        editGoalPopup.hidden = false;
        editGoalClose.focus();
    }

    function closeEditGoalPopup() {
        editGoalPopup.hidden = true;
        // Clear any error states
        $$('.pacey-input.error').forEach(el => {
            // Only clear errors within the edit-goal form
            if (editGoalForm.contains(el)) el.classList.remove('error');
        });
        $$('.pacey-field-error').forEach(el => {
            if (editGoalForm.contains(el)) el.hidden = true;
        });
        if (editGoalTrigger) editGoalTrigger.focus();
    }

    // Edit-goal form submission — validates, saves to API, reloads dashboard data
    editGoalForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        // Clear previous error states within this form only
        $$('.pacey-input.error').forEach(el => {
            if (editGoalForm.contains(el)) el.classList.remove('error');
        });
        $$('.pacey-field-error').forEach(el => {
            if (editGoalForm.contains(el)) el.hidden = true;
        });

        const h = $('#pacey-edit-time-h').value || '0';
        const m = $('#pacey-edit-time-m').value || '00';
        const s = $('#pacey-edit-time-s').value || '00';
        const timeTarget = `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;

        const editPurposeValue = $('#pacey-edit-purpose').value;
        const required = [
            { id: 'pacey-edit-purpose', val: editPurposeValue },
            // The custom distance only matters when Custom is picked. The field
            // is hidden otherwise, so requiring it unconditionally would block
            // the four standard types.
            ...(editPurposeValue === 'Custom'
                ? [{ id: 'pacey-edit-custom-distance', val: $('#pacey-edit-custom-distance').value }]
                : []),
            { id: 'pacey-edit-time-h', val: timeTarget !== '00:00:00' ? timeTarget : '' },
            { id: 'pacey-edit-race-date', val: $('#pacey-edit-race-date').value },
            { id: 'pacey-edit-mileage', val: $('#pacey-edit-mileage').value },
            { id: 'pacey-edit-gender', val: $('#pacey-edit-gender').value },
            { id: 'pacey-edit-age', val: $('#pacey-edit-age').value },
        ];

        let hasError = false;
        for (const f of required) {
            if (!f.val) {
                const el = document.getElementById(f.id);
                if (el) el.classList.add('error');
                const fg = el && el.closest('.pacey-field');
                if (fg) { const er = fg.querySelector('.pacey-field-error'); if (er) er.hidden = false; }
                if (f.id === 'pacey-edit-time-h') {
                    ['pacey-edit-time-h','pacey-edit-time-m','pacey-edit-time-s'].forEach(id => {
                        const inp = document.getElementById(id); if (inp) inp.classList.add('error');
                    });
                    const dpErr = document.querySelector('#pacey-edit-duration-picker').nextElementSibling;
                    if (dpErr && dpErr.classList.contains('pacey-field-error')) dpErr.hidden = false;
                }
                hasError = true;
            }
        }
        if (hasError) return;

        const editDist = formGoalDistance(editPurposeValue, $('#pacey-edit-custom-distance').value, $('#pacey-edit-custom-distance-unit').value);

        setButtonLoading(editGoalBtn, true);
        const body = {
            race_name: $('#pacey-edit-race-name').value,
            // The type is kept so the modal can re-open on it, but every
            // read-only view of the goal works from the distance instead.
            purpose: $('#pacey-edit-purpose').value,
            distance: editDist ? editDist.distance : 0,
            distance_unit: editDist ? editDist.distance_unit : 'km',
            time_target: timeTarget,
            race_date: $('#pacey-edit-race-date').value,
            weekly_mileage: $('#pacey-edit-mileage').value,
            mileage_unit: $('#pacey-edit-mileage-unit').value,
            // The latest race result now lives in its own onboarding step, so
            // carry the stored values through unchanged when editing the goal.
            fitness_race_distance: (raceGoal && raceGoal.fitness_race_distance) || '',
            fitness_race_time: (raceGoal && raceGoal.fitness_race_time) || '',
            gender: $('#pacey-edit-gender').value,
            age: $('#pacey-edit-age').value,
        };
        try {
            // A new goal replaces the old one, so a finished race on the old goal
            // is filed to history before it is overwritten.
            fileRaceResultToHistory(raceGoal);
            // In demo mode, save locally without an API call
            if (window.__demoMode) {
                raceGoal = { ...body, saved_at: new Date().toISOString() };
            } else {
                const resp = await apiCall('POST', 'onboarding', body, true);
                const data = await resp.json();
                if (!resp.ok) { alert(data.error || 'Failed to save race goal.'); return; }
                raceGoal = data.goal;
            }
            localStorage.setItem('pacey_race_goal', JSON.stringify(raceGoal));
            // Goal changed — cached AI insights are no longer valid
            clearAICache();
            // The coach plan (and its trajectory) was generated against the old
            // goal too. Drop the client cache AND the in-memory plan so the
            // Plan page refetches instead of re-rendering the old block
            // (openPlanPage re-renders coachPlanData whenever coachLoaded is
            // true, and generateCoachPlan early-returns on it).
            clearCoachCache();
            coachLoaded = false;
            coachPlanData = null;
            coachEditingDate = null;
            coachSyncedDates.clear();
            // Clear stored chart data so stale values aren't re-rendered
            // during the reload (e.g. by a theme toggle mid-fetch)
            lastRadarData = null;
            lastMileageWeeks = null;
            lastPaceDistActivities = null;
            lastHrPaceActivities = null;
            // Update the sidebar goal display
            sidebarGoalEl.textContent = `${goalTypeLabel(raceGoal)} — ${raceGoal.time_target}`;
            // Update the goal specifics panel
            renderGoalSpecifics(raceGoal);
            // ...and the race detail note on the readiness page, which restates
            // the same goal from the other end of the app.
            renderRaceDetail(raceGoal);
            // The course is titled after the race goal, so an edited goal
            // re-titles it.
            updateCourseHead();
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

    $('#pacey-reset-goal-btn').addEventListener('click', editGoal);
    // Settings popup edit-goal button — shown only on mobile
    const settingsResetGoalBtn = $('#pacey-settings-reset-goal-btn');
    if (settingsResetGoalBtn) settingsResetGoalBtn.addEventListener('click', editGoal);

    // =========================================================================
    // Race goal reminder popup — shown when a returning user logs in and has
    // a persisted race goal from a previous session. Lets them keep the
    // existing goal, edit it, or start fresh with the onboarding flow.
    // =========================================================================

    const goalReminderPopup = $('#pacey-goal-reminder-popup');
    const goalReminderClose = $('#pacey-goal-reminder-close');
    const goalReminderKeep = $('#pacey-goal-reminder-keep');
    const goalReminderEdit = $('#pacey-goal-reminder-edit');
    const goalReminderNew = $('#pacey-goal-reminder-new');
    const goalReminderSummary = $('#pacey-goal-reminder-summary');
    let goalReminderTrigger = null;

    // Populate the summary card with the saved race goal details and show
    // the popup. Called from the login handler when data.has_race_goal is true.
    function showGoalReminderPopup(goal) {
        if (!goalReminderPopup || !goal) return;
        goalReminderTrigger = document.activeElement;

        // Build the summary rows — only show fields that have values
        const rows = [];
        if (goal.race_name) rows.push(['Race', goal.race_name]);
        if (goal.distance) rows.push(['Distance', goalDistanceLabel(goal)]);
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
            <div class="pacey-goal-reminder-summary-row">
                <span class="pacey-goal-reminder-summary-label">${escapeHtml(label)}</span>
                <span class="pacey-goal-reminder-summary-value">${escapeHtml(String(value))}</span>
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
        localStorage.removeItem('pacey_race_goal');
        clearAICache();
        clearCoachCache();
        // Also drop the in-memory plan so the Plan page rebuilds for the new goal
        coachLoaded = false;
        coachPlanData = null;
        coachEditingDate = null;
        coachSyncedDates.clear();
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
    const settingsPopup = $('#pacey-settings-popup');
    const settingsPopupClose = $('#pacey-settings-popup-close');
    const settingsLogoutBtn = $('#pacey-settings-logout-btn');

    async function openSettingsPopup(trigger) {
        if (sessionToken && sessionToken !== 'demo') {
            // Populate account details from the latest check-session data
            try {
                const resp = await apiCall('GET', 'check-session');
                const data = await resp.json();
                if (data.valid) {
                    $('#pacey-settings-name').textContent = data.full_name || data.display_name || '--';
                    $('#pacey-settings-email').textContent = data.email || '--';
                    $('#pacey-settings-device').textContent = data.device_name || '--';
                }
            } catch (e) {
                // Fallback to cached data
                $('#pacey-settings-name').textContent = displayName || '--';
                $('#pacey-settings-email').textContent = '--';
                $('#pacey-settings-device').textContent = '--';
            }
            // Real session — show disconnect button
            settingsLogoutBtn.textContent = 'Disconnect Garmin';
            settingsLogoutBtn.className = 'pacey-btn pacey-btn-danger';
        } else {
            // Demo mode — show placeholder + connect button. Assign a
            // realistic Garmin device (Forerunner 165) rather than a
            // "Demo Device" label so the settings read naturally.
            $('#pacey-settings-name').textContent = 'Demo Runner';
            $('#pacey-settings-email').textContent = 'demo@example.com';
            $('#pacey-settings-device').textContent = 'Forerunner 165';
            settingsLogoutBtn.textContent = 'Connect Garmin';
            settingsLogoutBtn.className = 'pacey-btn pacey-btn-primary';
        }

        // Populate the mobile profile section — mirrors the sidebar's
        // avatar, display name, race goal, and edit button. Only visible
        // on mobile where the sidebar is hidden.
        const settingsAvatar = $('#pacey-settings-avatar');
        const settingsProfileName = $('#pacey-settings-profile-name');
        const settingsProfileGoal = $('#pacey-settings-profile-goal');
        if (settingsAvatar) {
            // Copy the same avatar content as the sidebar
            if (profileImageUrl) {
                settingsAvatar.innerHTML = `<img src="${profileImageUrl}" alt="${displayName || 'Runner'}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/><span class="pacey-avatar-initials" style="display:none">${getInitials(displayName)}</span>`;
            } else {
                const initials = getInitials(displayName);
                if (initials && !window.__demoMode) {
                    settingsAvatar.innerHTML = `<span class="pacey-avatar-initials">${initials}</span>`;
                } else {
                    // Lucide "user" icon — profile placeholder
                    settingsAvatar.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
                }
            }
        }
        if (settingsProfileName) {
            settingsProfileName.textContent = displayName || 'Demo Runner';
        }
        if (settingsProfileGoal && raceGoal) {
            settingsProfileGoal.textContent = `${goalTypeLabel(raceGoal)} — ${raceGoal.time_target}`;
        } else if (settingsProfileGoal) {
            settingsProfileGoal.textContent = '';
        }

        // Focus management: store the triggering element and move focus
        // to the close button so keyboard users can dismiss the panel
        settingsPopupTrigger = trigger || settingsBtn;
        // Cancel any in-flight close so a quick re-open isn't hidden mid-way
        if (settingsCloseTimer) { clearTimeout(settingsCloseTimer); settingsCloseTimer = null; }
        settingsPopup.hidden = false;
        // Add the open class on the next frame so the entrance transition runs
        // from the closed state (removing and re-adding it in the same frame
        // would skip the animation).
        requestAnimationFrame(() => settingsPopup.classList.add('pacey-settings-popup--open'));
        settingsPopupClose.focus();
    }

    let settingsCloseTimer = null;

    // Close the panel: the exit transition runs first (fade + scale on desktop,
    // slide-down on mobile), then the element is hidden.
    function closeSettingsPopup() {
        if (!settingsPopup.classList.contains('pacey-settings-popup--open')) return;
        settingsPopup.classList.remove('pacey-settings-popup--open');
        // Return focus to the trigger while the panel is still on screen, so
        // focus never lands on a hidden element.
        if (settingsPopupTrigger) settingsPopupTrigger.focus();
        settingsCloseTimer = setTimeout(() => {
            settingsPopup.hidden = true;
            settingsCloseTimer = null;
        }, 320);
    }

    let settingsPopupTrigger = null;

    // The open class is the source of truth for "is it open" — the element
    // stays visible during the exit transition, so `hidden` alone is not enough.
    const isSettingsPopupOpen = () => settingsPopup.classList.contains('pacey-settings-popup--open');

    // The settings button toggles the panel: open when closed, close when it
    // is already open (so a second tap dismisses it).
    settingsBtn.addEventListener('click', () => {
        if (isSettingsPopupOpen()) closeSettingsPopup();
        else openSettingsPopup(settingsBtn);
    });
    settingsPopupClose.addEventListener('click', closeSettingsPopup);
    // Tapping the scrim closes the mobile bottom sheet. On desktop the popup is
    // pointer-events:none, so this only fires for the card itself.
    settingsPopup.addEventListener('click', (e) => {
        if (e.target === settingsPopup) closeSettingsPopup();
    });
    // Close when clicking anywhere outside the panel. On desktop the popup is
    // not a full-screen overlay, so this needs a document-level listener rather
    // than a click on the popup. The two trigger buttons are exempt so their
    // own click can toggle.
    document.addEventListener('click', (e) => {
        if (!isSettingsPopupOpen()) return;
        if (settingsPopup.contains(e.target)) return;
        if (settingsBtn.contains(e.target)) return;
        const tabBtn = document.getElementById('pacey-tab-settings');
        if (tabBtn && tabBtn.contains(e.target)) return;
        closeSettingsPopup();
    });
    // Close on Escape key — matches the login modal and metric popup behavior
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isSettingsPopupOpen()) closeSettingsPopup();
    });

    // Edit-goal popup Escape key handler
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !editGoalPopup.hidden) closeEditGoalPopup();
    });

    // =========================================================================
    // Add to Home Screen — instructional prompt
    // =========================================================================
    // There is no programmatic install API on iOS, and none on Android without
    // a web app manifest, so this is an education modal: it teaches the manual
    // "Add to Home Screen" gesture. It shows once (remembered in localStorage)
    // and is always reachable from Settings, so a dismissal never loses the
    // instruction. Desktop is skipped (different affordance), and it never
    // appears once the app is already running standalone.
    // =========================================================================

    const A2HS_SEEN_KEY = 'pacey_a2hs_seen';
    const FIRST_SEEN_KEY = 'pacey_first_seen_at';
    // Dwell before the prompt appears — the first value moment should land
    // first, and out-of-context prompts get dismissed on reflex. Returning
    // users have already shown interest, so they wait less.
    const A2HS_DWELL_FIRST_MS = 60 * 1000;
    const A2HS_DWELL_RETURNING_MS = 20 * 1000;

    const a2hsModal = $('#pacey-a2hs-modal');
    const a2hsClose = $('#pacey-a2hs-close');
    const a2hsDone = $('#pacey-a2hs-done');
    const a2hsPlatformIos = $('#pacey-a2hs-ios');
    const a2hsPlatformAndroid = $('#pacey-a2hs-android');
    const a2hsNote = $('#pacey-a2hs-note');
    const a2hsSettingsBtn = $('#pacey-settings-install-btn');
    let a2hsTrigger = null;

    // iPadOS 13+ reports itself as "Macintosh" but is touch-capable, so the
    // platform string alone would misclassify it as desktop.
    function isIOSDevice() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }
    function isAndroidDevice() {
        return /Android/i.test(navigator.userAgent);
    }
    function isMobileDevice() {
        return isIOSDevice() || isAndroidDevice()
            || (/Mobi/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0);
    }
    // In-app browsers (Instagram, Facebook, WhatsApp, TikTok, etc.) don't offer
    // "Add to Home Screen" at all, so the steps below would be wrong there.
    function isInAppBrowser() {
        return /FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Twitter|TikTok|Snapchat|Pinterest|MicroMessenger|GSA\//i
            .test(navigator.userAgent || '');
    }

    function openA2HSModal(trigger) {
        if (!a2hsModal) return;
        a2hsTrigger = trigger || null;
        // Show the matching platform's steps. When the platform can't be
        // identified (desktop, or an unknown browser) show BOTH, so the
        // guidance is complete and the two are clearly separated.
        const ios = isIOSDevice();
        const android = isAndroidDevice();
        const known = ios || android;
        if (a2hsPlatformIos) a2hsPlatformIos.hidden = known ? !ios : false;
        if (a2hsPlatformAndroid) a2hsPlatformAndroid.hidden = known ? !android : false;
        if (a2hsNote) {
            if (isInAppBrowser()) {
                a2hsNote.textContent = 'Looks like you are in an in-app browser. Open this page in Safari (iPhone) or Chrome (Android) first — the "Add to Home Screen" option only appears there.';
                a2hsNote.hidden = false;
            } else {
                a2hsNote.hidden = true;
            }
        }
        a2hsModal.hidden = false;
        if (a2hsDone) a2hsDone.focus();
    }

    // Dismissing remembers it, so the prompt never nags. The Settings row
    // reopens it without clearing the flag — an explicit request is always fine.
    function closeA2HSModal(markSeen = true) {
        if (!a2hsModal) return;
        a2hsModal.hidden = true;
        if (markSeen) {
            try { localStorage.setItem(A2HS_SEEN_KEY, String(Date.now())); } catch (e) { /* ignore */ }
        }
        if (a2hsTrigger) a2hsTrigger.focus();
    }

    if (a2hsClose) a2hsClose.addEventListener('click', () => closeA2HSModal(true));
    if (a2hsDone) a2hsDone.addEventListener('click', () => closeA2HSModal(true));
    if (a2hsModal) a2hsModal.addEventListener('click', (e) => {
        if (e.target === a2hsModal) closeA2HSModal(true);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && a2hsModal && !a2hsModal.hidden) closeA2HSModal(true);
    });
    // Permanent entry point in Settings.
    if (a2hsSettingsBtn) a2hsSettingsBtn.addEventListener('click', () => {
        closeSettingsPopup();
        openA2HSModal(a2hsSettingsBtn);
    });

    // First-time detection: the marker is written on the very first load, so a
    // returning user is anyone whose browser already carried it before now.
    let isFirstVisit = false;
    try {
        if (!localStorage.getItem(FIRST_SEEN_KEY)) {
            localStorage.setItem(FIRST_SEEN_KEY, String(Date.now()));
            isFirstVisit = true;
        }
    } catch (e) { isFirstVisit = true; }

    // Schedule the one-time prompt. Called once the dashboard's real data has
    // loaded, so the runner has reached the value before being asked.
    let a2hsTimer = null;
    function maybeScheduleA2HS() {
        if (!a2hsModal || a2hsTimer) return;
        if (isStandalone) return;                        // already added — nothing to teach
        if (!isMobileDevice()) return;                   // desktop uses a different affordance
        try { if (localStorage.getItem(A2HS_SEEN_KEY)) return; } catch (e) { /* ignore */ }
        const dwell = isFirstVisit ? A2HS_DWELL_FIRST_MS : A2HS_DWELL_RETURNING_MS;
        a2hsTimer = setTimeout(() => {
            a2hsTimer = null;
            if (isStandalone) return;
            try { if (localStorage.getItem(A2HS_SEEN_KEY)) return; } catch (e) { /* ignore */ }
            if (a2hsModal.hidden) openA2HSModal(null);
        }, dwell);
    }

    // =========================================================================
    // AI chat floating button + popup — currently locked as "coming soon"
    // =========================================================================

    const chatFab = $('#pacey-chat-fab');
    const chatPopup = $('#pacey-chat-popup');
    const chatPopupClose = $('#pacey-chat-popup-close');
    let chatPopupOpen = false;

    // Open the chat popup — hides the FAB and expands the popup from the
    // button's position using CSS transform animation
    function openChatPopup() {
        chatFab.classList.add('pacey-chat-fab--hidden');
        chatPopup.classList.add('pacey-chat-popup--open');
        chatPopupOpen = true;
        // Focus the close button after the expand animation settles
        setTimeout(() => chatPopupClose.focus(), 300);
    }

    // Close the chat popup — collapses back toward the FAB, then shows
    // the FAB again after the animation completes
    function closeChatPopup() {
        chatPopup.classList.remove('pacey-chat-popup--open');
        chatPopupOpen = false;
        // Show the FAB after the collapse animation finishes
        setTimeout(() => {
            chatFab.classList.remove('pacey-chat-fab--hidden');
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

    // Mobile tab bar settings button — mirrors the sidebar settings button,
    // including the toggle behaviour (a second tap closes the panel).
    const tabSettingsBtn = $('#pacey-tab-settings');
    if (tabSettingsBtn) {
        tabSettingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (isSettingsPopupOpen()) closeSettingsPopup();
            else openSettingsPopup(tabSettingsBtn);
        });
    }

    // Demo CTA buttons — open the login modal to connect Garmin
    const demoBannerCta = $('#pacey-demo-banner-cta');
    const demoBannerSlimCta = $('#pacey-demo-banner-slim-cta');
    const demoPageCtaBtn = $('#pacey-demo-cta-btn');
    if (demoBannerCta) demoBannerCta.addEventListener('click', openLoginModal);
    // Slim pill "Connect" link — same behaviour as the full banner CTA
    if (demoBannerSlimCta) demoBannerSlimCta.addEventListener('click', openLoginModal);
    if (demoPageCtaBtn) demoPageCtaBtn.addEventListener('click', openLoginModal);

    // "Show more" button on the overview page — navigates to the full
    // activities page and scrolls to the top so users land on the most
    // recent activities first. On desktop the body is the scroll
    // container (.pacey-content has overflow:clip, not auto), so we use
    // window.scrollTo rather than scrollIntoView on a child element.
    // A short setTimeout lets the hashchange → navigateTo() run first
    // so the activities page is visible before we scroll.
    const showMoreActivitiesBtn = $('#pacey-show-more-activities');
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
    const loadMoreActivitiesBtn = $('#pacey-load-more-activities');
    if (loadMoreActivitiesBtn) {
        loadMoreActivitiesBtn.addEventListener('click', loadMoreActivities);
    }

    // Dismiss the radar external HTML tooltip when clicking outside the
    // radar canvas or the tooltip itself — matches the behavior the user
    // expects from the previous canvas tooltip which stayed until clicking away
    document.addEventListener('click', (e) => {
        const tooltipEl = document.getElementById('pacey-radar-tooltip');
        if (!tooltipEl || tooltipEl.style.opacity === '0') return;
        // If the click was inside the tooltip (e.g. on the link), don't dismiss
        if (tooltipEl.contains(e.target)) return;
        // If the click was on a radar canvas, don't dismiss — the chart's
        // own click handler will update the tooltip
        if (e.target.classList && e.target.classList.contains('pacey-radar-chart')) return;
        // Otherwise hide the tooltip
        tooltipEl.style.opacity = 0;
    });

    // Logout function — shared between settings and session expiry
    async function logout() {
        try { await apiCall('DELETE', 'check-session'); } catch (err) {}
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
        coachSyncedDates.clear();
        // Clear all cached session data so the next load starts fresh
        localStorage.removeItem('pacey_session_token');
        localStorage.removeItem('pacey_race_goal');
        localStorage.removeItem('pacey_display_name');
        localStorage.removeItem('pacey_profile_image_url');
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

    const coachCalendarEl = $('#pacey-coach-calendar');
    const coachErrorEl = $('#pacey-coach-error');
    const planEditBtn = $('#pacey-plan-edit-btn');
    const planPrefsModal = $('#pacey-plan-prefs-modal');
    const planPrefsModalClose = $('#pacey-plan-prefs-close');
    const planPrefsCancelBtn = $('#pacey-plan-prefs-cancel');
    const planPrefsForm = $('#pacey-plan-prefs-form');
    const prefDaysEl = $('#pacey-pref-days');
    const prefIntensityEl = $('#pacey-pref-intensity');
    const prefDistanceEl = $('#pacey-pref-distance');
    const planRaceCardEl = $('#pacey-plan-race-card');
    const planRaceNameEl = $('#pacey-plan-race-name');
    const planRaceMetaEl = $('#pacey-plan-race-meta');
    const planFitnessEl = $('#pacey-plan-fitness');
    const planFitnessToggle = $('#pacey-plan-fitness-toggle');
    const planFitnessSummaryEl = $('#pacey-plan-fitness-summary');
    const planFitnessBody = $('#pacey-plan-fitness-body');
    const planPaceEasyRangeEl = $('#pacey-pace-easy-range');
    const planPaceFastRangeEl = $('#pacey-pace-fast-range');
    const planPaceEasyNoteEl = $('#pacey-pace-easy-note');
    const planPaceFastNoteEl = $('#pacey-pace-fast-note');
    const planPaceEasyRunsEl = $('#pacey-pace-easy-runs');
    const planPaceFastRunsEl = $('#pacey-pace-fast-runs');
    const planInsightEl = $('#pacey-plan-insight');
    const planTrajectoryEl = $('#pacey-plan-trajectory');
    const coachBuildStatusEl = $('#pacey-coach-build-status');
    const workoutSheet = $('#pacey-workout-sheet');
    const workoutSheetClose = $('#pacey-workout-sheet-close');
    const workoutSheetBody = $('#pacey-workout-sheet-body');

    // v2: the trajectory/race-card payload changed shape — old cached plans
    // carry stale verdict text, so the key is bumped to ignore them.
    const COACH_CACHE_KEY = 'pacey_coach_plan_cache_v2';
    const COACH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    let coachPlanData = null;   // { history: [...], plan: { days: [...], pace_zones: {...} } }
    let coachLoaded = false;    // whether the plan has been fetched this session
    let coachGenerating = false; // whether a generation is in flight (guards re-entry)
    let coachEditingDate = null; // the day currently in edit mode (or null)
    // date -> workout fingerprint already synced to Garmin. Storing the
    // fingerprint (not just the date) lets edited workouts be re-synced: a
    // changed workout no longer matches its stored fingerprint, so it is
    // sendable again within the sync window.
    const coachSyncedDates = new Map();

    // Compact fingerprint of a workout spec — any change to the session
    // (type, distance, duration, pace, description) invalidates the sync.
    function workoutFingerprint(w) {
        if (!w) return '';
        // Include the compiled structure (segments, or the derived steps) so a
        // change to the step breakdown alone still invalidates the sync — a
        // structure-only edit would otherwise look "already synced".
        return [
            w.type, w.title, w.distance_km, w.duration_min,
            w.target_pace_min_per_km, w.description,
            JSON.stringify(w.segments || w.steps || []),
        ].join('|');
    }

    // Training phase for a given number of days left until race day — mirrors
    // the backend's _phase_for_days_left boundaries so the week headings
    // agree with what the AI was told.
    function phaseForDaysLeft(daysLeft) {
        if (daysLeft < 0) return 'Post-race';
        if (daysLeft < 7) return 'Taper';
        if (daysLeft <= 20) return 'Sharpen';
        if (daysLeft <= 42) return 'Specificity';
        return 'Build';
    }

    // Plan page history pagination — how many days of past activities to
    // render before the current date. Starts at 2 weeks (14 days); the
    // "Show more" button extends this by 14 days per click. Reset to 14
    // every time the plan page is opened so it always leads to today.
    let planPastDays = 14;
    const planShowMoreBtn = $('#pacey-plan-show-more');

    const WORKOUT_TYPES = ['Easy', 'Recovery', 'Long Run', 'Tempo', 'Intervals', 'Speedwork'];

    // Suggested workouts reuse the run-tag colour scheme, but saturated
    const WORKOUT_TAG_CLASS = {
        'Easy': 'pacey-run-tag--easy',
        'Recovery': 'pacey-run-tag--easy',
        'Long Run': 'pacey-run-tag--lsd',
        'Tempo': 'pacey-run-tag--tempo-long',
        'Intervals': 'pacey-run-tag--speedwork',
        'Speedwork': 'pacey-run-tag--speedwork',
    };

    // Plan-level preferences — persisted so they stay the same until changed
    const COACH_PREFS_KEY = 'pacey_coach_prefs';
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
        const goalFingerprint = raceGoal ? `${raceGoal.purpose || ''}|${raceGoal.time_target || ''}|${raceGoal.race_date || ''}|${raceGoal.fitness_race_distance || ''}|${raceGoal.fitness_race_time || ''}` : 'no-goal';
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
            if (!coachCacheIsUsable(entry.data)) return null;
            return entry.data;
        } catch (e) {
            return null;
        }
    }

    // A cached plan is only usable if its fitness block carries the run lists.
    // An older payload has the pace values but no current_*_runs, which renders
    // as "no recent easy/quality runs — goal-based reference only" even though
    // the runner has them. Reject it so the plan is re-pulled.
    function coachCacheIsUsable(data) {
        const f = data && data.plan && data.plan.fitness;
        return !f || Array.isArray(f.current_easy_runs);
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
        // Tags match the backend classifier so the demo insight's
        // similar-session lookup behaves exactly like the real one.
        const tags = ['Easy', 'LSD', 'Tempo Long', 'Speedwork', 'Recovery'];
        const secPerKm = [400, 420, 350, 330, 450]; // easy, long, tempo, interval, recovery
        const distances = [6, 18, 10, 8, 5];
        // Spread across the week like a real runner's schedule: Tue(1),
        // Thu(3), Sat(5), Sun(6) — a rest day between runs, with only the
        // weekend long run + recovery back to back. Mon, Wed, Fri rest.
        const weeklyOffsets = [1, 3, 5, 6];
        const results = [];
        for (let i = 0; i < 8; i++) {
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

    // Mock plan for demo mode — mirrors the full-block coach-plan.py logic:
    // starts tomorrow, runs through race day (build → specificity → sharpen
    // → taper), long runs progress toward ~30 km then taper, and the final
    // day is a Race workout with no hard/long session stacked on it.
    const MOCK_MAX_PLAN_DAYS = 26 * 7; // mirrors MAX_PLAN_DAYS in coach-plan.py

    // Phase by days remaining — mirrors the backend boundaries. Shared by the
    // plan builder and the demo insight generator.
    function mockPhase(daysLeft) {
        if (daysLeft < 7) return 'taper';
        if (daysLeft <= 20) return 'sharpen';
        if (daysLeft <= 42) return 'specificity';
        return 'build';
    }

    // Demo fitness summary for the race card — mirrors the backend's
    // plan.fitness shape: medians + IQR ranges + the runs behind them.
    function buildMockFitness() {
        const mockHistory = getMockCoachHistory();
        const runSummary = (r) => ({
            id: r.id,
            name: r.name,
            date: (r.start_time || '').slice(0, 10),
            distance: r.distance,
            avg_pace: r.avg_pace,
            run_tag: r.run_tag,
        });
        return {
            current_easy_pace: '6:32',
            current_easy_range: '6:20–6:50',
            current_easy_runs: mockHistory
                .filter(r => ['Easy', 'LSD', 'Recovery'].includes(r.run_tag))
                .map(runSummary),
            current_quality_pace: '5:52',
            current_quality_range: '5:40–6:05',
            current_quality_runs: mockHistory
                .filter(r => ['Tempo Long', 'Tempo', 'Speedwork'].includes(r.run_tag))
                .map(runSummary),
            goal_quality_pace: '5:18',
            goal_pace: '5:13',
        };
    }

    function getMockCoachPlan(prefs) {
        const p = prefs || {};
        const daysPerWeek = p.days_per_week || 3;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // Plan starts tomorrow
        const planStart = new Date(today);
        planStart.setDate(today.getDate() + 1);

        // Demo race date: prefer the saved race goal, else 12 weeks out.
        let raceDate = null;
        if (raceGoal && raceGoal.race_date) {
            const saved = new Date(raceGoal.race_date + 'T00:00:00');
            if (saved > today) raceDate = saved;
        }
        if (!raceDate) {
            raceDate = new Date(today);
            raceDate.setDate(today.getDate() + 84);
        }
        const maxEnd = new Date(planStart);
        maxEnd.setDate(planStart.getDate() + MOCK_MAX_PLAN_DAYS);
        if (raceDate > maxEnd) raceDate = maxEnd;

        const planEnd = raceDate;
        const totalDays = Math.round((planEnd - planStart) / 86400000) + 1;
        const daysToRace = Math.round((raceDate - today) / 86400000);

        const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        // Race-day distance + pace from the typed goal (mirrors the backend's
        // _race_distance_km and the Race zone) so the demo race card is never
        // a marathon for a half-marathon goal, and always shows the goal pace.
        const raceDistanceKm = (raceGoal && goalDistanceKm(raceGoal)) || 42.2;
        let racePace = null;
        if (raceGoal && raceGoal.time_target) {
            const parts = String(raceGoal.time_target).split(':').map(Number);
            const totalSec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0)
                : parts.length === 2 ? parts[0] * 60 + (parts[1] || 0) : 0;
            if (totalSec > 0) {
                const secPerKm = totalSec / raceDistanceKm;
                racePace = `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}`;
            }
        }
        const paceZones = Object.assign(
            { Recovery: '6:50', Easy: '6:30', 'Long Run': '6:25', Tempo: '6:10', Intervals: '5:40', Speedwork: '5:35' },
            racePace ? { Race: racePace } : {}
        );

        // Days before the first full Monday: at most one easy run if 3+ gap days
        const daysUntilMonday = (8 - planStart.getDay()) % 7; // 0=Sun..6=Sat → Mon=1
        const gapDays = daysUntilMonday === 0 ? 0 : daysUntilMonday;

        // Long-run distance per full week: ramp in build, peak in specificity,
        // cut in sharpen, minimal in taper (honesty rules).
        function mockLongKm(phase, weekIdx) {
            if (phase === 'taper') return 12;
            if (phase === 'sharpen') return 21;
            if (phase === 'specificity') return 30;
            return Math.min(24, 12 + weekIdx * 1.2);
        }

        // One Mon-Sun week's schedule: long run Sat, quality Tue, fill the
        // remaining workout days with easy/recovery in a fixed order.
        function mockWeekSchedule(dpw) {
            const sched = { 5: 'Long Run', 1: 'Speedwork' };
            const remaining = dpw - 2;
            // Fill spaced-out easy/recovery days: Thu(3), Mon(0), Sun(6),
            // Wed(2) — quality Tue, easy Thu, long Sat, recovery Sun.
            const fillOrder = [3, 0, 6, 2];
            const fillTypes = ['Easy', 'Recovery', 'Easy', 'Easy'];
            for (let i = 0; i < remaining && i < fillOrder.length; i++) {
                sched[fillOrder[i]] = fillTypes[i];
            }
            return sched;
        }

        // Build the days array
        const days = [];
        const raceKey = localDateKey(raceDate);
        for (let i = 0; i < totalDays; i++) {
            const d = new Date(planStart);
            d.setDate(planStart.getDate() + i);
            const key = localDateKey(d);
            const daysLeft = Math.round((raceDate - d) / 86400000);
            const phase = mockPhase(daysLeft);
            let wType = null;
            let overrides = null;

            if (key === raceKey) {
                wType = 'Race';
                overrides = { distance_km: raceDistanceKm };
            } else if (i < gapDays) {
                if (gapDays >= 3 && i === Math.min(2, gapDays - 1)) wType = 'Easy';
            } else {
                const weekIdx = Math.floor((i - gapDays) / 7);
                const dowIdx = (i - gapDays) % 7;
                const sched = mockWeekSchedule(daysPerWeek);
                wType = sched[dowIdx];
                // Race week keeps the long run off the calendar entirely.
                if (wType === 'Long Run' && phase === 'taper') wType = null;
                if (wType === 'Long Run') {
                    const longKm = mockLongKm(phase, weekIdx);
                    overrides = { distance_km: longKm, duration_min: Math.round(longKm * 6.5) };
                }
            }

            const workout = wType ? makeMockWorkout(wType, paceZones, overrides) : null;
            days.push({
                date: key,
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
            race_date: localDateKey(raceDate),
            race_phase: mockPhase(daysToRace),
            days_to_race: daysToRace,
            pace_zones: paceZones,
            // The real plan ramps zones per week; the demo keeps a flat set
            // so the day-level zone lookup behaves the same way.
            zones_by_date: days.reduce((acc, d) => { acc[d.date] = paceZones; return acc; }, {}),
            // Current fitness summary for the race card — mirrors the
            // backend's plan.fitness shape, with ranges + the runs behind
            // them for the training-paces drawer.
            fitness: buildMockFitness(),
            // Demo trajectory — on track, so the status row shows green.
            trajectory: {
                status: 'on_track',
                note: 'Your recent quality pace (5:52/km) is where the plan expects it right now — keep the block moving.',
                rebuild: false,
            },
            days,
        };
    }

    // Canned demo workout specs — mirrors the on-demand /api/coach-plan (action "insight")
    // behaviour: workouts carry no insight, and opening the card "generates"
    // one locally in demo mode via mockInsight().
    const MOCK_WORKOUT_DEFS = {
        'Easy': { title: 'Easy 6km', distance_km: 6, duration_min: 40, intensity: 'easy', description: 'Relaxed aerobic run.' },
        'Recovery': { title: 'Recovery 5km', distance_km: 5, duration_min: 35, intensity: 'easy', description: 'Very easy shakeout.' },
        'Long Run': { title: 'Long 16km', distance_km: 16, duration_min: 105, intensity: 'moderate', description: 'Endurance builder.' },
        'Tempo': { title: 'Tempo 8km', distance_km: 8, duration_min: 50, intensity: 'moderate', description: 'Sustained threshold effort.' },
        'Speedwork': { title: '6 x 400m', distance_km: 6, duration_min: 45, intensity: 'hard', description: 'Short, fast repeats.' },
        'Intervals': { title: '5 x 1km', distance_km: 7, duration_min: 50, intensity: 'hard', description: 'Longer repeats at threshold.' },
        'Race': { title: 'Race Day', distance_km: 42.195, duration_min: null, intensity: 'hard', description: 'Race day — execute the goal-pace plan you trained for.' },
    };

    // Demo insight generator — mirrors the on-demand /api/coach-plan (action "insight")
    // behaviour with the same context: week position in the block, phase at
    // the session's date, the previous planned session, and the runner's
    // recent similar runs from the demo history. Context leads; race
    // specifics (goal time/date) never appear — the race is "race day".
    function mockInsight(dateKey, w) {
        const type = (w && w.type) || 'Easy';
        const purpose = {
            'Easy': 'Builds aerobic base and aids recovery without adding fatigue',
            'Recovery': 'Flushes the legs and keeps you moving between harder days',
            'Long Run': 'Extends aerobic endurance so race distance feels manageable',
            'Tempo': 'Trains you to hold goal pace under fatigue',
            'Intervals': 'Sharpens your ability to sustain faster paces in blocks',
            'Speedwork': 'Raises your speed reserve above goal pace',
            'Race': 'Executes the goal pace plan you have trained for',
        }[type] || 'Keeps your fitness moving forward';

        // Week position + phase at THIS date (same math as the live path).
        let placementText = '';
        const plan = coachPlanData && coachPlanData.plan ? coachPlanData.plan : null;
        const d = parseDate(dateKey + 'T00:00:00');
        if (plan && plan.plan_start) {
            const start = parseDate(plan.plan_start + 'T00:00:00');
            const dayDiff = Math.round((d - start) / 86400000);
            if (dayDiff >= 0) {
                const weekIndex = Math.floor(dayDiff / 7) + 1;
                const totalWeeks = Math.max(1, Math.ceil((plan.total_plan_days || 1) / 7));
                placementText += ` This is week ${weekIndex} of ${totalWeeks} of the block`;
            }
        }
        if (plan && plan.race_date) {
            const raceDate = parseDate(plan.race_date + 'T00:00:00');
            const daysLeft = Math.round((raceDate - d) / 86400000);
            const phase = mockPhase(daysLeft);
            placementText += ` — ${phase} phase, ${daysLeft} days before race day.`;
            // Race week mirrors the backend's "arrive fresh" guidance.
            if (daysLeft >= 0 && daysLeft <= 7) {
                placementText += ' Race week — the only job is arriving at the line fresh.';
            }
        } else if (placementText) {
            placementText += '.';
        }

        // Previous planned session — mirrors the live context payload.
        let prevText = '';
        if (plan) {
            const idx = plan.days.findIndex(x => x.date === dateKey);
            for (let i = idx - 1; i >= 0; i--) {
                const pd = plan.days[i];
                if (pd && pd.workout) {
                    prevText = ` It follows the planned ${pd.workout.type.toLowerCase()}${pd.workout.distance_km ? ' (' + pd.workout.distance_km + ' km)' : ''}.`;
                    break;
                }
            }
        }

        // Recent similar runs from the demo history — same tag mapping as the
        // backend: Long Run→LSD, Tempo→Tempo Long/Tempo, Intervals/Speedwork→Speedwork,
        // Easy→Easy/Warmup, Recovery→Recovery, Race→LSD/Tempo Long.
        const tagMap = {
            'Long Run': ['LSD'], 'Tempo': ['Tempo Long', 'Tempo'], 'Intervals': ['Speedwork'],
            'Speedwork': ['Speedwork'], 'Easy': ['Easy', 'Warmup'], 'Recovery': ['Recovery'],
            'Race': ['LSD', 'Tempo Long'],
        };
        let similarText = '';
        const history = coachPlanData && coachPlanData.history ? coachPlanData.history : [];
        const similar = history.filter(h => (tagMap[type] || []).includes(h.run_tag)).slice(0, 2);
        if (similar.length) {
            const line = similar.map(s => {
                const sec = s.avg_pace ? 1000 / s.avg_pace : null;
                const pace = sec != null ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}/km` : '--';
                return `${(s.start_time || '').slice(5, 10)}: ${s.distance} km @ ${pace}${s.avg_hr ? ', avg HR ' + s.avg_hr : ''}`;
            }).join('; ');
            similarText = ` Your recent similar run${similar.length > 1 ? 's' : ''}: ${line}.`;
        }

        const effort = {
            'Easy': 'hold RPE 3-4, conversational',
            'Recovery': 'keep RPE 2-3, very light',
            'Long Run': 'start at RPE 4-5 and save energy for the final third',
            'Tempo': 'hold a comfortably hard RPE 7',
            'Intervals': 'run reps at RPE 8 with full recovery between',
            'Speedwork': 'run each rep at RPE 8-9, relaxed upper body',
            'Race': 'hold your goal pace through halfway before pushing',
        }[type] || 'keep a steady, honest effort';

        return `${purpose} — that is the session's job for race day.${placementText}${prevText}${similarText} Stay hydrated, and ${effort}.`;
    }

    function makeMockWorkout(type, zones, overrides) {
        const d = MOCK_WORKOUT_DEFS[type] || MOCK_WORKOUT_DEFS['Easy'];
        const o = overrides || {};
        const pace = zones[type] || '6:30';
        return {
            type,
            title: type === 'Long Run' && o.distance_km != null ? `Long ${o.distance_km}km` : d.title,
            description: d.description,
            // Lazy insight — the card opens with null and the sheet fills it
            // in via mockInsight (demo) or /api/coach-plan (action "insight") (real).
            insight: null,
            distance_km: o.distance_km != null ? o.distance_km : d.distance_km,
            duration_min: o.duration_min != null ? o.duration_min : d.duration_min,
            intensity: d.intensity,
            target_pace_min_per_km: type === 'Race' ? (zones['Race'] || null) : pace,
            steps: type === 'Race' ? [{ type: 'Run', detail: `${(o.distance_km != null ? o.distance_km : 42.195)} km`, level: 0, pace: zones['Race'] || null }] : makeMockSteps(type, pace, zones),
        };
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

    // Mirror of the backend's _split_windows: first chunk runs tomorrow
    // through the end of the current Mon-Sun week, then full Mon-Sun weeks
    // until race day (capped at MAX_PLAN_DAYS). Returns ISO start dates of
    // each chunk, or null when there is no future race date (short-window
    // fallback).
    function getPlanWeekStarts() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (!raceGoal || !raceGoal.race_date) return null;
        const raceDate = new Date(raceGoal.race_date + 'T00:00:00');
        if (raceDate <= today) return null;
        const planStart = new Date(today);
        planStart.setDate(today.getDate() + 1);
        const maxEnd = new Date(planStart);
        maxEnd.setDate(planStart.getDate() + MOCK_MAX_PLAN_DAYS);
        const planEnd = raceDate > maxEnd ? maxEnd : raceDate;

        const starts = [];
        // Convert JS getDay (Sun=0..Sat=6) to Python weekday (Mon=0..Sun=6)
        // so the first-chunk math matches the backend exactly. The final
        // chunk is always the 7 days before race day (the only taper chunk)
        // — no matter which weekday the race falls on.
        const taperStart = new Date(planEnd);
        taperStart.setDate(planEnd.getDate() - 6);
        if (planStart >= taperStart) {
            // The whole remaining block is inside the taper window.
            starts.push(localDateKey(planStart));
            return starts;
        }
        const lastPreTaper = new Date(taperStart);
        lastPreTaper.setDate(taperStart.getDate() - 1);
        const pyWd = (planStart.getDay() + 6) % 7;
        const firstEnd = new Date(planStart);
        firstEnd.setDate(planStart.getDate() + ((7 - pyWd) % 7) + 6);
        if (firstEnd > lastPreTaper) firstEnd.setTime(lastPreTaper.getTime());
        if (firstEnd > planEnd) firstEnd.setTime(planEnd.getTime());
        starts.push(localDateKey(planStart));
        const cursor = new Date(firstEnd);
        cursor.setDate(cursor.getDate() + 1);
        while (cursor <= planEnd) {
            starts.push(localDateKey(cursor));
            const end = new Date(cursor);
            end.setDate(end.getDate() + 6);
            const next = cursor >= taperStart
                ? planEnd                              // taper chunk — last one
                : (end > lastPreTaper ? lastPreTaper : end);
            cursor.setDate(next.getDate() + 1);
        }
        // Mirror the backend's pre-taper merge: a 1-2 day leftover chunk
        // before the taper window is absorbed into the previous chunk, so
        // the same window is never requested (or generated) twice.
        if (starts.length >= 3) {
            const secondLast = parseDate(starts[starts.length - 2] + 'T00:00:00');
            const leftoverDays = (lastPreTaper - secondLast) / 86400000 + 1;
            const thirdLast = parseDate(starts[starts.length - 3] + 'T00:00:00');
            const mergedDays = (lastPreTaper - thirdLast) / 86400000 + 1;
            if (leftoverDays <= 2 && mergedDays <= 13) {
                starts.splice(starts.length - 2, 1);
            }
        }
        return starts;
    }

    // Loading skeleton for the plan page — a light aura revolving around
    // the loading container's border (motion-primitive effect, adapted to
    // the Pacey palette), with the status line below.
    // The plan build runs one AI call per part, so it can take a while. The
    // status line is plain text: it changes as batches land and has to stay
    // legible.
    function coachLoadingMarkup(text) {
        return `
            <div class="pacey-coach-loading pacey-coach-loading--plan" role="status" aria-label="Building your plan">
                <div class="pacey-plan-skeleton-border">
                    <div class="pacey-plan-skeleton-glow"></div>
                </div>
                <span class="pacey-coach-loading-progress">${text}</span>
            </div>
        `;
    }

    async function generateCoachPlan(prefs, force) {
        // Post-race there is no block left to build. Guarded here as well as at
        // the callers so nothing — a prefs save, a stale auto-load — can spend an
        // AI call generating workouts for a race that has already happened.
        if (postRaceState(raceGoal, fullActivitiesLoaded).isPostRace) {
            renderCoachCalendar({ history: (coachPlanData && coachPlanData.history) || [], plan: {} });
            return;
        }
        // Auto-load is guarded; an explicit Save & Rebuild always regenerates.
        if ((coachLoaded || coachGenerating) && !force) return;
        if (prefs) {
            coachPrefs = {
                days_per_week: Number(prefs.days_per_week) || 3,
                intensity: prefs.intensity || 'moderate',
                distance_adj: prefs.distance_adj || 'keep',
            };
        }

        coachErrorEl.hidden = true;
        coachCalendarEl.innerHTML = coachLoadingMarkup('Preparing your weeks…');

        // Demo mode uses local mocks — no API calls. A 3-second delay
        // (matching DEMO_CHART_LOADING_MS) lets the shimmer loading state
        // appear so the placeholder is visible instead of flashing away
        // instantly.
        if (window.__demoMode) {
            coachGenerating = true;
            setTimeout(() => {
                coachPlanData = { history: getMockCoachHistory(), plan: getMockCoachPlan(coachPrefs) };
                renderCoachCalendar(coachPlanData);
                coachLoaded = true;
                coachGenerating = false;
            }, DEMO_CHART_LOADING_MS);
            return;
        }

        // Local 24h cache fast path — skip the network entirely when the
        // cached block already covers the full plan window.
        if (!force) {
            const cached = readCoachCache();
            if (cached && cached.plan && cached.plan.days && cached.plan.total_plan_days
                    && cached.plan.days.length >= cached.plan.total_plan_days) {
                coachPlanData = cached;
                renderCoachCalendar(coachPlanData);
                coachLoaded = true;
                return;
            }
        }

        // Real network generation — mark as in-flight so tab switches don't
        // kick off a second generation while the first is still running.
        coachGenerating = true;
        try {
            // Full-block plans are generated week by week — one AI call per
            // week — so no single request exceeds the Hobby 60s function cap.
            // Weeks are fetched in small parallel batches; a server-side cache
            // hit returns the whole block from the first request.
            const weekStarts = getPlanWeekStarts();
            if (!weekStarts) {
                // Short-window fallback (no future race date) — single request.
                const body = { ...coachPrefs };
                if (force) body.force = '1';
                const resp = await apiCall('POST', 'coach-plan', body);
                const data = await resp.json();
                if (!resp.ok) {
                    // Coach-language error — log the raw server message instead
                    // of surfacing implementation details to the runner.
                    console.warn('Coach plan request failed:', data.error || resp.status);
                    coachErrorEl.textContent = 'Failed to build your plan.';
                    coachErrorEl.hidden = false;
                    coachCalendarEl.innerHTML = '';
                    return;
                }
                coachPlanData = data;
                renderCoachCalendar(coachPlanData);
                coachLoaded = true;
                return;
            }

            const batchSize = 2;
            let history = null;
            let meta = null;
            const daysByDate = {};
            const zonesByDate = {};   // paces ramp across the block — each day knows its week's zones
            let complete = false;
            for (let i = 0; i < weekStarts.length; i += batchSize) {
                const batch = weekStarts.slice(i, i + batchSize);
                const done = Math.min(i + batch.length, weekStarts.length);
                // Chunks are AI calls, not calendar weeks — the first chunk
                // can span up to 13 days, so label them "parts".
                // The headline stroke above already says "Building your plan",
                // so this line carries only the progress — repeating the words
                // read as two competing loading messages.
                const partLabel = weekStarts.length === 1
                    ? 'Preparing your weeks…'
                    : `Part ${i + 1}–${done} of ${weekStarts.length}…`;
                if (i === 0) {
                    // First batch — show the loading skeleton while the first
                    // weeks generate.
                    coachCalendarEl.innerHTML = coachLoadingMarkup(partLabel);
                } else if (coachBuildStatusEl) {
                    // The calendar is already visible (history + first weeks)
                    // — keep a slim status line instead of the skeleton.
                    coachBuildStatusEl.textContent = partLabel;
                    coachBuildStatusEl.hidden = false;
                }
                const results = await Promise.all(batch.map(async (ws) => {
                    // Pass force=1 when the user explicitly regenerates so the
                    // server skips its persistent cache for every week.
                    const body = { ...coachPrefs, week_start: ws };
                    if (force) body.force = '1';
                    const resp = await apiCall('POST', 'coach-plan', body);
                    const data = await resp.json();
                    if (!resp.ok) throw new Error('Failed to build your plan.');
                    return data;
                }));
                for (const data of results) {
                    if (!history && data.history) history = data.history;
                    if (!meta && data.plan) meta = data.plan;
                    for (const d of (data.plan && data.plan.days) || []) {
                        daysByDate[d.date] = d;
                        if (data.plan.zones) zonesByDate[d.date] = data.plan.zones;
                    }
                }
                // Render as soon as the first batch lands — the past activities
                // (history rides along with every chunk response, computed
                // before the AI call) plus any plan weeks generated so far.
                // Later batches re-render with the added weeks so the plan
                // fills in progressively instead of appearing all at once.
                const plan = meta ? { ...meta, days: Object.keys(daysByDate).sort().map(k => daysByDate[k]), zones_by_date: zonesByDate } : {};
                complete = !!(meta && meta.total_plan_days && Object.keys(daysByDate).length >= meta.total_plan_days);
                coachPlanData = { history: history || [], plan };
                renderCoachCalendar(coachPlanData);
                // Stop early when the block is already complete (e.g. the
                // server returned the full cached plan on the first call).
                if (complete) {
                    break;
                }
            }

            if (coachBuildStatusEl) coachBuildStatusEl.hidden = true;
            writeCoachCache(coachPlanData);
            coachLoaded = true;
        } catch (err) {
            coachErrorEl.textContent = (err && err.message) || 'Network error.';
            coachErrorEl.hidden = false;
        } finally {
            coachGenerating = false;
        }
    }

    // Open the plan page — resets the past history window to 2 weeks.
    // Called every time the user navigates to the Plan tab. If the plan is
    // already loaded, we just re-render from the cached data (no refetch);
    // otherwise we kick off the initial generation. The page opens at the
    // top (navigateTo resets the window scroll), led by the race card.
    function openPlanPage() {
        planPastDays = 14;
        // Post-race there is no block left to build. Generating one would produce
        // recovery sessions the runner never asked for and cannot act on, and it
        // would spend an AI call doing it. The calendar still renders — it is the
        // training log now rather than a schedule — from whatever history we
        // already hold.
        if (postRaceState(raceGoal, fullActivitiesLoaded).isPostRace) {
            let source = coachPlanData || readCoachCache();
            // Demo mode never builds a real plan, so its history comes from the
            // mock; without this the calendar would be empty.
            if (!source && window.__demoMode) source = { history: getMockCoachHistory() };
            coachLoaded = true;
            renderCoachCalendar({ history: (source && source.history) || [], plan: {} });
            return;
        }
        if (coachLoaded && coachPlanData) {
            renderCoachCalendar(coachPlanData);
        } else {
            generateCoachPlan(coachPrefs, false);
        }
    }

    // The plan calendar scrolls with the page rather than inside its own box, so
    // a scroll correction has to be applied to whichever ancestor actually
    // overflows rather than to the calendar itself.
    function planScrollContainer() {
        let el = coachCalendarEl.parentElement;
        while (el && el !== document.body) {
            const oy = getComputedStyle(el).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    // data-date of the first day row still visible at the top of the scroller —
    // the row the view is anchored to.
    function planTopVisibleRowDate(scroller) {
        const edge = scroller === document.scrollingElement
            ? 0
            : scroller.getBoundingClientRect().top;
        for (const row of coachCalendarEl.querySelectorAll('.pacey-cal-row')) {
            if (row.getBoundingClientRect().bottom > edge + 1) return row.dataset.date;
        }
        return null;
    }

    function planRowTop(date) {
        const row = coachCalendarEl.querySelector(`.pacey-cal-row[data-date="${date}"]`);
        return row ? row.getBoundingClientRect().top : null;
    }

    // "Show more" on the plan page — extends the past history window by 2 weeks
    // and re-renders. Nothing is fetched: the activities for these weeks already
    // arrived with the plan (see _ui_history_from_cache on the server), so this
    // only reveals weeks the client was already holding.
    //
    // The older weeks are inserted ABOVE the current ones, which shifts the
    // whole calendar down by their height. The view is re-anchored afterwards to
    // the topmost visible row, so the dates under the runner's eyes stay put and
    // the newly revealed weeks simply appear above them. Without that correction
    // the content jumps and then a smooth scroll animates on top of the jump,
    // which is what made this feel wrong.
    if (planShowMoreBtn) {
        planShowMoreBtn.addEventListener('click', () => {
            if (!coachPlanData) return;

            const scroller = planScrollContainer();
            const anchorDate = planTopVisibleRowDate(scroller);
            const before = anchorDate ? planRowTop(anchorDate) : null;

            planPastDays += 14;
            renderCoachCalendar(coachPlanData);

            if (anchorDate && before !== null) {
                const after = planRowTop(anchorDate);
                if (after !== null) scroller.scrollTop += after - before;
            }
        });
    }

    function renderCoachCalendar(data) {
        if (!coachCalendarEl) return;
        const history = data.history || [];
        const plan = data.plan || {};
        // Post-race the block is over, so the calendar carries no workouts. It
        // still renders — the training history is what it is for now — but the
        // race was the last thing in the plan, and a session after it would be
        // advice about a block that no longer exists.
        const planDays = postRaceState(raceGoal, fullActivitiesLoaded).isPostRace ? [] : (plan.days || []);

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
        // How far back the runner has paged to. Kept separate from `start`
        // below, so the "Show more" gate can ask how far back it has *asked* to
        // go independently of how far back there is data to show.
        const desiredStart = new Date(today);
        desiredStart.setDate(desiredStart.getDate() - (planPastDays - 1));
        desiredStart.setDate(desiredStart.getDate() - ((desiredStart.getDay() + 6) % 7)); // back to Monday

        // Oldest week we actually hold activities for. Rendering weeks before it
        // would add blocks that can never hold a card, which is what made the
        // top of the history look empty. The clamp stays Monday-aligned, or the
        // week blocks and their "Week N" labels would drift off the Mon-Sun grid.
        const oldestKey = Object.keys(historyByDate).sort()[0] || null;
        const oldestMonday = oldestKey ? mondayOfKey(oldestKey) : null;
        const start = oldestMonday && oldestMonday > desiredStart ? oldestMonday : desiredStart;

        const daysUntilMonday = ((8 - today.getDay()) % 7) || 7;
        const nextMonday = new Date(today);
        nextMonday.setDate(today.getDate() + daysUntilMonday);
        let end = new Date(nextMonday);
        end.setDate(end.getDate() + 6); // Sunday of the upcoming week
        // With a full-block plan the calendar extends through race day so the
        // whole season is visible; otherwise it stops at the upcoming week.
        if (plan.plan_end) {
            const planEndDate = parseDate(plan.plan_end + 'T00:00:00');
            if (planEndDate > end) end = planEndDate;
        }

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

        // Each week block gets its own "Sync week" row, so the user pushes
        // workouts week by week instead of all at once, plus a heading that
        // names the week, its date range, and the training phase (derived
        // from days left at the week start, mirroring the backend's phase
        // boundaries) so the runner always knows where they are in the block.
        const todayKey = localDateKey(today);
        // Only the current week and the next one may be synced — beyond that
        // the button is disabled, because the runner may still edit those
        // workouts and should always be able to push the updated block.
        const planStartDate = plan.plan_start ? parseDate(plan.plan_start + 'T00:00:00') : new Date(today);
        const planStartMonday = new Date(planStartDate);
        planStartMonday.setDate(planStartDate.getDate() - ((planStartDate.getDay() + 6) % 7));
        const raceDateObj = plan.race_date ? parseDate(plan.race_date + 'T00:00:00') : null;
        const dayMs = 86400000;

        coachCalendarEl.innerHTML = weeks.map(week => {
            const weekStartDate = parseDate(week[0].date + 'T00:00:00');
            const weekOffset = Math.round((weekStartDate - planStartMonday) / dayMs / 7);
            const inSyncWindow = weekOffset === 0 || weekOffset === 1;
            const weekNumber = weekOffset + 1;
            const weekLabel = weekNumber >= 1 ? `Week ${weekNumber}` : 'History';
            const weekEndDate = new Date(weekStartDate);
            weekEndDate.setDate(weekStartDate.getDate() + 6);
            const rangeLabel = `${weekStartDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekEndDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
            const daysLeft = raceDateObj ? Math.round((raceDateObj - weekStartDate) / dayMs) : null;
            const phaseLabel = daysLeft != null ? phaseForDaysLeft(daysLeft) : null;
            // Sendable: today/future, non-rest, with a workout, and not
            // already synced with the current content (edits change the
            // fingerprint, so an updated workout is sendable again).
            const sendable = week.filter(day =>
                day.date >= todayKey && day.plan && !day.plan.is_rest
                && day.plan.workout
                && coachSyncedDates.get(day.date) !== workoutFingerprint(day.plan.workout));
            // Only the two in-window weeks get a button, and only when there
            // is something to sync — weeks beyond the sync window show no
            // button at all (a disabled one would just confuse the runner).
            const showButton = inSyncWindow && sendable.length > 0;
            return `
                <div class="pacey-cal-week-block">
                    <div class="pacey-cal-week-head">
                        <span class="pacey-cal-week-title">${weekLabel}</span>
                        ${phaseLabel ? `<span class="pacey-cal-week-phase">${phaseLabel}</span>` : ''}
                        <span class="pacey-cal-week-range">${rangeLabel}</span>
                    </div>
                    ${week.map(day => renderDayRow(day)).join('')}
                    ${showButton ? `
                    <div class="pacey-cal-week-send">
                        <button type="button" class="pacey-btn pacey-btn-primary pacey-cal-week-send-btn" data-week-start="${week[0].date}" title="Sync this week's workouts to Garmin">
                            <span class="pacey-btn-text">Sync to Garmin</span>
                            <span class="pacey-btn-spinner" hidden></span>
                        </button>
                        <span class="pacey-coach-schedule-status" hidden></span>
                    </div>` : ''}
                </div>
            `;
        }).join('');
        renderPlanRaceCard(plan);

        // "Show more" appears while there are still older weeks to page back to.
        // It compares the oldest week we hold against how far back the runner
        // has *asked* to go, not against where the window ended up — those two
        // used to be the same value, which is precisely why the button could
        // never appear: the window start was always the Monday on or before the
        // oldest date the server sent, so "is there anything older?" was false
        // by construction.
        if (planShowMoreBtn) {
            const hasOlder = !!(oldestMonday && oldestMonday < desiredStart);
            planShowMoreBtn.hidden = !hasOlder;
            planShowMoreBtn.textContent = 'Show more';
            planShowMoreBtn.disabled = false;
        }
    }

    // Header line for the full-block plan: countdown to race day, current
    // Race status card — the plan page header block: race name + meta,
    // current fitness chips, the AI coach line, and drift advice. Hidden
    // for the short-window fallback (a plan with no race target).
    function renderPlanRaceCard(plan) {
        if (!planRaceCardEl) return;
        const postRace = postRaceState(raceGoal, fullActivitiesLoaded);
        const daysToRace = plan.days_to_race;

        // Post-race the card summarises the race instead of counting down to it,
        // and it no longer depends on a plan — there is no plan to depend on, so
        // every figure comes from the goal and the result instead.
        if (postRace.isPostRace) {
            planRaceNameEl.textContent = (raceGoal && raceGoal.race_name) || 'Your race';
            planRaceMetaEl.textContent = [
                raceGoal ? goalDistanceLabel(raceGoal) : '',
                raceGoal && raceGoal.race_date
                    ? new Date(raceGoal.race_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : '',
                postRace.detected
                    ? `${formatFinishTime((postRace.raceResult.duration_min || 0) * 60)} finish`
                    : 'race day passed',
                raceVerdict(postRace),
            ].filter(Boolean).join(' · ');
            // The drawer showed the paces the block was built around, and the
            // trajectory projected whether the goal was reachable — both are moot
            // now. renderFitnessDrawer hides itself on an empty object.
            renderFitnessDrawer({});
            renderTrajectoryNote({});
            if (planInsightEl) { planInsightEl.hidden = true; planInsightEl.textContent = ''; }
            // "Customize plan" opens the prefs modal that rebuilds the block.
            // There is no block to rebuild, so the control goes with it.
            if (planEditBtn) planEditBtn.hidden = true;
            planRaceCardEl.hidden = false;
            return;
        }

        if (planEditBtn) planEditBtn.hidden = false;

        if (daysToRace == null || !plan.race_date || !raceGoal) {
            planRaceCardEl.hidden = true;
            return;
        }
        const fitness = plan.fitness || {};
        planRaceNameEl.textContent = raceGoal.race_name || 'Your goal race';
        const phaseLabel = String(plan.race_phase || 'build').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const raceDateLabel = raceGoal.race_date
            ? new Date(raceGoal.race_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '';
        planRaceMetaEl.textContent = [
            goalDistanceLabel(raceGoal),
            fitness.goal_pace ? `${fitness.goal_pace}/km` : '',
            raceDateLabel,
            `${daysToRace} ${daysToRace === 1 ? 'day' : 'days'} to race`,
            phaseLabel,
        ].filter(Boolean).join(' · ');

        renderFitnessDrawer(fitness);
        planRaceCardEl.hidden = false;

        renderTrajectoryNote(plan);
        loadPlanInsight();
    }

    // Training paces drawer — a pace range per type plus the runs that
    // produced it. Each run links to the activities page.
    function renderFitnessDrawer(fitness) {
        if (!planFitnessEl) return;
        if (!fitness || !fitness.current_quality_pace) {
            planFitnessEl.hidden = true;
            return;
        }
        const easyLabel = fitness.current_easy_range
            || (fitness.current_easy_pace ? `≈${fitness.current_easy_pace}` : '--');
        const fastLabel = fitness.current_quality_range
            || (fitness.current_quality_pace ? `≈${fitness.current_quality_pace}` : '--');
        planFitnessSummaryEl.textContent = `Long ${easyLabel} · Speed ${fastLabel} · Goal ${fitness.goal_pace || '--'}`;
        planPaceEasyRangeEl.textContent = easyLabel;
        planPaceFastRangeEl.textContent = fastLabel;
        planPaceEasyRunsEl.innerHTML = buildFitnessRunRows(fitness.current_easy_runs || []);
        planPaceFastRunsEl.innerHTML = buildFitnessRunRows(fitness.current_quality_runs || []);
        const easyRuns = (fitness.current_easy_runs || []).length;
        const fastRuns = (fitness.current_quality_runs || []).length;
        planPaceEasyNoteEl.textContent = easyRuns
            ? `Based on ${easyRuns} recent run${easyRuns === 1 ? '' : 's'}.`
            : 'No recent easy runs — goal-based reference only.';
        planPaceEasyNoteEl.hidden = false;
        planPaceFastNoteEl.textContent = fastRuns
            ? `Based on ${fastRuns} recent quality run${fastRuns === 1 ? '' : 's'}.`
            : 'No recent quality runs — goal-based reference only.';
        planPaceFastNoteEl.hidden = false;
        planFitnessEl.hidden = false;
    }

    function buildFitnessRunRows(runs) {
        return runs.map(r => {
            const date = r.date
                ? new Date(r.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : '--';
            const pace = r.avg_pace ? formatPace(r.avg_pace) : '--';
            const dist = r.distance != null ? `${r.distance} km` : '';
            const id = r.id != null ? r.id : '';
            return `
                <li>
                    <button class="pacey-plan-fitness-run" type="button" data-activity-id="${escapeHtml(String(id))}"
                            aria-label="View ${escapeHtml(r.name || 'Run')} in activities">
                        <span class="pacey-plan-fitness-run-date">${date}</span>
                        <span class="pacey-plan-fitness-run-name">${escapeHtml(r.name || 'Run')}</span>
                        <span class="pacey-plan-fitness-run-meta">${dist}${dist ? ' · ' : ''}${pace}/km</span>
                        <svg class="pacey-plan-fitness-run-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
                    </button>
                </li>
            `;
        }).join('');
    }

    // Jump to a specific run on the activities page and flash-highlight it.
    function navigateToActivity(activityId) {
        if (!activityId) return;
        window.location.hash = 'activities';
        // The activities page renders asynchronously — retry until the row
        // exists (or give up after ~5s).
        let attempts = 0;
        const iv = setInterval(() => {
            attempts++;
            const el = document.querySelector(`.pacey-activity-item[data-activity-id="${CSS.escape(String(activityId))}"]`);
            if (el) {
                clearInterval(iv);
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('pacey-activity-item--flash');
                setTimeout(() => el.classList.remove('pacey-activity-item--flash'), 2000);
            } else if (attempts > 20) {
                clearInterval(iv);
            }
        }, 250);
    }

    // Drawer expand/collapse + run navigation (event delegation).
    if (planFitnessToggle) {
        planFitnessToggle.addEventListener('click', () => {
            const open = planFitnessToggle.getAttribute('aria-expanded') === 'true';
            planFitnessToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
            planFitnessBody.hidden = open;
        });
    }
    if (planFitnessEl) {
        planFitnessEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.pacey-plan-fitness-run');
            if (btn) navigateToActivity(btn.getAttribute('data-activity-id'));
        });
    }

    // Trajectory status row inside the race card — always visible when
    // fitness data exists: a colored dot + label + one supporting line,
    // with a rebuild button when the runner drifts behind or ahead.
    function renderTrajectoryNote(plan) {
        if (!planTrajectoryEl) return;
        const t = plan.trajectory;
        if (!t || !t.status) { planTrajectoryEl.hidden = true; return; }
        const labels = { on_track: 'On track', behind: 'Behind plan', ahead: 'Ahead of plan', mixed: 'Not proven' };
        // The rebuild affordance tracks PLAN staleness (fitness has moved since
        // the block was generated), not the readiness verdict — rebuilding
        // can't change whether you're ahead of the goal, but it does refresh a
        // block projected from older fitness. Clears once rebuilt.
        const canRebuild = !!t.rebuild;
        planTrajectoryEl.className = `pacey-plan-trajectory pacey-plan-trajectory--${t.status}`;
        planTrajectoryEl.innerHTML = `
            <span class="pacey-plan-trajectory-dot"></span>
            <span class="pacey-plan-trajectory-label">${labels[t.status] || 'On track'}</span>
            <span class="pacey-plan-trajectory-note">${escapeHtml(t.note || '')}</span>
            ${canRebuild ? '<button class="pacey-btn pacey-btn-secondary pacey-plan-trajectory-rebuild" type="button">Rebuild remaining block</button>' : ''}
        `;
        planTrajectoryEl.hidden = false;
    }

    // Rebuild restarts the remaining block from current fitness (force
    // regeneration).
    if (planTrajectoryEl) {
        planTrajectoryEl.addEventListener('click', (e) => {
            if (e.target.closest('.pacey-plan-trajectory-rebuild')) {
                generateCoachPlan(coachPrefs, true);
            }
        });
    }

    // AI coach line for the race card — one short paragraph, generated once
    // per plan (guarded by plan_start). Demo mode shows a canned line.
    let lastInsightPlanStart = null;
    async function loadPlanInsight() {
        const plan = coachPlanData && coachPlanData.plan ? coachPlanData.plan : null;
        if (!plan || !planInsightEl || !planRaceCardEl || planRaceCardEl.hidden) return;
        if (lastInsightPlanStart === plan.plan_start) return;
        lastInsightPlanStart = plan.plan_start;
        if (window.__demoMode) {
            planInsightEl.textContent = 'Your recent long runs sit right at the shape this goal needs — this week keeps the engine ticking with easy miles and one quality touch.';
            planInsightEl.hidden = false;
            return;
        }
        if (!plan.fitness) { planInsightEl.hidden = true; return; }
        // A skeleton rather than a phrase: this line sits inside the race card,
        // which already carries a lot of text, so the loading state stays quiet.
        // Decorative, so it's hidden from screen readers.
        planInsightEl.innerHTML = '<span class="pacey-skeleton-lines" aria-hidden="true">'
            + '<span class="pacey-skeleton-line"></span>'
            + '<span class="pacey-skeleton-line"></span>'
            + '<span class="pacey-skeleton-line pacey-skeleton-line--short"></span>'
            + '</span>';
        planInsightEl.hidden = false;
        const context = {
            race_goal: raceGoal,
            fitness: plan.fitness,
            race_phase: plan.race_phase || '',
            days_to_race: plan.days_to_race,
            trajectory_status: (plan.trajectory && plan.trajectory.status) || 'on_track',
            trajectory_note: (plan.trajectory && plan.trajectory.note) || '',
        };
        try {
            const resp = await apiCall('POST', 'coach-plan', { action: 'insight', kind: 'plan', context });
            const data = await resp.json();
            if (resp.ok && data.insight) {
                planInsightEl.textContent = data.insight;
            } else {
                planInsightEl.hidden = true;
            }
        } catch (err) {
            planInsightEl.hidden = true;
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
            <div class="pacey-cal-row ${isToday ? 'pacey-cal-row--today' : ''} ${isPast ? 'pacey-cal-row--past' : ''}" data-date="${day.date}">
                <div class="pacey-cal-date">
                    <span class="pacey-cal-date-dow">${dow}</span>
                    <span class="pacey-cal-date-value">
                        <span class="pacey-cal-date-num">${dayNum}</span>
                        <span class="pacey-cal-date-month">${monthShort}</span>
                    </span>
                </div>
                <div class="pacey-cal-cards">${cards.join('')}</div>
            </div>
        `;
    }

    function renderHistoryCard(r) {
        const pace = formatPace(r.avg_pace);
        const tagClass = RUN_TAG_CLASS[r.run_tag] || 'pacey-run-tag--easy';
        return `
            <div class="pacey-cal-card pacey-cal-card--past">
                <div class="pacey-cal-card-title-row">
                    <span class="pacey-cal-card-title">${escapeHtml(r.name || 'Run')}</span>
                    <span class="pacey-run-tag ${tagClass}">${escapeHtml(r.run_tag || 'Easy')}</span>
                </div>
                <div class="pacey-cal-card-row">
                    <span class="pacey-cal-card-meta">${r.distance} km · ${pace}/km</span>
                </div>
            </div>
        `;
    }

    // Title-case a workout title: capitalise the first letter of each
    // lowercase word, but leave numbers and the "x" in rep schemes
    // ("6 x 400m") untouched. Already-capitalised words are left alone.
    function formatWorkoutTitle(title) {
        if (!title) return title;
        return title.replace(/\b[a-z][a-z']*/g, (word) => (
            word === 'x' ? word : word[0].toUpperCase() + word.slice(1)
        ));
    }

    function renderPlanCard(d) {
        // "Synced" only when the exact current workout content has been
        // pushed to Garmin — an edit invalidates the fingerprint, so the
        // badge drops off until the updated session is synced again.
        const synced = d.workout && coachSyncedDates.get(d.date) === workoutFingerprint(d.workout);
        const editing = coachEditingDate === d.date;

        if (d.is_rest || !d.workout) {
            return `
                <div class="pacey-cal-card pacey-cal-card--rest">
                    <span class="pacey-cal-rest-label">Rest</span>
                </div>
            `;
        }

        const w = d.workout;
        const pace = w.target_pace_min_per_km || '--';
        const tagClass = WORKOUT_TAG_CLASS[w.type] || 'pacey-run-tag--easy';

        if (editing) {
            return `
                <div class="pacey-cal-card pacey-cal-card--editing">
                    <div class="pacey-cal-card-top">
                        <span class="pacey-run-tag ${tagClass}">${escapeHtml(w.type)}</span>
                        ${synced ? '<span class="pacey-plan-scheduled-badge">Synced</span>' : ''}
                    </div>
                    <div class="pacey-plan-controls">
                        <label class="pacey-plan-control">
                            <span class="pacey-plan-control-label">Type</span>
                            <select data-field="type" data-date="${d.date}">
                                ${WORKOUT_TYPES.map(t => `<option ${t === w.type ? 'selected' : ''}>${t}</option>`).join('')}
                            </select>
                        </label>
                        <label class="pacey-plan-control">
                            <span class="pacey-plan-control-label">Distance (km)</span>
                            <input type="number" data-field="distance_km" data-date="${d.date}" value="${w.distance_km ?? ''}" min="0" step="0.5">
                        </label>
                        <label class="pacey-plan-control">
                            <span class="pacey-plan-control-label">Duration (min)</span>
                            <input type="number" data-field="duration_min" data-date="${d.date}" value="${w.duration_min ?? ''}" min="0" step="5">
                        </label>
                    </div>
                    <p class="pacey-cal-card-pace">Target pace: ${pace}/km</p>
                    <p class="pacey-cal-card-desc">${escapeHtml(w.description || '')}</p>
                    <div class="pacey-cal-card-actions">
                        <button class="pacey-cal-save-btn" type="button" data-action="save" data-date="${d.date}">Done</button>
                        <button class="pacey-cal-rest-toggle" type="button" data-action="mark-rest" data-date="${d.date}">Rest day</button>
                    </div>
                </div>
            `;
        }

        return `
            <div class="pacey-cal-card pacey-cal-card--suggested ${synced ? 'pacey-cal-card--scheduled' : ''}" draggable="true" data-action="view" data-date="${d.date}">
                <span class="pacey-drag-handle" title="Drag to rearrange" aria-hidden="true">
                    <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor"><circle cx="4" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="4" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="4" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>
                </span>
                <div class="pacey-cal-card-body">
                    <div class="pacey-cal-card-title-row">
                        <span class="pacey-cal-card-title">${escapeHtml(formatWorkoutTitle(w.title || w.type))}</span>
                        <span class="pacey-run-tag ${tagClass}">${escapeHtml(w.type)}</span>
                        ${synced ? '<span class="pacey-plan-scheduled-badge">Synced</span>' : ''}
                    </div>
                    <div class="pacey-cal-card-row">
                        <span class="pacey-cal-card-meta">${w.distance_km ? `${w.distance_km} km · ` : ''}${pace}/km</span>
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
            // The workout changed — any previously generated insight is stale.
            day.workout.insight = null;
        } else if (field === 'type') {
            day.workout.type = value;
            // The workout changed — any previously generated insight is stale.
            day.workout.insight = null;
        } else {
            day.workout[field] = value;
        }
        renderCoachCalendar(coachPlanData);
        // Recompile server-side so the paces, distances, durations, totals and
        // step breakdown are all recomputed from the edit. The card, the detail
        // sheet and the Garmin upload read the compiled structure, so they must
        // move together — editing only the raw field would let them drift.
        if (field !== 'date') recompileDay(dateKey);
    }

    // Ask the server to recompile one edited workout and swap in the result.
    // Uses the day's own week pace zones so the recomputed paces still reflect
    // the runner's current fitness at that point in the block.
    async function recompileDay(dateKey) {
        if (window.__demoMode) return;
        const plan = coachPlanData && coachPlanData.plan;
        const day = plan ? plan.days.find(x => x.date === dateKey) : null;
        if (!day || !day.workout) return;
        const zones = (plan.zones_by_date || {})[dateKey] || plan.pace_zones || {};
        try {
            const resp = await apiCall('POST', 'coach-plan', { action: 'compile', workout: day.workout, zones });
            const data = await resp.json();
            if (resp.ok && data.workout) {
                data.workout.insight = null;
                day.workout = data.workout;
                renderCoachCalendar(coachPlanData);
            }
        } catch (err) {
            console.warn('Workout recompile failed:', err);
        }
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
        const card = e.target.closest('.pacey-cal-card[draggable="true"]');
        if (!card) return;
        dragDate = card.getAttribute('data-date');
        card.classList.add('pacey-cal-card--dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragDate); } catch (err) {}
    });

    coachCalendarEl.addEventListener('dragend', (e) => {
        const card = e.target.closest('.pacey-cal-card');
        if (card) card.classList.remove('pacey-cal-card--dragging');
        coachLastDragEnd = Date.now();
        dragDate = null;
    });

    coachCalendarEl.addEventListener('dragover', (e) => {
        const row = e.target.closest('.pacey-cal-row');
        if (!row || !dragDate) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('pacey-cal-row--drop-target');
    });

    coachCalendarEl.addEventListener('dragleave', (e) => {
        const row = e.target.closest('.pacey-cal-row');
        if (row) row.classList.remove('pacey-cal-row--drop-target');
    });

    coachCalendarEl.addEventListener('drop', (e) => {
        const row = e.target.closest('.pacey-cal-row');
        if (!row) return;
        row.classList.remove('pacey-cal-row--drop-target');
        const targetDate = row.getAttribute('data-date');
        const sourceDate = dragDate || e.dataTransfer.getData('text/plain');
        if (sourceDate && targetDate) moveWorkout(sourceDate, targetDate);
        dragDate = null;
    });

    // --- Touch drag ---------------------------------------------------------
    // The HTML5 drag-and-drop above is mouse-only, so on a phone the browser's
    // own gestures (scroll, text selection, the long-press callout) win and the
    // drag never starts. Touch therefore uses Pointer Events with a
    // press-and-hold activation, started from the drag handle — the one region
    // that opts out of the browser's touch behaviour via `touch-action: none`
    // (putting that on the whole card would break scrolling over the calendar).
    const TOUCH_DRAG_HOLD_MS = 300;      // press-and-hold before a drag begins
    const TOUCH_DRAG_TOLERANCE_PX = 8;   // movement allowed during the hold
    let touchDrag = null;

    function clearDropHighlight() {
        coachCalendarEl.querySelectorAll('.pacey-cal-row--drop-target')
            .forEach(r => r.classList.remove('pacey-cal-row--drop-target'));
    }

    coachCalendarEl.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;   // mouse keeps the HTML5 path
        const handle = e.target.closest('.pacey-drag-handle');
        if (!handle) return;
        const card = handle.closest('.pacey-cal-card[draggable="true"]');
        if (!card) return;
        // Stop the native drag from also starting on a long-press
        card.setAttribute('draggable', 'false');
        // Keep receiving moves even if the finger leaves the handle
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        touchDrag = {
            pointerId: e.pointerId,
            startX: e.clientX, startY: e.clientY,
            card, date: card.getAttribute('data-date'),
            timer: null, active: false, targetRow: null,
        };
        touchDrag.timer = setTimeout(() => {
            if (!touchDrag) return;
            touchDrag.active = true;
            touchDrag.timer = null;
            touchDrag.card.classList.add('pacey-cal-card--dragging');
            dragDate = touchDrag.date;
            // Clear any text selection the long-press may have already started
            const sel = window.getSelection && window.getSelection();
            if (sel) sel.removeAllRanges();
            // A short buzz confirms the drag has engaged, where supported
            if (navigator.vibrate) { try { navigator.vibrate(10); } catch (err) { /* ignore */ } }
        }, TOUCH_DRAG_HOLD_MS);
    });

    coachCalendarEl.addEventListener('pointermove', (e) => {
        if (!touchDrag || e.pointerId !== touchDrag.pointerId) return;
        if (!touchDrag.active) {
            // Moved before the hold completed — the runner meant to scroll
            if (Math.abs(e.clientX - touchDrag.startX) > TOUCH_DRAG_TOLERANCE_PX
                    || Math.abs(e.clientY - touchDrag.startY) > TOUCH_DRAG_TOLERANCE_PX) {
                clearTimeout(touchDrag.timer);
                touchDrag.card.setAttribute('draggable', 'true');
                touchDrag = null;
            }
            return;
        }
        e.preventDefault();
        // Highlight whichever day row sits under the finger
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const row = el && el.closest ? el.closest('.pacey-cal-row') : null;
        if (row !== touchDrag.targetRow) {
            clearDropHighlight();
            if (row) row.classList.add('pacey-cal-row--drop-target');
            touchDrag.targetRow = row;
        }
    });

    function endTouchDrag(e, commit) {
        if (!touchDrag || (e && e.pointerId !== touchDrag.pointerId)) return;
        const state = touchDrag;
        touchDrag = null;
        if (state.timer) clearTimeout(state.timer);
        state.card.classList.remove('pacey-cal-card--dragging');
        state.card.setAttribute('draggable', 'true');
        clearDropHighlight();
        dragDate = null;
        if (!state.active) return;
        // A drag just ended — swallow the click that follows, so releasing
        // doesn't also open the workout sheet.
        coachLastDragEnd = Date.now();
        if (commit) {
            const targetDate = state.targetRow && state.targetRow.getAttribute('data-date');
            if (targetDate) moveWorkout(state.date, targetDate);
        }
    }

    coachCalendarEl.addEventListener('pointerup', (e) => endTouchDrag(e, true));
    coachCalendarEl.addEventListener('pointercancel', (e) => endTouchDrag(e, false));

    // Long-pressing the handle on Android would otherwise raise the context menu
    coachCalendarEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.pacey-drag-handle')) e.preventDefault();
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
            const zones = (coachPlanData.plan.zones_by_date || {})[dateKey]
                || coachPlanData.plan.pace_zones || {};
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
        const tagClass = WORKOUT_TAG_CLASS[w.type] || 'pacey-run-tag--easy';
        const sheetDate = parseDate(dateKey + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

        // Build a numbered procedure: top-level steps get a step number, steps
        // inside a repeat group are indented beneath the "Repeat N×" marker.
        // Each step's pace is rendered as a separate element with its own
        // spacing so the time/distance and pace don't run together.
        const steps = w.steps || [];
        let stepNum = 0;
        const stepsHtml = steps.map(s => {
            const paceHtml = s.pace ? `<span class="pacey-sheet-step-pace">${escapeHtml(s.pace)}/km</span>` : '';
            if (s.level === 1) {
                return `<div class="pacey-sheet-step pacey-sheet-step--sub"><span class="pacey-sheet-step-type">↳ ${escapeHtml(s.type || 'Run')}</span><span class="pacey-sheet-step-detail">${escapeHtml(s.detail || '')}</span>${paceHtml}</div>`;
            }
            stepNum += 1;
            const isRepeat = s.type === 'Repeat';
            return `<div class="pacey-sheet-step ${isRepeat ? 'pacey-sheet-step--repeat' : ''}"><span class="pacey-sheet-step-num">${stepNum}</span><span class="pacey-sheet-step-type">${escapeHtml(s.type || 'Run')}</span><span class="pacey-sheet-step-detail">${escapeHtml(s.detail || '')}</span>${paceHtml}</div>`;
        }).join('');

        // Workout description — the short 1-2 sentence intent summary that
        // is also sent to Garmin as the workout description. Shown before
        // the AI coach insight so the runner sees the session purpose first.
        const descriptionHtml = w.description ? `
            <div class="pacey-sheet-section">
                <span class="pacey-sheet-section-title">Description</span>
                <p class="pacey-sheet-description">${escapeHtml(w.description)}</p>
            </div>` : '';

        // Coach insight is lazy: the full-block plan carries no insight text,
        // so the sheet shows a placeholder and fills it on demand from
        // /api/coach-plan (action "insight") (canned text in demo mode).
        const insightHtml = `
            <div class="pacey-sheet-section" id="pacey-sheet-insight-slot">
                <span class="pacey-sheet-section-title">Coach insight</span>
                ${w.insight
                    ? `<p class="pacey-sheet-insight">${escapeHtml(w.insight)}</p>`
                    : '<div class="pacey-sheet-insight pacey-sheet-insight--loading" aria-hidden="true">'
                        + '<span class="pacey-skeleton-lines">'
                        + '<span class="pacey-skeleton-line"></span>'
                        + '<span class="pacey-skeleton-line"></span>'
                        + '<span class="pacey-skeleton-line pacey-skeleton-line--short"></span>'
                        + '</span></div>'}
            </div>`;

        workoutSheetBody.innerHTML = `
            <div class="pacey-sheet-header">
                <h3 class="pacey-sheet-title">${escapeHtml(formatWorkoutTitle(w.title || w.type))}</h3>
                <span class="pacey-run-tag ${tagClass}">${escapeHtml(w.type)}</span>
            </div>
            <div class="pacey-sheet-meta">
                ${w.distance_km ? `<span class="pacey-sheet-meta-item"><strong>${w.distance_km}</strong> km</span>` : ''}
                ${w.duration_min ? `<span class="pacey-sheet-meta-item"><strong>${w.duration_min}</strong> min</span>` : ''}
                <span class="pacey-sheet-meta-item"><strong>${pace}</strong>/km</span>
                <span class="pacey-sheet-meta-item">${sheetDate}</span>
            </div>
            ${descriptionHtml}
            ${insightHtml}
            ${stepsHtml ? `<div class="pacey-sheet-section"><span class="pacey-sheet-section-title">Workout breakdown</span><div class="pacey-sheet-steps">${stepsHtml}</div></div>` : ''}
        `;
        workoutSheet.hidden = false;
        // Fill the insight slot when the plan did not carry one.
        if (!w.insight) loadWorkoutInsight(dateKey, w);
        // Force reflow so the initial transform applies before the slide-up
        void workoutSheet.offsetHeight;
        workoutSheet.classList.add('pacey-sheet-overlay--open');
        workoutSheetClose.focus();
    }

    // Lazy coach insight — called when a workout card opens without one.
    // Writes the paragraph from the workout spec; keeps the sheet open and
    // swaps the placeholder when the text arrives.
    async function loadWorkoutInsight(dateKey, w) {
        if (window.__demoMode) {
            setTimeout(() => {
                w.insight = mockInsight(dateKey, w);
                renderSheetInsight(w);
            }, 500);
            return;
        }
        // Plan context — where this session sits in the block, so the insight
        // is written for the week (week number, previous session) and not the
        // workout in isolation. The backend derives phase from the session
        // date itself.
        const context = {};
        const plan = coachPlanData && coachPlanData.plan ? coachPlanData.plan : null;
        if (plan && plan.plan_start) {
            const start = parseDate(plan.plan_start + 'T00:00:00');
            const d = parseDate(dateKey + 'T00:00:00');
            const dayDiff = Math.round((d - start) / 86400000);
            if (dayDiff >= 0) {
                context.week_index = Math.floor(dayDiff / 7) + 1;
                context.total_weeks = Math.max(1, Math.ceil((plan.total_plan_days || 1) / 7));
            }
            const idx = plan.days.findIndex(x => x.date === dateKey);
            for (let i = idx - 1; i >= 0; i--) {
                const pd = plan.days[i];
                if (pd && pd.workout) {
                    context.prev_workout = `${pd.workout.type}${pd.workout.distance_km ? ' ' + pd.workout.distance_km + ' km' : ''} — ${pd.workout.title || ''}`;
                    break;
                }
            }
        }
        const body = {
            date: dateKey,
            workout: {
                type: w.type,
                title: w.title,
                description: w.description,
                distance_km: w.distance_km,
                duration_min: w.duration_min,
                intensity: w.intensity,
                target_pace_min_per_km: w.target_pace_min_per_km,
                // The compiled structure — the insight describes the exact
                // session that will be sent to the watch, not a re-imagined one.
                totals: w.totals,
                segments: w.segments,
            },
            context,
        };
        try {
            const resp = await apiCall('POST', 'coach-plan', { action: 'insight', ...body });
            const data = await resp.json();
            if (!resp.ok) throw new Error('Failed to write insight.');
            w.insight = data.insight;
        } catch (err) {
            w.insight = '';
        }
        renderSheetInsight(w);
    }

    // Swap the placeholder insight section for the real text (or an error).
    function renderSheetInsight(w) {
        const slot = document.getElementById('pacey-sheet-insight-slot');
        if (!slot) return;
        if (w.insight) {
            slot.innerHTML = `<span class="pacey-sheet-section-title">Coach insight</span><p class="pacey-sheet-insight">${escapeHtml(w.insight)}</p>`;
        } else {
            slot.innerHTML = '<span class="pacey-sheet-section-title">Coach insight</span><p class="pacey-sheet-insight pacey-sheet-insight--error">Could not write your insight right now. Try again later.</p>';
        }
    }

    function closeWorkoutSheet() {
        workoutSheet.classList.remove('pacey-sheet-overlay--open');
        // Wait for the exit animation before hiding — listen on the sheet
        // element since both the slide-down (mobile) and scale-out (desktop)
        // transitions happen there via transform
        const sheet = workoutSheet.querySelector('.pacey-workout-sheet');
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

    // Weekly Garmin send — a button under each week block pushes that
    // week's unscheduled workouts. Delegated on the calendar element since
    // the calendar re-renders after every send.
    coachCalendarEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.pacey-cal-week-send-btn');
        if (btn) scheduleWeek(btn.dataset.weekStart, btn);
    });

    async function scheduleWeek(weekStart, btn) {
        if (!coachPlanData || !coachPlanData.plan) return;
        const todayKey = localDateKey(new Date());
        const weekStartDate = parseDate(weekStart + 'T00:00:00');
        const weekEndDate = new Date(weekStartDate);
        weekEndDate.setDate(weekEndDate.getDate() + 6);
        const weekEnd = localDateKey(weekEndDate);
        const days = coachPlanData.plan.days
            .filter(d => !d.is_rest && d.workout
                && coachSyncedDates.get(d.date) !== workoutFingerprint(d.workout)
                && d.date >= todayKey && d.date >= weekStart && d.date <= weekEnd)
            .map(d => ({ date: d.date, workout: d.workout }));
        // Map the sent workouts by date so the synced fingerprints can be
        // recorded from the API response.
        const workoutByDate = {};
        days.forEach(d => { workoutByDate[d.date] = d.workout; });
        const statusEl = btn.nextElementSibling;
        // The status line now only carries messages that need explaining, so
        // it is shown in the error tone rather than the old success green.
        const setStatus = (msg) => {
            statusEl.textContent = msg;
            statusEl.classList.add('pacey-coach-schedule-status--error');
            statusEl.hidden = false;
        };

        if (!days.length) {
            statusEl.textContent = 'Nothing to send for this week.';
            statusEl.classList.remove('pacey-coach-schedule-status--error');
            statusEl.hidden = false;
            return;
        }

        // The upload only takes a second or two, so the in-progress state is a
        // spinner on the button rather than a status line — the button label is
        // swapped out while it spins. Text is reserved for outcomes that need
        // explaining (nothing to send, or a failure).
        const btnText = btn.querySelector('.pacey-btn-text');
        const btnSpinner = btn.querySelector('.pacey-btn-spinner');
        const setSyncing = (on) => {
            btn.disabled = on;
            if (btnText) btnText.hidden = on;
            if (btnSpinner) btnSpinner.hidden = !on;
        };
        statusEl.hidden = true;
        setSyncing(true);

        // Demo mode: simulate success without touching Garmin
        if (window.__demoMode) {
            days.forEach(d => coachSyncedDates.set(d.date, workoutFingerprint(d.workout)));
            btn.hidden = true;
            renderCoachCalendar(coachPlanData);
            return;
        }

        try {
            const resp = await apiCall('POST', 'coach-plan', { action: 'schedule', days });
            const data = await resp.json();
            if (!resp.ok) {
                console.warn('Schedule request failed:', data.error || resp.status);
                setStatus('Could not send workouts to Garmin. Please try again.');
            } else {
                (data.scheduled || []).forEach(s => {
                    if (workoutByDate[s.date]) {
                        coachSyncedDates.set(s.date, workoutFingerprint(workoutByDate[s.date]));
                    }
                });
                const errorCount = (data.errors || []).length;
                if (errorCount) {
                    // Leave the button up so the runner can retry; a re-render
                    // here would wipe this message.
                    setStatus(`${errorCount} workout${errorCount !== 1 ? 's' : ''} could not be sent. Please try again.`);
                } else {
                    // Silent success — the "Synced" badges on the cards are the
                    // feedback, and the week's button disappears.
                    btn.hidden = true;
                    renderCoachCalendar(coachPlanData);
                }
            }
        } catch (err) {
            setStatus('Network error. Please try again.');
        } finally {
            setSyncing(false);
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

    const savedToken = localStorage.getItem('pacey_session_token');
    if (savedToken && savedToken !== 'demo') {
        // Real Garmin session — restore cached profile data for instant render
        sessionToken = savedToken;
        displayName = localStorage.getItem('pacey_display_name') || 'Runner';
        profileImageUrl = localStorage.getItem('pacey_profile_image_url') || '';
        const cachedRaceGoal = localStorage.getItem('pacey_race_goal');
        const hasCachedRaceGoal = cachedRaceGoal && cachedRaceGoal !== 'null';
        window.__demoMode = false;
        // Hide demo CTAs since we have a real session
        const demoCta = $('#pacey-demo-cta');
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
                localStorage.setItem('pacey_display_name', displayName);
                localStorage.setItem('pacey_profile_image_url', profileImageUrl);
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
                        localStorage.setItem('pacey_race_goal', JSON.stringify(raceGoal));
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
                localStorage.removeItem('pacey_session_token');
                localStorage.removeItem('pacey_display_name');
                localStorage.removeItem('pacey_profile_image_url');
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
                // Metrics first (it stocks the shared cache), then the two
                // readers in parallel — same sequencing as loadAllData so a
                // background refresh can never trip the concurrent-login race.
                const metricsResp = await apiCallWithAuthRetry('GET', 'metrics');
                const metricsData = await metricsResp.json();
                if (metricsResp.ok && metricsData.metrics) {
                    renderMetrics(metricsData.metrics);
                    writeSWRCache(METRICS_CACHE_KEY, metricsData.metrics);
                }
                const [activitiesResp, mileageResp] = await Promise.all([
                    apiCallWithAuthRetry('GET', `activities?limit=${ACTIVITIES_PAGE_SIZE}&offset=0`),
                    apiCallWithAuthRetry('GET', 'activities?mode=mileage&weeks=12'),
                ]);
                const activitiesData = await activitiesResp.json();
                const mileageData = await mileageResp.json();
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
