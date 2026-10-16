#!/usr/bin/env node
// check-fair-golive-readiness.mjs — READ-ONLY. What PMS must have in order
// before the new fair rule goes live (owner, 2026-10-16: 「这个确定一下」 on
// "Sales Attending 填齐、地点名字对好").
//
//   1. Booths from FROM to UNTIL: which cannot be offered at all (no venue, no
//      organizer, no start date — the picker's own test, fair-options.ts
//      isPickableFair), and which have nobody on Sales Attending.
//   2. Salespeople with orders in the last 30 days who stand on NO fair that
//      ran in the 30 days before their latest order — they would be stopped.
//   3. Venue names: the venue master (what a scan's written place is matched to)
//      against the venues PMS fairs use, so one place under two names shows.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-15), UNTIL (default 2026-12-31).
//   npx tsx scripts/check-fair-golive-readiness.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-15');
const UNTIL = String(process.env.UNTIL || '2026-12-31');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const blank = (s) => String(s ?? '').trim() === '';
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const STOP = new Set(['THE', 'CENTRE', 'CENTER', 'CONVENTION', 'MALL', 'HALL', 'INTERNATIONAL', 'EXHIBITION', 'AND', 'OF', 'TRADE', 'ARENA']);
const words = (s) => norm(s).replace(/[^A-Z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));

try {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

  /* 1. Booths. */
  const booths = await sql`
    SELECT p.id, p.name, p.venue, p.organizer, p.brand, p.start_date, p.end_date, p.status, p.pic_id,
           (SELECT count(*) FROM public.project_sales_attendees a WHERE a.project_id = p.id)::int AS attending
      FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date >= ${FROM} AND p.start_date <= ${UNTIL}
     ORDER BY p.start_date, p.venue, p.id`;
  const notPickable = booths.filter((b) => blank(b.venue) || blank(b.organizer) || blank(b.start_date));
  const noTeam = booths.filter((b) => b.attending === 0);
  console.log(`company ${CO}: live booths starting ${FROM} → ${UNTIL}: ${booths.length} (past ${booths.filter((b) => day(b.start_date) <= today).length}, coming ${booths.filter((b) => day(b.start_date) > today).length})`);
  console.log(`  cannot be offered (no venue / organizer / start): ${notPickable.length}`);
  for (const b of notPickable) console.log(`    ${b.id} ${day(b.start_date)} ${b.brand ?? '?'} venue=${b.venue ?? '—'} organizer=${b.organizer ?? '—'} status=${b.status ?? '—'}`);
  console.log(`  nobody on Sales Attending: ${noTeam.length} (past ${noTeam.filter((b) => day(b.start_date) <= today).length}, coming ${noTeam.filter((b) => day(b.start_date) > today).length})`);
  for (const b of noTeam) console.log(`    ${b.id} ${day(b.start_date)}..${day(b.end_date)} ${b.brand ?? '?'} @ ${b.venue ?? '—'} / ${b.organizer ?? '—'}${b.pic_id != null ? ' (has PIC)' : ''}${day(b.start_date) > today ? ' [coming]' : ''}`);

  /* 2. Salespeople who would be stopped. */
  const reps = await sql`
    SELECT st.name, st.user_id, count(*)::int AS n, max(so.so_date) AS last_order
      FROM scm.mfg_sales_orders so JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${addDays(today, -30)} AND so.status::text <> 'CANCELLED'
     GROUP BY st.name, st.user_id ORDER BY n DESC`;
  const stood = await sql`
    SELECT DISTINCT u.uid, p.start_date, p.end_date FROM (
      SELECT sr.user_id AS uid, a.project_id FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id WHERE sr.user_id IS NOT NULL
      UNION SELECT p2.pic_id AS uid, p2.id FROM public.projects p2 WHERE p2.pic_id IS NOT NULL
    ) u JOIN public.projects p ON p.id = u.project_id
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled' AND p.start_date IS NOT NULL`;
  console.log(`\nsalespeople with orders in the last 30 days: ${reps.length}`);
  for (const r of reps) {
    const d = day(r.last_order);
    const mine = stood.filter((s) => r.user_id != null && Number(s.uid) === Number(r.user_id));
    const ok = mine.some((s) => day(s.start_date) <= d && (day(s.end_date) || day(s.start_date)) >= addDays(d, -30));
    if (!ok) console.log(`  WOULD BE STOPPED: ${r.name} — ${r.n} orders, latest ${d}${r.user_id == null ? ' (no login account linked)' : mine.length ? ` (last fair ended ${mine.map((s) => day(s.end_date) || day(s.start_date)).sort().at(-1)})` : ' (on no fair at all)'}`);
  }

  /* 3. Venue names. */
  const master = (await sql`SELECT name FROM public.project_venues WHERE active = 1 AND company_id = ${CO}`).map((r) => norm(r.name));
  const used = (await sql`
    SELECT DISTINCT upper(trim(p.venue)) AS v FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND p.venue IS NOT NULL AND trim(p.venue) <> '' AND p.start_date >= '2026-01-01'`).map((r) => norm(r.v));
  const masterSet = new Set(master);
  const usedSet = new Set(used);
  const onlyMaster = master.filter((v) => !usedSet.has(v)).sort();
  const onlyPms = used.filter((v) => !masterSet.has(v)).sort();
  console.log(`\nvenue master: ${master.length} names; venues on 2026 PMS fairs: ${used.length}`);
  console.log(`  on PMS fairs but NOT in the master (a scan can never be matched to these): ${onlyPms.length}`);
  for (const v of onlyPms) {
    const near = master.filter((m) => m !== v && words(m).some((w) => words(v).includes(w)));
    console.log(`    ${v}${near.length ? `   ~ master: ${near.join(' | ')}` : ''}`);
  }
  console.log(`  in the master but on NO 2026 PMS fair: ${onlyMaster.length}`);
  for (const v of onlyMaster) {
    const near = used.filter((u) => u !== v && words(u).some((w) => words(v).includes(w)));
    console.log(`    ${v}${near.length ? `   ~ PMS: ${near.join(' | ')}` : ''}`);
  }
} finally {
  await sql.end();
}
