import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared with the binder script
import { colourNumberMayBind, colourNumberRuns } from '../scripts/lib/colour-digit-guard.mjs';

/* A colour NUMBER is an identity, not a spelling. The shared matcher refuses to
   move a digit inside its fuzzy tail, but its exact / seriesNum / alias passes
   reach the library by a REWRITTEN spelling, so anything that writes a binding
   has to re-assert the rule on the answer it got back.

   The case that forced this file into existence: production DRY-RUN
   31452652036 passed `PC151-101` -> `PC151-11`, the single binding
   bind-null-colour-lines.mjs exists to refuse. The guard had joined the digit
   runs into one blob before comparing, so `15111` padded to `151101` and the
   two numbers looked identical. Keeping the separator is the fix, and this test
   is what stops it being "simplified" back. */

describe('colourNumberRuns keeps the separator', () => {
  test('a hyphen separates the series number from the colour number', () => {
    expect(colourNumberRuns('PC151-101')).toEqual(['151', '101']);
    expect(colourNumberRuns('PC151-11')).toEqual(['151', '11']);
  });

  test('letter-O is never read as a zero', () => {
    // BO315 is a letter-O; B0315 is a written zero. They must not agree by digits.
    expect(colourNumberRuns('BO315-1')).toEqual(['315', '1']);
    expect(colourNumberRuns('B0315-1')).toEqual(['0315', '1']);
  });

  test('a name-only colour writes no number at all', () => {
    expect(colourNumberRuns('Cream')).toEqual([]);
    expect(colourNumberRuns('sliver')).toEqual([]);
  });
});

describe('colourNumberMayBind', () => {
  test('THE REGRESSION: PC151-101 may not bind to PC151-11', () => {
    // joined, these are 151101 and 15111 - and padding the second yields the
    // first, which is exactly how this slipped through in production.
    expect(colourNumberMayBind('PC151-101', 'PC151-11')).toBe(false);
  });

  test('the same number written the same way binds', () => {
    expect(colourNumberMayBind('STAR-09', 'STAR-09')).toBe(true);
    expect(colourNumberMayBind('MB-04', 'MB-04')).toBe(true);
    // the library keeps the colour NAME in colour_id; the document does not
    expect(colourNumberMayBind('STAR-10', 'STAR-10 NAVY')).toBe(true);
    // a typo in the SERIES LETTERS is allowed - only digits are an identity
    expect(colourNumberMayBind('HC151-17', 'PC151-17')).toBe(true);
  });

  test('exactly one padding zero on the final run is allowed, and no more', () => {
    expect(colourNumberMayBind('J9226-2', 'ARMANI J9226-02 BUTTER CREAM')).toBe(true);
    expect(colourNumberMayBind('MODENZA 5', 'MODENZA-05')).toBe(true);
    expect(colourNumberMayBind('J9226-2', 'ARMANI J9226-002')).toBe(false);
  });

  test('a colour named only by word is not subject to the guard', () => {
    // the matcher drops any fold key two library rows share, so a name-only hit
    // is unique by construction; refusing it would discard a correct binding.
    expect(colourNumberMayBind('Cream', 'KS-02')).toBe(true);
    expect(colourNumberMayBind('sliver', 'KS-15')).toBe(true);
  });

  test('every silent swap the matcher docstring names stays refused', () => {
    expect(colourNumberMayBind('B0315-27', 'BO315-2')).toBe(false);
    expect(colourNumberMayBind('B0315-29', 'BO315-2')).toBe(false);
    expect(colourNumberMayBind('HR805-20', 'HR805-40')).toBe(false);
    expect(colourNumberMayBind('Chantic141-5', 'CHANTIC-141-2')).toBe(false);
    expect(colourNumberMayBind('GD8371-03', 'GD8371-02')).toBe(false);
    expect(colourNumberMayBind('STAR-10', 'STAR 01')).toBe(false);
  });

  test('a truncated number is not the same number', () => {
    expect(colourNumberMayBind('STAR-1', 'STAR-10 NAVY')).toBe(false);
  });
});
