// ----------------------------------------------------------------------------
// The final invoice at delivery (owner 2026-09-12, the deposit-invoice design;
// docs/bugs/0830). When a company's deposit-invoice flow is ON, a fully
// delivered order is invoiced BY ITSELF the moment the delivery reconciler
// flips it to DELIVERED: one sales invoice off every delivered line not yet
// billed, SENT, its revenue posted per product group, its paid roll counting
// the deposits already taken. The deposit invoices that stood for those
// deposits are then closed by a credit note each (the next step of the
// design; `acc_deposit_invoices.credit_note_id` is the link).
//
// The conversion is lib/si-from-do's core — the same rules, refusals and
// side effects the picker path has, with no request to hand. Everything here
// is best-effort at the hook: a delivery is never blocked by its invoice.
// ----------------------------------------------------------------------------

import { loadDepositInvoiceSettings } from '../../acc/deposit-invoices';
import { companyCodeById } from './doc-no';
import { docPrefixForCode } from './companyScope';
import { absorbsOrderDeposit } from './si-order-deposit';
import { doLineRemaining, siTransferRefusal } from './do-line-remaining';
import { createSalesInvoiceFromDoLines } from './si-from-do';
import { SO_DELIVERED_OR_BEYOND } from '../shared/so-deliverable-states';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the SCM libs */
type Db = any;

export type AutoFinalInvoiceResult =
  | { ok: true; status: 'switched_off' | 'no_company' | 'already_invoiced' | 'nothing_to_invoice' }
  | { ok: true; status: 'invoiced'; invoiceNumber: string; revenue: string; lines: number }
  | { ok: false; status: 'read_failed' | 'refused'; reason: string; body?: Record<string, unknown> };

/**
 * Invoice one delivered order off its delivered, not-yet-billed lines — when
 * the company's switch is on, the order has no live invoice yet, and there
 * is something left to bill. Idempotent: a second call finds the invoice.
 */
export async function autoFinalInvoiceForOrder(
  sb: Db,
  p: { docNo: string; companyId: number | null; actorId: string | null; invoiceDate?: string | null },
): Promise<AutoFinalInvoiceResult> {
  if (p.companyId == null) return { ok: true, status: 'no_company' };
  const st = await loadDepositInvoiceSettings(sb, p.companyId);
  if (!st.ok) return { ok: false, status: 'read_failed', reason: `settings: ${st.reason}` };
  if (!st.settings.enabled) return { ok: true, status: 'switched_off' };

  /* A live invoice already on the order — raised by hand, or by an earlier
     run — is the final invoice; nothing is raised beside it. A draft or a
     cancelled one is no invoice (si-order-deposit's own reading). */
  const { data: sis, error: siErr } = await sb.from('sales_invoices')
    .select('id, status').eq('so_doc_no', p.docNo).eq('company_id', p.companyId);
  if (siErr) return { ok: false, status: 'read_failed', reason: `order invoices: ${siErr.message}` };
  if (((sis ?? []) as Array<{ status?: string | null }>).some((r) => absorbsOrderDeposit(r.status))) {
    return { ok: true, status: 'already_invoiced' };
  }

  const code = await companyCodeById(sb, p.companyId);
  if (!code) return { ok: false, status: 'read_failed', reason: `company ${p.companyId} has no code to number under` };

  /* The order's deliveries that an invoice may be raised from (the same gate
     the picker applies), then every line with quantity still unbilled. */
  const { data: dos, error: doErr } = await sb.from('delivery_orders')
    .select('id, status').eq('so_doc_no', p.docNo).eq('company_id', p.companyId);
  if (doErr) return { ok: false, status: 'read_failed', reason: `deliveries: ${doErr.message}` };
  const doIds = ((dos ?? []) as Array<{ id: string; status: string | null }>)
    .filter((d) => siTransferRefusal(d.status) == null)
    .map((d) => d.id);
  if (doIds.length === 0) return { ok: true, status: 'nothing_to_invoice' };
  const rem = await doLineRemaining(sb, doIds, 'invoiceable');
  if (!rem.ok) return { ok: false, status: 'read_failed', reason: `remaining: ${rem.reason}` };
  const picks = [...rem.lines.values()]
    .filter((l) => l.remaining > 0)
    .map((l) => ({ doItemId: l.doItemId, qty: l.remaining }));
  if (picks.length === 0) return { ok: true, status: 'nothing_to_invoice' };

  const r = await createSalesInvoiceFromDoLines(sb, {
    companyId: p.companyId,
    docPrefix: docPrefixForCode(code),
    picks,
    asDraft: false,
    createdBy: p.actorId,
    actor: null,
    auditNote: `Auto: final invoice at delivery of ${p.docNo} (deposit-invoice flow)`,
    invoiceDate: p.invoiceDate ?? null,
  });
  if (!r.ok) return { ok: false, status: 'refused', reason: String(r.body.error ?? r.status), body: r.body };
  return { ok: true, status: 'invoiced', invoiceNumber: r.body.invoiceNumber, revenue: r.body.revenue.status, lines: picks.length };
}

/** The hook the delivery reconciler calls: never throws, never blocks. */
export async function autoFinalInvoiceBestEffort(
  sb: Db,
  p: { docNo: string; companyId: number | null; actorId: string | null },
): Promise<void> {
  try {
    const r = await autoFinalInvoiceForOrder(sb, p);
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error('[auto-final-invoice] not raised for', p.docNo, r.status, r.reason, r.body ?? '');
    } else if (r.status === 'invoiced' && r.revenue !== 'posted') {
      // eslint-disable-next-line no-console
      console.error(`[auto-final-invoice] ${r.invoiceNumber} raised for ${p.docNo} but its revenue is ${r.revenue}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auto-final-invoice] hook threw for', p.docNo, e);
  }
}

/* ── The backlog: orders delivered before the switch was on ──────────────── */


export type DeliveredUninvoiced = { docNo: string; deliveredOn: string | null };

/**
 * The company's delivered orders with no live sales invoice — what the switch
 * being turned on AFTER those deliveries left behind (owner 2026-09-12: 已送货的
 * 根据程序走). Each carries the day its goods left: the latest delivered_at of
 * its invoiceable deliveries, else the customer delivery date, else nothing
 * (the invoice is then dated today).
 */
export async function deliveredUninvoiced(
  sb: Db,
  companyId: number,
): Promise<{ ok: true; orders: DeliveredUninvoiced[] } | { ok: false; reason: string }> {
  const { data: sos, error: soErr } = await sb.from('mfg_sales_orders')
    .select('doc_no, status')
    .eq('company_id', companyId)
    .in('status', [...SO_DELIVERED_OR_BEYOND])
    .order('doc_no')
    .limit(2000);
  if (soErr) return { ok: false, reason: `orders: ${soErr.message}` };
  const docNos = ((sos ?? []) as Array<{ doc_no: string }>).map((r) => String(r.doc_no));
  if (docNos.length === 0) return { ok: true, orders: [] };

  const invoiced = new Set<string>();
  const deliveredOn = new Map<string, string>();
  for (let i = 0; i < docNos.length; i += 200) {
    const chunk = docNos.slice(i, i + 200);
    const { data: sis, error: siErr } = await sb.from('sales_invoices')
      .select('so_doc_no, status').eq('company_id', companyId).in('so_doc_no', chunk);
    if (siErr) return { ok: false, reason: `order invoices: ${siErr.message}` };
    for (const r of (sis ?? []) as Array<{ so_doc_no: string | null; status?: string | null }>) {
      if (r.so_doc_no && absorbsOrderDeposit(r.status)) invoiced.add(String(r.so_doc_no));
    }
    const { data: dos, error: doErr } = await sb.from('delivery_orders')
      .select('so_doc_no, status, delivered_at, customer_delivery_date').eq('company_id', companyId).in('so_doc_no', chunk);
    if (doErr) return { ok: false, reason: `deliveries: ${doErr.message}` };
    for (const d of (dos ?? []) as Array<{ so_doc_no: string | null; status: string | null; delivered_at?: string | null; customer_delivery_date?: string | null }>) {
      if (!d.so_doc_no || siTransferRefusal(d.status) != null) continue;
      const day = String(d.delivered_at ?? d.customer_delivery_date ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const at = deliveredOn.get(String(d.so_doc_no));
      if (!at || day > at) deliveredOn.set(String(d.so_doc_no), day);
    }
  }
  return {
    ok: true,
    orders: docNos.filter((d) => !invoiced.has(d)).map((docNo) => ({ docNo, deliveredOn: deliveredOn.get(docNo) ?? null })),
  };
}

/** Invoice every delivered, uninvoiced order — each dated the day its goods
    left — in order-number order. Each order answers for itself; one refusal
    does not stop the rest. The switch must be on (the per-order gate says so). */
export async function invoiceDeliveredOrders(
  sb: Db,
  companyId: number,
  actorId: string | null,
): Promise<{ ok: true; invoiced: string[]; skipped: Array<{ docNo: string; why: string }> } | { ok: false; reason: string }> {
  const backlog = await deliveredUninvoiced(sb, companyId);
  if (!backlog.ok) return backlog;
  const invoiced: string[] = [];
  const skipped: Array<{ docNo: string; why: string }> = [];
  for (const o of backlog.orders) {
    const r = await autoFinalInvoiceForOrder(sb, { docNo: o.docNo, companyId, actorId, invoiceDate: o.deliveredOn });
    if (!r.ok) skipped.push({ docNo: o.docNo, why: `${r.status}: ${r.reason}` });
    else if (r.status !== 'invoiced') skipped.push({ docNo: o.docNo, why: r.status });
    else invoiced.push(r.invoiceNumber);
  }
  return { ok: true, invoiced, skipped };
}
