// ----------------------------------------------------------------------------
// canonical-state.ts — Malaysian state vocabulary normaliser.
//
// Owner 2026-07-22 (SO list showed "Pulau Pinang" and "PENANG" side by side):
// the PMS surfaces stored UPPERCASE short codes (JOHOR / KL / PENANG / N.S.),
// while the SCM surfaces stored the Title Case names from scm.my_localities
// (Johor / Kuala Lumpur / Pulau Pinang / Negeri Sembilan). Any cross-module
// report bucketed on `state` therefore split the same physical state.
//
// The canonical spelling is the one stored in `scm.my_localities` (~5,870
// rows seeded from Pos Malaysia's postcode dataset).
//
// This helper mirrors the SQL function `scm.canonicalize_my_state()` from
// migration 0175 so backend write paths can canonicalize BEFORE the row is
// inserted — the SQL function is the safety net; the TS helper is the front
// door. Keep the two in sync: any addition to the WHEN-list below MUST also
// land in 0175_scm_state_canonicalize.sql (or a follow-up migration), and
// vice versa.
// ----------------------------------------------------------------------------

const CANONICAL_STATES: ReadonlySet<string> = new Set([
  'Johor', 'Kedah', 'Kelantan', 'Kuala Lumpur', 'Labuan', 'Melaka',
  'Negeri Sembilan', 'Pahang', 'Perak', 'Perlis', 'Pulau Pinang',
  'Putrajaya', 'Sabah', 'Sarawak', 'Selangor', 'Terengganu',
]);

/** Every historical / alternate spelling → its canonical form.
 *  Keys are already normalised (upper, whitespace collapsed, dots stripped)
 *  so the lookup is a single map hit after normalisation. */
const ALIAS_MAP: ReadonlyMap<string, string> = new Map([
  ['JOHOR', 'Johor'],
  ['KEDAH', 'Kedah'],
  ['KELANTAN', 'Kelantan'],
  ['KL', 'Kuala Lumpur'],
  ['KUALA LUMPUR', 'Kuala Lumpur'],
  ['WP KUALA LUMPUR', 'Kuala Lumpur'],
  ['W P KUALA LUMPUR', 'Kuala Lumpur'],
  ['WILAYAH PERSEKUTUAN KUALA LUMPUR', 'Kuala Lumpur'],
  ['LABUAN', 'Labuan'],
  ['WP LABUAN', 'Labuan'],
  ['W P LABUAN', 'Labuan'],
  ['MELAKA', 'Melaka'],
  ['MALACCA', 'Melaka'],
  ['NEGERI SEMBILAN', 'Negeri Sembilan'],
  ['NS', 'Negeri Sembilan'],
  ['N S', 'Negeri Sembilan'],
  ['N SEMBILAN', 'Negeri Sembilan'],
  ['PAHANG', 'Pahang'],
  ['PENANG', 'Pulau Pinang'],
  ['PULAU PINANG', 'Pulau Pinang'],
  ['P PINANG', 'Pulau Pinang'],
  ['PERAK', 'Perak'],
  ['PERLIS', 'Perlis'],
  ['PUTRAJAYA', 'Putrajaya'],
  ['WP PUTRAJAYA', 'Putrajaya'],
  ['W P PUTRAJAYA', 'Putrajaya'],
  ['SABAH', 'Sabah'],
  ['SARAWAK', 'Sarawak'],
  ['SELANGOR', 'Selangor'],
  ['TERENGGANU', 'Terengganu'],
  ['TRENGGANU', 'Terengganu'],
]);

/** Normalise a raw string for alias lookup: upper, then REPLACE dots with a
 *  space (not just drop them) so `P.PINANG`, `P. PINANG` and `P PINANG` all
 *  collapse to the same key. Then collapse whitespace, trim. */
function probeKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

/** Return the canonical Malaysian state name for the input, or the input
 *  unchanged when it's null/empty/unrecognised. Idempotent: canonical strings
 *  return unchanged.
 *
 *  The `country` hint is optional. If provided and NOT Malaysia (case-
 *  insensitive), we skip the mapping — a foreign state name like "Guangdong"
 *  or "Central" must not be corrupted. Callers that don't know the country
 *  should omit the hint; unrecognised strings still round-trip unchanged so
 *  the worst case is no-op.
 */
export function canonicalizeMyState(
  input: string | null | undefined,
  country?: string | null,
): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed === '') return input;
  if (country != null && country.trim() !== '') {
    const cu = country.trim().toUpperCase();
    if (cu !== 'MALAYSIA' && cu !== 'MY') return input;
  }
  if (CANONICAL_STATES.has(trimmed)) return trimmed;
  const key = probeKey(trimmed);
  return ALIAS_MAP.get(key) ?? input;
}

/** True when `s` (after normalisation) is one of the 16 canonical MY states.
 *  Convenience for backend validators that want to REJECT rather than munge. */
export function isCanonicalMyState(s: string | null | undefined): boolean {
  if (s === null || s === undefined) return false;
  return CANONICAL_STATES.has(s.trim());
}

/** The 16 canonical values, in the same order the frontend dropdown expects. */
export const CANONICAL_MY_STATES: readonly string[] = [
  'Johor', 'Kedah', 'Kelantan', 'Kuala Lumpur', 'Labuan', 'Melaka',
  'Negeri Sembilan', 'Pahang', 'Perak', 'Perlis', 'Pulau Pinang',
  'Putrajaya', 'Sabah', 'Sarawak', 'Selangor', 'Terengganu',
];
