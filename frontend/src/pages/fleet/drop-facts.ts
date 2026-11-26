import { haversineMeters } from "../../vendor/shared/hr-attendance";

type At = { lat: number | null; lng: number | null };
type Fix = { lat: number; lng: number; recorded_at: string };

/** A POD more than this far from the stop's address is flagged. */
export const FAR_FROM_ADDRESS_M = 1000;
/** A fix this close to the drop counts as the lorry being on site. */
export const ON_SITE_RADIUS_M = 300;

/** Metres from the POD to the planned stop's address; null when either has no GPS. PURE. */
export function metresFromAddress(drop: At, stop: At | null): number | null {
  if (drop.lat == null || drop.lng == null || stop?.lat == null || stop.lng == null) return null;
  return Math.round(haversineMeters(drop.lat, drop.lng, stop.lat, stop.lng));
}

/** Minutes the lorry stayed near the drop: the unbroken run of fixes within ON_SITE_RADIUS_M around
 *  the fix nearest in time to the POD. null when no fix is near. 5-min fixes, so it is to about 5 min. PURE. */
export function minutesOnSite(drop: At & { at: string }, fixes: Fix[]): number | null {
  if (drop.lat == null || drop.lng == null) return null;
  const { lat, lng } = drop;
  const near = fixes.map((f) => haversineMeters(lat, lng, f.lat, f.lng) <= ON_SITE_RADIUS_M);
  const t = Date.parse(drop.at);
  let best = -1;
  for (let i = 0; i < fixes.length; i++) {
    if (near[i] && (best < 0 || Math.abs(Date.parse(fixes[i]!.recorded_at) - t) < Math.abs(Date.parse(fixes[best]!.recorded_at) - t))) best = i;
  }
  if (best < 0) return null;
  let a = best;
  let b = best;
  while (a > 0 && near[a - 1]) a--;
  while (b < fixes.length - 1 && near[b + 1]) b++;
  return Math.round((Date.parse(fixes[b]!.recorded_at) - Date.parse(fixes[a]!.recorded_at)) / 60_000);
}
