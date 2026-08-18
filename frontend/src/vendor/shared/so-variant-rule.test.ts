import { describe, expect, it } from 'vitest';
import {
  missingVariantAxes, missingConfirmVariantAxes, hasSofaMixConflict, sofaMixIntroduced,
} from './so-variant-rule';

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

/* ─────────────────────────────────────────────────────────────────────────────
   THE SOFA-MIX PAIR. Two client checks for ONE server rule, and which one a
   surface uses is decided by which server path it is standing in front of:

     a NEW-order form  -> the server create path asks a FLAT question
                          -> hasSofaMixConflict
     a DETAIL page     -> the server line paths ask a DIFFERENTIAL one
                          (backend/src/scm/lib/main-mix.ts, mainMixIntroduced)
                          -> sofaMixIntroduced

   Getting that backwards is not a cosmetic mismatch. A flat check in front of a
   differential gate refuses saves the server would have accepted, and the order
   it refuses is precisely the one written before the rule existed — which the
   server deliberately grandfathers and the operator has no way to un-mix.
   ───────────────────────────────────────────────────────────────────────────── */
describe('hasSofaMixConflict — the FLAT form, for the New-order surfaces', () => {
  it('refuses a sofa beside a bedframe or a mattress', () => {
    expect(hasSofaMixConflict(['sofa', 'bedframe'])).toBe(true);
    expect(hasSofaMixConflict(['mattress', 'Sofa Set'])).toBe(true);
  });

  it('allows sofa-only, bedframe + mattress, and any service / accessory rider', () => {
    expect(hasSofaMixConflict(['sofa', 'sofa'])).toBe(false);
    expect(hasSofaMixConflict(['bedframe', 'mattress'])).toBe(false);
    expect(hasSofaMixConflict(['sofa', 'service', 'accessory', 'others', '', null])).toBe(false);
  });
});

describe('sofaMixIntroduced — the DIFFERENTIAL form, for the Detail surfaces', () => {
  it('refuses adding a sofa to a bedframe order', () => {
    expect(sofaMixIntroduced(['bedframe'], ['bedframe', 'sofa'])).toBe(true);
  });

  it('refuses swapping an accessory line to a sofa while a bedframe stays', () => {
    expect(sofaMixIntroduced(['bedframe', 'accessory'], ['bedframe', 'sofa'])).toBe(true);
  });

  it('allows replacing the last bedframe with a sofa — the result does not mix', () => {
    expect(sofaMixIntroduced(['bedframe'], ['sofa'])).toBe(false);
  });

  /* THE GRANDFATHERING. An order that already mixes must stay editable, or the
     client locks the operator out of a document the server would let them
     save. */
  it('an ALREADY-MIXED order stays saveable — including edits that touch nothing relevant', () => {
    expect(sofaMixIntroduced(['sofa', 'bedframe'], ['sofa', 'bedframe'])).toBe(false);
    expect(sofaMixIntroduced(['sofa', 'bedframe'], ['sofa', 'bedframe', 'service'])).toBe(false);
    expect(sofaMixIntroduced(['sofa', 'bedframe'], ['sofa', 'bedframe', 'mattress'])).toBe(false);
  });

  it('and the flat form is exactly what would have refused those saves', () => {
    // The regression this pair exists to stop, stated as an assertion.
    expect(hasSofaMixConflict(['sofa', 'bedframe'])).toBe(true);
    expect(sofaMixIntroduced(['sofa', 'bedframe'], ['sofa', 'bedframe'])).toBe(false);
  });

  it('an empty order accepts a first sofa line', () => {
    expect(sofaMixIntroduced([], ['sofa'])).toBe(false);
  });
});
