// ----------------------------------------------------------------------------
// accounting-receipts-check — one month of customer payments against one
// month of Official Receipts (owner 2026-09-16: or 我如何查看 amount 是对的).
// One receipt per payment, for the payment's amount, is the rule the writers
// keep (acc/receipts.ts); this is the reader that says whether the month
// obeys it: the two totals, the difference, and every row behind a difference
// — a payment with no receipt, a receipt whose amount is not its payment's,
// a receipt whose payment is gone.
//
//   GET /accounting/receipts/check?month=YYYY-MM
//
// Payments are read by paid_at, receipts by their paid_at too (the receipt
// carries the payment's day; the OR series is numbered by it). Money that
// never arrived is not expected to have a receipt: a converted row and a
// mirror row (lib/so-payment-row.ts) are left out, as are zero rows.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

export type CheckPayment = { source: 'SOPAY' | 'SIPAY'; paymentId: string; docNo: string | null; paidAt: string; method: string; amountSen: number };
export type CheckReceipt = { id: number; orNumber: string; status: string; source: string; paymentId: string; docNo: string | null; paidAt: string; amountSen: number };

export type ReceiptsCheck = {
  month: string;
  payments: { count: number; totalSen: number };
  receipts: { count: number; totalSen: number };
  diffSen: number;
  /** Payments of the month with no receipt. */
  missing: CheckPayment[];
  /** Receipts whose amount is not their payment's. */
  mismatched: Array<{ orNumber: string; source: string; paymentId: string; docNo: string | null; paidAt: string; receiptSen: number; paymentSen: number }>;
  /** Receipts whose payment no longer exists in the month (deleted, or re-dated out of it). */
  orphans: Array<{ orNumber: string; docNo: string | null; paidAt: string; amountSen: number }>;
};

const dayOf = (v: unknown): string => String(v ?? '').slice(0, 10);
const keyOf = (source: string, paymentId: string): string => `${source}:${paymentId}`;

/** The month's verdict, from the rows — pure, so a test reads it without a client. */
export function receiptsCheckOf(month: string, payments: CheckPayment[], receipts: CheckReceipt[]): ReceiptsCheck {
  const byKey = new Map(payments.map((p) => [keyOf(p.source, p.paymentId), p]));
  const receipted = new Set(receipts.map((r) => keyOf(r.source, r.paymentId)));
  const missing = payments.filter((p) => !receipted.has(keyOf(p.source, p.paymentId)));
  const mismatched: ReceiptsCheck['mismatched'] = [];
  const orphans: ReceiptsCheck['orphans'] = [];
  for (const r of receipts) {
    const p = byKey.get(keyOf(r.source, r.paymentId));
    if (!p) { orphans.push({ orNumber: r.orNumber, docNo: r.docNo, paidAt: r.paidAt, amountSen: r.amountSen }); continue; }
    if (p.amountSen !== r.amountSen) mismatched.push({ orNumber: r.orNumber, source: r.source, paymentId: r.paymentId, docNo: r.docNo, paidAt: r.paidAt, receiptSen: r.amountSen, paymentSen: p.amountSen });
  }
  const paymentsTotal = payments.reduce((s, p) => s + p.amountSen, 0);
  const receiptsTotal = receipts.reduce((s, r) => s + r.amountSen, 0);
  return {
    month,
    payments: { count: payments.length, totalSen: paymentsTotal },
    receipts: { count: receipts.length, totalSen: receiptsTotal },
    diffSen: paymentsTotal - receiptsTotal,
    missing, mismatched, orphans,
  };
}

export const monthRange = (month: string): { from: string; to: string } | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/** The month's payments that ought to carry a receipt: money that arrived. */
async function loadPayments(sb: Db, companyId: number, r: { from: string; to: string }): Promise<{ ok: true; rows: CheckPayment[] } | { ok: false; reason: string }> {
  const so = await paginateAll<Row>((from, to) => sb.from('mfg_sales_order_payments')
    .select('id, so_doc_no, paid_at, method, amount_sen')
    .eq('company_id', companyId).gte('paid_at', r.from).lte('paid_at', r.to)
    .order('paid_at', { ascending: true }).order('id', { ascending: true })
    .range(from, to));
  if (so.error) return { ok: false, reason: `SO payments: ${so.error.message}` };
  const si = await paginateAll<Row>((from, to) => sb.from('sales_invoice_payments')
    .select('id, sales_invoice_id, paid_at, method, amount_sen')
    .eq('company_id', companyId).gte('paid_at', r.from).lte('paid_at', r.to)
    .order('paid_at', { ascending: true }).order('id', { ascending: true })
    .range(from, to));
  if (si.error) return { ok: false, reason: `SI payments: ${si.error.message}` };
  const siIds = [...new Set((si.data ?? []).map((p) => String(p.sales_invoice_id)))];
  const invoiceNo = new Map<string, string>();
  if (siIds.length > 0) {
    const { data, error } = await sb.from('sales_invoices').select('id, invoice_number').in('id', siIds);
    if (error) return { ok: false, reason: `invoices: ${error.message}` };
    for (const x of (data ?? []) as Row[]) invoiceNo.set(String(x.id), String(x.invoice_number ?? ''));
  }
  const arrived = (p: Row): boolean => String(p.method ?? '') !== 'converted' && Number(p.amount_sen ?? 0) > 0;
  const rows: CheckPayment[] = [
    ...(so.data ?? []).filter(arrived).map((p): CheckPayment => ({ source: 'SOPAY', paymentId: String(p.id), docNo: p.so_doc_no == null ? null : String(p.so_doc_no), paidAt: dayOf(p.paid_at), method: String(p.method ?? ''), amountSen: Number(p.amount_sen ?? 0) })),
    ...(si.data ?? []).filter(arrived).map((p): CheckPayment => ({ source: 'SIPAY', paymentId: String(p.id), docNo: invoiceNo.get(String(p.sales_invoice_id)) ?? null, paidAt: dayOf(p.paid_at), method: String(p.method ?? ''), amountSen: Number(p.amount_sen ?? 0) })),
  ];
  return { ok: true, rows };
}

async function loadReceipts(sb: Db, companyId: number, r: { from: string; to: string }): Promise<{ ok: true; rows: CheckReceipt[] } | { ok: false; reason: string }> {
  const out = await paginateAll<Row>((from, to) => sb.from('acc_official_receipts')
    .select('id, or_number, status, payment_source, payment_id, doc_no, paid_at, amount_sen')
    .eq('company_id', companyId).gte('paid_at', r.from).lte('paid_at', r.to)
    .order('paid_at', { ascending: true }).order('or_number', { ascending: true })
    .range(from, to));
  if (out.error) return { ok: false, reason: `receipts: ${out.error.message}` };
  return {
    ok: true,
    rows: (out.data ?? []).map((x): CheckReceipt => ({
      id: Number(x.id), orNumber: String(x.or_number ?? ''), status: String(x.status ?? ''), source: String(x.payment_source ?? ''), paymentId: String(x.payment_id ?? ''),
      docNo: x.doc_no == null ? null : String(x.doc_no), paidAt: dayOf(x.paid_at), amountSen: Number(x.amount_sen ?? 0),
    })),
  };
}

const requirePerm = (c: any): boolean =>
  hasHouzsPerm(c, 'scm.payment_voucher.post') || hasHouzsPerm(c, 'scm.sales_order.write');

/* ── GET /accounting/receipts/check?month=YYYY-MM ────────────────────────── */
export const receiptsCheck = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to see receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const month = String(c.req.query('month') ?? '').trim();
  const range = monthRange(month);
  if (!range) return c.json({ error: 'month_required', message: 'Which month? YYYY-MM.' }, 400);
  const sb = c.get('supabase');
  const payments = await loadPayments(sb, co.companyId, range);
  if (!payments.ok) return c.json({ error: 'load_failed', reason: payments.reason }, 500);
  const receipts = await loadReceipts(sb, co.companyId, range);
  if (!receipts.ok) return c.json({ error: 'load_failed', reason: receipts.reason }, 500);
  return c.json(receiptsCheckOf(month, payments.rows, receipts.rows));
};
