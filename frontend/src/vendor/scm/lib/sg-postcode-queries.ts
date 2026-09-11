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
