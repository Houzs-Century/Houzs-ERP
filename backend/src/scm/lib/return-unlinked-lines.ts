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

import { findUnlinkedSoItemLines, itemCodeKey, type UnlinkedCandidate } from './do-unlinked-so-lines';

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

/**
 * Every material_code on a SET of receipts, WITH THE ERROR BOUND, and each code
 * mapped to the receipt number that carries it.
 *
 * Two things this shape buys, both of which the single-GRN version could not:
 *
 *  1. **A set, not one id.** A purchase invoice is line-level multi-receipt by
 *     design (owner 2026-08-06, migration 0267): one supplier invoice may bill
 *     several goods-received notes, and `purchase_invoices.grn_id` is only the
 *     PRIMARY ref — `/from-grn-items` stamps `bucket.grnIds[0]` under a comment
 *     saying so. A guard that reads only the header ref is blind to every other
 *     note the invoice covers, which is the same double-bill it was written to
 *     stop, one note over.
 *  2. **The error, bound.** `const { data } = await …` cannot tell "the query
 *     failed" from "this receipt has no lines", and an empty code set is an
 *     unconditional PASS (`do-unlinked-so-lines.ts:85`). So a statement timeout
 *     silently opened the door. That is the same fail-open `piLocked` in
 *     purchase-invoices.ts was fixed for, in its words: *"A failed read must
 *     never read as an absence when the absence is what authorises the write."*
 */
export async function readGrnMaterialCodes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  grnIds: Array<string | null | undefined>,
): Promise<{ codeToReceipt: Map<string, string>; error: string | null }> {
  const ids = [...new Set(grnIds.map((x) => String(x ?? '').trim()).filter(Boolean))];
  const codeToReceipt = new Map<string, string>();
  if (ids.length === 0) return { codeToReceipt, error: null };
  /* The receipt NUMBER rides the same read. Without it the refusal named the
     receipt by raw uuid — the operator was told which invoice was wrong but not
     which document to go and look at, and no client sends `grnNumber` on create.
     The `grn:grns!inner (…)` embed is the form this router already uses at the
     over-invoice guard, so it is not a new shape. */
  const { data, error } = await sb
    .from('grn_items')
    .select('material_code, grn_id, grn:grns!inner ( grn_number )')
    .in('grn_id', ids);
  if (error) return { codeToReceipt, error: String(error.message ?? error) };
  type Row = {
    material_code: string | null; grn_id: string | null;
    grn?: { grn_number?: string | null } | Array<{ grn_number?: string | null }> | null;
  };
  /* Sorted by receipt number so a code carried by two of the covered notes always
     names the SAME one — a refusal that alternated between two receipts run to run
     would read as a flaky guard. */
  const rows = ((data ?? []) as Row[]).slice().sort((a, b) => {
    const na = (Array.isArray(a.grn) ? a.grn[0] : a.grn)?.grn_number ?? '';
    const nb = (Array.isArray(b.grn) ? b.grn[0] : b.grn)?.grn_number ?? '';
    return String(na).localeCompare(String(nb));
  });
  for (const r of rows) {
    const k = itemCodeKey(r.material_code);
    if (!k || codeToReceipt.has(k)) continue;
    const parent = Array.isArray(r.grn) ? r.grn[0] : r.grn;
    codeToReceipt.set(k, String(parent?.grn_number ?? r.grn_id ?? '').trim() || String(r.grn_id ?? ''));
  }
  return { codeToReceipt, error: null };
}

/** Every material_code on the source GRN's lines.
 *
 *  The single-receipt, error-DROPPING view, kept because the Purchase Return and
 *  Delivery Return chains behave exactly this way today and changing them is a
 *  separate decision about a STOCK guard. The money chain does not use it — see
 *  `findUnlinkedPiLines`. */
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
 * refused only when the material is ALREADY ON one of the receipts this invoice
 * covers. A freight line, a service charge, or a part none of those receipts
 * contained still passes untouched — which is the property that lets this ship
 * without breaking PI-native lines.
 *
 * TWO WAYS IT DIFFERS FROM ITS FIVE SIBLINGS, both because this is the money one.
 *
 * **It takes a SET of receipts, not one.** A purchase invoice is line-level
 * multi-receipt by design; the header's `grn_id` is the PRIMARY ref only. Passing
 * just the header ref let an unlinked goods line billing a SECONDARY note's
 * material through — the exact refused shape, one note over. Callers therefore
 * hand in the header ref UNION every receipt reachable through the invoice's own
 * linked lines (`purchase_invoice_items.grn_item_id -> grn_items.grn_id`), which
 * is the walk `purchase-invoices.ts` already does twice for READS.
 *
 * **It FAILS CLOSED.** The answer is a result, not a bare array: an empty code
 * set is an unconditional pass, so a swallowed read error opened the door
 * silently. `{ ok: false }` means the caller must refuse the write, not proceed.
 */
export type PiUnlinkedVerdict =
  /** The check could not be performed. The caller must NOT write. */
  | { ok: false; reason: string }
  | { ok: true; offenders: UnlinkedReturnOffender[] };

export async function findUnlinkedPiLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  /** Every receipt this invoice covers: the header ref plus the ones its linked
   *  lines descend from. Nulls and duplicates are fine — they are dropped. */
  grnIds: Array<string | null | undefined>,
  lines: UnlinkedCandidate[],
): Promise<PiUnlinkedVerdict> {
  const ids = [...new Set(grnIds.map((x) => String(x ?? '').trim()).filter(Boolean))];
  // The header names no receipt -> there is nothing to bypass. Same carve-out as
  // all five siblings, and the reason a PI-native invoice still works.
  if (ids.length === 0) return { ok: true, offenders: [] };
  // Nothing unlinked -> the cap already sees every line. Skip the read.
  if (!lines.some((l) => !l.soItemId)) return { ok: true, offenders: [] };

  const { codeToReceipt, error } = await readGrnMaterialCodes(sb, ids);
  if (error) return { ok: false, reason: error };

  /* The PREDICATE is the shared one — one definition of "the same item" across all
     six chains. It is applied per receipt so each offender names the receipt that
     actually carries its material, which is the document the operator has to open. */
  const offenders: UnlinkedReturnOffender[] = [];
  const byReceipt = new Map<string, Set<string>>();
  for (const [code, receipt] of codeToReceipt) {
    const s = byReceipt.get(receipt) ?? new Set<string>();
    s.add(code);
    byReceipt.set(receipt, s);
  }
  const claimed = new Set<string>();
  for (const [receipt, codes] of byReceipt) {
    for (const o of findUnlinkedSoItemLines(receipt, lines, codes)) {
      if (claimed.has(o.lineRef)) continue;   // already named by an earlier receipt
      claimed.add(o.lineRef);
      offenders.push({ lineRef: o.lineRef, itemCode: o.itemCode, qty: o.qty, parentNo: receipt });
    }
  }
  return { ok: true, offenders };
}

/** The 500 body for a guard that could not run. Its own refusal, because "we
 *  could not check" and "there is nothing to find" are opposite facts and only
 *  one of them authorises billing the supplier. */
export function unlinkedCheckFailedResponse(reason: string) {
  return {
    error: 'unlinked_check_failed',
    message: 'Could not check whether any line bills goods the named Goods Receipt already '
      + 'contains, so this invoice was NOT saved — the same goods could otherwise be paid for '
      + `twice. Please try again (${reason}).`,
    reason,
  };
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
 *  stock: the operator has to understand that the goods get PAID FOR twice.
 *
 *  TWO CORRECTIONS TO THE FIRST DRAFT OF THIS MESSAGE, both because a refusal that
 *  misdirects is worse than a terse one:
 *
 *  · It used to say *"Pick those items from the Goods Receipt instead of adding
 *    them by hand"* — on the screen where this fires most, the invoice DETAIL
 *    editor, there is no receipt-line picker at all and its add payload cannot
 *    carry a `grnItemId` (`PurchaseInvoiceDetail.tsx`: *"New free-entry line —
 *    full insert payload (grnItemId null)"*). A correctly-refused operator was
 *    dead-ended, and the way out of a dead end is to retype the code until it
 *    stops matching, which is the double-bill itself. It now names the route that
 *    exists: raise the invoice FROM the receipt, or delete the hand-typed line.
 *  · It used to promise a freight or service line was *"unaffected"*, full stop.
 *    A GRN can carry its own service line (`grns.ts` splits a receipt's freight
 *    pool across its goods lines), and when it does, a hand-added duplicate of
 *    THAT line is refused — correctly. The promise is now qualified.
 *
 *  Each offender names the receipt that actually carries its material, which for
 *  a multi-note invoice is not necessarily the header's primary ref. */
export function unlinkedInvoiceResponse(offenders: UnlinkedReturnOffender[]) {
  const parent = offenders[0]?.parentNo ?? '';
  const receipts = [...new Set(offenders.map((o) => o.parentNo).filter(Boolean))];
  const list = [...new Set(offenders.map((o) => o.itemCode))].join(', ');
  const where = receipts.length <= 1
    ? `Goods Receipt ${parent}`
    : `these Goods Receipts: ${receipts.join(', ')}`;
  return {
    error: 'unlinked_grn_lines',
    message:
      `${offenders.length} line(s) on this invoice bill an item that is already on ${where}, ` +
      `without being linked to it: ${list}. An unlinked line still bills the supplier but ticks ` +
      `nothing off the receipt, so the same goods can be invoiced and paid for a second time. ` +
      `Raise the invoice from that receipt (Goods Receipt -> Transfer to Purchase Invoice) so each ` +
      `line is linked, or remove the hand-typed line. Any item those receipts do NOT contain — ` +
      `including a freight or service charge they do not carry — is unaffected.`,
    parentNo: parent,
    receipts,
    offenders,
  };
}
