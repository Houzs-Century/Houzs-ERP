#!/usr/bin/env node
// check-fair-transfers.mjs — READ-ONLY. The Fair Links "Report says another
// fair" transfers made since 2026-10-20: when, by whom, which orders, with
// each order's Ref No. (ref, else customer_so_no) as the SO page shows it.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT a.so_doc_no, a.actor_name_snapshot AS who,
           to_char(a.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD HH24:MI') AS at,
           a.field_changes, s.ref, s.customer_so_no, s.company_id
      FROM scm.mfg_so_audit_log a
      LEFT JOIN scm.mfg_sales_orders s ON s.doc_no = a.so_doc_no
     WHERE a.source = 'transfer' AND a.created_at >= '2026-10-19T16:00:00Z'
     ORDER BY a.created_at, a.so_doc_no`;
  console.log(`transfers since 2026-10-20 MYT: ${rows.length}`);
  for (const r of rows) {
    const fair = (r.field_changes ?? []).find((c) => c.field === 'fair');
    console.log(`${r.at} ${r.who ?? '?'} co${r.company_id} ${r.so_doc_no} ref=${(r.ref || r.customer_so_no || '-').trim()} | ${fair ? `${fair.from} -> ${fair.to}` : '-'}`);
  }
  const refs = await sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE coalesce(trim(ref), '') <> '')::int AS with_ref,
           count(*) FILTER (WHERE coalesce(trim(ref), '') = '' AND coalesce(trim(customer_so_no), '') <> '')::int AS only_cust
      FROM scm.mfg_sales_orders WHERE so_date >= '2026-09-01' AND status <> 'CANCELLED' AND company_id = 1`;
  console.log(`Houzs orders since 09-01: ${refs[0].n}, with ref ${refs[0].with_ref}, only customer_so_no ${refs[0].only_cust}`);
} finally { await sql.end(); }
