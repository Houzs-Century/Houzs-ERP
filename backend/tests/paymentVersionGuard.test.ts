import { describe, expect, test } from 'vitest';
import { paymentVersionGuard } from '../src/scm/routes/mfg-sales-orders';

describe('payment mutation version contract', () => {
  test('missing or invalid version is precondition-required 428', () => {
    expect(paymentVersionGuard(undefined, 4)).toEqual({
      ok: false,
      status: 428,
      body: { error: 'payment_version_required', currentVersion: 4 },
    });
    expect(paymentVersionGuard('not-a-version', 4)).toMatchObject({ ok: false, status: 428 });
  });

  test('stale version is conflict 409 and exact version passes', () => {
    expect(paymentVersionGuard(3, 4)).toEqual({
      ok: false,
      status: 409,
      body: { error: 'payment_version_conflict', currentVersion: 4 },
    });
    expect(paymentVersionGuard(4, 4)).toEqual({ ok: true, version: 4 });
  });
});
