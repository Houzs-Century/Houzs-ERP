#!/usr/bin/env node
// check-report-auto-move.mjs — READ-ONLY. Owner 2026-10-20 (先确定):
// 「如果这个报告显示他们这张单是另外一场就自动 move 过去那场可以吗？」
// What a move driven by the sales report chat would do today: for every event
// whose chat carries an evening report, the bills (booklet number = the order's
// Ref No.) whose order sits under ANOTHER event or under none. A booklet number
// that two events' reports both list is a conflict — it would not be moved.
// Uses the page's own parser and matcher (routes/lib/sales-report-bills.ts).
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1).
//   npx tsx scripts/check-report-auto-move.mjs
import postgres from 'postgres';
import { collectReport, matchBills } from '../src/routes/lib/sales-report-bills.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const stamp = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;
/* The route's own window: orders dated from 30 days before the fair. */
const windowStart = (start) => {
  const s = day(start);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '2000-01-01';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 30)).toISOString().slice(0, 10);
};

try {
  const projs = await sql`
    SELECT p.id, p.name, p.start_date, p.end_date, p.brand, p.status, p.archived_at
      FROM public.projects p
     WHERE p.company_id = ${CO}
       AND EXISTS (SELECT 1 FROM public.project_activity a WHERE a.project_id = p.id AND a.action = 'note' AND a.archived_at IS NULL)`;
  const allProjects = await sql`SELECT id, name, brand FROM public.projects WHERE company_id = ${CO}`;
  const name = new Map(allProjects.map((p) => [Number(p.id), p.name]));
  const brandOf = new Map(allProjects.map((p) => [Number(p.id), p.brand]));
  const ids = projs.map((p) => Number(p.id));
  const notes = ids.length === 0 ? [] : await sql`
    SELECT a.id, a.project_id, a.note, a.created_at, u.email AS author_email, ps.name AS author_position
      FROM public.project_activity a
      LEFT JOIN public.users u ON u.id = a.user_id
      LEFT JOIN public.positions ps ON ps.id = u.position_id
     WHERE a.project_id IN ${sql(ids)} AND a.action = 'note' AND a.archived_at IS NULL`;
  const notesOf = new Map();
  for (const n of notes) {
    const k = Number(n.project_id);
    if (!notesOf.has(k)) notesOf.set(k, []);
    notesOf.get(k).push({ id: Number(n.id), note: n.note, created_at: stamp(n.created_at), author_email: n.author_email, author_position: n.author_position });
  }

  const orders = (await sql`
    SELECT so.doc_no, so.project_id, so.status::text AS status, so.customer_so_no, so.ref, so.salesperson_id, so.local_total_sen, so.total_revenue_sen, so.so_date, so.branding, so.created_at, so.debtor_name, so.venue, st.name AS sp_name
      FROM scm.mfg_sales_orders so LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.status::text <> 'CANCELLED' AND so.so_date >= '2026-06-01'`).map((o) => ({
    ...o,
    project_id: o.project_id == null ? null : Number(o.project_id),
    local_total_sen: o.local_total_sen == null ? null : Number(o.local_total_sen),
    total_revenue_sen: o.total_revenue_sen == null ? null : Number(o.total_revenue_sen),
    so_day: day(o.so_date),
  }));
  const orderByDoc = new Map(orders.map((o) => [o.doc_no, o]));

  let withReport = 0; let bills = 0; let opened = 0; let notOpened = 0; let same = 0;
  const reportedBy = new Map(); // token -> Set(projectId)
  const moves = [];
  for (const p of projs) {
    const pid = Number(p.id);
    const report = collectReport(notesOf.get(pid) ?? [], day(p.start_date) || null);
    if (report.bills.length === 0) continue;
    withReport += 1;
    for (const b of report.bills) {
      if (!reportedBy.has(b.ref_token)) reportedBy.set(b.ref_token, new Set());
      reportedBy.get(b.ref_token).add(pid);
    }
    const from = windowStart(p.start_date);
    const matched = matchBills(report.bills, pid, orders.filter((o) => o.so_day >= from), []);
    for (const b of matched) {
      bills += 1;
      if (b.match.status !== 'opened') { notOpened += 1; continue; }
      opened += 1;
      if (!b.match.other_event && !b.match.unlinked) { same += 1; continue; }
      moves.push({ token: b.ref_token, raw: b.ref_raw, amount: b.amount_sen, sp: b.salesperson_name, report: b.report_date, doc: b.match.so_doc_no, from: b.match.so_project_id, to: pid });
    }
  }

  const conflicts = [...reportedBy.entries()].filter(([, s]) => s.size > 1);
  const conflictSet = new Set(conflicts.map(([t]) => t));
  console.log(`events with a sales report in chat: ${withReport} | bills ${bills} | opened ${opened} (already on this event ${same}) | not opened ${notOpened}`);
  console.log(`would move: ${moves.filter((m) => !conflictSet.has(m.token)).length} (from another event ${moves.filter((m) => m.from != null && !conflictSet.has(m.token)).length}, from no event ${moves.filter((m) => m.from == null && !conflictSet.has(m.token)).length}) | held back, booklet in two reports: ${moves.filter((m) => conflictSet.has(m.token)).length}`);
  console.log(`booklet numbers listed by two or more events' reports: ${conflicts.length}`);
  for (const [t, s] of conflicts.slice(0, 30)) console.log(`  ${t}: ${[...s].map((id) => `#${id} ${name.get(id)}`).join(' | ')}`);

  console.log('\ndoc | booklet | report day | report amount | order RM | order status | so_date | order brand | from event → to event (brand) | held back?');
  for (const m of moves.sort((a, b) => String(a.doc).localeCompare(String(b.doc)))) {
    const o = orderByDoc.get(m.doc);
    console.log(`${m.doc} | ${m.raw} | ${m.report ?? '—'} | ${rm(m.amount)} | ${rm(o?.local_total_sen)} | ${o?.status} | ${o?.so_day} | ${o?.branding ?? '—'} | ${m.from == null ? '(no event)' : `#${m.from} ${name.get(m.from) ?? ''}`} → #${m.to} ${name.get(m.to)} (${brandOf.get(m.to) ?? '—'}) | ${conflictSet.has(m.token) ? 'YES — two reports' : ''}`);
  }
} finally {
  await sql.end();
}
