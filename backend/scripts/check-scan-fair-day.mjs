#!/usr/bin/env node
// check-scan-fair-day.mjs — READ-ONLY. Who gave a SCANNED order its Fair Day?
//
// WHY. The owner, 2026-10-16, disputing that a scan leaves the Fair Day empty:
// 「照理我的 fair 有个 period，扫描单上的 venue 对的上 fair，然后照理就应该对的上卖的
// 日期了」 / 「他扫描时不算有了吗？」. In code the scan job never sends a day
// (scan-so.ts has no fairDate; fairDayOnSave keeps a day only from an explicit
// event pick), so every scanned order's fair_date should trace to a PERSON
// editing it afterwards. Checked here: scanned orders since FROM, whether they
// carry a fair_date, and whether an audit row records a person setting it.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-scan-fair-day.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-26');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  const rows = await sql`
    WITH scanned AS (
      SELECT so.doc_no, so.fair_date, so.status::text AS status
        FROM scm.mfg_sales_orders so
       WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text <> 'CANCELLED'
         AND EXISTS (SELECT 1 FROM scm.mfg_so_audit_log a WHERE a.so_doc_no = so.doc_no AND a.action = 'CREATE' AND a.source = 'scan')
    )
    SELECT s.doc_no, s.fair_date IS NOT NULL AS has_day, s.status,
           EXISTS (SELECT 1 FROM scm.mfg_so_audit_log a, jsonb_array_elements(a.field_changes) fc
                    WHERE a.so_doc_no = s.doc_no AND a.action <> 'CREATE' AND fc->>'field' = 'fairDate') AS person_set_day,
           EXISTS (SELECT 1 FROM scm.mfg_so_audit_log a, jsonb_array_elements(a.field_changes) fc
                    WHERE a.so_doc_no = s.doc_no AND a.action = 'CREATE' AND fc->>'field' = 'fairDate') AS create_had_day
      FROM scanned s`;
  const t = {};
  for (const r of rows) {
    const k = `${r.has_day ? 'HAS Fair Day' : 'no Fair Day'} | set by a later edit: ${r.person_set_day ? 'yes' : 'no'} | in the scan's CREATE: ${r.create_had_day ? 'yes' : 'no'}`;
    t[k] = (t[k] ?? 0) + 1;
  }
  console.log(`company ${CO}, scanned orders dated ${FROM} onward (not cancelled): ${rows.length}`);
  for (const k of Object.keys(t).sort()) console.log(`  ${k} — ${t[k]}`);
} finally {
  await sql.end();
}
