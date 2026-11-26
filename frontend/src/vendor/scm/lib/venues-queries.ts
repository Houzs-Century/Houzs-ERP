
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { writeFailed, writeFailedAs } from './mutation-error';

export type VenueRow = {
  id: string;
  name: string;
  address: string | null;
  state: string | null;
  active: boolean;
  created_at: string;
  origin: VenueOrigin;
  warehouseId: string | null;
};

export type VenueOrigin = 'PROJECT' | 'SHOWROOM';

/** Response of GET /mfg-sales-orders/active-venue — the venue the logged-in
 *  salesperson is BOUND to, which the New-SO form offers as a DEFAULT.
 *
 *  Declared HERE, once, because desktop (pages/scm-v2/SalesOrderNew) and mobile
 *  (mobile/MobileNewSO) both consume it and the two must not drift: the rule
 *  that produced it lives in ONE place on the backend
 *  (scm/lib/venue-binding.ts), and its wire shape belongs in one place too.
 *
 *  - `source` says WHICH binding fired, so the form can name it. 'PMS' = an
 *    exhibition project the rep is on; 'SHOWROOM' = the showroom they are
 *    parked under; null = nothing resolved, which is a legitimate answer and
 *    NOT an error — the operator simply picks a venue.
 *  - `venueId` is null when the venue text is not in the venue master. The
 *    order still saves with the text; this is a known, tolerated gap. */
export type AutoVenue = {
  venueId: string | null;
  venueName: string | null;
  projectName: string | null;
  projectId: number | null;
  source: 'PMS' | 'SHOWROOM' | null;
  showroomName: string | null;
};

export type NewVenue = {
  name: string;
  address?: string | null;
  active?: boolean;
};

type ProjectVenueRow = {
  id: number | string;
  name: string;
  state: string | null;
  notes: string | null;
  active: number | boolean;
  origin?: VenueOrigin;
  warehouseId?: string | null;
};

function mapVenue(r: ProjectVenueRow): VenueRow {
  return {
    id: String(r.id),
    name: r.name,
    address: r.notes ?? null,
    state: r.state ?? null,
    active: r.active === 1 || r.active === true,
    created_at: '',
    origin: r.origin ?? 'PROJECT',
    warehouseId: r.warehouseId ?? null,
  };
}

export function useVenues(_opts?: { includeInactive?: boolean }) {
  return useQuery({
    queryKey: ['venues'],
    queryFn: () =>
      api
        /* includeShowrooms: the SCM venue list is fed from project venues AND
           from Showroom-flagged warehouses (owner 2026-07-19). Opt-in, so
           Project Maintenance's own CRUD list stays exactly the rows it owns. */
        .get<{ data: ProjectVenueRow[] }>('/api/projects/venues?includeShowrooms=1')
        .then((r) => (r.data ?? []).map(mapVenue)),
    staleTime: 60_000,
  });
}

export function useCreateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewVenue) =>
      api.post<{ id: number; name: string; state: string | null }>(
        '/api/projects/venues',
        { name: body.name, notes: body.address ?? null },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
    onError: writeFailedAs('Venue not created'),
  });
}

export function useUpdateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, address }: Partial<NewVenue> & { id: string }) =>
      api.patch<{ ok: true }>(`/api/projects/venues/${id}`, {
        ...(name !== undefined ? { name } : {}),
        ...(address !== undefined ? { notes: address } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
    onError: writeFailed,
  });
}

export function useDeactivateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/projects/venues/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
    onError: writeFailedAs('Venue not deactivated'),
  });
}
