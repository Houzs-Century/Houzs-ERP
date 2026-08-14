// Vendored from apps/backend/src/lib/delivery-planning-regions-queries.ts —
// Delivery Planning Regions CONFIG hooks for the owner-maintained region master
// + the per-state → region(s) multi-mapping that drives the Delivery Planning
// board's tabs (migration 0053 / route delivery-planning-regions.ts).
//
// Two surfaces:
//   • the region MASTER (delivery_planning_regions) — code / name / sortOrder /
//     active, with create / patch / delete. Delete surfaces a 409 region_in_use
//     when a state still maps to it.
//   • the per-STATE mapping (state_delivery_regions) — a state (keyed by NAME +
//     country) maps to MANY region codes. Read the full map for the editor;
//     PUT replaces ONE state's set.
//
// The API emits camelCase already (the route shapes rows out), but we dual-read
// camelCase ?? snake_case where the pg driver might surface either.
//
// HOUZS VENDOR NOTE: the source `import { supabase } from './supabase'` was
// imported but NEVER referenced (all calls go through authedFetch → /api/scm);
// it is DROPPED exactly as in the other vendored query slices. Everything else
// is copied verbatim.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

/* ── Region master ──────────────────────────────────────────────────────── */

export type RegionMasterRow = {
  id: string;
  code: string;
  name: string;
  // The route shapes these out camelCase; dual-read in case the pg path leaks snake_case.
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
    staleTime: 60_000,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: REGIONS_KEY }),
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

/* ── Per-state → region(s) mapping ──────────────────────────────────────── */

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
    staleTime: 30_000,
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
