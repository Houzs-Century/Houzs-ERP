// ----------------------------------------------------------------------------
// Receipts — every ringgit that came IN, on one page (owner 2026-09-03).
//
// Three kinds, ONE list:
//   · GENERAL — 就我只想开 receipt 罢了: payer typed free (no registry), money
//     account + lines that pick their own credit accounts, POSTS DIRECTLY
//     (不需要走四层，就录入就好), and the only undo is VOID (错就 delete 或
//     void — a posted document leaves the ledger by RCT_REVERSAL, never by
//     vanishing);
//   · DEBTOR — the Other Debtors receipts, listed here read-only (they are
//     raised and walked through their four layers on /scm/other-debtors);
//   · CUSTOMER — 顾客的钱 keeps flowing through the sales payments it always
//     used; these rows are read-only mirrors of mfg_sales_order_payments.
//
// Permission keys stay the PV family's: create raises, cancel voids.
// Handlers exported bare for the vitest harness (other-debtors precedent).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { supabaseAuth } from '../middleware/auth';
import { companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { mintMonthlyDocNo } from '../lib/doc-no';
import { postJournal, reverseJournal } from '../../acc/engine';
import { type RuleLine } from '../../acc/rules';
import { requireLeafAccount } from './accounting-chart';

type Row = Record<string, any>;

const yymm = () => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/* Month window "YYYY-MM" → [first day, first day of next month). Defaults to
   the current month — the page answers 这个月收了什么钱 without pagination. */
const monthWindow = (raw: string | undefined): { from: string; to: string } | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(raw ?? '').trim() || new Date().toISOString().slice(0, 7));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${y}-${pad(mo)}-01`;
  const to = mo === 12 ? `${y + 1}-01-01` : `${y}-${pad(mo + 1)}-01`;
  return { from, to };
};

/* ── GET /receipts?month=YYYY-MM — the unified money-in list ─────────────── */
export const listReceiptsHandler = async (c: any): Promise<Response> => {
  const win = monthWindow(c.req.query('month'));
  if (!win) return c.json({ error: 'bad_month', message: 'month must look like 2026-09.' }, 400);
  const sb = c.get('supabase');

  const [general, debtor, customer] = await Promise.all([
    scopeToCompany(sb.from('acc_receipts')
      .select('id, receipt_number, payer_name, receipt_date, bank_account_code, total_sen, status, notes')
      .gte('receipt_date', win.from).lt('receipt_date', win.to), c).order('receipt_number'),
    scopeToCompany(sb.from('acc_debtor_receipts')
      .select('id, receipt_number, receipt_date, bank_account_code, total_sen, status, debtor_id, debtor:acc_debtors(name)')
      .gte('receipt_date', win.from).lt('receipt_date', win.to), c).order('receipt_number'),
    scopeToCompany(sb.from('mfg_sales_order_payments')
      .select('id, so_doc_no, paid_at, method, amount_sen, is_deposit')
      .gte('paid_at', win.from).lt('paid_at', win.to), c).order('paid_at'),
  ]);
  if (general.error) return c.json({ error: 'load_failed', reason: general.error.message }, 500);
  if (debtor.error) return c.json({ error: 'load_failed', reason: debtor.error.message }, 500);
  if (customer.error) return c.json({ error: 'load_failed', reason: customer.error.message }, 500);

  const rows = [
    ...((general.data ?? []) as Row[]).map((r) => ({
      kind: 'GENERAL' as const, id: r.id, number: r.receipt_number, date: r.receipt_date,
      payer: r.payer_name, moneyAccount: r.bank_account_code, totalSen: Number(r.total_sen ?? 0),
      status: r.status, notes: r.notes ?? null,
    })),
    ...((debtor.data ?? []) as Row[]).map((r) => ({
      kind: 'DEBTOR' as const, id: r.id, number: r.receipt_number, date: r.receipt_date,
      payer: (r.debtor as Row | null)?.name ?? '(debtor)', moneyAccount: r.bank_account_code,
      totalSen: Number(r.total_sen ?? 0), status: r.status, debtorId: r.debtor_id,
    })),
    ...((customer.data ?? []) as Row[]).map((r) => ({
      kind: 'CUSTOMER' as const, id: r.id, number: r.so_doc_no,
      date: String(r.paid_at ?? '').slice(0, 10),
      payer: r.is_deposit === true ? 'Customer deposit' : 'Customer payment',
      moneyAccount: r.method ?? '—', totalSen: Number(r.amount_sen ?? 0), status: 'RECEIVED',
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.number < b.number ? 1 : -1));

  return c.json({ month: win.from.slice(0, 7), receipts: rows });
};

/* ── POST /receipts — record + post, one motion (不需要走四层) ────────────── */
export const createReceiptHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json({ error: 'no_company', message: 'No active company resolves for this session.' }, 409);
  const coId = co.companyId;

  const payer = String(body.payerName ?? '').trim();
  if (!payer) return c.json({ error: 'payer_required', message: 'Who paid? Type the name.' }, 400);
  const bank = String(body.bankAccountCode ?? '').trim();
  if (!bank) return c.json({ error: 'bank_required' }, 400);
  const sb = c.get('supabase');
  {
    const { data, error } = await sb.from('accounts')
      .select('acc_money, is_active').eq('company_id', coId).eq('account_code', bank).maybeSingle();
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const a = data as { acc_money?: boolean; is_active?: boolean } | null;
    if (!a || a.is_active !== true || a.acc_money !== true) {
      return c.json({ error: 'not_a_money_account', message: `${bank} is not an active bank/cash account — the receipt must land on money.` }, 400);
    }
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0 || rawLines.length > 50) {
    return c.json({ error: 'lines_required', message: 'A receipt takes 1 to 50 lines.' }, 400);
  }
  const lines: Array<{ description: string | null; code: string; amountSen: number }> = [];
  for (const [i, l] of rawLines.entries()) {
    const code = String(l?.creditAccountCode ?? '').trim();
    const amount = Number(l?.amountSen);
    if (!code) return c.json({ error: 'bad_line', message: `Line ${i + 1} has no account.` }, 400);
    if (!Number.isInteger(amount) || amount <= 0) {
      return c.json({ error: 'bad_line', message: `Line ${i + 1}: amountSen must be a positive integer (got ${String(l?.amountSen)}).` }, 400);
    }
    lines.push({ description: l?.description ? String(l.description).trim() : null, code, amountSen: amount });
  }
  /* Same doors as the Debtor Bill's lines: headers refuse (父户不记账),
     control accounts refuse (由模块过账). */
  for (const code of [...new Set(lines.map((l) => l.code))]) {
    const leafErr = await requireLeafAccount(c, coId, code);
    if (leafErr) return leafErr;
  }
  const receiptDate = String(body.receiptDate ?? '').trim() || new Date().toISOString().slice(0, 10);
  const totalSen = lines.reduce((s, l) => s + l.amountSen, 0);

  const receiptNumber = await mintMonthlyDocNo(sb, 'acc_receipts', 'receipt_number', `${companyDocPrefix(c)}OR-${yymm()}`);
  const { data: receipt, error: insErr } = await sb.from('acc_receipts').insert({
    company_id: coId,
    receipt_number: receiptNumber,
    payer_name: payer,
    receipt_date: receiptDate,
    bank_account_code: bank,
    total_sen: totalSen,
    status: 'POSTED',
    notes: body.notes ? String(body.notes).trim() : null,
    created_by: String(c.get('user')?.id ?? ''),
  }).select('id, receipt_number').single();
  if (insErr || !receipt) return c.json({ error: 'save_failed', reason: insErr?.message ?? 'insert returned nothing' }, 500);

  const { error: lineErr } = await sb.from('acc_receipt_lines').insert(lines.map((l, i) => ({
    company_id: coId,
    receipt_id: receipt.id,
    line_no: i + 1,
    description: l.description,
    credit_account_code: l.code,
    amount_sen: l.amountSen,
  })));
  if (lineErr) {
    await sb.from('acc_receipts').delete().eq('company_id', coId).eq('id', receipt.id);
    return c.json({ error: 'save_failed', reason: lineErr.message }, 500);
  }

  const ruleLines: RuleLine[] = [
    {
      accountCode: bank, debitSen: totalSen, creditSen: 0,
      partyType: null, partyCode: null, partyName: payer,
      notes: `Receipt ${receipt.receipt_number} — ${payer}`,
    },
    ...lines.map((l) => ({
      accountCode: l.code, debitSen: 0, creditSen: l.amountSen,
      partyType: null, partyCode: null, partyName: null,
      notes: l.description ?? receipt.receipt_number,
    })),
  ];
  const r = await postJournal(sb, {
    companyId: coId,
    entryDate: receiptDate,
    sourceType: 'RCT',
    sourceDocNo: receipt.receipt_number,
    narration: `Receipt ${receipt.receipt_number} — ${payer}`,
    lines: ruleLines,
  });
  if (!r.ok) {
    /* Direct-post means BOTH or NEITHER — the receipt leaves with its journal. */
    await sb.from('acc_receipt_lines').delete().eq('company_id', coId).eq('receipt_id', receipt.id);
    await sb.from('acc_receipts').delete().eq('company_id', coId).eq('id', receipt.id);
    return c.json({ error: 'post_failed', reason: (r as { reason?: string }).reason ?? r.status }, 500);
  }
  return c.json({ ok: true, receipt: { id: receipt.id, receiptNumber: receipt.receipt_number, totalSen } }, 201);
};

/* ── POST /receipts/:id/void — the one undo (错就 void) ─────────────────── */
export const voidReceiptHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const sb = c.get('supabase');
  const { data: receipt, error } = await scopeToCompany(
    sb.from('acc_receipts').select('id, receipt_number, status, company_id').eq('id', c.req.param('id')), c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!receipt) return c.json({ error: 'not_found' }, 404);
  if (receipt.status === 'CANCELLED') return c.json({ error: 'void_twice', message: 'This receipt is void.' }, 409);

  const rev = await reverseJournal(sb, {
    companyId: receipt.company_id,
    sourceType: 'RCT',
    sourceDocNo: receipt.receipt_number,
    narration: (orig) => `Void receipt ${receipt.receipt_number} — voids ${orig.je_no}`,
  });
  if (!rev.ok) return c.json({ error: 'reverse_failed', reason: (rev as { reason?: string }).reason ?? rev.status }, 500);
  const { error: upErr } = await sb.from('acc_receipts')
    .update({ status: 'CANCELLED' }).eq('company_id', receipt.company_id).eq('id', receipt.id);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true });
};

/* ── Router ───────────────────────────────────────────────────────────────── */

export const receipts = new Hono();
/* The SCM bridge is PER ROUTER (scm/index.ts mounts no global one): it stashes
   the real caller as houzsUser — what hasHouzsPerm reads — and hands out the
   service client. This router shipped without it and GET /receipts answered 500 to everyone. See docs/bugs/0648; tests/scmRouterBridge.test.ts pins it. */
receipts.use('*', supabaseAuth);
receipts.get('/', listReceiptsHandler);
receipts.post('/', createReceiptHandler);
receipts.post('/:id/void', voidReceiptHandler);
