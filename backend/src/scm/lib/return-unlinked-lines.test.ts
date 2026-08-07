// The two RETURN chains inherit the rule that closed the delivery and receiving
// sides on 2026-08-04 (docs/unlinked-line-duplicate-coe.md).
//
// A production scan the same day found ZERO rows of this shape on either chain,
// so these guards are preventative. That is the argument FOR adding them, not
// against: the cost is one query on a path already doing several, and the cost
// of not having it on the delivery side was three weeks of a double deduction
// nobody could see.

import { describe, it, expect } from 'vitest';
import { unlinkedReturnResponse, type UnlinkedReturnOffender } from './return-unlinked-lines';

const off = (itemCode: string, qty = 1, parentNo = '2990-DO-2607-017'): UnlinkedReturnOffender =>
  ({ lineRef: '0', itemCode, qty, parentNo });

describe('unlinkedReturnResponse', () => {
  it('names the Delivery Order and the items, for a delivery return', () => {
    const body = unlinkedReturnResponse([off('NTYR-PILLOW'), off('MATTRESS-Q')], 'delivery');
    expect(body.error).toBe('unlinked_do_lines');
    expect(body.parentNo).toBe('2990-DO-2607-017');
    expect(body.message).toContain('Delivery Order 2990-DO-2607-017');
    expect(body.message).toContain('NTYR-PILLOW, MATTRESS-Q');
    expect(body.message).toContain('2 line(s)');
  });

  it('names the Goods Receipt for a purchase return, with its own error code', () => {
    // Distinct codes so the two surfaces can show their own copy — a DR and a
    // PR fail for the same reason but the operator's next action differs.
    const body = unlinkedReturnResponse([off('FOAM-A', 3, '2990-GRN-2607-001')], 'purchase');
    expect(body.error).toBe('unlinked_grn_lines');
    expect(body.message).toContain('Goods Receipt 2990-GRN-2607-001');
    expect(body.message).toContain('1 line(s)');
  });

  it('de-duplicates the item list but counts LINES', () => {
    // Three offending rows, two distinct items: the count is of rows, because
    // that is what the operator has to fix.
    const body = unlinkedReturnResponse(
      [off('NTYR-PILLOW'), off('NTYR-PILLOW'), off('MATTRESS-Q')], 'delivery',
    );
    expect(body.message).toContain('3 line(s)');
    expect(body.message).toContain('NTYR-PILLOW, MATTRESS-Q');
    expect(body.offenders).toHaveLength(3);
  });

  it('explains WHY it is refused, not just that it is', () => {
    const body = unlinkedReturnResponse([off('NTYR-PILLOW')], 'delivery');
    expect(body.message).toContain('the same goods can be returned again');
  });
});
