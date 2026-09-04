import { describe, expect, test } from 'vitest';
import { parseSofa } from '../scripts/lib/parse-sofa.mjs';
import { isSingleSeatBuild, SAYS_ONE_SEATER } from '../scripts/lib/sofa-single-seat.mjs';

/* The owner's split, 2026-09-04: a `-1S` line is EITHER "the book says one seat
   and we agree" OR "we could not read the build". Both were one number in the
   completeness audit and the second is the only one that is work.

   Every string below is real production text (company 1, measured 2026-09-04);
   the docs are named so the next reader can go and look. */

const ask = (d2, model = '8030', recl = false) =>
  isSingleSeatBuild(d2, parseSofa(d2, model, recl));

describe('the book says a single seater', () => {
  test('HC-SO-011000 — the Desc2 opens with 1S', () => {
    expect(ask('1S/Size:35”/Col:MODENZA 04-MUSTARD')).toBe(true);
  });

  test('HC-SO-013286 — the 1S is written last', () => {
    expect(ask('BO315-21 pearl/35”/1S')).toBe(true);
  });

  test('HC-SO-011571 — a cm seat size does not change the answer', () => {
    expect(ask('BO315-11 metal/75cm/1S', '8050')).toBe(true);
  });
});

describe('a -1S line that is NOT an agreement', () => {
  /* THE REASON THE DECODER HALF IS REQUIRED. A three-sofa suite contains the
     letters "1S"; its 1S line is correct, but for a different reason, and
     counting it as "the book says a single seater" would hide a real build. */
  test('HC-SO-001472 "3S+2S+1S" is a suite, not a single seater', () => {
    expect(ask('3S+2S+1S / (COL: ORION 4)', '00913')).toBe(false);
  });

  test('HC-SO-006941 "2+1S”70cm”" is a two-piece run', () => {
    expect(ask('2+1S”70cm”/col:J9047-1-Brunette', '7223')).toBe(false);
  });

  /* THE REASON THE TEXT HALF IS REQUIRED. "Seater depth +1”" is an instruction,
     and its "+1" reaches the grammar as a bare unit — so the decoder alone reads
     a single seater out of a Desc2 that carries no build at all. This line is
     backlog: only the photograph can answer it. */
  test('HC-SO-013327 — a "+1" out of a depth instruction is not a build', () => {
    expect(ask('Size:24”/Col:BO315-7 Peach/Bottom wrap nylon/Seater depth +1”', '8069')).toBe(false);
  });

  test('HC-SO-013320 — colour and a bottom note only', () => {
    expect(ask('col: HR805-20\nNilon bottom', '8069')).toBe(false);
  });

  test('HC-SO-003295 — the book says a 2-seater, the line says 1S', () => {
    expect(ask('2R(60cm) / Guardian - 05', '2379')).toBe(false);
  });
});

describe('SAYS_ONE_SEATER reads a token, not a substring', () => {
  test.each(['1S', '1 S', '1S/Size:30”', 'Col:X/1S', '1 SEATER (30”)'])('%s writes one seat', (s) => {
    expect(SAYS_ONE_SEATER.test(s)).toBe(true);
  });

  test.each(['21S', '1SX', '1SEAT2', '2S+3S'])('%s does not', (s) => {
    expect(SAYS_ONE_SEATER.test(s)).toBe(false);
  });
});
