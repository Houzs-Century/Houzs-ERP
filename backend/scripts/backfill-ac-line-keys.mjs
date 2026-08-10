#!/usr/bin/env node
// Backfill scm.*_items.linked_ac_dtlkey from the AutoCount export.
//
// The write-back's /edit addresses an AutoCount detail row by its DtlKey — the
// only handle the SDK gives (detail classes expose no settable identity). The
// import already carried every line's DtlKey in the export files; it just was
// not stored. Without this, the first edit of a migrated order APPENDS lines
// instead of changing them.
//
// Matching is (AutoCount DocNo + ERP item code), the same pair every other
// cutover script uses, and lines are zipped IN ORDER when one order has several
// rows of the same code — the import inserted them in DtlKey order, so line_no
// order and DtlKey order agree.
// DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

  // AutoCount side: (docNo|erpCode) -> ordered DtlKeys
  const acKeys = (rows, codeField) => {
    const m = new Map();
    for (const r of rows) {
      const erp = byAc.get(norm(r[codeField]));
      if (!erp) continue;
      const k = `${r.DocNo}|${norm(erp)}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(Number(r.DtlKey));
    }
    for (const v of m.values()) v.sort((a, b) => a - b);
    return m;
  };
  const soAc = acKeys(gz("ac-outstanding-so.json.gz"), "ItemCode");
  const poAc = acKeys(gz("ac-outstanding-po.json.gz"), "ItemCode");

  const run = async (label, rows, acMap, table) => {
    const erpGrp = new Map();
    for (const r of rows) {
      const k = `${r.ac}|${norm(r.code)}`;
      if (!erpGrp.has(k)) erpGrp.set(k, []);
      erpGrp.get(k).push(r);
    }
    const updates = []; let noMatch = 0, countMismatch = 0, already = 0;
    for (const [k, list] of erpGrp) {
      const keys = acMap.get(k);
      if (!keys) { noMatch += list.length; continue; }
      if (keys.length !== list.length) countMismatch += Math.abs(keys.length - list.length);
      list.sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0));
      for (let i = 0; i < list.length && i < keys.length; i++) {
        if (list[i].linked_ac_dtlkey != null) { already++; continue; }
        updates.push({ id: list[i].id, key: keys[i] });
      }
    }
    log(`${label}: erp lines ${rows.length}; to set ${updates.length}; already set ${already}; no AC match ${noMatch}; count mismatch ${countMismatch}`);
    if (!APPLY) return;
    for (let i = 0; i < updates.length; i += 200) {
      const b = updates.slice(i, i + 200);
      await sql.begin(async (tx) => {
        for (const u of b) await tx.unsafe(`UPDATE scm.${table} SET linked_ac_dtlkey = $1 WHERE id = $2`, [u.key, u.id]);
      });
      log(`  ..${Math.min(i + 200, updates.length)}/${updates.length}`);
    }
  };

  const soRows = await sql`SELECT i.id, i.item_code AS code, i.line_no, i.linked_ac_dtlkey, h.linked_ac_docno AS ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
  await run("SO lines", soRows, soAc, "mfg_sales_order_items");

  /* THE PO HALF IS RETIRED — repair-migrated-po-lines.mjs owns purchase-order
     linked_ac_dtlkey now, and two writers with different rules would fight.
     This one was the weaker rule and it never ran, so nothing is lost:
       - it matched on (DocNo, ERP item code), which cannot tell apart two PO
         lines of the same code, where the repair splits them on (qty, Desc2)
         and REFUSES what that does not separate;
       - it zipped by line_no, which it selected as `NULL::int` for PO rows, so
         the sort was a no-op and the pairing was whatever order postgres
         happened to return — not reproducible between runs;
       - it had no notion of a sofa line fanning out into compartment rows.
     The SO half above is untouched and still the only writer for SO lines. */
  log("PO lines: skipped — repair-migrated-po-lines.mjs is the single writer for purchase-order linked_ac_dtlkey.");
  void poAc;

  if (!APPLY) log("DRY-RUN — set APPLY=1 to write.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
