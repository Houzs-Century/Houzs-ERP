#!/usr/bin/env node
// Undo the SO->PO dedications that bind a sales-order line to a purchase-order
// line for a DIFFERENT product, after dumping every one of them to a restorable
// JSON file.
//
// WHAT WENT WRONG. `sync-ac-delta.mjs` lane `links` resolved
// both ends of AutoCount's `PODTL.FromSODtlKey` edge by `linked_ac_dtlkey` and
// wrote `purchase_order_items.so_item_id` on the strength of that key pair
// alone, never comparing the two ERP rows' `item_code`. Run 34123720786
// (2026-09-07 20:46 MYT, mode=apply) wrote 10; nine of them name different
// beds on the two ends — REGAL (A)-(K) dedicated to a TRION (A) (HB STR)-(K),
// CODY-(Q) to a JAGER-(Q), JAGER-(Q) to a JAGER-(SS).
//
// WHY A WRONG ONE IS WORSE THAN NONE. A bedframe or sofa line is HARD-BOUND
// (`isHardBoundLine`, src/scm/lib/so-stock-allocation.ts): it reads READY only
// through its OWN dedicated purchase order's received_qty, never through the
// pooled balance. So the customer's REGAL lights up as ready to ship when a
// TRION arrives, and the real REGAL can never light. Nulling the link restores
// the state that held before that run: the line waits on the pool again.
//
// THE POPULATION IS MEASURED, NOT LISTED. It is every company-scoped
// purchase-order line whose `so_item_id` points at a sales-order line with a
// different `item_code`. The sofa document-chain audit measured that count as
// 0 at 19:54 MYT and 9 at 22:02 MYT the same evening, so the structural rule
// and the incident describe the same nine rows — and if a tenth appears later,
// this script finds it without being edited. A hard-coded id list would not.
//
// WHAT IT DOES NOT DECIDE. Which SIDE is right — did the customer change the
// bed in AutoCount after we copied the order, or did the import mis-map the
// code? — is the owner's call, so the plan PRINTS the evidence per pair (our
// two codes, the book's two codes, and which of ours disagrees with the book)
// and writes no correction. Re-dedicating to the RIGHT line is a separate,
// deliberate act once he has ruled.
//
// THE DUMP IS THE PRECONDITION, NOT A COURTESY (copied from
// dump-and-delete-po.mjs): MODE=apply refuses unless the dump was written AND
// re-read off disk on this run. The `restore` block carries one UPDATE per row
// that puts the exact so_item_id back.
//
// MODE=plan (default, writes nothing) | MODE=apply
//   apply also needs CONFIRM="REVERT <n> DEDICATIONS" with <n> the count the
//   plan found on THIS run — a confirmation copied from an older run refuses.
// COMPANY_ID=1  OUT=/tmp/dedication-dump.json
//
// RE-RUN: convergent and safe. A second apply finds nothing left to revert
// (the rule selects rows that still carry a mismatched so_item_id), says so,
// and exits 0 without writing. Re-running plan is free and re-prints the table.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/* THE SAME NORMALISATION THE GUARD USES, and deliberately a copy for now.
   The guard that stops NEW bad dedications is in flight as `normItemCode` in
   scripts/lib/ac-po-line.mjs (PR #3076, green but not yet on main). Importing
   an export that does not exist on `main` would make this repair unrunnable
   tonight, and the nine wrong rows are live tonight — so the rule is restated
   here, once, and this PR's ledger entry records that folding the two into one
   lib export is the follow-up the moment #3076 lands. The SQL re-assertion in
   the UPDATE below mirrors this exactly: BTRIM, collapse internal whitespace,
   upper-case. If you change one, change all three. */
const normItemCode = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");

const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = process.env.CONFIRM ?? "";
const CO = Number(process.env.COMPANY_ID || 1);
const OUT = process.env.OUT || path.join(process.cwd(), "so-po-dedication-dump.json");

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const rpad = (s, n) => String(s ?? "").padEnd(n);

/* ── the BOOK, from files committed in this repo ───────────────────────────
   No AutoCount SQL connection is opened here and none may be: a heavy read on
   that server starves the ERP -> AutoCount write-back. ac-reconcile-truth is
   the 2026-09-07 17:35 MYT snapshot of every header and line of all six
   document types; ac-po-fromsodtlkey is PODTL's own SO edge; the 1,561-row
   mapping sheet turns an AutoCount item code into ours. */
function readBook() {
  const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))));
  const T = gz("ac-reconcile-truth.json.gz");
  const LF = T.line_fields;
  const obj = (row) => Object.fromEntries(LF.map((k, i) => [k, row[i]]));
  const byDtl = (rows) => new Map(rows.map((r) => { const o = obj(r); return [String(o.dtlKey), o]; }));
  const csv = fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").trim().split(/\r?\n/);
  const map = new Map();
  for (const line of csv.slice(1)) {
    const m = /^("(?:[^"]|"")*"|[^,]*),("(?:[^"]|"")*"|[^,]*),/.exec(line);
    if (!m) continue;
    const un = (s) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);
    map.set(normItemCode(un(m[1])), un(m[2]).trim());
  }
  const edgeFile = gz("ac-po-fromsodtlkey.json.gz");
  return {
    exportedAt: T.exported_at,
    edgesExportedAt: edgeFile.exportedAt,
    soByDtl: byDtl(T.types.SO.lines),
    poByDtl: byDtl(T.types.PO.lines),
    /* null, never a guess: an unmapped AutoCount code is a fact about the
       mapping sheet and has to read as one. */
    toErp: (ac) => map.get(normItemCode(ac)) ?? null,
  };
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${MODE} company=${CO} out=${OUT}`);

  /* THE RULE: a dedication whose two ERP rows name different items. Every
     dedicated line in the company is read and the comparison is done in JS
     with `normItemCode` above, so the population is a MEASUREMENT and the
     count appears in the log even when it is not the nine we expect. */
  const rows = await sql`
    SELECT i.id            AS po_item_id,
           i.item_code     AS po_item_code,
           i.so_item_id    AS so_item_id,
           i.linked_ac_dtlkey AS po_dtlkey,
           COALESCE(i.received_qty, 0)::float8 AS received_qty,
           i.qty::float8   AS po_qty,
           p.po_number     AS po_number,
           p.linked_ac_docno AS po_ac_docno,
           s.item_code     AS so_item_code,
           s.doc_no        AS so_doc_no,
           s.linked_ac_dtlkey AS so_dtlkey,
           s.stock_status  AS so_stock_status,
           h.linked_ac_docno AS so_ac_docno
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p       ON p.id = i.purchase_order_id
      JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
      JOIN scm.mfg_sales_orders h      ON h.doc_no = s.doc_no
     WHERE p.company_id = ${CO} AND i.so_item_id IS NOT NULL
     ORDER BY s.doc_no, p.po_number`;
  log(`company ${CO}: ${rows.length} purchase-order line(s) carry a dedication`);

  const bad = rows.filter((r) => normItemCode(r.so_item_code) !== normItemCode(r.po_item_code));
  const ok = rows.length - bad.length;
  log(`  the two ERP rows name the SAME item                ${ok}`);
  log(`  the two ERP rows name DIFFERENT items  <- revert   ${bad.length}`);

  /* ── the owner's table: which SIDE disagrees with the book ─────────────── */
  const book = readBook();
  log(`book snapshot ${book.exportedAt}; PODTL SO-edge export ${book.edgesExportedAt}`);
  const verdicts = [];
  for (const r of bad) {
    const bSo = book.soByDtl.get(String(r.so_dtlkey ?? ""))?.itemKey ?? null;
    const bPo = book.poByDtl.get(String(r.po_dtlkey ?? ""))?.itemKey ?? null;
    const eSo = bSo === null ? null : book.toErp(bSo);
    const ePo = bPo === null ? null : book.toErp(bPo);
    const soAgrees = eSo !== null && normItemCode(eSo) === normItemCode(r.so_item_code);
    const poAgrees = ePo !== null && normItemCode(ePo) === normItemCode(r.po_item_code);
    verdicts.push({
      soDoc: r.so_doc_no, poNo: r.po_number, soDtl: String(r.so_dtlkey ?? ""), poDtl: String(r.po_dtlkey ?? ""),
      ourSo: r.so_item_code, ourPo: r.po_item_code, bookSo: bSo, bookPo: bPo, bookSoErp: eSo, bookPoErp: ePo,
      bookAgreesWithItself: bSo !== null && bPo !== null && String(bSo).trim() === String(bPo).trim(),
      soAgrees, poAgrees,
      whoDisagrees: bSo === null || bPo === null ? "UNKNOWN (line not in the book snapshot)"
        : soAgrees && !poAgrees ? "our PURCHASE ORDER line"
          : poAgrees && !soAgrees ? "our SALES ORDER line"
            : soAgrees && poAgrees ? "neither — both match the book (the book itself pairs two different items)"
              : "BOTH of our lines",
      receivedQty: r.received_qty, soStockStatus: r.so_stock_status,
    });
  }
  if (verdicts.length) {
    plain("");
    plain("WHICH SIDE DISAGREES WITH AUTOCOUNT — for the owner to rule on. No correction is written from this.");
    plain("```enumeration");
    plain(`${rpad("sales order", 14)}${rpad("our SO line", 26)}${rpad("our PO line", 26)}${rpad("book SO -> ERP", 26)}${rpad("book PO -> ERP", 26)}disagrees with the book`);
    for (const v of verdicts) {
      plain(`${rpad(v.soDoc, 14)}${rpad(v.ourSo, 26)}${rpad(v.ourPo, 26)}${rpad(v.bookSoErp ?? "(unmapped)", 26)}${rpad(v.bookPoErp ?? "(unmapped)", 26)}${v.whoDisagrees}`);
      plain(`${rpad("", 14)}  ${v.poNo}  SODtlKey ${v.soDtl} -> PODtlKey ${v.poDtl}; the book's own two codes are ${v.bookAgreesWithItself ? "IDENTICAL" : "DIFFERENT"} (${v.bookSo} / ${v.bookPo}); PO received ${v.receivedQty}, SO line stock_status ${v.soStockStatus}`);
    }
    plain("```");
    plain("");
  }

  if (bad.length === 0) {
    log("nothing to revert — every dedication in this company names the same item on both ends.");
    await sql.end();
    return;
  }

  /* ── the restorable dump ─────────────────────────────────────────────── */
  const dump = {
    dumpedAt: new Date().toISOString(),
    reason: "restorable dump taken immediately before nulling purchase_order_items.so_item_id",
    database: "production (secrets.DATABASE_URL)",
    companyId: CO,
    incident: "sync-ac-delta run 34123720786 wrote dedications without comparing item_code (guard: PR #3076)",
    rows: bad.map((r) => ({ ...r })),
    verdicts,
    restore: bad.map((r) =>
      `UPDATE scm.purchase_order_items SET so_item_id = '${String(r.so_item_id).replace(/'/g, "''")}' WHERE id = '${String(r.po_item_id).replace(/'/g, "''")}';`),
  };
  const json = JSON.stringify(dump, null, 2);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json, "utf8");

  /* READ IT BACK. Writing is intent; parsing what came off the disk is
     evidence, and evidence is the precondition for the write below. */
  const readBack = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const dumpOk = Array.isArray(readBack.rows)
    && readBack.rows.length === bad.length
    && readBack.rows.every((r) => r.po_item_id && r.so_item_id)
    && readBack.restore.length === bad.length;
  log(`dump written to ${OUT} (${json.length} bytes) and re-read: ${dumpOk ? "OK" : "FAILED"}`);
  plain("----- BEGIN RESTORABLE DUMP -----");
  plain(json);
  plain("----- END RESTORABLE DUMP -----");

  const PHRASE = `REVERT ${bad.length} DEDICATIONS`;
  if (!APPLY) {
    log(`PLAN ONLY — nothing written. To revert: MODE=apply CONFIRM="${PHRASE}"`);
    await sql.end();
    return;
  }
  if (!dumpOk) { log("REFUSED: the dump did not read back. Nothing reverted."); await sql.end(); process.exit(1); }
  if (CONFIRM !== PHRASE) {
    log(`REFUSED: MODE=apply needs CONFIRM="${PHRASE}" — the count is the one THIS run measured, so a phrase copied from an earlier run cannot fire.`);
    await sql.end();
    process.exit(2);
  }

  /* The mismatch is RE-ASSERTED inside the statement. Between the plan and
     here, a person could have corrected either row in the ERP; if the two
     codes now agree, the dedication is no longer the defect and must not be
     removed. A row that fails the re-assertion is simply not updated and shows
     up in the count. */
  let reverted = 0;
  await sql.begin(async (tx) => {
    for (const r of bad) {
      const res = await tx`
        UPDATE scm.purchase_order_items i
           SET so_item_id = NULL
          FROM scm.mfg_sales_order_items s
         WHERE i.id = ${r.po_item_id}
           AND i.so_item_id = ${r.so_item_id}
           AND s.id = i.so_item_id
           AND UPPER(REGEXP_REPLACE(BTRIM(s.item_code), '\\s+', ' ', 'g'))
             <> UPPER(REGEXP_REPLACE(BTRIM(i.item_code), '\\s+', ' ', 'g'))
        RETURNING i.id`;
      reverted += res.length;
    }
  });
  log(`dedications reverted: ${reverted} of ${bad.length} intended`);

  /* ── verification on a connection this run has not used ────────────────
     The SHAPE, not a count: for every row we touched, what is so_item_id NOW,
     and does the line still name the item it named before? */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const ids = bad.map((r) => String(r.po_item_id));
  const after = await v`
    SELECT i.id, i.so_item_id, i.item_code, COALESCE(i.received_qty, 0)::float8 AS received_qty
      FROM scm.purchase_order_items i WHERE i.id = ANY(${ids})`;
  const byId = new Map(after.map((a) => [String(a.id), a]));
  let stillLinked = 0, missing = 0, codeChanged = 0;
  for (const r of bad) {
    const a = byId.get(String(r.po_item_id));
    if (!a) { missing++; log(`   VERIFY: purchase-order line ${r.po_item_id} is GONE`); continue; }
    if (a.so_item_id !== null) { stillLinked++; log(`   VERIFY: ${r.po_number} line still dedicated to ${a.so_item_id}`); }
    if (normItemCode(a.item_code) !== normItemCode(r.po_item_code)) { codeChanged++; log(`   VERIFY: ${r.po_number} line item_code moved ${r.po_item_code} -> ${a.item_code}`); }
  }
  log(`VERIFY on a fresh connection: ${after.length} of ${ids.length} line(s) re-read; so_item_id now NULL on ${after.length - stillLinked}; still linked ${stillLinked}; missing ${missing}; item_code changed ${codeChanged}`);
  await v.end();
  await sql.end();
  if (stillLinked > 0 || missing > 0) process.exit(1);
  log(`DONE. ${reverted} wrong dedication(s) removed; the restorable dump is at ${OUT} and printed above.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
