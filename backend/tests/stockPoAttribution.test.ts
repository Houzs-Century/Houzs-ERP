/* Stock POs matched to the orders that later took their goods, first in first
   out per warehouse and item (owner, 2026-10-17). */
import { describe, expect, test } from 'vitest';
import { attributeStockPos } from '../src/scm/lib/stock-po-attribution';

describe('stock PO attribution', () => {
  test('oldest receipt first; only receipts in by the delivery; the rest is older stock', () => {
    const r = attributeStockPos([
      { warehouse: 'KL', itemCode: 'M1', category: 'MATTRESS', poId: 'po-b', poDate: '2026-08-01', receivedAt: '2026-08-20', qty: 2 },
      { warehouse: 'KL', itemCode: 'M1', category: 'MATTRESS', poId: 'po-a', poDate: '2026-07-01', receivedAt: '2026-07-20', qty: 1 },
      { warehouse: 'PG', itemCode: 'M1', category: 'MATTRESS', poId: 'po-c', poDate: '2026-07-01', receivedAt: '2026-07-10', qty: 5 },
    ], [
      { warehouse: 'KL', itemCode: 'M1', doDate: '2026-07-15', qty: 1, soDate: '2026-07-10', needDate: '2026-07-15' },
      { warehouse: 'KL', itemCode: 'M1', doDate: '2026-09-01', qty: 2, soDate: '2026-08-25', needDate: '2026-09-01' },
    ]);
    /* July 15: nothing received yet in KL -> older stock. Sept 1: po-a (1) then po-b (1). */
    expect(r.fromOlderStockUnits).toBe(1);
    expect(r.total.units).toBe(2);
    /* po-a: 2026-07-01 -> SO 2026-08-25 = 55 days; po-b: 2026-08-01 -> 24 days; median 39.5 */
    expect(r.total.medianOrderedAheadDays).toBe(39.5);
    expect(r.byCategory.MATTRESS?.medianHeldDays).toBe(27.5);
    expect(r.unusedReceiptUnits).toBe(6);
  });
});
