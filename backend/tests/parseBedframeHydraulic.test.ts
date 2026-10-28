/* HYDRAULIC: the picker tick and the divan height are COMPLEMENTARY.
 *
 * Owner 2026-08-11: "开 special order 那边勾选" — HYDRAULIC becomes a tickable
 * Special Orders code. This OVERRIDES the earlier recommendation from two
 * agents that it stay a property of the divan base and never become a
 * `special_addons` row.
 *
 * The trap this file exists to hold shut. `parse-bedframe.mjs` reads the SAME
 * hydraulic wording for TWO different answers:
 *
 *   the MEASUREMENT  -> variants.divanHeight, derived at :56-89 (outer wins,
 *                       inner + 2 — owner's ruling 2026-08-10)
 *   the BED TYPE     -> the "hydraulic" phrase pushed at :89, which the phrase
 *                       map now resolves to the picker code
 *
 * Making the tick a substitute for the height would silently drop the
 * measurement on 45 of the 49 migrated lines that carry both. So every case
 * below asserts BOTH answers off ONE string: the code maps AND the height
 * survives. A future edit that satisfies one and breaks the other fails here.
 */
import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by both importers and both refresh scripts
import { parseBedframe } from '../scripts/lib/parse-bedframe.mjs';
import MAP from '../scripts/data/special-order-phrase-map.json';

const CODE = 'Hydraulic';
const fam = (MAP.families as Array<{ code: string; categories: string[]; yes: string; no?: string }>)
  .find((f) => f.code === CODE)!;

// the normalisation the map declares in its own `_matching` note
const flat = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const YES = new RegExp(fam.yes);
const NO = fam.no ? new RegExp(fam.no) : null;
const mapped = (phrase: string) => { const s = flat(phrase); return !(NO && NO.test(s)) && YES.test(s); };

/** The whole chain the backfill walks: AutoCount Desc2 -> parser phrases ->
 *  picker code. Testing the map alone would pass while the parser stopped
 *  emitting anything for it. */
const chainMapsToCode = (desc2: string): boolean =>
  (parseBedframe(desc2).specials as string[]).some(mapped);

describe('HYDRAULIC is a Special Orders code (owner 2026-08-11)', () => {
  test('the family is BEDFRAME-scoped — a sofa slip must never gain it', () => {
    expect(fam.categories).toEqual(['BEDFRAME']);
  });

  /* Verbatim wordings the migrated slips actually use. The first three are the
     shapes the owner named; the bare tag is what the parser itself emits. */
  const SHOULD_MAP = [
    'DIV 12" HYDRAULIC',
    'Divan: Hydraulic/ Inner Hydraulic: 12"',
    'HYDRAULIC:16"',
    'hydraulic',
    'Col:X(hydraulic 16”/Inner 14”/4Pump)',
    "DIVAN:10'INCH 1'INCH LEG/HYDRAULIC",
    'Hydraulic2pcs12”inner',
  ];

  /* parse-bedframe.mjs:33 folds these spellings to HYDRAULIC before pushing the
     phrase, but raw slip text reaching the map directly does not go through
     that, so the family carries the alternatives itself. */
  const MISSPELLINGS = ['HYDROLIC', 'HYDRAULLIC', 'HYDRAILIC'];

  /* Neighbouring bedframe families, and the words that merely start the same.
     The family matches WITHOUT word boundaries (the slips glue words together,
     'Hydraulic2pcs12"inner'), so the hydr(aul|ol|ail) stem is what keeps
     'hydration' and 'dehydrated' out — these two are that guard. */
  const SHOULD_NOT_MAP = [
    'front drawer',
    'HB straight to wall',
    'divan curve',
    '1 piece divan',
    'hydration',
    'dehydrated foam',
  ];

  for (const phrase of SHOULD_MAP)
    test(`"${phrase}" maps to ${CODE}`, () => { expect(mapped(phrase)).toBe(true); });

  for (const phrase of MISSPELLINGS)
    test(`the misspelling "${phrase}" maps to ${CODE}`, () => { expect(mapped(phrase)).toBe(true); });

  for (const phrase of SHOULD_NOT_MAP)
    test(`"${phrase}" does NOT map to ${CODE}`, () => { expect(mapped(phrase)).toBe(false); });
});

describe('the tick does NOT replace variants.divanHeight', () => {
  /* [Desc2, the divan height it must still derive]. Every one of these is a
     shape the owner's 2026-08-10 ruling covers: an outer figure wins outright,
     an inner-only figure converts at +2. */
  const BOTH: Array<[string, number]> = [
    ['DIV 12" HYDRAULIC', 12],
    ['HYDRAULIC:16"', 16],
    ['Col:X(hydraulic 16”/Inner 14”/4Pump)', 16],   // outer wins over the inner 14
    ['Hydraulic2pcs12”inner', 14],                  // inner-only -> +2, and 2pcs is not a height
    ["DIVAN:10'INCH 1'INCH LEG/HYDRAULIC", 10],
  ];

  for (const [d2, divan] of BOTH) {
    test(`"${d2}" yields BOTH the ${CODE} code AND divanHeight ${divan}`, () => {
      expect(chainMapsToCode(d2)).toBe(true);
      expect(parseBedframe(d2).divan).toBe(divan);
    });
  }

  test('Divan: Hydraulic/ Inner Hydraulic: 12" is an INNER reading — 12 + 2', () => {
    const d2 = 'Divan: Hydraulic/ Inner Hydraulic: 12"';
    expect(chainMapsToCode(d2)).toBe(true);
    expect(parseBedframe(d2).divan).toBe(14);
  });

  /* The 4 of 49 that carry NO height are placeholders, not parse failures.
     Two visible ones are BEDFRAME KIV lines whose Desc2 names no measurement at
     all. The parser must NOT invent one — an invented height would be a
     measurement nobody took. */
  test('a hydraulic line with no measurement gets the code and NO height', () => {
    for (const d2 of ['HYDRAULIC', 'BEDFRAME KIV HYDRAULIC']) {
      expect(chainMapsToCode(d2)).toBe(true);
      expect(parseBedframe(d2).divan).toBeUndefined();
    }
  });
});
