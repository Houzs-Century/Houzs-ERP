// ----------------------------------------------------------------------------
// so-money — the money on a sales order, and its two exits (owner 2026-09-15;
// docs/bugs/0927): refund（可部分，弹去 Finance 开 PV）或 convert 去新 SO（可部分；
// 一对多、多对一）；两个按钮挨着一起. Since 2026-09-16 the order need not be
// cancelled: a LIVE order may move money out as long as it keeps its deposit
// fraction of the total (Houzs 30% / 2990 50%, the Processing-Date gate's own
// number, total including transport), and may refund any part of it — the
// voucher is Finance's to approve. A cancelled order keeps no floor. Money
// that leaves a live order is mirrored on it as a negative payment row
// (lib/so-payment-row.ts mirror rows), so its Paid and Balance move.
//
// ONE POOL. What an order collected is one sum, and what is left of it is
// read off the ledger every time, never kept in a column:
//
//     remaining = paid − refund vouchers (draft or posted)
//                      − converted rows on other orders naming this one
//
// where PAID is the payments this ledger booked (an active SOPAY / SOCONV)
// plus the payments brought over from AutoCount (method `imported`) — the
// owner, 2026-10-05: 「两个payment 我要看到也可以refund 和 convert … 那个在
// erp 开张前已记录，所以照理没欠了」. A refund or a conversion of AutoCount
// money books as for any payment (Dr AR); the AR Aging already footnotes the
// AutoCount deposits this ledger never booked, and that figure does not grow.
// It is the same headroom the refund voucher reads (lib/pv-refund.ts), so a
// refund and a conversion can never together move more than there is.
//
// THE SAME CUSTOMER is matched by customer id, else phone, else debtor code
// AND name — never by a debtor code alone: Houzs's cash debtor 300-C002 sits
// on 2,882 orders of 2,654 different people, and the Convert list walked
// every one of them, five queries an order, until the read gave up and the
// money panel vanished (2026-10-05). Many orders are read in one batch
// (ordersMoney), never one by one.
//
// A CONVERSION is a payment row on the NEW order — method `converted`
// (acc/payments.ts CONVERTED_METHOD), the cancelled order's first payment
// date and collector (owner: 原本当天, collected by 不影响), naming the order
// it came from — recorded through the same writer every payment uses
// (lib/so-payment-row.ts recordSoPaymentRow), so the audit row, the AutoCount
// balance and the invoice re-roll all happen as for money received. What
// differs is the accounting and the paper, and both live below the route:
//
//   • no money moved, so no bank moves — the row's entry is the transfer
//     Dr AR (cancelled order's customer) / Cr AR (new order's customer)
//     (acc/payments.ts postConvertedPayment), dated the day of the move;
//   • no receipt is born (the money's receipt is on the cancelled order);
//   • under the deposit-invoice regime the moved amount is taken off the
//     cancelled order's deposit invoices by CREDIT NOTE — the e-invoice
//     shape — and the new order gets its own deposit invoice, dated the day
//     of the move (afterConvertedRowBooked, below);
//   • sales is not recognised twice: old DI +X, its note −X, new DI +X.
//
// A converted row is undone the way any payment is — deleted (the same-day
// / amend gate) — and its transfer, its notes and its invoice go with it.
//
// A REFUND from the panel raises the Customer Refund voucher as a DRAFT for
// Finance — the existing paper (lib/pv-refund.ts), through the voucher
// door's own core (routes/payment-vouchers.ts createPaymentVoucherCore), on
// the salesperson's behalf: the voucher-create key is Finance's, the refund
// request is not. Finance changes the Paid From account in Draft if the
// default bank is not the one, and only Finance approves.
// ----------------------------------------------------------------------------

import { CONVERTED_METHOD, CONVERT_SOURCE } from '../../acc/payments';
import { issueDepositInvoice } from '../../acc/deposit-invoices';
import { releaseConversionNotes, takeFromDepositInvoices } from '../../acc/deposit-refunds';
import { resolveRoles } from '../../acc/rules';
import { mytDateOf, todayMyt } from './my-time';
import { companyCodeById } from './doc-no';
import { processingDateThresholdFor } from '../shared/order-rules';
import { fmtSen } from '../shared/format';
import { chunkIn, paginateAll } from './paginate-all';

/** A payment brought over from AutoCount: never booked by this ledger, the
    order's money all the same (owner 2026-10-05). */
export const IMPORTED_METHOD = 'imported';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[so-money]', ...args);
};

export type MoneyPayment = {
  id: string; paidOn: string; method: string; provider: string | null; amountSen: number;
  /** Reached this ledger (an active SOPAY / SOCONV journal). */
  booked: boolean;
  /** Brought over from AutoCount (method `imported`) — counts beside the booked ones. */
  imported: boolean;
  collectedBy: string | null;
  /** A converted row: the cancelled order it moved money from. */
  convertedFrom: string | null;
  /** The proof the money arrived with (an R2 key), if one was attached. */
  slipKey: string | null;
};
export type MoneyRefund = { id: string; pvNumber: string; status: string; voucherDate: string; totalSen: number };
export type MoneyConversion = { paymentId: string; toDocNo: string; amountSen: number; paidOn: string; convertedOn: string };

export type OrderMoney = {
  docNo: string;
  status: string | null;
  cancelled: boolean;
  customer: { name: string | null; phone: string | null; customerId: string | null; debtorCode: string | null };
  payments: MoneyPayment[];
  /** The money in the pool: what this ledger booked plus what came over from
      AutoCount (the name is older than the AutoCount half). */
  bookedSen: number;
  /** The part of it brought over from AutoCount. */
  importedSen: number;
  refunds: MoneyRefund[];
  refundedSen: number;
  conversions: MoneyConversion[];
  convertedSen: number;
  remainingSen: number;
  /** The order's total (local currency, every line — transport included). */
  totalSen: number;
  /** The deposit fraction a LIVE order keeps (Houzs 0.3 / 2990 0.5); 0 once cancelled. */
  keepFraction: number;
  /** What must stay on a live order: ceil(keepFraction × total). 0 once cancelled. */
  keepSen: number;
  /** What may move to another order: remaining − keepSen, never below 0. A refund has no floor. */
  movableSen: number;
  /** The money may still be refunded or moved: something is left. */
  open: boolean;
  reason: string | null;
};

const dayOf = (v: unknown): string => String(v ?? '').slice(0, 10);

/** The status a refusal answers with — the literal union the typed Hono context takes. */
export type Refusal = 400 | 404 | 409 | 500;

type OrderRow = {
  doc_no: string; company_id: number | null; status: string | null; debtor_name: string | null; debtor_code: string | null;
  phone: string | null; customer_id: string | null; local_total_sen: number | null;
};

/** Every converted row on another order that names this one as its source. */
export async function conversionsFrom(sb: Db, companyId: number, docNo: string): Promise<{ ok: true; rows: MoneyConversion[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('mfg_sales_order_payments')
    .select('id, so_doc_no, amount_sen, paid_at, created_at')
    .eq('company_id', companyId).eq('converted_from_so_doc_no', docNo);
  if (error) return { ok: false, reason: error.message };
  return {
    ok: true,
    rows: ((data ?? []) as Row[]).map((r) => ({ paymentId: String(r.id), toDocNo: String(r.so_doc_no), amountSen: Number(r.amount_sen ?? 0), paidOn: dayOf(r.paid_at), convertedOn: r.created_at ? mytDateOf(String(r.created_at)) : '' })),
  };
}

/**
 * The money on many orders at once and what is left of each: the orders,
 * their payments (booked, brought over from AutoCount, or neither), the
 * refund vouchers on them and the converted rows that took from them — a
 * handful of batched reads, whatever the number of orders. An order that is
 * not this company's, or not there, is simply absent from the map.
 */
export async function ordersMoney(sb: Db, companyId: number, docNosRaw: readonly unknown[]): Promise<{ ok: true; money: Map<string, OrderMoney> } | { ok: false; reason: string }> {
  const out = new Map<string, OrderMoney>();
  const wanted = [...new Set(docNosRaw.map((d) => String(d ?? '').trim()).filter(Boolean))];
  if (wanted.length === 0) return { ok: true, money: out };
  const sos = await chunkIn<OrderRow>(wanted, (batch, f, t) => sb.from('mfg_sales_orders')
    .select('doc_no, company_id, status, debtor_name, debtor_code, phone, customer_id, local_total_sen')
    .eq('company_id', companyId).in('doc_no', batch)
    .order('doc_no').range(f, t));
  if (sos.error) return { ok: false, reason: sos.error.message };
  const orders = sos.data.filter((o) => Number(o.company_id) === companyId);
  if (orders.length === 0) return { ok: true, money: out };
  const docs = orders.map((o) => String(o.doc_no));

  const pays = await chunkIn<Row>(docs, (batch, f, t) => sb.from('mfg_sales_order_payments')
    .select('id, so_doc_no, paid_at, method, merchant_provider, amount_sen, collected_by, converted_from_so_doc_no, slip_key')
    .eq('company_id', companyId).in('so_doc_no', batch)
    .order('paid_at').order('id').range(f, t));
  if (pays.error) return { ok: false, reason: pays.error.message };
  /* A mirror row (the money that left, negative) is not money in: the pool
     reads what left off the vouchers and the converted rows themselves. */
  const payRows = pays.data.filter((r) => Number(r.amount_sen ?? 0) >= 0);

  /* Which payments carry an ACTIVE journal — the payment's own (SOPAY) or the
     transfer a converted row booked (SOCONV). */
  const jes = await chunkIn<Row>(payRows.map((r) => String(r.id)), (batch, f, t) => sb.from('journal_entries')
    .select('id, source_doc_no, reversed')
    .eq('company_id', companyId).in('source_type', ['SOPAY', CONVERT_SOURCE]).in('source_doc_no', batch)
    .order('id').range(f, t));
  if (jes.error) return { ok: false, reason: jes.error.message };
  const booked = new Set(jes.data.filter((r) => !r.reversed).map((r) => String(r.source_doc_no)));

  /* Every non-cancelled refund voucher on the orders, draft or posted. */
  const pvs = await chunkIn<Row>(docs, (batch, f, t) => sb.from('payment_vouchers')
    .select('id, pv_number, status, voucher_date, total_sen, refund_source_doc_no')
    .eq('company_id', companyId).eq('purpose', 'CUSTOMER_REFUND').neq('status', 'CANCELLED').in('refund_source_doc_no', batch)
    .order('id').range(f, t));
  if (pvs.error) return { ok: false, reason: pvs.error.message };

  /* Every converted row on another order that names one of these as its source. */
  const convs = await chunkIn<Row>(docs, (batch, f, t) => sb.from('mfg_sales_order_payments')
    .select('id, so_doc_no, amount_sen, paid_at, created_at, converted_from_so_doc_no')
    .eq('company_id', companyId).in('converted_from_so_doc_no', batch)
    .order('id').range(f, t));
  if (convs.error) return { ok: false, reason: convs.error.message };

  /* The floor a live order keeps: the Processing-Date gate's own fraction of
     the same total (shared/order-rules.ts) — one rule, one number per company. */
  let liveFraction = 0;
  if (orders.some((o) => String(o.status ?? '').toUpperCase() !== 'CANCELLED')) {
    try { liveFraction = processingDateThresholdFor(await companyCodeById(sb, companyId)); }
    catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  }

  const group = <T>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = key(r); const list = m.get(k); if (list) list.push(r); else m.set(k, [r]); }
    return m;
  };
  const paysByDoc = group(payRows, (r) => String(r.so_doc_no));
  const pvsByDoc = group(pvs.data, (r) => String(r.refund_source_doc_no));
  const convsByDoc = group(convs.data, (r) => String(r.converted_from_so_doc_no));

  for (const row of orders) {
    const docNo = String(row.doc_no);
    const payments: MoneyPayment[] = (paysByDoc.get(docNo) ?? []).map((r) => ({
      id: String(r.id), paidOn: dayOf(r.paid_at), method: String(r.method ?? ''), provider: r.merchant_provider ?? null,
      amountSen: Number(r.amount_sen ?? 0), booked: booked.has(String(r.id)), imported: String(r.method ?? '') === IMPORTED_METHOD,
      collectedBy: r.collected_by ?? null, convertedFrom: r.converted_from_so_doc_no ?? null, slipKey: r.slip_key ? String(r.slip_key) : null,
    }));
    const refunds: MoneyRefund[] = (pvsByDoc.get(docNo) ?? []).map((r) => ({
      id: String(r.id), pvNumber: String(r.pv_number), status: String(r.status), voucherDate: dayOf(r.voucher_date), totalSen: Number(r.total_sen ?? 0),
    }));
    const conversions: MoneyConversion[] = (convsByDoc.get(docNo) ?? []).map((r) => ({
      paymentId: String(r.id), toDocNo: String(r.so_doc_no), amountSen: Number(r.amount_sen ?? 0), paidOn: dayOf(r.paid_at),
      convertedOn: r.created_at ? mytDateOf(String(r.created_at)) : '',
    }));
    const counts = payments.filter((p) => (p.booked || p.imported) && p.amountSen > 0);
    const bookedSen = counts.reduce((s, p) => s + p.amountSen, 0);
    const importedSen = counts.filter((p) => p.imported && !p.booked).reduce((s, p) => s + p.amountSen, 0);
    const refundedSen = refunds.reduce((s, r) => s + r.totalSen, 0);
    const convertedSen = conversions.reduce((s, r) => s + r.amountSen, 0);
    const remainingSen = Math.max(0, bookedSen - refundedSen - convertedSen);
    const status = row.status ?? null;
    const cancelled = String(status ?? '').toUpperCase() === 'CANCELLED';
    const keepFraction = cancelled ? 0 : liveFraction;
    const totalSen = Math.max(0, Number(row.local_total_sen ?? 0));
    const keepSen = cancelled ? 0 : Math.ceil(totalSen * keepFraction);
    const movableSen = Math.max(0, remainingSen - keepSen);
    let reason: string | null = null;
    if (bookedSen === 0) reason = payments.length === 0 ? `${docNo} collected nothing.` : `${docNo}'s payments never reached this ledger — nothing here to refund or move.`;
    else if (remainingSen === 0) reason = `${docNo}'s money is spoken for — refunded or moved in full.`;
    out.set(docNo, {
      docNo, status, cancelled,
      customer: { name: row.debtor_name ?? null, phone: row.phone ?? null, customerId: row.customer_id ?? null, debtorCode: row.debtor_code?.trim() || null },
      payments, bookedSen, importedSen, refunds, refundedSen, conversions, convertedSen, remainingSen,
      totalSen, keepFraction, keepSen, movableSen,
      open: remainingSen > 0, reason,
    });
  }
  return { ok: true, money: out };
}

/** The money on one order and what is left of it (ordersMoney, for one).
    An order that is not this company's is not found. */
export async function orderMoney(sb: Db, companyId: number, docNoRaw: unknown): Promise<{ ok: true; money: OrderMoney } | { ok: false; status: Refusal; error: string; message: string }> {
  const docNo = String(docNoRaw ?? '').trim();
  if (!docNo) return { ok: false, status: 400, error: 'doc_required', message: 'Which order? Name the Sales Order.' };
  const r = await ordersMoney(sb, companyId, [docNo]);
  if (!r.ok) return { ok: false, status: 500, error: 'load_failed', message: r.reason };
  const money = r.money.get(docNo);
  if (!money) return { ok: false, status: 404, error: 'not_found', message: `${docNo} is not a Sales Order of this company.` };
  return { ok: true, money };
}

export type ConvertPlan = {
  fromDocNo: string;
  amountSen: number;
  /** The cancelled order's first booked payment: its day and collector ride on the converted row. */
  paidAt: string;
  collectedBy: string | null;
  /** The cancelled order's customer, for the screen. */
  fromCustomer: string | null;
  /** The proof the money arrived with (owner 2026-09-16: attachment 可以带过来):
      the first booked payment's slip, else the first slip any payment on the
      source carries — the same R2 object, referenced from both orders. */
  slipKey: string | null;
};

/**
 * May this much move from that order to this one? The source must be an
 * order of the company with that much left — and, while it is live, that
 * much above its floor; an order cannot feed itself. Returns what the
 * converted row carries.
 */
export async function convertGuard(
  sb: Db, companyId: number, p: { fromDocNo: unknown; toDocNo: string; amountSen: number },
): Promise<{ ok: true; plan: ConvertPlan } | { ok: false; status: Refusal; error: string; message: string }> {
  const fromDocNo = String(p.fromDocNo ?? '').trim();
  if (!fromDocNo) return { ok: false, status: 400, error: 'convert_source_required', message: 'Which order is the money from? Name it.' };
  if (fromDocNo === p.toDocNo) return { ok: false, status: 400, error: 'convert_same_order', message: `${fromDocNo} cannot move money to itself.` };
  const amount = Number(p.amountSen);
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, status: 400, error: 'convert_amount_required', message: 'How much moves? An amount above zero, in sen.' };
  const m = await orderMoney(sb, companyId, fromDocNo);
  if (!m.ok) return m;
  const money = m.money;
  if (!money.open) return { ok: false, status: 409, error: 'convert_not_allowed', message: money.reason ?? `${fromDocNo} has no money to move.` };
  if (amount > money.remainingSen) {
    return {
      ok: false, status: 409, error: 'convert_exceeds_remaining',
      message: `${fromDocNo} has ${fmtSen(money.remainingSen)} left to move (${fmtSen(money.bookedSen)} paid, ${fmtSen(money.refundedSen)} on refund vouchers, ${fmtSen(money.convertedSen)} moved already) — not ${fmtSen(amount)}.`,
    };
  }
  if (amount > money.movableSen) {
    return {
      ok: false, status: 409, error: 'convert_keeps_deposit',
      message: `${fromDocNo} keeps ${fmtSen(money.keepSen)} (${Math.round(money.keepFraction * 100)}% of ${fmtSen(money.totalSen)}) while it stands — ${money.movableSen > 0 ? `${fmtSen(money.movableSen)} can move` : 'nothing can move'}, not ${fmtSen(amount)}.`,
    };
  }
  const first = money.payments.find((x) => x.booked && x.amountSen > 0)
    ?? money.payments.find((x) => x.imported && x.amountSen > 0)
    ?? money.payments[0] ?? null;
  const slipKey = first?.slipKey ?? money.payments.find((x) => x.slipKey)?.slipKey ?? null;
  return {
    ok: true,
    plan: {
      fromDocNo, amountSen: amount,
      paidAt: first?.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(first.paidOn) ? first.paidOn : todayMyt(),
      collectedBy: first?.collectedBy ?? null,
      fromCustomer: money.customer.name,
      slipKey,
    },
  };
}

/**
 * May this payment come off a CANCELLED order (owner 2026-09-29, 1a: the same
 * swipe keyed on two orders — the copy on the cancelled one goes)? Only Finance,
 * the correction right, and only while the money it brought is still on the
 * order: a refund voucher or a conversion has already drawn on the booked
 * money, and taking a payment out from under them would leave more refunded or
 * moved than was ever paid. A payment that never booked (and did not come
 * over from AutoCount) is not in the pool.
 */
export async function cancelledRemovalGuard(
  sb: Db, companyId: number, p: { docNo: string; paymentId: string; mayAmend: boolean },
): Promise<{ ok: true } | { ok: false; status: 403 | Refusal; error: string; message: string }> {
  if (!p.mayAmend) {
    return { ok: false, status: 403, error: 'cancelled_payment_finance_only', message: 'Only Finance (the payment-correction right) can remove a payment from a cancelled order.' };
  }
  const m = await orderMoney(sb, companyId, p.docNo);
  if (!m.ok) return m;
  const pay = m.money.payments.find((x) => x.id === p.paymentId);
  if (!pay || !(pay.booked || pay.imported)) return { ok: true };
  const takenSen = m.money.refundedSen + m.money.convertedSen;
  if (m.money.bookedSen - pay.amountSen < takenSen) {
    return {
      ok: false, status: 409, error: 'cancelled_money_taken',
      message: `${fmtSen(takenSen)} of ${p.docNo}'s money is refunded or moved to another order. Undo that first, then remove this payment.`,
    };
  }
  return { ok: true };
}

export type ConvertSource = {
  docNo: string; customer: string | null; status: string | null;
  /** The day it was cancelled; null while it stands. */
  cancelledOn: string | null;
  remainingSen: number; bookedSen: number;
  /** What may move to another order — the remaining, less the floor a live order keeps. */
  movableSen: number;
  keepSen: number;
};

/**
 * The orders a new order may draw on: this customer's, with money left —
 * matched by customer id, else phone, else debtor code AND name (a debtor
 * code alone is not a customer: Houzs's cash debtor 300-C002 is on thousands
 * of orders of different people) — plus any order named outright (`also`),
 * whoever's it is. A live order is listed for what it may give above its floor.
 */
export async function convertSources(
  sb: Db, companyId: number,
  p: { customerId?: string | null; debtorCode?: string | null; debtorName?: string | null; phone?: string | null; also?: string[]; exclude?: string | null },
): Promise<{ ok: true; sources: ConvertSource[] } | { ok: false; reason: string }> {
  const customerId = String(p.customerId ?? '').trim();
  const phone = String(p.phone ?? '').trim();
  const debtorCode = String(p.debtorCode ?? '').trim();
  const debtorName = String(p.debtorName ?? '').trim();
  let rows: Row[] = [];
  if (customerId || phone || (debtorCode && debtorName)) {
    const found = await paginateAll<Row>((f, t) => {
      let q = sb.from('mfg_sales_orders').select('doc_no, debtor_name, updated_at, status').eq('company_id', companyId);
      if (customerId) q = q.eq('customer_id', customerId);
      else if (phone) q = q.eq('phone', phone);
      else q = q.eq('debtor_code', debtorCode).eq('debtor_name', debtorName);
      return q.order('doc_no').range(f, t);
    });
    if (found.error) return { ok: false, reason: found.error.message };
    rows = found.data ?? [];
  }
  const docs = new Set<string>(rows.map((r) => String(r.doc_no)));
  for (const d of p.also ?? []) if (d) docs.add(String(d).trim());
  if (p.exclude) docs.delete(p.exclude);
  const money = await ordersMoney(sb, companyId, [...docs]);
  if (!money.ok) return { ok: false, reason: money.reason };
  const sources: ConvertSource[] = [];
  for (const docNo of [...docs].sort()) {
    const m = money.money.get(docNo);
    if (!m || !m.open || m.movableSen <= 0) continue;
    sources.push(sourceOf(m, rows.find((r) => String(r.doc_no) === docNo) ?? null));
  }
  return { ok: true, sources };
}

const sourceOf = (m: OrderMoney, row: Row | null): ConvertSource => ({
  docNo: m.docNo, customer: m.customer.name, status: m.status,
  cancelledOn: m.cancelled && row?.updated_at ? mytDateOf(String(row.updated_at)) : null,
  remainingSen: m.remainingSen, bookedSen: m.bookedSen, movableSen: m.movableSen, keepSen: m.keepSen,
});

/**
 * Every order of the company still holding money it may refund or move —
 * Finance's list when `cancelledOnly` (cancelled orders whose money has to
 * go somewhere), any status for the Sales Orders list's bar and the New SO
 * page; narrowed to one customer's by phone for a page that has no order yet
 * (the New SO page picking "Convert from another SO"; docs/bugs/0931).
 */
export async function ordersWithMoney(sb: Db, companyId: number, p: { phone?: string | null; cancelledOnly: boolean }): Promise<{ ok: true; rows: ConvertSource[] } | { ok: false; reason: string }> {
  const phone = String(p.phone ?? '').trim();
  const found = await paginateAll<Row>((f, t) => {
    let q = sb.from('mfg_sales_orders').select('doc_no, debtor_name, updated_at, status').eq('company_id', companyId);
    if (p.cancelledOnly) q = q.eq('status', 'CANCELLED');
    if (phone) q = q.eq('phone', phone);
    return q.order('doc_no').range(f, t);
  });
  if (found.error) return { ok: false, reason: found.error.message };
  const orders = [...(found.data ?? [])].sort((a, b) => String(a.doc_no).localeCompare(String(b.doc_no)));
  const money = await ordersMoney(sb, companyId, orders.map((r) => String(r.doc_no)));
  if (!money.ok) return { ok: false, reason: money.reason };
  const rows: ConvertSource[] = [];
  for (const r of orders) {
    const m = money.money.get(String(r.doc_no));
    if (!m || m.bookedSen === 0) continue;
    rows.push(sourceOf(m, r));
  }
  return { ok: true, rows: rows.filter((x) => x.remainingSen > 0) };
}

/**
 * After a converted row is booked: the paper. The moved amount comes off the
 * cancelled order's deposit invoices by credit note (oldest first, keyed on
 * this row — a retry finds its notes), and the new order gets its own
 * deposit invoice dated the day of the move. Each half decides for itself
 * whether the company's switch is on; neither blocks the row.
 */
export async function afterConvertedRowBooked(sb: Db, row: Row, where: string): Promise<void> {
  const id = String(row.id ?? '');
  const toDocNo = String(row.so_doc_no ?? '');
  const fromDocNo = String(row.converted_from_so_doc_no ?? '');
  const amountSen = Number(row.amount_sen ?? 0);
  const companyId = row.company_id == null ? null : Number(row.company_id);
  if (!id || !toDocNo || !fromDocNo || companyId == null || !(amountSen > 0)) return;
  const day = row.created_at ? mytDateOf(String(row.created_at)) : todayMyt();
  try {
    const taken = await takeFromDepositInvoices(sb, {
      companyId, noteDate: day, soDocNo: fromDocNo, amountSen, actor: row.created_by ? String(row.created_by) : null,
      taker: { kind: 'convert', paymentId: id, toDocNo },
    });
    if (!taken.ok) log(`${where}: ${fromDocNo}'s deposit invoices not credited for the move to ${toDocNo} —`, taken.reason);
  } catch (e) {
    log(`${where}: credit-note hook threw:`, e);
  }
  try {
    const issued = await issueDepositInvoice(sb, {
      paymentId: id, soDocNo: toDocNo, paidAt: day, amountSen, method: CONVERTED_METHOD, createdBy: row.created_by ? String(row.created_by) : null,
    });
    if (!issued.ok) log(`${where}: deposit invoice for the move to ${toDocNo} not issued —`, issued.status, issued.reason);
  } catch (e) {
    log(`${where}: deposit-invoice hook threw:`, e);
  }
}

/** After a converted row is deleted: the notes its move raised are cancelled
    by contra (the invoice on the new order is cancelled by the payment hook). */
export async function afterConvertedRowRemoved(sb: Db, p: { paymentId: string; companyId: number | null; actor: string | null }): Promise<void> {
  if (p.companyId == null) return;
  try {
    const r = await releaseConversionNotes(sb, { companyId: p.companyId, paymentId: p.paymentId, actor: p.actor });
    if (!r.ok) log(`delete ${p.paymentId}: conversion notes not released —`, r.reason);
  } catch (e) {
    log(`delete ${p.paymentId}: release hook threw:`, e);
  }
}

/** The body the voucher core takes for a refund raised from the order's
    money panel: the customer as payee, the company's default bank as Paid
    From (Finance changes it in Draft), the amount, the request's note. */
export async function refundDraftBody(sb: Db, companyId: number, money: OrderMoney, amountSen: number, note: string | null, requestedBy: string | null): Promise<Record<string, unknown>> {
  const roles = await resolveRoles(sb, companyId);
  return {
    purpose: 'CUSTOMER_REFUND',
    refundSourceType: 'SO',
    refundSourceDocNo: money.docNo,
    refundAmountSen: amountSen,
    payeeName: money.customer.name ?? money.docNo,
    creditAccountCode: roles.BANK_DEFAULT,
    voucherDate: todayMyt(),
    notes: `Refund requested from ${money.docNo}${requestedBy ? ` by ${requestedBy}` : ''}${note ? ` — ${note}` : ''}`,
  };
}
