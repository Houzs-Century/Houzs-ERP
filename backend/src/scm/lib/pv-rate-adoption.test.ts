// The rate-adoption DECISION TABLE (pv-rate-adoption.ts), exhaustively.
//
// The decision is pure on purpose so every row of the table is asserted here with
// no database: "the payment defines the FX rate" is a money-path rule, and the one
// thing that must never be in doubt is WHEN it fires and when it keeps its hands
// off. The route-level behaviour it drives (the invoice write, the recost, the
// audit row, and the fact that a recost failure cannot fail a payment) is covered
// by tests/pvRateFromPayment.test.ts.

import { describe, expect, test } from 'vitest';
import { planPvRateAdoption, isRateRetainedFromPv, roundRate6, type PiRateFacts } from './pv-rate-adoption';

const RMB_PI: PiRateFacts = {
  piId: 'pi-1',
  docNo: '2990-PI-2607-004',
  currency: 'RMB',
  exchangeRate: 1, // the R2 hole: a foreign invoice at rate 1 was never rated
  grnId: 'grn-1',
};

const plan = (over: Partial<Parameters<typeof planPvRateAdoption>[0]> = {}) =>
  planPvRateAdoption({
    appliedCenti: 2_162_500,
    pvCurrency: 'RMB',
    pvExchangeRate: 0.619838,
    pi: RMB_PI,
    ...over,
  });

describe('row 5 — an un-rated foreign invoice ADOPTS the payment rate', () => {
  test('stored rate 1 on an RMB invoice adopts, and names the GRN to re-cost', () => {
    expect(plan()).toEqual({ action: 'adopt', rate: 0.619838, oldRate: 1, grnId: 'grn-1' });
  });

  test('a numeric handed back as a STRING (PostgREST numeric) is still recognised as 1', () => {
    expect(plan({ pi: { ...RMB_PI, exchangeRate: '1.000000' } }))
      .toEqual({ action: 'adopt', rate: 0.619838, oldRate: 1, grnId: 'grn-1' });
  });

  test('a PV rate arriving as a string is adopted as a number', () => {
    const r = plan({ pvExchangeRate: '0.619838' });
    expect(r).toMatchObject({ action: 'adopt', rate: 0.619838 });
  });

  test.each([null, 0, -1, 'abc', Number.NaN])(
    'a stored rate of %p is the same hole as 1 and adopts',
    (stored) => {
      expect(plan({ pi: { ...RMB_PI, exchangeRate: stored as never } }))
        .toMatchObject({ action: 'adopt', rate: 0.619838, oldRate: 1 });
    },
  );

  test('an invoice with no GRN still adopts the rate — there is just nothing to re-cost', () => {
    expect(plan({ pi: { ...RMB_PI, grnId: null } }))
      .toEqual({ action: 'adopt', rate: 0.619838, oldRate: 1, grnId: null });
  });

  test('the adopted rate is rounded to the stored numeric(14,6) precision', () => {
    expect(plan({ pvExchangeRate: 0.6198384999 }))
      .toMatchObject({ action: 'adopt', rate: 0.619838 });
  });
});

describe('row 7 — a foreign invoice with a DIFFERENT deliberate rate is LEFT ALONE', () => {
  test('reports the disagreement instead of overwriting', () => {
    expect(plan({ pi: { ...RMB_PI, exchangeRate: 0.62 } }))
      .toEqual({ action: 'report_mismatch', piRate: 0.62, pvRate: 0.619838 });
  });

  test('a partial payment at a second rate is reported, never resolved', () => {
    // Half the invoice paid in January at 0.62, the rest now at 0.6099. Neither
    // is "the" rate for the whole invoice — that is the owner's call, not ours.
    expect(plan({ appliedCenti: 1_081_250, pvExchangeRate: 0.6099, pi: { ...RMB_PI, exchangeRate: 0.62 } }))
      .toEqual({ action: 'report_mismatch', piRate: 0.62, pvRate: 0.6099 });
  });

  test('a deliberately-entered rate BELOW 1 that is not the payment rate is still respected', () => {
    expect(plan({ pi: { ...RMB_PI, exchangeRate: 0.55 } })).toMatchObject({ action: 'report_mismatch' });
  });
});

describe('row 6 — an invoice already at the payment rate is a no-op', () => {
  test('same rate skips rather than writing it again', () => {
    expect(plan({ pi: { ...RMB_PI, exchangeRate: 0.619838 } }))
      .toEqual({ action: 'skip', reason: 'already_at_this_rate' });
  });

  test('a 6-dp round-trip through the database does not look like a change', () => {
    expect(plan({ pvExchangeRate: 0.6198384, pi: { ...RMB_PI, exchangeRate: '0.619838' } }))
      .toEqual({ action: 'skip', reason: 'already_at_this_rate' });
  });
});

describe('row 2 — an MYR invoice is never touched', () => {
  test.each(['MYR', 'myr', '', null])('PI currency %p is a no-op', (cur) => {
    expect(plan({ pi: { ...RMB_PI, currency: cur as never } }))
      .toEqual({ action: 'skip', reason: 'myr_invoice' });
  });

  test('an all-MYR payment of an all-MYR invoice — the overwhelming majority — does nothing', () => {
    expect(plan({ pvCurrency: 'MYR', pvExchangeRate: 1, pi: { ...RMB_PI, currency: 'MYR', exchangeRate: 1 } }))
      .toEqual({ action: 'skip', reason: 'myr_invoice' });
  });
});

describe('row 1 — nothing applied means no evidence of payment', () => {
  test.each([0, -1, -2_162_500, Number.NaN])('appliedCenti %p is a no-op', (applied) => {
    expect(plan({ appliedCenti: applied }))
      .toEqual({ action: 'skip', reason: 'nothing_applied' });
  });

  test('a fully-clamped allocation (the invoice was already paid) adopts nothing', () => {
    // settlePiPaidCenti returns appliedCenti 0 when the clamp refuses the whole
    // request. No money reached the invoice, so the payment says nothing about it.
    expect(plan({ appliedCenti: 0 })).toEqual({ action: 'skip', reason: 'nothing_applied' });
  });
});

describe('row 3 — a voucher with no usable rate of its own adopts nothing', () => {
  test('an MYR voucher cannot rate a foreign invoice', () => {
    expect(plan({ pvCurrency: 'MYR', pvExchangeRate: 1 }))
      .toEqual({ action: 'skip', reason: 'voucher_rate_unusable' });
  });

  test.each([null, 0, -0.5, 'abc', Number.NaN, Number.POSITIVE_INFINITY])(
    'a foreign voucher whose own rate is %p is itself un-rated, not evidence',
    (rate) => {
      expect(plan({ pvExchangeRate: rate as never }))
        .toEqual({ action: 'skip', reason: 'voucher_rate_unusable' });
    },
  );

  test('a foreign voucher at rate exactly 1 is the same hole and is refused', () => {
    expect(plan({ pvExchangeRate: 1 })).toEqual({ action: 'skip', reason: 'voucher_rate_unusable' });
  });
});

describe('row 4 — a payment in one currency says nothing about an invoice in another', () => {
  test('an RMB voucher does not rate a USD invoice', () => {
    expect(plan({ pi: { ...RMB_PI, currency: 'USD' } }))
      .toEqual({ action: 'skip', reason: 'currency_mismatch' });
  });

  test('case and whitespace do not create a false mismatch', () => {
    expect(plan({ pvCurrency: ' rmb ' })).toMatchObject({ action: 'adopt' });
  });
});

describe('isRateRetainedFromPv — what the CANCEL path names', () => {
  const args = {
    pvCurrency: 'RMB', pvExchangeRate: 0.619838,
    piCurrency: 'RMB', piExchangeRate: 0.619838,
  };

  test('an invoice still carrying this voucher\'s rate is named', () => {
    expect(isRateRetainedFromPv(args)).toBe(true);
  });

  test('an invoice since moved to another rate is NOT named', () => {
    expect(isRateRetainedFromPv({ ...args, piExchangeRate: 0.62 })).toBe(false);
  });

  test('an MYR voucher never established a rate', () => {
    expect(isRateRetainedFromPv({ ...args, pvCurrency: 'MYR', pvExchangeRate: 1 })).toBe(false);
  });

  test('a rate of 1 is the hole, so it is never claimed as something we set', () => {
    expect(isRateRetainedFromPv({ ...args, pvExchangeRate: 1, piExchangeRate: 1 })).toBe(false);
  });

  test('a different currency is not this voucher\'s doing', () => {
    expect(isRateRetainedFromPv({ ...args, piCurrency: 'USD' })).toBe(false);
  });
});

describe('roundRate6 — the numeric(14,6) contract', () => {
  test.each([
    [0.6198384999, 0.619838],
    ['0.619838', 0.619838],
    [1, 1],
    [null, 1],   // safeRate: a missing rate can never zero out the money
    [0, 1],
    [-3, 1],
    ['abc', 1],
  ])('%p -> %p', (raw, want) => {
    expect(roundRate6(raw)).toBe(want);
  });
});
