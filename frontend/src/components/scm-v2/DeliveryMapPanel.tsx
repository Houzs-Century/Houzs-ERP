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
import { X, MapPin as MapPinIcon, ChevronDown } from 'lucide-react';
import { fmtSen, fmtTime } from '../../../../shared/src/vendor/shared/format';
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
import { STOP_STATUS_COLOR, STOP_STATUS_LABEL, type StopStatus } from '../../vendor/scm/lib/delivery-stop-status';
import type { VehiclePosition } from '../../vendor/scm/lib/vehicle-positions';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

export function useMapPanelOpen(pageKey: string): [boolean, (open: boolean) => void] {
  const storageKey = `dmap-open.${pageKey}.v1`;
  const [open, setOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem(storageKey) !== '0'; } catch { return true; }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try { window.localStorage.setItem(storageKey, next ? '1' : '0'); } catch { }
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
    try { window.localStorage.setItem(storageKey, next ? '1' : '0'); } catch { }
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
  emphasisRouteId: string | null;
  regionKey: string | null;
  viewKey: string;
  fitRefs: readonly string[] | null;
  onPinClick?: (ref: string) => void;
  onRouteClick?: (routeId: string) => void;
  onHoverRef?: (ref: string | null) => void;
  onMapTypeChange?: (mapTypeId: string) => void;
  statusByRef: Map<string, StopStatus> | null;
  ringStops: boolean;
  vehicles: VehiclePosition[];
  onVehicleClick?: (v: VehiclePosition) => void;
};

function PanelOverlay({
  pins, routes, depot, focus, selectedRef, emphasisRouteId, regionKey, viewKey, fitRefs,
  onPinClick, onRouteClick, onHoverRef, onMapTypeChange, statusByRef, ringStops, vehicles, onVehicleClick,
}: OverlayProps) {
  const map = useMap();
  const objectsRef = useRef<Array<{ setMap: (m: google.maps.Map | null) => void }>>([]);
  const listenersRef = useRef<google.maps.MapsEventListener[]>([]);

  const [zoomBucket, setZoomBucket] = useState<number>(11);
  useEffect(() => {
    if (!map) return;
    const l = map.addListener('zoom_changed', () => {
      const z = Math.floor(map.getZoom() ?? 11);
      setZoomBucket((cur) => (cur === z ? cur : z));
    });
    return () => l.remove();
  }, [map]);

  useEffect(() => {
    if (!map || !onMapTypeChange) return;
    onMapTypeChange(String(map.getMapTypeId() ?? 'roadmap'));
    const l = map.addListener('maptypeid_changed', () =>
      onMapTypeChange(String(map.getMapTypeId() ?? 'roadmap')));
    return () => l.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  const fitSig = useMemo(
    () => JSON.stringify([
      viewKey,
      pins.map((p) => p.ref),
      routes.map((r) => [r.id, r.stops.length]),
      depot ? [depot.lat, depot.lng] : null,
      focus?.routeId ?? null,
      fitRefs,
    ]),
    [viewKey, pins, routes, depot, focus, fitRefs],
  );
  const appliedFitSigRef = useRef<string | null>(null);

  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    for (const l of listenersRef.current) l.remove();
    listenersRef.current = [];
    for (const o of objectsRef.current) o.setMap(null);
    objectsRef.current = [];

    const fitPoints: google.maps.LatLngLiteral[] = [];
    const extend = (p: google.maps.LatLngLiteral, counts: boolean) => {
      if (counts) fitPoints.push(p);
    };

    const focused = focus?.routeId ?? null;
    const focusRefs = new Set(focus?.refs ?? []);
    const emphasis = focused ?? emphasisRouteId;
    const emphasisRefs = focused != null
      ? focusRefs
      : new Set(routes.find((r) => r.id === emphasisRouteId)?.allRefs ?? []);
    const onRouteRefs = new Set<string>();
    for (const r of routes) for (const s of r.stops) onRouteRefs.add(s.ref);

    const statusOf = (ref: string): StopStatus | null => statusByRef?.get(ref) ?? null;

    for (const v of vehicles) {
      const at = fmtTime(v.recordedAt);
      const marker = new google.maps.Marker({
        position: { lat: v.lat, lng: v.lng },
        map,
        title: `${v.label} · ${v.source === 'gps' ? 'Tracker' : 'Phone'} fix ${at} (${Math.max(0, Math.round((Date.now() - Date.parse(v.recordedAt)) / 60_000))} min ago)${v.lorryId ? ' · click for Fleet Health' : ''}`,
        zIndex: 4000,
        label: { text: v.label, color: '#111827', fontWeight: 'bold', fontSize: '11px' },
        icon: {
          path: 'M -11 -7 L 5 -7 L 5 -3 L 9 -3 L 12 1 L 12 6 L -11 6 Z',
          scale: 1.3,
          fillColor: '#111827',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
          labelOrigin: new google.maps.Point(0, 18),
        },
      });
      objectsRef.current.push(marker);
      if (onVehicleClick) listenersRef.current.push(marker.addListener('click', () => onVehicleClick(v)));
    }

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
        if (s.covered) continue;
        const spotRefs = s.spotRefs ?? [s.ref];
        const pinText = s.pinLabel ?? String(s.order);
        const isSel = selectedRef != null && spotRefs.includes(selectedRef);
        const st = statusOf(s.ref);
        let fillColor: string; let strokeColor: string; let strokeWeight: number; let labelColor: string;
        if (ringStops) {
          const delivered = st === 'done';
          const ring = st === 'overdue' ? STOP_STATUS_COLOR.overdue : route.color;
          fillColor = delivered ? route.color : '#ffffff';
          strokeColor = isSel ? '#111111' : ring;
          strokeWeight = isSel || !delivered ? 3.5 : 2;
          labelColor = delivered ? '#ffffff' : ring;
        } else {
          fillColor = st ? STOP_STATUS_COLOR[st] : route.color;
          strokeColor = isSel ? '#111111' : st ? route.color : '#ffffff';
          strokeWeight = isSel || st ? 3 : 2;
          labelColor = '#ffffff';
        }
        const marker = new google.maps.Marker({
          position: p,
          map,
          title: `${route.title} · ${s.pinLabel ? `Stops ${s.pinLabel} (same address)` : `${s.order}.`} ${s.label}${s.windowLabel ? ` (${s.windowLabel})` : ''}${s.approximate ? ' · approximate location (postcode area)' : ''}`,
          zIndex: isSel ? 3000 : dimmed ? 1 : 500,
          label: { text: pinText, color: labelColor, fontWeight: 'bold', fontSize: pinText.length > 3 ? '10px' : '12px' },
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: (isSel ? 15 : 12) + (pinText.length > 3 ? 4 : 0),
            fillColor,
            fillOpacity: opacity,
            strokeColor,
            strokeWeight,
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
          fillColor: statusOf(pin.ref) ? STOP_STATUS_COLOR[statusOf(pin.ref) as StopStatus] : pin.color,
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

    if (appliedFitSigRef.current !== fitSig) {
      appliedFitSigRef.current = fitSig;
      let pointsToFit = fitPoints;
      if (fitRefs) {
        const want = new Set(fitRefs);
        const zone = [
          ...routes.flatMap((r) => r.stops).filter((st) => want.has(st.ref)),
          ...pins.filter((pn) => want.has(pn.ref)),
        ].map((pt) => ({ lat: pt.lat, lng: pt.lng }));
        if (zone.length > 0) pointsToFit = zone;
      }
      const vp = viewportForPins(pointsToFit, regionKey);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitSig, selectedRef, zoomBucket, emphasisRouteId, statusByRef, vehicles]);

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
  title: string;
  onClose: () => void;
  headerControls?: ReactNode;
  pins: MapPin[];
  routes?: MapRoute[];
  depot?: DeliveryMapDepot | null;
  depotReason?: string | null;
  focus?: MapFocus | null;
  onRouteClick?: (routeId: string) => void;
  selectedRef?: string | null;
  onPinClick?: (ref: string) => void;
  totals?: { orders: number; sets: number; revenueSen: number } | null;
  regionKey?: string | null;
  viewKey?: string;
  zoneSummary?: ZoneSummary | null;
  onZoneClick?: (key: string | null) => void;
  activeZoneKey?: string | null;
  fitRefs?: readonly string[] | null;
  compactColumns?: boolean | null;
  onCompactColumnsChange?: (on: boolean) => void;
  ungeocoded?: Array<{ ref: string; label?: string; reason: string }>;
  serverConfigured?: boolean;
  isLoading?: boolean;
  mapHeight?: number;
  children?: ReactNode;
  statusByRef?: Map<string, StopStatus> | null;
  routeStopRings?: boolean;
  vehicles?: VehiclePosition[];
  onVehicleClick?: (v: VehiclePosition) => void;
  className?: string;
};

const NO_VEHICLES: VehiclePosition[] = [];

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
  onZoneClick,
  activeZoneKey = null,
  fitRefs = null,
  compactColumns = null,
  onCompactColumnsChange,
  ungeocoded = [],
  serverConfigured = true,
  isLoading = false,
  mapHeight = 440,
  children,
  className,
  statusByRef = null,
  routeStopRings = false,
  vehicles = NO_VEHICLES,
  onVehicleClick,
}: DeliveryMapPanelProps) {
  const [colorBy, setColorBy] = useState<'status' | 'trip'>('status');
  const activeStatus = statusByRef && colorBy === 'status' ? statusByRef : null;
  const ringStops = routeStopRings && activeStatus != null;
  const statusCounts = useMemo(() => {
    const n: Record<StopStatus, number> = { done: 0, active: 0, overdue: 0, scheduled: 0 };
    for (const st of activeStatus?.values() ?? []) n[st] += 1;
    return n;
  }, [activeStatus]);
  const [failed, setFailed] = useState(false);
  const [hoverRef, setHoverRef] = useState<string | null>(null);
  const [legendHoverId, setLegendHoverId] = useState<string | null>(null);
  /* Which per-lorry rows have their stop-time windows expanded (owner 2026-11-04:
     the windows are secondary — a compact span shows on the row, per-stop times
     open on demand). */
  const [expandedRoutes, setExpandedRoutes] = useState<Set<string>>(() => new Set());
  const toggleRouteExpanded = (id: string) =>
    setExpandedRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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

  const cardRef = hoverRef ?? selectedRef;
  const card = useMemo(() => {
    if (!cardRef) return null;
    return pins.find((p) => p.ref === cardRef)?.card ?? null;
  }, [pins, cardRef]);
  const cardStop = useMemo(() => {
    if (!cardRef) return null;
    for (const r of routes) {
      const s = r.stops.find((st) => st.ref === cardRef);
      if (s) return { title: r.title, order: s.order, windowLabel: s.windowLabel, approximate: s.approximate === true };
    }
    return null;
  }, [routes, cardRef]);

  const legend = useMemo(() => legendFromRoutes(routes), [routes]);

  const center = pins[0]
    ? { lat: pins[0].lat, lng: pins[0].lng }
    : depot
      ? { lat: depot.lat, lng: depot.lng }
      : { lat: 3.139, lng: 101.6869 };

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
        {statusByRef && (
          <span className="inline-flex overflow-hidden rounded-full border border-border text-[11px]" role="group" aria-label="Colour stops by">
            {(['status', 'trip'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setColorBy(k)} aria-pressed={colorBy === k}
                className={colorBy === k ? 'bg-accent/10 px-2.5 py-0.5 font-semibold text-accent' : 'px-2.5 py-0.5 text-ink-secondary'}>
                {k === 'status' ? 'By status' : 'By trip'}
              </button>
            ))}
          </span>
        )}
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

      {zoneSummary && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
          {zoneSummary.entries.length === 0 && (
            <span className="text-[11.5px] text-ink-muted">No orders this day</span>
          )}
          {onZoneClick && zoneSummary.entries.length > 0 && (
            <button
              type="button"
              onClick={() => onZoneClick(null)}
              aria-pressed={activeZoneKey == null}
              className={['rounded-full border px-2 py-0.5 text-[11px]', activeZoneKey == null ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-transparent bg-surface-dim text-ink-secondary hover:bg-surface-raised'].join(' ')}
            >
              All
            </button>
          )}
          {zoneSummary.entries.map((e) => (onZoneClick ? (
            <button
              key={e.key}
              type="button"
              onClick={() => onZoneClick(e.key)}
              aria-pressed={activeZoneKey === e.key}
              title={`Fit the map to ${e.label}`}
              className={['rounded-full border px-2 py-0.5 text-[11px]', activeZoneKey === e.key ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-transparent bg-surface-dim text-ink-secondary hover:bg-surface-raised'].join(' ')}
            >
              {e.label} <span className="font-semibold text-ink">{e.count}</span>
            </button>
          ) : (
            <span key={e.key} className="rounded-full bg-surface-dim px-2 py-0.5 text-[11px] text-ink-secondary">
              {e.label} <span className="font-semibold text-ink">{e.count}</span>
            </span>
          )))}
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
                fitRefs={fitRefs}
                onPinClick={onPinClick}
                onRouteClick={onRouteClick}
                onHoverRef={setHoverRef}
                onMapTypeChange={setMapTypeId}
                statusByRef={activeStatus}
                ringStops={ringStops}
                vehicles={vehicles}
                onVehicleClick={onVehicleClick}
              />
            </GoogleMap>
          </APIProvider>
        )}

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

        {MAPS_KEY && !failed && !isLoading && pins.length === 0 && (
          <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-border bg-surface/95 px-2.5 py-1 text-[11.5px] text-ink-secondary shadow-sm">
            {(regionKey ?? 'ALL') === 'ALL' ? '0 orders on this day' : '0 orders in this region'}
          </div>
        )}

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
            {(card.approximate || cardStop?.approximate) && (
              <div className="text-[11px] font-semibold text-warning-text">Approximate location — postcode area, not the address</div>
            )}
          </div>
        )}
      </div>

      {ringStops && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-[11.5px] text-ink-secondary">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-ink-secondary" />
            Delivered <span className="font-semibold tabular-nums text-ink">{statusCounts.done}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-ink-secondary bg-transparent" />
            To deliver <span className="font-semibold tabular-nums text-ink">{statusCounts.active + statusCounts.scheduled}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 bg-transparent" style={{ borderColor: STOP_STATUS_COLOR.overdue }} />
            Late <span className="font-semibold tabular-nums text-ink">{statusCounts.overdue}</span>
          </span>
          {vehicles.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-3.5 rounded-sm bg-[#111827]" /> Lorry now <span className="font-semibold tabular-nums text-ink">{vehicles.length}</span>
            </span>
          )}
        </div>
      )}
      {activeStatus && !ringStops && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-[11.5px] text-ink-secondary">
          {(['done', 'active', 'overdue', 'scheduled'] as const).map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: STOP_STATUS_COLOR[k] }} />
              {STOP_STATUS_LABEL[k]} <span className="font-semibold tabular-nums text-ink">{statusCounts[k]}</span>
            </span>
          ))}
          {vehicles.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-3.5 rounded-sm bg-[#111827]" /> Lorry now <span className="font-semibold tabular-nums text-ink">{vehicles.length}</span>
            </span>
          )}
        </div>
      )}
      {/* Per-lorry picker (owner 2026-11-04: "车辆那里 — button"). Last Mile draws
          each lorry as a tappable BUTTON card — plate the label, driver + a
          delivered/total progress bar supporting it — and tapping it filters the
          map to that lorry's route; an "All" button (and tapping the active card
          again) clears back to every lorry. Per-stop times are secondary, behind
          the chevron. The proposal pages (no delivered/total) keep the plain row. */}
      {legend.length > 0 && legend.some((r) => r.delivered != null && r.total != null) && (
        <div className="border-b border-border px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">By lorry</span>
            <button
              type="button"
              onClick={() => { if (focus) onRouteClick?.(focus.routeId); }}
              aria-pressed={!focus}
              className={[
                'rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold transition-colors',
                !focus ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary hover:bg-surface-raised',
              ].join(' ')}
            >
              All lorries
            </button>
            <span className="text-[10.5px] text-ink-muted">tap one to show just its route</span>
          </div>
          <div className="space-y-2">
            {legend.map((row) => {
              const isFocused = focus?.routeId === row.routeId;
              const windowed = row.stops.filter((s) => s.windowLabel);
              const expanded = expandedRoutes.has(row.routeId);
              const total = row.total ?? 0;
              const delivered = row.delivered ?? 0;
              const pct = total > 0 ? Math.round((delivered / total) * 100) : 0;
              return (
                <div
                  key={row.routeId}
                  className="relative"
                  onMouseEnter={() => setLegendHoverId(row.routeId)}
                  onMouseLeave={() => setLegendHoverId(null)}
                >
                  <button
                    type="button"
                    onClick={() => onRouteClick?.(row.routeId)}
                    aria-pressed={isFocused}
                    title={isFocused ? 'Showing only this lorry — tap to show all' : "Tap to show only this lorry's route"}
                    className={[
                      'block w-full rounded-lg border px-2.5 py-2 pr-9 text-left transition-colors',
                      isFocused ? 'border-accent bg-accent/5 ring-1 ring-accent' : 'border-border hover:bg-surface-raised',
                    ].join(' ')}
                  >
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-3.5 w-3.5 flex-none rounded-full" style={{ background: row.color }} />
                      <span className="flex-none text-[13px] font-bold text-ink">{row.title}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">{row.crewLabel ?? ''}</span>
                      <span className="flex flex-none items-center gap-1.5">
                        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-dim">
                          <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: row.color }} />
                        </span>
                        <span className="tabular-nums text-[11.5px] text-ink-secondary">
                          <span className="font-semibold text-ink">{delivered}</span>/{total}
                        </span>
                      </span>
                    </span>
                    {(row.timeRange || isFocused || row.roadLabel) && (
                      <span className="mt-0.5 flex items-center gap-2 pl-[22px] text-[10.5px]">
                        {row.timeRange && <span className="tabular-nums text-ink-muted">{row.timeRange}</span>}
                        {row.roadLabel && <span className="tabular-nums font-semibold text-ink-secondary">{row.roadLabel}</span>}
                        {isFocused && <span className="font-semibold text-accent">Showing only this lorry</span>}
                      </span>
                    )}
                    {expanded && windowed.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1.5 pl-[22px]">
                        {windowed.map((s) => (
                          <span key={s.ref} className="rounded bg-surface-dim px-1.5 py-0.5 text-[10.5px] tabular-nums text-ink-secondary">
                            <span className="text-ink-muted">{s.order}.</span> {s.windowLabel}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                  {windowed.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleRouteExpanded(row.routeId)}
                      aria-expanded={expanded}
                      aria-label={expanded ? 'Hide stop times' : 'Show stop times'}
                      className="absolute right-1.5 top-2 rounded p-0.5 text-ink-muted hover:bg-surface-raised hover:text-ink"
                    >
                      <ChevronDown size={14} className={expanded ? 'rotate-180' : ''} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {legend.length > 0 && !legend.some((r) => r.delivered != null && r.total != null) && (
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
          <details className="group rounded-md border border-border bg-surface-dim text-[11px] text-ink-muted">
            <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-ink-secondary marker:content-['']">
              <ChevronDown size={13} className="flex-none transition-transform group-open:rotate-180" />
              <span className="font-semibold">{ungeocoded.length} couldn&rsquo;t be located</span>
              <span className="text-ink-muted">— check the address</span>
            </summary>
            <ul className="list-disc space-y-0.5 px-2.5 pb-2 pl-7">
              {ungeocoded.map((u) => (
                <li key={u.ref}>
                  <span className="font-mono">{u.label ?? u.ref}</span> — {u.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {children && <div className="border-t border-border p-3">{children}</div>}
    </aside>
  );
}
