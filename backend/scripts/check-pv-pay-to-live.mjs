#!/usr/bin/env node
// check-pv-pay-to-live.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// After PR #5393 deploys: did migration 20261108T2100_scm_pv_pay_to_bank.sql apply, do the
// three bank columns exist on scm.payment_vouchers, and how many vouchers already carry one.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);

await sql.begin('READ ONLY', async (tx) => {
  const mig = await tx`SELECT filename, applied_at::text AS at FROM _pg_migrations WHERE filename = '20261108T2100_scm_pv_pay_to_bank.sql'`;
  out(`migration: ${mig.length ? `applied ${mig[0].at}` : 'NOT applied'}`);
  const last = await tx`SELECT filename FROM _pg_migrations ORDER BY filename DESC LIMIT 2`;
  out(`newest applied: ${last.map((r) => r.filename).join(', ')}`);
  const cols = await tx`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'payment_vouchers' AND column_name LIKE 'pay_to_%'
     ORDER BY column_name`;
  out(`columns: ${cols.map((c) => `${c.column_name} ${c.data_type} ${c.is_nullable === 'YES' ? 'null ok' : 'NOT NULL'}`).join(' | ') || 'none'}`);
  if (cols.length === 3) {
    const filled = await tx`
      SELECT company_id, count(*)::int AS n FROM scm.payment_vouchers
       WHERE coalesce(pay_to_bank_name, '') <> '' OR coalesce(pay_to_account_no, '') <> '' OR coalesce(pay_to_account_name, '') <> ''
       GROUP BY company_id ORDER BY company_id`;
    out(`vouchers with their own bank: ${filled.map((r) => `company ${r.company_id} ${r.n}`).join(', ') || 'none yet'}`);
  }
});
await sql.end();
