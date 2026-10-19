#!/usr/bin/env node
// check-scan-brand-booth.mjs — READ-ONLY. The owner's 2026-10-19 brand rule for
// a scanned order: 「他被 assign 去 akemi 就只能 save akemi 的 brand」 — at a fair
// with several brand booths (AKEMI, DUNLOPILLO …) the order goes to its brand's
// booth, and the keyer must be on THAT booth's Sales Attending to confirm it.
// A brand with no booth there goes to the keyer's own booth.
//
// For scanned orders since FROM whose slip place + slip date name a fair: does
// the order's brand have a booth there, and is the keyer on it? Counts how many
// would confirm, and how many would wait for PMS (and why).
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-scan-brand-booth.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-26');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const endOf = (f) => day(f.end_date) || day(f.start_date);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

try {
  const fairs = await sql`
    SELECT p.id, p.venue, p.brand, p.start_date, p.end_date, p.pic_id FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date IS NOT NULL AND p.venue IS NOT NULL AND trim(p.venue) <> '' AND p.start_date >= '2026-06-01'`;
  const byId = new Map(fairs.map((f) => [Number(f.id), f]));
  const att = await sql`SELECT a.project_id, sr.user_id FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id WHERE sr.user_id IS NOT NULL`;
  const on = new Set(att.map((a) => `${a.user_id}:${a.project_id}`));
  for (const f of fairs) if (f.pic_id != null) on.add(`${f.pic_id}:${f.id}`);

  const rows = await sql`
    SELECT so.doc_no, so.branding, st.user_id AS uid, st.name AS sp,
           s.extracted->>'slipDate' AS slip_date,
           coalesce(s.extracted->'locationMatch'->>'value', s.extracted->>'locationMatch') AS slip_place
      FROM scm.scan_jobs j JOIN scm.mfg_sales_orders so ON so.doc_no = j.so_doc_no
      LEFT JOIN scm.so_scan_samples s ON s.id = j.sample_id
      LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text <> 'CANCELLED'`;
  const t = {}; const ex = [];
  const bump = (k) => { t[k] = (t[k] ?? 0) + 1; };
  for (const r of rows) {
    const sd = ISO.test(String(r.slip_date ?? '').trim()) ? String(r.slip_date).trim() : '';
    const place = norm(r.slip_place);
    if (!sd || !place) { bump('slip place/date not both read'); continue; }
    const booths = fairs.filter((f) => norm(f.venue) === place && day(f.start_date) <= sd && endOf(f) >= sd);
    if (!booths.length) { bump('no fair at that place on that date'); continue; }
    const brand = norm(r.branding);
    const brandBooth = booths.find((f) => brand && norm(f.brand) === brand);
    const mine = booths.filter((f) => r.uid != null && on.has(`${r.uid}:${f.id}`));
    let k;
    if (brandBooth) k = mine.some((f) => f.id === brandBooth.id) ? 'OK — on his brand\'s booth' : mine.length ? 'WAIT — brand has a booth there, he is on another booth' : 'WAIT — he is on no booth at that fair';
    else k = mine.length ? 'OK — brand has no booth there, goes to his own booth' : 'WAIT — brand has no booth and he is on no booth there';
    bump(k);
    if (k.includes('another booth') && ex.length < 10) ex.push(`${r.doc_no} ${r.sp ?? '?'} brand ${r.branding ?? '—'} @ ${place} ${sd} — he is on ${mine.map((f) => f.brand).join('/')}`);
  }
  console.log(`company ${CO}, scanned orders dated ${FROM} onward: ${rows.length}`);
  for (const k of Object.keys(t).sort()) console.log(`  ${k} — ${t[k]}`);
  console.log('\nexamples (brand has a booth, he is on another):');
  for (const e of ex) console.log('  ' + e);
} finally {
  await sql.end();
}
