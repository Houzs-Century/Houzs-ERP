#!/usr/bin/env node
// Value-by-value truth check: do the imported/backfilled SO header+line fields
// EQUAL the book's own values? (owner 2026-08-28: "这些对比两套系统的数据是对
// 的吗？" — filled is not the same claim as correct.)
//
// Compares, per field, ERP vs the committed round snapshots (the exact source
// the import/backfills copied FROM — so a mismatch is a copy defect, never
// book drift):
//   processing_date          vs ac-so-dates.json.gz   PDate     (per header)
//   customer_delivery_date   vs earliest line DelivDate          (per header)
//   line_delivery_date       vs DelivDate                        (per line)
//   remark2/3/4, note, sales_exemption_expiry vs ac-so-remarks.json.gz
//
// Buckets per field: MATCH / ERP-blank (book has) / ERP-has (book blank) /
// DIFFER — with samples for every DIFFER. Read-only: one connection, SELECTs
// only. Exit 0 for every legitimate verdict; non-zero only for missing inputs
// or an unreachable DB (a verdict computed over nothing must never read as a
// pass).
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => {
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
  if (!rows.length) { console.error(`${f} is EMPTY — refusing to report over nothing`); process.exit(2); }
  return rows;
};

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

const day = (v) => (v == null || v === "" ? null : String(v).slice(0, 10));
const txt = (v) => { const s = (v == null ? "" : String(v)).trim(); return s === "" ? null : s; };

async function main() {
  const dates = gz("ac-so-dates.json.gz");
  const remarks = gz("ac-so-remarks.json.gz");

  // same mapping + alias the backfill used, so this verifies what it copied
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
  const erpOf = (ac) => { let e = byAc.get(norm(ac)); if (e && C1_ALIAS[e.toUpperCase()]) e = C1_ALIAS[e.toUpperCase()]; return e || null; };

  const proc = new Map(), earliest = new Map(), lineDates = new Map();
  for (const r of dates) {
    if (r.PDate && r.PDate.trim() && !proc.has(r.DocNo)) proc.set(r.DocNo, day(r.PDate.trim()));
    const d = (r.DelivDate || "").trim();
    if (d) {
      if (!earliest.has(r.DocNo) || d < earliest.get(r.DocNo)) earliest.set(r.DocNo, d);
      const erp = erpOf(r.ItemCode);
      if (erp) lineDates.set(`${r.DocNo}|${erp.toUpperCase()}`, day(d));
    }
  }
  for (const k of earliest.keys()) earliest.set(k, day(earliest.get(k)));
  const remByDoc = new Map();
  for (const r of remarks) {
    remByDoc.set(r.DocNo, {
      remark2: txt(r.Remark2), remark3: txt(r.Remark3), remark4: txt(r.Remark4),
      note: txt(r.UDF_Note), seed: day(r.SalesExemptionExpiryDate),
    });
  }

  const orders = await sql`SELECT doc_no, linked_ac_docno,
      to_char(processing_date, 'YYYY-MM-DD') AS p,
      to_char(customer_delivery_date, 'YYYY-MM-DD') AS d,
      to_char(sales_exemption_expiry, 'YYYY-MM-DD') AS seed,
      remark2, remark3, remark4, note
    FROM scm.mfg_sales_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  log(`imported company-1 orders: ${orders.length}; book docs in snapshot: dates ${new Set(dates.map((r) => r.DocNo)).size}, remarks ${remByDoc.size}`);

  const FIELDS = [
    ["processing_date", (o) => o.p, (o) => proc.get(o.linked_ac_docno) ?? null],
    ["customer_delivery_date", (o) => o.d, (o) => earliest.get(o.linked_ac_docno) ?? null],
    ["sales_exemption_expiry", (o) => o.seed, (o) => (remByDoc.get(o.linked_ac_docno) || {}).seed ?? null],
    ["remark2", (o) => txt(o.remark2), (o) => (remByDoc.get(o.linked_ac_docno) || {}).remark2 ?? null],
    ["remark3", (o) => txt(o.remark3), (o) => (remByDoc.get(o.linked_ac_docno) || {}).remark3 ?? null],
    ["remark4", (o) => txt(o.remark4), (o) => (remByDoc.get(o.linked_ac_docno) || {}).remark4 ?? null],
    ["note", (o) => txt(o.note), (o) => (remByDoc.get(o.linked_ac_docno) || {}).note ?? null],
  ];
  for (const [name, erpV, bookV] of FIELDS) {
    let match = 0, erpBlank = 0, erpOnly = 0;
    const differ = [];
    for (const o of orders) {
      const e = erpV(o), b = bookV(o);
      if (e == null && b == null) continue;
      else if (e != null && b == null) erpOnly++;
      else if (e == null && b != null) erpBlank++;
      else if (e === b) match++;
      else differ.push({ doc: o.doc_no, e, b });
    }
    log(`${name}: MATCH ${match} | ERP blank, book has ${erpBlank} | ERP has, book blank ${erpOnly} | DIFFER ${differ.length}`);
    for (const s of differ.slice(0, 8)) log(`   DIFFER ${s.doc}: ERP=${JSON.stringify(s.e).slice(0, 40)} book=${JSON.stringify(s.b).slice(0, 40)}`);
  }

  const items = await sql`SELECT i.doc_no, i.item_code, to_char(i.line_delivery_date, 'YYYY-MM-DD') AS d, h.linked_ac_docno
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
  let lm = 0, lblank = 0, lonly = 0;
  const ldiff = [];
  for (const it of items) {
    const b = lineDates.get(`${it.linked_ac_docno}|${(it.item_code || "").toUpperCase()}`) ?? null;
    const e = it.d;
    if (e == null && b == null) continue;
    else if (e != null && b == null) lonly++;
    else if (e == null && b != null) lblank++;
    else if (e === b) lm++;
    else ldiff.push({ doc: it.doc_no, code: it.item_code, e, b });
  }
  log(`line_delivery_date (${items.length} lines): MATCH ${lm} | ERP blank, book has ${lblank} | ERP has, book blank ${lonly} | DIFFER ${ldiff.length}`);
  for (const s of ldiff.slice(0, 8)) log(`   DIFFER ${s.doc} ${s.code}: ERP=${s.e} book=${s.b}`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
