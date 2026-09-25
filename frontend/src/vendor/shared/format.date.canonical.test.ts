import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fmtDate, fmtDateTime, fmtDateOrDash, fmtTime, fmtDayMonth, fmtDayMonthRange } from './format';

/* The date rule had five spellings in this tree and the owner was shown two of
   them on one screen. These tests pin the ONE rule, and specifically pin the
   cases that made the previous body wrong rather than only the happy path. */

describe('fmtDate — DD/MM/YYYY, always', () => {
  test('a date-only column renders day-first', () => {
    expect(fmtDate('2026-08-16')).toBe('2026/08/16');
  });

  /* THE BUG THAT MADE THIS WORK NECESSARY, and the one a Malaysian developer
     cannot see locally. `new Date('2026-08-16')` is UTC midnight; the old body
     handed that to toLocaleDateString with no timeZone, so west of Greenwich it
     rendered 2026/08/15. Malaysia is UTC+8, so the office always saw the right
     day and nobody could reproduce it. Asserted here by forcing the process
     into a negative-offset zone for the length of the test. */
  test('a date-only value does NOT shift a day in a negative-offset zone', () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(fmtDate('2026-08-16')).toBe('2026/08/16');
      expect(fmtDate('2026-01-01')).toBe('2026/01/01');
      expect(fmtDate('2026-12-31')).toBe('2026/12/31');
    } finally {
      process.env.TZ = before;
    }
  });

  test('an ISO datetime keeps the date half', () => {
    expect(fmtDate('2026-08-16T14:30:00Z')).toBe('2026/08/16');
  });

  /* A real instant is converted ONCE, to Malaysian time. 17:00 UTC on the 16th
     is 01:00 on the 17th in KL, and the ERP must say the 17th — this is the
     "late-night UTC creation rolls over correctly" case. */
  test('a zoned instant is shown in Malaysian time, not the viewer time', () => {
    expect(fmtDate('2026-08-16T17:00:00Z')).toBe('2026/08/17');
    expect(fmtDate('2026-08-16T15:59:59Z')).toBe('2026/08/16');
  });

  test('a wall-clock datetime-local value is shown exactly as typed', () => {
    expect(fmtDate('2026-08-16T14:30')).toBe('2026/08/16');
  });

  test('a bare SQL timestamp is read as UTC and shown in Malaysian time', () => {
    expect(fmtDate('2026-08-16 17:30:00')).toBe('2026/08/17');
  });

  test('an already-formatted string is returned unchanged (idempotent)', () => {
    expect(fmtDate('2026/08/16')).toBe('2026/08/16');
    expect(fmtDate(fmtDate('2026-08-16'))).toBe('2026/08/16');
  });

  test('nothing to show renders as a dash, never "Invalid Date"', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
    expect(fmtDate('')).toBe('—');
    expect(fmtDate('   ')).toBe('—');
  });

  test('an unparseable value renders as a dash, never "NaN/NaN/NaN"', () => {
    expect(fmtDate('not a date')).toBe('—');
    expect(fmtDate(Number.NaN)).toBe('—');
    expect(fmtDate(new Date('nope'))).toBe('—');
  });

  test('a Date and an epoch number are accepted', () => {
    expect(fmtDate(new Date(Date.UTC(2026, 7, 16, 4, 0, 0)))).toBe('2026/08/16');
    expect(fmtDate(Date.UTC(2026, 7, 16, 4, 0, 0))).toBe('2026/08/16');
  });

  test('no month name ever appears — the owner ruled numeric', () => {
    const samples = ['2026-01-05', '2026-06-30', '2026-07-04T09:00:00Z', '2026-12-25'];
    for (const s of samples) expect(fmtDate(s)).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });

  test('fmtDateOrDash is the same rule under its older name', () => {
    for (const s of ['2026-08-16', '', null, '2026-08-16T17:00:00Z']) {
      expect(fmtDateOrDash(s)).toBe(fmtDate(s));
    }
  });
});

describe('fmtDateTime — the same rule, one export further', () => {
  test('24-hour, no comma, day-first', () => {
    expect(fmtDateTime('2026-08-16T06:30:00Z')).toBe('2026/08/16 14:30');
  });

  test('its date half is byte-identical to fmtDate', () => {
    const samples = ['2026-08-16', '2026-08-16T17:00:00Z', '2026-08-16 17:30:00', '2026-08-16T14:30'];
    for (const s of samples) expect(fmtDateTime(s).slice(0, 10)).toBe(fmtDate(s));
  });

  test('a date-only value gets midnight, not a shifted day', () => {
    expect(fmtDateTime('2026-08-16')).toBe('2026/08/16 00:00');
  });

  test('nothing to show renders as a dash', () => {
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDateTime('')).toBe('—');
    expect(fmtDateTime('not a date')).toBe('—');
  });

  test('fmtTime is the time half of the same parse', () => {
    expect(fmtTime('2026-08-16T06:30:00Z')).toBe('14:30');
    expect(fmtTime(null)).toBe('—');
  });
});

describe('fmtDayMonth / fmtDayMonthRange — the year dropped, the shape kept', () => {
  /* Owner 2026-09-19, on the SO fair picker: *"日期不需要年份"*. The list there
     only ever spans the 28 days behind the order date, so a year disambiguates
     nothing in it. He was offered `Aug 13 - 17` and chose this instead, so the
     app still has exactly ONE date shape and `check-date-formatting.mjs` has
     nothing new to allow. */
  test('month-first, zero-padded, no year (the year-first rule with the year trimmed)', () => {
    expect(fmtDayMonth('2026-08-13')).toBe('08/13');
    expect(fmtDayMonth('2026-08-04')).toBe('08/04');
  });

  test('a range renders BOTH ends in full', () => {
    /* "08/13 - 17" would save three characters and cost the reader the month on
       the end most likely to differ. */
    expect(fmtDayMonthRange('2026-08-13', '2026-08-17')).toBe('08/13 - 08/17');
    expect(fmtDayMonthRange('2026-08-30', '2026-09-02')).toBe('08/30 - 09/02');
    /* Across New Year, which a 28-day window reaches every December. */
    expect(fmtDayMonthRange('2026-12-30', '2027-01-02')).toBe('12/30 - 01/02');
  });

  test('one day is one date, not a range against itself', () => {
    expect(fmtDayMonthRange('2026-08-13', '2026-08-13')).toBe('08/13');
    expect(fmtDayMonthRange('2026-08-13', null)).toBe('08/13');
  });

  test('an unreadable end falls back to the start, never "08/13 - —"', () => {
    /* A dash on the end reads as a fair that never finished. */
    expect(fmtDayMonthRange('2026-08-13', 'not-a-date')).toBe('08/13');
    expect(fmtDayMonth(null)).toBe('—');
  });

  test('does not shift a date-only value across a timezone', () => {
    /* The bug the whole date rule exists for: `new Date('2026-08-16')` is UTC
       midnight, so anything west of Greenwich renders the day before. */
    const tz = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(fmtDayMonth('2026-08-16')).toBe('08/16');
    } finally {
      process.env.TZ = tz;
    }
  });
});

/* The frontend VENDORS the backend module rather than importing it, so the two
   can drift silently — that is the mechanism check-shared-mirrors.mjs exists
   for. This asserts the date rule specifically, byte for byte, so a fix applied
   to one side and forgotten on the other fails here rather than in production.
   phone.canonical.test.ts is the precedent and the reason phone normalisation
   has never drifted. */
describe('the backend copy carries the identical rule', () => {
  const slice = (text: string): string => {
    const start = text.indexOf('/* ── THE ONE DATE RULE');
    const end = text.indexOf('export const fmtDateOrDash');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, text.indexOf('\n', text.indexOf(';', end)));
  };

  test('frontend and backend format.ts hold the same date block', () => {
    const fe = readFileSync(resolve(__dirname, 'format.ts'), 'utf8');
    const be = readFileSync(
      resolve(__dirname, '../../../../backend/src/scm/shared/format.ts'),
      'utf8',
    );
    expect(slice(fe)).toBe(slice(be));
  });
});
