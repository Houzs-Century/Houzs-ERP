/* GET /api/scm/logistic-overview — the history half of the Logistic Overview
   (owner, 2026-10-16: the weekly logistic report and the HC delivery dashboard,
   now from the ERP itself). The board half (what is pending, ready, confirmed)
   is the Delivery Planning read the page already loads.

   Returns: the last 8 weeks plus this week and next (DOs issued, delivered,
   lorry runs), the last 12 months of DO volume, and delivered orders that still
   owe money (the sheet's "Overdue balance > 30 days").
   Company scope: every read is scoped to the active company. */
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';

export const logisticOverview = new Hono<{ Bindings: Env; Variables: Variables }>();
logisticOverview.use('*', supabaseAuth);

type Row = Record<string, unknown>;
const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0) || 0;

/** Monday of the week holding `day` (ISO date). */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return iso(t - dow * DAY);
}

logisticOverview.get('/', async (c) => {
  const sb = c.get('supabase');
  const today = todayMyt();
  const thisMonday = mondayOf(today);
  const firstWeek = iso(Date.parse(`${thisMonday}T00:00:00Z`) - 8 * 7 * DAY);
  const lastDay = iso(Date.parse(`${thisMonday}T00:00:00Z`) + 14 * DAY - DAY);
  const yearAgo = `${iso(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - 330 * DAY).slice(0, 7)}-01`;
  const fail = (what: string, e: { message: string }) => c.json({ error: 'load_failed', reason: `${what}: ${e.message}` }, 500);

  const dos = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('delivery_orders')
    .select('id, do_date, delivered_at, status, local_total_sen').gte('do_date', yearAgo)
    .not('status', 'in', '("DRAFT","CANCELLED")'), c).order('id').range(f, t));
  if (dos.error) return fail('delivery orders', dos.error);
  const trips = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('trips')
    .select('id, trip_date, status').gte('trip_date', firstWeek).lte('trip_date', lastDay)
    .neq('status', 'CANCELLED'), c).order('id').range(f, t));
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

  return c.json({
    today, thisMonday,
    runsToday: (trips.data ?? []).filter((t) => String(t.trip_date ?? '').slice(0, 10) === today).length,
    weeks,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    deliveredOwing: outstanding,
    deliveredOwingOver30: overdue30,
  });
});
