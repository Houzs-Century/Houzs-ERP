#!/usr/bin/env node
// check-fair-autodetect-by-date.mjs — READ-ONLY. Can an order's fair be found
// from (a) the fairs opened in PMS, (b) the ones its salesperson is assigned to
// (Sales Attending / PIC) and (c) the DAY the sale was made?
//
// WHY. The owner, 2026-10-16: 「还是以 autodetect 为准。autodetect 的一定是以 pms
// 开了的 fair + 自己有被 assign 去这场 fair 为准」 — the salesperson picks only
// when that finds nothing. A rep usually stands at several fairs a month and keys
// orders days or weeks later, so the KEYED date cannot say which; a sale day can,
// if a rep is at one fair per day. Measured here, against the links orders carry:
//   - per rep-day: how many of the rep's fairs are running (is "one per day" true?);
//   - per order: the rep's fairs running on its fair_date (the day picked with the
//     fair), and on its so_date (the day it was keyed): none / one / several, and
//     when one, whether it is the order's fair.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-fair-autodetect-by-date.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-26');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const eventKey = (f) => `${norm(f.venue)}|${norm(f.organizer)}|${day(f.start_date)}|${day(f.end_date)}`;
const runsOn = (f, d) => day(f.start_date) <= d && (day(f.end_date) || day(f.start_date)) >= d;
const label = (f) => (f ? `${f.id}:${f.brand ?? '?'}@${f.venue}/${day(f.start_date)}..${day(f.end_date)}` : '—');

try {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const fairs = await sql`
    SELECT p.id, p.venue, p.organizer, p.brand, p.start_date, p.end_date, p.pic_id
      FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date IS NOT NULL AND p.venue IS NOT NULL AND trim(p.venue) <> ''
       AND p.start_date >= ${addDays(FROM, -150)}`;
  const byId = new Map(fairs.map((f) => [Number(f.id), f]));
  const att = await sql`
    SELECT a.project_id, sr.user_id FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id
     WHERE a.project_id IN ${sql(fairs.map((f) => Number(f.id)))} AND sr.user_id IS NOT NULL`;
  const mine = new Map(); // user → Set(project id)
  const put = (u, p) => { if (u == null) return; const k = Number(u); if (!mine.has(k)) mine.set(k, new Set()); mine.get(k).add(Number(p)); };
  for (const a of att) put(a.user_id, a.project_id);
  for (const f of fairs) put(f.pic_id, f.id);
  const ownEventsOn = (uid, d) => {
    const ids = mine.get(uid);
    if (!ids || !d) return [];
    return [...new Map(fairs.filter((f) => ids.has(Number(f.id)) && runsOn(f, d)).map((f) => [eventKey(f), f])).values()];
  };

  /* 1. Is a rep at one fair a day? Every rep-day from 60 days back to today. */
  const perDay = { one: 0, several: 0 };
  const severalEx = [];
  for (const [uid] of mine) {
    for (let d = addDays(FROM, -60); d <= today; d = addDays(d, 1)) {
      const n = ownEventsOn(uid, d);
      if (n.length === 1) perDay.one += 1;
      else if (n.length > 1) { perDay.several += 1; if (severalEx.length < 12) severalEx.push(`user ${uid} on ${d}: ${n.map(label).join(' + ')}`); }
    }
  }
  console.log(`company ${CO}: rep-days (${addDays(FROM, -60)} → ${today}) with exactly one own fair running: ${perDay.one}; with 2+: ${perDay.several}`);
  for (const e of severalEx) console.log('  ' + e);

  /* 2. Orders since FROM. */
  const orders = await sql`
    SELECT so.doc_no, so.so_date, so.fair_date, so.project_id, so.fair_match, so.local_total_sen, st.user_id AS uid, st.name AS sp
      FROM scm.mfg_sales_orders so LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text NOT IN ('CANCELLED', 'DRAFT')`;
  const tally = {};
  const bump = (k) => { tally[k] = (tally[k] ?? 0) + 1; };
  const wrong = [];
  for (const o of orders) {
    const uid = o.uid != null ? Number(o.uid) : null;
    const linked = o.project_id != null ? byId.get(Number(o.project_id)) ?? null : null;
    const fd = day(o.fair_date);
    bump(`has fair_date: ${fd ? 'yes' : 'no'} | ${linked ? 'linked' : 'not linked'}`);
    for (const [name, d] of [['by fair_date', fd], ['by keyed date', day(o.so_date)]]) {
      if (!d) continue;
      const ev = uid == null ? [] : ownEventsOn(uid, d);
      let k;
      if (ev.length === 0) k = 'no own fair that day';
      else if (ev.length > 1) k = 'several own fairs that day';
      else if (!linked) k = 'one own fair | order not linked';
      else if (eventKey(ev[0]) === eventKey(linked)) k = 'one own fair | = the order\'s fair';
      else { k = 'one own fair | ≠ the order\'s fair'; if (name === 'by fair_date' && wrong.length < 15) wrong.push(`${o.doc_no} ${o.sp ?? '?'} fair_date ${fd} | linked ${label(linked)} | own fair that day ${label(ev[0])}`); }
      bump(`${name} | ${k}`);
    }
  }
  console.log(`\norders dated ${FROM} onward: ${orders.length}`);
  for (const k of Object.keys(tally).sort()) console.log(`  ${k} — ${tally[k]}`);
  console.log('\nfair_date names one own fair, but not the order\'s:');
  for (const w of wrong) console.log('  ' + w);
} finally {
  await sql.end();
}
