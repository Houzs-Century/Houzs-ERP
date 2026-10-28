import { describe, expect, test, vi, afterEach } from 'vitest';

import { PROCESSING_LEAD_DAYS, deriveProcessingDate } from './processingDate';

/* The rule is "42 days before delivery, but never in the past", and BOTH halves
   decide a real thing on screen: the first is procurement lead time, the second
   stops the form authoring a date the server's own gate would refuse. Neither
   had a test while it lived inside a 2,300-line page component. */

const at = (iso: string) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${iso}T04:00:00.000Z`)); // 12:00 MYT — same day either side of the offset
};

afterEach(() => { vi.useRealTimers(); });

describe('deriveProcessingDate', () => {
  test('a delivery far out lands exactly PROCESSING_LEAD_DAYS before it', () => {
    at('2026-01-01');
    /* 2026-06-01 minus 42 days = 2026-04-20. Written out rather than computed,
       so a bug in the arithmetic cannot also be in the expectation. */
    expect(deriveProcessingDate('2026-06-01')).toBe('2026-04-20');
  });

  test('the lead date is clamped to today, never into the past', () => {
    at('2026-05-20');
    /* 42 days before 2026-06-01 is 2026-04-20, which is behind today. */
    expect(deriveProcessingDate('2026-06-01')).toBe('2026-05-20');
  });

  test('a delivery date in the past still yields today, not a past date', () => {
    at('2026-05-20');
    expect(deriveProcessingDate('2020-01-01')).toBe('2026-05-20');
  });

  test('the boundary is inclusive — a lead landing exactly on today is kept', () => {
    at('2026-04-20');
    expect(deriveProcessingDate('2026-06-01')).toBe('2026-04-20');
  });

  test('it crosses a month and a leap-day boundary by real date arithmetic', () => {
    at('2020-01-01');
    /* 2020-03-15 minus 42 days crosses February of a LEAP year: Mar 15 -> Feb 2. */
    expect(deriveProcessingDate('2020-03-15')).toBe('2020-02-02');
  });

  test('an unparseable value returns today rather than NaN or a throw', () => {
    at('2026-05-20');
    expect(deriveProcessingDate('not-a-date')).toBe('2026-05-20');
    expect(deriveProcessingDate('')).toBe('2026-05-20');
  });

  test('the lead is 42 days — the number the guide and the form both quote', () => {
    expect(PROCESSING_LEAD_DAYS).toBe(42);
  });
});
