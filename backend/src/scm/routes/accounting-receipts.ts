// ----------------------------------------------------------------------------
// accounting-receipts — the Official Receipts surface (GL redesign item 9).
// The receipts themselves are born inside the payment writers and formalised
// by the money-confirmation hooks (acc/receipts.ts); this file is the screen's
// three doors: list them, fetch-or-heal one for a payment (the print button's
// path), and the MANUAL confirm — the owner's 客户催收据 route: he verified
// the slip himself, the receipt goes formal now, recon links up later.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { ensureReceiptForPayment, formaliseReceipt, loadReceiptParties, withReceiptParty } from '../../acc/receipts';
import { rebankTxFor } from '../../acc/rebank-transaction';
import { resolveRoles } from '../../acc/rules';
import { companyCodeById } from '../lib/doc-no';
import { paginateAll } from '../lib/paginate-all';
import { monthRange } from './accounting-receipts-check';

/* Receipts are a sales-side paper: the writer key covers recording payments,
   so it covers handing over the receipt for one. */
const requirePerm = (c: any): boolean =>
  hasHouzsPerm(c, 'scm.payment_voucher.post') || hasHouzsPerm(c, 'scm.sales_order.write');

/* ── GET /accounting/receipts?status=&limit=&month=YYYY-MM&all=1 ────────────
   Without a month: the newest `limit` receipts — or, with `all=1`, every one,
   newest first (Money in › Receipts' Any month, the owner's Claude Design batch
   5 §2.3 c2: the book read whole, paged, so its chips count it truly). With a
   month: every receipt whose payment day falls in it, oldest first, so the
   month reads whole beside its check (accounting-receipts-check.ts). */
export const receiptsList = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to see receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const status = String(c.req.query('status') ?? '').trim().toUpperCase();
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
  const month = String(c.req.query('month') ?? '').trim();
  const range = month ? monthRange(month) : null;
  if (month && !range) return c.json({ error: 'bad_month', message: 'Which month? YYYY-MM.' }, 400);

  const COLS = 'id, or_number, status, payment_source, payment_id, doc_no, customer_name, method, amount_sen, paid_at, channel_account_code, issued_at, issued_by, created_at, cancelled_at, cancelled_by, cancel_reason';
  const scoped = (q: any) => (status === 'DRAFT' || status === 'FORMAL' || status === 'CANCELLED' ? q.eq('status', status) : q);
  /* Each row carries its customer's name, phone and address for the batch print (owner 2026-11-09). */
  const withParties = async (rows: Array<Record<string, unknown>>) => {
    const parties = await loadReceiptParties(sb, co.companyId, rows);
    return rows.map((r) => withReceiptParty(r, parties));
  };
  if (range) {
    const all = await paginateAll<Record<string, unknown>>((from, to) => scoped(sb.from('acc_official_receipts').select(COLS)
      .eq('company_id', co.companyId).gte('paid_at', range.from).lte('paid_at', range.to))
      .order('paid_at', { ascending: true }).order('or_number', { ascending: true }).range(from, to));
    if (all.error) return c.json({ error: 'load_failed', reason: all.error.message }, 500);
    return c.json({ receipts: await withParties(all.data ?? []) });
  }
  if (String(c.req.query('all') ?? '') === '1') {
    const every = await paginateAll<Record<string, unknown>>((from, to) => scoped(sb.from('acc_official_receipts').select(COLS)
      .eq('company_id', co.companyId))
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to));
    if (every.error) return c.json({ error: 'load_failed', reason: every.error.message }, 500);
    return c.json({ receipts: await withParties(every.data ?? []) });
  }
  const { data, error } = await scoped(sb.from('acc_official_receipts').select(COLS).eq('company_id', co.companyId))
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ receipts: await withParties((data ?? []) as Array<Record<string, unknown>>) });
};

/* ── GET /accounting/receipts/:id — one official receipt, for its page ──────
   (the owner's Claude Design, batch 5 §8.3 c7). The row; the receipt that
   replaced it (a cancelled receipt points at its re-issue) and the one it
   replaced; the PAYMENT's journal — a receipt posts nothing, its payment's
   entry is its books; what the payment says now (the page names an amount
   that is no longer the payment's); the order and its salesperson. Reads
   only, every one of them company-scoped; a read that fails says so. */
type PaymentNow = { amountSen: number; paidAt: string | null; method: string | null; soDocNo: string | null; salesInvoiceId: string | null };
type Rec = Record<string, unknown>;
const textOf = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

export const receiptDetail = async (c: Parameters<typeof receiptsList>[0]): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to see receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad_id' }, 400);
  const sb = c.get('supabase');
  const fail = (what: string, reason: string) => c.json({ error: 'load_failed', reason: `${what}: ${reason}` }, 500);

  const { data: row, error } = await sb.from('acc_official_receipts')
    .select('id, or_number, status, payment_source, payment_id, doc_no, customer_name, method, amount_sen, paid_at, channel_account_code, issued_at, issued_by, created_at, created_by, cancelled_at, cancelled_by, cancel_reason, replaced_by_id')
    .eq('company_id', co.companyId).eq('id', id).maybeSingle();
  if (error) return fail('receipt', error.message);
  if (!row) return c.json({ error: 'not_found', message: 'That receipt is not in the company you are working in.' }, 404);
  const r = row as Rec;
  const source = String(r.payment_source ?? '');
  const paymentId = String(r.payment_id ?? '');

  const [next, prev, jes] = await Promise.all([
    r.replaced_by_id != null
      ? sb.from('acc_official_receipts').select('id, or_number, status').eq('company_id', co.companyId).eq('id', r.replaced_by_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    sb.from('acc_official_receipts').select('id, or_number, status').eq('company_id', co.companyId).eq('replaced_by_id', id).maybeSingle(),
    sb.from('journal_entries').select('id, je_no, entry_date, reversed, created_at')
      .eq('company_id', co.companyId).eq('source_type', source).eq('source_doc_no', paymentId).order('created_at', { ascending: false }),
  ]);
  if (next.error) return fail('replacement', next.error.message);
  if (prev.error) return fail('replaced receipt', prev.error.message);
  if (jes.error) return fail('payment journal', jes.error.message);
  const entries = (jes.data ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>;
  const je = entries.find((e) => !e.reversed) ?? entries.at(0);

  /* The payment as it stands now — gone when it was deleted. */
  const table = source === 'SIPAY' ? 'sales_invoice_payments' : 'mfg_sales_order_payments';
  const payCols = source === 'SIPAY' ? 'id, sales_invoice_id, paid_at, method, amount_sen' : 'id, so_doc_no, paid_at, method, amount_sen';
  const { data: payRaw, error: payErr } = await sb.from(table).select(payCols).eq('company_id', co.companyId).eq('id', paymentId).maybeSingle();
  if (payErr) return fail('payment', payErr.message);
  const pay = payRaw as Rec | null;
  const payment: PaymentNow | null = pay ? {
    amountSen: Number(pay.amount_sen ?? 0), paidAt: textOf(pay.paid_at)?.slice(0, 10) ?? null, method: textOf(pay.method),
    soDocNo: textOf(pay.so_doc_no), salesInvoiceId: textOf(pay.sales_invoice_id),
  } : null;

  /* A sales-invoice payment's invoice, and through it the order. */
  let salesInvoice: { id: string; number: string } | null = null;
  let soDocNo: string | null = payment?.soDocNo ?? (source === 'SOPAY' ? textOf(r.doc_no) : null);
  if (source === 'SIPAY') {
    const siId = payment?.salesInvoiceId ?? textOf(r.doc_no);
    if (siId) {
      const { data: siRaw, error: siErr } = await sb.from('sales_invoices').select('id, invoice_number, so_doc_no').eq('company_id', co.companyId).eq('id', siId).maybeSingle();
      if (siErr) return fail('sales invoice', siErr.message);
      const si = siRaw as Rec | null;
      if (si) { salesInvoice = { id: String(si.id), number: String(si.invoice_number ?? '') }; soDocNo = textOf(si.so_doc_no); }
    }
  }
  let salesperson: string | null = null;
  if (soDocNo) {
    const { data: soRaw, error: soErr } = await sb.from('mfg_sales_orders').select('doc_no, salesperson_id').eq('company_id', co.companyId).eq('doc_no', soDocNo).maybeSingle();
    if (soErr) return fail('sales order', soErr.message);
    const spId = textOf((soRaw as Rec | null)?.salesperson_id);
    if (spId) {
      /* staff is the people master, shared by every company. */
      const { data: spRaw, error: spErr } = await sb.from('staff').select('id, name').eq('id', spId).maybeSingle();
      if (spErr) return fail('salesperson', spErr.message);
      salesperson = textOf((spRaw as Rec | null)?.name);
    }
  }

  const ref = (x: unknown) => { const v = x as { id: number; or_number: string; status: string } | null; return v ? { id: v.id, orNumber: v.or_number, status: v.status } : null; };
  return c.json({
    /* RECEIVED FROM on the print: the order's phone and address, its name where the receipt has none. */
    receipt: withReceiptParty(r, await loadReceiptParties(sb, co.companyId, [r])),
    replacedBy: ref(next.data),
    replaces: ref(prev.data),
    paymentJournal: je ? { id: je.id, jeNo: je.je_no, reversed: je.reversed === true } : null,
    payment,
    salesOrder: soDocNo,
    salesInvoice,
    salesperson,
  });
};

/* ── POST /accounting/receipts/ensure — {source, paymentId} ──────────────── */
export const receiptEnsure = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to issue receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const source = String(body.source ?? '').trim().toUpperCase();
  const paymentId = String(body.paymentId ?? '').trim();
  if ((source !== 'SOPAY' && source !== 'SIPAY') || !paymentId) {
    return c.json({ error: 'bad_key', message: 'source (SOPAY/SIPAY) and paymentId are required.' }, 400);
  }
  const sb = c.get('supabase');
  // company-scope: ensureReceiptForPayment reads the receipt and the payment with co.companyId
  const r = await ensureReceiptForPayment(sb, source as 'SOPAY' | 'SIPAY', paymentId, co.companyId);
  if (!r.ok) return c.json({ error: 'ensure_failed', reason: r.reason }, r.reason.endsWith('not found') ? 404 : 500);
  /* The caller is about to PRINT: hand back the whole row (customer, method,
     amounts, issued-by), not just the number — one round trip, server truth. */
  const { data: row, error: rowErr } = await sb.from('acc_official_receipts').select('*').eq('id', r.id).maybeSingle();
  if (rowErr || !row) return c.json({ error: 'ensure_failed', reason: rowErr?.message ?? 'receipt vanished after ensure' }, 500);
  return c.json({ receipt: withReceiptParty(row as Rec, await loadReceiptParties(sb, co.companyId, [row as Rec])) });
};

/* ── POST /accounting/receipts/:id/formalise — {accountCode?} ─────────────
   The human said the money is real. accountCode names where it landed; left
   out, the company's default bank answers (transfers into the main account —
   the common case the owner described). */
export const receiptFormalise = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to confirm receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad_id' }, 400);
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body = default bank */ }
  const sb = c.get('supabase');

  const roles = await resolveRoles(sb, co.companyId);
  const accountCode = String(body?.accountCode ?? '').trim() || roles.BANK_DEFAULT;
  const code = await companyCodeById(sb, co.companyId);
  if (!code) return c.json({ error: 'load_failed', reason: `company ${co.companyId} has no code` }, 500);

  const actor = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  const r = await formaliseReceipt(sb, { companyId: co.companyId, companyCode: code, receiptId: id, accountCode, actor, rebankTx: rebankTxFor(c.env) });
  if (!r.ok) {
    return c.json({ error: r.status, message: r.reason }, r.status === 'bank_letter_missing' || r.status === 'cancelled' || r.status === 'payment_reconciled' ? 409 : r.status === 'not_found' ? 404 : 500);
  }
  return c.json({ ok: true, orNumber: r.orNumber, already: r.already === true });
};
