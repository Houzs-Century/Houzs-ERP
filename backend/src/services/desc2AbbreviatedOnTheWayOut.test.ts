// The obvious fix — shorten what the ERP stores — was built and abandoned when
// the plan showed it would reprice live sales orders: `variants.specials` is
// matched BY NAME in mfg-pricing.ts (`findOption(pool, p)`, "Unknown picks
// contribute 0"), and recomputeOneLine runs on save. So the abbreviation happens
// on the way OUT, and these are the cases that keep it honest.
import { describe, expect, it } from 'vitest';
import {
  abbreviateDesc2,
  DESC2_ABBREVIATIONS,
  pointSpecialsAtTheErp,
  SPECIAL_ORDER_POINTER,
} from './autocount-desc2-abbrev';
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
    /* REWRITTEN 2026-09-10, and the rewrite is the point. This used to use the
       106-character add-on note on HC-SO-007678, which the owner's pointer rung
       now fits — so that string no longer tests this property at all.

       The property still holds and still matters: when the length is NOT in the
       special order, nothing here can reach it, and the caller must refuse
       rather than send half a specification. A colour name is the case. */
    const huge = `A VERY LONG FABRIC NAME ${'X'.repeat(120)} / DIVAN 8" + LEG 0"`;
    const out = abbreviateDesc2(huge, AC_DESC2_MAX);
    expect(out.length).toBeGreaterThan(AC_DESC2_MAX);
    expect(out).toBe(huge);
  });

  it('never reaches into the prose of an add-on note', () => {
    /* A bare `Drawer` rule did exactly that — "one drawer on the left" became
       "one Dwr on the left" — and was removed. Every rule names a whole phrase
       somebody picked.

       ASKED OF THE ABBREVIATIONS THEMSELVES, not of the whole ladder: the
       pointer rung below replaces the entire special segment when nothing else
       fits, so running the ladder here would prove nothing about the rules. */
    const note = 'HB Fully Cover + one drawer on the left and one drawer on the right';
    let out = note;
    for (const [pattern, short] of DESC2_ABBREVIATIONS) out = out.replace(pattern, short);
    expect(out).toContain('one drawer on the left');
    expect(out).toContain('one drawer on the right');
    expect(out).toContain('HB FC');
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

// ----------------------------------------------------------------------------
// THE LAST RUNG: POINT AT THE ERP.
//
// The owner, 2026-09-10, deciding what AutoCount is FOR:
//   「反正我们没有用 Auto Call 的 PO 那些,用 Auto Call 只是因为我要平行跑这个
//    系统 ... Special Order 可以不进,最重要是每一张单都可以进到就行了。」
//   「你可以写说 "Special Order: Refer to ERP"。」
//
// AutoCount is a parallel run; the factory builds from the ERP and the PDF. So
// the special order is not load-bearing there, and a document that reaches the
// book with a pointer beats a document that reaches nothing with the full text.
//
// A POINTER IS NOT A TRUNCATION, and that is why it is allowed where cutting is
// not: half a specification reads as a complete instruction and builds the wrong
// furniture; a sentence that says where the specification lives cannot.
// ----------------------------------------------------------------------------
describe('a special order that will not fit points at the ERP instead', () => {
  /* The two lines of HC-SO-007678, verbatim off production on 2026-09-09. They
     are 207 and 212 characters against a column that holds 100, and no
     abbreviation reaches them: the length is free prose on a paid add-on. */
  const HC_SO_007678_LINE_2 = 'KS-16 ICE STEEL / DIVAN 8" + LEG 0" / GAP 12" / T.Heights 20" / SPECIAL: Left Drawer'
    + ' + Right Drawer + Customer would like to customize the front divan with one drawer on the'
    + ' left and one drawer on the right.';
  const HC_SO_2609_037 = 'DIVAN 8" + NO LEG / GAP 12" / T.Heights 20" / SPECIAL: HB Fully Cover'
    + ' + Divan Top Fully Cover + HB Straight + No Side Panel';

  it('brings the 207-character line inside the column', () => {
    expect(HC_SO_007678_LINE_2.length).toBe(207);
    const out = abbreviateDesc2(HC_SO_007678_LINE_2, AC_DESC2_MAX);
    expect(out.length).toBeLessThanOrEqual(AC_DESC2_MAX);
    expect(out).toContain(SPECIAL_ORDER_POINTER);
    /* Everything that is NOT the special order still travels. */
    expect(out).toContain('KS-16 ICE STEEL');
    expect(out).toContain('T.Heights 20"');
  });

  it('brings the 123-character line inside the column', () => {
    expect(HC_SO_2609_037.length).toBe(123);
    expect(abbreviateDesc2(HC_SO_2609_037, AC_DESC2_MAX).length).toBeLessThanOrEqual(AC_DESC2_MAX);
  });

  it('is the LAST rung — a line the abbreviations can save keeps its specials', () => {
    /* HC-SO-012312, which the abbreviations alone bring from 115 to 98. Reaching
       for the pointer here would throw away three real customisations that fit. */
    const line = 'PC151-11 / DIVAN 10" + NO LEG / GAP 14" / T.Heights 24"'
      + ' / SPECIAL: HB Fully Cover + Divan Full Cover + Right Drawer';
    const out = abbreviateDesc2(line, AC_DESC2_MAX);
    expect(out.length).toBeLessThanOrEqual(AC_DESC2_MAX);
    expect(out).not.toContain(SPECIAL_ORDER_POINTER);
    /* All three customisations still travel, and `Right Drawer` is not even
       abbreviated: the ladder stops at the least change that fits. */
    expect(out).toContain('HB FC');
    expect(out).toContain('Divan FC');
    expect(out).toContain('Right Drawer');
  });

  it('never fires on a line that already fits', () => {
    const fits = 'PC151-11 / SPECIAL: Right Drawer';
    expect(abbreviateDesc2(fits, AC_DESC2_MAX)).toBe(fits);
  });
});

describe('the pointer replaces a SEGMENT, never the tail of the string', () => {
  it('keeps a FREE campaign segment that prints after the special one', () => {
    /* buildVariantSummary prints `FREE - <campaign>` LAST, after SPECIAL. Cutting
       to the end of the string would delete a different fact about the line. */
    const line = 'PC151-11 / SPECIAL: Left Drawer + Right Drawer / FREE - Raya 2026';
    expect(pointSpecialsAtTheErp(line))
      .toBe(`PC151-11 / ${SPECIAL_ORDER_POINTER} / FREE - Raya 2026`);
  });

  it('leaves a line with no special order exactly as it is', () => {
    const line = 'PC151-11 / DIVAN 10" + NO LEG / GAP 14"';
    expect(pointSpecialsAtTheErp(line)).toBe(line);
  });

  it('does not touch a segment that merely mentions the word', () => {
    const line = 'PC151-11 / COL: SPECIAL EDITION BEIGE';
    expect(pointSpecialsAtTheErp(line)).toBe(line);
  });

  it('is the owner\'s sentence, not a paraphrase', () => {
    /* Pinned because it is text a person in the office reads and acts on. */
    expect(SPECIAL_ORDER_POINTER).toBe('Special Order: Refer to ERP');
  });
});
