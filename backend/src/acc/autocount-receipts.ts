// ----------------------------------------------------------------------------
// autocount-receipts — customers' money AutoCount recorded after the books
// started (owner 2026-11-08: 可以帮我注明是从auto count带过来的吗？).
//
// Such a payment came over on its order as method 'imported' and posts no
// journal (acc/payments.ts), so the Cash Flow, which reads the ledger, never
// counts it. The Cash Flow names it under the customer receipts, in no total.
// One dated on or before the opening journal's day is inside the opening
// balances already (AutoCount's position on that day), so it is in the books
// and not named. A cancelled order's is left out, as the ledger leaves out a
// cancelled order's own payments, and so is one the owner marked a previous
// record (owner 2026-11-11: 我哪里都不会take-in; acc/previous-payments).
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { OPENING_SOURCE } from './opening-balance';
import { loadPreviousKeys, previousKey } from './previous-payments';

export type AutoCountReceipt = {
  id: string; docNo: string; paidOn: string; amountSen: number; party: string | null; note: string | null;
};

type Sb = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- PostgREST builders are chained structurally, as in paginate-all
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

export async function loadAutoCountReceipts(
  sb: Sb, companyId: number, from: string, to: string,
): Promise<{ ok: true; payments: AutoCountReceipt[] } | { ok: false; reason: string }> {
  /* The books' first day follows the opening journal's; no opening journal, no boundary. */
  const { data: opening, error: oErr } = await sb.from('v_gl_entries').select('entry_date')
    .eq('company_id', companyId).eq('source_type', OPENING_SOURCE)
    .order('entry_date', { ascending: false }).range(0, 0);
  if (oErr) return { ok: false, reason: `opening: ${oErr.message}` };
  const openedOn = (opening as Array<{ entry_date: string }> | null)?.[0] ? day(opening[0].entry_date) : null;

  const { data, error } = await paginateAll<{ id: string; so_doc_no: string; amount_sen: number; paid_at: string | null; note: string | null }>((f, t) => sb
    .from('mfg_sales_order_payments').select('id, so_doc_no, amount_sen, paid_at, note')
    .eq('company_id', companyId).eq('method', 'imported')
    .gte('paid_at', from).lte('paid_at', `${to}T23:59:59`)
    .order('paid_at').order('id').range(f, t));
  if (error) return { ok: false, reason: `AutoCount payments: ${error.message}` };
  const previous = await loadPreviousKeys(sb, companyId);
  if (!previous.ok) return previous;
  const inPeriod = (data ?? []).filter((p) => {
    const on = day(p.paid_at);
    return on >= from && on <= to && (openedOn == null || on > openedOn) && Number(p.amount_sen ?? 0) !== 0
      && !previous.keys.has(previousKey('SOPAY', String(p.id)));
  });
  if (inPeriod.length === 0) return { ok: true, payments: [] };

  const docs = [...new Set(inPeriod.map((p) => String(p.so_doc_no)))];
  const orders = await chunkIn<{ doc_no: string; status: string | null; debtor_name: string | null }>(docs, (batch, f, t) => sb
    .from('mfg_sales_orders').select('doc_no, status, debtor_name')
    .eq('company_id', companyId).in('doc_no', batch).range(f, t));
  if (orders.error) return { ok: false, reason: `orders: ${orders.error.message}` };
  const orderOf = new Map(orders.data.map((o) => [String(o.doc_no), o]));

  return {
    ok: true,
    payments: inPeriod
      .filter((p) => String(orderOf.get(String(p.so_doc_no))?.status ?? '') !== 'CANCELLED')
      .map((p) => ({
        id: String(p.id),
        docNo: String(p.so_doc_no),
        paidOn: day(p.paid_at),
        amountSen: Number(p.amount_sen),
        party: orderOf.get(String(p.so_doc_no))?.debtor_name ?? null,
        note: p.note ?? null,
      }))
      .sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.docNo.localeCompare(b.docNo)),
  };
}
