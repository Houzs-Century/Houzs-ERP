import { describe, it, expect } from 'vitest';
import { HANDOVER_BATCH_MAX, parseHandoverBody } from './so-handover';

/* The apply endpoint rewrites who owns an order — and SO visibility keys off
   that column, so a bad payload does not just write junk, it makes orders
   disappear from the list of whoever should see them. This pins the guard; the
   per-order "still theirs?" re-check lives in the handler around it. */

const ok = (body: Record<string, unknown>) => {
  const r = parseHandoverBody(body);
  if (!r.ok) throw new Error(`expected ok, got ${r.payload.error}`);
  return r.req;
};
const err = (body: Record<string, unknown>) => {
  const r = parseHandoverBody(body);
  if (r.ok) throw new Error('expected a rejection');
  return r.payload.error;
};

const base = { fromStaffId: 'staff-a', toStaffId: 'staff-b', docNos: ['HC-SO-1'] };

describe('parseHandoverBody — the two people', () => {
  it('accepts a from/to pair and trims both', () => {
    const req = ok({ ...base, fromStaffId: ' staff-a ', toStaffId: 'staff-b ' });
    expect(req.fromStaffId).toBe('staff-a');
    expect(req.toStaffId).toBe('staff-b');
  });

  it('rejects a missing or blank side', () => {
    expect(err({ ...base, fromStaffId: '' })).toBe('missing_staff');
    expect(err({ ...base, toStaffId: '   ' })).toBe('missing_staff');
    expect(err({ ...base, toStaffId: undefined })).toBe('missing_staff');
    expect(err({ ...base, fromStaffId: 42 })).toBe('missing_staff');
  });

  it('rejects a handover to the same person — a no-op that still writes audit rows', () => {
    expect(err({ ...base, toStaffId: 'staff-a' })).toBe('same_staff');
  });
});

describe('parseHandoverBody — the orders', () => {
  it('dedupes the doc list', () => {
    expect(ok({ ...base, docNos: ['HC-SO-1', 'HC-SO-1', ' HC-SO-2 '] }).docNos)
      .toEqual(['HC-SO-1', 'HC-SO-2']);
  });

  it('rejects an empty list rather than moving an unbounded set', () => {
    expect(err({ ...base, docNos: [] })).toBe('no_orders');
    expect(err({ ...base, docNos: ['', '  '] })).toBe('no_orders');
    expect(err({ ...base, docNos: undefined })).toBe('no_orders');
    expect(err({ ...base, docNos: 'HC-SO-1' })).toBe('no_orders');
  });

  it('caps the batch — the UI loops, the worker does not', () => {
    const many = Array.from({ length: HANDOVER_BATCH_MAX + 1 }, (_, i) => `HC-SO-${i}`);
    expect(err({ ...base, docNos: many })).toBe('too_many_orders');
    expect(ok({ ...base, docNos: many.slice(0, HANDOVER_BATCH_MAX) }).docNos)
      .toHaveLength(HANDOVER_BATCH_MAX);
  });
});
