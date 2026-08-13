#!/usr/bin/env node
// Rebuild the AC cutover stock as REAL FIFO layers (owner 2026-08-10: "拿得到
// 我的 movement 给目前的 stocks 补齐这个数据和 COGS 方便 PNL").
//
// The flat import (source_doc_no AC-BAL-2026-08-09) landed quantities as one
// zero-cost lot per cell. data/ac-stock-layers.json.gz decomposes every cell
// back into its actual receipts (GRN + direct-PI history, newest backwards
// until the balance is covered): per-layer qty, REAL unit cost, receipt date
// and source doc. This script, per cell:
//   1. writes a negative ADJUSTMENT consuming the flat zero-cost lot
//   2. writes one positive ADJUSTMENT per layer with unit_cost_sen and
//      created_at = the real receipt date (the FIFO trigger stamps the lot's
//      received_at from it, so consumption order matches physical reality)
// Guard: refuses any cell whose flat lot has been partially consumed.
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. A cell is only relayered while its flat zero-cost lot is unconsumed; step 1 consumes it, so a second run skips the cell.
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
const isSofa = (c) => /SOFA/i.test(c || "");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY",
  "EM DISP": "EM DISPLAY", "C&C DISP": "C&C DISPLAY",
  "SERV KL": "KL SERVICE", "SERV PG": "PG SERVICE",
  SUNWAY: "SUNWAY SHOWROOM", "KELANA.J": "KELANA.J SHOWROOM",
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const layers = gz("ac-stock-layers.json.gz").filter((l) => !isSofa(l.ItemCode));
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  const whs = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(whs.map((w) => [String(w.code).toUpperCase(), w]));
  const resolveWh = (loc) => { const k = norm(loc); return whByCode.get((SALESLOC[k] || k).toUpperCase()) ?? whByCode.get(k) ?? null; };
  const prods = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = 1`;
  const prodBy = new Map(prods.map((p) => [norm(p.code), p]));
  const mvCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name='inventory_movements'`).map((r) => r.column_name);
  const hasCo = mvCols.includes("company_id");

  // cells (erp code + warehouse) -> their layers
  const cells = new Map();
  let unmapped = 0, unWh = 0;
  for (const l of layers) {
    const erp = byAc.get(norm(l.ItemCode));
    if (!erp) { unmapped++; continue; }
    const wh = resolveWh(l.Location);
    if (!wh) { unWh++; continue; }
    const k = `${norm(erp)}|${wh.id}`;
    if (!cells.has(k)) cells.set(k, { code: erp, wh, name: prodBy.get(norm(erp))?.name ?? erp, ac: l.ItemCode, loc: l.Location, layers: [] });
    cells.get(k).layers.push(l);
  }
  // the flat lots this replaces — must be fully unconsumed
  const flat = await sql`SELECT l.id, l.product_code, l.warehouse_id, l.qty_received, l.qty_remaining, l.unit_cost_sen
    FROM scm.inventory_lots l WHERE l.source_doc_no = 'AC-BAL-2026-08-09'`;
  // Several AC ItemCodes map onto ONE ERP code (HOK-/DSL-/AMN-SQUARE PILLOW ->
  // SQUARE PILLOW), so a cell may hold SEVERAL flat lots — aggregate them and
  // reconcile the SUM against the merged layers.
  const flatBy = new Map();
  for (const f of flat) {
    const k = `${norm(f.product_code)}|${f.warehouse_id}`;
    const agg = flatBy.get(k) ?? { received: 0, remaining: 0 };
    agg.received += Number(f.qty_received);
    agg.remaining += Number(f.qty_remaining);
    flatBy.set(k, agg);
  }
  let consumed = 0, noFlat = 0, ready = 0, layerCount = 0, costedUnits = 0, totalUnits = 0;
  const todo = [];
  for (const [k, c] of cells) {
    const f = flatBy.get(k);
    if (!f) { noFlat++; continue; }
    if (f.remaining !== f.received) { consumed++; log(`  SKIP consumed cell ${c.code} @ ${c.wh.code}`); continue; }
    const lq = c.layers.reduce((s, x) => s + x.Qty, 0);
    if (Math.round(lq) !== f.received) { log(`  SKIP qty mismatch ${c.code} @ ${c.wh.code}: layers ${lq} vs lots ${f.received}`); continue; }
    ready++; layerCount += c.layers.length;
    for (const l of c.layers) { totalUnits += l.Qty; if (l.Cost > 0) costedUnits += l.Qty; }
    todo.push({ ...c, flat: { qty_received: f.received } });
  }
  log(`cells: ${cells.size}; ready to relayer: ${ready}; already-consumed skipped: ${consumed}; no-flat-lot: ${noFlat}; unmapped: ${unmapped}; unresolved-wh: ${unWh}`);
  log(`layers to write: ${layerCount}; units with real cost: ${Math.round(costedUnits)}/${Math.round(totalUnits)}`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  let done = 0;
  for (const c of todo) {
    await sql.begin(async (tx) => {
      const base = ["movement_type", "warehouse_id", "product_code", "product_name", "variant_key", "qty", "unit_cost_sen", "source_doc_type", "source_doc_no", "notes"];
      const cols = hasCo ? [...base, "company_id"] : base;
      // 1. reverse the flat zero-cost lot (negative adjustment consumes it)
      const negVals = ["'ADJUSTMENT'", `'${c.wh.id}'`, "$1", "$2", "''", `${-Number(c.flat.qty_received)}`, "0", "'AC_CUTOVER'", "'AC-BAL-RELAYER-2026-08-10'", "'replace flat opening lot with real receipt layers'"];
      if (hasCo) negVals.push("1");
      await tx.unsafe(`INSERT INTO scm.inventory_movements (${cols.join(",")}) VALUES (${negVals.join(",")})`, [c.code, c.name]);
      // 2. one positive adjustment per real receipt layer, backdated
      for (const l of c.layers) {
        const costSen = Math.round((l.Cost || 0) * 100);
        const when = l.Date ? `'${l.Date}T00:00:00Z'` : "now()";
        const note = l.SrcDoc ? `AC ${l.Src} ${l.SrcDoc} ${l.Date}` : `AC layer uncovered (no receipt history)`;
        const posVals = ["'ADJUSTMENT'", `'${c.wh.id}'`, "$1", "$2", "''", `${Math.round(l.Qty)}`, `${costSen}`, "'AC_CUTOVER'", "'AC-BAL-LAYERS-2026-08-10'", "$3", `${when}`];
        const posCols = [...base, "created_at"];
        if (hasCo) { posCols.push("company_id"); posVals.push("1"); }
        await tx.unsafe(`INSERT INTO scm.inventory_movements (${posCols.join(",")}) VALUES (${posVals.join(",")})`, [c.code, c.name, note]);
      }
    });
    done++;
    if (done % 100 === 0) log(`  ..${done}/${todo.length}`);
  }
  log(`DONE. cells relayered: ${done}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
