#!/usr/bin/env node
// check-cn-line-event-column.mjs — READ-ONLY. After #4860 deploys: the credit
// note line event column exists, and how many supplier notes credit an AP
// invoice that carries an event (the ones that now post tagged).
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const col = await sql`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_credit_note_lines' AND column_name = 'project_id'`;
  console.log(`ROW|column project_id: ${col.length ? `${col[0].data_type} nullable=${col[0].is_nullable}` : 'MISSING'}`);
  const scn = await sql`
    SELECT n.status, count(*)::int AS n,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.ap_invoice_lines al WHERE al.invoice_id = n.ap_invoice_id AND al.project_id IS NOT NULL))::int AS with_event_invoice
      FROM scm.acc_credit_notes n WHERE n.kind = 'SCN' GROUP BY n.status ORDER BY n.status`;
  for (const r of scn) console.log(`ROW|SCN ${r.status}: ${r.n} (credits an AP invoice with an event: ${r.with_event_invoice})`);
} finally { await sql.end(); }
