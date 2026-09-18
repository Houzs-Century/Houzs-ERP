/**
 * ONE RULE ABOUT AN UNDECIDED HEIGHT, ASSERTED IN ALL THREE PLACES IT IS WRITTEN.
 *
 * `docs/bugs/0732-an-undecided-divan-height-was-counted-as-zero-so-the-bed-got.md`
 * fixed the total-height rule in ONE of the three files that carry it and said
 * so in its own scope table:
 *
 *   scripts/lib/parse-bedframe.mjs   (bedframeVariants)   fixed
 *   scripts/lib/variant-merge.mjs    (buildBedframeVariantPatch)   NOT fixed
 *   scripts/lib/variant-reconcile.mjs (decodeBook)                 NOT fixed
 *
 * All three compute `(gap || 0) + (divan || 0) + (leg || 0)`, and in the two
 * unfixed copies `Number(undefined) || 0` still counts a component the book
 * wrote TBC/KIV as ZERO — so a bed whose divan nobody has picked is given a
 * total height anyway.
 *
 * WHY A TEST AND NOT A COMPARISON. The reconcile derives the BOOK's expected
 * total with the same expression the writer uses, so both sides produce the
 * same wrong number and the axis reports agreement. A test written as "book
 * side equals ERP side" passes on a broken reader and proves nothing — the
 * lesson bug 0732 recorded as the thing that mattered more than the bug. Every
 * expectation below is written out by hand from the owner's model.
 *
 * THE TWO HALVES OF THE OWNER'S MODEL, and this test pins BOTH:
 *   UNDECIDED   an EXPLICIT TBC/KIV against a component means nobody knows how
 *               tall the bed is. The total is unknown — `null`, never a smaller
 *               number.
 *   ABSENT      a component the text never mentions is NOT undecided. `Gap: 14"`
 *               with a divan and no leg still totals 22": a divan with no leg
 *               mentioned means no leg. Only an explicit marker counts, and the
 *               controls below fail if a fix ever blurs the two.
 *
 * PROVED RED FIRST. Run against the two unfixed modules this file reported
 * `6 failed | 4 passed (10)` — the 4 that passed being the ABSENT controls,
 * which is exactly the shape that says the new guard has not swallowed them.
 * After the fix: `30 passed (30)` across this file, tests/
 * bedframePendingHeight.test.ts and tests/bedframeVariantsBlock.test.ts.
 */
import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, the shared decoder the writers and the reconcile both use
import { parseBedframe } from '../scripts/lib/parse-bedframe.mjs';
// @ts-expect-error - plain .mjs, the AutoCount re-parse sweeps' patch builder
import { buildBedframeVariantPatch } from '../scripts/lib/variant-merge.mjs';
// @ts-expect-error - plain .mjs, the BOOK side of the reconcile's variant axis
import { decodeBook } from '../scripts/lib/variant-reconcile.mjs';
// @ts-expect-error - plain .mjs, the owner's TBC/KIV colour rule
import { isPendingColour } from '../scripts/lib/fabric-colour-match.mjs';

/* The reconcile injects its decoders rather than importing them, so the book
   side can never quietly become a second opinion about what a Desc2 says. Only
   the bedframe arm is exercised here; the sofa deps are never reached. */
const deps = {
  parseBedframe,
  isPendingColour,
  parseSofa: () => { throw new Error('the bedframe arm must not reach the sofa decoder'); },
  modelAlias: {},
  reclOf: () => false,
  knownColour: () => false,
  colourIdentity: (c: string) => c,
};

const bookTotal = (desc2: string) =>
  decodeBook(deps, { desc2, itemGroup: 'bedframe', itemCode: 'CODY-(SS)' }).totalHeight;

const patchTotal = (desc2: string) => buildBedframeVariantPatch(parseBedframe(desc2), null).totalHeight;

/* Real shapes from the committed book cut. The divan is written TBC/KIV on 55
   Desc2 lines, the mattress gap on 38 and the leg on 20 (measured in bug 0732),
   which is why all three components are exercised and not the divan alone. */
const UNDECIDED = [
  { what: 'the divan is TBC and the gap is stated', desc2: 'Divan: TBC / Gap: 12"' },
  { what: 'the leg is KIV, written before the word as staff do', desc2: 'Clr:TBC/Divan:8"+TBC"legs/Gap:14"' },
  { what: 'the mattress gap itself is TBC', desc2: 'Divan: 8" / MATT GAP: TBC' },
];

const ABSENT = [
  { what: 'a divan and a gap with no leg mentioned totals divan + gap', desc2: 'Col: /Div:8"/M.GAP:14"', want: '22"' },
  { what: 'divan, leg and gap all stated', desc2: 'PC151-01/8inch+4inchLeg/Gap12inch', want: '24"' },
];

describe('an undecided component makes the total unknown — the AutoCount re-parse sweeps', () => {
  for (const c of UNDECIDED) {
    test(`buildBedframeVariantPatch: ${c.what}`, () => {
      expect(patchTotal(c.desc2)).toBeNull();
    });
  }

  for (const c of ABSENT) {
    test(`CONTROL — buildBedframeVariantPatch still totals an ABSENT component: ${c.what}`, () => {
      expect(patchTotal(c.desc2)).toBe(c.want);
    });
  }
});

describe('an undecided component makes the total unknown — the reconcile BOOK side', () => {
  for (const c of UNDECIDED) {
    test(`decodeBook: ${c.what}`, () => {
      /* `null` is not "no bed". `verdictOf` reads a null book value beside an
         ERP value as BOOK_BLANK — "the ERP carries a value the book never
         stated", which is what the book genuinely does here — instead of
         reporting agreement on a height nobody chose. */
      expect(bookTotal(c.desc2)).toBeNull();
    });
  }

  for (const c of ABSENT) {
    test(`CONTROL — decodeBook still totals an ABSENT component: ${c.what}`, () => {
      expect(bookTotal(c.desc2)).toBe(Number(c.want.replace('"', '')));
    });
  }
});
