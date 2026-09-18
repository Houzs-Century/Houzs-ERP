import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs library shared by the read-only audit scripts
import {
  atomsOf, coverageBag, isCovered, residueOf, kindOf, sizeTokensFromItemCode,
} from '../scripts/lib/book-text-residue.mjs';

/* The library decides which sofa / bedframe lines the owner is told carry a
   fact the purchase order does not already state, so its edges are worth
   pinning. Every case below is a shape that was MEASURED on the production
   corpus (Export Century SO lines run 34451454550, 3,920 lines) — the counts in
   the comments are what that corpus held, not invented examples. */

const residue = (book: string, doc: string, dropLabels: boolean) =>
  residueOf(book, coverageBag(doc), dropLabels) as string[];

describe('atomsOf cuts on the book\'s separators but not inside brackets', () => {
  test('a bracketed slash does not shred the atom', () => {
    expect(atomsOf("1+1NA+L(26/28'Inch)/Col:KIV/Bottom upgrade to umbrella fabric"))
      .toEqual(["1+1NA+L(26/28'Inch)", 'Col:KIV', 'Bottom upgrade to umbrella fabric']);
  });

  test('commas, semicolons and newlines cut too, and empties are dropped', () => {
    expect(atomsOf('COL: SF-AT-4, DIVAN: 8+4 INCHES LEG;;\nMATTRESS GAP: 12 INCHES'))
      .toEqual(['COL: SF-AT-4', 'DIVAN: 8+4 INCHES LEG', 'MATTRESS GAP: 12 INCHES']);
  });
});

describe('an atom is covered only when the document really says it', () => {
  const bedframe = coverageBag('PC151-14 / DIVAN 8" + LEG 4" / GAP 10" / T.Heights 22"');

  test('the same spec in the book\'s words reads as covered', () => {
    expect(residue('COL: PC151-14 / DIVAN: 8"+4"(LEG) / GAP: 10"',
      'PC151-14 / DIVAN 8" + LEG 4" / GAP 10" / T.Heights 22"', false)).toEqual([]);
  });

  /* The guard that stops a short atom matching inside a longer word. `NA` sits
     inside `NAVY`, and a colour the document does not carry must not be hidden
     because of it. */
  test('a two-character atom cannot match inside a longer token', () => {
    expect(isCovered('NA', coverageBag('A201-7 NAVY'), false)).toBe(false);
    expect(residue('COL:NAVY', 'A201-7 NA', false)).toEqual(['COL:NAVY']);
  });

  test('a genuine instruction survives as residue under both readings', () => {
    const book = "1+1NA+L(26/28'Inch)/Col:KIV/Bottom upgrade to umbrella fabric";
    const doc = 'PC151-01 COLOUR KIV / SEAT 26 / LEG 2"';
    expect(residue(book, doc, false)).toContain('Bottom upgrade to umbrella fabric');
    expect(residue(book, doc, true)).toContain('Bottom upgrade to umbrella fabric');
  });

  /* `;` is one of the book's own separators, so this cuts to two atoms and the
     bare label word carries nothing — which is why the leftover is the VALUE
     alone. That shape is 37 lines of the corpus. */
  test('an empty document covers nothing, and a bare label is not a value', () => {
    expect(residue('COLOUR ; KIV', '', false)).toEqual(['KIV']);
    expect(isCovered('', bedframe, false)).toBe(true);
  });
});

describe('the digit-to-letter split is what makes the two sides comparable', () => {
  /* `GAP:12INCH` appeared as unexplained residue on 80 production lines and
     `M.GAP:12INCH` on 99, purely because `12INCH` was one token and could never
     equal `12`. */
  test('a glued measurement matches the same number spelled our way', () => {
    expect(residue('GAP:12INCH', 'PC151-01 / GAP 12"', false)).toEqual([]);
  });

  test('and it makes the book\'s hyphenated code match ours', () => {
    expect(residue('COL:PC-151-01', 'PC151-01 / SEAT 28', false)).toEqual([]);
  });
});

describe('the LABEL-aware reading drops labels, never values', () => {
  const doc = 'KS-10 SOFT LAVENDAR / DIVAN 8" + LEG 0" / GAP 12" / T.Heights 20"';

  test("the book's own label vocabulary stops counting as new information", () => {
    expect(residue("Col:KS-10/M'Gap:12\"/Div:8\"", doc, false).length).toBeGreaterThan(0);
    expect(residue("Col:KS-10/M'Gap:12\"/Div:8\"", doc, true)).toEqual([]);
  });

  test('NO LEG and our LEG 0" are the same fact', () => {
    expect(residue('DIVAN:8INCH+NO LEG', 'DIVAN 8" + LEG 0" / T.Heights 8"', true)).toEqual([]);
  });

  /* The direction that makes the two readings a bound rather than two guesses:
     dropping labels can only ever move a line towards "says nothing new". */
  test('the label reading never finds MORE than the plain reading', () => {
    const cases: Array<[string, string]> = [
      ['COL: AMBER 01 / SIDE PANEL LEFT', 'AMBER-01'],
      ['COLOUR :KIV/DIVAN : 8 INCHES , NO LEG/MATTRESS GAP : KIV', 'DIVAN 8" + LEG 0" / T.Heights 8"'],
      ['TBC/32”/1R+C+2R', 'SEAT 32'],
      ['KING SIZE DIVAN GAP: 10" + NO LEG/ DIVAN COL: AMBER 01', 'AMBER-01 / DIVAN 10" + LEG 0" / GAP 10"'],
    ];
    for (const [book, doc2] of cases) {
      expect(residue(book, doc2, true).length).toBeLessThanOrEqual(residue(book, doc2, false).length);
    }
  });

  test('a real instruction is still left over after the labels go', () => {
    expect(residue('COL: AMBER 01 / SIDE PANEL LEFT', 'AMBER-01', true)).toEqual(['SIDE PANEL LEFT']);
  });
});

describe('the bed size an item code already states', () => {
  test('a trailing size suffix becomes coverage tokens', () => {
    expect(sizeTokensFromItemCode('DIVAN ONLY-(K)')).toBe('K KING');
    expect(sizeTokensFromItemCode('CROWN-(Q)')).toBe('Q QUEEN');
    expect(sizeTokensFromItemCode('MACRO (A)-(SS)')).toBe('SS SUPER SINGLE');
  });

  test('a code with no size suffix contributes nothing', () => {
    expect(sizeTokensFromItemCode('9058-1A(LHF)')).toBe('');
    expect(sizeTokensFromItemCode(null)).toBe('');
  });
});

describe('kindOf names the shape of a leftover', () => {
  /* A build contains a measurement, so a measurement-first order would file
     every sofa build under "a measurement in words" and hide the second most
     common leftover on the corpus. */
  test('a build is recognised before its measurement is', () => {
    expect(kindOf("1+1NA+L(26/28'Inch)")).toBe('a build / piece list');
    expect(kindOf('1R+1NA+1R')).toBe('a build / piece list');
  });

  test('the undecided colour and the real instruction are told apart', () => {
    expect(kindOf('COL:TBC')).toBe('colour or size not yet decided (KIV / TBC)');
    expect(kindOf('Bottom upgrade to umbrella fabric')).toBe('a fabric or material note');
    expect(kindOf('FULLY COVER REPLACE THE LEG')).toBe('an instruction to change / add / remove');
    expect(kindOf('MATTRESSGAP:12"')).toBe('a measurement in words');
    expect(kindOf('EDGE DO CURVE DIVAN')).toBe('something else');
  });
});
