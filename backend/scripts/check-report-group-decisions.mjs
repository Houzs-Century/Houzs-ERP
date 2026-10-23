#!/usr/bin/env node
// check-report-group-decisions.mjs — READ-ONLY. Before Fair Links' report
// group honours a person's decision (owner 2026-10-23): how fair changes sit in
// History (mfg_so_audit_log UPDATE_FAIR — sources, field names), and the fair
// History of the four orders on his screenshot.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const DOCS = ['HC-SO-2610-065', 'HC-SO-2610-037', 'HC-SO-2609-044', 'HC-SO-013507'];
try {
  const kinds = await sql.unsafe(`
    SELECT source, COALESCE((SELECT string_agg(DISTINCT c->>'field', ',') FROM jsonb_array_elements(field_changes) c), '-') AS fields, count(*) AS n
      FROM scm.mfg_so_audit_log WHERE action = 'UPDATE_FAIR'
     GROUP BY 1, 2 ORDER BY 3 DESC`);
  for (const r of kinds) console.log(`ROW|kind source=${r.source} fields=${r.fields} n=${r.n}`);
  const rows = await sql.unsafe(`
    SELECT so_doc_no, source, field_changes, created_at, actor_name_snapshot
      FROM scm.mfg_so_audit_log WHERE action = 'UPDATE_FAIR' AND so_doc_no = ANY($1)
     ORDER BY so_doc_no, created_at`, [DOCS]);
  for (const r of rows) console.log(`ROW|${r.so_doc_no} ${new Date(r.created_at).toISOString()} ${r.source} by ${r.actor_name_snapshot ?? '-'} ${JSON.stringify(r.field_changes)}`);
  console.log(`ROW|history rows for the four: ${rows.length}`);
  const settled = await sql.unsafe(`
    SELECT count(DISTINCT so_doc_no) AS n FROM scm.mfg_so_audit_log
     WHERE action = 'UPDATE_FAIR' AND source IN ('settle', 'transfer')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(field_changes) c WHERE c->>'field' = 'fair')`);
  console.log(`ROW|orders ever linked/transferred by hand on Fair Links: ${settled[0].n}`);
} finally { await sql.end(); }
