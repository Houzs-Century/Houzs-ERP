// ----------------------------------------------------------------------------
// FleetDayMap — the A4 day-view map: EVERY lorry's route on ONE Google map, each
// a distinct colour with numbered stops 1->2->3, the depot as origin.
//
// Same infra as the Phase-3 ScheduleRouteMap (@vis.gl/react-google-maps + an
// imperative useMap() overlay, classic raster map so no cloud mapId is needed) —
// this is the MULTI-route sibling: ScheduleRouteMap draws one order's route, this
// draws N coloured routes for a whole day and can FOCUS one (the others fade).
//
// KEY: reads VITE_GOOGLE_MAPS_API_KEY from the caller. When unset the caller does
// not mount this at all (the page shows a "map key not configured" note). If the
// Maps JS fails to load at runtime, onError flips to a graceful in-place fallback.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';

export type FleetMapStop = {
  ref: string;
  lat: number;
  lng: number;
  order: number;
  label: string;
};

export type FleetMapRoute = {
  id: string;
  color: string;
  depot: { lat: number; lng: number } | null;
  stops: FleetMapStop[];
};

/* Imperative overlay: for each route, a depot marker (its colour), numbered stop
   markers and a depot->stops->depot polyline. Re-drawn whenever the routes or the
   focus change; every object is torn down on change / unmount so nothing leaks. */
function RoutesOverlay({ routes, focusedId }: { routes: FleetMapRoute[]; focusedId: string | null }) {
  const map = useMap();
  const objectsRef = useRef<Array<{ setMap: (m: google.maps.Map | null) => void }>>([]);

  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    for (const o of objectsRef.current) o.setMap(null);
    objectsRef.current = [];

    const bounds = new google.maps.LatLngBounds();
    let anyPoint = false;

    for (const route of routes) {
      const dimmed = focusedId != null && route.id !== focusedId;
      const opacity = dimmed ? 0.2 : 1;
      const path: google.maps.LatLngLiteral[] = [];

      if (route.depot) {
        const d = { lat: route.depot.lat, lng: route.depot.lng };
        path.push(d);
        if (!dimmed) { bounds.extend(d); anyPoint = true; }
        const depotMarker = new google.maps.Marker({
          position: d,
          map,
          title: 'Depot',
          zIndex: dimmed ? 1 : 1000,
          opacity,
          label: { text: 'D', color: '#ffffff', fontWeight: 'bold', fontSize: '11px' },
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 12,
            fillColor: route.color,
            fillOpacity: opacity,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
        });
        objectsRef.current.push(depotMarker);
      }

      for (const s of route.stops) {
        const p = { lat: s.lat, lng: s.lng };
        path.push(p);
        if (!dimmed) { bounds.extend(p); anyPoint = true; }
        const marker = new google.maps.Marker({
          position: p,
          map,
          title: `${s.order}. ${s.label}`,
          zIndex: dimmed ? 1 : 500,
          opacity,
          label: { text: String(s.order), color: '#ffffff', fontWeight: 'bold', fontSize: '11px' },
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 11,
            fillColor: route.color,
            fillOpacity: opacity,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
        });
        objectsRef.current.push(marker);
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
      }
    }

    if (anyPoint && !bounds.isEmpty()) {
      map.fitBounds(bounds, 56);
      // A single point leaves fitBounds zoomed all the way in — cap it.
      const one = routes.reduce((n, r) => n + r.stops.length + (r.depot ? 1 : 0), 0) <= 1;
      if (one) map.setZoom(14);
    }

    return () => {
      for (const o of objectsRef.current) o.setMap(null);
      objectsRef.current = [];
    };
  }, [map, routes, focusedId]);

  return null;
}

export function FleetDayMap({
  apiKey,
  routes,
  focusedId = null,
  height = 460,
}: {
  apiKey: string;
  routes: FleetMapRoute[];
  focusedId?: string | null;
  height?: number;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-border bg-surface-dim px-4 text-center text-[12.5px] text-ink-muted"
        style={{ height }}
      >
        The map could not load. Check that VITE_GOOGLE_MAPS_API_KEY is valid and its referrer
        restriction allows this site. The stop lists below are unaffected.
      </div>
    );
  }

  // Centre on the first geocoded point, else KL.
  const first = routes.find((r) => r.depot || r.stops.length > 0);
  const center = first?.depot ?? (first?.stops[0]
    ? { lat: first.stops[0].lat, lng: first.stops[0].lng }
    : { lat: 3.139, lng: 101.6869 });

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <APIProvider apiKey={apiKey} onError={() => setFailed(true)}>
        <Map
          defaultCenter={center}
          defaultZoom={11}
          gestureHandling="greedy"
          disableDefaultUI={false}
          style={{ width: '100%', height }}
        >
          <RoutesOverlay routes={routes} focusedId={focusedId} />
        </Map>
      </APIProvider>
    </div>
  );
}
