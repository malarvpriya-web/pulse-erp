// backend/src/modules/logistics/services/routeOptimiser.service.js
//
// Distance-based delivery route optimisation.
//
// WHAT WAS ACTUALLY BLOCKED, AND WHAT WAS NOT
// -------------------------------------------
// The first build sequenced stops by promised date and priority and said so
// plainly: without distances, delivering in the order things were promised is
// the only defensible rule. That was a dispatch order, not a route.
//
// The blocker was named as "needs a mapping API", which conflated two things:
//
//   GEOCODING an address to a coordinate needs a service, a human, or a lookup
//     table. Migration 20260911000018 seeds a city-level table, which is the
//     resolution Indian industrial delivery planning actually works at.
//
//   OPTIMISING a tour over known coordinates is ordinary computer science and
//     needs nothing external.
//
// So this is a real optimiser. What it is NOT is a road-network router: distance
// is great-circle, and every response says so. Swapping in a road or traffic
// matrix later is a substitution into `distanceMatrix` — the algorithm does not
// change, and `distance_source` records which was used so past routes keep
// meaning what they meant.
//
// THE ALGORITHM
//   1. Nearest-neighbour from the depot — a fast, decent tour.
//   2. 2-opt improvement — repeatedly reverse a segment where doing so shortens
//      the tour, until no reversal helps. This removes the crossings that
//      nearest-neighbour characteristically leaves behind.
//
// Exact TSP is not worth solving here: a van does 8-20 drops, 2-opt lands within
// a few percent of optimal in milliseconds, and the road distances the numbers
// rest on are themselves approximations.
//
// PROMISES OUTRANK DISTANCE. A stop promised today is not resequenced behind one
// promised next week because it happens to be nearer. Stops are grouped into
// promise-date bands and optimised WITHIN each band, so the route is efficient
// without being efficient at a customer's expense.

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance between two coordinates, in kilometres. */
export function haversineKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)) * 100) / 100;
}

/** Full point-to-point distance matrix, including the depot at index 0. */
export function buildMatrix(points) {
  const n = points.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(points[i], points[j]);
      // An unlocatable stop must not look adjacent to everything. Infinity would
      // break the arithmetic, so it is penalised heavily and ends up last.
      m[i][j] = m[j][i] = d === null ? 1e6 : d;
    }
  }
  return m;
}

/** Total length of a tour that starts at the depot and visits `order` in turn. */
export function tourLength(matrix, order) {
  if (!order.length) return 0;
  let total = matrix[0][order[0]];
  for (let i = 0; i < order.length - 1; i++) total += matrix[order[i]][order[i + 1]];
  return total;
}

/** Nearest-neighbour tour from the depot over the given stop indices. */
export function nearestNeighbour(matrix, indices) {
  const unvisited = new Set(indices);
  const order = [];
  let current = 0;                       // depot
  while (unvisited.size) {
    let best = null, bestD = Infinity;
    for (const i of unvisited) {
      if (matrix[current][i] < bestD) { bestD = matrix[current][i]; best = i; }
    }
    order.push(best);
    unvisited.delete(best);
    current = best;
  }
  return order;
}

/**
 * 2-opt: reverse any segment whose reversal shortens the tour, until none does.
 * Bounded so a pathological input cannot spin — the improvement after a few
 * passes is negligible anyway.
 */
export function twoOpt(matrix, order, maxPasses = 40) {
  if (order.length < 3) return order;
  let best = [...order];
  let bestLen = tourLength(matrix, best);
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const len = tourLength(matrix, candidate);
        if (len < bestLen - 1e-9) { best = candidate; bestLen = len; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

/**
 * Optimise a set of stops from a depot.
 *
 * @param {{lat:number,lng:number}} depot
 * @param {Array<{id:*, lat:number|null, lng:number|null, promised_date:string|null, priority:string|null}>} stops
 * @param {{respectPromiseDates?: boolean}} opts
 * @returns {{order:Array, total_distance_km:number, legs:Array, unlocated:Array, improvement_pct:number|null}}
 */
export function optimiseRoute(depot, stops, { respectPromiseDates = true } = {}) {
  if (!stops.length) {
    return { order: [], total_distance_km: 0, legs: [], unlocated: [], improvement_pct: null };
  }

  const points = [{ lat: depot?.lat ?? null, lng: depot?.lng ?? null },
                  ...stops.map(s => ({ lat: s.lat, lng: s.lng }))];
  const matrix = buildMatrix(points);
  const unlocated = stops.map((s, i) => ({ ...s, idx: i + 1 }))
                         .filter(s => s.lat == null || s.lng == null);

  // Group by promise date so distance never reorders a customer's commitment.
  const bands = new Map();
  for (let i = 0; i < stops.length; i++) {
    const key = respectPromiseDates
      ? (stops[i].promised_date ? String(stops[i].promised_date).slice(0, 10) : '9999-12-31')
      : 'all';
    if (!bands.has(key)) bands.set(key, []);
    bands.get(key).push(i + 1);           // +1: index 0 is the depot
  }

  const finalOrder = [];
  for (const key of [...bands.keys()].sort()) {
    const optimised = twoOpt(matrix, nearestNeighbour(matrix, bands.get(key)));
    finalOrder.push(...optimised);
  }

  // What the naive order would have cost, for comparison. The baseline is the
  // promise/priority sequence the first build produced, so the improvement
  // figure answers "what did optimising buy us" rather than comparing against a
  // random order nobody would have driven.
  const baselineOrder = stops
    .map((s, i) => ({ i: i + 1, d: s.promised_date || '9999-12-31',
                      p: ['critical', 'high', 'normal'].indexOf(String(s.priority || 'normal').toLowerCase()) }))
    .sort((a, b) => String(a.d).localeCompare(String(b.d)) || (a.p < 0 ? 9 : a.p) - (b.p < 0 ? 9 : b.p))
    .map(x => x.i);

  const optimisedLen = tourLength(matrix, finalOrder);
  const baselineLen = tourLength(matrix, baselineOrder);
  const improvement = baselineLen > 0
    ? Math.round(((baselineLen - optimisedLen) / baselineLen) * 10000) / 100
    : null;

  const legs = [];
  let prev = 0;
  for (const idx of finalOrder) {
    const km = matrix[prev][idx];
    legs.push({
      stop: stops[idx - 1],
      leg_distance_km: km >= 1e6 ? null : Math.round(km * 100) / 100,
    });
    prev = idx;
  }

  return {
    order: finalOrder.map(i => stops[i - 1]),
    legs,
    total_distance_km: optimisedLen >= 1e6 ? null : Math.round(optimisedLen * 100) / 100,
    baseline_distance_km: baselineLen >= 1e6 ? null : Math.round(baselineLen * 100) / 100,
    improvement_pct: improvement,
    unlocated: unlocated.map(s => ({ id: s.id, reason: 'no coordinate — sequenced last' })),
    distance_source: 'great_circle',
  };
}

export default { haversineKm, buildMatrix, tourLength, nearestNeighbour, twoOpt, optimiseRoute };
