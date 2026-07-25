// ----------------------------------------------------------------------------
// ScheduleRouteMap — the interactive Google Map for the Phase 3 scheduling
// drawer. Renders the depot + numbered stop pins + the route polyline for the
// CURRENT order (reorder happens in the drawer's stop list; this map reflects
// it). Uses the Maps JavaScript API through @vis.gl/react-google-maps.
//
// KEY: reads the BROWSER key from import.meta.env.VITE_GOOGLE_MAPS_API_KEY. When
// that env var is unset, this component is not mounted at all (the drawer shows a
// "map key not configured" note instead). If the Maps JS fails to load at runtime
// (bad key, referrer block, network), onError flips to a graceful in-place
// fallback rather than crashing the drawer.
//
// Markers + polyline are drawn IMPERATIVELY via useMap() so the map needs no
// cloud-configured mapId (classic raster map, numbered circle markers) — it works
// with any Maps-enabled key out of the box.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { APIProvider, Map, useMap } from "@vis.gl/react-google-maps";

export type RoutePoint = {
  ref: string;
  lat: number;
  lng: number;
  order: number;
  label: string;
  violated?: boolean;
};

/* Imperative overlay: markers + a polyline for depot -> stops (in order) ->
   depot, re-drawn whenever the order changes, with the viewport fit to the
   points. Cleans every object up on change / unmount so no marker leaks. */
function RouteOverlay({ depot, stops }: { depot: { lat: number; lng: number } | null; stops: RoutePoint[] }) {
  const map = useMap();
  const objectsRef = useRef<Array<{ setMap: (m: google.maps.Map | null) => void }>>([]);

  useEffect(() => {
    if (!map || typeof google === "undefined") return;
    // Clear previous overlay objects.
    for (const o of objectsRef.current) o.setMap(null);
    objectsRef.current = [];

    const bounds = new google.maps.LatLngBounds();
    const path: google.maps.LatLngLiteral[] = [];

    if (depot) {
      const d = { lat: depot.lat, lng: depot.lng };
      path.push(d);
      bounds.extend(d);
      const depotMarker = new google.maps.Marker({
        position: d,
        map,
        title: "Depot",
        zIndex: 1000,
        label: { text: "D", color: "#ffffff", fontWeight: "bold", fontSize: "12px" },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 13,
          fillColor: "#059669",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
      objectsRef.current.push(depotMarker);
    }

    for (const s of stops) {
      const p = { lat: s.lat, lng: s.lng };
      path.push(p);
      bounds.extend(p);
      const marker = new google.maps.Marker({
        position: p,
        map,
        title: `${s.order}. ${s.label}`,
        label: { text: String(s.order), color: "#ffffff", fontWeight: "bold", fontSize: "12px" },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 12,
          fillColor: s.violated ? "#dc2626" : "#2563eb",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
      objectsRef.current.push(marker);
    }

    if (depot && stops.length > 0) path.push({ lat: depot.lat, lng: depot.lng });

    if (path.length >= 2) {
      const line = new google.maps.Polyline({
        path,
        map,
        geodesic: true,
        strokeColor: "#2563eb",
        strokeOpacity: 0.85,
        strokeWeight: 3,
      });
      objectsRef.current.push(line);
    }

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, 48);
      // A single point leaves fitBounds zoomed all the way in — cap it.
      if (path.length <= 1) map.setZoom(14);
    }

    return () => {
      for (const o of objectsRef.current) o.setMap(null);
      objectsRef.current = [];
    };
  }, [map, depot, stops]);

  return null;
}

export function ScheduleRouteMap({
  apiKey,
  depot,
  stops,
}: {
  apiKey: string;
  depot: { lat: number; lng: number } | null;
  stops: RoutePoint[];
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-lg border border-dashed border-border bg-surface-dim px-4 text-center text-[12.5px] text-ink-muted">
        The map could not load. Check that VITE_GOOGLE_MAPS_API_KEY is valid and its referrer
        restriction allows this site. The proposed route + times below are unaffected.
      </div>
    );
  }

  const center = depot ?? (stops[0] ? { lat: stops[0].lat, lng: stops[0].lng } : { lat: 3.139, lng: 101.6869 });

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <APIProvider apiKey={apiKey} onError={() => setFailed(true)}>
        <Map
          defaultCenter={center}
          defaultZoom={11}
          gestureHandling="greedy"
          disableDefaultUI={false}
          style={{ width: "100%", height: 320 }}
        >
          <RouteOverlay depot={depot} stops={stops} />
        </Map>
      </APIProvider>
    </div>
  );
}
