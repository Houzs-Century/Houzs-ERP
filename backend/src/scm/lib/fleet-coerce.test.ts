/* The distinction these tests exist for: "the caller sent nothing" and "the
   caller sent rubbish" must NOT produce the same row. Every one of these
   coercers is the only thing standing between a typo'd number and a silent
   NULL on a compliance or mileage record. */
import { describe, expect, test } from 'vitest';

import {
  dateOrNull, floatOrNull, intOrNull, iso, normPlate, numOrNull, refsOrNull, tsOrNull,
} from './fleet-coerce';

/** Every `*OrNull` coercer shares the not-supplied rule. Asserted for all of
    them together so a new one cannot quietly disagree. */
const COERCERS = { dateOrNull, intOrNull, numOrNull, floatOrNull, tsOrNull, refsOrNull };

describe('not supplied is not the same as invalid', () => {
  for (const [name, fn] of Object.entries(COERCERS)) {
    test(`${name}: null, undefined and "" all mean null — an untouched form box is not an error`, () => {
      for (const blank of [null, undefined, '']) {
        expect(fn(blank), `${name}(${JSON.stringify(blank)})`).toEqual({ ok: true, value: null });
      }
    });
  }

  test('and every one of them REFUSES rubbish rather than storing null', () => {
    expect(dateOrNull('not-a-date')).toEqual({ ok: false });
    expect(intOrNull('abc')).toEqual({ ok: false });
    expect(numOrNull('abc')).toEqual({ ok: false });
    expect(floatOrNull('abc')).toEqual({ ok: false });
    expect(tsOrNull('abc')).toEqual({ ok: false });
    expect(refsOrNull('not-an-array')).toEqual({ ok: false });
  });
});

describe('intOrNull — mileage and counts', () => {
  test('takes a non-negative integer', () => {
    expect(intOrNull(0)).toEqual({ ok: true, value: 0 });
    expect(intOrNull('120450')).toEqual({ ok: true, value: 120450 });
  });

  test('REFUSES a fraction — 12.5 km is a typo, not a reading', () => {
    expect(intOrNull(12.5)).toEqual({ ok: false });
  });

  test('REFUSES a negative — an odometer does not run backwards', () => {
    expect(intOrNull(-1)).toEqual({ ok: false });
  });

  test('REFUSES Infinity and NaN', () => {
    expect(intOrNull(Infinity)).toEqual({ ok: false });
    expect(intOrNull(NaN)).toEqual({ ok: false });
  });
});

describe('numOrNull vs floatOrNull — the sign rule is the difference', () => {
  test('numOrNull refuses a negative (it is money in cents)', () => {
    expect(numOrNull(-1)).toEqual({ ok: false });
    expect(numOrNull(1250)).toEqual({ ok: true, value: 1250 });
    expect(numOrNull(12.5)).toEqual({ ok: true, value: 12.5 });
  });

  test('floatOrNull ACCEPTS a negative (it is a GPS coordinate)', () => {
    expect(floatOrNull(-3.1234)).toEqual({ ok: true, value: -3.1234 });
    expect(floatOrNull(101.6869)).toEqual({ ok: true, value: 101.6869 });
  });
});

describe('dateOrNull and iso', () => {
  test('dateOrNull takes the YYYY-MM-DD prefix of a longer timestamp', () => {
    expect(dateOrNull('2026-08-15T10:30:00Z')).toEqual({ ok: true, value: '2026-08-15' });
  });

  test('dateOrNull refuses a non-ISO shape rather than half-parsing it', () => {
    expect(dateOrNull('15/08/2026')).toEqual({ ok: false });
    expect(dateOrNull('2026-8-5')).toEqual({ ok: false });
  });

  test('iso NEVER refuses — it shapes stored rows, where a bad value must not throw', () => {
    expect(iso('2026-08-15')).toBe('2026-08-15');
    expect(iso('rubbish')).toBeNull();
    expect(iso(null)).toBeNull();
    expect(iso(undefined)).toBeNull();
  });
});

describe('tsOrNull', () => {
  test('keeps the string as sent — Postgres does the parsing', () => {
    expect(tsOrNull('2026-08-15T10:30:00Z')).toEqual({ ok: true, value: '2026-08-15T10:30:00Z' });
  });
});

describe('refsOrNull — R2 keys', () => {
  test('trims, drops blanks, and keeps the rest', () => {
    expect(refsOrNull([' a/b.jpg ', '', 'c/d.jpg'])).toEqual({ ok: true, value: ['a/b.jpg', 'c/d.jpg'] });
  });

  test('an array that is empty after trimming stores NULL, not []', () => {
    expect(refsOrNull([])).toEqual({ ok: true, value: null });
    expect(refsOrNull(['  ', ''])).toEqual({ ok: true, value: null });
  });

  test('refuses an object or a bare string — the column is a list', () => {
    expect(refsOrNull({ a: 1 })).toEqual({ ok: false });
    expect(refsOrNull('a/b.jpg')).toEqual({ ok: false });
  });
});

describe('normPlate', () => {
  test('two spellings of one lorry compare equal', () => {
    expect(normPlate(' w a 1234 b ')).toBe('WA1234B');
    expect(normPlate('WA1234B')).toBe('WA1234B');
    expect(normPlate(' w a 1234 b ')).toBe(normPlate('WA1234B'));
  });

  test('null and undefined normalise to empty, not to "NULL"', () => {
    expect(normPlate(null)).toBe('');
    expect(normPlate(undefined)).toBe('');
  });
});
