/* Procurement Overview, period edition (owner, 2026-10-17): every figure
   follows the period; "open" and "late" are as of the period's last day. */
import { describe, expect, test } from 'vitest';
import { stockScopeKeeps, procurementPeriod, deadStock, turnoverAndSellers, type PLine } from '../src/scm/lib/procurement-period';

const line = (o: Partial<PLine>): PLine => ({
  poId: 'p1', poNumber: 'PO-1', poDate: '2026-10-02', supplier: 'HOOKKA', category: 'BEDFRAME',
  itemCode: 'BF', itemDesc: null, soDocNo: null, qty: 10, priceSen: 100_00,
  originalDue: '2026-10-20', promised: '2026-10-20', needDate: null, receipts: [], ...o,
});

describe('procurement period', () => {
  test('raised, received and still to come in the period, by amount', () => {
    const r = procurementPeriod([
      line({ receipts: [{ date: '2026-10-10', qty: 4, rejected: 0 }] }),
      line({ poId: 'p2', poDate: '2026-09-15', originalDue: '2026-10-05', promised: '2026-10-05' }),
    ], '2026-10-01', '2026-10-31', '2026-10-31', '2026-10-17', 'original');
    expect(r.asOf).toBe('2026-10-17');
    expect(r.total.raised).toMatchObject({ pos: 1, lines: 1, sen: 1000_00, receivedSen: 400_00, openSen: 600_00 });
    expect(r.total.due).toMatchObject({ lines: 2, sen: 2000_00, openSen: 1600_00 });
    expect(r.total.receivedSen).toBe(400_00);
    expect(r.overdue.map((x) => [x.poId, x.daysLate])).toEqual([['p2', 12]]);
  });

  test('a past month is judged at its last day, not today', () => {
    const l = line({ poDate: '2026-08-01', originalDue: '2026-08-20', promised: '2026-08-20', receipts: [{ date: '2026-09-05', qty: 10, rejected: 0 }] });
    const aug = procurementPeriod([l], '2026-08-01', '2026-08-31', '2026-08-31', '2026-10-17', 'original');
    expect(aug.asOf).toBe('2026-08-31');
    expect(aug.total.open).toMatchObject({ lines: 1, late: 1, sen: 1000_00 });
    expect(aug.total.open.buckets.late5.lines).toBe(1);
    const oct = procurementPeriod([l], '2026-10-01', '2026-10-17', '2026-10-17', '2026-10-17', 'original');
    expect(oct.total.open.lines).toBe(0);
  });

  test('due in the next 3 days, and the basis switch', () => {
    const l = line({ originalDue: '2026-10-10', promised: '2026-10-19' });
    expect(procurementPeriod([l], '2026-10-01', '2026-10-17', '2026-10-17', '2026-10-17', 'original').overdue).toHaveLength(1);
    const latest = procurementPeriod([l], '2026-10-01', '2026-10-17', '2026-10-17', '2026-10-17', 'promised');
    expect(latest.overdue).toHaveLength(0);
    expect(latest.dueSoon.map((x) => x.daysLate)).toEqual([-2]);
  });

  test('supplier lead and on time over the receipts in the period', () => {
    const r = procurementPeriod([
      line({ receipts: [{ date: '2026-10-18', qty: 10, rejected: 0 }] }),
      line({ poId: 'p2', receipts: [{ date: '2026-10-25', qty: 10, rejected: 0 }] }),
    ], '2026-10-01', '2026-10-31', '2026-10-31', '2026-10-31', 'original');
    expect(r.total.supplierLead).toMatchObject({ receipts: 2, midDays: 19.5, onTimePct: 50, latePct: 50, avgDaysLate: 5 });
  });

  test('the drill-down lines: raised, due, received in the period, or still open at its end', () => {
    const r = procurementPeriod([
      line({ poId: 'a', poDate: '2026-10-02', receipts: [{ date: '2026-10-10', qty: 4, rejected: 0 }] }),
      line({ poId: 'b', poDate: '2026-08-01', originalDue: '2026-08-20', promised: '2026-08-20', receipts: [{ date: '2026-08-20', qty: 10, rejected: 0 }] }),
    ], '2026-10-01', '2026-10-17', '2026-10-17', '2026-10-17', 'original');
    expect(r.lines).toEqual([expect.objectContaining({ poId: 'a', raised: true, due: false, receivedQty: 4, receivedSen: 400_00, openQty: 6, openSen: 600_00 })]);
  });
  test('a drill-down line names its item and sales order, for the full PO list under the breakdown', () => {
    const r = procurementPeriod([line({ itemDesc: 'Bed frame queen', soDocNo: 'SO-1' })], '2026-10-01', '2026-10-31', '2026-10-31', '2026-10-25', 'original');
    expect(r.lines[0]).toMatchObject({ itemDesc: 'Bed frame queen', soDocNo: 'SO-1', openQty: 10, daysLate: 5 });
  });

  test('location scope: all, leave out display / display and service, or one kind', () => {
    expect(['warehouse', 'display', 'service', 'others'].filter((k) => stockScopeKeeps('all', k))).toEqual(['warehouse', 'display', 'service', 'others']);
    expect(['warehouse', 'display', 'service', 'others'].filter((k) => stockScopeKeeps('no_display', k))).toEqual(['warehouse', 'service', 'others']);
    expect(['warehouse', 'display', 'service', 'others'].filter((k) => stockScopeKeeps('no_display_service', k))).toEqual(['warehouse', 'others']);
    expect(['warehouse', 'display', 'service', 'others'].filter((k) => stockScopeKeeps('service', k))).toEqual(['service']);
  });

  test('due runs to the natural end of the period while received stops at today', () => {
    const r = procurementPeriod([line({ originalDue: '2026-10-28', promised: '2026-10-28' })], '2026-10-01', '2026-10-19', '2026-10-31', '2026-10-19', 'original');
    expect(r.total.due.lines).toBe(1);
    expect(procurementPeriod([line({ originalDue: '2026-10-28', promised: '2026-10-28' })], '2026-10-01', '2026-10-19', '2026-10-19', '2026-10-19', 'original').total.due.lines).toBe(0);
  });

  test('lead time is the median, so one line ordered months ahead does not drag it', () => {
    const r = procurementPeriod([
      line({ poDate: '2026-10-01', receipts: [{ date: '2026-10-11', qty: 1, rejected: 0 }] }),
      line({ poId: 'p2', poDate: '2026-10-01', receipts: [{ date: '2026-10-13', qty: 1, rejected: 0 }] }),
      line({ poId: 'p3', poDate: '2026-04-01', receipts: [{ date: '2026-10-18', qty: 1, rejected: 0 }] }),
    ], '2026-10-01', '2026-10-31', '2026-10-31', '2026-10-31', 'original');
    expect(r.total.supplierLead.midDays).toBe(12);
  });

  test('order later by the slack 80% of lines still keep', () => {
    const lines = Array.from({ length: 10 }, (_, i) => line({
      poId: `p${i}`, needDate: '2026-11-10', receipts: [{ date: `2026-10-${String(20 + i).padStart(2, '0')}`, qty: 10, rejected: 0 }],
    }));
    const o = procurementPeriod(lines, '2026-10-01', '2026-10-31', '2026-10-31', '2026-10-31', 'original').total.ordering;
    expect(o.measured).toBe(10);
    expect(o.avgOrderAheadDays).toBe(18);
    expect(o.avgDueBeforeNeedDays).toBe(21);
    expect(o.midPoDueBeforeNeedDays).toBe(21);
    expect(o.p20ArrivedBeforeNeedDays).toBe(13);
    expect(o.canOrderLaterDays).toBe(13);
    const few = procurementPeriod(lines.slice(0, 3), '2026-10-01', '2026-10-31', '2026-10-31', '2026-10-31', 'original').total.ordering;
    expect(few.canOrderLaterDays).toBeNull();
  });

  test('turnover: cost sent out in the period, a year of it, over the stock value now', () => {
    const stock = [
      { warehouse: 'KL', kind: 'warehouse', category: 'SOFA', itemCode: 'A', variantKey: '', name: 'Sofa A', qty: 10, valueSen: 300_000, lastOut: null, firstMove: null },
      { warehouse: 'PG', kind: 'warehouse', category: 'SOFA', itemCode: 'A', variantKey: '', name: 'Sofa A', qty: 5, valueSen: 150_000, lastOut: null, firstMove: null },
      { warehouse: 'KL', kind: 'warehouse', category: 'MATTRESS', itemCode: 'B', variantKey: '', name: 'Mat B', qty: 3, valueSen: 50_000, lastOut: null, firstMove: null },
    ];
    const r = turnoverAndSellers(stock, [
      { warehouse: 'KL', kind: 'warehouse', category: 'SOFA', costSen: 36_500, zeroCost: false },
      { warehouse: 'KL', kind: 'warehouse', category: 'SOFA', costSen: 0, zeroCost: true },
    ], [
      { itemCode: 'A', name: 'Sofa A', category: 'SOFA', qty: 6, salesSen: 9000 },
      { itemCode: 'A', name: 'Sofa A', category: 'SOFA', qty: 4, salesSen: 6000 },
    ], 30, 30);
    const sofa = r.byCategory.find((g) => g.key === 'SOFA')!;
    expect(sofa).toMatchObject({ stockSen: 450_000, outSen: 36_500, daysOfStock: 370 });
    expect(sofa.turnsPerYear).toBe(1);
    expect(r.byCategory.find((g) => g.key === 'MATTRESS')!.daysOfStock).toBeNull();
    expect(r.zeroCostOuts).toBe(1);
    expect(r.topSellers[0]).toMatchObject({ itemCode: 'A', qty: 10, salesSen: 15000, stockQty: 15, coverDays: 45 });
    expect(r.lowSellers.map((x) => [x.itemCode, x.soldQty])).toEqual([['B', 0], ['A', 10]]);
  });

  const row = (warehouse: string, kind: 'warehouse' | 'service' | 'display' | 'others', itemCode: string, variantKey: string, qty: number, unitSen: number, lastOut: string | null = null) =>
    ({ warehouse, kind, category: 'MATTRESS', itemCode, variantKey, name: null, qty, valueSen: qty * unitSen, lastOut, firstMove: '2025-01-01' });
  const D = '2026-10-17';

  test('no open order wants it: all of it is dead, wherever it is, with no days of outflow off', () => {
    const r = deadStock([row('KL', 'warehouse', 'P', '', 20, 100, '2026-10-16'), row('KL', 'warehouse', 'C', '', 1, 500)], D, new Map(), () => true);
    expect(r).toMatchObject({ deadSen: 2500, deadSkus: 2, bufferSen: 0 });
  });

  test("buffer, the owner's example: 30 on hand, 5 on dated orders, 25 undated -> 25 at cost", () => {
    const r = deadStock([row('KL', 'warehouse', 'M', 'size=Q', 30, 1000_00)], D, new Map([['M|size=Q', { scheduled: 5, unscheduled: 25 }]]), () => true);
    expect(r.bufferTop[0]).toMatchObject({ bufferQty: 25, valueSen: 25 * 1000_00 });
    expect(r.deadSen).toBe(0);
  });

  test('matched by variant: an order for fabric X does not take fabric Y', () => {
    const r = deadStock([row('KL', 'warehouse', 'BF', 'fabric=X', 10, 100), row('KL', 'warehouse', 'BF', 'fabric=Y', 2, 100)], D,
      new Map([['BF|fabric=X', { scheduled: 3, unscheduled: 4 }]]), () => true);
    /* X: 3 needed, 4 buffer, 3 dead. Y: no order, 2 dead. */
    expect(r).toMatchObject({ bufferSen: 400, deadSen: 500 });
  });

  test("the owner's display case: orders want 10, the warehouse holds 15, so service and display stock is dead", () => {
    const rows = [row('KL WH', 'warehouse', 'S', '', 15, 100), row('KL SVC', 'service', 'S', '', 2, 100), row('KL DSP', 'display', 'S', '', 2, 100)];
    const demand = new Map([['S|', { scheduled: 10, unscheduled: 0 }]]);
    const all = deadStock(rows, D, demand, () => true);
    expect(Object.fromEntries(all.byWarehouse.map((w) => [w.key, w.deadSen]))).toEqual({ 'KL WH': 500, 'KL SVC': 200, 'KL DSP': 200 });
    /* Display picked alone: still dead - the warehouse fills the orders first. */
    expect(deadStock(rows, D, demand, (r) => r.kind === 'display')).toMatchObject({ totalSen: 200, deadSen: 200, bufferSen: 0 });
  });

  test('orders take the warehouse, then service, then display; dated orders before undated, the rest dead', () => {
    const rows = [row('WH', 'warehouse', 'M', '', 3, 100), row('SVC', 'service', 'M', '', 2, 100), row('DSP', 'display', 'M', '', 2, 100)];
    /* 7 in the pool: 3 dated (warehouse), 3 undated (service 2 + display 1) -> buffer 3, dead 1 at display. */
    const r = deadStock(rows, D, new Map([['M|', { scheduled: 3, unscheduled: 3 }]]), () => true);
    const by = Object.fromEntries(r.byWarehouse.map((w) => [w.key, [w.bufferSen, w.deadSen]]));
    expect(by).toEqual({ WH: [0, 0], SVC: [200, 0], DSP: [100, 100] });
    /* The picked locations add up to All. */
    const sum = (['warehouse', 'service', 'display'] as const).map((k) => deadStock(rows, D, new Map([['M|', { scheduled: 3, unscheduled: 3 }]]), (x) => x.kind === k))
      .reduce((a, x) => ({ d: a.d + x.deadSen, b: a.b + x.bufferSen }), { d: 0, b: 0 });
    expect(sum).toEqual({ d: r.deadSen, b: r.bufferSen });
  });
});
