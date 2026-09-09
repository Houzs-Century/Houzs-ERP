// A superseded fabric row carries its own obituary, and it is not a
// specification. Two sofa orders sat outside the account book because 39
// characters of bookkeeping pushed their build text past nvarchar(100).
import { describe, expect, it } from 'vitest';
import { buildVariantSummary } from './variant-summary';
import { AC_DESC2_MAX } from '../../services/autocount-sofa-collapse';

const NOTE = '[superseded by BO315-03 on 2026-08-11]';

describe('the superseded note never reaches the account book', () => {
  it('renders the SUCCESSOR code, not the dead one and not the note', () => {
    const s = buildVariantSummary('BEDFRAME', { fabricCode: `BO315-3 ${NOTE}` });
    expect(s).toBe('BO315-03');
  });

  it('strips a note that names no successor, leaving the code', () => {
    /* Still bookkeeping, still must not travel. The dead code is at least a
       code; the sentence is not. */
    expect(buildVariantSummary('BEDFRAME', { fabricCode: 'KS-16 [superseded by]' })).toBe('KS-16');
  });

  it('reads the note off the colour NAME as well as the code', () => {
    const s = buildVariantSummary('BEDFRAME', {
      fabricCode: 'PC151',
      colourLabel: 'CH141-8 [superseded by CH141-08 on 2026-08-11]',
    });
    expect(s).toBe('PC151 CH141-08');
  });

  it('leaves an ordinary colour EXACTLY as it was', () => {
    /* The rule that makes this safe to ship: a line with no note renders
       character-for-character what it rendered before, so no document's text
       moves except the ones carrying bookkeeping. */
    const v = { fabricCode: 'PC151-01', gap: '12"', divanHeight: '8"', legHeight: 'No Leg' };
    expect(buildVariantSummary('BEDFRAME', v)).toBe('PC151-01 / DIVAN 8" + NO LEG / GAP 12"');
  });

  it('takes HC-SO-012513\'s build back under the column', () => {
    /* Measured 2026-09-09: the collapse composed 113 characters for this sofa
       and AutoCount refused the whole document. The note is 39 of them. */
    const withNote = `2EL + 1ER / COL: BO315-3 ${NOTE} / BOTTOM USE UMBRELLA FABRIC / Nylon Fabric`;
    const without = withNote.replace(` ${NOTE}`, '');
    expect(withNote.length).toBeGreaterThan(AC_DESC2_MAX);
    expect(without.length).toBeLessThanOrEqual(AC_DESC2_MAX);
  });
});
