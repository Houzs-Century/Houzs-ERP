// Saved "common locations" address book hooks (owner 2026-11-02 方案2) — the
// owner-maintained points a transfer is driven between. Backed by
// scm.saved_locations (mig 20261102T1700) via /api/scm/saved-locations. The DP
// order's origin / destination pickers read this list; the maintenance page CRUDs
// it. Per-company scoped server-side.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type SavedLocationRow = {
  id: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  state: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type NewSavedLocation = {
  name: string;
  contactName?: string | null;
  contactPhone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  postcode?: string | null;
  state?: string | null;
  notes?: string | null;
  isActive?: boolean;
};

export type SavedLocationPatch = Partial<NewSavedLocation> & { id: string };

const KEY = ['saved-locations'] as const;

export function useSavedLocations() {
  return useQuery({
    queryKey: KEY,
    queryFn: () =>
      authedFetch<{ locations: SavedLocationRow[] }>('/saved-locations').then((r) => r.locations),
    staleTime: 60_000,
  });
}

export function useCreateSavedLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewSavedLocation) =>
      authedFetch<{ location: SavedLocationRow }>('/saved-locations', {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useUpdateSavedLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SavedLocationPatch) =>
      authedFetch<{ location: SavedLocationRow }>(`/saved-locations/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useDeleteSavedLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/saved-locations/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}
