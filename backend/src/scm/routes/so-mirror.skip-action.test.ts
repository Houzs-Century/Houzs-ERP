import { describe, expect, it } from 'vitest';
import { soMirrorSkipAction } from './so-mirror';

/* soMirrorSkipAction separates a benign re-delivery (same order offered again)
   from a split-brain double-mint (a DIFFERENT order wearing a doc_no Houzs
   already holds). The 2990-SO-2607-019 incident is the shape being pinned:
   Houzs held Larding Chen's sofa, 2990 delivered Jaikrishen Singh's order
   under the same number, and the pre-#2515 receiver overwrote it wholesale.
   Post-#2515 the write is refused either way — this classifier only decides
   whether the refusal is logged as boring or as a conflict. */
describe('soMirrorSkipAction', () => {
  it('flags a delivery naming a different customer as skipped_conflict (the 2607-019 shape)', () => {
    expect(
      soMirrorSkipAction({ debtor_name: 'Larding Chen' }, { debtor_name: 'Jaikrishen Singh' }),
    ).toBe('skipped_conflict');
  });

  it('treats the same customer re-delivered as skipped_existing', () => {
    expect(
      soMirrorSkipAction({ debtor_name: 'Larding Chen' }, { debtor_name: 'Larding Chen' }),
    ).toBe('skipped_existing');
  });

  it('ignores case and whitespace differences — those are formatting, not identity', () => {
    expect(
      soMirrorSkipAction({ debtor_name: '  LARDING   chen ' }, { debtor_name: 'larding Chen' }),
    ).toBe('skipped_existing');
  });

  it('stays skipped_existing when the delivery carries no header (deleted:true retries)', () => {
    expect(soMirrorSkipAction({ debtor_name: 'Larding Chen' }, undefined)).toBe('skipped_existing');
    expect(soMirrorSkipAction({ debtor_name: 'Larding Chen' }, null)).toBe('skipped_existing');
  });

  it('stays skipped_existing when either side has no usable name — a blank cannot prove a conflict', () => {
    expect(soMirrorSkipAction({ debtor_name: null }, { debtor_name: 'Jaikrishen Singh' })).toBe('skipped_existing');
    expect(soMirrorSkipAction({ debtor_name: 'Larding Chen' }, { debtor_name: '' })).toBe('skipped_existing');
    expect(soMirrorSkipAction({ debtor_name: '   ' }, { debtor_name: '   ' })).toBe('skipped_existing');
    expect(soMirrorSkipAction(null, { debtor_name: 'Jaikrishen Singh' })).toBe('skipped_existing');
    expect(soMirrorSkipAction({ debtor_name: 'Larding Chen' }, {})).toBe('skipped_existing');
  });
});
