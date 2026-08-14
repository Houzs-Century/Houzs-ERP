// Vendored SLICE of apps/backend/src/lib/venues-queries.ts — the SO list/detail
// + SO Maintenance venue reads/CRUD.
//
// ── HOUZS RE-SOURCING (2026-06-21) ──────────────────────────────────────────
// Venues are maintained CENTRALLY in Houzs's Project Maintenance / PMS, not in
// the SCM. The old `/api/scm/venues` route never existed in the cutover (it
// 404'd), so these hooks now source from the Houzs-native Project Maintenance
// API: GET/POST/PATCH/DELETE /api/projects/venues.
//
// That endpoint lives OUTSIDE the /api/scm mount, so `authedFetch` (which
// prepends /api/scm) cannot reach it. We use the Houzs-native `api` client
// (../../../api/client) which carries the same bearer token but targets the
// Worker root.
//
// Shape adaptation — the projects VenueRow is { id:number, name, state, notes,
// active } and the GET only returns active venues. We map it onto the SCM
// `VenueRow` contract the SO/CO consumers already expect:
//   • id    → String(id)   — the SO pickers match `venue.id === staff.venueId`
//                            with `===`, and staff.venueId is a STRING. Keeping
//                            id a string preserves that comparison.
//   • notes → address      — projects venues have no `address`; `notes` is the
//                            nearest free-text column (read-only display only).
//   • state                — carried through so the SO venue picker can read it.
//   • active → true        — the projects GET only returns active rows.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { writeFailed, writeFailedAs } from './mutation-error';

export type VenueRow = {
  id: string;
  name: string;
  address: string | null;
  /** Houzs Project Maintenance tags each venue with a Malaysian state; the SO
   *  venue picker reads it to pre-fill the customer state. */
  state: string | null;
  active: boolean;
  created_at: string;
  /** Where this venue comes from. 'PROJECT' = the Project Maintenance venue
   *  master (an exhibition venue). 'SHOWROOM' = a warehouse flagged as a
   *  Showroom, contributing its venue_name. The owner asked to be able to tell
   *  the two apart in the list, so the origin travels with the row instead of
   *  being guessed from the name. */
  origin: VenueOrigin;
  /** Set only when origin is 'SHOWROOM' — the source warehouse. */
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

// Raw row as returned by GET /api/projects/venues.
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
    /* Default to PROJECT only because that is what an un-upgraded backend
       returns; it is a shape fallback, not a guess about the data. */
    origin: r.origin ?? 'PROJECT',
    warehouseId: r.warehouseId ?? null,
  };
}

export function useVenues(_opts?: { includeInactive?: boolean }) {
  // The projects GET only returns active venues; `includeInactive` is accepted
  // for call-site compatibility but has no effect (central maintenance lives in
  // Project Maintenance, which is the source of truth for inactive venues).
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
      // Projects venues carry name + state + notes (no `address`); map the
      // editor's free-text address onto `notes`.
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
