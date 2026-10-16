#!/usr/bin/env node
// check-rep-pms-link.mjs — READ-ONLY. Why a salesperson is "on no fair at all"
// in PMS: never put on Sales Attending, or put on it under a sales-rep record
// that is not linked to the login they key orders with.
//
// WHY. check-fair-golive-readiness.mjs (2026-10-16) found reps with recent
// orders whose login stands on no PMS fair (Jason 19 orders, Lim, Shu Hui,
// Syasya, Nancy, Mayson); under the owner's new rule they would be stopped.
// Per name: their scm.staff row and its login (user_id), every
// public.sales_reps row of that name or login, and how many fairs each sales-rep
// record is on.
//
// Writes nothing. Env: DATABASE_URL, NAMES (comma list).
//   npx tsx scripts/check-rep-pms-link.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const NAMES = String(process.env.NAMES || 'Jason,Lim,Shu Hui,Syasya,Nancy,Mayson').split(',').map((s) => s.trim()).filter(Boolean);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  for (const name of NAMES) {
    const staff = await sql`SELECT id::text AS id, name, user_id, active FROM scm.staff WHERE lower(trim(name)) = lower(${name})`;
    const uids = staff.map((s) => s.user_id).filter((v) => v != null);
    const reps = await sql`
      SELECT sr.id, sr.name, sr.user_id, sr.status,
             (SELECT count(*) FROM public.project_sales_attendees a WHERE a.sales_rep_id = sr.id)::int AS fairs,
             (SELECT max(p.start_date) FROM public.project_sales_attendees a JOIN public.projects p ON p.id = a.project_id WHERE a.sales_rep_id = sr.id) AS last_fair
        FROM public.sales_reps sr
       WHERE lower(sr.name) LIKE ${'%' + name.toLowerCase() + '%'}${uids.length ? sql` OR sr.user_id IN ${sql(uids)}` : sql``}`;
    const users = uids.length ? await sql`SELECT id, name, email IS NOT NULL AS has_email FROM public.users WHERE id IN ${sql(uids)}` : [];
    console.log(`\n${name}:`);
    for (const s of staff) console.log(`  staff ${s.name} active=${s.active} login user_id=${s.user_id ?? '—'}`);
    for (const u of users) console.log(`  login user ${u.id} "${u.name}"`);
    if (!reps.length) console.log('  sales_reps: NONE matching the name or the login');
    for (const r of reps) console.log(`  sales_rep #${r.id} "${r.name}" user_id=${r.user_id ?? '—'} status=${r.status} on ${r.fairs} fair(s), latest start ${r.last_fair ?? '—'}${uids.includes(r.user_id) ? '  ← linked to this login' : ''}`);
  }
} finally {
  await sql.end();
}
