#!/usr/bin/env node
/* probe-book-line-in-erp — READ-ONLY. Where does ONE account-book LINE live in
 * the ERP, and would adding a compartment row beside it move stock?
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * `probe-book-line-gaps.mjs` answers "what does the ERP hold on THIS document",
 * which needs the ERP document NUMBER. That is exactly what a chain repair does
 * not have. One account-book receipt can cover several purchase orders and the
 * ERP splits it into one receipt per purchase order (`scm.grns.purchase_order_id`
 * is a single PO; reshape-migrated-grns.mjs states the same fact), so the book's
 * `GR-000287` is TWO ERP receipts and only one of them carries that number.
 * Asking "which ERP document holds book DtlKey 84946" cannot be answered by
 * naming a document, and guessing the number is how a plan comes to be written
 * against the wrong receipt.
 *
 * The book LINE KEY is the fact that survives every renumber: six ERP tables
 * carry it as `linked_ac_dtlkey` (migrations 0273 and 0280). This looks a key up
 * in all six and prints the row and its document, whatever the document is
 * called.
 *
 * ── SECTION 2: WOULD A WRITE MOVE STOCK ─────────────────────────────────────
 * 「库存先不看」 — the owner. A correction that adds a compartment row to a
 * migrated receipt or delivery note is paperwork, and the claim that it moves no
 * on-hand figure has to be PROVED against the database rather than asserted from
 * the fact that the header says `migrated_no_stock`. So this also prints every
 * trigger on the four downstream line tables, from `pg_trigger` on the same
 * production database, with the definition each one carries. A reader can then
 * see for themselves whether an INSERT there reaches inventory.
 *
 * IT DECIDES NOTHING. It prints rows and trigger definitions; there is no
 * verdict, no comparison and no equality test anywhere in the file.
 *
 * ── READ-ONLY BY CONSTRUCTION ───────────────────────────────────────────────
 * Every statement is a SELECT. There is no MODE, no APPLY flag, no transaction
 * and no INSERT/UPDATE/DELETE.
 *
 * Usage:
 *   KEYS=84946,84948,84950,84952 node scripts/probe-book-line-in-erp.mjs
 *
 *   KEYS       comma-separated AutoCount DtlKeys. Required - this is a probe of
 *              NAMED lines, never a sweep.
 *   COMPANY    ERP company, default 1.
 */
import postgres from "postgres";

const CO = Number(process.env.COMPANY || process.env.COMPANY_ID || 1);
const KEYS = String(process.env.KEYS || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

const p = (m = "") => console.log(m);
const refuse = (why) => { console.error(`REFUSED: ${why}`); process.exit(2); };

if (!process.env.DATABASE_URL) refuse("DATABASE_URL not set.");
if (!KEYS.length) refuse("KEYS not set. This probe reads NAMED book lines; it never sweeps.");
if (!KEYS.every((k) => /^\d+$/.test(k))) refuse(`every KEY must be a bare DtlKey number, got ${JSON.stringify(KEYS)}.`);

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const keys = KEYS.map((k) => Number(k));

/* One reader per table that carries `linked_ac_dtlkey`. The document number is
   SELECTed with the row, because the whole point is that the caller does not
   know it. */
const TABLES = [
  {
    name: "scm.mfg_sales_order_items",
    rows: () => sql`SELECT i.linked_ac_dtlkey::text AS dtlkey, i.doc_no AS doc, i.id::text, i.line_no,
        i.item_code, i.item_group, i.qty::float8 AS qty, i.unit_price_sen, i.total_sen, i.description2
      FROM scm.mfg_sales_order_items i
      WHERE i.company_id = ${CO} AND i.linked_ac_dtlkey = ANY(${keys}) ORDER BY i.doc_no, i.line_no, i.id`,
  },
  {
    name: "scm.purchase_order_items",
    rows: () => sql`SELECT i.linked_ac_dtlkey::text AS dtlkey, h.po_number AS doc, i.id::text,
        i.item_code, i.qty::float8 AS qty, i.received_qty::float8 AS received_qty, i.unit_price_sen,
        i.line_total_sen, i.so_item_id::text AS so_item_id, i.description2
      FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey = ANY(${keys}) ORDER BY h.po_number, i.id`,
  },
  {
    name: "scm.grn_items",
    rows: () => sql`SELECT i.linked_ac_dtlkey::text AS dtlkey, h.grn_number AS doc, i.id::text,
        i.item_code, i.qty_accepted::float8 AS qty, i.unit_price_sen, i.line_total_sen,
        i.po_item_id::text AS po_item_id, i.invoiced_qty::float8 AS invoiced_qty,
        h.purchase_order_id::text AS po_id, h.linked_ac_gr_docno,
        COALESCE(h.migrated_no_stock, false) AS migrated_no_stock, i.description2
      FROM scm.grn_items i JOIN scm.grns h ON h.id = i.grn_id
      WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey = ANY(${keys}) ORDER BY h.grn_number, i.id`,
  },
  {
    name: "scm.delivery_order_items",
    rows: () => sql`SELECT i.linked_ac_dtlkey::text AS dtlkey, h.do_number AS doc, i.id::text, i.line_no,
        i.item_code, i.qty::float8 AS qty, i.unit_price_sen, i.so_item_id::text AS so_item_id,
        h.so_doc_no, COALESCE(h.migrated_no_stock, false) AS migrated_no_stock, i.description2
      FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey = ANY(${keys}) ORDER BY h.do_number, i.line_no, i.id`,
  },
  {
    name: "scm.sales_invoice_items",
    rows: () => sql`SELECT i.linked_ac_dtlkey::text AS dtlkey, h.invoice_number AS doc, i.id::text, i.line_no,
        i.item_code, i.qty::float8 AS qty, i.unit_price_sen, i.line_total_sen,
        i.do_item_id::text AS do_item_id, COALESCE(h.migrated_no_stock, false) AS migrated_no_stock,
        i.description2
      FROM scm.sales_invoice_items i JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
      WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey = ANY(${keys}) ORDER BY h.invoice_number, i.line_no, i.id`,
  },
  {
    name: "scm.purchase_invoice_items",
    rows: () => sql`SELECT i.linked_ac_dtlkey::text AS dtlkey, h.invoice_number AS doc, i.id::text,
        i.item_code, i.qty::float8 AS qty, i.unit_price_sen, i.grn_item_id::text AS grn_item_id,
        COALESCE(h.migrated_no_stock, false) AS migrated_no_stock, i.description2
      FROM scm.purchase_invoice_items i JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey = ANY(${keys}) ORDER BY h.invoice_number, i.id`,
  },
];

/* The four tables a downstream compartment write would INSERT into. Named
   explicitly rather than swept, so the list in the log is the list the reader
   is being asked to check. */
const WRITE_TABLES = ["grn_items", "delivery_order_items", "sales_invoice_items", "purchase_invoice_items"];

async function main() {
  p(`company ${CO} · book line key(s) ${KEYS.join(", ")}`);
  p("");
  p("════════ 1. WHERE EACH BOOK LINE LIVES IN THE ERP ════════");
  for (const t of TABLES) {
    const rows = await t.rows();
    p("");
    p(`── ${t.name}: ${rows.length} row(s)`);
    for (const r of rows) p(`   dtl ${r.dtlkey}  ${r.doc}  ${JSON.stringify(r)}`);
  }

  p("");
  p("════════ 2. TRIGGERS ON THE TABLES A COMPARTMENT WRITE WOULD TOUCH ════════");
  p("Printed so 「库存先不看」 can be checked against the database rather than assumed.");
  const trg = await sql`
    SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name,
           pg_get_triggerdef(t.oid)::text AS definition, t.tgenabled::text AS enabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'scm' AND c.relname = ANY(${WRITE_TABLES})
     ORDER BY c.relname, t.tgname`;
  for (const name of WRITE_TABLES) {
    const mine = trg.filter((r) => r.table_name === name);
    p("");
    p(`── scm.${name}: ${mine.length} non-internal trigger(s)`);
    for (const r of mine) p(`   ${r.trigger_name} (tgenabled=${r.enabled})\n      ${r.definition}`);
  }

  await sql.end();
  p("");
  p("Read-only: every statement was a SELECT, no transaction was opened and nothing was written.");
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch { /* already closed */ } process.exit(1); });
