
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LOOKUP_CACHE } from './lookup-cache';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';


export type RegionMasterRow = {
  id: string;
  code: string;
  name: string;
  sortOrder?: number;
  sort_order?: number;
  active: boolean;
  createdAt?: string | null;
  created_at?: string | null;
};

/** Dual-read sortOrder off a region row. */
export const sortOrderOf = (r: RegionMasterRow): number =>
  Number(r.sortOrder ?? r.sort_order ?? 0);

export type NewRegion = {
  code: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
};

const REGIONS_KEY = ['delivery-planning-regions'] as const;
const STATES_KEY = ['delivery-planning-region-states'] as const;

export function useDeliveryPlanningRegions() {
  return useQuery({
    queryKey: REGIONS_KEY,
    queryFn: () =>
      authedFetch<{ regions: RegionMasterRow[] }>('/delivery-planning-regions')
        .then((r) => r.regions),
    ...LOOKUP_CACHE,
  });
}

export function useCreateDeliveryPlanningRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewRegion) =>
      authedFetch<{ region: RegionMasterRow }>('/delivery-planning-regions', {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: REGIONS_KEY }),
  });
}

export function useUpdateDeliveryPlanningRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewRegion> & { id: string }) =>
      authedFetch<{ region: RegionMasterRow }>(`/delivery-planning-regions/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: REGIONS_KEY });
      void qc.invalidateQueries({ queryKey: STATES_KEY });
    },
    onError: writeFailed,
  });
}

export function useDeleteDeliveryPlanningRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/delivery-planning-regions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: REGIONS_KEY });
      qc.invalidateQueries({ queryKey: STATES_KEY });
    },
  });
}


export type StateRegions = {
  stateKey: string;
  country: string;
  regionCodes: string[];
};

/** Full per-state → region-codes map (drives the SO Maintenance multi-select). */
export function useStateDeliveryRegions() {
  return useQuery({
    queryKey: STATES_KEY,
    queryFn: () =>
      authedFetch<{ states: StateRegions[] }>('/delivery-planning-regions/states')
        .then((r) => r.states),
    ...LOOKUP_CACHE,
  });
}

/** Replace ONE state's region set. stateKey = state NAME; country defaults to
    Malaysia (Singapore passes country='Singapore'). */
export function useSetStateDeliveryRegions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stateKey, regionCodes, country }: {
      stateKey: string; regionCodes: string[]; country?: string;
    }) =>
      authedFetch<{ ok: true; stateKey: string; country: string; regionCodes: string[] }>(
        `/delivery-planning-regions/states/${encodeURIComponent(stateKey)}`,
        { method: 'PUT', body: JSON.stringify({ regionCodes, country }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATES_KEY }),
  });
}
