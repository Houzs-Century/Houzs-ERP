import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the importers and the refresh scripts
import { parseSofa } from '../scripts/lib/parse-sofa.mjs';
// @ts-expect-error - plain .mjs
import { parseBedframe } from '../scripts/lib/parse-bedframe.mjs';
// @ts-expect-error - plain .mjs
import { buildFabricColourIndex } from '../scripts/lib/fabric-colour-match.mjs';

/* EXTRACTION, not matching. The matcher can only answer a string somebody hands
   it, and the owner's first example on 2026-09-04 was labelled by him as "a bad
   extraction, not a bad code": the colour sat in the AutoCount Desc2 and never
   reached the matcher at all.

   Two mechanisms did that, and each one is a class rather than a row:

     1. parseSofa reads a colour written with NO "COL:" label only when the
        caller supplies `knownColour`, and its pre-filter demanded a letter
        IMMEDIATELY before a digit. Every series whose name is a word and whose
        number follows a dash - MODENZA-05, CHINO-06, GARFIELD-01, GUARDIAN-05 -
        failed that filter.
     2. parseBedframe's bare-code rules required a word boundary after the
        number and allowed no separator inside the series, so "PC151-02Divan8+4"
        and "PC:151-01" walked straight past a colour sitting in the text.

   Measured on company 1, 2026-09-04: 4,305 migrated sofa/bedframe lines, of
   which 2,009 carry no colour. The two mechanisms above account for 45 of them.
 */

type Row = { fabric_id: string; colour_id: string; label: string; active: boolean };
const row = (fabric_id: string, colour_id: string, label = colour_id): Row =>
  ({ fabric_id, colour_id, label, active: true });

const LIBRARY: Row[] = [
  row('MODENZA', 'MODENZA-05', 'MODENZA-05 DARK OLIVE'),
  row('MODENZA', 'MODENZA-01', 'MODENZA-01 HOUSTON CREAM'),
  row('CHINO', 'CHINO-06', 'CHINO-06'),
  row('GUARDIAN', 'GUARDIAN-05', 'GUARDIAN-05'),
  row('HR805', 'HR805-90', 'HR805-90'),
  row('PC151', 'PC151-01', 'PC151-01'),
  row('PC151', 'PC151-02', 'PC151-02'),
];
const { findColour } = buildFabricColourIndex(LIBRARY);
const knownColour = (c: string): string | null => {
  const h = findColour(c) as Row | null;
  return h ? h.colour_id : null;
};
const sofaColour = (d2: string): string | null =>
  (parseSofa(d2, '9028', false, { knownColour }) as { color: string | null }).color;
const bedColour = (d2: string): string | null =>
  (parseBedframe(d2) as { color: string | null }).color;

describe('sofa: a colour-first Desc2 with no COL: label', () => {
  test('a WORD series numbered with a dash is read, once the library confirms it', () => {
    expect(sofaColour('MODENZA-05 (DARK OLIVE)/35"/1R+1R')).toBe('MODENZA-05');
    expect(sofaColour('CHINO-06 (NAVY BLUE)/28"/1B+1B')).toBe('CHINO-06');
    expect(sofaColour('Modenza-01 houston cream/28"/1R+1NA+1R')).toBe('MODENZA-01');
    expect(sofaColour('2R(60cm) / Guardian - 05')).toBe('GUARDIAN-05');
  });

  test('a CODE series still works - this widened the filter, it did not replace it', () => {
    expect(sofaColour('HR805-90/35"/1R+1R')).toBe('HR805-90');
  });

  test('the library is still the guard: an unconfirmed code is left blank', () => {
    expect(sofaColour('ZZ999-05 (NOTHING)/28"/2L')).toBeNull();
    expect(sofaColour('MODENZA-99/28"/2L')).toBeNull();
  });

  test('a piece list, a size and a seat label are still not colours', () => {
    expect(sofaColour('28"/1B(LHF)+C+1NA+CONSOLE+1A(RHF)+STOOL')).toBeNull();
    expect(sofaColour('Size:28"/2L')).toBeNull();
    expect(sofaColour('1R+1NA+C+1R')).toBeNull();
    expect(sofaColour('3S (28")')).toBeNull();
  });

  test('without knownColour nothing is read - the guard is the library, not the shape', () => {
    expect((parseSofa('MODENZA-05 (DARK OLIVE)/35"/1R+1R', '9028', false) as { color: string | null }).color).toBeNull();
  });
});

describe('bedframe: the bare code the rules used to walk past', () => {
  test('the code glued to the next word is still the code', () => {
    expect(bedColour('PC151-02Divan8+4/Gap12')).toBe('PC151-02');
    expect(bedColour('PC151-01Divan+Side Panel/8inch+4inchLeg/Gap14inch')).toBe('PC151-01');
  });

  test('a colon inside the series is still the same code', () => {
    expect(bedColour("Divan:10''+NO Leg/Gap:12''/PC:151-01")).toBe('PC:151-01');
    expect(findColour('PC:151-01')).toBeTruthy();
  });

  test('a measurement is still not read as a colour', () => {
    expect(bedColour('Divan:8"+4"leg/M.GAP:12"')).toBeFalsy();
    expect(bedColour('Col:TBC/Divan:8inch no legs/gap:12inch')).toBeFalsy();
  });
});
