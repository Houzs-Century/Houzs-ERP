// Vendored SLICE of apps/backend/src/lib/localities-queries.ts — only the
// pieces SupplierDetail's edit form reads: useLocalities (drives the Malaysia
// State <select>), distinctStates, COUNTRIES, PAYMENT_TERMS_OPTIONS.
//
// HOUZS VENDOR NOTE (supabase slice): the source useLocalities reads the
// `my_localities` reference table DIRECTLY via the Supabase JS client (paged
// 1000 rows at a time). There is NO `/localities` GET endpoint to route through
// authedFetch (the source localities route only exposes POST/PATCH/DELETE), and
// the vendor layer has no Supabase client. So this slice ships useLocalities as
// a hook that resolves to an EMPTY list — exactly the cold-start behaviour the
// source already handles: SupplierDetail's StateSelect falls back to a free-text
// State input when the Malaysia dataset is unavailable. The write mutations
// (useCreate/Update/DeleteLocality) and the other derivations
// (citiesInState/postcodesInCity/countryForState/BUILDING_TYPES) are NOT pulled
// in — SupplierDetail doesn't call them.
//
// FLAG: if a future page needs the real Malaysia postcode cascade, wire a
// `GET /api/scm/localities` endpoint on the Houzs SCM backend and repoint
// useLocalities at authedFetch.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export interface LocalityRow {
  id?: string;
  postcode: string;
  city: string;
  state: string;
  stateCode: string;
  country: string;
  warehouseId?: string | null;
}

/* HOUZS VENDOR — routes through GET /api/scm/localities (returns scm.my_localities
   camelCased). Same shape + query key as the source. When the table is empty the
   endpoint returns [], so distinctStates/citiesInState below collapse to [] and
   the StateSelect falls back to a free-text State input (the verbatim no-data
   behaviour). Seed real MY data with seed-my-localities.mjs. */
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

/* Derive distinct states — used by SupplierDetail's StateSelect for the
   Malaysia dropdown. With the empty dataset above this returns [], so the
   field renders the free-text fallback the source already ships. */
export const distinctStates = (rows: LocalityRow[]): string[] => {
  const s = new Set<string>();
  for (const r of rows) s.add(r.state);
  return Array.from(s).sort();
};

/* HOUZS VENDOR — SO Detail's DeliveryAddressCard drives a state→city→postcode
   cascade off these. With the empty locality dataset above they return [] /
   null, so the cascade renders empty selects + the country falls back to the
   header snapshot / 'Malaysia' — the verbatim no-data behaviour. Copied from
   apps/backend/src/lib/localities-queries.ts. */
export const citiesInState = (rows: LocalityRow[], state: string): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (r.state === state) s.add(r.city);
  return Array.from(s).sort();
};
export const postcodesInCity = (rows: LocalityRow[], state: string, city: string): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (r.state === state && r.city === city) s.add(r.postcode);
  return Array.from(s).sort();
};
export const countryForState = (rows: LocalityRow[], state: string): string | null => {
  if (!state) return null;
  const hit = rows.find((r) => r.state === state);
  return hit?.country ?? null;
};

/* ── REVERSE resolution (postcode / city → state) ──────────────────────────
   The forward cascade above is State → City → Postcode. These helpers run the
   OTHER way so the SO/mobile forms can auto-fill State (and, through the existing
   state→warehouse mapping, the Sales Location) the moment the operator knows a
   Postcode or a City instead of a State. A Malaysian 5-digit postcode maps to a
   single locality, so resolvePostcode returns both {state, city}; a city name
   can (rarely) sit under more than one state, so resolveCityState returns a
   state ONLY when it is unambiguous — never a wrong guess. Both read the SAME
   my_localities rows the forward cascade uses, so the two directions can't
   disagree. */

/* Reverse-resolve a Postcode to its {state, city}. Exact (trimmed) string match —
   postcodes are stored as strings incl. any leading zeros/letters. Returns null
   when the postcode is unknown, or when the rows for it disagree on the state
   (conflicting seed data → refuse to guess). city is '' when a postcode legibly
   spans more than one city (still lets the caller set the state). */
export const resolvePostcode = (
  rows: LocalityRow[],
  postcode: string,
): { state: string; city: string } | null => {
  const want = (postcode ?? '').trim();
  if (!want) return null;
  const hits = rows.filter((r) => r.postcode === want);
  if (hits.length === 0) return null;
  const state = hits[0].state;
  if (!hits.every((r) => r.state === state)) return null; // ambiguous state → don't guess
  const cities = Array.from(new Set(hits.map((r) => r.city)));
  return { state, city: cities.length === 1 ? cities[0] : '' };
};

/* Reverse-resolve a City to its State — ONLY when the city name appears under a
   single state (case-insensitive). A city shared by >1 state returns null so the
   caller leaves State for the operator to pick (never a wrong guess). */
export const resolveCityState = (rows: LocalityRow[], city: string): string | null => {
  const want = (city ?? '').trim().toLowerCase();
  if (!want) return null;
  const states = new Set<string>();
  for (const r of rows) if (r.city.trim().toLowerCase() === want) states.add(r.state);
  return states.size === 1 ? Array.from(states)[0] : null;
};

/* Distinct city / postcode lists across ALL states — the option pool the SO
   forms show when NO state is picked yet, so the operator can choose a City or
   Postcode first and have the State resolve back from it. With a state picked the
   forms keep using the state-scoped citiesInState/postcodesInCity (forward
   cascade unchanged). */
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

/* ── COUNTRY cascade (2026-07-23) ────────────────────────────────────────
   The Warehouse address form (and any address surface that needs to
   support Malaysia + China + Singapore) picks Country FIRST, then filters
   State by country. State→country back-derive already exists via
   countryForState() above. */

/* Distinct country list from the seeded my_localities data — read live so
   it auto-picks up any country the SO Maintenance geo table adds. */
export const distinctCountries = (rows: LocalityRow[]): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (r.country) s.add(r.country);
  return Array.from(s).sort();
};

/* States within a country — the pre-filter the address form uses before
   showing the state dropdown. Case-insensitive on country to tolerate
   'MY'/'Malaysia' inputs from older callers. */
export const statesInCountry = (rows: LocalityRow[], country: string): string[] => {
  if (!country) return distinctStates(rows);
  const want = country.trim().toLowerCase();
  const s = new Set<string>();
  for (const r of rows) if ((r.country ?? '').toLowerCase() === want) s.add(r.state);
  return Array.from(s).sort();
};

/* HOUZS VENDOR — SO Maintenance's Localities CRUD section. authedFetch-based in
   the source (→ /localities). Copied verbatim. */
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

/* PR #47 — Country dropdown options. Only Malaysia today. */
export const COUNTRIES = ['Malaysia'] as const;
export type CountryName = typeof COUNTRIES[number];

/* PR #47 — Payment term presets. "Custom" lets user enter free text. */
export const PAYMENT_TERMS_OPTIONS = [
  'COD',
  'NET 7',
  'NET 14',
  'NET 30',
  'NET 45',
  'NET 60',
  'NET 90',
  '50/50',
  '30/70',
  'Advance Payment',
  'Custom',
] as const;
export type PaymentTermOption = typeof PAYMENT_TERMS_OPTIONS[number];
