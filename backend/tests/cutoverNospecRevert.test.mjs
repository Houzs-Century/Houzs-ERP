// The pure half of revert-cutover-nospec-repair.mjs, replayed on an in-memory
// ledger that does what the database does: the FIFO trigger on ADJUSTMENT rows
// (0307), scm.fn_reconcile_uncosted_out (20261026T1600), and the repair's own
// steps (repair-cutover-nospec-stock.mjs). A repair followed by the revert must
// leave every bucket, every lot, every DO OUT and the stock value exactly as
// they were before the repair.
import { describe, expect, test } from 'vitest';
import { planItemWarehouse, movementNotes } from '../scripts/lib/cutover-nospec-repair.mjs';
import {
  REPAIR_DOC_NO, REVERT_DOC_PREFIX, groupRepairRows, specOfRepairNotes, revertMarker, revertNotes,
  planGroupRevert, planPair, bucketsAfterRevert, bucketsBeforeRepair, sameBuckets,
} from '../scripts/lib/cutover-nospec-revert.mjs';

const ITEM = 'SQUARE PILLOW';
const WH = 'wh-kl';
const RED = 'fabriccode=pc-151';
const BLUE = 'fabriccode=pc-152';
const REPAIR_TS = '2026-11-10T05:00:00.000000';
const REVERT_TS = '2026-11-10T09:00:00.000000';
const REVERT_DOC = `${REVERT_DOC_PREFIX}-2026-11-10`;

/* ---------------- the in-memory ledger ---------------- */
function ledger() {
  let seq = 0;
  const id = (p) => `${p}-${String(++seq).padStart(4, '0')}`;
  const s = { lots: [], movements: [], consumptions: [], id };
  const consume = (m, need) => {
    let left = need;
    let cost = 0;
    const open = s.lots.filter((l) => l.wh === m.wh && l.item === m.item && l.vk === m.vk && l.qtyRemaining > 0)
      .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id < b.id ? -1 : 1));
    for (const l of open) {
      if (left <= 0) break;
      const take = Math.min(l.qtyRemaining, left);
      l.qtyRemaining -= take;
      s.consumptions.push({ id: id('c'), lotId: l.id, movementId: m.id, qty: take, unitCost: l.unitCost, totalCost: take * l.unitCost, consumedAt: m.createdAt });
      cost += take * l.unitCost;
      left -= take;
    }
    return cost;
  };
  /* scm.fn_inventory_movement_fifo for IN / OUT / ADJUSTMENT. */
  s.insert = (row) => {
    const m = { id: id('m'), total: 0, unit: 0, docNo: '', notes: '', doId: null, month: row.createdAt.slice(0, 7), ...row };
    s.movements.push(m);
    if (m.type === 'IN' || (m.type === 'ADJUSTMENT' && m.qty > 0)) {
      const open = s.lots.filter((l) => l.wh === m.wh && l.item === m.item && l.vk === m.vk && l.qtyRemaining > 0);
      const q = open.reduce((t, l) => t + l.qtyRemaining, 0);
      const avg = q > 0 ? Math.trunc(open.reduce((t, l) => t + l.qtyRemaining * l.unitCost, 0) / q) : 0;
      const unit = m.type === 'IN' ? m.unit : (m.unit || avg);
      s.lots.push({ id: id('lot'), item: m.item, wh: m.wh, vk: m.vk, qtyReceived: m.qty, qtyRemaining: m.qty, unitCost: unit, receivedAt: m.createdAt, movementId: m.id });
      m.total = m.qty * unit;
      m.unit = unit;
    } else if (m.type === 'OUT' || (m.type === 'ADJUSTMENT' && m.qty < 0)) {
      const need = Math.abs(m.qty);
      m.total = consume(m, need);
      m.unit = Math.trunc(m.total / need);
    }
    return m;
  };
  /* scm.fn_reconcile_uncosted_out (no drop-ship / cancelled / strict OUTs here). */
  s.reconcile = (wh, item, vk, beforeTs, at) => {
    let consumed = 0;
    const outs = s.movements.filter((m) => m.type === 'OUT' && m.wh === wh && m.item === item && m.vk === vk && m.createdAt < beforeTs)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    for (const o of outs) {
      const already = s.consumptions.filter((c) => c.movementId === o.id).reduce((t, c) => t + c.qty, 0);
      let short = Math.abs(o.qty) - already;
      if (short <= 0) continue;
      let added = 0;
      const open = s.lots.filter((l) => l.wh === wh && l.item === item && l.vk === vk && l.qtyRemaining > 0)
        .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id < b.id ? -1 : 1));
      for (const l of open) {
        if (short <= 0) break;
        const take = Math.min(l.qtyRemaining, short);
        l.qtyRemaining -= take;
        s.consumptions.push({ id: id('c'), lotId: l.id, movementId: o.id, qty: take, unitCost: l.unitCost, totalCost: take * l.unitCost, consumedAt: at });
        short -= take;
        consumed += take;
        added += take * l.unitCost;
      }
      if (added > 0) {
        o.total += added;
        o.unit = Math.trunc(o.total / Math.abs(o.qty));
      }
    }
    return consumed;
  };
  s.bucket = (vk) => ({
    mov: s.movements.filter((m) => m.item === ITEM && m.wh === WH && m.vk === vk).reduce((t, m) => t + (m.type === 'OUT' ? -m.qty : m.qty), 0),
    lots: s.lots.filter((l) => l.item === ITEM && l.wh === WH && l.vk === vk && l.qtyRemaining > 0).reduce((t, l) => t + l.qtyRemaining, 0),
  });
  /* acc/stock-close.ts signedCost over every movement. */
  s.value = () => s.movements.reduce((t, m) => t + (m.type === 'IN' ? Math.abs(m.total) : m.type === 'OUT' ? -Math.abs(m.total) : (m.qty >= 0 ? Math.abs(m.total) : -Math.abs(m.total))), 0);
  return s;
}

/* SQUARE PILLOW @ KL: cutover lots in the no-spec bucket (two costs), RED and
   BLUE shipped after the cutover from empty buckets, uncosted. */
function seeded() {
  const s = ledger();
  s.insert({ type: 'ADJUSTMENT', item: ITEM, wh: WH, vk: '', qty: 2, unit: 800, createdAt: '2026-08-29T00:00:00.000000', docNo: 'AC_CUTOVER' });
  s.insert({ type: 'ADJUSTMENT', item: ITEM, wh: WH, vk: '', qty: 40, unit: 900, createdAt: '2026-08-29T01:00:00.000000', docNo: 'AC_CUTOVER' });
  const out = (vk, qty, at, doc) => s.insert({ type: 'OUT', item: ITEM, wh: WH, vk, qty, createdAt: at, docNo: doc, doId: `do-${doc}` });
  out(RED, 1, '2026-09-05T03:00:00.000000', 'HC-DO-r1');
  out(RED, 2, '2026-09-20T03:00:00.000000', 'HC-DO-r2');
  out(BLUE, 2, '2026-10-02T03:00:00.000000', 'HC-DO-b1');
  /* An unrelated OUT that drew part of the oldest lot before the repair. */
  out('', 1, '2026-09-01T00:00:00.000000', 'HC-DO-plain');
  return s;
}

/* The repair, step by step as repair-cutover-nospec-stock.mjs writes it. */
function runRepair(s) {
  const emptyLots = s.lots.filter((l) => l.item === ITEM && l.wh === WH && l.vk === '' && l.qtyRemaining > 0);
  const outsOf = (vk) => s.movements.filter((m) => m.type === 'OUT' && m.vk === vk).map((m) => ({
    movementId: m.id, doId: m.doId, qty: m.qty, createdAt: m.createdAt, isDropship: false, strictBatchCommitted: false, doStatus: 'SHIPPED',
    alreadyConsumedQty: s.consumptions.filter((c) => c.movementId === m.id).reduce((t, c) => t + c.qty, 0), alreadyCostedSen: m.total,
    docNo: m.docNo, month: m.month,
  }));
  const plan = planItemWarehouse({
    cutoffTs: REPAIR_TS,
    empty: { mov: s.bucket('').mov, lots: emptyLots.map((l) => ({ lotId: l.id, receivedAt: l.receivedAt, qtyRemaining: l.qtyRemaining, unitCostSen: l.unitCost, rawVk: '' })) },
    negatives: [RED, BLUE].map((vk) => ({ vk, mov: s.bucket(vk).mov, lotOpen: 0, firstOutAt: outsOf(vk)[0].createdAt, outs: outsOf(vk) })),
    stocked: [{ vk: '', lotOpen: s.bucket('').lots }],
  });
  const base = { type: 'ADJUSTMENT', item: ITEM, wh: WH, docNo: REPAIR_DOC_NO, createdAt: REPAIR_TS };
  for (const f of plan.fixes) {
    const from = s.insert({ ...base, vk: '', qty: -f.qty, notes: movementNotes({ side: 'from', qty: -f.qty, specVk: f.vk, ref: REPAIR_DOC_NO }) });
    const used = s.consumptions.filter((c) => c.movementId === from.id);
    used.forEach((u, i) => {
      const to = s.insert({ ...base, vk: f.vk, qty: u.qty, unit: u.unitCost, notes: movementNotes({ side: 'to', qty: u.qty, specVk: f.vk, ref: REPAIR_DOC_NO }) });
      const lot = s.lots.find((l) => l.movementId === to.id);
      lot.unitCost = u.unitCost;
      lot.receivedAt = `${s.lots.find((l) => l.id === u.lotId).receivedAt}${i}`;
    });
    expect(s.reconcile(WH, ITEM, f.vk, REPAIR_TS, REPAIR_TS)).toBe(f.qty);
  }
  return plan;
}

/* What the script's gather reads, from the ledger. */
function gather(s, extraLater = []) {
  const repairRows = s.movements.filter((m) => m.docNo === REPAIR_DOC_NO)
    .map((m) => ({ id: m.id, itemCode: m.item, warehouseId: m.wh, vk: m.vk, qty: m.qty, notes: m.notes, createdAt: m.createdAt, totalCostSen: m.total, unitCostSen: m.unit }));
  const revertRows = s.movements.filter((m) => m.docNo.startsWith(`${REVERT_DOC_PREFIX}-`));
  const own = new Set([...repairRows.map((r) => r.id), ...revertRows.map((r) => r.id)]);
  const { groups } = groupRepairRows(repairRows);
  const inputs = groups.map((rg) => {
    const from = rg.from[0];
    const toIds = new Set(rg.to.map((t) => t.id));
    const minted = s.lots.filter((l) => toIds.has(l.movementId));
    const mintedIds = new Set(minted.map((l) => l.id));
    const mintedCons = s.consumptions.filter((c) => mintedIds.has(c.lotId)).map((c) => {
      const m = s.movements.find((x) => x.id === c.movementId);
      return { id: c.id, lotId: c.lotId, movementId: c.movementId, qty: c.qty, totalCostSen: c.totalCost, movementType: m.type,
        sourceDocType: m.type === 'OUT' ? 'DO' : 'ADJUSTMENT', movementCreatedAt: m.createdAt, consumedAt: c.consumedAt };
    });
    const fromCons = s.consumptions.filter((c) => c.movementId === from.id);
    const vks = new Set(['', rg.specVk]);
    return {
      itemCode: rg.itemCode, warehouseId: rg.warehouseId, specVk: rg.specVk,
      from: { id: from.id, qty: from.qty, totalCostSen: from.totalCostSen, createdAt: from.createdAt },
      to: rg.to.map((t) => ({ id: t.id, qty: t.qty, unitCostSen: t.unitCostSen })),
      reverted: revertRows.some((r) => r.notes.includes(revertMarker(from.id))),
      fromConsumptions: fromCons.map((c) => ({ id: c.id, lotId: c.lotId, qty: c.qty, unitCostSen: c.unitCost })),
      emptyLots: [...new Set(fromCons.map((c) => c.lotId))].map((lid) => s.lots.find((l) => l.id === lid))
        .map((l) => ({ lotId: l.id, vk: l.vk, qtyReceived: l.qtyReceived, qtyRemaining: l.qtyRemaining })),
      mintedLots: minted.map((l) => ({ lotId: l.id, movementId: l.movementId, vk: l.vk, qtyReceived: l.qtyReceived, qtyRemaining: l.qtyRemaining })),
      mintedConsumptions: mintedCons,
      outs: [...new Set(mintedCons.map((c) => c.movementId))].map((mid) => s.movements.find((m) => m.id === mid)).map((m) => ({
        movementId: m.id, qty: m.qty, totalCostSen: m.total, doId: m.doId, docNo: m.docNo, month: m.month,
        consumedQty: s.consumptions.filter((c) => c.movementId === m.id).reduce((t, c) => t + c.qty, 0),
      })),
      later: [...s.movements, ...extraLater].filter((m) => vks.has(m.vk) && m.createdAt > from.createdAt && !own.has(m.id) && !m.docNo.startsWith(`${REVERT_DOC_PREFIX}-`))
        .map((m) => ({ id: m.id, movementType: m.type, docNo: m.docNo, vk: m.vk, qty: m.qty, createdAt: m.createdAt })),
    };
  });
  const vks = ['', RED, BLUE];
  const ownMovs = s.movements.filter((m) => own.has(m.id));
  const ownMovIds = new Set(ownMovs.map((m) => m.id));
  const fromIds = new Set(inputs.map((g) => g.from.id));
  return planPair({
    groups: inputs,
    now: new Map(vks.map((vk) => [vk, s.bucket(vk)])),
    ownRows: ownMovs.map((m) => ({ vk: m.vk, qty: m.qty })),
    ownLots: s.lots.filter((l) => ownMovIds.has(l.movementId)).map((l) => ({ vk: l.vk, qtyRemaining: l.qtyRemaining })),
    drawnByRepair: s.consumptions.filter((c) => fromIds.has(c.movementId)).map((c) => ({ vk: s.lots.find((l) => l.id === c.lotId).vk, qty: c.qty })),
  });
}

/* The script's write steps, on the ledger. */
function applyRevert(s, pair) {
  const base = { type: 'ADJUSTMENT', item: ITEM, wh: WH, docNo: REVERT_DOC, createdAt: REVERT_TS };
  for (const g of pair.plans.filter((p) => p.status === 'revert')) {
    const del = new Set(g.deleteConsumptionIds);
    s.consumptions = s.consumptions.filter((c) => !del.has(c.id));
    for (const r of [...g.mintedRestores, ...g.emptyRestores]) {
      const l = s.lots.find((x) => x.id === r.lotId);
      l.qtyRemaining += r.add;
      expect(l.qtyRemaining).toBeLessThanOrEqual(l.qtyReceived);
    }
    for (const o of g.outResets) {
      const m = s.movements.find((x) => x.id === o.movementId);
      expect(m.total).toBe(o.fromTotalSen);
      m.total = o.toTotalSen;
      m.unit = o.toUnitSen;
    }
    const from = s.movements.find((x) => x.id === g.fromRecost.movementId);
    from.total = 0;
    from.unit = 0;
    const minus = s.insert({ ...base, vk: g.specVk, qty: g.specMinus.qty, notes: revertNotes({ side: 'spec', qty: g.specMinus.qty, specVk: g.specVk, fromRowId: g.fromRowId, ref: REVERT_DOC }) });
    const used = s.consumptions.filter((c) => c.movementId === minus.id).map((c) => [c.lotId, c.qty]).sort();
    expect(used).toEqual(g.specMinus.consumes.map((c) => [c.lotId, c.qty]).sort());
    const plus = s.insert({ ...base, vk: '', qty: g.emptyPlus.qty, notes: revertNotes({ side: 'empty', qty: g.emptyPlus.qty, specVk: g.specVk, fromRowId: g.fromRowId, ref: REVERT_DOC }) });
    s.lots.find((l) => l.movementId === plus.id).qtyRemaining = 0;
    plus.total = 0;
    plus.unit = 0;
  }
}

const snapshot = (s) => ({
  buckets: ['', RED, BLUE].map((vk) => [vk, s.bucket(vk)]),
  lots: s.lots.map((l) => [l.id, l.qtyRemaining]),
  outs: s.movements.filter((m) => m.type === 'OUT').map((m) => [m.id, m.total, m.unit,
    s.consumptions.filter((c) => c.movementId === m.id).map((c) => [c.lotId, c.qty]).sort()]),
  value: s.value(),
});

describe('repair then revert', () => {
  test('ends in the identical state: buckets, every lot, every DO OUT, the stock value', () => {
    const s = seeded();
    const before = snapshot(s);
    const repair = runRepair(s);
    expect(repair.moved).toBe(5);
    expect(snapshot(s).outs).not.toEqual(before.outs);

    const pair = gather(s);
    expect(pair.status).toBe('revert');
    expect(pair.problems).toEqual([]);
    expect(pair.plans.map((p) => [p.specVk, p.q])).toEqual([[RED, 3], [BLUE, 2]]);
    expect(pair.plans.flatMap((p) => p.outResets.map((o) => [o.docNo, o.qtyRemoved, o.toTotalSen, o.consumedAfter])))
      .toEqual([['HC-DO-r1', 1, 0, 0], ['HC-DO-r2', 2, 0, 0], ['HC-DO-b1', 2, 0, 0]]);
    // The plan's after-revert buckets equal the pre-repair buckets derived from the rows, and the real ones.
    expect(sameBuckets(pair.after, pair.pre)).toBe(true);
    for (const [vk, b] of before.buckets) expect(pair.pre.get(vk)).toEqual(b);

    applyRevert(s, pair);
    const after = snapshot(s);
    const minted = new Set(s.lots.filter((l) => s.movements.find((m) => m.id === l.movementId).docNo !== 'AC_CUTOVER').map((l) => l.id));
    expect(after.buckets).toEqual(before.buckets);
    expect(after.lots.filter(([id]) => !minted.has(id))).toEqual(before.lots);
    expect(after.lots.filter(([id]) => minted.has(id)).every(([, q]) => q === 0)).toBe(true);
    expect(after.outs).toEqual(before.outs);
    expect(after.value).toBe(before.value);

    // A re-plan finds nothing to revert.
    const again = gather(s);
    expect(again.status).toBe('already-reverted');
    expect(again.plans.every((p) => p.status === 'already-reverted')).toBe(true);
    for (const [vk, b] of before.buckets) expect(again.pre.get(vk)).toEqual(b);
  });

  test('a DO OUT with cost before the reconcile goes back to that cost, not to 0', () => {
    const s = seeded();
    const r2 = s.movements.find((m) => m.docNo === 'HC-DO-r2');
    r2.total = 500; // costed without consumption rows (the 20261026T1600 case)
    r2.unit = 250;
    const before = snapshot(s);
    runRepair(s);
    const pair = gather(s);
    expect(pair.status).toBe('revert');
    applyRevert(s, pair);
    expect(snapshot(s).outs).toEqual(before.outs);
  });
});

describe('refusals', () => {
  test('a DO shipped from the spec bucket after the repair: refused and listed', () => {
    const s = seeded();
    runRepair(s);
    s.insert({ type: 'OUT', item: ITEM, wh: WH, vk: RED, qty: 1, createdAt: '2026-11-10T07:00:00.000000', docNo: 'HC-DO-new', doId: 'do-new' });
    const pair = gather(s);
    expect(pair.status).toBe('refused');
    expect(pair.problems.some((m) => m.includes('written after the repair') && m.includes('HC-DO-new'))).toBe(true);
  });

  test('a lot the repair opened given units back and drawn again: refused', () => {
    const s = seeded();
    runRepair(s);
    const toRow = s.movements.find((m) => m.docNo === REPAIR_DOC_NO && m.vk === BLUE);
    const lot = s.lots.find((l) => l.movementId === toRow.id);
    const c = s.consumptions.find((x) => x.lotId === lot.id);
    s.consumptions = s.consumptions.filter((x) => x !== c); // a DO cancellation gave it back
    lot.qtyRemaining += c.qty;
    const pair = gather(s);
    expect(pair.status).toBe('refused');
    expect(pair.problems.some((m) => m.includes('holds') && m.includes('again'))).toBe(true);
  });

  test('a consumption on a repair lot by a movement created after the repair: refused', () => {
    const g = {
      itemCode: ITEM, warehouseId: WH, specVk: RED, reverted: false,
      from: { id: 'f', qty: -1, totalCostSen: 900, createdAt: REPAIR_TS },
      to: [{ id: 't', qty: 1, unitCostSen: 900 }],
      fromConsumptions: [{ id: 'c1', lotId: 'L1', qty: 1, unitCostSen: 900 }],
      emptyLots: [{ lotId: 'L1', vk: '', qtyReceived: 5, qtyRemaining: 4 }],
      mintedLots: [{ lotId: 'M1', movementId: 't', vk: RED, qtyReceived: 1, qtyRemaining: 0 }],
      mintedConsumptions: [{ id: 'c2', lotId: 'M1', movementId: 'o', qty: 1, totalCostSen: 900, movementType: 'OUT', sourceDocType: 'DO', movementCreatedAt: '2026-11-10T06:00:00.000000', consumedAt: null }],
      outs: [{ movementId: 'o', qty: 1, totalCostSen: 900, consumedQty: 1, doId: 'd', docNo: 'X', month: '2026-11' }],
      later: [],
    };
    expect(planGroupRevert(g).status).toBe('refused');
    expect(planGroupRevert({ ...g, mintedConsumptions: [{ ...g.mintedConsumptions[0], movementCreatedAt: '2026-09-01T00:00:00.000000' }] }).status).toBe('revert');
    // consumed_at far from the repair's own transaction: written later.
    expect(planGroupRevert({ ...g, mintedConsumptions: [{ ...g.mintedConsumptions[0], movementCreatedAt: '2026-09-01T00:00:00.000000', consumedAt: Date.parse('2026-11-10T08:00:00Z') }] }).status).toBe('refused');
    expect(planGroupRevert({ ...g, mintedConsumptions: [{ ...g.mintedConsumptions[0], movementCreatedAt: '2026-09-01T00:00:00.000000', consumedAt: Date.parse(`${REPAIR_TS}Z`) }] }).status).toBe('revert');
  });

  test('rows that are not the shape the repair writes are not grouped', () => {
    const notes = (side, qty, vk) => movementNotes({ side, qty, specVk: vk, ref: REPAIR_DOC_NO });
    const { groups, problems } = groupRepairRows([
      { id: 'a', itemCode: ITEM, warehouseId: WH, vk: '', qty: -2, notes: notes('from', -2, RED), createdAt: REPAIR_TS },
      { id: 'b', itemCode: ITEM, warehouseId: WH, vk: RED, qty: 2, notes: notes('to', 2, RED), createdAt: REPAIR_TS },
      { id: 'c', itemCode: ITEM, warehouseId: WH, vk: BLUE, qty: 1, notes: notes('to', 1, BLUE), createdAt: REPAIR_TS },
      { id: 'd', itemCode: ITEM, warehouseId: WH, vk: '', qty: -1, notes: 'something else', createdAt: REPAIR_TS },
    ]);
    expect(groups.map((g) => [g.specVk, g.from.map((r) => r.id), g.to.map((r) => r.id)])).toEqual([[RED, ['a'], ['b']]]);
    expect(problems).toHaveLength(2);
  });
});

test('notes: the spec is read back from the repair notes; the revert notes name the run and the repair row, no money', () => {
  expect(specOfRepairNotes(movementNotes({ side: 'from', qty: -3, specVk: RED, ref: REPAIR_DOC_NO }))).toBe(RED);
  expect(specOfRepairNotes('free text')).toBeNull();
  const n = revertNotes({ side: 'spec', qty: -3, specVk: RED, fromRowId: 'abc', ref: REVERT_DOC });
  expect(n).toContain('run 42827135058');
  expect(n).toContain(revertMarker('abc'));
  expect(n).toContain('spec bucket -3');
  expect(n).not.toMatch(/RM|sen\b/);
});

test('bucket arithmetic: before-repair from the rows, after-revert from the plan', () => {
  const now = new Map([['', { mov: 48, lots: 37 }], [RED, { mov: 0, lots: 0 }]]);
  const pre = bucketsBeforeRepair(now, [{ vk: '', qty: -3 }, { vk: RED, qty: 2 }, { vk: RED, qty: 1 }], [{ vk: RED, qtyRemaining: 0 }], [{ vk: '', qty: 3 }]);
  expect(pre.get('')).toEqual({ mov: 51, lots: 40 });
  expect(pre.get(RED)).toEqual({ mov: -3, lots: 0 });
  const after = bucketsAfterRevert(now, [{ status: 'revert', specVk: RED, emptyPlus: { qty: 3 }, emptyRestores: [{ add: 3 }], specMinus: { qty: -3, consumes: [{ qty: 2 }, { qty: 1 }] }, mintedRestores: [{ add: 2 }, { add: 1 }] }]);
  expect(sameBuckets(after, pre)).toBe(true);
});
