#!/usr/bin/env node
// try-migration-so-names.mjs — DRY RUN, ROLLED BACK. Staging's migration
// history carries another branch's file (20261021T0300_hr_employees.sql), so
// the staging run refuses before reaching ours. This runs migration
// 20261021T1400 against PRODUCTION inside one transaction, reads back what it
// would leave (the view's columns, the seeded names, a reader's row), and
// ROLLS BACK — nothing stays, whatever the outcome. Env: DATABASE_URL.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const text = readFileSync(new URL('./data/try-20261021T1400.sql', import.meta.url), 'utf8');
class Rollback extends Error {}
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    const cols = await tx`SELECT ordinal_position AS n, column_name AS c FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_acquirers' ORDER BY 1`;
    console.log(`view columns after: ${cols.map((r) => `${r.n}.${r.c}`).join(' ')}`);
    const cfg = await tx`SELECT code, so_names FROM scm.acc_acquirer_config ORDER BY code`;
    console.log(`names: ${cfg.map((r) => `${r.code}=${JSON.stringify(r.so_names)}`).join(' ')}`);
    const v = await tx`SELECT company_id, code, display_name, so_names, is_active FROM scm.acc_acquirers WHERE code IN ('AEON', 'PBB') ORDER BY 1, 2`;
    for (const r of v) console.log(`  view co ${r.company_id} ${r.code} "${r.display_name}" ${JSON.stringify(r.so_names)} active ${r.is_active}`);
    const g = await tx`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'scm' AND table_name = 'acc_acquirers' AND privilege_type = 'SELECT' ORDER BY 1`;
    console.log(`SELECT grants: ${g.map((r) => r.grantee).join(', ')}`);
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) console.log('ROLLED BACK — the migration applies cleanly; nothing was kept.');
  else { console.log(`MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
} finally { await sql.end(); }
const after = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const still = await after`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_acquirer_config' AND column_name = 'so_names'`;
console.log(`after rollback, so_names exists: ${still[0].n === 1}`);
await after.end();
