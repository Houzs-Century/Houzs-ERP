#!/usr/bin/env node
// check-3pl-ap-match.mjs — READ-ONLY. Owner 2026-10-23: the transport AP lines
// name the order ("SO012467", "HC12975", "ZNT6656"). Do those numbers resolve to
// sales orders and delivery orders in the system — which company, which DO,
// which 3PL on the DO? Writes nothing.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
const rm = (sen) => (Number(sen ?? 0) / 100).toFixed(2);
try {
  const lines = await sql`
    SELECT i.company_id, i.invoice_number, s.name AS supplier, l.line_no, l.description, l.debit_account_code, l.amount_sen
      FROM scm.ap_invoice_lines l JOIN scm.ap_invoices i ON i.id = l.invoice_id JOIN scm.suppliers s ON s.id = i.supplier_id
     WHERE i.status <> 'CANCELLED' AND l.description ~* '(\\mSO\\s?-?\\d{5,6}|\\m(HC|ZNT|ZN)\\s?\\d{4,6})'
     ORDER BY i.invoice_date, i.invoice_number, l.line_no`;
  console.log(`ROW|AP lines naming an order: ${lines.length}`);
  const tokens = new Set();
  for (const l of lines) for (const m of String(l.description).toUpperCase().matchAll(/\b(SO\s?-?\d{5,6}|(?:HC|ZNT|ZN)\s?\d{4,6})/g)) tokens.add(m[1].replace(/[\s-]/g, ''));
  console.log(`ROW|distinct numbers: ${[...tokens].join(', ')}`);
  for (const t of tokens) {
    let sos;
    if (t.startsWith('SO')) {
      const n = t.slice(2);
      sos = await sql`SELECT company_id, doc_no, so_date, status, customer_so_no, ref, local_total_sen FROM scm.mfg_sales_orders WHERE doc_no ~* ${'SO-?0*' + Number(n) + '$'} OR doc_no ILIKE ${'%' + n}`;
    } else {
      sos = await sql`SELECT company_id, doc_no, so_date, status, customer_so_no, ref, local_total_sen FROM scm.mfg_sales_orders
        WHERE upper(regexp_replace(coalesce(customer_so_no,'') || ' ' || coalesce(ref,''), '[\\s-]', '', 'g')) LIKE ${'%' + t + '%'}`;
    }
    if (sos.length === 0) { console.log(`ROW|${t}: no SO`); continue; }
    for (const so of sos) {
      const dos = await sql`SELECT company_id, do_number, do_date, status, threepl_company_id FROM scm.delivery_orders WHERE so_doc_no = ${so.doc_no} ORDER BY do_date`.catch(async () =>
        sql`SELECT company_id, do_number, do_date, status, NULL AS threepl_company_id FROM scm.delivery_orders WHERE so_doc_no = ${so.doc_no} ORDER BY do_date`);
      console.log(`ROW|${t}: co${so.company_id} ${so.doc_no} ${so.so_date} ${so.status} slip=[${so.customer_so_no ?? ''}|${so.ref ?? ''}] RM ${rm(so.local_total_sen)} → DOs: ${dos.map((d) => `co${d.company_id} ${d.do_number} ${d.do_date} ${d.status} 3pl=${d.threepl_company_id ?? '-'}`).join('; ') || 'none'}`);
    }
  }
  const carriers = await sql`SELECT company_id, id, name FROM scm.threepl_companies ORDER BY company_id, name`;
  for (const c of carriers) console.log(`ROW|carrier co${c.company_id} ${c.id} ${c.name}`);
  const charges = await sql`SELECT count(*)::int AS n FROM scm.threepl_do_charges`;
  console.log(`ROW|3PL charges keyed: ${charges[0].n}`);
} finally { await sql.end(); }
