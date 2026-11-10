/* do-return-lot-repair — the PURE half of repair-do-resync-return-lots.mjs.
 *
 * A shipped-DO edit that gave units back (resyncInventoryForDo) used to fall back
 * to a plain IN whenever scm.fn_return_do_units_at_cost failed, and it failed on
 * every call until 2026-11-10. The FIFO trigger turned each such IN into a new
 * lot sourced from the DO (no GRN, no PO) while the lot that really paid stayed
 * consumed. The repair does what the function would have done: unwind the DO's
 * consumptions of that bucket newest-first up to the IN's qty, give each unit back
 * to its own lot, and close the lot the IN minted.
 */

/** The exact notes the old route fallback wrote. The SQL function appends
 *  " Original lots restored ..." and the repair appends its own marker, so an
 *  IN with exactly this text is one that never went through either. */
export const FALLBACK_NOTES = 'Resync: line qty reduced / line deleted (shipped DO).';
export const REPAIR_MARK = ' [repair 2026-11-10: units returned to their original lots; this lot closed]';

/**
 * Why an IN must be left alone, or null when it can be repaired.
 * @param {{ notes: string|null, lot_id: string|null, qty_received: number|null, qty_remaining: number|null, lot_used: number, unstamped_lines: number }} c
 */
export function skipReason(c) {
  if ((c.notes ?? '') !== FALLBACK_NOTES) return 'not a fallback return (notes differ)';
  if (!c.lot_id) return 'no lot behind this IN';
  if (Number(c.qty_remaining) <= 0) return 'its lot is already closed (cancel or an earlier repair)';
  if (Number(c.qty_remaining) !== Number(c.qty_received) || Number(c.lot_used) > 0) {
    return 'another document already drew on its lot; the trace follows it back instead (classifyLots)';
  }
  /* The DO's old consumption is the only evidence of which PO those units came
     from until the line is stamped. Restoring it first would lose that for good. */
  if (Number(c.unstamped_lines) > 0) return 'the DO line for this item is not stamped yet: run stamp-do-shipped-from.mjs first';
  return null;
}

/**
 * Which consumptions to give back, newest first, for `qty` units.
 * @param {Array<{ id: string, lot_id: string, qty_consumed: number, unit_cost_sen: number|null }>} consumptions  newest first
 * @param {number} qty
 * @returns {{ steps: Array<{ id: string, lot_id: string, take: number, remove: boolean, left: number, unit_cost_sen: number }>, restored: number, uncosted: number }}
 */
export function unwindPlan(consumptions, qty) {
  let need = Math.max(0, Number(qty) || 0);
  const steps = [];
  for (const c of consumptions) {
    if (need <= 0) break;
    const have = Number(c.qty_consumed) || 0;
    const take = Math.min(need, have);
    if (take <= 0) continue;
    steps.push({ id: c.id, lot_id: c.lot_id, take, remove: take >= have, left: have - take, unit_cost_sen: Number(c.unit_cost_sen) || 0 });
    need -= take;
  }
  const restored = steps.reduce((s, x) => s + x.take, 0);
  return { steps, restored, uncosted: Math.max(0, Number(qty) - restored) };
}
