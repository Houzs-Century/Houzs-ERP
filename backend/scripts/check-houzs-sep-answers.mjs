#!/usr/bin/env node
/* check-houzs-sep-answers.mjs — READ ONLY. The owner's answers on the
   September import trial (2026-10-28, 「先别做，先确定」):
     PI   for each AutoCount purchase invoice he listed (screenshots with the
          supplier invoice no. AND the supplier D/O no.): every ERP paper of the
          company that carries either number anywhere — purchase invoices, AP
          invoices, GRNs, purchase orders (whole row as text, so a D/O typed as
          the "invoice ref" and later relabelled still shows), and the audit
          trail (an old value in field_changes) — plus same-supplier bills of
          the same amount within 20 days, as hints only.
          ITEMS: "acDoc:supplier:needle1/needle2:date:sen,…" (comma between items — the runner splits env on ;)
     RCPT for each receipt-book number (HC12772, …): the sales-order payments
          whose account sheet or note carries it, with the order and its journal.
          SHEETS: comma list.
     PIX  the named purchase invoices whole (lines, groups, GRN/PO, audit).
          PIS: comma list.
   Env: DATABASE_URL, COMPANY_ID (1), ITEMS, SHEETS, PIS. Writes nothing. */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const out = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));
const plain = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
const ITEMS = String(process.env.ITEMS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const [acDoc, supplier, needles, date, sen] = s.split(':');
  return { acDoc, supplier, needles: needles.split('/').filter(Boolean), date, sen: Number(sen) };
});
const SHEETS = String(process.env.SHEETS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PIS = String(process.env.PIS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const sups = await sql`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO}`;
    const supId = new Map(sups.map((s) => [s.code, String(s.id)]));
    const supCode = new Map(sups.map((s) => [String(s.id), s.code]));
    const cols = async (t) => (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = ${t}`).map((r) => r.column_name);
    const tables = [];
    for (const t of ['purchase_invoices', 'ap_invoices', 'grns', 'purchase_orders']) {
      const c = await cols(t);
      if (!c.length) { out('ERR', { table: t, msg: 'no such table' }); continue; }
      tables.push({ t, c, no: ['invoice_number', 'grn_number', 'po_number', 'doc_no'].find((x) => c.includes(x)), sup: c.includes('supplier_id') ? 'supplier_id' : null });
      out('COLS', { table: t, cols: c });
    }
    for (const it of ITEMS) {
      const sid = supId.get(it.supplier) ?? null;
      for (const tb of tables) {
        for (const n of it.needles) {
          const rows = await sql.unsafe(`SELECT t.* FROM scm.${tb.t} t WHERE t.company_id = $1 ${tb.sup && sid ? `AND t.${tb.sup}::text = $3` : ''} AND row_to_json(t)::text ILIKE $2 LIMIT 20`, tb.sup && sid ? [CO, `%${n}%`, sid] : [CO, `%${n}%`]);
          for (const r of rows) {
            const hitCols = Object.entries(r).filter(([, v]) => v != null && String(v instanceof Date ? v.toISOString() : v).toUpperCase().includes(n.toUpperCase())).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
            out('HIT', { ac: it.acDoc, needle: n, table: tb.t, no: tb.no ? r[tb.no] : r.id, supplier: r.supplier_id ? supCode.get(String(r.supplier_id)) ?? null : null,
              date: day(r.invoice_date ?? r.received_date ?? r.grn_date ?? r.order_date ?? r.po_date ?? r.created_at), total: Number(r.total_sen ?? 0), status: r.status ?? null, migrated: r.migrated_no_stock ?? null, where: hitCols });
          }
        }
      }
      for (const n of it.needles) {
        const au = await sql`SELECT entity_type, entity_doc_no, action, actor_name_snapshot, created_at, field_changes FROM scm.entity_audit_log
            WHERE company_id = ${CO} AND entity_type IN ('PURCHASE_INVOICE', 'GRN', 'PURCHASE_ORDER', 'AP_INVOICE') AND (field_changes::text ILIKE ${`%${n}%`} OR note ILIKE ${`%${n}%`}) LIMIT 20`;
        for (const a of au) out('AUDITHIT', { ac: it.acDoc, needle: n, entity: a.entity_type, doc: a.entity_doc_no, action: a.action, by: a.actor_name_snapshot, at: a.created_at, changes: JSON.stringify(a.field_changes).slice(0, 300) });
      }
      if (sid && it.sen) {
        const near = await sql`SELECT 'PI' AS k, invoice_number AS no, supplier_invoice_ref AS ref, invoice_date::text AS d, total_sen, status::text AS status, coalesce(migrated_no_stock, false) AS migrated FROM scm.purchase_invoices
            WHERE company_id = ${CO} AND supplier_id::text = ${sid} AND total_sen = ${it.sen} AND abs(invoice_date - ${it.date}::date) <= 20 AND status::text <> 'CANCELLED'
            UNION ALL SELECT 'API', invoice_number, supplier_invoice_ref, invoice_date::text, total_sen, status, false FROM scm.ap_invoices
            WHERE company_id = ${CO} AND supplier_id::text = ${sid} AND total_sen = ${it.sen} AND abs(invoice_date - ${it.date}::date) <= 20 AND status <> 'CANCELLED'`;
        for (const r of near) out('NEAR', { ac: it.acDoc, k: r.k, no: r.no, ref: r.ref, date: r.d, total: Number(r.total_sen), status: r.status, migrated: r.migrated });
      }
      out('DONE', { ac: it.acDoc });
    }

    for (const s of SHEETS) {
      const pays = await sql`SELECT * FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND (account_sheet ILIKE ${`%${s}%`} OR note ILIKE ${`%${s}%`}) ORDER BY paid_at`;
      if (!pays.length) out('RCPT', { sheet: s, none: true });
      for (const p of pays) {
        const soRow = (await sql`SELECT * FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${p.so_doc_no}`.catch(() => []))[0] ?? null;
        const so = soRow ? Object.fromEntries(['doc_no', 'status', 'debtor_name', 'debtor_code', 'customer_id', 'so_date', 'doc_date', 'created_at', 'total_sen', 'grand_total_sen', 'venue_name'].filter((k) => k in soRow).map((k) => [k, soRow[k] instanceof Date ? soRow[k].toISOString() : soRow[k]])) : null;
        const je = await sql`SELECT je_no, entry_date::text AS d, posted, reversed, source_type, total_debit_sen FROM scm.journal_entries WHERE company_id = ${CO} AND source_doc_no = ${String(p.id)} OR (company_id = ${CO} AND narration ILIKE ${`%${p.so_doc_no}%`} AND source_type IN ('SOPAY', 'SOPAY_REVERSAL') AND total_debit_sen = ${Math.abs(Number(p.amount_sen))})`.catch(() => []);
        const all = await sql`SELECT paid_at, method, amount_sen, account_sheet, is_deposit FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no = ${p.so_doc_no} ORDER BY paid_at`;
        out('RCPT', { sheet: s, pay: plain(Object.fromEntries(Object.entries(p).filter(([k]) => !/slip|ocr|raw|image/i.test(k)))), so, je: je.map((j) => `${j.je_no} ${j.source_type} ${j.d} ${j.posted ? 'posted' : 'draft'}${j.reversed ? ' reversed' : ''} ${j.total_debit_sen}`),
          soPayments: all.map((x) => `${day(x.paid_at)} ${x.method} ${x.amount_sen} ${x.account_sheet ?? '-'}${x.is_deposit ? ' dep' : ''}`) });
      }
    }

    if (PIS.length) {
      for (const p of await sql`SELECT * FROM scm.purchase_invoices WHERE company_id = ${CO} AND invoice_number = ANY(${PIS}::text[]) ORDER BY invoice_number`) {
        const items = await sql`SELECT * FROM scm.purchase_invoice_items WHERE purchase_invoice_id = ${p.id}`;
        const grn = p.grn_id ? (await sql`SELECT * FROM scm.grns WHERE id = ${p.grn_id}`.catch(() => []))[0] ?? null : null;
        const po = p.purchase_order_id ? (await sql`SELECT * FROM scm.purchase_orders WHERE id = ${p.purchase_order_id}`.catch(() => []))[0] ?? null : null;
        const au = await sql`SELECT action, actor_name_snapshot, created_at, field_changes FROM scm.entity_audit_log WHERE company_id = ${CO} AND entity_doc_no = ${p.invoice_number} ORDER BY created_at`;
        out('PIX', { pi: plain(p), supplier: supCode.get(String(p.supplier_id)) ?? null,
          items: items.map((i) => ({ code: i.item_code, name: i.material_name, desc: i.description, qty: Number(i.qty), unit: Number(i.unit_price_sen), sen: Number(i.line_total_sen), group: i.item_group, ac: i.linked_ac_dtlkey != null, at: i.created_at })),
          grn: grn ? plain(grn) : null, po: po ? { no: po.po_number ?? po.doc_no ?? null, date: day(po.po_date ?? po.order_date ?? po.created_at), status: po.status ?? null, total: Number(po.total_sen ?? 0) } : null,
          audit: au.map((a) => ({ action: a.action, by: a.actor_name_snapshot, at: a.created_at, changes: JSON.stringify(a.field_changes).slice(0, 400) })) });
      }
    }
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
