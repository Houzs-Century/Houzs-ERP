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
// The LOGIC (pins, routes, focus filter, colours) is the pure model in
// vendor/scm/lib/delivery-map-model.ts; this file is the React/Maps shell.
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
// personal-pref idiom as ResizableDrawer's panel-* width keys).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { APIProvider, Map as GoogleMap, useMap } from '@vis.gl/react-google-maps';
import { X, MapPin as MapPinIcon } from 'lucide-react';
import { fmtCenti } from '../../vendor/shared/format';
import type { MapFocus, MapPin, MapRoute } from '../../vendor/scm/lib/delivery-map-model';

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

export type DeliveryMapDepot = { lat: number; lng: number; label?: string | null };

type OverlayProps = {
  pins: MapPin[];
  routes: MapRoute[];
  depot: DeliveryMapDepot | null;
  focus: MapFocus | null;
  selectedRef: string | null;
  onPinClick?: (ref: string) => void;
  onRouteClick?: (routeId: string) => void;
  onHoverRef?: (ref: string | null) => void;
};

/* Imperative overlay — markers + polylines drawn/torn down on every change so
   nothing leaks (the FleetDayMap pattern, extended with click/hover wiring,
   focus dimming and the selected-pin outline). */
function PanelOverlay({ pins, routes, depot, focus, selectedRef, onPinClick, onRouteClick, onHoverRef }: OverlayProps) {
  const map = useMap();
  const objectsRef = useRef<Array<{ setMap: (m: google.maps.Map | null) => void }>>([]);
  const listenersRef = useRef<google.maps.MapsEventListener[]>([]);

  /* Fit-to-content runs when the CONTENT or the FOCUS changes — not when the
     selection does (a row click pans, it must not re-zoom the whole view). */
  const contentSig = useMemo(
    () => JSON.stringify([
      pins.map((p) => p.ref),
      routes.map((r) => [r.id, r.stops.length]),
      depot ? [depot.lat, depot.lng] : null,
      focus?.routeId ?? null,
    ]),
    [pins, routes, depot, focus],
  );

  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    for (const l of listenersRef.current) l.remove();
    listenersRef.current = [];
    for (const o of objectsRef.current) o.setMap(null);
    objectsRef.current = [];

    const bounds = new google.maps.LatLngBounds();
    let anyPoint = false;
    const extend = (p: google.maps.LatLngLiteral, counts: boolean) => {
      if (counts) { bounds.extend(p); anyPoint = true; }
    };

    const focused = focus?.routeId ?? null;
    const onRouteRefs = new Set<string>();
    for (const r of routes) for (const s of r.stops) onRouteRefs.add(s.ref);

    /* Depot — one dark marker; dims only under focus if no route claims it. */
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
          fillOpacity: focused == null ? 1 : 0.55,
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

    /* Routes — polyline + numbered stops, dimmed unless focused (or no focus). */
    for (const route of routes) {
      const dimmed = focused != null && route.id !== focused;
      const opacity = dimmed ? 0.2 : 1;
      const path: google.maps.LatLngLiteral[] = [];
      if (route.depot) path.push({ lat: route.depot.lat, lng: route.depot.lng });
      for (const s of route.stops) {
        const p = { lat: s.lat, lng: s.lng };
        path.push(p);
        extend(p, !dimmed);
        const isSel = selectedRef != null && s.ref === selectedRef;
        const marker = new google.maps.Marker({
          position: p,
          map,
          title: `${route.title} · ${s.order}. ${s.label}${s.windowLabel ? ` (${s.windowLabel})` : ''}`,
          zIndex: isSel ? 3000 : dimmed ? 1 : 500,
          label: { text: String(s.order), color: '#ffffff', fontWeight: 'bold', fontSize: '11px' },
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: isSel ? 14 : 11,
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
          strokeOpacity: dimmed ? 0.2 : 0.85,
          strokeWeight: dimmed ? 2 : 3,
          zIndex: dimmed ? 1 : 100,
        });
        objectsRef.current.push(line);
        if (onRouteClick) listenersRef.current.push(line.addListener('click', () => onRouteClick(route.id)));
      }
    }

    /* Plain order pins — only for orders NOT already numbered on a route. */
    for (const pin of pins) {
      if (onRouteRefs.has(pin.ref)) continue;
      const dimmed = focused != null && !(focus?.refs ?? []).includes(pin.ref);
      const p = { lat: pin.lat, lng: pin.lng };
      extend(p, !dimmed);
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
    }

    if (anyPoint && !bounds.isEmpty()) {
      map.fitBounds(bounds, 56);
      const single = pins.length + routes.reduce((n, r) => n + r.stops.length, 0) <= 1;
      if (single) map.setZoom(14);
    }

    return () => {
      for (const l of listenersRef.current) l.remove();
      listenersRef.current = [];
      for (const o of objectsRef.current) o.setMap(null);
      objectsRef.current = [];
    };
    // contentSig folds pins/routes/depot/focus identity; handlers are stable per render pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, contentSig, selectedRef]);

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
  totals?: { orders: number; sets: number; revenueCenti: number } | null;
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
  ungeocoded = [],
  serverConfigured = true,
  isLoading = false,
  mapHeight = 440,
  children,
  className,
}: DeliveryMapPanelProps) {
  const [failed, setFailed] = useState(false);
  const [hoverRef, setHoverRef] = useState<string | null>(null);

  /* The mini card follows hover first, then the board/pin selection. */
  const cardRef = hoverRef ?? selectedRef;
  const card = useMemo(() => {
    if (!cardRef) return null;
    return pins.find((p) => p.ref === cardRef)?.card ?? null;
  }, [pins, cardRef]);

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
            {totals.orders} order{totals.orders === 1 ? '' : 's'} · {totals.sets} sets · {fmtCenti(totals.revenueCenti)}
          </span>
        )}
        <span className="flex-1" />
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
              style={{ width: '100%', height: mapHeight }}
            >
              <PanelOverlay
                pins={pins}
                routes={routes}
                depot={depot}
                focus={focus}
                selectedRef={selectedRef}
                onPinClick={onPinClick}
                onRouteClick={onRouteClick}
                onHoverRef={setHoverRef}
              />
            </GoogleMap>
          </APIProvider>
        )}

        {/* Mini card — hover/click: SO no, customer, sets, address. */}
        {card && (
          <div className="pointer-events-none absolute bottom-2 left-2 max-w-[85%] rounded-md border border-border bg-surface/95 px-3 py-2 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] font-semibold text-ink">{card.soDocNo}</span>
              {card.zone && <span className="text-[10.5px] font-semibold uppercase text-ink-secondary">{card.zone}</span>}
            </div>
            <div className="text-[12px] text-ink">{card.customer ?? '—'}</div>
            <div className="text-[11.5px] text-ink-secondary">
              {card.sets} set{card.sets === 1 ? '' : 's'} · {fmtCenti(card.revenueCenti)}
            </div>
            {card.address && <div className="text-[11px] text-ink-muted">{card.address}</div>}
          </div>
        )}
      </div>

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
