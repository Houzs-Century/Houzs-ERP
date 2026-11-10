/* The Delivery Planning board's region model, moved out of routes/delivery-planning.ts
   so the PostgREST board path and the SQL board path (delivery-board-sql.ts) build
   the region tabs and each row's region(s) from ONE fold.

   CONFIG-DRIVEN (migration 0053). The region buckets are an owner-maintained
   master (delivery_planning_regions) and the per-state -> region(s) classification
   is an owner-maintained MULTI mapping (state_delivery_regions): a state can map to
   SEVERAL regions. Both are loaded once per request. A Region is an open string
   code (any code the owner adds), not a fixed union. An unmapped state falls back
   to the default bucket (KL). */
import { paginateAll } from './paginate-all';
import { noteDegradedRead } from './read-failure';

export type Region = string;

/* The codes the fallback reproduces, used ONLY when the config tables are
   empty/unapplied so behaviour never regresses below today. Kept in sync with the
   live Delivery Regions buckets (KL/SEL / Northern / Southern / East Coast /
   East Malaysia; Singapore folds into Southern). NOTE: migration 0053's seed is
   the older SELANGOR/KL/NORTHERN/SOUTHERN/EAST_COAST/EAST_MY set, so a fresh env
   seeded from 0053 differs from prod until reconciled. */
export const FALLBACK_DEFAULT_REGION = 'KL';
const FALLBACK_REGIONS: Array<{ key: Region; label: string }> = [
  { key: 'KL', label: 'KL/SEL' }, { key: 'NORTHERN', label: 'Northern' },
  { key: 'SOUTHERN', label: 'Southern' }, { key: 'EAST_COAST', label: 'East Coast' },
  { key: 'EM', label: 'East Malaysia' },
];

/* Normalize free-text for tolerant matching: upper, strip punctuation/accents,
   collapse whitespace. "Pulau  Pinang" / "P.Pinang" / "pulau-pinang" all align. */
function normState(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // drop accents
    .toUpperCase()
    .replace(/[._\-,/]/g, ' ')                            // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

export type RegionConfig = {
  // Ordered, active region masters -> the tab row.
  regions: Array<{ key: Region; label: string }>;
  // The set of VALID region codes (active) for filtering/membership checks.
  validCodes: Set<Region>;
  // Normalised state NAME -> region codes[]. Key = normState(state_key).
  byState: Map<string, Region[]>;
};

export type RegionRow = { id: string; code: string | null; name: string | null; active?: boolean | null };
export type StateRegionRow = { state_key?: string | null; stateKey?: string | null; region_id?: string | null; regionId?: string | null };

/** The fold: region master rows (ordered sort_order, code) + state mapping rows. */
export function regionConfigFromRows(regRows: RegionRow[], mapRows: StateRegionRow[]): RegionConfig {
  const codeById = new Map<string, Region>();
  let regions: Array<{ key: Region; label: string }> = [];
  const validCodes = new Set<Region>();
  for (const r of regRows) {
    const code = (r.code ?? '').toUpperCase();
    if (!code) continue;
    codeById.set(r.id, code);
    if ((r.active ?? true) !== false) {
      /* DEDUPE by code: the board is a CROSS-COMPANY view, so this read spans
         both companies' region masters; post-mig-0176 each company carries
         its own copy of every bucket, so without this each chip rendered
         TWICE (owner screenshot 2026-07-24). codeById keeps EVERY row (both
         companies' ids) so state mappings from either company still resolve. */
      if (!validCodes.has(code)) {
        regions.push({ key: code, label: r.name ?? code });
        validCodes.add(code);
      }
    }
  }
  const byState = new Map<string, Region[]>();
  if (codeById.size > 0) {
    for (const row of mapRows) {
      const stateKey = row.stateKey ?? row.state_key ?? '';
      const code = codeById.get(row.regionId ?? row.region_id ?? '');
      if (!stateKey || !code) continue;
      const k = normState(stateKey);
      const arr = byState.get(k) ?? [];
      if (!arr.includes(code)) arr.push(code);
      byState.set(k, arr);
    }
  }
  // Fallback when the config tables are empty / unapplied: keep today's tabs.
  if (regions.length === 0) {
    regions = [...FALLBACK_REGIONS];
    for (const r of FALLBACK_REGIONS) validCodes.add(r.key);
  }
  return { regions, validCodes, byState };
}

/* PostgREST read of the two tables. Best-effort: on any error / empty config the
   fold falls back to the seeded defaults so the board still works. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client
export async function loadRegionConfig(sb: any): Promise<RegionConfig> {
  let regRows: RegionRow[] = [];
  try {
    const { data, error } = await paginateAll<RegionRow & { sort_order?: number | null }>((from, to) =>
      sb.from('delivery_planning_regions')
        .select('id, code, name, sort_order, active')
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true })
        .range(from, to),
    );
    noteDegradedRead('delivery_planning_regions', error);
    regRows = data ?? [];
  } catch { /* fall through to the fallback */ }
  let mapRows: StateRegionRow[] = [];
  if (regRows.some((r) => (r.code ?? '') !== '')) {
    try {
      const { data, error } = await paginateAll<StateRegionRow>((from, to) =>
        sb.from('state_delivery_regions').select('state_key, country, region_id').range(from, to),
      );
      noteDegradedRead('state_delivery_regions', error);
      mapRows = data ?? [];
    } catch { /* mapping stays empty -> fallback default applies per-order */ }
  }
  return regionConfigFromRows(regRows, mapRows);
}

/* customer_state (+ customer_country fallback) -> region code(s) via the loaded
   config. Returns an ARRAY (a state can map to several regions). When the state
   isn't mapped, falls back to the default bucket (KL) so an unmapped/new state
   still lands somewhere. */
export function stateToRegionsFromConfig(
  cfg: RegionConfig,
  state: string | null | undefined,
  country?: string | null | undefined,
): Region[] {
  // Try the state name first, then the country (covers a blank-state SG order
  // whose country is 'Singapore').
  const sKey = normState(state);
  const cKey = normState(country);
  const hit = (sKey && cfg.byState.get(sKey)) || (cKey && cfg.byState.get(cKey)) || null;
  if (hit && hit.length > 0) return hit;
  const fallback = cfg.validCodes.has(FALLBACK_DEFAULT_REGION)
    ? FALLBACK_DEFAULT_REGION
    : (cfg.regions[0]?.key ?? FALLBACK_DEFAULT_REGION);
  return [fallback];
}
