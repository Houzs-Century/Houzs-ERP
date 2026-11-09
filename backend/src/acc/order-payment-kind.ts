// ----------------------------------------------------------------------------
// order-payment-kind — is a customer's payment a deposit (订金) or the settlement
// (尾款)? The rule the owner agreed on 2026-11-05, refined on 2026-11-09 (一次性
// 收完的我想要把它当deposit; 一次付清 = 同一天付清 → 对): the payment that brings an
// order's paid total up to its order total ON A LATER DAY than the customer's first
// payment is the settlement; every other payment is a deposit — an order paid in full
// on its first paying day (one payment, or card and cash together) is all deposit; an
// order not yet fully paid has only deposits. The first paying day is the first day
// with money IN: money moved out of the order (a negative mirror) is no payment.
//
// It reads ALL of an order's payments, whatever their month, so September's
// deposit stays a deposit when the balance comes in October. A payment after
// the order is already fully paid (the total went up, a top-up) is balance
// too. Payments run in the order they were paid (paid_at, then when they were
// keyed). Every row on the order counts toward its paid total: an AutoCount
// carry-over, money converted in from another order, and the negative mirror
// of money that left it.
// ----------------------------------------------------------------------------

import { chunkIn } from '../scm/lib/paginate-all';
import type { resolveRoles } from './rules';

export type PaymentKind = 'DEP' | 'BAL';
export type OrderPaymentFacts = {
  orders: Array<{ doc_no: string; local_total_sen: number | null }>;
  payments: Array<{ id: string; so_doc_no: string; amount_sen: number; paid_at: string | null; created_at: string | null }>;
};

/** Each payment's kind, keyed by its row id. */
export function paymentKinds(facts: OrderPaymentFacts): Map<string, PaymentKind> {
  const totalOf = new Map(facts.orders.map((o) => [String(o.doc_no), Number(o.local_total_sen ?? 0)]));
  const byOrder = new Map<string, OrderPaymentFacts['payments']>();
  for (const p of facts.payments) byOrder.set(String(p.so_doc_no), [...(byOrder.get(String(p.so_doc_no)) ?? []), p]);
  const out = new Map<string, PaymentKind>();
  for (const [doc, list] of byOrder) {
    const total = totalOf.get(doc) ?? 0;
    const sorted = [...list].sort((a, b) =>
      String(a.paid_at ?? '').slice(0, 10).localeCompare(String(b.paid_at ?? '').slice(0, 10))
      || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
      || String(a.id).localeCompare(String(b.id)));
    const day = (p: OrderPaymentFacts['payments'][number]): string => String(p.paid_at ?? p.created_at ?? '').slice(0, 10);
    const first = sorted.find((p) => Number(p.amount_sen) > 0);
    const firstDay = first ? day(first) : '';
    let paid = 0;
    for (const p of sorted) {
      paid += Number(p.amount_sen);
      /* With no order total there is nothing to complete: a deposit. Paid in full on
         the first paying day: a deposit too (一次性收完). */
      out.set(String(p.id), total > 0 && paid >= total && day(p) !== firstDay ? 'BAL' : 'DEP');
    }
  }
  return out;
}

type Sb = Parameters<typeof resolveRoles>[0];

/** The orders behind the named payment rows, with every payment each of them has. */
export async function loadOrderPaymentFacts(sb: Sb, companyId: number, paymentIds: string[]): Promise<{ ok: true; facts: OrderPaymentFacts } | { ok: false; reason: string }> {
  if (paymentIds.length === 0) return { ok: true, facts: { orders: [], payments: [] } };
  const named = await chunkIn<{ id: string; so_doc_no: string }>(paymentIds, (batch, f, t) =>
    sb.from('mfg_sales_order_payments').select('id, so_doc_no').eq('company_id', companyId).in('id', batch).order('id').range(f, t));
  if (named.error) return { ok: false, reason: `order payments: ${named.error.message}` };
  const docs = [...new Set(named.data.map((p) => String(p.so_doc_no)))];
  if (docs.length === 0) return { ok: true, facts: { orders: [], payments: [] } };
  const [orders, payments] = await Promise.all([
    chunkIn<OrderPaymentFacts['orders'][number]>(docs, (batch, f, t) =>
      sb.from('mfg_sales_orders').select('doc_no, local_total_sen').eq('company_id', companyId).in('doc_no', batch).order('doc_no').range(f, t)),
    chunkIn<OrderPaymentFacts['payments'][number]>(docs, (batch, f, t) =>
      sb.from('mfg_sales_order_payments').select('id, so_doc_no, amount_sen, paid_at, created_at').eq('company_id', companyId).in('so_doc_no', batch).order('id').range(f, t)),
  ]);
  if (orders.error) return { ok: false, reason: `orders: ${orders.error.message}` };
  if (payments.error) return { ok: false, reason: `order payments: ${payments.error.message}` };
  return { ok: true, facts: { orders: orders.data, payments: payments.data } };
}
