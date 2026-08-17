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

import { findUnlinkedSoItemLines, type UnlinkedCandidate } from './do-unlinked-so-lines';

export type UnlinkedReturnOffender = {
  lineRef: string;
  itemCode: string;
  qty: number;
  parentNo: string;
};

/** Every item_code on the source Delivery Order's lines. */
export async function doItemCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  deliveryOrderId: string | null | undefined,
): Promise<Set<string>> {
  const id = String(deliveryOrderId ?? '').trim();
  if (!id) return new Set();
  const { data } = await sb
    .from('delivery_order_items')
    .select('item_code')
    .eq('delivery_order_id', id);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ item_code: string | null }>) {
    const k = String(r.item_code ?? '').trim().toUpperCase();
    if (k) out.add(k);
  }
  return out;
}

/** Every material_code on the source GRN's lines. */
export async function grnMaterialCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  grnId: string | null | undefined,
): Promise<Set<string>> {
  const id = String(grnId ?? '').trim();
  if (!id) return new Set();
  const { data } = await sb
    .from('grn_items')
    .select('material_code')
    .eq('grn_id', id);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ material_code: string | null }>) {
    const k = String(r.material_code ?? '').trim().toUpperCase();
    if (k) out.add(k);
  }
  return out;
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
  codesOf: () => Promise<Set<string>>,
): Promise<UnlinkedReturnOffender[]> {
  if (!String(parentId ?? '').trim()) return [];
  if (!lines.some((l) => !l.soItemId)) return [];   // nothing unlinked — skip the read
  const label = String(parentLabel ?? '').trim() || String(parentId);
  return findUnlinkedSoItemLines(label, lines, await codesOf()).map((o) => ({
    lineRef: o.lineRef, itemCode: o.itemCode, qty: o.qty, parentNo: label,
  }));
}

export function findUnlinkedDrLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  deliveryOrderId: string | null | undefined,
  doNumber: string | null | undefined,
  lines: UnlinkedCandidate[],
): Promise<UnlinkedReturnOffender[]> {
  return findUnlinked(deliveryOrderId, doNumber, lines, () => doItemCodesOf(sb, deliveryOrderId));
}

export function findUnlinkedPrLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  grnId: string | null | undefined,
  grnNumber: string | null | undefined,
  lines: UnlinkedCandidate[],
): Promise<UnlinkedReturnOffender[]> {
  return findUnlinked(grnId, grnNumber, lines, () => grnMaterialCodesOf(sb, grnId));
}

/**
 * The SIXTH chain, and the last one on this door — GRN -> Purchase INVOICE.
 *
 * *Added 2026-08-17.* Five chains closed this back door; the invoicing side of
 * the receiving chain never did. The owner's 2026-08-04 instruction was
 * "包括 GR 那边也是" — including the GR side — and the receipt half
 * (`grn-unlinked-po-lines.ts`) was built then while the BILLING half was not.
 * `sales-invoices.ts` describes the identical vector on its own chain and blocks
 * it; `purchase-invoices.ts` contained the word "unlinked" zero times.
 *
 * THE VECTOR, and why the money version is worse than the stock version.
 * `scm.purchase_invoices.grn_id` names a GRN; `purchase_invoice_items.grn_item_id`
 * is nullable — legitimately, because that is how a PI-native line (freight, a
 * service charge, a discount) is represented. Every cap and every recount in
 * `purchase-invoices.ts` filters NULL links out FIRST, which is correct for a
 * service line and catastrophic for a hand-added GOODS line: it bills the
 * material, `grn_items.invoiced_qty` never moves, the GRN line still reads fully
 * outstanding, and a second Purchase Invoice bills the same receipt. Both post to
 * AP and both enqueue to AutoCount, so the supplier is paid twice for one
 * delivery.
 *
 * The rule is the same narrow one as the other five, and deliberately so:
 * refused only when the material is ALREADY ON the GRN the invoice names. A
 * freight line, a service charge, or a part that receipt never contained still
 * passes untouched — which is the property that lets this ship without breaking
 * PI-native lines.
 */
export function findUnlinkedPiLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  grnId: string | null | undefined,
  grnNumber: string | null | undefined,
  lines: UnlinkedCandidate[],
): Promise<UnlinkedReturnOffender[]> {
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

/** The invoice refusal. Its own wording because the consequence is MONEY, not
 *  stock: the operator has to understand that the goods get PAID FOR twice. */
export function unlinkedInvoiceResponse(offenders: UnlinkedReturnOffender[]) {
  const parent = offenders[0]?.parentNo ?? '';
  const list = [...new Set(offenders.map((o) => o.itemCode))].join(', ');
  return {
    error: 'unlinked_grn_lines',
    message:
      `This invoice names Goods Receipt ${parent}, but ${offenders.length} line(s) bill an item that is ` +
      `on that receipt without being linked to it: ${list}. Pick those items from the Goods Receipt ` +
      `instead of adding them by hand — an unlinked line still bills the supplier but ticks nothing off ` +
      `the receipt, so the same goods can be invoiced and paid for a second time. A freight or service ` +
      `line, or any item this receipt does not contain, is unaffected.`,
    parentNo: parent,
    offenders,
  };
}
