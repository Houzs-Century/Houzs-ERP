// The pure half of repair-half-done-documents-2026-11.mjs, on the production
// shapes the investigation found (company 1, runs 42824682129 / 42825512713).
import { describe, expect, test } from 'vitest';
import {
  KIND, TARGETS, TAG, planGrnInMissingShipUncosted, planGrnInLostOnRepost, planDoOutMissing,
  planCancelledDoOverReversed, collapseDoLines, receiptUnitCost, movementNotes,
} from '../scripts/lib/half-done-repair-2026-11.mjs';
import { DO_STOCK_OUT_STATES } from '../scripts/lib/do-shipped-states.mjs';

describe('TARGETS', () => {
  test('exactly the four documents of run 42808054032, each with its own kind', () => {
    expect(TARGETS.map((t) => t.docNo)).toEqual(['HC-GRN-2609-118', 'HC-GRN-2610-045', 'HC-DO-2610-319', 'HC-DO-2610-419']);
    expect(new Set(TARGETS.map((t) => t.kind)).size).toBe(4);
  });
});

describe('GRN-2609-118: IN never written, DO-329 shipped the unit uncosted', () => {
  const live = { lineQty: 1, grnNetIn: 0, item: { mov: 0, lots: 1 }, unitCost: 1000, downstream: { outId: 'out329', outQty: 1, consumed: 0 } };

  test('writes IN +1 and links its lot to the DO OUT; the item total (all specs) closes its gap', () => {
    const p = planGrnInMissingShipUncosted(live);
    expect(p.refusals).toEqual([]);
    expect(p.writes).toEqual([{ type: 'IN', qty: 1, unitCost: 1000, closeMintedLot: false }]);
    expect(p.attach).toEqual([{ fromMinted: true, toOut: 'out329', qty: 1 }]);
    expect(p.item.after).toEqual({ mov: 1, lots: 1 });
  });

  test('re-run after apply: the GRN nets 1 IN, so it is done and writes nothing', () => {
    const p = planGrnInMissingShipUncosted({ ...live, grnNetIn: 1, item: { mov: 1, lots: 1 } });
    expect(p.done).toBe(true);
    expect(p.writes).toEqual([]);
  });

  test('refused when the DO OUT already draws a lot: the IN would leave a shipped unit on the shelf', () => {
    const p = planGrnInMissingShipUncosted({ ...live, downstream: { outId: 'out329', outQty: 1, consumed: 1 } });
    expect(p.writes).toEqual([]);
    expect(p.refusals.join(' ')).toMatch(/already draws a lot/);
  });

  test('refused with no cost, or no downstream OUT', () => {
    expect(planGrnInMissingShipUncosted({ ...live, unitCost: null }).refusals.join(' ')).toMatch(/no usable unit cost/);
    expect(planGrnInMissingShipUncosted({ ...live, downstream: null }).refusals.join(' ')).toMatch(/has no OUT/);
  });

  test('refused when the item total would move further from its lots (all specs; no spec rule)', () => {
    const p = planGrnInMissingShipUncosted({ ...live, item: { mov: 2, lots: 1 } });
    expect(p.writes).toEqual([]);
    expect(p.refusals.join(' ')).toMatch(/further from its lots/);
  });
});

describe('GRN-2610-045: re-post wrote no IN, a stand-in lot carried the unit to DO-343', () => {
  const standIn = { qtyReceived: 1, qtyRemaining: 0, hasMovement: false, unitCost: 900, consumedBy: ['HC-DO-2610-343'] };
  const live = { lineQty: 1, grnNetIn: 0, item: { mov: 9, lots: 10 }, standIn, downstreamDo: 'HC-DO-2610-343' };

  test('writes IN +1 and closes the lot it opens; item movements +1, open lots unchanged', () => {
    const p = planGrnInLostOnRepost(live);
    expect(p.refusals).toEqual([]);
    expect(p.writes).toEqual([{ type: 'IN', qty: 1, unitCost: 900, closeMintedLot: true }]);
    expect(p.item.after).toEqual({ mov: 10, lots: 10 });
  });

  test('done once the GRN nets its IN again', () => {
    expect(planGrnInLostOnRepost({ ...live, grnNetIn: 1 }).done).toBe(true);
  });

  test('refused when the stand-in lot has a movement, still holds the unit, or was drawn by another DO', () => {
    expect(planGrnInLostOnRepost({ ...live, standIn: { ...standIn, hasMovement: true } }).refusals.join(' ')).toMatch(/already in the ledger/);
    expect(planGrnInLostOnRepost({ ...live, standIn: { ...standIn, qtyRemaining: 1 } }).refusals.join(' ')).toMatch(/still holds/);
    expect(planGrnInLostOnRepost({ ...live, standIn: { ...standIn, consumedBy: ['HC-DO-2610-999'] } }).refusals.join(' ')).toMatch(/not drawn by/);
    expect(planGrnInLostOnRepost({ ...live, standIn: null }).refusals.join(' ')).toMatch(/no stand-in lot/);
  });

  test('refused when the GRN already has a different net IN', () => {
    expect(planGrnInLostOnRepost({ ...live, grnNetIn: -1 }).refusals.join(' ')).toMatch(/net IN of -1/);
  });
});

describe('DO-2610-319: Confirmed, no OUT', () => {
  const KL = 'wh-kl';
  const SOFA = 'fabriccode=bo315-21|special=nylon fabric';
  const lines = [
    { itemCode: '8030-1A(LHF)', qty: 1, warehouseId: KL, vk: SOFA, batchNo: 'HC-PO-010145', service: false },
    { itemCode: '8030-CONSOLE', qty: 1, warehouseId: KL, vk: SOFA, batchNo: 'HC-PO-010145', service: false },
    { itemCode: '8030-1A(RHF)', qty: 1, warehouseId: KL, vk: SOFA, batchNo: 'HC-PO-010145', service: false },
    { itemCode: 'AMN-SOFA PILLOW', qty: 2, warehouseId: KL, vk: '', batchNo: null, service: false },
  ];
  const items = new Map([
    [`${KL}::8030-1A(LHF)`, { mov: 13, lots: 16 }],
    [`${KL}::8030-CONSOLE`, { mov: 2, lots: 2 }],
    [`${KL}::8030-1A(RHF)`, { mov: 12, lots: 14 }],
    [`${KL}::AMN-SOFA PILLOW`, { mov: 159, lots: 159 }],
  ]);
  const key = (l) => `${l.warehouseId}::${l.itemCode}::${l.vk}::${l.batchNo ?? ''}`;
  const drawable = new Map(lines.map((l) => [key(l), l.itemCode === 'AMN-SOFA PILLOW' ? 159 : 1]));
  const live = { status: 'LOADED', stockOutStates: DO_STOCK_OUT_STATES, existingOuts: 0, lines, items, drawable };

  test('one OUT per line as the ship would write it; item totals move by the qty shipped', () => {
    const p = planDoOutMissing(live);
    expect(p.refusals).toEqual([]);
    expect(p.outs.map((o) => [o.itemCode, o.qty, o.batchNo])).toEqual([
      ['8030-1A(LHF)', 1, 'HC-PO-010145'], ['8030-CONSOLE', 1, 'HC-PO-010145'], ['8030-1A(RHF)', 1, 'HC-PO-010145'], ['AMN-SOFA PILLOW', 2, null],
    ]);
    expect(p.items.get(`${KL}::AMN-SOFA PILLOW`).after).toEqual({ mov: 157, lots: 157 });
    expect(p.items.get(`${KL}::8030-CONSOLE`).after).toEqual({ mov: 1, lots: 1 });
    expect(p.items.get(`${KL}::8030-1A(LHF)`).after).toEqual({ mov: 12, lots: 15 });
  });

  test('done once any OUT exists (the ship guard would also skip it)', () => {
    expect(planDoOutMissing({ ...live, existingOuts: 4 }).done).toBe(true);
  });

  test('refused when the goods are not open lots, the DO is not shipped, or a line has no warehouse', () => {
    const none = new Map(drawable); none.set(key(lines[1]), 0);
    expect(planDoOutMissing({ ...live, drawable: none }).refusals.join(' ')).toMatch(/not on the shelf/);
    expect(planDoOutMissing({ ...live, status: 'DRAFT' }).refusals.join(' ')).toMatch(/not a stock-out status/);
    const noWh = lines.map((l, i) => (i === 0 ? { ...l, warehouseId: null } : l));
    expect(planDoOutMissing({ ...live, lines: noWh }).refusals.join(' ')).toMatch(/no ship-from warehouse/);
    expect(planDoOutMissing({ ...live, status: 'DRAFT' }).outs).toEqual([]);
  });

  test('service lines and zero qty write nothing; same bucket and batch collapse into one OUT', () => {
    const outs = collapseDoLines([
      { itemCode: 'A', qty: 1, warehouseId: KL, vk: '', batchNo: null, service: false },
      { itemCode: 'A', qty: 2, warehouseId: KL, vk: '', batchNo: null, service: false },
      { itemCode: 'SVC-DELIVERY', qty: 1, warehouseId: KL, vk: '', batchNo: null, service: true },
      { itemCode: 'B', qty: 0, warehouseId: KL, vk: '', batchNo: null, service: false },
    ]);
    expect(outs.map((o) => [o.itemCode, o.qty])).toEqual([['A', 3]]);
  });
});

describe('DO-2610-419: cancelled, ELEPHANE-(K) given back twice', () => {
  const live = {
    status: 'CANCELLED', doNet: -1, item: { mov: 0, lots: 1 },
    downstream: { outId: 'out420', outQty: 1, consumed: 0 },
    openLots: [{ id: 'lot-grn207', qtyRemaining: 1 }],
  };

  test('DO-420 draws the GRN-207 lot, then ADJUSTMENT -1; the item total is no worse (an old cutover row stays)', () => {
    const p = planCancelledDoOverReversed(live);
    expect(p.refusals).toEqual([]);
    expect(p.attach).toEqual([{ lotId: 'lot-grn207', toOut: 'out420', qty: 1 }]);
    expect(p.writes).toEqual([{ type: 'ADJUSTMENT', qty: -1, unitCost: 0, closeMintedLot: false }]);
    expect(p.item.after).toEqual({ mov: -1, lots: 0 });
  });

  test('done once the DO nets to 0', () => {
    expect(planCancelledDoOverReversed({ ...live, doNet: 0 }).done).toBe(true);
  });

  test('refused when an open lot would be left for the ADJUSTMENT to consume (real stock)', () => {
    const p = planCancelledDoOverReversed({ ...live, item: { mov: 2, lots: 2 }, openLots: [{ id: 'a', qtyRemaining: 2 }] });
    expect(p.writes).toEqual([]);
    expect(p.refusals.join(' ')).toMatch(/real stock/);
  });

  test('refused when the replacement OUT is already costed, or the DO is not cancelled, or still out', () => {
    expect(planCancelledDoOverReversed({ ...live, downstream: { outId: 'out420', outQty: 1, consumed: 1 } }).writes).toEqual([]);
    expect(planCancelledDoOverReversed({ ...live, status: 'LOADED' }).refusals.join(' ')).toMatch(/not CANCELLED/);
    expect(planCancelledDoOverReversed({ ...live, doNet: 1 }).refusals.join(' ')).toMatch(/not reversed/);
  });
});

describe('receiptUnitCost and notes', () => {
  test('receiptUnitCost mirrors recostFromGrn: live bill price wins, else GRN price; freight added once as a total', () => {
    const line = { qtyAccepted: 1, unitPriceSen: 1000, exchangeRate: 1, allocatedChargeSen: 0 };
    expect(receiptUnitCost({ ...line, bills: [] })).toBe(1000);
    expect(receiptUnitCost({ ...line, bills: [{ qty: 1, unitPriceSen: 1200, exchangeRate: 1, status: 'POSTED', allocatedChargeSen: 0 }] })).toBe(1200);
    expect(receiptUnitCost({ ...line, bills: [{ qty: 1, unitPriceSen: 1200, exchangeRate: 1, status: 'CANCELLED', allocatedChargeSen: 0 }] })).toBe(1000);
    expect(receiptUnitCost({ ...line, bills: [{ qty: 1, unitPriceSen: 0, exchangeRate: 1, status: 'POSTED', allocatedChargeSen: 0 }] })).toBe(1000);
    expect(receiptUnitCost({ ...line, qtyAccepted: 2, allocatedChargeSen: 50, bills: [{ qty: 2, unitPriceSen: 300, exchangeRate: 2, status: 'POSTED', allocatedChargeSen: 50 }] })).toBe(650);
    expect(receiptUnitCost({ ...line, unitPriceSen: null, bills: [] })).toBeNull();
  });

  test('notes carry the tag and the document, never a figure beyond qty', () => {
    const n = movementNotes({ docNo: 'HC-DO-2610-319', kind: KIND.DO_OUT_MISSING, what: 'missing stock OUT for X x2' });
    expect(n).toContain(TAG);
    expect(n).toContain('HC-DO-2610-319');
    expect(n).not.toMatch(/RM|sen/);
  });
});
