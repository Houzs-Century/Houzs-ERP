// Vendored from apps/backend/src/lib/drivers-queries.ts — Drivers CRUD hooks
// used by the Drivers page (and, in 2990's, the DO driver picker).
//
// HOUZS VENDOR NOTE: the source `import { supabase } from './supabase'` was
// imported but NEVER referenced (all calls go through authedFetch → /api/scm);
// it is DROPPED exactly as in the other vendored query slices. Everything else
// is copied verbatim.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type DriverRow = {
  id: string;
  driver_code: string;
  name: string;
  phone: string;
  ic_number: string | null;
  vehicle: string | null;
  // Migration 0195 — in-house staff driver vs outsourced/3rd-party.
  //
  // Consumers dual-read `inHouse ?? in_house`, and the camel half is DEAD. The
  // reason previously given here ("the pg driver camelCases result cols") is
  // Hookka's rule and is false for Houzs: pg.ts:5-10 deliberately does not
  // install that transform ("fix the route, do not flip a global transform"),
  // and these rows never reach the pg driver anyway — they come from PostgREST
  // over /api/scm/drivers, which returns the snake_case names listed in
  // scm/routes/drivers.ts:24's COLS. Only the snake half ever resolves. The
  // reads are kept (`?? ` is free and every sibling SCM surface has the same
  // shape); the claim is not.
  in_house?: boolean;
  inHouse?: boolean;
  active: boolean;
  created_at: string;
};

export type NewDriver = {
  /** Attach to a 3PL carrier. Setting it forces the row OUTSOURCE server-side. */
  threeplCompanyId?: string | null;
  driverCode: string;
  name: string;
  phone: string;
  icNumber?: string;
  vehicle?: string;
  inHouse?: boolean;
  active?: boolean;
};

export function useDrivers(opts?: { includeInactive?: boolean }) {
  return useQuery({
    queryKey: ['drivers', opts?.includeInactive ?? false],
    queryFn: () => authedFetch<{ drivers: DriverRow[] }>(
      `/drivers${opts?.includeInactive ? '?active=false' : ''}`,
    ).then((r) => r.drivers),
    staleTime: 60_000,
  });
}

export function useCreateDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewDriver) =>
      authedFetch<{ driver: DriverRow }>(`/drivers`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drivers'] }),
  });
}

export function useUpdateDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewDriver> & { id: string }) =>
      authedFetch<{ driver: DriverRow }>(`/drivers/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drivers'] }),
  });
}
