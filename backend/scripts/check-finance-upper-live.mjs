#!/usr/bin/env node
// check-finance-upper-live.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// After migration 20261109T1500_acc_finance_text_upper_case is applied on production
// (owner 2026-11-09: Finance's typed words in UPPER CASE, old rows once, old casing kept):
// was it applied, what the backup holds per table/column, do the 13 triggers stand, and is
// anything typed still lower case.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const COLS = {
  payment_vouchers: ['payee_name', 'notes', 'pay_to_bank_name', 'pay_to_account_name', 'official_doc_note'],
  payment_voucher_lines: ['description'],
  ap_invoices: ['notes', 'official_doc_note'],
  ap_invoice_lines: ['description'],
  acc_payment_requests: ['payee_name', 'purpose', 'bank_name', 'bank_account_name', 'note', 'finance_note', 'no_event_reason'],
  acc_receipts: ['payer_name', 'notes'],
  acc_receipt_lines: ['description'],
  acc_credit_notes: ['party_name', 'reason', 'notes'],
  acc_credit_note_lines: ['description'],
  acc_debtor_bills: ['notes'],
  acc_debtor_bill_lines: ['description'],
  acc_debtors: ['name'],
  suppliers: ['name', 'bank_name', 'bank_account_name'],
};

await sql.begin('READ ONLY', async (tx) => {
  const [m] = await tx`SELECT filename FROM _pg_migrations WHERE filename LIKE '%_acc_finance_text_upper_case.sql'`;
  out(`migration applied: ${m ? m.filename : 'NO'}`);
  const last = await tx`SELECT filename FROM _pg_migrations ORDER BY filename DESC LIMIT 3`;
  out(`newest applied: ${last.map((r) => r.filename).join(', ')}`);
  if (!m) return;
  const counts = await tx`SELECT table_name, column_name, count(*)::int AS n FROM scm.acc_text_case_backup GROUP BY 1, 2 ORDER BY 1, 2`;
  out(`backup holds ${counts.reduce((s, r) => s + r.n, 0)} old values`);
  for (const r of counts) out(`  ${r.table_name}.${r.column_name}: ${r.n}`);
  const trig = await tx`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'upper_typed_text' AND NOT t.tgisinternal ORDER BY 1`;
  out(`upper_typed_text triggers: ${trig.length} (${trig.map((r) => r.relname).join(', ')})`);
  let lower = 0;
  for (const [table, cols] of Object.entries(COLS)) {
    for (const col of cols) {
      const [{ n }] = await tx.unsafe(`SELECT count(*)::int AS n FROM scm.${table} WHERE ${col} <> upper(${col})`);
      if (n > 0) out(`  STILL LOWER ${table}.${col}: ${n}`);
      lower += n;
    }
  }
  out(`typed values still not upper case: ${lower}`);
  const [pv] = await tx`SELECT pv_number, payee_name, notes FROM scm.payment_vouchers WHERE notes IS NOT NULL ORDER BY updated_at DESC NULLS LAST LIMIT 1`;
  if (pv) out(`sample voucher ${pv.pv_number}: payee "${pv.payee_name}", remark "${String(pv.notes).slice(0, 60)}"`);
  const [{ n: manual }] = await tx`SELECT count(*)::int AS n FROM scm.journal_entries WHERE source_type = 'MANUAL' AND narration <> upper(narration)`;
  out(`manual journals still lower: ${manual}`);
});
await sql.end();
