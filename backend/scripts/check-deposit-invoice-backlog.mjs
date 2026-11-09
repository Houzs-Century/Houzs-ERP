#!/usr/bin/env node
// check-deposit-invoice-backlog.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 (Invoices: "69 payments dated from 2026/06/01 still without a deposit
// invoice", "21 delivered orders still without a final invoice" — 这个不是自动issue?): the
// switch per company as it stands; deposit invoices issued today and when; 2990's payments
// dated from the start day with no standing deposit invoice, by the month they were
// RECORDED, so the backlog can be told apart from the hook skipping new payments.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);

await sql.begin('READ ONLY', async (tx) => {
  for (const s of await tx`SELECT to_jsonb(s) AS j FROM scm.acc_company_settings s ORDER BY company_id`) {
    const j = s.j;
    out(`settings co${j.company_id}: enabled=${j.deposit_invoice_enabled} from=${j.deposit_invoice_from} updated_at=${j.updated_at ?? '∅'} updated_by=${j.updated_by ?? '∅'}`);
  }
  out('── deposit invoices made per day of creation, 2990 (last 15 days with any)');
  for (const r of await tx`
    SELECT created_at::date::text AS day, count(*)::int AS n, count(*) FILTER (WHERE status = 'ISSUED')::int AS issued
      FROM scm.acc_deposit_invoices WHERE company_id = 2 GROUP BY 1 ORDER BY 1 DESC LIMIT 15`) out(`${r.day}: ${r.n} made (${r.issued} standing)`);
  out('── 2990 payments dated from the start day without a standing deposit invoice, by month RECORDED');
  const [st] = await tx`SELECT deposit_invoice_from AS f FROM scm.acc_company_settings WHERE company_id = 2`;
  for (const r of await tx`
    SELECT to_char(p.created_at, 'YYYY-MM') AS recorded, to_char(p.paid_at, 'YYYY-MM') AS paid, count(*)::int AS n, sum(p.amount_sen)::bigint AS sen
      FROM scm.mfg_sales_order_payments p
     WHERE p.company_id = 2 AND p.paid_at >= ${st?.f ?? '2026-06-01'}
       AND NOT EXISTS (SELECT 1 FROM scm.acc_deposit_invoices d WHERE d.company_id = 2 AND d.payment_id = p.id::text AND d.status = 'ISSUED')
     GROUP BY 1, 2 ORDER BY 1, 2`) out(`recorded ${r.recorded} · paid ${r.paid}: ${r.n} payments, RM ${(Number(r.sen) / 100).toFixed(2)}`);
});
await sql.end();
