/* Stock-PO receipts assigned to open orders by MRP's rule (owner, 2026-10-19):
   orders that existed on the receipt day, due within the horizon or overdue,
   earliest delivery first; shipped or already-assigned quantity is not open. */
import { describe, expect, test } from 'vitest';
import { allocateReceipts, type DemandLine } from '../src/scm/lib/receipt-so-assignment';

const d = (o: Partial<DemandLine>): DemandLine => ({ soItemId: 's1', soDocNo: 'SO-1', itemCode: 'M1', soDate: '2026-09-01', needDate: '2026-10-20', qty: 1, delivered: [], assigned: 0, ...o });
const r = (key: string, qty: number, receivedAt: string) => ({ key, grnId: 'g', poItemId: key, itemCode: 'M1', qty, receivedAt });

describe('receipt to order assignment', () => {
  test('earliest delivery first, only open quantity, only orders that existed', () => {
    const out = allocateReceipts([r('p1', 3, '2026-10-05')], [
      d({ soItemId: 'late', needDate: '2026-11-01' }),
      d({ soItemId: 'early', needDate: '2026-10-10', qty: 2, delivered: [{ date: '2026-10-01', qty: 1 }] }),
      d({ soItemId: 'future', soDate: '2026-10-06', needDate: '2026-10-08' }),
      d({ soItemId: 'taken', needDate: '2026-10-09', assigned: 1 }),
    ]);
    expect(out.map((a) => [a.soItemId, a.qty])).toEqual([['early', 1], ['late', 1]]);
  });

  test('no delivery date, or due beyond the horizon, is not assigned; receipts take turns by date', () => {
    const out = allocateReceipts([r('p2', 1, '2026-10-10'), r('p1', 1, '2026-10-01')], [
      d({ soItemId: 'nodate', needDate: null }),
      d({ soItemId: 'far', needDate: '2027-01-31' }),
      d({ soItemId: 'a', needDate: '2026-10-15' }),
      d({ soItemId: 'b', needDate: '2026-10-20' }),
    ]);
    expect(out.map((a) => [a.key, a.soItemId])).toEqual([['p1', 'a'], ['p2', 'b']]);
  });
});
