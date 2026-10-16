#!/usr/bin/env node
// check-rep-departments.mjs — READ-ONLY. Why a salesperson is missing from the
// Sales Team roster (public.sales_reps) that PMS "Sales Attending" picks from.
//
// WHY. check-rep-pms-link.mjs (2026-10-16) found Lim and Syasya with no
// sales_reps row and Nancy's row linked to another login. The roster is kept in
// step with users.department by services/salesTeam.ts syncSalesRepFromUser: a
// login whose department name contains "sales" gets a row, linked by user_id.
// Prints each login's department, status and any roster row.
//
// Writes nothing. Env: DATABASE_URL, USER_IDS (default 4,88,82,47,149,154,163).
//   npx tsx scripts/check-rep-departments.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const IDS = String(process.env.USER_IDS || '4,88,82,47,149,154,163').split(',').map(Number).filter(Number.isInteger);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT u.id, u.name, u.status, d.name AS dept,
           (SELECT string_agg('#' || r.id || ' ' || r.name || coalesce(' archived', ''), '; ') FROM public.sales_reps r WHERE r.user_id = u.id) AS roster
      FROM public.users u LEFT JOIN public.departments d ON d.id = u.department_id
     WHERE u.id IN ${sql(IDS)} ORDER BY u.id`;
  for (const r of rows) console.log(`user ${r.id} "${r.name}" status=${r.status ?? '—'} department=${r.dept ?? '—'} roster=${r.roster ?? 'NONE'}`);
} finally {
  await sql.end();
}
