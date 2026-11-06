// ----------------------------------------------------------------------------
// notesModel — the rows of Money in › Credit / debit notes (the owner's Claude
// Design, batch 5 §5): a customer's credit and debit notes, an other debtor's
// credit note (OCN) and an other debtor's debit note (ODN — a bill of its own
// kind, raised and received like a bill) as ONE kind of row; the segments
// (credit · debit), the status chips, the search. Pure.
// ----------------------------------------------------------------------------

import type { ArListRow } from '../../../vendor/scm/lib/ar-invoice-queries';
import type { CreditNote } from '../../../vendor/scm/lib/credit-note-queries';
import { searchText } from '../../../lib/so-ref-search';
import { fmtSen } from '../../../vendor/shared/format';
import { noteTag, type Tag } from './moneyInStatus';
import { moneyInDocHref } from './moneyInDocs';

export type NoteSegment = 'all' | 'credit' | 'debit';
export type NoteChip = 'any' | 'draft' | 'posted' | 'cancelled';

/** One row: a note (CN, DN, OCN) or an other debtor's debit note (a bill). */
export type NoteItem = {
  key: string;
  /** Where it comes from: the notes table, or the debtor bills (ODN). */
  source: 'note' | 'bill';
  id: string;
  no: string;
  /** CN or DN, as the design's Kind column says it. */
  kindWord: 'CN' | 'DN';
  /** Credit (CN, OCN) or debit (DN, ODN). */
  side: 'credit' | 'debit';
  /** An other debtor's note (OCN, ODN). */
  otherDebtor: boolean;
  date: string;
  party: string;
  reference: string;
  totalSen: number;
  status: Exclude<NoteChip, 'any'>;
  cancelled: boolean;
  tag: Tag;
  journal: string | null;
  /** What it knocks off: an OCN's knocked-off total and what is left; '—' when it knocks off nothing. */
  knocks: { appliedSen: number; leftSen: number } | null;
  note?: CreditNote;
  bill?: ArListRow;
};

export function noteItem(n: CreditNote): NoteItem {
  const status = n.status === 'DRAFT' ? 'draft' : n.status === 'CANCELLED' ? 'cancelled' : 'posted';
  const credit = n.kind !== 'DN';
  return {
    key: `note:${n.id}`, source: 'note', id: n.id, no: n.note_number, kindWord: credit ? 'CN' : 'DN', side: credit ? 'credit' : 'debit',
    otherDebtor: n.kind === 'OCN', date: String(n.note_date).slice(0, 10), party: n.party_name ?? n.party_code ?? '—',
    reference: [n.so_doc_no, n.source_doc_no].filter(Boolean).join(' · ') || '—',
    totalSen: Number(n.total_sen), status, cancelled: status === 'cancelled', tag: noteTag(n.status), journal: n.je_no,
    /* An other debtor's credit knocks off their bills (the knock-off the list
       carries); a customer's waits for its own knock-off (f2). */
    knocks: n.kind === 'OCN' && status === 'posted' ? { appliedSen: Number(n.appliedSen ?? 0), leftSen: Number(n.unusedSen ?? 0) } : null,
    note: n,
  };
}

/** An other debtor's debit note — a bill: posted on save, or cancelled. */
export function debitBillItem(b: ArListRow): NoteItem {
  const cancelled = String(b.status).toUpperCase() === 'CANCELLED';
  return {
    key: `bill:${b.id}`, source: 'bill', id: b.id, no: b.invoiceNumber, kindWord: 'DN', side: 'debit', otherDebtor: true,
    date: String(b.invoiceDate ?? '').slice(0, 10), party: b.partyName ?? '—', reference: b.description ?? '—',
    totalSen: b.totalSen, status: cancelled ? 'cancelled' : 'posted', cancelled,
    tag: noteTag(cancelled ? 'CANCELLED' : 'POSTED'), journal: null, knocks: null, bill: b,
  };
}

export const noteHref = (x: Pick<NoteItem, 'source' | 'id'>): string =>
  moneyInDocHref(x.source === 'bill' ? 'debtorBill' : 'note', x.id);

/** The segments, [key, label], in the design's order. */
export const noteSegments = (): Array<[NoteSegment, string]> => [['all', 'All'], ['credit', 'Credit notes'], ['debit', 'Debit notes']];
/** The status chips, [key, label], in the design's order. */
export const noteChips = (): Array<[NoteChip, string]> => [['any', 'Any status'], ['draft', 'Draft'], ['posted', 'Posted'], ['cancelled', 'Cancelled']];

export const inNoteSegment = (x: NoteItem, s: NoteSegment): boolean => s === 'all' || x.side === s;
export const inNoteChip = (x: NoteItem, c: NoteChip): boolean => c === 'any' || x.status === c;

export const matchesNote = (x: NoteItem, q: string): boolean => {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return searchText([x.no, x.party, x.note?.debtor_code, x.bill?.partyCode, x.reference, x.note?.reason, fmtSen(x.totalSen), (x.totalSen / 100).toFixed(2)]).includes(needle);
};

export const newestNoteFirst = (a: NoteItem, b: NoteItem): number => b.date.localeCompare(a.date) || b.no.localeCompare(a.no);

export const readNoteSegment = (raw: string | null): NoteSegment => (raw === 'credit' || raw === 'debit' ? raw : 'all');
export const readNoteChip = (raw: string | null): NoteChip => {
  const s = String(raw ?? '').toLowerCase();
  return noteChips().find(([key]) => key === s)?.[0] ?? 'any';
};
