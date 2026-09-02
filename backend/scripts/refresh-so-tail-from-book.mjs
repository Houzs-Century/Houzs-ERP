#!/usr/bin/env node
// QUIET-BOOK TAIL SYNC (owner 2026-08-29: "没人碰autocount了 把所有东西同步过
// 然后再检查status"). The two backfills fill BLANKS only, by design — but the
// book kept moving until tonight (40 delivery dates and a day of Remark2
// re-detections measured), so already-imported orders now hold yesterday's
// values. This tool REFRESHES the header fields to the fresh snapshot where
// they DIFFER, and per-line delivery dates likewise.
//
//   processing_date, customer_delivery_date (earliest line date),
//   sales_exemption_expiry, remark2, remark3, remark4, note   (headers)
//   line_delivery_date                                        (lines)
//
// SAFETY: every doc whose audit trail shows a person touched any of these
// fields is REFUSED (same needle lists as the backfills) — HC is frozen, so
// in practice nothing refuses, but the guard is the rule, not the situation.
// Values are AutoCount's own, verbatim (copy, never compute).
//
// MODE: plan (default) prints every difference; APPLY=1 +
// CONFIRM="REFRESH SO TAIL" writes.
// RE-RUN: convergent — a second run against the same snapshot finds zero
// differences and writes nothing.
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
if (APPLY && process.env.CONFIRM !== "REFRESH SO TAIL") {
  console.error('APPLY=1 needs CONFIRM="REFRESH SO TAIL" — refusing.');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
const day = (v) => (v == null || String(v).trim() === "" ? null : String(v).slice(0, 10));
const txt = (v) => { const s = (v == null ? "" : String(v)).trim(); return s === "" ? null : s; };

const TOUCHED = [
  "proceeded_at", "proceededAt",
  SO_PROCESSING_DATE_COLUMN, SO_PROCESSING_DATE_PAYLOAD_KEY,
  ...SO_PROCESSING_DATE_LEGACY_COLUMNS,
  ...Object.keys(SO_HEADER_LEGACY_PAYLOAD_KEYS),
  "Processing Date", "customer_delivery_date", "customerDeliveryDate",
  "remark2", "remark3", "remark4", "Remark 2", "Remark 3", "Remark 4",
  "sales_exemption_expiry", "salesExemptionExpiry", '"note"', "'note'",
].map((n) => `%${n}%`);

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"}`);
  const dates = gz("ac-so-dates.json.gz");
  const remarks = gz("ac-so-remarks.json.gz");
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
  const erpOf = (ac) => { let e = byAc.get(norm(ac)); if (e && C1_ALIAS[e.toUpperCase()]) e = C1_ALIAS[e.toUpperCase()]; return e || null; };

  const proc = new Map(), earliest = new Map(), lineDates = new Map();
  for (const r of dates) {
    if (r.PDate && String(r.PDate).trim() && !proc.has(r.DocNo)) proc.set(r.DocNo, day(r.PDate));
    const d = day(r.DelivDate);
    if (d) {
      if (!earliest.has(r.DocNo) || d < earliest.get(r.DocNo)) earliest.set(r.DocNo, d);
      const erp = erpOf(r.ItemCode);
      if (erp) lineDates.set(`${r.DocNo}|${erp.toUpperCase()}`, d);
    }
  }
  const rem = new Map();
  for (const r of remarks) rem.set(r.DocNo, {
    remark2: txt(r.Remark2), remark3: txt(r.Remark3), remark4: txt(r.Remark4),
    note: txt(r.UDF_Note), seed: day(r.SalesExemptionExpiryDate),
  });
  log(`snapshot: dates docs ${new Set(dates.map((r) => r.DocNo)).size}, remark docs ${rem.size}`);

  const orders = await sql`SELECT doc_no, linked_ac_docno,
      to_char(processing_date, 'YYYY-MM-DD') AS p,
      to_char(customer_delivery_date, 'YYYY-MM-DD') AS d,
      to_char(sales_exemption_expiry, 'YYYY-MM-DD') AS seed,
      remark2, remark3, remark4, note
    FROM scm.mfg_sales_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const docNos = orders.map((o) => o.doc_no);
  const touchedRows = docNos.length
    ? await sql`SELECT DISTINCT so_doc_no FROM scm.mfg_so_audit_log
                 WHERE so_doc_no = ANY(${docNos}) AND field_changes::text ILIKE ANY(${TOUCHED})`
    : [];
  const touched = new Set(touchedRows.map((r) => r.so_doc_no));

  const per = { processing_date: 0, customer_delivery_date: 0, sales_exemption_expiry: 0, remark2: 0, remark3: 0, remark4: 0, note: 0 };
  let refused = 0;
  const ups = [];
  for (const o of orders) {
    if (touched.has(o.doc_no)) { refused++; continue; }
    const R = rem.get(o.linked_ac_docno) || {};
    const want = {
      processing_date: proc.get(o.linked_ac_docno) ?? null,
      customer_delivery_date: earliest.get(o.linked_ac_docno) ?? null,
      sales_exemption_expiry: R.seed ?? null,
      remark2: R.remark2 ?? null, remark3: R.remark3 ?? null, remark4: R.remark4 ?? null, note: R.note ?? null,
    };
    const cur = { processing_date: o.p, customer_delivery_date: o.d, sales_exemption_expiry: o.seed, remark2: txt(o.remark2), remark3: txt(o.remark3), remark4: txt(o.remark4), note: txt(o.note) };
    const changed = Object.keys(want).filter((k) => (want[k] ?? null) !== (cur[k] ?? null));
    if (!changed.length) continue;
    for (const k of changed) per[k]++;
    ups.push({ doc: o.doc_no, want, changed });
  }
  log(`headers REFUSED (a person touched a synced field): ${refused}`);
  log(`headers with differences: ${ups.length} — ${Object.entries(per).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  for (const u of ups.slice(0, 10)) log(`   ${u.doc}: ${u.changed.map((k) => `${k} -> ${JSON.stringify(u.want[k])}`).join(" | ")}`);

  const items = await sql`SELECT i.id, i.item_code, to_char(i.line_delivery_date, 'YYYY-MM-DD') AS d, i.doc_no, h.linked_ac_docno
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
  const lus = [];
  for (const it of items) {
    if (touched.has(it.doc_no)) continue;
    const want = lineDates.get(`${it.linked_ac_docno}|${(it.item_code || "").toUpperCase()}`) ?? null;
    if (want !== null && want !== it.d) lus.push({ id: it.id, d: want });
  }
  log(`line delivery dates with differences: ${lus.length}`);

  if (!APPLY) { log('PLAN ONLY — APPLY=1 CONFIRM="REFRESH SO TAIL" writes.'); await sql.end(); return; }

  let hw = 0;
  for (let i = 0; i < ups.length; i += 200) {
    const b = ups.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of b) {
        const r = await tx`UPDATE scm.mfg_sales_orders SET
            processing_date = ${u.want.processing_date}::date,
            customer_delivery_date = ${u.want.customer_delivery_date}::date,
            sales_exemption_expiry = ${u.want.sales_exemption_expiry}::date,
            remark2 = ${u.want.remark2}, remark3 = ${u.want.remark3},
            remark4 = ${u.want.remark4}, note = ${u.want.note}
          WHERE doc_no = ${u.doc} AND company_id = 1 RETURNING doc_no`;
        hw += r.length;
      }
    });
  }
  log(`headers refreshed: ${hw} of ${ups.length} intended`);
  let lw = 0;
  for (let i = 0; i < lus.length; i += 300) {
    const b = lus.slice(i, i + 300);
    await sql.begin(async (tx) => {
      for (const u of b) {
        const r = await tx`UPDATE scm.mfg_sales_order_items SET line_delivery_date = ${u.d}::date WHERE id = ${u.id} RETURNING id`;
        lw += r.length;
      }
    });
  }
  log(`line dates refreshed: ${lw} of ${lus.length} intended`);

  /* fresh-connection SHAPE verify */
  const vsql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let bad = 0;
  for (const u of ups.slice(0, 3)) {
    const [row] = await vsql`SELECT remark2, to_char(customer_delivery_date, 'YYYY-MM-DD') AS d FROM scm.mfg_sales_orders WHERE doc_no = ${u.doc} AND company_id = 1`;
    const wantR2 = u.want.remark2 ?? null, gotR2 = txt(row?.remark2) ?? null;
    if (!row || gotR2 !== wantR2 || (row.d ?? null) !== (u.want.customer_delivery_date ?? null)) { bad++; log(`   VERIFY MISMATCH ${u.doc}`); }
  }
  if (bad) { log(`VERIFY FAILED on ${bad} sample(s)`); await vsql.end(); await sql.end(); process.exit(1); }
  log(`VERIFY (fresh connection): ${Math.min(3, ups.length)} sample header(s) re-read equal to the book.`);
  await vsql.end();
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
