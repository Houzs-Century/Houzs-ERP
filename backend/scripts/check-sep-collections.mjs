#!/usr/bin/env node
// check-sep-collections.mjs — READ ONLY. Owner 2026-10-24: 「可以帮我检查9月收了多少
// 钱吗？houzs 那边 罢了」. Money that came IN for Houzs (company 1) in September
// 2026, by the Receipts page's three kinds:
//   CUSTOMER  scm.mfg_sales_order_payments by paid_at — new money only: a
//             converted row (converted_from_so_doc_no) is money MOVED from a
//             cancelled order and keeps the original paid_at, and 'imported'
//             rows are AutoCount reference data; both shown apart, not added
//   SI        scm.sales_invoice_payments by paid_at
//   GENERAL   scm.acc_receipts by receipt_date, not CANCELLED
//   DEBTOR    scm.acc_debtor_receipts by receipt_date, by status
// plus the books' cross-check (SOPAY journals dated in September). Writes
// nothing. Env: DATABASE_URL; FROM / TO / COMPANY_ID override the window.
import postgres from 'postgres';

const FROM = process.env.FROM || '2026-09-01';
const TO = process.env.TO || '2026-09-30';
const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function section(name, fn) {
  try { await fn(); } catch (e) { console.log(`ROW|${name}: FAILED ${e.message}`); }
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    console.log(`ROW|window ${FROM} .. ${TO}, company ${CO}`);
    await section('customer', async () => {
      const kinds = await sql`SELECT
          CASE WHEN converted_from_so_doc_no IS NOT NULL THEN 'moved from another order'
               WHEN method = 'imported' THEN 'imported (AutoCount)'
               ELSE 'new money' END AS k,
          count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen,
          count(*) FILTER (WHERE amount_sen < 0)::int AS neg, coalesce(sum(amount_sen) FILTER (WHERE amount_sen < 0), 0)::bigint AS neg_sen
        FROM scm.mfg_sales_order_payments
        WHERE company_id = ${CO} AND paid_at >= ${FROM} AND paid_at <= ${TO}
        GROUP BY 1 ORDER BY 1`;
      for (const r of kinds) console.log(`ROW|customer ${r.k}: ${r.n} payments ${rm(r.sen)}${r.neg ? ` (incl. ${r.neg} negative ${rm(r.neg_sen)})` : ''}`);
      const NEW = sql`company_id = ${CO} AND paid_at >= ${FROM} AND paid_at <= ${TO} AND converted_from_so_doc_no IS NULL AND method <> 'imported'`;
      const byMethod = await sql`SELECT method, coalesce(merchant_provider, '') AS provider, count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen
        FROM scm.mfg_sales_order_payments WHERE ${NEW} GROUP BY 1, 2 ORDER BY 4 DESC`;
      for (const r of byMethod) console.log(`ROW|  method ${r.method}${r.provider ? ` / ${r.provider}` : ''}: ${r.n} ${rm(r.sen)}`);
      const byDep = await sql`SELECT is_deposit, count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen
        FROM scm.mfg_sales_order_payments WHERE ${NEW} GROUP BY 1 ORDER BY 1`;
      for (const r of byDep) console.log(`ROW|  ${r.is_deposit ? 'deposit' : 'balance / other'}: ${r.n} ${rm(r.sen)}`);
      const byStatus = await sql`SELECT coalesce(o.status::text, '(no order)') AS st, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen
        FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
        WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND p.converted_from_so_doc_no IS NULL AND p.method <> 'imported'
        GROUP BY 1 ORDER BY 3 DESC`;
      for (const r of byStatus) console.log(`ROW|  order now ${r.st}: ${r.n} ${rm(r.sen)}`);
      const byWeek = await sql`SELECT to_char(date_trunc('week', paid_at), 'YYYY-MM-DD') AS wk, count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen
        FROM scm.mfg_sales_order_payments WHERE ${NEW} GROUP BY 1 ORDER BY 1`;
      for (const r of byWeek) console.log(`ROW|  week of ${r.wk}: ${r.n} ${rm(r.sen)}`);
      const sos = await sql`SELECT count(DISTINCT so_doc_no)::int AS n FROM scm.mfg_sales_order_payments WHERE ${NEW}`;
      console.log(`ROW|  orders paying: ${sos[0].n}`);
    });
    await section('si', async () => {
      const r = await sql`SELECT count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen FROM scm.sales_invoice_payments
        WHERE company_id = ${CO} AND paid_at >= ${FROM} AND paid_at <= ${TO}`;
      console.log(`ROW|sales invoice payments: ${r[0].n} ${rm(r[0].sen)}`);
    });
    await section('general', async () => {
      const r = await sql`SELECT status, count(*)::int AS n, coalesce(sum(total_sen), 0)::bigint AS sen FROM scm.acc_receipts
        WHERE company_id = ${CO} AND receipt_date >= ${FROM} AND receipt_date <= ${TO} GROUP BY 1 ORDER BY 1`;
      for (const x of r) console.log(`ROW|general receipts ${x.status}: ${x.n} ${rm(x.sen)}`);
      if (!r.length) console.log('ROW|general receipts: none');
    });
    await section('debtor', async () => {
      const r = await sql`SELECT status, count(*)::int AS n, coalesce(sum(total_sen), 0)::bigint AS sen FROM scm.acc_debtor_receipts
        WHERE company_id = ${CO} AND receipt_date >= ${FROM} AND receipt_date <= ${TO} GROUP BY 1 ORDER BY 1`;
      for (const x of r) console.log(`ROW|debtor receipts ${x.status}: ${x.n} ${rm(x.sen)}`);
      if (!r.length) console.log('ROW|debtor receipts: none');
    });
    await section('books', async () => {
      const r = await sql`SELECT source_type, reversed, count(*)::int AS n, coalesce(sum(total_debit_sen), 0)::bigint AS sen FROM scm.journal_entries
        WHERE company_id = ${CO} AND entry_date >= ${FROM} AND entry_date <= ${TO} AND source_type IN ('SOPAY', 'SOCONV', 'SIPAY', 'RCT', 'DRCT')
        GROUP BY 1, 2 ORDER BY 1, 2`;
      for (const x of r) console.log(`ROW|books ${x.source_type}${x.reversed ? ' (reversed)' : ''}: ${x.n} ${rm(x.sen)}`);
    });
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
