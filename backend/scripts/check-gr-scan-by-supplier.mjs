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

  // Only scans a person went on to create a goods receipt from, one per DO: the
  // honest rate (re-scans of a DO already received cannot tie and inflate the misses).
  const made = await sql`
    SELECT coalesce(s.name, '(supplier not found)') AS supplier,
           count(DISTINCT coalesce(j.review->>'doNo', j.id::text))::int AS dos,
           coalesce(sum(jsonb_array_length(coalesce(j.review->'lines', '[]'::jsonb))), 0)::int AS lines,
           coalesce(sum((SELECT count(*) FROM jsonb_array_elements(coalesce(j.review->'lines', '[]'::jsonb)) e WHERE e->>'poItemId' IS NOT NULL)), 0)::int AS tied
      FROM scm.scan_jobs j
      LEFT JOIN scm.suppliers s ON s.id::text = j.review->>'supplierId'
     WHERE j.document_type = 'GR' AND j.created_at >= now() - make_interval(days => ${DAYS}) AND j.review_state = 'created'
     GROUP BY 1 ORDER BY 2 DESC`;
  console.log('');
  console.log('Of those, scans a goods receipt was created from (lines as saved by the person):');
  console.log('supplier | DOs | lines | tied | tied%');
  for (const r of made) console.log(`${r.supplier} | ${r.dos} | ${r.lines} | ${r.tied} | ${r.lines ? Math.round((100 * r.tied) / r.lines) : 0}%`);

  const states = await sql`
    SELECT coalesce(review_state, '(none)') AS state, status, count(*)::int AS n
      FROM scm.scan_jobs WHERE document_type = 'GR' AND created_at >= now() - make_interval(days => ${DAYS})
     GROUP BY 1, 2 ORDER BY 3 DESC`;
  console.log('');
  console.log('scan states: ' + states.map((r) => `${r.state}/${r.status}=${r.n}`).join(', '));

  const lost = await sql`
    SELECT to_char(created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'MM-DD HH24:MI') AS at, review_state, status,
           lower(substring(coalesce(file_name, '') from '\.([a-z0-9]+)$')) AS ext, left(coalesce(error, ''), 90) AS note
      FROM scm.scan_jobs
     WHERE document_type = 'GR' AND created_at >= now() - make_interval(days => ${DAYS})
       AND (review->>'supplierId') IS NULL
     ORDER BY created_at`;
  console.log('');
  console.log('Scans with no supplier found:');
  for (const r of lost) console.log(`${r.at} | ${r.ext || '?'} | ${r.review_state}/${r.status} | ${r.note}`);

  // Per supplier, what the matcher said about the scans it could not fully tie.
  const notes = await sql`
    SELECT coalesce(s.name, '?') AS supplier, to_char(j.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'MM-DD HH24:MI') AS at,
           j.review_state, jsonb_array_length(coalesce(j.review->'lines', '[]'::jsonb))::int AS lines,
           (SELECT count(*) FROM jsonb_array_elements(coalesce(j.review->'lines', '[]'::jsonb)) e WHERE e->>'poItemId' IS NOT NULL)::int AS tied,
           left(regexp_replace(coalesce(j.error, ''), '\s+', ' ', 'g'), 160) AS note
      FROM scm.scan_jobs j
      JOIN scm.suppliers s ON s.id::text = j.review->>'supplierId'
     WHERE j.document_type = 'GR' AND j.created_at >= now() - make_interval(days => ${DAYS})
       AND s.name NOT ILIKE 'HOOKKA%'
     ORDER BY 1, j.created_at`;
  console.log('');
  console.log('Other suppliers, each scan: when | state | lines tied/read | note');
  for (const r of notes) console.log(`${r.supplier.slice(0, 14)} | ${r.at} | ${r.review_state} | ${r.tied}/${r.lines} | ${r.note}`);
} finally {
  await sql.end();
}
