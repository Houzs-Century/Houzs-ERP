import { describe, expect, it } from 'vitest';
import {
  PROCEED_DATE_UNREADABLE,
  PROCEED_NEEDS_DATE,
  meetsDepositGate,
  meetsProceedGate,
  processingDateThresholdFor,
  resolveProceedProcessingDate,
  type ProceedGateInput,
} from './order-rules';

/* Complete on every non-money condition, so a verdict below is the MONEY
   verdict and nothing else. */
const complete = (paid: number, total: number, companyCode?: string | null): ProceedGateInput => ({
  hasCustomerName: true,
  hasAddress: true,
  hasPostcode: true,
  hasDeliveryDate: true,
  paid,
  total,
  companyCode,
});

/* ONE deposit rule for proceeding and for setting the Processing Date, because
   they are one act (owner 2026-07-31: "Processing Date 就是当天 Proceed 的意思").
   Two functions for it is how a second threshold appeared once already: a 2990
   order refused at the Houzs 30% when the 2990 rule is 50%. */
describe('meetsDepositGate', () => {
  it('holds Houzs to 30%', () => {
    expect(meetsDepositGate(29_99, 100_00, 'HOUZS')).toBe(false);
    expect(meetsDepositGate(30_00, 100_00, 'HOUZS')).toBe(true);
  });

  it('holds 2990 to 50%', () => {
    expect(meetsDepositGate(30_00, 100_00, '2990')).toBe(false);
    expect(meetsDepositGate(50_00, 100_00, '2990')).toBe(true);
  });

  it('falls back to the LOOSER 30% for an unknown / absent company', () => {
    // Over-gating blocks the shop floor with no signal; under-gating is
    // recoverable because the money is still owed before delivery.
    expect(meetsDepositGate(30_00, 100_00, null)).toBe(true);
    expect(meetsDepositGate(30_00, 100_00, undefined)).toBe(true);
    expect(meetsDepositGate(30_00, 100_00, 'FUTURE-CO')).toBe(true);
  });

  it('is vacuously met on a zero-total order', () => {
    // A Free Item Campaign giveaway has nothing to collect, and 0/0 would be NaN.
    expect(meetsDepositGate(0, 0)).toBe(true);
  });
});

/* The collapse itself: whatever the money says, both gates say it. If this ever
   fails, some path has grown its own threshold again. */
describe('meetsProceedGate asks meetsDepositGate the money question', () => {
  const cases: Array<[string | null, number, number]> = [
    ['HOUZS', 0, 100_00], ['HOUZS', 29_99, 100_00], ['HOUZS', 30_00, 100_00],
    ['2990', 30_00, 100_00], ['2990', 49_99, 100_00], ['2990', 50_00, 100_00],
    [null, 30_00, 100_00], ['HOUZS', 0, 0],
  ];
  for (const [company, paid, total] of cases) {
    it(`${company ?? 'no company'} paid ${paid} of ${total}`, () => {
      expect(meetsProceedGate(complete(paid, total, company)))
        .toBe(meetsDepositGate(paid, total, company));
    });
  }

  it('still refuses an incomplete order that HAS the deposit', () => {
    expect(meetsProceedGate({ ...complete(100_00, 100_00, 'HOUZS'), hasAddress: false })).toBe(false);
    expect(meetsProceedGate({ ...complete(100_00, 100_00, 'HOUZS'), hasDeliveryDate: false })).toBe(false);
  });
});

describe('processingDateThresholdFor', () => {
  it('reads a padded / lower-case company code', () => {
    expect(processingDateThresholdFor(' 2990 ')).toBe(0.5);
    expect(processingDateThresholdFor('houzs')).toBe(0.30);
  });
});

/* Proceed is the DATE, not a click (owner, pinned 2026-08-13: "只要有 Processing
   Date，就代表他 Proceed 了。Proceed 的日期是他填入 Processing Date 的日期。没有
   processing date 就代表没有 proceed。") */
describe('resolveProceedProcessingDate', () => {
  it('refuses when neither the order nor the request carries a date', () => {
    const r = resolveProceedProcessingDate({});
    expect(r).toEqual({ ok: false, refusal: PROCEED_NEEDS_DATE });
  });

  it('refuses rather than guessing today', () => {
    // The whole point: a guessed start date is a real order sitting in the real
    // factory queue on the wrong day, and nothing would ever show it was guessed.
    const r = resolveProceedProcessingDate({ supplied: '   ', stored: '' });
    expect(r.ok).toBe(false);
  });

  it('uses the date the caller supplies, and tells the caller to persist it', () => {
    expect(resolveProceedProcessingDate({ supplied: '2026-09-01' }))
      .toEqual({ ok: true, date: '2026-09-01', write: true });
  });

  it('uses the date already on the order, and writes nothing', () => {
    expect(resolveProceedProcessingDate({ stored: '2026-09-01' }))
      .toEqual({ ok: true, date: '2026-09-01', write: false });
  });

  it('never MOVES a date the order already has', () => {
    // Rescheduling is a different act, owned by the header PATCH because that is
    // where the processing lock and the full save gate live. Proceeding must not
    // be the road around them.
    expect(resolveProceedProcessingDate({ supplied: '2026-12-25', stored: '2026-09-01' }))
      .toEqual({ ok: true, date: '2026-09-01', write: false });
  });

  it('reads a timestamp-shaped stored value as its calendar day', () => {
    expect(resolveProceedProcessingDate({ stored: '2026-09-01T16:00:00.000Z' }))
      .toEqual({ ok: true, date: '2026-09-01', write: false });
  });

  it('refuses a supplied value that is not a calendar date', () => {
    for (const bad of ['tomorrow', '01/09/2026', '2026-9-1', 'null']) {
      expect(resolveProceedProcessingDate({ supplied: bad }))
        .toEqual({ ok: false, refusal: PROCEED_DATE_UNREADABLE });
    }
  });

  it('falls through an unreadable STORED value to the supplied date', () => {
    // A row we cannot read a day out of is not a date the factory can queue by,
    // so it must not silently stand in for one.
    expect(resolveProceedProcessingDate({ supplied: '2026-09-01', stored: 'unknown' }))
      .toEqual({ ok: true, date: '2026-09-01', write: true });
  });
});
