#!/usr/bin/env node
// explore-oct-history.mjs — READ ONLY. Before back-filling the Event Commission
// change record for 1–19 October 2026 (owner 2026-10-26: 「10月的我也要算」 /
// 「本身不是有history吗？」): what the SO modification history holds in that
// window for Houzs — audit actions and their field shapes, amendment
// snapshots, and where recording (scm.so_total_changes) began. Writes nothing.
// Env: DATABASE_URL.
import postgres from 'postgres';

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const [rec] = await sql`SELECT min(changed_at) AS first, count(*)::int AS n FROM scm.so_total_changes WHERE company_id = 1`;
    console.log(`ROW|recording: first change ${rec.first ? new Date(rec.first).toISOString() : '-'} (${rec.n} rows)`);
    const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'mfg_so_audit_log' ORDER BY ordinal_position`;
    console.log(`ROW|audit columns: ${cols.map((c) => c.column_name).join(', ')}`);
    const acts = await sql`SELECT a.action, coalesce(a.source, '-') AS source, count(*)::int AS n, count(DISTINCT a.so_doc_no)::int AS orders
      FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no
      WHERE o.company_id = 1 AND a.created_at >= '2026-09-30T16:00:00Z' AND a.created_at < '2026-10-20T16:00:00Z'
      GROUP BY 1, 2 ORDER BY 3 DESC`;
    for (const r of acts) console.log(`ROW|action ${r.action} / ${r.source}: ${r.n} rows on ${r.orders} orders`);
    const fields = await sql`SELECT a.action, f->>'field' AS field, count(*)::int AS n
      FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no, jsonb_array_elements(a.field_changes) f
      WHERE o.company_id = 1 AND a.created_at >= '2026-09-30T16:00:00Z' AND a.created_at < '2026-10-20T16:00:00Z'
        AND a.action IN ('ADD_LINE', 'UPDATE_LINE', 'DELETE_LINE', 'CREATE', 'UPDATE_DETAILS')
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`;
    for (const r of fields) console.log(`ROW|field ${r.action}.${r.field}: ${r.n}`);
    const samples = await sql`SELECT a.so_doc_no, a.action, a.source, a.created_at, a.field_changes
      FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no
      WHERE o.company_id = 1 AND a.created_at >= '2026-10-05T00:00:00Z' AND a.created_at < '2026-10-06T00:00:00Z'
        AND a.action IN ('ADD_LINE', 'UPDATE_LINE', 'DELETE_LINE')
      ORDER BY a.created_at LIMIT 12`;
    for (const s of samples) console.log(`ROW|sample ${s.so_doc_no} ${s.action} ${s.source} ${new Date(s.created_at).toISOString()} ${JSON.stringify(s.field_changes).slice(0, 400)}`);
    const revCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'so_revisions' ORDER BY ordinal_position`;
    console.log(`ROW|so_revisions columns: ${revCols.map((c) => c.column_name).join(', ')}`);
    const revs = await sql`SELECT count(*)::int AS n, count(DISTINCT r.so_doc_no)::int AS orders FROM scm.so_revisions r
      JOIN scm.mfg_sales_orders o ON o.doc_no = r.so_doc_no WHERE o.company_id = 1 AND r.created_at >= '2026-09-30T16:00:00Z' AND r.created_at < '2026-10-20T16:00:00Z'`;
    console.log(`ROW|amendment snapshots in window: ${revs[0].n} on ${revs[0].orders} orders`);
    const itemCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'mfg_sales_order_items' ORDER BY ordinal_position`;
    console.log(`ROW|item columns: ${itemCols.map((c) => c.column_name).join(', ')}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
