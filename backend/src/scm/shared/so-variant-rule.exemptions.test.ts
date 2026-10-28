import { describe, expect, it } from 'vitest';
import { missingVariantAxes, missingConfirmVariantAxes } from './so-variant-rule';
import { adjustmentIncreaseErrors } from './inventory-adjustment';

/* ═══════════════════════════════════════════════════════════════════════════
   THE BY-SKU EXEMPTIONS, PINNED ON EVERY GATE THAT CAN ASK FOR THEM.

   Two owner rulings say a frame without a divan base must not be asked for
   divan-base facts:
     2026-08-09  "divan only 不需要 gap"
     2026-08-10  电动床/抽拉床…像 DIVAN ONLY 一样豁免 — 要

   Both are implemented, and both were HALF-APPLIED for four days, because the
   itemCode they key off was an OPTIONAL third parameter: the call sites that
   did not pass it kept the old behaviour with no compile error and no failing
   test. PR #1763's own message claimed "every desktop + mobile call site".

   The parameter is now REQUIRED, which is what makes the compiler enumerate
   the call sites. These tests are the other half: they assert the exemption
   through EACH gate, so a future gate that forgets to thread the code fails
   here rather than in production on somebody's order.
   ═══════════════════════════════════════════════════════════════════════════ */

const keys = (axes: Array<{ key: string }>) => axes.map((a) => a.key).sort();

const DIVANLESS = [
  'HOK-ADJUSTABLE (Q)',
  'NB-(S+S)',
  'NB-(SS+S)',
  'HOK-DOUBLE DECKER (S)',
  'NB-DDB (S)',
];

describe('DIVAN ONLY — no mattress, so no Gap (owner 2026-08-09)', () => {
  it('is not asked for a Gap, but is still asked for the rest', () => {
    const miss = keys(missingVariantAxes('bedframe', null, 'HOK-DIVAN ONLY (K)'));
    expect(miss).not.toContain('gap');
    expect(miss).toEqual(['divanHeight', 'fabricCode', 'legHeight']);
  });

  it('holds for every DIVAN ONLY variant, matched on the code not a list', () => {
    for (const code of ['HOK-DIVAN ONLY (K)', 'NB-DIVAN ONLY (S)', 'divan only (q)']) {
      expect(keys(missingVariantAxes('bedframe', null, code))).not.toContain('gap');
    }
  });

  it('a normal bedframe IS still asked for the Gap', () => {
    expect(keys(missingVariantAxes('bedframe', null, 'Y103-(Q)'))).toContain('gap');
  });
});

describe('no divan base at all — adjustable / pull-out / bunk (owner 2026-08-10)', () => {
  it('is asked for the fabric and nothing else', () => {
    for (const code of DIVANLESS) {
      expect(keys(missingVariantAxes('bedframe', null, code))).toEqual(['fabricCode']);
    }
  });
});

describe('the exemption reaches the CONFIRM rule, not just the full one', () => {
  it('missingConfirmVariantAxes honours it too', () => {
    expect(keys(missingConfirmVariantAxes('bedframe', null, 'HOK-DIVAN ONLY (K)'))).not.toContain('gap');
    expect(keys(missingConfirmVariantAxes('bedframe', null, 'HOK-ADJUSTABLE (Q)'))).toEqual(['fabricCode']);
  });
});

/* The gate that was actually broken. adjustmentIncreaseErrors never passed an
   item code — it could not, the parameter did not exist — so finding stock for
   a DIVAN ONLY frame demanded a Gap that the product does not have. */
describe('the stock-adjustment gate honours the same exemptions', () => {
  const complete = { divanHeight: '5"', legHeight: '6"', gap: '2"', fabricCode: 'BO315-22' };

  it('a DIVAN ONLY increase is not blocked for a missing Gap', () => {
    const errs = adjustmentIncreaseErrors(
      'bedframe',
      { divanHeight: '5"', legHeight: '6"', fabricCode: 'BO315-22' },
      null,
      'HOK-DIVAN ONLY (K)',
    );
    expect(errs).toEqual([]);
  });

  it('an adjustable bed needs only its fabric', () => {
    expect(adjustmentIncreaseErrors('bedframe', { fabricCode: 'BO315-22' }, null, 'HOK-ADJUSTABLE (Q)')).toEqual([]);
  });

  it('a normal bedframe missing its Gap IS still blocked, naming the field', () => {
    const errs = adjustmentIncreaseErrors(
      'bedframe',
      { divanHeight: '5"', legHeight: '6"', fabricCode: 'BO315-22' },
      null,
      'Y103-(Q)',
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('Gap');
  });

  it('a complete bedframe passes, and sofa still needs its batch number', () => {
    expect(adjustmentIncreaseErrors('bedframe', complete, null, 'Y103-(Q)')).toEqual([]);
    const sofa = adjustmentIncreaseErrors('sofa', { seatHeight: '28', fabricCode: 'PC151-01' }, null, '9028-1A(LHF)');
    expect(sofa).toHaveLength(1);
    expect(sofa[0]).toContain('Batch Number');
  });

  it('a null item code exempts nothing — the safe direction', () => {
    expect(keys(missingVariantAxes('bedframe', null, null))).toEqual(['divanHeight', 'fabricCode', 'gap', 'legHeight']);
  });
});
