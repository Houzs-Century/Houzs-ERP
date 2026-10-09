/* Where each lorry is now, for the Last Mile map (owner, 2026-10-07).

   Today the position comes from the crew's phone: while a run is IN_PROGRESS the
   driver app posts a GPS fix every ~25s (useTripLocationCapture -> trip_locations).
   A GPS vendor will hand off a feed later. This file is the ONE seam for that:
   swap the source inside useVehiclePositions and every map keeps working, since
   they only read VehiclePosition. */
import { useMemo } from "react";
import { useActiveTripLocations, type TripLocation } from "./trip-locations-queries";

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

type RunOfLorry = { id: string; lorry: { id: string; plate: string } | null; driver?: { name: string } | null };

/** The newest fix per run, labelled with the run's plate. A run with no fix yet
 *  has no marker — never a guessed position. */
export function vehiclePositionsFrom(locations: TripLocation[], runs: RunOfLorry[]): VehiclePosition[] {
  const runById = new Map(runs.map((r) => [r.id, r]));
  const newest = new Map<string, TripLocation>();
  for (const l of locations) {
    if (!runById.has(l.tripId)) continue;
    const cur = newest.get(l.tripId);
    if (!cur || l.recordedAt > cur.recordedAt) newest.set(l.tripId, l);
  }
  return [...newest.values()].map((l) => {
    const run = runById.get(l.tripId)!;
    return {
      key: run.lorry?.id ?? l.tripId,
      lorryId: run.lorry?.id ?? null,
      tripId: l.tripId,
      label: run.lorry?.plate ?? run.driver?.name ?? "Lorry",
      lat: l.lat,
      lng: l.lng,
      recordedAt: l.recordedAt,
      source: "phone",
    };
  });
}

export function useVehiclePositions(runs: RunOfLorry[], enabled: boolean): VehiclePosition[] {
  const q = useActiveTripLocations(enabled);
  return useMemo(() => vehiclePositionsFrom(q.data?.locations ?? [], runs), [q.data, runs]);
}
