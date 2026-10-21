#!/usr/bin/env node
// rematch-open-lines.mjs — decide every merchant's OPEN Merchant Recon lines
// again, with the shipped code (acc/settlement-rematch.ts), once, after
// migration 20261021T1400 gave AEON {Pinelabs} and PBB {Public}. Owner
// 2026-10-21: 「全部做，Pinelabs=AEON，Public=PBB」 — 已经上传的报告也重新对一次.
//
// PLAN (default): every merchant is matched again INSIDE a transaction that is
// then rolled back — the output is exactly what apply would do, and nothing
// stays. APPLY: MODE=apply and CONFIRM=REMATCH — the same, committed.
// Nothing posts in either mode: matching is a proposal; Confirm all posts.
// Confirmed and set-aside lines are never touched (the module's own rule).
//
// Env: DATABASE_URL; COMPANY_IDS (default 1,2); ACQUIRERS (default: every
// merchant with open lines).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { rematchOpenLines } from '../src/acc/settlement-rematch.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const wantsApply = process.env.APPLY === '1' || process.env.MODE === 'apply';
if (wantsApply && process.env.CONFIRM !== 'REMATCH') { console.error('apply needs CONFIRM=REMATCH'); process.exit(2); }
const APPLY = wantsApply;
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const companies = (process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter(Number.isInteger);
const only = (process.env.ACQUIRERS || '').split(',').map((s) => s.trim()).filter(Boolean);
class Rollback extends Error {}

const tally = (tx, co, acq) => tx`
  SELECT r.bucket, count(*)::int AS n
    FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
   WHERE r.company_id = ${co} AND b.acquirer_code = ${acq} AND r.confirmed_at IS NULL AND r.bucket <> 'IGNORED'
   GROUP BY 1 ORDER BY 1`;
const show = (rows) => rows.map((r) => `${r.bucket} ${r.n}`).join(', ') || 'none';

try {
  console.log(`${APPLY ? 'APPLY' : 'PLAN (rolled back)'} — companies ${companies.join(', ')}${only.length ? `, merchants ${only.join(', ')}` : ''}`);
  const open = await sql`
    SELECT r.company_id, b.acquirer_code, count(*)::int AS n
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
     WHERE r.confirmed_at IS NULL AND r.bucket <> 'IGNORED' AND r.company_id IN ${sql(companies)}
     GROUP BY 1, 2 ORDER BY 1, 2`;
  for (const o of open) {
    if (only.length && !only.includes(o.acquirer_code)) continue;
    try {
      await sql.begin(async (tx) => {
        const before = await tally(tx, o.company_id, o.acquirer_code);
        const r = await rematchOpenLines(pgrestShim(tx, 'scm'), o.company_id, o.acquirer_code);
        const after = await tally(tx, o.company_id, o.acquirer_code);
        console.log(`co ${o.company_id} ${o.acquirer_code}: ${JSON.stringify(r)}`);
        console.log(`   before: ${show(before)}  →  after: ${show(after)}`);
        if (!APPLY) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) { console.log(`co ${o.company_id} ${o.acquirer_code}: FAILED ${e.message}`); process.exitCode = 1; }
    }
  }
  const left = await sql`
    SELECT r.company_id, b.acquirer_code, count(*)::int AS n
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
     WHERE r.confirmed_at IS NULL AND r.bucket = 'MATCHED' AND r.company_id IN ${sql(companies)}
     GROUP BY 1, 2 ORDER BY 1, 2`;
  console.log(`Matched and waiting for Confirm all now: ${left.map((l) => `co ${l.company_id} ${l.acquirer_code} ${l.n}`).join(', ') || 'none'}`);
} finally {
  await sql.end();
}
