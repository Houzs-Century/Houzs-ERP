import { describe, expect, it } from 'vitest';
import { isLocalDeliveryGeography, isShippedOrderDeliveredNow } from './deliver-due-shipped';

/* The daily local "actually delivered" sweep (owner 2026-10-27). The async sweep
   is thin Supabase glue; its two decisions are pure and pinned here:
     · isLocalDeliveryGeography — East Malaysia + Singapore are NEVER swept by
       do_date (their delivered signal is the HC Delivery sheet).
     · isShippedOrderDeliveredNow — a SHIPPED order is delivered only once its DO
       date has PASSED and a driver is on it (到日子 + 有司机). */

describe('isLocalDeliveryGeography — who the date+driver sweep may deliver', () => {
  it('peninsular Malaysia is local', () => {
    expect(isLocalDeliveryGeography('Selangor', 'Malaysia')).toBe(true);
    expect(isLocalDeliveryGeography('Kuala Lumpur', null)).toBe(true);
    expect(isLocalDeliveryGeography('Pulau Pinang', 'Malaysia')).toBe(true);
  });

  it('East Malaysia is NOT local (its do_date is a ship-out date)', () => {
    expect(isLocalDeliveryGeography('Sabah', 'Malaysia')).toBe(false);
    expect(isLocalDeliveryGeography('Sarawak', null)).toBe(false);
    expect(isLocalDeliveryGeography('labuan', 'Malaysia')).toBe(false);
  });

  it('Singapore is NOT local — caught by country, even on a Malaysian-looking state', () => {
    expect(isLocalDeliveryGeography('Central', 'Singapore')).toBe(false);
    expect(isLocalDeliveryGeography(null, ' SINGAPORE ')).toBe(false);
  });

  it('missing geography defaults to local (swept on the strict date+driver rule)', () => {
    expect(isLocalDeliveryGeography(null, null)).toBe(true);
  });
});

describe('isShippedOrderDeliveredNow — 到日子 + 有司机', () => {
  const today = '2026-10-27';

  it('delivers when the DO date has passed AND a driver is on it', () => {
    expect(isShippedOrderDeliveredNow({ doDate: '2026-10-26', today, hasDriver: true })).toBe(true);
    expect(isShippedOrderDeliveredNow({ doDate: '2026-10-01T00:00:00Z', today, hasDriver: true })).toBe(true);
  });

  it('does NOT deliver on the delivery day itself — only once it has passed', () => {
    expect(isShippedOrderDeliveredNow({ doDate: '2026-10-27', today, hasDriver: true })).toBe(false);
  });

  it('does NOT deliver a future-dated order', () => {
    expect(isShippedOrderDeliveredNow({ doDate: '2026-10-28', today, hasDriver: true })).toBe(false);
  });

  it('does NOT deliver without a driver, however old the DO date', () => {
    expect(isShippedOrderDeliveredNow({ doDate: '2026-09-01', today, hasDriver: false })).toBe(false);
  });

  it('does NOT deliver when there is no DO date', () => {
    expect(isShippedOrderDeliveredNow({ doDate: null, today, hasDriver: true })).toBe(false);
    expect(isShippedOrderDeliveredNow({ doDate: '', today, hasDriver: true })).toBe(false);
  });
});
