
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { sameState } from '../../../../../shared/src/vendor/scm/lib/state-key';
export { stateKey, sameState } from '../../../../../shared/src/vendor/scm/lib/state-key';

export interface LocalityRow {
  id?: string;
  postcode: string;
  city: string;
  state: string;
  stateCode: string;
  country: string;
  warehouseId?: string | null;
}

export const useLocalities = () =>
  useQuery({
    queryKey: ['my_localities'],
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async (): Promise<LocalityRow[]> => {
      const res = await authedFetch<{ localities: LocalityRow[] }>('/localities');
      return res.localities ?? [];
    },
  });

export const distinctStates = (rows: LocalityRow[]): string[] => {
  const s = new Set<string>();
  for (const r of rows) s.add(r.state);
  return Array.from(s).sort();
};

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export const citiesInState = (rows: LocalityRow[], state: string): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (sameState(r.state, state)) s.add(r.city);
  return Array.from(s).sort();
};
export const postcodesInCity = (rows: LocalityRow[], state: string, city: string): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (sameState(r.state, state) && sameText(r.city, city)) s.add(r.postcode);
  return Array.from(s).sort();
};

export const postcodesInState = (rows: LocalityRow[], state: string): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (sameState(r.state, state)) s.add(r.postcode);
  return Array.from(s).sort();
};

export const postcodesForCity = (rows: LocalityRow[], city: string): string[] => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- must match resolveCityState's normalisation exactly
  const want = (city ?? '').trim().toLowerCase();
  if (!want) return [];
  const s = new Set<string>();
  for (const r of rows) if (r.city.trim().toLowerCase() === want) s.add(r.postcode);
  return Array.from(s).sort();
};
export const countryForState = (rows: LocalityRow[], state: string): string | null => {
  if (!state) return null;
  const hit = rows.find((r) => sameState(r.state, state));
  return hit?.country ?? null;
};


export const resolvePostcode = (
  rows: LocalityRow[],
  postcode: string,
): { state: string; city: string } | null => {
  const want = (postcode ?? '').trim();
  if (!want) return null;
  const hits = rows.filter((r) => r.postcode === want);
  if (hits.length === 0) return null;
  const state = hits[0].state;
  if (!hits.every((r) => r.state === state)) return null;
  const cities = Array.from(new Set(hits.map((r) => r.city)));
  return { state, city: cities.length === 1 ? cities[0] : '' };
};

export const resolveCityState = (rows: LocalityRow[], city: string): string | null => {
  const want = (city ?? '').trim().toLowerCase();
  if (!want) return null;
  const states = new Set<string>();
  for (const r of rows) if (r.city.trim().toLowerCase() === want) states.add(r.state);
  return states.size === 1 ? Array.from(states)[0] : null;
};

export const allCities = (rows: LocalityRow[]): string[] => {
  const s = new Set<string>();
  for (const r of rows) s.add(r.city);
  return Array.from(s).sort();
};
export const allPostcodes = (rows: LocalityRow[]): string[] => {
  const s = new Set<string>();
  for (const r of rows) s.add(r.postcode);
  return Array.from(s).sort();
};


export const distinctCountries = (rows: LocalityRow[]): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (r.country) s.add(r.country);
  return Array.from(s).sort();
};

export const statesInCountry = (rows: LocalityRow[], country: string): string[] => {
  if (!country) return distinctStates(rows);
  const want = country.trim().toLowerCase();
  const s = new Set<string>();
  for (const r of rows) if ((r.country ?? '').toLowerCase() === want) s.add(r.state);
  return Array.from(s).sort();
};

export const useCreateLocality = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { state: string; stateCode: string; city: string; postcode: string; country?: string }) =>
      authedFetch<{ locality: { id: string } }>('/localities', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my_localities'] }); },
  });
};

export const useUpdateLocality = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: {
      id: string;
      state?: string; stateCode?: string; city?: string; postcode?: string;
      country?: string;
      warehouseId?: string | null;
    }) =>
      authedFetch(`/localities/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my_localities'] }); },
  });
};

export const useDeleteLocality = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch(`/localities/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my_localities'] }); },
    onError: writeFailed,
  });
};

export const COUNTRIES = ['Malaysia'] as const;
export type CountryName = typeof COUNTRIES[number];

export const postcodeIndex = (rows: LocalityRow[]): Map<string, LocalityRow[]> => {
  const m = new Map<string, LocalityRow[]>();
  for (const r of rows) {
    const list = m.get(r.postcode);
    if (list) list.push(r); else m.set(r.postcode, [r]);
  }
  return m;
};

/* "53000 Cyberjaya" for a postcode (HC-0196). The state narrows rows that share a
   postcode across states; if the postcode still names more than one city (or none)
   the number alone is shown, never a guess (docs/modules/address-cascade.md). */
export const postcodeLabel = (index: Map<string, LocalityRow[]>, postcode: string | null, state: string | null): string => {
  const pc = (postcode ?? '').trim();
  const hits = index.get(pc) ?? [];
  const inState = state ? hits.filter((r) => r.state === state) : [];
  const cities = new Set((inState.length > 0 ? inState : hits).map((r) => r.city).filter(Boolean));
  return cities.size === 1 ? `${pc} ${[...cities][0]}` : pc;
};
