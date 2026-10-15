// The SO list "Sales Exemption Expiry Date" column, after the BUG-51 repoint
// (owner 2026-10-15): it shows the REAL AutoCount sales-exemption expiry
// (public.sales_orders.expiry_date), keyed by the order's linked book doc no —
// NOT the ERP's frozen sales_exemption_expiry (the original delivery date) and
// NOT the delivery date. acExemptionExpiryByDoc is the keying this column rests
// on; it must leave non-AutoCount orders blank.
import { describe, expect, it } from 'vitest';

import { acExemptionExpiryByDoc } from './so-list-rows';

describe('acExemptionExpiryByDoc — the SO list Sales Exemption Expiry Date (BUG-51 repoint)', () => {
  it('maps a linked SO to the AutoCount mirror expiry for its book doc no', () => {
    const linked = new Map([
      ['HC-SO-000001', 'SO-000111'],
      ['HC-SO-000002', 'SO-000222'],
    ]);
    const mirror = [
      { doc_no: 'SO-000111', expiry_date: '2026-12-31' },
      { doc_no: 'SO-000222', expiry_date: '2027-03-01' },
    ];
    const out = acExemptionExpiryByDoc(linked, mirror);
    expect(out.get('HC-SO-000001')).toBe('2026-12-31');
    expect(out.get('HC-SO-000002')).toBe('2027-03-01');
  });

  it('leaves an order with no AutoCount link absent, so the column renders blank', () => {
    const linked = new Map<string, string>(); // this order is not in AutoCount
    const mirror = [{ doc_no: 'SO-000111', expiry_date: '2026-12-31' }];
    expect(acExemptionExpiryByDoc(linked, mirror).has('HC-SO-000009')).toBe(false);
  });

  it('leaves a linked order absent when the mirror carries no expiry for its book doc', () => {
    const linked = new Map([['HC-SO-000003', 'SO-000333']]);
    const mirror = [
      { doc_no: 'SO-000333', expiry_date: null }, // in the book, but no exemption date
      { doc_no: 'SO-000999', expiry_date: '2026-10-10' }, // a different order
    ];
    expect(acExemptionExpiryByDoc(linked, mirror).has('HC-SO-000003')).toBe(false);
  });

  it('consults only the mirror expiry — never the delivery date', () => {
    // No mirror row at all: even a linked order stays blank. The delivery date is
    // irrelevant to this column now (that was the BUG-51 mislabel being fixed).
    const linked = new Map([['HC-SO-000004', 'SO-000444']]);
    expect(acExemptionExpiryByDoc(linked, []).size).toBe(0);
  });
});
