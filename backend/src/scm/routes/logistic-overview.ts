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
import { logisticPeriod, regionOf, type PeriodDo, type PeriodTrip, type DoCatLine } from '../lib/logistic-period';
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
  const lastDay = iso(Date.parse(`${thisMonday}T00:00:00Z`) + 14 * DAY - DAY);
  const yearAgo = `${iso(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - 330 * DAY).slice(0, 7)}-01`;
  const fail = (what: string, e: { message: string }) => c.json({ error: 'load_failed', reason: `${what}: ${e.message}` }, 500);

  const dos = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('delivery_orders')
    .select('id, do_date, delivered_at, status, local_total_sen').gte('do_date', yearAgo)
    .not('status', 'in', '("DRAFT","CANCELLED")')), c).order('id').range(f, t));
  if (dos.error) return fail('delivery orders', dos.error);
  const trips = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('trips')
    .select('id, trip_date, status').gte('trip_date', firstWeek).lte('trip_date', lastDay)
    .neq('status', 'CANCELLED')), c).order('id').range(f, t));
  if (trips.error) return fail('lorry runs', trips.error);

  // Weeks: 8 back, this week, next week.
  const weeks = Array.from({ length: 10 }, (_, i) => {
    const from = iso(Date.parse(`${firstWeek}T00:00:00Z`) + i * 7 * DAY);
    return { from, to: iso(Date.parse(`${from}T00:00:00Z`) + 6 * DAY), doCount: 0, doAmountSen: 0, delivered: 0, runs: 0, current: from === thisMonday };
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
  for (const t of trips.data ?? []) { const w = weekOf(String(t.trip_date ?? '')); if (w) w.runs += 1; }

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

  /* The selected period (?from=&to=, default this month to today): what went
     out on a DO, how much of it is closed with a POD, and what each lorry run
     carried — revenue on its stops, or its DOs' amount when a stop has none. */
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const qFrom = c.req.query('from'); const qTo = c.req.query('to');
  const pFrom = qFrom && ISO.test(qFrom) ? qFrom : `${today.slice(0, 7)}-01`;
  const pTo = qTo && ISO.test(qTo) ? qTo : today;
  /* DOs dated from 60 days before the period (a DO delivered in the period
     may have been issued before it); logisticPeriod keeps what belongs. */
  const lookback = iso(Date.parse(`${pFrom}T00:00:00Z`) - 60 * DAY);
  const periodDos = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('delivery_orders')
    .select('id, status, do_date, delivered_at, local_total_sen, state, customer_state, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen')
    .gte('do_date', lookback).lte('do_date', pTo)
    .in('status', ['LOADED', 'DELIVERED'])), c).order('id').range(f, t));
  if (periodDos.error) return fail('delivery orders in the period', periodDos.error);
  const periodTrips = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('trips')
    .select('id, trip_date, lorry_id').gte('trip_date', pFrom).lte('trip_date', pTo).neq('status', 'CANCELLED')), c).order('id').range(f, t));
  if (periodTrips.error) return fail('lorry runs in the period', periodTrips.error);
  const tripIds = (periodTrips.data ?? []).map((r) => String(r.id));
  const stops = await chunkIn<Row>(tripIds, (b, f, t) => scopeToCompany(sb.from('trip_stops')
    .select('trip_id, do_id, revenue_sen').in('trip_id', b), c).order('id').range(f, t));
  if (stops.error) return fail('lorry run stops', stops.error);
  const stopDoIds = [...new Set(stops.data.map((s) => str(s.do_id)).filter((x): x is string => !!x))];
  const stopDos = await chunkIn<Row>(stopDoIds, (b, f, t) => scopeToCompany(sb.from('delivery_orders')
    .select('id, local_total_sen, state, customer_state').in('id', b), c).order('id').range(f, t));
  if (stopDos.error) return fail('lorry run delivery orders', stopDos.error);
  const lorryIds = [...new Set((periodTrips.data ?? []).map((r) => str(r.lorry_id)).filter((x): x is string => !!x))];
  const lorries = await chunkIn<Row>(lorryIds, (b, f, t) => scopeToCompany(sb.from('lorries').select('id, plate').in('id', b), c).order('id').range(f, t));
  if (lorries.error) return fail('lorries', lorries.error);
  const plate = new Map(lorries.data.map((l) => [String(l.id), String(l.plate ?? '—')]));
  const stopDoById = new Map(stopDos.data.map((d) => [String(d.id), d]));

  const runs: PeriodTrip[] = (periodTrips.data ?? []).map((t) => {
    const ss = stops.data.filter((s) => String(s.trip_id) === String(t.id));
    const regs = new Map<string, number>();
    let amountSen = 0;
    for (const s of ss) {
      const d = s.do_id ? stopDoById.get(String(s.do_id)) : undefined;
      amountSen += s.revenue_sen != null ? num(s.revenue_sen) : num(d?.local_total_sen);
      if (d) { const r = regionOf(str(d.state) || str(d.customer_state)); regs.set(r, (regs.get(r) ?? 0) + 1); }
    }
    const region = [...regs.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    return { id: String(t.id), date: String(t.trip_date).slice(0, 10), lorry: t.lorry_id ? plate.get(String(t.lorry_id)) ?? null : null, driver: null, stops: ss.length, amountSen, region };
  });
  const pDos: PeriodDo[] = (periodDos.data ?? []).map((d) => ({
    id: String(d.id), doDate: String(d.do_date).slice(0, 10), deliveredAt: d.delivered_at ? String(d.delivered_at).slice(0, 10) : null,
    status: String(d.status), amountSen: num(d.local_total_sen), state: str(d.state) || str(d.customer_state),
    mattressSofaSen: num(d.mattress_sofa_sen), bedframeSen: num(d.bedframe_sen), accessoriesSen: num(d.accessories_sen), othersSen: num(d.others_sen), serviceSen: num(d.service_sen),
  }));
  const inP = pDos.filter((d) => d.doDate >= pFrom && d.doDate <= pTo);
  const doLines = await chunkIn<Row>(inP.map((d) => d.id), (b, f, t) => scopeToCompany(sb.from('delivery_order_items')
    .select('delivery_order_id, item_code, item_group, line_total_sen').in('delivery_order_id', b), c).order('id').range(f, t));
  if (doLines.error) return fail('delivery order lines', doLines.error);
  const lineCodes = [...new Set(doLines.data.map((l) => str(l.item_code)).filter((x): x is string => !!x))];
  const prods = await chunkIn<Row>(lineCodes, (b, f, t) => scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
  if (prods.error) return fail('products', prods.error);
  const prodCat = new Map(prods.data.map((p) => [String(p.code), str(p.category)]));
  const CAT_LABEL: Record<string, string> = { MATTRESS: 'Mattress', BEDFRAME: 'Bedframe', SOFA: 'Sofa', ACCESSORY: 'Accessories', DINING: 'Dining', OTHERS: 'Others' };
  const catLines: DoCatLine[] = doLines.data.map((l) => {
    const raw = prodCat.get(String(l.item_code ?? '')) ?? null;
    const service = raw === 'SERVICE' || String(l.item_group ?? '').toLowerCase() === 'service' || String(l.item_code ?? '').toUpperCase().startsWith('SVC-');
    return { doId: String(l.delivery_order_id), category: service ? 'Service' : CAT_LABEL[procurementCategory(raw, str(l.item_group))] ?? 'Others', sen: num(l.line_total_sen) };
  });
  const period = {
    from: pFrom, to: pTo,
    doCount: inP.length,
    doAmountSen: inP.reduce((a, d) => a + d.amountSen, 0),
    podClosed: inP.filter((d) => d.status === 'DELIVERED').length,
    runs: runs.length,
    lorries: new Set(runs.map((r) => r.lorry).filter(Boolean)).size,
    runAmountSen: runs.reduce((a, r) => a + r.amountSen, 0),
    ...logisticPeriod(pDos, runs, catLines, pFrom, pTo),
  };

  return c.json({
    today, thisMonday,
    period,
    doNotClosed, doNoCost,
    runsToday: (trips.data ?? []).filter((t) => String(t.trip_date ?? '').slice(0, 10) === today).length,
    weeks,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    deliveredOwing: outstanding,
    deliveredOwingOver30: overdue30,
  });
});
