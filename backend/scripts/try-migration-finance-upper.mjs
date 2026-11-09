#!/usr/bin/env node
// try-migration-finance-upper.mjs — DRY RUN, ROLLED BACK. Runs migration
// 20261109T1500_acc_finance_text_upper_case (owner 2026-11-09: Finance's typed words in
// UPPER CASE, the old rows once, their old casing kept aside) against PRODUCTION inside
// one transaction, reports what it would change, proves the triggers upper-case a
// write, and ROLLS BACK — nothing stays, whatever the outcome. Env: DATABASE_URL.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Dry run only: it always rolls back.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, onnotice: () => {} });
const out = (s) => console.log(`ROW|${s}`);
const text = readFileSync(new URL('./data/try-20261109T1500.sql', import.meta.url), 'utf8');
const TABLES = ['payment_vouchers', 'payment_voucher_lines', 'ap_invoices', 'ap_invoice_lines', 'acc_payment_requests', 'acc_receipts',
  'acc_receipt_lines', 'acc_credit_notes', 'acc_credit_note_lines', 'acc_debtor_bills', 'acc_debtor_bill_lines', 'acc_debtors', 'suppliers',
  'journal_entries', 'journal_entry_lines'];
const short = (s, n = 70) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    /* The triggers these tables carry before: anything that might refuse or re-stamp the update. */
    const before = await tx`
      SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'scm' AND NOT t.tgisinternal AND c.relname IN ${tx(TABLES)} ORDER BY 1, 2`;
    out(`triggers before: ${before.length}`);
    for (const r of before) out(`  ${r.relname}.${r.tgname}: ${short(r.def, 160)}`);

    const t0 = Date.now();
    await tx.unsafe(text);
    out(`migration ran in ${Date.now() - t0} ms`);

    const counts = await tx`
      SELECT table_name, column_name, count(*)::int AS n, count(DISTINCT company_id)::int AS cos
        FROM scm.acc_text_case_backup GROUP BY 1, 2 ORDER BY 1, 2`;
    out(`backed up and upper-cased: ${counts.reduce((s, r) => s + r.n, 0)} values`);
    for (const r of counts) out(`  ${r.table_name}.${r.column_name}: ${r.n}`);
    const samples = await tx`
      SELECT DISTINCT ON (table_name, column_name) table_name, column_name, old_value FROM scm.acc_text_case_backup ORDER BY table_name, column_name, id`;
    for (const r of samples) out(`  e.g. ${r.table_name}.${r.column_name}: "${short(r.old_value, 50)}" → "${short(String(r.old_value).toUpperCase(), 50)}"`);

    /* Every value now upper case? (a value upper() cannot change, e.g. Chinese, is fine either way) */
    const left = await tx`
      SELECT 'payment_vouchers.notes' AS c, count(*)::int AS n FROM scm.payment_vouchers WHERE notes <> upper(notes)
      UNION ALL SELECT 'suppliers.name', count(*)::int FROM scm.suppliers WHERE name <> upper(name)
      UNION ALL SELECT 'MANUAL narration', count(*)::int FROM scm.journal_entries WHERE source_type = 'MANUAL' AND narration <> upper(narration)
      UNION ALL SELECT 'other narration (left as written)', count(*)::int FROM scm.journal_entries WHERE source_type <> 'MANUAL' AND narration <> upper(narration)`;
    for (const r of left) out(`  still lower after: ${r.c} = ${r.n}`);

    const trig = await tx`
      SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'upper_typed_text' AND NOT t.tgisinternal ORDER BY 1`;
    out(`upper_typed_text triggers: ${trig.length} (${trig.map((r) => r.relname).join(', ')})`);

    /* The trigger on a real write: a voucher's remark and a line's words typed lower case. */
    const [pv] = await tx`SELECT id, notes FROM scm.payment_vouchers ORDER BY created_at DESC LIMIT 1`;
    if (pv) {
      await tx`UPDATE scm.payment_vouchers SET notes = 'typed in lower case · 测试' WHERE id = ${pv.id}`;
      const [back] = await tx`SELECT notes FROM scm.payment_vouchers WHERE id = ${pv.id}`;
      out(`trigger on update: "typed in lower case · 测试" → "${back.notes}"`);
    }
    const [ln] = await tx`SELECT id FROM scm.payment_voucher_lines ORDER BY id LIMIT 1`;
    if (ln) {
      await tx`UPDATE scm.payment_voucher_lines SET description = 'rental nov' WHERE id = ${ln.id}`;
      const [back] = await tx`SELECT description FROM scm.payment_voucher_lines WHERE id = ${ln.id}`;
      out(`line trigger: "rental nov" → "${back.description}"`);
    }
    const [st] = await tx`SELECT id, status FROM scm.payment_vouchers WHERE notes IS NOT NULL ORDER BY created_at LIMIT 1`;
    if (st) {
      await tx`UPDATE scm.payment_vouchers SET status = status WHERE id = ${st.id}`;
      out('an update that writes no typed column passes untouched');
    }
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) out('ROLLED BACK — the migration applies cleanly; nothing was kept.');
  else { out(`MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
} finally { await sql.end(); }

const after = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const still = await after`SELECT to_regclass('scm.acc_text_case_backup') IS NOT NULL AS t, EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'upper_typed_text') AS f`;
out(`after rollback: backup table exists ${still[0].t}, function exists ${still[0].f}`);
await after.end();
