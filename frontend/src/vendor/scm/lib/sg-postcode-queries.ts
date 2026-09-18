// Live Singapore postcode -> address lookup via GET /api/scm/sg-postcode/:code
// (backend routes/sg-postcode.ts). Singapore's ~150k per-building postcodes are
// NOT seeded in scm.my_localities (only 55 area-representative codes are), so a
// real SG postcode is resolved live through the official OneMap API instead of
// being imported into the shared master.
//
// INERT until configured: the backend returns { configured: false } when it has
// no OneMap credentials. Callers MUST degrade (let the operator type the code /
// address by hand) and never assume a live result.
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export interface SgAddress {
  postcode: string;
  building: string;
  blockNo: string;
  road: string;
  address: string;
  lat: string;
  lng: string;
  // URA planning area for this coordinate (pln_area_n), uppercased; "" when the
  // backend could not resolve it. resolveSgPlanningArea maps it to a seeded
  // { state, city } so the form fills City + State as well as the address.
  planningArea: string;
}

export interface SgLookupResult {
  configured: boolean;
  results: SgAddress[];
  error?: 'invalid_postcode' | 'auth_failed' | 'lookup_failed';
}

export const isValidSgPostcode = (code: string): boolean => /^\d{6}$/.test(code.trim());

/** Address line 1 an operator would write: block + road, then the building,
 *  then the whole formatted address. Mirrors the backend's addressLine1. */
export const sgAddressLine1 = (a: SgAddress): string => {
  const blkRoad = [a.blockNo, a.road].filter(Boolean).join(' ').trim();
  return blkRoad || a.building || a.address;
};

/** Reverse-resolve a OneMap planning area (pln_area_n, any case) to the seeded
 *  Singapore { state, city } it names. The 55 SG rows in my_localities use the
 *  planning area as `city` and the URA region as `state` (mig 0181), so a live
 *  planning area maps straight back to a seeded pair — the same trick that lets
 *  a Malaysian postcode fill State + City. Returns null when the area is blank
 *  or not one of the seeded SG cities, so the caller leaves State/City for the
 *  operator rather than guessing. */
export const resolveSgPlanningArea = (
  rows: { country: string; city: string; state: string }[],
  planningArea: string,
): { state: string; city: string } | null => {
  const want = planningArea.trim().toUpperCase();
  if (!want) return null;
  const hit = rows.find((r) => r.country === 'Singapore' && r.city.trim().toUpperCase() === want);
  return hit ? { state: hit.state, city: hit.city } : null;
};

/** Look a real 6-digit SG postcode up. Fires ONLY for a valid 6-digit code, so
 *  it makes at most one request per completed postcode (no per-keystroke calls).
 *  Cached 24h — a postcode's address does not change. `retry:false` so a 502
 *  upstream failure surfaces immediately as isError rather than stalling the
 *  field. */
export const useSgPostcodeLookup = (code: string) => {
  const trimmed = code.trim();
  return useQuery({
    queryKey: ['sg-postcode', trimmed],
    enabled: isValidSgPostcode(trimmed),
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: (): Promise<SgLookupResult> => authedFetch<SgLookupResult>(`/sg-postcode/${trimmed}`),
  });
};
