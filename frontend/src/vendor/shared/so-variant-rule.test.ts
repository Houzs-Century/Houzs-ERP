import { describe, expect, it } from 'vitest';
import { missingVariantAxes, missingConfirmVariantAxes } from './so-variant-rule';

/* The colour-KIV carve-out: a line that committed to a fabric SERIES with the
   colour confirmed later SATISFIES the fabric axis.

   CORRECTED 2026-08-14. This header used to say "Desktop New SO, mobile New SO
   and the backend confirm gate all read missingConfirmVariantAxes" — all three
   statements were false from 2026-08-13, when #2072 took variants out of the
   confirm gate on the owner's narrowing ("只要是没有 proceed 这一张订单，其实都
   不一定是需要填写的"). docs/modules/sales-order.md recorded the falsehood and
   deliberately left it here, being a docs-only diff; this is that follow-up.
   What reads the function now is the .mjs audit mirror — see its docblock. */

const labels = (axes: Array<{ label: string }>) => axes.map((a) => a.label);

describe('missingConfirmVariantAxes', () => {
  it('a bedframe with nothing picked reports every required axis (the HC-SO-2607-008 shape)', () => {
    expect(labels(missingConfirmVariantAxes('bedframe', null, null)))
      .toEqual(['Divan Height', 'Leg Height', 'Gap', 'Fabrics']);
  });

  it('a complete bedframe passes', () => {
    expect(missingConfirmVariantAxes('bedframe', {
      divanHeight: '5"', legHeight: '6"', gap: '2"', fabricCode: 'BO315-22',
    }, null)).toEqual([]);
  });

  it('colour-KIV satisfies the fabric axis at confirm — but NOT for the Processing Date', () => {
    const kiv = { seatHeight: '28', fabricId: 'f-1', fabricLabel: 'EZ' };
    expect(missingConfirmVariantAxes('sofa', kiv, null)).toEqual([]);
    expect(labels(missingVariantAxes('sofa', kiv, null))).toEqual(['Fabrics']);
  });

  it('KIV only excuses the fabric axis — other gaps still report', () => {
    expect(labels(missingConfirmVariantAxes('sofa', { fabricId: 'f-1', fabricLabel: 'EZ' }, null)))
      .toEqual(['Seat Height']);
  });

  it('the POS vocabulary satisfies the sofa axes (depth == seatHeight)', () => {
    expect(missingConfirmVariantAxes('sofa', { depth: '28', fabricCode: 'EZ-01' }, null)).toEqual([]);
  });

  it('categories with no axes (mattress / accessory / service / others) always pass', () => {
    for (const g of ['mattress', 'accessory', 'service', 'others', '', null]) {
      expect(missingConfirmVariantAxes(g, null, null)).toEqual([]);
    }
  });
});
