import { describe, expect, test } from 'vitest';
import {
  canonicalizeSinglePhone as tsCanonical,
  normalizePhone as tsNormalize,
} from '../src/scm/shared/phone';
import {
  canonicalizeSinglePhone as jsCanonical,
  normalizePhone as jsNormalize,
} from '../scripts/lib/phone-normalise.mjs';

// scripts/lib/phone-normalise.mjs is a hand copy of two functions from
// src/scm/shared/phone.ts, because a .mjs backfill script cannot import
// TypeScript and compiling the backend to run one backfill is worse than a
// copy that is pinned.
//
// THIS is the pin. Without it the backfill could write a different canonical
// form from the one the API writes — and it would do so to 3788 customer phone
// numbers, silently, with both sides looking correct in isolation.
//
// The corpus is deliberately nastier than real data: the point is to catch a
// divergence, not to prove either implementation right (phone.canonical.test.ts
// and trackPhoneMatch.test.ts do that).
const CORPUS = [
  // ordinary Malaysian forms
  '0123456789', '012-345 6789', '012 345 6789', '+60123456789', '+60 12-345 6789',
  '60123456789', '123456789', '03-1234 5678', '0312345678', '+60312345678',
  // doubled country code (BUG-114)
  '+6060192689927', '6060192689927', '+600192689927', '+60 019-268 9927', '+606060192689927',
  '6060123', '60601234567890123',
  // explicit foreign
  '+65 6123 4567', '+6591234567', '+8613800138000', '+1 415 555 0123',
  // things the guard must refuse
  '03-1234 5678 / 019-876 5432', '03-1234 5678, 03-1234 5679',
  '03-1234 5678 ext 12', '03-1234 5678 x12', '0312345678 & 0198765432',
  // degenerate
  '', ' ', '1234', '12', '0', '+', '++60123456789', 'abc', 'n/a', '-',
  '0312345678031234567', '000000000000000000',
  // whitespace and unicode-ish noise
  '  0123456789  ', '(012) 345-6789', '012.345.6789', 'Tel: 012-345 6789',
];

describe('the backfill script agrees with the API on every input', () => {
  for (const raw of CORPUS) {
    test(`canonicalizeSinglePhone(${JSON.stringify(raw)})`, () => {
      expect(jsCanonical(raw)).toBe(tsCanonical(raw));
    });
  }

  test('normalizePhone agrees across the whole corpus, including null/undefined', () => {
    for (const raw of [...CORPUS, null, undefined]) {
      expect(jsNormalize(raw as string)).toBe(tsNormalize(raw as string));
    }
  });
});
