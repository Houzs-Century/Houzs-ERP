
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export type FleetFilter = 'all' | 'internal' | 'outsourced';

export type LorryCapacityRow = {
  lorry_id: string;
  plate: string;
  type: string | null;
  is_internal: boolean;
  work_days: number;
  repair_days: number;
  available_days: number;
  utilisation: number | null;
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
  km: number | null;
  running_cost_sen: number | null;
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
  km_incomplete: string | null;
};

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

export function useToggleLorryInHouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isInternal }: { id: string; isInternal: boolean }) =>
      authedFetch<{ lorry: { id: string; plate: string; is_internal: boolean } }>(
        `/lorry-capacity/lorries/${id}/in-house`,
        { method: 'PATCH', body: JSON.stringify({ isInternal }) },
      ),
    onSuccess: () => Promise.all([['lorry-capacity'], ['lorries'], ['logistic-overview']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
    onError: writeFailed,
  });
}

export function useSetRepairDays() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, from, to, days }: { id: string; from: string; to: string; days: number }) =>
      authedFetch<{ ok: true; lorry_id: string; repair_days: number; working_days: number }>(
        `/lorry-capacity/lorries/${id}/repair-days`,
        { method: 'PUT', body: JSON.stringify({ from, to, days }) },
      ),
    onSuccess: () => Promise.all([['lorry-capacity'], ['logistic-overview']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
