// ----------------------------------------------------------------------------
// acc/receipts — Official Receipts (GL redesign item 9, owner 2026-09-05).
//
// One receipt per customer payment, born the moment the payment is recorded
// — rows of scm.acc_official_receipts (its OWN table since docs/bugs/0658:
// the first migration named it acc_receipts, the general money-in receipt's
// table, and so built nothing):
//   DRAFT   printable with a DRAFT stamp, numbered on the draft series
//           ({co}DraftOR-YYMM-NNN) — the salesperson can hand something over;
//   FORMAL  the moment the money is CONFIRMED — which mints the channel
//           number: cash {co}COR-YYMM-NNN immediately (钱当场在手), card when
//           merchant recon confirms that payment, transfer by a manual
//           confirm; ANY draft can be formalised by hand after a human
//           verified the money (客户催收据).
//   CANCELLED a formal receipt whose payment changed or was removed (owner
//           2026-10-29: 收据跟着付款改或作废). Kept on file, its number never
//           reused; the payment's live receipt is a new row. A DRAFT is never
//           cancelled — it follows its payment, or goes with it.
//
// The channel letters are the PV letter table (scm.acc_bank_letters) — the
// same bank is the same letter on a voucher and a receipt; C is RESERVED for
// cash. Formal-number order per channel = the order money was confirmed, so
// a slow reconciliation never scrambles the cash run (the owner's exact
// worry: 期间的 or number 都是 cash 了不是?).
//
// Everything here is BEST-EFFORT from the payment flows' point of view: a
// receipt that fails to create must never un-record a payment (the money
// happened), so callers log and carry on — and ensureReceiptForPayment heals
// any gap the next time the receipt is needed.
// ----------------------------------------------------------------------------

import { companyCodeById, docMonthTag, mintMonthlyDocNo } from '../scm/lib/doc-no';
import { docPrefixForCode } from '../scm/lib/companyScope';
import { fmtSen } from '../scm/shared/format';
import { resolveRoles } from './rules';

export const CASH_SERIES_LETTER = 'C';
/** A receipt kept on file but no longer the payment's — see the header. Every
    read of "the receipt of a payment" leaves these out; the one-per-payment key
    covers the others only (migration 20261029T1500). */
export const CANCELLED = 'CANCELLED';

export type ReceiptPaymentInput = {
  source: 'SOPAY' | 'SIPAY';
  paymentId: string;
  companyId: number;
  companyCode: string;
  docNo: string | null;
  customerName?: string | null;
  method: string;
  amountSen: number;
  paidAt: string | null;
  createdBy?: string | null;
};

async function digitsOf(sb: any, companyId: number): Promise<number> {
  const { data, error } = await sb.from('acc_numbering').select('doc_digits').eq('company_id', companyId).maybeSingle();
  /* Width is cosmetic (the parser reads any length) — a blip here must not
     block a money confirmation, so the default width answers, out loud. */
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[receipts] width read failed, defaulting to 3:', error.message);
    return 3;
  }
  return Number((data as { doc_digits?: number } | null)?.doc_digits ?? 3);
}

/** The channel letter for a money account: C for the company's CASH role,
    else the bank's own letter from the PV table. Null = not configured yet. */
export async function channelLetterFor(
  sb: any,
  companyId: number,
  accountCode: string,
): Promise<{ ok: true; letter: string | null } | { ok: false; reason: string }> {
  const roles = await resolveRoles(sb, companyId);
  if (accountCode === roles.CASH) return { ok: true, letter: CASH_SERIES_LETTER };
  const { data, error } = await sb.from('acc_bank_letters')
    .select('letter').eq('company_id', companyId).eq('account_code', accountCode).maybeSingle();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, letter: (data as { letter?: string } | null)?.letter ?? null };
}

/**
 * Create the DRAFT receipt for one recorded payment — idempotent on the
 * payment key (a retry or a second caller finds the existing row). A CASH
 * payment is formalised in the same breath: the drawer is its own proof.
 */
export async function createReceiptForPayment(
  sb: any,
  p: ReceiptPaymentInput,
): Promise<{ ok: true; id: number; orNumber: string; status: string } | { ok: false; reason: string }> {
  const { data: existing, error: exErr } = await sb.from('acc_official_receipts')
    .select('id, or_number, status')
    .eq('payment_source', p.source).eq('payment_id', p.paymentId).neq('status', CANCELLED).maybeSingle();
  if (exErr) return { ok: false, reason: exErr.message };
  if (existing) {
    const cur = existing as { id: number; or_number: string; status: string };
    return { ok: true, id: cur.id, orNumber: cur.or_number, status: cur.status };
  }

  const prefix = docPrefixForCode(p.companyCode);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const draftNo = await mintMonthlyDocNo(sb, 'acc_official_receipts', 'or_number', `${prefix}DraftOR-${docMonthTag(p.paidAt)}`);
    const { data, error } = await sb.from('acc_official_receipts').insert({
      company_id: p.companyId,
      or_number: draftNo,
      status: 'DRAFT',
      payment_source: p.source,
      payment_id: p.paymentId,
      doc_no: p.docNo,
      customer_name: p.customerName ?? null,
      method: p.method,
      amount_sen: p.amountSen,
      paid_at: p.paidAt,
      created_by: p.createdBy ?? null,
    }).select('id').single();
    if (!error) {
      const id = Number((data as { id: number }).id);
      if (p.method === 'cash') {
        const roles = await resolveRoles(sb, p.companyId);
        const f = await formaliseReceipt(sb, {
          companyId: p.companyId, companyCode: p.companyCode, receiptId: id,
          accountCode: roles.CASH, actor: p.createdBy ?? null,
        });
        if (f.ok) return { ok: true, id, orNumber: f.orNumber, status: 'FORMAL' };
        /* The cash formalisation failing must not lose the receipt — it stays
           a draft the manual button can finish. */
        return { ok: true, id, orNumber: draftNo, status: 'DRAFT' };
      }
      return { ok: true, id, orNumber: draftNo, status: 'DRAFT' };
    }
    const dupPayment = /payment_source|payment_id/.test(String(error.message ?? '')) && /duplicate key/i.test(String(error.message ?? ''));
    if (dupPayment) {
      const { data: again, error: againErr } = await sb.from('acc_official_receipts')
        .select('id, or_number, status').eq('payment_source', p.source).eq('payment_id', p.paymentId).neq('status', CANCELLED).maybeSingle();
      if (againErr) return { ok: false, reason: `receipt exists but could not be read back: ${againErr.message}` };
      if (again) {
        const cur = again as { id: number; or_number: string; status: string };
        return { ok: true, id: cur.id, orNumber: cur.or_number, status: cur.status };
      }
    }
    const numberClash = String(error.code ?? '') === '23505' || /duplicate key/i.test(String(error.message ?? ''));
    if (!numberClash) return { ok: false, reason: error.message };
  }
  return { ok: false, reason: 'could not mint a draft receipt number after 8 attempts' };
}

/**
 * Turn one DRAFT receipt FORMAL: mint the channel number from the money
 * account's letter (C = cash) and stamp who confirmed the money. Idempotent —
 * an already-formal receipt echoes itself.
 */
export async function formaliseReceipt(
  sb: any,
  input: { companyId: number; companyCode: string; receiptId: number; accountCode: string; actor: string | null },
): Promise<{ ok: true; orNumber: string; already?: boolean } | { ok: false; status: string; reason: string }> {
  const { data: rRaw, error: rErr } = await sb.from('acc_official_receipts')
    .select('id, or_number, status, company_id, paid_at')
    .eq('id', input.receiptId).eq('company_id', input.companyId).maybeSingle();
  if (rErr) return { ok: false, status: 'load_failed', reason: rErr.message };
  if (!rRaw) return { ok: false, status: 'not_found', reason: `receipt ${input.receiptId} not found` };
  const r = rRaw as { id: number; or_number: string; status: string; paid_at: string | null };
  if (r.status === 'FORMAL') return { ok: true, orNumber: r.or_number, already: true };
  if (r.status === CANCELLED) {
    return { ok: false, status: 'cancelled', reason: `${r.or_number} was cancelled — its payment changed or was removed. Confirm the payment's current receipt instead.` };
  }

  const ch = await channelLetterFor(sb, input.companyId, input.accountCode);
  if (!ch.ok) return { ok: false, status: 'load_failed', reason: ch.reason };
  if (!ch.letter) {
    return {
      ok: false,
      status: 'bank_letter_missing',
      reason: `${input.accountCode} has no series letter yet — set one on the Voucher numbering card (Reconciliation setup), then confirm again.`,
    };
  }

  const digits = await digitsOf(sb, input.companyId);
  const prefix = docPrefixForCode(input.companyCode);
  const at = new Date().toISOString();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const formalNo = await mintMonthlyDocNo(sb, 'acc_official_receipts', 'or_number', `${prefix}${ch.letter}OR-${docMonthTag(r.paid_at)}`, digits);
    const { error } = await sb.from('acc_official_receipts').update({
      or_number: formalNo,
      status: 'FORMAL',
      channel_account_code: input.accountCode,
      issued_at: at,
      issued_by: input.actor,
    }).eq('id', r.id);
    if (!error) return { ok: true, orNumber: formalNo };
    const clash = String(error.code ?? '') === '23505' || /duplicate key/i.test(String(error.message ?? ''));
    if (!clash) return { ok: false, status: 'save_failed', reason: error.message };
  }
  return { ok: false, status: 'save_failed', reason: 'could not mint a formal receipt number after 8 attempts' };
}

/**
 * Find-or-create the receipt for a payment that exists in the ledgered
 * tables — the healing path for rows recorded before this module, or through
 * a writer that has no hook. Reads the payment row itself, so a caller needs
 * only the key.
 */
export async function ensureReceiptForPayment(
  sb: any,
  source: 'SOPAY' | 'SIPAY',
  paymentId: string,
  /* The caller's active company: a payment id from another company's books is
     refused before anything is written. null only for a caller that has
     already scoped the payment itself. */
  activeCompanyId: number | null,
): Promise<{ ok: true; id: number; orNumber: string; status: string } | { ok: false; reason: string }> {
  let existingQuery = sb.from('acc_official_receipts')
    .select('id, or_number, status')
    .eq('payment_source', source).eq('payment_id', paymentId).neq('status', CANCELLED);
  if (activeCompanyId !== null) existingQuery = existingQuery.eq('company_id', activeCompanyId);
  const { data: existing, error: exErr } = await existingQuery.maybeSingle();
  if (exErr) return { ok: false, reason: exErr.message };
  if (existing) {
    const cur = existing as { id: number; or_number: string; status: string };
    return { ok: true, id: cur.id, orNumber: cur.or_number, status: cur.status };
  }

  const table = source === 'SOPAY' ? 'mfg_sales_order_payments' : 'sales_invoice_payments';
  const cols = source === 'SOPAY'
    ? 'id, so_doc_no, paid_at, method, amount_sen, company_id, created_by'
    : 'id, sales_invoice_id, paid_at, method, amount_sen, company_id, created_by';
  let paymentQuery = sb.from(table).select(cols).eq('id', paymentId);
  if (activeCompanyId !== null) paymentQuery = paymentQuery.eq('company_id', activeCompanyId);
  const { data: payRaw, error: payErr } = await paymentQuery.maybeSingle();
  if (payErr) return { ok: false, reason: payErr.message };
  if (!payRaw) return { ok: false, reason: `payment ${source}:${paymentId} not found` };
  const pay = payRaw as Record<string, unknown>;
  /* Money moved from a cancelled order (docs/bugs/0927) was receipted when it
     was received; the moved row gets no receipt of its own. */
  if (String(pay.method ?? '') === 'converted') return { ok: false, reason: `payment ${source}:${paymentId} is money moved from a cancelled order — its receipt is on that order` };
  const companyId = Number(pay.company_id ?? 0);
  if (!companyId) return { ok: false, reason: `payment ${source}:${paymentId} carries no company` };

  const { data: coRaw, error: coErr } = await sb.schema('public').from('companies')
    .select('code').eq('id', companyId).maybeSingle();
  if (coErr) return { ok: false, reason: coErr.message };
  const companyCode = String((coRaw as { code?: string } | null)?.code ?? '');
  if (!companyCode) return { ok: false, reason: `company ${companyId} has no code` };

  return createReceiptForPayment(sb, {
    source,
    paymentId,
    companyId,
    companyCode,
    docNo: source === 'SOPAY' ? String(pay.so_doc_no ?? '') || null : String(pay.sales_invoice_id ?? '') || null,
    method: String(pay.method ?? ''),
    amountSen: Number(pay.amount_sen ?? 0),
    paidAt: String(pay.paid_at ?? '').slice(0, 10) || null,
    createdBy: (pay.created_by as string | null) ?? null,
  });
}

/* ── The receipt follows its payment (owner 2026-10-29: 收据跟着付款改或作废) ──
   2990's October check found RM 3,359 of receipts saying what their payments no
   longer said — a card payment corrected from RM 1,115 to RM 558 two minutes
   after keying, a cash payment deleted a minute after keying, a transfer
   re-dated from 13/10 to 08/09 — because nothing ever touched a receipt after
   its birth. The deposit invoice's rule, applied to the paper the customer
   holds: a DRAFT follows (nobody holds a confirmed one), a FORMAL receipt is
   cancelled and re-issued, never rewritten. */

/** What a receipt prints and is checked against, as the payment now stands. */
export type ReceiptFacts = { amountSen: number; paidAt: string | null; method: string };

/** What following a payment did to its receipt, for the payment's audit row:
    `draft` names a draft removed with its payment; otherwise `from` is the
    formal receipt cancelled and `to` its replacement (null when the payment
    went). Null when the receipt was left as it was, or followed in place. */
export type ReceiptTouch = { from: string; to: string | null; draft: boolean };

type LiveReceipt = {
  id: number; or_number: string; status: string; payment_source: string; payment_id: string; amount_sen: number;
  paid_at: string | null; method: string | null; channel_account_code: string | null; doc_no: string | null; customer_name: string | null;
};

const dayOf = (v: unknown): string => String(v ?? '').slice(0, 10);

async function liveReceiptOf(
  sb: any, companyId: number | null, source: 'SOPAY' | 'SIPAY', paymentId: string,
): Promise<{ ok: true; row: LiveReceipt | null } | { ok: false; reason: string }> {
  let q = sb.from('acc_official_receipts')
    .select('id, or_number, status, payment_source, payment_id, amount_sen, paid_at, method, channel_account_code, doc_no, customer_name')
    .eq('payment_source', source).eq('payment_id', paymentId).neq('status', CANCELLED);
  if (companyId !== null) q = q.eq('company_id', companyId);
  const { data, error } = await q.maybeSingle();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, row: (data as LiveReceipt | null) ?? null };
}

/** The receipt's words for what moved — empty when it already says what the
    payment says. */
export function receiptChange(was: { amount_sen: number; paid_at: string | null; method: string | null }, next: ReceiptFacts): string {
  const parts: string[] = [];
  if (Number(was.amount_sen) !== Number(next.amountSen)) parts.push(`amount ${fmtSen(Number(was.amount_sen))} → ${fmtSen(next.amountSen)}`);
  if (dayOf(was.paid_at) !== dayOf(next.paidAt)) parts.push(`date ${dayOf(was.paid_at) || '—'} → ${dayOf(next.paidAt) || '—'}`);
  if ((was.method ?? '') !== (next.method ?? '')) parts.push(`method ${was.method || '—'} → ${next.method || '—'}`);
  return parts.join(', ');
}

/** The one receipt row `r` names, by its id AND its payment — a write that
    must never reach another payment's paper. */
const theReceipt = (q: any, r: LiveReceipt, companyId: number | null): any => {
  const out = q.eq('id', r.id).eq('payment_source', r.payment_source).eq('payment_id', r.payment_id);
  return companyId !== null ? out.eq('company_id', companyId) : out;
};

/** Cancel one FORMAL receipt — only while it is still formal, so two callers
    cannot both cancel it and both issue a replacement. */
async function cancelFormal(
  sb: any, companyId: number | null, r: LiveReceipt, reason: string, actor: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data, error } = await theReceipt(sb.from('acc_official_receipts')
    .update({ status: CANCELLED, cancelled_at: new Date().toISOString(), cancelled_by: actor, cancel_reason: reason }), r, companyId)
    .eq('status', 'FORMAL').select('id').maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!data) return { ok: false, reason: `${r.or_number} changed while it was being cancelled` };
  return { ok: true };
}

/**
 * After a payment is EDITED. A DRAFT is rewritten in place — its number stays,
 * the number is an id, not a date (单据存了后改日期号码不要重发). A FORMAL receipt
 * is in the customer's hand: when its AMOUNT or DAY moved it is CANCELLED, with
 * what moved as its reason, and the payment gets a new receipt — formal at once
 * on the cancelled one's channel when the method is unchanged (the money was
 * confirmed there already), otherwise born as any payment's receipt is: cash
 * formal, the rest a draft to confirm. A method re-filed alone leaves a formal
 * receipt standing. Nothing happens when the receipt already says what the
 * payment says, or when the payment has none (ensure heals that at the next print).
 */
export async function followPaymentEdit(
  sb: any,
  p: { source: 'SOPAY' | 'SIPAY'; paymentId: string; companyId: number; next: ReceiptFacts; why: string; actor: string | null },
): Promise<{ ok: true; touch: ReceiptTouch | null } | { ok: false; reason: string }> {
  const cur = await liveReceiptOf(sb, p.companyId, p.source, p.paymentId);
  if (!cur.ok) return cur;
  const r = cur.row;
  if (!r) return { ok: true, touch: null };
  const change = receiptChange(r, p.next);
  if (!change) return { ok: true, touch: null };

  if (r.status !== 'FORMAL') {
    const { error } = await theReceipt(sb.from('acc_official_receipts')
      .update({ amount_sen: p.next.amountSen, paid_at: p.next.paidAt, method: p.next.method }), r, p.companyId)
      .eq('status', 'DRAFT');
    if (error) return { ok: false, reason: error.message };
    return { ok: true, touch: null };
  }
  /* A formal receipt is re-issued for the money it states — a new amount or a
     new day (the owner's words: 按付款的新金额或新日期开一张新收据). A method
     re-filed alone (a card payment's provider or method corrected) leaves it
     standing: the same money on the same day. */
  if (!receiptChange(r, { ...p.next, method: r.method ?? '' })) return { ok: true, touch: null };

  let companyCode: string | null;
  try { companyCode = await companyCodeById(sb, p.companyId); } catch (e) { return { ok: false, reason: String((e as Error).message ?? e) }; }
  if (!companyCode) return { ok: false, reason: `company ${p.companyId} has no code` };

  const gone = await cancelFormal(sb, p.companyId, r, `${p.why}: ${change}`, p.actor);
  if (!gone.ok) return gone;
  const made = await createReceiptForPayment(sb, {
    source: p.source, paymentId: p.paymentId, companyId: p.companyId, companyCode,
    docNo: r.doc_no, customerName: r.customer_name, method: p.next.method,
    amountSen: p.next.amountSen, paidAt: p.next.paidAt, createdBy: p.actor,
  });
  if (!made.ok) return { ok: false, reason: `${r.or_number} cancelled, but its replacement was not issued: ${made.reason}` };
  let to = made.orNumber;
  if (made.status !== 'FORMAL' && (r.method ?? '') === (p.next.method ?? '') && r.channel_account_code) {
    const f = await formaliseReceipt(sb, {
      companyId: p.companyId, companyCode, receiptId: made.id, accountCode: r.channel_account_code, actor: p.actor,
    });
    if (f.ok) to = f.orNumber;
    // eslint-disable-next-line no-console
    else console.error(`[receipts] ${made.orNumber} replaces ${r.or_number} but stays a draft:`, f.status, f.reason);
  }
  const { error: linkErr } = await theReceipt(sb.from('acc_official_receipts').update({ replaced_by_id: made.id }), r, p.companyId);
  // eslint-disable-next-line no-console
  if (linkErr) console.error(`[receipts] ${r.or_number} not linked to its replacement ${to}:`, linkErr.message);
  return { ok: true, touch: { from: r.or_number, to, draft: false } };
}

/**
 * After a payment is DELETED its receipt goes with it, whatever the order's
 * state: a DRAFT is removed (it was never a confirmed paper — the cancelled-
 * order removal of 2026-09-29 did only this, now every delete does), a FORMAL
 * one is CANCELLED and kept.
 */
export async function followPaymentRemoval(
  sb: any,
  p: { source: 'SOPAY' | 'SIPAY'; paymentId: string; companyId: number | null; why: string; actor: string | null },
): Promise<{ ok: true; touch: ReceiptTouch | null } | { ok: false; reason: string }> {
  const cur = await liveReceiptOf(sb, p.companyId, p.source, p.paymentId);
  if (!cur.ok) return cur;
  const r = cur.row;
  if (!r) return { ok: true, touch: null };
  if (r.status !== 'FORMAL') {
    const { error } = await theReceipt(sb.from('acc_official_receipts').delete(), r, p.companyId).eq('status', 'DRAFT');
    if (error) return { ok: false, reason: error.message };
    return { ok: true, touch: { from: r.or_number, to: null, draft: true } };
  }
  const gone = await cancelFormal(sb, p.companyId, r, p.why, p.actor);
  if (!gone.ok) return gone;
  return { ok: true, touch: { from: r.or_number, to: null, draft: false } };
}

/**
 * Card money confirmed by merchant reconciliation → the payments' receipts
 * turn FORMAL on the acquirer's payout bank. BEST-EFFORT by design: the
 * settlement confirm must never fail over a receipt (the fee entry is the
 * money truth); a missing letter or absent receipt is reported, not thrown.
 */
export async function formaliseReceiptsForSettlement(
  sb: any,
  companyId: number,
  companyCode: string,
  payments: Array<{ source: string; id: string }>,
  bankAccountCode: string | null,
  actor: string | null,
): Promise<Array<{ paymentId: string; outcome: string }>> {
  const out: Array<{ paymentId: string; outcome: string }> = [];
  if (!bankAccountCode) return payments.map((p) => ({ paymentId: p.id, outcome: 'no_bank_configured' }));
  for (const p of payments) {
    const { data, error } = await sb.from('acc_official_receipts')
      .select('id, status')
      .eq('payment_source', p.source).eq('payment_id', p.id).neq('status', CANCELLED).maybeSingle();
    /* A blip is NOT "no receipt" — reported as its own outcome so the sweep's
       answer never lies about what it saw. */
    if (error) { out.push({ paymentId: p.id, outcome: 'read_failed' }); continue; }
    const r = data as { id: number; status: string } | null;
    if (!r) { out.push({ paymentId: p.id, outcome: 'no_receipt' }); continue; }
    if (r.status === 'FORMAL') { out.push({ paymentId: p.id, outcome: 'already_formal' }); continue; }
    const f = await formaliseReceipt(sb, { companyId, companyCode, receiptId: r.id, accountCode: bankAccountCode, actor });
    out.push({ paymentId: p.id, outcome: f.ok ? 'formalised' : f.status });
  }
  return out;
}
