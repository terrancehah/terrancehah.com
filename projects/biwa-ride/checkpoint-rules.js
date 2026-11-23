/* checkpoint-rules.js — pure group/rally progress calculations.
 *
 * These functions never touch the DOM, storage or the network so they can be
 * unit-tested under `node --test` and reused by every view. All shared state
 * lives in the trip snapshot (schema v2):
 *
 *   trip.places            — catalogue (programme membership is immutable
 *                            source metadata, independent of itinerary edits)
 *   trip.days[].stops[]    — itinerary occurrences {occurrenceId, placeId}
 *   trip.days[].start/end  — endpoints; implicit occurrence ids dayId-start /
 *                            dayId-end make them tickable like stops
 *   trip.visitStatus       — {occurrenceId: true} manual per-occurrence visits
 *   trip.programmeStatus   — {rally: {placeId: true}, official: {placeId: true}}
 *                            shared manual checklist, keyed by programme FAMILY
 *   trip.skippedStatus     — {occurrenceId: true} optional per-occurrence skip
 *                            dismissal: the stop keeps its itinerary and route
 *                            slot but leaves the "next" queue — never a visit,
 *                            never programme progress; only Undo skip clears
 *                            it (a check while skipped is a no-op)
 *   One arrival tick marks the row's visit flag AND every programme family
 *   the place belongs to — a shared checkpoint (Mizudori) clears both.
 *   The stamp rally is retired from the active surface: rally-only records
 *   stay immutable in the catalogue and stored snapshots, but dayPoints
 *   filters them out — no itinerary row, route anchor or next target. A
 *   shared official+rally record (Mizudori) renders as official only.
 */
(function (global) {
  'use strict';

  var BiwaRules = {};

  // Official checkpoint programme ids grouped by lakeside area. The rally is
  // a single ten-stop programme, not area based.
  BiwaRules.OFFICIAL_AREAS = [
    { key: 'south', programme: 'official-south', label: 'South shore' },
    { key: 'east', programme: 'official-east', label: 'East shore' },
    { key: 'north', programme: 'official-north', label: 'North shore' },
    { key: 'west', programme: 'official-west', label: 'West shore' }
  ];
  BiwaRules.RALLY_TOTAL = 10;

  // Index places by stable placeId for O(1) lookup everywhere else.
  BiwaRules.placesById = function (trip) {
    var map = {};
    (trip.places || []).forEach(function (p) { map[p.placeId] = p; });
    return map;
  };

  // Does this source place belong to a given programme? Programme membership
  // comes from the checkpoint catalogue, not the itinerary, so removing a
  // stop from a day never removes it from the certificate catalogue.
  BiwaRules.placeInProgramme = function (place, programme) {
    return !!(place && place.programmes && place.programmes.indexOf(programme) !== -1);
  };

  // All catalogue places carrying rally membership (expected total: 10).
  BiwaRules.rallyPlaces = function (trip) {
    return (trip.places || []).filter(function (p) {
      return BiwaRules.placeInProgramme(p, 'rally');
    });
  };

  // A place belonging ONLY to the stamp rally — shared checkpoints like
  // Mizudori keep their official membership and are never caught by this.
  // Rally-only records stay immutable in the catalogue and stored trips;
  // the active surface simply never offers them to the rider.
  BiwaRules.isRallyOnly = function (place) {
    return !!(
      place &&
      BiwaRules.placeInProgramme(place, 'rally') &&
      BiwaRules.programmeFamilies(place.programmes).indexOf(
        'official'
      ) === -1
    );
  };

  // All catalogue places for one official area, e.g. 'south' -> official-south.
  BiwaRules.officialPlacesForArea = function (trip, areaKey) {
    var area = BiwaRules.OFFICIAL_AREAS.filter(function (a) { return a.key === areaKey; })[0];
    if (!area) return [];
    return (trip.places || []).filter(function (p) {
      return BiwaRules.placeInProgramme(p, area.programme);
    });
  };

  function isProgrammeChecked(trip, programme, placeId) {
    var status = trip.programmeStatus && trip.programmeStatus[programme];
    return !!(status && status[placeId]);
  }

  // The programmeStatus families a place's membership maps to — 'rally' plus
  // 'official' for any official-* area, so one tick can mark both.
  BiwaRules.programmeFamilies = function (programmes) {
    var fams = [];
    (programmes || []).forEach(function (p) {
      if (p === 'rally' && fams.indexOf('rally') === -1) fams.push('rally');
      else if (typeof p === 'string' && p.indexOf('official-') === 0 &&
               fams.indexOf('official') === -1) fams.push('official');
    });
    return fams;
  };

  // Is the place checked for ANY programme family? Used to derive the arrival
  // state of every occurrence of the same place.
  BiwaRules.placeProgrammeChecked = function (trip, place) {
    return BiwaRules.programmeFamilies(place && place.programmes).some(function (f) {
      return isProgrammeChecked(trip, f, place.placeId);
    });
  };

  // The implicit occurrence id an endpoint row carries for manual visits.
  BiwaRules.endpointOccurrenceId = function (day, which) {
    return day.dayId + '-' + which;
  };

  // Derived arrival state for a row: its own visit flag, plus — for
  // programme places — the shared family check (a tick on one occurrence is
  // reflected on the place's other occurrences). A skipped occurrence is
  // never read as arrived: the dismissal is intentional, so even a shared
  // programme tick landed elsewhere leaves it skipped — only Undo skip
  // restores it, at which point any stored visit flag shows through again.
  BiwaRules.arrivalChecked = function (trip, occurrenceId, place) {
    if (BiwaRules.isSkipped(trip, occurrenceId)) return false;
    if (trip.visitStatus && trip.visitStatus[occurrenceId]) return true;
    return BiwaRules.placeProgrammeChecked(trip, place);
  };

  // Apply one arrival tick: the row's own visit flag plus EVERY programme
  // family the place belongs to. Unchecking clears the place's programme
  // flags but never other occurrences' own visit flags. There is no
  // direct skipped -> visited transition: a check while the occurrence is
  // skipped is a complete no-op (no visit, no programme writes — Undo skip
  // must come first), and unchecking never silently undoes the dismissal
  // either; only applySkip(false) clears a skip flag.
  BiwaRules.applyArrival = function (draft, occurrenceId, place, checked) {
    if (
      checked &&
      occurrenceId &&
      BiwaRules.isSkipped(draft, occurrenceId)
    ) {
      return;
    }
    draft.visitStatus = draft.visitStatus || {};
    if (occurrenceId) {
      if (checked) draft.visitStatus[occurrenceId] = true;
      else delete draft.visitStatus[occurrenceId];
    }
    BiwaRules.programmeFamilies(place && place.programmes).forEach(function (family) {
      BiwaRules.checkProgramme(draft, family, place.placeId, checked);
    });
  };

  // Per-occurrence skip flags — a dismissal of the stop, independent of
  // visitStatus and the programme families.
  BiwaRules.isSkipped = function (trip, occurrenceId) {
    return !!(
      trip &&
      trip.skippedStatus &&
      occurrenceId &&
      trip.skippedStatus[occurrenceId] === true
    );
  };

  // The stop+place pair behind a skippable occurrence — an official
  // checkpoint that is still an itinerary stop. Endpoints are day
  // boundaries not stops; custom/extra places, route-waypoint anchors and
  // rally-only records never qualify either.
  function skippableTarget(trip, occurrenceId) {
    if (!trip || !occurrenceId) return null;
    var places = BiwaRules.placesById(trip);
    var target = null;
    (trip.days || []).some(function (day) {
      return (day.stops || []).some(function (stop) {
        if (stop.occurrenceId !== occurrenceId) return false;
        var place = places[stop.placeId];
        if (
          place &&
          BiwaRules.programmeFamilies(place.programmes).indexOf(
            'official'
          ) !== -1
        ) {
          target = { stop: stop, place: place };
          return true;
        }
        return false;
      });
    });
    return target;
  }

  // Only official checkpoint occurrences that are still itinerary stops may
  // be skipped — never endpoints (they are day boundaries, not stops),
  // custom/extra places, route-waypoint anchors or rally-only records.
  BiwaRules.skippableOccurrence = function (trip, occurrenceId) {
    return !!skippableTarget(trip, occurrenceId);
  };

  // A skip is a dismissal, never a visit: it touches only skippedStatus so
  // the row keeps its itinerary order, route geometry and visit state — and
  // no programme family is ever marked. Setting the flag is refused for an
  // ineligible occurrence or one already arrived — a completed stop can
  // never carry a hidden dismissal. Clearing is unconditional: undo must
  // still reach a flag whose eligibility or visit state changed since.
  // Progress writers mutate a progress-only draft ({visitStatus,
  // programmeStatus, skippedStatus} — no days/places), so they pass the
  // live trip as tripContext: eligibility and arrival resolve against the
  // real itinerary while the draft's progress maps win the overlay.
  BiwaRules.applySkip = function (draft, occurrenceId, skipped, tripContext) {
    draft.skippedStatus = draft.skippedStatus || {};
    if (!skipped) {
      delete draft.skippedStatus[occurrenceId];
      return;
    }
    var effective = Object.assign({}, tripContext || draft, draft);
    var target = skippableTarget(effective, occurrenceId);
    if (!target) return;
    if (BiwaRules.arrivalChecked(effective, occurrenceId, target.place))
      return;
    draft.skippedStatus[occurrenceId] = true;
  };

  // Rally progress: shared manual checks against the ten-stop catalogue.
  BiwaRules.rallyProgress = function (trip) {
    var places = BiwaRules.rallyPlaces(trip);
    var done = places.filter(function (p) {
      return isProgrammeChecked(trip, 'rally', p.placeId);
    }).length;
    return { done: done, total: places.length, complete: done === places.length && places.length > 0 };
  };

  // Official progress per area: an area counts as covered when at least one
  // of its checkpoints is checked (the programme asks for one per area).
  BiwaRules.officialAreaProgress = function (trip) {
    var areas = BiwaRules.OFFICIAL_AREAS.map(function (area) {
      var places = BiwaRules.officialPlacesForArea(trip, area.key);
      var checked = places.filter(function (p) {
        return isProgrammeChecked(trip, 'official', p.placeId);
      }).length;
      return {
        key: area.key,
        label: area.label,
        programme: area.programme,
        checked: checked,
        total: places.length,
        covered: checked >= 1,
        places: places
      };
    });
    var coveredCount = areas.filter(function (a) { return a.covered; }).length;
    return {
      areas: areas,
      coveredCount: coveredCount,
      totalAreas: areas.length,
      complete: coveredCount === areas.length && areas.length > 0
    };
  };

  // Group checklist completion is a housekeeping label, not an official
  // award — the UI must say "Group checklist complete", never "Certificate
  // earned", because this app neither submits nor verifies official stamps.
  // With the rally retired from the active ride, completion gates on the
  // official shores alone; the rally sub-result still reports any persisted
  // rally progress for compatibility.
  BiwaRules.groupChecklist = function (trip) {
    var rally = BiwaRules.rallyProgress(trip);
    var official = BiwaRules.officialAreaProgress(trip);
    return {
      rally: rally,
      official: official,
      complete: official.complete,
      label: 'Group checklist complete'
    };
  };

  // Programme badges for a stop row, e.g. ['Official · North']. The rally
  // chip is retired with the rally surface — a shared official+rally record
  // emits 'Official · X' alone.
  BiwaRules.placeBadges = function (place) {
    var badges = [];
    if (!place || !place.programmes) return badges;
    BiwaRules.OFFICIAL_AREAS.forEach(function (area) {
      if (place.programmes.indexOf(area.programme) !== -1) {
        badges.push('Official · ' + area.label.replace(' shore', ''));
      }
    });
    return badges;
  };

  // Ordered row list for a day: start endpoint, each stop in order, then the
  // end endpoint. Rows carry everything the timeline/map/links need: visit
  // state, badges metadata and the transient anchors (googlePlaceId /
  // address — coordinates may legitimately be null for resolved extras).
  // Missing endpoints are skipped here; the caller renders an explicit
  // missing-endpoint state so nothing is dropped silently.
  BiwaRules.dayPoints = function (trip, day) {
    var places = BiwaRules.placesById(trip);
    var points = [];
    function placePoint(p, kind, occurrenceId) {
      var visited = BiwaRules.arrivalChecked(trip, occurrenceId, p);
      return {
        kind: kind,
        occurrenceId: occurrenceId,
        placeId: p.placeId,
        label: p.label,
        lat: p.lat,
        lng: p.lng,
        googlePlaceId: p.googlePlaceId || null,
        address: p.address || null,
        category: p.category || null,
        place: p,
        visited: visited,
        // Skipped is a dismissal flag, not a visit — the row keeps its
        // slot but leaves the next queue. Endpoints never carry it, and
        // arrivalChecked already reports a skipped row unvisited, so the
        // flag alone decides the face until it is undone.
        skipped:
          kind === 'stop' && BiwaRules.isSkipped(trip, occurrenceId),
        // Only official checkpoint stop occurrences may be skipped —
        // endpoints, custom/extra places, waypoints and rally-only
        // records are never eligible.
        skippable:
          kind === 'stop' &&
          BiwaRules.programmeFamilies(p.programmes).indexOf(
            'official'
          ) !== -1
      };
    }
    function pushEndpoint(endpoint, kind) {
      if (!endpoint) return;
      var occurrenceId = BiwaRules.endpointOccurrenceId(day, kind);
      if (endpoint.placeId && places[endpoint.placeId]) {
        points.push(placePoint(places[endpoint.placeId], kind, occurrenceId));
      } else if (endpoint.pin && typeof endpoint.pin.lat === 'number') {
        var pinPlace = { placeId: null, programmes: [] };
        points.push({
          kind: kind,
          occurrenceId: occurrenceId,
          placeId: null,
          label: endpoint.pin.label || 'Pinned point',
          lat: endpoint.pin.lat,
          lng: endpoint.pin.lng,
          googlePlaceId: null,
          address: null,
          category: 'pin',
          place: null,
          visited: !!(trip.visitStatus && trip.visitStatus[occurrenceId]),
          skipped: false,
          skippable: false
        });
      }
    }
    pushEndpoint(day.start, 'start');
    (day.stops || []).forEach(function (stop) {
      var p = places[stop.placeId];
      if (!p) return;
      // Rally-only records stay stored in day.stops (immutable source
      // data) but never reach the active itinerary — no row, route
      // anchor or next target.
      if (BiwaRules.isRallyOnly(p)) return;
      points.push(placePoint(p, 'stop', stop.occurrenceId));
    });
    pushEndpoint(day.end, 'end');
    return points;
  };

  // The check-in rows a day presents to the rider: dayPoints minus the
  // hidden route-waypoint anchors. Waypoints steer the road line but are
  // not destinations — itinerary, completion, Nearby context and the map's
  // day location lists all read this view; routing keeps full dayPoints.
  BiwaRules.visibleDayPoints = function (trip, day) {
    return BiwaRules.dayPoints(trip, day).filter(function (p) {
      return !(p.place && p.place.category === 'route-waypoint');
    });
  };

  // The next unvisited row for the "up next" card — endpoints included, so
  // the day's first pending point may be the start lodging or the rental
  // finish, not only scheduled stops. Skipped occurrences are dismissed
  // from this queue but keep their itinerary slot.
  BiwaRules.nextUnvisitedStop = function (trip, day) {
    var points = BiwaRules.visibleDayPoints(trip, day);
    for (var i = 0; i < points.length; i++) {
      if (!points[i].visited && !points[i].skipped) return points[i];
    }
    return null;
  };

  // Provider-route anchors for a day: source coordinates where present, a
  // Google place id where the record is resolved transiently. Rows with
  // neither are reported as 'unroutable' rather than silently dropped.
  BiwaRules.routePoints = function (trip, day) {
    var points = BiwaRules.dayPoints(trip, day);
    var routable = [];
    var unroutable = [];
    points.forEach(function (p) {
      if (typeof p.lat === 'number' && typeof p.lng === 'number') {
        routable.push({ lat: p.lat, lng: p.lng });
      } else if (p.googlePlaceId) {
        routable.push({ googlePlaceId: p.googlePlaceId });
      } else {
        unroutable.push(p.label);
      }
    });
    return { points: routable, unroutable: unroutable };
  };

  // Every occurrence of a place across all days — scheduled stops AND
  // endpoint roles (repeated visits are valid; each carries its own flag).
  BiwaRules.occurrencesOf = function (trip, placeId) {
    var found = [];
    (trip.days || []).forEach(function (day) {
      ['start', 'end'].forEach(function (which) {
        var endpoint = day[which];
        if (endpoint && endpoint.placeId === placeId) {
          found.push({ dayId: day.dayId, occurrenceId: BiwaRules.endpointOccurrenceId(day, which), kind: which });
        }
      });
      (day.stops || []).forEach(function (stop) {
        if (stop.placeId === placeId) found.push({ dayId: day.dayId, occurrenceId: stop.occurrenceId, kind: 'stop' });
      });
    });
    return found;
  };

  // Reorder a stop inside its day, preserving its occurrenceId (and so its
  // visit flag). Used by drag reorder and the keyboard/sheet alternatives.
  BiwaRules.moveStopWithinDay = function (day, fromIndex, toIndex) {
    var stops = day.stops || [];
    if (fromIndex < 0 || fromIndex >= stops.length) return;
    if (toIndex < 0 || toIndex >= stops.length) return;
    var stop = stops.splice(fromIndex, 1)[0];
    stops.splice(toIndex, 0, stop);
  };

  // Move a stop occurrence to the END of another day, preserving its
  // occurrenceId/visit flag and honouring the provider stop cap.
  BiwaRules.moveStopBetweenDays = function (trip, fromDayId, occurrenceId, toDayId) {
    var from = (trip.days || []).filter(function (d) { return d.dayId === fromDayId; })[0];
    var to = (trip.days || []).filter(function (d) { return d.dayId === toDayId; })[0];
    if (!from || !to || from === to) return false;
    if ((to.stops || []).length >= BiwaRules.MAX_STOPS_PER_DAY) return false;
    var index = (from.stops || []).findIndex(function (s) { return s.occurrenceId === occurrenceId; });
    if (index === -1) return false;
    var stop = from.stops.splice(index, 1)[0];
    to.stops.push(stop);
    return true;
  };

  // 25 stops + 2 endpoints = 27 locations, the Google Routes cap.
  BiwaRules.MAX_STOPS_PER_DAY = 25;

  // Removing a stop from the itinerary must not change certificate progress:
  // programme status is keyed on placeId, not occurrenceId, by design.
  BiwaRules.checkProgramme = function (trip, programme, placeId, checked) {
    if (!trip.programmeStatus) trip.programmeStatus = {};
    if (!trip.programmeStatus[programme]) trip.programmeStatus[programme] = {};
    if (checked) trip.programmeStatus[programme][placeId] = true;
    else delete trip.programmeStatus[programme][placeId];
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BiwaRules;
  global.BiwaRules = BiwaRules;
})(typeof window !== 'undefined' ? window : globalThis);
