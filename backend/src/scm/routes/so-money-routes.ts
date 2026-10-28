// ----------------------------------------------------------------------------
// so-money-routes — the money panel on a Sales Order (cancelled or live since
// 2026-09-16) and its two exits (owner 2026-09-15; docs/bugs/0927). Rules in
// lib/so-money.ts; these are the doors. Registered from
// routes/mfg-sales-orders.ts behind its per-order guard
// (selfScopedSalesBlocked), which is private to that file.
//
//   GET  /:docNo/money             what it collected, what left by refund
//                                  or conversion, what is left, what a live
//                                  order must keep — and this customer's
//                                  other orders with money, for the Convert
//                                  tick list
//   POST /:docNo/money/refund      { amountSen, reason, bankName,
//                                  bankAccountNo, bankAccountName } — a
//                                  payment request for Finance, the caller's
//                                  own (owner 2026-10-14; lib/refund-request.ts)
//   GET  /:docNo/convert-sources   the orders THIS order may draw on
//                                  (?also=SO-a,SO-b names orders outright)
//   GET  /cancelled-with-money     Finance's list: cancelled orders still
//                                  holding money (?phone= narrows it to one
//                                  customer's, for a page with no order yet)
//   GET  /with-money               the same for orders of ANY status — the
//                                  Sales Orders list's bar, the New SO page
//
// The CONVERSION itself is not a door here: it is a payment row with method
// `converted` on the new order, through POST /:docNo/payments and the
// order's create — the same writers every payment uses.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId } from '../lib/companyScope';
import { convertSources, orderMoney, ordersWithMoney } from '../lib/so-money';
import { raiseRefundRequest, readRefundAsk } from '../lib/refund-request';
import { fmtSen } from '../shared/format';

/* eslint-disable @typescript-eslint/no-explicit-any -- Hono context, untyped in this router family */
type Ctx = any;

export const soMoneyHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const m = await orderMoney(sb, co.companyId, c.req.param('docNo'));
  if (!m.ok) return c.json({ error: m.error, message: m.message }, m.status);
  /* The customer's other orders with money — what the Convert button lists
     beside this one. Only an order with money asks. */
  let others: Awaited<ReturnType<typeof convertSources>> = { ok: true, sources: [] };
  if (m.money.open) {
    others = await convertSources(sb, co.companyId, { customerId: m.money.customer.customerId, debtorCode: m.money.customer.debtorCode, debtorName: m.money.customer.name, phone: m.money.customer.phone, exclude: m.money.docNo });
    if (!others.ok) return c.json({ error: 'load_failed', reason: others.reason }, 500);
  }
  return c.json({ money: m.money, others: others.sources });
};

export const soMoneyRefundHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const read = readRefundAsk(body);
  if (!read.ok) return c.json({ error: read.error, message: read.message }, 400);
  const amountSen = read.ask.amountSen;
  const m = await orderMoney(sb, co.companyId, c.req.param('docNo'));
  if (!m.ok) return c.json({ error: m.error, message: m.message }, m.status);
  if (!m.money.open) return c.json({ error: 'refund_not_allowed', message: m.money.reason ?? `${m.money.docNo} has no money to refund.` }, 409);
  if (amountSen > m.money.remainingSen) {
    const asked = m.money.requestedSen > 0 ? `, ${fmtSen(m.money.requestedSen)} on refund requests waiting for Finance` : '';
    return c.json({
      error: 'refund_exceeds_remaining',
      message: `${m.money.docNo} has ${fmtSen(m.money.remainingSen)} left (${fmtSen(m.money.bookedSen)} paid, ${fmtSen(m.money.refundedSen)} on refund vouchers${asked}, ${fmtSen(m.money.convertedSen)} moved to other orders) — not ${fmtSen(amountSen)}.`,
    }, 409);
  }
  /* A payment request for Finance (owner 2026-10-14: 我可能还会拒绝) — the
     caller's own, whoever they are; Finance answers it with the refund voucher. */
  const raised = await raiseRefundRequest(c, { companyId: co.companyId, docNo: m.money.docNo, customerName: m.money.customer.name, ask: read.ask });
  if (!raised.ok) return c.json(raised.body, raised.status);
  return c.json({ id: String(raised.request.id), requestNo: String(raised.request.request_no), request: raised.request }, 201);
};

export const soConvertSourcesHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const docNo = String(c.req.param('docNo') ?? '').trim();
  const { data: so, error } = await sb.from('mfg_sales_orders').select('doc_no, company_id, customer_id, debtor_code, debtor_name, phone').eq('doc_no', docNo).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const row = so as { company_id: number | null; customer_id: string | null; debtor_code: string | null; debtor_name: string | null; phone: string | null } | null;
  if (!row || Number(row.company_id) !== co.companyId) return c.json({ error: 'not_found' }, 404);
  const also = String(c.req.query('also') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const r = await convertSources(sb, co.companyId, { customerId: row.customer_id, debtorCode: row.debtor_code, debtorName: row.debtor_name, phone: row.phone, also, exclude: docNo });
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json({ sources: r.sources });
};

const withMoney = (cancelledOnly: boolean) => async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = await ordersWithMoney(c.get('supabase'), co.companyId, { phone: String(c.req.query('phone') ?? '').trim() || null, cancelledOnly });
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json({ orders: r.rows, totalRemainingSen: r.rows.reduce((s, x) => s + x.remainingSen, 0) });
};
export const cancelledWithMoneyHandler = withMoney(true);
export const ordersWithMoneyHandler = withMoney(false);
