// ----------------------------------------------------------------------------
// acc/deposit-refunds — a customer refund on an order that carries deposit
// invoices: the CREDIT NOTE half (owner 2026-09-13: partial refund 可以做; 就
// DI 也需要开 CN — a deposit invoice, once issued, is taken back by a credit
// note, never contra'd; docs/bugs/0860).
//
// A deposit invoice booked the money as a sale the day it was received
// (Dr AR / Cr DEPOSIT PAY BY CUSTOMER, docs/bugs/0828). Refunding that money
// on its own — the Customer Refund voucher, Dr AR / Cr bank — leaves the sale
// standing: the customer's AR nets to nothing while 509 still says the
// deposit was earned. The paper that takes the sale back is a credit note
// against the deposit invoice, Dr DEPOSIT PAY BY CUSTOMER / Cr AR, for the
// amount refunded — which may be PART of the invoice (owner 2026-09-12: 要预留
// 可能是 partial refund，这点很重要). It is also the e-invoice shape: a Refund
// Note referencing the original document, never a cancel past 72 hours.
//
// RULES.
//   • Raised when the refund voucher POSTS (approval is the posting), one
//     note per deposit invoice the refund draws on, oldest invoice first,
//     dated the voucher's day, carrying the voucher's id (refund_pv_id).
//   • An invoice refunded in FULL is closed by its note (credit_note_id);
//     one refunded in PART stands for the remainder, and the final invoice
//     closes the remainder (deposit-invoices.ts reads refundedByInvoice).
//   • A cancelled refund voucher cancels its notes by contra, and the
//     invoices stand again for what they stood for.
//   • Idempotent per (voucher, invoice): a retry after a partial failure
//     finds the note it raised and posts and links it rather than raising a
//     second beside it.
//   • Money on the order no deposit invoice covers (a payment after the
//     final invoice, or before the switch) needs no note: the refund's own
//     Dr AR already answers that payment's Cr AR. It is reported, not hidden.
//   • A CONVERSION (owner 2026-09-15; docs/bugs/0927) takes money off the
//     cancelled order's deposit invoices the same way — a note per invoice,
//     oldest first, for the amount moved, carrying converted_payment_id
//     instead of refund_pv_id — and the new order's own deposit invoice is
//     issued beside it. Un-converting (the converted row deleted) cancels
//     the notes by contra, the way a cancelled refund voucher does.
//
// This file does not import deposit-invoices.ts — that file imports this one
// for the close-out — so it reads the invoice with its own column list.
// ----------------------------------------------------------------------------

import { CREDIT_NOTE_HEADER, cancelCreditNote, insertCreditNote, postCreditNote } from './credit-notes';
import { resolveRoles } from './rules';
import { companyCodeById } from '../scm/lib/doc-no';
import { docPrefixForCode } from '../scm/lib/companyScope';
import { fmtSen } from '../scm/shared/format';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[acc/deposit-refunds]', ...args);
};

const DI_FIELDS = 'id, company_id, di_number, so_doc_no, party_code, party_name, invoice_date, amount_sen, status, credit_note_id';
type DiRow = {
  id: string; company_id: number; di_number: string; so_doc_no: string; party_code: string | null; party_name: string | null;
  invoice_date: string; amount_sen: number; status: string; credit_note_id: string | null;
};

/** One partial taker of a deposit invoice — a refund's note or a
    conversion's — as the page and the close-out read it. */
export type RefundNote = {
  id: string; noteNumber: string; diNumber: string; totalSen: number; status: string;
  /** The refund voucher that raised it, or null for a conversion's note. */
  refundPvId: string | null;
  /** The converted payment row that raised it, or null for a refund's note. */
  convertedPaymentId: string | null;
  noteDate: string;
};

/**
 * What has already been taken off each deposit invoice, by invoice number:
 * every non-cancelled CN that names the invoice AND carries a refund voucher
 * id or a converted payment id. The close-out note (sales_invoice_id set,
 * neither) and a note Finance raised by hand are not among them.
 */
export async function refundedByInvoice(
  sb: Db, companyId: number, diNumbers: string[],
): Promise<{ ok: true; sen: Map<string, number>; notes: Map<string, RefundNote[]> } | { ok: false; reason: string }> {
  const sen = new Map<string, number>();
  const notes = new Map<string, RefundNote[]>();
  const wanted = [...new Set(diNumbers.filter(Boolean))];
  for (let i = 0; i < wanted.length; i += 200) {
    const { data, error } = await sb.from('acc_credit_notes')
      .select('id, note_number, source_doc_no, total_sen, status, refund_pv_id, converted_payment_id, note_date')
      .eq('company_id', companyId).eq('kind', 'CN').neq('status', 'CANCELLED')
      .in('source_doc_no', wanted.slice(i, i + 200));
    if (error) return { ok: false, reason: `refund notes: ${error.message}` };
    for (const r of (data ?? []) as Row[]) {
      if (r.refund_pv_id == null && r.converted_payment_id == null) continue;
      const di = String(r.source_doc_no);
      const n: RefundNote = {
        id: String(r.id), noteNumber: String(r.note_number), diNumber: di, totalSen: Number(r.total_sen ?? 0),
        status: String(r.status), refundPvId: r.refund_pv_id == null ? null : String(r.refund_pv_id),
        convertedPaymentId: r.converted_payment_id == null ? null : String(r.converted_payment_id),
        noteDate: String(r.note_date ?? '').slice(0, 10),
      };
      sen.set(di, (sen.get(di) ?? 0) + n.totalSen);
      const at = notes.get(di);
      if (at) at.push(n); else notes.set(di, [n]);
    }
  }
  return { ok: true, sen, notes };
}

/** The deposit invoices still standing on an order — no note has closed
    them — and what is left on them after earlier refunds. What the refund
    form says before the voucher is raised. */
export async function standingDeposits(
  sb: Db, companyId: number, soDocNo: string,
): Promise<{ ok: true; deposits: { count: number; standingSen: number } } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_deposit_invoices')
    .select('di_number, amount_sen, credit_note_id')
    .eq('company_id', companyId).eq('so_doc_no', soDocNo).neq('status', 'CANCELLED');
  if (error) return { ok: false, reason: `deposit invoices: ${error.message}` };
  const open = ((data ?? []) as Array<{ di_number: string; amount_sen: number; credit_note_id: string | null }>).filter((d) => !d.credit_note_id);
  if (open.length === 0) return { ok: true, deposits: { count: 0, standingSen: 0 } };
  const taken = await refundedByInvoice(sb, companyId, open.map((d) => d.di_number));
  if (!taken.ok) return taken;
  const standingSen = open.reduce((s, d) => s + Math.max(0, Number(d.amount_sen) - (taken.sen.get(d.di_number) ?? 0)), 0);
  return { ok: true, deposits: { count: open.length, standingSen } };
}

export type RefundInput = {
  companyId: number;
  pvId: string;
  pvNumber: string;
  /** The voucher's day — the notes are dated with it. */
  voucherDate: string;
  soDocNo: string;
  amountSen: number;
  actor: string | null;
};

export type RaisedRefundNote = { diNumber: string; noteNumber: string; sen: number; jeNo: string | null; closed: boolean };

export type RefundResult =
  | { ok: true; raised: RaisedRefundNote[]; uncoveredSen: number }
  | { ok: false; reason: string };

/** Who takes the money off the invoice: the refund voucher, or the converted
    payment row that moved it to another order (docs/bugs/0927). */
export type DepositTaker =
  | { kind: 'refund'; pvId: string; pvNumber: string }
  | { kind: 'convert'; paymentId: string; toDocNo: string };

export type TakeInput = {
  companyId: number;
  /** The day the notes are dated with — the voucher's day, or the day of the move. */
  noteDate: string;
  soDocNo: string;
  amountSen: number;
  actor: string | null;
  taker: DepositTaker;
};

const takerOf = (n: RefundNote, t: DepositTaker): boolean =>
  t.kind === 'refund' ? n.refundPvId === t.pvId : n.convertedPaymentId === t.paymentId;

/**
 * The notes for one posted refund voucher: oldest deposit invoice first, each
 * for what still stands on it, until the refund is covered. Idempotent on
 * (voucher, invoice). `uncoveredSen` is the part of the refund no deposit
 * invoice answers for.
 */
export async function refundDepositInvoices(sb: Db, p: RefundInput): Promise<RefundResult> {
  return takeFromDepositInvoices(sb, {
    companyId: p.companyId, noteDate: p.voucherDate, soDocNo: p.soDocNo, amountSen: p.amountSen, actor: p.actor,
    taker: { kind: 'refund', pvId: p.pvId, pvNumber: p.pvNumber },
  });
}

/**
 * The notes that take an amount off an order's deposit invoices — for a
 * refund voucher or for a conversion: oldest invoice first, each for what
 * still stands on it, until the amount is covered. Idempotent on (taker,
 * invoice). `uncoveredSen` is the part no deposit invoice answers for.
 */
export async function takeFromDepositInvoices(sb: Db, p: TakeInput): Promise<RefundResult> {
  const amount = Number(p.amountSen);
  if (!Number.isInteger(amount) || amount <= 0) return { ok: true, raised: [], uncoveredSen: 0 };
  const { data, error } = await sb.from('acc_deposit_invoices')
    .select(DI_FIELDS)
    .eq('company_id', p.companyId).eq('so_doc_no', p.soDocNo).neq('status', 'CANCELLED')
    .order('invoice_date').order('di_number');
  if (error) return { ok: false, reason: `deposit invoices: ${error.message}` };
  const invoices = (data ?? []) as DiRow[];
  if (invoices.length === 0) return { ok: true, raised: [], uncoveredSen: amount };

  const taken = await refundedByInvoice(sb, p.companyId, invoices.map((d) => d.di_number));
  if (!taken.ok) return taken;
  /* This taker's own notes — the retry finds them rather than raising beside. */
  const mine = new Map<string, RefundNote>();
  for (const list of taken.notes.values()) for (const n of list) if (takerOf(n, p.taker)) mine.set(n.diNumber, n);
  const label = p.taker.kind === 'refund' ? `Refund ${p.taker.pvNumber}` : `Moved to ${p.taker.toDocNo}`;

  const code = await companyCodeById(sb, p.companyId);
  if (!code) return { ok: false, reason: `company ${p.companyId} has no code to number under` };
  const roles = await resolveRoles(sb, p.companyId);

  const raised: RaisedRefundNote[] = [];
  let left = amount;
  for (const di of invoices) {
    if (left <= 0) break;
    const own = mine.get(di.di_number) ?? null;
    /* Closed by another paper — the final invoice's note, or another refund's
       — so nothing stands on it to refund. */
    if (di.credit_note_id && (!own || own.id !== di.credit_note_id)) continue;
    const byOthers = (taken.sen.get(di.di_number) ?? 0) - (own?.totalSen ?? 0);
    const remaining = Number(di.amount_sen) - byOthers;
    if (remaining <= 0) continue;
    const part = own ? own.totalSen : Math.min(remaining, left);
    if (part <= 0) continue;

    let note: Row | null = null;
    if (own) {
      const { data: found, error: fErr } = await sb.from('acc_credit_notes')
        .select(CREDIT_NOTE_HEADER).eq('company_id', p.companyId).eq('id', own.id).maybeSingle();
      if (fErr) return { ok: false, reason: `note ${own.noteNumber}: ${fErr.message}` };
      note = (found as Row | null) ?? null;
    }
    if (!note) {
      const ins = await insertCreditNote(sb, {
        companyId: p.companyId,
        docPrefix: docPrefixForCode(code),
        kind: 'CN',
        party: { code: di.party_code, name: di.party_name },
        soDocNo: di.so_doc_no,
        sourceDocNo: di.di_number,
        refundPvId: p.taker.kind === 'refund' ? p.taker.pvId : null,
        convertedPaymentId: p.taker.kind === 'convert' ? p.taker.paymentId : null,
        noteDate: p.noteDate,
        reason: `${label} — ${part >= remaining ? 'closes' : 'part of'} deposit invoice ${di.di_number}`,
        lines: [{ description: `${label} against deposit invoice ${di.di_number}`, code: roles.DEPOSIT_INCOME, amountSen: part }],
        createdBy: p.actor,
      });
      if (!ins.ok) return { ok: false, reason: `${di.di_number}: note not raised: ${ins.reason}` };
      note = ins.note;
    }
    const posted = await postCreditNote(sb, { companyId: p.companyId, note, actor: p.actor });
    if (!posted.ok) log(`${label}: ${String(note.note_number)} raised for ${di.di_number} but not posted:`, posted.status, posted.reason);
    /* Refunded in full: the note closes the invoice, the way the final
       invoice's note would have. The link is written even when the posting
       was refused, so the note is found (and posted from the notes page)
       rather than raised a second time. */
    const closed = part >= remaining;
    if (closed && di.credit_note_id !== note.id) {
      const { error: linkErr } = await sb.from('acc_deposit_invoices')
        .update({ credit_note_id: note.id }).eq('company_id', p.companyId).eq('id', di.id);
      if (linkErr) return { ok: false, reason: `${di.di_number}: link: ${linkErr.message}` };
    }
    raised.push({ diNumber: di.di_number, noteNumber: String(note.note_number), sen: part, jeNo: posted.ok ? posted.jeNo : null, closed });
    left -= part;
  }
  return { ok: true, raised, uncoveredSen: Math.max(0, left) };
}

/**
 * When the refund voucher is CANCELLED: every note it raised is cancelled by
 * contra (dated the day of the cancel) and the invoices it closed stand
 * again. A note with no voucher id — the close-out's, or Finance's own — is
 * not this voucher's and stays.
 */
export async function releaseRefundNotes(
  sb: Db, p: { companyId: number; pvId: string; actor: string | null; entryDate?: string },
): Promise<{ ok: true; released: string[] } | { ok: false; reason: string }> {
  return releaseTakerNotes(sb, { companyId: p.companyId, actor: p.actor, entryDate: p.entryDate, taker: { kind: 'refund', pvId: p.pvId, pvNumber: '' } });
}

/** When a converted row is deleted (the money moved back; docs/bugs/0927):
    the notes its move raised are cancelled by contra and the invoices stand again. */
export async function releaseConversionNotes(
  sb: Db, p: { companyId: number; paymentId: string; actor: string | null; entryDate?: string },
): Promise<{ ok: true; released: string[] } | { ok: false; reason: string }> {
  return releaseTakerNotes(sb, { companyId: p.companyId, actor: p.actor, entryDate: p.entryDate, taker: { kind: 'convert', paymentId: p.paymentId, toDocNo: '' } });
}

async function releaseTakerNotes(
  sb: Db, p: { companyId: number; actor: string | null; entryDate?: string; taker: DepositTaker },
): Promise<{ ok: true; released: string[] } | { ok: false; reason: string }> {
  let q = sb.from('acc_credit_notes').select(CREDIT_NOTE_HEADER).eq('company_id', p.companyId).neq('status', 'CANCELLED');
  q = p.taker.kind === 'refund' ? q.eq('refund_pv_id', p.taker.pvId) : q.eq('converted_payment_id', p.taker.paymentId);
  const { data, error } = await q;
  if (error) return { ok: false, reason: `refund notes: ${error.message}` };
  const released: string[] = [];
  for (const note of (data ?? []) as Row[]) {
    const c = await cancelCreditNote(sb, { companyId: p.companyId, note, actor: p.actor, ...(p.entryDate ? { entryDate: p.entryDate } : {}) });
    if (!c.ok) return { ok: false, reason: `${String(note.note_number)}: ${c.reason}` };
    const { error: unlinkErr } = await sb.from('acc_deposit_invoices')
      .update({ credit_note_id: null }).eq('company_id', p.companyId).eq('credit_note_id', note.id);
    if (unlinkErr) return { ok: false, reason: `unlink ${String(note.note_number)}: ${unlinkErr.message}` };
    released.push(String(note.note_number));
  }
  return { ok: true, released };
}

/* ── The hooks the voucher route calls (best-effort, never throw) ─────────── */

/** After a refund voucher posts. `null` means there is nothing to credit —
    an invoice refund, no document, no company — and is silent. */
export async function refundDepositInvoicesBestEffort(sb: Db, p: RefundInput | null): Promise<void> {
  if (!p) return;
  try {
    const r = await refundDepositInvoices(sb, p);
    if (!r.ok) log(`refund ${p.pvNumber}: deposit invoices not credited —`, r.reason);
    else if (r.uncoveredSen > 0 && r.raised.length > 0) log(`refund ${p.pvNumber}: ${fmtSen(r.uncoveredSen)} beyond the deposit invoices — the refund's own Dr AR answers it.`);
  } catch (e) {
    log(`refund ${p.pvNumber}: hook threw:`, e);
  }
}

/** After a refund voucher is cancelled. */
export async function releaseRefundNotesBestEffort(
  sb: Db, p: { companyId: number | null; pvId: string; pvNumber: string; actor: string | null },
): Promise<void> {
  if (p.companyId == null) return;
  try {
    const r = await releaseRefundNotes(sb, { companyId: p.companyId, pvId: p.pvId, actor: p.actor });
    if (!r.ok) log(`cancel ${p.pvNumber}: refund notes not released —`, r.reason);
  } catch (e) {
    log(`cancel ${p.pvNumber}: hook threw:`, e);
  }
}
