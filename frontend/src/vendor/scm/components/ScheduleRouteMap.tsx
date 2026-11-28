
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

/** Where the lorry is now (Fleet Health's lorry page) — a dark marker on top. */
export type RouteVehicle = { lat: number; lng: number; label: string };

/** True when every point is the same spot, so fitBounds has no area to fit and the map needs a fixed street zoom. */
export function isOnePlace(points: ReadonlyArray<{ lat: number; lng: number }>): boolean {
  const first = points.at(0);
  return first === undefined || points.every((p) => p.lat === first.lat && p.lng === first.lng);
}

function RouteOverlay({ depot, stops, vehicle, track, drops }: { depot: { lat: number; lng: number } | null; stops: RoutePoint[]; vehicle: RouteVehicle | null; track: Array<{ lat: number; lng: number }>; drops: RoutePoint[] }) {
  const map = useMap();
  const objectsRef = useRef<Array<{ setMap: (m: google.maps.Map | null) => void }>>([]);
  const vehicleRef = useRef(vehicle);
  vehicleRef.current = vehicle;
  const markerRef = useRef<google.maps.Marker | null>(null);

  useEffect(() => {
    if (!map || typeof google === "undefined") return;
    if (!vehicle) { markerRef.current?.setMap(null); markerRef.current = null; return; }
    const v = { lat: vehicle.lat, lng: vehicle.lng };
    if (!markerRef.current) {
      markerRef.current = new google.maps.Marker({
        position: v, map, title: vehicle.label, zIndex: 2000,
        icon: { path: "M -11 -7 L 5 -7 L 5 -3 L 9 -3 L 12 1 L 12 6 L -11 6 Z", scale: 1.4, fillColor: "#111827", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 },
      });
    } else {
      markerRef.current.setPosition(v);
      markerRef.current.setTitle(vehicle.label);
    }
  }, [map, vehicle]);
  useEffect(() => () => { markerRef.current?.setMap(null); markerRef.current = null; }, []);

  useEffect(() => {
    if (!map || typeof google === "undefined") return;
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

    for (const s of drops) {
      const p = { lat: s.lat, lng: s.lng };
      bounds.extend(p);
      objectsRef.current.push(new google.maps.Marker({
        position: p,
        map,
        title: `${s.order}. ${s.label}`,
        zIndex: 1500,
        label: { text: String(s.order), color: "#ffffff", fontWeight: "bold", fontSize: "12px" },
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: "#ea580c", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 },
      }));
    }

    if (depot && stops.length > 0) path.push({ lat: depot.lat, lng: depot.lng });

    if (track.length >= 2) {
      for (const p of track) bounds.extend(p);
      objectsRef.current.push(new google.maps.Polyline({
        path: track, map, geodesic: true, strokeColor: "#475569", strokeOpacity: 0.8, strokeWeight: 4, zIndex: 1,
      }));
    }

    const vehicleNow = vehicleRef.current;
    if (vehicleNow) bounds.extend({ lat: vehicleNow.lat, lng: vehicleNow.lng });

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
      if (isOnePlace([...path, ...drops, ...track, ...(vehicleNow ? [vehicleNow] : [])])) map.setZoom(14);
    }

    return () => {
      for (const o of objectsRef.current) o.setMap(null);
      objectsRef.current = [];
    };
  }, [map, depot, stops, track, drops]);

  return null;
}

const NO_TRACK: Array<{ lat: number; lng: number }> = [];
const NO_DROPS: RoutePoint[] = [];

export function ScheduleRouteMap({
  apiKey,
  depot,
  stops,
  vehicle = null,
  track = NO_TRACK,
  drops = NO_DROPS,
}: {
  apiKey: string;
  depot: { lat: number; lng: number } | null;
  stops: RoutePoint[];
  vehicle?: RouteVehicle | null;
  track?: Array<{ lat: number; lng: number }>;
  drops?: RoutePoint[];
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
          <RouteOverlay depot={depot} stops={stops} vehicle={vehicle} track={track} drops={drops} />
        </Map>
      </APIProvider>
    </div>
  );
}
