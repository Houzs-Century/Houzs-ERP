// ----------------------------------------------------------------------------
// so-variant-rule — the ONE source of truth for "a Sales Order line's
// category-required variants are all filled".
//
// History: the rule was born in the Backend coordinator vocabulary
// (sofa → seatHeight + legHeight + fabricCode) and hand-copied into four
// places: apps/api so-variant-check, backend SoLineCard, SalesOrderDetail,
// and sales-order/types. The POS handover speaks a DIFFERENT vocabulary for
// the same physical facts — sofa seat depth is `variants.depth` and the sofa
// leg pick is `variants.sofaLegHeight` (PR #473) — so the moment PR #448
// started threading the POS Process Date onto the SO, every POS sofa order
// with a Process Date 409'd `variants_incomplete` (2026-06-04, Bernard's
// RM 3,365 order at the handover screen).
//
// The server already treats these keys as the same axis everywhere else:
//   mfg-sales-orders.ts  → combo lookup height = depth ?? seatHeight
//   allowed-options-check → legPick = legHeight ?? sofaLegHeight
// This module encodes that equivalence ONCE: each required axis lists every
// key that satisfies it. The canonical key (first alias) is what offender
// reports name, so coordinator-facing messages keep the Backend vocabulary.
//
// Pure — no I/O. Shared by apps/api (409 gate), apps/backend (save gates +
// warning banners), and any future surface. Do NOT hand-copy the lists again.
// ----------------------------------------------------------------------------
import { isColourKiv } from './variant-summary';

export type VariantAxis = {
  /** Canonical key — what offender lists / `missing` arrays report. */
  key: string;
  /** Human label for coordinator-facing messages ("missing: Seat Height"). */
  label: string;
  /** Every variant key that satisfies this axis (canonical first). */
  aliases: readonly string[];
  /** Whether an empty value BLOCKS confirmation. Defaults to true. An axis with
   *  `required: false` still participates in alias canonicalization (so the edit
   *  form maps POS-vocabulary keys onto the canonical key) but never appears in
   *  `missingVariantAxes` — used for the sofa Leg Height, which carries a
   *  standing "Default" option (RM 0.00) so it is always pre-filled and must
   *  never gate Confirm (owner 2026-07-13). */
  required?: boolean;
};

export const REQUIRED_VARIANT_AXES_BY_CATEGORY: Record<string, readonly VariantAxis[]> = {
  bedframe: [
    { key: 'divanHeight', label: 'Divan Height', aliases: ['divanHeight'] },
    { key: 'legHeight',   label: 'Leg Height',   aliases: ['legHeight'] },
    { key: 'gap',         label: 'Gap',          aliases: ['gap'] },
    // GRN-family editors store the fabric pick as fabricColor (see variant-key);
    // accept it so a received line counts as fabric-complete.
    { key: 'fabricCode',  label: 'Fabrics',      aliases: ['fabricCode', 'colorCode', 'colourCode', 'fabricColor'] },
  ],
  sofa: [
    // Backend coordinators fill seatHeight; the POS configurator captures the
    // same physical pick as `depth` (always set — Configurator activeDepth).
    { key: 'seatHeight',  label: 'Seat Height',  aliases: ['seatHeight', 'depth'] },
    // Backend fills legHeight; POS sends sofaLegHeight (PR #473 leg picker).
    // NOT required: the sofa Leg Height always defaults to the "Default" option
    // (RM 0.00) at create/edit time, so it is never empty and must never block
    // Confirm. Kept in the list so canonicalizeVariants still maps sofaLegHeight
    // → legHeight for POS-created lines (owner 2026-07-13).
    { key: 'legHeight',   label: 'Leg Height',   aliases: ['legHeight', 'sofaLegHeight'], required: false },
    { key: 'fabricCode',  label: 'Fabrics',      aliases: ['fabricCode', 'colorCode', 'colourCode', 'fabricColor'] },
  ],
};

const isEmpty = (val: unknown): boolean =>
  val === undefined || val === null || String(val).trim() === '';

/** The axes a line leaves unsatisfied — [] when the line is complete or its
 *  category has no mandatory variants (mattress / accessory / service). An
 *  axis is satisfied when ANY of its aliases carries a non-empty value. */
/** A DIVAN ONLY line is a divan sold without a mattress, so there is no
 *  mattress Gap to state — demanding one blocked orders that were complete
 *  (owner 2026-08-09: "divan only 不需要 gap"). Matched on the item code so it
 *  holds for every DIVAN ONLY variant (HOK-DIVAN ONLY (K), NB-DIVAN ONLY ...). */
export const isDivanOnly = (itemCode: string | null | undefined): boolean =>
  /\bDIVAN\s*ONLY\b/i.test(itemCode ?? '');

export function missingVariantAxes(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
  itemCode?: string | null,
): VariantAxis[] {
  const axes = REQUIRED_VARIANT_AXES_BY_CATEGORY[(itemGroup ?? '').toLowerCase()];
  if (!axes) return [];
  const v = variants ?? {};
  const skipGap = isDivanOnly(itemCode);
  return axes.filter(
    (axis) =>
      axis.required !== false &&
      !(skipGap && axis.key === 'gap') &&
      axis.aliases.every((k) => isEmpty(v[k])),
  );
}

/** The axes a line must fill BEFORE THE ORDER MAY BE CONFIRMED (owner
 *  2026-08-08, HC-SO-2607-008: a bedframe line confirmed with no variant
 *  selections at all). Same axes map as missingVariantAxes, with ONE
 *  carve-out: a colour-KIV line (fabric SERIES committed via fabricId /
 *  fabricLabel, colour confirmed later — isColourKiv) SATISFIES the fabric
 *  axis. KIV is a legitimate confirmed-order state; it blocks the Processing
 *  Date (owner rule 2026-07-24), never confirm. Desktop, mobile and the
 *  backend confirm gate all read THIS so the rule cannot drift. */
export function missingConfirmVariantAxes(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
  itemCode?: string | null,
): VariantAxis[] {
  const missing = missingVariantAxes(itemGroup, variants, itemCode);
  if (missing.length === 0) return missing;
  return isColourKiv(variants ?? null)
    ? missing.filter((axis) => axis.key !== 'fabricCode')
    : missing;
}

/** Rewrite POS-vocabulary alias keys to their canonical axis key for the given
 *  category (sofa: depth → seatHeight, sofaLegHeight → legHeight). Returns a
 *  shallow copy; unknown categories / keys pass through untouched.
 *
 *  Why this exists: the editor dropdowns read the canonical key (seatHeight /
 *  legHeight) but a POS-created sofa line stores depth / sofaLegHeight, so the
 *  Edit modal rendered those axes blank even though the line had them
 *  (2026-06-08, Loo — sofa edit re-asks Seat/Leg). Apply it when seeding an
 *  editable draft from a persisted line.
 *
 *  The alias key is REMOVED after copying so a subsequent edit of the canonical
 *  value isn't shadowed by a stale alias in `alias ?? canonical` consumers
 *  (e.g. mfg-sales-orders combo lookup = `depth ?? seatHeight`). Canonical wins
 *  when both are present. */
export function canonicalizeVariants(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const v: Record<string, unknown> = { ...(variants ?? {}) };
  const axes = REQUIRED_VARIANT_AXES_BY_CATEGORY[(itemGroup ?? '').toLowerCase()];
  if (!axes) return v;
  for (const axis of axes) {
    for (const alias of axis.aliases) {
      if (alias === axis.key) continue;
      if (!(alias in v)) continue;
      if (isEmpty(v[axis.key]) && !isEmpty(v[alias])) v[axis.key] = v[alias];
      delete v[alias];
    }
  }
  return v;
}
