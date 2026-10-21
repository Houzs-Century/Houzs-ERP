#!/usr/bin/env node
// check-fair-count.mjs — READ-ONLY. How many pickable PMS fair booths there
// are per company (the "every fair" list Fair Links would offer), their date
// span, and the SPICE venues' names (owner 2026-10-21: why SETIA SPICE does not
// show for HC-SO-2610-002).
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const live = sql`p.venue IS NOT NULL AND trim(p.venue) <> '' AND p.start_date IS NOT NULL AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'`;
  const per = await sql`SELECT p.company_id, count(*)::int AS n, min(p.start_date)::text AS first, max(p.start_date)::text AS last FROM projects p WHERE ${live} GROUP BY 1 ORDER BY 1`;
  for (const r of per) console.log(`co${r.company_id}: ${r.n} booths, ${r.first} → ${r.last}`);
  const since = await sql`SELECT p.company_id, count(*)::int AS n FROM projects p WHERE ${live} AND p.start_date >= '2026-01-01' GROUP BY 1 ORDER BY 1`;
  for (const r of since) console.log(`co${r.company_id} since 2026-01-01: ${r.n}`);
  const spice = await sql`SELECT p.id, p.brand, p.organizer, p.venue, p.start_date::text AS s, p.end_date::text AS e FROM projects p WHERE ${live} AND p.venue ILIKE '%spice%' AND p.start_date >= '2026-06-01' ORDER BY p.start_date, p.brand`;
  for (const r of spice) console.log(`#${r.id} ${r.brand} ${r.organizer} @ ${r.venue} ${r.s}..${r.e}`);
  const so = await sql`SELECT doc_no, so_date::text AS d, venue, project_id, fair_match, coalesce(nullif(trim(ref), ''), customer_so_no) AS ref FROM scm.mfg_sales_orders WHERE doc_no IN ('HC-SO-2610-002', 'HC-SO-2610-003')`;
  for (const r of so) console.log(`${r.doc_no} ${r.d} venue=${r.venue} project=${r.project_id} match=${r.fair_match} ref=${r.ref}`);
} finally { await sql.end(); }
