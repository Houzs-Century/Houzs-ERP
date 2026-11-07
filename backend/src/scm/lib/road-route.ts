// A lorry's day by road (owner 2026-11-08): from its home point, through its stops in
// the order they run, and back home. Google Directions gives the distance and driving
// time; the stops are NOT reordered here (the run's order is the office's decision).
// Gated on GOOGLE_MAPS_API_KEY like the rest of maps.ts: no key, no call.

export type Point = { lat: number; lng: number };
export type RoadRoute = { ok: true; distanceM: number; durationS: number; polyline: string | null } | { ok: false; reason: string };

const DIRECTIONS = 'https://maps.googleapis.com/maps/api/directions/json';
/** Directions takes at most 25 waypoints in one request. */
export const MAX_STOPS = 25;

const at = (p: Point) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** The key a stored figure was worked out for: the home point and the stops in order. PURE. */
export const stopKey = (home: Point, stops: readonly Point[]): string => [home, ...stops].map(at).join('|');

/** The Directions request for home -> stops in order -> home. PURE. */
export function roadRouteUrl(home: Point, stops: readonly Point[], apiKey: string): string {
  const parts = [`origin=${at(home)}`, `destination=${at(home)}`, 'region=my', `key=${apiKey}`];
  if (stops.length) parts.splice(2, 0, `waypoints=${stops.map((s) => encodeURIComponent(at(s))).join('|')}`);
  return `${DIRECTIONS}?${parts.join('&')}`;
}

type Body = { status?: string; routes?: Array<{ legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }>; overview_polyline?: { points?: string } }> };

/** Add up every leg, the drive home included. PURE. */
export function parseRoadRoute(body: Body): RoadRoute {
  const route = body.status === 'OK' ? body.routes?.[0] : undefined;
  if (!route) return { ok: false, reason: `Directions status ${body.status ?? 'unknown'}` };
  const legs = route.legs ?? [];
  return {
    ok: true,
    distanceM: legs.reduce((a, l) => a + Number(l.distance?.value ?? 0), 0),
    durationS: legs.reduce((a, l) => a + Number(l.duration?.value ?? 0), 0),
    polyline: route.overview_polyline?.points ?? null,
  };
}

export async function roadRoute(env: { GOOGLE_MAPS_API_KEY?: string }, home: Point, stops: readonly Point[]): Promise<RoadRoute> {
  if (!env.GOOGLE_MAPS_API_KEY) return { ok: false, reason: 'Google Maps is not set up' };
  if (stops.length === 0) return { ok: false, reason: 'no stops' };
  if (stops.length > MAX_STOPS) return { ok: false, reason: `more than ${MAX_STOPS} stops` };
  try {
    const res = await fetch(roadRouteUrl(home, stops, env.GOOGLE_MAPS_API_KEY), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, reason: `Directions HTTP ${res.status}` };
    return parseRoadRoute((await res.json()) as Body);
  } catch (e) {
    return { ok: false, reason: `routing failed: ${String((e as Error).message).slice(0, 120)}` };
  }
}
