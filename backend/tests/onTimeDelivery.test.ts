/* On-time delivery (owner 2026-11-08): judged on the Malaysia date of delivered_at
   against the promised date (amended, else the customer's). */
import { describe, expect, test } from 'vitest';
import { classifyOnTime, deliveredMyDate, latestLiveDo, onTimeSummary, promisedDateOf, type OnTimeOrderIn } from '../src/scm/lib/on-time-delivery';

const o = (x: Partial<OnTimeOrderIn>): OnTimeOrderIn => ({
  soDocNo: 'SO-1', customer: 'A', promised: '2026-11-03', deliveredAt: null, closedWithoutTime: false,
  region: 'KL / Selangor', offPeninsula: false, lorryId: 'l1', lorry: 'WXX 1', driver: 'Ali', ...x,
});

describe('the Malaysia date boundary', () => {
  test('23:59 MYT on the promised day is on time', () => {
    // 2026-11-03 23:59 MYT = 15:59 UTC the same day
    expect(deliveredMyDate('2026-11-03T15:59:00.000Z')).toBe('2026-11-03');
    expect(classifyOnTime('2026-11-03', '2026-11-03T15:59:00.000Z', '2026-11-08').result).toBe('ON_TIME');
  });
  test('00:01 MYT the next day is one day late, though UTC still reads the promised day', () => {
    // 2026-11-04 00:01 MYT = 2026-11-03 16:01 UTC
    const r = classifyOnTime('2026-11-03', '2026-11-03T16:01:00.000Z', '2026-11-08');
    expect(r).toEqual({ result: 'LATE', delivered: '2026-11-04', daysLate: 1 });
  });
  test('a stamp with an offset and a bare date both read as the Malaysia day', () => {
    expect(deliveredMyDate('2026-11-02T07:30:00+08:00')).toBe('2026-11-02');
    expect(deliveredMyDate('2026-11-02')).toBe('2026-11-02');
    expect(deliveredMyDate(null)).toBeNull();
  });
  test('before the promised day is early', () => {
    expect(classifyOnTime('2026-11-03', '2026-11-01T04:00:00Z', '2026-11-08')).toEqual({ result: 'EARLY', delivered: '2026-11-01', daysLate: -2 });
  });
});

describe('the promised date', () => {
  test('the amended date wins over the customer date', () => {
    expect(promisedDateOf({ amended_delivery_date: '2026-11-05', customer_delivery_date: '2026-11-01' })).toBe('2026-11-05');
    expect(classifyOnTime(promisedDateOf({ amended_delivery_date: '2026-11-05', customer_delivery_date: '2026-11-01' }), '2026-11-05T02:00:00Z', '2026-11-08').result).toBe('ON_TIME');
  });
  test('no amended date falls back to the customer date', () => {
    expect(promisedDateOf({ amended_delivery_date: null, customer_delivery_date: '2026-11-01' })).toBe('2026-11-01');
  });
});

describe('undelivered orders', () => {
  test('past the promised date is late-open, counted in days to today', () => {
    expect(classifyOnTime('2026-11-03', null, '2026-11-08')).toEqual({ result: 'LATE_OPEN', delivered: null, daysLate: 5 });
  });
  test('due today or later is still open', () => {
    expect(classifyOnTime('2026-11-08', null, '2026-11-08').result).toBe('OPEN');
  });
  test('no promised date is not judged', () => {
    expect(classifyOnTime(null, '2026-11-03T02:00:00Z', '2026-11-08').result).toBe('NO_DATE');
  });
});

describe('the latest live DO', () => {
  test('a cancelled newer DO does not hide the delivered one', () => {
    const l = latestLiveDo([
      { id: 'a', status: 'DELIVERED', created_at: '2026-11-01T00:00:00Z' },
      { id: 'b', status: 'CANCELLED', created_at: '2026-11-02T00:00:00Z' },
    ]);
    expect(l?.id).toBe('a');
  });
  test('the newest live DO wins', () => {
    expect(latestLiveDo([
      { id: 'a', status: 'DELIVERED', created_at: '2026-11-01T00:00:00Z' },
      { id: 'b', status: 'LOADED', created_at: '2026-11-02T00:00:00Z' },
    ])?.id).toBe('b');
  });
});

describe('the period summary', () => {
  const s = onTimeSummary([
    o({ soDocNo: 'S1', deliveredAt: '2026-11-03T05:00:00Z' }),                     // on time
    o({ soDocNo: 'S2', deliveredAt: '2026-11-02T05:00:00Z' }),                     // early
    o({ soDocNo: 'S3', deliveredAt: '2026-11-05T05:00:00Z', lorry: 'WXX 2', lorryId: 'l2', driver: null }), // late 2
    o({ soDocNo: 'S4', promised: '2026-11-04' }),                                  // late-open
    o({ soDocNo: 'S5', deliveredAt: '2026-11-03T05:00:00Z', offPeninsula: true }), // Sabah: left out
    o({ soDocNo: 'S6', promised: null, deliveredAt: '2026-11-03T05:00:00Z' }),     // no promise: left out
    o({ soDocNo: 'S7', promised: '2026-11-02', closedWithoutTime: true }),         // closed, no time
    o({ soDocNo: 'S8', deliveredAt: '2026-10-20T05:00:00Z', promised: '2026-10-20' }), // outside the period
    o({ soDocNo: 'S9', promised: '2026-11-09' }),                                  // not yet due
  ], '2026-11-01', '2026-11-30', '2026-11-08');

  test('rate = (on time + early) / delivered; late-open is outside it', () => {
    expect([s.delivered, s.onTime, s.early, s.late, s.lateOpen]).toEqual([3, 1, 1, 1, 1]);
    expect(s.ratePct).toBe(66.7);
  });
  test('what is left out is counted', () => {
    expect(s.excluded).toEqual({ offPeninsula: 1, noPromise: 1, noDeliveryTime: 1 });
  });
  test('per lorry and per driver, an unrecorded driver last', () => {
    expect(s.byLorry.map((g) => [g.key, g.lorryId, g.delivered, g.ratePct])).toEqual([['WXX 1', 'l1', 2, 100], ['WXX 2', 'l2', 1, 0]]);
    expect(s.byDriver.map((g) => g.key)).toEqual(['Ali', 'Not recorded']);
    expect(s.byRegion[0]).toMatchObject({ key: 'KL / Selangor', delivered: 3, lateOpen: 1 });
  });
  test('the list leads with the late-open, then the latest late', () => {
    expect(s.orders.map((r) => [r.soDocNo, r.result, r.daysLate])).toEqual([
      ['S4', 'LATE_OPEN', 4], ['S3', 'LATE', 2], ['S2', 'EARLY', -1], ['S1', 'ON_TIME', 0],
    ]);
  });
});
