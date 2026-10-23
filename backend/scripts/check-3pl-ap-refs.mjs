#!/usr/bin/env node
// check-3pl-ap-refs.mjs — READ-ONLY. Owner 2026-10-23: 「其实我的ap invoice 本身就带有
// so number 或do number」. Where on the transport AP invoices the SO / DO numbers
// sit (header ref, notes, line description), in what spelling, and whether they
// resolve to orders / delivery orders in the system. Writes nothing.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
const rm = (sen) => (Number(sen ?? 0) / 100).toFixed(2);
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
try {
  /* Transport bills: a transport-sounding supplier, or a line on a 900-T account. */
  const inv = await sql`
    SELECT DISTINCT i.id, i.company_id, i.invoice_number, i.supplier_invoice_ref, i.invoice_date, i.total_sen, i.status, i.notes, s.name AS supplier
      FROM scm.ap_invoices i
      JOIN scm.suppliers s ON s.id = i.supplier_id
      LEFT JOIN scm.ap_invoice_lines l ON l.invoice_id = i.id
     WHERE i.status <> 'CANCELLED'
       AND (s.name ~* '(TRANSPORT|LOGISTIC|LORRY|DELIVER|FREIGHT|EXPRESS|COURIER|MOVER|HAULAGE|BRIGHTSUN)' OR l.debit_account_code LIKE '900-T%')
     ORDER BY i.invoice_date DESC, i.invoice_number`;
  console.log(`ROW|transport AP invoices: ${inv.length}`);
  const ids = inv.map((i) => i.id);
  const lines = ids.length ? await sql`
    SELECT l.invoice_id, l.line_no, l.description, l.debit_account_code, l.amount_sen, l.project_id
      FROM scm.ap_invoice_lines l WHERE l.invoice_id IN ${sql(ids)} ORDER BY l.invoice_id, l.line_no` : [];
  const byInv = new Map();
  for (const l of lines) { const a = byInv.get(l.invoice_id) ?? []; a.push(l); byInv.set(l.invoice_id, a); }
  for (const i of inv) {
    console.log(`ROW|== co${i.company_id} ${i.invoice_number} ${i.invoice_date} ${i.status} RM ${rm(i.total_sen)} "${i.supplier}" ref=[${one(i.supplier_invoice_ref)}] notes=[${one(i.notes).slice(0, 160)}]`);
    for (const l of byInv.get(i.id) ?? []) {
      console.log(`ROW|   ${l.line_no}. ${l.debit_account_code} RM ${rm(l.amount_sen)} ev=${l.project_id ?? '-'} — ${one(l.description).slice(0, 200)}`);
    }
  }
  /* Every token that looks like an order / delivery / slip number. */
  const text = [...inv.flatMap((i) => [i.supplier_invoice_ref, i.notes]), ...lines.map((l) => l.description)].map(one).join(' \n ');
  const pats = {
    so: /\b(?:HC|2990)?-?SO-?\d{4}-?\d{3,4}\b|\bHC-SO-\d{5,6}\b/gi,
    do: /\b(?:HC|2990)?-?DO-?\d{4}-?\d{3,4}\b|\bHC-DO-\d{5,6}\b/gi,
    bare: /\b2[56]\d{2}-\d{3}\b/g,
    slip: /\b(?:HC|ZNT|ZN|AK|DP)\s?\d{4,6}\b/gi,
  };
  for (const [k, re] of Object.entries(pats)) {
    const found = [...new Set(text.match(re) ?? [])];
    console.log(`ROW|tokens ${k}: ${found.length} e.g. ${found.slice(0, 25).join(', ')}`);
  }
} finally { await sql.end(); }
