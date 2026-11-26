
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import type { HistoryRow } from './fleet-day-cards';

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
  planned_depart_at: string | null;
  clock_in_at: string | null;
  clock_out_at: string | null;
  lorry: { id: string; plate: string } | null;
  driver: { id: string; name: string } | null;
  helpers: Array<{ id: string; name: string }>;
  warehouse: FleetDayWarehouse | null;
  depot: { lat: number; lng: number } | null;
  total_revenue_sen: number;
  total_drops: number;
  total_delivered: number;
  total_with_pod: number;
  stops: FleetDayStop[];
};

export type FleetDayResponse = {
  date: string;
  configured: boolean;
  warehouses: FleetDayWarehouse[];
  trips: FleetDayTrip[];
};

/** The Last Mile History tab (phase 3c): delivered drops whose delivery day is
 *  in [from,to]. Disabled until both ends are set. */
export function useDeliveryHistory(from: string | null, to: string | null) {
  return useQuery({
    queryKey: ['fleet-history', from ?? '', to ?? ''],
    queryFn: () => authedFetch<{ rows: HistoryRow[] }>(
      `/trips/history?from=${encodeURIComponent(from ?? '')}&to=${encodeURIComponent(to ?? '')}`,
    ).then((r) => r.rows),
    enabled: !!from && !!to,
    staleTime: 60_000,
  });
}

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
