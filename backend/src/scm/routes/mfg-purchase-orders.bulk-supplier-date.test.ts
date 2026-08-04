import { describe, it, expect } from 'vitest';
import { parseBulkSupplierDateBody } from './mfg-purchase-orders';

/* The batch endpoint writes a date onto every line of every PO it is handed, so
   its input guard is the only thing between a fat-fingered payload and a lot of
   rows. These pin the guard; the per-PO lock / company skipping lives in the
   handler around it. */

const ok = (body: Record<string, unknown>) => {
  const r = parseBulkSupplierDateBody(body);
  if (!r.ok) throw new Error(`expected ok, got ${r.payload.error}`);
  return r.req;
};
const err = (body: Record<string, unknown>) => {
  const r = parseBulkSupplierDateBody(body);
  if (r.ok) throw new Error('expected a rejection');
  return r.payload.error;
};

const base = { slot: 2, date: '2026-08-25', poIds: ['po-1'] };

describe('parseBulkSupplierDateBody — slot', () => {
  it('accepts the three real slots and maps each to its column', () => {
    expect(ok({ ...base, slot: 2 }).col).toBe('supplier_delivery_date_2');
    expect(ok({ ...base, slot: 3 }).col).toBe('supplier_delivery_date_3');
    expect(ok({ ...base, slot: 4 }).col).toBe('supplier_delivery_date_4');
  });

  it('accepts a numeric string (the form sends what the buttons hold)', () => {
    expect(ok({ ...base, slot: '3' }).slot).toBe(3);
  });

  it('rejects anything else — slot 1 is the ORIGINAL delivery date, not a revision', () => {
    expect(err({ ...base, slot: 1 })).toBe('invalid_slot');
    expect(err({ ...base, slot: 5 })).toBe('invalid_slot');
    expect(err({ ...base, slot: 0 })).toBe('invalid_slot');
    expect(err({ ...base, slot: undefined })).toBe('invalid_slot');
    expect(err({ ...base, slot: 'delivery_date' })).toBe('invalid_slot');
  });
});

describe('parseBulkSupplierDateBody — date', () => {
  it('accepts an ISO calendar date and trims it', () => {
    expect(ok({ ...base, date: '  2026-08-25 ' }).date).toBe('2026-08-25');
  });

  it('rejects a non-ISO or free-text date', () => {
    expect(err({ ...base, date: '25/08/2026' })).toBe('invalid_date');
    expect(err({ ...base, date: '2026-8-3' })).toBe('invalid_date');
    expect(err({ ...base, date: 'next week' })).toBe('invalid_date');
    expect(err({ ...base, date: '' })).toBe('invalid_date');
    expect(err({ ...base, date: undefined })).toBe('invalid_date');
    expect(err({ ...base, date: 20260825 })).toBe('invalid_date');
  });

  it('rejects a well-shaped impossible day', () => {
    expect(err({ ...base, date: '2026-02-31' })).toBe('invalid_date');
    expect(err({ ...base, date: '2026-13-01' })).toBe('invalid_date');
  });

  it('keeps a real leap day', () => {
    expect(ok({ ...base, date: '2028-02-29' }).date).toBe('2028-02-29');
  });
});

describe('parseBulkSupplierDateBody — poIds', () => {
  it('dedupes and trims', () => {
    expect(ok({ ...base, poIds: ['po-1', ' po-1 ', 'po-2'] }).poIds).toEqual(['po-1', 'po-2']);
  });

  it('drops blanks and non-strings', () => {
    expect(ok({ ...base, poIds: ['po-1', '', '   ', null, 7, {}] }).poIds).toEqual(['po-1']);
  });

  it('rejects an empty or missing list rather than silently touching nothing', () => {
    expect(err({ ...base, poIds: [] })).toBe('no_purchase_orders');
    expect(err({ ...base, poIds: ['', '  '] })).toBe('no_purchase_orders');
    expect(err({ ...base, poIds: undefined })).toBe('no_purchase_orders');
    expect(err({ ...base, poIds: 'po-1' })).toBe('no_purchase_orders');
  });

  it('caps the batch — the handler walks POs sequentially', () => {
    const many = Array.from({ length: 101 }, (_, i) => `po-${i}`);
    expect(err({ ...base, poIds: many })).toBe('too_many_purchase_orders');
    expect(ok({ ...base, poIds: many.slice(0, 100) }).poIds).toHaveLength(100);
  });

  it('counts the batch AFTER dedupe, so repeats do not burn the cap', () => {
    const dupes = Array.from({ length: 200 }, () => 'po-same');
    expect(ok({ ...base, poIds: dupes }).poIds).toEqual(['po-same']);
  });
});

describe('parseBulkSupplierDateBody — applyToLines', () => {
  it('defaults ON: leaving the lines behind is the tedium this endpoint exists to remove', () => {
    expect(ok(base).applyToLines).toBe(true);
  });

  it('honours an explicit false for header-only moves', () => {
    expect(ok({ ...base, applyToLines: false }).applyToLines).toBe(false);
  });
});
