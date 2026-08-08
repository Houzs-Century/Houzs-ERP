// ----------------------------------------------------------------------------
// delivery-map-model.ts — PURE view-model folds for the Option B side map
// (owner decision 2026-08-08: LEFT board / RIGHT sticky map on Delivery Date
// Arrangement, Delivery Time Arrangement and Last Mile Delivery).
//
// The shared DeliveryMapPanel component stays thin: everything that turns API
// data into drawable pins / routes — zone colouring, geo-point → pin, proposal
// runs → polylines, staged trips → polylines, the trip-focus board filter and
// the totals line — lives here, unit-testable without React or a Google map.
// Presentation varies per page via the panel's props; the LOGIC is this file.
// ----------------------------------------------------------------------------

import type { PlanningOrder } from './delivery-planning-queries';
import type { DeliveryGeoPoint } from './delivery-geo-queries';
import type { AnonymousRun } from './anonymous-runs';
import { estWindowOf } from './anonymous-runs';
import { FLEET_ROUTE_COLORS } from './fleet-colors';
import { etaLabel } from './fleet-day-model';

export type MapLatLng = { lat: number; lng: number };

/** One order pin on the panel map. Colour keys off the postcode ZONE, falling
 *  back to the REGION bucket for unzoned orders — same fact the board's chips
 *  express. The `card` block feeds the hover/click mini card. */
export type MapPin = {
  ref: string;
  lat: number;
  lng: number;
  color: string;
  card: {
    soDocNo: string;
    customer: string | null;
    sets: number;
    revenueCenti: number;
    address: string | null;
    zone: string | null;
  };
};

/** One numbered stop on a route polyline. `windowLabel` is the per-stop time
 *  text (estimated delivery window on a proposal; ETA offset on a staged trip);
 *  null renders nothing — never a fabricated clock. */
export type MapRouteStop = {
  ref: string;
  lat: number;
  lng: number;
  order: number;
  label: string;
  windowLabel: string | null;
};

/** One coloured route (a proposed run / a staged or live trip). `crewLabel`
 *  carries the Last Mile plate/driver line; `allRefs` is EVERY order on the
 *  route (geocoded or not) — the trip-focus board filter reads it, so an
 *  unpinned stop still filters in. */
export type MapRoute = {
  id: string;
  color: string;
  title: string;
  crewLabel: string | null;
  depot: MapLatLng | null;
  stops: MapRouteStop[];
  allRefs: string[];
};

/** Trip focus (owner rule: click a trip card / polyline → dim the others, zoom
 *  to it, filter the board to its stops; click again → unfocus). */
export type MapFocus = { routeId: string; refs: string[] };

/* ── Zone colours ─────────────────────────────────────────────────────────────
   Deterministic per zone NAME so the same zone reads the same colour on every
   page and every day (assignRouteColors keys off load order, which shuffles
   between days — wrong tool here). The 14 canonical zones get hand-spread
   palette slots; an owner-added zone (open string) hashes into the palette. */
const ZONE_COLOR_INDEX: Record<string, number> = {
  KL: 0, PJ: 1, KLANG: 2, KAJANG: 3, RAWANG: 4, PUCHONG: 5,
  NS: 6, MELAKA: 7, JOHOR: 8, PENANG: 9, KEDAH: 0, PERAK: 3,
  PAHANG: 6, EAST: 8,
};
const FALLBACK_PIN_COLOR = '#64748b'; // slate — no zone AND no region resolved

export function zoneColorFor(zone: string | null | undefined, region?: string | null): string {
  const key = (zone ?? '').trim().toUpperCase() || (region ?? '').trim().toUpperCase();
  if (!key) return FALLBACK_PIN_COLOR;
  const idx = ZONE_COLOR_INDEX[key];
  if (idx != null) return FLEET_ROUTE_COLORS[idx % FLEET_ROUTE_COLORS.length];
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FLEET_ROUTE_COLORS[h % FLEET_ROUTE_COLORS.length];
}

/** Geo points → pins. PURE. Pin colour = zone (region fallback). */
export function pinsFromGeoPoints(points: readonly DeliveryGeoPoint[]): MapPin[] {
  return points.map((p) => ({
    ref: p.ref,
    lat: p.lat,
    lng: p.lng,
    color: zoneColorFor(p.zone, p.region),
    card: {
      soDocNo: p.so_doc_no,
      customer: p.customer,
      sets: p.sets,
      revenueCenti: p.revenueCenti,
      address: p.address ?? null,
      zone: p.zone,
    },
  }));
}

/** The small totals line beside the map — orders / sets / revenue. PURE. */
export function geoTotals(points: readonly DeliveryGeoPoint[]): { orders: number; sets: number; revenueCenti: number } {
  let sets = 0;
  let revenueCenti = 0;
  for (const p of points) { sets += p.sets; revenueCenti += p.revenueCenti; }
  return { orders: points.length, sets, revenueCenti };
}

/** Proposal runs → routes for ONE date (the Time page's "Propose time" view).
 *  Stop lat/lng joins through the geo points by ref; an unlocatable stop stays
 *  off the polyline but keeps its place in `allRefs` (focus still finds it).
 *  Stop windowLabel = the estimated delivery window (estWindowOf — Google leg
 *  ETA + installation + unload buffer), the same text the run card shows. */
export function routesFromRuns(
  runs: readonly AnonymousRun[],
  date: string,
  pointByRef: ReadonlyMap<string, MapLatLng>,
  depot: MapLatLng | null,
): MapRoute[] {
  const out: MapRoute[] = [];
  for (const run of runs) {
    if (run.date !== date) continue;
    const stops: MapRouteStop[] = [];
    for (const s of run.stops) {
      const pt = pointByRef.get(s.ref);
      if (!pt) continue;
      stops.push({
        ref: s.ref,
        lat: pt.lat,
        lng: pt.lng,
        order: s.order,
        label: s.debtorName ?? s.ref,
        windowLabel: estWindowOf(s),
      });
    }
    stops.sort((a, b) => a.order - b.order);
    out.push({
      id: run.key,
      color: FLEET_ROUTE_COLORS[(run.runNo - 1) % FLEET_ROUTE_COLORS.length],
      title: `Trip ${run.runNo}`,
      crewLabel: null,
      depot,
      stops,
      allRefs: run.stops.map((s) => s.ref),
    });
  }
  return out;
}

/** Staged live trips → routes for ONE date, off the server-stamped board rows
 *  (trip_id / trip_no / trip_stop_no / trip_eta_offset_s — the same columns
 *  the Time queue's run-time sort reads). Trips number "Trip 1..n" in trip_no
 *  order, matching the Time page's staging and the Last Mile ordinals. Stop
 *  windowLabel = the stop's ETA offset ("+1h 20m"); null when never routed. */
export function stagedRoutesFromRows(
  rows: readonly PlanningOrder[],
  date: string,
  pointByRef: ReadonlyMap<string, MapLatLng>,
  depot: MapLatLng | null,
): MapRoute[] {
  const byTrip = new Map<string, { tripNo: string | null; rows: PlanningOrder[] }>();
  for (const o of rows) {
    if (o.row_type !== 'so' || !o.trip_id) continue;
    if (String(o.trip_date ?? '').slice(0, 10) !== date) continue;
    const cur = byTrip.get(o.trip_id) ?? { tripNo: o.trip_no ?? null, rows: [] };
    cur.rows.push(o);
    if (cur.tripNo == null && o.trip_no) cur.tripNo = o.trip_no;
    byTrip.set(o.trip_id, cur);
  }
  const ordered = [...byTrip.entries()].sort((a, b) =>
    String(a[1].tripNo ?? '').localeCompare(String(b[1].tripNo ?? '')) || a[0].localeCompare(b[0]));
  return ordered.map(([tripId, t], i) => {
    const sortedRows = [...t.rows].sort((a, b) =>
      (a.trip_stop_no ?? Number.MAX_SAFE_INTEGER) - (b.trip_stop_no ?? Number.MAX_SAFE_INTEGER)
      || a.so_doc_no.localeCompare(b.so_doc_no));
    const stops: MapRouteStop[] = [];
    let order = 0;
    for (const o of sortedRows) {
      const pt = pointByRef.get(o.so_doc_no);
      order += 1;
      if (!pt) continue;
      stops.push({
        ref: o.so_doc_no,
        lat: pt.lat,
        lng: pt.lng,
        order,
        label: o.debtor_name ?? o.so_doc_no,
        windowLabel: o.trip_eta_offset_s != null ? etaLabel(o.trip_eta_offset_s) : null,
      });
    }
    return {
      id: tripId,
      color: FLEET_ROUTE_COLORS[i % FLEET_ROUTE_COLORS.length],
      title: `Trip ${i + 1}`,
      crewLabel: null,
      depot,
      stops,
      allRefs: sortedRows.map((o) => o.so_doc_no),
    };
  });
}

/** The trip-focus board filter. PURE. No focus → the rows unchanged; a focus →
 *  only the rows on the focused route (keyed by so_doc_no against `refs`, so a
 *  stop with no map pin still filters IN — focus narrows the board, never
 *  hides an order the route carries). Non-SO rows drop out under focus (a
 *  route carries SOs only). */
export function focusFilterRows<T extends Pick<PlanningOrder, 'row_type' | 'so_doc_no'>>(
  rows: readonly T[],
  focus: MapFocus | null,
): T[] {
  if (!focus) return [...rows];
  const wanted = new Set(focus.refs);
  return rows.filter((o) => o.row_type === 'so' && wanted.has(o.so_doc_no));
}

/** Toggle helper: clicking the focused trip again unfocuses. PURE. */
export function toggleFocus(current: MapFocus | null, next: MapFocus): MapFocus | null {
  return current && current.routeId === next.routeId ? null : next;
}

/* ── Column narrowing while the map is open (owner rule: the board auto-narrows
   to the essential columns; the full set returns when the map closes). These
   are DataGrid column KEYS on the shared DeliveryPlanningBoard. A render-time
   overlay — the user's own saved column prefs are never written. */
export const MAP_ESSENTIAL_COLUMNS: readonly string[] = [
  'so_doc_no', 'debtor_name', 'region', 'postcode',
  'customer_delivery_date', 'amended_delivery_date',
];
/** The Time page keeps its trip + window columns beside the essentials. */
export const MAP_ESSENTIAL_COLUMNS_TIME: readonly string[] = [
  ...MAP_ESSENTIAL_COLUMNS, 'trip_no', 'time_range',
];
/** Last Mile keeps the trip number (its rows all sit on a trip). */
export const MAP_ESSENTIAL_COLUMNS_LAST_MILE: readonly string[] = [
  ...MAP_ESSENTIAL_COLUMNS, 'trip_no',
];
