import { describe, expect, it } from 'vitest';
import { parseBedframe } from '../scripts/lib/parse-bedframe.mjs';

/* A SIDE drawer is not a FRONT drawer — docs/bugs/0824.
 *
 * The hand tests demanded a space, so `Sidedrawer` (one word, and the way the
 * book actually writes it) matched none of them and fell through to "an
 * unqualified drawer is a front drawer". 41 sales lines over 29 sales orders
 * were recorded as Front while the customer asked for a side one, and the
 * customer of HC-SO-003434 received a delivery order printing "Front Drawer".
 *
 * Every phrasing below is transcribed from a real production line. */
const drawers = (text) => (parseBedframe(text, 'CODY-(Q)')?.specials ?? []).filter((x) => /drawer/i.test(x));

describe('a drawer keeps the side the customer asked for', () => {
  it('reads a hand written with no space, on either side of the word', () => {
    expect(drawers('Leftside Drawer/Divan:8”+No Leg/Gap:14”')).toEqual(['Left Drawer']);
    expect(drawers('Divan: 8" no leg/Gap: 12"/add on right side drawer')).toEqual(['Right Drawer']);
    expect(drawers('Col:TBC/Divan:10”no leg/Add left hand side drawer')).toEqual(['Left Drawer']);
    expect(drawers('Col:KIV/Addon Drawer at side')).toEqual(['Side Drawer (side unknown)']);
    expect(drawers('drawer at the right')).toEqual(['Right Drawer']);
  });

  it('marks a side drawer whose side nobody stated, rather than calling it Front', () => {
    /* The catalogue holds Front / Left / Right and no neutral Side, so the answer
       has to come from the supplier's record, the slip's drawing or the
       salesperson. Marked, never guessed. */
    expect(drawers('Sidedrawer/PC151-01/Divan12/gap10')).toEqual(['Side Drawer (side unknown)']);
    expect(drawers('2SIDE DRAWER/DIV:8”NOLEG/COL:PC151-04')).toEqual(['Side Drawer (side unknown)']);
    expect(drawers('HBDIVANFULLCOVER/sidedrawer')).toEqual(['Side Drawer (side unknown)']);
  });

  it('still calls a front drawer Front, and an unqualified drawer Front', () => {
    expect(drawers('div:10inch / gap:14inch / Front Drawer, HB Fully Cover')).toEqual(['Front Drawer']);
    expect(drawers('frontdrawerdivan12”/PC151-01/gap9')).toEqual(['Front Drawer']);
    expect(drawers('Divan: 8"/ add drawer')).toEqual(['Front Drawer']);
    expect(drawers('Col: KIV / pull out')).toEqual(['Front Drawer']);
  });
});
