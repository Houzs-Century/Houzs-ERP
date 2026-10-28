import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { canonicalizeSinglePhone, formatPhone } from './phone';

// canonicalizeSinglePhone exists for ONE reason: the company branding phone is
// a free-text field that is printed on every invoice and delivery order, and it
// has historically held more than one number. normalizePhone strips every
// non-digit, so running it over "03-1234 5678 / 019-876 5432" would concatenate
// the two into one nonsense string and print THAT to customers.
//
// The contract is therefore asymmetric on purpose: canonicalise only what is
// unambiguously one number, and return everything else untouched. Refusing is
// always safe — the worst case is a value that keeps the format a human typed.
describe('canonicalizeSinglePhone — canonicalises one number', () => {
  test('a Malaysian landline in local form gains the country code', () => {
    expect(canonicalizeSinglePhone('03-1234 5678')).toBe('+60312345678');
  });

  test('a Malaysian mobile in local form gains the country code', () => {
    expect(canonicalizeSinglePhone('012-345 6789')).toBe('+60123456789');
  });

  test('a value already in E.164 is unchanged', () => {
    expect(canonicalizeSinglePhone('+60312345678')).toBe('+60312345678');
  });

  test('an explicit foreign country code is preserved, not forced to +60', () => {
    expect(canonicalizeSinglePhone('+65 6123 4567')).toBe('+6561234567');
  });

  test('empty stays empty', () => {
    expect(canonicalizeSinglePhone('')).toBe('');
    expect(canonicalizeSinglePhone(null)).toBe('');
    expect(canonicalizeSinglePhone(undefined)).toBe('');
  });
});

describe('canonicalizeSinglePhone — REFUSES anything that is not one number', () => {
  test('two numbers separated by a slash are left exactly as typed', () => {
    // The failure this function exists to prevent. Without the guard this
    // becomes "+6031234567801987654 32"-shaped garbage on every document.
    const two = '03-1234 5678 / 019-876 5432';
    expect(canonicalizeSinglePhone(two)).toBe(two);
  });

  test('a comma-separated list is left alone', () => {
    const two = '03-1234 5678, 03-1234 5679';
    expect(canonicalizeSinglePhone(two)).toBe(two);
  });

  test('an extension is left alone', () => {
    expect(canonicalizeSinglePhone('03-1234 5678 ext 12')).toBe('03-1234 5678 ext 12');
    expect(canonicalizeSinglePhone('03-1234 5678 x12')).toBe('03-1234 5678 x12');
  });

  test('too few digits to be a phone is left alone', () => {
    expect(canonicalizeSinglePhone('1234')).toBe('1234');
  });

  test('more digits than E.164 permits is left alone', () => {
    const runTogether = '0312345678031234567';
    expect(canonicalizeSinglePhone(runTogether)).toBe(runTogether);
  });
});

describe('what the document actually renders', () => {
  test('a legacy local-form landline renders with the country code', () => {
    // The branding row was saved before the write path canonicalised, so the
    // read path has to do it too or the change would not show until re-save.
    expect(formatPhone(canonicalizeSinglePhone('03-1234 5678'))).toBe('+60 3-1234 5678');
  });

  test('a refused multi-number value renders byte-identical to what was stored', () => {
    const two = '03-1234 5678 / 019-876 5432';
    expect(formatPhone(canonicalizeSinglePhone(two))).toBe(two);
  });
});

// The backend and the frontend each carry a copy of this module. They are meant
// to be the same file, and on 2026-07-22 they were NOT: the frontend had a
// splitE164 fix from 2026-06-24 (a bare "197770309" was being claimed by US +1)
// that the backend copy never received. Nothing caught it because nothing
// compared them, and the backend never calls splitE164 — so the drift was
// invisible right up until somebody would have called it and got a fixed bug
// back. This test is the thing that compares them.
describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/phone.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/phone.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/phone.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

// formatPhone used to return any non-+60 value untouched, so a Singapore
// customer's number printed on an invoice as the unbroken run "+6561234567"
// beside a Malaysian one reading "+60 12-345 6789". These pin the grouping —
// and, first, that the Malaysian rules were not disturbed while adding it.
describe('formatPhone — Malaysia is unchanged', () => {
  test('mobile and landline keep their exact existing shape', () => {
    expect(formatPhone('+60123456789')).toBe('+60 12-345 6789');
    expect(formatPhone('+60312345678')).toBe('+60 3-1234 5678');
    expect(formatPhone('+60161556133')).toBe('+60 16-155 6133');
  });
});

describe('formatPhone — a foreign number is legible instead of a digit run', () => {
  test('the countries the owner actually trades with', () => {
    expect(formatPhone('+6561234567')).toBe('+65 6123 4567');
    expect(formatPhone('+6281234567890')).toBe('+62 812 3456 7890');
    expect(formatPhone('+8613800138000')).toBe('+86 138 0013 8000');
    expect(formatPhone('+14155550123')).toBe('+1 415 555 0123');
  });

  test('a 3-digit dial code wins over its 1-digit prefix (673 before 6)', () => {
    expect(formatPhone('+6738123456')).toBe('+673 812 3456');
  });

  test('readable, NOT locale-canonical — Thailand groups 2-3-4 in real life', () => {
    // Recorded rather than hidden: without libphonenumber this is grouping for
    // legibility, not a numbering-plan implementation.
    expect(formatPhone('+66812345678')).toBe('+66 812 345 678');
  });
});

describe('formatPhone — anything it cannot read is returned untouched', () => {
  test('unknown dial code, local form, and junk are never mangled', () => {
    expect(formatPhone('+9999')).toBe('+9999');
    expect(formatPhone('0123456789')).toBe('0123456789');
    expect(formatPhone('abc')).toBe('abc');
    expect(formatPhone('')).toBe('');
  });
});
