#!/usr/bin/env node
// Bring the AutoCount physical stock into the ERP for company 1 (Houzs Century),
// non-sofa first (sofa held for the sofa round).
//
// Model: the ERP's inventory is movements-based (inventory_balances is a view,
// FIFO lots created by the movement trigger), so this writes RECONCILING
// ADJUSTMENT movements per product+warehouse: delta = AC balance − ERP on-hand.
//   qty source  = vItemBalQty snapshot (data/ac-stock-balance.json.gz)
//   cost source = UTDStockCost.AverageCost → ItemUOM cost → ERP product cost → 0
//                 (zero-cost rows are REPORTED — they feed costless-stock-check)
// Positive deltas insert stock (trigger creates lots at the given cost).
// Negative deltas are REPORT-ONLY unless NEG=1 (they consume FIFO lots).
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert by construction. It writes delta = AutoCount balance MINUS ERP on-hand, so once the two agree the delta is zero and no movement is written.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const NEG = process.env.NEG === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const isSofa = (c) => /SOFA/i.test(c || "");
// set once the binding CSV is read (see main) — category, not spelling
let sofaCategory = new Set();
const isSofaFurniture = (c) => sofaCategory.has(norm(c));
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

// AC location code -> ERP warehouse CODE — the exact map the PO import resolved
// 100% with (import-ac-outstanding-po.mjs SALESLOC), extended with the extra
// stock locations seen in vItemBalQty. Codes with no confident ERP home stay
// UNRESOLVED and are reported, never guessed.
const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY",
  "EM DISP": "EM DISPLAY", "C&C DISP": "C&C DISPLAY",
  // dry-run 2 revealed the ERP codes for the last four AC locations verbatim
  "SERV KL": "KL SERVICE", "SERV PG": "PG SERVICE",
  SUNWAY: "SUNWAY SHOWROOM", "KELANA.J": "KELANA.J SHOWROOM",
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}${NEG ? " (+negative adjustments)" : ""}`);
  const utd = gz("ac-utd-stock-cost.json.gz");
  const iuc = gz("ac-item-costs.json.gz");
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  // column 4 is the AutoCount category; only SOFA is furniture we skip
  sofaCategory = new Set(csv.map(parseCsvLine).filter((f) => (f[3] || "").trim().toUpperCase() === "SOFA").map((f) => norm(f[0])));
  log(`sofa furniture codes excluded: ${sofaCategory.size}`);
  /* Sofa FURNITURE is excluded — owner 2026-08-10: "沙发库存不准的，因为我们
     接下来跑 compartment 了". AutoCount counts a sofa as one whole unit and the
     ERP counts it per compartment, so the balance cannot be decomposed without
     inventing stock, and the owner does not trust the number anyway.

     But "SOFA" in a code does not mean sofa furniture. AMN-SOFA PILLOW and
     THL-SOFA PILLOW are ordinary accessories — 205 units of real, countable
     stock that the literal /SOFA/ test threw away with the furniture. The
     binding CSV already separates them (category SOFA vs ACC), so the
     exclusion reads the CATEGORY instead of the spelling. Owner: "pillow 就ok". */
  const bal = gz("ac-stock-balance.json.gz").filter((r) => r.BalQty !== 0 && !isSofaFurniture(r.ItemCode));

  // cost maps (RM -> sen)
  const utdCost = new Map(); // item -> avg cost
  for (const r of utd) if (r.UTDQty > 0 && (r.AverageCost || r.UTDCost)) {
    const c = r.AverageCost ?? (r.UTDCost / r.UTDQty);
    if (c > 0 && !utdCost.has(norm(r.ItemCode))) utdCost.set(norm(r.ItemCode), c);
  }
  const iucCost = new Map();
  for (const r of iuc) { const c = r.RealCost || r.Cost || r.RecentCost; if (c > 0 && !iucCost.has(norm(r.ItemCode))) iucCost.set(norm(r.ItemCode), c); }

  // warehouse resolution — by CODE, exactly like the PO import (100% there)
  const whs = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = 1`;
  log(`ERP warehouse codes: ${whs.map((w) => w.code).join(", ")}`);
  const whByCode = new Map(whs.map((w) => [String(w.code).toUpperCase(), w]));
  const resolveWh = (loc) => {
    const k = norm(loc);
    return whByCode.get((SALESLOC[k] || k).toUpperCase()) ?? whByCode.get(k) ?? null;
  };
  const locs = [...new Set(bal.map((r) => norm(r.Location)))];
  const locMap = new Map();
  for (const l of locs) { const w = resolveWh(l); locMap.set(l, w); log(`  location ${l} -> ${w ? `${w.code} (${w.name})` : "UNRESOLVED"}`); }

  // ERP product cost fallback + product names
  const prodCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name='mfg_products'`;
  const pcn = prodCols.map((r) => r.column_name);
  const costCol = ["cost_sen", "unit_cost_sen", "cost_sen", "base_cost_sen"].find((c) => pcn.includes(c));
  const prods = await sql.unsafe(`SELECT code, name${costCol ? `, ${costCol} AS cost_sen` : ""} FROM scm.mfg_products WHERE company_id = 1`);
  const prodBy = new Map(prods.map((p) => [norm(p.code), p]));

  // ERP current on-hand per product+warehouse (all variant keys summed)
  const onhand = await sql`SELECT item_code, warehouse_id, SUM(qty)::int AS qty
    FROM scm.inventory_balances WHERE company_id = 1 GROUP BY item_code, warehouse_id`;
  const ohBy = new Map(onhand.map((r) => [`${norm(r.item_code)}|${r.warehouse_id}`, Number(r.qty)]));

  // movements table company_id presence (multicompany migration)
  const mvCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name='inventory_movements'`).map((r) => r.column_name);
  const hasCo = mvCols.includes("company_id");

  let unmapped = 0, unWh = 0, zeroCost = 0;
  /* AGGREGATE FIRST (2026-08-29, docs/bugs/0566). Several AutoCount codes can
     map to ONE ERP code (35 such cells carried balance that day: the four
     DIVAN ONLY supplier families, HOK/NB bedframe twins, two pillow codes...).
     The first version computed one delta PER AC ROW against the same ERP
     cell's on-hand, so with NEG=1 every extra AC row re-subtracted the whole
     cell: SQUARE PILLOW @ Balakong took -173 and -180 for a true -173 and
     landed on -161. One cell, one delta: sum the AC rows first. */
  const cells = new Map(); // `${norm(erp)}|${wh.id}` -> {erp, wh, acQty, acs:[], costSen}
  for (const r of bal) {
    const erp = byAc.get(norm(r.ItemCode));
    if (!erp) { unmapped++; log(`  unmapped AC item: ${r.ItemCode} (${r.Location} ${r.BalQty})`); continue; }
    /* an ERP code with unbalanced parentheses is a truncated 30-char AutoCount
       code that leaked through the mapping (docs/bugs/0567) — creating stock
       under it would mint a garbage product code. Refuse loudly. */
    if ((erp.match(/\(/g) ?? []).length !== (erp.match(/\)/g) ?? []).length) {
      unmapped++; log(`  REFUSED unbalanced-paren ERP code for AC ${r.ItemCode}: ${JSON.stringify(erp)} — fix the mapping row`); continue;
    }
    const wh = locMap.get(norm(r.Location));
    if (!wh) { unWh++; continue; }
    const k = `${norm(erp)}|${wh.id}`;
    const c = cells.get(k) ?? { erp, wh, acQty: 0, acs: [], costSen: 0 };
    c.acQty += Math.round(r.BalQty);
    c.acs.push(r.ItemCode);
    if (!c.costSen) {
      const costRm = utdCost.get(norm(r.ItemCode)) ?? iucCost.get(norm(r.ItemCode)) ?? 0;
      c.costSen = Math.round(costRm * 100);
    }
    cells.set(k, c);
  }
  const plan = []; const negs = [];
  for (const c of cells.values()) {
    const p = prodBy.get(norm(c.erp));
    if (!c.costSen && p?.cost_sen) c.costSen = p.cost_sen;
    const cur = ohBy.get(`${norm(c.erp)}|${c.wh.id}`) ?? 0;
    const delta = c.acQty - cur;
    if (delta === 0) continue;
    if (delta > 0 && c.costSen === 0) zeroCost++;
    (delta > 0 ? plan : negs).push({ code: c.erp, name: p?.name ?? c.erp, wh: c.wh, delta, costSen: c.costSen, ac: c.acs.join("+"), loc: "", acQty: c.acQty, cur });
  }
  const units = plan.reduce((s, x) => s + x.delta, 0);
  log(`positive adjustments: ${plan.length} cells / +${units} units (zero-cost: ${zeroCost}); negative deltas: ${negs.length}${NEG ? " (WILL APPLY)" : " (report-only)"}; unmapped items: ${unmapped}; unresolved-warehouse rows: ${unWh}`);
  for (const x of plan.slice(0, 25)) log(`   +${x.delta} ${x.code} @ ${x.wh.name} (AC ${x.acQty} vs ERP ${x.cur}) cost ${x.costSen / 100} RM`);
  for (const x of negs.slice(0, 15)) log(`   NEG ${x.delta} ${x.code} @ ${x.wh.name} (AC ${x.acQty} vs ERP ${x.cur})`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  const todo = NEG ? [...plan, ...negs] : plan;
  let done = 0;
  for (const x of todo) {
    const cols = ["movement_type", "warehouse_id", "item_code", "product_name", "variant_key", "qty", "unit_cost_sen", "source_doc_type", "source_doc_no", "notes"];
    const vals = ["'ADJUSTMENT'", `'${x.wh.id}'`, "$1", "$2", "''", `${x.delta}`, `${x.costSen}`, "'AC_CUTOVER'", "'AC-BAL-2026-08-09'", "$3"];
    if (hasCo) { cols.push("company_id"); vals.push("1"); }
    await sql.unsafe(
      `INSERT INTO scm.inventory_movements (${cols.join(",")}) VALUES (${vals.join(",")})`,
      [x.code, x.name, `AutoCount ${x.ac} @ ${x.loc}: AC ${x.acQty} vs ERP ${x.cur}`]);
    done++;
    if (done % 100 === 0) log(`  ..${done}/${todo.length}`);
  }
  log(`DONE. adjustment movements written: ${done}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
