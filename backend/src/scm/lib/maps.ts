
const DIRECTIONS_BASE = 'https://maps.googleapis.com/maps/api/directions/json';
const DISTANCE_MATRIX_BASE = 'https://maps.googleapis.com/maps/api/distancematrix/json';

export interface RouteStop {
  ref: string;
  address: string;
}

export interface OptimizedStop {
  ref: string;
  address: string;
  order: number;
  legDistanceMetres: number;
  legDurationSeconds: number;
  etaSecondsFromDepart: number;
}

export interface RouteResult {
  configured: boolean;
  ok: boolean;
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

  const waypointStops = roundTrip ? stops : stops.slice(0, -1);
  const order = route.waypoint_order ?? waypointStops.map((_, i) => i);

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
  if (roundTrip && legs.length > sequenced.length) {
    const back = legs[legs.length - 1];
    totalDistance += Number(back?.distance?.value ?? 0);
    totalDuration += Number(back?.duration?.value ?? 0);
  }

  return { configured: true, ok: true, stops: optimized,
    totalDistanceMetres: totalDistance, totalDurationSeconds: totalDuration };
}


export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface MatrixResult {
  configured: boolean;
  ok: boolean;
  reason?: string;
  durationSeconds: number[][];
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
