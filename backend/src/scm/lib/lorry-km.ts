// Own-lorry running cost: km driven from the Velocity fixes (scm.lorry_positions)
// x the lorry's cost_per_km_sen. Pure, so the light test project covers it.

export type Fix = { lat: number; lng: number; recorded_at: string };

const EARTH_KM = 6371;
// ponytail: a hop faster than this is treated as a GPS jump and skipped; a
// road-snapped distance (map-matching API) if straight-line km proves too low.
const MAX_KMH = 150;
// ponytail: a hop under this is parked-GPS drift (288 fixes/day x a few metres
// adds phantom km); an ignition-aware filter if crawling traffic gets lost.
const MIN_HOP_KM = 0.05;

function haversineKm(a: Fix, b: Fix): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Straight-line km between consecutive fixes, in time order. Fixes are 5 min
 *  apart, so this under-counts winding roads slightly. */
export function kmFromFixes(fixes: Fix[]): number {
  const sorted = [...fixes].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  let km = 0;
  for (let i = 1; i < sorted.length; i++) {
    const d = haversineKm(sorted[i - 1], sorted[i]);
    const hours = (Date.parse(sorted[i].recorded_at) - Date.parse(sorted[i - 1].recorded_at)) / 3_600_000;
    if (hours <= 0 || d < MIN_HOP_KM || d / hours > MAX_KMH) continue;
    km += d;
  }
  return Math.round(km * 10) / 10;
}

/** null when the lorry has no rate set: unknown cost is not zero cost. */
export function costSen(km: number, costPerKmSen: number | null): number | null {
  return costPerKmSen == null ? null : Math.round(km * costPerKmSen);
}

/** The UTC window for one Malaysia (UTC+8) calendar day; null for a date that
 *  does not exist (2026-13-45, or 2026-02-30 which Date.parse rolls to 2 Mar).
 *  A hop across midnight counts on neither day. */
export function myDayWindow(date: string): { from: string; to: string } | null {
  const start = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start) || new Date(start + 8 * 3_600_000).toISOString().slice(0, 10) !== date) return null;
  return { from: new Date(start).toISOString(), to: new Date(start + 86_400_000).toISOString() };
}
