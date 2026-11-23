// Vendored from apps/backend/src/lib/helpers-queries.ts — Helpers CRUD hooks.
// TMS fleet master (scm.helpers). Cloned from drivers-queries pattern.
//
// HOUZS VENDOR NOTE: the source has no `import { supabase } from './supabase'`
// to drop (it only imports authedFetch + react-query). Everything else is
// copied verbatim from 2990.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type HelperRow = {
  id: string;
  helper_code: string;
  name: string;
  contact: string | null;
  ic_number: string | null;
  // Migration 0195 — in-house staff helper vs outsourced. The pg driver
  // camelCases result cols, so consumers dual-read `inHouse ?? in_house`.
  in_house?: boolean;
  inHouse?: boolean;
  active: boolean;
  created_at: string;
  /** The 3PL company this person is registered under, or null. */
  threepl_company_id?: string | null;
  /** Mig 20261107T2000: the warehouse this helper works from. */
  warehouse_id?: string | null;
};

export type NewHelper = {
  /** Attach to a 3PL carrier. Setting it forces the row OUTSOURCE server-side. */
  threeplCompanyId?: string | null;
  /** OPTIONAL since 2026-08-02 — the server mints HLP-###. See NewDriver. */
  helperCode?: string;
  name: string;
  contact?: string;
  icNumber?: string;
  inHouse?: boolean;
  active?: boolean;
  warehouseId?: string | null;
};

/** `enabled: false` for a reader without the Fleet area, who could only get a 403. */
export function useHelpers(opts?: { includeInactive?: boolean; enabled?: boolean }) {
  return useQuery({
    queryKey: ['helpers', opts?.includeInactive ?? false],
    queryFn: () => authedFetch<{ helpers: HelperRow[] }>(
      `/helpers${opts?.includeInactive ? '?active=false' : ''}`,
    ).then((r) => r.helpers),
    enabled: opts?.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useCreateHelper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewHelper) =>
      authedFetch<{ helper: HelperRow }>(`/helpers`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['helpers'] }),
  });
}

export function useUpdateHelper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewHelper> & { id: string }) =>
      authedFetch<{ helper: HelperRow }>(`/helpers/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['helpers'] }),
  });
}
