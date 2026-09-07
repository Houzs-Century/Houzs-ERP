// ----------------------------------------------------------------------------
// acc/receipts — Official Receipts (GL redesign item 9, owner 2026-09-05).
//
// One receipt per customer payment, born the moment the payment is recorded:
//   DRAFT   printable with a DRAFT stamp, numbered on the draft series
//           ({co}DraftOR-YYMM-NNN) — the salesperson can hand something over;
//   FORMAL  the moment the money is CONFIRMED — which mints the channel
//           number: cash {co}COR-YYMM-NNN immediately (钱当场在手), card when
//           merchant recon confirms that payment, transfer by a manual
//           confirm; ANY draft can be formalised by hand after a human
//           verified the money (客户催收据).
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

import { docMonthTag, mintMonthlyDocNo } from '../scm/lib/doc-no';
import { docPrefixForCode } from '../scm/lib/companyScope';
import { resolveRoles } from './rules';

export const CASH_SERIES_LETTER = 'C';

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
  const { data: existing, error: exErr } = await sb.from('acc_receipts')
    .select('id, or_number, status')
    .eq('payment_source', p.source).eq('payment_id', p.paymentId).maybeSingle();
  if (exErr) return { ok: false, reason: exErr.message };
  if (existing) {
    const cur = existing as { id: number; or_number: string; status: string };
    return { ok: true, id: cur.id, orNumber: cur.or_number, status: cur.status };
  }

  const prefix = docPrefixForCode(p.companyCode);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const draftNo = await mintMonthlyDocNo(sb, 'acc_receipts', 'or_number', `${prefix}DraftOR-${docMonthTag(p.paidAt)}`);
    const { data, error } = await sb.from('acc_receipts').insert({
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
      const { data: again, error: againErr } = await sb.from('acc_receipts')
        .select('id, or_number, status').eq('payment_source', p.source).eq('payment_id', p.paymentId).maybeSingle();
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
  const { data: rRaw, error: rErr } = await sb.from('acc_receipts')
    .select('id, or_number, status, company_id, paid_at')
    .eq('id', input.receiptId).eq('company_id', input.companyId).maybeSingle();
  if (rErr) return { ok: false, status: 'load_failed', reason: rErr.message };
  if (!rRaw) return { ok: false, status: 'not_found', reason: `receipt ${input.receiptId} not found` };
  const r = rRaw as { id: number; or_number: string; status: string; paid_at: string | null };
  if (r.status === 'FORMAL') return { ok: true, orNumber: r.or_number, already: true };

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
    const formalNo = await mintMonthlyDocNo(sb, 'acc_receipts', 'or_number', `${prefix}${ch.letter}OR-${docMonthTag(r.paid_at)}`, digits);
    const { error } = await sb.from('acc_receipts').update({
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
): Promise<{ ok: true; id: number; orNumber: string; status: string } | { ok: false; reason: string }> {
  const { data: existing, error: exErr } = await sb.from('acc_receipts')
    .select('id, or_number, status')
    .eq('payment_source', source).eq('payment_id', paymentId).maybeSingle();
  if (exErr) return { ok: false, reason: exErr.message };
  if (existing) {
    const cur = existing as { id: number; or_number: string; status: string };
    return { ok: true, id: cur.id, orNumber: cur.or_number, status: cur.status };
  }

  const table = source === 'SOPAY' ? 'mfg_sales_order_payments' : 'sales_invoice_payments';
  const cols = source === 'SOPAY'
    ? 'id, so_doc_no, paid_at, method, amount_sen, company_id, created_by'
    : 'id, sales_invoice_id, paid_at, method, amount_sen, company_id, created_by';
  const { data: payRaw, error: payErr } = await sb.from(table).select(cols).eq('id', paymentId).maybeSingle();
  if (payErr) return { ok: false, reason: payErr.message };
  if (!payRaw) return { ok: false, reason: `payment ${source}:${paymentId} not found` };
  const pay = payRaw as Record<string, unknown>;
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
    const { data, error } = await sb.from('acc_receipts')
      .select('id, status')
      .eq('payment_source', p.source).eq('payment_id', p.id).maybeSingle();
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
