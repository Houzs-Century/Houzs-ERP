// The decision half of repair-repair-return-received.mjs, kept free of the
// database so it can be tested on the real production rows.
//
// adjustGrnReturnedQty (routes/purchase-returns.ts) now counts only CREDIT
// returns: a GRN line's returned_qty is Σ qty_returned over its lines on a
// non-cancelled CREDIT return, clamped to [0, qty_accepted]. Before the fix a
// REPAIR return counted too, which re-opened the PO while the goods sat in the
// repair warehouse. This restates that rule for the lines it left behind, then
// recounts each touched PO line with recomputePoReceived's rule.

import { liveReceivedByPoLine } from './po-received-recount.mjs';

/** GRN lines whose returned_qty differs from the CREDIT-only recount.
 *  `prLines`: [{ grnItemId, qtyReturned, prKind, prStatus }] for every return
 *  line on the candidate GRN lines; `grnLines`: [{ grnItemId, qtyAccepted, returnedQty, ... }]. */
export function planReturnedQty(grnLines, prLines) {
  const credit = new Map();
  for (const l of prLines) {
    if (String(l.prStatus ?? '').toUpperCase() === 'CANCELLED') continue;
    if (l.prKind === 'REPAIR') continue;
    credit.set(l.grnItemId, (credit.get(l.grnItemId) ?? 0) + Number(l.qtyReturned ?? 0));
  }
  const fixes = [];
  for (const g of grnLines) {
    const want = Math.min(Number(g.qtyAccepted ?? 0), Math.max(0, credit.get(g.grnItemId) ?? 0));
    if (Number(g.returnedQty ?? 0) !== want) fixes.push({ ...g, newReturnedQty: want });
  }
  return fixes;
}

/** PO lines whose received_qty differs once `grnFixes` land. `poLines` and
 *  `allGrnLines` are every line on the touched PO lines. AutoCount cutover
 *  POs and cancelled POs are left alone, as in planStaleReceived. */
export function planPoReceived(poLines, allGrnLines, grnFixes) {
  const newReturned = new Map(grnFixes.map((f) => [f.grnItemId, f.newReturnedQty]));
  const after = allGrnLines.map((g) => ({ ...g, returnedQty: newReturned.get(g.grnItemId) ?? g.returnedQty }));
  const live = liveReceivedByPoLine(after);
  const fixes = [];
  for (const p of poLines) {
    if (p.linkedAcDocno) continue;
    if (String(p.poStatus ?? '').toUpperCase() === 'CANCELLED') continue;
    const want = live.get(p.poItemId) ?? 0;
    if (Number(p.receivedQty ?? 0) !== want) fixes.push({ ...p, newReceivedQty: want });
  }
  return fixes;
}
