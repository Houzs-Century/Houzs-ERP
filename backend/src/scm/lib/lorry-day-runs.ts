/* Each lorry's run on a day, worked out ONCE on the server (owner 2026-11-08: "看那个地方
   算好了 api 数据去各大地方而已"). Last Mile, Fleet Health, Lorry Capacity and the lorry
   record all read the figures this keeps in scm.lorry_day_routes; none works them out.

   A lorry's stops for a day are the sales orders it carries that day:
     - an SO with a DO stop on a live (not cancelled) trip dated that day, on that trip's lorry;
     - an SO due that day (amended date, else the customer's date) whose latest DO has a
       lorry on its crew but which sits on no live trip yet (assigned on the DP board).
   East Malaysia and Singapore orders are left out, as on the Last Mile board.
   Order: the delivery window's start time, then the trip's stop number, then the SO
   number (the Last Mile card order). The lorry leaves from and comes back to its home
   warehouse; with none set, the trip's warehouse; else the warehouse most of its orders
   ship from. An address that cannot be located is listed, not guessed.

   company-scope: the lorry fleet is one shared master across companies and a lorry's
   day is one physical run, so the run is read across companies and kept under the
   company most of its orders belong to. */
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { chunkIn } from './paginate-all';
import { composeAddress, geocodeAddressCached, normalizeAddress } from './geocode';
import { loadLorryDepots } from './lorry-depots';
import { normalizePlate } from './plate-normalize';
import { MAX_STOPS, roadRoute, stopKey, type Point, type RoadLeg } from './road-route';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised scm client, same alias as geocode.ts
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

/* ── Pure ───────────────────────────────────────────────────────────────── */

function clockMinutes(token: string, apHint: 'am' | 'pm' | null): number | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(token.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3] || apHint;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes after midnight a delivery window starts, for ordering a run: the first clock
 *  time anywhere in the free text ("TIME AROUND 9AM TO 11AM" -> 540); a bare AM sorts at
 *  0 and PM at noon; no readable time sorts last. Pinned to the Last Mile card order
 *  (frontend slotSortKey) by tests/lorryDayRuns.test.ts. PURE. */
export function windowStartMinutes(timeRange: string | null | undefined): number {
  const t = (timeRange ?? '').trim().toLowerCase();
  if (!t) return Number.MAX_SAFE_INTEGER;
  const hint = (/(am|pm)/.exec(t)?.[1] as 'am' | 'pm' | undefined) ?? null;
  const tok = /\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?/.exec(t);
  const start = tok ? clockMinutes(tok[0], hint) : null;
  if (start != null) return start;
  if (t === 'am') return 0;
  if (t === 'pm') return 12 * 60;
  const parts = t.split(/\s*(?:-|–|—|to)\s*/).filter(Boolean);
  const s = parts.length > 0 ? clockMinutes(parts[0]!, hint) : null;
  const e = parts.length > 1 ? clockMinutes(parts[parts.length - 1]!, hint) : null;
  if (e != null && e <= 12 * 60 && (s == null || s < e)) return 0;
  if (s != null && s >= 12 * 60) return 12 * 60;
  return Number.MAX_SAFE_INTEGER;
}

/** Sabah, Sarawak, Labuan and Singapore orders do not ride a peninsula lorry. PURE. */
export function offPeninsula(state: string | null, country: string | null): boolean {
  if (/singapore/i.test(country ?? '')) return true;
  return /sabah|sarawak|labuan/i.test(state ?? '');
}

export type RunStopIn = {
  ref: string;
  plate: string;
  lorryId: string | null;
  companyId: number;
  timeRange: string | null;
  stopNo: number | null;
  tripWarehouseId: string | null;
  orderWarehouseId: string | null;
  point: Point | null;
};

export type DayRun = {
  plateKey: string;
  plate: string;
  lorryId: string | null;
  companyId: number;
  homeWarehouseId: string | null;
  stops: Array<{ ref: string; lat: number; lng: number }>;
  unlocated: string[];
};

/** The day's stops grouped per lorry, in run order, with the warehouse it starts from. PURE. */
export function buildDayRuns(rows: readonly RunStopIn[], homeWarehouseOf: (plateKey: string) => string | null): DayRun[] {
  const byPlate = new Map<string, RunStopIn[]>();
  for (const r of rows) {
    const k = normalizePlate(r.plate);
    if (!k) continue;
    (byPlate.get(k) ?? byPlate.set(k, []).get(k)!).push(r);
  }
  const majority = (vals: Array<string | number | null>): string | null => {
    const n = new Map<string, number>();
    for (const v of vals) if (v != null) n.set(String(v), (n.get(String(v)) ?? 0) + 1);
    let best: string | null = null;
    for (const [v, c] of n) if (best == null || c > n.get(best)!) best = v;
    return best;
  };
  const runs: DayRun[] = [];
  for (const [plateKey, list] of byPlate) {
    const sorted = [...list].sort((a, b) =>
      windowStartMinutes(a.timeRange) - windowStartMinutes(b.timeRange)
      || (a.stopNo ?? Number.MAX_SAFE_INTEGER) - (b.stopNo ?? Number.MAX_SAFE_INTEGER)
      || a.ref.localeCompare(b.ref));
    const seen = new Set<string>();
    const stops: DayRun['stops'] = [];
    const unlocated: string[] = [];
    for (const s of sorted) {
      if (seen.has(s.ref)) continue;
      seen.add(s.ref);
      if (s.point) stops.push({ ref: s.ref, lat: s.point.lat, lng: s.point.lng });
      else unlocated.push(s.ref);
    }
    runs.push({
      plateKey,
      plate: list[0]!.plate,
      lorryId: list.find((s) => s.lorryId)?.lorryId ?? null,
      companyId: Number(majority(list.map((s) => s.companyId))),
      homeWarehouseId: homeWarehouseOf(plateKey) ?? majority(list.map((s) => s.tripWarehouseId)) ?? majority(list.map((s) => s.orderWarehouseId)),
      stops,
      unlocated,
    });
  }
  return runs.sort((a, b) => a.plateKey.localeCompare(b.plateKey));
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

/** A failed read stops the work; a guess would be a wrong figure kept as right. */
async function need<T>(what: string, p: Promise<{ data: T[]; error: { message: string } | null }>): Promise<T[]> {
  const r = await p;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}

type Env = { GOOGLE_MAPS_API_KEY?: string };
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** The day's runs, read across companies (see the header). Throws on a failed read. */
export async function loadDayRuns(sb: SupabaseClient, env: Env, date: string): Promise<{ runs: DayRun[]; homes: Map<string, Point>; warehousePoints: Map<string, Point> }> {
  const fail = (what: string, e: { message: string } | null) => { if (e) throw new Error(`${what}: ${e.message}`); };

  // 1. The lorries (shared master) and live trips dated the day.
  const { data: lorryRows, error: lErr } = await sb.from('lorries').select('id, plate');
  fail('lorries', lErr);
  const plateById = new Map(((lorryRows ?? []) as Array<{ id: string; plate: string }>).map((l) => [String(l.id), String(l.plate)]));
  const idByPlate = new Map([...plateById].map(([id, p]) => [normalizePlate(p), id]));
  const { data: tripRows, error: tErr } = await sb.from('trips').select('id, company_id, lorry_id, warehouse_id, status').eq('trip_date', date).neq('status', 'CANCELLED');
  fail('trips', tErr);
  const tripById = new Map(((tripRows ?? []) as Array<Record<string, unknown>>).map((t) => [String(t.id), t]));
  const stopRows = await need('stopRows', chunkIn<{ trip_id: string; do_id: string | null; stop_no: number | null }>([...tripById.keys()], (b, from, to) =>
      sb.from('trip_stops').select('trip_id, do_id, stop_no').in('trip_id', b).order('trip_id').range(from, to)));

  // 2. SOs on those trips (through their DOs), and SOs due the day.
  const tripDoIds = [...new Set(stopRows.map((s) => s.do_id).filter((x): x is string => !!x))];
  const tripDos = await need('tripDos', chunkIn<{ id: string; so_doc_no: string | null }>(tripDoIds, (b, from, to) => sb.from('delivery_orders').select('id, so_doc_no').in('id', b).order('id').range(from, to)));
  const docByDo = new Map(tripDos.map((d) => [d.id, d.so_doc_no ?? '']));
  const { data: dueRows, error: dErr } = await sb.from('mfg_sales_orders').select('doc_no')
    .neq('status', 'DRAFT').neq('status', 'CANCELLED')
    .or(`amended_delivery_date.eq.${date},and(amended_delivery_date.is.null,customer_delivery_date.eq.${date})`);
  fail('sales orders due', dErr);
  const docNos = [...new Set([...docByDo.values(), ...((dueRows ?? []) as Array<{ doc_no: string }>).map((r) => String(r.doc_no))].filter(Boolean))];
  if (docNos.length === 0) return { runs: [], homes: new Map(), warehousePoints: new Map() };

  const soRows = await need('soRows', chunkIn<Record<string, unknown>>(docNos, (b, from, to) =>
    sb.from('mfg_sales_orders').select('doc_no, company_id, status, address1, address2, postcode, customer_state, customer_country').in('doc_no', b).order('doc_no').range(from, to)));
  const soByDoc = new Map(soRows.filter((r) => !['DRAFT', 'CANCELLED'].includes(String(r.status))).map((r) => [String(r.doc_no), r]));
  const allDos = await need('allDos', chunkIn<{ id: string; so_doc_no: string; time_range: string | null }>(docNos, (b, from, to) =>
    sb.from('delivery_orders').select('id, so_doc_no, time_range').in('so_doc_no', b).order('id').range(from, to)));
  const latestDo = new Map<string, { id: string; time_range: string | null }>();
  for (const d of allDos) latestDo.set(d.so_doc_no, d); // ordered by id: the last one wins, the board's rule
  const latestIds = [...new Set([...latestDo.values()].map((d) => d.id))];
  const crewRows = await need('crewRows', chunkIn<{ do_id: string; lorry_plate: string | null }>(latestIds, (b, from, to) => sb.from('delivery_order_crew').select('do_id, lorry_plate').in('do_id', b).order('do_id').range(from, to)));
  const crewPlate = new Map(crewRows.map((c) => [c.do_id, c.lorry_plate]));
  // An SO on ANY live trip is not "assigned, no trip", whatever the trip's date.
  const allDoIds = allDos.map((d) => d.id);
  const anyStops = await need('anyStops', chunkIn<{ do_id: string; trip_id: string }>(allDoIds, (b, from, to) => sb.from('trip_stops').select('do_id, trip_id').in('do_id', b).order('do_id').range(from, to)));
  const anyTripIds = [...new Set(anyStops.map((s) => s.trip_id))];
  const anyTrips = await need('anyTrips', chunkIn<{ id: string; status: string | null }>(anyTripIds, (b, from, to) => sb.from('trips').select('id, status').in('id', b).order('id').range(from, to)));
  const liveTrip = new Set(anyTrips.filter((t) => String(t.status ?? '').toUpperCase() !== 'CANCELLED').map((t) => t.id));
  const doSo = new Map(allDos.map((d) => [d.id, d.so_doc_no]));
  const onLiveTrip = new Set(anyStops.filter((s) => liveTrip.has(s.trip_id)).map((s) => doSo.get(s.do_id)).filter((x): x is string => !!x));

  // 3. Where each order ships from (its first line's warehouse) and where it goes.
  const itemRows = await need('itemRows', chunkIn<{ doc_no: string; warehouse_id: string | null }>(docNos, (b, from, to) =>
    sb.from('mfg_sales_order_items').select('doc_no, warehouse_id').in('doc_no', b).order('doc_no').range(from, to)));
  const whByDoc = new Map<string, string>();
  for (const it of itemRows) if (it.warehouse_id && !whByDoc.has(it.doc_no)) whByDoc.set(it.doc_no, it.warehouse_id);
  const addrByDoc = new Map<string, string>();
  for (const [dn, r] of soByDoc) {
    const a = composeAddress({ address1: str(r.address1), address2: str(r.address2), postcode: str(r.postcode), state: str(r.customer_state), country: str(r.customer_country) });
    if (a) addrByDoc.set(dn, a);
  }
  const pointByDoc = await locate(sb, env, addrByDoc);

  // 4. The stop rows: trip stops first, then assigned orders not on any live trip.
  const rows: RunStopIn[] = [];
  const push = (dn: string, plate: string, lorryId: string | null, companyId: number, stopNo: number | null, tripWh: string | null) => {
    const so = soByDoc.get(dn);
    if (!so || offPeninsula(str(so.customer_state), str(so.customer_country))) return;
    rows.push({ ref: dn, plate, lorryId, companyId, timeRange: latestDo.get(dn)?.time_range ?? null, stopNo, tripWarehouseId: tripWh, orderWarehouseId: whByDoc.get(dn) ?? null, point: pointByDoc.get(dn) ?? null });
  };
  for (const s of stopRows) {
    const t = tripById.get(s.trip_id);
    const dn = s.do_id ? docByDo.get(s.do_id) : undefined;
    const plate = t ? plateById.get(String(t.lorry_id)) : undefined;
    if (!t || !dn || !plate) continue;
    push(dn, plate, String(t.lorry_id), Number(t.company_id), s.stop_no, str(t.warehouse_id));
  }
  for (const r of (dueRows ?? []) as Array<{ doc_no: string }>) {
    const dn = String(r.doc_no);
    if (onLiveTrip.has(dn)) continue;
    const d = latestDo.get(dn);
    const plate = d ? crewPlate.get(d.id) : null;
    if (!plate) continue;
    push(dn, plate, idByPlate.get(normalizePlate(plate)) ?? null, Number(soByDoc.get(dn)?.company_id ?? 0), null, null);
  }

  // 5. Homes: the lorry's own warehouse first (lorry-depots.ts), else the run's warehouse.
  const { lorryDepots } = await loadLorryDepots(sb, env);
  const runs = buildDayRuns(rows, (k) => (k in lorryDepots ? lorryDepots[k]!.warehouseId : null));
  const homes = new Map(Object.entries(lorryDepots).map(([k, d]) => [k, { lat: d.lat, lng: d.lng }]));
  const whIds = [...new Set(runs.map((r) => r.homeWarehouseId).filter((x): x is string => !!x && !Object.values(lorryDepots).some((d) => d.warehouseId === x)))];
  const warehousePoints = new Map<string, Point>(Object.values(lorryDepots).map((d) => [d.warehouseId, { lat: d.lat, lng: d.lng }]));
  if (whIds.length) {
    const { data: whRows, error: wErr } = await sb.from('warehouses').select('id, location, city, state, postcode, latitude, longitude').in('id', whIds);
    fail('warehouses', wErr);
    for (const w of (whRows ?? []) as Array<Record<string, unknown>>) {
      const pinned = w.latitude != null && w.longitude != null ? { lat: Number(w.latitude), lng: Number(w.longitude) } : null;
      const addr = composeAddress({ address1: str(w.location), address2: str(w.city), postcode: str(w.postcode), state: str(w.state) });
      const hit = pinned ?? (addr ? await geocodeAddressCached(sb, env, addr) : null);
      if (hit) warehousePoints.set(String(w.id), { lat: hit.lat, lng: hit.lng });
    }
  }
  return { runs, homes, warehousePoints };
}

/** Cache first in one read, then Google for each miss (once ever, geocode.ts keeps it). */
async function locate(sb: SupabaseClient, env: Env, addrByDoc: Map<string, string>): Promise<Map<string, Point>> {
  const keys = [...new Set([...addrByDoc.values()].map(normalizeAddress).filter(Boolean))];
  const cached = new Map<string, Point>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await sb.from('geocode_cache').select('normalized_address, lat, lng').in('normalized_address', keys.slice(i, i + 200));
    if (error) throw new Error(`geocode cache: ${error.message}`);
    for (const h of data as Array<Record<string, unknown>>) {
      const lat = Number(h.lat); const lng = Number(h.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) cached.set(String(h.normalized_address), { lat, lng });
    }
  }
  const out = new Map<string, Point>();
  for (const [dn, addr] of addrByDoc) {
    const key = normalizeAddress(addr);
    let hit = cached.get(key) ?? null;
    if (!hit && env.GOOGLE_MAPS_API_KEY) {
      const g = await geocodeAddressCached(sb, env, addr);
      hit = g ? { lat: g.lat, lng: g.lng } : null;
      if (hit) cached.set(key, hit);
    }
    if (hit) out.set(dn, hit);
  }
  return out;
}

/* ── Work out and keep ──────────────────────────────────────────────────── */

export type StopLeg = { ref: string | null; distanceM: number; durationS: number };

/** Each stop's drive from the one before (the first from home), keyed by the stop's
 *  order; the last entry (ref null) is the drive home. Null when Google's legs do not
 *  line up with the stops, so a mismatch never pins a figure on the wrong order. PURE. */
export function stopLegs(stops: ReadonlyArray<{ ref: string }>, legs: readonly RoadLeg[]): StopLeg[] | null {
  if (legs.length !== stops.length + 1) return null;
  return legs.map((l, i) => ({ ref: stops[i]?.ref ?? null, distanceM: l.distanceM, durationS: l.durationS }));
}

export type DayRouteOutcome = { plate: string; lorryId: string | null; stops: number; unlocated: string[]; result: 'kept' | 'worked-out' | 'skipped'; reason: string | null };

/** Work out every lorry's run for the day and keep it; Google is asked only when a run
 *  changed (stop_key). A lorry that no longer runs that day loses its kept figure. */
export async function computeDayRoutes(sb: SupabaseClient, env: Env, date: string): Promise<DayRouteOutcome[]> {
  const { runs, homes, warehousePoints } = await loadDayRuns(sb, env, date);
  const { data: keptRows, error: kErr } = await sb.from('lorry_day_routes').select('id, company_id, lorry_id, stop_key, legs').eq('route_date', date);
  if (kErr) throw new Error(`kept routes: ${kErr.message}`);
  const kept = keptRows as Array<{ id: string; company_id: number; lorry_id: string; stop_key: string; legs: unknown }>;
  const outcomes: DayRouteOutcome[] = [];
  const keep = new Set<string>();
  for (const run of runs) {
    const base = { plate: run.plate, lorryId: run.lorryId, stops: run.stops.length, unlocated: run.unlocated };
    const home = homes.get(run.plateKey) ?? (run.homeWarehouseId ? warehousePoints.get(run.homeWarehouseId) : undefined) ?? null;
    if (!run.lorryId) { outcomes.push({ ...base, result: 'skipped', reason: 'plate is not in the lorry list' }); continue; }
    if (run.stops.length === 0) { outcomes.push({ ...base, result: 'skipped', reason: 'no stop could be located' }); continue; }
    if (!home) { outcomes.push({ ...base, result: 'skipped', reason: 'no warehouse to start from' }); continue; }
    if (run.stops.length > MAX_STOPS) { outcomes.push({ ...base, result: 'skipped', reason: `more than ${MAX_STOPS} located stops` }); continue; }
    const key = stopKey(home, run.stops);
    const prev = kept.find((k) => k.lorry_id === run.lorryId && Number(k.company_id) === run.companyId);
    // A figure kept before the per-stop legs were stored is worked out once more.
    if (prev && prev.stop_key === key && prev.legs != null) { keep.add(prev.id); outcomes.push({ ...base, result: 'kept', reason: null }); continue; }
    const road = await roadRoute(env, home, run.stops);
    if (!road.ok) {
      if (prev) keep.add(prev.id); // a Google failure keeps yesterday's answer rather than none
      outcomes.push({ ...base, result: 'skipped', reason: road.reason });
      continue;
    }
    const { data: saved, error: sErr } = await sb.from('lorry_day_routes').upsert({
      company_id: run.companyId, lorry_id: run.lorryId, route_date: date, stop_key: key, stop_count: run.stops.length,
      distance_m: road.distanceM, duration_s: road.durationS, polyline: road.polyline, legs: stopLegs(run.stops, road.legs), computed_at: new Date().toISOString(),
    }, { onConflict: 'company_id,lorry_id,route_date' }).select('id').single();
    if (sErr) throw new Error(`save ${run.plate}: ${sErr.message}`);
    keep.add(String((saved as { id: string }).id));
    outcomes.push({ ...base, result: 'worked-out', reason: null });
  }
  const stale = kept.filter((k) => !keep.has(k.id)).map((k) => k.id);
  if (stale.length) {
    const { error } = await sb.from('lorry_day_routes').delete().in('id', stale);
    if (error) throw new Error(`clear stale routes: ${error.message}`);
  }
  return outcomes;
}
