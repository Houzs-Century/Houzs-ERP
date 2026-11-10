/* hard-bound-cost-backfill — the pure half of backfill-hard-bound-cost.mjs.
 *
 * Owner decision A (2026-11-10): a company-1 hard-bound DO line is costed from
 * its bound PO's receipt. #5619 makes new shipments do that (the OUT carries
 * batch_no = the bound PO). This module plans the same for lines already
 * shipped, selected by the #5614 check's verdicts (analyseHardBoundOuts):
 *   uncosted        the OUT consumed no lot
 *   lot-po-unknown  costed from a lot that names no PO (cutover layer, stock take)
 *   other-po        costed from another PO's lot at a different cost
 *                   (verdict mismatch, ratio not 100%)
 *
 * THE RE-COST USES ONLY EXISTING MACHINERY. Per DO bucket (warehouse + item +
 * spec, un-batched): scm.fn_return_do_units_at_cost gives the units back to the
 * lots that paid (the resync's return), then one OUT with batch_no = the bound PO
 * is inserted and fn_inventory_movement_fifo costs it from that PO's lot, exactly
 * as a #5619 shipment is costed. restampDoActualCost + restampSiFromDo then copy
 * the cost onto the DO and SI lines. Nothing here computes a cost.
 *
 * A line is re-costed only when its bound PO's lot (same warehouse, item, spec)
 * holds the units, counting units the same run gives back to that lot from other
 * targets. Otherwise it is listed with the reason and left alone: a batched OUT
 * with no own lot would only fall back to plain FIFO again.
 *
 * Nothing here reads a database or prints money. */

export const BACKFILL_CONFIRM_PHRASE = 'RECOST HARD-BOUND LINES FROM THEIR BOUND PO';
export const BACKFILL_NOTE = 'Hard-bound cost backfill:';

export const SKIPS = [
  ['awaiting-cutover-revert', 'still costed from a lot of the 2026-11-10 cutover repair; run the revert, then plan again'],
  ['out-is-batched', 'the OUT already carries a batch (sofa dye lot, ship-before-arrival commitment, drop-ship)'],
  ['no-bound-po', 'no live received PO bound to the line'],
  ['several-bound-pos', 'more than one received PO bound to the line'],
  ['nothing-out', 'the un-batched bucket has no units out any more'],
  ['own-po-lot-not-available', 'the bound PO has no open lot here under this item + spec for these units'],
];

/** The class a census row is re-costed for, or null. */
export function targetClass(row) {
  if (!row.hardBound) return null;
  if (row.verdict === 'uncosted') return 'uncosted';
  if (row.verdict === 'lot-po-unknown') return 'lot-po-unknown';
  if (row.verdict === 'mismatch' && row.same === false) return 'other-po';
  return null;
}

export const bucketKeyOf = (r) => `${r.doId}\u0001${r.warehouseId}\u0001${r.itemCode}\u0001${r.vk}`;
export const groupKeyOf = (r) => `${r.warehouseId}\u0001${r.itemCode}\u0001${r.vk}`;

/**
 * Census rows -> one candidate per DO bucket, or a skip.
 * @param rows analyseHardBoundOuts rows (with warehouseId, outBatch, seq, outDate, costing[].lotDocNo / lotBatch)
 * @param repairDocNo the cutover repair's lot document number (lots the revert takes back)
 */
export function selectBuckets(rows, repairDocNo) {
  const byBucket = new Map();
  for (const r of rows) {
    const cls = targetClass(r);
    if (!cls) continue;
    const k = bucketKeyOf(r);
    const b = byBucket.get(k) ?? {
      key: k, doId: r.doId, doNo: r.doNo, warehouseId: r.warehouseId, wh: r.wh, itemCode: r.itemCode, vk: r.vk,
      classes: new Set(), boundPoNos: new Set(), outIds: [], outDate: r.outDate, batched: false, awaitingRevert: false,
    };
    b.classes.add(cls);
    for (const p of r.boundPoNos) b.boundPoNos.add(p);
    b.outIds.push(r.id);
    if (r.outDate < b.outDate) b.outDate = r.outDate;
    if (r.outBatch) b.batched = true;
    if (r.costing.some((c) => String(c.lotDocNo ?? '').startsWith(repairDocNo))) b.awaitingRevert = true;
    byBucket.set(k, b);
  }
  const out = [];
  for (const b of byBucket.values()) {
    const pos = [...b.boundPoNos].sort();
    let skip = null;
    if (b.awaitingRevert) skip = 'awaiting-cutover-revert';
    else if (b.batched) skip = 'out-is-batched';
    else if (pos.length === 0) skip = 'no-bound-po';
    else if (pos.length > 1) skip = 'several-bound-pos';
    out.push({ ...b, classes: [...b.classes].sort(), boundPo: pos.length === 1 ? pos[0] : null, skip });
  }
  return out.sort((a, b) => a.outDate.localeCompare(b.outDate) || a.doNo.localeCompare(b.doNo, undefined, { numeric: true }) || a.itemCode.localeCompare(b.itemCode));
}

/**
 * Decide, per (warehouse, item, spec) group, which candidates the bound PO's lot
 * can carry. Each candidate needs `netQty` units of its PO's lot; a candidate
 * that is re-costed also gives back `releases` (units per PO it currently holds
 * in this group's lots). Iterates to a fixed point: a candidate that cannot be
 * served gives nothing back, which may leave another short.
 * @param cands [{ key, boundPo, netQty, releases: Map<po, qty> }] in priority order
 * @param openByPo Map<po, open qty in this group> now
 * @returns Map<key, 'recost' | 'own-po-lot-not-available'>
 */
export function planGroup(cands, openByPo) {
  let serving = new Set(cands.map((c) => c.key));
  for (let round = 0; round <= cands.length; round++) {
    const avail = new Map(openByPo);
    for (const c of cands) {
      if (!serving.has(c.key)) continue;
      for (const [po, q] of c.releases) avail.set(po, (avail.get(po) ?? 0) + q);
    }
    const next = new Set();
    for (const c of cands) {
      if (!serving.has(c.key)) continue;
      const have = avail.get(c.boundPo) ?? 0;
      if (have >= c.netQty) { next.add(c.key); avail.set(c.boundPo, have - c.netQty); }
    }
    if (next.size === serving.size) break;
    serving = next;
  }
  return new Map(cands.map((c) => [c.key, serving.has(c.key) ? 'recost' : 'own-po-lot-not-available']));
}

/** Next correction numbers for a (DO, item, spec): the return's balancing IN and
 *  the new OUT each take their own slot in uq_inv_mov_do_source_v2, whose key
 *  has neither warehouse nor batch. */
export function nextSeqs(maxSeqByDoItem, doId, itemCode, vk) {
  const k = `${doId}\u0001${itemCode}\u0001${vk}`;
  const base = maxSeqByDoItem.get(k) ?? 0;
  maxSeqByDoItem.set(k, base + 2);
  return { returnSeq: base + 1, outSeq: base + 2 };
}

export const backfillNote = (po, classes) => `${BACKFILL_NOTE} re-costed from bound PO ${po} (was ${classes.join(', ')}).`;
export const returnNote = (po) => `${BACKFILL_NOTE} units returned to re-cost from bound PO ${po}.`;

/** A group's fingerprint: everything the apply re-reads under lock and must find
 *  unchanged. Counts and ids only. */
export function groupFingerprint({ buckets, openLots }) {
  const b = buckets.map((x) => `${x.key}|${x.netQty}|${[...x.consumed].sort().join(',')}`).sort();
  const l = openLots.map((x) => `${x.lotId}:${x.qty}`).sort();
  return `${b.join(';')}#${l.join(';')}`;
}

export function tallyBy(items, keyFn) {
  const m = new Map();
  for (const it of items) { const k = keyFn(it); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
