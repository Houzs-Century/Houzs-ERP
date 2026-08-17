// ----------------------------------------------------------------------------
// return-unlinked-lines — the same back door, on the two RETURN chains.
//
// The delivery side (do-unlinked-so-lines) and the receiving side
// (grn-unlinked-po-lines) were closed on 2026-08-04 after one Sales Order
// shipped twice. Both returns have the identical shape and neither had a guard:
//
//   scm.delivery_returns.delivery_order_id   names a DO
//   scm.delivery_return_items.do_item_id     is NULLABLE
//
//   scm.purchase_returns.grn_id              names a GRN
//   scm.purchase_return_items.grn_item_id    is NULLABLE
//
// A return line with a null link still MOVES THE STOCK — a Delivery Return
// brings goods back IN, a Purchase Return sends them OUT — but it counts toward
// no parent line, so the remaining pools those chains are governed by
// (`delivered - invoiced - returned` for DR, `qty_accepted - returned_qty` for
// PR) never see it. The same goods can therefore be returned twice.
//
// A production scan on 2026-08-04 found ZERO rows of this shape on both chains,
// so this is preventative rather than corrective. That is the reason to add it
// now: the cost of the guard is one query on a path that is already doing
// several, and the cost of NOT having it was three weeks of a double deduction
// nobody could see.
//
// THE RULE IS THE SAME NARROW ONE, and deliberately so — one definition of "the
// same item", one shape of refusal across all four chains:
//
//   header names no parent            -> nothing to bypass, allowed
//   item is NOT on the named parent   -> genuinely ad-hoc, allowed
//   item IS on the named parent       -> REFUSED: link it
//
// A goodwill item added to a return, or a part the original document never
// contained, still passes. What is refused is returning what the parent document
// contains while recording that it does not.
// ----------------------------------------------------------------------------

import {
  findUnlinkedSoItemLines,
  readParentCodes,
  type ParentCodes,
  type UnlinkedCandidate,
  type UnlinkedScan,
} from './do-unlinked-so-lines';

export type UnlinkedReturnOffender = {
  lineRef: string;
  itemCode: string;
  qty: number;
  parentNo: string;
};

/** Every item_code on the source Delivery Order's lines. */
export function doItemCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  deliveryOrderId: string | null | undefined,
): Promise<ParentCodes> {
  return readParentCodes(sb, {
    table: 'delivery_order_items',
    select: 'item_code',
    codeColumn: 'item_code',
    parentColumn: 'delivery_order_id',
    parentId: deliveryOrderId,
  });
}

/** Every material_code on the source GRN's lines. */
export function grnMaterialCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  grnId: string | null | undefined,
): Promise<ParentCodes> {
  return readParentCodes(sb, {
    table: 'grn_items',
    select: 'material_code',
    codeColumn: 'material_code',
    parentColumn: 'grn_id',
    parentId: grnId,
  });
}

/**
 * Shared driver. `codesOf` supplies the parent document's item codes; the rest
 * is the same predicate all four chains use.
 *
 * `parentLabel` is cosmetic — it only has to be non-empty for the predicate to
 * engage, so the id is an acceptable last resort. It must never fall back to
 * empty, or a missing parent would silently read as "allowed".
 */
async function findUnlinked(
  parentId: string | null | undefined,
  parentLabel: string | null | undefined,
  lines: UnlinkedCandidate[],
  codesOf: () => Promise<ParentCodes>,
): Promise<UnlinkedScan<UnlinkedReturnOffender>> {
  if (!String(parentId ?? '').trim()) return { ok: true, offenders: [] };
  // nothing unlinked — skip the read
  if (!lines.some((l) => !l.soItemId)) return { ok: true, offenders: [] };
  const label = String(parentLabel ?? '').trim() || String(parentId);
  const codes = await codesOf();
  if (!codes.ok) return codes;
  return {
    ok: true,
    offenders: findUnlinkedSoItemLines(label, lines, codes.codes).map((o) => ({
      lineRef: o.lineRef, itemCode: o.itemCode, qty: o.qty, parentNo: label,
    })),
  };
}

export function findUnlinkedDrLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  deliveryOrderId: string | null | undefined,
  doNumber: string | null | undefined,
  lines: UnlinkedCandidate[],
): Promise<UnlinkedScan<UnlinkedReturnOffender>> {
  return findUnlinked(deliveryOrderId, doNumber, lines, () => doItemCodesOf(sb, deliveryOrderId));
}

export function findUnlinkedPrLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  grnId: string | null | undefined,
  grnNumber: string | null | undefined,
  lines: UnlinkedCandidate[],
): Promise<UnlinkedScan<UnlinkedReturnOffender>> {
  return findUnlinked(grnId, grnNumber, lines, () => grnMaterialCodesOf(sb, grnId));
}

export function unlinkedReturnResponse(
  offenders: UnlinkedReturnOffender[],
  kind: 'delivery' | 'purchase',
) {
  const parent = offenders[0]?.parentNo ?? '';
  const list = [...new Set(offenders.map((o) => o.itemCode))].join(', ');
  const source = kind === 'delivery' ? 'Delivery Order' : 'Goods Receipt';
  const picker = kind === 'delivery' ? 'the Delivery Order' : 'the Goods Receipt';
  return {
    error: kind === 'delivery' ? 'unlinked_do_lines' : 'unlinked_grn_lines',
    message:
      `This return names ${source} ${parent}, but ${offenders.length} line(s) are not linked to it: ${list}. ` +
      `Pick those items from ${picker} instead of adding them by hand — an unlinked line still moves the ` +
      `stock but counts against no line of the source document, so the same goods can be returned again.`,
    parentNo: parent,
    offenders,
  };
}
