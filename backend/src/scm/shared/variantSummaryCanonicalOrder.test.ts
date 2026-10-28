/* Description 2 composes in ONE canonical order on every surface (owner
 * 2026-09-22).
 *
 * A modular sofa SET is carried as several SO lines — one per compartment
 * (8030-1B(LHF), 8030-CNR, 8030-1NA, 8030-1A(RHF)) — that share the same
 * fabric, seat, leg and special orders. buildVariantSummary is the ONE composer
 * every surface (SO/PO/DO/GRN/PI editors, the PDFs, the *-description2 export
 * helpers) routes through, so pinning the order here pins it everywhere.
 *
 * The fixed attribute segments already emit in a fixed sequence (fabric → seat/
 * divan → gap → leg → SPECIAL → FREE). The one free axis was the specials WITHIN
 * the SPECIAL segment, which used to print in the operator's pick order and so
 * differed line to line. These pin the deterministic order and — the real
 * complaint — that two lines with the SAME picks in a DIFFERENT order compose an
 * identical string. */
import { describe, expect, it } from 'vitest';
import { buildVariantSummary, canonicalSpecialOrder, compareSpecialLabels } from './variant-summary';

describe('the SPECIAL segment prints in a canonical, pick-order-independent order', () => {
  const PICKS_A = ['Backcushion Firmer', 'Nylon Fabric', 'Seat Base Fully Cover with no Leg'];
  const PICKS_B = ['Seat Base Fully Cover with no Leg', 'Nylon Fabric', 'Backcushion Firmer'];

  it("the owner's SET: line 1 and its siblings compose IDENTICAL Description 2", () => {
    const base = { fabricCode: 'NX010', colourLabel: 'IVORY', seatHeight: '35', legHeight: '1"' };
    const lineOne = buildVariantSummary('sofa', { ...base, specials: PICKS_A });
    const sibling = buildVariantSummary('sofa', { ...base, specials: PICKS_B });
    expect(lineOne).toBe(sibling);
  });

  it('the specials sort by label, after the fixed attribute segments', () => {
    const s = buildVariantSummary('sofa', {
      fabricCode: 'NX010', colourLabel: 'IVORY', seatHeight: '35', legHeight: '1"',
      specials: PICKS_B,
    });
    expect(s).toBe(
      'NX010 IVORY / SEAT 35 / LEG 1" / SPECIAL: Backcushion Firmer + Nylon Fabric + Seat Base Fully Cover with no Leg',
    );
  });

  it('the fixed attributes keep their fixed sequence: fabric / seat / leg / SPECIAL', () => {
    // Whatever order the keys appear on the variants object, the segments order
    // is fixed by the composer, not by the object.
    const s = buildVariantSummary('sofa', {
      specials: ['Wooden Arm'], legHeight: '2"', seatHeight: '30', fabricCode: 'BF-01',
    });
    expect(s).toBe('BF-01 / SEAT 30 / LEG 2" / SPECIAL: Wooden Arm');
  });

  it('the free-text extra add-on note trails the sorted picks', () => {
    // "AAA…" sorts first alphabetically but is a NOTE, so it must stay last.
    const s = buildVariantSummary('sofa', {
      fabricCode: 'BF-01', seatHeight: '30',
      specials: ['Nylon Fabric', 'Backcushion Firmer'],
      extraAddonNote: 'AAA custom note',
    });
    expect(s).toBe('BF-01 / SEAT 30 / SPECIAL: Backcushion Firmer + Nylon Fabric + AAA custom note');
  });
});

describe('the shared canonical-order primitives', () => {
  it('compareSpecialLabels is a codepoint comparison (locale-independent)', () => {
    expect(compareSpecialLabels('a', 'b')).toBe(-1);
    expect(compareSpecialLabels('b', 'a')).toBe(1);
    expect(compareSpecialLabels('a', 'a')).toBe(0);
  });

  it('canonicalSpecialOrder does not mutate its input', () => {
    const input = ['c', 'a', 'b'];
    const out = canonicalSpecialOrder(input);
    expect(out).toEqual(['a', 'b', 'c']);
    expect(input).toEqual(['c', 'a', 'b']);
  });
});
