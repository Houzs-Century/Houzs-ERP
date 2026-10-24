#!/usr/bin/env node
// check-sep-first-vs-later.mjs — READ ONLY. Owner 2026-10-24: 「把第一笔和第二笔以
// 上的total amount 分出来」, rules agreed 「1，2，3 同意」:
//   1. the FIRST payment is every payment on the order's first paying DAY
//      (split cards / part cash the same day are one first payment); payments
//      on any later day are "second and later";
//   2. the order's whole history decides — payments before September included,
//      and money moved in from an earlier order counts as already paid before
//      (a converted row keeps the original paid_at);
//   3. AutoCount-imported payments are split the same way; sales-invoice
//      payments are all "second and later".
// September 2026 money in for Houzs (company 1) by paid date. Moved rows are
// history only, never money in. Writes nothing. Env: DATABASE_URL.
import postgres from 'postgres';

const FROM = process.env.FROM || '2026-09-01';
const TO = process.env.TO || '2026-09-30';
const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    console.log(`ROW|window ${FROM} .. ${TO}, company ${CO}`);
    const split = await sql`
      WITH firstday AS (
        SELECT so_doc_no, min(paid_at) AS first_day
        FROM scm.mfg_sales_order_payments
        WHERE company_id = ${CO} AND amount_sen > 0
        GROUP BY so_doc_no
      )
      SELECT CASE WHEN p.method = 'imported' THEN 'imported' ELSE 'keyed' END AS src,
             (p.paid_at = f.first_day) AS is_first,
             count(*)::int AS n, count(DISTINCT p.so_doc_no)::int AS orders, coalesce(sum(p.amount_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_payments p JOIN firstday f ON f.so_doc_no = p.so_doc_no
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND p.converted_from_so_doc_no IS NULL
      GROUP BY 1, 2 ORDER BY 1, 2 DESC`;
    let first = { n: 0, orders: 0, sen: 0n };
    let later = { n: 0, orders: 0, sen: 0n };
    for (const r of split) {
      console.log(`ROW|${r.src} ${r.is_first ? 'FIRST' : 'LATER'}: ${r.n} payments on ${r.orders} orders ${rm(r.sen)}`);
      const t = r.is_first ? first : later;
      t.n += r.n; t.sen += BigInt(r.sen);
    }
    const ord = await sql`
      WITH firstday AS (
        SELECT so_doc_no, min(paid_at) AS first_day FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND amount_sen > 0 GROUP BY so_doc_no
      )
      SELECT (p.paid_at = f.first_day) AS is_first, count(DISTINCT p.so_doc_no)::int AS orders
      FROM scm.mfg_sales_order_payments p JOIN firstday f ON f.so_doc_no = p.so_doc_no
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND p.converted_from_so_doc_no IS NULL
      GROUP BY 1`;
    for (const o of ord) (o.is_first ? first : later).orders = o.orders;
    const si = await sql`SELECT count(*)::int AS n, count(DISTINCT sales_invoice_id)::int AS invs, coalesce(sum(amount_sen), 0)::bigint AS sen
      FROM scm.sales_invoice_payments WHERE company_id = ${CO} AND paid_at >= ${FROM} AND paid_at <= ${TO}`;
    console.log(`ROW|sales invoice payments (all LATER): ${si[0].n} on ${si[0].invs} invoices ${rm(si[0].sen)}`);
    console.log(`ROW|TOTAL FIRST: ${first.n} payments on ${first.orders} orders ${rm(first.sen)}`);
    console.log(`ROW|TOTAL LATER: ${later.n + si[0].n} payments (${later.orders} orders + ${si[0].invs} invoices) ${rm(later.sen + BigInt(si[0].sen))}`);
    console.log(`ROW|GRAND TOTAL: ${first.n + later.n + si[0].n} payments ${rm(first.sen + later.sen + BigInt(si[0].sen))}`);

    /* Which day the LATER money's order first paid — before September or within it. */
    const when = await sql`
      WITH firstday AS (
        SELECT so_doc_no, min(paid_at) AS first_day FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND amount_sen > 0 GROUP BY so_doc_no
      )
      SELECT (f.first_day < ${FROM}::date) AS first_before, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_payments p JOIN firstday f ON f.so_doc_no = p.so_doc_no
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND p.converted_from_so_doc_no IS NULL AND p.paid_at <> f.first_day
      GROUP BY 1 ORDER BY 1`;
    for (const w of when) console.log(`ROW|  LATER whose first payment was ${w.first_before ? 'before September' : 'in September'}: ${w.n} ${rm(w.sen)}`);
    const sameDay = await sql`
      WITH firstday AS (
        SELECT so_doc_no, min(paid_at) AS first_day FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND amount_sen > 0 GROUP BY so_doc_no
      ), firsts AS (
        SELECT p.so_doc_no, count(*) AS k FROM scm.mfg_sales_order_payments p JOIN firstday f ON f.so_doc_no = p.so_doc_no
        WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND p.converted_from_so_doc_no IS NULL AND p.paid_at = f.first_day
        GROUP BY 1
      )
      SELECT count(*) FILTER (WHERE k > 1)::int AS split_orders, coalesce(sum(k) FILTER (WHERE k > 1), 0)::int AS split_rows FROM firsts`;
    console.log(`ROW|  FIRST paid in pieces the same day: ${sameDay[0].split_orders} orders (${sameDay[0].split_rows} payments)`);
    const moved = await sql`
      SELECT count(DISTINCT p.so_doc_no)::int AS orders FROM scm.mfg_sales_order_payments p
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND p.converted_from_so_doc_no IS NULL
        AND EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments m WHERE m.so_doc_no = p.so_doc_no AND m.converted_from_so_doc_no IS NOT NULL)`;
    console.log(`ROW|  September money on orders that also hold money moved in from an earlier order: ${moved[0].orders} orders`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
