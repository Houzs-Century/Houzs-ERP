
import { yymmFor } from '../../services/documentRefs';
import { Hono } from 'hono';
import { syncTripCrewToDos } from '../lib/trip-crew-sync';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import {
  assemblePackingLists,
  type PackTripRow, type PackStopRow, type PackDoRow, type PackItemRow, type PackLabelRow,
  type PackSoItemRow, type PackCrewRow, type PackingList,
} from '../lib/packing-list-view';
import {
  assemblePackingDay, assemblePackingRegions, mergeLorryLists,
  type DayCrewRow, type DayDoRow, type DayTripStop, type PackingDayDo,
} from '../lib/packing-day-view';
import { loadRegionConfig } from '../lib/delivery-board-regions';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { scopeToAllowedCompanies, companyCodeMap, withCompanyCode, activeCompanyId, type CompanyScopeCtx } from '../lib/companyScope';
import { planStopMove } from '../lib/move-stop';
import { optimizeRoute, travelTimeMatrix, type LatLngPoint } from '../lib/maps';
import { geocodeAddressCached, composeAddress } from '../lib/geocode';
import { proposeRoute, timeToMinutes, minutesToTime, type ProposeStopInput } from '../lib/propose-route';
import {
  assembleDayView,
  type RawTripRow, type RawStopRow, type StopEnrichment,
  type MasterName as DayMasterName, type MasterLorry as DayMasterLorry,
  type MasterWarehouse as DayMasterWarehouse, type LatLng as DayLatLng,
} from '../lib/fleet-day-view';
import { resolveDeliveryScope, scopeMatchesAssignment, type CrewAssignment, type DeliveryScope } from '../lib/deliveryScope';
import { lorryPlatesByIds } from '../lib/lorry-plate-lookup';
import { reconcileStopsToBoard, reconcileFieldsFor, type ReconcileStop } from '../lib/tripReconcile';
import { validatePing, shouldAcceptPing, latestPerDriver, PING_ACCEPTED_STATUSES, pingCallerAllowed } from '../lib/tripLocation';
import { dateOrNull } from '../lib/date-coerce';
import { fillDpRowsPostcode, fillPostcodeFields, localitiesForPostcodes, postcodesToLookUp } from '../lib/postcode-from-address';
import { DO_ARRIVED_STATES } from '../shared/do-shipped-states';
import { resolveWorkedOutSources, type WorkedOutDo } from '../lib/do-line-worked-out-sources';
import type { VariantAttrs } from '../shared';

export const trips = new Hono<{ Bindings: Env; Variables: Variables }>();
trips.use('*', supabaseAuth);

const TRIP_COLS =
  'company_id, id, trip_no, trip_date, lorry_id, driver_id, helper_1_id, helper_2_id, warehouse_id, ' +
  'trip_type, status, is_outsourced, clock_in_at, clock_out_at, total_distance_km, notes, ' +
  'created_at, created_by, updated_at';

const STOP_COLS =
  'id, trip_id, stop_no, stop_type, do_id, so_id, customer_name, address, revenue_sen, notes, created_at, ' +
  'leg_distance_m, leg_duration_s, eta_offset_s, route_optimised_at';

const TRIP_STATUSES = new Set(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);

function tripAssignment(row: Record<string, unknown>, platesById?: ReadonlyMap<string, string> | null): CrewAssignment {
  const lid = dual<string | null>(row, 'lorry_id');
  return {
    driverIds: [dual<string | null>(row, 'driver_id')],
    helperIds: [dual<string | null>(row, 'helper_1_id'), dual<string | null>(row, 'helper_2_id')],
    lorryPlate: lid && platesById ? platesById.get(String(lid)) ?? null : null,
  };
}

/** trips.lorry_id → plate, resolved ONLY for a `self` scope that carries lorry
 *  plates (a lorry account, owner 2026-11-28). An `all` scope never matches, and
 *  a person-driver self scope has no plates, so neither pays for the lorries
 *  read. Best-effort: an empty map just means the plate arm does not fire. The
 *  rows must carry lorry_id (every trip select here does). */
async function platesForTripRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every scm route
  sb: any,
  scope: DeliveryScope,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<ReadonlyMap<string, string>> {
  if (scope.mode !== 'self' || scope.lorryPlates.size === 0) return new Map();
  return lorryPlatesByIds(sb, rows.map((r) => dual<string | null>(r, 'lorry_id')));
}

function dual<T = unknown>(row: Record<string, unknown>, snake: string): T {
  const camel = snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return (row[camel] ?? row[snake]) as T;
}

async function nextTripNo(sb: any): Promise<string> {
  const yymm = yymmFor();
  return mintMonthlyDocNo(sb, 'trips', 'trip_no', `TRIP-${yymm}`);
}

async function deriveOutsourced(sb: any, lorryId: string | null): Promise<boolean> {
  if (!lorryId) return false;
  const { data } = await sb.from('lorries').select('is_internal').eq('id', lorryId).maybeSingle();
  if (!data) return false;
  const internal = dual<boolean | null>(data as Record<string, unknown>, 'is_internal');
  return internal === false;
}

function toNumericOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actorOf(c: any): { actorId: string | null; actorName: string | null } {
  const user = c.get('user') as { id?: string; user_metadata?: { name?: string } } | null;
  return { actorId: user?.id ?? null, actorName: user?.user_metadata?.name ?? null };
}

trips.get('/', async (c) => {
  const sb = c.get('supabase');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const lorryId = c.req.query('lorryId');
  const status = c.req.query('status');

  const { data, error } = await paginateAll<Record<string, unknown>>((lo, hi) => {
    let q = sb.from('trips')
      .select('company_id, id, trip_no, trip_date, lorry_id, driver_id, helper_1_id, helper_2_id, warehouse_id, trip_type, status, is_outsourced, clock_in_at, clock_out_at, total_distance_km, notes, created_at, created_by, updated_at')
      .order('trip_date', { ascending: false }).range(lo, hi);
    if (from) q = q.gte('trip_date', from);
    if (to) q = q.lte('trip_date', to);
    if (lorryId) q = q.eq('lorry_id', lorryId);
    if (status && TRIP_STATUSES.has(status.toUpperCase())) q = q.eq('status', status.toUpperCase());
    q = scopeToAllowedCompanies(q, c);
    return q;
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const plates = await platesForTripRows(sb, scope, data ?? []);
  const scoped = scope.mode === 'all'
    ? (data ?? [])
    : (data ?? []).filter((r) => scopeMatchesAssignment(scope, tripAssignment(r, plates)));
  const codes = companyCodeMap(c);
  const trips = scoped.map((r) => withCompanyCode(r, codes));
  return c.json({ trips });
});

trips.get('/day', async (c) => {
  const sb = c.get('supabase');
  const date = c.req.query('date');
  const warehouseId = c.req.query('warehouseId');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'invalid_date', reason: 'date=YYYY-MM-DD is required' }, 400);
  }
  const configured = !!c.env.GOOGLE_MAPS_API_KEY;

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

  const { data: tripData, error: tripErr } = await paginateAll<Record<string, unknown>>((lo, hi) => {
    let q = sb.from('trips')
      .select('company_id, id, trip_no, trip_date, lorry_id, driver_id, helper_1_id, helper_2_id, warehouse_id, trip_type, status, is_outsourced, total_distance_km, planned_depart_at, clock_in_at, clock_out_at')
      .eq('trip_date', date).neq('status', 'CANCELLED').order('trip_no', { ascending: true }).range(lo, hi);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    q = scopeToAllowedCompanies(q, c);
    return q;
  });
  if (tripErr) return c.json({ error: 'load_failed', reason: tripErr.message }, 500);

  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const dayPlates = await platesForTripRows(sb, scope, tripData ?? []);
  const scopedTrips = (scope.mode === 'all'
    ? (tripData ?? [])
    : (tripData ?? []).filter((r) => scopeMatchesAssignment(scope, tripAssignment(r, dayPlates))));

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
    planned_depart_at: dual<string | null>(r, 'planned_depart_at'),
    clock_in_at: dual<string | null>(r, 'clock_in_at'),
    clock_out_at: dual<string | null>(r, 'clock_out_at'),
  }));

  if (rawTrips.length === 0) {
    return c.json({ date, configured, warehouses, trips: [] });
  }

  const tripIds = rawTrips.map((t) => t.id);
  const { data: stopData } = await sb.from('trip_stops')
    .select('id, trip_id, stop_no, stop_type, do_id, so_id, customer_name, address, revenue_sen, eta_offset_s, leg_distance_m')
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
    revenue_sen: toNumericOrNull(dual(s, 'revenue_sen')),
    eta_offset_s: toNumericOrNull(dual(s, 'eta_offset_s')),
    leg_distance_m: toNumericOrNull(dual(s, 'leg_distance_m')),
  }));

  const doIds = [...new Set(rawStops.map((s) => s.do_id).filter((v): v is string => !!v))];
  const soDocByDoId = new Map<string, string>();
  const podByDoId = new Map<string, { delivered: boolean; hasPod: boolean }>();
  if (doIds.length > 0) {
    /* COMPANY PREDICATE. The trips above are scoped and the stops hang off
       them, but rule (b) of the company-scope note in scm/lib/companyScope.ts
       is exactly this case: a parent-ownership filter proves the DO is on that
       trip, never that the DO is in your books. Same shape as docs/bugs/0496.
       Widened, not isolated — TMS is one shared queue. */
    const { data: doRows } = await scopeToAllowedCompanies(
      sb.from('delivery_orders').select('id, so_doc_no, status, delivered_at, pod_r2_key, pod_lat').in('id', doIds), c,
    );
    for (const d of (doRows ?? []) as Array<Record<string, unknown>>) {
      const id = dual<string | null>(d, 'id');
      const soDoc = dual<string | null>(d, 'so_doc_no');
      if (id && soDoc) soDocByDoId.set(String(id), String(soDoc));
      if (id) {
        const status = String(dual<string | null>(d, 'status') ?? '').toUpperCase();
        const podKey = dual<string | null>(d, 'pod_r2_key');
        const podLat = dual<number | null>(d, 'pod_lat');
        podByDoId.set(String(id), {
          delivered: status === 'DELIVERED',
          hasPod: podKey != null || podLat != null,
        });
      }
    }
  }
  const soDocNos = [...new Set([...soDocByDoId.values()])];
  const soByDoc = new Map<string, { phone: string | null; buildingType: string | null; address: string; postcode: string | null; state: string | null }>();
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
        postcode: dual<string | null>(r, 'postcode'),
        state: dual<string | null>(r, 'customer_state'),
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

  const dpByStopId = new Map<string, Record<string, unknown>>();
  {
    const stopIds = rawStops.map((s) => s.id);
    const { data: dpRows, error: dpErr } = await chunkIn<Record<string, unknown>>(stopIds, (batch, lo, hi) => scopeToAllowedCompanies(
      sb.from('dp_orders').select('id, trip_stop_id, address1, address2, address3, address4, city, postcode, state').in('trip_stop_id', batch).order('id'), c,
    ).range(lo, hi));
    if (dpErr) return c.json({ error: 'load_failed', reason: dpErr.message }, 500);
    await fillDpRowsPostcode(sb, dpRows);
    for (const d of dpRows) {
      const sid = dual<string | null>(d, 'trip_stop_id');
      if (sid) dpByStopId.set(String(sid), d);
    }
  }
  const snapshotFields = (address: string | null) => ({ lines: [address], city: null, postcode: null, state: null });
  const snapshotKnown = await localitiesForPostcodes(sb, rawStops
    .filter((s) => !dpByStopId.has(s.id) && !(s.do_id && soDocByDoId.has(s.do_id)))
    .flatMap((s) => postcodesToLookUp(snapshotFields(s.address))));

  const enrichByStopId = new Map<string, StopEnrichment>();
  const geoAddrByStopId = new Map<string, string>();
  const podByStopId = new Map<string, { delivered: boolean; hasPod: boolean }>();
  for (const s of rawStops) {
    const soDoc = s.do_id ? soDocByDoId.get(s.do_id) ?? null : null;
    if (s.do_id) { const m = podByDoId.get(s.do_id); if (m) podByStopId.set(s.id, m); }
    const so = soDoc ? soByDoc.get(soDoc) ?? null : null;
    const houseType = so?.buildingType ?? null;
    const win = houseType ? windowByType.get(houseType.trim().toLowerCase()) ?? null : null;
    const dp = dpByStopId.get(s.id) ?? null;
    const place = dp
      ? { postcode: (dp.postcode as string | null) ?? null, state: (dp.state as string | null) ?? null }
      : so
        ? { postcode: so.postcode, state: so.state }
        : fillPostcodeFields(snapshotFields(s.address), snapshotKnown);
    enrichByStopId.set(s.id, {
      phone: so?.phone ?? null,
      houseType,
      earliestTime: win?.earliest ?? null,
      latestTime: win?.latest ?? null,
      accessNote: win?.note ?? null,
      postcode: place.postcode,
      state: place.state,
    });
    const addr = (so?.address && so.address.trim() !== '') ? so.address : (s.address ?? '');
    if (addr.trim() !== '') geoAddrByStopId.set(s.id, addr);
  }

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
    enrichByStopId, geoByStopId, depotByWarehouseId, podByStopId,
  });

  return c.json({ date, configured, warehouses, trips: dayTrips });
});

type PackLines = { items: PackItemRow[]; racks: PackLabelRow[]; soItems: PackSoItemRow[] };

/* The lines of delivery orders already read under the company predicate, the racks they were picked
   from and the SO lines they were cut from. Every read is scoped and chunked: rack_id lands in a line
   straight off a request body, so resolving it by id alone lets one company's paperwork name the
   other company's bay (docs/bugs/0497). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client, as everywhere in this file
async function loadPackLines(sb: any, c: CompanyScopeCtx, dos: readonly WorkedOutDo[]): Promise<PackLines | { error: string }> {
  const doIds = dos.map((d) => d.id);
  if (doIds.length === 0) return { items: [], racks: [], soItems: [] };
  const { data: itemData, error: itemErr } = await chunkIn<Record<string, unknown>>(doIds, (batch, lo, hi) =>
    scopeToAllowedCompanies(
      sb.from('delivery_order_items')
        .select('id, delivery_order_id, line_no, item_code, description, description2, item_group, variants, qty, rack_id, shipped_from, so_item_id, committed_po_batch_no')
        .in('delivery_order_id', batch).range(lo, hi),
      c,
    ));
  if (itemErr) return { error: itemErr.message };
  const rows = (itemData ?? []) as Array<Record<string, unknown>>;
  /* PO and Rack of a line with no dispatch stamp yet: worked out by the DO detail's own rule,
     batched over the whole day (owner 2026-11-28, VPC9058: every mattress and accessory line
     printed a dash while the DO showed its PO). */
  const worked = await resolveWorkedOutSources(sb, dos, rows.map((it) => ({
    id: String(dual<string>(it, 'id')),
    delivery_order_id: String(dual<string>(it, 'delivery_order_id')),
    item_code: dual<string | null>(it, 'item_code'),
    item_group: dual<string | null>(it, 'item_group'),
    variants: (dual<VariantAttrs | null>(it, 'variants') ?? null),
    so_item_id: dual<string | null>(it, 'so_item_id'),
    rack_id: dual<string | null>(it, 'rack_id'),
  })), () => scopeToAllowedCompanies(sb.from('warehouse_rack_movements').select('source_doc_no, item_code, rack_label'), c));
  const items: PackItemRow[] = rows.map((it) => ({
    delivery_order_id: String(dual<string>(it, 'delivery_order_id')),
    line_no: toNumericOrNull(dual(it, 'line_no')),
    item_code: dual<string | null>(it, 'item_code'),
    description: dual<string | null>(it, 'description'),
    qty: toNumericOrNull(dual(it, 'qty')),
    rack_id: dual<string | null>(it, 'rack_id'),
    shipped_from: dual<unknown>(it, 'shipped_from') ?? null,
    item_group: dual<string | null>(it, 'item_group'),
    variants: (dual<Record<string, unknown> | null>(it, 'variants') ?? null),
    description2: dual<string | null>(it, 'description2'),
    so_item_id: dual<string | null>(it, 'so_item_id'),
    committed_po_batch_no: dual<string | null>(it, 'committed_po_batch_no'),
    worked: (() => {
      const w = worked.byLine.get(String(dual<string>(it, 'id')));
      return w ? { pos: w.source_pos, racks: w.racks } : null;
    })(),
  }));

  const rackIds = [...new Set(items.map((i) => i.rack_id).filter((v): v is string => !!v))];
  let racks: PackLabelRow[] = [];
  if (rackIds.length > 0) {
    const { data: rackData, error: rackErr } = await chunkIn<Record<string, unknown>>(rackIds, (batch, lo, hi) =>
      scopeToAllowedCompanies(
        sb.from('warehouse_racks').select('id, rack').in('id', batch).range(lo, hi),
        c,
      ));
    if (rackErr) return { error: rackErr.message };
    racks = ((rackData ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(dual<string>(r, 'id')),
      label: dual<string | null>(r, 'rack'),
    }));
  }

  const soItemIds = [...new Set(items.map((i) => i.so_item_id).filter((v): v is string => !!v))];
  let soItems: PackSoItemRow[] = [];
  if (soItemIds.length > 0) {
    const { data: soItemData, error: soItemErr } = await chunkIn<Record<string, unknown>>(soItemIds, (batch, lo, hi) =>
      scopeToAllowedCompanies(
        sb.from('mfg_sales_order_items').select('id, doc_no, line_no').in('id', batch).range(lo, hi),
        c,
      ));
    if (soItemErr) return { error: soItemErr.message };
    soItems = ((soItemData ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(dual<string>(r, 'id')),
      doc_no: dual<string | null>(r, 'doc_no'),
      line_no: toNumericOrNull(dual(r, 'line_no')),
    }));
  }
  return { items, racks, soItems };
}

/* ──────────────────────────────────────────────────────────────────────────
   GET /trips/packing         — one day's PACKING LISTS, one per lorry.
   GET /trips/packing-regions — the same day by Delivery Planning region.

   Both read ONE day through loadPackingDay. Production (2026-11-27) puts
   customer DOs on a lorry through the Delivery Planning board crew
   (scm.delivery_order_crew, its lorry_plate), not through trips: the day's
   trips carried only TRANSFER stops. So the day is every open DO whose Sales
   Order's board Delivery Date (amended ?? customer) is the date, every DO whose
   own customer_delivery_date is the date, and every DO that is a stop on a
   non-cancelled trip dated that day.
   A lorry is the trip's lorry, else the crew's plate, else the DO's vehicle.
   Trip lists that carry DOs keep their stop order; every other DO with a plate
   is grouped by plate (packing-day-view.ts, pure).

   COMPANY PREDICATES. The SCM client is service-role and mig 0061 enabled RLS
   with no policies, so the predicate in the statement is the entire tenant
   boundary: another company's delivery orders (docs/bugs/0496) and RACKS
   (docs/bugs/0497). trip_stops has no company_id (mig 0053) and is scoped by
   trip_id over trips scoped one statement earlier. Every id list is chunked.

   A crew-scoped caller (driver, helper) sees only the DOs on their own trips
   or whose board crew names them.

   MUST stay registered BEFORE '/:id', which would otherwise swallow it.
   ─────────────────────────────────────────────────────────────────────────*/
const DAY_DO_COLS = 'id, company_id, do_number, status, so_doc_no, debtor_code, debtor_name, address1, address2, city, postcode, state, customer_state, customer_country, phone, time_range, m3_total_milli, vehicle, driver_name, warehouse_id';

type PackingDay = {
  tripLists: PackingList[];
  dayDos: PackingDayDo[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client, as everywhere in this file
export async function loadPackingDay(sb: any, c: CompanyScopeCtx, date: string, warehouseId: string | null): Promise<PackingDay | { error: string }> {
  const { data: tripData, error: tripErr } = await paginateAll<Record<string, unknown>>((lo, hi) => {
    let q = sb.from('trips')
      .select('id, trip_no, trip_date, status, lorry_id, driver_id, helper_1_id, helper_2_id, warehouse_id')
      .eq('trip_date', date).neq('status', 'CANCELLED')
      .order('trip_no', { ascending: true }).range(lo, hi);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    return scopeToAllowedCompanies(q, c);
  });
  if (tripErr) return { error: tripErr.message };

  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const packPlates = await platesForTripRows(sb, scope, tripData ?? []);
  const scopedTrips = (scope.mode === 'all'
    ? (tripData ?? [])
    : (tripData ?? []).filter((r) => scopeMatchesAssignment(scope, tripAssignment(r, packPlates))));
  const packTrips: PackTripRow[] = scopedTrips.map((r) => ({
    id: String(dual<string>(r, 'id')),
    trip_no: dual<string | null>(r, 'trip_no'),
    trip_date: dual<string | null>(r, 'trip_date'),
    status: dual<string | null>(r, 'status'),
    lorry_id: dual<string | null>(r, 'lorry_id'),
    driver_id: dual<string | null>(r, 'driver_id'),
    helper_1_id: dual<string | null>(r, 'helper_1_id'),
    helper_2_id: dual<string | null>(r, 'helper_2_id'),
    warehouse_id: dual<string | null>(r, 'warehouse_id'),
  }));

  const tripIds = packTrips.map((t) => t.id);
  const { data: stopData, error: stopErr } = await chunkIn<Record<string, unknown>>(tripIds, (batch, lo, hi) =>
    sb.from('trip_stops')
      .select('id, trip_id, stop_no, stop_type, do_id, customer_name, address')
      .in('trip_id', batch).range(lo, hi));
  if (stopErr) return { error: stopErr.message };
  const packStops: PackStopRow[] = (stopData as Array<Record<string, unknown>>).map((s) => ({
    id: String(dual<string>(s, 'id')),
    trip_id: String(dual<string>(s, 'trip_id')),
    stop_no: toNumericOrNull(dual(s, 'stop_no')),
    stop_type: dual<string | null>(s, 'stop_type'),
    do_id: dual<string | null>(s, 'do_id'),
    customer_name: dual<string | null>(s, 'customer_name'),
    address: dual<string | null>(s, 'address'),
  }));
  const stopDoIds = [...new Set(packStops.map((s) => s.do_id).filter((v): v is string => !!v))];

  const doRows = new Map<string, Record<string, unknown>>();
  const keep = (rows: readonly Record<string, unknown>[]) => { for (const r of rows) doRows.set(String(dual<string>(r, 'id')), r); };
  const { data: onTrip, error: onTripErr } = await chunkIn<Record<string, unknown>>(stopDoIds, (batch, lo, hi) =>
    scopeToAllowedCompanies(
      sb.from('delivery_orders').select(DAY_DO_COLS).in('id', batch).neq('status', 'CANCELLED').range(lo, hi),
      c,
    ));
  if (onTripErr) return { error: onTripErr.message };
  keep(onTrip);
  const { data: dated, error: datedErr } = await paginateAll<Record<string, unknown>>((lo, hi) => {
    let q = sb.from('delivery_orders').select(DAY_DO_COLS)
      .eq('customer_delivery_date', date).neq('status', 'CANCELLED')
      .order('id', { ascending: true }).range(lo, hi);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    return scopeToAllowedCompanies(q, c);
  });
  if (datedErr) return { error: datedErr.message };
  keep(dated ?? []);

  // The day a DO actually goes out is its Sales Order's Delivery Date on the
  // Delivery Planning board (amended, else the customer's). Production DOs cut
  // before #6126 carry the old SO date on the DO itself, so the board date is
  // the one that matches the lorry the board crew put them on. Open DOs only:
  // a DO already delivered on another day of the same order stays on that day.
  const { data: soDay, error: soDayErr } = await paginateAll<Record<string, unknown>>((lo, hi) =>
    scopeToAllowedCompanies(
      sb.from('mfg_sales_orders').select('doc_no')
        .or(`amended_delivery_date.eq.${date},and(amended_delivery_date.is.null,customer_delivery_date.eq.${date})`)
        .order('doc_no', { ascending: true }).range(lo, hi),
      c,
    ));
  if (soDayErr) return { error: soDayErr.message };
  const soDocs = [...new Set((soDay ?? []).map((r) => String(dual<string>(r, 'doc_no'))).filter(Boolean))];
  const { data: bySo, error: bySoErr } = await chunkIn<Record<string, unknown>>(soDocs, (batch, lo, hi) => {
    let q = sb.from('delivery_orders').select(DAY_DO_COLS)
      .in('so_doc_no', batch).neq('status', 'CANCELLED').range(lo, hi);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    return scopeToAllowedCompanies(q, c);
  });
  if (bySoErr) return { error: bySoErr.message };
  const arrived = new Set<string>(DO_ARRIVED_STATES);
  keep(bySo.filter((r) => !arrived.has(String(dual<string | null>(r, 'status') ?? '').toUpperCase())));

  const allDoIds = [...doRows.keys()];
  const { data: crewData, error: crewErr } = await chunkIn<Record<string, unknown>>(allDoIds, (batch, lo, hi) =>
    scopeToAllowedCompanies(
      sb.from('delivery_order_crew')
        .select('do_id, lorry_plate, driver_1_id, driver_2_id, helper_1_id, helper_2_id, driver_1_name, driver_1_contact, helper_1_name, helper_2_name')
        .in('do_id', batch).range(lo, hi),
      c,
    ));
  if (crewErr) return { error: crewErr.message };

  if (scope.mode !== 'all') {
    const visible = new Set(stopDoIds);
    for (const cr of crewData) {
      const assignment = {
        driverIds: [dual<string | null>(cr, 'driver_1_id'), dual<string | null>(cr, 'driver_2_id')],
        helperIds: [dual<string | null>(cr, 'helper_1_id'), dual<string | null>(cr, 'helper_2_id')],
        lorryPlate: dual<string | null>(cr, 'lorry_plate'),
      };
      if (scopeMatchesAssignment(scope, assignment)) visible.add(String(dual<string>(cr, 'do_id')));
    }
    for (const id of allDoIds) if (!visible.has(id)) doRows.delete(id);
  }

  const dos = [...doRows.values()];
  const packDos: PackDoRow[] = dos.map((d) => ({
    id: String(dual<string>(d, 'id')),
    do_number: dual<string | null>(d, 'do_number'),
    status: dual<string | null>(d, 'status'),
    m3_total_milli: toNumericOrNull(dual(d, 'm3_total_milli')),
    so_doc_no: dual<string | null>(d, 'so_doc_no'),
    phone: dual<string | null>(d, 'phone'),
    time_range: dual<string | null>(d, 'time_range'),
  }));
  const dayDoRows: DayDoRow[] = dos.map((d) => ({
    id: String(dual<string>(d, 'id')),
    do_number: dual<string | null>(d, 'do_number'),
    status: dual<string | null>(d, 'status'),
    so_doc_no: dual<string | null>(d, 'so_doc_no'),
    debtor_code: dual<string | null>(d, 'debtor_code'),
    debtor_name: dual<string | null>(d, 'debtor_name'),
    address1: dual<string | null>(d, 'address1'),
    address2: dual<string | null>(d, 'address2'),
    city: dual<string | null>(d, 'city'),
    postcode: dual<string | null>(d, 'postcode'),
    state: dual<string | null>(d, 'state'),
    customer_state: dual<string | null>(d, 'customer_state'),
    customer_country: dual<string | null>(d, 'customer_country'),
    phone: dual<string | null>(d, 'phone'),
    time_range: dual<string | null>(d, 'time_range'),
    m3_total_milli: toNumericOrNull(dual(d, 'm3_total_milli')),
    vehicle: dual<string | null>(d, 'vehicle'),
    driver_name: dual<string | null>(d, 'driver_name'),
  }));
  const crew: DayCrewRow[] = crewData.map((cr) => ({
    do_id: String(dual<string>(cr, 'do_id')),
    lorry_plate: dual<string | null>(cr, 'lorry_plate'),
    driver_1_name: dual<string | null>(cr, 'driver_1_name'),
    driver_1_contact: dual<string | null>(cr, 'driver_1_contact'),
    helper_1_name: dual<string | null>(cr, 'helper_1_name'),
    helper_2_name: dual<string | null>(cr, 'helper_2_name'),
  }));

  const lines = await loadPackLines(sb, c, dos.map((d) => {
    const companyId = toNumericOrNull(dual(d, 'company_id'));
    return {
      id: String(dual<string>(d, 'id')),
      do_number: dual<string | null>(d, 'do_number'),
      warehouse_id: dual<string | null>(d, 'warehouse_id'),
      company_id: companyId ?? undefined,
    };
  }));
  if ('error' in lines) return { error: lines.error };

  /* company-scope: crew masters, by id off trips scoped above (the same lookup /trips/day
     does). A helper can belong to the other company — Houzs crew run 2990's
     trips — so the id from a scoped trip is the boundary here, not company_id. */
  const helperIds = [...new Set(packTrips.flatMap((t) => [t.helper_1_id, t.helper_2_id]).filter((v): v is string => !!v))];
  const [lry, drv, wh, hlp] = await Promise.all([
    sb.from('lorries').select('id, plate'),
    sb.from('drivers').select('id, name, phone'),
    sb.from('warehouses').select('id, name'),
    helperIds.length > 0
      ? sb.from('helpers').select('id, name, contact').in('id', helperIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);
  const toCrew = (rows: unknown, phoneCol: string): PackCrewRow[] =>
    ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(dual<string>(r, 'id')),
      name: dual<string | null>(r, 'name'),
      phone: dual<string | null>(r, phoneCol),
    }));
  const toLabels = (rows: unknown, col: string): PackLabelRow[] =>
    ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(dual<string>(r, 'id')),
      label: dual<string | null>(r, col),
    }));
  const lorries = toLabels(lry.data, 'plate');

  const tripLists = assemblePackingLists({
    trips: packTrips,
    stops: packStops,
    deliveryOrders: packDos,
    ...lines,
    lorries,
    drivers: toCrew(drv.data, 'phone'),
    helpers: toCrew(hlp.data, 'contact'),
    warehouses: toLabels(wh.data, 'name'),
  });
  const tripStops: DayTripStop[] = [];
  for (const l of tripLists) {
    for (const s of l.stops) if (s.do_id) tripStops.push({ do_id: s.do_id, trip_no: l.trip_no, stop_no: s.stop_no, lorry_plate: l.lorry_plate });
  }
  const dayDos = assemblePackingDay({ deliveryOrders: dayDoRows, crew, tripStops, ...lines });
  return { tripLists, dayDos };
}

trips.get('/packing', async (c) => {
  const sb = c.get('supabase');
  const date = c.req.query('date');
  const warehouseId = c.req.query('warehouseId') ?? null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'invalid_date', reason: 'date=YYYY-MM-DD is required' }, 400);
  }
  const day = await loadPackingDay(sb, c, date, warehouseId);
  if ('error' in day) return c.json({ error: 'load_failed', reason: day.error }, 500);
  return c.json({ date, lists: mergeLorryLists(date, day.tripLists, day.dayDos) });
});

trips.get('/packing-regions', async (c) => {
  const sb = c.get('supabase');
  const date = c.req.query('date');
  const unassignedOnly = c.req.query('unassignedOnly') === '1';
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'invalid_date', reason: 'date=YYYY-MM-DD is required' }, 400);
  }
  const day = await loadPackingDay(sb, c, date, null);
  if ('error' in day) return c.json({ error: 'load_failed', reason: day.error }, 500);
  const regionCfg = await loadRegionConfig(sb);
  return c.json({ date, unassigned_only: unassignedOnly, regions: assemblePackingRegions(regionCfg, day.dayDos, unassignedOnly) });
});

const DO_DELIVERED = [...DO_ARRIVED_STATES];

trips.get('/history', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return c.json({ error: 'invalid_range', reason: 'from & to (YYYY-MM-DD) are required' }, 400);
  }
  const sb = c.get('supabase');
  const { data: doData, error } = await scopeToAllowedCompanies(
    sb.from('delivery_orders')
      .select('id, do_number, so_doc_no, debtor_name, do_date, delivered_at, local_total_sen, time_range, pod_r2_key, pod_photo_keys')
      .gte('do_date', from).lte('do_date', to).in('status', DO_DELIVERED),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const dos = doData as Array<Record<string, unknown>>;

  const ids = dos.map((d) => String(d.id));
  const crewByDo = new Map<string, { plate: string | null; driver: string | null }>();
  if (ids.length) {
    const { data: crew, error: crewErr } = await chunkIn<Record<string, unknown>>(ids, (batch) =>
      sb.from('delivery_order_crew').select('do_id, lorry_plate, driver_1_name').in('do_id', batch));
    if (crewErr) return c.json({ error: 'load_failed', reason: crewErr.message }, 500);
    for (const cr of crew) {
      crewByDo.set(String(cr.do_id), { plate: (cr.lorry_plate as string | null) ?? null, driver: (cr.driver_1_name as string | null) ?? null });
    }
  }

  const rows = dos.map((d) => {
    const crew = crewByDo.get(String(d.id)) ?? { plate: null, driver: null };
    const keys = d.pod_photo_keys;
    const hasPod = Array.isArray(keys) ? keys.length > 0 : !!d.pod_r2_key;
    return {
      day: String(d.do_date ?? '').slice(0, 10),
      soDocNo: (d.so_doc_no as string | null) ?? null,
      doNumber: (d.do_number as string | null) ?? null,
      customer: (d.debtor_name as string | null) ?? null,
      slot: (d.time_range as string | null) ?? null,
      doneAt: (d.delivered_at as string | null) ?? (d.do_date as string | null) ?? null,
      amountSen: Number(d.local_total_sen) || 0,
      hasPod,
      plate: crew.plate,
      driver: crew.driver,
    };
  });
  return c.json({ rows });
});

trips.get('/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const [t, s] = await Promise.all([
    scopeToAllowedCompanies(sb.from('trips').select(TRIP_COLS).eq('id', id), c).maybeSingle(),
    scopeToAllowedCompanies(
      sb.from('trip_stops').select(STOP_COLS).eq('trip_id', id).order('stop_no', { ascending: true }), c,
    ),
  ]);
  if (t.error) return c.json({ error: 'load_failed', reason: t.error.message }, 500);
  if (!t.data) return c.json({ error: 'not_found' }, 404);
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const onePlate = await platesForTripRows(sb, scope, [t.data as unknown as Record<string, unknown>]);
  if (scope.mode === 'self' && !scopeMatchesAssignment(scope, tripAssignment(t.data as unknown as Record<string, unknown>, onePlate))) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ trip: t.data, stops: s.data ?? [] });
});

const tripCreateSchema = z.object({
  tripDate: z.string().min(8),
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
  plannedDepartAt: z.string().nullable().optional(),
  totalDistanceKm: z.union([z.number(), z.string()]).nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const patchTripHandler = async (c: any) => {
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
  if (p.clockInAt !== undefined) updates.clock_in_at = dateOrNull(p.clockInAt);
  if (p.clockOutAt !== undefined) updates.clock_out_at = dateOrNull(p.clockOutAt);
  if (p.plannedDepartAt !== undefined) updates.planned_depart_at = dateOrNull(p.plannedDepartAt);
  if (p.totalDistanceKm !== undefined) updates.total_distance_km = toNumericOrNull(p.totalDistanceKm);
  if (p.notes !== undefined) updates.notes = p.notes;
  if (p.isOutsourced !== undefined) {
    updates.is_outsourced = p.isOutsourced;
  } else if (p.lorryId !== undefined) {
    updates.is_outsourced = await deriveOutsourced(sb, p.lorryId);
  }
  if (Object.keys(updates).length === 1) return c.json({ error: 'no_changes' }, 400);

  const { data, error } = await scopeToAllowedCompanies(
    sb.from('trips').update(updates).eq('id', id), c,
  ).select(TRIP_COLS).maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json({ error: 'not_found' }, 404);
  if (p.driverId !== undefined || p.helper1Id !== undefined || p.helper2Id !== undefined || p.lorryId !== undefined) {
    const syncErr = await syncTripCrewToDos(sb, id, null, c.get('user')?.id ?? null).then(() => null, (e: Error) => String(e.message).slice(0, 160));
    if (syncErr) return c.json({ trip: data, crewSyncError: syncErr });
  }
  return c.json({ trip: data });
};
trips.patch('/:id', patchTripHandler);

export const patchTripStatusHandler = async (c: any) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const status = String(body.status ?? '').toUpperCase();
  if (!TRIP_STATUSES.has(status)) return c.json({ error: 'invalid_status' }, 400);

  const sb = c.get('supabase');
  // company-scope: widened to the caller's ALLOWED companies, same set GET /
  // lists under - see the COMPANY BOUND note on PATCH /:id above.
  const { data: cur } = await scopeToAllowedCompanies(
    sb.from('trips').select('clock_in_at, clock_out_at, driver_id, helper_1_id, helper_2_id, lorry_id').eq('id', id), c,
  ).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  {
    const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
    const curPlate = await platesForTripRows(sb, scope, [cur as Record<string, unknown>]);
    if (scope.mode === 'self' && !scopeMatchesAssignment(scope, tripAssignment(cur as Record<string, unknown>, curPlate))) {
      return c.json({ error: 'You can only update a delivery job assigned to you.' }, 403);
    }
  }
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status, updated_at: now };
  if (status === 'IN_PROGRESS' && !dual(cur as Record<string, unknown>, 'clock_in_at')) updates.clock_in_at = now;
  if (status === 'COMPLETED' && !dual(cur as Record<string, unknown>, 'clock_out_at')) updates.clock_out_at = now;

  const { data, error } = await scopeToAllowedCompanies(
    sb.from('trips').update(updates).eq('id', id), c,
  ).select(TRIP_COLS).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);

  if (status === 'CANCELLED') {
    const stops = await deliveryStopsOfTrip(sb, id);
    const reconcile = await reconcileStopsToBoard(sb, { stops, ...actorOf(c) });
    return c.json({ trip: data, ...reconcileFieldsFor(reconcile) });
  }
  return c.json({ trip: data });
};
trips.patch('/:id/status', patchTripStatusHandler);

const moveStopSchema = z.object({
  doId: z.string().uuid(),
  targetTripId: z.string().uuid(),
  position: z.number().int().min(1).max(999),
});

trips.post('/move-stop', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = moveStopSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const sb = c.get('supabase');

  const { data: movedRows, error: mErr } = await sb.from('trip_stops')
    .select('id, trip_id, company_id').eq('do_id', p.doId).eq('stop_type', 'DELIVERY');
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  const moved = ((movedRows ?? []) as Array<{ id: string; trip_id: string; company_id: number }>)[0];
  if (!moved) return c.json({ error: 'stop_not_found', reason: 'This order has no delivery stop on a run yet.' }, 404);
  const sourceTripId = String(moved.trip_id);
  const companyId = moved.company_id;

  const { data: tripRows, error: tErr } = await scopeToAllowedCompanies(
    sb.from('trips').select('id, trip_date, company_id').in('id', [sourceTripId, p.targetTripId]), c,
  );
  if (tErr) return c.json({ error: 'load_failed', reason: tErr.message }, 500);
  const found = (tripRows ?? []) as Array<{ id: string; trip_date: string | null }>;
  const srcTrip = found.find((t) => String(t.id) === sourceTripId);
  const tgtTrip = found.find((t) => String(t.id) === p.targetTripId);
  if (!srcTrip || !tgtTrip) return c.json({ error: 'trip_not_found', reason: 'A lorry run was not found for your company.' }, 404);
  if (String(srcTrip.trip_date).slice(0, 10) !== String(tgtTrip.trip_date).slice(0, 10)) {
    return c.json({ error: 'cross_day', reason: 'A stop can only move between runs on the same day.' }, 400);
  }

  const [{ data: srcStops }, { data: tgtStops }] = await Promise.all([
    sb.from('trip_stops').select('id, stop_no').eq('trip_id', sourceTripId),
    sb.from('trip_stops').select('id, stop_no').eq('trip_id', p.targetTripId),
  ]);
  const lite = (rows: unknown) => ((rows ?? []) as Array<{ id: string; stop_no: number | string }>)
    .map((r) => ({ id: String(r.id), stop_no: Number(r.stop_no) || 0 }));

  const updates = planStopMove({
    stopId: String(moved.id), sourceTripId, targetTripId: p.targetTripId, position: p.position,
    sourceStops: lite(srcStops), targetStops: lite(tgtStops),
  });
  if (updates.length === 0) return c.json({ ok: true, moved: 0 });

  let applied = 0; let failed = 0;
  for (const u of updates) {
    const patch: Record<string, unknown> = { stop_no: u.stop_no };
    if (u.trip_id) patch.trip_id = u.trip_id;
    const { error } = await sb.from('trip_stops').update(patch).eq('id', u.id).eq('company_id', companyId);
    if (error) failed += 1; else applied += 1;
  }
  return c.json({ ok: failed === 0, moved: applied, failed });
});

const stopCreateSchema = z.object({
  stopNo: z.number().int().positive().optional(),
  stopType: z.enum(['DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE']).default('DELIVERY'),
  doId: z.string().uuid().nullable().optional(),
  soId: z.string().uuid().nullable().optional(),
  soDocNo: z.string().nullable().optional(),
  customerName: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  revenueSen: z.number().int().nullable().optional(),
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

  const { data: trip } = await sb.from('trips').select('id').eq('id', tripId).maybeSingle();
  if (!trip) return c.json({ error: 'trip_not_found' }, 404);

  let revenue = p.revenueSen ?? null;
  let customerName = p.customerName ?? null;
  let address = p.address ?? null;
  let soId = p.soId ?? null;

  if (p.doId) {
    const { data: doRow } = await sb.from('delivery_orders')
      .select('local_total_sen, debtor_name, address1, address2').eq('id', p.doId).maybeSingle();
    if (doRow) {
      const r = doRow as Record<string, unknown>;
      if (revenue == null) revenue = Number(dual(r, 'local_total_sen') ?? 0);
      if (customerName == null) customerName = (dual<string>(r, 'debtor_name') ?? null);
      if (address == null) address = [dual<string>(r, 'address1'), dual<string>(r, 'address2')].filter(Boolean).join(', ') || null;
    }
  } else if (p.soDocNo) {
    const { data: soRow } = await sb.from('mfg_sales_orders')
      .select('id, local_total_sen, debtor_name, address1, address2').eq('doc_no', p.soDocNo).maybeSingle();
    if (soRow) {
      const r = soRow as Record<string, unknown>;
      if (soId == null) soId = dual<string>(r, 'id') ?? null;
      if (revenue == null) revenue = Number(dual(r, 'local_total_sen') ?? 0);
      if (customerName == null) customerName = (dual<string>(r, 'debtor_name') ?? null);
      if (address == null) address = [dual<string>(r, 'address1'), dual<string>(r, 'address2')].filter(Boolean).join(', ') || null;
    }
  }

  let stopNo = p.stopNo ?? null;
  if (stopNo == null) {
    const { data: existing } = await sb.from('trip_stops').select('stop_no').eq('trip_id', tripId);
    const max = ((existing ?? []) as Array<Record<string, unknown>>)
      .reduce((m, r) => Math.max(m, Number(dual(r, 'stop_no') ?? 0)), 0);
    stopNo = max + 1;
  }

  const { data, error } = await sb.from('trip_stops').insert({
    company_id:    activeCompanyId(c),
    trip_id:       tripId,
    stop_no:       stopNo,
    stop_type:     p.stopType,
    do_id:         p.doId ?? null,
    so_id:         soId,
    customer_name: customerName,
    address,
    revenue_sen: Math.max(0, Math.round(Number(revenue ?? 0)) || 0),
    notes:         p.notes ?? null,
  }).select(STOP_COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ stop: data }, 201);
});

export const deleteTripStopHandler = async (c: any) => {
  const tripId = c.req.param('id');
  const stopId = c.req.param('stopId');
  const sb = c.get('supabase');
  /* company-scope: scm.trip_stops carries company_id NOT NULL (mig 0083), so the
     stop is bounded on its OWN column - not merely inherited from the trip via
     .eq('trip_id'), which a caller supplies and which would let a stop from an
     out-of-scope trip be deleted by passing that trip's uuid. Widened to the
     allowed set, matching the trip reads. */
  const { data: stopRow } = await scopeToAllowedCompanies(
    sb.from('trip_stops').select('do_id, so_id, stop_type').eq('id', stopId).eq('trip_id', tripId), c,
  ).maybeSingle();
  if (!stopRow) return c.json({ error: 'not_found' }, 404);
  const { error } = await scopeToAllowedCompanies(
    sb.from('trip_stops').delete().eq('id', stopId).eq('trip_id', tripId), c,
  );
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

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
};
trips.delete('/:id/stops/:stopId', deleteTripStopHandler);

export const deleteTripHandler = async (c: any) => {
  const id = c.req.param('id');
  const hard = c.req.query('hard') === 'true';
  const sb = c.get('supabase');

  const stops = await deliveryStopsOfTrip(sb, id);

  /* company-scope: BOTH paths - see the COMPANY BOUND note on PATCH /:id. The
     hard path is the more dangerous of the two: trip_stops CASCADEs (mig 0053),
     so an unbounded DELETE by uuid took another company's stops with it. */
  if (hard) {
    const { data: own, error: ownErr } = await scopeToAllowedCompanies(
      sb.from('trips').select('id').eq('id', id), c,
    ).maybeSingle();
    if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return c.json({ error: 'not_found' }, 404);
    const { error } = await scopeToAllowedCompanies(sb.from('trips').delete().eq('id', id), c);
    if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
    const reconcile = await reconcileStopsToBoard(sb, { stops, ...actorOf(c) });
    return c.json({ ok: true, deleted: true, ...reconcileFieldsFor(reconcile) });
  }

  const { data, error } = await scopeToAllowedCompanies(
    sb.from('trips')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', id), c,
  ).select(TRIP_COLS).maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const reconcile = await reconcileStopsToBoard(sb, { stops, ...actorOf(c) });
  return c.json({ trip: data, cancelled: true, ...reconcileFieldsFor(reconcile) });
};
trips.delete('/:id', deleteTripHandler);

export const optimizeTripRouteHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const apply = c.req.query('apply') === 'true';

  /* company-scope: the trip gate for this whole handler. Everything below keys
     off `id` (the stop read, and the stop_no / total_distance_km write-back when
     ?apply=true), so bounding the trip here bounds the writes too - and an
     out-of-scope id stops before Google is called, which also means it cannot be
     used to bill the owner's Directions quota. */
  const t = await scopeToAllowedCompanies(
    sb.from('trips').select('id, warehouse_id').eq('id', id), c,
  ).maybeSingle();
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

  let applied = false;
  if (apply && result.ok && result.stops.length > 0) {
    const optimisedAt = new Date().toISOString();
    for (const st of result.stops) {
      await scopeToAllowedCompanies(sb.from('trip_stops').update({
        stop_no: st.order,
        leg_distance_m: st.legDistanceMetres,
        leg_duration_s: st.legDurationSeconds,
        eta_offset_s: st.etaSecondsFromDepart,
        route_optimised_at: optimisedAt,
      }).eq('id', st.ref).eq('trip_id', id), c);
    }
    await scopeToAllowedCompanies(sb.from('trips')
      .update({ total_distance_km: Math.round(result.totalDistanceMetres / 100) / 10, updated_at: optimisedAt })
      .eq('id', id), c);
    applied = true;
  }
  return c.json({ ...result, applied });
};
trips.post('/:id/optimize-route', optimizeTripRouteHandler);

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

  const points: LatLngPoint[] = [{ lat: depotOut.lat, lng: depotOut.lng }, ...geocoded.map((s) => ({ lat: s.lat, lng: s.lng }))];
  const matrix = await travelTimeMatrix(c.env, points);
  if (!matrix.ok) {
    return c.json({ configured: true, ok: false, reason: matrix.reason ?? 'travel matrix unavailable',
      departTime, depot: depotOut, stops: geocoded, ungeocoded, travelSeconds: [], distanceMetres: [], proposed: null });
  }

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


const LOCATION_COLS = 'trip_id, driver_id, lat, lng, accuracy_m, recorded_at, received_at';

trips.post('/:id/location', async (c) => {
  const tripId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const v = validatePing(body);
  if (!v.ok) return c.json({ error: 'invalid_ping', reason: v.error }, 400);

  const sb = c.get('supabase');
  // company-scope: crew-gated by pingCallerAllowed below; the trip read has no company predicate (open finding, tasks/TODO.md)
  const { data: trip } = await sb.from('trips')
    .select('id, status, company_id, driver_id, helper_1_id, helper_2_id, lorry_id')
    .eq('id', tripId).maybeSingle();
  if (!trip) return c.json({ error: 'trip_not_found' }, 404);
  const t = trip as Record<string, unknown>;

  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const pingPlate = await platesForTripRows(sb, scope, [t]);
  if (!pingCallerAllowed(scope, tripAssignment(t, pingPlate), c.get('scmWriteBypassed') === true)) {
    return c.json({ error: 'not_your_trip' }, 403);
  }

  const status = String(dual(t, 'status') ?? '').toUpperCase();
  if (!PING_ACCEPTED_STATUSES.has(status)) {
    return c.json({ ok: false, accepted: false, reason: 'trip_not_in_progress', status }, 409);
  }

  const driverId = (dual<string | null>(t, 'driver_id') ?? null);

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
    simulated:   (body as { simulated?: unknown } | null)?.simulated === true,
  });
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true, accepted: true });
});

trips.get('/:id/locations/latest', async (c) => {
  const tripId = c.req.param('id');
  const sb = c.get('supabase');

  const { data: trip } = await scopeToAllowedCompanies(
    sb.from('trips').select('id, driver_id, helper_1_id, helper_2_id, lorry_id').eq('id', tripId), c,
  ).maybeSingle();
  if (!trip) return c.json({ error: 'trip_not_found' }, 404);
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const latPlate = await platesForTripRows(sb, scope, [trip as Record<string, unknown>]);
  if (scope.mode === 'self' && !scopeMatchesAssignment(scope, tripAssignment(trip as Record<string, unknown>, latPlate))) {
    return c.json({ error: 'not_found' }, 404);
  }

  const { data, error } = await sb.from('trip_locations')
    .select(LOCATION_COLS).eq('trip_id', tripId)
    .order('recorded_at', { ascending: false }).limit(200);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ locations: latestPerDriver((data ?? []) as Array<Record<string, unknown>>) });
});

trips.get('/active/locations', async (c) => {
  const sb = c.get('supabase');

  let tripQ = sb.from('trips')
    .select('id, driver_id, helper_1_id, helper_2_id, lorry_id').eq('status', 'IN_PROGRESS');
  tripQ = scopeToAllowedCompanies(tripQ, c);
  const { data: activeTrips, error: tErr } = await tripQ;
  if (tErr) return c.json({ error: 'load_failed', reason: tErr.message }, 500);

  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const activePlates = await platesForTripRows(sb, scope, (activeTrips ?? []) as Array<Record<string, unknown>>);
  const visible = (activeTrips ?? []).filter((r) =>
    scope.mode === 'all' || scopeMatchesAssignment(scope, tripAssignment(r as Record<string, unknown>, activePlates)));
  const tripIds = visible.map((r) => dual<string>(r as Record<string, unknown>, 'id')).filter(Boolean);
  if (tripIds.length === 0) return c.json({ locations: [] });

  const { data, error } = await sb.from('trip_locations')
    .select(LOCATION_COLS).in('trip_id', tripIds)
    .order('recorded_at', { ascending: false }).limit(1000);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ locations: latestPerDriver((data ?? []) as Array<Record<string, unknown>>) });
});

export default trips;
