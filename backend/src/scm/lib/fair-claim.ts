// ----------------------------------------------------------------------------
// fair-claim.ts — an event claims the orders its sales report names.
//
// Owner 2026-11-04: when a bill in an event's nightly report is plainly an order
// sitting under another event, or under none, move it, like a parent claiming a
// child. fair-reconcile.ts links orders still PENDING; this one also corrects an
// order a rep linked to the wrong event.
//
// "Plainly" is the whole rule, because a move changes two events' P&L: the booklet
// number is on one order only, one event's report carries it, and the money agrees
// to within RM 1. Anything less stays on Books not complete for a person. An order
// marked NO_FAIR was a person's decision and is left alone, and so is a binding
// (ZNT1234+HC1234, one sale of two brands) or an order under another brand's booth
// of the same fair: either event may hold those.
//
// Each company runs on its own. Safe to re-run: a claimed order is no longer under
// another event.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseService } from '../../db/supabase';
import { collectReport, indexOrdersByToken, isBinding, orderAmountSen, sameFair, type BoothRef, type NoteRow, type OrderRow } from '../../routes/lib/sales-report-bills';
import type { Env } from '../env';
import { recordFairChange, fairStateOf } from './fair-audit';
import type { FairDb } from './fair-binding';
import { paginateAll } from './paginate-all';

export type ReportBill = { token: string; amountSen: number };
export type ClaimOrder = OrderRow & { fair_match: string | null };
export type Claim = { docNo: string; fromProjectId: number | null; toProjectId: number; token: string };

const ONE_RINGGIT_SEN = 100;

/** Which orders move: see the header for what makes one plain. */
export function ordersToClaim(reports: ReadonlyMap<number, readonly ReportBill[]>, orders: readonly ClaimOrder[], booths: ReadonlyMap<number, BoothRef>): Claim[] {
  const index = indexOrdersByToken(orders);
  const eventsOf = new Map<string, number[]>();
  for (const [projectId, bills] of reports) {
    for (const t of new Set(bills.map((b) => b.token))) eventsOf.set(t, [...(eventsOf.get(t) ?? []), projectId]);
  }
  const claims: Claim[] = [];
  for (const [projectId, bills] of reports) {
    for (const b of bills) {
      const found = index.get(b.token) ?? [];
      if (found.length !== 1 || eventsOf.get(b.token)?.length !== 1) continue;
      const order = found[0] as ClaimOrder;
      if (order.project_id === projectId || order.fair_match === 'NO_FAIR' || isBinding(order)) continue;
      if (order.project_id != null && sameFair(booths.get(order.project_id), booths.get(projectId))) continue;
      if (Math.abs(orderAmountSen(order) - b.amountSen) > ONE_RINGGIT_SEN) continue;
      claims.push({ docNo: order.doc_no, fromProjectId: order.project_id, toProjectId: projectId, token: b.token });
    }
  }
  return claims;
}

export type FairClaimResult = { companies: number; claimed: number; failed: number };

type Rows<T> = { all: () => Promise<{ results: T[] }> };
type Db = { prepare: (q: string) => { bind: (...a: unknown[]) => Rows<never> } };

async function reportsOf(db: Db, companyId: number, since: string): Promise<{ reports: Map<number, ReportBill[]>; booths: Map<number, BoothRef> }> {
  const events = (await (db.prepare(
    `SELECT p.id, p.venue, p.start_date, p.end_date FROM projects p
      WHERE p.company_id = ? AND p.archived_at IS NULL AND COALESCE(p.status, '') <> 'cancelled'
        AND substr(COALESCE(p.start_date, p.end_date), 1, 10) >= ?`,
  ).bind(companyId, since) as unknown as Rows<{ id: number; venue: string | null; start_date: string | null; end_date: string | null }>).all()).results;
  const notes = (await (db.prepare(
    `SELECT a.id, a.project_id, a.note, a.created_at, u.email AS author_email, ps.name AS author_position
       FROM project_activity a JOIN projects p ON p.id = a.project_id
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN positions ps ON ps.id = u.position_id
      WHERE a.action = 'note' AND a.archived_at IS NULL AND p.company_id = ?
        AND substr(COALESCE(p.start_date, p.end_date), 1, 10) >= ?`,
  ).bind(companyId, since) as unknown as Rows<NoteRow & { project_id: number }>).all()).results;
  const attendees = (await (db.prepare(
    `SELECT psa.project_id, LOWER(TRIM(u.email)) AS email
       FROM project_sales_attendees psa
       JOIN projects p ON p.id = psa.project_id
       JOIN sales_reps sr ON sr.id = psa.sales_rep_id
       JOIN users u ON u.id = sr.user_id
      WHERE u.email IS NOT NULL AND u.email <> '' AND p.company_id = ?
        AND substr(COALESCE(p.start_date, p.end_date), 1, 10) >= ?`,
  ).bind(companyId, since) as unknown as Rows<{ project_id: number; email: string }>).all()).results;
  const reports = new Map<number, ReportBill[]>();
  for (const e of events) {
    const id = Number(e.id);
    const mine = notes.filter((n) => Number(n.project_id) === id).map((n) => ({ ...n, id: Number(n.id) }));
    if (mine.length === 0) continue;
    const who = new Set(attendees.filter((a) => Number(a.project_id) === id).map((a) => a.email));
    const { bills } = collectReport(mine, e.start_date ? String(e.start_date) : null, who);
    if (bills.length) reports.set(id, bills.map((b) => ({ token: b.ref_token, amountSen: Number(b.amount_sen) })));
  }
  return { reports, booths: new Map(events.map((e) => [Number(e.id), { venue: e.venue, start: e.start_date, end: e.end_date }])) };
}

/** One pass over the last 120 days of events, company by company. */
export async function claimReportedOrders(env: Env, today: string): Promise<FairClaimResult> {
  const out: FairClaimResult = { companies: 0, claimed: 0, failed: 0 };
  let sb: ReturnType<typeof getSupabaseService>;
  try { sb = getSupabaseService(env); } catch { return out; }
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 120 * 86_400_000).toISOString().slice(0, 10);
  const db = env.DB as unknown as Db;
  const companies = (await (db.prepare('SELECT id FROM companies WHERE id > ?').bind(0) as unknown as Rows<{ id: number }>).all()).results;
  for (const { id } of companies) {
    const companyId = Number(id);
    const { reports, booths } = await reportsOf(db, companyId, since);
    if (reports.size === 0) continue;
    out.companies += 1;
    const orders = await paginateAll<ClaimOrder>((f, t) => sb.from('mfg_sales_orders')
      .select('doc_no, project_id, status, customer_so_no, ref, salesperson_id, local_total_sen, total_revenue_sen, fair_match')
      .eq('company_id', companyId).neq('status', 'CANCELLED').gte('so_date', since).order('doc_no').range(f, t));
    if (orders.error) { console.error('[fair-claim] orders', orders.error.message); out.failed += 1; continue; }
    for (const c of ordersToClaim(reports, orders.data ?? [], booths)) {
      const before = (orders.data ?? []).find((o) => o.doc_no === c.docNo);
      const patch = { project_id: c.toProjectId, fair_match: 'PICKED' };
      /* The old event in the predicate: a rep's edit since the read wins. */
      const write = sb.from('mfg_sales_orders').update(patch).eq('doc_no', c.docNo).eq('company_id', companyId);
      const { error } = await (c.fromProjectId == null ? write.is('project_id', null) : write.eq('project_id', c.fromProjectId));
      if (error) { console.error('[fair-claim] move', c.docNo, error.message); out.failed += 1; continue; }
      out.claimed += 1;
      await recordFairChange({
        sb: sb as unknown as SupabaseClient, db: env.DB as unknown as FairDb, companySql: ` AND p.company_id = ${companyId}`, docNo: c.docNo,
        before: fairStateOf(before ?? {}), after: fairStateOf(patch), how: 'nightly', actorId: null, actorName: 'System',
        note: `The event's sales report carries bill ${c.token} at this amount.`,
      });
    }
  }
  return out;
}
