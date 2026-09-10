// The obvious fix — shorten what the ERP stores — was built and abandoned when
// the plan showed it would reprice live sales orders: `variants.specials` is
// matched BY NAME in mfg-pricing.ts (`findOption(pool, p)`, "Unknown picks
// contribute 0"), and recomputeOneLine runs on save. So the abbreviation happens
// on the way OUT, and these are the cases that keep it honest.
import { describe, expect, it } from 'vitest';
import { abbreviateDesc2 } from './autocount-desc2-abbrev';
import { AC_DESC2_MAX } from './autocount-sofa-collapse';

const PREFIX_12312 = 'PC151-11 / DIVAN 10" + NO LEG / GAP 14" / T.Heights 24" / SPECIAL: ';
const PREFIX_2609 = 'PC151-11 / DIVAN 8" + LEG 0" / GAP 12" / T.Heights 20" / SPECIAL: ';

describe('a Description 2 is abbreviated only on its way to the account book', () => {
  it('leaves a string that already fits EXACTLY as it was', () => {
    /* The rule that makes this safe to ship: nothing that reaches AutoCount
       today reaches it differently tomorrow. */
    const ok = `${PREFIX_2609}HB Fully Cover`;
    expect(ok.length).toBeLessThanOrEqual(AC_DESC2_MAX);
    expect(abbreviateDesc2(ok, AC_DESC2_MAX)).toBe(ok);
  });

  it('brings HC-SO-012312 under the column using the owner\'s own words', () => {
    const over = `${PREFIX_12312}HB Fully Cover + Divan Full Cover + Right Drawer`;
    expect(over.length).toBe(115);
    const out = abbreviateDesc2(over, AC_DESC2_MAX);
    expect(out.length).toBeLessThanOrEqual(AC_DESC2_MAX);
    expect(out).toContain('HB FC');
    expect(out).toContain('Divan FC');
  });

  it('brings HC-PO-2609-017 under it too', () => {
    const over = `${PREFIX_2609}HB back fully covered + HB Fully Cover`;
    expect(over.length).toBe(104);
    expect(abbreviateDesc2(over, AC_DESC2_MAX).length).toBeLessThanOrEqual(AC_DESC2_MAX);
  });

  it('stops at the LEAST abbreviation that fits', () => {
    /* A line needing only one word shortened does not also lose the others —
       the shortest text is not the goal, the fitting one is. */
    const over = `${PREFIX_12312}HB Fully Cover + Divan Full Cover + X`;
    expect(over.length).toBeGreaterThan(AC_DESC2_MAX);
    const out = abbreviateDesc2(over, AC_DESC2_MAX);
    expect(out.length).toBeLessThanOrEqual(AC_DESC2_MAX);
    /* The FIRST rule alone (Divan Full Cover -> Divan FC) is enough, so the
       second phrase must come through untouched. */
    expect(out, 'went further than it needed to').toContain('HB Fully Cover');
  });

  it('NEVER truncates — a string it cannot fit keeps every word', () => {
    /* The 106-character add-on note on HC-SO-007678 is not abbreviable, and the
       caller must still refuse rather than send half a specification. */
    const huge = `${PREFIX_2609}Customer would like to customize the front divan with one drawer on the left and one drawer on the right.`;
    const out = abbreviateDesc2(huge, AC_DESC2_MAX);
    expect(out.length).toBeGreaterThan(AC_DESC2_MAX);
    expect(out).toContain('one drawer on the right.');
  });

  it('never reaches into the prose of an add-on note', () => {
    /* A bare `Drawer` rule did exactly that — "one drawer on the left" became
       "one Dwr on the left" — and was removed. Every rule names a whole phrase
       somebody picked. */
    const note = `${PREFIX_2609}HB Fully Cover + one drawer on the left and one drawer on the right`;
    expect(abbreviateDesc2(note, AC_DESC2_MAX)).toContain('one drawer on the left');
  });

  it('does not eat a longer phrase with a shorter one inside it', () => {
    /* `Divan Full Cover` must not be reached by the rule for `Fully Cover`, and
       `Right Drawer` must not be reached by the bare `Drawer` rule first. */
    const over = `${PREFIX_12312}Divan Full Cover + Right Drawer + Divan Full Cover`;
    const out = abbreviateDesc2(over, AC_DESC2_MAX);
    expect(out).not.toContain('Divan Full Cover');
    expect(out).toContain('Divan FC');
  });
});
