// The headline is the only thing a reader sees before deciding whether to act,
// so a PARTIAL sweep must not read like a complete one.
import { describe, expect, it } from 'vitest';
import { acSweepHeadline, type AcLineOrderSweepResponse } from './acLineOrderSweep';

const base: AcLineOrderSweepResponse = {
  ok: true, docType: 'SO', bookDocuments: 2889, bookTruncated: false,
  total: 2889, byVerdict: {}, failing: [],
};

describe('what the sweep says before any table', () => {
  it('says everything matches when nothing is failing', () => {
    expect(acSweepHeadline(base)).toBe('All 2889 document(s) compared, and every one\'s lines match the ERP.');
  });

  it('counts the ones that need looking at', () => {
    const r = { ...base, failing: [{ docNo: 'HC-SO-010741', verdict: 'order', bookLines: 4, erpLines: 4 }] };
    expect(acSweepHeadline(r)).toBe('2889 document(s) compared. 1 need looking at.');
  });

  it('says PARTIAL first when the book read was truncated', () => {
    /* The failure this guards: a truncated sweep reporting "12 need looking at"
       reads exactly like a complete one that found 12, and the difference is
       whether the rest were checked at all. */
    const r = { ...base, bookTruncated: true, total: 500, failing: [] };
    expect(acSweepHeadline(r)).toMatch(/^PARTIAL/);
    expect(acSweepHeadline(r)).toContain('floor, not a total');
  });

  it('says nothing at all before the sweep has run', () => {
    expect(acSweepHeadline(undefined)).toBe('');
  });
});
