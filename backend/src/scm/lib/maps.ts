// ---------------------------------------------------------------------------
// maps.ts — Google Directions route optimisation for a delivery trip.
//
// docs/agents/operating-spec.md §4 (Delivery agent): "Maps / distance service —
// travel-time estimate and routing." The delivery board's schedule layer
// (scm.trips + trip_stops) orders stops by a manual stop_no; this turns that
// manual order into an optimised one and fills in per-stop ETA.
//
// GATED behind GOOGLE_MAPS_API_KEY. When the key is absent this returns
// { configured: false } and NEVER calls Google — so nothing here bills until the
// owner sets the key. That mirrors how the codebase already treats the key
// (commented out in wrangler.toml; scan-so's geocoder no-ops without it).
//
// The URL builder and the response parser are PURE and unit-tested; only the
// thin fetch wrapper touches the network, so the routing maths is verifiable
// without a key.
// ---------------------------------------------------------------------------

const DIRECTIONS_BASE = 'https://maps.googleapis.com/maps/api/directions/json';
const DISTANCE_MATRIX_BASE = 'https://maps.googleapis.com/maps/api/distancematrix/json';

export interface RouteStop {
  /** Opaque id the caller uses to match the result back (a trip_stop id). */
  ref: string;
  /** A geocodable address string. Directions geocodes waypoints itself, so no
   *  separate lat/lng step is needed. */
  address: string;
}

export interface OptimizedStop {
  ref: string;
  address: string;
  /** 1-based position in the optimised order. */
  order: number;
  /** The leg that ARRIVES at this stop (from the previous point). */
  legDistanceMetres: number;
  legDurationSeconds: number;
  /** Cumulative drive time from the depot to arriving here — the caller adds the
   *  trip's depart clock time to get a wall-clock ETA. Does NOT include service
   *  time at earlier stops (unknown here). */
  etaSecondsFromDepart: number;
}

export interface RouteResult {
  /** False = no API key; the caller must fall back to the manual order. */
  configured: boolean;
  /** True only when a usable optimised route came back. */
  ok: boolean;
  /** Why ok is false (never configured, or the API status), for the caller. */
  reason?: string;
  stops: OptimizedStop[];
  totalDistanceMetres: number;
  totalDurationSeconds: number;
}

const NOT_CONFIGURED: RouteResult = {
  configured: false, ok: false, reason: 'GOOGLE_MAPS_API_KEY not set — routing disabled',
  stops: [], totalDistanceMetres: 0, totalDurationSeconds: 0,
};

/**
 * Build the Directions URL. PURE. `optimize:true` on the waypoints asks Google
 * to reorder them for the shortest route. A round trip returns to the origin
 * (the depot), which is the delivery reality; set roundTrip=false to end at the
 * last stop.
 */
export function buildDirectionsUrl(
  originAddress: string,
  stops: RouteStop[],
  apiKey: string,
  roundTrip = true,
): string {
  const origin = encodeURIComponent(originAddress);
  const destination = roundTrip ? origin : encodeURIComponent(stops[stops.length - 1]?.address ?? originAddress);
  // With a round trip, ALL stops are waypoints. Without, the last stop is the
  // destination and only the rest are waypoints.
  const waypointStops = roundTrip ? stops : stops.slice(0, -1);
  const waypoints = waypointStops.map((s) => encodeURIComponent(s.address)).join('|');
  const parts = [
    `origin=${origin}`,
    `destination=${destination}`,
    waypoints ? `waypoints=optimize:true|${waypoints}` : '',
    'region=my',
    `key=${apiKey}`,
  ].filter(Boolean);
  return `${DIRECTIONS_BASE}?${parts.join('&')}`;
}

interface DirectionsBody {
  status?: string;
  routes?: Array<{
    waypoint_order?: number[];
    legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }>;
  }>;
}

/**
 * Turn a Directions response into the optimised stop order + ETAs. PURE.
 *
 * `waypoint_order` indexes into the ORIGINAL waypoints array (the stops, minus
 * the destination on a one-way trip). `legs` are origin→wp1→…→destination in the
 * OPTIMISED order, so leg i (0-based) arrives at the i-th optimised stop.
 */
export function parseOptimizedRoute(
  body: DirectionsBody,
  stops: RouteStop[],
  roundTrip = true,
): RouteResult {
  if (body.status !== 'OK' || !body.routes?.length) {
    return { configured: true, ok: false, reason: `Directions status ${body.status ?? 'unknown'}`,
      stops: [], totalDistanceMetres: 0, totalDurationSeconds: 0 };
  }
  const route = body.routes[0];
  const legs = route.legs ?? [];

  // The waypoints that were optimised. On a one-way trip the last stop is the
  // fixed destination and is appended after the optimised waypoints.
  const waypointStops = roundTrip ? stops : stops.slice(0, -1);
  const order = route.waypoint_order ?? waypointStops.map((_, i) => i);

  // Optimised sequence of stops: the reordered waypoints, then (one-way) the
  // fixed destination stop last.
  const sequenced: RouteStop[] = order.map((i) => waypointStops[i]).filter(Boolean);
  if (!roundTrip && stops.length) sequenced.push(stops[stops.length - 1]);

  const optimized: OptimizedStop[] = [];
  let cumSeconds = 0;
  let totalDistance = 0;
  let totalDuration = 0;
  sequenced.forEach((s, idx) => {
    const leg = legs[idx];
    const dist = Number(leg?.distance?.value ?? 0);
    const dur = Number(leg?.duration?.value ?? 0);
    cumSeconds += dur;
    totalDistance += dist;
    totalDuration += dur;
    optimized.push({
      ref: s.ref, address: s.address, order: idx + 1,
      legDistanceMetres: dist, legDurationSeconds: dur, etaSecondsFromDepart: cumSeconds,
    });
  });
  // On a round trip the final leg back to the depot still counts toward the
  // total, though no stop arrives on it.
  if (roundTrip && legs.length > sequenced.length) {
    const back = legs[legs.length - 1];
    totalDistance += Number(back?.distance?.value ?? 0);
    totalDuration += Number(back?.duration?.value ?? 0);
  }

  return { configured: true, ok: true, stops: optimized,
    totalDistanceMetres: totalDistance, totalDurationSeconds: totalDuration };
}

// ===========================================================================
// Distance Matrix — the travel-time / distance MATRIX between every point, for
// the Phase 3 "Propose times + route" scheduler. Directions optimises ONE tour;
// the scheduler needs the full point-to-point matrix so it can sequence stops
// under time-window constraints (residence rules) and re-cost a drag-reorder
// WITHOUT another Google call. ONE Distance Matrix request answers all of it.
// GATED behind GOOGLE_MAPS_API_KEY exactly like optimizeRoute.
// ===========================================================================

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface MatrixResult {
  /** False = no API key; the caller must fall back. */
  configured: boolean;
  /** True only when a full, finite matrix came back. */
  ok: boolean;
  reason?: string;
  /** durationSeconds[i][j] = drive seconds from point i to point j. */
  durationSeconds: number[][];
  /** distanceMetres[i][j] = drive metres from point i to point j. */
  distanceMetres: number[][];
}

const NOT_CONFIGURED_MATRIX: MatrixResult = {
  configured: false, ok: false,
  reason: 'GOOGLE_MAPS_API_KEY not set — travel matrix disabled',
  durationSeconds: [], distanceMetres: [],
};

/** Build the Distance Matrix URL. PURE. Every point is both an origin and a
 *  destination, so one call yields the full NxN matrix. */
export function buildDistanceMatrixUrl(points: LatLngPoint[], apiKey: string): string {
  const coords = points.map((p) => `${p.lat},${p.lng}`).join('|');
  const enc = encodeURIComponent(coords);
  return `${DISTANCE_MATRIX_BASE}?origins=${enc}&destinations=${enc}&region=my&key=${apiKey}`;
}

interface DistanceMatrixBody {
  status?: string;
  rows?: Array<{
    elements?: Array<{
      status?: string;
      distance?: { value?: number };
      duration?: { value?: number };
    }>;
  }>;
}

/**
 * Parse a Distance Matrix response into duration/distance matrices. PURE. A
 * per-element non-OK status (NOT_FOUND / ZERO_RESULTS) becomes a 0 rather than a
 * throw — the sequencer treats a 0 leg as "unknown, effectively adjacent", which
 * degrades that leg's ETA but never crashes the proposal. The diagonal is 0.
 */
export function parseDistanceMatrix(body: DistanceMatrixBody, n: number): MatrixResult {
  if (body.status !== 'OK' || !body.rows?.length) {
    return { configured: true, ok: false, reason: `Distance Matrix status ${body.status ?? 'unknown'}`,
      durationSeconds: [], distanceMetres: [] };
  }
  const durationSeconds: number[][] = [];
  const distanceMetres: number[][] = [];
  for (let i = 0; i < n; i++) {
    const els = body.rows[i]?.elements ?? [];
    const durRow: number[] = [];
    const distRow: number[] = [];
    for (let j = 0; j < n; j++) {
      const el = els[j];
      const okEl = el?.status === 'OK';
      durRow.push(i === j ? 0 : (okEl ? Number(el?.duration?.value ?? 0) : 0));
      distRow.push(i === j ? 0 : (okEl ? Number(el?.distance?.value ?? 0) : 0));
    }
    durationSeconds.push(durRow);
    distanceMetres.push(distRow);
  }
  return { configured: true, ok: true, durationSeconds, distanceMetres };
}

/**
 * Fetch the travel matrix for a set of points. The fetch wrapper: gated off
 * without a key, and never throws — a failure returns ok:false and the caller
 * falls back to the input order with no ETAs.
 */
export async function travelTimeMatrix(
  env: { GOOGLE_MAPS_API_KEY?: string },
  points: LatLngPoint[],
): Promise<MatrixResult> {
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return NOT_CONFIGURED_MATRIX;
  if (points.length < 2) {
    return { configured: true, ok: false, reason: 'need at least a depot + one stop',
      durationSeconds: [], distanceMetres: [] };
  }
  try {
    const resp = await fetch(buildDistanceMatrixUrl(points, apiKey), { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      return { configured: true, ok: false, reason: `Distance Matrix HTTP ${resp.status}`,
        durationSeconds: [], distanceMetres: [] };
    }
    return parseDistanceMatrix((await resp.json()) as DistanceMatrixBody, points.length);
  } catch (e) {
    return { configured: true, ok: false, reason: `matrix failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
      durationSeconds: [], distanceMetres: [] };
  }
}

/**
 * Optimise a trip's stops. The fetch wrapper: gated off without a key, and never
 * throws — a routing failure falls back to the manual order at the caller.
 */
export async function optimizeRoute(
  env: { GOOGLE_MAPS_API_KEY?: string },
  input: { originAddress: string; stops: RouteStop[]; roundTrip?: boolean },
): Promise<RouteResult> {
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return NOT_CONFIGURED;
  const stops = input.stops.filter((s) => (s.address ?? '').trim() !== '');
  if (stops.length === 0) {
    return { configured: true, ok: false, reason: 'no stops with an address',
      stops: [], totalDistanceMetres: 0, totalDurationSeconds: 0 };
  }
  const roundTrip = input.roundTrip ?? true;
  try {
    const url = buildDirectionsUrl(input.originAddress, stops, apiKey, roundTrip);
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      return { configured: true, ok: false, reason: `Directions HTTP ${resp.status}`,
        stops: [], totalDistanceMetres: 0, totalDurationSeconds: 0 };
    }
    return parseOptimizedRoute((await resp.json()) as DirectionsBody, stops, roundTrip);
  } catch (e) {
    return { configured: true, ok: false, reason: `routing failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
      stops: [], totalDistanceMetres: 0, totalDurationSeconds: 0 };
  }
}
