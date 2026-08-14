import { describe, expect, test } from 'vitest';
import { nonFabricCodeWord as routeWord } from '../src/scm/routes/fabric-tracking';
// @ts-expect-error - plain .mjs, shared with the retire script
import { nonFabricCodeWord as scriptWord, NON_FABRIC_HEAD, RETIRE_STAMP_RE, stampDescription } from '../scripts/lib/non-fabric-code.mjs';

/* THE RULE IS WRITTEN TWICE AND MUST NEVER DIVERGE.

   src/scm/routes/fabric-tracking.ts refuses a product-headed fabric code on the
   write path. scripts/lib/non-fabric-code.mjs decides which rows already in the
   table retire-non-fabric-rows.mjs will deactivate. They have to be the same
   rule: a word added to the guard but not the script leaves rows the guard now
   forbids sitting in the master forever, and a word added to the script but not
   the guard has the script deactivating codes the app still happily accepts —
   the row comes straight back and nobody can see why.

   The route cannot be imported from a .mjs script (it pulls in Hono and its
   auth middleware, and the workflows run Node 20/22, which will not strip
   types), so the copy is real. This file is what keeps it honest: identical
   regex source, and identical verdicts over the guard's own corpus.

   That corpus is not decorative. The nine-in-153 case — genuine fabrics
   DESCRIBED as "SOFA FABRIC KOONA VELVET PEARL" — is why the rule reads the
   code and not the description, and it is pinned on both sides here. */

describe('the guard and the retire script share one rule', () => {
  test('the regex is character-identical, flags included', () => {
    const routeSource = String(
      /^(SOFA|SQUARE\s*PILLOW|LONG\s*PILLOW|BOLSTER|STOOL|CONSOLE|MATTRESS|BEDFRAME|DIVAN|DELIVERY|TRANSPORT|SERVICE|SVC)\b/i,
    );
    // Pinned literally, so editing EITHER real definition without the other fails here.
    expect(String(NON_FABRIC_HEAD)).toBe(routeSource);
  });

  const corpus = [
    // the two rows the 2026-08-13 prod probe found
    'SOFA 5535', 'SQUARE PILLOW', 'sofa 5535', '  SOFA 5535  ', 'SQUARE  PILLOW', 'square pillow',
    // the description trap: genuine fabrics whose DESCRIPTION says SOFA
    'KN390-1', 'KN390-2 SOFA',
    // real catalogue codes, including the awkward ones
    'CG-002', 'EZ-14', 'BF-01', 'AM 275-7', 'GARFIELD - 3 TUNDORA', 'FABR(W) B',
    'TARONI - CREAM', 'FABRIC HR805-10', 'XQ#18', 'M2402-8-YELLOW', 'BO315-2-FEATHER',
    'ALPINE-5311-13', 'SF-AT-01', 'PC151-101',
    // whole-word matching, not prefix matching
    'SOFAR-01', 'CONSOLETTE-2', 'STOOLIE-3', 'SERVICEABLE-1', 'DIVANNA-9',
    // the other condemned heads
    'LONG PILLOW', 'BOLSTER', 'STOOL 12', 'CONSOLE TABLE', 'MATTRESS Q',
    'BEDFRAME 5535', 'DIVAN 3', 'DELIVERY', 'TRANSPORT', 'SERVICE', 'SVC-1',
    // degenerate input must not throw on either side
    '', '   ', 'SOFA', 'sofa',
  ];

  test.each(corpus)('both sides agree on %j', (code) => {
    expect(scriptWord(code)).toBe(routeWord(code));
  });

  test('null and undefined are handled the same way, not thrown on', () => {
    // The route types the parameter as string, but a script reads whatever the
    // column holds, and fabric_code has been null-ish in staging before.
    expect(scriptWord(null)).toBeNull();
    expect(scriptWord(undefined)).toBeNull();
    expect(routeWord(null as unknown as string)).toBeNull();
  });

  test('the two prod rows are condemned and the description trap is not', () => {
    expect(scriptWord('SOFA 5535')).toBe('SOFA');
    expect(scriptWord('SQUARE PILLOW')).toBe('SQUARE PILLOW');
    expect(scriptWord('SQUARE  PILLOW')).toBe('SQUARE PILLOW'); // whitespace normalised
    expect(scriptWord('KN390-1')).toBeNull();
  });
});

/* THE STAMP IS THE ONLY RECORD OF WHY A ROW WENT INACTIVE.

   is_active = false is machine-readable and says nothing. Six months later the
   only thing that explains a greyed-out "SOFA 5535" in the Fabric Converter is
   the sentence appended to its description — so the writer and the recogniser
   have to agree exactly, or a second run stamps the row twice and the original
   description drifts further behind a wall of markers. */
describe('the retire stamp', () => {
  test('appends, keeping the original description verbatim in front', () => {
    expect(stampDescription('5535 (3+L)', 'SOFA', '2026-08-13')).toBe(
      '5535 (3+L) [RETIRED 2026-08-13 - non-fabric code head SOFA: a product, not a fabric. Deactivated, not deleted.]',
    );
  });

  test("survives the quote characters both prod rows actually contain", () => {
    const out = stampDescription('SQUARE PILLOW (16" X 16")', 'SQUARE PILLOW', '2026-08-13');
    expect(out.startsWith('SQUARE PILLOW (16" X 16") ')).toBe(true);
    expect(RETIRE_STAMP_RE.test(out)).toBe(true);
  });

  test('an empty or null description yields the marker alone, not " [RETIRED…"', () => {
    expect(stampDescription(null, 'SOFA', '2026-08-13')).toMatch(/^\[RETIRED /);
    expect(stampDescription('', 'SOFA', '2026-08-13')).toMatch(/^\[RETIRED /);
    expect(stampDescription('   ', 'SOFA', '2026-08-13')).toMatch(/^\[RETIRED /);
  });

  test('what it writes is what it recognises — so a re-run is inert', () => {
    for (const [desc, word] of [['5535 (3+L)', 'SOFA'], ['SQUARE PILLOW (16" X 16")', 'SQUARE PILLOW'], [null, 'BOLSTER']] as const) {
      const once = stampDescription(desc, word, '2026-08-13');
      expect(RETIRE_STAMP_RE.test(once)).toBe(true);
    }
  });

  test('it recognises any date, not just the one it was written on', () => {
    expect(RETIRE_STAMP_RE.test(stampDescription('x', 'SOFA', '2019-01-01'))).toBe(true);
    expect(RETIRE_STAMP_RE.test(stampDescription('x', 'SOFA', '2030-12-31'))).toBe(true);
  });

  test('it does not fire on an unstamped description, however suggestive', () => {
    expect(RETIRE_STAMP_RE.test('5535 (3+L)')).toBe(false);
    expect(RETIRE_STAMP_RE.test('SOFA FABRIC KOONA VELVET PEARL')).toBe(false);
    // the fabric_colours supersede marker is a DIFFERENT stamp and must not match
    expect(RETIRE_STAMP_RE.test('BO315-2 [MERGED into BO315-02 on 2026-08-11 - superseded, not deleted]')).toBe(false);
    expect(RETIRE_STAMP_RE.test('')).toBe(false);
  });
});
