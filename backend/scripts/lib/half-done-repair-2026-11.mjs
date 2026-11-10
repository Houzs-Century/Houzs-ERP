/* half-done-repair-2026-11 — the PURE half of repair-half-done-documents-2026-11.mjs.
 *
 * check-half-done-documents.mjs (run 42808054032, company 1) found four
 * documents whose stock movements do not match their posted lines. The
 * investigation (runs 42824682129, 42825512713) showed they are FOUR SEPARATE
 * stories, in two warehouses, on different specs and different SO / PO chains,
 * so none of them cancels another out:
 *
 *   HC-GRN-2609-118  PG, 8030-2A(LHF) "bo315-05 / 28 / 6in", PO HC-PO-010044,
 *                    SO HC-SO-010676. The line was posted with the GRN on
 *                    2026-09-22 and its IN never written (the line added on
 *                    09-26 did get one). DO HC-DO-2610-329 then shipped that
 *                    unit: its OUT found no lot, so it is uncosted and the
 *                    bucket stands at movements -1, lots 0.
 *                    -> kind GRN_IN_MISSING_SHIP_UNCOSTED.
 *   HC-GRN-2610-045  KL, 8030-1A(LHF) and 8030-2A(RHF) "hi-01 / 30 / default",
 *                    PO HC-PO-2609-225, SO HC-SO-2609-179. Posted, cancelled
 *                    (the IN reversed), then posted again from DRAFT; the second
 *                    post wrote no IN because the post guard counts IN rows and
 *                    found the cancelled one. 30 minutes later a lot with no
 *                    movement behind it (source ADJUSTMENT, batch the same PO)
 *                    appeared per item, and DO HC-DO-2610-343 shipped from it.
 *                    Lots are right (0); movements are -1 per bucket.
 *                    -> kind GRN_IN_LOST_ON_REPOST.
 *   HC-DO-2610-319   KL, Confirmed (LOADED) since 2026-10-22, no OUT at all.
 *                    Its 3 sofa pieces (batch HC-PO-010145 from GRN
 *                    HC-GRN-2610-030) and 2 pillows are still open lots.
 *                    -> kind DO_OUT_MISSING.
 *   HC-DO-2610-419   KL, cancelled. ELEPHANE-(K): OUT 1, then the line was
 *                    removed (resync IN +1), then the cancel added +1 again.
 *                    The replacement DO HC-DO-2610-420 shipped the unit before
 *                    GRN HC-GRN-2610-207 received it, and because of the extra
 *                    +1 the receipt never costed DO-420's OUT, so the GRN lot is
 *                    still open. -> kind CANCELLED_DO_OVER_REVERSED.
 *
 * Each planner below takes the LIVE facts the script reads and returns the
 * exact rows to write, the lot links to make, the bucket before/after, and the
 * reasons to refuse. The rule for every kind: the result must leave the bucket
 * at movements == open lots; anything else contradicts the investigation and
 * is refused, never written in part.
 */

export const CONFIRM_PHRASE = 'WRITE THE MISSING HALF-DONE MOVEMENTS';
export const TAG = 'repair-half-done-documents-2026-11';

export const KIND = Object.freeze({
  GRN_IN_MISSING_SHIP_UNCOSTED: 'GRN_IN_MISSING_SHIP_UNCOSTED',
  GRN_IN_LOST_ON_REPOST: 'GRN_IN_LOST_ON_REPOST',
  DO_OUT_MISSING: 'DO_OUT_MISSING',
  CANCELLED_DO_OVER_REVERSED: 'CANCELLED_DO_OVER_REVERSED',
});

/** The four documents, as the investigation found them. Nothing else is touched. */
export const TARGETS = Object.freeze([
  { docNo: 'HC-GRN-2609-118', kind: KIND.GRN_IN_MISSING_SHIP_UNCOSTED, items: ['8030-2A(LHF)'], downstreamDo: 'HC-DO-2610-329' },
  { docNo: 'HC-GRN-2610-045', kind: KIND.GRN_IN_LOST_ON_REPOST, items: ['8030-1A(LHF)', '8030-2A(RHF)'], downstreamDo: 'HC-DO-2610-343' },
  { docNo: 'HC-DO-2610-319', kind: KIND.DO_OUT_MISSING, items: null, downstreamDo: null },
  { docNo: 'HC-DO-2610-419', kind: KIND.CANCELLED_DO_OVER_REVERSED, items: ['ELEPHANE-(K)'], downstreamDo: 'HC-DO-2610-420' },
]);

export const EXPLAIN = Object.freeze({
  [KIND.GRN_IN_MISSING_SHIP_UNCOSTED]:
    'GRN line posted, its stock IN never written; the DO that shipped the unit found no lot, so its OUT is uncosted. '
    + 'Write the IN (cost from the GRN line), and let that DO OUT draw the new lot, as the receipt-time reconcile would have.',
  [KIND.GRN_IN_LOST_ON_REPOST]:
    'GRN posted, cancelled (IN reversed), posted again: the second post wrote no IN (the post guard saw the cancelled IN). '
    + 'A lot with no movement behind it stood in for the receipt and the DO shipped from it. '
    + 'Write the IN so the ledger shows the receipt; close the lot it opens (the stand-in lot already carried the unit).',
  [KIND.DO_OUT_MISSING]:
    'DO in a stock-out status with no stock OUT at all; its goods are still open lots. '
    + 'Write the OUT exactly as the ship would have (warehouse from the SO line, batch from the allocator), consuming those lots.',
  [KIND.CANCELLED_DO_OVER_REVERSED]:
    'Cancelled DO reversed twice: the line removal gave the unit back and the cancel gave it back again. '
    + 'The replacement DO shipped it before the GRN arrived, and the extra +1 hid that shortfall, so the GRN lot was never drawn. '
    + 'Let the replacement DO OUT draw the GRN lot, and write one ADJUSTMENT -1 against the cancel (consumes nothing).',
});

const num = (v) => (v == null ? 0 : Number(v));

/** A bucket's movements and open lots after deltas. */
export function shift(b, dMov, dLots) {
  return { mov: num(b?.mov) + dMov, lots: num(b?.lots) + dLots };
}

function mustBalance(after, refusals) {
  if (after.mov !== after.lots) refusals.push(`the bucket would end at movements ${after.mov} vs open lots ${after.lots}, not equal: contradicts the investigation`);
}

/**
 * GRN line posted with no IN, shipped by a DO whose OUT drew no lot.
 * @param {{ lineQty: number, grnNetIn: number, bucket: {mov:number,lots:number}, unitCost: number|null,
 *           downstream: { outId: string, outQty: number, consumed: number } | null }} f
 */
export function planGrnInMissingShipUncosted(f) {
  const refusals = [];
  const q = num(f.lineQty);
  if (num(f.grnNetIn) === q && q > 0) return { done: true, refusals, writes: [], attach: [], before: f.bucket, after: f.bucket };
  if (q <= 0) refusals.push('the GRN line accepts no qty');
  if (num(f.grnNetIn) !== 0) refusals.push(`the GRN already has a net IN of ${f.grnNetIn} for this line, not 0 and not ${q}`);
  if (f.unitCost == null || !Number.isFinite(f.unitCost) || f.unitCost < 0) refusals.push('the GRN line gives no usable unit cost');
  const free = f.downstream ? Math.max(0, num(f.downstream.outQty) - num(f.downstream.consumed)) : 0;
  if (!f.downstream) refusals.push('the DO that shipped this unit has no OUT in this bucket');
  else if (free <= 0) refusals.push('the DO OUT already draws a lot: a new IN would leave a unit on the shelf that shipped');
  const take = Math.min(q, free);
  const after = shift(f.bucket, q, q - take);
  mustBalance(after, refusals);
  if (refusals.length) return { done: false, refusals, writes: [], attach: [], before: f.bucket, after: f.bucket };
  return {
    done: false, refusals,
    writes: [{ type: 'IN', qty: q, unitCost: f.unitCost, closeMintedLot: false }],
    attach: take > 0 ? [{ fromMinted: true, toOut: f.downstream.outId, qty: take }] : [],
    before: f.bucket, after,
  };
}

/**
 * GRN posted again after a cancel, with no IN; a stand-in lot with no movement
 * carried the unit and is already consumed.
 * @param {{ lineQty: number, grnNetIn: number, bucket: {mov:number,lots:number},
 *           standIn: { qtyReceived: number, qtyRemaining: number, hasMovement: boolean, unitCost: number, consumedBy: string[] } | null,
 *           downstreamDo: string }} f
 */
export function planGrnInLostOnRepost(f) {
  const refusals = [];
  const q = num(f.lineQty);
  if (num(f.grnNetIn) === q && q > 0) return { done: true, refusals, writes: [], attach: [], before: f.bucket, after: f.bucket };
  if (q <= 0) refusals.push('the GRN line accepts no qty');
  if (num(f.grnNetIn) !== 0) refusals.push(`the GRN has a net IN of ${f.grnNetIn} for this line, not 0 and not ${q}`);
  const s = f.standIn;
  if (!s) refusals.push('no stand-in lot (same bucket and batch, no movement behind it) was found');
  else {
    if (s.hasMovement) refusals.push('the stand-in lot has a movement behind it: the receipt is already in the ledger');
    if (num(s.qtyReceived) !== q) refusals.push(`the stand-in lot received ${s.qtyReceived}, the GRN line ${q}`);
    if (num(s.qtyRemaining) !== 0) refusals.push(`the stand-in lot still holds ${s.qtyRemaining}: the unit did not ship from it`);
    if (!(s.consumedBy ?? []).includes(f.downstreamDo)) refusals.push(`the stand-in lot was not drawn by ${f.downstreamDo}`);
  }
  const after = shift(f.bucket, q, 0);
  mustBalance(after, refusals);
  if (refusals.length) return { done: false, refusals, writes: [], attach: [], before: f.bucket, after: f.bucket };
  return { done: false, refusals, writes: [{ type: 'IN', qty: q, unitCost: num(s.unitCost), closeMintedLot: true }], attach: [], before: f.bucket, after };
}

/** One OUT per (warehouse, item, variant, batch), as deductInventoryForDo collapses lines. */
export function collapseDoLines(lines) {
  const by = new Map();
  for (const l of lines) {
    if (l.service || num(l.qty) <= 0) continue;
    const k = `${l.warehouseId}::${l.itemCode}::${l.vk}::${l.batchNo ?? ''}`;
    const cur = by.get(k);
    if (cur) cur.qty += num(l.qty);
    else by.set(k, { key: k, warehouseId: l.warehouseId, itemCode: l.itemCode, vk: l.vk, batchNo: l.batchNo ?? null, qty: num(l.qty) });
  }
  return [...by.values()];
}

/**
 * DO in a stock-out status, no OUT written.
 * @param {{ status: string, stockOutStates: string[], existingOuts: number,
 *           lines: Array<{ itemCode: string, qty: number, warehouseId: string|null, vk: string, batchNo: string|null, service: boolean }>,
 *           buckets: Map<string, { mov: number, lots: number }> }} f  buckets keyed `${warehouseId}::${itemCode}::${vk}`
 */
export function planDoOutMissing(f) {
  const refusals = [];
  if (num(f.existingOuts) > 0) return { done: true, refusals, outs: [], before: new Map(), after: new Map() };
  if (!f.stockOutStates.includes(f.status)) refusals.push(`the DO is ${f.status}, not a stock-out status`);
  const goods = f.lines.filter((l) => !l.service && num(l.qty) > 0);
  if (goods.length === 0) refusals.push('the DO has no goods line');
  for (const l of goods) if (!l.warehouseId) refusals.push(`${l.itemCode}: no ship-from warehouse resolves`);
  const outs = refusals.length ? [] : collapseDoLines(goods);
  const before = new Map();
  const after = new Map();
  for (const o of outs) {
    const bk = `${o.warehouseId}::${o.itemCode}::${o.vk}`;
    const b = after.get(bk) ?? f.buckets.get(bk) ?? { mov: 0, lots: 0 };
    if (!before.has(bk)) before.set(bk, f.buckets.get(bk) ?? { mov: 0, lots: 0 });
    if (num(b.lots) < o.qty) refusals.push(`${o.itemCode}: ${o.qty} to ship, ${b.lots} open in the bucket: the goods are not on the shelf in the ledger`);
    after.set(bk, shift(b, -o.qty, -Math.min(o.qty, num(b.lots))));
  }
  for (const [, a] of after) mustBalance(a, refusals);
  if (refusals.length) return { done: false, refusals, outs: [], before, after: before };
  return { done: false, refusals, outs, before, after };
}

/**
 * Cancelled DO whose item was given back more than it went out.
 * @param {{ status: string, doNet: number, bucket: {mov:number,lots:number},
 *           downstream: { outId: string, outQty: number, consumed: number } | null,
 *           openLots: Array<{ id: string, qtyRemaining: number }> }} f
 *   doNet = OUT - DO IN - cancel ADJUSTMENT for the item (negative = over-reversed)
 */
export function planCancelledDoOverReversed(f) {
  const refusals = [];
  if (num(f.doNet) === 0) return { done: true, refusals, writes: [], attach: [], before: f.bucket, after: f.bucket };
  if (f.status !== 'CANCELLED') refusals.push(`the DO is ${f.status}, not CANCELLED`);
  if (num(f.doNet) > 0) refusals.push(`the DO still has ${f.doNet} out: not reversed, a different problem`);
  const excess = Math.max(0, -num(f.doNet));
  const free = f.downstream ? Math.max(0, num(f.downstream.outQty) - num(f.downstream.consumed)) : 0;
  if (!f.downstream) refusals.push('no replacement DO OUT in this bucket');
  const attach = [];
  let left = Math.min(excess, free);
  for (const l of f.openLots) {
    if (left <= 0) break;
    const n = Math.min(left, num(l.qtyRemaining));
    if (n > 0) { attach.push({ lotId: l.id, toOut: f.downstream?.outId, qty: n }); left -= n; }
  }
  const attached = attach.reduce((s, a) => s + a.qty, 0);
  const lotsAfterAttach = num(f.bucket.lots) - attached;
  if (lotsAfterAttach > 0) refusals.push(`${lotsAfterAttach} open lot unit(s) would remain for the ADJUSTMENT to consume: real stock, refused`);
  const after = shift(f.bucket, -excess, -attached);
  mustBalance(after, refusals);
  if (refusals.length) return { done: false, refusals, writes: [], attach: [], before: f.bucket, after: f.bucket };
  return { done: false, refusals, writes: [{ type: 'ADJUSTMENT', qty: -excess, unitCost: 0, closeMintedLot: false }], attach, before: f.bucket, after };
}

/** Unit cost a GRN IN carries: line price at the GRN rate plus the per-unit allocated charge (grns.ts post). */
export function grnUnitCost({ unitPriceSen, exchangeRate, allocatedChargeSen, qtyAccepted }) {
  if (unitPriceSen == null) return null;
  const rate = exchangeRate == null || Number(exchangeRate) <= 0 ? 1 : Number(exchangeRate);
  const base = Math.round(Number(unitPriceSen) * rate);
  const q = num(qtyAccepted);
  const charge = q > 0 ? Math.round(num(allocatedChargeSen) / q) : 0;
  return base + charge;
}

/** The movement notes: the tag, the document, what this row is. No money, no names. */
export function movementNotes({ docNo, kind, what }) {
  return `[${TAG}] ${docNo}: ${what} (${kind}). Ledger repair from check-half-done-documents run 42808054032.`;
}
