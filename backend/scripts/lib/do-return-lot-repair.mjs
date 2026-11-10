/* do-return-lot-repair — the PURE half of repair-do-resync-return-lots.mjs.
 *
 * A shipped-DO edit that gave units back (resyncInventoryForDo) used to fall back
 * to a plain IN whenever scm.fn_return_do_units_at_cost failed, and it failed on
 * every call until 2026-11-10 (#5589). The FIFO trigger turned each such IN into a
 * new lot sourced from the DO (no GRN, no PO) while the lot that really paid
 * stayed consumed.
 *
 * Owner decision 2026-11-10: the repair follows the ACTUAL stock. Most of these
 * INs came from a SPEC edit: the same edit (same DO, same correction_seq) also
 * wrote an OUT in the line's new spec bucket. One unit left the warehouse, once:
 *   - the new-spec OUT consumed a real lot -> that lot is what shipped; the old
 *     spec's consumption is given back to its own lot (2990-DO-2611-018: ships
 *     from GRN 2610-011, the GRN 2610-028 unit returns to the shelf);
 *   - the new-spec OUT consumed NOTHING (no stock carries the new spec) -> the
 *     old spec's consumption is what shipped, so it is moved onto that OUT
 *     (2990-DO-2611-016: stays shipped from GRN 2611-010, and the uncosted OUT
 *     is reconciled instead of leaving a phantom unit on the shelf).
 * Either way the PO-less lot the IN minted is closed.
 */

/** The exact notes the old route fallback wrote. The SQL function appends
 *  " Original lots restored ..." and the repair appends its own marker, so an
 *  IN with exactly this text is one that never went through either. */
export const FALLBACK_NOTES = 'Resync: line qty reduced / line deleted (shipped DO).';
export const REPAIR_MARK = ' [repair 2026-11-10: units put back where they really came from; this lot closed]';

/**
 * Why an IN must be left alone, or null when it can be repaired.
 * @param {{ notes: string|null, lot_id: string|null, qty_received: number|null, qty_remaining: number|null, lot_used: number }} c
 */
export function skipReason(c) {
  if ((c.notes ?? '') !== FALLBACK_NOTES) return 'not a fallback return (notes differ)';
  if (!c.lot_id) return 'no lot behind this IN';
  if (Number(c.qty_remaining) <= 0) return 'its lot is already closed (cancel or an earlier repair)';
  if (Number(c.qty_remaining) !== Number(c.qty_received) || Number(c.lot_used) > 0) {
    return 'another document already drew on its lot; the trace follows it back instead (classifyLots)';
  }
  return null;
}

/**
 * What to do with the IN's units.
 * @param {Array<{ id: string, lot_id: string, qty_consumed: number }>} consumptions  the DO's consumptions of the IN's (old) bucket, newest first
 * @param {Array<{ id: string, variant_key: string, qty: number, consumed: number }>} siblingOuts  OUTs of the same edit (same DO, correction_seq, warehouse, item, batch) in another bucket
 * @param {number} qty  the IN's qty
 * @returns {{ move: Array<{ id: string, lot_id: string, take: number, to_out: string, to_vk: string }>,
 *             restore: Array<{ id: string, lot_id: string, take: number }>, uncosted: number }}
 *   move: the consumption is what really shipped under the new spec -> re-point it to that OUT;
 *   restore: the unit came back to the shelf -> give it to its own lot;
 *   uncosted: units with no consumption behind them (nothing to move or give back).
 */
export function planActual(consumptions, siblingOuts, qty) {
  const room = siblingOuts.map((o) => ({ ...o, free: Math.max(0, Number(o.qty) - Number(o.consumed)) }));
  let need = Math.max(0, Number(qty) || 0);
  const move = [];
  const restore = [];
  for (const c of consumptions) {
    if (need <= 0) break;
    let have = Math.min(Number(c.qty_consumed) || 0, need);
    let used = 0;
    for (const o of room) {
      if (have <= 0) break;
      const n = Math.min(o.free, have);
      if (n <= 0) continue;
      o.free -= n;
      have -= n;
      used += n;
      move.push({ id: c.id, lot_id: c.lot_id, take: n, to_out: o.id, to_vk: o.variant_key });
    }
    if (have > 0) restore.push({ id: c.id, lot_id: c.lot_id, take: have });
    need -= used + have;
  }
  return { move, restore, uncosted: need };
}
