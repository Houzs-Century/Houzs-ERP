#!/usr/bin/env node
/* Fill the empty `ref` on Delivery Orders and Sales Invoices from their Sales
   Order (owner 2026-09-25: "回填 DO/SI 的空 Ref").

   WHAT WAS FOUND (prod, read-only, 2026-09-25). DOs and SIs keep a copy of the
   SO's reference in `ref`. 233 / 474 DOs and 79 / 205 SIs had it empty while
   their SO had one:
     - 230 of the 233 DOs hold the same number in `customer_so_no` (the Create-DO
       form writes the reference there), so screens already showed it through
       customerRefOf (ref || customer_so_no); only `ref` itself was empty.
     - 47 SIs (created 2026-08-28 .. 09-09) have BOTH columns empty and showed
       "—" as their Ref No.
   Search no longer depends on the copy (it matches the SO link, #4266); this
   makes the stored copy agree with the order.

   WHAT IT WRITES. `ref` = the SO's ref, and ONLY where the row's ref is empty
   and its customer_so_no is empty or equal to the SO's ref. A row whose
   customer_so_no holds a DIFFERENT number is counted as a conflict and left
   alone. Same company only (doc numbers are unique per company). No other
   column changes (updated_at included), and nothing is queued to AutoCount:
   its Ref already comes from ref || customer_so_no (autocount-writeback.ts
   soReference). The only trigger on these tables is the DO delete lock.

   Logs COUNTS only: this repo is public, and so are its Actions logs.

   MODE=plan (default) counts and writes nothing.
   MODE=apply needs CONFIRM="FILL DO SI REF FROM SO", writes each table in one
   statement, then re-reads on a fresh connection that every written row now
   equals its SO's ref and that nothing fillable is left.

   RE-RUN: inert. Keyed on an empty ref, which the fill removes; conflicts are
   never written, so they are re-counted, not re-touched. */
import postgres from 'postgres';
import { DOC_TABLES, countSql, fillSql, idsParam, mismatchSql } from './lib/backfill-doc-ref.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'FILL DO SI REF FROM SO';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function counts(client) {
  const out = {};
  for (const t of DOC_TABLES) out[t] = (await client.unsafe(countSql(t)))[0];
  return out;
}

async function main() {
  const before = await counts(sql);
  note('=== BEFORE ===');
  for (const t of DOC_TABLES) note(`  ${t}: fillable ${before[t].fillable}, conflict (left alone) ${before[t].conflict}`);

  if (!APPLY) {
    note(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  const written = {};
  for (const t of DOC_TABLES) {
    written[t] = (await sql.unsafe(fillSql(t))).map((r) => r.id);
    note(`  ${t}: written ${written[t].length}`);
  }
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failed = false;
  try {
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    const after = await counts(check);
    for (const t of DOC_TABLES) {
      const [{ n }] = await check.unsafe(mismatchSql(t), [idsParam(written[t])]);
      note(`  ${t}: written ${written[t].length}, now differing from their SO ${n}, fillable left ${after[t].fillable}, conflict ${after[t].conflict}`);
      if (n !== 0 || after[t].fillable !== 0) { bad(`  ${t}: fill did not hold`); failed = true; }
    }
  } finally {
    await check.end({ timeout: 5 });
  }
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
