/* GET /api/scm/logistic-overview — the history half of the Logistic Overview
   (owner, 2026-10-16: the weekly logistic report and the HC delivery dashboard,
   now from the ERP itself). The board half (what is pending, ready, confirmed)
   is the Delivery Planning read the page already loads.

   Returns: the last 8 weeks plus this week and next (DOs issued, delivered,
   lorry runs), the last 12 months of DO volume, delivered orders that still
   owe money (the sheet's "Overdue balance > 30 days"), and DOs never closed
   or carrying no cost.
   Company scope: every read is scoped to the active company. */
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { logisticPeriod, type PeriodDo, type DoCatLine } from '../lib/logistic-period';
import { procurementCategory } from '../lib/procurement-overview';

export const logisticOverview = new Hono<{ Bindings: Env; Variables: Variables }>();
logisticOverview.use('*', supabaseAuth);

type Row = Record<string, unknown>;
const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

/** Monday of the week holding `day` (ISO date). */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return iso(t - dow * DAY);
}

logisticOverview.get('/', async (c) => {
  const sb = c.get('supabase');
  const today = todayMyt();
  /* ?warehouse=<id>: delivery orders and lorry runs of that warehouse only;
     absent = every warehouse. Delivered-but-owing stays company-wide (it is
     a sales order balance, not a warehouse's). */
  const wq = c.req.query('warehouse') ?? '';
  const warehouseId = /^[0-9a-f-]{36}$/i.test(wq) ? wq : null;
  const byWh = <Q,>(q: Q): Q => (warehouseId ? (q as unknown as { eq: (col: string, v: string) => Q }).eq('warehouse_id', warehouseId) : q);
  const thisMonday = mondayOf(today);
  const firstWeek = iso(Date.parse(`${thisMonday}T00:00:00Z`) - 8 * 7 * DAY);
  const yearAgo = `${iso(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - 330 * DAY).slice(0, 7)}-01`;
  const fail = (what: string, e: { message: string }) => c.json({ error: 'load_failed', reason: `${what}: ${e.message}` }, 500);

  const dos = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('delivery_orders')
    .select('id, do_date, delivered_at, status, local_total_sen').gte('do_date', yearAgo)
    .not('status', 'in', '("DRAFT","CANCELLED")')), c).order('id').range(f, t));
  if (dos.error) return fail('delivery orders', dos.error);

  // Weeks: 8 back, this week, next week.
  const weeks = Array.from({ length: 10 }, (_, i) => {
    const from = iso(Date.parse(`${firstWeek}T00:00:00Z`) + i * 7 * DAY);
    return { from, to: iso(Date.parse(`${from}T00:00:00Z`) + 6 * DAY), doCount: 0, doAmountSen: 0, delivered: 0, current: from === thisMonday };
  });
  const weekOf = (d: string | null) => (d ? weeks.find((w) => d.slice(0, 10) >= w.from && d.slice(0, 10) <= w.to) : undefined);
  const months = new Map<string, { month: string; doCount: number; doAmountSen: number }>();
  for (const d of dos.data ?? []) {
    const date = String(d.do_date ?? '').slice(0, 10);
    const w = weekOf(date);
    if (w) { w.doCount += 1; w.doAmountSen += num(d.local_total_sen); }
    // A DELIVERED order without a delivered_at stamp (older imports) counts on its DO date.
    const dw = d.status === 'DELIVERED' ? weekOf(String(d.delivered_at ?? d.do_date ?? '')) : undefined;
    if (dw) dw.delivered += 1;
    const m = date.slice(0, 7);
    if (m) { const row = months.get(m) ?? { month: m, doCount: 0, doAmountSen: 0 }; row.doCount += 1; row.doAmountSen += num(d.local_total_sen); months.set(m, row); }
  }

  /* Delivered but still owing: an order whose delivery is done and whose
     balance is above zero, aged from its last delivery. */
  const owing = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no, balance_sen').gt('balance_sen', 0).not('status', 'in', '("DRAFT","CANCELLED")'), c).order('doc_no').range(f, t));
  if (owing.error) return fail('order balances', owing.error);
  const owingDocs = (owing.data ?? []).map((r) => String(r.doc_no));
  const delivered = await chunkIn<Row>(owingDocs, (b, f, t) => scopeToCompany(sb.from('delivery_orders')
    .select('so_doc_no, delivered_at, do_date').in('so_doc_no', b).eq('status', 'DELIVERED'), c).order('id').range(f, t));
  if (delivered.error) return fail('delivered orders', delivered.error);
  const lastDelivered = new Map<string, string>();
  for (const d of delivered.data) {
    const k = String(d.so_doc_no); const at = String(d.delivered_at ?? d.do_date ?? '').slice(0, 10);
    if (at && (!lastDelivered.has(k) || at > (lastDelivered.get(k) as string))) lastDelivered.set(k, at);
  }
  let outstanding = { count: 0, balanceSen: 0, oldestDays: 0 };
  let overdue30 = { count: 0, balanceSen: 0, oldestDays: 0 };
  for (const r of owing.data ?? []) {
    const at = lastDelivered.get(String(r.doc_no));
    if (!at) continue;
    const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${at}T00:00:00Z`)) / DAY);
    const bal = num(r.balance_sen);
    outstanding = { count: outstanding.count + 1, balanceSen: outstanding.balanceSen + bal, oldestDays: Math.max(outstanding.oldestDays, age) };
    if (age > 30) overdue30 = { count: overdue30.count + 1, balanceSen: overdue30.balanceSen + bal, oldestDays: Math.max(overdue30.oldestDays, age) };
  }

  /* Two process gaps management should see: DOs loaded more than a week ago
     and never closed as delivered (the POD step skipped, so "delivered" and
     "owing" read low), and DOs carrying no cost (their margin reads 100%). */
  const weekAgo = iso(Date.parse(`${today}T00:00:00Z`) - 7 * DAY);
  const monthAgo = iso(Date.parse(`${today}T00:00:00Z`) - 30 * DAY);
  const notClosed = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('delivery_orders')
    .select('do_date, local_total_sen').eq('status', 'LOADED').lt('do_date', weekAgo)), c).order('id').range(f, t));
  if (notClosed.error) return fail('unclosed delivery orders', notClosed.error);
  const noCost = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('delivery_orders')
    .select('local_total_sen').gte('do_date', iso(Date.parse(`${today}T00:00:00Z`) - 90 * DAY))
    .neq('status', 'CANCELLED').gt('local_total_sen', 0).or('total_cost_sen.is.null,total_cost_sen.eq.0')), c).order('id').range(f, t));
  if (noCost.error) return fail('delivery orders without cost', noCost.error);
  const doNotClosed = { count: 0, amountSen: 0, over30: 0, over30Sen: 0 };
  for (const d of notClosed.data ?? []) {
    doNotClosed.count += 1; doNotClosed.amountSen += num(d.local_total_sen);
    if (String(d.do_date ?? '') < monthAgo) { doNotClosed.over30 += 1; doNotClosed.over30Sen += num(d.local_total_sen); }
  }
  const doNoCost = { count: (noCost.data ?? []).length, amountSen: (noCost.data ?? []).reduce((a, d) => a + num(d.local_total_sen), 0) };

  /* The selected period (?from=&to=, default this month to today): the DOs
     issued in it, the lorry each went on, and their lines by category. */
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const qFrom = c.req.query('from'); const qTo = c.req.query('to');
  const pFrom = qFrom && ISO.test(qFrom) ? qFrom : `${today.slice(0, 7)}-01`;
  const pTo = qTo && ISO.test(qTo) ? qTo : today;
  const periodDos = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('delivery_orders')
    .select('id, status, do_date, local_total_sen, state, customer_state')
    .gte('do_date', pFrom).lte('do_date', pTo)
    .in('status', ['LOADED', 'DELIVERED'])), c).order('id').range(f, t));
  if (periodDos.error) return fail('delivery orders in the period', periodDos.error);
  const doIds = (periodDos.data ?? []).map((d) => String(d.id));
  /* The lorry: the DO's crew record first, else the lorry run it was put on. */
  const crew = await chunkIn<Row>(doIds, (b, f, t) => scopeToCompany(sb.from('delivery_order_crew')
    .select('do_id, lorry_id, lorry_plate').in('do_id', b), c).order('id').range(f, t));
  if (crew.error) return fail('delivery crews', crew.error);
  const stops = await chunkIn<Row>(doIds, (b, f, t) => scopeToCompany(sb.from('trip_stops')
    .select('do_id, trip_id').in('do_id', b), c).order('id').range(f, t));
  if (stops.error) return fail('lorry run stops', stops.error);
  const tripIds = [...new Set(stops.data.map((s) => String(s.trip_id)))];
  const trips = await chunkIn<Row>(tripIds, (b, f, t) => scopeToCompany(sb.from('trips')
    .select('id, lorry_id').in('id', b).neq('status', 'CANCELLED'), c).order('id').range(f, t));
  if (trips.error) return fail('lorry runs', trips.error);
  const lorryOfTrip = new Map(trips.data.map((t) => [String(t.id), str(t.lorry_id)]));
  const lorryOfDo = new Map<string, string>();
  for (const s of stops.data) { const l = lorryOfTrip.get(String(s.trip_id)); if (l) lorryOfDo.set(String(s.do_id), l); }
  for (const r of crew.data) { const l = str(r.lorry_id) || str(r.lorry_plate); if (l) lorryOfDo.set(String(r.do_id), l); }
  const pDos: PeriodDo[] = (periodDos.data ?? []).map((d) => ({
    id: String(d.id), doDate: String(d.do_date).slice(0, 10), status: String(d.status), amountSen: num(d.local_total_sen),
    state: str(d.state) || str(d.customer_state), lorry: lorryOfDo.get(String(d.id)) ?? null,
  }));
  const doLines = await chunkIn<Row>(doIds, (b, f, t) => scopeToCompany(sb.from('delivery_order_items')
    .select('delivery_order_id, item_code, item_group, line_total_sen').in('delivery_order_id', b), c).order('id').range(f, t));
  if (doLines.error) return fail('delivery order lines', doLines.error);
  const lineCodes = [...new Set(doLines.data.map((l) => str(l.item_code)).filter((x): x is string => !!x))];
  const prods = await chunkIn<Row>(lineCodes, (b, f, t) => scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
  if (prods.error) return fail('products', prods.error);
  const prodCat = new Map(prods.data.map((p) => [String(p.code), str(p.category)]));
  const CAT_LABEL: Record<string, string> = { MATTRESS: 'Mattress', BEDFRAME: 'Bedframe', SOFA: 'Sofa', ACCESSORY: 'Accessories', DINING: 'Dining', OTHERS: 'Others' };
  const catLines: DoCatLine[] = doLines.data.map((l) => {
    const raw = prodCat.get(String(l.item_code ?? '')) ?? null;
    /* Transport, disposal, storage fees: a charge on the order, not a product. */
    const fee = raw === 'SERVICE' || String(l.item_group ?? '').toLowerCase() === 'service' || String(l.item_code ?? '').toUpperCase().startsWith('SVC-');
    return { doId: String(l.delivery_order_id), category: fee ? 'Charges' : CAT_LABEL[procurementCategory(raw, str(l.item_group))] ?? 'Others', sen: num(l.line_total_sen) };
  });
  const period = {
    from: pFrom, to: pTo,
    doCount: pDos.length,
    doAmountSen: pDos.reduce((a, d) => a + d.amountSen, 0),
    podClosed: pDos.filter((d) => d.status === 'DELIVERED').length,
    ...logisticPeriod(pDos, catLines, pFrom, pTo),
  };

  return c.json({
    today, thisMonday,
    period,
    doNotClosed, doNoCost,
    weeks,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    deliveredOwing: outstanding,
    deliveredOwingOver30: overdue30,
  });
});
