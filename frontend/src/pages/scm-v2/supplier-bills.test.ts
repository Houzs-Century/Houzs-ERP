/* Supplier bills' rules (the owner's Claude Design, batch 4 step 5): the
   status tag in the design's order, the chips' predicates, the search, the
   order, and a credit note taking off what we owe on the listing. */

import { describe, expect, test } from 'vitest';
import { billTag, inChip, listingRowOf, matchesBill, sortBills, type BillRow } from './supplier-bills';

const TODAY = '2026-11-03';
const bill = (over: Partial<BillRow>): BillRow => ({
  key: 'API-1', kind: 'API', debitNote: false, id: '1', number: '2990-API-2610-001', supplierId: 's', supplierName: 'TNB', supplierCode: '405-T001',
  controlRole: 'AP_OTHER', ref: 'T-1', description: 'Electric', date: '2026-10-01', due: '2026-11-30', planned: null, currency: 'MYR',
  totalSen: 10_000, paidSen: 0, outstandingSen: 10_000, unusedSen: null, status: 'POSTED', held: false, holdReason: null, ...over,
});

describe('the status tag', () => {
  test('reads in the design order', () => {
    expect(billTag(bill({ status: 'CANCELLED' }), TODAY).text).toBe('Cancelled');
    expect(billTag(bill({ status: 'DRAFT', outstandingSen: null }), TODAY).text).toBe('Draft');
    expect(billTag(bill({ kind: 'SCN', outstandingSen: null, unusedSen: 5 }), TODAY)).toEqual({ text: 'To use', tone: 'info' });
    expect(billTag(bill({ kind: 'SCN', outstandingSen: null, unusedSen: 0 }), TODAY).text).toBe('Used');
    expect(billTag(bill({ outstandingSen: 0, paidSen: 10_000 }), TODAY).text).toBe('Paid');
    expect(billTag(bill({ held: true, due: '2026-10-01' }), TODAY)).toEqual({ text: 'On hold', tone: 'late' });
    expect(billTag(bill({ paidSen: 4_000, outstandingSen: 6_000 }), TODAY).text).toBe('Partly paid');
    expect(billTag(bill({ due: '2026-10-31' }), TODAY)).toEqual({ text: 'Overdue 3d', tone: 'late' });
    expect(billTag(bill({}), TODAY).text).toBe('Posted');
  });
});

describe('the chips', () => {
  test('Overdue is an unpaid bill past its due date — never a credit note, never a draft', () => {
    expect(inChip(bill({ due: '2026-11-02' }), 'overdue', TODAY)).toBe(true);
    expect(inChip(bill({ due: TODAY }), 'overdue', TODAY)).toBe(false);
    expect(inChip(bill({ status: 'DRAFT', outstandingSen: null, due: '2026-10-01' }), 'overdue', TODAY)).toBe(false);
    expect(inChip(bill({ kind: 'SCN', unusedSen: 5, outstandingSen: null, due: null }), 'unpaid', TODAY)).toBe(true);
    expect(inChip(bill({ kind: 'SCN', unusedSen: 5, outstandingSen: null, due: '2026-10-01' }), 'overdue', TODAY)).toBe(false);
    expect(inChip(bill({ outstandingSen: 0 }), 'paid', TODAY)).toBe(true);
    expect(inChip(bill({ status: 'CANCELLED', outstandingSen: null }), 'paid', TODAY)).toBe(false);
  });
});

describe('the search and the order', () => {
  test('finds a number, a supplier code, a ref or an amount', () => {
    expect(matchesBill(bill({}), 'api-2610')).toBe(true);
    expect(matchesBill(bill({}), '405-t')).toBe(true);
    expect(matchesBill(bill({}), 'RM 100.00')).toBe(true);
    expect(matchesBill(bill({}), '100.01')).toBe(false);
    expect(matchesBill(bill({}), 'rent')).toBe(false);
  });

  test('what is owed comes soonest-due first; any other view newest first', () => {
    const a = bill({ key: 'a', number: 'A', date: '2026-10-01', due: '2026-12-01' });
    const b = bill({ key: 'b', number: 'B', date: '2026-09-01', due: '2026-11-10' });
    expect(sortBills([a, b], 'unpaid').map((r) => r.number)).toEqual(['B', 'A']);
    expect(sortBills([b, a], 'all').map((r) => r.number)).toEqual(['A', 'B']);
  });
});

describe('the listing row', () => {
  test('a credit note takes off what we owe and prints its use, not a due date', () => {
    const r = listingRowOf(bill({ kind: 'SCN', number: 'SCN-1', totalSen: 5_000, paidSen: 1_000, unusedSen: 4_000, outstandingSen: null, due: '2026-12-01', controlRole: 'AP' }), TODAY);
    expect(r).toMatchObject({ kindWord: 'Credit note', control: '400', totalSen: -5_000, paidSen: 0, outstandingSen: null, due: null, status: 'To use' });
  });
});

describe('the planned payment date (step 7)', () => {
  test('what is owed sorts by the plan, else the due date; Overdue still reads the due date', () => {
    const a = bill({ key: 'a', number: 'A', due: '2026-11-10', planned: '2026-12-01' });
    const b = bill({ key: 'b', number: 'B', due: '2026-11-20', planned: null });
    expect(sortBills([a, b], 'unpaid').map((r) => r.number)).toEqual(['B', 'A']);
    expect(inChip(bill({ due: '2026-11-01', planned: '2026-11-30' }), 'overdue', TODAY)).toBe(true);
  });
});
