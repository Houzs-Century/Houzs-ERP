#!/usr/bin/env node
// check-fair-park-rule.mjs — READ-ONLY. Trial of the owner's 2026-10-16 default
// for an order's fair, against the links orders carry now.
//
// The rule (owner, after confirming with the boss): 「自动 assign 去对的 fair，如果
// 迟开的话，就会自动 park 去 on going sales person 有站的 fair。如果没有 on going
// 就会去 latest 站的 fair。但他们还可以更改去对的 project」. Per order:
//   1. the salesperson's fairs (Sales Attending / PIC) running on the day it is
//      keyed → that fair ("ongoing");
//   2. none running → the latest one they stood at that has started ("latest");
//   3. booth → the order's brand booth there, else their own booth, else the
//      only booth.
// Also measured: the same rule fed the order's fair_date (the sale day) instead
// of the keyed day, so the two can be compared.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-fair-park-rule.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-26');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const eventKey = (f) => `${norm(f.venue)}|${day(f.start_date)}|${day(f.end_date)}`; // place + dates: two solo booths at one place are one fair
const endOf = (f) => day(f.end_date) || day(f.start_date);
const label = (f) => (f ? `${f.id}:${f.brand ?? '?'}@${f.venue}/${day(f.start_date)}..${endOf(f)}` : '—');

try {
  const fairs = await sql`
    SELECT p.id, p.venue, p.organizer, p.brand, p.start_date, p.end_date, p.pic_id
      FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date IS NOT NULL AND p.venue IS NOT NULL AND trim(p.venue) <> ''
       AND p.start_date >= ${addDays(FROM, -180)}`;
  const byId = new Map(fairs.map((f) => [Number(f.id), f]));
  const att = await sql`
    SELECT a.project_id, sr.user_id FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id
     WHERE a.project_id IN ${sql(fairs.map((f) => Number(f.id)))} AND sr.user_id IS NOT NULL`;
  const mine = new Map();
  const put = (u, p) => { if (u == null) return; const k = Number(u); if (!mine.has(k)) mine.set(k, new Set()); mine.get(k).add(Number(p)); };
  for (const a of att) put(a.user_id, a.project_id);
  for (const f of fairs) put(f.pic_id, f.id);

  /* The rule, for one salesperson, one day and one brand. */
  const park = (uid, d, brand) => {
    const own = uid == null ? [] : fairs.filter((f) => (mine.get(uid) ?? new Set()).has(Number(f.id)));
    if (own.length === 0) return { how: 'rep on no fair in PMS', booth: null };
    const running = own.filter((f) => day(f.start_date) <= d && endOf(f) >= d);
    let how; let pool;
    if (running.length) { how = 'ongoing'; pool = running; }
    else {
      const started = own.filter((f) => day(f.start_date) <= d);
      if (!started.length) return { how: 'rep\'s fairs all later', booth: null };
      const last = started.reduce((a, b) => (endOf(b) > endOf(a) || (endOf(b) === endOf(a) && day(b.start_date) > day(a.start_date)) ? b : a));
      how = 'latest'; pool = started.filter((f) => eventKey(f) === eventKey(last));
    }
    const ev = eventKey(pool.sort((a, b) => day(b.start_date).localeCompare(day(a.start_date)))[0]);
    const booths = fairs.filter((f) => eventKey(f) === ev).sort((a, b) => Number(a.id) - Number(b.id));
    const b = norm(brand);
    const booth = (b && booths.find((f) => norm(f.brand) === b)) || booths.find((f) => (mine.get(uid) ?? new Set()).has(Number(f.id))) || (booths.length === 1 ? booths[0] : null);
    return { how, booth };
  };

  const orders = await sql`
    SELECT so.doc_no, so.so_date, so.fair_date, so.branding, so.project_id, so.fair_match, so.local_total_sen, st.user_id AS uid, st.name AS sp
      FROM scm.mfg_sales_orders so LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text NOT IN ('CANCELLED', 'DRAFT')`;
  const tally = {};
  const bump = (k, sen) => { tally[k] ??= [0, 0]; tally[k][0] += 1; tally[k][1] += Math.round(Number(sen ?? 0) / 100); };
  const wrongEx = [];
  for (const o of orders) {
    const uid = o.uid != null ? Number(o.uid) : null;
    const linked = o.project_id != null ? byId.get(Number(o.project_id)) ?? { id: o.project_id, venue: '?', start_date: '', end_date: '' } : null;
    for (const [name, d] of [['keyed day', day(o.so_date)], ['sale day (fair_date)', day(o.fair_date)]]) {
      if (!d) { bump(`${name} | (no date on the order)`, o.local_total_sen); continue; }
      const r = park(uid, d, o.branding);
      let v;
      if (!r.booth) v = `nothing (${r.how})`;
      else if (!linked) v = `${r.how} | order not linked now`;
      else if (Number(linked.id) === Number(r.booth.id)) v = `${r.how} | same booth as now`;
      else if (eventKey(linked) === eventKey(r.booth)) v = `${r.how} | same fair, other booth`;
      else { v = `${r.how} | OTHER fair than now`; if (name === 'keyed day' && wrongEx.length < 12) wrongEx.push(`${o.doc_no} ${o.sp ?? '?'} keyed ${d} | now ${label(linked)} | parked ${label(r.booth)}`); }
      bump(`${name} | ${v}`, o.local_total_sen);
    }
  }
  console.log(`company ${CO}, orders dated ${FROM} onward: ${orders.length}`);
  for (const k of Object.keys(tally).sort()) console.log(`  ${k} — ${tally[k][0]} | RM ${tally[k][1].toLocaleString('en-MY')}`);
  console.log('\nexamples parked at another fair than the one the order is on now:');
  for (const w of wrongEx) console.log('  ' + w);
} finally {
  await sql.end();
}
