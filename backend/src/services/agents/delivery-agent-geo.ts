// ---------------------------------------------------------------------------
// delivery-agent-geo.ts — Malaysia state-code canonicalisation + the Delivery
// Planning region-config loader for the Delivery Agent engine.
//
// Two jobs:
//   1. resolveStateCode() — free-text customer_state ("Pulau Pinang",
//      "p.pinang", "WP Kuala Lumpur") → a canonical 2-3 letter code (PNG, KL).
//      The learner's config-proposal keys (`delivery.transitDays.<STATE>`)
//      MUST be [A-Z]{2,3} to pass the agent-console whitelist pattern, and
//      Houzs (unlike HOOKKA) has no malaysia-states lib — so it lives here.
//   2. loadRegionConfig() / stateToRegions() — a faithful replica of the
//      UNEXPORTED region-config machinery in scm/routes/delivery-planning.ts
//      (loadRegionConfig + stateToRegionsFromConfig + normState). The board is
//      the source of truth for region semantics; if the board's version ever
//      changes, mirror it here. Re-implemented (not imported) only because the
//      board keeps those functions module-private.
//
// Pure reads + pure functions — nothing here writes.
// ---------------------------------------------------------------------------

import { paginateAll } from '../../scm/lib/paginate-all';

/* ── Canonical Malaysia state codes ─────────────────────────────────────────
   All codes match /^[A-Z]{2,3}$/ (the config-proposal whitelist shape). */
export const MALAYSIA_STATE_NAMES: Record<string, string> = {
  JHR: 'Johor',
  KDH: 'Kedah',
  KTN: 'Kelantan',
  MLK: 'Melaka',
  NSN: 'Negeri Sembilan',
  PHG: 'Pahang',
  PNG: 'Pulau Pinang',
  PRK: 'Perak',
  PLS: 'Perlis',
  SBH: 'Sabah',
  SWK: 'Sarawak',
  SEL: 'Selangor',
  TRG: 'Terengganu',
  KL: 'Kuala Lumpur',
  LBN: 'Labuan',
  PJY: 'Putrajaya',
  SG: 'Singapore',
};

/* Normalise free-text for tolerant matching — VERBATIM the board's normState:
   upper, strip accents/punctuation, collapse whitespace. */
export function normState(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[._\-,/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Normalised name / alias → code. Keys are normState() outputs. */
const STATE_ALIASES: Record<string, string> = {
  'JOHOR': 'JHR', 'JOHOR BAHRU': 'JHR', 'JB': 'JHR',
  'KEDAH': 'KDH',
  'KELANTAN': 'KTN',
  'MELAKA': 'MLK', 'MALACCA': 'MLK',
  'NEGERI SEMBILAN': 'NSN', 'N SEMBILAN': 'NSN', 'N9': 'NSN', 'SEREMBAN': 'NSN',
  'PAHANG': 'PHG',
  'PULAU PINANG': 'PNG', 'PENANG': 'PNG', 'P PINANG': 'PNG',
  'PERAK': 'PRK',
  'PERLIS': 'PLS',
  'SABAH': 'SBH',
  'SARAWAK': 'SWK',
  'SELANGOR': 'SEL',
  'TERENGGANU': 'TRG',
  'KUALA LUMPUR': 'KL', 'WP KUALA LUMPUR': 'KL', 'W P KUALA LUMPUR': 'KL',
  'WILAYAH PERSEKUTUAN': 'KL', 'WILAYAH PERSEKUTUAN KUALA LUMPUR': 'KL',
  'LABUAN': 'LBN', 'WP LABUAN': 'LBN', 'W P LABUAN': 'LBN',
  'PUTRAJAYA': 'PJY', 'WP PUTRAJAYA': 'PJY', 'W P PUTRAJAYA': 'PJY',
  'SINGAPORE': 'SG', 'SINGAPURA': 'SG',
};

/**
 * Free-text state (or country fallback) → canonical code, or null when
 * unresolvable. Accepts already-canonical codes ("SEL") unchanged.
 */
export function resolveStateCode(raw: string | null | undefined): string | null {
  const k = normState(raw);
  if (!k) return null;
  if (MALAYSIA_STATE_NAMES[k]) return k;         // already a code
  return STATE_ALIASES[k] ?? null;
}

/* ── Region config (replica of the board's private loader) ─────────────────
   Region buckets = owner-maintained scm.delivery_planning_regions master +
   the per-state MULTI mapping scm.state_delivery_regions (migration 0053).
   A state can map to SEVERAL regions; unmapped states fall back to KL (or the
   first configured region). Same fallbacks as the board when config is empty. */

export type Region = string;

const FALLBACK_DEFAULT_REGION = 'KL';
const FALLBACK_REGIONS: Array<{ key: Region; label: string }> = [
  { key: 'KL', label: 'KL/SEL' }, { key: 'NORTHERN', label: 'Northern' },
  { key: 'SOUTHERN', label: 'Southern' }, { key: 'EAST_COAST', label: 'East Coast' },
  { key: 'EM', label: 'East Malaysia' },
];

export interface RegionConfig {
  regions: Array<{ key: Region; label: string }>;
  validCodes: Set<Region>;
  /** normState(state_key) → region codes[] */
  byState: Map<string, Region[]>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadRegionConfig(sb: any): Promise<RegionConfig> {
  const codeById = new Map<string, Region>();
  let regions: Array<{ key: Region; label: string }> = [];
  const validCodes = new Set<Region>();
  try {
    const { data: regRows } = await paginateAll<{
      id: string; code: string | null; name: string | null;
      sort_order?: number | null; active?: boolean | null;
    }>((from, to) =>
      sb.from('delivery_planning_regions')
        .select('id, code, name, sort_order, active')
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true })
        .range(from, to),
    );
    for (const r of (regRows ?? [])) {
      const code = (r.code ?? '').toUpperCase();
      if (!code) continue;
      codeById.set(r.id, code);
      if ((r.active ?? true) !== false) {
        regions.push({ key: code, label: r.name ?? code });
        validCodes.add(code);
      }
    }
  } catch { /* fall through to fallback below */ }

  const byState = new Map<string, Region[]>();
  if (codeById.size > 0) {
    try {
      const { data: mapRows } = await paginateAll<{
        state_key?: string | null; region_id?: string | null;
      }>((from, to) =>
        sb.from('state_delivery_regions').select('state_key, country, region_id').range(from, to),
      );
      for (const row of (mapRows ?? [])) {
        const stateKey = row.state_key ?? '';
        const code = codeById.get(row.region_id ?? '');
        if (!stateKey || !code) continue;
        const k = normState(stateKey);
        const arr = byState.get(k) ?? [];
        if (!arr.includes(code)) arr.push(code);
        byState.set(k, arr);
      }
    } catch { /* mapping stays empty → fallback default applies per-order */ }
  }

  if (regions.length === 0) {
    regions = [...FALLBACK_REGIONS];
    for (const r of FALLBACK_REGIONS) validCodes.add(r.key);
  }
  return { regions, validCodes, byState };
}

/** customer_state (+ country fallback) → region code(s). Never empty. */
export function stateToRegions(
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
