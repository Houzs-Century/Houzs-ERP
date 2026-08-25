// ----------------------------------------------------------------------------
// packing-list-queries — the day's PACKING LISTS read hook.
//
// `GET /trips/packing?date=&warehouseId=` returns ONE ENTRY PER TRIP for the
// picked day, because a packing list IS a trip: one lorry, one day (owner
// 2026-08-25). Three lorries out = three lists; a six-day week with one lorry
// a day = six lists on six dates. Nothing here writes — Delivery Time
// Arrangement sequences the stops and Last Mile Delivery crews them; this is a
// render of what they produced.
//
// Same pattern as the sibling fleet-day-queries: TanStack Query + authedFetch,
// rows as the API emits them. Stops arrive in DELIVERY order (stop_no
// ascending); the LOADING order is packing-list-model.ts's business.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type PackingItem = {
  line_no: number;
  item_code: string;
  description: string | null;
  qty: number;
  /** The rack this LINE leaves from, or null when no explicit pick was made. */
  rack: string | null;
};

export type PackingStop = {
  stop_no: number;
  stop_type: string | null;
  customer_name: string | null;
  address: string | null;
  do_id: string | null;
  do_number: string | null;
  do_status: string | null;
  /** The stop names a delivery order outside the companies you hold a grant for. */
  do_missing: boolean;
  units: number;
  items: PackingItem[];
};

export type PackingListRow = {
  trip_id: string;
  trip_no: string | null;
  trip_date: string | null;
  trip_status: string | null;
  lorry_plate: string | null;
  driver_name: string | null;
  warehouse_name: string | null;
  stop_count: number;
  do_count: number;
  units: number;
  /** Null — never 0 — when no member delivery order carries a volume. */
  m3_milli: number | null;
  stops: PackingStop[];
};

export type PackingListsResponse = {
  date: string;
  lists: PackingListRow[];
};

/** The request path, exported so it can be asserted without a React tree. */
export function packingListsPath(date: string, warehouseId: string | null): string {
  const p = new URLSearchParams();
  p.set('date', date);
  if (warehouseId) p.set('warehouseId', warehouseId);
  return `/trips/packing?${p.toString()}`;
}

/** One day's packing lists. Disabled until a date is set, like useFleetDay. */
export function usePackingLists(opts: { date: string | null; warehouseId?: string | null }) {
  const { date, warehouseId } = opts;
  return useQuery({
    queryKey: ['packing-lists', date ?? '', warehouseId ?? ''],
    queryFn: () => authedFetch<PackingListsResponse>(packingListsPath(date as string, warehouseId ?? null)),
    enabled: !!date,
    staleTime: 30_000,
  });
}
