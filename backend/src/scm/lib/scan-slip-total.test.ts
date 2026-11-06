// HC-0214 (HC-SO-2611-002): the slip's AMOUNT column said 8888 / 8193 and its
// TOTAL said RM 8,888, but no line carried a unit price, so the background scan
// draft was created at RM 0 and was later moved to production at RM 0.
import { describe, expect, test } from 'vitest';
import { applySlipTotalToUnpricedLines } from './scan-slip-total';

const line = (unitPriceSen: number, qty = 1) => ({ itemCode: 'X', qty, unitPriceSen });

describe('applySlipTotalToUnpricedLines', () => {
  test('every line unpriced + slip total read: the total lands on the first line', () => {
    const items = [line(0), line(0), line(0)];
    applySlipTotalToUnpricedLines(items, 8888);
    expect(items.map((i) => i.unitPriceSen)).toEqual([888800, 0, 0]);
  });

  test('first line qty 2: unit price is the total over qty, so the line amount is the total', () => {
    const items = [line(0, 2), line(0)];
    applySlipTotalToUnpricedLines(items, 1000);
    expect(items[0]!.unitPriceSen).toBe(50000);
  });

  test('a line that already carries a price is left alone', () => {
    const items = [line(0), line(819300)];
    applySlipTotalToUnpricedLines(items, 8888);
    expect(items.map((i) => i.unitPriceSen)).toEqual([0, 819300]);
  });

  test('no slip total read: nothing is invented', () => {
    const items = [line(0)];
    applySlipTotalToUnpricedLines(items, null);
    applySlipTotalToUnpricedLines(items, 0);
    expect(items[0]!.unitPriceSen).toBe(0);
  });

  test('no lines: no-op', () => {
    const items: Array<ReturnType<typeof line>> = [];
    applySlipTotalToUnpricedLines(items, 8888);
    expect(items).toEqual([]);
  });
});
