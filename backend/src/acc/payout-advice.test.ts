// 几份 excel 对一份 pdf (owner, 2026-08-20) — his own words for Public Bank's
// shape, and what this file pins.
//
// The advice names several settlement dates; each one has a merchant report or
// it does not, agrees or it does not, is reconciled or it is not. What is
// pinned hardest is that a payout is NOT ready while any of those is unsettled,
// and that the reason given names the FIRST thing in the way rather than
// listing everything at once.

import { describe, it, expect } from 'vitest';
import { statusOfPayout, type ReportForPayout } from './payout-advice';

/* His real figures: the advice of 10 Aug pays for three trading days, and the
   09 Aug day is equal to the sen to that day's CSV. */
const ADVICE = {
  netSen: 18895586,
  batches: [
    { settledOn: '2026-08-07', netSen: 3753766 },
    { settledOn: '2026-08-08', netSen: 5226993 },
    { settledOn: '2026-08-09', netSen: 9914827 },
  ] as never,
};

const report = (over: Partial<ReportForPayout> = {}): ReportForPayout => ({
  id: 1, fileName: 'csv-0809.csv', periodFrom: '2026-08-09', periodTo: '2026-08-09',
  payableSen: 9914827, openLines: 0, ...over,
});

const all = (): ReportForPayout[] => [
  report({ id: 1, fileName: 'csv-0807.csv', periodFrom: '2026-08-07', periodTo: '2026-08-07', payableSen: 3753766 }),
  report({ id: 2, fileName: 'csv-0808.csv', periodFrom: '2026-08-08', periodTo: '2026-08-08', payableSen: 5226993 }),
  report({ id: 3 }),
];

describe('an advice against the reports it pays for', () => {
  it('agrees day by day, and is ready when every day does', () => {
    const s = statusOfPayout(ADVICE, all());
    expect(s.days.map((d) => d.state)).toEqual(['AGREES', 'AGREES', 'AGREES']);
    expect(s.days.map((d) => d.differenceSen)).toEqual([0, 0, 0]);
    expect(s.netSen).toBe(18895586);
    expect(s.readyToReceive).toBe(true);
    expect(s.blockedBy).toBeNull();
  });

  /* The state he is actually in: he has the 09 Aug file and not the other two. */
  it('names the days whose report has not been uploaded', () => {
    const s = statusOfPayout(ADVICE, [report({ id: 3 })]);
    expect(s.readyToReceive).toBe(false);
    expect(s.blockedBy).toMatch(/2 of the 3 day\(s\)/);
    expect(s.blockedBy).toMatch(/2026-08-07, 2026-08-08/);
    expect(s.days.filter((d) => d.state === 'REPORT_MISSING')).toHaveLength(2);
  });

  /* A difference is the FINDING — both numbers, named to the file. */
  it('names both figures when a day disagrees', () => {
    const reports = all();
    reports[2] = report({ id: 3, payableSen: 9900000 });
    const s = statusOfPayout(ADVICE, reports);
    expect(s.readyToReceive).toBe(false);
    expect(s.blockedBy).toMatch(/csv-0809\.csv nets RM 99,000\.00/);
    expect(s.blockedBy).toMatch(/advice says RM 99,148\.27/);
    expect(s.blockedBy).toMatch(/difference of -RM 148\.27|difference of RM -148\.27/);
  });

  /* A report whose lines are not all decided has fees not yet in the books, so
     its net is not yet the truth — the same gate the bank screen already keeps. */
  it('will not call a payout ready while a report still has lines to decide', () => {
    const reports = all();
    reports[0] = report({ id: 1, fileName: 'csv-0807.csv', periodFrom: '2026-08-07', periodTo: '2026-08-07', payableSen: 3753766, openLines: 4 });
    const s = statusOfPayout(ADVICE, reports);
    expect(s.readyToReceive).toBe(false);
    expect(s.blockedBy).toMatch(/csv-0807\.csv/);
    expect(s.blockedBy).toMatch(/still have lines to decide/);
  });

  /* One thing at a time, in the order they have to be dealt with: a missing
     report cannot be compared, so it is named before a difference. */
  it('names the missing report first when both are wrong', () => {
    const s = statusOfPayout(ADVICE, [report({ id: 3, payableSen: 9900000 })]);
    expect(s.blockedBy).toMatch(/no merchant report uploaded yet/);
    expect(s.blockedBy).not.toMatch(/difference of/);
  });
});
