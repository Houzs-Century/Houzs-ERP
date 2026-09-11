// ----------------------------------------------------------------------------
// Deposit invoices (owner 2026-09-12; docs/bugs/0828).
//
// WHY. 为什么我想要 deposit 开 invoice：因为 e-invoice 好像是根据收钱就认
// sales 了 … 每个顾客不是有自己本身的 account code 吗？ — money received is
// a sale the day it is received, and the customer's own code is the debit
// side, not a deposit liability. So: ONE DEPOSIT INVOICE per customer payment
// received before the order's final sales invoice exists,
//     Dr AR (party = the customer's code)  /  Cr DEPOSIT PAY BY CUSTOMER
// (role DEPOSIT_INCOME, 509-0000, a sales account). The payment itself has
// already booked Dr money / Cr AR, so the customer's sub-ledger nets to
// nothing and the deposit stands as a sale. At the final invoice the design
// raises one credit note per deposit invoice (credit_note_id is the link);
// a payment made AFTER the final invoice settles that invoice and gets no
// deposit invoice.
//
// THE SWITCH is per company with a start date (scm.acc_company_settings):
// off everywhere until Finance turns it on; a payment dated before the start
// is left alone. 2990 first; HOUZS later (owner: houzs 那边往后也是需要，只是
// 暂时先关闭).
//
// WHERE IT FIRES. so-payment-row's bookSoPaymentBestEffort — the one hook
// every payment birth passes (the panel, the scan job, both SO-create deposit
// inserts); the edit re-post cancels and re-issues; the delete cancels.
// Everything here is best-effort at the hook: the money is recorded first,
// and issue-missing (the page's button) heals any invoice a hiccup skipped.
//
// NUMBERING: {co}-DI-YYMM-NNN — a NEW series (flagged to the owner
// 2026-09-12, 可以). An edited payment's invoice is CANCELLED by contra and
// the next number issued, never rewritten — the way an e-invoice is
// cancelled and re-issued.
// ----------------------------------------------------------------------------

import { postJournal, reverseJournal } from './engine';
import { depositInvoiceLines, resolveRoles } from './rules';
import { customerPartyCode } from './payments';
import { companyCodeById, docMonthTag, mintMonthlyDocNo } from '../scm/lib/doc-no';
import { docPrefixForCode } from '../scm/lib/companyScope';
import { absorbsOrderDeposit } from '../scm/lib/si-order-deposit';
import { todayMyt } from '../scm/lib/my-time';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;

export const DI_COLS = 'id, company_id, di_number, payment_source, payment_id, so_doc_no, party_code, party_name, invoice_date, amount_sen, method, status, je_no, credit_note_id, cancel_reason, created_at, created_by, cancelled_at, cancelled_by';

export type DepositInvoiceSettings = { enabled: boolean; fromDate: string | null };

export type DepositInvoiceRow = {
  id: string; company_id: number; di_number: string; payment_source: string; payment_id: string; so_doc_no: string;
  party_code: string | null; party_name: string | null; invoice_date: string; amount_sen: number; method: string | null;
  status: 'ISSUED' | 'CANCELLED'; je_no: string | null; credit_note_id: string | null; cancel_reason: string | null;
  created_at: string; created_by: string | null; cancelled_at: string | null; cancelled_by: string | null;
};

/** The day of a payment — a full timestamp is accepted, only the day counts;
    anything else is no date, and a deposit invoice is never dated today by
    default (§2.5: the document date drives the reports). */
const dayOf = (paidAt: string | null | undefined): string | null => {
  const d = String(paidAt ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[acc/deposit-invoices]', ...args);
};

/* ── The switch ──────────────────────────────────────────────────────────── */

export async function loadDepositInvoiceSettings(
  sb: Db,
  companyId: number,
): Promise<{ ok: true; settings: DepositInvoiceSettings } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_company_settings')
    .select('deposit_invoice_enabled, deposit_invoice_from')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  const row = data as { deposit_invoice_enabled?: boolean | null; deposit_invoice_from?: string | null } | null;
  return {
    ok: true,
    settings: {
      enabled: row?.deposit_invoice_enabled === true,
      fromDate: dayOf(row?.deposit_invoice_from),
    },
  };
}

export async function saveDepositInvoiceSettings(
  sb: Db,
  companyId: number,
  settings: DepositInvoiceSettings,
  actor: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error } = await sb.from('acc_company_settings').upsert({
    company_id: companyId,
    deposit_invoice_enabled: settings.enabled,
    deposit_invoice_from: settings.fromDate,
    updated_at: new Date().toISOString(),
    updated_by: actor,
  }, { onConflict: 'company_id' });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

/* ── Is one due? ─────────────────────────────────────────────────────────── */

export type NotDueWhy = 'switched_off' | 'before_start' | 'no_date' | 'no_amount' | 'invoice_exists';

/** Whether a payment on this order earns a deposit invoice: the company's
    switch is on, the payment's day is on or after the start, the amount is
    money, and the order has no LIVE sales invoice yet (a draft or a
    cancelled invoice is no invoice — si-order-deposit's own reading). */
export async function depositInvoiceDue(
  sb: Db,
  p: { companyId: number; soDocNo: string; paidAt: string | null | undefined; amountSen: number },
): Promise<{ ok: true; due: true; date: string } | { ok: true; due: false; why: NotDueWhy } | { ok: false; reason: string }> {
  const amount = Number(p.amountSen);
  if (!Number.isInteger(amount) || amount <= 0) return { ok: true, due: false, why: 'no_amount' };
  const date = dayOf(p.paidAt);
  if (!date) return { ok: true, due: false, why: 'no_date' };
  const st = await loadDepositInvoiceSettings(sb, p.companyId);
  if (!st.ok) return st;
  if (!st.settings.enabled) return { ok: true, due: false, why: 'switched_off' };
  if (st.settings.fromDate && date < st.settings.fromDate) return { ok: true, due: false, why: 'before_start' };
  const { data, error } = await sb.from('sales_invoices')
    .select('id, status')
    .eq('so_doc_no', p.soDocNo)
    .eq('company_id', p.companyId);
  if (error) return { ok: false, reason: `order invoices: ${error.message}` };
  const live = ((data ?? []) as Array<{ status?: string | null }>).some((r) => absorbsOrderDeposit(r.status));
  if (live) return { ok: true, due: false, why: 'invoice_exists' };
  return { ok: true, due: true, date };
}

/* ── Issue ───────────────────────────────────────────────────────────────── */

export type IssueInput = {
  paymentId: string;
  soDocNo: string;
  paidAt: string | null | undefined;
  amountSen: number;
  method?: string | null;
  createdBy?: string | null;
};

export type IssueResult =
  | { ok: true; status: 'issued'; id: string; diNumber: string; jeNo: string | null; postProblem: string | null }
  | { ok: true; status: 'already_issued'; id: string; diNumber: string; jeNo: string | null }
  | { ok: true; status: 'not_due'; why: NotDueWhy }
  | { ok: false; status: 'read_failed' | 'so_not_found' | 'no_company' | 'insert_failed'; reason: string };

const activeFor = async (sb: Db, paymentId: string): Promise<{ row: DepositInvoiceRow | null; error: string | null }> => {
  const { data, error } = await sb.from('acc_deposit_invoices')
    .select(DI_COLS)
    .eq('payment_source', 'SOPAY')
    .eq('payment_id', paymentId)
    .neq('status', 'CANCELLED')
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data as DepositInvoiceRow | null) ?? null, error: null };
};

/**
 * Issue the deposit invoice for one recorded payment — idempotent on the
 * payment (a retry or a second caller finds the standing invoice), silent
 * when none is due. Inserts the row, then posts it; a posting refusal leaves
 * the invoice ISSUED with no journal, which the page shows and "Post" heals.
 */
export async function issueDepositInvoice(sb: Db, p: IssueInput): Promise<IssueResult> {
  const paymentId = String(p.paymentId).trim();
  const soDocNo = String(p.soDocNo).trim();
  if (!paymentId || !soDocNo) return { ok: false, status: 'read_failed', reason: 'payment id and order are required' };

  const existing = await activeFor(sb, paymentId);
  if (existing.error) return { ok: false, status: 'read_failed', reason: existing.error };
  if (existing.row) return { ok: true, status: 'already_issued', id: existing.row.id, diNumber: existing.row.di_number, jeNo: existing.row.je_no };

  /* The order carries the company and the customer — the same read the
     payment's own posting makes (acc/payments), the same party code. */
  const { data: so, error: soErr } = await sb.from('mfg_sales_orders')
    .select('company_id, debtor_name, customer_id, debtor_code')
    .eq('doc_no', soDocNo)
    .maybeSingle();
  if (soErr) return { ok: false, status: 'read_failed', reason: `order: ${soErr.message}` };
  const order = so as { company_id?: number | null; debtor_name?: string | null; customer_id?: string | null; debtor_code?: string | null } | null;
  if (!order) return { ok: false, status: 'so_not_found', reason: soDocNo };
  const companyId = order.company_id ?? null;
  if (companyId == null) return { ok: false, status: 'no_company', reason: `${soDocNo} carries no company` };

  const due = await depositInvoiceDue(sb, { companyId, soDocNo, paidAt: p.paidAt, amountSen: p.amountSen });
  if (!due.ok) return { ok: false, status: 'read_failed', reason: due.reason };
  if (!due.due) return { ok: true, status: 'not_due', why: due.why };

  const code = await companyCodeById(sb, companyId);
  if (!code) return { ok: false, status: 'no_company', reason: `company ${companyId} has no code to number under` };
  const prefix = docPrefixForCode(code);
  const partyCode = customerPartyCode(order.debtor_code, order.customer_id);
  const partyName = order.debtor_name ?? null;
  const amountSen = Number(p.amountSen);

  let inserted: { id: string; di_number: string } | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const diNumber = await mintMonthlyDocNo(sb, 'acc_deposit_invoices', 'di_number', `${prefix}DI-${docMonthTag(due.date)}`);
    const { data, error } = await sb.from('acc_deposit_invoices').insert({
      company_id: companyId,
      di_number: diNumber,
      payment_source: 'SOPAY',
      payment_id: paymentId,
      so_doc_no: soDocNo,
      party_code: partyCode,
      party_name: partyName,
      invoice_date: due.date,
      amount_sen: amountSen,
      method: p.method ?? null,
      status: 'ISSUED',
      je_no: null,
      created_by: p.createdBy ?? null,
    }).select('id, di_number').single();
    if (!error) { inserted = data as { id: string; di_number: string }; break; }
    const msg = String(error.message ?? '');
    const clash = String(error.code ?? '') === '23505' || /duplicate key/i.test(msg);
    if (!clash) return { ok: false, status: 'insert_failed', reason: msg };
    /* A clash on the PAYMENT is a concurrent birth of the same invoice: read
       it back rather than mint beside it. A clash on the number is the
       counter racing; the next loop mints again. */
    if (/payment/i.test(msg)) {
      const again = await activeFor(sb, paymentId);
      if (again.error) return { ok: false, status: 'read_failed', reason: `invoice exists but could not be read back: ${again.error}` };
      if (again.row) return { ok: true, status: 'already_issued', id: again.row.id, diNumber: again.row.di_number, jeNo: again.row.je_no };
    }
  }
  if (!inserted) return { ok: false, status: 'insert_failed', reason: 'could not mint a deposit invoice number after 8 attempts' };

  const posted = await postDepositInvoice(sb, {
    id: inserted.id, companyId, diNumber: inserted.di_number, soDocNo, partyCode, partyName, amountSen, invoiceDate: due.date,
  });
  return {
    ok: true, status: 'issued', id: inserted.id, diNumber: inserted.di_number,
    jeNo: posted.ok ? posted.jeNo : null, postProblem: posted.ok ? null : posted.reason,
  };
}

/** Post one issued invoice's journal (Dr AR party / Cr DEPOSIT_INCOME) through
    the one gate — keyed (DI, di_number), so a second post echoes — and record
    the number on the invoice. */
export async function postDepositInvoice(
  sb: Db,
  di: { id: string; companyId: number; diNumber: string; soDocNo: string; partyCode: string | null; partyName: string | null; amountSen: number; invoiceDate: string },
): Promise<{ ok: true; jeNo: string; status: 'posted' | 'already_posted' } | { ok: false; reason: string }> {
  const roles = await resolveRoles(sb, di.companyId);
  const r = await postJournal(sb, {
    companyId: di.companyId,
    entryDate: di.invoiceDate,
    sourceType: 'DI',
    sourceDocNo: di.diNumber,
    narration: `Deposit invoice ${di.diNumber} — ${di.soDocNo}${di.partyName ? ` — ${di.partyName}` : ''}`,
    lines: depositInvoiceLines(roles, { diNumber: di.diNumber, docNo: di.soDocNo, customerCode: di.partyCode, customerName: di.partyName }, di.amountSen),
  });
  if (!r.ok) return { ok: false, reason: `${r.status}${r.reason ? `: ${r.reason}` : ''}` };
  const { error } = await sb.from('acc_deposit_invoices').update({ je_no: r.jeNo }).eq('id', di.id);
  if (error) return { ok: false, reason: `posted as ${r.jeNo} but the invoice did not record it: ${error.message}` };
  return { ok: true, jeNo: r.jeNo, status: r.status === 'already_posted' ? 'already_posted' : 'posted' };
}

/* ── Cancel ──────────────────────────────────────────────────────────────── */

export type CancelResult =
  | { ok: true; status: 'cancelled'; diNumber: string; contraJeNo: string | null }
  | { ok: true; status: 'already_cancelled'; diNumber: string }
  | { ok: false; status: 'not_found' | 'read_failed' | 'reversal_failed' | 'update_failed'; reason: string };

/** Cancel one invoice: the contra for its journal (dated the day of the
    cancel), the row kept on file as CANCELLED with the reason. An invoice
    that never posted is simply marked. */
export async function cancelDepositInvoice(
  sb: Db,
  p: { companyId: number; id: string; reason: string | null; actor: string | null; entryDate?: string },
): Promise<CancelResult> {
  const { data, error } = await sb.from('acc_deposit_invoices')
    .select(DI_COLS).eq('id', p.id).eq('company_id', p.companyId).maybeSingle();
  if (error) return { ok: false, status: 'read_failed', reason: error.message };
  const di = data as DepositInvoiceRow | null;
  if (!di) return { ok: false, status: 'not_found', reason: p.id };
  if (di.status === 'CANCELLED') return { ok: true, status: 'already_cancelled', diNumber: di.di_number };

  let contraJeNo: string | null = null;
  if (di.je_no) {
    const rev = await reverseJournal(sb, {
      sourceType: 'DI',
      sourceDocNo: di.di_number,
      companyId: p.companyId,
      narration: (orig) => `Reversal of ${orig.je_no} — deposit invoice ${di.di_number} cancelled${p.reason ? `: ${p.reason}` : ''}`,
      entryDate: p.entryDate ?? todayMyt(),
    });
    if (!rev.ok) return { ok: false, status: 'reversal_failed', reason: rev.reason ?? rev.status };
    contraJeNo = rev.status === 'reversed' ? rev.jeNo : null;
  }
  const { error: upErr } = await sb.from('acc_deposit_invoices').update({
    status: 'CANCELLED',
    cancel_reason: p.reason,
    cancelled_at: new Date().toISOString(),
    cancelled_by: p.actor,
  }).eq('id', p.id);
  if (upErr) return { ok: false, status: 'update_failed', reason: upErr.message };
  return { ok: true, status: 'cancelled', diNumber: di.di_number, contraJeNo };
}

/* ── The hooks the payment row calls (best-effort, never throw) ──────────── */

/** After a payment row is born: issue its invoice when one is due. `row` is
    the inserted payment (id, so_doc_no, paid_at, amount_sen, method). */
export async function issueDepositInvoiceBestEffort(sb: Db, row: Record<string, unknown> | null | undefined, where: string): Promise<void> {
  if (!row) return;
  try {
    const r = await issueDepositInvoice(sb, {
      paymentId: String(row.id ?? ''),
      soDocNo: String(row.so_doc_no ?? ''),
      paidAt: typeof row.paid_at === 'string' ? row.paid_at : null,
      amountSen: Number(row.amount_sen),
      method: typeof row.method === 'string' ? row.method : null,
      createdBy: typeof row.created_by === 'string' ? row.created_by : null,
    });
    if (!r.ok) log(`${where}: no deposit invoice for payment`, row.id, r.status, r.reason);
    else if (r.status === 'issued' && r.postProblem) log(`${where}: ${r.diNumber} issued but not posted:`, r.postProblem);
  } catch (e) {
    log(`${where}: deposit invoice hook threw:`, e);
  }
}

/** After a payment is edited: a standing invoice whose amount or day no
    longer matches is cancelled by contra and the next number issued; a
    payment with no standing invoice simply gets one if it is now due. */
export async function reissueDepositInvoiceBestEffort(
  sb: Db,
  p: { paymentId: string; docNo: string; paidAt: string | null | undefined; amountSen: number; method?: string | null; actor?: string | null },
): Promise<void> {
  try {
    const cur = await activeFor(sb, p.paymentId);
    if (cur.error) { log('edit: standing invoice not read:', p.paymentId, cur.error); return; }
    if (cur.row) {
      const same = Number(cur.row.amount_sen) === Number(p.amountSen) && dayOf(cur.row.invoice_date) === dayOf(p.paidAt);
      if (same) return;
      const c = await cancelDepositInvoice(sb, {
        companyId: cur.row.company_id, id: cur.row.id, reason: `payment on ${p.docNo} edited — re-issued`, actor: p.actor ?? null,
      });
      /* A cancel that failed leaves the old invoice standing; issuing a second
         beside it would be two invoices for one payment. Stop, out loud. */
      if (!c.ok) { log('edit: standing invoice not cancelled:', cur.row.di_number, c.status, c.reason); return; }
    }
    const r = await issueDepositInvoice(sb, {
      paymentId: p.paymentId, soDocNo: p.docNo, paidAt: p.paidAt, amountSen: p.amountSen, method: p.method ?? null, createdBy: p.actor ?? null,
    });
    if (!r.ok) log('edit: deposit invoice not re-issued:', p.paymentId, r.status, r.reason);
    else if (r.status === 'issued' && r.postProblem) log(`edit: ${r.diNumber} re-issued but not posted:`, r.postProblem);
  } catch (e) {
    log('edit: deposit invoice hook threw:', e);
  }
}

/** After a payment is deleted: its standing invoice is cancelled by contra. */
export async function cancelDepositInvoiceForPaymentBestEffort(
  sb: Db,
  p: { paymentId: string; reason: string; actor?: string | null },
): Promise<void> {
  try {
    const cur = await activeFor(sb, p.paymentId);
    if (cur.error) { log('delete: standing invoice not read:', p.paymentId, cur.error); return; }
    if (!cur.row) return;
    const c = await cancelDepositInvoice(sb, { companyId: cur.row.company_id, id: cur.row.id, reason: p.reason, actor: p.actor ?? null });
    if (!c.ok) log('delete: deposit invoice not cancelled:', cur.row.di_number, c.status, c.reason);
  } catch (e) {
    log('delete: deposit invoice hook threw:', e);
  }
}

/* ── The backlog: payments due an invoice that have none ─────────────────── */

export type MissingPayment = { id: string; so_doc_no: string; paid_at: string | null; amount_sen: number; method: string | null; created_by: string | null };

/** The company's payments dated on or after the start that are due a deposit
    invoice and have no standing one — what turning the switch on with a past
    start date leaves behind, and what a hook hiccup skipped. */
export async function missingDepositInvoices(
  sb: Db,
  companyId: number,
): Promise<{ ok: true; enabled: boolean; payments: MissingPayment[] } | { ok: false; reason: string }> {
  const st = await loadDepositInvoiceSettings(sb, companyId);
  if (!st.ok) return st;
  if (!st.settings.enabled) return { ok: true, enabled: false, payments: [] };

  let q = sb.from('mfg_sales_order_payments')
    .select('id, so_doc_no, paid_at, amount_sen, method, created_by')
    .eq('company_id', companyId)
    .neq('method', 'imported')
    .order('paid_at', { ascending: true })
    .limit(2000);
  if (st.settings.fromDate) q = q.gte('paid_at', st.settings.fromDate);
  const { data: pays, error: payErr } = await q;
  if (payErr) return { ok: false, reason: `payments: ${payErr.message}` };
  const candidates = ((pays ?? []) as MissingPayment[]).filter((p) => dayOf(p.paid_at) != null && Number(p.amount_sen) > 0);
  if (candidates.length === 0) return { ok: true, enabled: true, payments: [] };

  const { data: dis, error: diErr } = await sb.from('acc_deposit_invoices')
    .select('payment_id')
    .eq('company_id', companyId)
    .neq('status', 'CANCELLED');
  if (diErr) return { ok: false, reason: `deposit invoices: ${diErr.message}` };
  const have = new Set(((dis ?? []) as Array<{ payment_id: string }>).map((d) => String(d.payment_id)));

  /* The orders that already carry a live invoice — one read per 200 orders. */
  const docNos = [...new Set(candidates.map((p) => p.so_doc_no))];
  const invoiced = new Set<string>();
  for (let i = 0; i < docNos.length; i += 200) {
    const { data: sis, error: siErr } = await sb.from('sales_invoices')
      .select('so_doc_no, status')
      .eq('company_id', companyId)
      .in('so_doc_no', docNos.slice(i, i + 200));
    if (siErr) return { ok: false, reason: `order invoices: ${siErr.message}` };
    for (const r of (sis ?? []) as Array<{ so_doc_no: string; status?: string | null }>) {
      if (absorbsOrderDeposit(r.status)) invoiced.add(String(r.so_doc_no));
    }
  }
  return {
    ok: true, enabled: true,
    payments: candidates.filter((p) => !have.has(String(p.id)) && !invoiced.has(String(p.so_doc_no))),
  };
}

/** Issue every missing invoice, in payment-date order so the numbers follow
    the money. Each payment answers for itself; one refusal does not stop
    the rest. */
export async function issueMissingDepositInvoices(
  sb: Db,
  companyId: number,
  actor: string | null,
): Promise<{ ok: true; issued: string[]; skipped: Array<{ paymentId: string; why: string }> } | { ok: false; reason: string }> {
  const missing = await missingDepositInvoices(sb, companyId);
  if (!missing.ok) return missing;
  const issued: string[] = [];
  const skipped: Array<{ paymentId: string; why: string }> = [];
  for (const p of missing.payments) {
    const r = await issueDepositInvoice(sb, {
      paymentId: String(p.id), soDocNo: p.so_doc_no, paidAt: p.paid_at, amountSen: Number(p.amount_sen), method: p.method, createdBy: actor,
    });
    if (!r.ok) skipped.push({ paymentId: String(p.id), why: `${r.status}: ${r.reason}` });
    else if (r.status === 'not_due') skipped.push({ paymentId: String(p.id), why: r.why });
    else issued.push(r.diNumber);
  }
  return { ok: true, issued, skipped };
}
