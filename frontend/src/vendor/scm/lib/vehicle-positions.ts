/* Where each lorry is now, for the Last Mile map (owner, 2026-10-07).

   The position is the lorry's GPS tracker fix when it is fresh, else the crew
   phone's (while a run is IN_PROGRESS the driver app posts a fix every ~25s,
   useTripLocationCapture -> trip_locations). This file is the ONE seam: swap the
   source inside useVehiclePositions and every map keeps working, since they only
   read VehiclePosition. */
import { useMemo } from "react";
import { useActiveTripLocations, type TripLocation } from "./trip-locations-queries";
import { useLorryPositions, type LorryPosition } from "./lorries-queries";

export type VehiclePosition = {
  /** Stable marker key: the lorry when known, else the run. */
  key: string;
  lorryId: string | null;
  tripId: string;
  label: string;
  lat: number;
  lng: number;
  recordedAt: string;
  source: "phone" | "gps";
};

type RunOfLorry = { id: string; status: string; lorry: { id: string; plate: string } | null; driver?: { name: string } | null };

/** A tracker fix older than this loses to the phone (trackers report every 5 min). */
export const TRACKER_FRESH_MS = 15 * 60_000;

/** One marker per lorry (per run when it has no lorry). Per run: a fresh tracker fix wins, else the
 *  newest phone fix, else a stale tracker fix (so the office sees where it was). A run with no fix at
 *  all has no marker, never a guessed position. */
export function vehiclePositionsFrom(locations: TripLocation[], runs: RunOfLorry[], trackers: LorryPosition[], now: number, isToday: boolean): VehiclePosition[] {
  const runById = new Map(runs.map((r) => [r.id, r]));
  const trackerByLorry = new Map(trackers.map((t) => [t.lorry_id, t]));
  const newest = new Map<string, TripLocation>();
  for (const l of locations) {
    if (!runById.has(l.tripId)) continue;
    const cur = newest.get(l.tripId);
    if (!cur || l.recordedAt > cur.recordedAt) newest.set(l.tripId, l);
  }
  const out = new Map<string, VehiclePosition>();
  for (const run of runs) {
    // Tracker fixes are latest-only: valid for today's running runs, never a past day's.
    const t = isToday && run.status.toUpperCase() === "IN_PROGRESS" && run.lorry ? trackerByLorry.get(run.lorry.id) ?? null : null;
    const p = newest.get(run.id) ?? null;
    const fresh = t != null && now - Date.parse(t.recorded_at) <= TRACKER_FRESH_MS;
    const base = { key: run.lorry?.id ?? run.id, lorryId: run.lorry?.id ?? null, tripId: run.id, label: run.lorry?.plate ?? run.driver?.name ?? "Lorry" };
    const v: VehiclePosition | null = t && (fresh || !p)
      ? { ...base, lat: t.lat, lng: t.lng, recordedAt: t.recorded_at, source: "gps" }
      : p
        ? { ...base, lat: p.lat, lng: p.lng, recordedAt: p.recordedAt, source: "phone" }
        : null;
    const cur = v ? out.get(v.key) : undefined;
    if (v && (!cur || v.recordedAt > cur.recordedAt)) out.set(v.key, v);
  }
  return [...out.values()];
}

export function useVehiclePositions(runs: RunOfLorry[], enabled: boolean, isToday: boolean): VehiclePosition[] {
  const q = useActiveTripLocations(enabled);
  const trackers = useLorryPositions();
  return useMemo(() => vehiclePositionsFrom(q.data?.locations ?? [], runs, trackers.data ?? [], Date.now(), isToday), [q.data, trackers.data, runs, isToday]);
}
