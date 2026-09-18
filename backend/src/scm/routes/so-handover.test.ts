import { describe, it, expect } from 'vitest';
import { HANDOVER_BATCH_MAX, SHARE_STAFF_MAX, parseHandoverBody, parseShareBody } from './so-handover';

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

/* SHARING is the other operation on this router, and it is deliberately not a
   flag on the one above: it grants ACCESS and never touches attribution (owner
   2026-09-09, 全部平等，不设主). The guard matters for the same reason — the
   array it writes feeds `access_staff_ids`, which is what every scoped SO read
   filters on, so a bad payload here hands people the wrong order book. */

const okShare = (body: Record<string, unknown>) => {
  const r = parseShareBody(body);
  if (!r.ok) throw new Error(`expected ok, got ${r.payload.error}`);
  return r.req;
};
const errShare = (body: Record<string, unknown>) => {
  const r = parseShareBody(body);
  if (r.ok) throw new Error('expected a rejection');
  return r.payload.error;
};

const shareBase = { staffIds: ['staff-b'], docNos: ['HC-SO-1'] };

describe('parseShareBody — the people being given access', () => {
  it('accepts several, trims them, and drops duplicates', () => {
    const req = okShare({ ...shareBase, staffIds: [' staff-b ', 'staff-c', 'staff-b'] });
    expect(req.staffIds).toEqual(['staff-b', 'staff-c']);
  });

  it('rejects an empty or non-string list', () => {
    expect(errShare({ ...shareBase, staffIds: [] })).toBe('missing_staff');
    expect(errShare({ ...shareBase, staffIds: ['   '] })).toBe('missing_staff');
    expect(errShare({ ...shareBase, staffIds: 'staff-b' })).toBe('missing_staff');
    expect(errShare({ ...shareBase, staffIds: [7] })).toBe('missing_staff');
  });

  it('refuses a mis-click that would share one order with a crowd', () => {
    const many = Array.from({ length: SHARE_STAFF_MAX + 1 }, (_, i) => `staff-${i}`);
    expect(errShare({ ...shareBase, staffIds: many })).toBe('too_many_staff');
    expect(okShare({ ...shareBase, staffIds: many.slice(0, SHARE_STAFF_MAX) }).staffIds)
      .toHaveLength(SHARE_STAFF_MAX);
  });

  /* Unlike the handover there is no same_staff rule: sharing an order with the
     person already attributed to it is harmless (the derived access column
     de-duplicates), and refusing it would make a bulk grant fail because one
     order in the batch happened to be theirs already. */
  it('allows sharing with the person the order is already attributed to', () => {
    expect(okShare({ ...shareBase, staffIds: ['staff-a'] }).staffIds).toEqual(['staff-a']);
  });
});

describe('parseShareBody — the orders and the mode', () => {
  it('keeps the same per-batch ceiling as the handover', () => {
    const many = Array.from({ length: HANDOVER_BATCH_MAX + 1 }, (_, i) => `HC-SO-${i}`);
    expect(errShare({ ...shareBase, docNos: many })).toBe('too_many_orders');
    expect(errShare({ ...shareBase, docNos: [] })).toBe('no_orders');
  });

  it('defaults to ADD, so a bulk grant can never silently drop another grant', () => {
    expect(okShare(shareBase).mode).toBe('add');
    expect(okShare({ ...shareBase, mode: 'replace' }).mode).toBe('add');
    expect(okShare({ ...shareBase, mode: 'remove' }).mode).toBe('remove');
  });
});
