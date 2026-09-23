// The slip-date window's boundaries, which are the whole rule: 14 days back is
// IN, 15 is out, today is in, tomorrow is out. Asserted on the shared module
// because the desktop panel, the phone, the New-SO forms and the write core all
// call this one function — a boundary that moves here moves on every surface.
import { describe, expect, test } from 'vitest';
import {
  PAYMENT_SLIP_WINDOW_DAYS,
  checkPaymentSlipDate,
  paymentSlipDateWindow,
  shiftIsoDay,
} from './payment-slip-date';

const TODAY = '2026-09-23';

describe('payment slip date window', () => {
  test('the window is the last 14 days, inclusive of today', () => {
    expect(PAYMENT_SLIP_WINDOW_DAYS).toBe(14);
    expect(paymentSlipDateWindow(TODAY)).toEqual({ min: '2026-09-09', max: TODAY });
  });

  test('today and the 14th day back are both accepted', () => {
    expect(checkPaymentSlipDate(TODAY, TODAY).ok).toBe(true);
    expect(checkPaymentSlipDate('2026-09-09', TODAY).ok).toBe(true);
  });

  test('the 15th day back is refused as too old, and says the earliest date', () => {
    const v = checkPaymentSlipDate('2026-09-08', TODAY);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe('too_old');
    expect(v.reason).toContain('09/09/2026');
  });

  test('tomorrow is refused as a future date, not as too old', () => {
    const v = checkPaymentSlipDate('2026-09-24', TODAY);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe('future');
    expect(v.reason).toContain('23/09/2026');
  });

  test('every refusal stays a short sentence (SCM swaps long ones for a generic line)', () => {
    for (const d of ['2026-01-01', '2027-01-01', 'not-a-date']) {
      const v = checkPaymentSlipDate(d, TODAY);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason.length).toBeLessThan(200);
    }
  });

  test('the window crosses a month and a year boundary by calendar days, not by 30', () => {
    expect(paymentSlipDateWindow('2026-01-05').min).toBe('2025-12-22');
    expect(paymentSlipDateWindow('2026-03-01').min).toBe('2026-02-15');
    expect(shiftIsoDay('2028-03-01', -1)).toBe('2028-02-29');
  });

  test('a date that is not a real calendar day is refused, never shifted into one', () => {
    expect(shiftIsoDay('2026-02-31', -14)).toBe('');
    const v = checkPaymentSlipDate('2026-02-31', TODAY);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('unreadable');
  });

  test('an unreadable TODAY judges nothing rather than refusing everything', () => {
    // A caller whose clock helper returned junk must not turn every payment
    // into a refusal — that would shut the screen, not protect the books.
    expect(checkPaymentSlipDate(TODAY, '').ok).toBe(true);
  });

  test('a timestamp is read by its date part, the way the stored paid_at arrives', () => {
    expect(checkPaymentSlipDate('2026-09-20T08:00:00.000Z', TODAY).ok).toBe(true);
  });
});
