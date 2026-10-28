#!/usr/bin/env node
/* check-houzs-find-text.mjs — READ ONLY. Where does a paper number the owner
   quotes (e.g. a receipt-book number "HC12772") live in the ERP? Searches the
   whole row text of the company's sales orders, sales-order payments, sales
   invoices, payment vouchers, payment requests and Diglant-style GRNs/PIs for
   each needle, and prints every hit with the columns that carry it. Also lists
   one supplier's GRNs in a window with their delivery note ref and the
   purchase invoices billing them (GRN_SUPPLIER / FROM / TO), so a D/O number
   can be paired with its invoice.
   Env: DATABASE_URL, COMPANY_ID (1), NEEDLES (comma list), GRN_SUPPLIER, FROM, TO.
   Writes nothing. */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const NEEDLES = String(process.env.NEEDLES || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const TABLES = [
      ['mfg_sales_orders', 'doc_no'], ['mfg_sales_order_payments', 'so_doc_no'], ['sales_invoices', 'invoice_number'],
      ['payment_vouchers', 'pv_number'], ['acc_payment_requests', 'request_no'], ['acc_receipts', 'receipt_number'], ['mfg_so_audit_log', 'so_doc_no'],
    ];
    for (const n of NEEDLES) {
      let hits = 0;
      for (const [t, noCol] of TABLES) {
        const rows = await sql.unsafe(`SELECT t.* FROM scm.${t} t WHERE t.company_id = $1 AND row_to_json(t)::text ILIKE $2 LIMIT 15`, [CO, `%${n}%`]).catch((e) => { out('ERR', { table: t, msg: String(e.message).slice(0, 160) }); return []; });
        for (const r of rows) {
          hits += 1;
          const where = Object.entries(r).filter(([, v]) => v != null && String(v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : v).toUpperCase().includes(n.toUpperCase()))
            .map(([k, v]) => `${k}=${String(typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v).slice(0, 140)}`);
          out('HIT', { needle: n, table: t, no: r[noCol] ?? r.id, date: day(r.paid_at ?? r.so_date ?? r.doc_date ?? r.voucher_date ?? r.invoice_date ?? r.created_at), amount: Number(r.amount_sen ?? r.total_sen ?? 0),
            status: r.status ?? null, method: r.method ?? null, who: r.debtor_name ?? r.payee_name ?? r.customer_name ?? null, where });
        }
      }
      if (!hits) out('HIT', { needle: n, none: true });
    }
    const SUP = process.env.GRN_SUPPLIER;
    if (SUP) {
      const FROM = process.env.FROM || '2026-08-25'; const TO = process.env.TO || '2026-09-30';
      const [s] = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = ${CO} AND code = ${SUP}`;
      const grns = await sql`SELECT id, grn_number, received_at, delivery_note_ref, total_sen, status, purchase_order_id, linked_ac_docno, migrated_no_stock FROM scm.grns
          WHERE company_id = ${CO} AND supplier_id::text = ${String(s.id)} AND received_at >= ${FROM} AND received_at < (${TO}::date + 1) ORDER BY received_at, grn_number`;
      const pis = await sql`SELECT id, invoice_number, supplier_invoice_ref, invoice_date::text AS d, total_sen, status::text AS status, grn_id, purchase_order_id, coalesce(migrated_no_stock, false) AS migrated, linked_ac_docno
          FROM scm.purchase_invoices WHERE company_id = ${CO} AND supplier_id::text = ${String(s.id)} AND invoice_date >= ${FROM}::date - 10 AND invoice_date <= ${TO}::date + 40 AND status::text <> 'CANCELLED'`;
      const firstRef = new Map((await sql`SELECT DISTINCT ON (entity_doc_no) entity_doc_no, field_changes FROM scm.entity_audit_log WHERE company_id = ${CO} AND entity_type = 'PURCHASE_INVOICE'
          AND entity_doc_no = ANY(${pis.map((p) => p.invoice_number)}::text[]) AND action = 'CREATE' ORDER BY entity_doc_no, created_at`).map((a) => {
        const ch = Array.isArray(a.field_changes) ? a.field_changes : []; const r = ch.find((c) => c.field === 'supplierInvoiceRef'); return [a.entity_doc_no, r ? r.to : null];
      }));
      for (const g of grns) {
        const billed = pis.filter((p) => String(p.grn_id) === String(g.id));
        out('GRN', { grn: g.grn_number, date: day(g.received_at), dn: g.delivery_note_ref, sen: Number(g.total_sen), status: g.status, ac: g.linked_ac_docno, migrated: g.migrated_no_stock,
          pis: billed.map((p) => `${p.invoice_number} ref ${p.supplier_invoice_ref ?? '-'}${firstRef.get(p.invoice_number) && firstRef.get(p.invoice_number) !== p.supplier_invoice_ref ? ` (keyed first as ${firstRef.get(p.invoice_number)})` : ''} ${p.d} ${Number(p.total_sen)} ${p.status}${p.migrated ? ' migrated' : ''}`) });
      }
      for (const p of pis.filter((p) => !grns.some((g) => String(g.id) === String(p.grn_id)))) {
        out('PINOGRN', { no: p.invoice_number, ref: p.supplier_invoice_ref, first: firstRef.get(p.invoice_number) ?? null, date: p.d, sen: Number(p.total_sen), status: p.status, migrated: p.migrated, ac: p.linked_ac_docno, grn: p.grn_id ? 'outside window' : null });
      }
    }
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
