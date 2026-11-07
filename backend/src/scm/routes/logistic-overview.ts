/* GET /api/scm/logistic-overview — the history half of the Logistic Overview
   (owner, 2026-10-16: the weekly logistic report and the HC delivery dashboard,
   now from the ERP itself). The board half (what is pending, ready, confirmed)
   is the Delivery Planning read the page already loads.

   Returns: the last 8 weeks plus this week and next (DOs issued, delivered,
   lorry runs), the last 12 months of DO volume, delivered orders that still
   owe money (the sheet's "Overdue balance > 30 days"), and DOs never closed
   or carrying no cost.
   Company scope: every read is scoped to the active company. */
import type { LorryJobDetail, LorryJobKind } from '../shared/logistic-region';
import { loadProjectJobs } from './lorry-capacity';
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { serveSwr, type SwrBuild } from '../lib/kv-swr';
import { logisticPeriod, regionOf, type PeriodDo, type DoCatLine } from '../lib/logistic-period';
import { downDates, loadDownWindows } from '../lib/lorry-down-days';
import { DO_NOT_DELIVERED_IN_LIST, DO_STOCK_OUT_STATES } from '../shared/do-shipped-states';

/* A sales order that is a draft or cancelled has no balance to chase. */
const SO_NOT_LIVE = `(${['DRAFT', 'CANCELLED'].join(',')})`;
import { unreleasedOrders } from '../lib/so-unreleased';
import { SO_PROCESSING_DATE_COLUMN } from '../shared/so-processing-date';
import { procurementCategory, PROCUREMENT_CATEGORY_LABEL } from '../lib/procurement-overview';

export const logisticOverview = new Hono<{ Bindings: Env; Variables: Variables }>();
logisticOverview.use('*', supabaseAuth);

type Row = Record<string, unknown>;
const DAY = 86400000;
/** How a run's stop counts for the lorry. A lorry service is the lorry's own upkeep. */
const STOP_KIND: Readonly<Record<string, LorryJobKind | null>> = {
  DELIVERY: 'delivery', SERVICE: 'service', INSPECTION: 'service', PICKUP: 'service',
  SETUP: 'setup', DISMANTLE: 'setup', SUPPLIER_PICKUP: 'transport', TRANSFER: 'transport', LORRY_SERVICE: null,
};
/** What a run's stop reads as in the lorry's list, in the board's job type words. */
const STOP_TYPE: Readonly<Record<string, string>> = {
  DELIVERY: 'Delivery', SERVICE: 'Service case', INSPECTION: 'Service case · Inspection', PICKUP: 'Service case · Pickup',
  SETUP: 'Setup', DISMANTLE: 'Dismantle', SUPPLIER_PICKUP: 'Supplier Pickup', TRANSFER: 'Transfer',
};
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

/** Monday of the week holding `day` (ISO date). */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return iso(t - dow * DAY);
}

/* HC-0002: every open of the home Overview and Logistic Overview ran this
   (12 stages, ~1.2 s on prod). Served stale-while-revalidate from KV
   (lib/kv-swr.ts), keyed by company, day and the query. Up to 5 minutes old. */
logisticOverview.get('/', (c) =>
  serveSwr(c, { family: 'logov', parts: [todayMyt(), c.req.query('warehouse') ?? '', c.req.query('from') ?? '', c.req.query('to') ?? ''], softSeconds: 5 * 60, hardSeconds: 2 * 60 * 60, build: () => buildLogisticOverview(c) }));

async function buildLogisticOverview(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<SwrBuild> {
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
  const fail = (what: string, e: { message: string }): SwrBuild => ({ ok: false, status: 500, body: { error: 'load_failed', reason: `${what}: ${e.message}` } });

  const dos = await paginateAll<Row>((f, t) => scopeToCompany(byWh(sb.from('delivery_orders')
    .select('id, do_date, delivered_at, status, local_total_sen').gte('do_date', yearAgo)
    .not('status', 'in', DO_NOT_DELIVERED_IN_LIST)), c).order('id').range(f, t));
  if (dos.error) return fail('delivery orders', dos.error);

  // Weeks: 8 back, this week, next week.
  const weeks = Array.from({ length: 10 }, (_, i) => {
    const from = iso(Date.parse(`${firstWeek}T00:00:00Z`) + i * 7 * DAY);
    return { from, to: iso(Date.parse(`${from}T00:00:00Z`) + 6 * DAY), doCount: 0, doAmountSen: 0, delivered: 0, current: from === thisMonday };
  });
  const weekOf = (d: string | null) => (d ? weeks.find((w) => d.slice(0, 10) >= w.from && d.slice(0, 10) <= w.to) : undefined);
  const months = new Map<string, { month: string; doCount: number; doAmountSen: number }>();
  const deliveredMonths = new Map<string, { month: string; doCount: number; doAmountSen: number }>();
  for (const d of dos.data ?? []) {
    const date = String(d.do_date ?? '').slice(0, 10);
    const w = weekOf(date);
    if (w) { w.doCount += 1; w.doAmountSen += num(d.local_total_sen); }
    // A DELIVERED order without a delivered_at stamp (older imports) counts on its DO date.
    const dw = d.status === 'DELIVERED' ? weekOf(String(d.delivered_at ?? d.do_date ?? '')) : undefined;
    if (dw) dw.delivered += 1;
    // Monthly volume is what was confirmed delivered, in the month it was delivered.
    const dm = d.status === 'DELIVERED' ? String(d.delivered_at ?? d.do_date ?? '').slice(0, 7) : '';
    if (dm) { const row = deliveredMonths.get(dm) ?? { month: dm, doCount: 0, doAmountSen: 0 }; row.doCount += 1; row.doAmountSen += num(d.local_total_sen); deliveredMonths.set(dm, row); }
    const m = date.slice(0, 7);
    if (m) { const row = months.get(m) ?? { month: m, doCount: 0, doAmountSen: 0 }; row.doCount += 1; row.doAmountSen += num(d.local_total_sen); months.set(m, row); }
  }

  /* Delivered but still owing: an order whose delivery is done and whose
     balance is above zero, aged from its last delivery. */
  const owing = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no, balance_sen').gt('balance_sen', 0).not('status', 'in', SO_NOT_LIVE), c).order('doc_no').range(f, t));
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
  /* HC-0159: confirmed orders nobody has released (no Processing Date) for over 30 days. */
  const unreleased = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('mfg_sales_orders')
    .select('so_date, status, on_hold, processing_date').eq('status', 'CONFIRMED').is(SO_PROCESSING_DATE_COLUMN, null).lt('so_date', monthAgo), c).order('doc_no').range(f, t));
  if (unreleased.error) return fail('unreleased orders', unreleased.error);
  const soNoProcessing = unreleasedOrders((unreleased.data ?? []) as Parameters<typeof unreleasedOrders>[0], today);
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
    .select('id, do_number, so_doc_no, debtor_name, status, do_date, local_total_sen, state, customer_state, vehicle')
    .gte('do_date', pFrom).lte('do_date', pTo)
    .in('status', [...DO_STOCK_OUT_STATES])), c).order('id').range(f, t));
  if (periodDos.error) return fail('delivery orders in the period', periodDos.error);
  const doIds = (periodDos.data ?? []).map((d) => String(d.id));
  /* The lorry: the DO's crew record first, else the lorry run it was put on,
     else the Vehicle typed on the DO itself. */
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
  /* The fleet, to name each lorry by its plate and list our own even on no day out. */
  const fleet = await scopeToCompany(sb.from('lorries').select('id, plate, is_internal, active'), c);
  if (fleet.error) return fail('lorries', fleet.error);
  const plateOf = new Map((fleet.data as Row[]).map((l) => [String(l.id), String(l.plate ?? '—')]));
  const fleetByNorm = new Map((fleet.data as Row[]).map((l) => [String(l.plate ?? '').replace(/\s+/g, '').toUpperCase(), String(l.plate ?? '—')]));
  const fleetLorries = (fleet.data as Row[]).filter((l) => l.active !== false).map((l) => ({ plate: String(l.plate ?? '—'), internal: l.is_internal === true }));
  const pDos: PeriodDo[] = (periodDos.data ?? []).map((d) => ({
    id: String(d.id), doDate: String(d.do_date).slice(0, 10), status: String(d.status), amountSen: num(d.local_total_sen),
    state: str(d.state) || str(d.customer_state), lorry: (() => { const l = lorryOfDo.get(String(d.id)); if (l) return plateOf.get(l) ?? l; const v = String(d.vehicle ?? '').replace(/\s+/g, '').toUpperCase(); return v ? fleetByNorm.get(v) ?? v : null; })(),
  }));
  const doLines = await chunkIn<Row>(doIds, (b, f, t) => scopeToCompany(sb.from('delivery_order_items')
    .select('delivery_order_id, item_code, item_group, line_total_sen').in('delivery_order_id', b), c).order('id').range(f, t));
  if (doLines.error) return fail('delivery order lines', doLines.error);
  const lineCodes = [...new Set(doLines.data.map((l) => str(l.item_code)).filter((x): x is string => !!x))];
  const prods = await chunkIn<Row>(lineCodes, (b, f, t) => scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
  if (prods.error) return fail('products', prods.error);
  const prodCat = new Map(prods.data.map((p) => [String(p.code), str(p.category)]));
  const catLines: DoCatLine[] = doLines.data.map((l) => {
    const raw = prodCat.get(String(l.item_code ?? '')) ?? null;
    /* Transport, disposal, storage fees: a charge on the order, not a product. */
    const fee = raw === 'SERVICE' || String(l.item_group ?? '').toLowerCase() === 'service' || String(l.item_code ?? '').toUpperCase().startsWith('SVC-');
    return { doId: String(l.delivery_order_id), category: fee ? 'Charges' : PROCUREMENT_CATEGORY_LABEL[procurementCategory(raw, str(l.item_group))], sen: num(l.line_total_sen) };
  });
  /* A day in the workshop is not a day the lorry could have gone out. */
  const pEnd = pTo < today ? pTo : today;
  const down = await loadDownWindows(sb, pFrom, pEnd, today);
  if (down.error) return fail('lorry down days', { message: down.error });
  const downByPlate = new Map([...downDates(down.windows, pFrom, pEnd)].map(([id, days]) => [plateOf.get(id) ?? id, days]));
  /* What each lorry did, from its runs' stops and event set-ups and dismantles. */
  const used = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('trips')
    .select('id, lorry_id, trip_date').gte('trip_date', pFrom).lte('trip_date', pEnd).neq('status', 'CANCELLED'), c).order('id').range(f, t));
  if (used.error) return fail('lorry runs in the period', used.error);
  const usedStops = await chunkIn<Row>((used.data ?? []).map((u) => String(u.id)), (b, f, t) => scopeToCompany(sb.from('trip_stops')
    .select('trip_id, stop_type, assr_case_id, do_id, dp_no, customer_name').in('trip_id', b), c).order('id').range(f, t));
  if (usedStops.error) return fail('lorry run stops in the period', usedStops.error);
  const projectJobs = await loadProjectJobs(c, pFrom, pEnd);
  if (projectJobs.error) return fail('event lorries', { message: projectJobs.error });
  const runOf = new Map((used.data ?? []).map((u) => [String(u.id), { plate: plateOf.get(String(u.lorry_id)), date: String(u.trip_date ?? '').slice(0, 10) }]));
  const lorryJobs: LorryJobDetail[] = [];
  for (const s of usedStops.data) {
    const run = runOf.get(String(s.trip_id));
    /* A service case's delivery leg is a DELIVERY stop too; it rides the run as a service job. */
    const kind = s.assr_case_id != null ? 'service' : STOP_KIND[String(s.stop_type)];
    if (run?.plate && run.date && kind) {
      const type = s.assr_case_id != null && String(s.stop_type) === 'DELIVERY' ? 'Service case' : STOP_TYPE[String(s.stop_type)] ?? String(s.stop_type);
      lorryJobs.push({ plate: run.plate, date: run.date, kind, type, ref: str(s.dp_no), customer: str(s.customer_name), assrId: s.assr_case_id != null ? String(s.assr_case_id) : null, doId: str(s.do_id) });
    }
  }
  /* An event's set-up and dismantle live on the project, never on a run, so they add to
     the run stops rather than repeat them. */
  for (const j of projectJobs.data) {
    const typed = j.lorryPlate ? (fleetByNorm.get(j.lorryPlate.replace(/\s+/g, '').toUpperCase()) ?? j.lorryPlate) : null;
    const plate = j.lorryId ? plateOf.get(j.lorryId) : typed;
    const date = String(j.date ?? '').slice(0, 10);
    if (plate && date) lorryJobs.push({ plate, date, kind: 'setup', type: j.stage, ref: j.code, customer: j.name, assrId: null, doId: null });
  }
  const period = {
    from: pFrom, to: pTo,
    doCount: pDos.length,
    doAmountSen: pDos.reduce((a, d) => a + d.amountSen, 0),
    podClosed: pDos.filter((d) => d.status === 'DELIVERED').length,
    ...logisticPeriod(pDos, catLines, pFrom, pTo, fleetLorries, today, downByPlate, lorryJobs),
    lorryJobs,
    /* The delivery orders behind every figure above, for the page's drill-down. */
    doList: (periodDos.data ?? []).map((d, i) => ({
      id: String(d.id), doNumber: str(d.do_number), soDocNo: str(d.so_doc_no), customer: str(d.debtor_name),
      date: pDos[i]!.doDate, region: regionOf(pDos[i]!.state), state: pDos[i]!.state, amountSen: pDos[i]!.amountSen, lorry: pDos[i]!.lorry, status: pDos[i]!.status,
    })),
  };

  return { ok: true, body: {
    today, thisMonday,
    period,
    doNotClosed, doNoCost, soNoProcessing,
    weeks,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    deliveredMonths: [...deliveredMonths.values()].sort((a, b) => a.month.localeCompare(b.month)),
    deliveredOwing: outstanding,
    deliveredOwingOver30: overdue30,
  } };
}
