import { describe, expect, it } from 'vitest';
import { missingVariantAxes, missingConfirmVariantAxes } from './so-variant-rule';

/* Owner 2026-08-08 (HC-SO-2607-008): confirming an order requires every goods
   line's category-required variant axes — with ONE carve-out over the
   Processing-Date rule: a colour-KIV line (series committed, colour confirmed
   later) SATISFIES the fabric axis at confirm time. Desktop New SO, mobile
   New SO and the backend confirm gate all read missingConfirmVariantAxes, so
   this suite is the one place the carve-out is pinned for both surfaces. */

const labels = (axes: Array<{ label: string }>) => axes.map((a) => a.label);

describe('missingConfirmVariantAxes', () => {
  it('a bedframe with nothing picked reports every required axis (the HC-SO-2607-008 shape)', () => {
    expect(labels(missingConfirmVariantAxes('bedframe', null)))
      .toEqual(['Divan Height', 'Leg Height', 'Gap', 'Fabrics']);
  });

  it('a complete bedframe passes', () => {
    expect(missingConfirmVariantAxes('bedframe', {
      divanHeight: '5"', legHeight: '6"', gap: '2"', fabricCode: 'BO315-22',
    })).toEqual([]);
  });

  it('colour-KIV satisfies the fabric axis at confirm — but NOT for the Processing Date', () => {
    const kiv = { seatHeight: '28', fabricId: 'f-1', fabricLabel: 'EZ' };
    expect(missingConfirmVariantAxes('sofa', kiv)).toEqual([]);
    expect(labels(missingVariantAxes('sofa', kiv))).toEqual(['Fabrics']);
  });

  it('KIV only excuses the fabric axis — other gaps still report', () => {
    expect(labels(missingConfirmVariantAxes('sofa', { fabricId: 'f-1', fabricLabel: 'EZ' })))
      .toEqual(['Seat Height']);
  });

  it('the POS vocabulary satisfies the sofa axes (depth == seatHeight)', () => {
    expect(missingConfirmVariantAxes('sofa', { depth: '28', fabricCode: 'EZ-01' })).toEqual([]);
  });

  it('categories with no axes (mattress / accessory / service / others) always pass', () => {
    for (const g of ['mattress', 'accessory', 'service', 'others', '', null]) {
      expect(missingConfirmVariantAxes(g, null)).toEqual([]);
    }
  });
});
