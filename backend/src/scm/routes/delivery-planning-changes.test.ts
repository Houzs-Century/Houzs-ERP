/* Owner 2026-10-27 option B: the board asks which orders changed since its cursor. */
import { describe, expect, it } from 'vitest';
import { summariseChanges } from './delivery-planning-changes';

describe('summariseChanges', () => {
  it('lists each changed order once, only for the caller\'s companies, and flags other legs', () => {
    const out = summariseChanges([
      { id: 11, doc_no: 'SO-1', company_id: 1 },
      { id: 12, doc_no: 'SO-1', company_id: 1 },
      { id: 13, doc_no: 'SO-9', company_id: 2 },
      { id: 14, doc_no: '*OTHER*', company_id: null },
    ], 10, [1]);
    expect(out).toEqual({ cursor: 14, docs: ['SO-1'], others: true, full: false });
  });
  it('nothing new keeps the cursor', () => {
    expect(summariseChanges([], 10, undefined)).toEqual({ cursor: 10, docs: [], others: false, full: false });
  });
  it('too much changed: re-read wholesale', () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, doc_no: `SO-${i}`, company_id: 1 }));
    expect(summariseChanges(rows, 0, undefined)).toMatchObject({ cursor: 2000, docs: [], full: true });
  });
});
