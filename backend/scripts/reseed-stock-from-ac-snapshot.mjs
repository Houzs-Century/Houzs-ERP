#!/usr/bin/env node
/* Re-seed the ERP's stock balance from a FRESH AutoCount snapshot — the go-live cut.
   ---------------------------------------------------------------------------
   THE OWNER'S RULING (2026-09-07, ~23:00 +08): 「盖，用今晚的结存为准」 — overwrite
   the ERP's inventory balance with the AutoCount balance exported tonight at
   22:21 (+08). Both books are frozen for the cut: AutoCount is view-only for
   staff and the ERP refuses non-GET /api/scm while app_config['scm.write_freeze']
   is on.

   WHY OVERWRITING IS THE CORRECT REMEDY AND NOT A PAPER-OVER.
   .github/workflows/create-migrated-documents.yml states it in its own header:
   the migrated goods receipts and delivery notes are stamped `migrated_no_stock`
   and write NO inventory movement, because "the balance snapshot already counts
   those receipts as IN and those deliveries as OUT, so posting either would
   apply the same movement twice." The ERP's stock therefore IS a balance
   snapshot — it is not a ledger replay — and a snapshot has exactly one defect
   mode: age. The 2026-09-07 reconcile's largest bucket, 157 cells / 410 units
   labelled "ERP IS BEHIND THE BOOK", is that age and nothing else. Replacing the
   snapshot with a newer snapshot closes it by construction.

   NEVER COMPUTE A BALANCE — COPY AUTOCOUNT'S. Every target quantity in this
   script is `Math.round(BalQty)` read from data/ac-live-stock-balance.json.gz.
   Nothing is derived, netted, inferred or averaged. (migration-copy-never-compute.)

   WHAT IT WRITES. One `ADJUSTMENT` movement per cell that disagrees:
       qty = AutoCount balance MINUS the ERP's current on-hand
   so the movement trigger opens a FIFO lot for a positive delta and consumes
   FIFO for a negative one. Cells that already agree get no row at all.

   THE UNIVERSE IS THE RECONCILE'S UNIVERSE, deliberately. The AutoCount side is
   filtered by the SAME shared lib check-stock-vs-autocount.mjs uses
   (lib/ac-stock-compare.mjs: SALESLOC, SERVICE_GROUPS, loadAcBinding,
   serviceErpCodes), so "a cell this script re-seeds" and "a cell the reconcile
   compares" are the same sentence. A second copy of a location map is how stock
   silently moves between branches in one script and not the other.

   THREE THINGS IT REFUSES TO TOUCH, each reported rather than silently skipped:
     1. SOFA. Owner ruling 2 the same night: fold the ERP's PIECES into whole
        sofas FOR THE COMPARISON ONLY — 「把我们的件数折回成整张沙发再比」 — and do
        NOT change how sofa stock is stored, because the sofa MRP is hard-bound
        at piece level. AutoCount counts one whole sofa where the ERP counts its
        compartments, so an AutoCount balance row cannot be written onto ERP
        compartment cells without inventing which build it is. Excluded on BOTH
        sides, by the binding CSV's category column on the AutoCount side and by
        mfg_products.category on the ERP side.
     2. SERVICE pseudo-items. AutoCount models delivery / disposal / storage as
        stock-controlled items; the ERP models them as SERVICE, which carries no
        inventory. Excluded symmetrically — the ERP codes come from the binding
        via serviceErpCodes(), never typed.
     3. Anything AutoCount has no opinion on: an ERP item_code that is not a
        binding TARGET, or a warehouse that is not a SALESLOC target. Zeroing
        those would not be "用今晚的结存为准", it would be deleting stock from a
        book that never spoke about it.

   THE SAFETY CHECK IS PART OF THE PLAN, NOT A SEPARATE ERRAND. Overwriting
   erases any stock movement that happened only in the ERP. The ERP has been
   frozen, so the expected answer is none — but "expected" is not "measured".
   PLAN counts and PRINTS every non-AC_CUTOVER movement since the seeding, and
   APPLY REFUSES to run while any exist unless a human passes
   ACK_ERP_ONLY_MOVEMENTS=1 having read them. A count of zero that nobody looked
   at is not evidence.

   THE PRE-OVERWRITE BALANCE IS DUMPED OFF-DATABASE FIRST, always, in both modes:
   every company-1 cell with its qty, to DUMP_PATH (default reseed-pre-balance.json),
   which the workflow uploads as a build artifact. To restore, feed those quantities
   back as the target — the arithmetic is the same delta = target − current.

   MODE=plan (default) writes nothing.
   MODE=apply needs CONFIRM="RESEED STOCK FROM TONIGHT'S AUTOCOUNT BALANCE".

   RE-RUN: inert by construction. The delta is AutoCount MINUS the ERP's on-hand
   read at run time, so once the two agree every delta is zero and no movement is
   written. A second APPLY on an unchanged book is a no-op that reports 0 cells. */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SALESLOC, SERVICE_GROUPS, loadAcBinding, serviceErpCodes } from "./lib/ac-stock-compare.mjs";

const DSN = process.env.DATABASE_URL;
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "RESEED STOCK FROM TONIGHT'S AUTOCOUNT BALANCE";
const ACK_ERP_ONLY = process.env.ACK_ERP_ONLY_MOVEMENTS === "1";
const CO = Number(process.env.COMPANY_ID ?? 1);
const SRC_DOC = process.env.SRC_DOC || "AC-BAL-2026-09-07-2221";
const DUMP_PATH = process.env.DUMP_PATH || "reseed-pre-balance.json";
const TOP = Number(process.env.TOP ?? 40);

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : m); process.exit(2); };

if (!DSN) bad("need DATABASE_URL");
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — run MODE=plan first and read it.`);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* +08 is the only clock the owner reads. Times printed by this script are LOCAL
   Malaysia time with the offset spelled out, never bare UTC. */
const my = (v) => {
  if (v === null || v === undefined) return "-";
  const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T") + (/[Zz+]/.test(String(v)) ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return String(v);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " (+08)";
};

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "data", "ac-live-export-manifest.json"), "utf8"));
  log(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${CO} source_doc_no=${SRC_DOC}`);
  log(`AutoCount snapshot: exported ${manifest.exported_at} (+08) from ${manifest.source}; ${manifest.balance_cells} balance cells`);

  // ---- binding + item master (identical predicates to the reconcile) --------
  const { byAc, sofaFurniture } = loadAcBinding(
    fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8"));
  const item = new Map(gz("ac-live-item-master.json.gz").map((r) => [norm(r.ItemCode), r]));
  const groupOf = (ac) => (item.get(norm(ac))?.ItemGroup ?? "").toUpperCase();
  const svcErp = serviceErpCodes(byAc, groupOf);
  /* Binding TARGETS: the ERP codes AutoCount actually speaks about. An ERP cell
     outside this set is not "missing from AutoCount", it is outside AutoCount's
     vocabulary, and the ruling does not reach it. */
  const bindingTargets = new Set([...byAc.values()].filter(Boolean).map(norm));

  // ---- warehouses ----------------------------------------------------------
  const whs = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const whByCode = new Map(whs.map((w) => [String(w.code).toUpperCase(), w]));
  const whName = new Map(whs.map((w) => [String(w.id), w.name]));
  const resolveWh = (loc) => {
    const k = norm(loc);
    return whByCode.get((SALESLOC[k] || k).toUpperCase()) ?? whByCode.get(k) ?? null;
  };
  /* The GOVERNED warehouses come from the MAP, not from the data: a branch where
     AutoCount happens to hold nothing tonight must still be re-seeded to zero,
     and a branch AutoCount does not model must not be touched at all. */
  const governedWh = new Set();
  for (const k of Object.keys(SALESLOC)) { const w = resolveWh(k); if (w) governedWh.add(String(w.id)); }
  /* Plus any warehouse an AutoCount location in tonight's file actually resolves
     to. resolveWh falls back to a bare warehouse-code match, so a location can be
     mapped without appearing in SALESLOC — and if AutoCount states a balance for
     a branch, it states ALL of that branch, including the cells it says are
     empty. Leaving those out would seed the branch's additions while refusing its
     subtractions, which is not "用今晚的结存为准" but a top-up wearing its name. */
  for (const r of gz("ac-live-stock-balance.json.gz")) {
    const w = resolveWh(r.Location);
    if (w) governedWh.add(String(w.id));
  }
  log(`governed warehouses: ${[...governedWh].map((id) => whName.get(id)).join(", ")}`);
  const ungoverned = whs.filter((w) => !governedWh.has(String(w.id)));
  log(`warehouses AutoCount does not speak about, left entirely alone: ${ungoverned.length ? ungoverned.map((w) => w.name).join(", ") : "(none)"}`);

  // ================= AutoCount side — the authority =========================
  const bal = gz("ac-live-stock-balance.json.gz");
  const acCell = new Map();
  const held = { sofa: 0, service: 0, unmappedItem: 0, unmappedWh: 0 };
  const unmappedWhLoc = new Map();
  for (const r of bal) {
    if (!r.BalQty) continue;
    if (SERVICE_GROUPS.has(groupOf(r.ItemCode))) { held.service += r.BalQty; continue; }
    if (sofaFurniture.has(norm(r.ItemCode))) { held.sofa += r.BalQty; continue; }
    const erp = byAc.get(norm(r.ItemCode));
    if (!erp) { held.unmappedItem += r.BalQty; continue; }
    /* An ERP code with unbalanced parentheses is a truncated 30-char AutoCount
       code that leaked through the mapping (docs/bugs/0567). Creating stock
       under it would mint a garbage product code — refuse loudly, as the
       original importer does. */
    if ((erp.match(/\(/g) ?? []).length !== (erp.match(/\)/g) ?? []).length) {
      held.unmappedItem += r.BalQty;
      log(`  REFUSED unbalanced-paren ERP code for AC ${r.ItemCode}: ${JSON.stringify(erp)} — fix the mapping row`);
      continue;
    }
    const wh = resolveWh(r.Location);
    if (!wh) {
      held.unmappedWh += r.BalQty;
      unmappedWhLoc.set(norm(r.Location), (unmappedWhLoc.get(norm(r.Location)) ?? 0) + r.BalQty);
      continue;
    }
    const k = `${norm(erp)}|${wh.id}`;
    acCell.set(k, (acCell.get(k) ?? 0) + Number(r.BalQty));
  }
  log(`AutoCount governable cells: ${acCell.size}`);
  log(`  held out — sofa furniture ${held.sofa} units (owner ruling 2: storage stays piece-level); service pseudo-items ${held.service}; unmapped item ${held.unmappedItem}; unmapped warehouse ${held.unmappedWh}`);
  for (const [l, q] of unmappedWhLoc) log(`  UNMAPPED LOCATION ${l}: ${q} units have no ERP warehouse — untouched`);

  // ================= ERP side — current on-hand =============================
  /* scm.inventory_balances, the VIEW, never a naive SUM(qty) over movements:
     the view carries the IN/OUT/ADJUSTMENT/TRANSFER sign arithmetic and a naive
     sum gets OUT backwards (erp-integrity-audit-2026-08-18). */
  const erpBal = await sql`SELECT b.item_code, b.warehouse_id, b.variant_key, SUM(b.qty)::int qty,
      bool_or(UPPER(COALESCE(p.category::text,'')) = 'SOFA') AS is_sofa
    FROM scm.inventory_balances b
    LEFT JOIN scm.mfg_products p ON p.code = b.item_code AND p.company_id = ${CO}
   WHERE b.company_id = ${CO}
   GROUP BY b.item_code, b.warehouse_id, b.variant_key`;

  /* The pre-overwrite dump, off-database, BEFORE anything is written and in
     BOTH modes. Variant-grained, because that is the grain the ERP stores at
     and a restore has to put the units back where they were. */
  const dump = {
    taken_at_utc: new Date().toISOString(),
    company_id: CO,
    source_doc_no: SRC_DOC,
    ac_snapshot_exported_at: manifest.exported_at,
    note: "Pre-overwrite ERP inventory balance. To restore, use these quantities as the target: delta = target - current.",
    cells: erpBal.map((r) => ({
      item_code: r.item_code, warehouse_id: r.warehouse_id,
      warehouse_name: whName.get(String(r.warehouse_id)) ?? null,
      variant_key: r.variant_key ?? "", qty: Number(r.qty),
    })),
  };
  fs.writeFileSync(DUMP_PATH, JSON.stringify(dump, null, 1));
  log(`pre-overwrite balance dumped: ${dump.cells.length} cells -> ${DUMP_PATH} (${Math.round(fs.statSync(DUMP_PATH).size / 1024)} KB)`);

  /* On-hand per (item, warehouse), summed across variant keys — the grain the
     AutoCount balance is stated at, and the grain the original importer wrote
     its adjustments at. A cell whose stock is split across variant keys is
     corrected at variant_key='' exactly as the cutover import did; changing
     that here would fragment the very cells this run is meant to settle. */
  const cellsErp = new Map();
  const sofaCell = new Set(), svcCell = new Set();
  for (const r of erpBal) {
    const k = `${norm(r.item_code)}|${r.warehouse_id}`;
    if (r.is_sofa) { sofaCell.add(k); continue; }
    if (svcErp.has(norm(r.item_code))) { svcCell.add(k); continue; }
    cellsErp.set(k, (cellsErp.get(k) ?? 0) + Number(r.qty));
  }
  log(`ERP side, same exclusions: ${sofaCell.size} sofa cells and ${svcCell.size} service cells held out`);

  // ================= SAFETY CHECK — ERP-only movements ======================
  /* The seeding window, read from the rows rather than from a runbook date. */
  const [cut] = await sql`SELECT COUNT(*)::int n, COALESCE(SUM(qty),0)::int units,
      MIN(created_at) first_at, MAX(created_at) last_at
    FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_type = 'AC_CUTOVER'`;
  log("");
  log("=== SAFETY CHECK — stock that moved only in the ERP =====================");
  log(`existing AC_CUTOVER seeding movements: ${cut.n} (${cut.units} units), ${my(cut.first_at)} .. ${my(cut.last_at)}`);

  const seedEnd = cut.last_at;
  const erpOnlyMoves = seedEnd
    ? await sql`SELECT id, created_at, item_code, warehouse_id, variant_key, movement_type,
          qty, source_doc_type, source_doc_no, notes
        FROM scm.inventory_movements
       WHERE company_id = ${CO}
         AND created_at > ${seedEnd}
         AND source_doc_type IS DISTINCT FROM 'AC_CUTOVER'
       ORDER BY created_at`
    : [];
  const erpOnlyUnits = erpOnlyMoves.reduce((s, r) => s + Math.abs(Number(r.qty)), 0);
  log(`ERP stock movements after the seeding finished that are NOT the seeding itself: ${erpOnlyMoves.length} (${erpOnlyUnits} units absolute)`);
  for (const r of erpOnlyMoves.slice(0, 200)) {
    log(`   ${my(r.created_at)}  ${r.movement_type} ${r.qty > 0 ? "+" : ""}${r.qty}  ${r.item_code} @ ${whName.get(String(r.warehouse_id)) ?? r.warehouse_id}  ${r.source_doc_type ?? "(null)"} ${r.source_doc_no ?? ""}`);
  }
  if (erpOnlyMoves.length > 200) log(`   ... and ${erpOnlyMoves.length - 200} more`);
  if (erpOnlyMoves.length === 0) {
    log("   -> NONE. Overwriting erases nothing that exists only in the ERP.");
  } else {
    log("   -> these movements exist ONLY in the ERP. Overwriting the balance ERASES their effect.");
  }

  /* Second reading of the same question, on the owner's calendar rather than on
     the seeding timestamp, because the two can disagree and both are cheap. */
  const [since829] = await sql`SELECT COUNT(*)::int n, COALESCE(SUM(ABS(qty)),0)::int units
    FROM scm.inventory_movements
   WHERE company_id = ${CO} AND created_at >= TIMESTAMPTZ '2026-08-29 00:00:00+08'
     AND source_doc_type IS DISTINCT FROM 'AC_CUTOVER'`;
  log(`same question on the calendar: non-seeding movements since 2026-08-29 00:00 (+08): ${since829.n} (${since829.units} units absolute)`);

  // ================= THE ~22-HOUR BASELINE BIAS =============================
  /* data/ac-seed-baseline-balance.README.md records this as UNKNOWN in size:
     the frozen drift baseline sits at 2026-08-28 23:27 (+08) while the ERP's own
     AC_CUTOVER movements run to 2026-08-29 21:55 (+08). Anything AutoCount posted
     inside that ~22h window was SEEDED into the ERP but reads as drift.
     Measured here, not estimated:
       erpSeeded[cell] = current ERP qty MINUS every movement after seeding
                       = what the ERP held the moment seeding finished
                       = the AutoCount balance at the seeding export's own moment
     so a cell where erpSeeded differs from the frozen baseline is a cell where
     the seeding input and the baseline disagree — which is exactly the bias. */
  log("");
  log("=== THE ~22-HOUR BASELINE BIAS (previously UNKNOWN, measured here) ======");
  const seedCell = new Map();
  for (const r of gz("ac-seed-baseline-balance.json.gz")) {
    if (!r.BalQty) continue;
    if (SERVICE_GROUPS.has(groupOf(r.ItemCode))) continue;
    if (sofaFurniture.has(norm(r.ItemCode))) continue;
    const erp = byAc.get(norm(r.ItemCode)); const wh = resolveWh(r.Location);
    if (!erp || !wh) continue;
    const k = `${norm(erp)}|${wh.id}`;
    seedCell.set(k, (seedCell.get(k) ?? 0) + Number(r.BalQty));
  }
  const postSeed = new Map();
  for (const r of erpOnlyMoves) {
    const k = `${norm(r.item_code)}|${r.warehouse_id}`;
    const signed = r.movement_type === "OUT" ? -Number(r.qty) : Number(r.qty);
    postSeed.set(k, (postSeed.get(k) ?? 0) + signed);
  }
  let biasCells = 0, biasUnits = 0;
  const biasRows = [];
  for (const k of new Set([...seedCell.keys(), ...cellsErp.keys()])) {
    const seeded = Math.round(seedCell.get(k) ?? 0);
    const erpSeeded = (cellsErp.get(k) ?? 0) - (postSeed.get(k) ?? 0);
    if (seeded !== erpSeeded) {
      biasCells++; biasUnits += Math.abs(erpSeeded - seeded);
      biasRows.push({ k, seeded, erpSeeded, d: erpSeeded - seeded });
    }
  }
  log(`cells where the ERP's seeded quantity differs from the frozen 2026-08-28 23:27 (+08) baseline: ${biasCells} (${biasUnits} units absolute)`);
  log("   Every one of these is a cell the reconcile could mis-bucket: the ERP already carries AutoCount activity that the baseline predates, so the drift test calls it 'both moved' when only AutoCount moved.");
  for (const r of biasRows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 25)) {
    const [code, whId] = r.k.split("|");
    log(`   ${code} @ ${whName.get(whId) ?? whId}: baseline ${r.seeded} vs ERP-as-seeded ${r.erpSeeded} (${r.d > 0 ? "+" : ""}${r.d})`);
  }
  if (biasRows.length > 25) log(`   ... and ${biasRows.length - 25} more`);

  // ================= THE PLAN ==============================================
  log("");
  log("=== PLAN — one ADJUSTMENT per disagreeing cell =========================");
  /* Cost for a positive delta, exactly the chain the cutover importer used:
     AutoCount UTDStockCost.AverageCost -> ItemUOM cost -> ERP product cost -> 0.
     A zero-cost lot is REPORTED, never invented: backfill-zero-cost-lots.mjs
     owns that fallback. */
  const utdCost = new Map();
  for (const r of gz("ac-utd-stock-cost.json.gz")) {
    if (!(r.UTDQty > 0)) continue;
    const c = r.AverageCost ?? (r.UTDCost / r.UTDQty);
    if (c > 0 && !utdCost.has(norm(r.ItemCode))) utdCost.set(norm(r.ItemCode), c);
  }
  const iucCost = new Map();
  for (const r of gz("ac-item-costs.json.gz")) {
    const c = r.RealCost || r.Cost || r.RecentCost;
    if (c > 0 && !iucCost.has(norm(r.ItemCode))) iucCost.set(norm(r.ItemCode), c);
  }
  /* An ERP code can be the target of several AutoCount codes (the DIVAN ONLY
     supplier families, the HOK/NB bedframe twins). Cost rides the first AC code
     that has one — the same convention the cutover importer used. */
  const costByErp = new Map();
  for (const [ac, erp] of byAc) {
    if (!erp) continue;
    const rm = utdCost.get(ac) ?? iucCost.get(ac) ?? 0;
    if (rm > 0 && !costByErp.has(norm(erp))) costByErp.set(norm(erp), rm);
  }

  const prodCols = (await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='scm' AND table_name='mfg_products'`).map((r) => r.column_name);
  const costCol = ["cost_sen", "unit_cost_sen", "base_cost_sen"].find((c) => prodCols.includes(c));
  const prods = await sql.unsafe(
    `SELECT code, name${costCol ? `, ${costCol} AS cost_sen` : ""} FROM scm.mfg_products WHERE company_id = $1`, [CO]);
  const prodBy = new Map(prods.map((p) => [norm(p.code), p]));

  /* The write universe: every AutoCount governable cell, PLUS every ERP cell
     AutoCount has vocabulary for (a binding target, in a governed warehouse).
     The second half is what makes this an OVERWRITE rather than a top-up —
     stock the ERP holds and AutoCount does not goes to zero. */
  const universe = new Set(acCell.keys());
  const untouched = [];
  for (const k of cellsErp.keys()) {
    const [code, whId] = k.split("|");
    if (acCell.has(k)) continue;
    if (bindingTargets.has(code) && governedWh.has(String(whId))) universe.add(k);
    else if (cellsErp.get(k) !== 0) untouched.push({ code, whId, qty: cellsErp.get(k),
      why: !bindingTargets.has(code) ? "no AutoCount item maps to this ERP code" : "warehouse is not an AutoCount location" });
  }
  log(`ERP cells left alone because AutoCount has no opinion on them: ${untouched.length} (${untouched.reduce((s, r) => s + Math.abs(r.qty), 0)} units absolute)`);
  for (const r of untouched.sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty)).slice(0, 25)) {
    log(`   LEFT ALONE ${r.code} @ ${whName.get(r.whId) ?? r.whId}: ERP ${r.qty} — ${r.why}`);
  }
  if (untouched.length > 25) log(`   ... and ${untouched.length - 25} more`);

  const plan = [];
  for (const k of universe) {
    const [code, whId] = k.split("|");
    const target = Math.round(acCell.get(k) ?? 0);   // COPIED, never computed
    const cur = cellsErp.get(k) ?? 0;
    const delta = target - cur;
    if (delta === 0) continue;
    const p = prodBy.get(code);
    const rm = costByErp.get(code) ?? 0;
    const costSen = rm > 0 ? Math.round(rm * 100) : (p?.cost_sen ?? 0);
    plan.push({ k, code, whId, wh: whName.get(whId) ?? whId, target, cur, delta,
      costSen, name: p?.name ?? code, known: !!p });
  }
  const pos = plan.filter((p) => p.delta > 0), neg = plan.filter((p) => p.delta < 0);
  const zeroCost = pos.filter((p) => p.costSen === 0).length;
  const unknownProd = plan.filter((p) => !p.known);
  log("");
  log(`cells in the governed universe: ${universe.size} | already agree: ${universe.size - plan.length} | to adjust: ${plan.length}`);
  log(`  positive ${pos.length} cells / +${pos.reduce((s, p) => s + p.delta, 0)} units (zero-cost lots: ${zeroCost})`);
  log(`  negative ${neg.length} cells / ${neg.reduce((s, p) => s + p.delta, 0)} units`);
  if (unknownProd.length) {
    log(`  ${unknownProd.length} cell(s) name an ERP code with no scm.mfg_products row for company ${CO} — listed, and adjusted anyway because the movement ledger, not the product table, is what the balance reads:`);
    for (const p of unknownProd.slice(0, 15)) log(`     UNKNOWN PRODUCT ${p.code} @ ${p.wh} (AutoCount ${p.target}, ERP ${p.cur})`);
  }
  /* VARIANT-KEY GRAIN, reported because it is the one way a negative delta can
     land somewhere the stock is not. The adjustment is written at variant_key=''
     — the grain the cutover import used and the grain the AutoCount balance is
     stated at — while the FIFO consume is keyed on variant_key. A negative delta
     on a cell whose stock sits under a NON-empty variant key therefore consumes
     nothing and leaves a negative '' row beside a positive one. The cell TOTAL,
     which is what both the reconcile and AutoCount read, stays correct either
     way; this counts how often the split would happen at all. */
  const variantSplit = new Map();
  for (const r of erpBal) {
    if (r.is_sofa || svcErp.has(norm(r.item_code))) continue;
    if (!String(r.variant_key ?? "")) continue;
    if (Number(r.qty) === 0) continue;
    const k = `${norm(r.item_code)}|${r.warehouse_id}`;
    variantSplit.set(k, (variantSplit.get(k) ?? 0) + Number(r.qty));
  }
  const negSplit = neg.filter((p) => variantSplit.has(p.k));
  log(`  negative-delta cells whose ERP stock sits under a NON-empty variant key: ${negSplit.length} (the cell total still lands on AutoCount's number; only the per-variant split is left uneven)`);
  for (const p of negSplit.slice(0, 15)) log(`     VARIANT SPLIT ${p.code} @ ${p.wh}: ${variantSplit.get(p.k)} units under a named variant, delta ${p.delta}`);

  log("");
  log(`largest adjustments (max ${TOP}):`);
  for (const p of [...plan].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, TOP)) {
    log(`   ${p.delta > 0 ? "+" : ""}${String(p.delta).padStart(6)}  ${p.code} @ ${p.wh}: AutoCount ${p.target} vs ERP ${p.cur}  cost ${(p.costSen / 100).toFixed(2)} RM`);
  }

  if (!APPLY) {
    log("");
    log(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    if (erpOnlyMoves.length) log("   NOTE: ERP-only movements exist. APPLY will refuse unless ACK_ERP_ONLY_MOVEMENTS=1 is set by a person who has read them above.");
    return;
  }

  /* THE REFUSAL. Not a warning — a stop. Overwriting is irreversible in effect
     even though the dump makes it reversible in arithmetic, and a movement that
     exists only in the ERP is a shipment or receipt nobody else recorded. */
  if (erpOnlyMoves.length && !ACK_ERP_ONLY) {
    bad(`REFUSING TO APPLY: ${erpOnlyMoves.length} stock movement(s) exist only in the ERP since seeding (listed above). ` +
        `Overwriting erases their effect. A person must read them and re-run with ACK_ERP_ONLY_MOVEMENTS=1.`);
  }

  const mvCols = (await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='scm' AND table_name='inventory_movements'`).map((r) => r.column_name);
  const hasCo = mvCols.includes("company_id");
  let done = 0;
  for (const p of plan) {
    const cols = ["movement_type", "warehouse_id", "item_code", "product_name", "variant_key",
      "qty", "unit_cost_sen", "source_doc_type", "source_doc_no", "notes"];
    const vals = ["'ADJUSTMENT'", "$4", "$1", "$2", "''", `${p.delta}`, `${p.costSen}`,
      "'AC_CUTOVER'", "$5", "$3"];
    if (hasCo) { cols.push("company_id"); vals.push(String(CO)); }
    await sql.unsafe(
      `INSERT INTO scm.inventory_movements (${cols.join(",")}) VALUES (${vals.join(",")})`,
      [p.code, p.name, `AutoCount ${manifest.exported_at} (+08) balance ${p.target} vs ERP ${p.cur} — go-live re-seed`,
       p.whId, SRC_DOC]);
    done++;
    if (done % 100 === 0) log(`  ..${done}/${plan.length}`);
  }
  log(`wrote ${done} adjustment movement(s)`);

  /* ── INDEPENDENT READ-BACK ────────────────────────────────────────────────
     A FRESH connection, and it asserts the SHAPE, not a row count. "997 of 997
     rows written" would have been just as true of a run that wrote every
     quantity into the wrong cell — a repair once reproduced the jsonb
     double-encoding bug on 7 production rows while its row count reported 7 of
     7. The shape asserted here is the only one that matters: for EVERY cell in
     the governed universe, the ERP's on-hand must now equal the number
     AutoCount holds, to the unit. */
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const after = await check`SELECT b.item_code, b.warehouse_id, SUM(b.qty)::int qty
      FROM scm.inventory_balances b
     WHERE b.company_id = ${CO} GROUP BY b.item_code, b.warehouse_id`;
    const afterBy = new Map(after.map((r) => [`${norm(r.item_code)}|${r.warehouse_id}`, Number(r.qty)]));
    let ok = 0; const wrong = [];
    for (const k of universe) {
      const want = Math.round(acCell.get(k) ?? 0);
      const got = afterBy.get(k) ?? 0;
      if (got === want) ok++; else wrong.push({ k, want, got });
    }
    log(`VERIFY (fresh connection, SHAPE): ${ok}/${universe.size} governed cells now hold exactly what AutoCount holds`);
    for (const w of wrong.slice(0, 25)) {
      const [code, whId] = w.k.split("|");
      log(`   SHAPE MISMATCH ${code} @ ${whName.get(whId) ?? whId}: AutoCount ${w.want}, ERP reads back ${w.got}`);
    }
    if (wrong.length) {
      bad(`VERIFY FAILED: ${wrong.length} governed cell(s) do not equal the AutoCount balance after the re-seed. The pre-overwrite dump is at ${DUMP_PATH}.`);
    }
    /* Second half of the shape: nothing OUTSIDE the universe moved. The sofa
       cells in particular must be byte-identical — owner ruling 2 says the
       storage model does not change. */
    const before = new Map();
    for (const r of erpBal) {
      const k = `${norm(r.item_code)}|${r.warehouse_id}`;
      before.set(k, (before.get(k) ?? 0) + Number(r.qty));
    }
    const collateral = [];
    for (const [k, q] of before) {
      if (universe.has(k)) continue;
      const got = afterBy.get(k) ?? 0;
      if (got !== q) collateral.push({ k, was: q, now: got });
    }
    log(`VERIFY (fresh connection, SHAPE): ${collateral.length} cell(s) outside the governed universe changed — sofa, service and unmapped stock must be untouched`);
    for (const c of collateral.slice(0, 25)) {
      const [code, whId] = c.k.split("|");
      log(`   COLLATERAL ${code} @ ${whName.get(whId) ?? whId}: was ${c.was}, now ${c.now}`);
    }
    if (collateral.length) bad("VERIFY FAILED: stock changed outside the governed universe.");
    log("verify OK — every governed cell equals AutoCount, and nothing outside it moved.");
  } finally {
    await check.end({ timeout: 5 });
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => sql.end({ timeout: 5 }));
