#!/usr/bin/env node
// try-migration-dn.mjs — DRY RUN, ROLLED BACK. Runs migration 20261029T1000
// (doc_kind on scm.ap_invoices and scm.acc_debtor_bills: a debit note is a bill
// of its own kind) against PRODUCTION inside one transaction, reads back the
// columns and CHECKs, sees every existing row read 'INV', moves one row of each
// table to 'DN' and refuses 'XX', then ROLLS BACK — nothing stays. Env: DATABASE_URL.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const out = (s) => console.log(`ROW|${s}`);
async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const text = readFileSync(new URL('./data/try-20261029T1000.sql', import.meta.url), 'utf8');
  class Rollback extends Error {}
  try {
    const [b] = await sql`SELECT (SELECT count(*)::int FROM scm.ap_invoices) AS api, (SELECT count(*)::int FROM scm.acc_debtor_bills) AS odb`;
    out(`before: ${b.api} AP invoices, ${b.odb} debtor bills`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      const cols = await tx`SELECT table_name AS t, data_type AS d, is_nullable AS n, column_default AS def FROM information_schema.columns
        WHERE table_schema = 'scm' AND column_name = 'doc_kind' AND table_name IN ('ap_invoices', 'acc_debtor_bills') ORDER BY 1`;
      for (const r of cols) out(`column ${r.t}.doc_kind ${r.d} nullable=${r.n} default=${r.def}`);
      const checks = await tx`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('ap_invoices_doc_kind_check', 'acc_debtor_bills_doc_kind_check') ORDER BY 1`;
      for (const r of checks) out(`check ${r.t} ${r.conname} ${r.def}`);
      const kinds = await tx`SELECT 'ap_invoices' AS t, doc_kind, count(*)::int AS n FROM scm.ap_invoices GROUP BY 2
        UNION ALL SELECT 'acc_debtor_bills', doc_kind, count(*)::int FROM scm.acc_debtor_bills GROUP BY 2 ORDER BY 1, 2`;
      for (const r of kinds) out(`rows ${r.t} ${r.doc_kind}: ${r.n}`);
      for (const t of ['ap_invoices', 'acc_debtor_bills']) {
        const [one] = await tx.unsafe(`SELECT id FROM scm.${t} ORDER BY created_at DESC LIMIT 1`);
        if (!one) { out(`${t}: no row to move`); continue; }
        const [moved] = await tx.unsafe(`UPDATE scm.${t} SET doc_kind = 'DN' WHERE id = $1 RETURNING doc_kind`, [one.id]);
        out(`${t}: a row moved to ${moved.doc_kind}`);
        try { await tx.savepoint((sp) => sp.unsafe(`UPDATE scm.${t} SET doc_kind = 'XX' WHERE id = $1`, [one.id])); out(`${t}: 'XX' ACCEPTED (wrong)`); }
        catch (e) { out(`${t}: 'XX' refused (${e.message})`); }
      }
      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) out('ROLLED BACK — the migration applies cleanly; nothing was kept.');
    else { out(`MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
  } finally { await sql.end(); }
  const after = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const [s] = await after`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'scm' AND column_name = 'doc_kind' AND table_name IN ('ap_invoices', 'acc_debtor_bills')`;
  out(`after rollback: doc_kind columns ${s.n}`);
  await after.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
