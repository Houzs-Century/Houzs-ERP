import { describe, expect, test } from 'vitest';
import { effectiveSoDelivery } from './effective-delivery';

describe('effectiveSoDelivery — precedence', () => {
  test('the amended date beats the customer original', () => {
    expect(effectiveSoDelivery({
      customer_delivery_date: '2026-12-01',
      amended_delivery_date: '2026-10-15',
    })).toBe('2026-10-15');
  });

  test('with no amendment the original stands', () => {
    expect(effectiveSoDelivery({
      customer_delivery_date: '2026-12-01',
      amended_delivery_date: null,
    })).toBe('2026-12-01');
  });

  test('a NON-overridden line date is a stale mirror and never masks the amendment', () => {
    expect(effectiveSoDelivery({
      line_delivery_date: '2026-12-01',
      line_delivery_date_overridden: false,
      customer_delivery_date: '2026-12-01',
      amended_delivery_date: '2026-10-15',
    })).toBe('2026-10-15');
  });

  test('an OVERRIDDEN line date is a real per-line promise and outranks the header', () => {
    expect(effectiveSoDelivery({
      line_delivery_date: '2026-09-09',
      line_delivery_date_overridden: true,
      customer_delivery_date: '2026-12-01',
      amended_delivery_date: '2026-10-15',
    })).toBe('2026-09-09');
  });

  test('the override flag alone decides — the same dates flip the answer', () => {
    const dates = {
      line_delivery_date: '2026-09-09',
      customer_delivery_date: '2026-12-01',
      amended_delivery_date: '2026-10-15',
    };
    expect(effectiveSoDelivery({ ...dates, line_delivery_date_overridden: true })).toBe('2026-09-09');
    expect(effectiveSoDelivery({ ...dates, line_delivery_date_overridden: false })).toBe('2026-10-15');
  });

  test('a mirror is still used as a LAST resort when the header carries no date', () => {
    expect(effectiveSoDelivery({
      line_delivery_date: '2026-11-11',
      line_delivery_date_overridden: false,
      customer_delivery_date: null,
      amended_delivery_date: null,
    })).toBe('2026-11-11');
  });

  test('genuinely undated demand stays null', () => {
    expect(effectiveSoDelivery({})).toBeNull();
    expect(effectiveSoDelivery({ customer_delivery_date: null, amended_delivery_date: null })).toBeNull();
    expect(effectiveSoDelivery({ customer_delivery_date: '' })).toBeNull();
  });
});

describe('effectiveSoDelivery — the shapes the transports actually deliver', () => {
  test('camelCase is read as well as snake_case', () => {
    expect(effectiveSoDelivery({
      customerDeliveryDate: '2026-12-01',
      amendedDeliveryDate: '2026-10-15',
    })).toBe('2026-10-15');
    expect(effectiveSoDelivery({
      lineDeliveryDate: '2026-09-09',
      lineDeliveryDateOverridden: true,
      customerDeliveryDate: '2026-12-01',
    })).toBe('2026-09-09');
  });

  test('a mixed row prefers the snake_case column, matching the dual-reads it replaces', () => {
    expect(effectiveSoDelivery({ amended_delivery_date: '2026-10-15' })).toBe('2026-10-15');
    expect(effectiveSoDelivery({ amendedDeliveryDate: '2026-10-15' })).toBe('2026-10-15');
  });

  test('Date objects normalise instead of throwing', () => {
    const d = effectiveSoDelivery({ customer_delivery_date: new Date('2026-12-01T00:00:00Z') });
    expect(d).toBe('2026-12-01');
    expect(() => (d as string).localeCompare('2026-01-01')).not.toThrow();
  });

  test('a timestamp is truncated to its day', () => {
    expect(effectiveSoDelivery({ amended_delivery_date: '2026-10-15T00:00:00Z' })).toBe('2026-10-15');
  });
});
