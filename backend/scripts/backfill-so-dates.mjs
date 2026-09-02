#!/usr/bin/env node
// Backfill the two AutoCount dates the first export omitted, onto the already
// imported company-1 Sales Orders:
//   UDF_PDate (header)   -> processing_date      (processing date — this is what
//                                              gates MRP; owner: "SO 有 processing
//                                              date, MRP 就能跑")
//   SODTL.DeliveryDate   -> item.line_delivery_date  and, on the header, the
//                           earliest line date -> customer_delivery_date
// They are matched by the AutoCount DocNo we stored in linked_ac_docno + the
// line's ItemCode -> ERP item_code. NOT swapped: processing is the header UDF,
// delivery is the per-line column.
//
// RE-RUN: inert on a blank column, REFUSED on a document a person has touched.
// It used to be neither. Every UPDATE was unconditional, so a second run wrote
// AutoCount's dates back over whatever the ERP held - and all three of these
// columns are things people legitimately change. customer_delivery_date and
// line_delivery_date are edited on the order screen when a customer moves a
// date, and processing_date is CLEARED by the Super Admin "Remove Processing
// Date" action, which is the sanctioned way to pull an order back out of
// Proceed. A blind second pass silently undid all of it, and worse: it would
// re-manufacture the processing_date-vs-AutoCount agreement that
// unify-processing-date.mjs uses as its migration key, so a date a person had
// deliberately removed could then be promoted into internal_expected_dd as if
// the source had proved it.
//
// So: every UPDATE now re-asserts that the target column IS NULL - a backfill
// fills blanks, which is the whole job, and on the original run they were all
// blank, so the written result is unchanged - and any document whose audit
// trail mentions one of these dates is refused outright. Same two guards
// unify-processing-date.mjs already carries, for the same reason: an IS NULL
// key that a human action can restore to NULL is not a safe key on its own.
//
// DRY-RUN by default; APPLY=1 to write.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  SO_HEADER_LEGACY_PAYLOAD_KEYS,
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_LEGACY_COLUMNS,
  SO_PROCESSING_DATE_PAYLOAD_KEY,
} from "./lib/so-processing-date.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/* Every spelling this backfill's three dates have EVER been written under, as
   ILIKE needles against the stored audit jsonb.
   `scm.mfg_so_audit_log.field_changes` is TEXT written by whichever deploy was
   live that day, so it keeps the old names forever — which is why the retired
   ones stay here and why lib/so-processing-date.mjs records them. The CURRENT
   pair used to be missing outright: the list was written before mig 0286 and
   named only internal_expected_dd / internalExpectedDd, so a Remove Processing
   Date performed after 2026-08-13 left an audit row this scan did not match and
   the backfill would have written the date straight back. Over-refusing costs
   nothing; re-writing a date somebody removed costs a production decision. */
const TOUCHED_BY_A_PERSON = [
  /* the RETIRED pair stays matched on purpose: an audit row written while the
     date lived in proceeded_at still marks a human decision */
  "proceeded_at",
  "proceededAt",
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_PAYLOAD_KEY,
  ...SO_PROCESSING_DATE_LEGACY_COLUMNS,
  ...Object.keys(SO_HEADER_LEGACY_PAYLOAD_KEYS),
  "Processing Date",
  "customer_delivery_date",
  "customerDeliveryDate",
].map((name) => `%${name}%`);

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-so-dates.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  log(`AutoCount date rows: ${rows.length}`);

  // ac_code -> erp_code, so a line's AutoCount ItemCode can be matched to the ERP item
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
  const erpOf = (ac) => { let e = byAc.get(norm(ac)); if (e && C1_ALIAS[e.toUpperCase()]) e = C1_ALIAS[e.toUpperCase()]; return e || null; };

  // header processing date + earliest line delivery date, per AutoCount DocNo
  const proc = new Map(), earliest = new Map(), lineDates = new Map();
  for (const r of rows) {
    if (r.PDate && r.PDate.trim() && !proc.has(r.DocNo)) proc.set(r.DocNo, r.PDate.trim());
    const d = (r.DelivDate || "").trim();
    if (d) {
      if (!earliest.has(r.DocNo) || d < earliest.get(r.DocNo)) earliest.set(r.DocNo, d);
      const erp = erpOf(r.ItemCode);
      if (erp) lineDates.set(`${r.DocNo}|${erp.toUpperCase()}`, d);
    }
  }
  log(`orders with processing date: ${proc.size}; orders with a delivery date: ${earliest.size}; line-level delivery dates: ${lineDates.size}`);

  const orders = await sql`SELECT doc_no, linked_ac_docno, processing_date, customer_delivery_date
    FROM scm.mfg_sales_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  log(`imported company-1 orders: ${orders.length}`);

  /* A deliberate human decision outranks this backfill. Any document whose
     audit trail mentions one of these dates has had it set, moved or REMOVED by
     a person - the Super-Admin Remove Processing Date action is exactly the
     state a blind re-run would undo. Matched broadly on both the column names
     and the payload keys: over-refusing costs nothing, re-writing a date
     somebody removed costs a production decision. */
  const docNos = orders.map((o) => o.doc_no);
  const touchedRows = docNos.length
    ? await sql`SELECT DISTINCT so_doc_no FROM scm.mfg_so_audit_log
                 WHERE so_doc_no = ANY(${docNos})
                   AND field_changes::text ILIKE ANY(${TOUCHED_BY_A_PERSON})`
    : [];
  const touched = new Set(touchedRows.map((r) => r.so_doc_no));

  let hdr = 0, hdrDel = 0, humanTouched = 0, alreadySet = 0;
  const hdrUpdates = [];
  for (const o of orders) {
    if (touched.has(o.doc_no)) { humanTouched++; continue; }
    /* Only a blank column is a backfill target. A value already there was put
       there by the import, by a person, or by an earlier run of this script -
       and none of those is ours to overwrite. */
    const p = o.processing_date == null ? (proc.get(o.linked_ac_docno) || null) : null;
    const d = o.customer_delivery_date == null ? (earliest.get(o.linked_ac_docno) || null) : null;
    if (o.processing_date != null || o.customer_delivery_date != null) alreadySet++;
    if (p || d) { hdrUpdates.push({ doc: o.doc_no, p, d }); if (p) hdr++; if (d) hdrDel++; }
  }
  log(`headers REFUSED, the audit trail shows a person changed one of these dates: ${humanTouched}`);
  log(`headers with a date already stored, left exactly as they are: ${alreadySet}`);
  log(`headers to update: ${hdrUpdates.length} (processing ${hdr}, delivery ${hdrDel})`);
  for (const u of hdrUpdates.slice(0, 5)) log(`   ${u.doc}: processing_date=${u.p || "-"} customer_delivery_date=${u.d || "-"}`);

  if (APPLY) {
    /* Counted from RETURNING, not from the loop. Now that the UPDATEs carry an
       IS NULL predicate, "intended" and "written" can differ - and a loop
       counter reporting success for a statement that matched nothing is the
       failure BUG-HISTORY #1938 records. */
    let hdrWrote = 0;
    for (let i = 0; i < hdrUpdates.length; i += 200) {
      const b = hdrUpdates.slice(i, i + 200);
      await sql.begin(async (tx) => {
        /* The IS NULL predicate is repeated IN the statement, not just in the
           plan above: a date written between the read and this write - by the
           order screen, by another script - must win over a backfill. */
        for (const u of b) {
          const r = u.p && u.d
            ? await tx`UPDATE scm.mfg_sales_orders SET processing_date = ${u.p}::date, customer_delivery_date = ${u.d}::date
                 WHERE doc_no = ${u.doc} AND company_id = 1 AND processing_date IS NULL AND customer_delivery_date IS NULL
                RETURNING doc_no`
            : u.p
            ? await tx`UPDATE scm.mfg_sales_orders SET processing_date = ${u.p}::date
                 WHERE doc_no = ${u.doc} AND company_id = 1 AND processing_date IS NULL
                RETURNING doc_no`
            : await tx`UPDATE scm.mfg_sales_orders SET customer_delivery_date = ${u.d}::date
                 WHERE doc_no = ${u.doc} AND company_id = 1 AND customer_delivery_date IS NULL
                RETURNING doc_no`;
          hdrWrote += r.length;
        }
      });
    }
    log(`headers updated: ${hdrWrote} of ${hdrUpdates.length} intended${hdrWrote === hdrUpdates.length ? "" : " — the rest were filled between the read and the write"}`);

    // per-line delivery date — blank lines only, and never on a refused document
    const items = await sql`SELECT i.id, i.item_code, i.line_delivery_date, i.doc_no, h.linked_ac_docno
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL AND i.line_delivery_date IS NULL`;
    const lu = [];
    let lineRefused = 0;
    for (const it of items) {
      if (touched.has(it.doc_no)) { lineRefused++; continue; }
      const d = lineDates.get(`${it.linked_ac_docno}|${(it.item_code || "").toUpperCase()}`);
      if (d) lu.push({ id: it.id, d });
    }
    log(`item lines REFUSED on a human-touched document: ${lineRefused}`);
    log(`item lines to update: ${lu.length}`);
    let lineWrote = 0;
    for (let i = 0; i < lu.length; i += 300) {
      const b = lu.slice(i, i + 300);
      await sql.begin(async (tx) => {
        for (const u of b) {
          const r = await tx`UPDATE scm.mfg_sales_order_items SET line_delivery_date = ${u.d}::date
             WHERE id = ${u.id} AND line_delivery_date IS NULL RETURNING id`;
          lineWrote += r.length;
        }
      });
    }
    log(`item lines updated: ${lineWrote} of ${lu.length} intended`);
  } else {
    log("\nDRY-RUN — set APPLY=1 to write.");
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
