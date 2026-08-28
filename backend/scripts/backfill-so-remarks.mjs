#!/usr/bin/env node
// Backfill the five SO header text/status fields the 2026-08-28 re-import
// omitted, onto the already imported company-1 Sales Orders:
//   Remark2                  -> remark2               (the staff's per-order
//                                                     stock status: READY /
//                                                     MATTRESS/ACC / ...)
//   Remark3                  -> remark3
//   Remark4                  -> remark4
//   UDF_Note                 -> note                  (the listing's "Note"
//                                                     column — plain text on
//                                                     481 docs. SO.Note itself
//                                                     is skipped: its only 2
//                                                     values are RTF-embedded
//                                                     PICTURES, not words)
//   SalesExemptionExpiryDate -> sales_exemption_expiry (the delivery date the
//                                                     staff maintain on the
//                                                     header; 533 of 539 equal
//                                                     the earliest line date)
// Matched by linked_ac_docno. Values are AutoCount's own, verbatim (the RTF
// unwrap removes formatting only, never words) — copy, never compute.
//
// MODE: dry-run by default; APPLY=1 + CONFIRM="BACKFILL SO REMARKS" to write.
// RE-RUN: inert. Every UPDATE re-asserts the target column IS NULL, so a value
// written by this script, by the import, or by a person is never overwritten;
// a second run finds nothing blank and writes nothing. Documents whose audit
// trail mentions any of these fields are refused outright — a person's edit
// (including clearing a remark) outranks a backfill.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
if (APPLY && process.env.CONFIRM !== "BACKFILL SO REMARKS") {
  console.error('APPLY=1 needs CONFIRM="BACKFILL SO REMARKS" — refusing.');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/* Deliberate human edits outrank a backfill — same guard, same reasoning as
   backfill-so-dates.mjs. Matched on column names and payload keys. */
const TOUCHED_BY_A_PERSON = [
  "remark2", "remark3", "remark4",
  "Remark 2", "Remark 3", "Remark 4",
  "sales_exemption_expiry", "salesExemptionExpiry",
  '"note"', "'note'", // bare %note% would match every audit row containing the word
].map((n) => `%${n}%`);

const clean = (v) => {
  const s = (v == null ? "" : String(v)).trim();
  return s === "" ? null : s;
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-so-remarks.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  const byDoc = new Map();
  for (const r of rows) {
    byDoc.set(r.DocNo, {
      remark2: clean(r.Remark2),
      remark3: clean(r.Remark3),
      remark4: clean(r.Remark4),
      note: clean(r.UDF_Note),
      seed: r.SalesExemptionExpiryDate ? String(r.SalesExemptionExpiryDate).slice(0, 10) : null,
    });
  }
  log(`AutoCount remark rows: ${rows.length}`);

  const orders = await sql`SELECT doc_no, linked_ac_docno, remark2, remark3, remark4, note, sales_exemption_expiry
    FROM scm.mfg_sales_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  log(`imported company-1 orders: ${orders.length}`);

  const docNos = orders.map((o) => o.doc_no);
  const touchedRows = docNos.length
    ? await sql`SELECT DISTINCT so_doc_no FROM scm.mfg_so_audit_log
                 WHERE so_doc_no = ANY(${docNos})
                   AND field_changes::text ILIKE ANY(${TOUCHED_BY_A_PERSON})`
    : [];
  const touched = new Set(touchedRows.map((r) => r.so_doc_no));

  const COLS = ["remark2", "remark3", "remark4", "note", "seed"];
  const per = { remark2: 0, remark3: 0, remark4: 0, note: 0, seed: 0 };
  let humanTouched = 0;
  const updates = [];
  for (const o of orders) {
    if (touched.has(o.doc_no)) { humanTouched++; continue; }
    const src = byDoc.get(o.linked_ac_docno);
    if (!src) continue;
    const u = { doc: o.doc_no };
    /* only a blank column is a target — a value already there was put there by
       the import, a person, or an earlier run, and none of those is ours */
    if (o.remark2 == null && src.remark2) { u.remark2 = src.remark2; per.remark2++; }
    if (o.remark3 == null && src.remark3) { u.remark3 = src.remark3; per.remark3++; }
    if (o.remark4 == null && src.remark4) { u.remark4 = src.remark4; per.remark4++; }
    if (o.note == null && src.note) { u.note = src.note; per.note++; }
    if (o.sales_exemption_expiry == null && src.seed) { u.seed = src.seed; per.seed++; }
    if (Object.keys(u).length > 1) updates.push(u);
  }
  log(`headers REFUSED, a person edited one of these fields: ${humanTouched}`);
  log(`headers to update: ${updates.length} (remark2 ${per.remark2}, remark3 ${per.remark3}, remark4 ${per.remark4}, note ${per.note}, delivery-date field ${per.seed})`);
  for (const u of updates.slice(0, 5)) log(`   ${u.doc}: ${COLS.filter((c) => u[c]).map((c) => `${c}=${String(u[c]).slice(0, 30)}`).join(" | ")}`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 CONFIRM=\"BACKFILL SO REMARKS\" to write."); await sql.end(); return; }

  /* counted from RETURNING, not the loop — per-column IS NULL is re-asserted in
     the statement so anything filled between the read and the write wins */
  let wrote = 0;
  for (let i = 0; i < updates.length; i += 200) {
    const b = updates.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of b) {
        const r = await tx.unsafe(
          `UPDATE scm.mfg_sales_orders SET
             remark2 = CASE WHEN remark2 IS NULL THEN COALESCE($2, remark2) ELSE remark2 END,
             remark3 = CASE WHEN remark3 IS NULL THEN COALESCE($3, remark3) ELSE remark3 END,
             remark4 = CASE WHEN remark4 IS NULL THEN COALESCE($4, remark4) ELSE remark4 END,
             note    = CASE WHEN note    IS NULL THEN COALESCE($5, note)    ELSE note    END,
             sales_exemption_expiry = CASE WHEN sales_exemption_expiry IS NULL THEN COALESCE($6::date, sales_exemption_expiry) ELSE sales_exemption_expiry END
           WHERE doc_no = $1 AND company_id = 1 RETURNING doc_no`,
          [u.doc, u.remark2 ?? null, u.remark3 ?? null, u.remark4 ?? null, u.note ?? null, u.seed ?? null],
        );
        wrote += r.length;
      }
    });
  }
  log(`headers updated: ${wrote} of ${updates.length} intended`);

  /* independent verify — a FRESH connection, and the SHAPE, not a row count:
     re-read a sample and assert the stored string equals the book's string */
  const vsql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const counts = (await vsql`SELECT
      COUNT(*) FILTER (WHERE remark2 IS NOT NULL) r2,
      COUNT(*) FILTER (WHERE sales_exemption_expiry IS NOT NULL) seed
    FROM scm.mfg_sales_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`)[0];
  log(`VERIFY (fresh connection): remark2 now on ${counts.r2} orders, delivery-date field on ${counts.seed}`);
  const sample = updates.filter((u) => u.remark2).slice(0, 3);
  let bad = 0;
  for (const s of sample) {
    const [row] = await vsql`SELECT remark2 FROM scm.mfg_sales_orders WHERE doc_no = ${s.doc} AND company_id = 1`;
    if (!row || row.remark2 !== s.remark2) { bad++; log(`   SHAPE MISMATCH ${s.doc}: stored ${row ? JSON.stringify(row.remark2) : "(missing)"} vs book ${JSON.stringify(s.remark2)}`); }
  }
  if (bad) { log(`VERIFY FAILED on ${bad} sample(s)`); await vsql.end(); await sql.end(); process.exit(1); }
  log(`VERIFY: ${sample.length} sample value(s) re-read equal to the book's, byte for byte.`);
  await vsql.end();
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
