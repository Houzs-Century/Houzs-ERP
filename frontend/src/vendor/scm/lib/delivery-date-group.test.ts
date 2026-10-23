/* Owner follow-up 2026-10-23: the Delivery Planning board defaults to EFFECTIVE
 * delivery date (amended ?? original customer date), earliest first, and the All
 * tab buckets rows by that date's month with a trailing "No date" group. These
 * tests pin the shared key/comparator/label so the sort and the month buckets
 * can never disagree.
 */
import { describe, expect, test } from 'vitest';
import {
  effectiveDeliveryDay,
  compareByDeliveryDate,
  deliveryMonthKey,
  deliveryMonthLabel,
  type DeliveryDateRow,
} from './delivery-date-group';

const row = (amended: string | null, customer: string | null): DeliveryDateRow => ({
  amended_delivery_date: amended,
  customer_delivery_date: customer,
});

describe('effectiveDeliveryDay', () => {
  test('prefers the amended date, falls back to the customer date, truncates to the day', () => {
    expect(effectiveDeliveryDay(row('2026-10-15', '2026-09-01'))).toBe('2026-10-15');
    expect(effectiveDeliveryDay(row(null, '2026-09-01'))).toBe('2026-09-01');
    expect(effectiveDeliveryDay(row('2026-10-15T08:30:00Z', null))).toBe('2026-10-15');
    expect(effectiveDeliveryDay(row(null, null))).toBeNull();
  });
});

describe('compareByDeliveryDate — default ordering', () => {
  test('earliest effective date first, no-date rows last', () => {
    const noDate = row(null, null);
    const oct = row('2026-10-20', null);
    const sep = row(null, '2026-09-05'); // customer-date fallback
    const aug = row('2026-08-01', '2026-12-31');
    const sorted = [noDate, oct, sep, aug].slice().sort(compareByDeliveryDate);
    expect(sorted.map(effectiveDeliveryDay)).toEqual(['2026-08-01', '2026-09-05', '2026-10-20', null]);
  });

  test('two no-date rows tie (stable)', () => {
    expect(compareByDeliveryDate(row(null, null), row(null, null))).toBe(0);
  });
});

describe('deliveryMonthKey / deliveryMonthLabel — month buckets', () => {
  test('key is YYYY-MM off the effective date; no date -> empty key', () => {
    expect(deliveryMonthKey(row('2026-10-15', null))).toBe('2026-10');
    expect(deliveryMonthKey(row(null, '2026-09-30'))).toBe('2026-09');
    expect(deliveryMonthKey(row(null, null))).toBe('');
  });

  test('label is YYYY/MM (app date order, no month name); empty key -> "No date"', () => {
    expect(deliveryMonthLabel('2026-10')).toBe('2026/10');
    expect(deliveryMonthLabel('2026-01')).toBe('2026/01');
    expect(deliveryMonthLabel('')).toBe('No date');
  });
});
