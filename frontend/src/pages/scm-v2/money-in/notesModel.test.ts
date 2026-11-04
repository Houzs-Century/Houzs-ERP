/* The rows of Money in › Credit / debit notes (batch 5 step 7): a note or an
   other debtor's debit note as one row, the segment it falls in, its status,
   what an other debtor's credit knocked off, and the URL's view read back. */

import { describe, expect, test } from 'vitest';
import type { ArListRow } from '../../../vendor/scm/lib/ar-invoice-queries';
import type { CreditNote } from '../../../vendor/scm/lib/credit-note-queries';
import {
  debitBillItem, inNoteChip, inNoteSegment, matchesNote, newestNoteFirst, noteChips, noteHref, noteItem, noteSegments, readNoteChip, readNoteSegment,
} from './notesModel';

const cn = (over: Partial<CreditNote>): CreditNote => ({
  id: 'n1', note_number: 'HC-CN-2611-001', kind: 'CN', party_type: 'CUSTOMER', party_code: '300-C001', party_name: 'TAN MEI LING',
  supplier_id: null, so_doc_no: 'HC-SO-2611-004', sales_invoice_id: null, ap_invoice_id: null, purchase_invoice_id: null, source_doc_no: null,
  note_date: '2026-11-02', total_sen: 15_000, reason: 'Scratched leg', notes: null, status: 'DRAFT', je_no: null,
  created_at: '2026-11-02T00:00:00Z', created_by: null, posted_at: null, cancelled_at: null, ...over,
});
const odn: ArListRow = {
  kind: 'ODB', docKind: 'DN', id: 'b7', invoiceNumber: 'HC-ODN-2611-001', partyKey: 'D:d2', partyCode: null, partyName: 'OLD DEBTOR', debtorId: 'd2',
  ref: null, description: 'Damaged booth', invoiceDate: '2026-11-01', dueDate: null, currency: 'MYR', totalSen: 10_000, paidSen: 0,
  depositAppliedSen: 0, outstandingSen: 10_000, status: 'POSTED',
};

describe('a note as a row', () => {
  test('a customer’s credit note: credit side, Draft, the order as its reference, nothing knocked off', () => {
    const x = noteItem(cn({}));
    expect(x).toMatchObject({ source: 'note', kindWord: 'CN', side: 'credit', otherDebtor: false, status: 'draft', reference: 'HC-SO-2611-004', knocks: null });
    expect(x.tag).toEqual({ text: 'Draft', tone: 'warn' });
    expect(noteHref(x)).toBe('/scm/credit-notes/n1');
  });

  test('an other debtor’s posted credit says what it knocked off and what is left; a debit note is debit side', () => {
    expect(noteItem(cn({ kind: 'OCN', status: 'POSTED', appliedSen: 150_000, unusedSen: 50_000 })).knocks).toEqual({ appliedSen: 150_000, leftSen: 50_000 });
    expect(noteItem(cn({ kind: 'OCN', status: 'DRAFT' })).knocks).toBeNull();
    expect(noteItem(cn({ kind: 'DN', status: 'POSTED' }))).toMatchObject({ kindWord: 'DN', side: 'debit', status: 'posted', knocks: null });
    expect(noteItem(cn({ status: 'CANCELLED' }))).toMatchObject({ status: 'cancelled', cancelled: true });
  });

  test('an other debtor’s debit note is a bill: debit side, posted, opening the bill page', () => {
    const x = debitBillItem(odn);
    expect(x).toMatchObject({ source: 'bill', kindWord: 'DN', side: 'debit', otherDebtor: true, status: 'posted', reference: 'Damaged booth', party: 'OLD DEBTOR' });
    expect(noteHref(x)).toBe('/scm/ar-invoices/bills/b7');
    expect(debitBillItem({ ...odn, status: 'CANCELLED' })).toMatchObject({ status: 'cancelled', cancelled: true });
  });
});

describe('segments, chips, search, order, the URL', () => {
  test('the design’s segments and chips, in order', () => {
    expect(noteSegments().map(([, l]) => l)).toEqual(['All', 'Credit notes', 'Debit notes']);
    expect(noteChips().map(([, l]) => l)).toEqual(['Any status', 'Draft', 'Posted', 'Cancelled']);
  });

  test('a row falls in its side and its status; the search reads number, party, reference, reason and amount', () => {
    const x = noteItem(cn({}));
    expect([inNoteSegment(x, 'all'), inNoteSegment(x, 'credit'), inNoteSegment(x, 'debit')]).toEqual([true, true, false]);
    expect([inNoteChip(x, 'any'), inNoteChip(x, 'draft'), inNoteChip(x, 'posted')]).toEqual([true, true, false]);
    for (const q of ['cn-2611', 'tan mei', 'so-2611-004', 'scratched', '150.00']) expect(matchesNote(x, q), q).toBe(true);
    expect(matchesNote(x, 'nothing like it')).toBe(false);
  });

  test('newest first; the URL’s kind and status read back, junk to the defaults', () => {
    const a = noteItem(cn({ note_date: '2026-11-01' }));
    const b = noteItem(cn({ id: 'n2', note_number: 'HC-CN-2611-002', note_date: '2026-11-03' }));
    expect([a, b].sort(newestNoteFirst).map((x) => x.no)).toEqual(['HC-CN-2611-002', 'HC-CN-2611-001']);
    expect([readNoteSegment('debit'), readNoteSegment('nope'), readNoteSegment(null)]).toEqual(['debit', 'all', 'all']);
    expect([readNoteChip('posted'), readNoteChip('POSTED'), readNoteChip('junk')]).toEqual(['posted', 'posted', 'any']);
  });
});
