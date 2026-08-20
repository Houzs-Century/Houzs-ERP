// ----------------------------------------------------------------------------
// trips-queries.ts — the TRIPS scheduling layer's read/act hooks.
//
// scm.trips + trip_stops have existed since mig 0053 and the backend route since
// the TMS port, but nothing in the UI ever read them: a trip could only be seen
// through the API. That also left POST /trips/:id/optimize-route (the Google
// Directions optimiser, #732 + #757) with no way to be triggered by a human.
// These hooks + the Trips page close that.
//
// Same pattern as the sibling vendor query libs: TanStack Query + authedFetch,
// rows snake_case as the API emits them.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type TripStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export type TripRow = {
  id: string;
  trip_no: string;
  trip_date: string | null;
  lorry_id: string | null;
  driver_id: string | null;
  warehouse_id: string | null;
  trip_type: string | null;
  status: TripStatus | string;
  is_outsourced: boolean | null;
  total_distance_km: number | string | null;
  notes: string | null;
  company_code?: string | null;
};

export type TripStop = {
  id: string;
  trip_id: string;
  stop_no: number;
  stop_type: string;
  customer_name: string | null;
  address: string | null;
  revenue_sen: number;
  /* Mig 0134 — filled by the route optimiser; null when never optimised. */
  leg_distance_m: number | null;
  leg_duration_s: number | null;
  eta_offset_s: number | null;
  route_optimised_at: string | null;
};

export function useTrips(opts: { from?: string; to?: string; status?: string } = {}) {
  const { from, to, status } = opts;
  return useQuery({
    queryKey: ['scm-trips', from ?? '', to ?? '', status ?? ''],
    queryFn: () => {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (status && status !== 'ALL') p.set('status', status);
      const qs = p.toString();
      return authedFetch<{ trips: TripRow[] }>(`/trips${qs ? `?${qs}` : ''}`);
    },
    staleTime: 30_000,
  });
}

export function useTrip(id: string | null) {
  return useQuery({
    queryKey: ['scm-trip', id ?? ''],
    queryFn: () => authedFetch<{ trip: TripRow; stops: TripStop[] }>(`/trips/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export type OptimizeResult = {
  configured: boolean;
  ok: boolean;
  reason?: string;
  applied: boolean;
  totalDistanceMetres: number;
  totalDurationSeconds: number;
  stops: Array<{ ref: string; order: number; etaSecondsFromDepart: number }>;
};

/* Optimise a trip's stop order via Google Directions. `apply` writes the new
   stop_no + the per-stop ETA back; without it this is a dry run. Returns
   configured:false when GOOGLE_MAPS_API_KEY is unset — nothing is billed. */
export function useOptimizeTripRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, apply }: { id: string; apply: boolean }) =>
      authedFetch<OptimizeResult>(`/trips/${id}/optimize-route${apply ? '?apply=true' : ''}`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['scm-trip', v.id] });
      qc.invalidateQueries({ queryKey: ['scm-trips'] });
    },
  });
}

/* ── Trip crew update (Last Mile "Propose crew", owner 2026-08-08) ─────────────
   Labels the crew/vehicle onto an EXISTING trip via the long-standing
   PATCH /trips/:id (it has accepted lorryId / driverId / helper1Id / helper2Id
   since the TMS port — this is its first UI caller). The trip row is what the
   day map's crew line, the run-sheet and the per-assignee row scope read.
   NOTE: scm.trips carries ONE driver seat by schema; the second driver of a
   two-driver run lives on the DO crew record (delivery_order_crew.driver_2_id,
   written via useAssignDoCrew) — the two writes travel together in the page. */
export function useUpdateTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string;
      lorryId?: string | null;
      driverId?: string | null;
      helper1Id?: string | null;
      helper2Id?: string | null;
      tripDate?: string | null;
      warehouseId?: string | null;
      notes?: string | null;
    }) =>
      authedFetch<{ trip: TripRow }>(`/trips/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['scm-trip', v.id] });
      qc.invalidateQueries({ queryKey: ['scm-trips'] });
      qc.invalidateQueries({ queryKey: ['fleet-day'] });
    },
  });
}
