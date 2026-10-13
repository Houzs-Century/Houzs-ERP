// The slip rule's whole boundary: a keyed payment without its proof is refused,
// a converted row never is. Asserted on the shared module because the payments
// POST, the SO create, the backdate request, the write core and the three
// frontend surfaces (via the byte-identical mirror) all call this one function.
import { describe, expect, test } from 'vitest';
import { SLIP_REQUIRED_CODE, SLIP_REQUIRED_REASON, checkPaymentSlip } from './payment-slip-required';

describe('payment slip required', () => {
  test('a keyed payment with no slip is refused, with the one shared sentence', () => {
    expect(checkPaymentSlip({ converted: false, hasSlip: false })).toEqual({
      ok: false, code: SLIP_REQUIRED_CODE, reason: SLIP_REQUIRED_REASON,
    });
    expect(SLIP_REQUIRED_CODE).toBe('slip_required');
  });

  test('a keyed payment with its slip or scanned receipt passes', () => {
    expect(checkPaymentSlip({ converted: false, hasSlip: true })).toEqual({ ok: true });
  });

  test('money moved from another order carries no slip and is never asked for one', () => {
    expect(checkPaymentSlip({ converted: true, hasSlip: false })).toEqual({ ok: true });
  });
});
