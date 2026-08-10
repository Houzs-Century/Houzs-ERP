#!/usr/bin/env node
// Reconcile the ERP against LIVE AutoCount on the two axes the owner set as a
// go-live blocker (2026-08-11):
//
//   A. BALANCE — scm.inventory_balances vs AutoCount vItemBalQty, per item and
//      per warehouse, with a named CAUSE for every disagreement.
//   B. STATUS  — AutoCount SO.Remark2 (the operator's stock-status column) vs
//      the ERP's derived stock remark, as an agreement matrix.
//
// READ-ONLY on both systems. One SELECT per question, no writes, no DDL.
//
// The AutoCount side arrives as a snapshot exported from the live book by
// backend/scripts/export-ac-live.py, because the AutoCount host is only
// reachable over ZeroTier from the office network and a CI runner is not on it.
// data/ac-live-export-manifest.json records when it was taken; a stale export
// is itself reported rather than silently compared.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 40);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* AutoCount location -> ERP warehouse CODE. Taken verbatim from the PO import
   (import-ac-outstanding-po.mjs SALESLOC), which resolved 100% there, extended
   with the stock-only locations that appear in vItemBalQty. A location with no
   confident ERP home stays UNMAPPED and is REPORTED — never guessed, because a
   wrong guess silently moves stock between branches. */
const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY",
  "EM DISP": "EM DISPLAY", "C&C DISP": "C&C DISPLAY",
  "SERV KL": "KL SERVICE", "SERV PG": "PG SERVICE",
  SUNWAY: "SUNWAY SHOWROOM", "KELANA.J": "KELANA.J SHOWROOM",
};

/* AutoCount ItemGroups that are NOT physical stock. AutoCount models delivery
   fees, disposal and storage as stock-controlled items, so they accumulate a
   large negative balance that no warehouse ever holds. The ERP models the same
   lines as SERVICE, which carry no inventory at all. Comparing them is a
   category error, not a discrepancy. */
const SERVICE_GROUPS = new Set(["OTHER", "TRANS"]);

/* Known-unfixed defect, already traced and pending an owner decision. Listed so
   it is labelled as the known case instead of being re-reported as new. */
const KNOWN_DOUBLE_SHIP = { doc: "SO-2606-019", dos: ["DO-2607-005", "DO-2607-017"], codes: new Set(["KETTA", "NTYR", "TRION", "XAMMAR"]) };

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

/* Faithful reimplementation of backend/src/scm/lib/so-readiness.ts. Kept in
   step with it deliberately: this script must derive the SAME string the UI
   shows, or the status comparison measures the script instead of the ERP. */
const MAIN_CATEGORIES = new Set(["SOFA", "BEDFRAME", "MATTRESS"]);
function normCategory(raw) {
  const g = (raw ?? "").trim().toUpperCase();
  if (g.includes("BEDFRAME")) return "BEDFRAME";
  if (g.includes("SOFA")) return "SOFA";
  if (g.includes("MATTRESS")) return "MATTRESS";
  if (g.includes("ACCESSOR")) return "ACCESSORY";
  if (g.includes("SERVICE")) return "SERVICE";
  return "OTHERS";
}
const isServiceLine = (l) => normCategory(l.item_group) === "SERVICE" || /^SVC-/i.test(l.item_code ?? "");
function summariseReadiness(lines) {
  const live = lines.filter((l) => !l.cancelled);
  let mainCount = 0, mainReady = 0, accCount = 0, accReady = 0;
  const mainByCat = new Map();
  for (const l of live) {
    if (isServiceLine(l)) continue;
    const cat = normCategory(l.item_group);
    const isReady = l.stock_status === "READY";
    if (MAIN_CATEGORIES.has(cat)) {
      mainCount += 1;
      const cell = mainByCat.get(cat) ?? { total: 0, ready: 0 };
      cell.total += 1;
      if (isReady) { mainReady += 1; cell.ready += 1; }
      mainByCat.set(cat, cell);
    } else { accCount += 1; if (isReady) accReady += 1; }
  }
  const isMainReady = mainCount > 0 ? mainReady === mainCount : true;
  const isFullyReady = (mainCount + accCount) > 0 && mainReady === mainCount && accReady === accCount;
  if (mainCount + accCount === 0) return "";
  if (isFullyReady) return "READY";
  if (isMainReady) return "READY (PARTIAL)";
  const readyCats = [];
  for (const cat of ["BEDFRAME", "SOFA", "MATTRESS"]) {
    const cell = mainByCat.get(cat);
    if (cell && cell.total > 0 && cell.ready === cell.total) readyCats.push(cat);
  }
  if (accCount > 0 && accReady === accCount) readyCats.push("ACC");
  return readyCats.join("/");
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "data", "ac-live-export-manifest.json"), "utf8"));
  log(`AutoCount export taken ${manifest.exported_at} from ${manifest.source}`);

  // ---- binding: AutoCount ItemCode -> ERP product code, plus AC category ----
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  const item = new Map(gz("ac-live-item-master.json.gz").map((r) => [norm(r.ItemCode), r]));
  const groupOf = (ac) => (item.get(norm(ac))?.ItemGroup ?? "").toUpperCase();

  // ---- warehouses ----
  const whs = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const whByCode = new Map(whs.map((w) => [String(w.code).toUpperCase(), w]));
  const resolveWh = (loc) => {
    const k = norm(loc);
    return whByCode.get((SALESLOC[k] || k).toUpperCase()) ?? whByCode.get(k) ?? null;
  };

  // ================= PART A — BALANCE =================
  log("");
  log("=== PART A — stock balance, ERP vs live AutoCount ===");

  const bal = gz("ac-live-stock-balance.json.gz");
  const acCell = new Map();   // "CODE|whId" -> qty
  const excluded = { sofa: 0, service: 0, unmappedItem: 0, unmappedWh: 0 };
  const unmappedWhLoc = new Map();
  const acItemTotal = new Map();
  for (const r of bal) {
    if (!r.BalQty) continue;
    const g = groupOf(r.ItemCode);
    if (SERVICE_GROUPS.has(g)) { excluded.service += r.BalQty; continue; }
    if (g === "SOFA") { excluded.sofa += r.BalQty; continue; }
    const erp = byAc.get(norm(r.ItemCode));
    if (!erp) { excluded.unmappedItem += r.BalQty; continue; }
    const wh = resolveWh(r.Location);
    if (!wh) {
      excluded.unmappedWh += r.BalQty;
      const k = norm(r.Location);
      unmappedWhLoc.set(k, (unmappedWhLoc.get(k) ?? 0) + r.BalQty);
      continue;
    }
    const k = `${norm(erp)}|${wh.id}`;
    acCell.set(k, (acCell.get(k) ?? 0) + Number(r.BalQty));
    acItemTotal.set(norm(erp), (acItemTotal.get(norm(erp)) ?? 0) + Number(r.BalQty));
  }
  log(`AutoCount comparable cells: ${acCell.size}`);
  log(`  excluded — sofa furniture (compartment model): ${excluded.sofa} units; service pseudo-items: ${excluded.service} units; unmapped item: ${excluded.unmappedItem}; unmapped warehouse: ${excluded.unmappedWh}`);
  for (const [l, q] of unmappedWhLoc) log(`  UNMAPPED LOCATION ${l}: ${q} units have no ERP warehouse`);

  const erpBal = await sql`SELECT product_code, warehouse_id, SUM(qty)::int qty
    FROM scm.inventory_balances WHERE company_id = ${CO} GROUP BY product_code, warehouse_id`;
  const erpCell = new Map(erpBal.map((r) => [`${norm(r.product_code)}|${r.warehouse_id}`, Number(r.qty)]));
  const whName = new Map(whs.map((w) => [String(w.id), w.name]));

  /* Did the cutover import actually run? The repo contains a script that
      printed a DONE line while writing nothing, so the movements are counted
      here rather than trusted from a log. */
  const [cut] = await sql`SELECT COUNT(*)::int n, COALESCE(SUM(qty),0)::int units
    FROM scm.inventory_movements WHERE source_doc_type = 'AC_CUTOVER'`;
  log(`cutover adjustment movements present in ERP: ${cut.n} (${cut.units} units)`);

  // snapshot drift = AutoCount activity AFTER the cutover snapshot
  const snap = new Map();
  for (const r of gz("ac-stock-balance.json.gz")) {
    const k = `${norm(r.ItemCode)}|${norm(r.Location)}`;
    snap.set(k, (snap.get(k) ?? 0) + Number(r.BalQty || 0));
  }
  const movedSinceSnapshot = new Set();
  for (const r of bal) {
    const k = `${norm(r.ItemCode)}|${norm(r.Location)}`;
    if (Math.abs(Number(r.BalQty || 0) - (snap.get(k) ?? 0)) > 1e-9) {
      const erp = byAc.get(norm(r.ItemCode));
      const wh = resolveWh(r.Location);
      if (erp && wh) movedSinceSnapshot.add(`${norm(erp)}|${wh.id}`);
    }
  }

  const keys = new Set([...acCell.keys(), ...erpCell.keys()]);
  const agree = [], differ = [], acOnly = [], erpOnly = [];
  for (const k of keys) {
    const a = acCell.has(k) ? Math.round(acCell.get(k)) : null;
    const e = erpCell.has(k) ? erpCell.get(k) : null;
    const [code, whId] = k.split("|");
    const row = { code, whId, wh: whName.get(whId) ?? whId, ac: a, erp: e, d: (e ?? 0) - (a ?? 0) };
    if (a === null) { if (e !== 0) erpOnly.push(row); }
    else if (e === null) { if (a !== 0) acOnly.push(row); }
    else if (a === e) agree.push(row);
    else differ.push(row);
  }

  /* Movement provenance per cell. This is the evidence that separates the cause
     categories from each other: a cell whose only movement is the cutover
     adjustment cannot have drifted through trading, and a cell carrying the
     same source_doc_no twice is a duplicate rather than a missing posting. */
  const mv = await sql`SELECT product_code, warehouse_id, source_doc_type,
      COUNT(*)::int n, COALESCE(SUM(qty),0)::int units
    FROM scm.inventory_movements WHERE company_id = ${CO}
    GROUP BY product_code, warehouse_id, source_doc_type`;
  const mvBy = new Map();
  for (const r of mv) {
    const k = `${norm(r.product_code)}|${r.warehouse_id}`;
    if (!mvBy.has(k)) mvBy.set(k, new Map());
    mvBy.get(k).set(r.source_doc_type ?? "(null)", { n: r.n, units: Number(r.units) });
  }
  const dup = await sql`SELECT product_code, warehouse_id, source_doc_type, source_doc_no,
      COUNT(*)::int n, COALESCE(SUM(qty),0)::int units
    FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no IS NOT NULL
    GROUP BY product_code, warehouse_id, source_doc_type, source_doc_no
    HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 200`;
  const dupCell = new Set(dup.map((r) => `${norm(r.product_code)}|${r.warehouse_id}`));
  log(`cells carrying the same source document more than once: ${dupCell.size} (${dup.length} document groups)`);
  for (const r of dup.slice(0, 15)) log(`  DUP ${r.product_code} @ ${whName.get(String(r.warehouse_id)) ?? r.warehouse_id} ${r.source_doc_type} ${r.source_doc_no} x${r.n} = ${r.units} units`);

  const provenance = (r) => {
    const m = mvBy.get(`${r.code}|${r.whId}`);
    if (!m) return "no movements";
    return [...m.entries()].map(([t, v]) => `${t}x${v.n}=${v.units}`).join(" ");
  };

  const causeOf = (r) => {
    if (KNOWN_DOUBLE_SHIP.codes.has(r.code)) return "KNOWN DOUBLE-SHIP (SO-2606-019, DO-2607-005 + DO-2607-017) — traced, owner decision pending";
    if (dupCell.has(`${r.code}|${r.whId}`)) return "DUPLICATED MOVEMENT — the same source document is posted more than once against this cell";
    if (movedSinceSnapshot.has(`${r.code}|${r.whId}`)) return "MIGRATION CUT-OFF — AutoCount moved after the cutover snapshot the ERP was seeded from";
    const m = mvBy.get(`${r.code}|${r.whId}`);
    if (!m) return "NO ERP MOVEMENT — the cutover adjustment never reached this cell";
    const types = new Set(m.keys());
    if (types.size === 1 && types.has("AC_CUTOVER")) return "CUTOVER ADJUSTMENT ONLY — seeded once and untouched since, so the delta was present at seeding";
    if (!types.has("AC_CUTOVER")) return "ERP-NATIVE STOCK — this cell was never seeded from AutoCount; it exists only in the ERP";
    return "POSTED IN ONE SYSTEM ONLY — the ERP traded this cell after seeding; match against the AutoCount document list";
  };

  const totalAc = [...acCell.values()].reduce((s, x) => s + x, 0);
  const totalErp = [...acCell.keys()].reduce((s, k) => s + (erpCell.get(k) ?? 0), 0);
  log(`cells compared: ${keys.size} | AGREE: ${agree.length} | DISAGREE: ${differ.length} | AutoCount-only: ${acOnly.length} | ERP-only: ${erpOnly.length}`);
  log(`unit totals over comparable cells — AutoCount ${Math.round(totalAc)} vs ERP ${totalErp} (net ${totalErp - Math.round(totalAc) >= 0 ? "+" : ""}${totalErp - Math.round(totalAc)})`);

  const byCause = new Map();
  for (const r of [...differ, ...acOnly, ...erpOnly]) {
    const c = causeOf(r);
    const cell = byCause.get(c) ?? { n: 0, units: 0 };
    cell.n += 1; cell.units += Math.abs(r.d); byCause.set(c, cell);
  }
  log("");
  log("causes, by cell count:");
  for (const [c, v] of [...byCause.entries()].sort((a, b) => b[1].units - a[1].units)) {
    log(`  ${v.n} cells / ${v.units} units — ${c}`);
  }

  // per-warehouse rollup — the owner asks for the balance per location, not
  // only per item, because a branch that is wholly wrong reads differently
  // from the same units scattered across every branch.
  const perWh = new Map();
  for (const k of keys) {
    const [code, whId] = k.split("|");
    const a = acCell.has(k) ? Math.round(acCell.get(k)) : 0;
    const e = erpCell.get(k) ?? 0;
    const cell = perWh.get(whId) ?? { wh: whName.get(whId) ?? whId, cells: 0, agree: 0, ac: 0, erp: 0 };
    cell.cells += 1; cell.ac += a; cell.erp += e;
    if (a === e) cell.agree += 1;
    perWh.set(whId, cell);
  }
  log("");
  log("per-warehouse rollup:");
  log(`  ${"warehouse".padEnd(20)} ${"cells".padStart(6)} ${"agree".padStart(6)} ${"AutoCount".padStart(10)} ${"ERP".padStart(8)} ${"delta".padStart(8)}`);
  for (const c of [...perWh.values()].sort((a, b) => Math.abs(b.erp - b.ac) - Math.abs(a.erp - a.ac))) {
    log(`  ${String(c.wh).padEnd(20)} ${String(c.cells).padStart(6)} ${String(c.agree).padStart(6)} ${String(c.ac).padStart(10)} ${String(c.erp).padStart(8)} ${String(c.erp - c.ac).padStart(8)}`);
  }

  // value ranking — cost per ERP product, so a 1-unit delta on a bedframe does
  // not rank below a 40-unit delta on pillows.
  const costByErp = new Map();
  const addCost = (acCode, rm) => { const e = byAc.get(norm(acCode)); if (e && rm > 0 && !costByErp.has(norm(e))) costByErp.set(norm(e), rm); };
  for (const r of gz("ac-utd-stock-cost.json.gz")) if (r.UTDQty > 0) addCost(r.ItemCode, r.AverageCost ?? (r.UTDCost / r.UTDQty));
  for (const r of gz("ac-item-costs.json.gz")) addCost(r.ItemCode, r.RealCost || r.Cost || r.RecentCost);

  const all = [...differ, ...acOnly, ...erpOnly];
  log("");
  log(`top disagreements by absolute UNIT delta (max ${TOP}):`);
  for (const r of [...all].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, TOP)) {
    log(`  ${r.code} @ ${r.wh}: AutoCount ${r.ac ?? "-"} vs ERP ${r.erp ?? "-"} (${r.d > 0 ? "+" : ""}${r.d}) :: ${causeOf(r).split(" — ")[0]} :: ${provenance(r)}`);
  }
  log("");
  log(`top disagreements by VALUE (max ${TOP}):`);
  const valued = all.map((r) => ({ ...r, rm: Math.abs(r.d) * (costByErp.get(r.code) ?? 0) }))
    .filter((r) => r.rm > 0).sort((a, b) => b.rm - a.rm);
  const totalRm = valued.reduce((s, r) => s + r.rm, 0);
  log(`  total value at risk across all disagreeing cells: RM ${totalRm.toFixed(2)} (costed cells: ${valued.length}/${all.length})`);
  for (const r of valued.slice(0, TOP)) {
    log(`  RM ${r.rm.toFixed(2).padStart(10)}  ${r.code} @ ${r.wh}: AutoCount ${r.ac ?? "-"} vs ERP ${r.erp ?? "-"} (${r.d > 0 ? "+" : ""}${r.d}) :: ${causeOf(r).split(" — ")[0]}`);
  }

  // ================= PART B — STATUS / REMARK 2 =================
  log("");
  log("=== PART B — AutoCount SO.Remark2 vs ERP derived stock remark ===");

  const acRem = new Map();
  for (const r of gz("ac-live-so-remark2.json.gz")) acRem.set(r.DocNo.trim().toUpperCase(), { remark: (r.Remark2 || "").trim().toUpperCase(), outstanding: r.Outstanding });

  const lines = await sql`SELECT h.linked_ac_docno, h.doc_no, h.status,
      i.item_group, i.item_code, i.stock_status, COALESCE(i.cancelled,false) cancelled
    FROM scm.mfg_sales_orders h
    JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  const byOrder = new Map();
  for (const l of lines) {
    const k = String(l.linked_ac_docno).trim().toUpperCase();
    if (!byOrder.has(k)) byOrder.set(k, { doc_no: l.doc_no, status: l.status, lines: [] });
    byOrder.get(k).lines.push(l);
  }
  log(`ERP orders linked to an AutoCount DocNo: ${byOrder.size}`);

  const matrix = new Map();
  const mismatches = [];
  let compared = 0, missingInAc = 0;
  for (const [doc, o] of byOrder) {
    const ac = acRem.get(doc);
    if (!ac) { missingInAc += 1; continue; }
    const erpRemark = summariseReadiness(o.lines);
    compared += 1;
    const key = `${ac.remark || "(blank)"} => ${erpRemark || "(blank)"}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
    if ((ac.remark || "") !== (erpRemark || "")) mismatches.push({ doc, erpDoc: o.doc_no, ac: ac.remark, erp: erpRemark, status: o.status });
  }
  log(`orders compared: ${compared}; linked but absent from the AutoCount export: ${missingInAc}`);
  log(`AGREE: ${compared - mismatches.length}; DISAGREE: ${mismatches.length}`);
  log("");
  log("agreement matrix (AutoCount Remark2 => ERP stock remark):");
  for (const [k, n] of [...matrix.entries()].sort((a, b) => b[1] - a[1])) {
    const [l, r] = k.split(" => ");
    log(`  ${n === 0 ? "" : ""}${String(n).padStart(6)}  ${l.padEnd(20)} => ${r}${l === r ? "" : "   <-- differs"}`);
  }
  log("");
  log(`sample disagreements (max ${TOP}):`);
  for (const m of mismatches.slice(0, TOP)) {
    log(`  ${m.doc} (${m.erpDoc}, ${m.status}): AutoCount "${m.ac || "(blank)"}" vs ERP "${m.erp || "(blank)"}"`);
  }

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
