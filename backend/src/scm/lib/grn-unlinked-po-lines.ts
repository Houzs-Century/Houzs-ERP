// ----------------------------------------------------------------------------
// grn-unlinked-po-lines — the receiving side of the same back door.
//
// Owner, 2026-08-04, after the delivery-side duplicate was confirmed: "包括 GR
// 那边也是". He is right, and the shape is identical:
//
//   scm.grns.purchase_order_id            names a PO
//   scm.grn_items.purchase_order_item_id  is NULLABLE
//
// A GRN line with no purchase_order_item_id still writes the inventory IN —
// postGrnAndRollup moves stock from the GRN's own lines — but it feeds no PO
// line's received_qty rollup, so the over-receipt guard cannot see it. The
// manual New-GRN path says so itself: "Lines with no purchase_order_item_id
// (free / manual receipts) are uncapped."
//
// Uncapped is correct for a genuinely free receipt — a sample, a supplier
// freebie, stock found on the floor. It is not correct for receiving a PO's OWN
// material without ticking that PO line off, which lets the same delivery be
// received twice and the stock go up twice.
//
// SAME RULE AS THE DELIVERY SIDE (do-unlinked-so-lines), and deliberately so —
// one definition of "the same item", one shape of refusal:
//
//   header names no PO             -> nothing to bypass, allowed (unchanged)
//   material is NOT on the named PO -> genuinely free receipt, allowed (unchanged)
//   material IS on the named PO     -> REFUSED: link it, and tick the qty off
//
// The pure predicate lives in do-unlinked-so-lines and is shared; only the
// vocabulary and the lookup differ.
// ----------------------------------------------------------------------------

import { findUnlinkedSoItemLines, type UnlinkedCandidate } from './do-unlinked-so-lines';

export type UnlinkedPoOffender = {
  lineRef: string;
  materialCode: string;
  qty: number;
  poNumber: string;
};

/** Every material_code the named Purchase Order orders. Empty when the GRN has
 *  no parent PO, which is the legitimate free-receipt case. */
export async function poMaterialCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  purchaseOrderId: string | null | undefined,
): Promise<Set<string>> {
  const id = String(purchaseOrderId ?? '').trim();
  if (!id) return new Set();
  const { data } = await sb
    .from('purchase_order_items')
    .select('material_code')
    .eq('purchase_order_id', id);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ material_code: string | null }>) {
    const k = String(r.material_code ?? '').trim().toUpperCase();
    if (k) out.add(k);
  }
  return out;
}

/**
 * Which posted GRN lines receive one of the named PO's own materials while
 * carrying no purchase_order_item_id?
 *
 * `poNumber` is carried only for the message — the lookup is by id, because the
 * GRN header holds a real foreign key rather than the free text the delivery
 * side has to live with.
 */
export async function findUnlinkedPoLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  purchaseOrderId: string | null | undefined,
  poNumber: string | null | undefined,
  lines: UnlinkedCandidate[],
): Promise<UnlinkedPoOffender[]> {
  if (!String(purchaseOrderId ?? '').trim()) return [];
  if (!lines.some((l) => !l.soItemId)) return [];   // nothing unlinked — skip the read

  /* The number is fetched only on this path, and only when a line is actually
     unlinked — a receipt whose lines are all linked pays for neither query. */
  const [codes, fetchedNo] = await Promise.all([
    poMaterialCodesOf(sb, purchaseOrderId),
    String(poNumber ?? '').trim()
      ? Promise.resolve(String(poNumber).trim())
      : sb.from('purchase_orders').select('po_number').eq('id', purchaseOrderId).maybeSingle()
          .then((r: { data?: { po_number?: string | null } | null }) => r?.data?.po_number ?? ''),
  ]);
  /* The parent label must be non-empty for the shared predicate to engage; the
     id is the last resort so a missing PO row never turns into "allowed". */
  const label = String(fetchedNo ?? '').trim() || String(purchaseOrderId);
  return findUnlinkedSoItemLines(label, lines, codes).map((o) => ({
    lineRef: o.lineRef,
    materialCode: o.itemCode,
    qty: o.qty,
    poNumber: label,
  }));
}

export function unlinkedPoLinesResponse(offenders: UnlinkedPoOffender[]) {
  const po = offenders[0]?.poNumber ?? '';
  const list = [...new Set(offenders.map((o) => o.materialCode))].join(', ');
  return {
    error: 'unlinked_po_lines',
    message:
      `This receipt names Purchase Order ${po}, but ${offenders.length} line(s) are not linked to it: ${list}. ` +
      `Pick those materials from the Purchase Order instead of adding them by hand — an unlinked line still ` +
      `takes the stock in but ticks nothing off the order, so the same delivery can be received again.`,
    poNumber: po,
    offenders,
  };
}
