#!/usr/bin/env node
// check-scan-fair-chain.mjs — READ-ONLY. Trial of the owner's 2026-10-19
// order for placing a SCANNED order in a fair:
// 「先优先匹配上地点和日期和他站的场。如果没有就地点和日期，没有就他今天站的场，
//  再没有就他最近站的场」
//   1. slip place + slip date + a fair the keyer is on (Sales Attending / PIC)
//   2. slip place + slip date, any fair there that day
//   3. the keyer's fair running on the day it was scanned
//   4. the keyer's latest fair, ended within 1 month
// Per step: how many scanned orders land there, and does the fair agree with
// the one the order carries now. Slip place/date come from
// scm.so_scan_samples.extracted (scan_jobs.sample_id / so_doc_no).
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-scan-fair-chain.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-26');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const endOf = (f) => day(f.end_date) || day(f.start_date);
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const runs = (f, d) => day(f.start_date) <= d && endOf(f) >= d;
const sameEvent = (a, b) => norm(a.venue) === norm(b.venue) && day(a.start_date) === day(b.start_date);

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
    SELECT so.doc_no, so.project_id, so.so_date, st.user_id AS uid,
           s.extracted->>'slipDate' AS slip_date,
           coalesce(s.extracted->'locationMatch'->>'value', s.extracted->>'locationMatch') AS slip_place
      FROM scm.scan_jobs j
      JOIN scm.mfg_sales_orders so ON so.doc_no = j.so_doc_no
      LEFT JOIN scm.so_scan_samples s ON s.id = j.sample_id
      LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text <> 'CANCELLED'`;

  const t = {};
  const bump = (k) => { t[k] = (t[k] ?? 0) + 1; };
  for (const r of rows) {
    const sd = ISO.test(String(r.slip_date ?? '').trim()) ? String(r.slip_date).trim() : '';
    const place = norm(r.slip_place);
    const keyed = day(r.so_date);
    const uid = r.uid != null ? Number(r.uid) : null;
    const own = uid == null ? [] : fairs.filter((f) => (mine.get(uid) ?? new Set()).has(Number(f.id)));
    let step = '5 none'; let hit = null;
    const s1 = sd && place ? own.filter((f) => norm(f.venue) === place && runs(f, sd)) : [];
    const s2 = sd && place ? fairs.filter((f) => norm(f.venue) === place && runs(f, sd)) : [];
    const s3 = own.filter((f) => runs(f, keyed));
    const s4 = own.filter((f) => endOf(f) < keyed && endOf(f) >= addDays(keyed, -30)).sort((a, b) => endOf(b).localeCompare(endOf(a)));
    if (s1.length) { step = '1 place+date+his fair'; hit = s1[0]; }
    else if (s2.length) { step = '2 place+date'; hit = s2[0]; }
    else if (s3.length) { step = '3 his fair today'; hit = s3[0]; }
    else if (s4.length) { step = '4 his latest fair (1 month)'; hit = s4[0]; }
    const linked = r.project_id != null ? byId.get(Number(r.project_id)) ?? null : null;
    const v = !hit ? '' : !linked ? ' | not linked now' : sameEvent(hit, linked) ? ' | same fair as now' : ' | OTHER fair than now';
    bump(`${step}${v}`);
  }
  console.log(`company ${CO}, scanned orders dated ${FROM} onward: ${rows.length}`);
  for (const k of Object.keys(t).sort()) console.log(`  ${k} — ${t[k]}`);
} finally {
  await sql.end();
}
