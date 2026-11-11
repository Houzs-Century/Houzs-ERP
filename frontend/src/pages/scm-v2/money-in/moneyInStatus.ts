// The words and tones Money in's lists put in their tags (the owner's Claude
// Design, batch 5). ONE home, so a status reads and looks the same on every
// Money-in page — CI's duplicated-decisions gate fires on a second copy. This
// holds Outstanding's and Not yet billed's today; the other Money-in pages
// bring theirs here as they are rebuilt.
//
// The four tones are the design's: late (red), warn (brass), info (petrol) and
// calm (grey). The WORD of a stored status always comes from status-pill's
// statusLabel, so the confirm rung reads "Submitted" here as everywhere else.

import { fmtDate } from '../../../vendor/shared/format';
import { humaniseStatusKey, statusLabel } from '../../../vendor/scm/lib/status-pill';
import { PAYMENT_METHOD_CODES, PAYMENT_METHOD_DEFAULT_LABELS } from '../../../vendor/scm/lib/payment-methods';
import type { OutstandingModule } from '../../../vendor/scm/lib/outstanding-queries';
import { dayDiff } from '../../../lib/dateRangePresets';

export type TagTone = 'late' | 'warn' | 'info' | 'calm';
export type Tag = { text: string; tone: TagTone };

/** An Outstanding row's status: the ERP's word, toned by what the document
 *  still waits on. Closed rows are calm and a cancelled or voided one late; an
 *  open one is brass while money or billing waits (an unpaid invoice, a GRN not
 *  billed, a delivery not invoiced, a return not refunded) and petrol while the
 *  work is under way (an order, a part-paid invoice). */
export function outstandingStatusTag(
  module: OutstandingModule,
  status: string | null | undefined,
  open: boolean,
  partlyPaid = false,
): Tag {
  const text = statusLabel(module, status);
  const s = String(status ?? '').toUpperCase();
  if (s === 'CANCELLED' || s === 'VOID') return { text, tone: 'late' };
  if (!open) return { text, tone: 'calm' };
  switch (module) {
    case 'si': return { text, tone: s === 'OVERDUE' ? 'late' : partlyPaid ? 'info' : 'warn' };
    case 'pi': return { text, tone: s === 'ON_HOLD' ? 'late' : 'warn' };
    case 'grn':
    case 'pr': return { text, tone: 'warn' };
    case 'so':
    case 'do': return { text, tone: s === 'DELIVERED' || s === 'SIGNED' || s === 'ON_HOLD' ? 'warn' : 'info' };
    case 'po': return { text, tone: s === 'ON_HOLD' ? 'warn' : 'info' };
  }
}

/** A due (or expected) date as a tag: `2026/10/01 · 28d late` in red once it
 *  has passed while the document is still open, else the date in grey. Null
 *  when there is no date. */
export function dueDateTag(date: string | null | undefined, open: boolean, today: string): Tag | null {
  const d = String(date ?? '').slice(0, 10);
  if (!d) return null;
  const late = open && d < today ? dayDiff(d, today) : 0;
  return late > 0 ? { text: `${fmtDate(d)} · ${late}d late`, tone: 'late' } : { text: fmtDate(d), tone: 'calm' };
}

/** Not yet billed's age tag: red from 91 days, brass from 31, grey before —
 *  the newest month is ordinary billing lag, not yet a finding. */
export function unbilledAgeTone(days: number): TagTone {
  return days >= 91 ? 'late' : days >= 31 ? 'warn' : 'calm';
}

/* ── The Money-in documents (batch 5 §2–§8) ──────────────────────────────────
   Each document's status in the design's words, read from the columns its
   own table already has. Written as switches, not lookup tables, so no second
   copy of a stored-status list exists beside the ERP's own. */

/** The sand tint of a document still open (the design's OPEN_BG): open sales
 *  invoices and debtor bills, debtors with money outstanding. */
export const OPEN_BG = 'var(--hz-dk-warning-bg, #fcf7ec)';
/** A row's style for DataTable's getRowStyle: sand while it is open. */
export const openRowStyle = (open: boolean): { background: string } | undefined => (open ? { background: OPEN_BG } : undefined);

/** An official receipt: a draft waits for its money to be confirmed, a formal
 *  one carries its channel number, a cancelled one followed its payment away. */
export function officialReceiptTag(status: string | null | undefined): Tag {
  switch (String(status ?? '').toUpperCase()) {
    case 'DRAFT': return { text: 'Draft', tone: 'warn' };
    case 'CANCELLED': return { text: 'Cancelled', tone: 'late' };
    default: return { text: 'Formal', tone: 'calm' };
  }
}

/** A sundry (general) receipt posts on save; a void one is reversed. */
export function sundryReceiptTag(status: string | null | undefined): Tag {
  return String(status ?? '').toUpperCase() === 'CANCELLED' ? { text: 'Voided', tone: 'late' } : { text: 'Posted', tone: 'calm' };
}

/** A deposit invoice: cancelled; issued but its journal refused at birth (Not
 *  posted); closed by its credit note at the final invoice; else issued. */
export function depositInvoiceTag(d: { status: string; je_no: string | null; credit_note_id: string | null }): Tag {
  if (d.status === 'CANCELLED') return { text: 'Cancelled', tone: 'late' };
  if (!d.je_no) return { text: 'Not posted', tone: 'warn' };
  if (d.credit_note_id) return { text: 'Closed', tone: 'calm' };
  return { text: 'Issued', tone: 'info' };
}

/** A debtor bill (or an other debtor's debit note): what is still owed on it. */
export function debtorBillTag(b: { status: string; total_sen: number; received_sen: number }): Tag {
  if (String(b.status).toUpperCase() === 'CANCELLED') return { text: 'Cancelled', tone: 'late' };
  const received = Number(b.received_sen);
  if (Number(b.total_sen) - received <= 0) return { text: 'Paid', tone: 'calm' };
  return received > 0 ? { text: 'Partly paid', tone: 'info' } : { text: 'Unpaid', tone: 'warn' };
}

/** A sales invoice, by its money: paid; past its due date with money
 *  outstanding (`Overdue <n>d`); part paid; unpaid. `paidSen` counts the
 *  order's deposit applied and the credit notes knocked off it, as the
 *  outstanding figure does. */
export function salesInvoiceTag(si: { outstandingSen: number; paidSen: number; dueDate: string | null; status?: string | null }, today: string): Tag {
  /* Finance lists the live invoices only; a page opened on a cancelled or a
     draft one says so first (statusLabel's own word). */
  const stored = String(si.status ?? '').toUpperCase();
  if (stored === 'CANCELLED') return { text: statusLabel('si', stored), tone: 'late' };
  if (stored === 'DRAFT') return { text: statusLabel('si', stored), tone: 'warn' };
  if (si.outstandingSen <= 0) return { text: 'Paid', tone: 'calm' };
  const due = String(si.dueDate ?? '').slice(0, 10);
  const late = due && due < today ? dayDiff(due, today) : 0;
  if (late > 0) return { text: `Overdue ${late}d`, tone: 'late' };
  return si.paidSen > 0 ? { text: 'Partly paid', tone: 'info' } : { text: 'Unpaid', tone: 'warn' };
}

/** A credit or debit note: a draft, posted, or cancelled. */
export function noteTag(status: string | null | undefined): Tag {
  switch (String(status ?? '').toUpperCase()) {
    case 'DRAFT': return { text: 'Draft', tone: 'warn' };
    case 'CANCELLED': return { text: 'Cancelled', tone: 'late' };
    default: return { text: 'Posted', tone: 'calm' };
  }
}

/** An other debtor in the registry. */
export const debtorTag = (active: boolean): Tag => (active ? { text: 'Active', tone: 'calm' } : { text: 'Inactive', tone: 'late' });

/** A customer payment's method in words (Cash, Transfer, Card…), as the
 *  Official receipts and Deposit invoices lists print it. */
export const methodWord = (m: string | null | undefined): string => {
  const code = PAYMENT_METHOD_CODES.find((c) => c === m);
  return code ? PAYMENT_METHOD_DEFAULT_LABELS[code] : m ? humaniseStatusKey(m) : '—';
};

/** A debtor receipt's stage — the payment voucher's four layers riding on a
 *  DRAFT as marks (PvDocParts' pvStage reads them): Draft calm, Prepared brass,
 *  Checked petrol, Approved calm, Cancelled red. */
export function debtorReceiptTag(stage: 'Draft' | 'Prepared' | 'Checked' | 'Approved' | 'Cancelled'): Tag {
  switch (stage) {
    case 'Prepared': return { text: stage, tone: 'warn' };
    case 'Checked': return { text: stage, tone: 'info' };
    case 'Cancelled': return { text: stage, tone: 'late' };
    default: return { text: stage, tone: 'calm' };
  }
}
