#!/usr/bin/env node
// check-3pl-bill-lines.mjs — READ ONLY. After #4922 deploys: do the 3PL bill
// tables exist on production, and what has the half-hourly reader kept so far
// (bills read, by whom, errors; lines by where they went; DO charges from AP
// invoices)? Writes nothing. Env: DATABASE_URL.
import postgres from 'postgres';

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const [t] = await sql`SELECT to_regclass('scm.threepl_bill_lines') IS NOT NULL AS lines, to_regclass('scm.threepl_bill_reads') IS NOT NULL AS reads,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'threepl_do_charges' AND column_name = 'billed_by_hand') AS col`;
    console.log(`ROW|tables: bill_lines ${t.lines}, bill_reads ${t.reads}, billed_by_hand ${t.col === 1}`);
    if (!t.lines || !t.reads) return;
    const reads = await sql`SELECT r.company_id, i.invoice_number, s.name AS supplier, i.total_sen, r.read_by, r.read_at, r.files_count, r.attempts, r.error
      FROM scm.threepl_bill_reads r JOIN scm.ap_invoices i ON i.id = r.ap_invoice_id LEFT JOIN scm.suppliers s ON s.id = i.supplier_id
      ORDER BY r.read_at DESC`;
    console.log(`ROW|bills read: ${reads.length}`);
    for (const r of reads) console.log(`ROW|  co${r.company_id} ${r.invoice_number} ${r.supplier} RM ${(Number(r.total_sen) / 100).toFixed(2)} by ${r.read_by} at ${new Date(r.read_at).toISOString()} files ${r.files_count} attempts ${r.attempts}${r.error ? ` ERROR ${r.error}` : ''}`);
    const parts = await sql`SELECT company_id, coalesce(assign, 'to_check') AS a,
        count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen,
        count(*) FILTER (WHERE assign IS NULL OR (assign = 'do' AND cardinality(do_ids) = 0) OR (assign = 'event' AND project_id IS NULL))::int AS open
      FROM scm.threepl_bill_lines GROUP BY 1, 2 ORDER BY 1, 2`;
    for (const p of parts) console.log(`ROW|lines co${p.company_id} ${p.a}: ${p.n} (RM ${(Number(p.sen) / 100).toFixed(2)}), open ${p.open}`);
    const [ch] = await sql`SELECT count(*)::int AS n, count(ap_invoice_id)::int AS from_ap, coalesce(sum(billed_sen) FILTER (WHERE ap_invoice_id IS NOT NULL), 0)::bigint AS sen FROM scm.threepl_do_charges`;
    console.log(`ROW|DO charges: ${ch.n} rows, ${ch.from_ap} from AP invoices (RM ${(Number(ch.sen) / 100).toFixed(2)})`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
