import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the SO and PO importers
import { parseSofa } from '../scripts/lib/parse-sofa.mjs';

/* docs/sofa-import-handoff.md section 7: "owner 给的每个新例子都补成金标测试".
   Until now there was none, and that is exactly how #1813 shipped a NOISE class
   ([A-KM-OQ-Z]) that swallowed a bare "C" and a bare "R" before either could
   reach its classification arm — 49 real cutover lines decoded one compartment
   short at HIGH confidence, with no placeholder and no flag.

   Every case below is a rule from the handoff doc's own tables (section 2.2 /
   2.3), quoted in the label. Add the owner's next ruling here, not only to the
   parser. */

const pieces = (d2: string, model = '8030', recl = false): string[] =>
  (parseSofa(d2, model, recl) as { pieces: string[] }).pieces;
const conf = (d2: string, model = '8030', recl = false): string =>
  (parseSofa(d2, model, recl) as { conf: string }).conf;

describe('parse-sofa: the single-letter tokens the grammar owns', () => {
  /* The regression this file exists for. C, L, P and R each have their own
     classification arm, so none of them may be filtered as noise. */
  test('bare C is a corner, not noise (1+C+2)', () => {
    expect(pieces('1+C+2(28"INCH)/COL:KIV')).toEqual(['1A(LHF)', 'CNR', '2A(RHF)']);
  });

  test('2s + C + 1s is a corner set', () => {
    expect(pieces('2s + C + 1s (30")', '9058')).toEqual(['2A(LHF)', 'CNR', '1A(RHF)']);
  });

  test('a corner in the middle of a longer run survives', () => {
    expect(pieces('1EL+C+1NA+1ER/32"/col:TBC')).toEqual(['1A(LHF)', 'CNR', '1NA', '1A(RHF)']);
  });

  test('bare L is still a chaise', () => {
    expect(pieces('2S+L(28")')).toEqual(['2A(LHF)', 'L(RHF)']);
  });

  test('bare R on a recliner model is a recliner seat', () => {
    expect(pieces('R(24"Inch)/Col:BO315-4', '2379', true)).toEqual(['1S(R)']);
  });

  test('R+R on a recliner model is a recliner pair', () => {
    expect(pieces('R+R(24"Inch)/Col:X', '2379', true)).toEqual(['1A(R)(LHF)', '1A(R)(RHF)']);
  });

  /* Owner 2026-08-10: 8030/8060/9058/9028/9050/8069/5535 have no recliner. A
     bare R there is genuinely ambiguous, so it must NOT be guessed - the
     placeholder path is the correct outcome, not a silent drop. */
  test('bare R on a NON-recliner model refuses to guess', () => {
    expect(conf('R(24"Inch)/Col:BO315-4', '8030', false)).toBe('low');
  });
});

describe('parse-sofa: combination rules from the handoff doc section 2.3', () => {
  test('1+1 = 1A + 1A', () => {
    expect(pieces('1+1(28")')).toEqual(['1A(LHF)', '1A(RHF)']);
  });

  test('2L puts the seat left and the chaise right', () => {
    expect(pieces('2L(28")')).toEqual(['2A(LHF)', 'L(RHF)']);
  });

  test('L2 is the mirror of 2L', () => {
    expect(pieces('L2(28")')).toEqual(['L(LHF)', '2A(RHF)']);
  });

  test('the bracket wins over the label (2R(1+1))', () => {
    expect(pieces('2R(1+1)')).toEqual(['1A(LHF)', '1A(RHF)']);
  });

  test('3S splits at a seat depth other than 24 inch', () => {
    expect(pieces('3S(28")')).toEqual(['2A(LHF)', '1A(RHF)']);
  });

  test('3S stays whole at 24 inch', () => {
    expect(pieces('3S(24")')).toEqual(['3S']);
  });

  test('4S = 2A + 2A', () => {
    expect(pieces('4S(28")')).toEqual(['2A(LHF)', '2A(RHF)']);
  });

  test('a console forces the seats apart', () => {
    expect(pieces('2S+CONSOLE(28")')).toEqual(['1A(LHF)', 'Console', '1A(RHF)']);
  });

  test('2G1F is a corner set', () => {
    expect(pieces('2G1F(28")')).toEqual(['2A(LHF)', 'CNR', '1A(RHF)']);
  });

  test('a lone Corner sells the whole set', () => {
    expect(pieces('Corner(28")')).toEqual(['2A(LHF)', 'CNR', '1A(RHF)']);
  });

  test('3RR on a recliner model = 1AR + 1NA + 1AR', () => {
    expect(pieces('3RR(28")', '5071', true)).toEqual(['1A(R)(LHF)', '1NA', '1A(R)(RHF)']);
  });

  test('NA/LT opens an armed box', () => {
    expect(pieces('1NA/LT+C+2ER(28")', '558')).toEqual(['1ABOX(LHF)', 'CNR', '2A(RHF)']);
  });
});

describe('parse-sofa: arms only ever close the run (owner 2026-08-10)', () => {
  test('a mid-row armed piece trades places with an armless end', () => {
    expect(pieces('2NA+1R+L')).toEqual(['1A(LHF)', '2NA', 'L(RHF)']);
  });

  test('two same-side arms are corrected by position', () => {
    expect(pieces('1R+2R(28")', '8060')).toEqual(['1A(LHF)', '2A(RHF)']);
  });
});

describe('parse-sofa: never guess', () => {
  test('an empty Desc2 is low confidence, not an empty build', () => {
    const r = parseSofa('', '8030', false) as { conf: string; pieces: string[] };
    expect(r.conf).toBe('low');
    expect(r.pieces).toEqual([]);
  });

  test('an unreadable token refuses rather than dropping it', () => {
    expect(conf('1AP+2(28")')).toBe('low');
  });
});
