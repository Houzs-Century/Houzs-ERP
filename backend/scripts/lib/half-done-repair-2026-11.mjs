/* half-done-repair-2026-11 — the PURE half of repair-half-done-documents-2026-11.mjs.
 *
 * check-half-done-documents.mjs (run 42808054032, company 1) found four
 * documents whose stock movements do not match their posted lines. Company 1
 * binds each SO line to a PO line (hard binding, made to order) and does not
 * pick stock by spec, so only TOTAL qty per document and item counts here; spec
 * buckets are out of scope and nothing is re-keyed between them. Read-only
 * investigation (runs 42824682129, 42825512713): four separate stories, two
 * warehouses, different SO / PO chains, so none cancels another out. Each is a
 * real total-qty gap, not a spec artefact:
 *
 *   HC-GRN-2609-118  PG, 8030-2A(LHF), PO HC-PO-010044 -> SO HC-SO-010676. The
 *                    GRN holds NO stock IN at all for this line (posted
 *                    2026-09-22; the line added on 09-26 did get its IN).
 *                    DO HC-DO-2610-329 shipped the unit with an uncosted OUT.
 *                    -> GRN_IN_MISSING_SHIP_UNCOSTED: IN +1; the DO OUT draws it.
 *   HC-GRN-2610-045  KL, 8030-1A(LHF) and 8030-2A(RHF), PO HC-PO-2609-225 ->
 *                    SO HC-SO-2609-179. Posted, cancelled (IN reversed), posted
 *                    again: the second post wrote no IN (the post guard counted
 *                    the cancelled IN), so the GRN nets 0 IN per item. A lot with
 *                    no movement behind it stood in, and DO HC-DO-2610-343
 *                    shipped from it. -> GRN_IN_LOST_ON_REPOST: IN +1 each, the
 *                    lot it opens closed (the stand-in already carried the unit).
 *   HC-DO-2610-319   KL, Confirmed (LOADED) since 2026-10-22, NO stock OUT at all.
 *                    Its bound goods (GRN HC-GRN-2610-030, batch HC-PO-010145)
 *                    and 2 pillows are still open lots. -> DO_OUT_MISSING.
 *   HC-DO-2610-419   KL, cancelled. ELEPHANE-(K) in total: OUT 1, give-backs 2
 *                    (line removal, then the cancel), so +1 too many. The
 *                    replacement DO HC-DO-2610-420 shipped the unit before GRN
 *                    HC-GRN-2610-207 received it; its OUT is uncosted and the GRN
 *                    lot still open. -> CANCELLED_DO_OVER_REVERSED.
 *
 * Each planner takes the LIVE facts the script reads and returns the rows to
 * write, the lot links, the item total (warehouse, all specs) before / after,
 * and the reasons to refuse. Every row is written in the spec the document
 * itself already carries. A plan that would leave the item total's open lots
 * further from its movements than it found them is refused, never written in part.
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
    + 'Write the IN at the cost the bill recost gives every GRN lot, and let that DO OUT draw the new lot, as the receipt-time reconcile would have.',
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

/** Movements and open lots after deltas. */
export function shift(b, dMov, dLots) {
  return { mov: num(b?.mov) + dMov, lots: num(b?.lots) + dLots };
}

/* Company 1 binds each SO line to its PO line (hard binding, made to order) and
   does not pick stock by spec. So the only test that counts is the ITEM TOTAL at
   the warehouse, all specs together: the repair must not leave open lots further
   from movements than it found them. Rows are written in the spec the document
   itself already used (the GRN line's, the DO line's): nothing is re-keyed or
   moved between spec buckets. */
function itemGuard(item, dMov, dLots, refusals) {
  const before = { mov: num(item?.mov), lots: num(item?.lots) };
  const after = shift(before, dMov, dLots);
  if (Math.abs(after.lots - after.mov) > Math.abs(before.lots - before.mov)) {
    refusals.push(`the item total would move further from its lots (movements ${before.mov} -> ${after.mov}, open lots ${before.lots} -> ${after.lots})`);
  }
  return { before, after };
}

/**
 * GRN line posted with no IN, shipped by a DO whose OUT drew no lot.
 * @param {{ lineQty: number, grnNetIn: number, item: {mov:number,lots:number}, unitCost: number|null,
 *           downstream: { outId: string, outQty: number, consumed: number } | null }} f
 */
export function planGrnInMissingShipUncosted(f) {
  const refusals = [];
  const q = num(f.lineQty);
  if (num(f.grnNetIn) === q && q > 0) return { done: true, refusals, writes: [], attach: [], item: { before: f.item, after: f.item } };
  if (q <= 0) refusals.push('the GRN line accepts no qty');
  if (num(f.grnNetIn) !== 0) refusals.push(`the GRN already has a net IN of ${f.grnNetIn} for this line, not 0 and not ${q}`);
  if (f.unitCost == null || !Number.isFinite(f.unitCost) || f.unitCost < 0) refusals.push('the GRN line gives no usable unit cost');
  const free = f.downstream ? Math.max(0, num(f.downstream.outQty) - num(f.downstream.consumed)) : 0;
  if (!f.downstream) refusals.push('the DO that shipped this unit has no OUT for it');
  else if (free <= 0) refusals.push('the DO OUT already draws a lot: a new IN would leave a unit on the shelf that shipped');
  const take = Math.min(q, free);
  const item = itemGuard(f.item, q, q - take, refusals);
  if (refusals.length) return { done: false, refusals, writes: [], attach: [], item: { before: item.before, after: item.before } };
  return {
    done: false, refusals,
    writes: [{ type: 'IN', qty: q, unitCost: f.unitCost, closeMintedLot: false }],
    attach: take > 0 ? [{ fromMinted: true, toOut: f.downstream.outId, qty: take }] : [],
    item,
  };
}

/**
 * GRN posted again after a cancel, with no IN; a stand-in lot with no movement
 * carried the unit and is already consumed.
 * @param {{ lineQty: number, grnNetIn: number, item: {mov:number,lots:number},
 *           standIn: { qtyReceived: number, qtyRemaining: number, hasMovement: boolean, unitCost: number, consumedBy: string[] } | null,
 *           downstreamDo: string }} f
 */
export function planGrnInLostOnRepost(f) {
  const refusals = [];
  const q = num(f.lineQty);
  if (num(f.grnNetIn) === q && q > 0) return { done: true, refusals, writes: [], attach: [], item: { before: f.item, after: f.item } };
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
  const item = itemGuard(f.item, q, 0, refusals);
  if (refusals.length) return { done: false, refusals, writes: [], attach: [], item: { before: item.before, after: item.before } };
  return { done: false, refusals, writes: [{ type: 'IN', qty: q, unitCost: num(s.unitCost), closeMintedLot: true }], attach: [], item };
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
 *           items: Map<string, { mov: number, lots: number }>, drawable: Map<string, number> }} f
 *   items keyed `${warehouseId}::${itemCode}` (all specs); drawable keyed by the OUT's collapse key
 */
export function planDoOutMissing(f) {
  const refusals = [];
  if (num(f.existingOuts) > 0) return { done: true, refusals, outs: [], items: new Map() };
  if (!f.stockOutStates.includes(f.status)) refusals.push(`the DO is ${f.status}, not a stock-out status`);
  const goods = f.lines.filter((l) => !l.service && num(l.qty) > 0);
  if (goods.length === 0) refusals.push('the DO has no goods line');
  for (const l of goods) if (!l.warehouseId) refusals.push(`${l.itemCode}: no ship-from warehouse resolves`);
  const outs = refusals.length ? [] : collapseDoLines(goods);
  /* The OUT draws the lots the trigger finds for it: the bound PO's batch first.
     If they are not there the OUT would ship uncosted, which is not what happened. */
  const drawable = new Map(f.drawable ?? []);
  const d = new Map();
  for (const o of outs) {
    const left = num(drawable.get(o.key));
    if (left < o.qty) refusals.push(`${o.itemCode}: ${o.qty} to ship, ${left} open lot unit(s) it can draw: the goods are not on the shelf in the ledger`);
    drawable.set(o.key, left - Math.min(left, o.qty));
    const ik = `${o.warehouseId}::${o.itemCode}`;
    const cur = d.get(ik) ?? { mov: 0, lots: 0 };
    d.set(ik, { mov: cur.mov - o.qty, lots: cur.lots - Math.min(left, o.qty) });
  }
  const items = new Map();
  for (const [ik, delta] of d) items.set(ik, itemGuard(f.items.get(ik), delta.mov, delta.lots, refusals));
  if (refusals.length) return { done: false, refusals, outs: [], items };
  return { done: false, refusals, outs, items };
}

/**
 * Cancelled DO whose item was given back more than it went out.
 * @param {{ status: string, doNet: number, item: {mov:number,lots:number},
 *           downstream: { outId: string, outQty: number, consumed: number } | null,
 *           openLots: Array<{ id: string, qtyRemaining: number }> }} f
 *   doNet = OUT - DO IN - cancel ADJUSTMENT for the item (negative = over-reversed)
 */
export function planCancelledDoOverReversed(f) {
  const refusals = [];
  if (num(f.doNet) === 0) return { done: true, refusals, writes: [], attach: [], item: { before: f.item, after: f.item } };
  if (f.status !== 'CANCELLED') refusals.push(`the DO is ${f.status}, not CANCELLED`);
  if (num(f.doNet) > 0) refusals.push(`the DO still has ${f.doNet} out: not reversed, a different problem`);
  const excess = Math.max(0, -num(f.doNet));
  const free = f.downstream ? Math.max(0, num(f.downstream.outQty) - num(f.downstream.consumed)) : 0;
  if (!f.downstream) refusals.push('no replacement DO OUT for this item');
  const attach = [];
  let left = Math.min(excess, free);
  for (const l of f.openLots) {
    if (left <= 0) break;
    const n = Math.min(left, num(l.qtyRemaining));
    if (n > 0) { attach.push({ lotId: l.id, toOut: f.downstream?.outId, qty: n }); left -= n; }
  }
  const attached = attach.reduce((s, a) => s + a.qty, 0);
  const lotsAfterAttach = f.openLots.reduce((t, l) => t + num(l.qtyRemaining), 0) - attached;
  if (lotsAfterAttach > 0) refusals.push(`${lotsAfterAttach} open lot unit(s) would remain for the ADJUSTMENT to consume: real stock, refused`);
  const item = itemGuard(f.item, -excess, -attached, refusals);
  if (refusals.length) return { done: false, refusals, writes: [], attach: [], item: { before: item.before, after: item.before } };
  return { done: false, refusals, writes: [{ type: 'ADJUSTMENT', qty: -excess, unitCost: 0, closeMintedLot: false }], attach, item };
}

/**
 * The cost a GRN line's lot carries once its supplier bill exists — a mirror of
 * recostFromGrn (src/scm/lib/recost.ts), which re-costs every GRN lot when a
 * bill is posted: the bill's qty-weighted MYR price (DRAFT / CANCELLED bills and
 * zero prices ignored), else the GRN price at the GRN rate; plus the GRN's and
 * the bills' allocated freight as a total over the received qty. null = no price
 * anywhere (recost leaves such a lot "Pending").
 * @param {{ qtyAccepted: number, unitPriceSen: number|null, exchangeRate: number|null, allocatedChargeSen: number|null,
 *           bills: Array<{ qty: number, unitPriceSen: number|null, exchangeRate: number|null, status: string|null, allocatedChargeSen: number|null }> }} l
 */
export function receiptUnitCost(l) {
  const rate = (r) => (r == null || !(Number(r) > 0) ? 1 : Number(r));
  const live = (l.bills ?? []).filter((b) => !['CANCELLED', 'DRAFT'].includes(String(b.status ?? '').toUpperCase()));
  let bq = 0;
  let ba = 0;
  for (const b of live) { const q = num(b.qty); bq += q; ba += q * Math.round(num(b.unitPriceSen) * rate(b.exchangeRate)); }
  const billGoods = bq > 0 ? Math.round(ba / bq) : 0;
  const goods = billGoods > 0 ? billGoods
    : (num(l.unitPriceSen) > 0 ? Math.round(num(l.unitPriceSen) * rate(l.exchangeRate)) : null);
  if (goods === null) return null;
  const q = Math.max(0, num(l.qtyAccepted));
  if (q === 0) return null;
  const freight = num(l.allocatedChargeSen) + live.reduce((s, b) => s + num(b.allocatedChargeSen), 0);
  return Math.round((q * goods + freight) / q);
}

/** The movement notes: the tag, the document, what this row is. No money, no names. */
export function movementNotes({ docNo, kind, what }) {
  return `[${TAG}] ${docNo}: ${what} (${kind}). Ledger repair from check-half-done-documents run 42808054032.`;
}
