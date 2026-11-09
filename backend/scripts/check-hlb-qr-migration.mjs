#!/usr/bin/env node
// check-hlb-qr-migration.mjs — DRY RUN, ALWAYS ROLLED BACK. Runs migration
// 20261109T1700_acc_settlement_qr_lines.sql inside one transaction on the
// database, prints what it changed, then throws so nothing is kept.
// Env: DATABASE_URL. MODE=apply is refused: this script never commits.
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('check-hlb-qr-migration.mjs only dry-runs: mode=plan.'); process.exit(1); }

const FILE = new URL('../src/db/migrations-pg/20261109T1700_acc_settlement_qr_lines.sql', import.meta.url);
const migration = readFileSync(FILE, 'utf8');
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ROLLBACK = 'dry run — rolled back on purpose';

const snapshot = async (tx, label) => {
  console.log(`\n=== ${label}`);
  const cols = await tx`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_settlement_rows' AND column_name = 'channel'`;
  console.log(`ROW|channel column: ${cols.length ? 'present' : 'absent'}`);
  const [cfg] = await tx`SELECT column_map FROM scm.acc_acquirer_config WHERE code = 'HLB'`;
  console.log(`ROW|HLB column_map: ${JSON.stringify(cfg?.column_map ?? null)}`);
  const rows = cols.length
    ? await tx`SELECT r.id, r.company_id, r.batch_id, r.line_no, r.txn_date, r.ref, r.gross_sen, r.bucket, r.confirmed_at, r.channel FROM scm.acc_settlement_rows r WHERE r.acquirer_code = 'HLB' AND (upper(btrim(r.ref)) = '0000PP' OR r.channel = 'QR') ORDER BY r.id`
    : await tx`SELECT r.id, r.company_id, r.batch_id, r.line_no, r.txn_date, r.ref, r.gross_sen, r.bucket, r.confirmed_at, NULL AS channel FROM scm.acc_settlement_rows r WHERE r.acquirer_code = 'HLB' AND upper(btrim(r.ref)) = '0000PP' ORDER BY r.id`;
  for (const r of rows) {
    console.log(`ROW|line ${r.id}|co ${r.company_id}|batch ${r.batch_id}|l.${r.line_no}|${r.txn_date}|ref ${r.ref ?? 'NULL'}|RM ${rm(r.gross_sen)}|${r.bucket}|${r.confirmed_at ? 'confirmed' : 'open'}|channel ${r.channel ?? 'NULL'}`);
  }
  const batchIds = [...new Set(rows.map((r) => Number(r.batch_id)))];
  if (batchIds.length) {
    for (const b of await tx`SELECT id, file_name, gross_sen, fee_sen, net_sen, stated_net_sen FROM scm.acc_settlement_batches WHERE id IN ${tx(batchIds)} ORDER BY id`) {
      console.log(`ROW|batch ${b.id}|${b.file_name}|gross ${rm(b.gross_sen)}|fee ${rm(b.fee_sen)}|net ${rm(b.net_sen)}|stated ${b.stated_net_sen == null ? 'NULL' : rm(b.stated_net_sen)}`);
    }
  }
};

try {
  await sql.begin(async (tx) => {
    await snapshot(tx, 'BEFORE');
    await tx.unsafe(migration);
    await snapshot(tx, 'AFTER (inside the transaction)');
    await tx.unsafe(migration);
    await snapshot(tx, 'AFTER A SECOND RUN (idempotent?)');
    throw new Error(ROLLBACK);
  });
} catch (e) {
  if (String(e?.message) !== ROLLBACK) { console.error('MIGRATION FAILED:', e?.message ?? e); process.exitCode = 1; }
  else console.log(`\n${ROLLBACK}: nothing was kept.`);
} finally {
  await sql.end();
}
