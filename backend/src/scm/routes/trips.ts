// ----------------------------------------------------------------------------
// /trips — the TRIPS scheduling layer (Delivery / TMS Stage 5A).
//
// A trip is a scheduled lorry-day: one lorry + a primary driver (+ up to 2
// helpers) leaving an origin warehouse on a date, carrying an ordered list of
// trip_stops. Each stop links a DO (or an SO before a DO is cut) with a
// stop_type and the delivery value attributable to that stop (revenue_centi).
// Σ revenue_centi per trip = the trip revenue the Stage 5B "Lorry Capacity"
// dashboard aggregates; the dashboard route itself is NOT built here.
//
// is_outsourced is DERIVED from the lorry's is_internal at create time
// (is_outsourced = NOT is_internal) and snapshotted on the trip, so a later
// master flip doesn't rewrite history. trip_no is a human doc number
// (TRIP-YYMM-NNN) minted server-side via mintMonthlyDocNo (max+1, never count+1).
//
// Money: DO/SO grand totals are local_total_centi (integer cents); a stop's
// revenue_centi is sourced from that. Dual-read camelCase ?? snake_case on every
// result column (the pg driver camelCases result columns).
//
// Houzs port of 2990's apps/api/src/routes/trips.ts — same plumbing as the
// sibling SCM routes (supabaseAuth + scm-scoped c.get('supabase'); paginateAll
// from ../lib/paginate-all, mintMonthlyDocNo from ../lib/doc-no). scm.trips /
// scm.trip_stops already exist (migration 0053). Mounted at '/trips'.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { scopeToAllowedCompanies, companyCodeMap, withCompanyCode, activeCompanyId } from '../lib/companyScope';
import { optimizeRoute, travelTimeMatrix, type LatLngPoint } from '../lib/maps';
import { geocodeAddressCached, composeAddress } from '../lib/geocode';
import { proposeRoute, timeToMinutes, minutesToTime, type ProposeStopInput } from '../lib/propose-route';
import { resolveDeliveryScope, scopeMatchesAssignment, type CrewAssignment } from '../lib/deliveryScope';
import { reconcileStopsToBoard, reconcileFieldsFor, type ReconcileStop } from '../lib/tripReconcile';

export const trips = new Hono<{ Bindings: Env; Variables: Variables }>();
trips.use('*', supabaseAuth);

const TRIP_COLS =
  // company_id — TMS is a CROSS-COMPANY view: the row carries its company so the
  // UI can show a company column (see companyScope.ts cross-company pattern).
  'company_id, id, trip_no, trip_date, lorry_id, driver_id, helper_1_id, helper_2_id, warehouse_id, ' +
  'trip_type, status, is_outsourced, clock_in_at, clock_out_at, total_distance_km, notes, ' +
  'created_at, created_by, updated_at';

const STOP_COLS =
  'id, trip_id, stop_no, stop_type, do_id, so_id, customer_name, address, revenue_centi, notes, created_at, ' +
  /* Mig 0134 — what the route optimiser worked out. NULL = never optimised, which
     is honestly "not computed" rather than a fabricated zero. */
  'leg_distance_m, leg_duration_s, eta_offset_s, route_optimised_at';

const TRIP_STATUSES = new Set(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);

/* A trip's crew as a CrewAssignment (dual-read camelCase/snake_case), for the
   per-assignee row scope: a Driver/Helper sees / acts on ONLY their own trips. */
function tripAssignment(row: Record<string, unknown>): CrewAssignment {
  return {
    driverIds: [dual<string | null>(row, 'driver_id')],
    helperIds: [dual<string | null>(row, 'helper_1_id'), dual<string | null>(row, 'helper_2_id')],
  };
}

/* Dual-read a camelCased OR snake_cased field off a query result. The pg driver
   camelCases result columns; reading the snake_case key alone returns undefined
   (the #1 recurring 2990/Houzs bug). Always read both. */
function dual<T = unknown>(row: Record<string, unknown>, snake: string): T {
  const camel = snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return (row[camel] ?? row[snake]) as T;
}

/* Next TRIP-YYMM-NNN. Mirrors the sibling scm minters — max(suffix)+1 via
   mintMonthlyDocNo (self-healing; never count+1). */
async function nextTripNo(sb: any): Promise<string> {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  // TRIP stays CROSS-COMPANY (no companyDocPrefix) — one shared sequence, per
  // lib/companyScope.ts. mintMonthlyDocNo reads the row's single selected value,
  // so it keeps working whichever of trip_no/tripNo the driver hands back.
  return mintMonthlyDocNo(sb, 'trips', 'trip_no', `TRIP-${yymm}`);
}

/* is_outsourced derives from the lorry's is_internal (NOT is_internal). A trip
   with no lorry (or an unknown lorry) defaults to in-house (false). */
async function deriveOutsourced(sb: any, lorryId: string | null): Promise<boolean> {
  if (!lorryId) return false;
  const { data } = await sb.from('lorries').select('is_internal').eq('id', lorryId).maybeSingle();
  if (!data) return false;
  const internal = dual<boolean | null>(data as Record<string, unknown>, 'is_internal');
  return internal === false; // outsourced when explicitly not in-house
}

function toNumericOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Read the DELIVERY stops of a trip as ReconcileStops. Only DELIVERY stops carry
   the SO/DO delivery the reverse sync owns — the same stop_type scheduleOntoTrip
   stamps and the stale-stop sweep filters on, kept symmetric so forward and
   reverse cannot drift. A read failure yields [] (best-effort): the reconcile
   then reports NOT_REQUESTED rather than throwing on the primary trip action. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deliveryStopsOfTrip(sb: any, tripId: string): Promise<ReconcileStop[]> {
  const { data } = await sb.from('trip_stops')
    .select('do_id, so_id, stop_type').eq('trip_id', tripId).eq('stop_type', 'DELIVERY');
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    doId: (r.doId ?? r.do_id ?? null) as string | null,
    soId: (r.soId ?? r.so_id ?? null) as string | null,
    stopType: (r.stopType ?? r.stop_type ?? null) as string | null,
  }));
}

/* The actor for a reconcile audit row (best-effort, may be null). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actorOf(c: any): { actorId: string | null; actorName: string | null } {
  const user = c.get('user') as { id?: string; user_metadata?: { name?: string } } | null;
  return { actorId: user?.id ?? null, actorName: user?.user_metadata?.name ?? null };
}

/* ──────────────────────────────────────────────────────────────────────────
   GET /trips?from=&to=&lorryId=&status= — list (paginated past the 1000 cap).
   ─────────────────────────────────────────────────────────────────────────*/
trips.get('/', async (c) => {
  const sb = c.get('supabase');
  const from = c.req.query('from');         // YYYY-MM-DD (inclusive)
  const to = c.req.query('to');             // YYYY-MM-DD (inclusive)
  const lorryId = c.req.query('lorryId');
  const status = c.req.query('status');

  const { data, error } = await paginateAll<Record<string, unknown>>((lo, hi) => {
    // Inline literal select (not the TRIP_COLS const) so the PostgREST types
    // resolve a concrete row shape that satisfies paginateAll's generic — the
    // convention used by the paginated reads in delivery-planning.ts.
    let q = sb.from('trips')
      .select('company_id, id, trip_no, trip_date, lorry_id, driver_id, helper_1_id, helper_2_id, warehouse_id, trip_type, status, is_outsourced, clock_in_at, clock_out_at, total_distance_km, notes, created_at, created_by, updated_at')
      .order('trip_date', { ascending: false }).range(lo, hi);
    if (from) q = q.gte('trip_date', from);
    if (to) q = q.lte('trip_date', to);
    if (lorryId) q = q.eq('lorry_id', lorryId);
    if (status && TRIP_STATUSES.has(status.toUpperCase())) q = q.eq('status', status.toUpperCase());
    // CROSS-COMPANY view: widen to every allowed company (one shared queue) —
    // NOT isolated to the active company like SO/PO/GRN. No-op when unresolved.
    q = scopeToAllowedCompanies(q, c);
    return q;
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  /* PER-ASSIGNEE ROW SCOPE (owner rule): a Driver/Helper sees ONLY the trips
     they are crewed on; ops/dispatcher/management resolve to `all` and see every
     trip (the shared cross-company queue), unchanged. */
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const scoped = scope.mode === 'all'
    ? (data ?? [])
    : (data ?? []).filter((r) => scopeMatchesAssignment(scope, tripAssignment(r)));
  // Tag each row with a readable company_code so the list can show a company column.
  const codes = companyCodeMap(c);
  const trips = scoped.map((r) => withCompanyCode(r, codes));
  return c.json({ trips });
});

/* ──────────────────────────────────────────────────────────────────────────
   GET /trips/:id — one trip with its ordered stops.
   ─────────────────────────────────────────────────────────────────────────*/
trips.get('/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const [t, s] = await Promise.all([
    sb.from('trips').select(TRIP_COLS).eq('id', id).maybeSingle(),
    sb.from('trip_stops').select(STOP_COLS).eq('trip_id', id).order('stop_no', { ascending: true }),
  ]);
  if (t.error) return c.json({ error: 'load_failed', reason: t.error.message }, 500);
  if (!t.data) return c.json({ error: 'not_found' }, 404);
  /* Row scope — a self-scoped Driver/Helper opening a trip that is not theirs
     gets a 404 (indistinguishable from a nonexistent trip), same hatch the sales
     doc detail uses. Ops/dispatcher (`all`) are never blocked. */
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  if (scope.mode === 'self' && !scopeMatchesAssignment(scope, tripAssignment(t.data as unknown as Record<string, unknown>))) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ trip: t.data, stops: s.data ?? [] });
});

/* ──────────────────────────────────────────────────────────────────────────
   POST /trips — create (lorry + driver + date + warehouse + type). is_outsourced
   derived from the lorry's is_internal; trip_no auto-minted.
   ─────────────────────────────────────────────────────────────────────────*/
const tripCreateSchema = z.object({
  tripDate: z.string().min(8),                          // YYYY-MM-DD
  lorryId: z.string().uuid().nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  helper1Id: z.string().uuid().nullable().optional(),
  helper2Id: z.string().uuid().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  tripType: z.enum(['DELIVERY', 'SETUP', 'DISMANTLE', 'SG', 'MIXED']).default('DELIVERY'),
  notes: z.string().nullable().optional(),
});

trips.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = tripCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;

  const sb = c.get('supabase');
  const user = c.get('user');
  const lorryId = p.lorryId ?? null;
  const isOutsourced = await deriveOutsourced(sb, lorryId);

  const { data, error } = await insertWithDocNoRetry(
    () => nextTripNo(sb),
    (tripNo) => sb.from('trips').insert({
    // CROSS-COMPANY: a trip is created from whichever company you're currently
    // in (it can still reference the other company's DOs via its stops).
    company_id:    activeCompanyId(c),
    trip_no:       tripNo,
    trip_date:     p.tripDate,
    lorry_id:      lorryId,
    driver_id:     p.driverId ?? null,
    helper_1_id:   p.helper1Id ?? null,
    helper_2_id:   p.helper2Id ?? null,
    warehouse_id:  p.warehouseId ?? null,
    trip_type:     p.tripType,
    status:        'PLANNED',
    is_outsourced: isOutsourced,
    notes:         p.notes ?? null,
    created_by:    (user as { id?: string } | null)?.id ?? null,
    }).select(TRIP_COLS).single(),
  );
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_trip_no', reason: error.message }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ trip: data }, 201);
});

/* ──────────────────────────────────────────────────────────────────────────
   PATCH /trips/:id — edit header fields. Re-derives is_outsourced if the lorry
   changes (unless an explicit isOutsourced is passed).
   ─────────────────────────────────────────────────────────────────────────*/
const tripPatchSchema = z.object({
  tripDate: z.string().min(8).optional(),
  lorryId: z.string().uuid().nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  helper1Id: z.string().uuid().nullable().optional(),
  helper2Id: z.string().uuid().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  tripType: z.enum(['DELIVERY', 'SETUP', 'DISMANTLE', 'SG', 'MIXED']).optional(),
  isOutsourced: z.boolean().optional(),
  clockInAt: z.string().nullable().optional(),
  clockOutAt: z.string().nullable().optional(),
  totalDistanceKm: z.union([z.number(), z.string()]).nullable().optional(),
  notes: z.string().nullable().optional(),
});

trips.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = tripPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const sb = c.get('supabase');

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.tripDate !== undefined) updates.trip_date = p.tripDate;
  if (p.lorryId !== undefined) updates.lorry_id = p.lorryId;
  if (p.driverId !== undefined) updates.driver_id = p.driverId;
  if (p.helper1Id !== undefined) updates.helper_1_id = p.helper1Id;
  if (p.helper2Id !== undefined) updates.helper_2_id = p.helper2Id;
  if (p.warehouseId !== undefined) updates.warehouse_id = p.warehouseId;
  if (p.tripType !== undefined) updates.trip_type = p.tripType;
  if (p.clockInAt !== undefined) updates.clock_in_at = p.clockInAt;
  if (p.clockOutAt !== undefined) updates.clock_out_at = p.clockOutAt;
  if (p.totalDistanceKm !== undefined) updates.total_distance_km = toNumericOrNull(p.totalDistanceKm);
  if (p.notes !== undefined) updates.notes = p.notes;
  // is_outsourced: explicit value wins; else re-derive when the lorry changes.
  if (p.isOutsourced !== undefined) {
    updates.is_outsourced = p.isOutsourced;
  } else if (p.lorryId !== undefined) {
    updates.is_outsourced = await deriveOutsourced(sb, p.lorryId);
  }
  if (Object.keys(updates).length === 1) return c.json({ error: 'no_changes' }, 400);

  const { data, error } = await sb.from('trips').update(updates).eq('id', id).select(TRIP_COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ trip: data });
});

/* ──────────────────────────────────────────────────────────────────────────
   PATCH /trips/:id/status — flip the trip status (PLANNED/IN_PROGRESS/…).
   Stamps clock_in_at on first IN_PROGRESS and clock_out_at on COMPLETED if not
   already set (best-effort timeline, doesn't overwrite a manual clock).
   ─────────────────────────────────────────────────────────────────────────*/
trips.patch('/:id/status', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const status = String(body.status ?? '').toUpperCase();
  if (!TRIP_STATUSES.has(status)) return c.json({ error: 'invalid_status' }, 400);

  const sb = c.get('supabase');
  const { data: cur } = await sb.from('trips').select('clock_in_at, clock_out_at, driver_id, helper_1_id, helper_2_id').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  /* WRITE OWNERSHIP (owner rule): a Driver/Helper may advance a trip's step
     (status) ONLY on a trip they are crewed on. Ops/dispatcher (`all`) pass
     untouched. Layers under the area-guard's edit gate — see the twin guard in
     delivery-planning.ts /fields. */
  {
    const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
    if (scope.mode === 'self' && !scopeMatchesAssignment(scope, tripAssignment(cur as Record<string, unknown>))) {
      return c.json({ error: 'You can only update a delivery job assigned to you.' }, 403);
    }
  }
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status, updated_at: now };
  if (status === 'IN_PROGRESS' && !dual(cur as Record<string, unknown>, 'clock_in_at')) updates.clock_in_at = now;
  if (status === 'COMPLETED' && !dual(cur as Record<string, unknown>, 'clock_out_at')) updates.clock_out_at = now;

  const { data, error } = await sb.from('trips').update(updates).eq('id', id).select(TRIP_COLS).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  /* REVERSE SYNC: cancelling a trip strands its scheduled orders. Return each to
     the board by clearing its scheduled-looking delivery_state override — the
     board's live derivation then falls a ready-to-ship order back to
     PENDING_SCHEDULE. lorry-capacity already drops a CANCELLED trip and its stops
     (lorry-capacity.ts neq status CANCELLED), so no double-count; this closes the
     OTHER half — the stale board override. Best-effort + REPORTED. Other statuses
     leave the schedule intact. */
  if (status === 'CANCELLED') {
    const stops = await deliveryStopsOfTrip(sb, id);
    const reconcile = await reconcileStopsToBoard(sb, { stops, ...actorOf(c) });
    return c.json({ trip: data, ...reconcileFieldsFor(reconcile) });
  }
  return c.json({ trip: data });
});

/* ──────────────────────────────────────────────────────────────────────────
   POST /trips/:id/stops — add a stop linking a DO/SO, with stop_type + revenue.
   If revenueCenti is omitted and a do_id/so_id is given, the stop's revenue is
   sourced from the DO/SO local_total_centi. customer_name/address default from
   the DO/SO header when not supplied.
   ─────────────────────────────────────────────────────────────────────────*/
const stopCreateSchema = z.object({
  stopNo: z.number().int().positive().optional(),
  stopType: z.enum(['DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE']).default('DELIVERY'),
  doId: z.string().uuid().nullable().optional(),
  soId: z.string().uuid().nullable().optional(),
  soDocNo: z.string().nullable().optional(),       // resolve a stop to an SO by its doc_no
  customerName: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  revenueCenti: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
});

trips.post('/:id/stops', async (c) => {
  const tripId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = stopCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const sb = c.get('supabase');

  // Trip must exist (the FK would 500 anyway; this returns a clean 404).
  const { data: trip } = await sb.from('trips').select('id').eq('id', tripId).maybeSingle();
  if (!trip) return c.json({ error: 'trip_not_found' }, 404);

  // Resolve revenue + customer/address snapshots from the linked DO / SO when
  // not supplied. local_total_centi is the grand total on both headers.
  let revenue = p.revenueCenti ?? null;
  let customerName = p.customerName ?? null;
  let address = p.address ?? null;
  let soId = p.soId ?? null;

  if (p.doId) {
    const { data: doRow } = await sb.from('delivery_orders')
      .select('local_total_centi, debtor_name, address1, address2').eq('id', p.doId).maybeSingle();
    if (doRow) {
      const r = doRow as Record<string, unknown>;
      if (revenue == null) revenue = Number(dual(r, 'local_total_centi') ?? 0);
      if (customerName == null) customerName = (dual<string>(r, 'debtor_name') ?? null);
      if (address == null) address = [dual<string>(r, 'address1'), dual<string>(r, 'address2')].filter(Boolean).join(', ') || null;
    }
  } else if (p.soDocNo) {
    // SO lookup by doc_no → its uuid id + snapshots + grand total.
    const { data: soRow } = await sb.from('mfg_sales_orders')
      .select('id, local_total_centi, debtor_name, address1, address2').eq('doc_no', p.soDocNo).maybeSingle();
    if (soRow) {
      const r = soRow as Record<string, unknown>;
      if (soId == null) soId = dual<string>(r, 'id') ?? null;
      if (revenue == null) revenue = Number(dual(r, 'local_total_centi') ?? 0);
      if (customerName == null) customerName = (dual<string>(r, 'debtor_name') ?? null);
      if (address == null) address = [dual<string>(r, 'address1'), dual<string>(r, 'address2')].filter(Boolean).join(', ') || null;
    }
  }

  // Next stop_no for this trip if not pinned (1 = first stop).
  let stopNo = p.stopNo ?? null;
  if (stopNo == null) {
    const { data: existing } = await sb.from('trip_stops').select('stop_no').eq('trip_id', tripId);
    const max = ((existing ?? []) as Array<Record<string, unknown>>)
      .reduce((m, r) => Math.max(m, Number(dual(r, 'stop_no') ?? 0)), 0);
    stopNo = max + 1;
  }

  const { data, error } = await sb.from('trip_stops').insert({
    // CROSS-COMPANY: the stop belongs to its trip's company (a trip can still
    // reference the other company's DO/SO). Stamp the active company like the trip.
    company_id:    activeCompanyId(c),
    trip_id:       tripId,
    stop_no:       stopNo,
    stop_type:     p.stopType,
    do_id:         p.doId ?? null,
    so_id:         soId,
    customer_name: customerName,
    address,
    revenue_centi: Math.max(0, Math.round(Number(revenue ?? 0)) || 0),
    notes:         p.notes ?? null,
  }).select(STOP_COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ stop: data }, 201);
});

/* DELETE /trips/:id/stops/:stopId — remove one stop. */
trips.delete('/:id/stops/:stopId', async (c) => {
  const tripId = c.req.param('id');
  const stopId = c.req.param('stopId');
  const sb = c.get('supabase');
  /* Snapshot the stop's source keys BEFORE the delete — once it is gone there is
     nothing left to map back to a header. */
  const { data: stopRow } = await sb.from('trip_stops')
    .select('do_id, so_id, stop_type').eq('id', stopId).eq('trip_id', tripId).maybeSingle();
  const { error } = await sb.from('trip_stops').delete().eq('id', stopId).eq('trip_id', tripId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  /* REVERSE SYNC: a removed DELIVERY stop means that order is no longer on this
     trip — return it to the board by clearing its scheduled-looking override.
     Non-DELIVERY stops (a PICKUP / SERVICE raised for the same order) are a
     different job and are left alone, same stop_type discipline as the forward
     sweep. */
  const r = (stopRow ?? null) as Record<string, unknown> | null;
  const stopType = r ? ((r.stopType ?? r.stop_type ?? null) as string | null) : null;
  if (r && stopType === 'DELIVERY') {
    const reconcile = await reconcileStopsToBoard(sb, {
      stops: [{ doId: (r.doId ?? r.do_id ?? null) as string | null, soId: (r.soId ?? r.so_id ?? null) as string | null, stopType }],
      ...actorOf(c),
    });
    return c.json({ ok: true, ...reconcileFieldsFor(reconcile) });
  }
  return c.json({ ok: true });
});

/* ──────────────────────────────────────────────────────────────────────────
   DELETE /trips/:id — cancel (default) or hard-delete (?hard=true). A cancel
   flips status → CANCELLED (the legs FK is ON DELETE SET NULL, so a hard delete
   orphans the legs back to unplanned rather than removing them). Idempotent.
   ─────────────────────────────────────────────────────────────────────────*/
trips.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const hard = c.req.query('hard') === 'true';
  const sb = c.get('supabase');

  /* Snapshot the scheduled orders BEFORE mutating: a hard delete CASCADEs the
     stops away (trip_stops.trip_id ON DELETE CASCADE, mig 0053), and even a soft
     cancel drops the trip out of lorry-capacity — either way the orders must be
     returned to the board. Read once, up front, for both paths. */
  const stops = await deliveryStopsOfTrip(sb, id);

  if (hard) {
    const { error } = await sb.from('trips').delete().eq('id', id);
    if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
    const reconcile = await reconcileStopsToBoard(sb, { stops, ...actorOf(c) });
    return c.json({ ok: true, deleted: true, ...reconcileFieldsFor(reconcile) });
  }

  const { data, error } = await sb.from('trips')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', id).select(TRIP_COLS).maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  /* REVERSE SYNC — return each stranded order to the board (clear its
     scheduled-looking override). Best-effort + REPORTED. */
  const reconcile = await reconcileStopsToBoard(sb, { stops, ...actorOf(c) });
  return c.json({ trip: data, cancelled: true, ...reconcileFieldsFor(reconcile) });
});

/* ──────────────────────────────────────────────────────────────────────────
   POST /trips/:id/optimize-route — ask Google Directions for the shortest order
   of this trip's stops, from the origin warehouse and back. GATED: with no
   GOOGLE_MAPS_API_KEY it returns { configured:false } and never calls Google, so
   nothing bills until the owner sets the key. Read-only by default; `?apply=true`
   writes the optimised order back to trip_stops.stop_no.
   ─────────────────────────────────────────────────────────────────────────*/
trips.post('/:id/optimize-route', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const apply = c.req.query('apply') === 'true';

  const t = await sb.from('trips').select('id, warehouse_id').eq('id', id).maybeSingle();
  if (t.error) return c.json({ error: 'load_failed', reason: t.error.message }, 500);
  if (!t.data) return c.json({ error: 'not_found' }, 404);

  const [wh, s] = await Promise.all([
    (t.data as { warehouse_id?: string }).warehouse_id
      ? sb.from('warehouses').select('name, location').eq('id', (t.data as { warehouse_id: string }).warehouse_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from('trip_stops').select('id, address, stop_no').eq('trip_id', id).order('stop_no', { ascending: true }),
  ]);
  const whRow = (wh as { data?: { name?: string; location?: string } | null }).data ?? null;
  const originAddress = [whRow?.location, whRow?.name].filter(Boolean).join(', ') || 'warehouse';
  const stopRows = ((s as { data?: Array<{ id: string; address?: string }> }).data ?? [])
    .map((r) => ({ ref: String(r.id), address: String(r.address ?? '') }));

  const result = await optimizeRoute(c.env, { originAddress, stops: stopRows });

  // Only write when routing actually succeeded AND the caller asked to apply.
  // A failed/absent route must never renumber the operator's manual order.
  let applied = false;
  if (apply && result.ok && result.stops.length > 0) {
    const optimisedAt = new Date().toISOString();
    for (const st of result.stops) {
      /* Persist the numbers too (mig 0134) — otherwise the ETA lived only in this
         response and the next page load would have to re-bill Google to show it.
         eta_offset_s is an OFFSET from departure, not a clock time: the trip's
         start can move, and a stored wall-clock ETA would go stale silently. */
      await sb.from('trip_stops').update({
        stop_no: st.order,
        leg_distance_m: st.legDistanceMetres,
        leg_duration_s: st.legDurationSeconds,
        eta_offset_s: st.etaSecondsFromDepart,
        route_optimised_at: optimisedAt,
      }).eq('id', st.ref).eq('trip_id', id);
    }
    // The trip's own distance was hand-typed until now; the optimiser knows it.
    await sb.from('trips')
      .update({ total_distance_km: Math.round(result.totalDistanceMetres / 100) / 10, updated_at: optimisedAt })
      .eq('id', id);
    applied = true;
  }
  return c.json({ ...result, applied });
});

/* ──────────────────────────────────────────────────────────────────────────
   POST /trips/propose-schedule — the "Propose times + route" SMART scheduler
   (Phase 3). Given the selected SO stops + a depot warehouse, geocode each
   address (CACHED), read each stop's SERVICE DURATION + delivery TIME WINDOW
   from scm.delivery_residence_rules (by the SO's building_type), fetch the
   point-to-point travel matrix (Google Distance Matrix, ONE call), and sequence
   the stops with per-stop arrival / start / finish times.

   COST: this is the ONLY place that calls the Distance Matrix, and it runs ONLY
   when the operator clicks "Propose times + route" — never on render. Geocodes
   are cache-first (scm.geocode_cache), so a given address bills Google once ever.
   With no GOOGLE_MAPS_API_KEY it returns { configured:false } and never calls
   Google; the drawer then keeps its plain stop list. NOTHING is written here —
   the operator applies via the existing schedule path (stopNo + etaOffsetS).
   ─────────────────────────────────────────────────────────────────────────*/
const proposeScheduleSchema = z.object({
  soDocNos: z.array(z.string().min(1)).min(1).max(40),
  depotWarehouseId: z.string().uuid().nullable().optional(),
  departTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'departTime must be HH:MM').optional(),
});

trips.post('/propose-schedule', async (c) => {
  const sb = c.get('supabase');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = proposeScheduleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const { soDocNos, depotWarehouseId } = parsed.data;
  const departTime = parsed.data.departTime ?? '09:00';
  const departMin = timeToMinutes(departTime) ?? 9 * 60;

  // 1. Load the selected SO stops — address parts + building_type, scoped to the
  //    caller's allowed companies (never a blind doc_no read).
  const soQuery = scopeToAllowedCompanies(
    sb.from('mfg_sales_orders')
      .select('doc_no, debtor_name, address1, address2, postcode, customer_state, customer_country, building_type')
      .in('doc_no', soDocNos),
    c,
  );
  const { data: soRows, error: soErr } = await soQuery;
  if (soErr) return c.json({ error: 'load_failed', reason: soErr.message }, 500);
  const soByDoc = new Map<string, Record<string, unknown>>();
  for (const r of (soRows ?? []) as Array<Record<string, unknown>>) {
    soByDoc.set(String((r.docNo ?? r.doc_no) as string), r);
  }

  // 2. Residence rules for this company — building_type -> service + window.
  const { data: ruleRows } = await scopeToAllowedCompanies(
    sb.from('delivery_residence_rules')
      .select('building_type, service_duration_minutes, earliest_delivery_time, latest_delivery_time, is_active'),
    c,
  );
  const ruleByType = new Map<string, { service: number; earliest: number | null; latest: number | null }>();
  for (const r of (ruleRows ?? []) as Array<Record<string, unknown>>) {
    const type = String((r.buildingType ?? r.building_type ?? '') as string).trim().toLowerCase();
    if (type === '') continue;
    if (((r.isActive ?? r.is_active) as boolean | null) === false) continue;
    ruleByType.set(type, {
      service: Number((r.serviceDurationMinutes ?? r.service_duration_minutes) ?? 90),
      earliest: timeToMinutes((r.earliestDeliveryTime ?? r.earliest_delivery_time) as string | null),
      latest: timeToMinutes((r.latestDeliveryTime ?? r.latest_delivery_time) as string | null),
    });
  }
  const DEFAULT_SERVICE = 90;
  const ruleFor = (buildingType: string | null) => {
    const key = (buildingType ?? '').trim().toLowerCase();
    return ruleByType.get(key) ?? { service: DEFAULT_SERVICE, earliest: null, latest: null };
  };

  // 3. Resolve + geocode the depot (cache-first). No depot -> no route.
  let depotAddress = '';
  if (depotWarehouseId) {
    const { data: wh } = await sb.from('warehouses')
      .select('name, location, city, state, postcode').eq('id', depotWarehouseId).maybeSingle();
    if (wh) {
      const w = wh as Record<string, unknown>;
      depotAddress = composeAddress({
        address1: (w.location ?? null) as string | null,
        address2: (w.city ?? null) as string | null,
        postcode: (w.postcode ?? null) as string | null,
        state: (w.state ?? null) as string | null,
      }) || String((w.name ?? '') as string).trim();
    }
  }
  const depotHit = depotAddress ? await geocodeAddressCached(sb, c.env, depotAddress) : null;

  // 4. Geocode each stop (cache-first, preserving the selection order).
  type StopOut = {
    ref: string; debtorName: string | null; address: string; buildingType: string | null;
    lat: number; lng: number; serviceMinutes: number; earliestTime: string | null; latestTime: string | null;
  };
  const geocoded: StopOut[] = [];
  const ungeocoded: Array<{ ref: string; debtorName: string | null; address: string; reason: string }> = [];
  for (const docNo of soDocNos) {
    const row = soByDoc.get(docNo);
    if (!row) { ungeocoded.push({ ref: docNo, debtorName: null, address: '', reason: 'order not found or not in your company' }); continue; }
    const debtorName = (row.debtorName ?? row.debtor_name ?? null) as string | null;
    const address = composeAddress({
      address1: (row.address1 ?? null) as string | null,
      address2: (row.address2 ?? null) as string | null,
      postcode: (row.postcode ?? null) as string | null,
      state: (row.customerState ?? row.customer_state ?? null) as string | null,
      country: (row.customerCountry ?? row.customer_country ?? null) as string | null,
    });
    const buildingType = (row.buildingType ?? row.building_type ?? null) as string | null;
    const rule = ruleFor(buildingType);
    if (address.trim() === '') { ungeocoded.push({ ref: docNo, debtorName, address: '', reason: 'no delivery address on file' }); continue; }
    const hit = await geocodeAddressCached(sb, c.env, address);
    if (!hit) { ungeocoded.push({ ref: docNo, debtorName, address, reason: c.env.GOOGLE_MAPS_API_KEY ? 'could not geocode this address' : 'maps key not configured' }); continue; }
    geocoded.push({
      ref: docNo, debtorName, address, buildingType,
      lat: hit.lat, lng: hit.lng,
      serviceMinutes: rule.service,
      earliestTime: minutesToTime(rule.earliest),
      latestTime: minutesToTime(rule.latest),
    });
  }

  const depotOut = depotHit
    ? { warehouseId: depotWarehouseId ?? null, address: depotAddress, lat: depotHit.lat, lng: depotHit.lng }
    : null;

  // Not enough to route: report honestly, the drawer keeps its plain list.
  if (!c.env.GOOGLE_MAPS_API_KEY) {
    return c.json({ configured: false, ok: false, reason: 'GOOGLE_MAPS_API_KEY not set — smart scheduling disabled',
      departTime, depot: null, stops: geocoded, ungeocoded, travelSeconds: [], distanceMetres: [], proposed: null });
  }
  if (!depotOut) {
    return c.json({ configured: true, ok: false, reason: 'depot could not be geocoded — set a warehouse address',
      departTime, depot: null, stops: geocoded, ungeocoded, travelSeconds: [], distanceMetres: [], proposed: null });
  }
  if (geocoded.length === 0) {
    return c.json({ configured: true, ok: false, reason: 'no stop could be geocoded',
      departTime, depot: depotOut, stops: [], ungeocoded, travelSeconds: [], distanceMetres: [], proposed: null });
  }

  // 5. ONE Distance Matrix call over [depot, ...stops].
  const points: LatLngPoint[] = [{ lat: depotOut.lat, lng: depotOut.lng }, ...geocoded.map((s) => ({ lat: s.lat, lng: s.lng }))];
  const matrix = await travelTimeMatrix(c.env, points);
  if (!matrix.ok) {
    return c.json({ configured: true, ok: false, reason: matrix.reason ?? 'travel matrix unavailable',
      departTime, depot: depotOut, stops: geocoded, ungeocoded, travelSeconds: [], distanceMetres: [], proposed: null });
  }

  // 6. Sequence with the residence-rule windows + service durations.
  const stopInputs: ProposeStopInput[] = geocoded.map((s) => ({
    ref: s.ref,
    serviceMinutes: s.serviceMinutes,
    earliestMin: timeToMinutes(s.earliestTime),
    latestMin: timeToMinutes(s.latestTime),
  }));
  const route = proposeRoute({ departMin, stops: stopInputs, travelSeconds: matrix.durationSeconds, distanceMetres: matrix.distanceMetres });

  const proposed = {
    sequence: route.sequence.map((st) => ({
      ref: st.ref,
      order: st.order,
      travelMinutes: st.travelMinutes,
      distanceMetres: st.distanceMetres,
      arrivalTime: minutesToTime(st.arrivalMin),
      waitMinutes: st.waitMinutes,
      startServiceTime: minutesToTime(st.startServiceMin),
      finishTime: minutesToTime(st.finishMin),
      serviceMinutes: st.serviceMinutes,
      earliestTime: minutesToTime(st.earliestMin),
      latestTime: minutesToTime(st.latestMin),
      windowViolated: st.windowViolated,
    })),
    totalTravelMinutes: route.totalTravelMinutes,
    totalDistanceMetres: route.totalDistanceMetres,
    returnTime: minutesToTime(route.returnMin),
    windowViolations: route.windowViolations,
  };

  return c.json({
    configured: true, ok: true, departTime,
    depot: depotOut, stops: geocoded, ungeocoded,
    travelSeconds: matrix.durationSeconds, distanceMetres: matrix.distanceMetres,
    proposed,
  });
});

export default trips;
