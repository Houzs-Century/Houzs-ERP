// Vendored VERBATIM (minus the unused supabase import) from
// apps/backend/src/lib/state-warehouse-queries.ts — the SO Detail Sales-Location
// auto-populate + SO Maintenance state→warehouse mapping editor. authedFetch
// based already.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';

export type StateWarehouseMapping = {
  id:          string;
  state:       string;
  warehouseId: string | null;
  notes:       string | null;
  warehouse:   { id: string; code: string; name: string } | null;
  updatedAt:   string;
};

export function useStateWarehouseMappings() {
  return useQuery({
    queryKey: ['state-warehouse-mappings'],
    queryFn: () => authedFetch<{ mappings: StateWarehouseMapping[] }>('/state-warehouse-mappings'),
    staleTime: 30_000,
  });
}

export function useUpsertStateWarehouseMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ state, warehouseId, notes }: { state: string; warehouseId: string | null; notes: string | null }) =>
      authedFetch(`/state-warehouse-mappings/${encodeURIComponent(state)}`, {
        method: 'PUT',
        body: JSON.stringify({ warehouseId, notes }),
      }),
    onMutate: async ({ state, warehouseId, notes }) => {
      await qc.cancelQueries({ queryKey: ['state-warehouse-mappings'] });
      const previous = qc.getQueryData<{ mappings: StateWarehouseMapping[] }>(['state-warehouse-mappings']);
      qc.setQueryData<{ mappings: StateWarehouseMapping[] }>(['state-warehouse-mappings'], (old) => {
        const list = old?.mappings ?? [];
        const idx = list.findIndex((m) => m.state === state);
        const nextRow: StateWarehouseMapping = {
          id:          idx >= 0 ? list[idx]!.id : `pending-${state}`,
          state,
          warehouseId,
          notes,
          warehouse:   idx >= 0 ? list[idx]!.warehouse : null,
          updatedAt:   new Date().toISOString(),
        };
        const next = idx >= 0
          ? list.map((m, i) => (i === idx ? nextRow : m))
          : [...list, nextRow];
        return { mappings: next };
      });
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(['state-warehouse-mappings'], ctx.previous);
      /* Rolling back a rejected save without saying so reads as "it saved, then
         flickered back" — the operator believes the state is mapped to a
         warehouse it is not. This mapping routes deliveries, so a silently
         reverted edit misroutes real goods. */
      serviceNotify({
        title: 'Warehouse mapping not saved',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      });
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['state-warehouse-mappings'] }); },
  });
}

export function useDeleteStateWarehouseMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ state }: { state: string }) =>
      authedFetch(`/state-warehouse-mappings/${encodeURIComponent(state)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['state-warehouse-mappings'] }); },
  });
}
