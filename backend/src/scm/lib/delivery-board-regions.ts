import { paginateAll } from './paginate-all';
import { noteDegradedRead } from './read-failure';

export type Region = string;

export const FALLBACK_DEFAULT_REGION = 'KL';
const FALLBACK_REGIONS: Array<{ key: Region; label: string }> = [
  { key: 'KL', label: 'KL/SEL' }, { key: 'NORTHERN', label: 'Northern' },
  { key: 'SOUTHERN', label: 'Southern' }, { key: 'EAST_COAST', label: 'East Coast' },
  { key: 'EM', label: 'East Malaysia' },
];

function normState(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[._\-,/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type RegionConfig = {
  regions: Array<{ key: Region; label: string }>;
  validCodes: Set<Region>;
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
  if (regions.length === 0) {
    regions = [...FALLBACK_REGIONS];
    for (const r of FALLBACK_REGIONS) validCodes.add(r.key);
  }
  return { regions, validCodes, byState };
}

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
  } catch { }
  let mapRows: StateRegionRow[] = [];
  if (regRows.some((r) => (r.code ?? '') !== '')) {
    try {
      const { data, error } = await paginateAll<StateRegionRow>((from, to) =>
        sb.from('state_delivery_regions').select('state_key, country, region_id').range(from, to),
      );
      noteDegradedRead('state_delivery_regions', error);
      mapRows = data ?? [];
    } catch { }
  }
  return regionConfigFromRows(regRows, mapRows);
}

export function stateToRegionsFromConfig(
  cfg: RegionConfig,
  state: string | null | undefined,
  country?: string | null | undefined,
): Region[] {
  const sKey = normState(state);
  const cKey = normState(country);
  const hit = (sKey && cfg.byState.get(sKey)) || (cKey && cfg.byState.get(cKey)) || null;
  if (hit && hit.length > 0) return hit;
  const fallback = cfg.validCodes.has(FALLBACK_DEFAULT_REGION)
    ? FALLBACK_DEFAULT_REGION
    : (cfg.regions[0]?.key ?? FALLBACK_DEFAULT_REGION);
  return [fallback];
}
