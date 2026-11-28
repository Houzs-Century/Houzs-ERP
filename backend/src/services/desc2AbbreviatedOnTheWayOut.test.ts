import { describe, expect, it } from 'vitest';
import {
  abbreviateDesc2,
  DESC2_ABBREVIATIONS,
  pointSpecialsAtTheErp,
  SPECIAL_ORDER_POINTER,
} from './autocount-desc2-abbrev';
import { AC_DESC2_MAX } from './autocount-sofa-collapse';
import { composeDescription2 } from './autocount-writeback';

const PREFIX_12312 = 'PC151-11 / DIVAN 10" + NO LEG / GAP 14" / T.Heights 24" / SPECIAL: ';
const PREFIX_2609 = 'PC151-11 / DIVAN 8" + LEG 0" / GAP 12" / T.Heights 20" / SPECIAL: ';

describe('a Description 2 is abbreviated only on its way to the account book', () => {
  it('leaves a string that already fits EXACTLY as it was', () => {
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
    const over = `${PREFIX_12312}HB Fully Cover + Divan Full Cover + X`;
    expect(over.length).toBeGreaterThan(AC_DESC2_MAX);
    const out = abbreviateDesc2(over, AC_DESC2_MAX);
    expect(out.length).toBeLessThanOrEqual(AC_DESC2_MAX);
    expect(out, 'went further than it needed to').toContain('HB Fully Cover');
  });

  it('NEVER truncates — a string it cannot fit keeps every word', () => {
    const huge = `A VERY LONG FABRIC NAME ${'X'.repeat(120)} / DIVAN 8" + LEG 0"`;
    const out = abbreviateDesc2(huge, AC_DESC2_MAX);
    expect(out.length).toBeGreaterThan(AC_DESC2_MAX);
    expect(out).toBe(huge);
  });

  it('never reaches into the prose of an add-on note', () => {
    const note = 'HB Fully Cover + one drawer on the left and one drawer on the right';
    let out = note;
    for (const [pattern, short] of DESC2_ABBREVIATIONS) out = out.replace(pattern, short);
    expect(out).toContain('one drawer on the left');
    expect(out).toContain('one drawer on the right');
    expect(out).toContain('HB FC');
  });

  it('does not eat a longer phrase with a shorter one inside it', () => {
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
    expect(out).toContain('KS-16 ICE STEEL');
    expect(out).toContain('T.Heights 20"');
  });

  it('brings the 123-character line inside the column', () => {
    expect(HC_SO_2609_037.length).toBe(123);
    expect(abbreviateDesc2(HC_SO_2609_037, AC_DESC2_MAX).length).toBeLessThanOrEqual(AC_DESC2_MAX);
  });

  it('is the LAST rung — a line the abbreviations can save keeps its specials', () => {
    const line = 'PC151-11 / DIVAN 10" + NO LEG / GAP 14" / T.Heights 24"'
      + ' / SPECIAL: HB Fully Cover + Divan Full Cover + Right Drawer';
    const out = abbreviateDesc2(line, AC_DESC2_MAX);
    expect(out.length).toBeLessThanOrEqual(AC_DESC2_MAX);
    expect(out).not.toContain(SPECIAL_ORDER_POINTER);
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
    expect(SPECIAL_ORDER_POINTER).toBe('Special Order: Refer to ERP');
  });
});

describe('the composer is what calls the ladder — the wiring, not the rule', () => {
  const line = (variants: Record<string, unknown>) => ({
    item_code: 'HOK-1003 (A) (K)',
    item_group: 'bedframe',
    description2: null,
    variants,
  });

  it('a special order over the column reaches AutoCount as the pointer', () => {
    const out = composeDescription2(line({
      fabricCode: 'PC151-01', gap: '12"',
      specials: ['Customer would like to customize the front divan with one drawer on the left and one drawer on the right.'],
    }) as never);
    expect(out).not.toBeNull();
    expect(String(out).length).toBeLessThanOrEqual(AC_DESC2_MAX);
    expect(String(out)).toContain(SPECIAL_ORDER_POINTER);
    expect(String(out)).toContain('PC151-01');
  });

  it('a line that fits is composed exactly as it was before any of this', () => {
    const out = composeDescription2(line({ fabricCode: 'PC151-01', gap: '12"', specials: ['Right Drawer'] }) as never);
    expect(String(out)).toContain('Right Drawer');
    expect(String(out)).not.toContain(SPECIAL_ORDER_POINTER);
  });
});
