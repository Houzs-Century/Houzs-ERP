#!/usr/bin/env node
// check-pv-remind-audience.mjs — READ ONLY (plan only; there is no apply).
// Who a "Remind approver" on a Checked payment voucher would reach today: the
// active users whose ROLE holds scm.payment_voucher.approve literally (the
// permissionHolders.ts rule), per company grant; the wildcard roles beside them;
// how many vouchers wait at Checked per company; and the announcements columns
// the bell's system slice reads. Env: DATABASE_URL.
import postgres from 'postgres';

if (String(process.env.MODE ?? 'plan') !== 'plan') { console.error('Refused: this script only reads (MODE=plan).'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const perms = (raw) => { try { const p = JSON.parse(raw ?? '[]'); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } };

try {
  const companies = await sql`SELECT id, code, name, is_active FROM public.companies ORDER BY id`;
  out(`companies: ${companies.map((c) => `${c.id}=${c.code}${Number(c.is_active) === 1 ? '' : '(inactive)'}`).join(' ')}`);
  const roles = await sql`SELECT id, name, permissions FROM public.roles ORDER BY id`;
  const keyed = (key) => roles.filter((r) => perms(r.permissions).includes(key));
  for (const key of ['scm.payment_voucher.approve', 'scm.payment_voucher.check', '*']) {
    const rs = keyed(key);
    out(`--- roles holding ${key}: ${rs.map((r) => `${r.id}:${r.name}`).join(', ') || 'none'}`);
    if (!rs.length) continue;
    const users = await sql`SELECT u.id, u.name, u.role_id FROM public.users u WHERE u.status = 'active' AND u.role_id IN ${sql(rs.map((r) => r.id))} ORDER BY u.id`;
    const grants = users.length ? await sql`SELECT user_id, company_id FROM public.user_companies WHERE user_id IN ${sql(users.map((u) => u.id))}` : [];
    for (const u of users) {
      const g = grants.filter((x) => Number(x.user_id) === Number(u.id)).map((x) => Number(x.company_id));
      out(`  user ${u.id} ${u.name ?? ''} · role ${u.role_id} · companies ${g.length ? g.join(',') : 'no grants (every company)'}`);
    }
  }
  const waiting = await sql`SELECT company_id, count(*)::int AS n, min(checked_at) AS oldest FROM scm.payment_vouchers WHERE status = 'DRAFT' AND checked_at IS NOT NULL AND approved_at IS NULL GROUP BY company_id ORDER BY company_id`;
  out(`--- checked vouchers waiting: ${waiting.map((w) => `co ${w.company_id}: ${w.n} (oldest checked ${String(w.oldest).slice(0, 19)})`).join(' · ') || 'none'}`);
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'announcements' ORDER BY ordinal_position`;
  out(`--- announcements columns: ${cols.map((c) => c.column_name).join(', ')}`);
  const sources = await sql`SELECT split_part(source, ':', 1) AS tag, count(*)::int AS n, bool_or(position(':' in source) > 0) AS with_ref FROM public.announcements WHERE source IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`;
  out(`--- system notice sources: ${sources.map((s) => `${s.tag}${s.with_ref ? '(:ref)' : ''}=${s.n}`).join(', ')}`);
} catch (e) {
  out(`FAILED: ${e?.stack ?? e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
