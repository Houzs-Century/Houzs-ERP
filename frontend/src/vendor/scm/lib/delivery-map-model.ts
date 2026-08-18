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
    revenueSen: number;
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
      revenueSen: p.revenueSen,
      address: p.address ?? null,
      zone: p.zone,
    },
  }));
}

/** The small totals line beside the map — orders / sets / revenue. PURE. */
export function geoTotals(points: readonly DeliveryGeoPoint[]): { orders: number; sets: number; revenueSen: number } {
  let sets = 0;
  let revenueSen = 0;
  for (const p of points) { sets += p.sets; revenueSen += p.revenueSen; }
  return { orders: points.length, sets, revenueSen };
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

/* ── Marker clustering (owner feedback 2026-08-08: zoomed out, individual dots
   are unreadable — nearby pins collapse into a coloured bubble with the COUNT;
   clicking a cluster zooms into it). A hand-rolled GRID fold, not the
   @googlemaps/markerclusterer dep: zero bundle cost, deterministic and
   unit-testable, and the panel's overlay is already imperative/bespoke
   (selected-pin outline, focus dimming, hover cards) — the library's renderer
   abstraction would fight all of it for a day of at most a few dozen pins. */

export type MapCluster = {
  key: string;
  /** Centroid of the member pins. */
  lat: number;
  lng: number;
  count: number;
  /** The dominant member colour (most-frequent zone colour; first-seen wins a
   *  tie) — the bubble stays an honest majority statement, never a new hue. */
  color: string;
  refs: string[];
};

/** Cluster bubble target size on screen, in pixels — two pins whose screen
 *  distance at the current zoom is under this fold into one bubble. */
const CLUSTER_GRID_PX = 64;
/** At/above this zoom pins never cluster (the owner zooms IN to read singles;
 *  street level must always show the real pins). */
export const CLUSTER_OFF_ZOOM = 15;

/** Grid-cluster the plain order pins for one zoom level. PURE + deterministic:
 *  pins sharing a grid cell (~CLUSTER_GRID_PX on screen) fold into a cluster
 *  when there are 2+; a lone pin stays a single. The caller excludes pins that
 *  must never disappear into a bubble (the selected pin, route stops). */
export function clusterPins(
  pins: readonly MapPin[],
  zoom: number,
): { clusters: MapCluster[]; singles: MapPin[] } {
  const z = Math.floor(Number.isFinite(zoom) ? zoom : 0);
  if (z >= CLUSTER_OFF_ZOOM) return { clusters: [], singles: [...pins] };
  /* Web-mercator world = 256 * 2^zoom px across 360 degrees of longitude. */
  const cellDeg = (CLUSTER_GRID_PX * 360) / (256 * 2 ** Math.max(0, z));
  const cells = new Map<string, MapPin[]>();
  for (const p of pins) {
    const key = `${Math.floor(p.lat / cellDeg)}:${Math.floor(p.lng / cellDeg)}`;
    const arr = cells.get(key) ?? [];
    arr.push(p);
    cells.set(key, arr);
  }
  const clusters: MapCluster[] = [];
  const singles: MapPin[] = [];
  for (const [key, members] of cells) {
    if (members.length < 2) { singles.push(members[0]); continue; }
    let lat = 0; let lng = 0;
    const colorCount = new Map<string, number>();
    for (const m of members) {
      lat += m.lat; lng += m.lng;
      colorCount.set(m.color, (colorCount.get(m.color) ?? 0) + 1);
    }
    let color = members[0].color; let best = 0;
    for (const m of members) {
      const n = colorCount.get(m.color) ?? 0;
      if (n > best) { best = n; color = m.color; }
    }
    clusters.push({
      key: `cluster:${key}`,
      lat: lat / members.length,
      lng: lng / members.length,
      count: members.length,
      color,
      refs: members.map((m) => m.ref),
    });
  }
  /* Deterministic output order regardless of Map iteration quirks. */
  clusters.sort((a, b) => a.key.localeCompare(b.key));
  singles.sort((a, b) => a.ref.localeCompare(b.ref));
  return { clusters, singles };
}

/* ── Region fly-to + auto fit (owner feedback 2026-08-08: clicking a region
   chip must focus the map on THAT region's pins, sized right — "Johor 有
   order,点 Southern 就该直接聚焦到那张单附近"; every (date, region) load
   re-fits to the loaded pins; zero pins → the region's geographic extent). */

export type MapBounds = { north: number; south: number; east: number; west: number };
export type MapViewport =
  | { kind: 'bounds'; bounds: MapBounds }
  | { kind: 'center'; center: MapLatLng; zoom: number };

/** A single pin centres at this zoom — close enough to read the neighbourhood,
 *  never street level (owner: cap ~15). */
export const SINGLE_PIN_ZOOM = 14;
/** fitBounds over a tight cluster of pins may overzoom; the panel clamps the
 *  post-fit zoom to this. */
export const FIT_MAX_ZOOM = 15;

/* Approximate geographic extents per region bucket (customer-state
   classification, delivery-planning region keys). Static, display-only — a
   zero-pin region still flies somewhere sensible. */
const REGION_EXTENTS: Record<string, MapBounds> = {
  KL:         { north: 3.9,  south: 2.55, east: 102.05, west: 100.75 }, // KL + Selangor
  NORTHERN:   { north: 6.75, south: 3.7,  east: 101.9,  west: 99.6 },   // Perlis/Kedah/Penang/Perak
  SOUTHERN:   { north: 3.3,  south: 1.2,  east: 104.45, west: 101.75 }, // NS/Melaka/Johor
  EAST_COAST: { north: 6.35, south: 2.45, east: 103.65, west: 101.3 },  // Kelantan/Terengganu/Pahang
  EM:         { north: 7.5,  south: 0.8,  east: 119.3,  west: 109.5 },  // Sabah/Sarawak/Labuan
  SG:         { north: 1.48, south: 1.2,  east: 104.1,  west: 103.6 },
};
/** The whole-country fallback ('ALL', or an owner-added region with no extent). */
const MALAYSIA_EXTENT: MapBounds = { north: 7.5, south: 0.8, east: 119.3, west: 99.6 };

export function regionExtent(regionKey: string | null | undefined): MapBounds {
  const key = (regionKey ?? '').trim().toUpperCase();
  return REGION_EXTENTS[key] ?? MALAYSIA_EXTENT;
}

/** The viewport for a set of drawable points under a region filter. PURE.
 *  - none  → the region's geographic extent (the zero-pin fly-to)
 *  - one   → centred at SINGLE_PIN_ZOOM (never street level)
 *  - many  → their bounding box (the panel fits it with padding + a zoom cap) */
export function viewportForPins(
  points: readonly MapLatLng[],
  regionKey: string | null | undefined,
): MapViewport {
  if (points.length === 0) return { kind: 'bounds', bounds: regionExtent(regionKey) };
  if (points.length === 1) {
    return { kind: 'center', center: { lat: points[0].lat, lng: points[0].lng }, zoom: SINGLE_PIN_ZOOM };
  }
  let north = -90; let south = 90; let east = -180; let west = 180;
  for (const p of points) {
    if (p.lat > north) north = p.lat;
    if (p.lat < south) south = p.lat;
    if (p.lng > east) east = p.lng;
    if (p.lng < west) west = p.lng;
  }
  return { kind: 'bounds', bounds: { north, south, east, west } };
}

/* ── Per-zone summary strip (owner feedback 2026-08-08: on every load, where
   the orders are and how many must read in ONE glance — "KL/SEL 8 · Northern 2
   · Southern 1 · rest 0"). Folds from the already-fetched geo points. */

export type ZoneSummaryEntry = { key: string; label: string; count: number };
export type ZoneSummary = {
  entries: ZoneSummaryEntry[];
  /** How many region buckets have ZERO orders (collapsed to one "rest 0" chip).
   *  Always 0 under a region filter — the fetch only carries that region, so
   *  claiming the others are empty would be a lie. */
  zeroCount: number;
};

/** Count the loaded points per REGION bucket. Under 'ALL', every master region
 *  with orders lists in master order (an unknown region the master list lacks
 *  still shows, appended); the empty ones collapse into `zeroCount`. Under a
 *  specific region filter only that region's count shows — the other buckets
 *  are NOT loaded, so nothing is claimed about them. PURE. */
export function zoneSummary(
  points: readonly Pick<DeliveryGeoPoint, 'region'>[],
  regions: readonly { key: string; label: string }[],
  activeRegion: string,
): ZoneSummary {
  const masters = regions.filter((r) => r.key !== 'ALL');
  const counts = new Map<string, number>();
  for (const p of points) counts.set(p.region, (counts.get(p.region) ?? 0) + 1);
  if (activeRegion !== 'ALL') {
    const master = masters.find((r) => r.key === activeRegion);
    return {
      entries: [{ key: activeRegion, label: master?.label ?? activeRegion, count: points.length }],
      zeroCount: 0,
    };
  }
  const entries: ZoneSummaryEntry[] = [];
  let zeroCount = 0;
  const seen = new Set<string>();
  for (const r of masters) {
    seen.add(r.key);
    const n = counts.get(r.key) ?? 0;
    if (n > 0) entries.push({ key: r.key, label: r.label, count: n });
    else zeroCount += 1;
  }
  for (const [region, n] of counts) {
    if (!seen.has(region)) entries.push({ key: region, label: region, count: n });
  }
  return { entries, zeroCount };
}

/* ── Trip legend (owner feedback 2026-08-08: a VISIBLE legend beside the map —
   one row per trip with its colour, stop count and time range; hover/click =
   the existing focus behaviour; per-stop windows listed small). */

export type MapLegendStop = { ref: string; order: number; windowLabel: string | null };
export type MapLegendRow = {
  routeId: string;
  color: string;
  title: string;
  crewLabel: string | null;
  /** EVERY order on the trip (allRefs — an unpinned stop still counts). */
  stopCount: number;
  /** First window's start → last window's end ("09:40 → 12:55"; ETA offsets
   *  read "+30m → +2h 5m"). Null when no stop carries a window — never a
   *  fabricated clock. */
  timeRange: string | null;
  stops: MapLegendStop[];
};

/** "09:40–10:25" → its start/end pieces; a dash-less label ("+30m") is both. */
const windowPieces = (label: string): { start: string; end: string } => {
  const parts = label.split('–');
  return { start: parts[0], end: parts[parts.length - 1] };
};

/** The legend view of the drawn routes. PURE. */
export function legendFromRoutes(routes: readonly MapRoute[]): MapLegendRow[] {
  return routes.map((r) => {
    const labelled = r.stops.filter((s) => s.windowLabel != null && s.windowLabel !== '');
    let timeRange: string | null = null;
    if (labelled.length > 0) {
      const start = windowPieces(labelled[0].windowLabel!).start;
      const end = windowPieces(labelled[labelled.length - 1].windowLabel!).end;
      timeRange = start === end ? start : `${start} → ${end}`;
    }
    return {
      routeId: r.id,
      color: r.color,
      title: r.title,
      crewLabel: r.crewLabel,
      stopCount: r.allRefs.length,
      timeRange,
      stops: r.stops.map((s) => ({ ref: s.ref, order: s.order, windowLabel: s.windowLabel })),
    };
  });
}

/* ── Roadmap declutter (owner addendum 2026-08-08: the default roadmap layer is
   cluttered with road-shield badges (E19/AH2), POI/business icons and transit
   marks — none of it useful for TMS). Applied via the Maps JS `styles` array,
   which the panel CAN use because its map is classic raster with no cloud
   mapId (a vector mapId would ignore inline styles). Satellite/hybrid ignore
   roadmap styles inherently — Google's own Labels checkbox there is untouched.

   The Labels toggle mirrors Satellite's checkbox semantics: ON (default) keeps
   locality/town names and road-name text so orientation survives; OFF hides
   ALL labels (pure geometry) — chosen over "locality names only" because it
   matches what unchecking Satellite's Labels does, one mental model. POI,
   transit and road-shield icons stay hidden in BOTH modes: they are the
   clutter, not labels. */

export type MapStyleRule = {
  featureType?: string;
  elementType?: string;
  stylers: Array<Record<string, string>>;
};

export function roadmapDeclutterStyles(labelsOn: boolean): MapStyleRule[] {
  const base: MapStyleRule[] = [
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    /* Road-shield badges (E19 / AH2 / …) are the road labels' ICON element;
       the road-name TEXT stays (it is orientation, not clutter). */
    { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  ];
  if (!labelsOn) base.push({ elementType: 'labels', stylers: [{ visibility: 'off' }] });
  return base;
}

/* ── Column narrowing while the map is open (owner rule 2026-08-08, amended
   same day: the board auto-narrows to the essential columns BY DEFAULT — a
   visible per-page "Compact columns" toggle, never a lock; an explicit column
   choice in the Columns panel while the map is open wins instantly by
   switching the toggle off). These are DataGrid column KEYS on the shared
   DeliveryPlanningBoard. A render-time overlay — the user's own saved column
   prefs are never written. */
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
