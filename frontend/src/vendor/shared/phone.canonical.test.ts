import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { canonicalizeSinglePhone, formatPhone } from './phone';

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
    expect(formatPhone(canonicalizeSinglePhone('03-1234 5678'))).toBe('+60 3-1234 5678');
  });

  test('a refused multi-number value renders byte-identical to what was stored', () => {
    const two = '03-1234 5678 / 019-876 5432';
    expect(formatPhone(canonicalizeSinglePhone(two))).toBe(two);
  });
});

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/phone.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), '../shared/src/vendor/shared/phone.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/phone.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

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
