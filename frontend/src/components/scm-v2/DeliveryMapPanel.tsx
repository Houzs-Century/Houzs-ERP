// ----------------------------------------------------------------------------
// DeliveryMapPanel — the Option B side map (owner decision 2026-08-08: LEFT
// board / RIGHT sticky map on Delivery Date Arrangement, Delivery Time
// Arrangement and Last Mile Delivery).
//
// ONE shared panel, three presentations via props:
//   Date      — depot + one pin per order for the picked date (pin colour =
//               zone/region), hover/click mini card, totals line.
//   Time      — everything above + the proposed/staged "Trip N" routes as
//               coloured polylines with numbered stops + per-stop window text.
//   Last Mile — the day's real trips with crew labels; the page's trip cards
//               render UNDER the map via `children`.
//
// Owner feedback 2026-08-08 (on prod), folded in:
//   - Plain pins CLUSTER at low zoom into coloured count bubbles (pure grid
//     fold, clusterPins); clicking a bubble zooms into its members.
//   - Every (date, region) load auto-fits to the loaded pins (viewKey); a
//     region with ZERO pins flies to the region's geographic extent and says
//     "0 orders in this region" instead of staring at the old viewport.
//   - A per-zone summary strip above the map ("KL/SEL 8 · Northern 2 · rest
//     0") so where-the-orders-are reads in one glance; the totals line stays.
//   - Trips draw with bolder polylines + direction arrows, and a TRIP LEGEND
//     under the map: colour swatch, Trip N, stop count, time range, per-stop
//     windows. Hovering a legend row dims the other trips (visual only);
//     clicking is the existing focus behaviour (dim + zoom + board filter).
//   - The roadmap layer is DECLUTTERED by default (POI/transit/road-shield
//     icons off — roadmapDeclutterStyles; classic raster map, no mapId, so
//     the styles array applies) with a small "Labels" toggle mirroring
//     Satellite's checkbox (off = all labels off). Satellite is untouched.
//
// The LOGIC (pins, routes, clusters, viewports, legend, focus filter,
// colours) is the pure model in vendor/scm/lib/delivery-map-model.ts; this
// file is the React/Maps shell.
//
// Maps infra: the SAME @vis.gl/react-google-maps + imperative useMap() overlay
// idiom as FleetDayMap / ScheduleRouteMap (classic raster map, no cloud mapId).
// VITE_GOOGLE_MAPS_API_KEY unset → a "key not configured" note; a runtime load
// failure degrades in place. Ungeocoded orders are LISTED beside the map with
// the owner's wording — never silently dropped.
//
// Two-way linkage: `selectedRef` (board row click) enlarges/outlines that pin
// and pans to it; clicking a pin fires `onPinClick(ref)` (the page scrolls the
// board). Trip focus: clicking a polyline/stop fires `onRouteClick(id)`; the
// focused route keeps full colour while the rest dim, and the viewport zooms
// to it.
//
// Open/closed persists per page via useMapPanelOpen (localStorage, the same
// personal-pref idiom as ResizableDrawer's panel-* width keys); the compact-
// columns DEFAULT persists beside it via useMapCompactColumns.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { APIProvider, Map as GoogleMap, useMap } from '@vis.gl/react-google-maps';
import { X, MapPin as MapPinIcon } from 'lucide-react';
import { fmtSen } from '../../vendor/shared/format';
import {
  clusterPins,
  legendFromRoutes,
  roadmapDeclutterStyles,
  viewportForPins,
  FIT_MAX_ZOOM,
  SINGLE_PIN_ZOOM,
  type MapFocus,
  type MapPin,
  type MapRoute,
  type ZoneSummary,
} from '../../vendor/scm/lib/delivery-map-model';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

/* ── Open/closed persistence (per page, per browser — a personal pref). ────── */
export function useMapPanelOpen(pageKey: string): [boolean, (open: boolean) => void] {
  const storageKey = `dmap-open.${pageKey}.v1`;
  const [open, setOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem(storageKey) !== '0'; } catch { return true; }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try { window.localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* private mode */ }
  };
  return [open, set];
}

/* ── Compact-columns persistence (owner bug 2026-08-08: "已经添加了 column
   可是它却没有出来" — the map-open narrowing overrode the Columns panel).
   The narrowing is now a DEFAULT, not a lock: this toggle starts ON, persists
   per page like the open/closed pref, renders as a visible pill on the panel
   header, and the page switches it OFF the moment the user makes an explicit
   column choice while the map is open (their picks win instantly). */
export function useMapCompactColumns(pageKey: string): [boolean, (on: boolean) => void] {
  const storageKey = `dmap-compact.${pageKey}.v1`;
  const [on, setOn] = useState<boolean>(() => {
    try { return window.localStorage.getItem(storageKey) !== '0'; } catch { return true; }
  });
  const set = (next: boolean) => {
    setOn(next);
    try { window.localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* private mode */ }
  };
  return [on, set];
}

export type DeliveryMapDepot = { lat: number; lng: number; label?: string | null };

type OverlayProps = {
  pins: MapPin[];
  routes: MapRoute[];
  depot: DeliveryMapDepot | null;
  focus: MapFocus | null;
  selectedRef: string | null;
  /** Legend-row hover — dims the OTHER trips visually, without the zoom or the
   *  board filter a real (clicked) focus carries. */
  emphasisRouteId: string | null;
  /** Region key under the map's chips — the zero-pin fly-to target. */
  regionKey: string | null;
  /** Changes on every (date, region) pick — the auto-fit trigger, so a data
   *  load always lands on the default picture. */
  viewKey: string;
  onPinClick?: (ref: string) => void;
  onRouteClick?: (routeId: string) => void;
  onHoverRef?: (ref: string | null) => void;
  onMapTypeChange?: (mapTypeId: string) => void;
};

/* Imperative overlay — markers + polylines drawn/torn down on every change so
   nothing leaks (the FleetDayMap pattern, extended with click/hover wiring,
   focus dimming, the selected-pin outline, and now zoom-aware clustering +
   direction arrows + the region fly-to). */
function PanelOverlay({
  pins, routes, depot, focus, selectedRef, emphasisRouteId, regionKey, viewKey,
  onPinClick, onRouteClick, onHoverRef, onMapTypeChange,
}: OverlayProps) {
  const map = useMap();
  const objectsRef = useRef<Array<{ setMap: (m: google.maps.Map | null) => void }>>([]);
  const listenersRef = useRef<google.maps.MapsEventListener[]>([]);

  /* Zoom bucket — clusters fold per INTEGER zoom, so the overlay redraws when
     the operator crosses a zoom level and pins merge/split accordingly. */
  const [zoomBucket, setZoomBucket] = useState<number>(11);
  useEffect(() => {
    if (!map) return;
    const l = map.addListener('zoom_changed', () => {
      const z = Math.floor(map.getZoom() ?? 11);
      setZoomBucket((cur) => (cur === z ? cur : z));
    });
    return () => l.remove();
  }, [map]);

  /* Report the map type so the panel can show the roadmap Labels toggle only
     where it applies (satellite keeps Google's own checkbox, untouched). */
  useEffect(() => {
    if (!map || !onMapTypeChange) return;
    onMapTypeChange(String(map.getMapTypeId() ?? 'roadmap'));
    const l = map.addListener('maptypeid_changed', () =>
      onMapTypeChange(String(map.getMapTypeId() ?? 'roadmap')));
    return () => l.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  /* Fit-to-content runs when the CONTENT, the (date, region) view or the FOCUS
     changes — not on zoom redraws, legend hovers or row selections (a row
     click pans, it must not re-zoom the whole view). */
  const fitSig = useMemo(
    () => JSON.stringify([
      viewKey,
      pins.map((p) => p.ref),
      routes.map((r) => [r.id, r.stops.length]),
      depot ? [depot.lat, depot.lng] : null,
      focus?.routeId ?? null,
    ]),
    [viewKey, pins, routes, depot, focus],
  );
  const appliedFitSigRef = useRef<string | null>(null);

  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    for (const l of listenersRef.current) l.remove();
    listenersRef.current = [];
    for (const o of objectsRef.current) o.setMap(null);
    objectsRef.current = [];

    /* Bounds collection — only NON-focus-dimmed content counts, so a focused
       trip fits alone (the existing rule). Legend-hover emphasis dims VISUALLY
       but never re-fits. */
    const fitPoints: google.maps.LatLngLiteral[] = [];
    const extend = (p: google.maps.LatLngLiteral, counts: boolean) => {
      if (counts) fitPoints.push(p);
    };

    const focused = focus?.routeId ?? null;
    const focusRefs = new Set(focus?.refs ?? []);
    /* Visual emphasis: a real focus wins; else the hovered legend row. */
    const emphasis = focused ?? emphasisRouteId;
    const emphasisRefs = focused != null
      ? focusRefs
      : new Set(routes.find((r) => r.id === emphasisRouteId)?.allRefs ?? []);
    const onRouteRefs = new Set<string>();
    for (const r of routes) for (const s of r.stops) onRouteRefs.add(s.ref);

    /* Depot — one dark marker; dims only under emphasis if no route claims it. */
    if (depot) {
      const d = { lat: depot.lat, lng: depot.lng };
      extend(d, focused == null);
      const marker = new google.maps.Marker({
        position: d,
        map,
        title: depot.label ? `Depot — ${depot.label}` : 'Depot',
        zIndex: 2000,
        label: { text: 'D', color: '#ffffff', fontWeight: 'bold', fontSize: '11px' },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 12,
          fillColor: '#0c3f39',
          fillOpacity: emphasis == null ? 1 : 0.55,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      objectsRef.current.push(marker);
    }

    const wirePinEvents = (marker: google.maps.Marker, ref: string) => {
      if (onPinClick) listenersRef.current.push(marker.addListener('click', () => onPinClick(ref)));
      if (onHoverRef) {
        listenersRef.current.push(marker.addListener('mouseover', () => onHoverRef(ref)));
        listenersRef.current.push(marker.addListener('mouseout', () => onHoverRef(null)));
      }
    };

    /* Routes — bold polyline with direction arrows + numbered stops, dimmed
       unless emphasised (or nothing is emphasised). */
    for (const route of routes) {
      const dimmed = emphasis != null && route.id !== emphasis;
      const countsForFit = !(focused != null && route.id !== focused);
      const opacity = dimmed ? 0.2 : 1;
      const path: google.maps.LatLngLiteral[] = [];
      if (route.depot) path.push({ lat: route.depot.lat, lng: route.depot.lng });
      for (const s of route.stops) {
        const p = { lat: s.lat, lng: s.lng };
        path.push(p);
        extend(p, countsForFit);
        const isSel = selectedRef != null && s.ref === selectedRef;
        const marker = new google.maps.Marker({
          position: p,
          map,
          title: `${route.title} · ${s.order}. ${s.label}${s.windowLabel ? ` (${s.windowLabel})` : ''}`,
          zIndex: isSel ? 3000 : dimmed ? 1 : 500,
          label: { text: String(s.order), color: '#ffffff', fontWeight: 'bold', fontSize: '12px' },
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: isSel ? 15 : 12,
            fillColor: route.color,
            fillOpacity: opacity,
            strokeColor: isSel ? '#111111' : '#ffffff',
            strokeWeight: isSel ? 3 : 2,
          },
        });
        objectsRef.current.push(marker);
        wirePinEvents(marker, s.ref);
      }
      if (route.depot && route.stops.length > 0) path.push({ lat: route.depot.lat, lng: route.depot.lng });
      if (path.length >= 2) {
        const line = new google.maps.Polyline({
          path,
          map,
          geodesic: true,
          strokeColor: route.color,
          strokeOpacity: dimmed ? 0.2 : 0.9,
          strokeWeight: dimmed ? 2 : 4,
          zIndex: dimmed ? 1 : 100,
          /* Direction arrows — the drive order must read off the line itself. */
          icons: dimmed ? [] : [{
            icon: {
              path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
              scale: 2.4,
              fillColor: route.color,
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 1,
            },
            offset: '30px',
            repeat: '90px',
          }],
        });
        objectsRef.current.push(line);
        if (onRouteClick) listenersRef.current.push(line.addListener('click', () => onRouteClick(route.id)));
      }
    }

    /* Plain order pins — only for orders NOT already numbered on a route.
       Low zoom folds them into coloured COUNT bubbles (clusterPins); the
       selected pin never disappears into a bubble. */
    const plainPins = pins.filter((p) => !onRouteRefs.has(p.ref));
    const selPin = selectedRef != null ? plainPins.find((p) => p.ref === selectedRef) ?? null : null;
    const { clusters, singles } = clusterPins(
      selPin ? plainPins.filter((p) => p.ref !== selPin.ref) : plainPins,
      zoomBucket,
    );
    const pinByRef = new Map(plainPins.map((p) => [p.ref, p]));

    const drawPlainPin = (pin: MapPin) => {
      const dimmed = emphasis != null && !emphasisRefs.has(pin.ref);
      const countsForFit = !(focused != null && !focusRefs.has(pin.ref));
      const p = { lat: pin.lat, lng: pin.lng };
      extend(p, countsForFit);
      const isSel = selectedRef != null && pin.ref === selectedRef;
      const marker = new google.maps.Marker({
        position: p,
        map,
        title: `${pin.card.soDocNo}${pin.card.customer ? ` — ${pin.card.customer}` : ''}`,
        zIndex: isSel ? 3000 : dimmed ? 1 : 400,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isSel ? 12 : 8,
          fillColor: pin.color,
          fillOpacity: dimmed ? 0.25 : 0.95,
          strokeColor: isSel ? '#111111' : '#ffffff',
          strokeWeight: isSel ? 3 : 1.5,
        },
      });
      objectsRef.current.push(marker);
      wirePinEvents(marker, pin.ref);
    };

    for (const pin of singles) drawPlainPin(pin);
    if (selPin) drawPlainPin(selPin);

    for (const cluster of clusters) {
      const dimmed = emphasis != null && !cluster.refs.some((r) => emphasisRefs.has(r));
      const countsForFit = !(focused != null && !cluster.refs.some((r) => focusRefs.has(r)));
      const p = { lat: cluster.lat, lng: cluster.lng };
      /* Fit uses the member pins, not the centroid — the fit must cover them. */
      for (const ref of cluster.refs) {
        const member = pinByRef.get(ref);
        if (member) extend({ lat: member.lat, lng: member.lng }, countsForFit);
      }
      const marker = new google.maps.Marker({
        position: p,
        map,
        title: `${cluster.count} orders — click to zoom in`,
        zIndex: dimmed ? 1 : 450,
        label: { text: String(cluster.count), color: '#ffffff', fontWeight: 'bold', fontSize: '12px' },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: cluster.count >= 10 ? 18 : 15,
          fillColor: cluster.color,
          fillOpacity: dimmed ? 0.25 : 0.92,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      objectsRef.current.push(marker);
      /* Cluster click = zoom into its members (clamped — at FIT_MAX_ZOOM the
         cluster fold is off, so the members render as real pins). */
      listenersRef.current.push(marker.addListener('click', () => {
        const b = new google.maps.LatLngBounds();
        for (const ref of cluster.refs) {
          const member = pinByRef.get(ref);
          if (member) b.extend({ lat: member.lat, lng: member.lng });
        }
        if (!b.isEmpty()) {
          map.fitBounds(b, 56);
          google.maps.event.addListenerOnce(map, 'idle', () => {
            if ((map.getZoom() ?? 0) > FIT_MAX_ZOOM) map.setZoom(FIT_MAX_ZOOM);
          });
        }
      }));
    }

    /* The default picture (viewportForPins): many → fit with padding + zoom
       cap; one → centred, never street level; NONE → the region's geographic
       extent (the zero-pin fly-to). Gated on fitSig so zoom redraws and
       legend hovers never re-fit under the operator. */
    if (appliedFitSigRef.current !== fitSig) {
      appliedFitSigRef.current = fitSig;
      const vp = viewportForPins(fitPoints, regionKey);
      if (vp.kind === 'center') {
        map.setCenter(vp.center);
        map.setZoom(SINGLE_PIN_ZOOM);
      } else {
        map.fitBounds(new google.maps.LatLngBounds(
          { lat: vp.bounds.south, lng: vp.bounds.west },
          { lat: vp.bounds.north, lng: vp.bounds.east },
        ), 56);
        google.maps.event.addListenerOnce(map, 'idle', () => {
          if ((map.getZoom() ?? 0) > FIT_MAX_ZOOM) map.setZoom(FIT_MAX_ZOOM);
        });
      }
    }

    return () => {
      for (const l of listenersRef.current) l.remove();
      listenersRef.current = [];
      for (const o of objectsRef.current) o.setMap(null);
      objectsRef.current = [];
    };
    // fitSig folds pins/routes/depot/focus/view identity; handlers are stable per render pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitSig, selectedRef, zoomBucket, emphasisRouteId]);

  /* Board row → pin: PAN to the selected ref (no zoom change). */
  useEffect(() => {
    if (!map || !selectedRef) return;
    const inRoutes = routes.flatMap((r) => r.stops).find((s) => s.ref === selectedRef);
    const pin = inRoutes ?? pins.find((p) => p.ref === selectedRef);
    if (pin) map.panTo({ lat: pin.lat, lng: pin.lng });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selectedRef]);

  return null;
}

export type DeliveryMapPanelProps = {
  /** Panel title ("Day map", per page). */
  title: string;
  /** Collapse — the page persists the choice via useMapPanelOpen. */
  onClose: () => void;
  /** Page-specific header controls (the required date input, region chips…). */
  headerControls?: ReactNode;
  pins: MapPin[];
  routes?: MapRoute[];
  depot?: DeliveryMapDepot | null;
  /** Why there is no depot marker (server's depotReason) — shown muted. */
  depotReason?: string | null;
  focus?: MapFocus | null;
  onRouteClick?: (routeId: string) => void;
  /** The board-selected order — its pin enlarges/outlines and the map pans. */
  selectedRef?: string | null;
  /** Pin clicked — the page scrolls/highlights the board row. */
  onPinClick?: (ref: string) => void;
  /** Totals line: orders / sets / RM. */
  totals?: { orders: number; sets: number; revenueSen: number } | null;
  /** The map's active region key ('ALL' or a bucket) — the zero-pin fly-to
   *  target and the wording of the zero-pin note. */
  regionKey?: string | null;
  /** Changes on every (date, region) pick — triggers the auto fit-bounds so a
   *  data load always lands on the default picture. */
  viewKey?: string;
  /** The per-zone count strip above the map (zoneSummary fold). */
  zoneSummary?: ZoneSummary | null;
  /** Compact-columns pill (owner rule: the map-open narrowing is a DEFAULT,
   *  never a lock). Absent → no pill (a page without narrowing). */
  compactColumns?: boolean | null;
  onCompactColumnsChange?: (on: boolean) => void;
  /** Orders that could not be located ("N 张单定位不到 — 检查地址"). */
  ungeocoded?: Array<{ ref: string; reason: string }>;
  /** False = the SERVER has no maps key (geocoding off) — said out loud. */
  serverConfigured?: boolean;
  isLoading?: boolean;
  mapHeight?: number;
  /** Rendered under the map (Last Mile's trip/crew cards). */
  children?: ReactNode;
  /** Extra classes on the <aside> — the pages pass the split width
   *  (`lg:w-[40%] lg:flex-none`); sticky/top live here so the panel pins while
   *  the board column scrolls. */
  className?: string;
};

export function DeliveryMapPanel({
  title,
  onClose,
  headerControls,
  pins,
  routes = [],
  depot = null,
  depotReason = null,
  focus = null,
  onRouteClick,
  selectedRef = null,
  onPinClick,
  totals = null,
  regionKey = null,
  viewKey = '',
  zoneSummary = null,
  compactColumns = null,
  onCompactColumnsChange,
  ungeocoded = [],
  serverConfigured = true,
  isLoading = false,
  mapHeight = 440,
  children,
  className,
}: DeliveryMapPanelProps) {
  const [failed, setFailed] = useState(false);
  const [hoverRef, setHoverRef] = useState<string | null>(null);
  /* Legend-row hover — visual dimming only (no zoom, no board filter). */
  const [legendHoverId, setLegendHoverId] = useState<string | null>(null);
  /* Roadmap declutter (owner addendum 2026-08-08): decluttered by default;
     the Labels toggle mirrors Satellite's checkbox (off = all labels off).
     Only shown while the ROADMAP layer is active — satellite keeps Google's
     own Labels checkbox untouched. */
  const [roadLabels, setRoadLabels] = useState(true);
  const [mapTypeId, setMapTypeId] = useState<string>('roadmap');
  const roadStyles = useMemo(
    () => roadmapDeclutterStyles(roadLabels) as google.maps.MapTypeStyle[],
    [roadLabels],
  );

  /* The mini card follows hover first, then the board/pin selection. */
  const cardRef = hoverRef ?? selectedRef;
  const card = useMemo(() => {
    if (!cardRef) return null;
    return pins.find((p) => p.ref === cardRef)?.card ?? null;
  }, [pins, cardRef]);
  /* Trip stop facts for the card — the hovered marker's trip, stop number and
     time window (owner: the window must be on the hover card, not only the
     native tooltip). */
  const cardStop = useMemo(() => {
    if (!cardRef) return null;
    for (const r of routes) {
      const s = r.stops.find((st) => st.ref === cardRef);
      if (s) return { title: r.title, order: s.order, windowLabel: s.windowLabel };
    }
    return null;
  }, [routes, cardRef]);

  const legend = useMemo(() => legendFromRoutes(routes), [routes]);

  const center = pins[0]
    ? { lat: pins[0].lat, lng: pins[0].lng }
    : depot
      ? { lat: depot.lat, lng: depot.lng }
      : { lat: 3.139, lng: 101.6869 }; // KL fallback

  return (
    <aside className={['min-w-0 rounded-md border border-border bg-surface lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto', className].filter(Boolean).join(' ')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <MapPinIcon size={14} strokeWidth={1.75} className="text-ink-secondary" />
        <span className="text-[12.5px] font-semibold text-ink">{title}</span>
        {totals && (
          <span className="text-[11.5px] text-ink-muted">
            {totals.orders} order{totals.orders === 1 ? '' : 's'} · {totals.sets} sets · {fmtSen(totals.revenueSen)}
          </span>
        )}
        <span className="flex-1" />
        {compactColumns != null && onCompactColumnsChange && (
          <button
            type="button"
            onClick={() => onCompactColumnsChange(!compactColumns)}
            title={compactColumns
              ? 'The board shows only the essential columns while the map is open — click for your full column set (any change in the Columns panel also switches this off)'
              : 'Click to narrow the board to the essential columns while the map is open'}
            className={[
              'rounded-full border px-2.5 py-0.5 text-[11px]',
              compactColumns
                ? 'border-accent bg-accent/10 font-semibold text-accent'
                : 'border-border text-ink-secondary',
            ].join(' ')}
          >
            Compact columns
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close the map — the board returns to full width"
          aria-label="Close map"
          className="rounded p-1 text-ink-secondary hover:bg-surface-raised hover:text-ink"
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      {headerControls && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {headerControls}
        </div>
      )}

      {/* Per-zone summary strip — where the orders are, in one glance. */}
      {zoneSummary && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
          {zoneSummary.entries.length === 0 && (
            <span className="text-[11.5px] text-ink-muted">No orders this day</span>
          )}
          {zoneSummary.entries.map((e) => (
            <span key={e.key} className="rounded-full bg-surface-dim px-2 py-0.5 text-[11px] text-ink-secondary">
              {e.label} <span className="font-semibold text-ink">{e.count}</span>
            </span>
          ))}
          {zoneSummary.zeroCount > 0 && zoneSummary.entries.length > 0 && (
            <span className="text-[11px] text-ink-muted">rest 0</span>
          )}
        </div>
      )}

      <div className="relative">
        {!MAPS_KEY || failed ? (
          <div
            className="flex items-center justify-center border-b border-border bg-surface-dim px-6 text-center text-[12.5px] text-ink-muted"
            style={{ height: mapHeight }}
          >
            {failed
              ? 'The map could not load. Check that VITE_GOOGLE_MAPS_API_KEY is valid and its referrer restriction allows this site.'
              : 'Set VITE_GOOGLE_MAPS_API_KEY to draw the map. The board and its lists still work without it.'}
          </div>
        ) : (
          <APIProvider apiKey={MAPS_KEY} onError={() => setFailed(true)}>
            <GoogleMap
              defaultCenter={center}
              defaultZoom={11}
              gestureHandling="greedy"
              disableDefaultUI={false}
              styles={roadStyles}
              style={{ width: '100%', height: mapHeight }}
            >
              <PanelOverlay
                pins={pins}
                routes={routes}
                depot={depot}
                focus={focus}
                selectedRef={selectedRef}
                emphasisRouteId={legendHoverId}
                regionKey={regionKey}
                viewKey={viewKey}
                onPinClick={onPinClick}
                onRouteClick={onRouteClick}
                onHoverRef={setHoverRef}
                onMapTypeChange={setMapTypeId}
              />
            </GoogleMap>
          </APIProvider>
        )}

        {/* Roadmap "Labels" toggle — mirrors Satellite's checkbox; the roadmap
            base declutter (POI/transit/road shields) stays on in both states. */}
        {MAPS_KEY && !failed && mapTypeId === 'roadmap' && (
          <label className="absolute right-14 top-2 flex cursor-pointer items-center gap-1 rounded-md border border-border bg-surface/95 px-2 py-1 text-[11px] text-ink-secondary shadow-sm">
            <input
              type="checkbox"
              checked={roadLabels}
              onChange={(e) => setRoadLabels(e.target.checked)}
            />
            Labels
          </label>
        )}

        {/* Zero-pin note — the map flew to the region's extent, say why. */}
        {MAPS_KEY && !failed && !isLoading && pins.length === 0 && (
          <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-border bg-surface/95 px-2.5 py-1 text-[11.5px] text-ink-secondary shadow-sm">
            {(regionKey ?? 'ALL') === 'ALL' ? '0 orders on this day' : '0 orders in this region'}
          </div>
        )}

        {/* Mini card — hover/click: SO no, customer, sets, address (+ the trip
            stop's number and time window when the marker sits on a route). */}
        {card && (
          <div className="pointer-events-none absolute bottom-2 left-2 max-w-[85%] rounded-md border border-border bg-surface/95 px-3 py-2 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] font-semibold text-ink">{card.soDocNo}</span>
              {card.zone && <span className="text-[10.5px] font-semibold uppercase text-ink-secondary">{card.zone}</span>}
            </div>
            <div className="text-[12px] text-ink">{card.customer ?? '—'}</div>
            {cardStop && (
              <div className="text-[11.5px] font-semibold text-ink-secondary">
                {cardStop.title} · Stop {cardStop.order}
                {cardStop.windowLabel ? ` · ${cardStop.windowLabel}` : ''}
              </div>
            )}
            <div className="text-[11.5px] text-ink-secondary">
              {card.sets} set{card.sets === 1 ? '' : 's'} · {fmtSen(card.revenueSen)}
            </div>
            {card.address && <div className="text-[11px] text-ink-muted">{card.address}</div>}
          </div>
        )}
      </div>

      {/* Trip legend — one row per drawn trip: swatch, Trip N, stop count,
          time range, crew (Last Mile), per-stop windows. Hover dims the other
          trips; click is the existing focus behaviour. */}
      {legend.length > 0 && (
        <div className="border-b border-border">
          {legend.map((row) => {
            const isFocused = focus?.routeId === row.routeId;
            const windowed = row.stops.filter((s) => s.windowLabel);
            return (
              <button
                key={row.routeId}
                type="button"
                onClick={() => onRouteClick?.(row.routeId)}
                onMouseEnter={() => setLegendHoverId(row.routeId)}
                onMouseLeave={() => setLegendHoverId(null)}
                title={isFocused
                  ? 'Click to unfocus this trip'
                  : 'Click to focus this trip — the map zooms to it and the board filters to its stops'}
                className={[
                  'block w-full px-3 py-1.5 text-left hover:bg-surface-raised',
                  isFocused ? 'bg-accent/5' : '',
                ].join(' ')}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 flex-none rounded-full"
                    style={{ background: row.color }}
                  />
                  <span className="text-[12px] font-semibold text-ink">{row.title}</span>
                  <span className="text-[11.5px] text-ink-secondary">
                    {row.stopCount} stop{row.stopCount === 1 ? '' : 's'}
                  </span>
                  {row.timeRange && (
                    <span className="text-[11.5px] tabular-nums text-ink-secondary">{row.timeRange}</span>
                  )}
                  {row.crewLabel && (
                    <span className="text-[11px] text-ink-muted">{row.crewLabel}</span>
                  )}
                </span>
                {windowed.length > 0 && (
                  <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 pl-5">
                    {windowed.map((s) => (
                      <span key={s.ref} className="text-[10.5px] tabular-nums text-ink-muted">
                        #{s.order} {s.windowLabel}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="space-y-1.5 px-3 py-2">
        {isLoading && <p className="text-[11.5px] text-ink-muted">Loading the day&rsquo;s map…</p>}
        {!serverConfigured && (
          <p className="text-[11.5px] text-ink-muted">
            The server&rsquo;s maps key is not configured — only previously located addresses can pin.
          </p>
        )}
        {depot == null && depotReason && (
          <p className="text-[11.5px] text-ink-muted">No depot marker: {depotReason}.</p>
        )}
        {ungeocoded.length > 0 && (
          <div className="rounded-md border border-border bg-surface-dim px-2.5 py-1.5 text-[11.5px] text-ink-secondary">
            <span className="font-semibold">{ungeocoded.length} 张单定位不到 — 检查地址.</span>
            <ul className="mt-0.5 list-disc pl-4">
              {ungeocoded.map((u) => (
                <li key={u.ref}>
                  <span className="font-mono">{u.ref}</span> — {u.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {children && <div className="border-t border-border p-3">{children}</div>}
    </aside>
  );
}
