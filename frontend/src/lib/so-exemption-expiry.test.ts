import { describe, expect, test } from 'vitest';

import { soExemptionExpiryOf } from './so-exemption-expiry';

describe('soExemptionExpiryOf — the Sales Exemption Expiry Date cell', () => {
  test('BUG-51: an ERP-created order shows its delivery date, the value AutoCount holds', () => {
    expect(soExemptionExpiryOf({ sales_exemption_expiry: null, customer_delivery_date: '2026-10-03' })).toBe('2026-10-03');
  });

  test('a migrated order keeps the date copied from AutoCount', () => {
    expect(soExemptionExpiryOf({ sales_exemption_expiry: '2026-08-20', customer_delivery_date: '2026-08-25' })).toBe('2026-08-20');
  });

  test('HC-0122: with no frozen date, the AutoCount book value comes before the current delivery date', () => {
    expect(soExemptionExpiryOf({ sales_exemption_expiry: null, ac_sales_exemption_expiry: '2026-09-01', customer_delivery_date: '2026-10-23' })).toBe('2026-09-01');
    expect(soExemptionExpiryOf({ sales_exemption_expiry: '2026-08-20', ac_sales_exemption_expiry: '2026-09-01', customer_delivery_date: '2026-10-23' })).toBe('2026-08-20');
  });

  test('HC-0122: an order not in AutoCount with no frozen date shows its delivery date, not blank', () => {
    expect(soExemptionExpiryOf({ sales_exemption_expiry: null, ac_sales_exemption_expiry: null, customer_delivery_date: '2026-10-30' })).toBe('2026-10-30');
  });

  test('null when neither is recorded', () => {
    expect(soExemptionExpiryOf({})).toBeNull();
    expect(soExemptionExpiryOf(null)).toBeNull();
    expect(soExemptionExpiryOf({ sales_exemption_expiry: '', customer_delivery_date: null })).toBeNull();
  });
});
