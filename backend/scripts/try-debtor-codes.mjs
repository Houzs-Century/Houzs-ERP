#!/usr/bin/env node
// try-debtor-codes.mjs — a ROLLED-BACK production trial of migration
// 20261105T1900_acc_debtor_codes.sql (Finance redesign batch 5 step 11, the
// other debtors' account codes). It never writes: everything runs inside ONE
// transaction that is always rolled back, then a fresh read proves the column
// is still absent.
//
// What it shows: the code the fill gives every debtor (per company), any debtor
// left without one, the AutoCount code the Houzs opening import recorded for a
// debtor (in its notes or its opening bill / receipt), that a second run fills
// nothing (idempotent), and the fill's edge cases on synthetic rows in a TEMP
// table (digit names, names with no letter, ties, codes already taken, a number
// past 999).
//
// MODE=plan only (an apply is refused). RE-RUN: any time; nothing persists.
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from './lib/split-sql.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1' || (process.env.MODE && process.env.MODE !== 'plan')) {
  console.error('This trial is plan-only: it always rolls back.'); process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = '20261105T1900_acc_debtor_codes.sql';
const migration = readFileSync(path.join(here, '../src/db/migrations-pg', FILE), 'utf8');
const stmts = splitSqlStatements(migration);
const fill = stmts.find((s) => /^\s*WITH\s+todo\b/i.test(s));
if (!fill) { console.error('The fill statement was not found in the migration.'); process.exit(1); }

const pg = postgres(url, { ssl: pgSslMode(url), prepare: false, max: 1 });
const say = (m) => console.log(m);
const bad = [];
class Rollback extends Error {}

try {
  await pg.begin(async (tx) => {
    await tx.unsafe('RESET search_path');
    const roles = await tx`SELECT company_id, account_code FROM scm.acc_account_roles WHERE role = 'AR_OTHER' ORDER BY company_id`;
    say(`AR_OTHER control per company: ${roles.map((r) => `${r.company_id}=${r.account_code}`).join(', ') || '(no role rows: 305-0000)'}`);
    const counts = await tx`SELECT company_id, count(*)::int AS n FROM scm.acc_debtors GROUP BY company_id ORDER BY company_id`;
    say(`Debtors per company: ${counts.map((r) => `${r.company_id}=${r.n}`).join(', ')}`);

    const counted = [];
    for (const s of stmts) {
      const r = await tx.unsafe(s);
      if (s === fill) counted.push(r.count);
    }
    say(`\nMigration applied in the trial transaction: ${stmts.length} statements; the fill set ${counted[0]} code(s).`);

    const rows = await tx`
      SELECT d.company_id, d.code, d.name, d.is_active, to_char(d.created_at, 'YYYY-MM-DD HH24:MI') AS created,
             COALESCE(
               substring(d.notes FROM 'AutoCount ([0-9]{3}-[A-Z0-9][0-9]{3})'),
               (SELECT substring(b.notes FROM 'AutoCount ([0-9]{3}-[A-Z0-9][0-9]{3})') FROM scm.acc_debtor_bills b
                 WHERE b.debtor_id = d.id AND b.notes ~ 'AutoCount [0-9]{3}-[A-Z0-9][0-9]{3}' ORDER BY b.bill_number LIMIT 1),
               (SELECT substring(r.notes FROM 'AutoCount ([0-9]{3}-[A-Z0-9][0-9]{3})') FROM scm.acc_debtor_receipts r
                 WHERE r.debtor_id = d.id AND r.notes ~ 'AutoCount [0-9]{3}-[A-Z0-9][0-9]{3}' ORDER BY r.receipt_number LIMIT 1)
             ) AS autocount
        FROM scm.acc_debtors d
       ORDER BY d.company_id, d.code NULLS LAST, d.name`;
    let co = null;
    for (const r of rows) {
      if (r.company_id !== co) { co = r.company_id; say(`\nCompany ${co}  (code · name · active · created · AutoCount code recorded)`); }
      const ac = r.autocount ? (r.autocount === r.code ? `AutoCount ${r.autocount} (same)` : `AutoCount ${r.autocount} (DIFFERS)`) : '';
      say(`  ${r.code ?? '(none)'} · ${r.name} · ${r.is_active ? 'active' : 'inactive'} · ${r.created}${ac ? ' · ' + ac : ''}`);
    }
    const none = rows.filter((r) => !r.code);
    say(`\nLeft without a code (no letter or digit in the name): ${none.length}`);
    const differs = rows.filter((r) => r.autocount && r.autocount !== r.code);
    say(`Recorded AutoCount code differs from the fill: ${differs.length} of ${rows.filter((r) => r.autocount).length}`);

    const dups = await tx`SELECT company_id, code, count(*)::int AS n FROM scm.acc_debtors WHERE code IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1`;
    if (dups.length) bad.push(`duplicate codes: ${dups.map((d) => `${d.company_id}/${d.code}×${d.n}`).join(', ')}`);

    // Idempotent: the whole file again changes nothing.
    await tx.unsafe('RESET search_path');
    const snapshot = JSON.stringify(rows.map((r) => [r.company_id, r.name, r.code]));
    for (const s of stmts) {
      const r = await tx.unsafe(s);
      if (s === fill && r.count !== 0) bad.push(`a second run filled ${r.count} code(s); want 0`);
    }
    const again = await tx`SELECT d.company_id, d.name, d.code FROM scm.acc_debtors d ORDER BY d.company_id, d.code NULLS LAST, d.name`;
    if (JSON.stringify(again.map((r) => [r.company_id, r.name, r.code])) !== snapshot) bad.push('a second run changed a code');
    else say('Second run of the whole file: 0 codes filled, nothing changed.');

    // Edge cases on synthetic rows, in a TEMP table that dies with the transaction.
    await tx.unsafe('CREATE TEMP TABLE dc_trial (LIKE scm.acc_debtors INCLUDING ALL) ON COMMIT DROP');
    await tx.unsafe(`INSERT INTO dc_trial (company_id, name, code, created_at) VALUES
      (990001, 'Apex Trading', '305-A007', '2026-01-01T00:00:00Z'),
      (990001, 'Alpha Sdn Bhd', NULL, '2026-01-02T00:00:00Z'),
      (990001, '  apple trading', NULL, '2026-01-03T00:00:00Z'),
      (990001, '2990 Home Sdn Bhd', NULL, '2026-01-04T00:00:00Z'),
      (990001, '(M) Holdings', NULL, '2026-01-05T00:00:00Z'),
      (990001, '陈先生', NULL, '2026-01-06T00:00:00Z'),
      (990001, 'HOUZS VENTURY HOLDINGS', NULL, '2026-01-07T00:00:00Z'),
      (990001, 'HOOKKA MANUFACTURING', NULL, '2026-01-07T00:00:00Z'),
      (990001, 'Zenith', '305-Z999', '2026-01-08T00:00:00Z'),
      (990001, 'Zeta Works', NULL, '2026-01-09T00:00:00Z'),
      (990002, 'Alpha Sdn Bhd', NULL, '2026-01-02T00:00:00Z')`);
    const trialFill = fill.replace(/scm\.acc_debtors\b/g, 'pg_temp.dc_trial');
    await tx.unsafe(trialFill);
    const got = await tx`SELECT company_id, name, code FROM pg_temp.dc_trial ORDER BY company_id, created_at, name`;
    const want = {
      '990001|Apex Trading': '305-A007', '990001|Alpha Sdn Bhd': '305-A008', '990001|  apple trading': '305-A009',
      '990001|2990 Home Sdn Bhd': '305-2001', '990001|(M) Holdings': '305-M001', '990001|陈先生': null,
      '990001|HOOKKA MANUFACTURING': '305-H001', '990001|HOUZS VENTURY HOLDINGS': '305-H002',
      '990001|Zenith': '305-Z999', '990001|Zeta Works': '305-Z1000', '990002|Alpha Sdn Bhd': '305-A001',
    };
    say('\nEdge cases (TEMP table, synthetic rows):');
    for (const r of got) {
      const k = `${r.company_id}|${r.name}`;
      const ok = (want[k] ?? null) === (r.code ?? null);
      say(`  ${ok ? 'ok ' : 'BAD'} ${r.company_id} · ${JSON.stringify(r.name)} → ${r.code ?? '(none)'}${ok ? '' : `  want ${want[k] ?? '(none)'}`}`);
      if (!ok) bad.push(`edge case ${k}: got ${r.code}, want ${want[k]}`);
    }
    const trialAgain = await tx.unsafe(trialFill);
    if (trialAgain.count !== 0) bad.push(`edge-case second fill set ${trialAgain.count}; want 0`);

    throw new Rollback('trial');
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(`FAILED: ${e.message}`); await pg.end(); process.exit(1); }
}

const still = await pg`SELECT 1 FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_debtors' AND column_name = 'code'`;
say(`\nRolled back: scm.acc_debtors.code ${still.length ? 'EXISTS (it should not!)' : 'is absent again'} on a fresh read.`);
if (still.length) bad.push('the column exists after the rollback');
await pg.end();
if (bad.length) { for (const b of bad) console.error(`::error::${b}`); process.exit(1); }
say('TRIAL PASSED (rolled back).');
