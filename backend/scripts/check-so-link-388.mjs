#!/usr/bin/env node
// check-so-link-388.mjs — READ-ONLY. Owner 2026-10-22 「我link 不到」 on Fair
// Links for HC-SO-2609-388: the order's fair columns now, and its fair History
// (who linked what, when) — did the Link land, and why is it still listed?
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const docs = ['HC-SO-2609-388'];
  const so = await sql`
    SELECT doc_no, so_date::text AS d, venue, venue_source, project_id, fair_match, fair_date::text AS fair_date, branding, status,
           fair_put_aside_at::text AS aside
      FROM scm.mfg_sales_orders WHERE doc_no = ANY(${docs})`;
  for (const r of so) console.log(`ROW|${r.doc_no} ${r.d} venue=${r.venue} (${r.venue_source}) project=${r.project_id} match=${r.fair_match} fair_date=${r.fair_date} brand=${r.branding} status=${r.status} aside=${r.aside ?? '-'}`);
  const pids = so.map((r) => r.project_id).filter((v) => v != null);
  if (pids.length) {
    const p = await sql`SELECT id, name, venue, start_date::text AS s, end_date::text AS e FROM projects WHERE id = ANY(${pids})`;
    for (const r of p) console.log(`ROW|project #${r.id} ${r.name} venue=${r.venue} ${r.s}..${r.e}`);
  }
  const hist = await sql`
    SELECT so_doc_no, to_char(created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD HH24:MI') AS at, actor_name_snapshot AS who, action, source, field_changes::text AS fc
      FROM scm.mfg_so_audit_log
     WHERE so_doc_no = ANY(${docs}) AND created_at >= '2026-10-20'
     ORDER BY created_at`;
  for (const h of hist) console.log(`ROW|hist ${h.at} ${h.who ?? '?'} ${h.action}/${h.source} ${h.fc.slice(0, 220)}`);
} finally { await sql.end(); }
