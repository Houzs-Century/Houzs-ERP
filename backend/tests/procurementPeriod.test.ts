/* Procurement Overview, period edition (owner, 2026-10-17): every figure
   follows the period; "open" and "late" are as of the period's last day. */
import { describe, expect, test } from 'vitest';
import { procurementPeriod, deadStock, type PLine } from '../src/scm/lib/procurement-period';

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
    ], '2026-10-01', '2026-10-31', '2026-10-17', 'original');
    expect(r.asOf).toBe('2026-10-17');
    expect(r.total.raised).toMatchObject({ pos: 1, lines: 1, sen: 1000_00, receivedSen: 400_00, openSen: 600_00 });
    expect(r.total.due).toMatchObject({ lines: 2, sen: 2000_00, openSen: 1600_00 });
    expect(r.total.receivedSen).toBe(400_00);
    expect(r.overdue.map((x) => [x.poId, x.daysLate])).toEqual([['p2', 12]]);
  });

  test('a past month is judged at its last day, not today', () => {
    const l = line({ poDate: '2026-08-01', originalDue: '2026-08-20', promised: '2026-08-20', receipts: [{ date: '2026-09-05', qty: 10, rejected: 0 }] });
    const aug = procurementPeriod([l], '2026-08-01', '2026-08-31', '2026-10-17', 'original');
    expect(aug.asOf).toBe('2026-08-31');
    expect(aug.total.open).toMatchObject({ lines: 1, late: 1, sen: 1000_00 });
    expect(aug.total.open.buckets.late5.lines).toBe(1);
    const oct = procurementPeriod([l], '2026-10-01', '2026-10-17', '2026-10-17', 'original');
    expect(oct.total.open.lines).toBe(0);
  });

  test('due in the next 3 days, and the basis switch', () => {
    const l = line({ originalDue: '2026-10-10', promised: '2026-10-19' });
    expect(procurementPeriod([l], '2026-10-01', '2026-10-17', '2026-10-17', 'original').overdue).toHaveLength(1);
    const latest = procurementPeriod([l], '2026-10-01', '2026-10-17', '2026-10-17', 'promised');
    expect(latest.overdue).toHaveLength(0);
    expect(latest.dueSoon.map((x) => x.daysLate)).toEqual([-2]);
  });

  test('supplier lead and on time over the receipts in the period', () => {
    const r = procurementPeriod([
      line({ receipts: [{ date: '2026-10-18', qty: 10, rejected: 0 }] }),
      line({ poId: 'p2', receipts: [{ date: '2026-10-25', qty: 10, rejected: 0 }] }),
    ], '2026-10-01', '2026-10-31', '2026-10-31', 'original');
    expect(r.total.supplierLead).toMatchObject({ receipts: 2, avgDays: 19.5, onTimePct: 50, latePct: 50, avgDaysLate: 5 });
  });

  test('order later by the slack 80% of lines still keep', () => {
    const lines = Array.from({ length: 10 }, (_, i) => line({
      poId: `p${i}`, needDate: '2026-11-10', receipts: [{ date: `2026-10-${String(20 + i).padStart(2, '0')}`, qty: 10, rejected: 0 }],
    }));
    const o = procurementPeriod(lines, '2026-10-01', '2026-10-31', '2026-10-31', 'original').total.ordering;
    expect(o.measured).toBe(10);
    expect(o.avgOrderAheadDays).toBe(18);
    expect(o.avgDueBeforeNeedDays).toBe(21);
    expect(o.p20ArrivedBeforeNeedDays).toBe(13);
    expect(o.canOrderLaterDays).toBe(13);
    const few = procurementPeriod(lines.slice(0, 3), '2026-10-01', '2026-10-31', '2026-10-31', 'original').total.ordering;
    expect(few.canOrderLaterDays).toBeNull();
  });

  test('dead stock: idle since the last time it went out, or since it first arrived', () => {
    const r = deadStock([
      { warehouse: 'KL', category: 'SOFA', itemCode: 'A', name: null, qty: 1, valueSen: 100, lastOut: '2026-10-01', firstMove: '2025-01-01' },
      { warehouse: 'KL', category: 'SOFA', itemCode: 'B', name: null, qty: 1, valueSen: 300, lastOut: '2026-05-01', firstMove: '2025-01-01' },
      { warehouse: 'PG', category: 'MATTRESS', itemCode: 'C', name: null, qty: 1, valueSen: 500, lastOut: null, firstMove: '2025-06-01' },
    ], '2026-10-17');
    expect(r).toMatchObject({ totalSen: 900, deadSen: 800, deadSkus: 2 });
    expect(r.byCategory.find((g) => g.key === 'SOFA')!.ages).toEqual({ d0to90: 100, d91to180: 300, d181to365: 0, d365plus: 0 });
    expect(r.byWarehouse.find((g) => g.key === 'PG')!.ages.d365plus).toBe(500);
    expect(r.top.map((x) => [x.itemCode, x.idleDays])).toEqual([['C', 503], ['B', 169]]);
  });
});
