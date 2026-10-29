#!/usr/bin/env node
// check-logistics-vs-excel-2.mjs — READ ONLY. Follow-up to check-logistics-vs-excel.mjs
// on the rows that did not agree with the owner's workbook for the month:
//   - Singapore: the workbook has 10 SGD DOs, the system 1 — the month's DOs whose
//     address reads Singapore anywhere, and the ones with no state;
//   - the DOs carrying a TRANSPORTATION CHARGES line, with their address;
//   - upkeep (U accounts) and insurance & road tax (I002): every bill / voucher line
//     dated in the month, whatever its status;
//   - the group bills to 2990 in the month after (their "LOGISTICS CHARGES - <month>").
// Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-09-01), TO (2026-09-30), NEXT_TO (2026-10-31).
import postgres from 'postgres';
import { regionOfDo } from '../src/scm/lib/logistics-cost.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const TO = String(process.env.TO || '2026-09-30');
const NEXT_TO = String(process.env.NEXT_TO || '2026-10-31');
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const out = (s) => console.log(`ROW|${s}`);
const cut = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

try {
  const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'delivery_orders' ORDER BY ordinal_position`).map((x) => x.column_name);
  out(`delivery_orders columns: ${cols.join(', ')}`);
  const addrCols = cols.filter((x) => /addr|address|street|line|city|state|postcode|country|ship|deliver_to|customer_name/i.test(x) && !/date|_at$|_id$|status/i.test(x));
  const sel = ['id', 'do_number', 'so_doc_no', 'coalesce(customer_delivery_date, do_date)::text AS day', ...addrCols].join(', ');
  const dos = await sql.unsafe(
    `SELECT ${sel} FROM scm.delivery_orders WHERE company_id = $1 AND status <> 'CANCELLED' AND coalesce(customer_delivery_date, do_date) BETWEEN $2::date AND $3::date ORDER BY id`,
    [CO, FROM, TO],
  );
  const text = (d) => addrCols.map((k) => d[k]).filter(Boolean).join(' | ');
  const show = (tag, d) => out(`${tag} ${d.do_number} ${d.day} SO ${d.so_doc_no ?? '-'} region ${regionOfDo({ state: d.state, city: d.city, postcode: d.postcode }).code}: ${cut(text(d), 150)}`);
  for (const d of dos) if (/singapore|\bS\(\d{6}\)|\bSG\b/i.test(text(d))) show('SG?', d);
  for (const d of dos) if (!String(d.state ?? '').trim()) show('NO STATE', d);

  const tr = await sql`
    SELECT d.do_number, i.item_code, i.line_total_sen
      FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
     WHERE d.company_id = ${CO} AND d.status <> 'CANCELLED' AND i.item_code = 'TRANSPORTATION CHARGES'
       AND coalesce(d.customer_delivery_date, d.do_date) BETWEEN ${FROM}::date AND ${TO}::date`;
  const byNo = new Map(dos.map((d) => [String(d.do_number), d]));
  for (const t of tr) {
    const d = byNo.get(String(t.do_number));
    out(`TRANSPORT ${t.do_number} ${rm(t.line_total_sen)} region ${d ? regionOfDo({ state: d.state, city: d.city, postcode: d.postcode }).code : '?'}: ${d ? cut(text(d), 120) : ''}`);
  }

  for (const r of await sql`
    SELECT 'AP' AS src, inv.invoice_number AS doc, inv.invoice_date::text AS day, inv.status, l.debit_account_code AS acc, l.description, l.amount_sen AS sen
      FROM scm.ap_invoice_lines l JOIN scm.ap_invoices inv ON inv.id = l.invoice_id
     WHERE inv.company_id = ${CO} AND inv.invoice_date BETWEEN ${FROM}::date AND ${TO}::date AND l.debit_account_code ~ '-(U0[0-9]{2}|I002)$'
    UNION ALL
    SELECT 'PV', pv.pv_number, pv.pv_date::text, pv.status, l.debit_account_code, l.description, l.amount_sen
      FROM scm.payment_voucher_lines l JOIN scm.payment_vouchers pv ON pv.id = l.pv_id
     WHERE pv.company_id = ${CO} AND pv.pv_date BETWEEN ${FROM}::date AND ${TO}::date AND l.debit_account_code ~ '-(U0[0-9]{2}|I002)$'
     ORDER BY 5, 3`) {
    out(`${r.src} ${r.acc} ${r.doc} ${r.day} ${r.status}: ${cut(r.description, 60)} ${rm(r.sen)}`);
  }

  for (const l of await sql`
    SELECT d.name AS debtor, b.bill_number, b.bill_date::text AS bill_date, l.description, l.credit_account_code, l.amount_sen
      FROM scm.acc_debtor_bills b JOIN scm.acc_debtors d ON d.id = b.debtor_id
      JOIN scm.acc_debtor_bill_lines l ON l.bill_id = b.id
     WHERE b.company_id = ${CO} AND b.status <> 'CANCELLED' AND b.bill_date > ${TO}::date AND b.bill_date <= ${NEXT_TO}::date
       AND d.name ~* '(2990|conts|hookka)'
     ORDER BY d.name, b.bill_number, l.line_no`) {
    out(`ODB ${l.debtor} ${l.bill_number} ${l.bill_date} [${l.credit_account_code}] ${cut(l.description, 70)}: ${rm(l.amount_sen)}`);
  }
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
