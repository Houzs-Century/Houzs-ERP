#!/usr/bin/env node
// check-sep-imported-payments.mjs — READ ONLY. The 'imported' customer
// payments dated September 2026 for Houzs (company 1): what orders they sit on,
// when they were imported, and whether the same money is also keyed in the
// ERP (same order + same amount within 3 days) — so September's money in is
// not counted twice or missed. Writes nothing. Env: DATABASE_URL.
import postgres from 'postgres';

const FROM = '2026-09-01';
const TO = '2026-09-30';
const CO = 1;
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const shape = await sql`SELECT regexp_replace(p.so_doc_no, '[0-9]+', '9', 'g') AS pat, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen,
        min(p.created_at) AS first_in, max(p.created_at) AS last_in
      FROM scm.mfg_sales_order_payments p
      WHERE p.company_id = ${CO} AND p.method = 'imported' AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO}
      GROUP BY 1 ORDER BY 3 DESC`;
    for (const r of shape) console.log(`ROW|imported on ${r.pat}: ${r.n} ${rm(r.sen)} (imported ${new Date(r.first_in).toISOString().slice(0, 10)} .. ${new Date(r.last_in).toISOString().slice(0, 10)})`);

    const orders = await sql`SELECT o.status::text AS st, o.so_date < ${FROM}::date AS before_sep, count(DISTINCT p.so_doc_no)::int AS sos, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
      WHERE p.company_id = ${CO} AND p.method = 'imported' AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO}
      GROUP BY 1, 2 ORDER BY 5 DESC`;
    for (const r of orders) console.log(`ROW|imported on orders ${r.st ?? '(no order)'}, SO dated ${r.before_sep ? 'before Sep' : 'Sep or later'}: ${r.sos} orders, ${r.n} payments ${rm(r.sen)}`);

    const both = await sql`SELECT count(DISTINCT i.so_doc_no)::int AS sos, count(*)::int AS n, coalesce(sum(i.amount_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_payments i
      WHERE i.company_id = ${CO} AND i.method = 'imported' AND i.paid_at >= ${FROM} AND i.paid_at <= ${TO}
        AND EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments k WHERE k.so_doc_no = i.so_doc_no AND k.method <> 'imported')`;
    console.log(`ROW|imported rows whose order ALSO has ERP-keyed payments: ${both[0].n} on ${both[0].sos} orders ${rm(both[0].sen)}`);
    const dup = await sql`SELECT count(*)::int AS n, coalesce(sum(i.amount_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_payments i
      WHERE i.company_id = ${CO} AND i.method = 'imported' AND i.paid_at >= ${FROM} AND i.paid_at <= ${TO}
        AND EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments k WHERE k.so_doc_no = i.so_doc_no AND k.method <> 'imported'
                    AND k.amount_sen = i.amount_sen AND abs(k.paid_at - i.paid_at) <= 3)`;
    console.log(`ROW|imported rows with the SAME amount keyed in the ERP within 3 days (likely the same money): ${dup[0].n} ${rm(dup[0].sen)}`);

    const sample = await sql`SELECT p.so_doc_no, p.paid_at, p.amount_sen, p.note, p.account_sheet, o.so_date, o.status::text AS st, o.debtor_name
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
      WHERE p.company_id = ${CO} AND p.method = 'imported' AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO}
      ORDER BY p.amount_sen DESC LIMIT 8`;
    for (const r of sample) console.log(`ROW|  e.g. ${r.so_doc_no} SO ${r.so_date ? new Date(r.so_date).toISOString().slice(0, 10) : '-'} ${r.st} paid ${new Date(r.paid_at).toISOString().slice(0, 10)} ${rm(r.amount_sen)} sheet=${r.account_sheet ?? '-'} note=${String(r.note ?? '-').slice(0, 60)}`);

    /* The ERP-keyed side for contrast: which order shapes the new money sits on. */
    const keyed = await sql`SELECT regexp_replace(p.so_doc_no, '[0-9]+', '9', 'g') AS pat, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_payments p
      WHERE p.company_id = ${CO} AND p.method <> 'imported' AND p.converted_from_so_doc_no IS NULL AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO}
      GROUP BY 1 ORDER BY 3 DESC`;
    for (const r of keyed) console.log(`ROW|keyed in ERP on ${r.pat}: ${r.n} ${rm(r.sen)}`);
    const si = await sql`SELECT p.method, count(*)::int AS n, coalesce(sum(p.amount_sen), 0)::bigint AS sen, string_agg(DISTINCT i.invoice_number, ', ') AS invs
      FROM scm.sales_invoice_payments p LEFT JOIN scm.sales_invoices i ON i.id = p.sales_invoice_id
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} GROUP BY 1`;
    for (const r of si) console.log(`ROW|SI payments ${r.method}: ${r.n} ${rm(r.sen)} on ${String(r.invs ?? '').slice(0, 160)}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
