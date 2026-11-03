// The rows of Money in › Receipts (the owner's Claude Design, batch 5 §2): each
// kind in the design's words, All's three groups, the chips per kind, the URL
// read safely, and the search finding a customer payment by its order's
// reference.

import { describe, expect, test } from 'vitest';
import type { ReceiptRow } from '../../../vendor/scm/lib/accounting-queries';
import {
  chipsOf, debtorStageOf, inChip, inKind, matchesReceipt, monthLabel, monthName, officialItem, readChip, readKind, receiptHref,
  receiptItem, shiftMonth, type OfficialListRow,
} from './receiptsModel';

const or = (over: Partial<OfficialListRow>): OfficialListRow => ({
  id: 1, or_number: 'HCDraftOR-2610-001', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p1', doc_no: 'HC-SO-1',
  customer_name: 'TAN', method: 'merchant', amount_sen: 10_000, paid_at: '2026-10-02', channel_account_code: null,
  issued_at: null, issued_by: null, created_at: '2026-10-02', cancelled_at: null, cancelled_by: null, cancel_reason: null, ...over,
});
const rr = (over: Partial<ReceiptRow>): ReceiptRow => ({
  kind: 'GENERAL', id: 'g1', number: 'HC-RCT-2610-001', date: '2026-10-05', payer: 'MLE', moneyAccount: '310-0001', totalSen: 5_000, status: 'POSTED', ...over,
});
const bank = (code: string) => (code === '310-0001' ? 'Hong Leong Bank' : code);

describe('each kind as a row', () => {
  test('an official receipt: its order is For, its method is how; a draft is Not final, a cancelled one keeps its reason', () => {
    const draft = officialItem(or({}));
    expect(draft).toMatchObject({ kind: 'official', no: 'HCDraftOR-2610-001', forText: 'HC-SO-1', forHref: '/scm/sales-orders/HC-SO-1', via: 'Merchant', status: 'draft', group: 'pending' });
    expect(draft.tag).toEqual({ text: 'Draft', tone: 'warn' });
    expect(officialItem(or({ status: 'FORMAL' }))).toMatchObject({ status: 'formal', group: 'final' });
    expect(officialItem(or({ status: 'CANCELLED', cancel_reason: 'Payment deleted' }))).toMatchObject({ status: 'cancelled', group: 'cancelled', cancelled: true, note: 'Payment deleted' });
    /* A sales invoice's payment healed by ensure: doc_no is the invoice's id, never an order. */
    expect(officialItem(or({ payment_source: 'SIPAY', doc_no: 'uuid-of-an-invoice' }))).toMatchObject({ forText: 'Sales invoice', forHref: null });
  });

  test('a sundry receipt says its first line and the bank by name; voided is Cancelled in All', () => {
    expect(receiptItem(rr({ firstLine: 'Booth deposit back' }), bank)).toMatchObject({ kind: 'sundry', forText: 'Booth deposit back', via: 'Hong Leong Bank', status: 'posted', group: 'final' });
    expect(receiptItem(rr({ status: 'CANCELLED' }), bank)).toMatchObject({ status: 'voided', group: 'cancelled', cancelled: true });
  });

  test("a debtor receipt's stage from its marks; For is its bills, opening the first", () => {
    const base = { kind: 'DEBTOR' as const, id: 'r1', number: 'HC-ODR-2610-001', bills: [{ billId: 'b1', no: 'HC-ODB-1', amountSen: 1 }, { billId: 'b2', no: 'HC-ODB-2', amountSen: 1 }] };
    expect(receiptItem(rr({ ...base, status: 'DRAFT' }), bank)).toMatchObject({ stage: 'Draft', status: 'draft', group: 'pending', forText: 'HC-ODB-1, HC-ODB-2', forHref: '/scm/ar-invoices/bills/b1' });
    expect(receiptItem(rr({ ...base, status: 'DRAFT', submittedAt: 'x' }), bank)).toMatchObject({ stage: 'Prepared' });
    /* An approval whose post died is still Checked — Approve & post resumes it. */
    expect(debtorStageOf({ status: 'DRAFT', submittedAt: 'x', checkedAt: 'y' })).toBe('Checked');
    expect(receiptItem(rr({ ...base, status: 'POSTED' }), bank)).toMatchObject({ stage: 'Approved', group: 'final' });
    expect(receiptItem(rr({ ...base, status: 'CANCELLED' }), bank)).toMatchObject({ stage: 'Cancelled', group: 'cancelled' });
  });

  test('a customer payment is its order, in no group, and never in All', () => {
    const x = receiptItem(rr({ kind: 'CUSTOMER', id: 'p1', number: 'HC-SO-9', status: 'RECEIVED', moneyAccount: 'cash' }), bank);
    expect(x).toMatchObject({ kind: 'customer', group: null, via: 'Cash' });
    expect(receiptHref(x)).toBe('/scm/sales-orders/HC-SO-9');
    expect(inKind(x, 'all')).toBe(false);
    expect(inKind(x, 'customer')).toBe(true);
  });
});

describe('segments, chips and the URL', () => {
  test("All's chips are the groups; a kind's chips are its own words", () => {
    expect(chipsOf('all').map(([, l]) => l)).toEqual(['All', 'Not final', 'Final', 'Cancelled']);
    expect(chipsOf('official').map(([, l]) => l)).toEqual(['All', 'Draft · money not confirmed', 'Formal', 'Cancelled']);
    expect(chipsOf('sundry').map(([, l]) => l)).toEqual(['All', 'Posted', 'Voided']);
    expect(chipsOf('debtor').map(([, l]) => l)).toEqual(['All', 'Draft', 'Prepared', 'Checked', 'Approved', 'Cancelled']);
    expect(chipsOf('customer')).toEqual([]);
    const draft = officialItem(or({}));
    expect(inChip(draft, 'all', 'pending')).toBe(true);
    expect(inChip(draft, 'official', 'draft')).toBe(true);
    expect(inChip(draft, 'official', 'formal')).toBe(false);
  });

  test("an unknown kind is All; an unknown chip is the kind's All; the old status words read as chips", () => {
    expect(readKind('OFFICIAL')).toBe('official');
    expect(readKind('nonsense')).toBe('all');
    expect(readChip('official', 'DRAFT')).toBe('draft');
    expect(readChip('sundry', 'draft')).toBe('all');
    expect(readChip('all', null)).toBe('all');
  });

  test('the month nav', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthLabel('2026-10')).toBe('2026/10');
    expect(monthName('2026-10')).toBe('October 2026');
  });

  test('the search finds a number, a payer, what it was for, an amount, and a customer payment by its reference', () => {
    const x = receiptItem(rr({ kind: 'CUSTOMER', id: 'p1', number: 'HC-SO-9', status: 'RECEIVED', moneyAccount: 'cash', soRef: 'PO-ACME-12', totalSen: 123_456 }), bank);
    expect(matchesReceipt(x, 'acme')).toBe(true);
    expect(matchesReceipt(x, '1,234.56')).toBe(true);
    expect(matchesReceipt(x, '1234.56')).toBe(true);
    expect(matchesReceipt(x, 'zzz')).toBe(false);
    expect(matchesReceipt(receiptItem(rr({ firstLine: 'Booth deposit back' }), bank), 'booth')).toBe(true);
  });
});
