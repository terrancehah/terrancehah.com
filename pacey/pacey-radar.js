/* =====================================================================
   PACEY RADAR — window.PaceyRadar
   ---------------------------------------------------------------------
   The six-area radar's shared presentation: dimension names, label
   splitting, run-colour palette and the Chart.js config. The app keeps
   its interactive callbacks (label-click scroll, external tooltip) and
   passes them in as options; read-only surfaces such as the landing's
   sample preview simply omit them. Classic script — no imports.
   ===================================================================== */

window.PaceyRadar = (function () {
    'use strict';

    /* Six fitness areas the AI reports on. Plain-English names chosen for
       readability over jargon ('Aerobic Endurance', not 'VO2 Max'). */
    var DIMENSIONS = [
        'Lactate Threshold',
        'Aerobic Endurance',
        'Running Economy',
        'Strength / Durability',
        'VO₂max / Speed',
        'Fatigue Resistance',
    ];

    /* Split a dimension label into two lines at the natural break point.
       Used by the radar chart's pointLabels callback so labels take less
       horizontal space, allowing a larger radar polygon — especially on
       mobile. Returns an array of strings for Chart.js multi-line
       rendering. */
    function splitLabel(label) {
        // Labels with a slash: break at the slash
        if (label.includes(' / ')) {
            var parts = label.split(' / ');
            return [parts[0], parts.slice(1).join(' / ')];
        }
        // Labels with a space: break at the last space so the second line
        // is shorter (e.g. "Lactate Threshold" → ["Lactate", "Threshold"])
        var spaceIdx = label.lastIndexOf(' ');
        if (spaceIdx > 0) {
            return [label.slice(0, spaceIdx), label.slice(spaceIdx + 1)];
        }
        // No break point — return as single-line
        return [label];
    }

    /* Radar dimension colours — read from the same tokens used by the
       dimension explainer dots so the radar and the explainer modal stay
       in sync. Since Chart.js needs rgba strings (not CSS variables),
       the computed hex tokens are read and 0.7 alpha applied inline.
       The element defaults to the board's paper area (#pacey-content),
       which carries the board palette in both themes. */
    function hex(el, name, fallback) {
        var value = getComputedStyle(el)
            .getPropertyValue(name).trim() || fallback;
        var r = parseInt(value.slice(1, 3), 16);
        var g = parseInt(value.slice(3, 5), 16);
        var b = parseInt(value.slice(5, 7), 16);
        return 'rgba(' + r + ', ' + g + ', ' + b + ', 0.7)';
    }

    var COLOR_VARS = ['--pacey-run-speedwork', '--pacey-accent-green', '--pacey-run-tempo', '--pacey-run-lsd', '--pacey-blue', '--pacey-run-easy'];
    var COLOR_FALLBACKS = ['#c44b4b', '#3f7b4f', '#8a6313', '#5d6db0', '#457b9d', '#388e8e'];

    function dimensionColors(el) {
        el = el || document.getElementById('pacey-content') || document.documentElement;
        return COLOR_VARS.map(function (v, i) { return hex(el, v, COLOR_FALLBACKS[i]); });
    }

    /* Chart.js reads font families at runtime — resolve the board's
       handwriting stacks off the canvas (or an explicit override). */
    function chartFont(el, varName) {
        var value = el ? getComputedStyle(el).getPropertyValue(varName).trim() : '';
        return value || "'Fuzzy Bubbles', 'Caveat', cursive";
    }

    /* The radar config — 0–10 scale, navy grid, handwriting labels, no
       legend, native tooltips off. Callers may pass onClick /
       externalTooltip for interactive use; without them the chart is
       inert and read-only. Loading callers pass loadingFill /
       loadingLine / loadingPoint for the desaturated stand-in style. */
    function createConfig(opts) {
        var canvas = opts.canvas;
        var loading = !!opts.loading;
        /* readOnly callers get a fully inert chart: no event handlers
           registered and no hover growth on points. */
        var readOnly = !!opts.readOnly;
        var pointColors = opts.pointColors || dimensionColors(canvas);
        var headingFont = opts.headingFont || chartFont(canvas, '--pacey-chart-heading-font');
        // Axis-label ink reads --pacey-navy off the canvas so the chart
        // follows the surface it sits on (paper in previews, app surface
        // on the readiness page); overridden via opts.labelColor.
        var labelColor = opts.labelColor
            || (canvas ? getComputedStyle(canvas).getPropertyValue('--pacey-navy').trim() : '')
            || '#1d3557';
        // On narrow screens (phone), use a smaller point label font to
        // prevent clipping — the canvas width decides.
        var pointLabelFontSize =
            canvas && canvas.clientWidth && canvas.clientWidth < 320 ? 11 : 13;
        return {
            type: 'radar',
            data: {
                labels: opts.labels,
                datasets: [{
                    data: opts.values,
                    backgroundColor: loading ? opts.loadingFill : 'rgba(69, 123, 157, 0.1)',
                    borderColor: loading ? opts.loadingLine : 'rgba(69, 123, 157, 0.8)',
                    borderWidth: 2,
                    pointBackgroundColor: loading ? opts.loadingPoint : pointColors,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    pointRadius: 5,
                    // Read-only radars never grow points on hover
                    pointHoverRadius: readOnly ? 5 : 7,
                }]
            },
            options: {
                // No Chart.js event listeners at all for read-only previews —
                // hover/click do nothing even without our own handlers.
                events: readOnly ? [] : undefined,
                responsive: true,
                // false: the chart fills the wrapper's flex-constrained height
                // instead of expanding to maintain a square aspect ratio
                maintainAspectRatio: false,
                // Animate the radar polygon from center (0) to actual values
                // when the chart is first created — creates a smooth grow-out
                // effect as the data fills in. Callers pass animate: false to
                // honour reduced motion.
                animation: opts.animate === false
                    ? { duration: 0 }
                    : { duration: 1200, easing: 'easeOutQuart' },
                scales: {
                    r: {
                        beginAtZero: true, max: 10, min: 0,
                        // Hide tick number labels — only show grid lines
                        ticks: { display: false, stepSize: 2 },
                        pointLabels: {
                            font: { size: pointLabelFontSize, family: headingFont, weight: '600' },
                            color: labelColor,
                            // Center-align multi-line labels so each line
                            // is centered at its position around the radar
                            align: 'center',
                            // Break labels into two lines to save horizontal
                            // space and allow a larger radar polygon
                            callback: function (label) { return splitLabel(label); },
                        },
                        // Darker grid/angle lines for better web visibility — theme-aware
                        grid: { color: 'rgba(69, 123, 157, 0.25)' },
                        angleLines: { color: 'rgba(69, 123, 157, 0.25)' },
                    }
                },
                plugins: {
                    legend: { display: false },
                    // Native tooltip stays off everywhere; interactive
                    // callers wire their own external HTML tooltip
                    tooltip: { enabled: false, external: opts.externalTooltip },
                },
                onClick: opts.onClick,
            },
        };
    }

    /* Build a read-only (or interactive, per opts) radar on the canvas. */
    function create(canvas, opts) {
        opts = opts || {};
        opts.canvas = canvas;
        return new Chart(canvas, createConfig(opts));
    }

    return {
        DIMENSIONS: DIMENSIONS,
        splitLabel: splitLabel,
        dimensionColors: dimensionColors,
        createConfig: createConfig,
        create: create,
    };
})();
