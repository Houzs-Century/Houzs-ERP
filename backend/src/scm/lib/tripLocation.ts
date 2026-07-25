// ----------------------------------------------------------------------------
// tripLocation.ts — the PURE parts of TMS Phase 4 live GPS tracking, factored
// out of the trips router so they can be unit-tested without a DB or a network:
//   1. validatePing        — range-check a driver's {lat,lng,accuracy,recorded_at}
//   2. shouldAcceptPing    — the server-side rate cap (ignore pings too close together)
//   3. latestPerDriver     — collapse a ping log slice to the newest row per driver/trip
//
// The endpoints in trips.ts do the IO (auth, trip-status gate, insert, select);
// everything a test would want to pin lives here.
// ----------------------------------------------------------------------------

/* A validated ping, in the column shape the insert uses. */
export type ValidPing = {
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: string; // ISO 8601 (device clock)
};

export type PingValidation =
  | { ok: true; ping: ValidPing }
  | { ok: false; error: string };

/* Trip statuses that accept location pings. A ping is a "the lorry is moving
   now" signal, so only an IN_PROGRESS trip is live. Everything else (PLANNED /
   COMPLETED / CANCELLED) is rejected cleanly — never 500. */
export const PING_ACCEPTED_STATUSES = new Set(['IN_PROGRESS']);

/* Minimum gap between two accepted pings for the same trip+driver. The phone is
   asked to report every ~20-30s, but a flaky watchPosition can fire far faster;
   the server caps the write rate so a misbehaving client cannot flood the log.
   10s is well under the client cadence, so a well-behaved client never trips it. */
export const MIN_PING_GAP_MS = 10_000;

/* Range-validate one raw ping body. Rejects out-of-range coordinates, a missing
   or unparseable device timestamp, and a device clock too far in the FUTURE
   (clock skew is fine for the past — an old fix is just stale — but a
   far-future recorded_at would sort ahead of every real ping and pin a ghost
   marker at the top of the trail). Never throws. */
export function validatePing(
  body: unknown,
  opts: { now?: number; maxFutureSkewMs?: number } = {},
): PingValidation {
  const now = opts.now ?? Date.now();
  const maxFutureSkewMs = opts.maxFutureSkewMs ?? 5 * 60_000; // 5 min

  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;

  const lat = Number(b.lat);
  const lng = Number(b.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: 'lat out of range' };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: 'lng out of range' };

  // accuracy is optional; when present it must be a non-negative finite number.
  let accuracyM: number | null = null;
  if (b.accuracy !== undefined && b.accuracy !== null && b.accuracy !== '') {
    const a = Number(b.accuracy);
    if (!Number.isFinite(a) || a < 0) return { ok: false, error: 'accuracy out of range' };
    accuracyM = a;
  }

  // recorded_at (device clock). Accept a millisecond epoch or an ISO string;
  // default to now() when omitted (the ping arrived, the server time is honest).
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

/* The rate cap. Given the newest already-stored ping time for this trip+driver
   (null = none yet) and the incoming ping's recorded_at, decide whether to keep
   it. Uses the DEVICE clock on both sides so the gap reflects the driver's real
   movement cadence, not server round-trip jitter. A non-finite / missing prior
   time accepts (first ping). */
export function shouldAcceptPing(
  lastRecordedAtMs: number | null,
  incomingRecordedAtMs: number,
  minGapMs: number = MIN_PING_GAP_MS,
): boolean {
  if (lastRecordedAtMs == null || !Number.isFinite(lastRecordedAtMs)) return true;
  return incomingRecordedAtMs - lastRecordedAtMs >= minGapMs;
}

/* One driver's / trip's latest position, as the dispatcher map consumes it. */
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

/* Dual-read a camelCased OR snake_cased column off a query result (the pg driver
   camelCases result columns; the snake key alone returns undefined). */
function dual(row: RawLocationRow, snake: string): unknown {
  const camel = snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return row[camel] ?? row[snake];
}

/* Collapse an append-only ping-log slice to the NEWEST row per (trip, driver).
   The board-level read pulls a recent window ordered by recorded_at DESC and
   feeds it here; the first row seen for a key wins (input must be newest-first).
   Keyed on trip_id + driver_id so a trip crewed by two phones shows both, and a
   driver on two trips shows once per trip. A row with no coordinates is skipped
   rather than emitted as a (0,0) marker off the coast of Africa. */
export function latestPerDriver(rows: RawLocationRow[]): LatestLocation[] {
  const seen = new Set<string>();
  const out: LatestLocation[] = [];
  for (const r of rows) {
    const tripId = dual(r, 'trip_id');
    const driverId = dual(r, 'driver_id');
    const rawLat = dual(r, 'lat');
    const rawLng = dual(r, 'lng');
    if (typeof tripId !== 'string' || tripId === '') continue;
    // Guard null/undefined/'' BEFORE Number(): Number(null) === 0 is finite and
    // would fabricate a (0,0) marker off the coast of Africa from an empty row.
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
