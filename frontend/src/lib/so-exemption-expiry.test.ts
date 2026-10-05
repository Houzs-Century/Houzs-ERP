import { describe, expect, test } from 'vitest';

import { soExemptionExpiryOf } from './so-exemption-expiry';

describe('soExemptionExpiryOf — the Sales Exemption Expiry Date cell', () => {
  test('BUG-51: an ERP-created order shows its delivery date, the value AutoCount holds', () => {
    expect(soExemptionExpiryOf({ sales_exemption_expiry: null, customer_delivery_date: '2026-10-03' })).toBe('2026-10-03');
  });

  test('a migrated order keeps the date copied from AutoCount', () => {
    expect(soExemptionExpiryOf({ sales_exemption_expiry: '2026-08-20', customer_delivery_date: '2026-08-25' })).toBe('2026-08-20');
  });

  test('null when neither is recorded', () => {
    expect(soExemptionExpiryOf({})).toBeNull();
    expect(soExemptionExpiryOf(null)).toBeNull();
    expect(soExemptionExpiryOf({ sales_exemption_expiry: '', customer_delivery_date: null })).toBeNull();
  });
});
