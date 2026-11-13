import { describe, expect, it } from 'vitest';

import { exemptionExpirySeed, soExemptionExpiryOf } from './so-exemption-expiry';

describe('exemptionExpirySeed — the original delivery date, written once (BUG-51)', () => {
  it('seeds the first delivery date an order carries', () => {
    expect(exemptionExpirySeed(null, '2026-10-03')).toBe('2026-10-03');
    expect(exemptionExpirySeed(undefined, '2026-10-03')).toBe('2026-10-03');
  });

  it('never moves once set: HC11494 was rescheduled 03/10 -> 10/10 and must keep 03/10', () => {
    expect(exemptionExpirySeed('2026-10-03', '2026-10-10')).toBeNull();
  });

  it('nothing to seed when no delivery date arrives', () => {
    expect(exemptionExpirySeed(null, null)).toBeNull();
    expect(exemptionExpirySeed(null, '')).toBeNull();
  });
});

describe('soExemptionExpiryOf — the column value the Overdue rule reads (same chain as the frontend)', () => {
  it('frozen original, then the AutoCount book, then the delivery date', () => {
    expect(soExemptionExpiryOf({ sales_exemption_expiry: '2026-10-26', ac_sales_exemption_expiry: '2026-12-31', customer_delivery_date: '2026-11-27' })).toBe('2026-10-26');
    expect(soExemptionExpiryOf({ sales_exemption_expiry: null, ac_sales_exemption_expiry: '2026-12-31', customer_delivery_date: '2026-11-27' })).toBe('2026-12-31');
    expect(soExemptionExpiryOf({ sales_exemption_expiry: '', ac_sales_exemption_expiry: null, customer_delivery_date: '2026-11-27' })).toBe('2026-11-27');
    expect(soExemptionExpiryOf({ sales_exemption_expiry: null, ac_sales_exemption_expiry: null, customer_delivery_date: null })).toBeNull();
  });
});
