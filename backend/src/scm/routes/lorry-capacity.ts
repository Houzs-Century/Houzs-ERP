// ----------------------------------------------------------------------------
// /lorry-capacity — STAGE 5B (final) of the Delivery / TMS module.
//
// The Lorry Capacity performance dashboard. For a [from,to] range it computes,
// per lorry, the cross-table fleet metrics the owner's Houzs "Lorry Capacity"
// page shows: work/repair/available days, utilisation, trip + stop counts split
// by kind (delivery / pickup / service / setup+dismantle), and the delivery
// revenue rollups (revenue per order / per trip). A summary card row aggregates
// the fleet. Fleet filter All / In-house / Outsourced reads lorries.is_internal.
//
// CONFIRMED FORMULAS (owner-approved 2026-06-25 — implemented EXACTLY):
//   working_days   = calendar days Mon–Sat (exclude Sundays) in [from,to] incl.
//   repair_days    = Mon–Sat days down: lorry_maintenance windows and grounding breakdowns,
//                    windows, each clipped to [from,to].
//   available_days = max(0, working_days − repair_days).
//   total_trips    = non-CANCELLED trips with trip_date in [from,to].
//                    PLUS one per lorry-date with board jobs and no real trip:
//                    DO crew lorries (deliveries +1 per DO) and PMS project
//                    setup/dismantle lorries (setup_dismantle +1), lib/lorry-capacity-jobs.ts.
//   km             = GPS km from lorry_positions; running_cost = km x cost_per_km_sen.
//   work_days      = distinct trip_date count (the displayed Work Days column).
//   delivery_days  = distinct trip_date where the trip has ≥1 DELIVERY stop.
//   utilisation    = total_trips ÷ available_days  (CAN exceed 100% — multiple
//                    trips/day; Houzs's own definition. available_days=0 → null).
//   deliveries     = trip_stops DELIVERY on the lorry's in-range trips;
//                    pickups=PICKUP; services=SERVICE+INSPECTION;
//                    setup_dismantle=SETUP+DISMANTLE.
//   orders_per_trip   = deliveries ÷ total_trips.
//   delivery_revenue  = Σ trip_stops.revenue_sen where stop_type=DELIVERY (cents).
//   revenue_per_order = delivery_revenue ÷ deliveries.
//   revenue_per_trip  = delivery_revenue ÷ total_trips.
// All ÷ guard div-by-zero (→ null, rendered "—" by the client). DRAFT does not
// exist for trips; CANCELLED trips are excluded everywhere.
//
// Money: revenue_sen is BIGINT cents; the dashboard returns cents and the
// client divides by 100 for the RM display (fmtSen).
//
// Repair Days inline edit — PUT /lorry-capacity/lorries/:id/repair-days
// {from,to,days}. A single dashboard-managed lorry_maintenance window represents
// the repair days for the queried period: the route deletes any prior
// dashboard-managed window overlapping [from,to] for that lorry, then (if days>0)
// inserts ONE window [from, from+N) sized so it contains exactly `days` Mon–Sat
// days within [from,to]. Manually-added maintenance windows (a different reason)
// are never touched. Sentinel reason = 'Repair days (dashboard)'.
//
// In-house inline toggle — PATCH /lorry-capacity/lorries/:id/in-house {isInternal}.
//
// Houzs port of 2990's apps/api/src/routes/lorry-capacity.ts — same plumbing as
// the sibling SCM routes (supabaseAuth + scm-scoped c.get('supabase');
// paginateAll from ../lib/paginate-all). scm.lorries / scm.trips /
// scm.trip_stops / scm.lorry_maintenance already exist (migration 0053).
// Mounted at '/lorry-capacity'.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { activeCompanySql, activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { tripsFromJobs, plateKey, type LorryJob } from '../lib/lorry-capacity-jobs';
import { flattenProjectCrew } from '../lib/delivery-planning-board-reads';
import { downDays, loadDownWindows } from '../lib/lorry-down-days';
import { costSen } from '../lib/lorry-km';
import { kmByLorryForRange } from '../lib/lorry-km-range';
import { todayMyt } from '../lib/my-time';

export const lorryCapacity = new Hono<{ Bindings: Env; Variables: Variables }>();
lorryCapacity.use('*', supabaseAuth);

function dual<T = unknown>(row: Record<string, unknown>, snake: string): T {
  const camel = snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return (row[camel] ?? row[snake]) as T;
}

const DASHBOARD_REASON = 'Repair days (dashboard)';


function dayMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const s = String(iso).slice(0, 10);
  const t = new Date(`${s}T00:00:00Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

function isWorkingDay(ms: number): boolean {
  return new Date(ms).getUTCDay() !== 0;
}

function countWorkingDays(fromMs: number, toMs: number): number {
  if (toMs < fromMs) return 0;
  let n = 0;
  for (let d = fromMs; d <= toMs; d += DAY) if (isWorkingDay(d)) n += 1;
  return n;
}

function clippedWorkingDays(winFrom: number, winTo: number, rangeFrom: number, rangeTo: number): number {
  const lo = Math.max(winFrom, rangeFrom);
  const hi = Math.min(winTo, rangeTo);
  return countWorkingDays(lo, hi);
}

function round(n: number | null, dp = 0): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function safeDiv(num: number, den: number): number | null {
  if (!den || !Number.isFinite(den)) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

type FleetFilter = 'all' | 'internal' | 'outsourced';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Loaded<T> = { data: T; error: string | null };

async function loadDoJobs(c: Ctx, from: string, to: string): Promise<Loaded<LorryJob[]>> {
  const sb = c.get('supabase');
  const { data: dos, error: doErr } = await paginateAll<Record<string, unknown>>((lo, hi) =>
    scopeToCompany(sb.from('delivery_orders')
      .select('id, customer_delivery_date, local_total_sen')
      .gte('customer_delivery_date', from)
      .lte('customer_delivery_date', to)
      .not('status', 'in', '(DRAFT,CANCELLED)'), c)
      .order('id')
      .range(lo, hi),
  );
  if (doErr) return { data: [], error: doErr.message };
  const dateByDo = new Map((dos ?? []).map((d) => [dual<string>(d, 'id'), dual<string | null>(d, 'customer_delivery_date')]));
  const senByDo = new Map((dos ?? []).map((d) => [dual<string>(d, 'id'), Number(dual(d, 'local_total_sen') ?? 0)]));
  const { data: crew, error: crewErr } = await chunkIn([...dateByDo.keys()], (batch, lo, hi) =>
    sb.from('delivery_order_crew')
      .select('do_id, lorry_id, lorry_plate')
      .in('do_id', batch)
      .order('do_id')
      .range(lo, hi),
  );
  if (crewErr) return { data: [], error: crewErr.message };
  return {
    error: null,
    data: crew.map((cr) => ({
      lorryId: dual<string | null>(cr, 'lorry_id') ?? null,
      lorryPlate: dual<string | null>(cr, 'lorry_plate') ?? null,
      date: dateByDo.get(dual<string>(cr, 'do_id')) ?? null,
      kind: 'delivery' as const,
      revenueSen: senByDo.get(dual<string>(cr, 'do_id')) ?? 0,
    })),
  };
}

export async function loadProjectJobs(c: Ctx, from: string, to: string): Promise<Loaded<Array<LorryJob & { stage: 'Setup' | 'Dismantle'; code: string | null; name: string | null }>>> {
  const proj = await c.env.DB.prepare(
    `SELECT code, name, setup_lorry_id, setup_start_at, setup_crew, dismantle_lorry_id, dismantle_start_at, dismantle_crew
       FROM projects WHERE archived_at IS NULL
        AND (setup_start_at IS NOT NULL OR dismantle_start_at IS NOT NULL)${activeCompanySql(c)}`,
  ).all<Record<string, unknown>>();
  const data: Array<LorryJob & { stage: 'Setup' | 'Dismantle'; code: string | null; name: string | null }> = [];
  for (const p of proj.results) {
    const code = dual<string | null>(p, 'code') ?? null;
    const name = dual<string | null>(p, 'name') ?? null;
    for (const k of ['setup', 'dismantle'] as const) {
      const stage = k === 'setup' ? 'Setup' : 'Dismantle';
      const lorryId = dual<string | number | null>(p, `${k}_lorry_id`);
      const date = String(dual<string | null>(p, `${k}_start_at`) ?? '').slice(0, 10);
      if (date < from || date > to) continue;
      const { plates } = flattenProjectCrew(dual<string | null>(p, `${k}_crew`) ?? null);
      for (const plate of plates) data.push({ lorryId: null, lorryPlate: plate, date, kind: 'setupDismantle', revenueSen: 0, stage, code, name });
      if (plates.length === 0 && lorryId != null) data.push({ lorryId: String(lorryId), lorryPlate: null, date, kind: 'setupDismantle', revenueSen: 0, stage, code, name });
    }
  }
  return { data, error: null };
}

async function loadKmByLorry(c: Ctx, from: string, to: string): Promise<Loaded<Map<string, number> | null> & { incomplete: string | null }> {
  const r = await kmByLorryForRange(c.get('supabase'), from, to);
  if (!r.ok) return { data: null, error: r.error, incomplete: null };
  if (r.km === null) return { data: null, error: null, incomplete: r.incomplete };
  return { data: r.km, error: null, incomplete: null };
}

lorryCapacity.get('/', async (c) => {
  const sb = c.get('supabase');

  const thisDay = todayMyt();
  const year = Number(thisDay.slice(0, 4));
  const month0 = Number(thisDay.slice(5, 7)) - 1;
  const defFrom = isoOf(Date.UTC(year, month0, 1));
  const defTo = isoOf(Date.UTC(year, month0 + 1, 0));
  const from = (c.req.query('from') || defFrom).slice(0, 10);
  const to = (c.req.query('to') || defTo).slice(0, 10);
  const fleetParam = (c.req.query('fleet') ?? 'all').toLowerCase();
  const fleet: FleetFilter =
    fleetParam === 'internal' ? 'internal' : fleetParam === 'outsourced' ? 'outsourced' : 'all';

  const fromMs = dayMs(from);
  const toMs = dayMs(to);
  if (fromMs == null || toMs == null) return c.json({ error: 'bad_range', reason: 'from / to must be YYYY-MM-DD' }, 400);

  const workingDays = countWorkingDays(fromMs, toMs);

  let lq = sb.from('lorries')
    .select('id, plate, type, is_internal, active, cost_per_km_sen')
    .eq('active', true)
    .order('plate');
  if (fleet === 'internal') lq = lq.eq('is_internal', true);
  if (fleet === 'outsourced') lq = lq.eq('is_internal', false);
  const { data: lorryRows, error: lErr } = await lq;
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);

  type LorryAcc = {
    id: string;
    plate: string;
    type: string | null;
    isInternal: boolean;
    repairDays: number;
    tripDates: Set<string>;
    deliveryTripDates: Set<string>;
    totalTrips: number;
    deliveries: number;
    pickups: number;
    services: number;
    setupDismantle: number;
    deliveryRevenueSen: number;
    costPerKmSen: number | null;
    km: number | null;
  };
  const byLorry = new Map<string, LorryAcc>();
  for (const r of (lorryRows ?? []) as Array<Record<string, unknown>>) {
    const id = dual<string>(r, 'id');
    byLorry.set(id, {
      id,
      plate: dual<string>(r, 'plate') ?? '—',
      type: dual<string | null>(r, 'type') ?? null,
      isInternal: dual<boolean | null>(r, 'is_internal') !== false,
      repairDays: 0,
      tripDates: new Set<string>(),
      deliveryTripDates: new Set<string>(),
      totalTrips: 0,
      deliveries: 0,
      pickups: 0,
      services: 0,
      setupDismantle: 0,
      deliveryRevenueSen: 0,
      costPerKmSen: dual<number | null>(r, 'cost_per_km_sen') ?? null,
      km: 0,
    });
  }

  /* 2. Repair days — the Mon–Sat days a lorry was down: its maintenance windows
        and the breakdowns that took it off the road, clipped to [from,to]. A
        lorry in the workshop has no capacity (owner 2026-11-04). */
  {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const down = await loadDownWindows(sb, from, to, today);
    if (down.error) return c.json({ error: 'load_failed', reason: `lorry down days: ${down.error}` }, 500);
    for (const [lid, n] of downDays(down.windows, from, to)) {
      const acc = byLorry.get(lid);
      if (acc) acc.repairDays = n;
    }
  }

  type TripMeta = { lorryId: string | null; date: string };
  const tripMeta = new Map<string, TripMeta>();
  {
    const { data: trips, error: tripErr, truncated: tripsCut } = await paginateAll<Record<string, unknown>>((lo, hi) =>
      sb.from('trips')
        .select('id, lorry_id, trip_date, status')
        .gte('trip_date', from)
        .lte('trip_date', to)
        .neq('status', 'CANCELLED')
        .order('id')
        .range(lo, hi),
    );
    if (tripErr) return c.json({ error: 'load_failed', reason: `trips: ${tripErr.message}` }, 500);
    if (tripsCut) return c.json({ error: 'range_too_large', reason: 'Too many trips in this range to count in full; narrow the range.' }, 400);
    for (const t of (trips ?? [])) {
      const id = dual<string>(t, 'id');
      const lorryId = dual<string | null>(t, 'lorry_id') ?? null;
      const date = String(dual<string>(t, 'trip_date') ?? '').slice(0, 10);
      tripMeta.set(id, { lorryId, date });
      if (!lorryId) continue;
      const acc = byLorry.get(lorryId);
      if (!acc) continue;
      acc.totalTrips += 1;
      if (date) acc.tripDates.add(date);
    }
  }

  const tripIds = [...tripMeta.keys()];
  const unpricedDo = new Map<string, string[]>();
  if (tripIds.length > 0) {
    const { data: stops, error: stopErr, truncated: stopsCut } = await chunkIn(tripIds, (batch, lo, hi) =>
      sb.from('trip_stops')
        .select('trip_id, stop_type, revenue_sen, do_id, assr_case_id')
        .in('trip_id', batch)
        .order('id')
        .range(lo, hi),
    );
    if (stopErr) return c.json({ error: 'load_failed', reason: `trip stops: ${stopErr.message}` }, 500);
    if (stopsCut) return c.json({ error: 'range_too_large', reason: 'Too many trip stops in this range to count in full; narrow the range.' }, 400);
    for (const s of (stops as Array<Record<string, unknown>>)) {
      const tid = dual<string>(s, 'trip_id');
      const meta = tripMeta.get(tid);
      if (!meta || !meta.lorryId) continue;
      const acc = byLorry.get(meta.lorryId);
      if (!acc) continue;
      const kind = String(dual<string>(s, 'stop_type') ?? '').toUpperCase();
      if (kind === 'DELIVERY' && dual(s, 'assr_case_id') != null) {
        acc.services += 1;
      } else if (kind === 'DELIVERY') {
        acc.deliveries += 1;
        const stamped = Number(dual(s, 'revenue_sen') ?? 0);
        const doId = dual<string | null>(s, 'do_id');
        if (stamped > 0) acc.deliveryRevenueSen += stamped;
        else if (doId) unpricedDo.set(doId, [...(unpricedDo.get(doId) ?? []), meta.lorryId]);
        if (meta.date) acc.deliveryTripDates.add(meta.date);
      } else if (kind === 'PICKUP') {
        acc.pickups += 1;
      } else if (kind === 'SERVICE' || kind === 'INSPECTION') {
        acc.services += 1;
      } else if (kind === 'SETUP' || kind === 'DISMANTLE') {
        acc.setupDismantle += 1;
      }
    }
  }

  if (unpricedDo.size > 0) {
    const { data: priced, error: priceErr } = await chunkIn([...unpricedDo.keys()], (batch, lo, hi) =>
      scopeToCompany(sb.from('delivery_orders').select('id, local_total_sen').in('id', batch), c).order('id').range(lo, hi),
    );
    if (priceErr) return c.json({ error: 'load_failed', reason: `delivery order amounts: ${priceErr.message}` }, 500);
    for (const d of priced) {
      for (const lid of unpricedDo.get(dual<string>(d, 'id')) ?? []) {
        const acc = byLorry.get(lid);
        if (acc) acc.deliveryRevenueSen += Number(dual(d, 'local_total_sen') ?? 0);
      }
    }
  }

  const realTripDates = new Map([...byLorry.values()].map((a) => [a.id, new Set(a.tripDates)]));
  const [doJobs, projectJobs, km] = await Promise.all([
    loadDoJobs(c, from, to),
    loadProjectJobs(c, from, to),
    loadKmByLorry(c, from, to),
  ]);
  for (const r of [doJobs, projectJobs, km]) if (r.error) return c.json({ error: 'load_failed', reason: r.error }, 500);
  const idByPlate = new Map([...byLorry.values()].map((a) => [plateKey(a.plate), a.id]));
  for (const [lorryId, t] of tripsFromJobs([...doJobs.data, ...projectJobs.data], idByPlate, realTripDates)) {
    const acc = byLorry.get(lorryId);
    if (!acc) continue;
    acc.totalTrips += t.dates.size;
    acc.deliveries += t.delivery;
    acc.setupDismantle += t.setupDismantle;
    acc.deliveryRevenueSen += t.revenueSen;
    for (const d of t.dates) acc.tripDates.add(d);
    for (const d of t.deliveryDates) acc.deliveryTripDates.add(d);
  }
  for (const acc of byLorry.values()) acc.km = km.data ? (km.data.get(acc.id) ?? 0) : null;

  const lorries = [...byLorry.values()].map((a) => {
    const availableDays = Math.max(0, workingDays - a.repairDays);
    const workDays = a.tripDates.size;
    const deliveryDays = a.deliveryTripDates.size;
    const utilisation = safeDiv(a.totalTrips, availableDays);
    const ordersPerTrip = safeDiv(a.deliveries, a.totalTrips);
    const revenuePerOrderSen = safeDiv(a.deliveryRevenueSen, a.deliveries);
    const revenuePerTripSen = safeDiv(a.deliveryRevenueSen, a.totalTrips);
    return {
      lorry_id: a.id,
      plate: a.plate,
      type: a.type,
      is_internal: a.isInternal,
      work_days: workDays,
      repair_days: a.repairDays,
      available_days: availableDays,
      utilisation: round(utilisation, 4),
      total_trips: a.totalTrips,
      delivery_days: deliveryDays,
      deliveries: a.deliveries,
      orders_per_trip: round(ordersPerTrip, 2),
      setup_dismantle: a.setupDismantle,
      pickups: a.pickups,
      services: a.services,
      delivery_revenue_sen: a.deliveryRevenueSen,
      revenue_per_order_sen: revenuePerOrderSen == null ? null : Math.round(revenuePerOrderSen),
      revenue_per_trip_sen: revenuePerTripSen == null ? null : Math.round(revenuePerTripSen),
      km: a.km,
      running_cost_sen: a.km == null ? null : costSen(a.km, a.costPerKmSen),
    };
  });

  const sum = (sel: (l: typeof lorries[number]) => number) => lorries.reduce((m, l) => m + sel(l), 0);
  const totalTrips = sum((l) => l.total_trips);
  const availableDaysTotal = sum((l) => l.available_days);
  const deliveriesTotal = sum((l) => l.deliveries);
  const deliveryRevenueTotal = sum((l) => l.delivery_revenue_sen);
  const totals = {
    lorries: lorries.length,
    total_trips: totalTrips,
    available_days: availableDaysTotal,
    utilisation: round(safeDiv(totalTrips, availableDaysTotal), 4),
    orders_per_delivery_trip: round(safeDiv(deliveriesTotal, totalTrips), 2),
    delivery_revenue_sen: deliveryRevenueTotal,
    revenue_per_order_sen: (() => {
      const v = safeDiv(deliveryRevenueTotal, deliveriesTotal);
      return v == null ? null : Math.round(v);
    })(),
    revenue_per_trip_sen: (() => {
      const v = safeDiv(deliveryRevenueTotal, totalTrips);
      return v == null ? null : Math.round(v);
    })(),
  };

  return c.json({
    lorries,
    totals,
    workingDays,
    range: { from, to, fleet },
    km_incomplete: km.incomplete,
  });
});

const inHouseSchema = z.object({ isInternal: z.boolean() });

lorryCapacity.patch('/lorries/:id/in-house', async (c) => {
  // company-scope: UNIFIED FLEET — deliberate, not an oversight. lorries.ts:132
  // and drivers.ts:24-26,48 declare one shared fleet/roster across ALL companies
  // ("every company's TMS page shows the same lorries/drivers"), and driver_code
  // carries a bare UNIQUE so per-company minting would collide across tenants.
  // scm.lorry_service_records' own DDL (mig 0121) spells out the consequence:
  // company_id is stamped on insert but "NOT used to scope reads", because a
  // lorry's history must be visible wherever the lorry is. Verified 2026-08-13
  // against the DDL and both route declarations before deciding NOT to change
  // this handler.
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = inHouseSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('lorries')
    .update({ is_internal: parsed.data.isInternal, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, plate, is_internal')
    .single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ lorry: data });
});

const repairSchema = z.object({
  from: z.string().min(8),
  to: z.string().min(8),
  days: z.number().int().min(0),
});

lorryCapacity.put('/lorries/:id/repair-days', async (c) => {
  /* company-scope: UNIFIED FLEET — same verdict as PATCH /lorries/:id/in-house
     above, re-derived 2026-08-13 for the WRITE-specific question: the
     lorry_maintenance row is stamped `activeCompanyId(c)` while its parent
     scm.lorries row carries its own company_id (mig 0083), so the two CAN
     disagree. They are allowed to: mig 0121's DDL says company_id on these
     lorry-child tables is stamped on insert but "NOT used to scope reads",
     because a lorry's history must be visible wherever the lorry is. Checked
     every reader of lorry_maintenance — one in scm/lib/fleet-availability.ts,
     two in fleet-maintenance.ts, two in dp-orders.ts, two in this file (grep
     `from('lorry_maintenance')`) — and none selects, filters or groups on
     company_id; they all key on lorry_id and the date window. Grounding a lorry
     must ground it for BOTH companies' dispatchers, so scoping the DELETE of the
     prior managed window just below would be the actual bug: one company could
     not clear a repair window the other had opened. */
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = repairSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const { from, to } = parsed.data;
  const fromMs = dayMs(from);
  const toMs = dayMs(to);
  if (fromMs == null || toMs == null) return c.json({ error: 'bad_range' }, 400);

  const workingDays = countWorkingDays(fromMs, toMs);
  const days = Math.max(0, Math.min(parsed.data.days, workingDays));

  const sb = c.get('supabase');
  const user = c.get('user');

  const { error: clearErr } = await sb.from('lorry_maintenance')
    .delete()
    .eq('lorry_id', id)
    .eq('reason', DASHBOARD_REASON)
    .lte('unavailable_from', to)
    .gte('unavailable_to', from);
  if (clearErr) return c.json({ error: 'update_failed', reason: `Could not clear the earlier repair days: ${clearErr.message}` }, 500);

  if (days > 0) {
    let counted = 0;
    let end = fromMs;
    for (let d = fromMs; d <= toMs; d += DAY) {
      if (isWorkingDay(d)) counted += 1;
      end = d;
      if (counted >= days) break;
    }
    const { error } = await sb.from('lorry_maintenance').insert({
      company_id: activeCompanyId(c),
      lorry_id: id,
      unavailable_from: isoOf(fromMs),
      unavailable_to: isoOf(end),
      reason: DASHBOARD_REASON,
      created_by: (user as { id?: string } | null)?.id ?? null,
    });
    if (error) {
      if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
      return c.json({ error: 'insert_failed', reason: error.message }, 500);
    }
  }

  return c.json({ ok: true, lorry_id: id, repair_days: days, working_days: workingDays });
});

export default lorryCapacity;
