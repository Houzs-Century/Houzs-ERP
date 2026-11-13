// Read-only: how the delivery-order scan has done per supplier over a window, as
// counts only (no item, price or customer data; Actions logs are public).
//
// WHY: after the 2026-11-13 Hookka DO-2611-037 fixes the owner asked whether other
// suppliers and product types read as well. This shows, per supplier: scans, reads
// that came back with no lines, failed reads, lines read, lines tied to a PO line.
//
// RE-RUN: Actions -> "Run a backend script on production" -> check-gr-scan-by-supplier.mjs,
//   mode plan. Env: DAYS=14. Writes nothing anywhere.
import postgres from 'postgres';

const DAYS = Math.max(1, Math.min(90, Number(process.env.DAYS || 14)));
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  const rows = await sql`
    SELECT coalesce(s.name, j.review->>'supplierRead', '(supplier not found)') AS supplier,
           count(*)::int AS scans,
           count(*) FILTER (WHERE j.status = 'error')::int AS failed,
           count(*) FILTER (WHERE j.status = 'done' AND jsonb_array_length(coalesce(j.review->'lines', '[]'::jsonb)) = 0)::int AS empty,
           coalesce(sum(jsonb_array_length(coalesce(j.review->'lines', '[]'::jsonb))), 0)::int AS lines,
           coalesce(sum((SELECT count(*) FROM jsonb_array_elements(coalesce(j.review->'lines', '[]'::jsonb)) e WHERE e->>'poItemId' IS NOT NULL)), 0)::int AS tied,
           count(*) FILTER (WHERE j.file_name ILIKE '%.pdf')::int AS pdfs
      FROM scm.scan_jobs j
      LEFT JOIN scm.suppliers s ON s.id::text = j.review->>'supplierId'
     WHERE j.document_type = 'GR' AND j.created_at >= now() - make_interval(days => ${DAYS})
     GROUP BY 1
     ORDER BY 2 DESC`;
  console.log(`GR scans, last ${DAYS} days, by supplier (check-step scans; 'tied' = lines matched to a PO line when read)`);
  console.log('supplier | scans | pdf | failed | empty | lines | tied | tied%');
  for (const r of rows) {
    const pct = r.lines ? Math.round((100 * r.tied) / r.lines) : 0;
    console.log(`${r.supplier} | ${r.scans} | ${r.pdfs} | ${r.failed} | ${r.empty} | ${r.lines} | ${r.tied} | ${pct}%`);
  }
} finally {
  await sql.end();
}
