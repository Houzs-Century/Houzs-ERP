#!/usr/bin/env node
// check-setup-invoices.mjs — READ-ONLY. Owner 2026-10-21 「帮我检查先」 before he
// posts the September booth-setup AP invoices (DREAM ART, 900-B003): does each
// line's Event match what its description names (show, place, brand, dates)?
// Are there September fairs with sales but no setup bill? Any repeats?
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });

try {
  const lines = await sql`
    SELECT i.invoice_number, i.status, i.invoice_date::text AS d, i.supplier_invoice_ref AS ref, i.total_sen, s.name AS supplier,
           l.line_no, l.description, l.debit_account_code AS acct, l.amount_sen, l.project_id,
           p.name AS pname, p.brand, p.venue, p.organizer, p.start_date, p.end_date, p.status AS pstatus, p.archived_at
      FROM scm.ap_invoices i
      JOIN scm.ap_invoice_lines l ON l.invoice_id = i.id
      LEFT JOIN scm.suppliers s ON s.id = i.supplier_id
      LEFT JOIN public.projects p ON p.id = l.project_id
     WHERE i.company_id = ${CO} AND i.status <> 'CANCELLED'
       AND (l.debit_account_code IN ('900-B003', '900-B005', '900-E011') OR upper(coalesce(s.name, '')) LIKE '%DREAM ART%')
     ORDER BY i.invoice_number, l.line_no`;
  console.log(`Setup-account / DREAM ART AP invoice lines: ${lines.length}`);
  for (const l of lines) {
    console.log(`${l.invoice_number} ${l.status} ${l.d} ref ${l.ref ?? '—'} | ${l.supplier} | line ${l.line_no} ${l.acct} RM ${rm(l.amount_sen)} (invoice total RM ${rm(l.total_sen)})`);
    console.log(`   says: "${l.description ?? ''}"`);
    console.log(`   event: ${l.project_id ? `#${l.project_id} ${l.pname} | ${l.brand} | ${l.organizer} @ ${l.venue} | ${l.start_date}→${l.end_date ?? l.start_date} | ${l.pstatus}${l.archived_at ? ' ARCHIVED' : ''}` : '— none'}`);
  }

  const descs = new Map();
  for (const l of lines) { const k = (l.description ?? '').trim().toUpperCase(); descs.set(k, [...(descs.get(k) ?? []), l.invoice_number]); }
  const dup = [...descs.entries()].filter(([, v]) => v.length > 1);
  console.log(`\nSame description on more than one line: ${dup.length}`);
  for (const [k, v] of dup) console.log(`  "${k}" — ${v.join(', ')}`);

  const billed = new Set(lines.filter((l) => l.project_id).map((l) => Number(l.project_id)));
  const sepFairs = await sql`
    SELECT p.id, p.name, p.brand, p.start_date, p.end_date,
           (SELECT count(*) FROM scm.mfg_sales_orders so WHERE so.project_id = p.id AND so.status::text <> 'CANCELLED')::int AS orders
      FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date >= '2026-09-01' AND p.start_date <= '2026-09-30'
     ORDER BY p.start_date, p.name`;
  const missing = sepFairs.filter((f) => !billed.has(Number(f.id)));
  console.log(`\nSeptember fairs: ${sepFairs.length}; with a setup bill line ${sepFairs.length - missing.length}; without ${missing.length}`);
  for (const f of missing) console.log(`  #${f.id} ${f.name} | ${f.brand} | ${f.start_date}→${f.end_date ?? f.start_date} | orders ${f.orders}`);
} finally {
  await sql.end();
}
