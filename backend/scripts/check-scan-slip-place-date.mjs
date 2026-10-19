#!/usr/bin/env node
// check-scan-slip-place-date.mjs — READ-ONLY. Trial of the owner's 2026-10-19
// rule for a SCANNED order: 「首先就是可以根据扫描单上的地点，日期然后 assign 的
// project 去对应他这张订单对应哪里一场 project」 — the place and the date written
// on the slip, together with the fairs the rep is on (Sales Attending / PIC),
// name the project; the Fair Day is the slip's date.
//
// The scan job keeps what the model read in scm.so_scan_samples.extracted
// (scan_jobs.sample_id → sample; scan_jobs.so_doc_no → order). Per scanned order
// since FROM: was a date / a place read, which of the rep's fairs ran at that
// place on that date, and is that the fair (and the Fair Day) the order carries
// now (set by a person while reviewing the draft)?
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-scan-slip-place-date.mjs

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
    SELECT p.id, p.venue, p.brand, p.start_date, p.end_date, p.pic_id
      FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date IS NOT NULL AND p.venue IS NOT NULL AND trim(p.venue) <> '' AND p.start_date >= '2026-06-01'`;
  const byId = new Map(fairs.map((f) => [Number(f.id), f]));
  const att = await sql`
    SELECT a.project_id, sr.user_id FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id
     WHERE sr.user_id IS NOT NULL`;
  const mine = new Map();
  const put = (u, p) => { if (u == null || !byId.has(Number(p))) return; const k = Number(u); if (!mine.has(k)) mine.set(k, new Set()); mine.get(k).add(Number(p)); };
  for (const a of att) put(a.user_id, a.project_id);
  for (const f of fairs) put(f.pic_id, f.id);

  const rows = await sql`
    SELECT so.doc_no, so.project_id, so.fair_date, so.venue, st.user_id AS uid,
           s.extracted->>'slipDate' AS slip_date,
           coalesce(s.extracted->'locationMatch'->>'value', s.extracted->>'locationMatch') AS slip_place_match,
           s.extracted->>'location' AS slip_place_raw
      FROM scm.scan_jobs j
      JOIN scm.mfg_sales_orders so ON so.doc_no = j.so_doc_no
      LEFT JOIN scm.so_scan_samples s ON s.id = j.sample_id
      LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text <> 'CANCELLED'`;

  const t = {};
  const bump = (k) => { t[k] = (t[k] ?? 0) + 1; };
  const ex = [];
  for (const r of rows) {
    const sd = ISO.test(String(r.slip_date ?? '').trim()) ? String(r.slip_date).trim() : '';
    const place = norm(r.slip_place_match);
    bump(`slip read | date: ${sd ? 'yes' : (r.slip_date ? 'unreadable' : 'none')} | place matched to the venue list: ${place ? 'yes' : (r.slip_place_raw ? 'written, not matched' : 'none')}`);
    if (r.fair_date && sd) bump(`slip date vs the Fair Day a person set | ${sd === day(r.fair_date) ? 'same' : 'different'}`);

    const uid = r.uid != null ? Number(r.uid) : null;
    const own = uid == null ? [] : fairs.filter((f) => (mine.get(uid) ?? new Set()).has(Number(f.id)));
    const linked = r.project_id != null ? byId.get(Number(r.project_id)) ?? null : null;
    /* The rule: place + date + assignment; date + assignment when the place
       does not agree or was not read; place + assignment when no date. */
    let hit = null; let how = 'nothing';
    if (sd) {
      const onDay = own.filter((f) => day(f.start_date) <= sd && endOf(f) >= sd);
      const both = onDay.filter((f) => place && norm(f.venue) === place);
      if (both.length) { hit = both[0]; how = 'place+date'; }
      else if (onDay.length) { hit = onDay[0]; how = place ? 'date only (place differs)' : 'date only (no place read)'; }
    } else if (place) {
      const atPlace = own.filter((f) => norm(f.venue) === place).sort((a, b) => endOf(b).localeCompare(endOf(a)));
      if (atPlace.length) { hit = atPlace[0]; how = 'place only (no date)'; }
    }
    const v = !hit ? `${how}` : !linked ? `${how} | order not linked now` : norm(hit.venue) === norm(linked.venue) && day(hit.start_date) === day(linked.start_date) ? `${how} | same fair as now` : `${how} | OTHER fair than now`;
    bump(`rule | ${v}`);
    if (v.includes('OTHER') && ex.length < 12) ex.push(`${r.doc_no} slip ${sd || '—'} @ ${place || r.slip_place_raw || '—'} | rule ${hit.id}:${hit.venue} ${day(hit.start_date)}..${endOf(hit)} | now ${linked.id}:${linked.venue} ${day(linked.start_date)}..${endOf(linked)}`);
  }
  console.log(`company ${CO}, scanned orders dated ${FROM} onward: ${rows.length}`);
  for (const k of Object.keys(t).sort()) console.log(`  ${k} — ${t[k]}`);
  console.log('\nrule names another fair than the one on the order now:');
  for (const e of ex) console.log('  ' + e);
} finally {
  await sql.end();
}
