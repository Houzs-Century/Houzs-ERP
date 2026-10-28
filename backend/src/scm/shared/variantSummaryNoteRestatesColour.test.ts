/* A Special Order note that only repeats the line's colour prints once.
 *
 * 2026-09-15 a data run (recategorise-fabric-accessory.mjs) wrote the colour each
 * Sofa Accessory line already named in its Special Order text into
 * variants.fabricCode. The composer printed both: HC-SO-013503's LONG PILLOW read
 * "COVE-13 / SPECIAL: Col : cove 13" and HC-SO-2609-072's SQUARE PILLOW
 * "COVE-11 / SPECIAL: COVE-11", on every PDF, screen and AutoCount Description 2
 * that composes from variants. The variants below are those lines' own, read
 * from production (run 34965615433).
 *
 * Rule: the note is dropped only when it says NOTHING the fabric segment does not
 * already say. A note with any other word (a colour name, a quantity, a code that
 * disagrees) still prints whole, so the supplier never loses an instruction. */
import { describe, expect, it } from 'vitest';
import { buildVariantSummary } from './variant-summary';
import { composeDescription2, type ErpLine } from '../../services/autocount-writeback';

const G = 'fabric_accessory';

describe('a note that only restates the fabric colour', () => {
  it('HC-SO-013503 LONG PILLOW prints the colour once', () => {
    expect(buildVariantSummary(G, { fabricCode: 'COVE-13', extraAddonNote: 'Col : cove 13' })).toBe('COVE-13');
  });

  it('HC-SO-2609-072 SQUARE PILLOW prints the colour once', () => {
    expect(buildVariantSummary(G, { fabricCode: 'COVE-11', extraAddonNote: 'COVE-11' })).toBe('COVE-11');
  });

  it('HC-SO-012927 LONG PILLOW, and a zero-padding difference, print once', () => {
    expect(buildVariantSummary(G, { fabricCode: 'BO315-22', extraAddonNote: 'Col:BO315-22' })).toBe('BO315-22');
    expect(buildVariantSummary(G, { fabricCode: 'CH141-01', extraAddonNote: 'Col:CH141-1' })).toBe('CH141-01');
    expect(buildVariantSummary(G, { fabricCode: 'COVE-03', extraAddonNote: 'Fabric : Cove-03' })).toBe('COVE-03');
  });

  it('the supplier copy keeps its Fabric label and loses only the repeat', () => {
    expect(buildVariantSummary(G, { fabricCode: 'COVE-13', extraAddonNote: 'Col : cove 13' }, { labelled: true }))
      .toBe('Fabric: COVE-13');
  });

  it('AutoCount Description 2 composed from variants carries it once', () => {
    const line: ErpLine = {
      item_code: 'LONG PILLOW', item_group: G, description: 'AMN-LONG PILLOW', description2: null, qty: 1, unit_price_sen: 0,
      variants: { fabricCode: 'COVE-13', extraAddonNote: 'Col : cove 13' },
    };
    expect(composeDescription2(line)).toBe('COVE-13');
  });
});

describe('a note that says more still prints whole', () => {
  it('HC-SO-012927 SQUARE PILLOW keeps "SKY x2"', () => {
    expect(buildVariantSummary(G, { fabricCode: 'BO315-28', extraAddonNote: 'BO315-28 SKY x2' }))
      .toBe('BO315-28 / SPECIAL: BO315-28 SKY x2');
  });

  it('a typed code that disagrees with the fabric is never hidden (HC-SO-010214)', () => {
    expect(buildVariantSummary(G, { fabricCode: 'CH141-05', extraAddonNote: 'CH151-5 (PEARL)' }))
      .toBe('CH141-05 / SPECIAL: CH151-5 (PEARL)');
  });

  it('a charged add-on keeps its note even when it names the colour', () => {
    expect(buildVariantSummary(G, { fabricCode: 'COVE-13', extraAddonNote: 'COVE-13', extraAddonAmountRM: 30 }))
      .toBe('COVE-13 / SPECIAL: COVE-13');
  });

  it('a note with no fabric on the line is unchanged', () => {
    expect(buildVariantSummary(G, { extraAddonNote: 'Col : cove 13' })).toBe('SPECIAL: Col : cove 13');
  });

  it('a sofa note is judged against the fabric segment only, not SEAT or LEG', () => {
    expect(buildVariantSummary('sofa', { fabricCode: 'COVE-13', seatHeight: '24"', extraAddonNote: 'SEAT 24' }))
      .toBe('COVE-13 / SEAT 24" / SPECIAL: SEAT 24');
  });
});
