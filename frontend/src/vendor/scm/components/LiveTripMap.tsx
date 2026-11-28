
import { useEffect, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import type { TripLocation } from '../lib/trip-locations-queries';

export type LiveMarker = {
  location: TripLocation;
  label: string;
  stale: boolean;
};

/* A lorry's driven path today, drawn under its pin (owner 2026-11-10). */
export type LiveTrail = { key: string; path: Array<{ lat: number; lng: number }> };
const NO_TRAILS: LiveTrail[] = [];

function TrailsOverlay({ trails }: { trails: LiveTrail[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    const lines = trails
      .filter((t) => t.path.length >= 2)
      .map((t) => new google.maps.Polyline({ path: t.path, map, strokeColor: '#475569', strokeOpacity: 0.8, strokeWeight: 4, zIndex: 1 }));
    return () => { for (const l of lines) l.setMap(null); };
  }, [map, trails]);
  return null;
}

function MarkersOverlay({ markers }: { markers: LiveMarker[] }) {
  const map = useMap();
  const objectsRef = useRef<Array<{ setMap: (m: google.maps.Map | null) => void }>>([]);
  const fittedRef = useRef(false);

  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    for (const o of objectsRef.current) o.setMap(null);
    objectsRef.current = [];

    const bounds = new google.maps.LatLngBounds();
    let n = 0;
    for (const m of markers) {
      const p = { lat: m.location.lat, lng: m.location.lng };
      bounds.extend(p);
      n += 1;
      const marker = new google.maps.Marker({
        position: p,
        map,
        title: `${m.label}${m.stale ? ' (stale)' : ''}`,
        label: { text: String(n), color: '#ffffff', fontWeight: 'bold', fontSize: '12px' },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 12,
          fillColor: m.stale ? '#d97706' : '#2563eb',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      objectsRef.current.push(marker);

      if (m.location.accuracyM && m.location.accuracyM > 0) {
        const circle = new google.maps.Circle({
          map,
          center: p,
          radius: m.location.accuracyM,
          strokeColor: m.stale ? '#d97706' : '#2563eb',
          strokeOpacity: 0.4,
          strokeWeight: 1,
          fillColor: m.stale ? '#d97706' : '#2563eb',
          fillOpacity: 0.08,
        });
        objectsRef.current.push(circle);
      }
    }

    if (!bounds.isEmpty() && !fittedRef.current) {
      map.fitBounds(bounds, 64);
      if (n <= 1) map.setZoom(14);
      fittedRef.current = true;
    }

    return () => {
      for (const o of objectsRef.current) o.setMap(null);
      objectsRef.current = [];
    };
  }, [map, markers]);

  return null;
}

export function LiveTripMap({
  apiKey,
  markers,
  trails = NO_TRAILS,
  height = 320,
}: {
  apiKey: string;
  markers: LiveMarker[];
  trails?: LiveTrail[];
  height?: number;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-surface-dim px-4 text-center text-[12.5px] text-ink-muted" style={{ height }}>
        The map could not load. Check that VITE_GOOGLE_MAPS_API_KEY is valid and its referrer
        restriction allows this site.
      </div>
    );
  }

  const first = markers[0]?.location;
  const center = first ? { lat: first.lat, lng: first.lng } : { lat: 3.139, lng: 101.6869 };

  return (
    <div className="relative overflow-hidden rounded-lg border border-border">
      <APIProvider apiKey={apiKey} onError={() => setFailed(true)}>
        <Map
          defaultCenter={center}
          defaultZoom={11}
          gestureHandling="greedy"
          disableDefaultUI={false}
          style={{ width: '100%', height }}
        >
          <TrailsOverlay trails={trails} />
          <MarkersOverlay markers={markers} />
        </Map>
      </APIProvider>
      {markers.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-surface/85 px-3 py-2 text-center text-[12px] text-ink-muted">
          Waiting for the driver&apos;s first location. Tracking starts when the driver opens the
          delivery page and the trip is in progress.
        </div>
      )}
    </div>
  );
}
