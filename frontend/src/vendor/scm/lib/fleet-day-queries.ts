// ----------------------------------------------------------------------------
// fleet-day-queries.ts — the Fleet Module A4 day-view read hook.
//
// A4 is a READ / RENDER layer over trips that are ALREADY scheduled: GET
// /trips/day?date=&warehouseId= returns every trip on one date, each with its
// ordered stops enriched (customer / phone / house type / window / ETA / revenue)
// and geocoded (cache-first, gated on the maps key) for the day map + the
// printable driver run-sheet. Nothing here writes — the Trips page owns creation.
//
// Same pattern as the sibling trips-queries: TanStack Query + authedFetch, rows
// as the API emits them.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type FleetDayWarehouse = {
  id: string;
  name: string;
  code: string | null;
};

export type FleetDayStop = {
  id: string;
  stop_no: number;
  stop_type: string;
  customer_name: string | null;
  address: string | null;
  phone: string | null;
  house_type: string | null;
  earliest_time: string | null;
  latest_time: string | null;
  access_note: string | null;
  eta_offset_s: number | null;
  leg_distance_m: number | null;
  revenue_sen: number;
  lat: number | null;
  lng: number | null;
  geocoded: boolean;
};

export type FleetDayTrip = {
  id: string;
  trip_no: string | null;
  trip_date: string | null;
  status: string;
  is_outsourced: boolean;
  total_distance_km: number | null;
  lorry: { id: string; plate: string } | null;
  driver: { id: string; name: string } | null;
  helpers: Array<{ id: string; name: string }>;
  warehouse: FleetDayWarehouse | null;
  depot: { lat: number; lng: number } | null;
  total_revenue_sen: number;
  total_drops: number;
  stops: FleetDayStop[];
};

export type FleetDayResponse = {
  date: string;
  /** False = GOOGLE_MAPS_API_KEY unset server-side: trips + stops still present,
   *  the map just has no geocoded pins. */
  configured: boolean;
  warehouses: FleetDayWarehouse[];
  trips: FleetDayTrip[];
};

/** Fetch a whole day's fleet. `date` is required (YYYY-MM-DD); `warehouseId`
 *  narrows to one depot. Disabled until a date is set. */
export function useFleetDay(opts: { date: string | null; warehouseId?: string | null }) {
  const { date, warehouseId } = opts;
  return useQuery({
    queryKey: ['fleet-day', date ?? '', warehouseId ?? ''],
    queryFn: () => {
      const p = new URLSearchParams();
      if (date) p.set('date', date);
      if (warehouseId) p.set('warehouseId', warehouseId);
      return authedFetch<FleetDayResponse>(`/trips/day?${p.toString()}`);
    },
    enabled: !!date,
    staleTime: 30_000,
  });
}
