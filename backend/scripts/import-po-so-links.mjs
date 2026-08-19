#!/usr/bin/env node
// Rebuild the PO->SO line dedication from AutoCount's own conversion records
// (owner 2026-08-10: Houzs runs the BOUND mode for bedframe/sofa — a PO raised
// from an SO belongs to that SO; the relationship map must be precise).
//
// Source: data/ac-outstanding-po.json.gz lines carry FromSODtlKey (the AC SO
// line DtlKey) and FromSODocList; data/ac-outstanding-so.json.gz maps DtlKey ->
// (SO DocNo, ItemCode). Both sides resolve to ERP rows via the AC->ERP code
// map, then per (doc, erp code) the AC lines (by DtlKey) zip against the ERP
// lines (by line order). Writes purchase_order_items.so_item_id ONLY where it
// is NULL — never overwrites a link made in the ERP.
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
  const poRows = gz("ac-outstanding-po.json.gz");
  const soRows = gz("ac-outstanding-so.json.gz");
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  const soByDtl = new Map(); // AC SO DtlKey -> {doc, code}
  for (const r of soRows) soByDtl.set(String(r.DtlKey), { doc: r.DocNo, code: r.ItemCode });

  // ERP SO lines grouped by (ac doc | erp code), ordered
  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, h.linked_ac_docno ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL ORDER BY i.line_no`;
  const soGrp = new Map();
  for (const it of soItems) {
    const k = `${it.ac}|${norm(it.item_code)}`;
    if (!soGrp.has(k)) soGrp.set(k, []);
    soGrp.get(k).push(it);
  }
  // ERP PO lines grouped likewise
  const poItems = await sql`SELECT i.id, i.item_code, i.so_item_id, h.linked_ac_docno ac
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL ORDER BY i.id`;
  const poGrp = new Map();
  for (const it of poItems) {
    const k = `${it.ac}|${norm(it.item_code)}`;
    if (!poGrp.has(k)) poGrp.set(k, []);
    poGrp.get(k).push(it);
  }

  // AC PO lines with an SO origin, grouped per (po doc | erp code), DtlKey order
  const acGrp = new Map();
  for (const r of poRows.sort((a, b) => Number(a.DtlKey) - Number(b.DtlKey))) {
    const erp = byAc.get(norm(r.ItemCode)); if (!erp) continue;
    const k = `${r.DocNo}|${norm(erp)}`;
    if (!acGrp.has(k)) acGrp.set(k, []);
    acGrp.get(k).push(r);
  }

  let planned = 0, already = 0, noSoLine = 0, noPoLine = 0, noOrigin = 0;
  const plan = [];
  for (const [k, acLines] of acGrp) {
    const poLines = poGrp.get(k);
    if (!poLines) { noPoLine += acLines.length; continue; }
    for (let i = 0; i < acLines.length && i < poLines.length; i++) {
      const ac = acLines[i]; const po = poLines[i];
      // resolve the SO line: precise DtlKey first, then doc-level fallback
      let soDoc = null, soCode = null;
      const viaDtl = ac.FromSODtlKey != null ? soByDtl.get(String(ac.FromSODtlKey)) : null;
      if (viaDtl) { soDoc = viaDtl.doc; soCode = viaDtl.code; }
      else if (ac.FromSODocList) { soDoc = String(ac.FromSODocList).split(",")[0].trim(); soCode = ac.ItemCode; }
      if (!soDoc) { noOrigin++; continue; }
      const erpSoCode = byAc.get(norm(soCode)) ?? "";
      const soCands = soGrp.get(`${soDoc}|${norm(erpSoCode)}`);
      if (!soCands || !soCands.length) { noSoLine++; log(`  no SO line for ${k} <- ${soDoc} ${soCode}`); continue; }
      const soLine = soCands.length === 1 ? soCands[0] : soCands[i % soCands.length];
      if (po.so_item_id) { already++; continue; }
      plan.push({ poItemId: po.id, soItemId: soLine.id, k, soDoc });
      planned++;
    }
  }
  log(`AC PO lines with origin: ${[...acGrp.values()].flat().length}; links planned: ${planned}; already linked: ${already}`);
  log(`unresolved -> PO line missing: ${noPoLine}; SO line missing: ${noSoLine}; no origin recorded: ${noOrigin}`);
  for (const p of plan.slice(0, 15)) log(`   ${p.k} -> SO ${p.soDoc}`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  let n = 0;
  for (const p of plan) {
    await sql`UPDATE scm.purchase_order_items SET so_item_id = ${p.soItemId} WHERE id = ${p.poItemId} AND so_item_id IS NULL`;
    n++;
  }
  log(`DONE. so_item_id set on ${n} PO lines`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
