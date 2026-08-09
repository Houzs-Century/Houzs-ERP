#!/usr/bin/env node
// Backfill the two AutoCount dates the first export omitted, onto the already
// imported company-1 Sales Orders:
//   UDF_PDate (header)   -> proceeded_at      (processing date — this is what
//                                              gates MRP; owner: "SO 有 processing
//                                              date, MRP 就能跑")
//   SODTL.DeliveryDate   -> item.line_delivery_date  and, on the header, the
//                           earliest line date -> customer_delivery_date
// They are matched by the AutoCount DocNo we stored in linked_ac_docno + the
// line's ItemCode -> ERP item_code. NOT swapped: processing is the header UDF,
// delivery is the per-line column.
// DRY-RUN by default; APPLY=1 to write.
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

  const orders = await sql`SELECT doc_no, linked_ac_docno FROM scm.mfg_sales_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  log(`imported company-1 orders: ${orders.length}`);
  let hdr = 0, hdrDel = 0;
  const hdrUpdates = [];
  for (const o of orders) {
    const p = proc.get(o.linked_ac_docno) || null;
    const d = earliest.get(o.linked_ac_docno) || null;
    if (p || d) { hdrUpdates.push({ doc: o.doc_no, p, d }); if (p) hdr++; if (d) hdrDel++; }
  }
  log(`headers to update: ${hdrUpdates.length} (processing ${hdr}, delivery ${hdrDel})`);
  for (const u of hdrUpdates.slice(0, 5)) log(`   ${u.doc}: proceeded_at=${u.p || "-"} customer_delivery_date=${u.d || "-"}`);

  if (APPLY) {
    for (let i = 0; i < hdrUpdates.length; i += 200) {
      const b = hdrUpdates.slice(i, i + 200);
      await sql.begin(async (tx) => {
        for (const u of b) {
          if (u.p && u.d) await tx`UPDATE scm.mfg_sales_orders SET proceeded_at = ${u.p}::date, customer_delivery_date = ${u.d}::date WHERE doc_no = ${u.doc} AND company_id = 1`;
          else if (u.p) await tx`UPDATE scm.mfg_sales_orders SET proceeded_at = ${u.p}::date WHERE doc_no = ${u.doc} AND company_id = 1`;
          else await tx`UPDATE scm.mfg_sales_orders SET customer_delivery_date = ${u.d}::date WHERE doc_no = ${u.doc} AND company_id = 1`;
        }
      });
    }
    log(`headers updated: ${hdrUpdates.length}`);

    // per-line delivery date
    const items = await sql`SELECT i.id, i.item_code, h.linked_ac_docno FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
    const lu = [];
    for (const it of items) { const d = lineDates.get(`${it.linked_ac_docno}|${(it.item_code || "").toUpperCase()}`); if (d) lu.push({ id: it.id, d }); }
    log(`item lines to update: ${lu.length}`);
    for (let i = 0; i < lu.length; i += 300) {
      const b = lu.slice(i, i + 300);
      await sql.begin(async (tx) => { for (const u of b) await tx`UPDATE scm.mfg_sales_order_items SET line_delivery_date = ${u.d}::date WHERE id = ${u.id}`; });
    }
    log(`item lines updated: ${lu.length}`);
  } else {
    log("\nDRY-RUN — set APPLY=1 to write.");
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
