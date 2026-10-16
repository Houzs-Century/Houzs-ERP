#!/usr/bin/env node
// check-fair-keyer-gap.mjs — READ-ONLY. Two facts the owner's 2026-10-16 fair
// rule needs before it can be set:
//   1. 「remain 看打单的人」 — the fair follows the person who KEYS the order (the
//      CREATE audit row's actor), not the order's salesperson. How often are
//      they different people, and who keys for others?
//   2. 「可以往回追溯到最后一次站场的几久？1 个月？两个月？」 — when the keyer is
//      at no fair on the day of keying, the order parks at the LATEST fair they
//      stood at. How long ago did that fair end, order by order?
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-fair-keyer-gap.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-26');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const endOf = (f) => day(f.end_date) || day(f.start_date);
const gapDays = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

try {
  const fairs = await sql`
    SELECT p.id, p.start_date, p.end_date, p.pic_id
      FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date IS NOT NULL AND p.venue IS NOT NULL AND trim(p.venue) <> ''`;
  const byId = new Map(fairs.map((f) => [Number(f.id), f]));
  const att = await sql`
    SELECT a.project_id, sr.user_id FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id
     WHERE sr.user_id IS NOT NULL`;
  const mine = new Map();
  const put = (u, p) => { if (u == null || !byId.has(Number(p))) return; const k = Number(u); if (!mine.has(k)) mine.set(k, new Set()); mine.get(k).add(Number(p)); };
  for (const a of att) put(a.user_id, a.project_id);
  for (const f of fairs) put(f.pic_id, f.id);

  /* Where the rule would land, for one person on one day. */
  const bucket = (uid, d) => {
    if (uid == null) return 'no user account';
    const own = [...(mine.get(uid) ?? [])].map((id) => byId.get(id));
    if (!own.length) return 'never on any fair';
    if (own.some((f) => day(f.start_date) <= d && endOf(f) >= d)) return '0 ongoing that day';
    const ended = own.filter((f) => endOf(f) < d);
    if (!ended.length) return 'only future fairs';
    const last = ended.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
    const g = gapDays(d, endOf(last));
    return g <= 7 ? '1 latest ended 1-7 days before' : g <= 14 ? '2 latest ended 8-14 days before' : g <= 30 ? '3 latest ended 15-30 days before'
      : g <= 60 ? '4 latest ended 31-60 days before' : '5 latest ended 61+ days before';
  };

  const orders = await sql`
    SELECT so.doc_no, so.so_date, so.status::text AS status, so.salesperson_id::text AS sp_id, sp.name AS sp_name, sp.user_id AS sp_uid,
           c.actor_id::text AS keyer_id, c.source, k.name AS keyer_name, k.user_id AS keyer_uid
      FROM scm.mfg_sales_orders so
      LEFT JOIN scm.staff sp ON sp.id = so.salesperson_id
      LEFT JOIN LATERAL (
        SELECT a.actor_id, a.source FROM scm.mfg_so_audit_log a
         WHERE a.so_doc_no = so.doc_no AND a.action = 'CREATE' ORDER BY a.created_at LIMIT 1
      ) c ON true
      LEFT JOIN scm.staff k ON k.id = c.actor_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text <> 'CANCELLED'`;

  const t = {};
  const bump = (k) => { t[k] = (t[k] ?? 0) + 1; };
  const others = {};
  for (const o of orders) {
    const d = day(o.so_date);
    const same = o.keyer_id && o.sp_id && o.keyer_id === o.sp_id;
    bump(`keyed by ${!o.keyer_id ? 'unknown (no CREATE row)' : same ? 'the salesperson' : 'someone else'} | ${o.source ?? '?'}`);
    if (o.keyer_id && !same) { const k = `${o.keyer_name ?? o.keyer_id} for ${o.sp_name ?? '?'}`; others[k] = (others[k] ?? 0) + 1; }
    bump(`rule on KEYER      | ${bucket(o.keyer_uid != null ? Number(o.keyer_uid) : null, d)}`);
    bump(`rule on SALESPERSON | ${bucket(o.sp_uid != null ? Number(o.sp_uid) : null, d)}`);
  }
  console.log(`company ${CO}, orders dated ${FROM} onward (not cancelled): ${orders.length}`);
  for (const k of Object.keys(t).sort()) console.log(`  ${k} — ${t[k]}`);
  console.log('\nkeyed by someone else (keyer for salesperson — n):');
  for (const [k, n] of Object.entries(others).sort((a, b) => b[1] - a[1])) console.log(`  ${k} — ${n}`);
} finally {
  await sql.end();
}
