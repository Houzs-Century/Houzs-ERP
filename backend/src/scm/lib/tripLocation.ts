
import { scopeMatchesAssignment, type CrewAssignment, type DeliveryScope } from './deliveryScope';

export function isTripLocationPing(method: string, path: string): boolean {
  return method === 'POST' && /\/trips\/[^/]+\/location$/.test(path);
}

export function pingCallerAllowed(
  scope: DeliveryScope,
  assignment: CrewAssignment,
  bypassed: boolean,
): boolean {
  if (bypassed) return scope.mode === 'self' && scopeMatchesAssignment(scope, assignment);
  return scopeMatchesAssignment(scope, assignment);
}

export type ValidPing = {
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: string;
};

export type PingValidation =
  | { ok: true; ping: ValidPing }
  | { ok: false; error: string };

export const PING_ACCEPTED_STATUSES = new Set(['IN_PROGRESS']);

export const MIN_PING_GAP_MS = 10_000;

export function validatePing(
  body: unknown,
  opts: { now?: number; maxFutureSkewMs?: number } = {},
): PingValidation {
  const now = opts.now ?? Date.now();
  const maxFutureSkewMs = opts.maxFutureSkewMs ?? 5 * 60_000;

  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;

  const lat = Number(b.lat);
  const lng = Number(b.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: 'lat out of range' };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: 'lng out of range' };

  let accuracyM: number | null = null;
  if (b.accuracy !== undefined && b.accuracy !== null && b.accuracy !== '') {
    const a = Number(b.accuracy);
    if (!Number.isFinite(a) || a < 0) return { ok: false, error: 'accuracy out of range' };
    accuracyM = a;
  }

  let recordedMs: number;
  if (b.recorded_at === undefined || b.recorded_at === null || b.recorded_at === '') {
    recordedMs = now;
  } else if (typeof b.recorded_at === 'number' && Number.isFinite(b.recorded_at)) {
    recordedMs = b.recorded_at;
  } else {
    const parsed = Date.parse(String(b.recorded_at));
    if (!Number.isFinite(parsed)) return { ok: false, error: 'recorded_at is not a valid timestamp' };
    recordedMs = parsed;
  }
  if (recordedMs > now + maxFutureSkewMs) return { ok: false, error: 'recorded_at is too far in the future' };

  return {
    ok: true,
    ping: { lat, lng, accuracyM, recordedAt: new Date(recordedMs).toISOString() },
  };
}

export function shouldAcceptPing(
  lastRecordedAtMs: number | null,
  incomingRecordedAtMs: number,
  minGapMs: number = MIN_PING_GAP_MS,
): boolean {
  if (lastRecordedAtMs == null || !Number.isFinite(lastRecordedAtMs)) return true;
  return incomingRecordedAtMs - lastRecordedAtMs >= minGapMs;
}

export type LatestLocation = {
  tripId: string;
  driverId: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: string;
  receivedAt: string;
};

type RawLocationRow = Record<string, unknown>;

function dual(row: RawLocationRow, snake: string): unknown {
  const camel = snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return row[camel] ?? row[snake];
}

export function latestPerDriver(rows: RawLocationRow[]): LatestLocation[] {
  const seen = new Set<string>();
  const out: LatestLocation[] = [];
  for (const r of rows) {
    const tripId = dual(r, 'trip_id');
    const driverId = dual(r, 'driver_id');
    const rawLat = dual(r, 'lat');
    const rawLng = dual(r, 'lng');
    if (typeof tripId !== 'string' || tripId === '') continue;
    if (rawLat == null || rawLat === '' || rawLng == null || rawLng === '') continue;
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = `${tripId}::${driverId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const acc = dual(r, 'accuracy_m');
    out.push({
      tripId,
      driverId: typeof driverId === 'string' && driverId !== '' ? driverId : null,
      lat,
      lng,
      accuracyM: acc == null || acc === '' ? null : Number(acc),
      recordedAt: String(dual(r, 'recorded_at') ?? ''),
      receivedAt: String(dual(r, 'received_at') ?? ''),
    });
  }
  return out;
}
