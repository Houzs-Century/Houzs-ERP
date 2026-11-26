
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type DeliveryGeoPoint = {
  ref: string;
  so_doc_no: string;
  lat: number;
  lng: number;
  zone: string | null;
  region: string;
  state: string | null;
  country?: string | null;
  postcode: string | null;
  sets: number;
  revenueSen: number;
  customer: string | null;
  address: string;
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
  configured: boolean;
  points: DeliveryGeoPoint[];
  depot: DeliveryGeoDepot | null;
  lorryDepots?: Record<string, { warehouseId: string; name: string; lat: number; lng: number }>;
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
