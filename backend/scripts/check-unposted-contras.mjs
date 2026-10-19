#!/usr/bin/env node
// check-unposted-contras.mjs — READ-ONLY. Every reversal (contra) entry that was
// written but never POSTED, while the entry it voids is flagged reversed — the
// original then stays in the books AND the document's fresh posting is added, so
// the document counts twice.
//
// WHY. check-odb-journal-history.mjs (2026-10-20) found HC-ODB-2609-002 and -004
// booked twice: each was edited twice; the second edit's contra (JE-2609-0319,
// JE-2609-0962) stayed posted=false. acc/engine.ts reverseJournal inserts the
// contra unposted, then `update({ posted: true })` WITHOUT checking the error —
// and the unique index acc_je_one_active_source (one posted, not-reversed entry
// per company + source_type + source_doc_no) refuses it, because the FIRST
// contra of the same document is still an active <TYPE>_REVERSAL entry. The
// original is flagged reversed anyway and the caller posts afresh.
//
// Lists them across companies with the original, whether the document has a live
// posting now, and the amount; totals per company and source type.
//
// Writes nothing. Env: DATABASE_URL.
//   npx tsx scripts/check-unposted-contras.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });

try {
  const rows = await sql`
    SELECT je.company_id, je.source_type, je.je_no, je.entry_date::text AS entry_date, je.source_doc_no,
           je.total_debit_sen, to_char(je.created_at, 'YYYY-MM-DD HH24:MI') AS created,
           o.je_no AS orig_je, o.source_type AS orig_type, o.posted AS orig_posted, o.reversed AS orig_reversed,
           o.reversed_by_je = je.id AS orig_points_here,
           (SELECT count(*)::int FROM scm.journal_entries x
             WHERE x.company_id = o.company_id AND x.source_type = o.source_type AND x.source_doc_no = o.source_doc_no
               AND x.posted AND NOT x.reversed) AS live_now
      FROM scm.journal_entries je
      JOIN scm.journal_entries o ON o.id = je.reversed_by_je
     WHERE je.posted = false
     ORDER BY je.company_id, je.source_type, je.created_at`;
  console.log(`Unposted contras: ${rows.length}`);
  const tot = new Map();
  for (const r of rows) {
    const k = `company ${r.company_id} ${r.source_type}`;
    const t = tot.get(k) ?? { n: 0, sen: 0, double: 0 };
    t.n += 1; t.sen += Number(r.total_debit_sen);
    const counted = r.orig_posted && r.orig_reversed && r.live_now > 0;
    if (counted) t.double += 1;
    tot.set(k, t);
    console.log(`- co ${r.company_id} ${r.je_no} ${r.entry_date} ${r.source_type} doc ${r.source_doc_no ?? '—'} RM ${rm(r.total_debit_sen)} created ${r.created} | voids ${r.orig_je} (${r.orig_type}, posted=${r.orig_posted}, reversed=${r.orig_reversed}, points here=${r.orig_points_here}) | live postings of the doc now: ${r.live_now}${counted ? '  ← COUNTED TWICE' : ''}`);
  }
  console.log('\nBy company and type (contras / RM / documents counted twice):');
  for (const [k, t] of tot) console.log(`  ${k}: ${t.n} / RM ${rm(t.sen)} / ${t.double}`);
} finally {
  await sql.end();
}
