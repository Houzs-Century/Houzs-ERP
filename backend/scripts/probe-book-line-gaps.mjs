#!/usr/bin/env node
/* probe-book-line-gaps — READ-ONLY. What the ERP actually holds on a named
 * document, printed beside what the account book states, ONE SIDE AT A TIME.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * `diag-doc-differ-cause.mjs` prints the reconcile's finding and the BOOK's
 * lines. It deliberately prints no ERP row, because it opens no connection. So
 * every plan to repair one of those documents had to be written against a guess
 * about our own side: which row carries which AutoCount key, what quantity it
 * states, what its money is, whether it moved stock. Guessing that is how
 * 「a dry run once planned to copy one sofa's price three times」 got written.
 *
 * This prints OUR side. It compares nothing and it decides nothing.
 *
 * ── IT MEASURES NOTHING, AND MUST NEVER LEARN HOW ───────────────────────────
 * `check-ac-erp-reconcile.mjs` is the only thing in this repo that compares a
 * book value to an ERP value; a second opinion about "different" is the failure
 * in docs/bugs/0708. This file prints two sides and draws no conclusion — there
 * is no equality test anywhere in it, and its output is a pair of listings, not
 * a verdict.
 *
 * ── READ-ONLY BY CONSTRUCTION ───────────────────────────────────────────────
 * Every statement is a SELECT. There is no MODE, no APPLY flag, no transaction
 * and no INSERT/UPDATE/DELETE anywhere in the file.
 *
 * The book side is the committed cut data/ac-reconcile-truth.json.gz — the same
 * file the reconcile compares against, so the two cannot be reading different
 * books. The money field names are the DECODED ones (`unitPriceSen`,
 * `subTotalSen`): reading `unitPrice` off a decoded row returns undefined and a
 * field name that does not exist reads as zero everywhere.
 *
 * Usage:
 *   TYPE=DO DOCS=HC-DO-010332,HC-DO-011465 node scripts/probe-book-line-gaps.mjs
 *
 *   TYPE   one of SO PO GR DO IV PI. Required.
 *   DOCS   comma-separated ERP document numbers. Required — this is a probe of
 *          NAMED documents, never a sweep.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { decodeSnapshot } from "./lib/ac-scope.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CO = Number(process.env.COMPANY_ID || 1);
const TYPE = String(process.env.TYPE || "").trim().toUpperCase();
const DOCS = String(process.env.DOCS || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

const p = (m) => console.log(m);
const rm = (sen) => (sen == null ? "—" : `RM ${(Number(sen) / 100).toFixed(2)}`);
const refuse = (why) => { console.error(`REFUSED: ${why}`); process.exit(2); };

if (!process.env.DATABASE_URL) refuse("DATABASE_URL not set.");
if (!["SO", "PO", "GR", "DO", "IV", "PI"].includes(TYPE)) refuse(`TYPE must be one of SO PO GR DO IV PI, got ${JSON.stringify(TYPE)}.`);
if (!DOCS.length) refuse("DOCS not set. This probe reads NAMED documents; it never sweeps.");

const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-reconcile-truth.json.gz"))));
const book = decodeSnapshot(snap);

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

/* The ERP side, one reader per type. Table and column names are the ones
   lib/ac-reconcile-erp-sql.mjs states — this asks the same tables the reconcile
   asks, so a row printed here is a row it compared. */
const READERS = {
  SO: {
    acOf: (d) => d.replace(/^HC-(SO-)/, "$1"),
    header: (d) => sql`SELECT doc_no, linked_ac_docno, status, subtotal_sen, local_total_sen, line_count,
        currency::text AS currency FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${d}`,
    lines: (d) => sql`SELECT id::text, line_no, item_code, item_group, line_suffix, qty::float8 AS qty,
        unit_price_sen, total_sen, linked_ac_dtlkey::text AS dtlkey, description2, variants, custom_specials,
        uom, location, warehouse_id::text AS warehouse_id
      FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND doc_no = ${d} ORDER BY line_no, id`,
    moves: (d) => sql`SELECT count(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${d}`,
  },
  DO: {
    acOf: (d) => d.replace(/^HC-(DO-)/, "$1"),
    header: (d) => sql`SELECT do_number AS doc_no, linked_ac_docno, status, local_total_sen, so_number
      FROM scm.delivery_orders WHERE company_id = ${CO} AND do_number = ${d}`,
    lines: (d) => sql`SELECT i.id::text, i.line_no, i.item_code, i.item_group, i.line_suffix, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey::text AS dtlkey, i.description2, i.variants, i.custom_specials,
        i.so_item_id::text AS so_item_id
      FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      WHERE h.company_id = ${CO} AND h.do_number = ${d} ORDER BY i.line_no, i.id`,
    moves: (d) => sql`SELECT count(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${d}`,
  },
  IV: {
    acOf: (d) => d.replace(/^HC-SI-/, "I-").replace(/^HC-I-/, "I-"),
    header: (d) => sql`SELECT invoice_number AS doc_no, linked_ac_docno, status, total_sen, local_total_sen
      FROM scm.sales_invoices WHERE company_id = ${CO} AND invoice_number = ${d}`,
    lines: (d) => sql`SELECT i.id::text, i.line_no, i.item_code, i.item_group, i.line_suffix, i.qty::float8 AS qty,
        i.unit_price_sen, i.line_total_sen, i.linked_ac_dtlkey::text AS dtlkey, i.description2, i.variants
      FROM scm.sales_invoice_items i JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
      WHERE h.company_id = ${CO} AND h.invoice_number = ${d} ORDER BY i.line_no, i.id`,
    moves: (d) => sql`SELECT count(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${d}`,
  },
  GR: {
    acOf: (d) => d.replace(/^HC-GR-/, "GR-"),
    header: (d) => sql`SELECT g.grn_number AS doc_no, g.linked_ac_gr_docno, g.linked_ac_docno AS po_ac_docno,
        p.linked_ac_docno AS po_book_no, p.po_number, g.status, g.total_sen, g.subtotal_sen,
        g.currency::text AS currency, COALESCE(g.migrated_no_stock, false) AS migrated_no_stock
      FROM scm.grns g LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      WHERE g.company_id = ${CO} AND g.grn_number = ${d}`,
    lines: (d) => sql`SELECT i.id::text, i.item_code, i.qty_accepted::float8 AS qty,
        i.qty_received::float8 AS qty_received, i.unit_price_sen, i.discount_sen, i.line_total_sen,
        i.linked_ac_dtlkey::text AS dtlkey, i.description2, i.po_item_id::text AS po_item_id, i.invoiced_qty
      FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
      WHERE g.company_id = ${CO} AND g.grn_number = ${d} ORDER BY i.id`,
    moves: (d) => sql`SELECT count(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${d}`,
  },
  PO: {
    acOf: (d) => d.replace(/^HC-PO-/, "PO-"),
    header: (d) => sql`SELECT po_number AS doc_no, linked_ac_docno, status, total_sen, currency::text AS currency
      FROM scm.purchase_orders WHERE company_id = ${CO} AND po_number = ${d}`,
    lines: (d) => sql`SELECT i.id::text, i.item_code, i.qty::float8 AS qty, i.unit_price_sen, i.discount_sen,
        i.line_total_sen, i.linked_ac_dtlkey::text AS dtlkey, i.description2, i.so_item_id::text AS so_item_id
      FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      WHERE h.company_id = ${CO} AND h.po_number = ${d} ORDER BY i.id`,
    moves: (d) => sql`SELECT count(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${d}`,
  },
  PI: {
    acOf: (d) => d.replace(/^HC-PI-/, "PI-"),
    header: (d) => sql`SELECT invoice_number AS doc_no, linked_ac_docno, status, total_sen
      FROM scm.purchase_invoices WHERE company_id = ${CO} AND invoice_number = ${d}`,
    lines: (d) => sql`SELECT i.id::text, i.item_code, i.qty::float8 AS qty, i.unit_price_sen,
        i.linked_ac_dtlkey::text AS dtlkey, i.description2
      FROM scm.purchase_invoice_items i JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      WHERE h.company_id = ${CO} AND h.invoice_number = ${d} ORDER BY i.id`,
    moves: (d) => sql`SELECT count(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${d}`,
  },
};

async function main() {
  const R = READERS[TYPE];
  p(`book snapshot ${snap.exported_at} · company ${CO} · type ${TYPE} · ${DOCS.length} document(s)`);
  for (const doc of DOCS) {
    const ac = R.acOf(doc);
    p("");
    p(`════════ ${doc}   (account book ${ac}) ════════`);

    const [h] = await R.header(doc);
    if (!h) p(`   THE ERP HOLDS NO SUCH DOCUMENT.`);
    else p(`   ERP header: ${JSON.stringify(h)}`);

    const rows = h ? await R.lines(doc) : [];
    p(`   ERP lines: ${rows.length}`);
    for (const r of rows) p(`      ${JSON.stringify(r)}`);

    if (h) {
      const [m] = await R.moves(doc);
      p(`   inventory movements naming ${doc}: ${m.n}`);
    }

    const bh = book[TYPE]?.headers?.get(ac) ?? null;
    const bl = book[TYPE]?.lines?.get(ac) ?? [];
    p(`   BOOK header: ${bh ? JSON.stringify(bh) : "(the book has no such document)"}`);
    p(`   BOOK lines: ${bl.length}`);
    for (const l of bl) {
      const d2 = book[TYPE].desc2.get(String(l.dtlKey));
      p(`      dtl ${l.dtlKey} seq ${l.seq} ${l.itemKey || "(no item code)"} qty ${l.qty} unit ${rm(l.unitPriceSen)} sub ${rm(l.subTotalSen)} from ${l.fromDocType || "-"}:${l.fromDocNo || "-"} loc ${l.location ?? "-"}`);
      if (d2) p(`         Desc2: ${JSON.stringify(d2)}`);
    }
  }
  await sql.end();
  p("");
  p("Read-only: every statement was a SELECT, no transaction was opened and nothing was written.");
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
