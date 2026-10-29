#!/usr/bin/env node
// check-transport-recharge.mjs — READ ONLY. Where the transport Houzs charges to
// other companies sits (owner 2026-10-29, on his "Transport Income (Houzs)" row:
// 「我charge 会其他公司的」): every Other Debtor bill line FROM..TO with its
// credit account; the income accounts the month booked whose names read like
// transport / delivery / logistics / recovery; and transport lines on sales
// invoices, by debtor.
// Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-08-01), TO (2026-10-31).
import postgres from 'postgres';
import { regionOfDo } from '../src/scm/lib/logistics-cost.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-08-01');
const TO = String(process.env.TO || '2026-10-31');
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const out = (s) => console.log(`ROW|${s}`);
const cut = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

try {
  for (const l of await sql`
    SELECT d.name AS debtor, b.bill_number, b.bill_date::text AS bill_date, b.status, l.description, l.credit_account_code AS acc,
           a.account_name, l.amount_sen
      FROM scm.acc_debtor_bills b JOIN scm.acc_debtors d ON d.id = b.debtor_id
      JOIN scm.acc_debtor_bill_lines l ON l.bill_id = b.id
      LEFT JOIN scm.accounts a ON a.company_id = b.company_id AND a.account_code = l.credit_account_code
     WHERE b.company_id = ${CO} AND b.status <> 'CANCELLED' AND b.bill_date BETWEEN ${FROM}::date AND ${TO}::date
     ORDER BY b.bill_date, b.bill_number, l.line_no`) {
    out(`ODB ${l.bill_date} ${l.bill_number} ${cut(l.debtor, 34)} [${l.acc} ${cut(l.account_name, 30)}] ${cut(l.description, 70)}: ${rm(l.amount_sen)}`);
  }

  for (const r of await sql`
    SELECT to_char(e.entry_date, 'YYYY-MM') AS ym, e.account_code, e.account_name,
           sum(e.credit_sen - e.debit_sen)::bigint AS sen, count(*)::int AS n
      FROM scm.v_gl_entries e
     WHERE e.company_id = ${CO} AND e.entry_date BETWEEN ${FROM}::date AND ${TO}::date AND e.posted = true
       AND e.reversed IS NOT TRUE AND e.reversed_by_je IS NULL AND e.opening IS NOT TRUE
       AND (e.account_code LIKE '5%' OR e.account_code LIKE '599%')
       AND e.account_name ~* '(transport|deliver|logistic|recover|charge|freight|lorry|lori|setup|set up|dismantle)'
     GROUP BY 1, 2, 3 ORDER BY 1, 2`) {
    out(`GL ${r.ym} ${r.account_code} ${cut(r.account_name, 50)}: ${rm(r.sen)} (${r.n} legs)`);
  }

  const siCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'sales_invoice_items'`).map((x) => x.column_name);
  const siHead = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'sales_invoices'`).map((x) => x.column_name);
  out(`sales_invoice_items: ${siCols.join(', ')}`);
  const code = ['item_code', 'product_code'].find((x) => siCols.includes(x));
  const desc = ['description', 'item_description'].find((x) => siCols.includes(x));
  const amt = ['line_total_sen', 'total_sen', 'amount_sen'].find((x) => siCols.includes(x));
  const fk = ['sales_invoice_id', 'invoice_id'].find((x) => siCols.includes(x));
  const dt = ['invoice_date', 'doc_date', 'si_date'].find((x) => siHead.includes(x));
  const who = ['debtor_name', 'customer_name'].find((x) => siHead.includes(x));
  if (code && amt && fk && dt && who) {
    for (const r of await sql.unsafe(
      `SELECT to_char(h.${dt}, 'YYYY-MM') AS ym, h.${who} AS who, count(*)::int AS n, sum(i.${amt})::bigint AS sen
         FROM scm.sales_invoice_items i JOIN scm.sales_invoices h ON h.id = i.${fk}
        WHERE h.company_id = $1 AND h.${dt} BETWEEN $2::date AND $3::date AND coalesce(h.status::text, '') <> 'CANCELLED'
          AND (i.${code} ~* '(transport|deliver)'${desc ? ` OR i.${desc} ~* '(transport|deliver)'` : ''})
          AND h.${who} ~* '(sdn|bhd|enterprise|trading|plt|company|co\\.)'
        GROUP BY 1, 2 ORDER BY 1, 4 DESC LIMIT 30`,
      [CO, FROM, TO],
    )) out(`SI ${r.ym} ${cut(r.who, 50)}: ${r.n} lines ${rm(r.sen)}`);
  } else out(`SI skipped: code ${code} amt ${amt} fk ${fk} dt ${dt} who ${who}`);

  /* The DOs' transport lines in Sep, a company customer apart from a person, by region. */
  const rows = await sql`
    SELECT d.do_number, d.debtor_name, d.state, d.city, d.postcode,
           concat_ws(' | ', d.address1, d.address2, o.address1, o.address2, o.address3, o.address4) AS address, i.line_total_sen
      FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
      LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = d.so_doc_no AND o.company_id = d.company_id
     WHERE d.company_id = ${CO} AND d.status <> 'CANCELLED' AND i.item_code = 'TRANSPORTATION CHARGES'
       AND coalesce(d.customer_delivery_date, d.do_date) BETWEEN '2026-09-01'::date AND '2026-09-30'::date`;
  const agg = new Map();
  for (const r of rows) {
    const company = /(sdn|bhd|enterprise|trading|plt|company|pte|ltd|resources|holdings|services)/i.test(String(r.debtor_name ?? ''));
    const k = `${regionOfDo({ state: r.state, city: r.city, postcode: r.postcode, address: r.address }).code} ${company ? 'COMPANY' : 'person'}`;
    agg.set(k, (agg.get(k) ?? 0) + Number(r.line_total_sen ?? 0));
    if (company) out(`DO-CO ${r.do_number} ${cut(r.debtor_name, 40)}: ${rm(r.line_total_sen)}`);
  }
  for (const [k, v] of [...agg].sort()) out(`DO transport Sep ${k}: ${rm(v)}`);
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
