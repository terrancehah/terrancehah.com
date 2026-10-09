/* =====================================================================
   PACEY LANDING — theme toggle, fixture sync + the sample radar
   ---------------------------------------------------------------------
   The page renders fully without JS. This file wires the theme toggle,
   rewrites the static metric tiles and week agenda from the shared demo
   fixture (so the previews cannot drift), and — when Chart.js is
   available — mounts the shared read-only radar (pacey-radar.js) over
   the printed scores fallback. It follows the app's exact theme rule: a
   saved pacey_theme choice wins, otherwise dark between 7pm and 7am
   local time.
   ===================================================================== */

(function () {
    'use strict';

    /* ---- Theme toggle ---- */
    var toggle = document.getElementById('landing-theme-toggle');
    if (toggle) {
        // Mirror the app's applyTheme — same attribute, same storage key,
        // same accessible label — so landing and app never disagree.
        var applyTheme = function (theme) {
            document.documentElement.setAttribute('data-theme', theme);
            try { localStorage.setItem('pacey_theme', theme); } catch (e) {}
            var label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
            toggle.setAttribute('aria-label', label);
            toggle.title = label;
        };

        toggle.addEventListener('click', function () {
            var current = document.documentElement.getAttribute('data-theme') || 'light';
            applyTheme(current === 'light' ? 'dark' : 'light');
        });

        // Correct the label for whatever theme the head script applied —
        // the static markup can't know whether dark mode is active.
        var active = document.documentElement.getAttribute('data-theme') || 'light';
        var label = active === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
    }

    /* ---- App-entry links keep app page hashes ----
       A signed-out bounce lands here carrying the page the session expired
       on (#plan and friends), and an old bookmark may do the same. The
       Open Pacey links take that hash through so a fresh sign-in returns
       to the same page. Landing's own anchors (#features and below) never
       qualify — the whitelist is app pages only. */
    var appHash = /#(overview|activities|readiness|plan)$/.test(window.location.hash)
        ? window.location.hash : '';
    if (appHash) {
        document.querySelectorAll('a[href^="/pacey/app/"]').forEach(function (a) {
            a.setAttribute('href', a.getAttribute('href') + appHash);
        });
    }

    /* ---- Metric tiles ----
       Same drift guard as the week: the static markup already carries the
       right numbers, and this pass rewrites them from the shared fixture
       so the preview can never disagree with the demo — value, unit, the
       zone-colour token and the icon the app maps the label to. */
    if (window.PACEY_SAMPLE && Array.isArray(PACEY_SAMPLE.metrics)) {
        PACEY_SAMPLE.metrics.forEach(function (m) {
            var tile = document.querySelector('.pacey-metric-tile[data-metric-label="' + m.label + '"]');
            if (!tile) return;
            var label = tile.querySelector('.pacey-metric-label');
            var value = tile.querySelector('.pacey-metric-value');
            var unit = tile.querySelector('.pacey-metric-unit');
            var icon = tile.querySelector('.pacey-metric-icon .pacey-icon');
            var use = icon && icon.querySelector('use');
            if (label) label.textContent = m.label;
            if (value) {
                value.textContent = m.value;
                value.style.color = 'var(--pacey-metric-zone-' + (m.colorToken || 'blue') + ')';
            }
            if (unit) unit.textContent = m.unit;
            if (use && m.icon) use.setAttribute('href', '#' + m.icon);
            if (icon) icon.classList.toggle('pacey-icon--stroke', !!m.stroke);
        });
    }

    /* ---- Sample week ----
       The agenda markup is static so the page reads without JS, but the
       values are the shared fixture's: pacey-sample.js stays the single
       source and this pass rewrites text (never the markup's structure)
       so the rows cannot drift from what the demo plan would show. Runs
       before the radar mount so a missing Chart.js can't skip it. */
    if (window.PACEY_SAMPLE && Array.isArray(PACEY_SAMPLE.week)) {
        PACEY_SAMPLE.week.forEach(function (day, i) {
            var row = document.querySelector('.pacey-cal-row[data-sample-day="' + i + '"]');
            if (!row) return;
            var card = row.querySelector('.pacey-cal-card');
            var title = row.querySelector('.pacey-cal-card-title');
            var meta = row.querySelector('.pacey-cal-card-meta');
            var tag = row.querySelector('.pacey-run-tag');
            var dow = row.querySelector('.pacey-cal-date-dow');
            var restLabel = row.querySelector('.pacey-cal-rest-label');
            if (dow && day.day) dow.textContent = day.day;
            if (!card) return;
            if (day.rest) {
                card.className = 'pacey-cal-card pacey-cal-card--rest';
                if (restLabel) restLabel.textContent = day.title || 'Rest';
            } else {
                card.className = 'pacey-cal-card pacey-cal-card--suggested';
                if (title) title.textContent = day.title;
                if (meta) meta.textContent = day.distance_km + ' km · ' + day.pace + '/km';
                if (tag) {
                    tag.textContent = day.type;
                    tag.className = 'pacey-run-tag ' + day.tagClass;
                }
            }
        });
    }

    /* ---- Course preview ----
       The Brooks snapshot is a static local asset — the same numbers the
       app's course analysis produced for the supplied GPX. One fetch
       draws the chalk route trace and the elevation profile; if it never
       resolves, the card keeps its name, stats and read — no skeleton. */
    (function () {
        var routeLine = document.getElementById('landing-course-route-line');
        var routeSvg = document.getElementById('landing-course-route-svg');
        var mapEl = document.getElementById('landing-course-map');
        var chartWrap = document.getElementById('landing-course-chart-wrap');
        var pending = document.getElementById('landing-course-pending');
        if (!routeLine || !chartWrap || !window.fetch) return;

        var SVG_NS = 'http://www.w3.org/2000/svg';

        /* A plain circle path run through the board's sketch filter — the
           same wobble the app's sketched dots get from their path math. */
        function circlePath(cx, cy, r) {
            return 'M' + (cx - r) + ' ' + cy +
                ' a' + r + ' ' + r + ' 0 1 0 ' + (r * 2) + ' 0' +
                ' a' + r + ' ' + r + ' 0 1 0 -' + (r * 2) + ' 0 Z';
        }

        function drawRoute(rec) {
            var route = rec.route;
            if (!route || !route.d) return;
            if (routeSvg && route.viewBox) routeSvg.setAttribute('viewBox', route.viewBox);
            routeLine.setAttribute('d', route.d);
            var startPin = document.getElementById('landing-course-route-start');
            var endPin = document.getElementById('landing-course-route-end');
            if (!startPin || !route.start) return;
            /* Brooks finishes where it starts — one split start/finish
               dot, the same treatment the app gives a loop. */
            startPin.setAttribute('d', circlePath(route.start.x, route.start.y, 12));
            startPin.style.fill = 'url(#pacey-course-split)';
            if (endPin) endPin.hidden = true;
        }

        function drawElevation(rec) {
            var pts = rec.profile;
            if (!pts || !pts.length) return;
            var w = Math.max(chartWrap.clientWidth, 260);
            var h = Math.max(chartWrap.clientHeight, 120);
            var pad = { top: 10, right: 8, bottom: 18, left: 8 };
            var minEle = Math.min.apply(null, pts.map(function (p) { return p.ele; }));
            var maxEle = Math.max.apply(null, pts.map(function (p) { return p.ele; }));
            var spanEle = Math.max(maxEle - minEle, 1);
            var maxKm = rec.distanceKm;
            var x = function (km) { return pad.left + (km / maxKm) * (w - pad.left - pad.right); };
            var y = function (ele) { return pad.top + (1 - (ele - minEle) / spanEle) * (h - pad.top - pad.bottom); };

            var svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.setAttribute('role', 'img');
            svg.setAttribute('aria-label', 'Elevation profile across the course — 0 to ' + maxKm.toFixed(1) + ' km');
            svg.setAttribute('class', 'landing-course-chart');

            /* Faint chalk gridlines at low, mid and high elevation. */
            [minEle, (minEle + maxEle) / 2, maxEle].forEach(function (ele) {
                var g = document.createElementNS(SVG_NS, 'line');
                g.setAttribute('x1', pad.left);
                g.setAttribute('x2', w - pad.right);
                g.setAttribute('y1', y(ele));
                g.setAttribute('y2', y(ele));
                g.setAttribute('class', 'landing-course-chart-grid');
                svg.appendChild(g);
            });

            /* Filled area under the line, then the chalk line itself. */
            var line = 'M' + pts.map(function (p) {
                return x(p.km).toFixed(1) + ' ' + y(p.ele).toFixed(1);
            }).join(' L');
            var area = document.createElementNS(SVG_NS, 'path');
            area.setAttribute('d', line + ' L' + x(maxKm).toFixed(1) + ' ' + (h - pad.bottom) + ' L' + x(0).toFixed(1) + ' ' + (h - pad.bottom) + ' Z');
            area.setAttribute('class', 'landing-course-chart-area');
            svg.appendChild(area);
            var trace = document.createElementNS(SVG_NS, 'path');
            trace.setAttribute('d', line);
            trace.setAttribute('class', 'landing-course-chart-line');
            svg.appendChild(trace);

            /* Distance markers along the bottom edge. */
            [[0, '0'], [maxKm / 2, (maxKm / 2).toFixed(1)], [maxKm, maxKm.toFixed(1)]].forEach(function (mark) {
                var t = document.createElementNS(SVG_NS, 'text');
                t.setAttribute('x', Math.min(Math.max(x(mark[0]), pad.left + 4), w - pad.right - 26));
                t.setAttribute('y', h - 5);
                t.setAttribute('class', 'landing-course-chart-tick');
                t.textContent = mark[1] + ' km';
                svg.appendChild(t);
            });

            chartWrap.appendChild(svg);
        }

        /* ---- Basemap ----
           Mirrors the app's inline card map (pacey.js buildCourseMap +
           applyCourseRouteLayers) at landing scale: the same OpenFreeMap
           Positron style, bounds fit and compact attribution, and the same
           route line and start/finish pen marks. Non-interactive — it is a
           picture of the course, and an interactive map inside a scrolling
           page would trap the page's own gestures. The modal-only guides
           (direction arrows, kilometre dots) are deliberately left off.

           The drawn SVG stays visible until the map has loaded AND the
           route layer is on it, so the panel is never an empty box while
           tiles stream in — and stays forever if MapLibre, WebGL or the
           tiles are unavailable. */

        /* The three harmonics the app's sketched circles use — copied so
           the landing's pen marks are drawn by the same hand. */
        var SKETCH_LEAN = 0.08;    /* off-centre lean, 1 cycle */
        var SKETCH_OVAL = 0.055;   /* slightly oval, 2 cycles */
        var SKETCH_WRIST = 0.03;   /* wrist lean, 3 cycles */

        /* A hand-drawn-looking circle as an SVG path — same construction
           as the app's sketchyCirclePath: fixed harmonics for the wobble,
           quadratic segments through edge midpoints so it curves. */
        function sketchyCirclePath(cx, cy, r) {
            var n = 16;
            var pts = [];
            for (var i = 0; i < n; i++) {
                var a = (i / n) * Math.PI * 2 - Math.PI / 2;
                var k = 1
                    + SKETCH_LEAN * Math.cos(a - 0.6)
                    + SKETCH_OVAL * Math.cos(2 * a + 1.1)
                    + SKETCH_WRIST * Math.cos(3 * a + 2.4);
                pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k]);
            }
            var d = 'M' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
            for (var j = 1; j <= n; j++) {
                var cur = pts[j % n];
                var next = pts[(j + 1) % n];
                var mx = (cur[0] + next[0]) / 2;
                var my = (cur[1] + next[1]) / 2;
                d += ' Q' + cur[0].toFixed(2) + ' ' + cur[1].toFixed(2) +
                    ' ' + mx.toFixed(2) + ' ' + my.toFixed(2);
            }
            return d + ' Z';
        }

        /* The coach's rougher pen ring — same harmonics pushed harder, and
           the sweep laps past its own start like a hand-drawn circle. */
        function sketchyRingPath(cx, cy, r) {
            var n = 18;
            var turns = 1.14;
            var pts = [];
            for (var i = 0; i <= n; i++) {
                var a = (i / n) * Math.PI * 2 * turns - Math.PI / 2;
                var k = 1
                    + (SKETCH_LEAN * 1.5) * Math.cos(a - 0.5)
                    + (SKETCH_OVAL * 1.4) * Math.cos(2 * a + 1.3)
                    + (SKETCH_WRIST * 1.4) * Math.cos(3 * a + 2.2);
                var squash = 0.93 + 0.04 * Math.cos(a + 0.8);
                pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k * squash]);
            }
            var d = 'M' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
            for (var j = 1; j < pts.length - 1; j++) {
                var cur = pts[j];
                var next = pts[j + 1];
                var mx = (cur[0] + next[0]) / 2;
                var my = (cur[1] + next[1]) / 2;
                d += ' Q' + cur[0].toFixed(2) + ' ' + cur[1].toFixed(2) +
                    ' ' + mx.toFixed(2) + ' ' + my.toFixed(2);
            }
            var last = pts[pts.length - 1];
            return d + ' L' + last[0].toFixed(2) + ' ' + last[1].toFixed(2);
        }

        /* Metres between two [lon,lat] points — enough to answer the same
           "does this route close on itself" question the app's 400 m
           heuristic asks, without loading the course module. */
        function metresBetween(a, b) {
            var rad = Math.PI / 180;
            var dLat = (b[1] - a[1]) * rad;
            var dLon = (b[0] - a[0]) * rad;
            var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(a[1] * rad) * Math.cos(b[1] * rad)
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
            return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
        }

        /* The app's ROUTE_CLOSES_M threshold: under 400 m of GPS drift the
           start and finish count as the same place. */
        function routeCloses(coords) {
            return metresBetween(coords[0], coords[coords.length - 1]) < 400;
        }

        function markerSvg(wrapClass, px, viewBox) {
            var wrap = document.createElement('div');
            wrap.className = wrapClass;
            var svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', viewBox);
            svg.setAttribute('width', String(px));
            svg.setAttribute('height', String(px));
            svg.setAttribute('aria-hidden', 'true');
            var path = document.createElementNS(SVG_NS, 'path');
            svg.appendChild(path);
            wrap.appendChild(svg);
            return { wrap: wrap, path: path, svg: svg };
        }

        /* A loop's single start/finish dot, split green/red down the middle
           — the same gradient trick the app uses so the sketched outline
           stays one stroke. */
        function makeSplitMarkerElement(size) {
            var m = markerSvg('pacey-course-marker pacey-course-marker--split', size, '0 0 24 24');
            var defs = document.createElementNS(SVG_NS, 'defs');
            var grad = document.createElementNS(SVG_NS, 'linearGradient');
            grad.setAttribute('id', 'pacey-course-split-landing');
            grad.setAttribute('x1', '0');
            grad.setAttribute('y1', '0');
            grad.setAttribute('x2', '1');
            grad.setAttribute('y2', '0');
            [['0', '#2f8f4e'], ['0.5', '#2f8f4e'], ['0.5', '#b83b2e'], ['1', '#b83b2e']]
                .forEach(function (stop) {
                    var s = document.createElementNS(SVG_NS, 'stop');
                    s.setAttribute('offset', stop[0]);
                    s.setAttribute('stop-color', stop[1]);
                    grad.appendChild(s);
                });
            defs.appendChild(grad);
            m.svg.insertBefore(defs, m.path);
            m.path.setAttribute('d', sketchyCirclePath(12, 12, 7.6));
            m.path.setAttribute('fill', 'url(#pacey-course-split-landing)');
            return m.wrap;
        }

        function makeEndpointMarkerElement(kind, size) {
            var m = markerSvg('pacey-course-marker pacey-course-marker--' + kind, size, '0 0 24 24');
            m.path.setAttribute('d', sketchyCirclePath(12, 12, 7.6));
            return m.wrap;
        }

        function makeRingElement(size) {
            var m = markerSvg('pacey-course-ring', size, '0 0 56 56');
            /* The wobble needs room — the ring sits well inside the viewBox
               so its stroke never clips at the edge. */
            m.path.setAttribute('d', sketchyRingPath(28, 28, 19));
            return m.wrap;
        }

        /* Fold MapLibre's compact attribution back to the ⓘ button — the
           style JSON opens it expanded on a wide container, and the full
           credit line would sit on the preview permanently. */
        function collapseAttribution(map) {
            var attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
            if (!attrib) return;
            attrib.removeAttribute('open');
            attrib.classList.remove('maplibregl-compact-show');
        }

        /* The coloured-pencil surface shading the app lays over Positron —
           same palette, same per-layer paint matching, same no-op on any
           layer a style revision renames. */
        function shadeMapLikePencil(map) {
            var SURFACES = {
                paper: ['#f3eee3', '#e7dfcd'],
                water: ['#cfe3f1', '#a9c8dd'],
                park: ['#e6e8d4', '#c6cba9'],
                landcover: ['#e9e1cf', '#cec2a2'],
                landuse: ['#eee6d5', '#d6cbb0'],
                building: ['#e5dcc6', '#cbbfa3'],
            };
            Object.keys(SURFACES).forEach(function (key) {
                var base = SURFACES[key][0];
                var stroke = SURFACES[key][1];
                var size = 32;
                var step = 8;
                var tile = document.createElement('canvas');
                tile.width = size;
                tile.height = size;
                var ctx = tile.getContext('2d');
                ctx.fillStyle = base;
                ctx.fillRect(0, 0, size, size);
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1.2;
                ctx.lineCap = 'round';
                for (var i = -size; i < size * 2; i += step) {
                    ctx.beginPath();
                    ctx.globalAlpha = 0.45 + ((i / step) % 3) * 0.15;
                    ctx.moveTo(i, 0);
                    ctx.lineTo(i + size, size);
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
                map.addImage('pacey-hachure-' + key, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
            });
            map.getStyle().layers.forEach(function (layer) {
                try {
                    var src = layer['source-layer'];
                    var paint = layer.paint || {};
                    if (layer.type === 'background' && 'background-color' in paint) {
                        map.setPaintProperty(layer.id, 'background-color', SURFACES.paper[0]);
                        map.setPaintProperty(layer.id, 'background-pattern', 'pacey-hachure-paper');
                    } else if ('fill-color' in paint && SURFACES[src]) {
                        map.setPaintProperty(layer.id, 'fill-color', SURFACES[src][0]);
                        map.setPaintProperty(layer.id, 'fill-pattern', 'pacey-hachure-' + src);
                    } else if ('line-color' in paint && src === 'transportation') {
                        map.setPaintProperty(layer.id, 'line-color', '#d8c9a8');
                    }
                } catch (e) {
                    /* Style revision without this property — leave it. */
                }
            });
        }

        function mountCourseMap(rec) {
            if (!mapEl || !window.maplibregl) return;
            var coords = rec.coords;
            /* Same range check as the app — MapLibre throws on an
               out-of-range latitude, and a malformed record should fall
               back to the drawn trace rather than break the card. */
            var valid = Array.isArray(coords) && coords.length > 1 && coords.every(function (c) {
                return Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])
                    && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;
            });
            if (!valid) return;

            var bounds = coords.reduce(function (b, c) { return b.extend(c); },
                new maplibregl.LngLatBounds(coords[0], coords[0]));

            /* MapLibre never loads while its container is display:none — the
               map is unhidden now so it gets a real box (it's absolute inside
               the wrap, so the layout doesn't change), while the drawn trace
               stays painted on top until the map's load event trades places.
               The wrap's [hidden] rule already removes it without JS, so the
               no-JS page keeps just the SVG. */
            mapEl.hidden = false;

            var map;
            try {
                map = new maplibregl.Map({
                    container: mapEl,
                    style: 'https://tiles.openfreemap.org/styles/positron',
                    bounds: bounds,
                    fitBoundsOptions: { padding: 26 },
                    /* OpenFreeMap's style JSON ships no attribution of its
                       own — OSM data is ODbL, so the credit is set here.
                       Compact keeps it as the ⓘ button on this small box. */
                    attributionControl: {
                        compact: true,
                        customAttribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors',
                    },
                    interactive: false,
                });
            } catch (err) {
                /* WebGL refused — put the empty box back away; the drawn
                   trace stays. */
                mapEl.hidden = true;
                return;
            }

            /* The container had a real box at construction, so the bounds
               fit lands right — refit is only the safety net for a box that
               somehow measured 0. One re-fit only, and never on an empty
               box (fitting a 0-size map would latch a nonsense camera). */
            var fitted = !!mapEl.clientWidth;
            function refit() {
                if (!mapEl.clientWidth || !mapEl.clientHeight) return;
                map.resize();
                if (!fitted) {
                    map.fitBounds(bounds, { padding: 26 });
                    fitted = true;
                }
            }
            if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(function () {
                    requestAnimationFrame(refit);
                }).observe(mapEl);
            }

            /* A style or tile-network failure before the map is revealed
               leaves the drawn trace in place — re-hide the empty box.
               Once the map is showing (SVG hidden) a stray tile error no
               longer sends it back. */
            map.on('error', function () {
                if (routeSvg.hasAttribute('hidden')) return;
                mapEl.hidden = true;
                try { map.remove(); } catch (e) {}
            });

            map.on('resize', function () { collapseAttribution(map); });
            map.on('load', function () {
                var mapStyle = getComputedStyle(mapEl);
                var routeColor = (mapStyle.getPropertyValue('--pacey-course-map-route') || '').trim() || '#2f6fb0';
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
                    paint: { 'line-color': routeColor, 'line-width': 3 },
                });

                shadeMapLikePencil(map);

                /* Start/finish pen marks — the app's inline treatment: one
                   split dot when the course closes on itself, a sketched
                   ring circling the point. */
                var closes = routeCloses(coords);
                if (closes) {
                    new maplibregl.Marker({ element: makeSplitMarkerElement(18) })
                        .setLngLat(coords[0])
                        .addTo(map);
                } else {
                    new maplibregl.Marker({ element: makeEndpointMarkerElement('start', 18) })
                        .setLngLat(coords[0])
                        .addTo(map);
                    new maplibregl.Marker({ element: makeEndpointMarkerElement('end', 18) })
                        .setLngLat(coords[coords.length - 1])
                        .addTo(map);
                }
                new maplibregl.Marker({ element: makeRingElement(44) })
                    .setLngLat(coords[0])
                    .addTo(map);
                if (!closes) {
                    new maplibregl.Marker({ element: makeRingElement(44) })
                        .setLngLat(coords[coords.length - 1])
                        .addTo(map);
                }

                collapseAttribution(map);
                /* Route is on the map — trade places with the drawn trace
                   and re-measure in case the box shifted while loading.
                   SVG elements have no .hidden IDL property, so the
                   attribute (and the card's [hidden] rule) does the work. */
                routeSvg.setAttribute('hidden', '');
                refit();
            });
        }

        fetch('/pacey/assets/brooks-half-marathon-preview.json')
            .then(function (res) { return res.ok ? res.json() : Promise.reject(res.status); })
            .then(function (rec) {
                drawRoute(rec);
                drawElevation(rec);
                mountCourseMap(rec);
                if (pending) pending.hidden = true;
            })
            .catch(function () {
                /* Quiet static fallback — the card's facts stand without
                   the drawings, and nothing keeps spinning. */
                if (pending) pending.textContent = 'The route and profile could not be drawn here.';
            });
    })();

    /* ---- Sample radar ----
       The same chart the readiness page draws, built from the Brooks
       supplied scores — read-only here: no tooltip, no click handler.
       Without Chart.js the printed scores inside the wrap are the whole
       truth, so nothing hides. */
    var brooks = window.PACEY_BROOKS_SAMPLE;
    var canvas = document.getElementById('landing-radar');
    var fallback = document.getElementById('landing-radar-fallback');
    if (!canvas || !fallback) return;
    if (!window.Chart || !window.PaceyRadar || !brooks) return;

    var reduceMotion = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var values = brooks.dimensions.map(function (d) { return d.score; });

    PaceyRadar.create(canvas, {
        labels: PaceyRadar.DIMENSIONS,
        values: values,
        animate: !reduceMotion,
        // Fully inert — no event listeners, no hover growth on points
        readOnly: true,
    });

    // Same fade-in the app triggers: two frames so the initial opacity-0
    // paint happens before the loaded class fires the transition.
    fallback.hidden = true;
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            canvas.classList.add('pacey-radar-loaded');
        });
    });
})();
