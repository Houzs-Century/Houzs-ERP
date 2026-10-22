#!/usr/bin/env node
/* disable-test-driver-login.mjs — disable the one test login left active.

   WHY. public.users carries ten seeded test accounts (houzs.test.*@gmail.com:
   sales exec/mgr/dir, logistic, storekeeper, helper, driver, admin, finance,
   operation). Nine are already status='disabled'; only "Test Driver" (id 114,
   houzs.test.driver@gmail.com) is still 'active' and can log in. It was the
   login behind the scm.drivers row DRV-015 deleted in #4788. Owner asked
   2026-10-20 to clean it up. We DISABLE it to match its nine siblings — not a
   delete: a disabled user keeps its created_by/audit stamps, which a delete
   would orphan, and disabling is what the app's own user-disable path does.

   WHAT. Sets status='disabled' (+ a status_reason) on exactly that one row,
   re-identified by email AND name before the write, only when it is not
   already disabled. No other user is touched.

   MODE=plan (default) reads and reports, writes nothing.
   MODE=apply needs CONFIRM="DISABLE TEST DRIVER LOGIN", flips the one row, and
   verifies on a FRESH connection that it now reads 'disabled' and that no other
   houzs.test.* account changed state.

   RE-RUN: inert. The update is gated on id=114 AND status <> 'disabled', so a
   second run finds it already disabled and writes nothing. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'DISABLE TEST DRIVER LOGIN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const TARGET = { id: 114, email: 'houzs.test.driver@gmail.com', match: 'test driver' };
const REASON = 'test account, disabled 2026-10-20 (owner cleanup, #4788 follow-up)';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}`);

  note(`\n=== houzs.test.* accounts (context) ===`);
  const siblings = await sql`
    SELECT id::text AS id, email, name, status FROM public.users
     WHERE email LIKE 'houzs.test.%@gmail.com' ORDER BY id`;
  for (const s of siblings) note(`  ${s.id.padStart(4)} ${String(s.email).padEnd(36)} ${String(s.status).padEnd(10)} ${s.name}`);

  const [row] = await sql`
    SELECT id::text AS id, email, name, status FROM public.users WHERE id = ${TARGET.id}`;
  if (!row) { note(`\nTarget id ${TARGET.id} not found — nothing to do.`); await sql.end({ timeout: 5 }); return; }

  const idOk = row.email === TARGET.email && String(row.name).toLowerCase().includes(TARGET.match);
  note(`\n=== TARGET ===`);
  note(`  id=${row.id} email="${row.email}" name="${row.name}" status="${row.status}"`);
  if (!idOk) { bad(`REFUSE — id ${TARGET.id} is not the Test Driver login (email/name mismatch); writing nothing`); process.exit(1); }
  if (row.status === 'disabled') { note(`\nAlready disabled — nothing to do.`); await sql.end({ timeout: 5 }); return; }

  if (!APPLY) {
    note(`\nPLAN ONLY: would set status='disabled'. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== DISABLING ===`);
  const back = await sql`
    UPDATE public.users SET status = 'disabled', status_reason = ${REASON}
     WHERE id = ${TARGET.id} AND email = ${TARGET.email} AND status <> 'disabled'
    RETURNING id::text AS id`;
  note(`  rows updated: ${back.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const [after] = await check`
      SELECT id::text AS id, email, name, status FROM public.users WHERE id = ${TARGET.id}`;
    note(`  now: ${JSON.stringify(after)}`);
    if (!after || after.status !== 'disabled') throw new Error(`Test Driver login is still "${after?.status}", not disabled`);
    const active = await check`
      SELECT id::text AS id, email, status FROM public.users
       WHERE email LIKE 'houzs.test.%@gmail.com' AND status <> 'disabled'`;
    for (const a of active) bad(`  still active: ${JSON.stringify(a)}`);
    note(`  houzs.test.* accounts still active: ${active.length} (expect 0)`);
    if (active.length) throw new Error(`${active.length} test account(s) still active`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
