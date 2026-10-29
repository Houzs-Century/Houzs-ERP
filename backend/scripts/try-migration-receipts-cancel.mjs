#!/usr/bin/env node
// try-migration-receipts-cancel.mjs — DRY RUN, ROLLED BACK. Runs migration
// 20261029T1500 (scm.acc_official_receipts: CANCELLED, the cancel columns, the
// one-per-payment key narrowed to live receipts) against PRODUCTION inside one
// transaction, reads back columns / constraints / indexes, then tries the rule on a
// real formal receipt: a second LIVE receipt for its payment is refused, CANCELLED
// without a time is refused, CANCELLED with one is taken, a new live receipt for the
// same payment is then taken, 'XX' is refused — then ROLLS BACK. Env: DATABASE_URL, OR.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const out = (s) => console.log(`ROW|${s}`);
const OR = String(process.env.OR || '').trim();
async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const text = readFileSync(new URL('./data/try-20261029T1500.sql', import.meta.url), 'utf8');
  class Rollback extends Error {}
  const constraints = (q) => q`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'scm.acc_official_receipts'::regclass ORDER BY conname`;
  const indexes = (q) => q`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'scm' AND tablename = 'acc_official_receipts' ORDER BY 1`;
  try {
    const counts = await sql`SELECT status, count(*)::int AS n FROM scm.acc_official_receipts GROUP BY 1 ORDER BY 1`;
    out(`before: ${counts.map((r) => `${r.status} ${r.n}`).join(', ')}`);
    for (const r of await constraints(sql)) out(`before constraint ${r.conname}: ${r.def}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      const cols = await tx`SELECT column_name AS c, data_type AS d, is_nullable AS n FROM information_schema.columns
        WHERE table_schema = 'scm' AND table_name = 'acc_official_receipts'
          AND column_name IN ('cancelled_at', 'cancelled_by', 'cancel_reason', 'replaced_by_id') ORDER BY 1`;
      for (const r of cols) out(`column ${r.c} ${r.d} nullable=${r.n}`);
      for (const r of await constraints(tx)) out(`after constraint ${r.conname}: ${r.def}`);
      for (const r of await indexes(tx)) out(`after index ${r.indexname}: ${r.indexdef}`);
      const [r] = OR
        ? await tx`SELECT * FROM scm.acc_official_receipts WHERE or_number = ${OR}`
        : await tx`SELECT * FROM scm.acc_official_receipts WHERE status = 'FORMAL' ORDER BY id DESC LIMIT 1`;
      if (!r) { out('no formal receipt to try the rule on'); throw new Rollback(); }
      out(`trying on ${r.or_number} (${r.status}, ${r.payment_source} ${r.payment_id})`);
      const second = (no) => tx.savepoint((sp) => sp`INSERT INTO scm.acc_official_receipts
        (company_id, or_number, status, payment_source, payment_id, doc_no, amount_sen, paid_at)
        VALUES (${r.company_id}, ${no}, 'DRAFT', ${r.payment_source}, ${r.payment_id}, ${r.doc_no}, ${r.amount_sen}, ${r.paid_at})`);
      try { await second('TRY-LIVE-1'); out('a second LIVE receipt for the payment: ACCEPTED (wrong)'); }
      catch (e) { out(`a second LIVE receipt for the payment: refused (${e.message})`); }
      try {
        await tx.savepoint((sp) => sp`UPDATE scm.acc_official_receipts SET status = 'CANCELLED' WHERE id = ${r.id}`);
        out('CANCELLED without a time: ACCEPTED (wrong)');
      } catch (e) { out(`CANCELLED without a time: refused (${e.message})`); }
      await tx`UPDATE scm.acc_official_receipts
        SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'trial', cancel_reason = 'trial' WHERE id = ${r.id}`;
      out(`${r.or_number} CANCELLED with a time: taken`);
      try { await second('TRY-LIVE-2'); out('a new LIVE receipt beside the cancelled one: taken'); }
      catch (e) { out(`a new LIVE receipt beside the cancelled one: REFUSED (wrong) (${e.message})`); }
      const [nw] = await tx`SELECT id FROM scm.acc_official_receipts WHERE or_number = 'TRY-LIVE-2'`;
      if (nw) {
        await tx`UPDATE scm.acc_official_receipts SET replaced_by_id = ${nw.id} WHERE id = ${r.id}`;
        out('replaced_by_id linked');
      }
      try {
        await tx.savepoint((sp) => sp`UPDATE scm.acc_official_receipts SET status = 'XX' WHERE id = ${r.id}`);
        out('status XX: ACCEPTED (wrong)');
      } catch (e) { out(`status XX: refused (${e.message})`); }
      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) out('ROLLED BACK — the migration applies cleanly; nothing was kept.');
    else { out(`MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
  } finally { await sql.end(); }
  const after = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const [s] = await after`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'acc_official_receipts' AND column_name = 'cancelled_at'`;
  const [t] = await after`SELECT count(*)::int AS n FROM scm.acc_official_receipts WHERE or_number LIKE 'TRY-%'`;
  out(`after rollback: cancelled_at columns ${s.n}, trial rows ${t.n}`);
  await after.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
