// ----------------------------------------------------------------------------
// fleet-day-model.ts — PURE view-model transforms for the A4 day map + run-sheet.
//
// The page + run-sheet stay thin: the shaping that turns the API's day trips into
// map routes (only geocoded stops become pins) and the small display helpers
// (ETA offset -> clock, time window text) live here so they are unit-testable
// without React or a Google map.
// ----------------------------------------------------------------------------

import type { FleetDayTrip } from './fleet-day-queries';
import type { FleetMapRoute } from '../components/FleetDayMap';
import { routeColorFor } from './fleet-colors';

/**
 * Build the map routes for the day. PURE. Each trip becomes one coloured route;
 * only GEOCODED stops become map points (an ungeocoded stop has no pin — honest,
 * never a fabricated 0,0), renumbered 1..M in their existing stop order so the map
 * numbering is contiguous even when a middle stop could not be located. A route
 * with no geocoded stop and no depot is dropped (nothing to draw).
 */
export function buildMapRoutes(trips: FleetDayTrip[], colors: Map<string, string>): FleetMapRoute[] {
  const routes: FleetMapRoute[] = [];
  for (const t of trips) {
    const points = t.stops
      .filter((s) => s.geocoded && s.lat != null && s.lng != null)
      .map((s, i) => ({
        ref: s.id,
        lat: s.lat as number,
        lng: s.lng as number,
        order: i + 1,
        label: s.customer_name ?? s.address ?? `Stop ${s.stop_no}`,
      }));
    if (points.length === 0 && !t.depot) continue;
    routes.push({ id: t.id, color: routeColorFor(colors, t.id), depot: t.depot, stops: points });
  }
  return routes;
}

/** ETA offset (seconds from departure) -> a readable "+1h 20m from depart". PURE. */
export function etaLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const s = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `+${h}h ${m}m` : `+${m}m`;
}

/** A delivery time window -> "10:00–17:00", "from 10:00", "by 17:00" or "". PURE. */
export function windowLabel(earliest: string | null, latest: string | null): string {
  const e = (earliest ?? '').trim();
  const l = (latest ?? '').trim();
  if (e && l) return `${e}–${l}`;
  if (e) return `from ${e}`;
  if (l) return `by ${l}`;
  return '';
}

/** metres -> "12.3 km", null-safe ("—"). PURE. */
export function kmLabel(metres: number | null | undefined): string {
  if (metres == null || !Number.isFinite(Number(metres))) return '—';
  return `${(Number(metres) / 1000).toFixed(1)} km`;
}
