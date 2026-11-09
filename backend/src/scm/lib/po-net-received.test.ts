import { describe, expect, test } from 'vitest';
import { grnLineNetReceived } from './po-net-received';

describe('grnLineNetReceived', () => {
  test('a return the supplier replaces re-opens the units', () => {
    expect(grnLineNetReceived({ qty_accepted: 3, returned_qty: 2, returned_closed_qty: 0 })).toBe(1);
  });
  test('a return with no replacement keeps the units received', () => {
    expect(grnLineNetReceived({ qty_accepted: 3, returned_qty: 2, returned_closed_qty: 2 })).toBe(3);
  });
  test('mixed: only the replaced part re-opens', () => {
    expect(grnLineNetReceived({ qty_accepted: 3, returned_qty: 2, returned_closed_qty: 1 })).toBe(2);
  });
  test('nulls (rows read before the column existed) read as today', () => {
    expect(grnLineNetReceived({ qty_accepted: 2, returned_qty: 1, returned_closed_qty: null })).toBe(1);
  });
  test('never negative', () => {
    expect(grnLineNetReceived({ qty_accepted: 1, returned_qty: 5, returned_closed_qty: 0 })).toBe(0);
  });
});
