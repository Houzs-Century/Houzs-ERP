#!/usr/bin/env node
/* Staging ledger rows for migrations that only ever existed on preview branches.

   THE SHAPE. Branches HC-0125 (HR) and HC-0157 (mail) were merged into the
   `staging` branch and deployed to the staging database, so pg-migrate there
   tracked five files that are not on main. Every push to main then ran the
   staging migration check, saw five applied files with no file in the tree,
   and failed closed with "Migration drift detected ... file deleted".

   WHAT THIS DOES. Deletes exactly those five rows from _pg_migrations on
   STAGING. The tables and columns the files created stay; each file uses
   IF NOT EXISTS, so when its PR merges and the file reappears the migration
   runs again over them.

   WHAT IT REFUSES. A DATABASE_URL that is not the staging project. A row whose
   stored checksum is not the one recorded when the drift was reported (someone
   re-applied a changed file). A row whose file is back in the migration tree
   (the PR merged; then it is no longer drift and must not be touched).

   MODE=plan (default) prints each row and writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN", deletes in one transaction, and checks
   on a fresh connection that none of the five rows remain and that every
   other row is untouched (count dropped by exactly the number deleted).

   RE-RUN: inert. Keyed on the five filenames; once deleted, none match.
   Delete this script once the HC-0125 and HC-0157 PRs have merged. */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const STAGING_REF = 'minnapsemfzjmtvnnvdd';
const PROD_REF = 'anogrigyjbduyzclzjgn';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

/* Checksums as printed by the failing staging run of 2026-10-28. */
const ROWS = [
  ['20261022T0600_hr_working_hours.sql', 'sha256:08f97791d79c221561fa0c0df030fb3aef6a89e6411ea14daf07cf6415cd0b44'],
  ['20261022T0900_hr_payroll.sql', 'sha256:d8d7ec6fa77c9af9fa016a699aba24ca3c90134d63355b10642c35283d588dfc'],
  ['20261022T1500_hr_trip_pay.sql', 'sha256:72251d6eab1917b237309fc887b05c4c6d172e049fb94d502dee64226c873e59'],
  ['20261027T1100_mail_department_link.sql', 'sha256:2ebe01c116f36a71c07aaef9dcbd5a5412c18070a3d24943cc4832b3f06fc165'],
  ['20261027T1110_mail_requested_department.sql', 'sha256:dc9f9ec13787699fdf6d5e7619ede690a1f83312687d5921595606e2082dc170'],
];

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
if (!DSN.includes(STAGING_REF) || DSN.includes(PROD_REF)) {
  console.error(`REFUSE: DATABASE_URL is not the staging project (${STAGING_REF})`);
  process.exit(2);
}
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const MIGRATIONS = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src/db/migrations-pg');
const filenames = ROWS.map(([f]) => f);
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const before = await sql`SELECT filename, checksum FROM _pg_migrations`;
const byName = new Map(before.map((r) => [r.filename, r.checksum]));

const toDelete = [];
let refused = false;
for (const [filename, expected] of ROWS) {
  if (!byName.has(filename)) { console.log(`SKIP    ${filename}: no ledger row (already cleared)`); continue; }
  if (existsSync(join(MIGRATIONS, filename))) {
    console.log(`REFUSE  ${filename}: the file is back in the migration tree, so it is not drift`);
    refused = true; continue;
  }
  if (byName.get(filename) !== expected) {
    console.log(`REFUSE  ${filename}: stored checksum ${byName.get(filename)} is not the reported ${expected}`);
    refused = true; continue;
  }
  console.log(`DELETE  ${filename}  ${expected}`);
  toDelete.push(filename);
}
console.log(`ledger rows now: ${before.length}; to delete: ${toDelete.length}`);

if (refused) { await sql.end(); process.exit(1); }
if (!APPLY || !toDelete.length) {
  console.log(APPLY ? 'nothing to delete' : 'MODE=plan: nothing written');
  await sql.end(); process.exit(0);
}

await sql.begin(async (tx) => {
  const gone = await tx`DELETE FROM _pg_migrations WHERE filename = ANY(${toDelete}) RETURNING filename`;
  if (gone.length !== toDelete.length) throw new Error(`deleted ${gone.length}, expected ${toDelete.length}`);
});
await sql.end();

/* Fresh connection: the five rows are gone and nothing else moved. */
const fresh = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const after = await fresh`SELECT filename, checksum FROM _pg_migrations`;
await fresh.end();
const left = after.filter((r) => filenames.includes(r.filename));
const changed = after.filter((r) => byName.get(r.filename) !== r.checksum);
if (left.length || changed.length || after.length !== before.length - toDelete.length) {
  console.error(`VERIFY FAILED: ${left.length} target row(s) remain, ${changed.length} other row(s) changed; ledger ${before.length} -> ${after.length}`);
  process.exit(1);
}
console.log(`VERIFIED: ledger ${before.length} -> ${after.length}, none of the five rows remain`);
