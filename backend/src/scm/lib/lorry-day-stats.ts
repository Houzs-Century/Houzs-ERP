/* Each lorry's day, Google against what really happened (owner 2026-11-08). The
   terms are fixed (docs/modules/delivery-tms.md):
     Google km / Google time  the kept run (scm.lorry_day_routes): home, stops in order, home.
     GPS km                   km from the lorry's Velocity fixes that day (scm.lorry_positions);
                              null when the lorry sent none, never 0.
     Drive time               per stop, the crew's "arrived" minus the later of "on the way"
                              and the stop before's "completed".
     On-site time             per stop, "arrived" to "completed".
   The time comparison is like for like: only stops that have a Drive time, against
   Google's legs into those same stops (the drive home has no tap, so it is left out).
   The stops are the run's own (lorry_day_routes.legs), so every page agrees on which
   orders a lorry carried.

   company-scope: the shared fleet's runs, read whole like lorry-day-runs.ts. */
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { chunkIn, paginateAll } from './paginate-all';
import { kmFromFixes, myDayWindow, type Fix } from './lorry-km';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised scm client, same alias as geocode.ts
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

/* ── Pure ───────────────────────────────────────────────────────────────── */

export type Leg = { ref: string | null; distanceM: number; durationS: number };
export type Stamps = { departedAt: string | null; arrivedAt: string | null; deliveredAt: string | null };
export type StopStat = { ref: string; driveS: number | null; onSiteS: number | null; googleS: number | null };

const secondsBetween = (from: string | null, to: string | null): number | null => {
  if (!from || !to) return null;
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return Number.isFinite(s) && s >= 0 ? s : null;
};

/** Each finished stop of one run: Drive time, On-site time and Google's leg into it.
 *  Same rule as the Last Mile card (fleet-day/vm.ts stopTimes), in arrival order. PURE. */
export function stopStats(legs: readonly Leg[], stampsOf: (ref: string) => Stamps | null): StopStat[] {
  const googleOf = new Map(legs.filter((l) => l.ref).map((l) => [l.ref!, l.durationS]));
  const done = [...googleOf.keys()]
    .map((ref) => ({ ref, s: stampsOf(ref) }))
    .filter((x): x is { ref: string; s: Stamps } => !!x.s?.deliveredAt)
    .sort((a, b) => (a.s.arrivedAt ?? a.s.deliveredAt ?? '').localeCompare(b.s.arrivedAt ?? b.s.deliveredAt ?? ''));
  const out: StopStat[] = [];
  let prevDone: string | null = null;
  for (const { ref, s } of done) {
    const start = prevDone && (!s.departedAt || prevDone > s.departedAt) ? prevDone : s.departedAt;
    out.push({ ref, driveS: secondsBetween(start, s.arrivedAt), onSiteS: secondsBetween(s.arrivedAt, s.deliveredAt), googleS: googleOf.get(ref) ?? null });
    prevDone = s.deliveredAt;
  }
  return out;
}

export type DayStat = {
  date: string; lorryId: string;
  googleM: number; googleS: number; gpsKm: number | null;
  stops: number; timedStops: number;
  /** Sum of Drive time over the timed stops, and Google's legs into the same stops. */
  driveS: number; googleTimedS: number;
  onSiteS: number; onSiteStops: number;
};

/** One lorry-day's figures from its run and its stops. PURE. */
export function dayStat(
  run: { date: string; lorryId: string; distanceM: number; durationS: number; legs: readonly Leg[] | null },
  stats: readonly StopStat[],
  gpsKm: number | null,
): DayStat {
  const timed = stats.filter((s) => s.driveS != null && s.googleS != null);
  const onSite = stats.filter((s) => s.onSiteS != null);
  return {
    date: run.date, lorryId: run.lorryId,
    googleM: run.distanceM, googleS: run.durationS, gpsKm,
    stops: (run.legs ?? []).filter((l) => l.ref).length,
    timedStops: timed.length,
    driveS: timed.reduce((a, s) => a + s.driveS!, 0),
    googleTimedS: timed.reduce((a, s) => a + s.googleS!, 0),
    onSiteS: onSite.reduce((a, s) => a + s.onSiteS!, 0),
    onSiteStops: onSite.length,
  };
}

export type OnSiteRow = { buildingType: string; lorryId: string; stops: number; onSiteS: number };

/** On-site time per building type and lorry. An order with no building type is
 *  "Not set", so the gap shows instead of vanishing. PURE. */
export function onSiteByBuilding(rows: ReadonlyArray<{ lorryId: string; buildingType: string | null; onSiteS: number | null }>): OnSiteRow[] {
  const acc = new Map<string, OnSiteRow>();
  for (const r of rows) {
    if (r.onSiteS == null) continue;
    const bt = r.buildingType?.trim() || 'Not set';
    const k = `${bt}\u0000${r.lorryId}`;
    const a = acc.get(k) ?? { buildingType: bt, lorryId: r.lorryId, stops: 0, onSiteS: 0 };
    a.stops += 1; a.onSiteS += r.onSiteS;
    acc.set(k, a);
  }
  return [...acc.values()].sort((a, b) => a.buildingType.localeCompare(b.buildingType) || a.lorryId.localeCompare(b.lorryId));
}

/* ── Load ───────────────────────────────────────────────────────────────── */

async function need<T>(what: string, p: Promise<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data ?? [];
}

const myDate = (iso: string): string => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);

export async function loadDayStats(sb: SupabaseClient, from: string, to: string): Promise<{ days: DayStat[]; onSite: OnSiteRow[] }> {
  const runs = await need('runs', paginateAll<{ lorry_id: string; route_date: string; distance_m: number; duration_s: number; legs: Leg[] | null }>((lo, hi) =>
    sb.from('lorry_day_routes').select('lorry_id, route_date, distance_m, duration_s, legs')
      .gte('route_date', from).lte('route_date', to).order('route_date').order('lorry_id').range(lo, hi)));
  const refs = [...new Set(runs.flatMap((r) => (r.legs ?? []).map((l) => l.ref).filter((x): x is string => !!x)))];

  /* The crew's taps live on the SO's DO; the newest DO that is not cancelled wins. */
  const dos = await need('dos', chunkIn<{ id: string; so_doc_no: string; status: string | null; departure_at: string | null; arrival_at: string | null; delivered_at: string | null }>(refs, (b, lo, hi) =>
    sb.from('delivery_orders').select('id, so_doc_no, status, departure_at, arrival_at, delivered_at').in('so_doc_no', b).order('id').range(lo, hi)));
  const stamps = new Map<string, Stamps>();
  for (const d of dos) {
    const st = (d.status ?? '').toUpperCase();
    if (st === 'DRAFT' || st === 'CANCELLED') continue;
    if (!d.departure_at && !d.arrival_at && !d.delivered_at && stamps.has(d.so_doc_no)) continue;
    stamps.set(d.so_doc_no, { departedAt: d.departure_at, arrivedAt: d.arrival_at, deliveredAt: d.delivered_at });
  }
  const sos = await need('sos', chunkIn<{ doc_no: string; building_type: string | null }>(refs, (b, lo, hi) =>
    sb.from('mfg_sales_orders').select('doc_no, building_type').in('doc_no', b).order('doc_no').range(lo, hi)));
  const buildingOf = new Map<string, string | null>();
  for (const s of sos) if (!buildingOf.get(s.doc_no)) buildingOf.set(s.doc_no, s.building_type);

  /* GPS km per lorry and Malaysia day; a lorry-day with no fix stays null. */
  const winFrom = myDayWindow(from)?.from;
  const winTo = myDayWindow(to)?.to;
  const fixesBy = new Map<string, Fix[]>();
  if (winFrom && winTo) {
    const fixes = await need('fixes', paginateAll<Fix & { lorry_id: string }>((lo, hi) =>
      sb.from('lorry_positions').select('lorry_id, lat, lng, recorded_at')
        .gte('recorded_at', winFrom).lt('recorded_at', winTo).order('recorded_at').order('id').range(lo, hi)));
    for (const f of fixes) {
      const k = `${f.lorry_id}|${myDate(f.recorded_at)}`;
      (fixesBy.get(k) ?? fixesBy.set(k, []).get(k)!).push(f);
    }
  }

  const days: DayStat[] = [];
  const onSiteRows: Array<{ lorryId: string; buildingType: string | null; onSiteS: number | null }> = [];
  for (const r of runs) {
    const date = String(r.route_date).slice(0, 10);
    const legs = r.legs ?? [];
    const stats = stopStats(legs, (ref) => stamps.get(ref) ?? null);
    const fx = fixesBy.get(`${r.lorry_id}|${date}`);
    days.push(dayStat({ date, lorryId: r.lorry_id, distanceM: Number(r.distance_m), durationS: Number(r.duration_s), legs }, stats, fx?.length ? kmFromFixes(fx) : null));
    for (const s of stats) onSiteRows.push({ lorryId: r.lorry_id, buildingType: buildingOf.get(s.ref) ?? null, onSiteS: s.onSiteS });
  }
  return { days, onSite: onSiteByBuilding(onSiteRows) };
}
