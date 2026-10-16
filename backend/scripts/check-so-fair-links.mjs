#!/usr/bin/env node
// check-so-fair-links.mjs — READ-ONLY. Which Sales Orders reached their fair
// (PMS project) and, for the ones that did not, why.
//
// WHY. The owner, 2026-10-16: 「so detect 进project 现在是怎样detect？ 这个要确定，
// 会不会没有detect到的？」. Per order it prints the stored verdict (fair_match)
// and what the nightly reconcile's own rule (venue + 28-day window + brand,
// scm/lib/fair-options.ts resolveFair) answers TODAY, so an order the retry
// should already have linked stands out.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01).
//   npx tsx scripts/check-so-fair-links.mjs

import postgres from 'postgres';
import { lookbackWindow, resolveFair } from '../src/scm/lib/fair-options.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const stamp = (v) => (v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v == null ? '—' : String(v).slice(0, 16));
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { maximumFractionDigits: 0 });
const toFair = (p) => ({
  projectId: Number(p.id), venue: p.venue ?? null, organizer: p.organizer ?? null, brand: p.brand ?? null,
  startDate: day(p.start_date) || null, endDate: day(p.end_date) || null, status: p.status ?? null, eventType: null,
});

try {
  /* 1. The verdicts as they stand, by month. */
  const counts = await sql`
    SELECT to_char(so_date, 'YYYY-MM') AS month, coalesce(fair_match, 'NULL') AS fm,
           (project_id IS NOT NULL) AS linked, count(*)::int AS n, sum(local_total_sen)::bigint AS sen
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND so_date >= ${FROM} AND status::text NOT IN ('CANCELLED', 'DRAFT')
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
  console.log(`company ${CO}, orders dated ${FROM} onward (not cancelled/draft) — month | fair_match | linked | n | RM`);
  for (const r of counts) console.log(`  ${r.month} | ${r.fm.padEnd(9)} | ${r.linked ? 'linked' : 'not linked'} | ${r.n} | ${rm(r.sen)}`);

  /* 2. Every unlinked order: stored verdict vs what the venue rule says today. */
  const open = await sql`
    SELECT * FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND so_date >= ${FROM} AND status::text NOT IN ('CANCELLED', 'DRAFT') AND project_id IS NULL
     ORDER BY fair_match NULLS FIRST, so_date, doc_no`;
  console.log(`\nunlinked: ${open.length}`);
  console.log('stored | doc | so_date | created | updated | venue | brand | RM | today (venue rule) | candidates');
  const tally = {};
  for (const so of open) {
    const venue = String(so.venue ?? '').trim();
    let verdict = 'no venue';
    let cands = [];
    if (venue) {
      const { start, end } = lookbackWindow(day(so.so_date));
      cands = await sql`
        SELECT p.* FROM public.projects p
         WHERE p.venue IS NOT NULL AND trim(p.venue) <> '' AND p.start_date IS NOT NULL AND p.archived_at IS NULL
           AND lower(coalesce(p.status, '')) <> 'cancelled'
           AND lower(trim(p.venue)) = lower(trim(${venue}))
           AND p.start_date <= ${end} AND coalesce(p.end_date, p.start_date) >= ${start}
           AND p.company_id = ${CO}
         ORDER BY p.start_date, p.id`;
      const res = resolveFair({ candidates: cands.map(toFair), brand: so.branding ?? null, organizer: null });
      verdict = res.projectId != null ? `PICKED → ${res.projectId}` : res.match;
    }
    const key = `${so.fair_match ?? 'NULL'} → ${verdict.startsWith('PICKED') ? 'PICKED' : verdict}`;
    tally[key] = (tally[key] || 0) + 1;
    console.log([
      so.fair_match ?? 'NULL', so.doc_no, day(so.so_date), stamp(so.created_at), stamp(so.updated_at), venue || '—',
      so.branding ?? '—', rm(so.local_total_sen), verdict,
      cands.map((p) => `${p.id}:${p.brand ?? '?'}/${p.organizer ?? 'NO-ORG'}/${day(p.start_date)}..${day(p.end_date)}${p.status ? '/' + p.status : ''}${p.created_at ? ' made ' + stamp(p.created_at) : ''}`).join(' ; ') || '—',
    ].join(' | '));
  }
  console.log('\nstored → today:');
  for (const k of Object.keys(tally).sort()) console.log(`  ${String(tally[k]).padStart(4)}  ${k}`);

  /* 3. Has the nightly retry ever linked anything? A PICKED order whose fair was
        created after the order cannot have been picked from the dropdown. */
  const picked = await sql`
    SELECT so.doc_no, so.so_date, so.created_at AS so_created, so.updated_at AS so_updated, p.id AS pid, p.created_at AS p_created
      FROM scm.mfg_sales_orders so JOIN public.projects p ON p.id = so.project_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.fair_match = 'PICKED'
       -- projects.created_at is TEXT in UTC ('YYYY-MM-DD HH24:MI:SS'); the order's is timestamptz.
       AND (NULLIF(p.created_at, '')::timestamp AT TIME ZONE 'UTC') > so.created_at + interval '1 hour'
     ORDER BY so.created_at`;
  console.log(`\nPICKED orders whose fair was created AFTER the order: ${picked.length}`);
  for (const r of picked.slice(0, 25)) {
    console.log(`  ${r.doc_no} so ${day(r.so_date)} made ${stamp(r.so_created)} updated ${stamp(r.so_updated)} → project ${r.pid} made ${stamp(r.p_created)}`);
  }
} finally {
  await sql.end();
}
