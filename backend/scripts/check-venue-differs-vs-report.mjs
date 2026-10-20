#!/usr/bin/env node
// check-venue-differs-vs-report.mjs — READ-ONLY. Owner 2026-10-20 (先确定):
// transfer the "Venue differs" orders from each project page. What does the
// evening sales report (project chat) say about each of them today?
//   CONFIRMED  the report of the event the order is linked to lists it
//              (agreed rule: then it is right and the flag goes)
//   OTHER      another event's report lists it (that is where it belongs)
//   NONE       no event's report lists it (a person decides)
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), DOCS (comma list).
//   npx tsx scripts/check-venue-differs-vs-report.mjs
import postgres from 'postgres';
import { collectReport } from '../src/routes/lib/sales-report-bills.ts';
import { extractRefTokens } from '../src/scm/shared/sales-report-parse.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const stamp = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

try {
  const allProjects = await sql`SELECT id, name, venue, start_date, end_date FROM public.projects WHERE company_id = ${CO}`;
  const proj = new Map(allProjects.map((p) => [Number(p.id), p]));
  const label = (id) => { const p = proj.get(Number(id)); return p ? `#${p.id} ${p.name} (${day(p.start_date)}→${day(p.end_date) || day(p.start_date)})` : `#${id}`; };
  const notes = await sql`
    SELECT a.id, a.project_id, a.note, a.created_at, u.email AS author_email, ps.name AS author_position
      FROM public.project_activity a
      JOIN public.projects p ON p.id = a.project_id AND p.company_id = ${CO}
      LEFT JOIN public.users u ON u.id = a.user_id
      LEFT JOIN public.positions ps ON ps.id = u.position_id
     WHERE a.action = 'note' AND a.archived_at IS NULL`;
  const notesOf = new Map();
  for (const n of notes) {
    const k = Number(n.project_id);
    if (!notesOf.has(k)) notesOf.set(k, []);
    notesOf.get(k).push({ id: Number(n.id), note: n.note, created_at: stamp(n.created_at), author_email: n.author_email, author_position: n.author_position });
  }
  const reportedBy = new Map(); // token -> [{ pid, date, amount, sp }]
  for (const [pid, list] of notesOf) {
    const p = proj.get(pid);
    const report = collectReport(list, p ? day(p.start_date) || null : null);
    for (const b of report.bills) {
      if (!reportedBy.has(b.ref_token)) reportedBy.set(b.ref_token, []);
      reportedBy.get(b.ref_token).push({ pid, date: b.report_date, amount: b.amount_sen, sp: b.salesperson_name });
    }
  }
  const orders = DOCS.length === 0 ? [] : await sql`
    SELECT so.doc_no, so.project_id, so.venue, so.customer_so_no, so.ref, so.status::text AS status, so.local_total_sen, st.name AS sp_name
      FROM scm.mfg_sales_orders so LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.doc_no IN ${sql(DOCS)} ORDER BY so.doc_no`;
  const tally = { CONFIRMED: 0, OTHER: 0, NONE: 0 };
  for (const o of orders) {
    const tokens = new Set([...extractRefTokens(o.customer_so_no), ...extractRefTokens(o.ref)]);
    const hits = [...tokens].flatMap((t) => (reportedBy.get(t) ?? []).map((h) => ({ ...h, token: t })));
    const linked = o.project_id == null ? null : Number(o.project_id);
    const onLinked = hits.filter((h) => h.pid === linked);
    const elsewhere = hits.filter((h) => h.pid !== linked);
    const kind = onLinked.length > 0 ? 'CONFIRMED' : elsewhere.length > 0 ? 'OTHER' : 'NONE';
    tally[kind] += 1;
    console.log(`${o.doc_no} | ${kind} | booklet ${[...tokens].join('/') || '—'} | venue ${o.venue ?? '—'} | ${o.sp_name ?? '—'} | RM ${(Number(o.local_total_sen ?? 0) / 100).toFixed(2)} | linked ${linked == null ? '—' : label(linked)}${elsewhere.length ? ` | report: ${elsewhere.map((h) => `${label(h.pid)} on ${h.date ?? '—'} by ${h.sp ?? '—'}`).join(' ; ')}` : ''}`);
  }
  console.log(`\nCONFIRMED ${tally.CONFIRMED} | OTHER ${tally.OTHER} | NONE ${tally.NONE} | of ${orders.length}`);
} finally {
  await sql.end();
}
