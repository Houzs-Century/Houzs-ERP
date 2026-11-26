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
  itemGroup?: string | null;
  item_group?: string | null;
  remark?: string | null;
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
  new_remark?: string | null;
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

const BEDFRAME_ONLY_AXES = ['divanHeight', 'gap', 'totalHeight', 'colourLabel'] as const;

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

const variantsChanged = (l: DiffableAmendmentLine): boolean => {
  const old = amendmentOldSnapshot(l);
  const group = resolveVariantGroup(l);
  const to = summaryOf(group, l.new_variants);
  if (old.variants == null) return (old.description2 ?? '').trim() !== to;
  return summaryOf(group, old.variants) !== to;
};

export function amendmentLineChangedFields(
  l: DiffableAmendmentLine,
): AmendmentLineChangedFields {
  // An ADD has no before and a REMOVE has no after — the row itself IS the
  // change, there is nothing to compare. Except the remark and the discount:
  // both are OPTIONAL on a line, so on a whole-line change each counts only when
  // the line actually carries one. Flagging them always made every card say
  // "Remark cleared" / "Discount cleared" about an added line that had neither
  // (docs/bugs/0919-an-added-amendment-line-said-remark-cleared-and-discount-cle.md).
  if (l.change_type === 'ADD') {
    return {
      ...EVERYTHING,
      remark: (l.new_remark ?? '').trim() !== '',
      discount: Math.round(l.new_discount_sen ?? 0) > 0,
    };
  }
  const old = amendmentOldSnapshot(l);
  if (l.change_type === 'REMOVE') {
    return {
      ...EVERYTHING,
      remark: (old.remark ?? '').trim() !== '',
      discount: Math.round(old.discountSen ?? 0) > 0,
    };
  }
  return {
    itemCode: (l.new_item_code ?? old.itemCode ?? null) !== (old.itemCode ?? null),
    qty:      (l.new_qty ?? old.qty ?? null) !== (old.qty ?? null),
    unitPrice: l.new_unit_price_sen != null
      && l.new_unit_price_sen !== (old.unitPriceSen ?? null),
    variants: variantsChanged(l),
    remark: l.new_remark != null
      && l.new_remark.trim() !== (old.remark ?? '').trim(),
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

/** The variants blob as an AMENDMENT compares and sends it: without the `remark`
    key. The phone's line editor copies the line remark into `variants.remark`
    (buildVariants) while the stored blob of an imported line carries none, so a
    compare of the raw blobs read every remarked line as a spec change and a
    Delivery Date change on HC-SO-011410 opened a second, Purchaser approval over
    nothing (owner 2026-09-15). The remark rides `newRemark`, not the variants. */
export const amendmentVariants = (v: unknown): Record<string, unknown> | null => {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const rest = { ...(v as Record<string, unknown>) };
  delete rest.remark;
  return Object.keys(rest).length === 0 ? null : rest;
};

const canonicalJson = (o: unknown): string => {
  if (o == null) return 'null';
  if (typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return `[${o.map(canonicalJson).join(',')}]`;
  const rec = o as Record<string, unknown>;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
};

const DEFAULT_LEG_RE = /^\s*default\s*$/i;

/** Whether two variants blobs ask for a different item — the client's copy of
    the server's variantsForCompare (amendment-noop-lines.ts). Beyond the remark
    side channel and key order, it ignores what the edit view FILLS on a saved
    line when it opens: the recomputed bedframe totalHeight (derived from divan +
    leg + gap, which are compared) and a blank sofa leg set to "Default". Both
    made a payment-only save raise a Purchaser amendment (HC-0103). */
export const amendmentVariantsKey = (v: unknown): string => {
  const rest = amendmentVariants(v);
  if (!rest) return 'null';
  delete rest.totalHeight;
  delete rest.fabricSupplierCode;
  delete rest.fabricSupplierCodeOf;
  if (typeof rest.legHeight === 'string' && DEFAULT_LEG_RE.test(rest.legHeight)) delete rest.legHeight;
  return Object.keys(rest).length === 0 ? 'null' : canonicalJson(rest);
};

/** The stored line's remark as the edit view seeds it: the column, else the copy
    an older write left in variants.remark (HC-SO-2609-321/A2). */
export const storedLineRemark = (remark: string | null | undefined, variants: unknown): string => {
  if (remark != null) return remark;
  const v = variants as Record<string, unknown> | null | undefined;
  return v && typeof v === 'object' && typeof v.remark === 'string' ? v.remark : '';
};

export const amendmentLineSig = (d: AmendmentSigDraft): string => JSON.stringify({
  itemCode:     d.itemCode,
  qty:          d.qty,
  unitPriceSen: d.unitPriceSen,
  variants:     amendmentVariantsKey(d.variants),
  remark:       d.remark ?? '',
  discountSen:  Math.round(d.discountSen ?? 0),
});

export const amendmentRequestedUnitPriceSen = (
  d: { unitPriceSen: number; priceAuthored?: boolean },
): number | null => (d.unitPriceSen === 0 && d.priceAuthored !== true ? null : d.unitPriceSen);

/* HC-0095 — the price half of an amendment line's payload. A requested 0 can
   only be an authored one (see above), so it carries `zeroPriceIntended`; the
   apply refuses a 0 without it and keeps the stored price, which also covers a
   0 queued by an older bundle. */
export const amendmentPriceFields = (
  d: { unitPriceSen: number; priceAuthored?: boolean },
): { newUnitPriceSen?: number; zeroPriceIntended?: true } => {
  const sen = amendmentRequestedUnitPriceSen(d);
  if (sen == null) return {};
  return sen === 0 ? { newUnitPriceSen: 0, zeroPriceIntended: true } : { newUnitPriceSen: sen };
};

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
  if (f.remark) kinds.push('LINE');
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
