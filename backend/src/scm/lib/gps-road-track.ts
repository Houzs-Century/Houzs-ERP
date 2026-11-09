// A lorry's driven path along the roads (owner 2026-11-10): the tracker sends a fix
// every 5 min, several km apart, so joining them with straight lines cuts across
// buildings. Each run of consecutive fixes is sent to Google Directions (the same key
// and API Last Mile already uses) as origin, pass-through points and destination, and
// the road it returns is drawn instead. The fixes are 3-5 km apart, too far for a
// snap-to-roads API, which wants points a few hundred metres apart.
//
// A chunk of fixes never changes once later fixes exist, so each chunk's road is kept
// by its own points and Google is asked once per chunk, not once per poll. No key, a
// refusal, a timeout or a detour Google invents: that chunk stays straight, no error.

import { haversineKm, MAX_KMH, MIN_HOP_KM, type Fix } from './lorry-km';

export type Point = { lat: number; lng: number };
export type RoadTrack = { path: Point[]; chunks: number; roadChunks: number };
/** A stored road for a chunk; `null` = Google answered but the road is not usable, keep it straight. */
export type ChunkCache = {
  get(key: string): Promise<Point[] | null | undefined>;
  put(key: string, road: Point[] | null): Promise<void>;
};

const DIRECTIONS = 'https://maps.googleapis.com/maps/api/directions/json';
/** Origin + 8 pass-through points + destination: up to 10 waypoints is Directions' lower price tier. */
export const CHUNK_POINTS = 10;
/** 40 chunks = 361 moving fixes; the busiest day measured had 180 (probe-lorry-gps-volume.mjs, 2026-11-10). */
export const MAX_CHUNKS = 40;
/** Google's road longer than this many times the straight line (plus 1 km) is a detour it invented, not the drive. */
export const DETOUR_LIMIT = 3;
const PARALLEL = 4;

const at = (p: Point) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/** The fixes worth drawing, in time order: parked drift and GPS jumps dropped. PURE. */
export function drivenPoints(fixes: readonly Fix[]): Point[] {
  const sorted = [...fixes].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  const out: Array<Point & { t: number }> = [];
  for (const f of sorted) {
    const t = Date.parse(f.recorded_at);
    const last = out.at(-1);
    if (last) {
      const km = haversineKm(last, f);
      const hours = (t - last.t) / 3_600_000;
      if (km < MIN_HOP_KM || hours <= 0 || km / hours > MAX_KMH) continue;
    }
    out.push({ lat: f.lat, lng: f.lng, t });
  }
  return out.map(({ lat, lng }) => ({ lat, lng }));
}

/** Consecutive chunks that share their joining point. PURE. */
export function chunkPoints(points: readonly Point[], size = CHUNK_POINTS): Point[][] {
  const out: Point[][] = [];
  for (let i = 0; i < points.length - 1; i += size - 1) out.push(points.slice(i, i + size));
  return out;
}

export const chunkKey = (chunk: readonly Point[]): string => chunk.map(at).join('|');

/** `via:` points are passed through, not stopped at. PURE. */
export function chunkUrl(chunk: readonly Point[], apiKey: string): string {
  const via = chunk.slice(1, -1).map((p) => encodeURIComponent(`via:${at(p)}`));
  const parts = [`origin=${at(chunk[0])}`, `destination=${at(chunk[chunk.length - 1])}`, 'region=my', `key=${apiKey}`];
  if (via.length) parts.splice(2, 0, `waypoints=${via.join('|')}`);
  return `${DIRECTIONS}?${parts.join('&')}`;
}

/** Google's encoded polyline format. PURE. */
export function decodePolyline(encoded: string): Point[] {
  const out: Point[] = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

type Body = {
  status?: string;
  routes?: Array<{
    overview_polyline?: { points?: string };
    legs?: Array<{ distance?: { value?: number }; steps?: Array<{ polyline?: { points?: string } }> }>;
  }>;
};

/** The road for one chunk, or null when Google's answer is not usable. PURE. */
export function parseChunkRoad(body: Body, chunk: readonly Point[]): Point[] | null {
  const route = body.status === 'OK' ? body.routes?.[0] : undefined;
  if (!route) return null;
  const legs = route.legs ?? [];
  const roadM = legs.reduce((a, l) => a + Number(l.distance?.value ?? 0), 0);
  let straightM = 0;
  for (let i = 1; i < chunk.length; i++) straightM += haversineKm(chunk[i - 1], chunk[i]) * 1000;
  if (roadM > straightM * DETOUR_LIMIT + 1000) return null;
  const steps = legs.flatMap((l) => l.steps ?? []).map((s) => s.polyline?.points).filter((p): p is string => !!p);
  const road = steps.length ? steps.flatMap(decodePolyline) : decodePolyline(route.overview_polyline?.points ?? '');
  return road.length >= 2 ? road : null;
}

async function chunkRoad(apiKey: string, chunk: Point[], cache: ChunkCache): Promise<Point[] | null> {
  const key = chunkKey(chunk);
  const kept = await cache.get(key).catch(() => undefined);
  if (kept !== undefined) return kept;
  try {
    const res = await fetch(chunkUrl(chunk, apiKey), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Body;
    // A quota or key refusal can clear up; only a real answer about this chunk is kept.
    if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS' && body.status !== 'NOT_FOUND') return null;
    const road = parseChunkRoad(body, chunk);
    await cache.put(key, road).catch(() => undefined);
    return road;
  } catch {
    return null;
  }
}

/** The day's path: Google's road where it has one, straight between fixes where it does not. */
export async function roadTrack(env: { GOOGLE_MAPS_API_KEY?: string }, fixes: readonly Fix[], cache: ChunkCache): Promise<RoadTrack> {
  const points = drivenPoints(fixes);
  const chunks = chunkPoints(points);
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  const roads: Array<Point[] | null> = chunks.map(() => null);
  if (apiKey) {
    const todo = chunks.slice(0, MAX_CHUNKS);
    for (let i = 0; i < todo.length; i += PARALLEL) {
      const batch = await Promise.all(todo.slice(i, i + PARALLEL).map((c) => chunkRoad(apiKey, c, cache)));
      batch.forEach((r, j) => { roads[i + j] = r; });
    }
  }
  if (!chunks.length) return { path: points, chunks: 0, roadChunks: 0 };
  const path: Point[] = [];
  chunks.forEach((chunk, i) => {
    const part = roads[i] ?? chunk;
    path.push(...(path.length ? part.slice(1) : part));
  });
  return { path, chunks: chunks.length, roadChunks: roads.filter(Boolean).length };
}
