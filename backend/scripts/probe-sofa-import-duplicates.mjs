#!/usr/bin/env node
// Read-only post-import audit for the sofa SO round (owner 2026-08-10: "之前
// 好像有混入过的 order 已经进过了，查看一下有没有 duplicate").
//
// The earlier non-sofa round excluded lines by /SOFA/i on ItemCode, so sofa
// lines whose code lacks the word (THL-7223, TNS-…) leaked in as ordinary,
// UNDECOMPOSED lines. Their orders already exist, so the sofa round's header
// ON CONFLICT DO NOTHING skips them entirely — no duplicate, but also no
// compartment split. This probe reports both failure modes with evidence:
//
//   1 DUPLICATE HEADER  — one AutoCount doc behind two ERP orders
//   2 DUPLICATE LINE    — the same item_code repeated on an order more times
//                         than AutoCount has lines for it
//   3 UNDECOMPOSED LEAK — the AutoCount source has a sofa line but the ERP
//                         order carries no {model}-{compartment} line
//   4 LINE-COUNT DRIFT  — ERP line count vs AutoCount line count per order
//
// Read-only: no writes, safe to run any time.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const here = path.dirname(fileURLToPath(import.meta.url));
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const isSofaCode = (c) => /SOFA/i.test(c || "");

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-so.json.gz"))).toString("utf8"));
const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
csv.shift();
const byAc = new Map();
for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

// AutoCount side: lines per doc, and which docs carry a sofa line
const acLines = new Map(), acSofa = new Map();
for (const l of raw) {
  if (!acLines.has(l.DocNo)) acLines.set(l.DocNo, []);
  acLines.get(l.DocNo).push(l);
  const erp = byAc.get(norm(l.ItemCode)) || "";
  if (isSofaCode(l.ItemCode) || /^\d{3,5}-1S$/i.test(erp)) {
    if (!acSofa.has(l.DocNo)) acSofa.set(l.DocNo, []);
    acSofa.get(l.DocNo).push(l.ItemCode);
  }
}

const heads = await sql`SELECT doc_no, linked_ac_docno, total_revenue_sen FROM scm.mfg_sales_orders
                        WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
const items = await sql`SELECT i.doc_no, i.item_code, i.qty, i.remark, i.description2, h.linked_ac_docno
                        FROM scm.mfg_sales_order_items i
                        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                        WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
note(`ERP orders linked to AutoCount: ${heads.length}; lines: ${items.length}`);

// 1 duplicate headers
const byAcDoc = new Map();
for (const h of heads) { if (!byAcDoc.has(h.linked_ac_docno)) byAcDoc.set(h.linked_ac_docno, []); byAcDoc.get(h.linked_ac_docno).push(h.doc_no); }
const dupHead = [...byAcDoc.entries()].filter(([, v]) => v.length > 1);
note(`1 DUPLICATE HEADER: ${dupHead.length}`);
for (const [ac, docs] of dupHead.slice(0, 20)) note(`   ${ac} -> ${docs.join(", ")}`);

// 2 duplicate lines vs the AutoCount line count for that code
const perOrder = new Map();
for (const it of items) {
  const k = it.linked_ac_docno;
  if (!perOrder.has(k)) perOrder.set(k, []);
  perOrder.get(k).push(it);
}
let dupLine = 0;
for (const [ac, list] of perOrder) {
  const acl = acLines.get(ac) || [];
  const acCount = new Map();
  for (const l of acl) { const erp = norm(byAc.get(norm(l.ItemCode)) || ""); if (erp) acCount.set(erp, (acCount.get(erp) || 0) + 1); }
  const erpCount = new Map();
  for (const it of list) erpCount.set(norm(it.item_code), (erpCount.get(norm(it.item_code)) || 0) + 1);
  for (const [code, n] of erpCount) {
    const expected = acCount.get(code) ?? 0;
    // a decomposed sofa build legitimately multiplies lines; only flag codes
    // AutoCount actually mapped 1:1 and that now appear more often
    if (expected > 0 && n > expected) {
      dupLine++;
      if (dupLine <= 20) note(`   ${ac} ${code}: ERP ${n} vs AutoCount ${expected}`);
    }
  }
}
note(`2 DUPLICATE LINE (code repeated beyond the AutoCount count): ${dupLine}`);

// 3 undecomposed sofa leaks
const COMP_RE = /-(1S|2S|3S|1NA|2NA|CNR|Console|STOOL|L\(|1A|2A|1B|2B|1ABOX)/i;
let leaks = 0;
for (const [ac, codes] of acSofa) {
  const list = perOrder.get(ac);
  if (!list) continue; // order not imported at all — not a leak
  if (!list.some((it) => COMP_RE.test(it.item_code))) {
    leaks++;
    if (leaks <= 25) note(`   ${ac}  AC sofa: ${[...new Set(codes)].join(", ")}  ERP lines: ${list.map((i) => i.item_code).join(" | ").slice(0, 90)}`);
  }
}
note(`3 UNDECOMPOSED LEAK (sofa order imported without compartment lines): ${leaks}`);

// 4 line-count drift, worst 15
const drift = [];
for (const [ac, list] of perOrder) {
  const acn = (acLines.get(ac) || []).length;
  if (acn && list.length !== acn) drift.push({ ac, erp: list.length, ac_n: acn, d: list.length - acn });
}
drift.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
note(`4 LINE-COUNT DRIFT (expected for decomposed sofa builds): ${drift.length} orders`);
for (const d of drift.slice(0, 15)) note(`   ${d.ac}: ERP ${d.erp} vs AC ${d.ac_n} (${d.d > 0 ? "+" : ""}${d.d})`);


// 5 DELIVERED-BUT-IMPORTED — owner's rule (2026-08-10): outstanding means NOT
// yet turned into a DO; converting to a PO keeps it outstanding. An order whose
// every line has TransferedQty >= Qty is fully delivered and must not sit in
// the ERP as an outstanding SO. (TransferedPOQty is deliberately ignored.)
{
  const n = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  const full = [];
  for (const [doc, ls] of acLines) if (ls.length && !ls.some((x) => n(x.Qty) > n(x.TransferedQty))) full.push(doc);
  const fullSet = new Set(full);
  const imported = heads.filter((h) => fullSet.has(h.linked_ac_docno));
  note(`5 DELIVERED-BUT-IMPORTED: export carries ${full.length} fully-delivered orders; ${imported.length} of them are in the ERP`);
  const sofaOnes = imported.filter((h) => (acSofa.get(h.linked_ac_docno) || []).length);
  note(`   of those, with sofa lines: ${sofaOnes.length}`);
  for (const h of imported.slice(0, 40)) note(`   ${h.linked_ac_docno} -> ${h.doc_no}  RM${(Number(h.total_revenue_sen || 0) / 100).toFixed(2)}${(acSofa.get(h.linked_ac_docno) || []).length ? "  [SOFA]" : ""}`);
}


// 6 PO-CONVERTED MUST BE PRESENT — the owner's other half of the rule: a line
// turned into a PO is STILL outstanding until it becomes a DO, so every such
// order must be in the ERP. Anything missing here is a real gap, not noise.
{
  const n = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  const want = new Set();
  for (const [doc, ls] of acLines) if (ls.some((x) => n(x.TransferedPOQty) > 0 && n(x.Qty) > n(x.TransferedQty))) want.add(doc);
  const have = new Set(heads.map((h) => h.linked_ac_docno));
  const missing = [...want].filter((d) => !have.has(d));
  note(`6 PO-CONVERTED (still outstanding): ${want.size} orders expected; missing from the ERP: ${missing.length}`);
  for (const d of missing.slice(0, 40)) note(`   MISSING ${d}  AC lines: ${(acLines.get(d) || []).map((l) => l.ItemCode).join(", ").slice(0, 80)}`);
}


// 7 TRUE LEAK vs HONEST PLACEHOLDER — a {model}-1S line is a LEAK only when the
// AutoCount text actually decodes into 2+ pieces AND the line carries no
// "SOFA UNPARSED" remark (i.e. it came in through the old non-sofa round, not
// through the sofa lane's deliberate fallback).
{
  let leak = 0, placeholder = 0, oneSeat = 0;
  for (const [ac, codes] of acSofa) {
    const list = perOrder.get(ac);
    if (!list) continue;
    for (const l of (acLines.get(ac) || [])) {
      const erpCode = byAc.get(norm(l.ItemCode)) || "";
      if (!/^\w{2,6}-1S$/i.test(erpCode)) continue;
      let model = erpCode.replace(/-1S$/i, "");
      model = SOFA_MODEL_ALIAS[model] || model;
      const line = list.find((it) => norm(it.item_code) === norm(`${model}-1S`));
      if (!line) continue;
      const ps = parseSofa(l.Desc2, model, false);
      const multi = ps.conf !== "low" && ps.pieces.length > 1;
      const flagged = /SOFA UNPARSED|补拆件/i.test(line.remark || "");
      if (multi && !flagged) { leak++; if (leak <= 25) note(`   LEAK ${ac} ${l.ItemCode} -> kept as ${line.item_code}, decodes to ${ps.pieces.join("+")}`); }
      else if (flagged) placeholder++;
      else oneSeat++;
    }
  }
  note(`7 TRUE LEAK (undecomposed sofa line, no placeholder flag): ${leak}`);
  note(`   honest placeholders (flagged for manual fill): ${placeholder}; genuine single-seat builds: ${oneSeat}`);
}

await sql.end({ timeout: 5 });
