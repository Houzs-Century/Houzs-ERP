#!/usr/bin/env node
// check-fair-reassign-access.mjs — READ-ONLY. Can the people the owner named for
// re-assigning an order's fair (Finance + PMS, 2026-10-16) actually reach the
// "Fair Links to Settle" page and its re-assign button?
//
// The re-assign right (scm/lib/fair-reassign.ts) = scm.finance.accounting OR
// pmsAccess.canCreateEvent (role name has the word BD, position Owner, or the
// weisiang login). The page itself sits behind the SCM sales-orders area: the
// sidebar entry needs scm.access or scm.sales.orders page access and hides for
// sales reps; the write needs scm.sales.orders at edit when the caller is
// L2-configured. Page access comes from the position policy (cohort full /
// restricted / sales) or, with no position, from the role's permission keys.
//
// Per active login that canCreateEvent would admit: role, position, departments,
// the stored position_policy row, and whether the role carries * / scm.access /
// scm.finance.accounting. Names only — no e-mail is printed.
//
// Writes nothing. Env: DATABASE_URL.
//   npx tsx scripts/check-fair-reassign-access.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  const rows = await sql`
    SELECT u.id, u.name, u.status, r.name AS role_name, p.name AS position_name,
           pd.name AS position_department, d.name AS department_name,
           pp.cohort AS policy_cohort, pp.profile AS policy_profile,
           (r.permissions::text LIKE '%"*"%') AS role_star,
           (r.permissions::text LIKE '%scm.access%') AS role_scm_access,
           (r.permissions::text LIKE '%scm.finance.accounting%') AS role_finance,
           (r.name ~* '\\mbd\\M') AS by_role,
           (lower(coalesce(p.name, '')) = 'owner') AS by_position,
           (lower(coalesce(u.email, '')) = 'weisiang329@gmail.com') AS by_login
      FROM public.users u
      JOIN public.roles r ON r.id = u.role_id
      LEFT JOIN public.positions p ON p.id = u.position_id
      LEFT JOIN public.departments pd ON pd.id = p.department_id
      LEFT JOIN public.departments d ON d.id = u.department_id
      LEFT JOIN public.position_policy pp ON pp.position_id = u.position_id
     WHERE r.name ~* '\\mbd\\M' OR lower(coalesce(p.name, '')) = 'owner' OR lower(coalesce(u.email, '')) = 'weisiang329@gmail.com'
     ORDER BY u.status, u.name`;
  console.log(`Logins canCreateEvent admits: ${rows.length}`);
  for (const r of rows) {
    const why = [r.by_role && 'role BD', r.by_position && 'position Owner', r.by_login && 'weisiang login'].filter(Boolean).join(' + ');
    console.log(`- user ${r.id} "${r.name}" status=${r.status} (${why})`);
    console.log(`    role "${r.role_name}" [*: ${r.role_star}, scm.access: ${r.role_scm_access}, scm.finance.accounting: ${r.role_finance}]`);
    console.log(`    position "${r.position_name ?? '—'}" (dept ${r.position_department ?? '—'}), user dept ${r.department_name ?? '—'}, policy ${r.policy_cohort ?? '—'}/${r.policy_profile ?? '—'}`);
  }
  const roles = await sql`
    SELECT r.name, count(u.id)::int AS users FROM public.roles r LEFT JOIN public.users u ON u.role_id = r.id AND u.status = 'active'
     WHERE r.name ~* 'bd|business' GROUP BY r.name ORDER BY r.name`;
  console.log('\nRoles whose name mentions bd / business (active users):');
  for (const r of roles) console.log(`- "${r.name}": ${r.users}`);
} finally {
  await sql.end();
}
