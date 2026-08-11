import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the SO and PO importers
import { parseSofa } from '../scripts/lib/parse-sofa.mjs';

/* An unlabelled colour code was thrown away as an unrecognised structure token,
 * so the fabric never reached the line. Measured on production 2026-08-11: of
 * the 86 blank colour axes on purchase-order and proceeded sales-order sofa
 * lines, 85 held NO value at all — not an unresolvable one. Teaching the parser
 * to read the code moved 103 of 158 blank-axis lines from "no evidence" to
 * "copyable from AutoCount's own Desc2".
 *
 * The rule is deliberately gated on `opts.knownColour`, a caller-supplied
 * predicate that must consult scm.fabric_colours: a code the library confirms
 * is a COPY, a code it cannot confirm is a GUESS, and this migration does not
 * guess. Every string below is a real Desc2 from the live AED_HOUZS book.
 */

const LIBRARY = new Set([
  'BO315-21', 'BO315-22', 'BO315-25', 'CH141-1', 'BO315-11 METAL', 'M2402-4',
]);
const knownColour = (t: string) => (LIBRARY.has(String(t).trim().toUpperCase()) ? String(t).trim() : null);

const colourOf = (d2: string, model = '8030', opts?: unknown): string | null =>
  (parseSofa(d2, model, false, opts) as { color: string | null }).color;

describe('an unlabelled colour code is read only when the fabric library confirms it', () => {
  test('without the predicate the parser behaves exactly as before — the code is still dropped', () => {
    expect(colourOf('BO315-21 (PEARL)/28"/2L')).toBeNull();
    expect(colourOf('CH141-1 (CREAM)/30"/1P+1NA+1P', '8051')).toBeNull();
  });

  test('a leading code with its colour name in brackets', () => {
    expect(colourOf('BO315-21 (PEARL)/28"/2L', '8030', { knownColour })).toBe('BO315-21');
  });

  test('a code glued to a note is read without the note', () => {
    expect(colourOf('2s(28")/BO315-22(feather)', '9028', { knownColour })).toBe('BO315-22');
  });

  test('a code with a word in it survives as written', () => {
    expect(colourOf('BO315-11 metal/75cm/1S', '8050', { knownColour })).toBe('BO315-11 metal');
  });

  test('a LABELLED colour still wins, and is taken verbatim', () => {
    expect(colourOf('colour : HR 805-9\nwrap bottom to Nilon\n30 inch per seat', '9058', { knownColour }))
      .toBe('HR 805-9');
  });

  test('a code the library does not have is left blank rather than guessed', () => {
    expect(colourOf('ZZ999-1 (NOTHING)/28"/2L', '8030', { knownColour })).toBeNull();
  });

  test('a size is never promoted to a colour', () => {
    expect(colourOf('28"/2L', '8030', { knownColour: () => 'WRONG' })).toBeNull();
    expect(colourOf('75cm/1S', '8050', { knownColour: () => 'WRONG' })).toBeNull();
  });

  test('a piece list is never promoted to a colour', () => {
    expect(colourOf('1P+1NA+1P', '8051', { knownColour: () => 'WRONG' })).toBeNull();
    expect(colourOf('1R+1NA+1NA+C+1R', '9058', { knownColour: () => 'WRONG' })).toBeNull();
  });

  test('the structure is still parsed — reading the colour must not eat a segment', () => {
    const r = parseSofa('BO315-21 (PEARL)/28"/2L', '8030', false, { knownColour }) as
      { pieces: string[]; size: string | null; color: string | null };
    expect(r.pieces).toEqual(['2A(LHF)', 'L(RHF)']);
    expect(r.size).toBe('28');
    expect(r.color).toBe('BO315-21');
  });

  test('the value carries the exact text it was cut from, so a wrong read is refutable', () => {
    const r = parseSofa('CH141-1 (CREAM)/30"/1P+1NA+1P', '8051', false, { knownColour }) as
      { colorEvidence?: string };
    expect(r.colorEvidence).toBe('CH141-1 (CREAM)');
  });
});
