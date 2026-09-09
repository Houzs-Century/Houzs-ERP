#!/usr/bin/env node
/* probe-so-po-compartment-cover — READ-ONLY. Is a sofa whose purchase counter
 * disagrees with the account book actually SHORT OF A PURCHASE, or is the
 * disagreement only our own compartment grain?
 *
 * ── THE QUESTION, AND WHY IT HAS TO BE MEASURED BEFORE ANYTHING IS MOVED ───
 * lib/so-po-counter-cause.mjs classifies six sales-order lines as
 * `decomposed_grain` and labels them NOT A DEFECT: one book line is one ERP row
 * PER COMPARTMENT, and we recorded exactly the quantity the book moved, so the
 * FRACTION differs only because our denominator is the compartment count.
 *
 * That sentence is true about arithmetic and says nothing about the warehouse.
 * The same numbers also describe a REAL gap: the book bought one whole sofa, we
 * linked ONE of its three compartments, and the other two sales-order rows go on
 * offering themselves for purchase — the duplicate-purchase-order risk
 * recompute-so-po-qty-picked.mjs's own header warns about. A reclassification
 * built on the first reading while the second is true is exactly the failure
 * docs/bugs/0668 cost 30 documents on go-live eve.
 *
 * So this prints the WHOLE group, both sides, and decides nothing:
 *   - every ERP sales-order row carrying the book's line key (the compartments),
 *     with its own po_qty_picked;
 *   - every ERP purchase-order row of the purchase order the BOOK names, with
 *     the sales-order row it points at.
 *
 * A reader can then see whether the purchase order carries one row for the whole
 * sofa (our grain, not a gap) or three rows of which two point nowhere (a link
 * gap, and work).
 *
 * ── READ-ONLY AND BOUNDED ──────────────────────────────────────────────────
 * SELECTs only, one connection, no DDL, no writes, no transaction, no
 * MODE=apply. Every read is restricted to the documents named in DOCS — never a
 * table scan. It writes nothing and it plans nothing.
 *
 * Env: DATABASE_URL (required)   COMPANY_ID (default 1)
 *      DOCS  comma-separated AutoCount sales-order numbers (required)
 *      MAX_SNAPSHOT_AGE_DAYS (default 2)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, "data", "ac-convert-edges.json.gz");
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const DOCS = String(process.env.DOCS || "")
  .split(/[,;\s]+/)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m = "") => console.log(m);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!process.env.DATABASE_URL) die("DATABASE_URL is required");
if (!DOCS.length) die("DOCS is required — comma-separated AutoCount sales-order numbers, e.g. SO-013322,SO-011160");

/* ── the book side, from the committed chain cut ──────────────────────────── */
if (!fs.existsSync(SNAP)) die(`${path.basename(SNAP)} is not in the tree — refresh it with export-ac-convert-edges.mjs`);
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAX_AGE_DAYS)) {
  die(`the chain snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}). A verdict against a stale book reads as coverage we do not have`);
}
const L = Object.fromEntries((snap.line_fields || []).map((n, i) => [n, i]));
for (const f of ["docNo", "dtlKey", "itemKey", "qty", "transferedPoQty", "fromDocNo", "fromSoDtlKey"]) {
  if (L[f] === undefined) die(`the chain snapshot carries no \`${f}\` column`);
}

/* Which purchase-order lines the BOOK raised off each sales-order LINE. The
   SO->PO edge is the ONE edge AutoCount keys at line grain
   (PODTL.FromSODtlKey), so this needs no guessing and none is done. */
const poBySoLine = new Map();
for (const r of snap.types?.PO?.lines || []) {
  const k = String(r[L.fromSoDtlKey] || "").trim();
  if (!k) continue;
  if (!poBySoLine.has(k)) poBySoLine.set(k, []);
  poBySoLine.get(k).push({ docNo: r[L.docNo], dtlKey: String(r[L.dtlKey]), itemKey: r[L.itemKey], qty: Number(r[L.qty] || 0) });
}

const wanted = new Set(DOCS);
const bookLines = [];
for (const r of snap.types?.SO?.lines || []) {
  if (!wanted.has(String(r[L.docNo]).toUpperCase())) continue;
  const tp = r[L.transferedPoQty] === "" ? null : Number(r[L.transferedPoQty] || 0);
  if (!tp) continue;
  bookLines.push({
    docNo: r[L.docNo],
    dtlKey: String(r[L.dtlKey]),
    itemKey: r[L.itemKey],
    qty: Number(r[L.qty] || 0),
    transferedPoQty: tp,
    children: poBySoLine.get(String(r[L.dtlKey])) || [],
  });
}

const main = async () => {
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  const PDATE = soProcessingDateFragment(sql);
  try {
    out(`snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)  source=${snap.source}`);
    out(`company=${CO}  documents asked about: ${DOCS.join(", ")}`);
    out(`book: ${bookLines.length} sales-order line(s) on those documents carry a purchase counter`);

    const keys = [...new Set(bookLines.map((b) => b.dtlKey))];
    const poDocs = [...new Set(bookLines.flatMap((b) => b.children.map((c) => c.docNo)))];
    if (!keys.length) {
      log("no book line on those documents carries TransferedPOQty — nothing to probe");
      return;
    }

    /* BOUNDED: only the line keys named above, never the table. */
    const soRows = await sql`
      SELECT h.doc_no, h.linked_ac_docno, i.id::text AS id, i.item_code, i.qty::float8 AS qty,
             i.po_qty_picked::float8 AS picked, i.linked_ac_dtlkey::text AS dtlkey,
             (h.${PDATE} IS NOT NULL) AS proceeded
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey::text = ANY(${keys})
       ORDER BY h.doc_no, i.item_code`;

    const poRows = poDocs.length
      ? await sql`
          SELECT p.po_number, p.linked_ac_docno, p.status, i.id::text AS id, i.item_code,
                 i.qty::float8 AS qty, i.so_item_id::text AS so_item_id,
                 i.linked_ac_dtlkey::text AS dtlkey, i.from_mrp
            FROM scm.purchase_order_items i
            JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
           WHERE p.company_id = ${CO} AND upper(p.linked_ac_docno) = ANY(${poDocs.map((d) => d.toUpperCase())})
           ORDER BY p.po_number, i.item_code`
      : [];

    const soByKey = new Map();
    for (const r of soRows) {
      if (!soByKey.has(r.dtlkey)) soByKey.set(r.dtlkey, []);
      soByKey.get(r.dtlkey).push(r);
    }
    const poByDoc = new Map();
    for (const r of poRows) {
      const k = String(r.linked_ac_docno || "").toUpperCase();
      if (!poByDoc.has(k)) poByDoc.set(k, []);
      poByDoc.get(k).push(r);
    }

    let sofaGrainOnly = 0;
    let unlinkedPurchaseRows = 0;

    for (const b of bookLines) {
      const ours = soByKey.get(b.dtlKey) || [];
      const ourIds = new Set(ours.map((r) => r.id));
      out("");
      out("-".repeat(78));
      out(`BOOK  ${b.docNo} DtlKey ${b.dtlKey}  ${b.itemKey}  qty ${b.qty}  TransferedPOQty ${b.transferedPoQty}`);
      out(`      the book raised: ${b.children.length ? b.children.map((c) => `${c.docNo} line ${c.dtlKey} (${c.itemKey} qty ${c.qty})`).join(", ") : "(nothing)"}`);
      out(`ERP   ${ours.length} sales-order row(s) carry that line key:`);
      for (const r of ours) {
        out(`        ${r.doc_no}  ${r.item_code}  qty ${r.qty}  po_qty_picked ${r.picked}${r.proceeded ? "  PROCEEDED" : ""}`);
      }
      for (const c of b.children) {
        const rows = poByDoc.get(String(c.docNo).toUpperCase()) || [];
        out(`ERP   purchase order ${c.docNo}: ${rows.length} row(s)`);
        for (const r of rows) {
          const pointsHere = r.so_item_id && ourIds.has(r.so_item_id);
          const where = r.so_item_id ? (pointsHere ? "-> THIS sales line" : "-> another sales line") : "-> NOTHING";
          if (!r.so_item_id) unlinkedPurchaseRows += 1;
          out(`        ${r.po_number} [${r.status}] ${r.item_code}  qty ${r.qty}  ${where}${r.from_mrp ? "  from_mrp" : ""}${r.dtlkey ? `  key ${r.dtlkey}` : "  (no book line key)"}`);
        }
        /* THE WHOLE POINT. If the purchase order carries ONE row for a sofa we
           hold as several, the shortfall is our grain and not a missing
           purchase; if it carries as many rows as we do and only one is linked,
           the other compartments are genuinely uncovered and that is WORK. */
        if (rows.length === 1 && ours.length > 1) {
          sofaGrainOnly += 1;
          out(`        => the purchase order holds ONE row for a sofa we hold as ${ours.length} compartment(s): our grain, not a missing purchase`);
        } else if (rows.length > 1) {
          const linked = rows.filter((r) => r.so_item_id && ourIds.has(r.so_item_id)).length;
          out(`        => ${linked} of ${rows.length} purchase row(s) point at this sales line; ${rows.length - linked} do not`);
        }
      }
    }

    out("");
    log(
      `PROBE: ${bookLines.length} book line(s) read on ${DOCS.length} document(s). ` +
        `${sofaGrainOnly} purchase order(s) hold ONE row for a sofa we hold as several — that shortfall is our grain. ` +
        `${unlinkedPurchaseRows} purchase row(s) on those orders point at no sales line at all. Nothing was written.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
};

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
