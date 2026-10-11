// ----------------------------------------------------------------------------
// so-variant-check — the API-side gate for "a line's category-required
// variants are all filled".
//
// Commander 2026-05-29: the rule "setting a Processing Date requires every line
// to carry its category-mandatory variants" was enforced on the PATCH header
// path (mfg-sales-orders.ts) and in the UI (SoLineCard.missingRequiredVariants),
// but the POST create path skipped it — so a direct API POST with a processing
// date + blank variants slipped through (found while seeding test SOs). Extract
// the check here so POST + PATCH share ONE implementation and can't drift.
//
// 2026-06-04: the rule itself moved to ../shared `so-variant-rule` —
// the requirement lists here only knew the Backend coordinator vocabulary
// (sofa → seatHeight + legHeight), while POS handover sends the same facts as
// `depth` + `sofaLegHeight`, so every POS sofa order carrying a Process Date
// 409'd `variants_incomplete` at the handover screen. The shared rule treats
// alias keys as one axis; this file keeps the offender-report shape the
// routes already consume.
//
// Pure — no I/O. ------------------------------------------------------------
import {
  REQUIRED_VARIANT_AXES_BY_CATEGORY,
  isColourKiv,
  missingVariantAxes,
} from '../shared';

/** Back-compat view of the rule (canonical keys only). Prefer the axes map
 *  in ../shared for anything new. */
export const REQUIRED_VARIANTS_BY_CATEGORY: Record<string, string[]> =
  Object.fromEntries(
    Object.entries(REQUIRED_VARIANT_AXES_BY_CATEGORY).map(([g, axes]) => [
      g,
      axes.map((a) => a.key),
    ]),
  );

export type SoLineForVariantCheck = {
  id?: string;
  itemCode: string;
  group: string | null | undefined;     // item_group / itemGroup, any case
  variants: Record<string, unknown> | null | undefined;
};

export type VariantOffender = { id?: string; itemCode: string; group: string; missing: string[] };

/** Return the lines whose category demands variants the line didn't fill.
 *  Empty array = every line is complete (or has no mandatory variants).
 *  `missing` lists canonical (Backend-vocabulary) keys — an axis is satisfied
 *  by ANY of its aliases (e.g. sofa seatHeight|depth, legHeight|sofaLegHeight). */
export function findIncompleteVariantLines(
  lines: readonly SoLineForVariantCheck[],
): VariantOffender[] {
  const out: VariantOffender[] = [];
  for (const l of lines) {
    const group = (l.group ?? '').toLowerCase();
    const missing = missingVariantAxes(group, l.variants, l.itemCode).map((a) => a.key);
    if (missing.length > 0) {
      out.push({ ...(l.id ? { id: l.id } : {}), itemCode: l.itemCode, group, missing });
    }
  }
  return out;
}

export type ColourKivOffender = { id?: string; itemCode: string; fabricLabel: string };

/** The lines whose fabric colour is still KIV (series committed via
 *  fabricId/fabricLabel, no colour-carrying key filled — the shared
 *  isColourKiv predicate, i.e. the exact state variant-summary renders as
 *  "<series> COLOUR KIV"). Deliberately variants-only: it does NOT key off the
 *  category axes map, so a line whose item_group spelling misses the
 *  REQUIRED_VARIANT_AXES_BY_CATEGORY keys is still caught. Used by the
 *  Processing-Date gate (owner rule 2026-07-24 after SO-2607-016): a KIV line
 *  must not get — or ride into — a Processing Date. */
export function findColourKivLines(
  lines: readonly SoLineForVariantCheck[],
): ColourKivOffender[] {
  const out: ColourKivOffender[] = [];
  for (const l of lines) {
    if (!isColourKiv(l.variants)) continue;
    const label = String((l.variants as Record<string, unknown> | null)?.fabricLabel ?? '').trim();
    out.push({ ...(l.id ? { id: l.id } : {}), itemCode: l.itemCode, fabricLabel: label });
  }
  return out;
}
