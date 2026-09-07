// ----------------------------------------------------------------------------
// pv-refund — the Customer Refund voucher (owner 2026-09-07: 按 1、2、3 的顺序做).
//
// A refund is the SAME paper as a payment voucher — money leaves a bank or
// the drawer through Draft → Prepared → Checked → Approved, with attachments,
// print, batch and audit — with the customer where the supplier would be:
//
//     Dr 300-0000 (AR, that customer)   the refund
//         Cr bank / cash                the refund
//
// which offsets the Cr AR the customer's own payment booked (SOPAY / SIPAY).
// Purpose CUSTOMER_REFUND (mig 20260907T1700); the source document and the
// customer ride the header (mig 20260907T1705). The formal number mints on
// its own series — {co}{letter}RF-YYMM-NNN, cash {co}CRF — at CHECKED, the
// way a PV takes {letter}PV (his word: 用 rf).
//
// 认单为主 — the operator names the document, not the customer: the Sales
// Order (any status — a deposit is a Cr AR with no revenue against it, so the
// refund simply nets it) or the Sales Invoice, which must be CANCELLED (its
// revenue reversed) — a live invoice refunded would leave the customer owing
// again, and the paper for THAT is the credit note, which is not built yet.
//
// THE HEADROOM IS WHAT THIS LEDGER BOOKED. Only payments that reached the
// journal count (SOPAY / SIPAY, not reversed): an `imported` row or a
// migrated invoice's payment lives in AutoCount's book, and refunding it here
// would Dr an AR this ledger never credited. Every non-cancelled refund
// voucher already on the document — draft or posted — is spoken for, the way
// a draft AP Payment reserves its invoice (docs/bugs/0653).
//
// Route-file budget: payment-vouchers.ts sits at its size ceiling, so every
// refund rule lives here; the route file holds one-line hooks.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId, scopeToCompanyId } from './companyScope';
import { resolveRoles } from '../../acc/rules';
import { addCustomerCredit } from './customer-credits';

export type RefundSourceType = 'SO' | 'SI';

export type RefundPayment = {
  id: string;
  paidOn: string;
  method: string;
  provider: string | null;
  amountSen: number;
  /** Reached this ledger (an active SOPAY / SIPAY journal) — only these count. */
  booked: boolean;
};

export type RefundVoucherRow = { id: string; pvNumber: string; status: string; voucherDate: string; totalSen: number };

export type RefundSource = {
  type: RefundSourceType;
  docNo: string;
  status: string | null;
  customer: { name: string | null; phone: string | null; customerId: string | null; debtorCode: string | null };
  payments: RefundPayment[];
  /** Money this ledger booked for the document (the refundable base). */
  bookedSen: number;
  /** Every non-cancelled refund voucher on the document, draft or posted. */
  refunds: RefundVoucherRow[];
  refundedSen: number;
  refundableSen: number;
  eligible: boolean;
  reason: string | null;
};

const normType = (raw: unknown): RefundSourceType | null => {
  const v = String(raw ?? '').trim().toUpperCase();
  return v === 'SO' || v === 'SI' ? v : null;
};

/** Which payment ids carry an ACTIVE journal of the given source type. */
async function bookedIds(sb: any, companyId: number, sourceType: 'SOPAY' | 'SIPAY', ids: string[]): Promise<{ ok: true; ids: Set<string> } | { ok: false; reason: string }> {
  const out = new Set<string>();
  if (ids.length === 0) return { ok: true, ids: out };
  const { data, error } = await sb.from('journal_entries')
    .select('source_doc_no, reversed')
    .eq('company_id', companyId).eq('source_type', sourceType).in('source_doc_no', ids);
  if (error) return { ok: false, reason: error.message };
  for (const r of (data ?? []) as Array<{ source_doc_no: string; reversed: boolean | null }>) if (!r.reversed) out.add(r.source_doc_no);
  return { ok: true, ids: out };
}

/** Every non-cancelled refund voucher already raised on the document. */
async function refundsOn(sb: any, companyId: number, docNo: string, excludePvId: string | null): Promise<{ ok: true; rows: RefundVoucherRow[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('payment_vouchers')
    .select('id, pv_number, status, voucher_date, total_sen')
    .eq('company_id', companyId).eq('purpose', 'CUSTOMER_REFUND').eq('refund_source_doc_no', docNo).neq('status', 'CANCELLED');
  if (error) return { ok: false, reason: error.message };
  const rows = ((data ?? []) as Array<{ id: string; pv_number: string; status: string; voucher_date: string; total_sen: number }>)
    .filter((r) => r.id !== excludePvId)
    .map((r) => ({ id: r.id, pvNumber: r.pv_number, status: r.status, voucherDate: String(r.voucher_date ?? '').slice(0, 10), totalSen: Number(r.total_sen ?? 0) }));
  return { ok: true, rows };
}

/**
 * The document, its customer, what it collected and what may still be
 * refunded. `excludePvId` leaves one voucher out of the reserved sum — the
 * one being edited.
 */
export async function loadRefundSource(
  sb: any,
  companyId: number,
  typeRaw: unknown,
  docNoRaw: unknown,
  excludePvId: string | null = null,
): Promise<{ ok: true; source: RefundSource } | { ok: false; status: number; error: string; message: string }> {
  const type = normType(typeRaw);
  const docNo = String(docNoRaw ?? '').trim();
  if (!type) return { ok: false, status: 400, error: 'bad_source_type', message: 'A refund names a Sales Order (SO) or a Sales Invoice (SI).' };
  if (!docNo) return { ok: false, status: 400, error: 'source_doc_required', message: 'Which document is refunded? Pick the SO or SI.' };

  let status: string | null = null;
  let customer: RefundSource['customer'] = { name: null, phone: null, customerId: null, debtorCode: null };
  let payments: RefundPayment[] = [];
  let ineligible: string | null = null;

  if (type === 'SO') {
    const { data: so, error } = await sb.from('mfg_sales_orders')
      .select('doc_no, company_id, status, debtor_name, debtor_code, phone, customer_id')
      .eq('doc_no', docNo).maybeSingle();
    if (error) return { ok: false, status: 500, error: 'load_failed', message: error.message };
    const row = so as { doc_no: string; company_id: number | null; status: string | null; debtor_name: string | null; debtor_code: string | null; phone: string | null; customer_id: string | null } | null;
    if (!row || Number(row.company_id) !== companyId) return { ok: false, status: 404, error: 'source_not_found', message: `${docNo} is not a Sales Order of this company.` };
    status = row.status ?? null;
    customer = { name: row.debtor_name ?? null, phone: row.phone ?? null, customerId: row.customer_id ?? null, debtorCode: row.debtor_code?.trim() || null };
    const { data: pays, error: pErr } = await sb.from('mfg_sales_order_payments')
      .select('id, paid_at, method, merchant_provider, amount_sen').eq('so_doc_no', docNo).order('paid_at');
    if (pErr) return { ok: false, status: 500, error: 'load_failed', message: pErr.message };
    const rows = (pays ?? []) as Array<{ id: string; paid_at: string | null; method: string; merchant_provider: string | null; amount_sen: number }>;
    const booked = await bookedIds(sb, companyId, 'SOPAY', rows.map((r) => String(r.id)));
    if (!booked.ok) return { ok: false, status: 500, error: 'load_failed', message: booked.reason };
    payments = rows.map((r) => ({
      id: String(r.id), paidOn: String(r.paid_at ?? '').slice(0, 10), method: String(r.method ?? ''),
      provider: r.merchant_provider ?? null, amountSen: Number(r.amount_sen ?? 0), booked: booked.ids.has(String(r.id)),
    }));
  } else {
    const { data: si, error } = await sb.from('sales_invoices')
      .select('id, invoice_number, company_id, status, debtor_name, debtor_code, migrated_no_stock')
      .eq('invoice_number', docNo).maybeSingle();
    if (error) return { ok: false, status: 500, error: 'load_failed', message: error.message };
    const row = si as { id: string; invoice_number: string; company_id: number | null; status: string | null; debtor_name: string | null; debtor_code: string | null; migrated_no_stock: boolean | null } | null;
    if (!row || Number(row.company_id) !== companyId) return { ok: false, status: 404, error: 'source_not_found', message: `${docNo} is not a Sales Invoice of this company.` };
    status = row.status ?? null;
    customer = { name: row.debtor_name ?? null, phone: null, customerId: null, debtorCode: row.debtor_code?.trim() || null };
    if (row.migrated_no_stock === true) {
      ineligible = `${docNo} was migrated — its money is in AutoCount's book, not this ledger.`;
    } else if (String(row.status ?? '').trim().toUpperCase() !== 'CANCELLED') {
      ineligible = `${docNo} still stands (${row.status ?? 'open'}) — a refund would leave the customer owing it again. Cancel the invoice first, or raise a credit note when that paper exists.`;
    }
    const { data: pays, error: pErr } = await sb.from('sales_invoice_payments')
      .select('id, paid_at, method, merchant_provider, amount_sen').eq('sales_invoice_id', row.id).order('paid_at');
    if (pErr) return { ok: false, status: 500, error: 'load_failed', message: pErr.message };
    const rows = (pays ?? []) as Array<{ id: string; paid_at: string | null; method: string; merchant_provider: string | null; amount_sen: number }>;
    const booked = await bookedIds(sb, companyId, 'SIPAY', rows.map((r) => String(r.id)));
    if (!booked.ok) return { ok: false, status: 500, error: 'load_failed', message: booked.reason };
    payments = rows.map((r) => ({
      id: String(r.id), paidOn: String(r.paid_at ?? '').slice(0, 10), method: String(r.method ?? ''),
      provider: r.merchant_provider ?? null, amountSen: Number(r.amount_sen ?? 0), booked: booked.ids.has(String(r.id)),
    }));
  }

  const bookedSen = payments.filter((p) => p.booked && p.amountSen > 0).reduce((s, p) => s + p.amountSen, 0);
  const prior = await refundsOn(sb, companyId, docNo, excludePvId);
  if (!prior.ok) return { ok: false, status: 500, error: 'load_failed', message: prior.reason };
  const refundedSen = prior.rows.reduce((s, r) => s + r.totalSen, 0);
  const refundableSen = Math.max(0, bookedSen - refundedSen);
  if (!ineligible && bookedSen === 0) {
    ineligible = payments.length === 0
      ? `${docNo} collected nothing — there is no money to refund.`
      : `${docNo}'s payments never reached this ledger (AutoCount-era or unbooked) — nothing here to refund against.`;
  }
  return {
    ok: true,
    source: {
      type, docNo, status, customer, payments, bookedSen,
      refunds: prior.rows, refundedSen, refundableSen,
      eligible: ineligible == null && refundableSen > 0,
      reason: ineligible ?? (refundableSen > 0 ? null : `${docNo} is refunded in full already.`),
    },
  };
}

/* ── GET /payment-vouchers/refund-source?type=SO&docNo=… ─────────────────── */
export const refundSourceHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = await loadRefundSource(c.get('supabase'), co.companyId, c.req.query('type'), c.req.query('docNo'), String(c.req.query('excludePvId') ?? '').trim() || null);
  if (!r.ok) return c.json({ error: r.error, message: r.message }, r.status);
  return c.json({ source: r.source });
};

export type RefundLineRow = { line_no: number; description: string; debit_account_code: string; amount_sen: number };

/**
 * The create door's refund half: the source must resolve and be eligible,
 * the amount must fit the headroom, and the ONE line is composed HERE — Dr
 * the AR control for the amount — never taken from the wire. Returns the
 * header fields to stamp and the line to write, or the refusal to send.
 */
export async function refundCreateGuard(
  c: any,
  body: Record<string, unknown>,
  excludePvId: string | null = null,
): Promise<
  | { ok: true; fields: Record<string, unknown>; rows: RefundLineRow[]; total: number; arControl: string }
  | { ok: false; resp: Response }
> {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, resp: c.json(co.refusal, 409) };
  const sb = c.get('supabase');
  const amount = Number(body.refundAmountSen);
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, resp: c.json({ error: 'refund_amount_required', message: 'How much is refunded? An amount above zero, in sen.' }, 400) };
  }
  const src = await loadRefundSource(sb, co.companyId, body.refundSourceType, body.refundSourceDocNo, excludePvId);
  if (!src.ok) return { ok: false, resp: c.json({ error: src.error, message: src.message }, src.status) };
  const s = src.source;
  if (!s.eligible) return { ok: false, resp: c.json({ error: 'refund_not_allowed', message: s.reason ?? `${s.docNo} cannot be refunded.` }, 409) };
  if (amount > s.refundableSen) {
    return {
      ok: false,
      resp: c.json({
        error: 'refund_exceeds_booked',
        message: `${s.docNo} has ${(s.refundableSen / 100).toFixed(2)} left to refund (${(s.bookedSen / 100).toFixed(2)} booked, ${(s.refundedSen / 100).toFixed(2)} already on refund vouchers) — not ${(amount / 100).toFixed(2)}.`,
        bookedSen: s.bookedSen, refundedSen: s.refundedSen, refundableSen: s.refundableSen,
      }, 409),
    };
  }
  const roles = await resolveRoles(sb, co.companyId);
  return {
    ok: true,
    arControl: roles.AR,
    total: amount,
    rows: [{ line_no: 1, description: `Refund on ${s.docNo}`, debit_account_code: roles.AR, amount_sen: amount }],
    fields: {
      refund_source_type: s.type,
      refund_source_doc_no: s.docNo,
      customer_id: s.customer.customerId,
      debtor_code: s.customer.debtorCode,
      /* The payee IS the customer — from the document, never retyped. */
      payee_name: s.customer.name ?? String(body.payeeName ?? '').trim(),
    },
  };
}

/** The refund's own control (roles.AR) — what the typing-time control lock
    exempts, the way a supplier payment's own AP control is exempt. */
export async function refundOwnControl(sb: any, companyId: number | null | undefined): Promise<string | null> {
  if (companyId == null) return null;
  return (await resolveRoles(sb, companyId)).AR;
}

/**
 * The customer's credit ledger, when the document carries a debtor code:
 * the refund pays the credit OUT, so the balance must drop (or the customer
 * spends it twice — once as cash, once on the next invoice); a cancel hands
 * it back. 2990's orders carry no code and no credit rows — nothing to write.
 * Best-effort: the journal is the money truth and is already committed.
 */
export async function bookRefundCredit(
  sb: any,
  pv: { id: string; pv_number: string; company_id: number | null; debtor_code?: string | null; payee_name: string; total_sen: number },
  direction: 'refund' | 'reversal',
): Promise<void> {
  const code = String(pv.debtor_code ?? '').trim();
  if (!code) return;
  const amount = Math.abs(Number(pv.total_sen ?? 0));
  if (!amount) return;
  const r = await addCustomerCredit(sb, {
    debtorCode: code,
    debtorName: pv.payee_name,
    amountSen: direction === 'refund' ? -amount : amount,
    sourceType: direction === 'refund' ? 'CUSTOMER_REFUND' : 'CUSTOMER_REFUND_REVERSAL',
    sourceDocNo: pv.pv_number,
    sourceDocId: pv.id,
    notes: direction === 'refund' ? `Refunded in cash — ${pv.pv_number}` : `Refund voucher ${pv.pv_number} cancelled`,
    companyId: pv.company_id ?? null,
  });
  if (!r.ok) {
    /* eslint-disable-next-line no-console */
    console.error('[pv-refund] customer credit NOT written:', pv.pv_number, direction, r.reason);
  }
}
