// ----------------------------------------------------------------------------
// receiptsModel — the rows of Money in › Receipts (the owner's Claude Design,
// batch 5 §2): the official receipts (one per customer payment, the paper),
// the sundry-income and other-debtor receipts (the money-in list) and the
// customer payments mirror, as ONE kind of row; the kind segments, the status
// chips each kind has, the search, and what each row says in the design's
// words. Pure — the page brings the reads and the steps.
// ----------------------------------------------------------------------------

import type { ReceiptRow } from '../../../vendor/scm/lib/accounting-queries';
import { searchText, soRefOfCamelStamp } from '../../../lib/so-ref-search';
import { fmtSen } from '../../../vendor/shared/format';
import { pvStage } from '../PvDocParts';
import { debtorReceiptTag, methodWord, officialReceiptTag, sundryReceiptTag, type Tag } from './moneyInStatus';
import type { OfficialReceiptRow } from './moneyInDocQueries';
import { moneyInDocHref } from './moneyInDocs';

/** The four kinds of money in. `customer` is the payments mirror — the same
 *  money as the official receipts, so it is never counted in All. */
export type ReceiptKind = 'official' | 'sundry' | 'debtor' | 'customer';
export type KindPick = 'all' | ReceiptKind;
export type DebtorStage = ReturnType<typeof pvStage>;

/** An official receipt as the list reads it (GET /accounting/receipts). */
export type OfficialListRow = Omit<OfficialReceiptRow, 'created_by' | 'replaced_by_id'> & { created_by?: string | null; replaced_by_id?: number | null };

/** One row of the merged list. */
export type ReceiptItem = {
  key: string;
  kind: ReceiptKind;
  id: string;
  no: string;
  /** The day the money came: the payment's for an official receipt, the receipt's otherwise. */
  date: string;
  from: string;
  /** What it was for: the order (or invoice), the first line, the bills. */
  forText: string;
  /** Where For opens — the order, the first bill; null when it opens nothing. */
  forHref: string | null;
  /** Method / into: the payment method, or the bank the money went into. */
  via: string;
  amountSen: number;
  /** The status chip key the row answers to within its kind. */
  status: string;
  /** All's three groups; null for the customer payments mirror. */
  group: 'pending' | 'final' | 'cancelled' | null;
  cancelled: boolean;
  tag: Tag;
  /** A cancelled official receipt's reason. */
  note: string | null;
  official?: OfficialListRow;
  receipt?: ReceiptRow;
  stage?: DebtorStage;
};

/** The debtor receipt's stage, from the marks the list carries (c1): the PV's four layers. */
export const debtorStageOf = (r: Pick<ReceiptRow, 'status' | 'submittedAt' | 'checkedAt'>): DebtorStage =>
  pvStage({ status: r.status, submitted_at: r.submittedAt ?? null, checked_at: r.checkedAt ?? null });

/** "2026-10" for a date. */
const monthOf = (d: string): string => d.slice(0, 7);

const soHref = (doc: string): string => `/scm/sales-orders/${encodeURIComponent(doc)}`;

/** An official receipt as a row. Its For is its order — or, for a sales
 *  invoice's payment healed by `ensure`, nothing a page can be opened from:
 *  that doc_no holds the invoice's id, not a number (acc/receipts.ts). */
export function officialItem(r: OfficialListRow): ReceiptItem {
  const status = String(r.status).toUpperCase();
  const draft = status === 'DRAFT';
  const cancelled = status === 'CANCELLED';
  const order = r.payment_source === 'SOPAY' ? r.doc_no : null;
  return {
    key: `official:${r.id}`, kind: 'official', id: String(r.id), no: r.or_number,
    date: String(r.paid_at ?? '').slice(0, 10), from: r.customer_name ?? '—',
    forText: order ?? (r.payment_source === 'SIPAY' ? 'Sales invoice' : '—'), forHref: order ? soHref(order) : null,
    via: methodWord(r.method), amountSen: Number(r.amount_sen),
    status: draft ? 'draft' : cancelled ? 'cancelled' : 'formal',
    group: draft ? 'pending' : cancelled ? 'cancelled' : 'final',
    cancelled, tag: officialReceiptTag(status), note: cancelled ? r.cancel_reason ?? null : null, official: r,
  };
}

/** A row of GET /receipts — a sundry receipt, an other debtor's, or a customer
 *  payment — as a row. `bankName` names the money account. */
export function receiptItem(r: ReceiptRow, bankName: (code: string) => string): ReceiptItem {
  const date = String(r.date).slice(0, 10);
  if (r.kind === 'CUSTOMER') {
    /* Its number IS the order; For has nothing more to say. */
    return {
      key: `customer:${r.id}`, kind: 'customer', id: r.id, no: r.number, date, from: r.payer,
      forText: '—', forHref: soHref(r.number), via: methodWord(r.moneyAccount), amountSen: r.totalSen,
      status: 'received', group: null, cancelled: false, tag: { text: 'Received', tone: 'calm' }, note: null, receipt: r,
    };
  }
  if (r.kind === 'GENERAL') {
    const voided = String(r.status).toUpperCase() === 'CANCELLED';
    return {
      key: `sundry:${r.id}`, kind: 'sundry', id: r.id, no: r.number, date, from: r.payer,
      forText: r.firstLine || '—', forHref: null, via: bankName(r.moneyAccount), amountSen: r.totalSen,
      status: voided ? 'voided' : 'posted', group: voided ? 'cancelled' : 'final',
      cancelled: voided, tag: sundryReceiptTag(r.status), note: null, receipt: r,
    };
  }
  const stage = debtorStageOf(r);
  const bills = r.bills ?? [];
  const first = bills.find((b) => b.no);
  return {
    key: `debtor:${r.id}`, kind: 'debtor', id: r.id, no: r.number, date, from: r.payer,
    forText: bills.map((b) => b.no).filter(Boolean).join(', ') || '—',
    forHref: first ? `/scm/ar-invoices/bills/${encodeURIComponent(first.billId)}` : null,
    via: bankName(r.moneyAccount), amountSen: r.totalSen, status: stage.toLowerCase(),
    group: stage === 'Approved' ? 'final' : stage === 'Cancelled' ? 'cancelled' : 'pending',
    cancelled: stage === 'Cancelled', tag: debtorReceiptTag(stage), note: null, receipt: r, stage,
  };
}

/** Where a row opens: its document's page — a customer payment, its order. */
export const receiptHref = (x: Pick<ReceiptItem, 'kind' | 'id' | 'forHref'>): string => {
  switch (x.kind) {
    case 'official': return moneyInDocHref('official', x.id);
    case 'sundry': return moneyInDocHref('sundry', x.id);
    case 'debtor': return moneyInDocHref('debtorReceipt', x.id);
    case 'customer': return x.forHref ?? '';
  }
};

/** The kind segments, in the design's order; the customer payments after a divider. */
export const kindLabel = (k: KindPick): string => {
  switch (k) {
    case 'all': return 'All';
    case 'official': return 'Official receipts';
    case 'sundry': return 'Sundry income';
    case 'debtor': return 'Other debtor';
    case 'customer': return 'Customer payments';
  }
};

/** The Kind column's tag. */
export const kindTag = (k: ReceiptKind): Tag => {
  switch (k) {
    case 'official': return { text: 'Official receipt', tone: 'info' };
    case 'sundry': return { text: 'Sundry income', tone: 'calm' };
    case 'debtor': return { text: 'Other debtor', tone: 'warn' };
    case 'customer': return { text: 'Customer payment', tone: 'calm' };
  }
};

/** The status chips a kind has: [key, label]. All groups the kinds' own words;
 *  the official receipts keep the ERP's Cancelled (a receipt that followed its
 *  payment away); the customer payments mirror has none. */
export function chipsOf(k: KindPick): Array<[string, string]> {
  switch (k) {
    case 'all': return [['all', 'All'], ['pending', 'Not final'], ['final', 'Final'], ['cancelled', 'Cancelled']];
    case 'official': return [['all', 'All'], ['draft', 'Draft · money not confirmed'], ['formal', 'Formal'], ['cancelled', 'Cancelled']];
    case 'sundry': return [['all', 'All'], ['posted', 'Posted'], ['voided', 'Voided']];
    case 'debtor': return [['all', 'All'], ['draft', 'Draft'], ['prepared', 'Prepared'], ['checked', 'Checked'], ['approved', 'Approved'], ['cancelled', 'Cancelled']];
    case 'customer': return [];
  }
}

/** Does the row belong to the kind segment. All is the three kinds that are receipts. */
export const inKind = (x: ReceiptItem, k: KindPick): boolean => (k === 'all' ? x.kind !== 'customer' : x.kind === k);

/** Does the row answer to the chip within the kind segment. */
export const inChip = (x: ReceiptItem, k: KindPick, chip: string): boolean =>
  chip === 'all' || (k === 'all' ? x.group === chip : x.status === chip);

/** The search: number, payer, what it was for, method or bank, amount — and a
 *  customer payment by its order's reference (soRefOfCamelStamp). */
export const matchesReceipt = (x: ReceiptItem, q: string): boolean => {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return searchText([
    x.no, x.from, x.forText, x.via, fmtSen(x.amountSen), (x.amountSen / 100).toFixed(2),
    x.receipt?.kind === 'CUSTOMER' ? soRefOfCamelStamp(x.receipt) : null,
    x.receipt?.payerCode,
  ]).includes(needle);
};

/** Newest first, then by number — the design's order. */
export const newestFirst = (a: ReceiptItem, b: ReceiptItem): number =>
  b.date.localeCompare(a.date) || b.no.localeCompare(a.no);

/** In the picked month ('' = any). An official receipt counts by its payment's day. */
export const inMonth = (x: ReceiptItem, month: string): boolean => !month || monthOf(x.date) === month;

/** The URL's kind / status, read safely: an unknown kind is All, an unknown
 *  chip for the kind is its All. Official receipts' old status words
 *  (DRAFT, FORMAL, CANCELLED) read as their chips. */
export function readKind(raw: string | null): KindPick {
  switch (String(raw ?? '').toLowerCase()) {
    case 'official': return 'official';
    case 'sundry': return 'sundry';
    case 'debtor': return 'debtor';
    case 'customer': return 'customer';
    default: return 'all';
  }
}
export function readChip(kind: KindPick, raw: string | null): string {
  const s = String(raw ?? '').toLowerCase();
  return chipsOf(kind).some(([key]) => key === s) ? s : 'all';
}

/** Today's month in Malaysia, "2026-10". */
export const thisMonth = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

/** "2026-10" ± n months. */
export const shiftMonth = (month: string, by: number): string => {
  const [y = 2026, m = 1] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

/** The month nav's label, "2026/10". */
export const monthLabel = (month: string): string => month.replace('-', '/');

/** "October 2026". */
export const monthName = (month: string): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
