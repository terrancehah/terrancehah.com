/**
 * pacey-course.js — GPX parsing and course analysis for Pacey.
 *
 * Pure logic, no DOM and no dependencies. Parses a .gpx file into track points,
 * then derives the numbers both the UI and the coach need: distance, filtered
 * elevation gain, grade statistics, detected climbs, and a downsampled profile
 * for the elevation chart.
 *
 * Exposed as a global (window.PaceyCourse) so it loads as a plain script, and
 * also exports via module.exports so it can be unit-tested from node.
 *
 * Why the parser is hand-rolled rather than a library:
 *   - GPX is a small, well-bounded XML dialect (trkpt/rtept/wpt with ele+time),
 *     so a targeted tolerant parse is ~40 lines and keeps the no-new-dependency
 *     rule intact.
 *   - It is also *more* robust in practice: a lot of real-world GPX is
 *     technically invalid XML (namespace and entity problems), which strict
 *     DOMParser-based parsers reject or only partially read.
 *
 * Why elevation gain is filtered (the important part):
 *   Summing every positive elevation delta overstates gain by 2-5x, because
 *   altimeter/GPS noise never cancels — you bank the +2 m and ignore the -2 m,
 *   forever. Every serious tool applies a threshold ("hysteresis"): a climb only
 *   counts once it exceeds a noise band, and a descent resets the baseline.
 *   We default to 2 m, which suits GPS-only tracks; barometric tracks could use
 *   less. See elevationStats() below.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.PaceyCourse = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // --- Tunables ---------------------------------------------------------
    // Elevation noise band in metres. A rise only banks once it exceeds this,
    // and a fall resets the reference the same way. 2 m matches what the
    // mainstream tools converged on for non-barometric tracks.
    const ELEVATION_THRESHOLD_M = 2;
    // Centred moving-average window (points) applied before measuring. Small
    // enough to keep genuine short pitches, large enough to kill jitter.
    const SMOOTHING_WINDOW = 5;
    // A sustained rise counts as a "climb" at or above all three of these.
    // The grade floor matters: without it a long gentle rise (8 km at 0.3%)
    // qualifies, which is not a climb in any useful sense.
    const CLIMB_MIN_GAIN_M = 25;
    const CLIMB_MIN_LENGTH_KM = 0.4;
    const CLIMB_MIN_GRADE_PCT = 2;
    // Elevation samples kept for the chart profile.
    const PROFILE_BUCKETS = 180;
    // Grade is measured over this distance so single-point spikes don't set it.
    const GRADE_WINDOW_M = 200;
    // Window for the grade-adjusted (flat-equivalent) calculation. Local grade
    // has to be read over ~100 m: point-to-point grade across 10 m of spacing
    // is dominated by altimeter noise rather than terrain.
    const GAP_WINDOW_M = 100;
    // Minetti's energy-cost curve is only meaningful inside roughly ±40%; past
    // that the polynomial diverges.
    const GRADE_CLAMP = 0.4;
    // The rolling index only counts a direction change once it clears this
    // band, so jitter can't inflate the count.
    const ROLLING_THRESHOLD_M = 4;
    // Gain per km at which a ROAD course counts as hilly. The widely quoted
    // bands (hilly at 9.5 m/km and up) were built for trail and ultra running
    // and compress every World Marathon Major into their bottom two — Boston
    // and New York are only ~6 m/km yet are the hilliest majors there are. On
    // the road scale this is the familiar rule of thumb: gain (m) / distance
    // (km) >= 10. Reference points: Berlin 1.7, London 3.0, Boston 5.9.
    const HILLY_GAIN_PER_KM = 10;

    const EARTH_RADIUS_M = 6371008.8;

    // --- Parsing ----------------------------------------------------------

    /** Distance between two lat/lon pairs in metres (haversine). */
    function haversineM(lat1, lon1, lat2, lon2) {
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /** Read a numeric XML attribute, tolerating single or double quotes. */
    function attr(attrs, name) {
        const m = new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(attrs);
        return m ? m[1] : null;
    }

    /** Read the text of the first <name> child inside a point body. */
    function child(body, name) {
        const m = new RegExp('<(?:[\\w.-]+:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?' + name + '\\s*>', 'i').exec(body);
        return m ? m[1].trim() : null;
    }

    /**
     * Pull every point of one GPX tag type. Handles both paired
     * (<trkpt>…</trkpt>) and self-closing (<trkpt … />) forms, and any
     * namespace prefix on the tag.
     */
    function collectTag(text, tag) {
        const re = new RegExp(
            '<(?:[\\w.-]+:)?' + tag + '\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?' + tag + '\\s*>)',
            'gi'
        );
        const out = [];
        let m;
        while ((m = re.exec(text)) !== null) {
            const attrs = m[1] || '';
            const body = m[2] || '';
            const lat = parseFloat(attr(attrs, 'lat'));
            const lon = parseFloat(attr(attrs, 'lon'));
            if (!isFinite(lat) || !isFinite(lon)) continue;
            const eleRaw = child(body, 'ele');
            const ele = eleRaw === null ? null : parseFloat(eleRaw);
            const time = child(body, 'time');
            out.push({
                lat, lon,
                ele: isFinite(ele) ? ele : null,
                time: time || null,
            });
        }
        return out;
    }

    /**
     * Parse a GPX string into track points.
     *
     * Preference order is track points (the recorded/course line), then route
     * points, then bare waypoints — a course export usually carries a track,
     * but a hand-planned route may only carry rtept.
     *
     * @returns {{points: Array, name: string, hasElevation: boolean, source: string}}
     */
    function parseGpx(text) {
        if (typeof text !== 'string' || !text.trim()) {
            throw new Error('Empty GPX file.');
        }
        // Reject non-GPX XML early with a clear message rather than returning
        // zero points and looking like an empty course.
        if (!/<gpx[\s>]/i.test(text)) {
            throw new Error('That file does not look like a GPX track.');
        }

        let points = collectTag(text, 'trkpt');
        let source = 'track';
        if (!points.length) {
            points = collectTag(text, 'rtept');
            source = 'route';
        }
        if (!points.length) {
            points = collectTag(text, 'wpt');
            source = 'waypoints';
        }
        if (!points.length) {
            throw new Error('No track points found in that GPX file.');
        }

        const nameMatch = /<(?:[\w.-]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?name\s*>/i.exec(text);
        const hasElevation = points.some(p => p.ele !== null);

        return {
            points,
            name: nameMatch ? nameMatch[1].trim() : '',
            hasElevation,
            source,
        };
    }

    // --- Elevation --------------------------------------------------------

    /**
     * Centred moving average over the elevation series. Nulls (points with no
     * <ele>) are carried through as null and skipped when averaging, so a
     * partially-elevated file still smooths correctly.
     */
    function smoothElevations(points, window) {
        const half = Math.max(0, Math.floor((window || SMOOTHING_WINDOW) / 2));
        return points.map((p, i) => {
            if (p.ele === null) return null;
            let sum = 0, n = 0;
            for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
                const e = points[j].ele;
                if (e !== null) { sum += e; n++; }
            }
            return n ? sum / n : null;
        });
    }

    /**
     * Cumulative gain/loss with a hysteresis threshold.
     *
     * Walks the series keeping a reference height. A rise is only banked once
     * it clears +threshold (and the reference moves up); a fall only once it
     * clears -threshold. Movements inside the band are treated as noise and
     * ignored, which is what stops jitter from accumulating.
     */
    function elevationStats(eleSeries, threshold) {
        const t = threshold || ELEVATION_THRESHOLD_M;
        const vals = eleSeries.filter(e => e !== null);
        if (vals.length < 2) return { gain: 0, loss: 0 };

        let gain = 0, loss = 0, ref = vals[0];
        for (let i = 1; i < vals.length; i++) {
            const d = vals[i] - ref;
            if (d >= t) { gain += d; ref = vals[i]; }
            else if (d <= -t) { loss += -d; ref = vals[i]; }
        }
        return { gain, loss };
    }

    // --- Grades and climbs ------------------------------------------------

    /** Running distance (metres) at each point, aligned to the input array. */
    function cumulativeDistances(points) {
        const dist = new Array(points.length).fill(0);
        for (let i = 1; i < points.length; i++) {
            dist[i] = dist[i - 1] + haversineM(
                points[i - 1].lat, points[i - 1].lon,
                points[i].lat, points[i].lon
            );
        }
        return dist;
    }

    /**
     * Grade over a sliding distance window, so a single noisy point cannot
     * define the max. Returns the steepest sustained percentage.
     */
    function maxGrade(points, smoothed, dist, windowM) {
        const w = windowM || GRADE_WINDOW_M;
        let best = 0;
        let lo = 0;
        for (let hi = 1; hi < points.length; hi++) {
            while (dist[hi] - dist[lo] > w) lo++;
            if (hi === lo) continue;
            const run = dist[hi] - dist[lo];
            if (run < 50) continue; // need a meaningful baseline
            const rise = smoothed[hi] - smoothed[lo];
            if (smoothed[hi] === null || smoothed[lo] === null) continue;
            const grade = (rise / run) * 100;
            if (grade > best) best = grade;
        }
        return best;
    }

    /** Steepest sustained grade inside a point range (see maxGrade). */
    function maxGradeInRange(smoothed, dist, startIdx, endIdx, windowM) {
        const w = windowM || GRADE_WINDOW_M;
        let best = 0;
        let lo = startIdx;
        for (let hi = startIdx + 1; hi <= endIdx; hi++) {
            while (dist[hi] - dist[lo] > w) lo++;
            const run = dist[hi] - dist[lo];
            if (run < 50) continue;
            if (smoothed[hi] === null || smoothed[lo] === null) continue;
            const grade = ((smoothed[hi] - smoothed[lo]) / run) * 100;
            if (grade > best) best = grade;
        }
        return best;
    }

    /**
     * Filtered gain over a fractional slice of the course (0..1). Used to say
     * whether a course front-loads or back-loads its climbing — which is the
     * difference between a race you can settle into and one that breaks late.
     */
    function gainInRange(smoothed, dist, startFrac, endFrac, threshold) {
        const total = dist[dist.length - 1];
        if (!total) return 0;
        const lo = total * startFrac;
        const hi = total * endFrac;
        const vals = [];
        for (let i = 0; i < smoothed.length; i++) {
            if (smoothed[i] !== null && dist[i] >= lo && dist[i] <= hi) vals.push(smoothed[i]);
        }
        return elevationStats(vals, threshold).gain;
    }

    /**
     * Direction changes per kilometre.
     *
     * Repeated rollers cost more than a single climb of the same total gain,
     * because the runner never settles into a rhythm. This is the number that
     * separates "480 m in one hill" from "480 m spread over twenty bumps".
     */
    function rollingIndex(smoothed, distanceKm) {
        const vals = smoothed.filter(e => e !== null);
        if (vals.length < 3 || !distanceKm) return 0;
        let dir = 0;
        let changes = 0;
        let ref = vals[0];
        for (let i = 1; i < vals.length; i++) {
            const d = vals[i] - ref;
            if (d >= ROLLING_THRESHOLD_M) {
                if (dir === -1) changes++;
                dir = 1;
                ref = vals[i];
            } else if (d <= -ROLLING_THRESHOLD_M) {
                if (dir === 1) changes++;
                dir = -1;
                ref = vals[i];
            }
        }
        return changes / distanceKm;
    }

    /**
     * Energy cost of running at a given gradient, relative to flat.
     *
     * Uses the fifth-order polynomial from Minetti et al. (2002), "Energy cost
     * of walking and running at extreme uphill and downhill slopes" — the same
     * basis Strava's grade-adjusted pace is built on. Cr(0) is 3.6 J/kg/m, so
     * the result is a multiplier on distance: 1.30 means that ground costs
     * 30% more than flat.
     */
    function gradeCostFactor(gradient) {
        const g = Math.max(-GRADE_CLAMP, Math.min(GRADE_CLAMP, gradient));
        const cost = 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3
            + 46.3 * g ** 2 + 19.5 * g + 3.6;
        return Math.max(cost, 0.5) / 3.6;
    }

    /**
     * Flat-equivalent distance in metres: how far the course would be if it
     * were level. Computed over non-overlapping ~100 m windows rather than
     * point-to-point, so altimeter noise can't drive the estimate.
     */
    function flatEquivalentM(smoothed, dist, windowM) {
        const w = windowM || GAP_WINDOW_M;
        let equivalent = 0;
        let start = 0;
        for (let i = 1; i < dist.length; i++) {
            const run = dist[i] - dist[start];
            const last = i === dist.length - 1;
            if (run < w && !last) continue;
            if (run <= 0) { start = i; continue; }
            if (smoothed[i] !== null && smoothed[start] !== null) {
                const grade = (smoothed[i] - smoothed[start]) / run;
                equivalent += run * gradeCostFactor(grade);
            } else {
                equivalent += run;
            }
            start = i;
        }
        return equivalent;
    }

    /**
     * Whether a candidate rise is a climb worth naming. It must clear the
     * gain, the length AND the average grade — the grade floor is what stops
     * a long shallow drag from being reported as a climb.
     */
    function isClimb(gain, lengthKm) {
        return gain >= CLIMB_MIN_GAIN_M
            && lengthKm >= CLIMB_MIN_LENGTH_KM
            && (gain / (lengthKm * 1000)) * 100 >= CLIMB_MIN_GRADE_PCT;
    }

    /**
     * Find sustained climbs: a run of net rise that reaches CLIMB_MIN_GAIN_M
     * without a meaningful descent in between.
     *
     * Each climb carries its position on the course (`startKm`, `positionPct`)
     * because WHERE a climb falls changes what it means — the same hill at
     * 30 km of a marathon is the decisive point, at 5 km it is a nuisance.
     * `maxGradePct` is the steepest sustained pitch inside the climb, so a
     * single hairpin can be described rather than hidden in the average.
     *
     * Not surfaced in the UI: the numbers read as noise to runners. This feeds
     * the coach prompt only.
     */
    function detectClimbs(points, smoothed, dist) {
        const totalM = dist[dist.length - 1] || 1;
        const climbs = [];

        const record = (startIdx, endIdx, gainM) => {
            const lengthKm = (dist[endIdx] - dist[startIdx]) / 1000;
            if (!isClimb(gainM, lengthKm)) return;
            climbs.push({
                startKm: dist[startIdx] / 1000,
                endKm: dist[endIdx] / 1000,
                positionPct: (dist[startIdx] / totalM) * 100,
                lengthKm,
                gainM,
                avgGradePct: (gainM / (lengthKm * 1000)) * 100,
                maxGradePct: maxGradeInRange(smoothed, dist, startIdx, endIdx),
            });
        };

        // The candidate climb runs from the LOW point to the HIGH point, not
        // from the last pullback to here — otherwise a long flat lead-in
        // dilutes the grade and a real 4% climb reads as 0.9% and is dropped.
        // minIdx uses <= so it settles on the last point at the low, which is
        // where the rise actually starts.
        let minIdx = -1;
        let maxIdx = -1;
        let minEle = Infinity;
        let maxEle = -Infinity;

        for (let i = 0; i < points.length; i++) {
            const e = smoothed[i];
            if (e === null) continue;

            if (minIdx === -1) {
                minIdx = maxIdx = i; minEle = maxEle = e;
                continue;
            }
            if (e <= minEle) {
                // A new low restarts the candidate: any earlier peak is gone.
                minEle = maxEle = e;
                minIdx = maxIdx = i;
            } else if (e > maxEle) {
                maxEle = e;
                maxIdx = i;
            }
            // A pullback of more than the noise band closes the climb.
            if (maxEle - e > ELEVATION_THRESHOLD_M * 2) {
                record(minIdx, maxIdx, maxEle - minEle);
                minIdx = maxIdx = i;
                minEle = maxEle = e;
            }
        }
        // Close the final candidate.
        if (minIdx !== -1 && maxIdx > minIdx) record(minIdx, maxIdx, maxEle - minEle);

        // Rank by severity (gain scaled by steepness) so the coach sees the
        // climbs that will actually shape the race.
        return climbs
            .sort((a, b) => (b.gainM * b.avgGradePct) - (a.gainM * a.avgGradePct))
            .slice(0, 5);
    }

    /**
     * Distance (km) spent in each grade band — the course's "shape".
     *
     * Walks NON-OVERLAPPING ~200 m windows, so the bands sum to roughly the
     * course distance. An earlier version used a sliding window and added the
     * run length at every point, which inflated the total about twentyfold —
     * a 21 km course reported 410 km of "flat".
     */
    function gradeBuckets(smoothed, dist) {
        const bands = [
            { label: 'Steep down (< -6%)', test: g => g < -6, km: 0 },
            { label: 'Down (-6% to -2%)', test: g => g >= -6 && g < -2, km: 0 },
            { label: 'Flat (-2% to 2%)', test: g => g >= -2 && g <= 2, km: 0 },
            { label: 'Up (2% to 6%)', test: g => g > 2 && g <= 6, km: 0 },
            { label: 'Steep up (> 6%)', test: g => g > 6, km: 0 },
        ];
        let start = 0;
        for (let hi = 1; hi < smoothed.length; hi++) {
            const run = dist[hi] - dist[start];
            const last = hi === smoothed.length - 1;
            if (run < GRADE_WINDOW_M && !last) continue;
            if (run <= 0) { start = hi; continue; }
            if (smoothed[hi] !== null && smoothed[start] !== null) {
                const grade = ((smoothed[hi] - smoothed[start]) / run) * 100;
                const band = bands.find(b => b.test(grade));
                if (band) band.km += run / 1000;
            }
            start = hi;
        }
        return bands.map(b => ({ label: b.label, km: b.km }));
    }

    /**
     * The kilometre that climbs the most (and the one that descends the most),
     * with where each falls.
     *
     * This is the "notable stretch" detector, and it is deliberately separate
     * from detectClimbs. The climb thresholds exist to keep noise out, but they
     * also hide a genuinely decisive rise: 20 m in the final kilometre of a
     * flat half is over 40% of that course's total gain, and it sits under
     * every threshold. A sliding 1 km window always finds the hardest stretch,
     * whatever its absolute size, and reports where it is.
     */
    function steepestKilometre(smoothed, dist, wantDescent) {
        const WINDOW_M = 1000;
        let best = null;
        let lo = 0;
        for (let hi = 1; hi < dist.length; hi++) {
            while (dist[hi] - dist[lo] > WINDOW_M) lo++;
            const run = dist[hi] - dist[lo];
            if (run < WINDOW_M * 0.9) continue;
            if (smoothed[hi] === null || smoothed[lo] === null) continue;
            const change = smoothed[hi] - smoothed[lo];
            const score = wantDescent ? -change : change;
            if (!best || score > best.score) {
                best = {
                    score,
                    startKm: dist[lo] / 1000,
                    endKm: dist[hi] / 1000,
                    lengthKm: run / 1000,
                    gainM: wantDescent ? -change : change,
                    avgGradePct: ((wantDescent ? -change : change) / run) * 100,
                };
            }
        }
        if (!best) return null;
        delete best.score;
        // If the "steepest descent" actually gains height, the course has no
        // meaningful descent at all — report nothing rather than a negative
        // climb dressed up as a drop. Same the other way round.
        if (best.gainM <= 0) return null;
        return best;
    }

    /** Downsample the elevation series into distance buckets for the chart. */
    function buildProfile(points, smoothed, dist, buckets) {
        const n = buckets || PROFILE_BUCKETS;
        const total = dist[dist.length - 1];
        if (!total) return [];
        const step = total / n;
        const out = [];
        let idx = 0;
        for (let b = 0; b < n; b++) {
            const target = b * step;
            let sum = 0, count = 0;
            while (idx < points.length && dist[idx] <= target + step) {
                if (smoothed[idx] !== null) { sum += smoothed[idx]; count++; }
                idx++;
            }
            if (count) out.push({ km: target / 1000, ele: sum / count });
        }
        // Always close on the final point so the chart ends where the course does.
        if (out.length && smoothed[smoothed.length - 1] !== null) {
            out.push({ km: total / 1000, ele: smoothed[smoothed.length - 1] });
        }
        return out;
    }

    /**
     * Classify overall hilliness from gain per kilometre, on the road scale
     * (see HILLY_GAIN_PER_KM). Road runners feel hills far sooner than the
     * trail bands suggest, so "hilly" starts at 10 m/km rather than 15.
     */
    function difficulty(gainPerKm) {
        if (gainPerKm < 3) return 'flat';
        if (gainPerKm < HILLY_GAIN_PER_KM) return 'rolling';
        if (gainPerKm < HILLY_GAIN_PER_KM * 2) return 'hilly';
        return 'mountainous';
    }

    /**
     * Full course analysis. This is the single entry point the UI and the AI
     * both consume, so the displayed numbers and the coached numbers cannot
     * drift apart.
     */
    function computeCourse(points, opts) {
        const options = opts || {};
        const dist = cumulativeDistances(points);
        const smoothed = smoothElevations(points, options.smoothingWindow);
        const distanceKm = dist[dist.length - 1] / 1000;
        const hasElevation = smoothed.some(e => e !== null);

        const lats = points.map(p => p.lat);
        const lons = points.map(p => p.lon);
        const bounds = {
            minLat: Math.min(...lats), maxLat: Math.max(...lats),
            minLon: Math.min(...lons), maxLon: Math.max(...lons),
        };

        if (!hasElevation) {
            return {
                distanceKm, pointCount: points.length, hasElevation: false,
                bounds, smoothed, dist,
                gainM: null, lossM: null, minEleM: null, maxEleM: null,
                avgGradePct: null, maxGradePct: null, gainPerKm: null,
                climbs: [], gradeBuckets: [], profile: [], difficulty: null,
                startAltM: null, endAltM: null, netElevationM: null,
                gainFirstHalfM: null, gainLastThirdM: null, shape: null,
                gainLastThirdPct: null,
                highPointKm: null, highPointPct: null, rollingIndex: null,
                flatEquivalentKm: null, hillPenaltyPct: null,
                steepestClimbKm: null, steepestDescentKm: null,
            };
        }

        const vals = smoothed.filter(e => e !== null);
        const { gain, loss } = elevationStats(smoothed, options.threshold);
        const minEleM = Math.min(...vals);
        const maxEleM = Math.max(...vals);
        const gainPerKm = distanceKm > 0 ? gain / distanceKm : 0;

        // Where the high point falls, as a distance and as a fraction of the
        // race — the single most useful fact about a course's shape. Strict
        // >, so a summit plateau reports where the summit is REACHED rather
        // than where it ends.
        let highIdx = smoothed.findIndex(e => e !== null);
        if (highIdx < 0) highIdx = 0;
        for (let i = highIdx + 1; i < smoothed.length; i++) {
            if (smoothed[i] !== null && smoothed[i] > smoothed[highIdx]) highIdx = i;
        }
        const highPointKm = dist[highIdx] / 1000;

        const firstVal = smoothed.find(e => e !== null);
        const lastVal = [...smoothed].reverse().find(e => e !== null);
        const netElevationM = (firstVal !== null && lastVal !== null) ? lastVal - firstVal : 0;

        const gainFirstHalfM = gainInRange(smoothed, dist, 0, 0.5, options.threshold);
        const gainLastThirdM = gainInRange(smoothed, dist, 2 / 3, 1, options.threshold);

        // Front-loaded means most of the climbing comes before halfway, so the
        // runner can settle; back-loaded means the race is decided late. This
        // describes WHERE the climbing falls only — the net rise or fall is
        // reported separately as netElevationM, so one field means one thing.
        let shape = 'even';
        if (gain > 0) {
            if (gainLastThirdM / gain > 0.45) shape = 'back-loaded';
            else if (gainFirstHalfM / gain > 0.65) shape = 'front-loaded';
        }

        const flatEquivalentKm = flatEquivalentM(smoothed, dist, options.gapWindow) / 1000;
        const hillPenaltyPct = distanceKm > 0 ? ((flatEquivalentKm / distanceKm) - 1) * 100 : 0;

        // The hardest single kilometre in each direction. These bypass the
        // climb thresholds on purpose — see steepestKilometre.
        const steepestClimbKm = steepestKilometre(smoothed, dist, false);
        const steepestDescentKm = steepestKilometre(smoothed, dist, true);

        return {
            distanceKm,
            pointCount: points.length,
            hasElevation: true,
            bounds, smoothed, dist,
            gainM: gain,
            lossM: loss,
            minEleM,
            maxEleM,
            avgGradePct: distanceKm > 0 ? (gain / (distanceKm * 1000)) * 100 : 0,
            maxGradePct: maxGrade(points, smoothed, dist, options.gradeWindow),
            gainPerKm,
            climbs: detectClimbs(points, smoothed, dist),
            gradeBuckets: gradeBuckets(smoothed, dist),
            profile: buildProfile(points, smoothed, dist, options.profileBuckets),
            difficulty: difficulty(gainPerKm),
            // --- shape ---
            startAltM: firstVal,
            endAltM: lastVal,
            netElevationM,
            gainFirstHalfM,
            gainLastThirdM,
            // Share of the climbing that falls in the last third. On a flat
            // course this can be 100% off a tiny absolute number, which is
            // exactly the case worth naming.
            gainLastThirdPct: gain > 0 ? (gainLastThirdM / gain) * 100 : 0,
            shape,
            highPointKm,
            highPointPct: distanceKm > 0 ? (highPointKm / distanceKm) * 100 : 0,
            // --- rhythm + cost ---
            rollingIndex: rollingIndex(smoothed, distanceKm),
            flatEquivalentKm,
            hillPenaltyPct,
            steepestClimbKm,
            steepestDescentKm,
        };
    }

    // --- Route geometry for the on-brand trace ---------------------------

    /**
     * Project the track into SVG coordinates for the hand-drawn route trace.
     * Longitude is scaled by cos(latitude) so the shape isn't stretched.
     * Returns a path string plus the start/end anchors for the pin markers.
     */
    function buildRoutePath(points, width, height, pad) {
        const p = pad === undefined ? 12 : pad;
        const lat0 = points.reduce((s, q) => s + q.lat, 0) / points.length;
        const k = Math.cos(lat0 * Math.PI / 180);

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const raw = points.map(q => {
            const x = q.lon * k;
            const y = -q.lat; // SVG y grows downward, latitude grows upward
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            return { x, y };
        });

        const spanX = maxX - minX || 1e-9;
        const spanY = maxY - minY || 1e-9;
        const scale = Math.min((width - p * 2) / spanX, (height - p * 2) / spanY);
        const offX = p + ((width - p * 2) - spanX * scale) / 2;
        const offY = p + ((height - p * 2) - spanY * scale) / 2;

        const pts = raw.map(q => ({
            x: offX + (q.x - minX) * scale,
            y: offY + (q.y - minY) * scale,
        }));

        const d = pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ');
        return { d, start: pts[0], end: pts[pts.length - 1], points: pts };
    }

    // --- AI handoff -------------------------------------------------------

    /**
     * Compact course summary for the coach prompt.
     *
     * Deliberately not the raw GPX: a marathon course is tens of thousands of
     * points of mostly noise, which is both a token-cost and a signal-to-noise
     * problem. This is the distilled version a model can actually reason over.
     */
    function buildAiSummary(course) {
        if (!course) return null;
        const summary = {
            distance_km: round(course.distanceKm, 2),
            has_elevation: !!course.hasElevation,
        };
        if (!course.hasElevation) {
            summary.note = 'Course file carried no elevation data; grade and climb advice is unavailable.';
            return summary;
        }
        summary.elevation_gain_m = Math.round(course.gainM);
        summary.elevation_loss_m = Math.round(course.lossM);
        summary.min_elevation_m = Math.round(course.minEleM);
        summary.max_elevation_m = Math.round(course.maxEleM);
        summary.avg_grade_pct = round(course.avgGradePct, 1);
        summary.max_grade_pct = round(course.maxGradePct, 1);
        summary.gain_per_km = round(course.gainPerKm, 1);
        summary.terrain = course.difficulty;

        // --- Shape: where the climbing falls and where the summit sits ---
        summary.shape = {
            character: course.shape,
            gain_first_half_m: Math.round(course.gainFirstHalfM),
            gain_last_third_m: Math.round(course.gainLastThirdM),
            gain_last_third_pct: round(course.gainLastThirdPct, 0),
            high_point_km: round(course.highPointKm, 1),
            high_point_pct: round(course.highPointPct, 0),
            net_elevation_m: Math.round(course.netElevationM),
        };
        summary.altitude_m = {
            start: Math.round(course.startAltM),
            min: Math.round(course.minEleM),
            max: Math.round(course.maxEleM),
        };

        // --- Rhythm + cost ---
        summary.rolling_index_per_km = round(course.rollingIndex, 1);
        summary.flat_equivalent_km = round(course.flatEquivalentKm, 2);
        summary.hill_penalty_pct = round(course.hillPenaltyPct, 1);

        // The hardest single kilometre each way, with where it falls. This is
        // what lets the coach name a specific stretch with numbers even when
        // the course as a whole is too flat to register any "climbs".
        const kmWindow = (w) => (w ? {
            start_km: round(w.startKm, 1),
            end_km: round(w.endKm, 1),
            length_km: round(w.lengthKm, 1),
            gain_m: Math.round(w.gainM),
            avg_grade_pct: round(w.avgGradePct, 1),
        } : null);
        summary.steepest_km = kmWindow(course.steepestClimbKm);
        summary.steepest_descent_km = kmWindow(course.steepestDescentKm);

        // --- The climbs that will shape the race ---
        // These carry a grade floor, a length floor, a max grade and their
        // position, so they are describable rather than noise. Not shown in
        // the UI; the coach is the consumer.
        summary.climbs = course.climbs.map(c => ({
            start_km: round(c.startKm, 1),
            end_km: round(c.endKm, 1),
            position_pct: round(c.positionPct, 0),
            length_km: round(c.lengthKm, 1),
            gain_m: Math.round(c.gainM),
            avg_grade_pct: round(c.avgGradePct, 1),
            max_grade_pct: round(c.maxGradePct, 1),
        }));

        summary.grade_distribution = course.gradeBuckets
            .filter(b => b.km > 0.05)
            .map(b => ({ band: b.label, km: round(b.km, 1) }));
        return summary;
    }

    function round(v, dp) {
        if (v === null || v === undefined || !isFinite(v)) return null;
        const f = Math.pow(10, dp || 0);
        return Math.round(v * f) / f;
    }

    return {
        parseGpx,
        haversineM,
        smoothElevations,
        elevationStats,
        computeCourse,
        buildRoutePath,
        buildAiSummary,
        // Exported for tests and for anything that wants a single derived
        // figure without running the whole course analysis.
        gradeCostFactor,
        flatEquivalentM,
        rollingIndex,
        gainInRange,
        round,
        ELEVATION_THRESHOLD_M,
        SMOOTHING_WINDOW,
        HILLY_GAIN_PER_KM,
    };
});
