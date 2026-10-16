#!/usr/bin/env node
// check-fair-saleday-from-payment.mjs — READ-ONLY. Can the day a sale was made
// be DETECTED rather than typed, from the order's first payment date?
//
// WHY. The owner, 2026-10-16, on asking reps to type the sale day: 「这个不是填哦，
// 也是 detect 哦」. A fair deposit is paid on the spot, so the earliest payment's
// paid_at (the slip's date, scm.mfg_sales_order_payments) should be the sale
// day. Measured against the orders' own fair_date (the day picked with the fair)
// and, through the owner's park rule (the rep's fair running that day, else the
// latest one they stood at), against the links the orders carry now.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-fair-saleday-from-payment.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-26');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const eventKey = (f) => `${norm(f.venue)}|${day(f.start_date)}|${day(f.end_date)}`;
const endOf = (f) => day(f.end_date) || day(f.start_date);

try {
  const fairs = await sql`
    SELECT p.id, p.venue, p.brand, p.start_date, p.end_date, p.pic_id
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
  const park = (uid, d) => {
    const own = uid == null ? [] : fairs.filter((f) => (mine.get(uid) ?? new Set()).has(Number(f.id)));
    if (!own.length) return null;
    const running = own.filter((f) => day(f.start_date) <= d && endOf(f) >= d);
    if (running.length) return { how: 'ongoing', fair: running[0] };
    const started = own.filter((f) => day(f.start_date) <= d);
    if (!started.length) return null;
    return { how: 'latest', fair: started.reduce((a, b) => (endOf(b) > endOf(a) ? b : a)) };
  };

  const orders = await sql`
    SELECT so.doc_no, so.so_date, so.fair_date, so.project_id, st.user_id AS uid,
           (SELECT min(p.paid_at) FROM scm.mfg_sales_order_payments p
             WHERE p.so_doc_no = so.doc_no AND p.method::text <> 'converted' AND p.amount_sen > 0
               AND p.mirror_of_payment_id IS NULL) AS first_paid,
           (SELECT count(*) FROM scm.mfg_so_audit_log a WHERE a.so_doc_no = so.doc_no AND a.action = 'CREATE' AND a.source = 'scan')::int AS scanned
      FROM scm.mfg_sales_orders so LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text NOT IN ('CANCELLED', 'DRAFT')`;
  const tally = {};
  const bump = (k) => { tally[k] = (tally[k] ?? 0) + 1; };
  for (const o of orders) {
    const pay = day(o.first_paid);
    const fd = day(o.fair_date);
    const via = o.scanned > 0 ? 'scan' : 'typed';
    const linked = o.project_id != null ? byId.get(Number(o.project_id)) ?? null : null;
    if (!pay) { bump(`${via} | no payment date`); continue; }
    /* 1. The payment date against the sale day the rep picked. */
    if (fd) {
      const dd = Math.round((Date.parse(pay) - Date.parse(fd)) / 864e5);
      bump(`${via} | payment vs fair_date | ${dd === 0 ? 'same day' : Math.abs(dd) <= 3 ? 'within 3 days' : dd > 0 ? 'payment 4+ days later' : 'payment 4+ days earlier'}`);
    }
    if (linked) bump(`${via} | payment day inside the linked fair | ${pay >= day(linked.start_date) && pay <= endOf(linked) ? 'yes' : 'no'}`);
    /* 2. The park rule on the payment day, against the link now. */
    const r = park(o.uid != null ? Number(o.uid) : null, pay);
    const v = !r ? 'nothing (rep on no fair)' : !linked ? `${r.how} | not linked now` : eventKey(r.fair) === eventKey(linked) ? `${r.how} | same fair as now` : `${r.how} | OTHER fair`;
    bump(`${via} | park on payment day | ${v}`);
  }
  console.log(`company ${CO}, orders dated ${FROM} onward: ${orders.length}`);
  for (const k of Object.keys(tally).sort()) console.log(`  ${k} — ${tally[k]}`);
} finally {
  await sql.end();
}
