// The decision half of repair-hc0106-stale-po-received.mjs, kept free of the
// database so it can be tested on the real production rows.
//
// The rule is grns.ts recomputePoReceived, restated: a PO line's received_qty
// is Σ greatest(0, qty_accepted − returned_qty) over the GRN lines that point at
// it, on a GRN that is NOT DRAFT / CANCELLED. A PO's status follows from its
// lines: every line received in full = RECEIVED, any received = PARTIALLY_RECEIVED,
// none = SUBMITTED. CANCELLED and ON_HOLD are never re-derived.

const DEAD_GRN = new Set(['DRAFT', 'CANCELLED']);

export const isLiveGrnStatus = (status) => !DEAD_GRN.has(String(status ?? '').toUpperCase());

/** Live received qty per PO line from its GRN lines. */
export function liveReceivedByPoLine(grnLines) {
  const out = new Map();
  for (const l of grnLines) {
    if (!out.has(l.poItemId)) out.set(l.poItemId, 0);
    if (!isLiveGrnStatus(l.grnStatus)) continue;
    const net = Math.max(0, Number(l.qtyAccepted ?? 0) - Number(l.returnedQty ?? 0));
    out.set(l.poItemId, out.get(l.poItemId) + net);
  }
  return out;
}

/**
 * The PO lines this repair may correct, and what they become.
 *
 * A line qualifies only when ALL of these hold:
 *  - its PO is not an AutoCount cutover order (`linkedAcDocno` null): those
 *    received through AutoCount with no ERP GRN behind them, so a recount from
 *    GRNs would wipe a real receipt;
 *  - at least one DRAFT / CANCELLED GRN line points at it: the BUG-64 shape,
 *    a voided receipt whose count never came off;
 *  - it reports MORE than its live GRNs received. Under-reporting is a
 *    different fault and is left alone.
 */
export function planStaleReceived(poLines, grnLines) {
  const live = liveReceivedByPoLine(grnLines);
  const deadByLine = new Map();
  for (const l of grnLines) {
    if (isLiveGrnStatus(l.grnStatus)) continue;
    if (!deadByLine.has(l.poItemId)) deadByLine.set(l.poItemId, []);
    deadByLine.get(l.poItemId).push(`${l.grnNumber} ${String(l.grnStatus).toUpperCase()}`);
  }
  const fixes = [];
  for (const p of poLines) {
    if (p.linkedAcDocno) continue;
    if (String(p.poStatus ?? '').toUpperCase() === 'CANCELLED') continue;
    const dead = deadByLine.get(p.poItemId);
    if (!dead || dead.length === 0) continue;
    const now = Number(p.receivedQty ?? 0);
    const want = live.get(p.poItemId) ?? 0;
    if (now <= want) continue;
    fixes.push({ ...p, receivedQty: now, newReceivedQty: want, deadGrns: dead });
  }
  return fixes;
}

/** A PO's status from its lines, or null when this writer must not touch it. */
export function poStatusFromLines(currentStatus, lines) {
  const cur = String(currentStatus ?? '').toUpperCase();
  if (cur === 'CANCELLED' || cur === 'ON_HOLD') return null;
  if (lines.length === 0) return null;
  const fully = lines.every((l) => Number(l.receivedQty ?? 0) >= Number(l.qty ?? 0));
  const any = lines.some((l) => Number(l.receivedQty ?? 0) > 0);
  return fully ? 'RECEIVED' : any ? 'PARTIALLY_RECEIVED' : 'SUBMITTED';
}

/** Each touched PO's status move once `fixes` land. `pos` is PO id ->
 *  { status, lines: [{ poItemId, qty, receivedQty }] } as read now. */
export function planPoStatuses(fixes, pos) {
  const newQtyById = new Map(fixes.map((f) => [f.poItemId, f.newReceivedQty]));
  return [...new Set(fixes.map((f) => f.poId))].map((poId) => {
    const p = pos.get(poId);
    const after = p.lines.map((l) => ({ ...l, receivedQty: newQtyById.get(l.poItemId) ?? l.receivedQty }));
    return { poId, from: p.status, to: poStatusFromLines(p.status, after), fully: after.every((l) => l.receivedQty >= l.qty) };
  });
}
