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
//   repair_days    = Σ overlapping Mon–Sat days of the lorry's lorry_maintenance
//                    windows, each clipped to [from,to].
//   available_days = max(0, working_days − repair_days).
//   total_trips    = non-CANCELLED trips with trip_date in [from,to].
//   work_days      = distinct trip_date count (the displayed Work Days column).
//   delivery_days  = distinct trip_date where the trip has ≥1 DELIVERY stop.
//   utilisation    = total_trips ÷ available_days  (CAN exceed 100% — multiple
//                    trips/day; Houzs's own definition. available_days=0 → null).
//   deliveries     = trip_stops DELIVERY on the lorry's in-range trips;
//                    pickups=PICKUP; services=SERVICE+INSPECTION;
//                    setup_dismantle=SETUP+DISMANTLE.
//   orders_per_trip   = deliveries ÷ total_trips.
//   delivery_revenue  = Σ trip_stops.revenue_centi where stop_type=DELIVERY (cents).
//   revenue_per_order = delivery_revenue ÷ deliveries.
//   revenue_per_trip  = delivery_revenue ÷ total_trips.
// All ÷ guard div-by-zero (→ null, rendered "—" by the client). DRAFT does not
// exist for trips; CANCELLED trips are excluded everywhere.
//
// Money: revenue_centi is BIGINT cents; the dashboard returns cents and the
// client divides by 100 for the RM display (fmtCenti).
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

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import { activeCompanyId } from '../lib/companyScope';

export const lorryCapacity = new Hono<{ Bindings: Env; Variables: Variables }>();
lorryCapacity.use('*', supabaseAuth);

/* Dual-read a camelCased OR snake_cased field off a query result. The pg driver
   camelCases result columns; reading the snake_case key alone returns undefined
   (the #1 recurring 2990/Houzs bug). Always read both. */
function dual<T = unknown>(row: Record<string, unknown>, snake: string): T {
  const camel = snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return (row[camel] ?? row[snake]) as T;
}

/* The sentinel reason marking a lorry_maintenance row this dashboard manages
   (so the Repair Days editor can replace its own window without clobbering a
   manually-entered repair/servicing window). */
const DASHBOARD_REASON = 'Repair days (dashboard)';

/* ── Date helpers — all YYYY-MM-DD, all UTC-anchored so day math is stable on
      the Workers UTC runtime (the dates are calendar dates, not instants). ──── */

/** Parse YYYY-MM-DD → a UTC midnight ms, or null. */
function dayMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const s = String(iso).slice(0, 10);
  const t = new Date(`${s}T00:00:00Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** A UTC ms back to YYYY-MM-DD. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

/** Is this UTC-day Monday–Saturday (working day)? Sunday (getUTCDay()===0) excluded. */
function isWorkingDay(ms: number): boolean {
  return new Date(ms).getUTCDay() !== 0;
}

/** Count Mon–Sat calendar days in [fromMs, toMs] inclusive. Empty / inverted → 0. */
function countWorkingDays(fromMs: number, toMs: number): number {
  if (toMs < fromMs) return 0;
  let n = 0;
  for (let d = fromMs; d <= toMs; d += DAY) if (isWorkingDay(d)) n += 1;
  return n;
}

/** Mon–Sat days of [winFrom,winTo] clipped to [rangeFrom,rangeTo]. */
function clippedWorkingDays(winFrom: number, winTo: number, rangeFrom: number, rangeTo: number): number {
  const lo = Math.max(winFrom, rangeFrom);
  const hi = Math.min(winTo, rangeTo);
  return countWorkingDays(lo, hi);
}

/* Round a number to `dp` decimals (default 0). null passes through. */
function round(n: number | null, dp = 0): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/* Safe divide → null on a zero / invalid denominator (the client renders "—"). */
function safeDiv(num: number, den: number): number | null {
  if (!den || !Number.isFinite(den)) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

type FleetFilter = 'all' | 'internal' | 'outsourced';

/* ──────────────────────────────────────────────────────────────────────────
   GET /lorry-capacity?from=&to=&fleet=all|internal|outsourced
   The dashboard. Per-lorry metrics + fleet summary cards + the working-day
   count for the range. Defaults the range to the current calendar month.
   ─────────────────────────────────────────────────────────────────────────*/
lorryCapacity.get('/', async (c) => {
  const sb = c.get('supabase');

  /* Range — default to the current calendar month (1st .. last day) if omitted. */
  const now = new Date();
  const defFrom = isoOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const defTo = isoOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const from = (c.req.query('from') || defFrom).slice(0, 10);
  const to = (c.req.query('to') || defTo).slice(0, 10);
  const fleetParam = (c.req.query('fleet') ?? 'all').toLowerCase();
  const fleet: FleetFilter =
    fleetParam === 'internal' ? 'internal' : fleetParam === 'outsourced' ? 'outsourced' : 'all';

  const fromMs = dayMs(from);
  const toMs = dayMs(to);
  if (fromMs == null || toMs == null) return c.json({ error: 'bad_range', reason: 'from / to must be YYYY-MM-DD' }, 400);

  const workingDays = countWorkingDays(fromMs, toMs);

  /* 1. Lorries master (fleet-filtered). Active lorries only — the dashboard is a
        capacity view of the live fleet. */
  let lq = sb.from('lorries')
    .select('id, plate, type, is_internal, active')
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
    tripDates: Set<string>;        // distinct trip_date (work days)
    deliveryTripDates: Set<string>; // distinct trip_date with ≥1 DELIVERY stop
    totalTrips: number;
    deliveries: number;
    pickups: number;
    services: number;
    setupDismantle: number;
    deliveryRevenueCenti: number;
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
      deliveryRevenueCenti: 0,
    });
  }

  /* 2. Repair days — lorry_maintenance windows overlapping [from,to]. Σ the
        clipped Mon–Sat days per lorry. Paginated. (We over-read [from,to]-
        overlapping rows: a window overlaps if its start <= to AND its end >=
        from.) */
  {
    const { data: maint } = await paginateAll<Record<string, unknown>>((lo, hi) =>
      sb.from('lorry_maintenance')
        .select('lorry_id, unavailable_from, unavailable_to')
        .lte('unavailable_from', to)
        .gte('unavailable_to', from)
        .range(lo, hi),
    );
    for (const m of (maint ?? [])) {
      const lid = dual<string>(m, 'lorry_id');
      const acc = byLorry.get(lid);
      if (!acc) continue;
      const wf = dayMs(dual<string>(m, 'unavailable_from'));
      const wt = dayMs(dual<string>(m, 'unavailable_to'));
      if (wf == null || wt == null) continue;
      acc.repairDays += clippedWorkingDays(wf, wt, fromMs, toMs);
    }
  }

  /* 3. Trips in range, non-CANCELLED. id → lorry + trip_date so stops can be
        attributed back to a lorry/date. Paginated. */
  type TripMeta = { lorryId: string | null; date: string };
  const tripMeta = new Map<string, TripMeta>();
  {
    const { data: trips } = await paginateAll<Record<string, unknown>>((lo, hi) =>
      sb.from('trips')
        .select('id, lorry_id, trip_date, status')
        .gte('trip_date', from)
        .lte('trip_date', to)
        .neq('status', 'CANCELLED')
        .range(lo, hi),
    );
    for (const t of (trips ?? [])) {
      const id = dual<string>(t, 'id');
      const lorryId = dual<string | null>(t, 'lorry_id') ?? null;
      const date = String(dual<string>(t, 'trip_date') ?? '').slice(0, 10);
      tripMeta.set(id, { lorryId, date });
      if (!lorryId) continue;
      const acc = byLorry.get(lorryId);
      if (!acc) continue;            // trip lorry filtered out (fleet) → skip
      acc.totalTrips += 1;
      if (date) acc.tripDates.add(date);
    }
  }

  /* 4. Stops for those trips — bucket by stop_type per lorry, sum DELIVERY
        revenue, and mark a trip's date as a delivery day. Read all stops whose
        trip_id is in our in-range trip set. Paginated, chunked over the trip ids
        (a large fleet-month can exceed a 1000-element IN list). */
  const tripIds = [...tripMeta.keys()];
  if (tripIds.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < tripIds.length; i += CHUNK) {
      const batch = tripIds.slice(i, i + CHUNK);
      const { data: stops } = await paginateAll<Record<string, unknown>>((lo, hi) =>
        sb.from('trip_stops')
          .select('trip_id, stop_type, revenue_centi')
          .in('trip_id', batch)
          .range(lo, hi),
      );
      for (const s of (stops ?? [])) {
        const tid = dual<string>(s, 'trip_id');
        const meta = tripMeta.get(tid);
        if (!meta || !meta.lorryId) continue;
        const acc = byLorry.get(meta.lorryId);
        if (!acc) continue;
        const kind = String(dual<string>(s, 'stop_type') ?? '').toUpperCase();
        if (kind === 'DELIVERY') {
          acc.deliveries += 1;
          acc.deliveryRevenueCenti += Number(dual(s, 'revenue_centi') ?? 0);
          if (meta.date) acc.deliveryTripDates.add(meta.date);
        } else if (kind === 'PICKUP') {
          acc.pickups += 1;
        } else if (kind === 'SERVICE' || kind === 'INSPECTION') {
          /* INSPECTION (mig 0165) is an ASSR on-site inspection visit scheduled
             from the Delivery Planning board. It is service-case work and counts
             with SERVICE — without this arm it matched no bucket at all and the
             visit consumed a lorry's day while showing up in none of its stop
             counts. */
          acc.services += 1;
        } else if (kind === 'SETUP' || kind === 'DISMANTLE') {
          acc.setupDismantle += 1;
        }
      }
    }
  }

  /* 5. Shape per-lorry metrics (formulas above). Money returned as cents; client
        divides by 100. Every displayed ratio rounded (counts integer; rates 1dp;
        utilisation as a 0..n fraction the client renders as a %). */
  const lorries = [...byLorry.values()].map((a) => {
    const availableDays = Math.max(0, workingDays - a.repairDays);
    const workDays = a.tripDates.size;
    const deliveryDays = a.deliveryTripDates.size;
    const utilisation = safeDiv(a.totalTrips, availableDays);         // CAN exceed 1
    const ordersPerTrip = safeDiv(a.deliveries, a.totalTrips);
    const revenuePerOrderCenti = safeDiv(a.deliveryRevenueCenti, a.deliveries);
    const revenuePerTripCenti = safeDiv(a.deliveryRevenueCenti, a.totalTrips);
    return {
      lorry_id: a.id,
      plate: a.plate,
      type: a.type,
      is_internal: a.isInternal,
      work_days: workDays,
      repair_days: a.repairDays,
      available_days: availableDays,
      utilisation: round(utilisation, 4),               // fraction; UI renders %
      total_trips: a.totalTrips,
      delivery_days: deliveryDays,
      deliveries: a.deliveries,
      orders_per_trip: round(ordersPerTrip, 2),
      setup_dismantle: a.setupDismantle,
      pickups: a.pickups,
      services: a.services,
      delivery_revenue_centi: a.deliveryRevenueCenti,
      revenue_per_order_centi: revenuePerOrderCenti == null ? null : Math.round(revenuePerOrderCenti),
      revenue_per_trip_centi: revenuePerTripCenti == null ? null : Math.round(revenuePerTripCenti),
    };
  });

  /* 6. Fleet summary cards — aggregate across the filtered lorries. Utilisation
        card = Σ total_trips ÷ Σ available_days (same definition, fleet-wide).
        Orders/Delivery Trip = Σ deliveries ÷ Σ total_trips. Revenue rollups Σ. */
  const sum = (sel: (l: typeof lorries[number]) => number) => lorries.reduce((m, l) => m + sel(l), 0);
  const totalTrips = sum((l) => l.total_trips);
  const availableDaysTotal = sum((l) => l.available_days);
  const deliveriesTotal = sum((l) => l.deliveries);
  const deliveryRevenueTotal = sum((l) => l.delivery_revenue_centi);
  const totals = {
    lorries: lorries.length,
    total_trips: totalTrips,
    available_days: availableDaysTotal,
    utilisation: round(safeDiv(totalTrips, availableDaysTotal), 4),
    orders_per_delivery_trip: round(safeDiv(deliveriesTotal, totalTrips), 2),
    delivery_revenue_centi: deliveryRevenueTotal,
    revenue_per_order_centi: (() => {
      const v = safeDiv(deliveryRevenueTotal, deliveriesTotal);
      return v == null ? null : Math.round(v);
    })(),
    revenue_per_trip_centi: (() => {
      const v = safeDiv(deliveryRevenueTotal, totalTrips);
      return v == null ? null : Math.round(v);
    })(),
  };

  return c.json({
    lorries,
    totals,
    workingDays,
    range: { from, to, fleet },
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   PATCH /lorry-capacity/lorries/:id/in-house — toggle is_internal inline.

   DELIBERATELY NOT COMPANY-SCOPED. scm.lorries is the GLOBAL fleet master —
   MULTICOMPANY-MODULE-MAP.md classes TMS drivers / helpers / lorries as SHARED,
   one copy for all companies, and every read on this dashboard (and in
   lorries.ts, fleet-maintenance.ts) lists the whole fleet. In-house vs
   Outsourced is a fact about the vehicle, not about a company's books; scoping
   this write would make the flag settable only by whichever company happened to
   insert the lorry and stale for the other, while the shared dashboard kept
   showing it. The gate here is the transportation area guard, not company_id.
   ─────────────────────────────────────────────────────────────────────────*/
const inHouseSchema = z.object({ isInternal: z.boolean() });

lorryCapacity.patch('/lorries/:id/in-house', async (c) => {
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

/* ──────────────────────────────────────────────────────────────────────────
   PUT /lorry-capacity/lorries/:id/repair-days {from,to,days} — set the repair
   days for the queried period via a single dashboard-managed maintenance window.
   Replaces this dashboard's own window for the period (never touches a manually
   entered maintenance window, which carries a different reason). days is clamped
   to [0, working_days(from,to)]; a window of `days` Mon–Sat days starting at
   `from` is inserted (days=0 → just clear the managed window).
   ─────────────────────────────────────────────────────────────────────────*/
const repairSchema = z.object({
  from: z.string().min(8),                 // YYYY-MM-DD (range start)
  to: z.string().min(8),                   // YYYY-MM-DD (range end)
  days: z.number().int().min(0),
});

lorryCapacity.put('/lorries/:id/repair-days', async (c) => {
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

  /* 1. Remove THIS dashboard's prior managed window(s) overlapping [from,to] for
        the lorry (leave manually-added maintenance untouched — different reason).
        No company predicate, for the same reason as the in-house toggle above: a
        window is an availability fact about a SHARED vehicle. A lorry that is in
        the workshop is in the workshop for both companies, so both must see (and
        be able to correct) the same window. */
  await sb.from('lorry_maintenance')
    .delete()
    .eq('lorry_id', id)
    .eq('reason', DASHBOARD_REASON)
    .lte('unavailable_from', to)
    .gte('unavailable_to', from);

  /* 2. Insert one window holding exactly `days` Mon–Sat days, starting at `from`,
        clamped to `to`. Walk day-by-day from `from`, counting working days; the
        window ends on the day that brings the working-day total to `days`. */
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
