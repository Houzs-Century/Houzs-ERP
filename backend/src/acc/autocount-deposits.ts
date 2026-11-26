// ----------------------------------------------------------------------------
// autocount-deposits — the deposit an order took in AutoCount, before the
// books started, offset at the order's sales invoice (owner 2026-11-25:
// 「以前autocount带过来的也要开cn对冲，但是以前的订单我是放在deferred revenue」;
// 「9月开始送的货如果是autocount带过来的订单，那么他的deposit就应该knock off
// deferred revenue」).
//
// WHERE THE MONEY IS. AutoCount kept customers' money on its cash debtor and
// moved it each month into DEFERRED REVENUE (440-0000); the books opened with
// that balance. The ERP carries each order's AutoCount money as a payment row
// of method 'imported', which books nothing (acc/payments.ts). A sales invoice
// books Dr AR for its whole total, so without this the customer owes the
// AutoCount money a second time in the books.
//
// WHAT IT DOES. At the order's first live sales invoice dated after the books'
// opening day, ONE credit note for the order's whole AutoCount money:
//     Dr AUTOCOUNT_DEFERRED (440-0000) / Cr AR (party = the invoice's party)
// dated the invoice day, linked to the invoice (sales_invoice_id), marked by
// its source document AUTOCOUNT_DEPOSIT_REF. A later invoice of the same order
// raises nothing. A cancelled invoice cancels its note by contra and the note
// is raised again on the order's next live invoice, if there is one.
//
// THE WHOLE AMOUNT, NOT A SLICE. A refund or a move of the order's money books
// Dr AR through its own flow (acc/payments.ts SOCONV, the Customer Refund), so
// the receivable already carries it back; only the note brings the AutoCount
// money onto the receivable at all. A first invoice smaller than the money
// leaves the customer in credit until the rest is invoiced, as an ERP payment
// does from the day it is taken.
//
// IT KNOCKS NOTHING OFF. The invoice already counts the order's AutoCount money
// as paid (scm/lib/si-order-deposit.ts reads every payment row of the order),
// so the note is a deposit paper (acc/credit-note-si.ts depositPapers): it nets
// inside its order on the AR Aging and is never ticked against an invoice.
//
// NOT HERE: money dated after the opening day (AutoCount took it after the
// books started, so it is not in DEFERRED REVENUE), a migrated invoice (it
// books nothing), an RM 0 invoice (no sale and no receivable to offset: an
// order AutoCount itself invoiced before the books carries one), an invoice
// dated on or before the opening day (soft launch, outside the books), a
// company with no books start.
//
// A DATE THE IMPORT COULD NOT KNOW. AutoCount kept no payment date: the second
// import (2026-09-08) dated a balance it found settled by the order's last
// edit, so a balance paid by the opening day can carry a September date. The
// caller that knows better (the back-fill, from AutoCount's own record) passes
// the amount; a note moved off a cancelled invoice keeps its amount the same way
// (owner 2026-11-26).
// ----------------------------------------------------------------------------

import { resolveRoles } from './rules';
import { customerPartyCode } from './payments';
import { loadBooksOpening } from './books-opening';
import { CREDIT_NOTE_HEADER, cancelCreditNote, insertCreditNote, postCreditNote } from './credit-notes';
import { companyCodeById } from '../scm/lib/doc-no';
import { docPrefixForCode } from '../scm/lib/companyScope';
import { AUTOCOUNT_DEPOSIT_REF } from './autocount-deposit-note';

export { AUTOCOUNT_DEPOSIT_REF, isAutoCountDepositNote } from './autocount-deposit-note';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

/* acc/payments.ts: an imported row books nothing — AutoCount carried it. */
const IMPORTED = 'imported';

type PaymentRow = { method?: unknown; amount_sen?: unknown; paid_at?: unknown };

/** The order's imported payment rows above nought, dated on or before
    `throughDay` — or whatever their date, when it is null. */
function importedSen(payments: ReadonlyArray<PaymentRow>, throughDay: string | null): number {
  let sen = 0;
  for (const p of payments) {
    if (String(p.method ?? '') !== IMPORTED) continue;
    const amount = Number(p.amount_sen ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (throughDay !== null) {
      const day = String(p.paid_at ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > throughDay) continue;
    }
    sen += amount;
  }
  return sen;
}

/** The order's AutoCount money that sits in DEFERRED REVENUE: its imported
    payment rows above nought, dated on or before the books' opening day. */
export function autoCountDepositSen(payments: ReadonlyArray<PaymentRow>, openingDate: string): number {
  return importedSen(payments, openingDate);
}

export type InvoiceParty = { code: string | null; name: string | null };

export type AutoCountDepositResult =
  | { ok: true; status: 'raised'; noteNumber: string; jeNo: string | null; amountSen: number }
  | { ok: true; status: 'already_offset'; noteNumber: string; jeNo: string | null }
  | { ok: true; status: 'nothing'; why: string }
  | { ok: false; reason: string };

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[acc/autocount-deposits]', ...args);
};

/** The AR party a sales invoice posts to — the rule post-si-revenue.ts follows:
    the invoice's debtor code, else its order's (debtor code, else customer id). */
export async function invoicePartyOf(
  sb: Db,
  companyId: number,
  si: { debtor_code?: string | null; debtor_name?: string | null; so_doc_no?: string | null },
): Promise<{ ok: true; party: InvoiceParty } | { ok: false; reason: string }> {
  let code = customerPartyCode(si.debtor_code ?? null, null);
  if (!code && si.so_doc_no) {
    const { data, error } = await sb.from('mfg_sales_orders')
      .select('customer_id, debtor_code').eq('company_id', companyId).eq('doc_no', si.so_doc_no).maybeSingle();
    if (error) return { ok: false, reason: `order: ${error.message}` };
    const o = data as { customer_id?: string | null; debtor_code?: string | null } | null;
    code = customerPartyCode(o?.debtor_code, o?.customer_id);
  }
  return { ok: true, party: { code, name: si.debtor_name ?? null } };
}

/** The live AutoCount deposit notes of one order (not cancelled). */
async function liveNotesOf(sb: Db, companyId: number, soDocNo: string): Promise<{ ok: true; notes: Row[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_credit_notes')
    .select(CREDIT_NOTE_HEADER)
    .eq('company_id', companyId).eq('kind', 'CN').eq('so_doc_no', soDocNo).eq('source_doc_no', AUTOCOUNT_DEPOSIT_REF)
    .neq('status', 'CANCELLED')
    .order('note_number');
  if (error) return { ok: false, reason: `notes: ${error.message}` };
  return { ok: true, notes: (data ?? []) as Row[] };
}

/**
 * At a sales invoice: the order's AutoCount deposit moves out of DEFERRED
 * REVENUE onto the customer — once per order. Idempotent: an order that already
 * carries a live note raises nothing (a draft one a retry left is posted).
 *
 * `amountSen`: null = the rule (imported money dated on or before the opening
 * day). A number = exactly that much, never more than the order's imported
 * money whatever its date — for a balance AutoCount's own record shows paid by
 * the opening day though the import dated it later, and for a note moved off a
 * cancelled invoice.
 */
export async function applyAutoCountDepositToInvoice(
  sb: Db,
  p: { companyId: number; siId: string; siNumber: string; soDocNo: string | null; invoiceDate: string; party: InvoiceParty; actor: string | null; amountSen: number | null },
): Promise<AutoCountDepositResult> {
  if (!p.soDocNo) return { ok: true, status: 'nothing', why: 'the invoice has no order' };
  const books = await loadBooksOpening(sb, p.companyId);
  if (!books.ok) return { ok: false, reason: books.reason };
  if (!books.opening) return { ok: true, status: 'nothing', why: 'the company has no books start' };
  const day = String(p.invoiceDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, reason: `invoice ${p.siNumber} has no date` };
  if (day <= books.opening.openingDate) return { ok: true, status: 'nothing', why: `dated ${day}, on or before the books' opening day` };

  const { data: si, error: siErr } = await sb.from('sales_invoices')
    .select('id, total_sen, migrated_no_stock')
    .eq('company_id', p.companyId).eq('id', p.siId).maybeSingle();
  if (siErr) return { ok: false, reason: `invoice: ${siErr.message}` };
  if (!si) return { ok: false, reason: `invoice ${p.siNumber} not found` };
  if ((si as Row).migrated_no_stock === true) return { ok: true, status: 'nothing', why: 'a migrated invoice books nothing' };
  if (!(Number((si as Row).total_sen ?? 0) > 0)) return { ok: true, status: 'nothing', why: 'the invoice bills RM 0: no sale and no receivable to offset' };

  const { data: pays, error: payErr } = await sb.from('mfg_sales_order_payments')
    .select('id, method, amount_sen, paid_at')
    .eq('company_id', p.companyId).eq('so_doc_no', p.soDocNo).eq('method', IMPORTED);
  if (payErr) return { ok: false, reason: `payments: ${payErr.message}` };
  const payments = (pays ?? []) as Row[];
  let amountSen = autoCountDepositSen(payments, books.opening.openingDate);
  if (p.amountSen !== null) {
    const ceiling = importedSen(payments, null);
    if (!Number.isInteger(p.amountSen) || p.amountSen <= 0 || p.amountSen > ceiling) {
      return { ok: false, reason: `${p.soDocNo}: ${p.amountSen} sen is not within its AutoCount money (${ceiling} sen)` };
    }
    amountSen = p.amountSen;
  }
  if (amountSen <= 0) return { ok: true, status: 'nothing', why: 'no AutoCount deposit on the order' };

  const live = await liveNotesOf(sb, p.companyId, p.soDocNo);
  if (!live.ok) return live;
  const standing = live.notes.find((n) => n.status !== 'CANCELLED');
  if (standing) {
    /* A note a retry left unposted is posted, never raised a second time. */
    if (standing.status === 'DRAFT') {
      const posted = await postCreditNote(sb, { companyId: p.companyId, note: standing, actor: p.actor });
      if (!posted.ok) return { ok: false, reason: `${String(standing.note_number)} not posted: ${posted.reason}` };
      return { ok: true, status: 'already_offset', noteNumber: String(standing.note_number), jeNo: posted.jeNo };
    }
    return { ok: true, status: 'already_offset', noteNumber: String(standing.note_number), jeNo: standing.je_no ?? null };
  }

  const code = await companyCodeById(sb, p.companyId);
  if (!code) return { ok: false, reason: `company ${p.companyId} has no code to number under` };
  const { data: order, error: oErr } = await sb.from('mfg_sales_orders')
    .select('linked_ac_docno').eq('company_id', p.companyId).eq('doc_no', p.soDocNo).maybeSingle();
  if (oErr) return { ok: false, reason: `order: ${oErr.message}` };
  const acDocNo = String((order as { linked_ac_docno?: string | null } | null)?.linked_ac_docno ?? '').trim();
  const roles = await resolveRoles(sb, p.companyId);
  const raised = await insertCreditNote(sb, {
    companyId: p.companyId,
    docPrefix: docPrefixForCode(code),
    kind: 'CN',
    party: { code: p.party.code, name: p.party.name },
    soDocNo: p.soDocNo,
    salesInvoiceId: p.siId,
    sourceDocNo: AUTOCOUNT_DEPOSIT_REF,
    noteDate: day,
    reason: `Deposit paid in AutoCount applied to ${p.siNumber}`,
    lines: [{
      description: `Deposit paid in AutoCount${acDocNo ? ` (${acDocNo})` : ''} on ${p.soDocNo}, applied to ${p.siNumber}`,
      code: roles.AUTOCOUNT_DEFERRED,
      amountSen,
    }],
    createdBy: p.actor,
  });
  if (!raised.ok) return { ok: false, reason: `note not raised: ${raised.reason}` };
  const posted = await postCreditNote(sb, { companyId: p.companyId, note: raised.note, actor: p.actor });
  /* Raised but refused at posting: the draft stays and the next posting of any
     of the order's invoices posts it (above), never a second note. */
  if (!posted.ok) return { ok: false, reason: `${String(raised.note.note_number)} raised but not posted: ${posted.reason}` };
  return { ok: true, status: 'raised', noteNumber: String(raised.note.note_number), jeNo: posted.jeNo, amountSen };
}

/** The hook the revenue posting calls (best-effort): never throws. */
export async function applyAutoCountDepositBestEffort(
  sb: Db,
  p: { companyId: number | null; siId: string; siNumber: string; soDocNo: string | null; invoiceDate: string; party: InvoiceParty; actor: string | null },
): Promise<void> {
  if (p.companyId == null) return;
  try {
    const r = await applyAutoCountDepositToInvoice(sb, { ...p, companyId: p.companyId, amountSen: null });
    if (!r.ok) log(`AutoCount deposit for ${p.siNumber} did not run:`, r.reason);
  } catch (e) {
    log(`AutoCount deposit for ${p.siNumber} threw:`, e);
  }
}

/** The order's earliest live, non-migrated invoice dated after the opening day
    that bills something (an RM 0 invoice posts no revenue), other than `exceptId`. */
async function nextInvoiceOf(sb: Db, companyId: number, soDocNo: string, exceptId: string, openingDate: string): Promise<{ ok: true; si: Row | null } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('sales_invoices')
    .select('id, invoice_number, invoice_date, status, so_doc_no, debtor_code, debtor_name, total_sen, migrated_no_stock')
    .eq('company_id', companyId).eq('so_doc_no', soDocNo)
    .not('status', 'in', '(DRAFT,CANCELLED)')
    .order('invoice_date').order('invoice_number');
  if (error) return { ok: false, reason: `invoices: ${error.message}` };
  const si = ((data ?? []) as Row[]).find((r) => String(r.id) !== exceptId && r.migrated_no_stock !== true
    && Number(r.total_sen ?? 0) > 0 && String(r.invoice_date ?? '').slice(0, 10) > openingDate) ?? null;
  return { ok: true, si };
}

/**
 * When a sales invoice is CANCELLED: its AutoCount deposit note is cancelled by
 * contra (the money is back in DEFERRED REVENUE), then raised again, for the
 * same amount, on the order's next live invoice, if it has one.
 */
export async function releaseAutoCountDepositFromInvoice(
  sb: Db,
  p: { companyId: number; siId: string; actor: string | null },
): Promise<{ ok: true; released: string[]; movedTo: string | null } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_credit_notes')
    .select(CREDIT_NOTE_HEADER)
    .eq('company_id', p.companyId).eq('kind', 'CN').eq('sales_invoice_id', p.siId).eq('source_doc_no', AUTOCOUNT_DEPOSIT_REF)
    .neq('status', 'CANCELLED');
  if (error) return { ok: false, reason: `notes: ${error.message}` };
  const notes = (data ?? []) as Row[];
  if (notes.length === 0) return { ok: true, released: [], movedTo: null };
  const released: string[] = [];
  let movedSen = 0;
  for (const note of notes) {
    const c = await cancelCreditNote(sb, { companyId: p.companyId, note, actor: p.actor });
    if (!c.ok) return { ok: false, reason: `${String(note.note_number)}: ${c.reason}` };
    released.push(String(note.note_number));
    movedSen += Number(note.total_sen ?? 0);
  }
  const soDocNo = String(notes[0]!.so_doc_no ?? '').trim();
  if (!soDocNo) return { ok: true, released, movedTo: null };
  const books = await loadBooksOpening(sb, p.companyId);
  if (!books.ok) return { ok: false, reason: books.reason };
  if (!books.opening) return { ok: true, released, movedTo: null };
  const next = await nextInvoiceOf(sb, p.companyId, soDocNo, p.siId, books.opening.openingDate);
  if (!next.ok) return next;
  if (!next.si) return { ok: true, released, movedTo: null };
  const party = await invoicePartyOf(sb, p.companyId, next.si);
  if (!party.ok) return party;
  const again = await applyAutoCountDepositToInvoice(sb, {
    companyId: p.companyId, siId: String(next.si.id), siNumber: String(next.si.invoice_number), soDocNo,
    invoiceDate: String(next.si.invoice_date), party: party.party, actor: p.actor, amountSen: movedSen,
  });
  if (!again.ok) return { ok: false, reason: `raised again on ${String(next.si.invoice_number)}: ${again.reason}` };
  return { ok: true, released, movedTo: again.status === 'raised' ? again.noteNumber : null };
}

/** The hook the invoice cancel calls (best-effort): never throws. */
export async function releaseAutoCountDepositBestEffort(sb: Db, p: { companyId: number | null; siId: string; siNumber: string; actor: string | null }): Promise<void> {
  if (p.companyId == null) return;
  try {
    const r = await releaseAutoCountDepositFromInvoice(sb, { companyId: p.companyId, siId: p.siId, actor: p.actor });
    if (!r.ok) log(`AutoCount deposit release for ${p.siNumber} did not run:`, r.reason);
  } catch (e) {
    log(`AutoCount deposit release for ${p.siNumber} threw:`, e);
  }
}
