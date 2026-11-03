// ----------------------------------------------------------------------------
// invoicesModel — the rows of Money in › Invoices (the owner's Claude Design,
// batch 5 §3): the sales invoices (read from Sales), the deposit invoices (one
// per customer payment before the final invoice) and the other debtors' bills
// and debit notes, as ONE kind of row; the kind segments, the status chips,
// the search, and what each row says in the design's words. Pure — the page
// brings the reads and the steps.
// ----------------------------------------------------------------------------

import type { ArListRow } from '../../../vendor/scm/lib/ar-invoice-queries';
import type { DepositInvoice } from '../../../vendor/scm/lib/deposit-invoice-queries';
import { searchText } from '../../../lib/so-ref-search';
import { fmtSen } from '../../../vendor/shared/format';
import { debtorBillTag, depositInvoiceTag, salesInvoiceTag, type Tag } from './moneyInStatus';
import { moneyInDocHref } from './moneyInDocs';

export type InvoiceKind = 'si' | 'di' | 'bill';
export type InvoiceKindPick = 'all' | InvoiceKind;
/** The design's status chips: still owed, issued but not on the books, done, cancelled. */
export type InvoiceChip = 'any' | 'open' | 'notposted' | 'settled' | 'cancelled';

/** One row of the merged list. */
export type InvoiceItem = {
  key: string;
  kind: InvoiceKind;
  id: string;
  no: string;
  date: string;
  /** The customer, or the other debtor. */
  billTo: string;
  /** The party as the filter groups it (`C:<code>` a customer, `D:<id>` a debtor). */
  partyKey: string | null;
  /** The order, or the bill's description. */
  forText: string;
  forHref: string | null;
  totalSen: number;
  /** What is still owed — null on a deposit invoice (it is money received, not owed). */
  outstandingSen: number | null;
  status: Exclude<InvoiceChip, 'any'>;
  cancelled: boolean;
  tag: Tag;
  /** An other debtor's debit note (a bill of its own kind). */
  debitNote: boolean;
  journal: string | null;
  closedBy: string | null;
  ar?: ArListRow;
  di?: DepositInvoice;
};

const soHref = (doc: string): string => `/scm/sales-orders/${encodeURIComponent(doc)}`;

/** A sales invoice or a debtor bill (GET /ar-invoices) as a row. */
export function arItem(r: ArListRow, today: string): InvoiceItem {
  if (r.kind === 'SI') {
    const open = r.outstandingSen > 0;
    return {
      key: `si:${r.id}`, kind: 'si', id: r.id, no: r.invoiceNumber, date: String(r.invoiceDate ?? '').slice(0, 10),
      billTo: r.partyName ?? '—', partyKey: r.partyKey, forText: r.ref ?? '—', forHref: r.ref ? soHref(r.ref) : null,
      totalSen: r.totalSen, outstandingSen: r.outstandingSen, status: open ? 'open' : 'settled', cancelled: false,
      tag: salesInvoiceTag({ outstandingSen: r.outstandingSen, paidSen: r.paidSen, dueDate: r.dueDate, status: r.status }, today),
      debitNote: false, journal: null, closedBy: null, ar: r,
    };
  }
  const cancelled = String(r.status).toUpperCase() === 'CANCELLED';
  const tag = debtorBillTag({ status: r.status, total_sen: r.totalSen, received_sen: r.paidSen });
  return {
    key: `bill:${r.id}`, kind: 'bill', id: r.id, no: r.invoiceNumber, date: String(r.invoiceDate ?? '').slice(0, 10),
    billTo: r.partyName ?? '—', partyKey: r.partyKey, forText: r.description ?? '—', forHref: null,
    totalSen: r.totalSen, outstandingSen: cancelled ? null : r.outstandingSen,
    status: cancelled ? 'cancelled' : r.outstandingSen > 0 ? 'open' : 'settled', cancelled, tag,
    debitNote: r.docKind === 'DN', journal: null, closedBy: null, ar: r,
  };
}

/** A deposit invoice as a row: Not posted while its journal was refused at
 *  birth, Settled once its credit note closed it, else Open. */
export function depositItem(d: DepositInvoice): InvoiceItem {
  const cancelled = d.status === 'CANCELLED';
  return {
    key: `di:${d.id}`, kind: 'di', id: d.id, no: d.di_number, date: String(d.invoice_date).slice(0, 10),
    billTo: d.party_name ?? d.party_code ?? '—', partyKey: d.party_code ? `C:${d.party_code}` : null,
    forText: d.so_doc_no, forHref: d.so_doc_no ? soHref(d.so_doc_no) : null,
    totalSen: d.amount_sen, outstandingSen: null,
    status: cancelled ? 'cancelled' : !d.je_no ? 'notposted' : d.credit_note_id ? 'settled' : 'open',
    cancelled, tag: depositInvoiceTag(d), debitNote: false, journal: d.je_no,
    closedBy: d.credit_note_number ?? (d.credit_note_id ? 'CN' : null), di: d,
  };
}

/** Where a row opens: its document's page. */
export const invoiceHref = (x: Pick<InvoiceItem, 'kind' | 'id'>): string =>
  moneyInDocHref(x.kind === 'si' ? 'salesInvoice' : x.kind === 'di' ? 'depositInvoice' : 'debtorBill', x.id);

export const invoiceKindLabel = (k: InvoiceKindPick): string => {
  switch (k) {
    case 'all': return 'All';
    case 'si': return 'Sales invoices';
    case 'di': return 'Deposit invoices';
    case 'bill': return 'Debtor bills';
  }
};

/** The Kind column's tag; an other debtor's debit note says so. */
export const invoiceKindTag = (x: Pick<InvoiceItem, 'kind' | 'debitNote'>): Tag => {
  if (x.debitNote) return { text: 'Debit note', tone: 'warn' };
  switch (x.kind) {
    case 'si': return { text: 'Sales invoice', tone: 'calm' };
    case 'di': return { text: 'Deposit invoice', tone: 'info' };
    case 'bill': return { text: 'Debtor bill', tone: 'warn' };
  }
};

/** The status chips, [key, label], in the design's order. */
export const invoiceChips = (): Array<[InvoiceChip, string]> =>
  [['any', 'Any status'], ['open', 'Open'], ['notposted', 'Not posted'], ['settled', 'Settled'], ['cancelled', 'Cancelled']];

export const inInvoiceKind = (x: InvoiceItem, k: InvoiceKindPick): boolean => k === 'all' || x.kind === k;
export const inInvoiceChip = (x: InvoiceItem, c: InvoiceChip): boolean => c === 'any' || x.status === c;

/** The search: number, who, what for, the amounts. */
export const matchesInvoice = (x: InvoiceItem, q: string): boolean => {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return searchText([
    x.no, x.billTo, x.forText, x.ar?.ref, x.ar?.partyCode, fmtSen(x.totalSen), (x.totalSen / 100).toFixed(2),
  ]).includes(needle);
};

export const newestInvoiceFirst = (a: InvoiceItem, b: InvoiceItem): number =>
  b.date.localeCompare(a.date) || b.no.localeCompare(a.no);

/** The URL's kind and chip, read safely (the old Deposit invoices page's
 *  `?kind=deposit` included). */
export function readInvoiceKind(raw: string | null): InvoiceKindPick {
  switch (String(raw ?? '').toLowerCase()) {
    case 'si': case 'sales': return 'si';
    case 'di': case 'deposit': return 'di';
    case 'bill': case 'bills': case 'odb': return 'bill';
    default: return 'all';
  }
}
export const readInvoiceChip = (raw: string | null): InvoiceChip => {
  const s = String(raw ?? '').toLowerCase();
  return invoiceChips().find(([key]) => key === s)?.[0] ?? 'any';
};
