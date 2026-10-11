// ----------------------------------------------------------------------------
// A line nobody ever ordered must SAY so, on both surfaces.
//
// HC-SO-012949 sold a CODY single bedframe on 2026-07-27. No purchase order on
// company 1 carries that code, and AutoCount's own export has none either — the
// gap is in the account book, not in our copy of it. The line sat
// IN_PRODUCTION reading PENDING, which is what an ordinary not-yet-arrived line
// reads, so nothing on the document told a buyer to act.
//
// The two things this pins, because both are how the bug would come back:
//   1. the chip renders INSTEAD OF the dash — the cell's early return fires
//      exactly when there are no other chips, which is the state this line is
//      always in;
//   2. the desktop and the mobile row render off the SAME server field, and
//      neither of them computes the rule.
// ----------------------------------------------------------------------------
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { SoSourceChips, type SoLineSourceFields } from './SoSourceChips';
import { PurchaseGapRowMobile } from '../mobile/source-chips';

const bare: SoLineSourceFields = {
  item_group: 'bedframe',
  stock_status: 'PENDING',
  shipped_source_pos: [],
  ready_source_pos: [],
};

describe('no purchase order was ever raised for this line', () => {
  test('desktop: the chip replaces the dash, which is the state this line is always in', () => {
    render(<SoSourceChips line={{ ...bare, purchase_gap: true }} coverage="ready" />);
    expect(screen.getByText('No PO raised')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });

  test('desktop: it also shows while the coverage query is still loading', () => {
    /* The placeholder ("WORKING…") is honest about MRP, but this verdict does
       not come from MRP and no later query can change it. */
    render(<SoSourceChips line={{ ...bare, purchase_gap: true }} coverage="loading" />);
    expect(screen.getByText('No PO raised')).toBeTruthy();
  });

  test('desktop: a line with a purchase order is untouched', () => {
    render(<SoSourceChips line={{ ...bare, purchase_gap: false }} coverage="ready" />);
    expect(screen.queryByText('No PO raised')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });

  test('desktop: an absent field is NOT a claim — a surface that does not serve it stays silent', () => {
    /* The SO LIST drill-down renders the same component from a payload that
       does not carry this field. Undefined must read as "not known here",
       never as "no purchase order exists". */
    render(<SoSourceChips line={bare} coverage="ready" />);
    expect(screen.queryByText('No PO raised')).toBeNull();
  });

  test('mobile: the same server field, the same three answers', () => {
    const { container, rerender } = render(<PurchaseGapRowMobile on />);
    expect(screen.getByText('No PO raised - purchasing must order this')).toBeTruthy();
    rerender(<PurchaseGapRowMobile on={false} />);
    expect(container.textContent).toBe('');
    rerender(<PurchaseGapRowMobile on={null} />);
    expect(container.textContent).toBe('');
  });
});
