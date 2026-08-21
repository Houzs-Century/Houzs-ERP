// ----------------------------------------------------------------------------
// so-amendment-line-diff — PURE display logic for the LINE half of an SO
// amendment. NO React, no I/O. The approver's job card (AmendmentDetailV2), the
// desktop SO-detail diff modal and the mobile "View changes" sheet all render
// the same rows, so "is this line actually a change, and WHICH field moved"
// lives ONCE — the header half's mirror of so-amendment-header.ts.
//
// WHY THIS EXISTS (Owner 2026-07-16): "完全看不出有什麼變動申請？" — an amendment
// whose real request was a HEADER change rendered four SPEC CHANGE cards whose
// Was and Requesting columns were character-for-character identical, above a
// header that claimed "4 changes". The approver could not tell what was being
// asked, and the count was a lie.
//
// A recorded line can be delta-free for two reasons, both real in prod data:
//   * the create-time builder's dirtiness test (lineCommitSig) was WIDER than
//     the payload an amendment line can carry, so a line dirty only in
//     lineDeliveryDate — which the header Delivery Date cascade rewrites on
//     EVERY non-overridden line — was recorded with new_* == old_*.
//   * draftFromItem canonicalises variants (POS sofa aliases) while the
//     oldSnapshot records the RAW item.variants, so a POS-created line could
//     record a "changed" variant blob that renders identically.
// The builders no longer record either (see buildAmendmentLines on both
// platforms), but rows created before that fix are already in the DB — this
// module is what stops them lying to the approver.
//
// The comparison is deliberately made on the RENDERED values, not the raw
// blobs: the surfaces show item code / qty / unit price / variant SUMMARY, and
// the summary is alias-aware (buildVariantSummary) while the raw variants are
// not. Comparing raw JSON would call a canonicalised-but-identical POS line a
// change — exactly the lie this closes. The rule is simply: if what the
// approver reads on the left equals what they read on the right, it is not a
// change. No real request can be hidden by it — these five fields are the ONLY
// things an amendment line carries (the fifth, REMARK, arrived with mig 0280;
// before it, a remark-only request could not be recorded at all).
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '@2990s/shared';
import { routeField, type AmendmentFieldKind, type FieldRouting } from './amendment-routing';

/** The old_snapshot blob both builders record. */
export type AmendmentOldSnapshot = {
  itemCode?: string;
  qty?: number;
  unitPriceSen?: number;
  description2?: string | null;
  variants?: unknown;
  /* The line's item GROUP, stamped server-side at create time from the SO item
     row (mfg_sales_order_items.item_group). buildVariantSummary BRANCHES on it —
     bedframe reads divanHeight / gap / totalHeight / colourLabel, everything else
     reads seatHeight / legHeight — so rendering a bedframe blob without it drops
     three real axes off the Requesting side. Absent on rows created before that
     stamp; resolveVariantGroup recovers it from the blob rather than guessing.
     `item_group` is accepted too: so-revision's ADD path already reads that key. */
  itemGroup?: string | null;
  item_group?: string | null;
  /* The line's REMARK before the request (mig 0280), stamped server-side from
     mfg_sales_order_items.remark for the same reason the group is: the "was"
     side is the approver's evidence and must come from the record, not from the
     browser asking to change it. Absent on rows raised before 0280 and on ADD
     lines (which have no before). */
  remark?: string | null;
  /* The line's DISCOUNT in sen before the request (mig 0317), stamped
     server-side from mfg_sales_order_items.discount_sen. Absent on rows raised
     before 0317 and on lines carrying no discount — both read as 0. */
  discountSen?: number | null;
};

/** The subset of an amendment line this module reads. Structural, so the
    vendored AmendmentLine satisfies it without a cast at any call site. */
export type DiffableAmendmentLine = {
  change_type: string;
  new_item_code?: string | null;
  new_variants?: unknown;
  new_qty?: number | null;
  new_unit_price_sen?: number | null;
  /* mig 0280 — the requested line REMARK. null/absent = the request does not
     touch it (true of every row raised before 0280); '' = clear it. */
  new_remark?: string | null;
  /* mig 0317 — the requested DISCOUNT in sen. null/absent = the request does
     not touch it; 0 = clear it. The lever a derived price (the delivery fee)
     is reduced with, so without this field a fee reduction cannot ride. */
  new_discount_sen?: number | null;
  old_snapshot?: unknown;
};

export const amendmentOldSnapshot = (l: DiffableAmendmentLine): AmendmentOldSnapshot =>
  (l.old_snapshot as AmendmentOldSnapshot | null) ?? {};

/** Which of the line's five carryable fields this request actually moves. */
export type AmendmentLineChangedFields = {
  itemCode: boolean;
  qty: boolean;
  unitPrice: boolean;
  variants: boolean;
  remark: boolean;
  discount: boolean;
};

const EVERYTHING: AmendmentLineChangedFields = {
  itemCode: true, qty: true, unitPrice: true, variants: true, remark: true, discount: true,
};

/* ── item group: the branch selector buildVariantSummary reads ──────────────
   Owner 2026-07-18 (SO-2607-018/A1, "customer change colour"): a colour-only
   amendment on a BEDFRAME line rendered
     WAS         PC151-14 / DIVAN 8" + LEG 1" / GAP 12" / T.Heights 21"
     REQUESTING  PC151-01 / LEG 1"
   and the owner read it as the amendment having wiped the divan, gap and total
   height off the spec. It had not — the persisted new_variants blob carried all
   four axes and applySoAmendment writes the blob whole. What was wrong was the
   RENDERING: summaryOf passed '' as the item group, so buildVariantSummary took
   its non-bedframe branch and simply never read divanHeight / gap / totalHeight,
   while the Was side (old_snapshot.description2) was stamped server-side with the
   line's REAL group and did read them. The two sides were being formatted by two
   different rules and the difference read as data loss.

   The same '' also went through variantsChanged, which is the dangerous half: a
   bedframe amendment that changed ONLY the divan height produced identical
   summaries on both sides, so the line scored as no-change and was dropped by
   visibleAmendmentLines — the approver never saw the request at all. */

/* The axes buildVariantSummary reads ONLY on its bedframe branch. A blob that
   carries any of them is a bedframe blob: this is read off the data, not
   guessed, and it is exactly the set the non-bedframe branch would silently
   drop. Keep in sync with buildVariantSummary. */
const BEDFRAME_ONLY_AXES = ['divanHeight', 'gap', 'totalHeight', 'colourLabel'] as const;

/* The axes the NON-bedframe branch reads and the bedframe branch does not. */
const SOFA_ONLY_AXES = ['seatHeight', 'depth'] as const;

const asBag = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

const hasAxis = (v: unknown, keys: readonly string[]): boolean => {
  const bag = asBag(v);
  if (!bag) return false;
  return keys.some((k) => bag[k] != null && String(bag[k]).trim() !== '');
};

/**
 * The item group BOTH sides of this line must be rendered with.
 *
 * Order of trust:
 *   1. the group stamped on old_snapshot at create time — authoritative, it is
 *      the SO item's own mfg_sales_order_items.item_group;
 *   2. for rows created before that stamp: bedframe when EITHER blob carries a
 *      bedframe-only axis. That is not a guess — those keys exist only on a
 *      bedframe line, and they are precisely the ones the other branch drops;
 *   3. '' otherwise, which is safe: with no bedframe axis present, the
 *      non-bedframe branch discards nothing.
 *
 * Returned for BOTH sides so the Was and Requesting columns are always formatted
 * by the same rule. That symmetry is what the module already relied on; it was
 * just symmetric on the WRONG group.
 */
export const resolveVariantGroup = (l: DiffableAmendmentLine): string => {
  const old = amendmentOldSnapshot(l);
  const stamped = (old.itemGroup ?? old.item_group ?? '').trim();
  if (stamped) return stamped;
  if (hasAxis(l.new_variants, BEDFRAME_ONLY_AXES)) return 'bedframe';
  if (hasAxis(old.variants, BEDFRAME_ONLY_AXES)) return 'bedframe';
  return '';
};

/**
 * The non-empty variant axes that a summary rendered with `group` would NOT
 * show — i.e. real spec the reader would never see on this card.
 *
 * This is the honesty backstop the owner's rule demands: an axis we cannot
 * render must surface as a warning, never as a silently shorter string. In
 * practice resolveVariantGroup makes this empty; it stays because the failure
 * mode it guards (a blob carrying both vocabularies, or a future axis added to
 * buildVariantSummary but not to the lists above) is exactly the one that
 * produced this bug, and it must be loud rather than invisible next time.
 */
export const unrenderedVariantAxes = (group: string, variants: unknown): string[] => {
  const dropped = group.toLowerCase().includes('bedframe') ? SOFA_ONLY_AXES : BEDFRAME_ONLY_AXES;
  const bag = asBag(variants);
  if (!bag) return [];
  return dropped.filter((k) => bag[k] != null && String(bag[k]).trim() !== '');
};

/** Render one variant blob the way the surfaces do, under the group BOTH sides
    of this line share (see resolveVariantGroup). */
const summaryOf = (group: string, v: unknown): string =>
  buildVariantSummary(group, asBag(v)).trim();

/** The variant summary each side RENDERS — old_snapshot.description2 is the
    server-stamped summary (built with the line's REAL item group), the new side
    is built from the requested blob. Display only; the change test below does
    NOT use this pair, deliberately. */
export const amendmentVariantSummaries = (
  l: DiffableAmendmentLine,
): { from: string; to: string } => {
  const group = resolveVariantGroup(l);
  const old = amendmentOldSnapshot(l);
  /* Prefer rendering the RAW old blob under the resolved group over the stored
     description2. Both are the same string when the stamp is right, but only the
     re-render is guaranteed to be formatted by the SAME rule as the Requesting
     side — and a Was/Requesting pair formatted by two different rules is exactly
     what made a colour-only change look like a wiped spec. description2 stays as
     the fallback for a legacy row that recorded no raw blob. */
  const from = old.variants != null
    ? summaryOf(group, old.variants)
    : (old.description2 ?? '').trim();
  return { from, to: summaryOf(group, l.new_variants) };
};

/** Variant axes present on this line that the card will not display, per side.
    Non-empty means the rendered summary is INCOMPLETE and the surface must say
    so rather than show a shorter string that reads as a deletion. */
export const amendmentUnrenderedAxes = (
  l: DiffableAmendmentLine,
): { from: string[]; to: string[] } => {
  const group = resolveVariantGroup(l);
  return {
    from: unrenderedVariantAxes(group, amendmentOldSnapshot(l).variants),
    to: unrenderedVariantAxes(group, l.new_variants),
  };
};

/**
 * Did the request actually move the variants?
 *
 * Both blobs go through the SAME formatter, rather than comparing the new
 * summary against the stored description2. That symmetry is the whole point —
 * it cancels the two ways an unchanged line can look changed:
 *   * description2 was stamped with the line's real item group, while the new
 *     side is rendered with ''. buildVariantSummary BRANCHES on the group
 *     (bedframe reads DIVAN/GAP/T.Heights, everything else SEAT/LEG), so an
 *     untouched BEDFRAME line would otherwise diff purely on formatting.
 *   * new_variants is draftFromItem's CANONICALISED blob while
 *     old_snapshot.variants is the RAW item blob, so a POS-vocabulary line
 *     (depth / sofaLegHeight) would otherwise diff purely on key names — and
 *     the formatter reads both vocabularies (seatHeight || depth,
 *     legHeight || sofaLegHeight), so it collapses that too.
 * A raw JSON compare fixes neither. What survives both is a real spec change.
 */
const variantsChanged = (l: DiffableAmendmentLine): boolean => {
  const old = amendmentOldSnapshot(l);
  const group = resolveVariantGroup(l);
  const to = summaryOf(group, l.new_variants);
  // No raw blob recorded (legacy row) — the stamped summary is the only signal
  // left, so fall back to it rather than guess.
  if (old.variants == null) return (old.description2 ?? '').trim() !== to;
  return summaryOf(group, old.variants) !== to;
};

export function amendmentLineChangedFields(
  l: DiffableAmendmentLine,
): AmendmentLineChangedFields {
  // An ADD has no before and a REMOVE has no after — the row itself IS the
  // change, there is nothing to compare.
  if (l.change_type === 'ADD' || l.change_type === 'REMOVE') return EVERYTHING;
  const old = amendmentOldSnapshot(l);
  return {
    /* `?? old` mirrors what every surface renders on the Requesting side: an
       omitted new value falls back to the old one, so it READS as unchanged and
       must not be flagged as a change. */
    itemCode: (l.new_item_code ?? old.itemCode ?? null) !== (old.itemCode ?? null),
    qty:      (l.new_qty ?? old.qty ?? null) !== (old.qty ?? null),
    /* A null price is not a requested price — the surfaces render no price at
       all on the Requesting side rather than falling back to the old one. */
    unitPrice: l.new_unit_price_sen != null
      && l.new_unit_price_sen !== (old.unitPriceSen ?? null),
    variants: variantsChanged(l),
    /* mig 0280. Same shape as the price test: a null new_remark is NOT a
       requested remark (it is every pre-0280 row, and every line whose remark
       did not move), so it can never render as a change. '' against a non-empty
       before IS one — clearing an instruction is a real request. */
    remark: l.new_remark != null
      && l.new_remark.trim() !== (old.remark ?? '').trim(),
    /* mig 0317. Unlike the remark, an absent before-side discount is not
       unknown — a line with no discount HAS one, of zero — so the compare
       falls back to 0 rather than refusing to flag. */
    discount: l.new_discount_sen != null
      && Math.round(l.new_discount_sen) !== Math.round(old.discountSen ?? 0),
  };
}

/* ── amendmentLineSig ── the dirtiness test for the amendment editor ──────────

   Serialised signature of exactly the fields an AMENDMENT LINE can carry — the
   CreateAmendmentLine payload's fields, and no more. Owner 2026-07-16
   ("完全看不出有什麼變動申請？"): testing dirtiness with the 13-field line-PATCH
   signature recorded phantom SPEC rows for fields the amendment cannot deliver
   (the header Delivery Date cascade mass-produced them). Both sides must be
   draftFromItem output so canonicalisation never false-positives.

   REMARK joined 2026-08-11 (mig 0280): a remark-only edit scored as "unmoved",
   so the instruction that was a service line's entire point was never
   requested. DISCOUNT joined 2026-08-21 (mig 0317) for the identical reason:
   the delivery fee's one sanctioned reduction lever is the line discount, so a
   fee edit on a locked SO scored as "unmoved" and the operator was told
   "Saved without an amendment" about work that went nowhere. A field may join
   this signature ONLY together with its payload field, its so_amendment_lines
   column and its applySoAmendment write — a signature entry without the
   channel behind it recreates the phantom-SPEC defect this replaced. */
export type AmendmentSigDraft = {
  itemCode: string;
  qty: number;
  unitPriceSen: number;
  variants?: unknown;
  remark?: string | null;
  discountSen?: number | null;
};

export const amendmentLineSig = (d: AmendmentSigDraft): string => JSON.stringify({
  itemCode:     d.itemCode,
  qty:          d.qty,
  unitPriceSen: d.unitPriceSen,
  variants:     d.variants ?? null,
  remark:       d.remark ?? '',
  discountSen:  Math.round(d.discountSen ?? 0),
});

/** True when the line requests at least one field change. */
export const amendmentLineIsChange = (l: DiffableAmendmentLine): boolean => {
  const f = amendmentLineChangedFields(l);
  return f.itemCode || f.qty || f.unitPrice || f.variants || f.remark || f.discount;
};

/** The field ATOMS an SO amendment line moves — the input to amendment-routing's
    classifier. ADD / REMOVE is a whole-line change (LINE); otherwise one atom per
    field that actually moved. Empty for a delta-free row. Shared by the SO
    amendment detail, the desktop diff modal and the mobile diff sheet so all
    three label a changed row with the SAME responsible department. */
export const amendmentLineFieldKinds = (l: DiffableAmendmentLine): AmendmentFieldKind[] => {
  if (l.change_type === 'ADD' || l.change_type === 'REMOVE') return ['LINE'];
  const f = amendmentLineChangedFields(l);
  const kinds: AmendmentFieldKind[] = [];
  if (f.itemCode) kinds.push('SPEC');
  if (f.variants) kinds.push('VARIANT');
  if (f.qty) kinds.push('QTY');
  if (f.unitPrice) kinds.push('PRICE');
  /* A free-text remark is not routable on its own — it is an instruction to
     whoever executes the line, so it routes LINE (Production / Design), exactly
     as amendment-routing's LABEL_TO_KIND already maps a 'notes' field. */
  if (f.remark) kinds.push('LINE');
  /* A discount changes what the customer pays — money routes exactly as a
     price change does. */
  if (f.discount) kinds.push('PRICE');
  return kinds;
};

/** The full {type, department} routing for each atom this line moves. */
export const amendmentLineRouting = (l: DiffableAmendmentLine): FieldRouting[] =>
  amendmentLineFieldKinds(l).map(routeField);

/** The lines worth SHOWING — and worth COUNTING. A delta-free row is dropped:
    it is not a change, so it must not render as one or inflate the "N changes"
    total the approver reads. */
export const visibleAmendmentLines = <T extends DiffableAmendmentLine>(
  lines: T[],
): T[] => lines.filter(amendmentLineIsChange);
