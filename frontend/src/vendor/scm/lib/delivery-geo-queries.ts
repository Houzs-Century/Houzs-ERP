// ----------------------------------------------------------------------------
// delivery-geo-queries.ts — the Option B side-map read hook (owner decision
// 2026-08-08: LEFT board / RIGHT sticky map on all three arrangement pages).
//
// GET /delivery-planning/geo?date=&region= returns one point per SO whose
// EFFECTIVE delivery date (amended ?? customer) is the picked day — lat/lng
// from the mig-0197 geocode cache (cache-first, batched server-side), the
// postcode ZONE + region bucket, set count and revenue for the mini card, plus
// the day's majority-warehouse depot. Orders that could not be located come
// back in `ungeocoded` with a reason — the panel LISTS them, never hides them.
//
// Same pattern as the sibling fleet-day-queries: TanStack Query + authedFetch,
// fetched ONCE per (date, region) with staleTime — NO polling.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type DeliveryGeoPoint = {
  ref: string;
  so_doc_no: string;
  lat: number;
  lng: number;
  /** The postcode AREA ZONE (delivery-zones map; null = unzoned postcode). */
  zone: string | null;
  /** The order's primary REGION bucket (customer-state classification). */
  region: string;
  state: string | null;
  /** Customer country — 'Singapore' marks an SG stop the Last Mile map omits.
   *  Optional: only the board/geo feed carries it; test fixtures may omit it. */
  country?: string | null;
  postcode: string | null;
  sets: number;
  revenueSen: number;
  customer: string | null;
  address: string;
  /** Pinned at the postcode area because the address itself could not be located. */
  approximate?: boolean;
};

export type DeliveryGeoDepot = {
  warehouseId: string;
  name: string;
  code: string | null;
  lat: number;
  lng: number;
};

export type DeliveryGeoResponse = {
  date: string;
  region: string;
  /** False = GOOGLE_MAPS_API_KEY unset server-side: only cached addresses pin. */
  configured: boolean;
  points: DeliveryGeoPoint[];
  depot: DeliveryGeoDepot | null;
  /** Each lorry's home warehouse point, by normalized plate; a lorry absent here uses `depot`. */
  lorryDepots?: Record<string, { warehouseId: string; name: string; lat: number; lng: number }>;
  /** Why `depot` is null, when it is (no warehouse / ungeocodable address). */
  depotReason?: string | null;
  ungeocoded: Array<{ ref: string; reason: string }>;
};

/** The day's map points. `date` is required (YYYY-MM-DD); `region` narrows like
 *  the board's region chips ('ALL' = everything). Disabled until a date is set
 *  and while `enabled` is false (the panel is closed — a closed map fetches
 *  nothing, the same unmount rule the Maintenance page's folds follow). */
export function useDeliveryGeo(opts: { date: string | null; region?: string; enabled?: boolean }) {
  const { date, region = 'ALL', enabled = true } = opts;
  return useQuery({
    queryKey: ['delivery-planning', 'geo', date ?? '', region],
    enabled: enabled && !!date,
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('date', date!);
      if (region !== 'ALL') p.set('region', region);
      return authedFetch<DeliveryGeoResponse>(`/delivery-planning/geo?${p.toString()}`);
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

/** One located non-SO stop (service-case leg, setup / dismantle, supplier
 *  pickup, transfer, lorry service), keyed by its board row key. `approximate`
 *  = pinned at the postcode area, not the address. */
export type JobGeoPoint = {
  ref: string;
  lat: number;
  lng: number;
  approximate: boolean;
  address: string;
  customer: string | null;
  postcode: string | null;
  state: string | null;
};

export type JobGeoResponse = {
  configured: boolean;
  points: JobGeoPoint[];
  ungeocoded: Array<{ ref: string; reason: string }>;
};

/** The Last Mile map's pins for the lorries' NON-SO stops, by row key
 *  (GET /delivery-planning/geo/jobs). The server reads each job's own address
 *  and locates it cache-first. Keyed on the sorted refs, so a board poll that
 *  returns the same stops refetches nothing; disabled with no refs or while the
 *  map is closed. */
export function useJobGeo(refs: readonly string[], enabled: boolean) {
  const sorted = [...new Set(refs)].sort();
  return useQuery({
    queryKey: ['delivery-planning', 'geo-jobs', sorted.join('|')],
    enabled: enabled && sorted.length > 0,
    queryFn: () => authedFetch<JobGeoResponse>(`/delivery-planning/geo/jobs?refs=${encodeURIComponent(sorted.join(','))}`),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
}
