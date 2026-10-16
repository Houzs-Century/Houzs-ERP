#!/usr/bin/env node
// check-showroom-venues.mjs — READ-ONLY. Which showrooms each company has, who
// is parked under them, and how many sales orders were written there.
//
// WHY. The owner, 2026-10-16, on the proposal that "No fair" be allowed only for
// showroom orders: 「houzs 这边应该不会有 showroom 的，不是吗？」. Answers it from
// the data: scm.warehouses flagged is_showroom (and their venue_name), the staff
// parked under each (scm.staff.showroom_warehouse_id), and the orders since FROM
// whose venue is a showroom's venue, by company and fair verdict.
//
// Writes nothing. Env: DATABASE_URL, FROM (default 2026-09-01).
//   npx tsx scripts/check-showroom-venues.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

try {
  const rooms = await sql`SELECT * FROM scm.warehouses WHERE is_showroom = true ORDER BY name`;
  console.log(`showroom warehouses: ${rooms.length}`);
  for (const w of rooms) {
    const parked = await sql`SELECT count(*)::int AS n FROM scm.staff WHERE showroom_warehouse_id = ${w.id} AND active = true`;
    console.log(`  company ${w.company_id ?? '?'} | ${w.name} | venue_name ${w.venue_name ?? '—'} | active staff parked ${parked[0].n}`);
  }

  const venues = [...new Set(rooms.map((w) => norm(w.venue_name)).filter(Boolean))];
  const orders = await sql`
    SELECT company_id, venue, venue_source, coalesce(fair_match, 'NULL') AS fm, count(*)::int AS n, sum(local_total_sen)::bigint AS sen
      FROM scm.mfg_sales_orders
     WHERE so_date >= ${FROM} AND status::text NOT IN ('CANCELLED', 'DRAFT')
     GROUP BY 1, 2, 3, 4`;
  console.log(`\norders since ${FROM} at a showroom's venue — company | venue | venue_source | fair_match | n | RM`);
  for (const r of orders.filter((r) => venues.includes(norm(r.venue))).sort((a, b) => a.company_id - b.company_id || String(a.venue).localeCompare(String(b.venue)))) {
    console.log(`  ${r.company_id} | ${r.venue} | ${r.venue_source ?? '-'} | ${r.fm} | ${r.n} | ${Math.round(Number(r.sen) / 100).toLocaleString('en-MY')}`);
  }
  console.log(`\norders since ${FROM} by venue_source — company | venue_source | n`);
  const bySource = {};
  for (const r of orders) { const k = `${r.company_id} | ${r.venue_source ?? '-'}`; bySource[k] = (bySource[k] ?? 0) + r.n; }
  for (const k of Object.keys(bySource).sort()) console.log(`  ${k} | ${bySource[k]}`);

  /* Venue-master rows that read like a showroom, for a person to judge. */
  const master = await sql`SELECT id, name, company_id, active FROM public.project_venues WHERE active = 1 ORDER BY name`;
  const roomish = master.filter((v) => /living|studio|suite|showroom|gallery|2990s|hq|headquarter|outlet/i.test(String(v.name)));
  console.log(`\nvenue master rows that read like a showroom: ${roomish.length}`);
  for (const v of roomish) console.log(`  company ${v.company_id ?? '?'} | ${v.name}`);
} finally {
  await sql.end();
}
