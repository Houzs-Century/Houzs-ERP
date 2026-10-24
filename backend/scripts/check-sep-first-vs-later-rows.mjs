#!/usr/bin/env node
// check-sep-first-vs-later-rows.mjs — READ ONLY. The rows behind
// check-sep-first-vs-later.mjs, one JSON per payment, for the owner's Excel
// (「好，给我 Excel 明细」): every September 2026 payment for Houzs (company 1)
// with whether it is the order's first payment (its first paying DAY) or a
// later one, the order's first paying day, the order, the customer and how it
// was paid. Same rules as the totals (agreed 「1，2，3 同意」); a sales-invoice
// payment of method credit is the customer's credit balance spent, not money
// in, so it is counted apart and left out. Writes nothing.
// Env: DATABASE_URL.
import postgres from 'postgres';

const FROM = process.env.FROM || '2026-09-01';
const TO = process.env.TO || '2026-09-30';
const CO = Number(process.env.COMPANY_ID || 1);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const so = await sql`
      WITH firstday AS (
        SELECT so_doc_no, min(paid_at) AS first_day FROM scm.mfg_sales_order_payments
        WHERE company_id = ${CO} AND amount_sen > 0 GROUP BY so_doc_no
      )
      SELECT p.id, p.so_doc_no, p.paid_at, p.method, p.merchant_provider, p.installment_months, p.amount_sen,
             p.account_sheet, p.approval_code, p.note, f.first_day, (p.paid_at = f.first_day) AS is_first,
             o.so_date, o.debtor_name, o.agent, o.status::text AS status, o.customer_so_no, o.ref,
             s.name AS collector
      FROM scm.mfg_sales_order_payments p
      JOIN firstday f ON f.so_doc_no = p.so_doc_no
      LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
      LEFT JOIN scm.staff s ON s.id = p.collected_by
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND p.converted_from_so_doc_no IS NULL
      ORDER BY p.paid_at, p.so_doc_no, p.created_at`;
    for (const r of so) {
      console.log(`ROW|${JSON.stringify({
        kind: 'SO', first: r.is_first, src: r.method === 'imported' ? 'AutoCount' : 'ERP',
        paidAt: day(r.paid_at), firstDay: day(r.first_day), doc: r.so_doc_no, soDate: day(r.so_date),
        customer: r.debtor_name, agent: r.agent, status: r.status, ref: r.customer_so_no ?? r.ref ?? null,
        method: r.method, provider: r.merchant_provider, months: r.installment_months,
        sheet: r.account_sheet, approval: r.approval_code, collector: r.collector, note: r.note ?? null, sen: Number(r.amount_sen),
      })}`);
    }
    const si = await sql`
      SELECT p.id, p.paid_at, p.method, p.amount_sen, i.invoice_number, i.so_doc_no, o.so_date, o.debtor_name, o.agent, o.status::text AS status, o.customer_so_no, o.ref
      FROM scm.sales_invoice_payments p
      LEFT JOIN scm.sales_invoices i ON i.id = p.sales_invoice_id
      LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = i.so_doc_no
      WHERE p.company_id = ${CO} AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO} AND lower(p.method) <> 'credit'
      ORDER BY p.paid_at, i.invoice_number`;
    /* A credit payment settles an invoice from the customer's credit balance — money
       received before, never money in now (sales-invoices.ts, customer-credits.ts). */
    const credit = await sql`SELECT count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen FROM scm.sales_invoice_payments
      WHERE company_id = ${CO} AND paid_at >= ${FROM} AND paid_at <= ${TO} AND lower(method) = 'credit'`;
    for (const r of si) {
      console.log(`ROW|${JSON.stringify({
        kind: 'SI', first: false, src: 'Sales invoice', paidAt: day(r.paid_at), firstDay: null,
        doc: r.invoice_number, so: r.so_doc_no, soDate: day(r.so_date), customer: r.debtor_name, agent: r.agent, status: r.status,
        ref: r.customer_so_no ?? r.ref ?? null, method: r.method, provider: null, months: null, sheet: null, approval: null, collector: null,
        sen: Number(r.amount_sen),
      })}`);
    }
    console.log(`ROW|${JSON.stringify({ kind: 'COUNT', so: so.length, si: si.length, siCreditN: credit[0].n, siCreditSen: Number(credit[0].sen) })}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
