// Vendored VERBATIM from packages/shared/src/so-variant-rule.ts — needed by
// inventory-adjustment.ts (adjustmentIncreaseErrors → missingVariantAxes). Pure
// (no I/O, no supabase), so it copies byte-for-byte. The stock-adjustment New
// page only uses `missingVariantAxes` (via inventory-adjustment); the rest of
// the module (canonicalizeVariants) is kept verbatim for completeness.
//
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

/** Resolve a raw item group / category to the MAIN bucket the server's sofa
 *  gate uses. Mirrors mfg-sales-orders `normCat` (substring match, so 'Sofa Set'
 *  → SOFA). SERVICE / ACCESSORY / OTHERS ride on any order and return ''. */
function mainCategory(raw: string | null | undefined): '' | 'SOFA' | 'BEDFRAME' | 'MATTRESS' {
  const g = (raw ?? '').trim().toUpperCase();
  if (g.includes('BEDFRAME')) return 'BEDFRAME';
  if (g.includes('SOFA'))     return 'SOFA';
  if (g.includes('MATTRESS')) return 'MATTRESS';
  return '';
}

/** True when the lines mix a SOFA main product with a bedframe / mattress main
 *  product — the server rejects this 400 `so_sofa_no_other_main`
 *  (mfg-sales-orders). Service / accessory / others lines never trip it. Used by
 *  the SO editors (desktop New / Detail + mobile) to block + warn BEFORE save so
 *  the operator gets one plain sentence instead of a raw 400. `itemGroups` is
 *  each line's resolved category / itemGroup. */
export function hasSofaMixConflict(itemGroups: Array<string | null | undefined>): boolean {
  const cats = itemGroups.map(mainCategory);
  return cats.includes('SOFA')
    && cats.some((c) => c === 'BEDFRAME' || c === 'MATTRESS');
}

/** One plain sentence for the sofa-mix block (owner standing rule: user errors
 *  = one plain sentence). Shared so desktop + mobile show identical copy. */
export const SOFA_MIX_MESSAGE =
  "A sofa order can't be mixed with bedframe or mattress items — use a separate order.";

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

/** Adjustable (electric) beds, pull-out/trundle combos ((S+S) / (SS+S)) and
 *  double-decker bunks have no divan base at all — physically there is no
 *  Divan Height, Leg Height or Gap to state, only the fabric colour (owner
 *  2026-08-10: "电动床/抽拉床…像 DIVAN ONLY 一样豁免 — 要"). */
export const isDivanlessFrame = (itemCode: string | null | undefined): boolean =>
  /ADJUSTABLE|\(S?S\+S\)|DOUBLE\s*D[AE]C?KER|\bDDB/i.test(itemCode ?? '');

/** A CONSOLE (the table between two seats) and a CT (coffee table) have no seat,
 *  so they can have no seat height — asking for one reports a defect no source
 *  can fix. Owner 2026-08-11, stating the class directly: "有些 sku 是没有的";
 *  the AutoCount sketches show it, on PO-009553 both seat boxes carry a figure
 *  and the console box is deliberately blank.
 *
 *  Matched on the COMPARTMENT (the part after the first hyphen), not the whole
 *  code, so `8030-CONSOLE` is exempt and a model whose name merely starts with
 *  those letters is not.
 *
 *  Deliberately narrow. STOOL is NOT here — a stool is something you sit on, and
 *  no line currently reports it missing, so exempting it would be a guess with
 *  no case behind it. Add a piece here only with evidence that it has no seat.
 *
 *  WHY IT ARRIVES HERE ONLY NOW. It was written in the .mjs audit mirror
 *  (scripts/lib/variant-axes.mjs) and never in this file, so for the audit a
 *  console line was complete and for the APP — the SO gate operators actually
 *  hit — it was missing a Seat Height. tests/variantAxesMirror.test.ts is
 *  supposed to make that impossible and did not catch it: its code list had no
 *  CONSOLE or CT case, so the two implementations were only ever compared where
 *  they agreed. That list now carries both. */
const SEATLESS_PIECE = /^(CONSOLE|CT)\b/i;

const compartmentOfCode = (itemCode: string | null | undefined): string => {
  const c = String(itemCode ?? '').toUpperCase();
  const i = c.indexOf('-');
  return i < 0 ? '' : c.slice(i + 1);
};

export const isSeatlessPiece = (itemCode: string | null | undefined): boolean =>
  SEATLESS_PIECE.test(compartmentOfCode(itemCode));

const DIVANLESS_AXES = new Set(['divanHeight', 'legHeight', 'gap']);

export function missingVariantAxes(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
/** The item code. REQUIRED — not optional — since 2026-08-13.
 *
 *  It arrived as an OPTIONAL third parameter with the DIVAN ONLY exemption
 *  (PR #1763, owner "divan only 不需要 gap"), and optional meant the compiler
 *  said nothing about the call sites that did not pass it. Two of the three
 *  confirm-path sites never got it, so the exemption — and the adjustable-bed
 *  one added on top of it a day later — simply did not apply there: no error,
 *  no failing test, and a PR message that said "every desktop + mobile call
 *  site". Required is what makes the compiler enumerate them, so the next
 *  by-SKU exemption cannot be half-applied.
 *
 *  Pass null when a caller genuinely has no code (nothing is exempted then). */
  itemCode: string | null,
): VariantAxis[] {
  const axes = REQUIRED_VARIANT_AXES_BY_CATEGORY[(itemGroup ?? '').toLowerCase()];
  if (!axes) return [];
  const v = variants ?? {};
  const skipGap = isDivanOnly(itemCode);
  const skipBase = isDivanlessFrame(itemCode);
  const skipSeat = isSeatlessPiece(itemCode);
  return axes.filter(
    (axis) =>
      axis.required !== false &&
      !(skipGap && axis.key === 'gap') &&
      !(skipBase && DIVANLESS_AXES.has(axis.key)) &&
      !(skipSeat && axis.key === 'seatHeight') &&
      axis.aliases.every((k) => isEmpty(v[k])),
  );
}

/** Same axes map as missingVariantAxes, with ONE carve-out: a colour-KIV line
 *  (fabric SERIES committed via fabricId / fabricLabel, colour confirmed later
 *  — isColourKiv) SATISFIES the fabric axis.
 *
 *  IT NO LONGER GATES CONFIRM, despite the name. It was born as the confirm
 *  rule (owner 2026-08-08, HC-SO-2607-008: a bedframe line confirmed with no
 *  variant selections at all) and the owner NARROWED it the same week —
 *  "只要是没有 proceed 这一张订单，其实都不一定是需要填写的" — so #2072 took
 *  variants out of so-confirm-gate entirely. Variant completeness is a
 *  PROCESSING-DATE gate now (so-variant-check.ts), and that gate calls
 *  missingVariantAxes, not this.
 *
 *  Its docblock claimed for a week that "desktop, mobile and the backend
 *  confirm gate all read THIS so the rule cannot drift" while nothing read it
 *  at all — a function with no callers cannot keep anything from drifting, and
 *  a comment saying otherwise is how the next reader adds an exemption here and
 *  believes it shipped.
 *
 *  WHAT DOES READ IT: the audit mirror scripts/lib/variant-axes.mjs, so
 *  check-so-noncatalog-lines.mjs's "confirmable?" report judges by this rule
 *  instead of by a hand-typed copy of it. Keep it exported for that. */
export function missingConfirmVariantAxes(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
/** The item code. REQUIRED — not optional — since 2026-08-13.
 *
 *  It arrived as an OPTIONAL third parameter with the DIVAN ONLY exemption
 *  (PR #1763, owner "divan only 不需要 gap"), and optional meant the compiler
 *  said nothing about the call sites that did not pass it. Two of the three
 *  confirm-path sites never got it, so the exemption — and the adjustable-bed
 *  one added on top of it a day later — simply did not apply there: no error,
 *  no failing test, and a PR message that said "every desktop + mobile call
 *  site". Required is what makes the compiler enumerate them, so the next
 *  by-SKU exemption cannot be half-applied.
 *
 *  Pass null when a caller genuinely has no code (nothing is exempted then). */
  itemCode: string | null,
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
