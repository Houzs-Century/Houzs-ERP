// ---------------------------------------------------------------------------
// fleet-day-view.ts — the PURE assembler behind GET /trips/day (Fleet Module A4).
//
// A4 is a READ / RENDER layer over trips that are ALREADY scheduled: pick a date
// (+ optional depot warehouse) and see every trip that day, each lorry's route on
// one map, and a printable per-lorry run-sheet. Nothing here schedules or writes
// — the trip + its stops came from scm.trips / scm.trip_stops (mig 0053), the
// customer / phone / house-type / revenue from the SO/DO the stop points at, and
// the delivery time window from scm.delivery_residence_rules (mig 0196).
//
// The DB reads (trips, stops, do->so resolution, residence rules, geocode cache,
// the driver/helper/lorry/warehouse masters) happen in the route handler; this
// file is the pure, deterministic SHAPING of those rows into the day-view model,
// so the grouping, ordering, totals and enrichment merge are unit-testable
// without a database or a Google key.
// ---------------------------------------------------------------------------

export interface MasterName {
  id: string;
  name: string;
}

export interface MasterLorry {
  id: string;
  plate: string;
}

export interface MasterWarehouse {
  id: string;
  name: string;
  code: string | null;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** A trip row, dual-read already resolved to plain snake_case fields. */
export interface RawTripRow {
  id: string;
  trip_no: string | null;
  trip_date: string | null;
  status: string | null;
  is_outsourced: boolean | null;
  lorry_id: string | null;
  driver_id: string | null;
  helper_1_id: string | null;
  helper_2_id: string | null;
  warehouse_id: string | null;
  total_distance_km: number | string | null;
}

/** A trip_stop row, dual-read already resolved. */
export interface RawStopRow {
  id: string;
  trip_id: string;
  stop_no: number | null;
  stop_type: string | null;
  do_id: string | null;
  so_id: string | null;
  customer_name: string | null;
  address: string | null;
  revenue_sen: number | null;
  eta_offset_s: number | null;
  leg_distance_m: number | null;
}

/** Per-stop enrichment resolved from the stop's source SO (via its DO) + the
 *  residence-rule window for its building/house type. All optional — a stop with
 *  no resolvable source keeps its snapshot fields and shows blanks for the rest. */
export interface StopEnrichment {
  phone: string | null;
  houseType: string | null;
  earliestTime: string | null;
  latestTime: string | null;
  accessNote: string | null;
}

export interface DayStop {
  id: string;
  stop_no: number;
  stop_type: string;
  customer_name: string | null;
  address: string | null;
  phone: string | null;
  house_type: string | null;
  earliest_time: string | null;
  latest_time: string | null;
  access_note: string | null;
  eta_offset_s: number | null;
  leg_distance_m: number | null;
  revenue_sen: number;
  lat: number | null;
  lng: number | null;
  geocoded: boolean;
}

export interface DayTrip {
  id: string;
  trip_no: string | null;
  trip_date: string | null;
  status: string;
  is_outsourced: boolean;
  total_distance_km: number | null;
  lorry: MasterLorry | null;
  driver: MasterName | null;
  helpers: MasterName[];
  warehouse: MasterWarehouse | null;
  depot: LatLng | null;
  total_revenue_sen: number;
  total_drops: number;
  stops: DayStop[];
}

export interface AssembleInput {
  trips: RawTripRow[];
  stops: RawStopRow[];
  driversById: Map<string, MasterName>;
  helpersById: Map<string, MasterName>;
  lorriesById: Map<string, MasterLorry>;
  warehousesById: Map<string, MasterWarehouse>;
  /** stopId -> enrichment (phone / house type / window). Missing = no source. */
  enrichByStopId: Map<string, StopEnrichment>;
  /** stopId -> geocoded point. Missing = could not geocode / no key. */
  geoByStopId: Map<string, LatLng>;
  /** warehouseId -> geocoded depot point. Missing = no depot geocode. */
  depotByWarehouseId: Map<string, LatLng>;
}

const EMPTY_ENRICH: StopEnrichment = {
  phone: null, houseType: null, earliestTime: null, latestTime: null, accessNote: null,
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Shape the day's trips into the render model. PURE.
 *
 * - Stops are grouped to their trip and ordered by stop_no (a null stop_no sorts
 *   last, keeping an un-numbered stop visible rather than dropping it).
 * - total_drops counts DELIVERY stops only (a supplier pickup is not a drop); the
 *   full ordered stop list is still returned so the map + run-sheet show every leg.
 * - total_revenue_sen sums revenue_sen over ALL stops (the trip's delivery
 *   value, the same figure lorry-capacity aggregates).
 * - A stop is `geocoded` only when a real point resolved; otherwise lat/lng are
 *   null and the map omits its pin — honest "not located", never a fabricated 0,0.
 */
export function assembleDayView(input: AssembleInput): { trips: DayTrip[] } {
  const {
    trips, stops, driversById, helpersById, lorriesById, warehousesById,
    enrichByStopId, geoByStopId, depotByWarehouseId,
  } = input;

  const stopsByTrip = new Map<string, RawStopRow[]>();
  for (const s of stops) {
    const arr = stopsByTrip.get(s.trip_id);
    if (arr) arr.push(s); else stopsByTrip.set(s.trip_id, [s]);
  }

  const dayTrips: DayTrip[] = trips.map((t) => {
    const raw = (stopsByTrip.get(t.id) ?? []).slice().sort((a, b) => {
      const an = a.stop_no == null ? Number.POSITIVE_INFINITY : a.stop_no;
      const bn = b.stop_no == null ? Number.POSITIVE_INFINITY : b.stop_no;
      return an - bn;
    });

    let totalRevenue = 0;
    let drops = 0;
    const dayStops: DayStop[] = raw.map((s, idx) => {
      const enrich = enrichByStopId.get(s.id) ?? EMPTY_ENRICH;
      const geo = geoByStopId.get(s.id) ?? null;
      const rev = Math.max(0, Math.round(num(s.revenue_sen)));
      totalRevenue += rev;
      const stopType = (s.stop_type ?? 'DELIVERY').toUpperCase();
      if (stopType === 'DELIVERY') drops += 1;
      return {
        id: s.id,
        stop_no: s.stop_no == null ? idx + 1 : s.stop_no,
        stop_type: stopType,
        customer_name: s.customer_name ?? null,
        address: s.address ?? null,
        phone: enrich.phone,
        house_type: enrich.houseType,
        earliest_time: enrich.earliestTime,
        latest_time: enrich.latestTime,
        access_note: enrich.accessNote,
        eta_offset_s: s.eta_offset_s ?? null,
        leg_distance_m: s.leg_distance_m ?? null,
        revenue_sen: rev,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        geocoded: geo != null,
      };
    });

    const lorry = t.lorry_id ? lorriesById.get(t.lorry_id) ?? null : null;
    const driver = t.driver_id ? driversById.get(t.driver_id) ?? null : null;
    const helpers = [t.helper_1_id, t.helper_2_id]
      .filter((h): h is string => !!h)
      .map((h) => helpersById.get(h))
      .filter((h): h is MasterName => !!h);
    const warehouse = t.warehouse_id ? warehousesById.get(t.warehouse_id) ?? null : null;
    const depot = t.warehouse_id ? depotByWarehouseId.get(t.warehouse_id) ?? null : null;
    const distKm = t.total_distance_km == null ? null : (Number.isFinite(Number(t.total_distance_km)) ? Number(t.total_distance_km) : null);

    return {
      id: t.id,
      trip_no: t.trip_no ?? null,
      trip_date: t.trip_date ?? null,
      status: (t.status ?? 'PLANNED').toUpperCase(),
      is_outsourced: t.is_outsourced === true,
      total_distance_km: distKm,
      lorry,
      driver,
      helpers,
      warehouse,
      depot,
      total_revenue_sen: totalRevenue,
      total_drops: drops,
      stops: dayStops,
    };
  });

  // Stable display order: by trip_no so the side panel + colour assignment are
  // deterministic across reloads (colour is assigned by the frontend off this).
  dayTrips.sort((a, b) => String(a.trip_no ?? '').localeCompare(String(b.trip_no ?? '')));
  return { trips: dayTrips };
}
