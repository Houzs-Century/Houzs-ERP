import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the two importers and the two top-ups
import { bedframeVariants, parseBedframe } from '../scripts/lib/parse-bedframe.mjs';

/* AN UNDECIDED HEIGHT IS NOT ZERO.
 * ---------------------------------------------------------------------------
 * `bedframeVariants` reads a book line as `Divan: TBC / Gap: 12"` and returns
 * `divanHeight: null` — correctly, the divan has not been chosen — and then
 * `totalHeight: '12"'`, which says the bed is twelve inches tall. It is not.
 * Nobody knows yet how tall it is, because the divan under it has not been
 * picked. The undecided component was counted as ZERO.
 *
 * The same function's COLOUR arm already honours the owner's rule that TBC/KIV
 * means "not chosen yet" (`isPendingColour`, lib/fabric-colour-match.mjs, and
 * see the owner ruling recorded as 「blank is OK until an order is proceeded」).
 * The HEIGHT arm did not. One function, two answers to the same question.
 *
 * ── WHY THE RECONCILE CANNOT CATCH THIS, AND WHY THIS TEST IS SHAPED SO ────
 * The AutoCount-vs-ERP reconcile compares OUR value against a value it derives
 * from the book with THE SAME EXPRESSION. Both sides run `bedframeVariants`, so
 * both produce '12"' and the axis reports agreement. A test written the same
 * way — book side against ERP side — passes on a broken reader and proves
 * nothing.
 *
 * So every assertion below is against the INTENDED value, written out by hand
 * from the owner's own model, and never against the other side of a comparison.
 *
 * ── MEASURED, NOT IMAGINED ────────────────────────────────────────────────
 * On the committed book cut (ac-reconcile-truth.json.gz, 83,610 Desc2 lines):
 *   · 55 lines state the DIVAN as TBC/KIV — 45 of them were given a total
 *   · 38 state the mattress GAP as TBC/KIV
 *   · 20 state the LEG as TBC/KIV
 * All three components are written this way by staff, so the fix is about an
 * undecided COMPONENT and not about the divan specifically.
 *
 * ── WHAT MUST NOT CHANGE ──────────────────────────────────────────────────
 * A component that is simply NOT MENTIONED is a different fact from one that is
 * mentioned and undecided, and the owner's model already has rules for it (a
 * divan stated with no leg mentioned means NO leg, 0). Those lines must go on
 * totalling exactly as they do today — the last two cases pin that.
 */

const findColour = () => null;
const V = (text: string) => bedframeVariants(parseBedframe(text), findColour);

describe('an explicitly undecided height component leaves the total unknown', () => {
  test('Divan: TBC / Gap: 12" — the divan is not chosen, so the bed has no known height', () => {
    const v = V('Divan: TBC / Gap: 12"');
    expect(v.divanHeight).toBeNull();
    expect(v.gap).toBe('12"');
    // THE DEFECT: this returned '12"', counting an unchosen divan as zero.
    expect(v.totalHeight).toBeNull();
  });

  test('KIV is the same fact as TBC — both mean "not chosen yet"', () => {
    expect(V('Divan: KIV / Gap: 12"').totalHeight).toBeNull();
  });

  test('a real book line: Col: TBC / Divan: TBC / Gap: 14"', () => {
    const v = V('Col: TBC / Divan: TBC / Gap: 14"');
    expect(v.colourId).toBeNull();
    expect(v.divanHeight).toBeNull();
    expect(v.totalHeight).toBeNull();
  });

  test('an undecided mattress GAP also leaves the total unknown', () => {
    const v = V('COL: PC151-10 / DIVAN: 8"+4" (LEG) / GAP: KIV');
    expect(v.divanHeight).toBe('8"');
    expect(v.legHeight).toBe('4"');
    expect(v.totalHeight).toBeNull();
  });

  test('an undecided LEG also leaves the total unknown', () => {
    const v = V('Headboard Straight/Divan:8"+Leg Tbc/Gap:12"/Col:PC-151-11');
    expect(v.divanHeight).toBe('8"');
    expect(v.totalHeight).toBeNull();
  });

  test('the colour being TBC says nothing about the height', () => {
    // Only the colour is undecided; all three heights are stated.
    const v = V('Color: TBC / Divan: 10" / Gap: 12"');
    expect(v.colourId).toBeNull();
    expect(v.totalHeight).toBe('22"');
  });
});

describe('a component that is merely absent is NOT undecided', () => {
  test('a divan with no leg mentioned still means no leg, and still totals', () => {
    expect(V('Divan: 10" no leg / Gap:12"').totalHeight).toBe('22"');
  });

  test('a line that mentions no divan at all totals what it does state', () => {
    // Unchanged behaviour: nothing here claims a divan exists.
    expect(V('Gap: 12"').totalHeight).toBe('12"');
  });
});
