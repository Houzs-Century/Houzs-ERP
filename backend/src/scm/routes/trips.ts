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
import {
  assembleDayView,
  type RawTripRow, type RawStopRow, type StopEnrichment,
  type MasterName as DayMasterName, type MasterLorry as DayMasterLorry,
  type MasterWarehouse as DayMasterWarehouse, type LatLng as DayLatLng,
} from '../lib/fleet-day-view';
import { resolveDeliveryScope, scopeMatchesAssignment, type CrewAssignment } from '../lib/deliveryScope';
import { reconcileStopsToBoard, reconcileFieldsFor, type ReconcileStop } from '../lib/tripReconcile';
import { validatePing, shouldAcceptPing, latestPerDriver, PING_ACCEPTED_STATUSES } from '../lib/tripLocation';

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
   GET /trips/day?date=YYYY-MM-DD&warehouseId=<id> — the FLEET DAY-VIEW (A4).

   Every trip on ONE date, each with its ordered stops enriched for the map + the
   printable driver run-sheet: customer / address / revenue come straight off the
   stop snapshot; phone + house type resolve through the stop's DO to its SO; the
   delivery time window comes from scm.delivery_residence_rules by house type. A
   READ layer over already-scheduled trips — it writes NOTHING and creates no trip.

   Geocoding is CACHE-FIRST and gated behind GOOGLE_MAPS_API_KEY: with no key the
   response still carries every trip + stop (configured:false), the map just has no
   pins. A cached address never bills; a new one geocodes once then caches forever
   (scm.geocode_cache, mig 0197) — the SAME cache the propose-schedule scheduler
   fills, keyed on the same composed address so the two share hits.

   MUST stay registered BEFORE '/:id' — '/day' is a single segment and '/:id'
   would otherwise swallow it.
   ─────────────────────────────────────────────────────────────────────────*/
trips.get('/day', async (c) => {
  const sb = c.get('supabase');
  const date = c.req.query('date');
  const warehouseId = c.req.query('warehouseId');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'invalid_date', reason: 'date=YYYY-MM-DD is required' }, 400);
  }
  const configured = !!c.env.GOOGLE_MAPS_API_KEY;

  // Warehouses master — the depot list for the filter + the per-trip depot label.
  const { data: whRows } = await sb.from('warehouses').select('id, name, code, location, city, state, postcode');
  const warehousesById = new Map<string, DayMasterWarehouse>();
  const warehouseAddrById = new Map<string, string>();
  for (const w of (whRows ?? []) as Array<Record<string, unknown>>) {
    const id = String(dual<string>(w, 'id'));
    warehousesById.set(id, { id, name: String(dual<string>(w, 'name') ?? ''), code: (dual<string | null>(w, 'code') ?? null) });
    warehouseAddrById.set(id, composeAddress({
      address1: dual<string | null>(w, 'location'),
      address2: dual<string | null>(w, 'city'),
      postcode: dual<string | null>(w, 'postcode'),
      state: dual<string | null>(w, 'state'),
    }) || String(dual<string>(w, 'name') ?? ''));
  }
  const warehouses = [...warehousesById.values()].sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name));

  // Trips on the date (cross-company fleet view), optional depot filter.
  const { data: tripData, error: tripErr } = await paginateAll<Record<string, unknown>>((lo, hi) => {
    let q = sb.from('trips')
      .select('company_id, id, trip_no, trip_date, lorry_id, driver_id, helper_1_id, helper_2_id, warehouse_id, trip_type, status, is_outsourced, total_distance_km')
      .eq('trip_date', date).neq('status', 'CANCELLED').order('trip_no', { ascending: true }).range(lo, hi);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    q = scopeToAllowedCompanies(q, c);
    return q;
  });
  if (tripErr) return c.json({ error: 'load_failed', reason: tripErr.message }, 500);

  // PER-ASSIGNEE ROW SCOPE (owner rule): a Driver/Helper sees only their trips.
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const scopedTrips = (scope.mode === 'all'
    ? (tripData ?? [])
    : (tripData ?? []).filter((r) => scopeMatchesAssignment(scope, tripAssignment(r))));

  const rawTrips: RawTripRow[] = scopedTrips.map((r) => ({
    id: String(dual<string>(r, 'id')),
    trip_no: dual<string | null>(r, 'trip_no'),
    trip_date: dual<string | null>(r, 'trip_date'),
    status: dual<string | null>(r, 'status'),
    is_outsourced: dual<boolean | null>(r, 'is_outsourced'),
    lorry_id: dual<string | null>(r, 'lorry_id'),
    driver_id: dual<string | null>(r, 'driver_id'),
    helper_1_id: dual<string | null>(r, 'helper_1_id'),
    helper_2_id: dual<string | null>(r, 'helper_2_id'),
    warehouse_id: dual<string | null>(r, 'warehouse_id'),
    total_distance_km: dual<number | string | null>(r, 'total_distance_km'),
  }));

  if (rawTrips.length === 0) {
    return c.json({ date, configured, warehouses, trips: [] });
  }

  // Stops for those trips.
  const tripIds = rawTrips.map((t) => t.id);
  const { data: stopData } = await sb.from('trip_stops')
    .select('id, trip_id, stop_no, stop_type, do_id, so_id, customer_name, address, revenue_centi, eta_offset_s, leg_distance_m')
    .in('trip_id', tripIds);
  const rawStops: RawStopRow[] = ((stopData ?? []) as Array<Record<string, unknown>>).map((s) => ({
    id: String(dual<string>(s, 'id')),
    trip_id: String(dual<string>(s, 'trip_id')),
    stop_no: dual<number | null>(s, 'stop_no'),
    stop_type: dual<string | null>(s, 'stop_type'),
    do_id: dual<string | null>(s, 'do_id'),
    so_id: dual<string | null>(s, 'so_id'),
    customer_name: dual<string | null>(s, 'customer_name'),
    address: dual<string | null>(s, 'address'),
    revenue_centi: toNumericOrNull(dual(s, 'revenue_centi')),
    eta_offset_s: toNumericOrNull(dual(s, 'eta_offset_s')),
    leg_distance_m: toNumericOrNull(dual(s, 'leg_distance_m')),
  }));

  // Resolve each stop's source SO through its DO (an SO stop keeps do_id; there is
  // no trip_stops.so_id for an SO — it has no uuid). do_id -> so_doc_no -> SO.
  const doIds = [...new Set(rawStops.map((s) => s.do_id).filter((v): v is string => !!v))];
  const soDocByDoId = new Map<string, string>();
  if (doIds.length > 0) {
    const { data: doRows } = await sb.from('delivery_orders').select('id, so_doc_no').in('id', doIds);
    for (const d of (doRows ?? []) as Array<Record<string, unknown>>) {
      const id = dual<string | null>(d, 'id');
      const soDoc = dual<string | null>(d, 'so_doc_no');
      if (id && soDoc) soDocByDoId.set(String(id), String(soDoc));
    }
  }
  const soDocNos = [...new Set([...soDocByDoId.values()])];
  const soByDoc = new Map<string, { phone: string | null; buildingType: string | null; address: string }>();
  if (soDocNos.length > 0) {
    const { data: soRows } = await scopeToAllowedCompanies(
      sb.from('mfg_sales_orders')
        .select('doc_no, phone, building_type, house_type, address1, address2, postcode, customer_state, customer_country')
        .in('doc_no', soDocNos),
      c,
    );
    for (const r of (soRows ?? []) as Array<Record<string, unknown>>) {
      const docNo = String(dual<string>(r, 'doc_no'));
      const buildingType = (dual<string | null>(r, 'building_type') ?? dual<string | null>(r, 'house_type')) ?? null;
      soByDoc.set(docNo, {
        phone: dual<string | null>(r, 'phone'),
        buildingType,
        address: composeAddress({
          address1: dual<string | null>(r, 'address1'),
          address2: dual<string | null>(r, 'address2'),
          postcode: dual<string | null>(r, 'postcode'),
          state: dual<string | null>(r, 'customer_state'),
          country: dual<string | null>(r, 'customer_country'),
        }),
      });
    }
  }

  // Residence rules — house/building type -> delivery window + access flags.
  const { data: ruleRows } = await scopeToAllowedCompanies(
    sb.from('delivery_residence_rules')
      .select('building_type, earliest_delivery_time, latest_delivery_time, requires_lift_booking, requires_registration, is_active'),
    c,
  );
  const windowByType = new Map<string, { earliest: string | null; latest: string | null; note: string | null }>();
  for (const r of (ruleRows ?? []) as Array<Record<string, unknown>>) {
    const type = String((dual<string | null>(r, 'building_type') ?? '')).trim().toLowerCase();
    if (type === '') continue;
    if (dual<boolean | null>(r, 'is_active') === false) continue;
    const notes: string[] = [];
    if (dual<boolean | null>(r, 'requires_lift_booking') === true) notes.push('Lift booking required');
    if (dual<boolean | null>(r, 'requires_registration') === true) notes.push('Registration required');
    windowByType.set(type, {
      earliest: minutesToTime(timeToMinutes(dual<string | null>(r, 'earliest_delivery_time'))),
      latest: minutesToTime(timeToMinutes(dual<string | null>(r, 'latest_delivery_time'))),
      note: notes.length ? notes.join(' · ') : null,
    });
  }

  // Per-stop enrichment + the address to geocode (prefer the SO's fuller address,
  // matching what propose-schedule cached, for cache-key parity; else the snapshot).
  const enrichByStopId = new Map<string, StopEnrichment>();
  const geoAddrByStopId = new Map<string, string>();
  for (const s of rawStops) {
    const soDoc = s.do_id ? soDocByDoId.get(s.do_id) ?? null : null;
    const so = soDoc ? soByDoc.get(soDoc) ?? null : null;
    const houseType = so?.buildingType ?? null;
    const win = houseType ? windowByType.get(houseType.trim().toLowerCase()) ?? null : null;
    enrichByStopId.set(s.id, {
      phone: so?.phone ?? null,
      houseType,
      earliestTime: win?.earliest ?? null,
      latestTime: win?.latest ?? null,
      accessNote: win?.note ?? null,
    });
    const addr = (so?.address && so.address.trim() !== '') ? so.address : (s.address ?? '');
    if (addr.trim() !== '') geoAddrByStopId.set(s.id, addr);
  }

  // Geocode (cache-first, gated). Depots first, then each distinct stop address.
  const depotByWarehouseId = new Map<string, DayLatLng>();
  const geoByStopId = new Map<string, DayLatLng>();
  if (configured) {
    const depotWhIds = [...new Set(rawTrips.map((t) => t.warehouse_id).filter((v): v is string => !!v))];
    for (const whId of depotWhIds) {
      const addr = warehouseAddrById.get(whId);
      if (!addr) continue;
      const hit = await geocodeAddressCached(sb, c.env, addr);
      if (hit) depotByWarehouseId.set(whId, { lat: hit.lat, lng: hit.lng });
    }
    // Distinct addresses so repeated customers geocode once per request too.
    const addrToStops = new Map<string, string[]>();
    for (const [stopId, addr] of geoAddrByStopId) {
      const arr = addrToStops.get(addr);
      if (arr) arr.push(stopId); else addrToStops.set(addr, [stopId]);
    }
    for (const [addr, stopIds] of addrToStops) {
      const hit = await geocodeAddressCached(sb, c.env, addr);
      if (hit) for (const sid of stopIds) geoByStopId.set(sid, { lat: hit.lat, lng: hit.lng });
    }
  }

  // Masters (cross-company fleet) — id -> display name / plate.
  const [drv, hlp, lry] = await Promise.all([
    sb.from('drivers').select('id, name'),
    sb.from('helpers').select('id, name'),
    sb.from('lorries').select('id, plate'),
  ]);
  const driversById = new Map<string, DayMasterName>();
  for (const d of (drv.data ?? []) as Array<Record<string, unknown>>) {
    const id = String(dual<string>(d, 'id')); driversById.set(id, { id, name: String(dual<string>(d, 'name') ?? '') });
  }
  const helpersById = new Map<string, DayMasterName>();
  for (const h of (hlp.data ?? []) as Array<Record<string, unknown>>) {
    const id = String(dual<string>(h, 'id')); helpersById.set(id, { id, name: String(dual<string>(h, 'name') ?? '') });
  }
  const lorriesById = new Map<string, DayMasterLorry>();
  for (const l of (lry.data ?? []) as Array<Record<string, unknown>>) {
    const id = String(dual<string>(l, 'id')); lorriesById.set(id, { id, plate: String(dual<string>(l, 'plate') ?? '') });
  }

  const { trips: dayTrips } = assembleDayView({
    trips: rawTrips, stops: rawStops,
    driversById, helpersById, lorriesById, warehousesById,
    enrichByStopId, geoByStopId, depotByWarehouseId,
  });

  return c.json({ date, configured, warehouses, trips: dayTrips });
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

/* ──────────────────────────────────────────────────────────────────────────
   LIVE GPS TRACKING (Phase 4). The driver keeps the delivery page open; the
   browser posts coordinates every ~20-30s WHILE the trip is IN_PROGRESS; the
   dispatcher map POLLS the latest position per driver (no websockets — polling
   is this repo's realtime mechanism). Append-only ping log in scm.trip_locations
   (mig 0199). Capture is scoped to an ACTIVE trip only (privacy) — see below.
   ─────────────────────────────────────────────────────────────────────────*/

const LOCATION_COLS = 'trip_id, driver_id, lat, lng, accuracy_m, recorded_at, received_at';

/* POST /trips/:id/location — a driver on an ACTIVE trip posts one GPS ping
   { lat, lng, accuracy?, recorded_at? }. Range-validated, rate-capped
   server-side (pings <10s apart are ignored), and accepted ONLY for a trip in
   an IN_PROGRESS state. A bad ping is REJECTED cleanly (4xx), never a 500 — a
   phone on a bad connection must not be able to crash the endpoint. */
trips.post('/:id/location', async (c) => {
  const tripId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  // Range + timestamp validation up front (pure, never throws).
  const v = validatePing(body);
  if (!v.ok) return c.json({ error: 'invalid_ping', reason: v.error }, 400);

  const sb = c.get('supabase');
  // The trip must exist, be visible to this caller, and be IN_PROGRESS. A
  // Driver/Helper is row-scoped to their OWN trips (same self-scope as the rest
  // of the trips router), so they can only ping a trip they are crewed on.
  const { data: trip } = await sb.from('trips')
    .select('id, status, company_id, driver_id, helper_1_id, helper_2_id')
    .eq('id', tripId).maybeSingle();
  if (!trip) return c.json({ error: 'trip_not_found' }, 404);
  const t = trip as Record<string, unknown>;

  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  if (scope.mode === 'self' && !scopeMatchesAssignment(scope, tripAssignment(t))) {
    return c.json({ error: 'not_your_trip' }, 403);
  }

  const status = String(dual(t, 'status') ?? '').toUpperCase();
  if (!PING_ACCEPTED_STATUSES.has(status)) {
    // Not live — the driver's page should stop tracking. Reported, not 500'd.
    return c.json({ ok: false, accepted: false, reason: 'trip_not_in_progress', status }, 409);
  }

  const driverId = (dual<string | null>(t, 'driver_id') ?? null);

  // Rate cap: read the newest stored ping for this trip+driver and drop the new
  // one if it is closer than the minimum gap (a flaky watchPosition can fire far
  // faster than the ~20-30s cadence). Best-effort — a read miss accepts.
  {
    let lastQ = sb.from('trip_locations')
      .select('recorded_at').eq('trip_id', tripId)
      .order('recorded_at', { ascending: false }).limit(1);
    lastQ = driverId ? lastQ.eq('driver_id', driverId) : lastQ.is('driver_id', null);
    const { data: last } = await lastQ.maybeSingle();
    const lastMs = last ? Date.parse(String(dual(last as Record<string, unknown>, 'recorded_at') ?? '')) : null;
    if (!shouldAcceptPing(Number.isFinite(lastMs as number) ? (lastMs as number) : null, Date.parse(v.ping.recordedAt))) {
      return c.json({ ok: true, accepted: false, reason: 'rate_capped' });
    }
  }

  const { error } = await sb.from('trip_locations').insert({
    company_id:  dual<number | null>(t, 'company_id') ?? activeCompanyId(c),
    trip_id:     tripId,
    driver_id:   driverId,
    user_id:     c.get('houzsUser')?.id ?? null,
    lat:         v.ping.lat,
    lng:         v.ping.lng,
    accuracy_m:  v.ping.accuracyM,
    recorded_at: v.ping.recordedAt,
    /* Mig 0253. Only the native watcher can tell a mock-location app from the
       GPS chip; a browser always sends nothing here and the column defaults to
       false, which is a true statement about a browser ping rather than a
       guess. Recorded, never rejected: refusing a simulated fix would leave a
       gap indistinguishable from lost signal, and the point is to be able to
       SEE it. */
    simulated:   (body as { simulated?: unknown } | null)?.simulated === true,
  });
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    // Any other insert failure is reported, not thrown — the driver's page keeps
    // trying on the next tick.
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true, accepted: true });
});

/* GET /trips/:id/locations/latest — the latest position per driver on ONE trip,
   for the dispatcher's live map. Read-only. Row-scoped like the rest of the
   router. Returns [] when the trip has no pings yet (a fresh trip). */
trips.get('/:id/locations/latest', async (c) => {
  const tripId = c.req.param('id');
  const sb = c.get('supabase');

  const { data: trip } = await sb.from('trips')
    .select('id, driver_id, helper_1_id, helper_2_id').eq('id', tripId).maybeSingle();
  if (!trip) return c.json({ error: 'trip_not_found' }, 404);
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  if (scope.mode === 'self' && !scopeMatchesAssignment(scope, tripAssignment(trip as Record<string, unknown>))) {
    return c.json({ error: 'not_found' }, 404);
  }

  // A bounded newest-first window (uses idx_trip_locations_trip_recorded); one
  // trip has at most a handful of driver phones, so 200 rows is ample headroom
  // for latestPerDriver to find the newest of each.
  const { data, error } = await sb.from('trip_locations')
    .select(LOCATION_COLS).eq('trip_id', tripId)
    .order('recorded_at', { ascending: false }).limit(200);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ locations: latestPerDriver((data ?? []) as Array<Record<string, unknown>>) });
});

/* GET /trips/active/locations — board-level: the latest position per driver
   across every IN_PROGRESS trip, for the Delivery-Planning / Trips overview map.
   Read-only, scoped to the caller's allowed companies (cross-company like the
   trip list) and to their own trips when self-scoped. */
trips.get('/active/locations', async (c) => {
  const sb = c.get('supabase');

  // The set of live trips the caller may see (cross-company; self-scoped when a
  // Driver/Helper). Empty → no pings.
  let tripQ = sb.from('trips')
    .select('id, driver_id, helper_1_id, helper_2_id').eq('status', 'IN_PROGRESS');
  tripQ = scopeToAllowedCompanies(tripQ, c);
  const { data: activeTrips, error: tErr } = await tripQ;
  if (tErr) return c.json({ error: 'load_failed', reason: tErr.message }, 500);

  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const visible = (activeTrips ?? []).filter((r) =>
    scope.mode === 'all' || scopeMatchesAssignment(scope, tripAssignment(r as Record<string, unknown>)));
  const tripIds = visible.map((r) => dual<string>(r as Record<string, unknown>, 'id')).filter(Boolean);
  if (tripIds.length === 0) return c.json({ locations: [] });

  // Newest-first window over just those trips; latestPerDriver collapses it to
  // one row per (trip, driver).
  const { data, error } = await sb.from('trip_locations')
    .select(LOCATION_COLS).in('trip_id', tripIds)
    .order('recorded_at', { ascending: false }).limit(1000);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ locations: latestPerDriver((data ?? []) as Array<Record<string, unknown>>) });
});

export default trips;
