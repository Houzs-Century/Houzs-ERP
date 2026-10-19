/* Which open sales orders a stock-PO receipt serves (owner, 2026-10-18/19).
   A PO raised for stock has no sales-order line, so the lead-time figures had
   no customer date for it (3 of 187 mattress receipts in October). MRP decides
   which order a receipt serves but keeps nothing; this keeps it, with MRP's
   rule: the receipt goes to the open orders of the same item that existed when
   it arrived, earliest delivery date first.

   - recordReceiptAssignments: at goods-receipt time (postGrnAndRollup), writes
     the assignment to scm.po_receipt_so_assignments — exact from then on.
   - allocateReceipts: the same rule, pure, also used to ESTIMATE receipts that
     arrived before the table existed (routes/procurement-overview.ts).

   An order line bought for its own customer (a PO line carries it) is not
   stock demand and is left out; a line already delivered before the receipt,
   or already given to an earlier receipt, is not open. */
import { scopeToCompanyId } from './companyScope';
import { chunkIn } from './paginate-all';
import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { SO_TERMINAL_STATES } from '../shared/so-terminal-states';

export interface StockReceipt { key: string; grnId: string; poItemId: string; itemCode: string; qty: number; receivedAt: string }
export interface DemandLine {
  soItemId: string; soDocNo: string; itemCode: string; soDate: string; needDate: string | null; qty: number;
  /** Quantity that went out on a shipped DO, and when. */
  delivered: Array<{ date: string; qty: number }>;
  /** Quantity already given to receipts (stored assignments). */
  assigned: number;
}
export interface Assignment { key: string; grnId: string; poItemId: string; soItemId: string; soDocNo: string; itemCode: string; qty: number; needDate: string | null; receivedAt: string }

/** How far ahead a receipt reaches: goods that just came in serve the orders
 *  due within this many days (or already overdue), not one due months away. */
export const RECEIPT_HORIZON_DAYS = 60;

/** MRP's rule over receipts in date order: each takes the open order lines of
 *  its item that existed on its day and have a delivery date no further than
 *  the horizon, earliest delivery date first. An order with no delivery date
 *  gives no customer date and is not assigned. */
export function allocateReceipts(receipts: StockReceipt[], demand: DemandLine[]): Assignment[] {
  const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const taken = new Map<string, number>(demand.map((d) => [d.soItemId, d.assigned]));
  const byItem = new Map<string, DemandLine[]>();
  for (const d of demand) byItem.set(d.itemCode, [...(byItem.get(d.itemCode) ?? []), d]);
  for (const ds of byItem.values()) ds.sort((a, b) => (a.needDate ?? '9999').localeCompare(b.needDate ?? '9999') || a.soDate.localeCompare(b.soDate));
  const out: Assignment[] = [];
  for (const r of [...receipts].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    let left = r.qty;
    for (const d of byItem.get(r.itemCode) ?? []) {
      if (left <= 0) break;
      if (d.soDate > r.receivedAt || !d.needDate || d.needDate > plus(r.receivedAt, RECEIPT_HORIZON_DAYS)) continue;
      const shipped = d.delivered.filter((x) => x.date < r.receivedAt).reduce((a, x) => a + x.qty, 0);
      const open = d.qty - shipped - (taken.get(d.soItemId) ?? 0);
      if (open <= 0) continue;
      const q = Math.min(open, left);
      left -= q; taken.set(d.soItemId, (taken.get(d.soItemId) ?? 0) + q);
      out.push({ key: r.key, grnId: r.grnId, poItemId: r.poItemId, soItemId: d.soItemId, soDocNo: d.soDocNo, itemCode: r.itemCode, qty: q, needDate: d.needDate, receivedAt: r.receivedAt });
    }
  }
  return out;
}

type Row = Record<string, unknown>;
const day = (v: unknown) => (v == null ? null : String(v).slice(0, 10));
const num = (v: unknown) => Number(v ?? 0) || 0;

/** The open stock demand for these items: order lines not cancelled, on live
 *  orders, not bought for their customer, with what has shipped and what is
 *  already assigned. `asOf` = only orders that existed by then.
 *  `history`: also orders since delivered or closed — for estimating past
 *  receipts, when those orders were still open; never cancelled or draft. */
export async function loadStockDemand(sb: any, companyId: number, itemCodes: string[], asOf: string, history: boolean): Promise<DemandLine[]> {
  if (!itemCodes.length) return [];
  const terminal = new Set<string>(history ? ['CANCELLED', 'DRAFT'] : SO_TERMINAL_STATES);
  const lines = await chunkIn<Row>(itemCodes, (b, f, t) => scopeToCompanyId(sb.from('mfg_sales_order_items')
    .select('id, doc_no, item_code, qty, so:mfg_sales_orders!inner(status, so_date, customer_delivery_date, amended_delivery_date)')
    .in('item_code', b).eq('cancelled', false), companyId).order('id').range(f, t));
  if (lines.error) throw new Error(`order lines: ${lines.error.message}`);
  const soOf = (r: Row) => (Array.isArray(r.so) ? r.so[0] : r.so) as Row | null;
  const live = lines.data.filter((r) => { const so = soOf(r); return !!so && !terminal.has(String(so.status)) && (day(so.so_date) ?? '9999') <= asOf; });
  const ids = live.map((r) => String(r.id));
  const bought = await chunkIn<Row>(ids, (b, f, t) => scopeToCompanyId(sb.from('purchase_order_items').select('so_item_id').in('so_item_id', b), companyId).order('id').range(f, t));
  if (bought.error) throw new Error(`PO lines for orders: ${bought.error.message}`);
  const boughtFor = new Set(bought.data.map((r) => String(r.so_item_id)));
  const shipped = await chunkIn<Row>(ids, (b, f, t) => scopeToCompanyId(sb.from('delivery_order_items')
    .select('so_item_id, qty, do:delivery_orders!inner(status, do_date)').in('so_item_id', b), companyId).order('id').range(f, t));
  if (shipped.error) throw new Error(`shipped order lines: ${shipped.error.message}`);
  const done = await chunkIn<Row>(ids, (b, f, t) => scopeToCompanyId(sb.from('po_receipt_so_assignments').select('so_item_id, qty').in('so_item_id', b), companyId).order('id').range(f, t));
  if (done.error) throw new Error(`stored assignments: ${done.error.message}`);
  const deliveredOf = new Map<string, Array<{ date: string; qty: number }>>();
  for (const l of shipped.data) {
    const d = (Array.isArray(l.do) ? l.do[0] : l.do) as Row | null;
    if (!d || !doCountsAsDelivered(String(d.status ?? ''))) continue;
    const k = String(l.so_item_id);
    deliveredOf.set(k, [...(deliveredOf.get(k) ?? []), { date: day(d.do_date) ?? '0000', qty: num(l.qty) }]);
  }
  const assignedOf = new Map<string, number>();
  for (const a of done.data) assignedOf.set(String(a.so_item_id), (assignedOf.get(String(a.so_item_id)) ?? 0) + num(a.qty));
  const closed = new Set<string>(SO_TERMINAL_STATES);
  return live.filter((r) => !boughtFor.has(String(r.id))).map((r) => {
    const so = soOf(r) as Row;
    const needDate = day(so.amended_delivery_date) ?? day(so.customer_delivery_date);
    /* An order delivered before the ERP kept delivery orders (imported, no DO
       line) went out on its delivery date — else it would look open forever
       and swallow every later receipt. */
    const dos = deliveredOf.get(String(r.id)) ?? [];
    const delivered = dos.length || !closed.has(String(so.status)) ? dos : [{ date: needDate ?? (day(so.so_date) as string), qty: num(r.qty) }];
    return {
      soItemId: String(r.id), soDocNo: String(r.doc_no), itemCode: String(r.item_code), soDate: day(so.so_date) as string,
      needDate, qty: num(r.qty), delivered, assigned: assignedOf.get(String(r.id)) ?? 0,
    };
  });
}

/** At goods-receipt time: assign this receipt's stock-PO lines and keep it. */
export async function recordReceiptAssignments(sb: any, grnId: string, companyId: number): Promise<number> {
  const { data: grn, error: gErr } = await scopeToCompanyId(sb.from('grns').select('id, received_at').eq('id', grnId), companyId).maybeSingle();
  if (gErr || !grn) throw new Error(`goods receipt: ${gErr?.message ?? 'not found'}`);
  const { data: items, error: iErr } = await scopeToCompanyId(sb.from('grn_items').select('purchase_order_item_id, item_code, qty_accepted').eq('grn_id', grnId), companyId);
  if (iErr) throw new Error(`goods receipt lines: ${iErr.message}`);
  const poItemIds = [...new Set(((items ?? []) as Row[]).map((r) => r.purchase_order_item_id).filter(Boolean).map(String))];
  if (!poItemIds.length) return 0;
  const { data: poItems, error: pErr } = await scopeToCompanyId(sb.from('purchase_order_items').select('id, so_item_id').in('id', poItemIds), companyId);
  if (pErr) throw new Error(`PO lines: ${pErr.message}`);
  const stockPo = new Set(((poItems ?? []) as Row[]).filter((p) => !p.so_item_id).map((p) => String(p.id)));
  const receivedAt = day(grn.received_at) as string;
  const receipts: StockReceipt[] = ((items ?? []) as Row[])
    .filter((r) => r.purchase_order_item_id && stockPo.has(String(r.purchase_order_item_id)) && r.item_code && num(r.qty_accepted) > 0)
    .map((r) => ({ key: `${grnId}|${String(r.purchase_order_item_id)}`, grnId, poItemId: String(r.purchase_order_item_id), itemCode: String(r.item_code), qty: num(r.qty_accepted), receivedAt }));
  if (!receipts.length) return 0;
  const demand = await loadStockDemand(sb, companyId, [...new Set(receipts.map((r) => r.itemCode))], receivedAt, false);
  const rows = allocateReceipts(receipts, demand).map((a) => ({
    company_id: companyId, grn_id: a.grnId, purchase_order_item_id: a.poItemId, so_item_id: a.soItemId, so_doc_no: a.soDocNo,
    item_code: a.itemCode, qty: a.qty, need_date: a.needDate, received_at: a.receivedAt,
  }));
  if (!rows.length) return 0;
  const { error } = await sb.from('po_receipt_so_assignments').upsert(rows, { onConflict: 'grn_id,purchase_order_item_id,so_item_id' });
  if (error) throw new Error(`write assignments: ${error.message}`);
  return rows.length;
}
