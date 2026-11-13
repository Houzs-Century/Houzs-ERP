// Read-only: what happened to the delivery-order scans uploaded in a time window.
// For each GR scan job it prints the stored note, the stored read's shape (how
// many lines, whether the model's raw text was cut off before its closing brace)
// and the model calls booked in the same window (output tokens against the cap).
//
// Built for the 2026-11-13 18:15 MYT Hookka DO-2611-037 upload that came back with
// no lines. Actions logs are public, so it prints no money, no customer data and
// no raw model text: only ids, times, statuses, counts and the scanner's own notes.
//
// SELECT only. Exit 0 for every answer; only a failed query exits non-zero.
// Env: DATABASE_URL (required); SINCE / UNTIL (ISO, default the 2026-11-13 window).
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const SINCE = process.env.SINCE || '2026-11-13T09:45:00Z';
const UNTIL = process.env.UNTIL || '2026-11-13T11:00:00Z';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

// The stored error can embed the model's raw text after "Raw:"; drop that part.
const safeError = (e) => (typeof e === 'string' ? e.split('Raw:')[0].slice(0, 160) : null);

function shapeOf(extracted) {
  if (!extracted || typeof extracted !== 'object') return 'none';
  if (Array.isArray(extracted.lines)) {
    return `parsed: lines=${extracted.lines.length} doNo=${extracted.doNo ? 'yes' : 'no'} supplier=${extracted.supplierName ? 'yes' : 'no'}`;
  }
  const raw = typeof extracted.claudeText === 'string' ? extracted.claudeText : '';
  const rows = (raw.match(/"itemCode"/g) || []).length;
  return `FAILED: error="${safeError(extracted.error)}" rawChars=${raw.length} rawRowsStarted=${rows} rawEndsWithBrace=${raw.trimEnd().endsWith('}')}`;
}

async function main() {
  console.log(`Window ${SINCE} .. ${UNTIL}`);
  const jobs = await sql`
    SELECT j.id, j.created_at, j.updated_at, j.status, j.review_state, j.file_name, j.page_from, j.page_to,
           j.retry_count, j.error, j.sample_id, j.company_id,
           jsonb_array_length(coalesce(j.review->'lines', '[]'::jsonb)) AS review_lines,
           s.status AS sample_status, s.extracted
    FROM scm.scan_jobs j
    LEFT JOIN scm.so_scan_samples s ON s.id = j.sample_id
    WHERE j.document_type = 'GR' AND j.created_at >= ${SINCE} AND j.created_at < ${UNTIL}
    ORDER BY j.created_at`;
  console.log(`GR scan jobs: ${jobs.length}`);
  for (const j of jobs) {
    const secs = Math.round((new Date(j.updated_at) - new Date(j.created_at)) / 1000);
    console.log([
      `job ${j.id}`, `co=${j.company_id}`, `created=${new Date(j.created_at).toISOString()}`, `took=${secs}s`,
      `status=${j.status}`, `review_state=${j.review_state}`, `file=${j.file_name}`, `pages=${j.page_from ?? '-'}..${j.page_to ?? '-'}`,
      `retries=${j.retry_count}`, `reviewLines=${j.review_lines}`, `sample=${j.sample_status ?? 'none'}`,
    ].join(' | '));
    console.log(`  note: ${safeError(j.error)}`);
    console.log(`  read: ${shapeOf(j.extracted)}`);
  }

  const calls = await sql`
    SELECT created_at, feature, model, input_tokens, output_tokens, ok, http_status, left(coalesce(error, ''), 160) AS error
    FROM public.ai_usage_events
    WHERE feature LIKE 'scan_gr%' AND created_at >= ${SINCE} AND created_at < ${UNTIL}
    ORDER BY created_at`;
  console.log(`Model calls booked to scan_gr*: ${calls.length}`);
  for (const c of calls) {
    console.log(`  ${new Date(c.created_at).toISOString()} | ${c.feature} | ${c.model} | in=${c.input_tokens} out=${c.output_tokens} | ok=${c.ok} http=${c.http_status} | ${c.error}`);
  }
}

try {
  await main();
} catch (e) {
  console.error('query failed:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
