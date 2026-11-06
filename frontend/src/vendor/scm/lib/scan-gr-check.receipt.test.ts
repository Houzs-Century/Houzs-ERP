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
  it('the selling warehouses each have their own, and a name always keeps it', () => {
    const tones = ['KL', 'SBH', 'PG', 'SRW', 'JB'].map((w) => warehouseTone(`${w} WAREHOUSE`, 8));
    expect(new Set(tones).size).toBe(5);
    expect(warehouseTone('MELAKA', 8)).toBe(warehouseTone('melaka', 8));
  });
});
