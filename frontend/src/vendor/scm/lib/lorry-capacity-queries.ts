// Lorry Capacity queries — STAGE 5B (final) of the Delivery / TMS module.
// Reads the performance dashboard (GET /lorry-capacity) and manages the two
// inline edits: the In-house checkbox (PATCH …/in-house) and the Repair Days
// number (PUT …/repair-days). Cloned from the lorries / delivery-planning query
// pattern (TanStack Query + authedFetch). Rows are snake_case as the API emits
// them; money fields are integer cents (centi) — divide by 100 for RM display.
//
// HOUZS VENDOR NOTE: 1:1 from 2990's apps/backend/src/lib/lorry-capacity-queries.ts.
// The source had no `supabase` import to drop; all calls go through authedFetch
// (→ /api/scm). Everything else is copied verbatim.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export type FleetFilter = 'all' | 'internal' | 'outsourced';

/* Per-lorry metric row. Counts are integers; utilisation / orders_per_trip are
   fractions/ratios already rounded server-side; *_sen are integer cents (null
   when the denominator was zero → render "—"). */
export type LorryCapacityRow = {
  lorry_id: string;
  plate: string;
  type: string | null;
  is_internal: boolean;
  work_days: number;
  repair_days: number;
  available_days: number;
  utilisation: number | null;          // fraction (0..n); render as %
  total_trips: number;
  delivery_days: number;
  deliveries: number;
  orders_per_trip: number | null;
  setup_dismantle: number;
  pickups: number;
  services: number;
  delivery_revenue_sen: number;
  revenue_per_order_sen: number | null;
  revenue_per_trip_sen: number | null;
};

export type LorryCapacityTotals = {
  lorries: number;
  total_trips: number;
  available_days: number;
  utilisation: number | null;
  orders_per_delivery_trip: number | null;
  delivery_revenue_sen: number;
  revenue_per_order_sen: number | null;
  revenue_per_trip_sen: number | null;
};

export type LorryCapacityResponse = {
  lorries: LorryCapacityRow[];
  totals: LorryCapacityTotals;
  workingDays: number;
  range: { from: string; to: string; fleet: FleetFilter };
};

/* The dashboard. from/to are YYYY-MM-DD; fleet = all | internal | outsourced. */
export function useLorryCapacity(opts: { from: string; to: string; fleet?: FleetFilter }) {
  const fleet = opts.fleet ?? 'all';
  return useQuery({
    queryKey: ['lorry-capacity', opts.from, opts.to, fleet],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('from', opts.from);
      params.set('to', opts.to);
      if (fleet !== 'all') params.set('fleet', fleet);
      return authedFetch<LorryCapacityResponse>(`/lorry-capacity?${params.toString()}`);
    },
    staleTime: 30_000,
  });
}

/* Toggle a lorry's In-house flag (is_internal) inline. */
export function useToggleLorryInHouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isInternal }: { id: string; isInternal: boolean }) =>
      authedFetch<{ lorry: { id: string; plate: string; is_internal: boolean } }>(
        `/lorry-capacity/lorries/${id}/in-house`,
        { method: 'PATCH', body: JSON.stringify({ isInternal }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorry-capacity'] }),
    onError: writeFailed,
  });
}

/* Set a lorry's repair days for the queried period (single managed window). */
export function useSetRepairDays() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, from, to, days }: { id: string; from: string; to: string; days: number }) =>
      authedFetch<{ ok: true; lorry_id: string; repair_days: number; working_days: number }>(
        `/lorry-capacity/lorries/${id}/repair-days`,
        { method: 'PUT', body: JSON.stringify({ from, to, days }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorry-capacity'] }),
  });
}
