// Single source of truth for venue-name canonicalization.
//
// The system has historically stored the venue as free text on TWO surfaces — the
// PMS `projects.venue` (+ the `project_venues` picker) and the SCM showroom side
// (`scm.mfg_sales_orders.venue`, `scm.warehouses.venue_name`). Each was cleaned up by
// separate one-shot backfills, so the same place drifted back apart (e.g. "PJ Showroom"
// vs "2990s PJ"). This module is imported by BOTH the runtime write paths and the
// backfill script so the guard and the cleanup can never disagree — every surface that
// writes or displays a venue resolves through the same map.
//
// To unify another venue in future, add a row to VENUE_CANONICAL_MAP.

/** canonical display name -> the raw variants that must fold into it (compare key form). */
export const VENUE_CANONICAL_MAP: Record<string, string[]> = {
  "2990s PJ": [
    "pj showroom",
    "pj-showroom",
    "pjshowroom",
    "2990s pj",
    "2990spj",
    "2990 pj",
    "2990pj",
  ],
};

/** Normalize a name to its lookup key: lower-case, trimmed, inner whitespace collapsed. */
export function venueKey(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

// Reverse index: variant key -> canonical name (built once).
const VARIANT_TO_CANONICAL: Record<string, string> = (() => {
  const idx: Record<string, string> = {};
  for (const [canonical, variants] of Object.entries(VENUE_CANONICAL_MAP)) {
    idx[venueKey(canonical)] = canonical;
    for (const v of variants) idx[venueKey(v)] = canonical;
  }
  return idx;
})();

/**
 * Fold a venue string to its canonical form. Blank stays blank (null); an unknown
 * venue is returned trimmed but otherwise unchanged (we only unify known aliases).
 */
export function canonicalizeVenue(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return VARIANT_TO_CANONICAL[venueKey(trimmed)] ?? trimmed;
}

/** All lookup keys that fold into a given canonical name — for SQL backfills. */
export function variantKeysFor(canonical: string): string[] {
  const key = venueKey(canonical);
  return Object.entries(VARIANT_TO_CANONICAL)
    .filter(([, c]) => venueKey(c) === key)
    .map(([variant]) => variant);
}
