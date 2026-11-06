import { describe, expect, it } from 'vitest';
import { receiptItems, warehouseTone } from './scan-gr-check';

describe('what a scanned card receives', () => {
  it('counts only the rows that reach the draft', () => {
    expect(receiptItems({ lines: [
      { poItemId: 'p1', gift: null, qty: 2 },
      { poItemId: null, gift: { itemCode: 'PILLOW' }, qty: 1 },
      { poItemId: null, gift: null, qty: 5 },
    ] })).toBe(3);
  });
});

describe('warehouse colours', () => {
  it('KL and SBH never share one, and a name always keeps its own', () => {
    expect(warehouseTone('KL WAREHOUSE', 5)).not.toBe(warehouseTone('SBH WAREHOUSE', 5));
    expect(warehouseTone('MELAKA', 5)).toBe(warehouseTone('melaka', 5));
  });
});
