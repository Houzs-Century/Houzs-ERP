/* effectiveSoDelivery — the ONE answer to "when is this order due".
 *
 * The bug this function exists to kill: the delivery board read
 * `amended_delivery_date ?? customer_delivery_date` while MRP and the stock
 * allocator read `line_delivery_date ?? customer_delivery_date`, so a customer
 * who rescheduled moved on one screen and not the other. These pin the chain
 * itself; mrp.test.ts pins that the ALLOCATION order actually moves with it.
 */
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

  /* THE TRAP. `line_delivery_date` is a MIRROR of the header date while
     `line_delivery_date_overridden` is false (mig 0172's
     apply_so_header_followers writes the pair), and a reschedule writes the
     HEADER only — so on a rescheduled order the mirror still holds the ORIGINAL
     date. Reading the line date first without consulting the flag keeps serving
     the pre-amendment answer no matter what the header fallback says. On
     production 2026-08-18 all 5 live lines on the 3 moved orders were exactly
     this shape, so a header-only fix would have moved ZERO of them. */
  test('a NON-overridden line date is a stale mirror and never masks the amendment', () => {
    expect(effectiveSoDelivery({
      line_delivery_date: '2026-12-01',            // mirror, written when the header said 12-01
      line_delivery_date_overridden: false,
      customer_delivery_date: '2026-12-01',
      amended_delivery_date: '2026-10-15',         // …then the customer rescheduled
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

  /* Step 4 of the chain. This function must never return FEWER dates than the
     one it replaced, or a line MRP used to show would silently vanish from the
     plan as "undated". */
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
    expect(effectiveSoDelivery({ customer_delivery_date: '' })).toBeNull();   // '' is not a date
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
    // delivery-planning.ts read `r.amendedDeliveryDate ?? r.amended_delivery_date`;
    // either spelling arriving alone must give the same answer.
    expect(effectiveSoDelivery({ amended_delivery_date: '2026-10-15' })).toBe('2026-10-15');
    expect(effectiveSoDelivery({ amendedDeliveryDate: '2026-10-15' })).toBe('2026-10-15');
  });

  /* The repair scripts drive so-stock-allocation through a postgres shim that
     returns Date OBJECTS, and `.localeCompare` on a Date threw mid-recompute in
     production on 2026-08-10. The allocator's `dateKey` helper was the patch;
     this function absorbed it, so the Date branch is load-bearing. */
  test('Date objects normalise instead of throwing', () => {
    const d = effectiveSoDelivery({ customer_delivery_date: new Date('2026-12-01T00:00:00Z') });
    expect(d).toBe('2026-12-01');
    expect(() => (d as string).localeCompare('2026-01-01')).not.toThrow();
  });

  test('a timestamp is truncated to its day', () => {
    expect(effectiveSoDelivery({ amended_delivery_date: '2026-10-15T00:00:00Z' })).toBe('2026-10-15');
  });
});
