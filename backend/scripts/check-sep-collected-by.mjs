#!/usr/bin/env node
// check-sep-collected-by.mjs — READ ONLY. Owner 2026-10-24: 「按谁收到的钱，
// collected by」. Houzs (company 1) money in for September 2026 by paid date,
// per Collected By on the payment row: ERP-keyed SO payments (not 'imported',
// not a moved/converted row), split cash / transfer / card; the AutoCount-
// imported rows and the sales-invoice payments each by their own collector
// when the row has one. Writes nothing. Env: DATABASE_URL; FROM / TO /
// COMPANY_ID override the window.
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
    const per = await sql`SELECT coalesce(s.name, CASE WHEN p.collected_by IS NULL THEN '(not filled in)' ELSE 'unknown id ' || p.collected_by::text END) AS who,
        count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen,
        coalesce(sum(p.amount_sen) FILTER (WHERE p.method = 'cash'), 0)::bigint AS cash,
        coalesce(sum(p.amount_sen) FILTER (WHERE p.method = 'transfer'), 0)::bigint AS transfer,
        coalesce(sum(p.amount_sen) FILTER (WHERE p.method IN ('merchant', 'installment')), 0)::bigint AS card,
        coalesce(sum(p.amount_sen) FILTER (WHERE p.method NOT IN ('cash', 'transfer', 'merchant', 'installment')), 0)::bigint AS other
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.staff s ON s.id = p.collected_by
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO}
        AND p.converted_from_so_doc_no IS NULL AND p.method <> 'imported'
      GROUP BY 1 ORDER BY 3 DESC`;
    let tot = 0n;
    for (const r of per) {
      tot += BigInt(r.sen);
      console.log(`ROW|keyed|${r.who}|${r.n}|${rm(r.sen)}|cash ${rm(r.cash)}|transfer ${rm(r.transfer)}|card ${rm(r.card)}${Number(r.other) ? `|other ${rm(r.other)}` : ''}`);
    }
    console.log(`ROW|keyed total ${rm(tot)}`);

    /* The unfilled ones: who keyed them, and on whose orders — to say who to ask. */
    const unfilled = await sql`SELECT coalesce(o.agent, '(no salesperson)') AS agent, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO}
        AND p.converted_from_so_doc_no IS NULL AND p.method <> 'imported' AND p.collected_by IS NULL
      GROUP BY 1 ORDER BY 3 DESC LIMIT 15`;
    for (const r of unfilled) console.log(`ROW|unfilled on orders of ${r.agent}: ${r.n} ${rm(r.sen)}`);

    const imp = await sql`SELECT coalesce(s.name, CASE WHEN p.collected_by IS NULL THEN '(not filled in)' ELSE 'unknown id' END) AS who, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.staff s ON s.id = p.collected_by
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND p.method = 'imported'
      GROUP BY 1 ORDER BY 3 DESC`;
    for (const r of imp) console.log(`ROW|imported|${r.who}|${r.n}|${rm(r.sen)}`);

    const siCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'sales_invoice_payments' AND column_name = 'collected_by'`;
    if (siCols.length) {
      const si = await sql`SELECT coalesce(s.name, CASE WHEN p.collected_by IS NULL THEN '(not filled in)' ELSE 'unknown id' END) AS who, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen
        FROM scm.sales_invoice_payments p LEFT JOIN scm.staff s ON s.id = p.collected_by
        WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} GROUP BY 1 ORDER BY 3 DESC`;
      for (const r of si) console.log(`ROW|si|${r.who}|${r.n}|${rm(r.sen)}`);
    } else {
      const si = await sql`SELECT count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen FROM scm.sales_invoice_payments WHERE company_id = ${CO} AND paid_at >= ${FROM} AND paid_at <= ${TO}`;
      console.log(`ROW|si|(no collected_by column)|${si[0].n}|${rm(si[0].sen)}`);
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
