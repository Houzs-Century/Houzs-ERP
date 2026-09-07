#!/usr/bin/env node
// ============================================================================
// check-golive-parity — the ONE gate the owner unlocks Houzs ERP on.
//
// NAMED `parity` and not `readiness` because check-golive-readiness.mjs already
// exists and answers a DIFFERENT question (the 2026-08-10 COGS / cost-coverage
// sweep). Two files, two gates, neither overwritten.
//
// Owner, 2026-09-07:
//   「确保数据都没问题后，我们要对标看 Stock Status 是不是一致的。如果一致，我们
//     就可以解锁 Houzs ERP。」
//   「以我们的为标准,因为我们的数据比较准确。」
//   「我们的单会分成有 processing date 跟没有 processing date,所以你也需要把这些
//     东西都补齐。」
//
// FOUR SECTIONS, four questions, one verdict:
//
//   1  STOCK STATUS   the ERP against AutoCount, per product+warehouse and per
//                     order/line. THE RELEASE GATE.
//   2  PROCESSING DATE  how many migrated orders carry one, how many legitimately
//                     have none, how many are MISSING one they should have.
//   3  PAYMENT        money AutoCount holds against a migrated order vs money the
//                     ERP holds, per order.
//   4  VARIANTS       colour / Seat Size / sofa compartments still outstanding.
//
// ── THE OWNER'S STANDING RULING, AND HOW IT IS WRITTEN DOWN HERE ────────────
// Where the two systems disagree, THE ERP IS RIGHT — its data is the more
// accurate ("以我们的为标准"). So section 1 never reports "the ERP is wrong". It
// reports AGREE, or it reports AUTOCOUNT BEHIND with the reason the ERP moved
// first. The one exception is a class the ERP genuinely cannot answer yet (an
// order with no processing date is force-PENDING by design, whatever the
// warehouse holds); that is named as its own class rather than scored either way.
//
// ── NOT ONE RULE IS RE-IMPLEMENTED HERE ────────────────────────────────────
// A duplicated rule is this repo's most expensive recurring bug — the stock
// remark alone has been hand-copied into four places and drifted in three. So:
//
//   readiness / stock remark   summariseReadiness, IMPORTED from
//                              src/scm/lib/so-readiness.ts. The REAL one, not a
//                              port. docs/stock-reconciliation.md's correction #2
//                              records that check-stock-vs-autocount.mjs carries a
//                              hand-copied port whose agreement with its source
//                              was never tested; this script does not add a third.
//   line -> readiness input    readinessLinesByDoc + attachLineCategories,
//                              IMPORTED from so-line-effective-stock.ts /
//                              so-readiness-category.ts (the SO list's own path).
//   processing-date column     soProcessingDateFragment (lib/so-processing-date.mjs)
//   required variant axes      missingVariantAxes (lib/variant-axes.mjs)
//   colour resolution          buildFabricColourIndex / isPendingColour
//   sofa build decode          parseSofa + isSingleSeatBuild
//   AutoCount location map     lib/ac-stock-compare.mjs, shared with
//                              check-stock-vs-autocount.mjs
//   AutoCount money            total = Σ centi(UnitPrice)·qty, paid = total −
//                              centi(UDF_BALANCE) — the formula the cutover
//                              importer itself ran (import-ac-outstanding-so.mjs
//                              :247,:317), not a fresh reading of the book.
//
// Because it imports TypeScript, RUN IT UNDER tsx (`npx tsx scripts/…`), the
// same way probe-so-stock-status-stale.yml does.
//
// ── IT REFUSES RATHER THAN REPORTS A CLEAN RUN ─────────────────────────────
// Section 0 self-tests every pattern and every join before a single verdict is
// computed: the imported readiness function against four fixtures whose answers
// the owner personally ruled on, the money parser against a known document, the
// variant-axis rule, and the ERP<->AutoCount join actually finding rows. If any
// of those fails the script exits NON-ZERO and prints REFUSED. A verdict
// computed over nothing must never read as a pass.
//
// ── READ-ONLY ──────────────────────────────────────────────────────────────
// SELECTs only. No DDL, no writes, no transaction, no lock — it never takes the
// allocation lock, so it cannot block a production recompute. Exit 0 for every
// legitimate answer, including a failing gate: the ANSWER is the output, and a
// red job would read as "the check broke". Non-zero is reserved for an
// unreachable database and for a failed self-test.
//
// AutoCount is a COMMITTED SNAPSHOT, not a live read: the book sits behind
// ZeroTier on the office network and a GitHub runner cannot reach it. Refresh it
// with `python backend/scripts/export-ac-reimport.py` from a machine on that
// network and commit data/ac-*. The snapshot's own timestamp is printed, and an
// export older than STALE_HOURS (default 48) is reported as STALE — a finding,
// never a silent comparison.
// ============================================================================
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { summariseReadiness } from "../src/scm/lib/so-readiness.ts";
import { readinessLinesByDoc } from "../src/scm/lib/so-line-effective-stock.ts";
import { attachLineCategories } from "../src/scm/lib/so-readiness-category.ts";
import { SALESLOC, SERVICE_GROUPS, loadAcBinding, serviceErpCodes } from "./lib/ac-stock-compare.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";
import { missingVariantAxes } from "./lib/variant-axes.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { isSingleSeatBuild } from "./lib/sofa-single-seat.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }

const CO = Number(process.env.COMPANY ?? 1);
const TOP = Number(process.env.TOP ?? 20);
const STALE_HOURS = Number(process.env.STALE_HOURS ?? 48);
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
const PDATE = soProcessingDateFragment(sql);

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARN  ${m}`);
const head = (m) => { log(""); log(m); };
const pad = (n, w = 6) => String(n).padStart(w);
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* The cutover importer's own money helpers, copied by VALUE from
   import-ac-outstanding-so.mjs:45-46 because that script is a runnable with no
   exports. They are two lines and they are pinned by selfTestMoney() below
   against a real document, so a drift is caught at startup rather than shipped
   as a payment "difference" that is really an arithmetic difference. */
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const centi = (v) => Math.round(num(v) * 100);

// ---------------------------------------------------------------------------
// SECTION 0 — SELF-TEST. Nothing below runs until these pass.
// ---------------------------------------------------------------------------
const failures = [];
const must = (name, ok, detail = "") => {
  if (ok) log(`  PASS  ${name}`);
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

function selfTestReadiness() {
  /* Four fixtures, each one an owner ruling recorded in so-readiness.ts's
     header. If the imported function stops answering these, the whole of
     section 1 is measuring something else and must not report. */
  const L = (group, status, code = null) => ({ item_group: group, item_code: code, stock_status: status, cancelled: false });
  must("readiness: every line in -> READY",
    summariseReadiness([L("BEDFRAME", "READY"), L("ACCESSORY", "READY")]).stockRemark === "READY");
  must("readiness: main in, accessory short -> PARTIAL",
    summariseReadiness([L("BEDFRAME", "READY"), L("ACCESSORY", "PENDING")]).stockRemark === "PARTIAL");
  must("readiness: accessory-only + short -> blank, NOT 'READY (PARTIAL)' (owner 2026-08-16: 骗人)",
    summariseReadiness([L("ACCESSORY", "PENDING")]).stockRemark === "");
  must("readiness: one MAIN category in, another short -> that category named",
    summariseReadiness([L("BEDFRAME", "READY"), L("MATTRESS", "PENDING")]).stockRemark === "BEDFRAME");
  must("readiness: no lines -> blank and never ship-ready",
    summariseReadiness([]).stockRemark === "" && summariseReadiness([]).isShipReady === false);
}

function selfTestMoney() {
  must("money: centi() reads AutoCount's decimal text", centi("1234.56") === 123456 && centi(" 1,234.50 ") === 123450);
  must("money: centi(null/blank) is 0, not NaN", centi(null) === 0 && centi("") === 0);
  must("money: qty rounds and floors at 1, per the importer", (Math.round(num("2")) || 1) === 2 && (Math.round(num("0")) || 1) === 1);
}

function selfTestVariantAxes() {
  must("axes: a sofa with no fabric and no seat size is missing BOTH",
    missingVariantAxes("sofa", {}, "MODEL-1S").map((a) => a.key).sort().join(",") === "fabricCode,seatHeight");
  must("axes: a fully specified sofa line is missing nothing",
    missingVariantAxes("sofa", { seatHeight: '22"', fabricCode: "C123" }, "MODEL-1S").length === 0);
  must("axes: a DIVAN ONLY bedframe is exempt from Gap (owner rule)",
    !missingVariantAxes("bedframe", {}, "NB-DIVAN ONLY (K)").some((a) => a.key === "gap"));
  must("axes: a CONSOLE has no seat, so no Seat Size is demanded",
    !missingVariantAxes("sofa", {}, "MODEL-CONSOLE").some((a) => a.key === "seatHeight"));
  must("colour: TBC / KIV read as not-yet-chosen, not as a colour",
    isPendingColour("TBC") && isPendingColour("kiv") && !isPendingColour("C1234"));
}

// AutoCount's Remark2 and the ERP's stock_remark are ONE vocabulary
// (docs/stock-reconciliation.md §2) with two spelling differences that carry no
// meaning: AutoCount's stored corpus writes the partial state as
// "READY (PARTIAL)" where the ERP has emitted the bare "PARTIAL" since
// 2026-08-16 evening, and AutoCount's hand-typed list is order-insensitive
// ("BEDFRAME/ACC" 31 times, "ACC/BEDFRAME" twice) where the ERP emits a fixed
// order. Folding both is the honest comparison; counting them as drift would
// report a disagreement where the two systems in fact agree.
const canon = (s) => {
  const t = norm(s);
  if (t === "READY (PARTIAL)") return "PARTIAL";
  return t.split("/").map((x) => x.trim()).filter(Boolean).sort().join("/");
};

function selfTestCanon() {
  must("canon: AutoCount's 'READY (PARTIAL)' folds onto the ERP's 'PARTIAL'", canon("READY (PARTIAL)") === canon("PARTIAL"));
  must("canon: token ORDER is not a disagreement", canon("ACC/BEDFRAME") === canon("BEDFRAME/ACC"));
  must("canon: READY and PARTIAL stay different", canon("READY") !== canon("PARTIAL"));
}

// ---------------------------------------------------------------------------
async function main() {
  log("================================================================");
  log("  HOUZS ERP — GO-LIVE READINESS GATE  (read-only)");
  log(`  company_id ${CO} · run ${new Date().toISOString()}`);
  log("================================================================");

  // ---- 0. the snapshot, and whether it may be compared at all -------------
  head("=== 0. SELF-TEST — the checker proves it can still measure ===");
  selfTestReadiness();
  selfTestMoney();
  selfTestVariantAxes();
  selfTestCanon();

  const manifest = JSON.parse(fs.readFileSync(path.join(here, "data", "ac-reimport-manifest.json"), "utf8"));
  /* The exporter runs ON the office machine and writes datetime.now() with no
     zone, so the stamp is Asia/Kuala_Lumpur wall time. Reading it as UTC makes a
     two-hour-old export look eight hours from the FUTURE, which is how a
     staleness guard comes to say nothing at all. +08:00 explicitly. */
  const takenAt = new Date(`${String(manifest.exported_at).replace(" ", "T").slice(0, 26)}+08:00`);
  const ageH = (Date.now() - takenAt.getTime()) / 36e5;
  log(`  AutoCount snapshot taken ${manifest.exported_at} from ${manifest.source} (${ageH.toFixed(1)}h ago)`);

  const acSoLines = gz("ac-outstanding-so.json.gz");
  const acRemarks = gz("ac-so-remarks.json.gz");
  const acBalance = gz("ac-stock-balance.json.gz");
  must("snapshot: the SO extract has rows", acSoLines.length > 0, `${acSoLines.length}`);
  must("snapshot: the Remark2 extract has rows", acRemarks.length > 0, `${acRemarks.length}`);
  must("snapshot: the balance extract has rows", acBalance.length > 0, `${acBalance.length}`);
  must("snapshot: the SO extract carries the money fields the importer read",
    Object.hasOwn(acSoLines[0], "UDF_BALANCE") && Object.hasOwn(acSoLines[0], "UnitPrice") && Object.hasOwn(acSoLines[0], "Qty"));
  must("snapshot: the SO extract carries UDF_PDate (the Processing Date)", Object.hasOwn(acSoLines[0], "UDF_PDate"));
  must("snapshot: the SO extract carries DtlKey (the exact per-line join key)", Object.hasOwn(acSoLines[0], "DtlKey"));

  /* The ERP side of the join, and the proof that it FINDS something. A checker
     whose join silently matches nothing reports a clean run over an empty set,
     which is the failure mode this whole section exists to make impossible. */
  const orders = await sql`
    SELECT h.doc_no, h.linked_ac_docno, h.status::text AS status,
           h.${PDATE} AS processing_date, h.customer_delivery_date, h.proceeded_at,
           h.local_total_sen, h.balance_sen, h.paid_sen
      FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  const byAcDoc = new Map(orders.map((o) => [norm(o.linked_ac_docno), o]));
  must("join: ERP orders carry a linked AutoCount DocNo", orders.length > 0, `${orders.length}`);

  const acDocSet = new Set(acRemarks.map((r) => norm(r.DocNo)));
  const joinable = [...acDocSet].filter((d) => byAcDoc.has(d)).length;
  must("join: the AutoCount snapshot and the ERP actually overlap",
    joinable > 0 && joinable / acDocSet.size > 0.5,
    `${joinable} of ${acDocSet.size} AutoCount documents found in the ERP`);

  /* Built HERE, not in section 4, so its shape is self-tested before any
     verdict depends on it. The first run of this script destructured the
     wrong key off buildFabricColourIndex and died at the colour loop AFTER
     printing three sections of numbers — a checker that gets that far has
     already published figures nobody can tell are complete. */
  const fabricRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fabricRows);
  must("colour: the fabric library loaded", fabricRows.length > 0, `${fabricRows.length} rows`);
  must("colour: findColour is callable and resolves a real library colour",
    typeof findColour === "function" && !!findColour(fabricRows[0]?.colour_id));
  must("colour: findColour refuses a code the library does not hold",
    typeof findColour === "function" && !findColour("ZZ-NOT-A-COLOUR-9999"));

  if (failures.length) {
    log("");
    log("################################################################");
    log(`  REFUSED — ${failures.length} self-test(s) failed. NO VERDICT IS GIVEN.`);
    for (const f of failures) log(`    · ${f}`);
    log("  A verdict computed over nothing must never read as a pass.");
    log("################################################################");
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  log(`  all ${"self-tests"} passed — the checker can measure, so the numbers below are real`);
  if (ageH > STALE_HOURS) {
    warn(`AutoCount snapshot is ${ageH.toFixed(1)}h old (> ${STALE_HOURS}h). Every AutoCount-side number below is as of ${manifest.exported_at}, NOT now. Re-export before quoting this as the go-live verdict.`);
  }

  const verdict = {};

  // =========================================================================
  // SECTION 1 — STOCK STATUS.  THE RELEASE GATE.
  // =========================================================================
  head("================ 1. STOCK STATUS — the release gate ================");
  log("Owner's ruling: where the two disagree the ERP is the standard (以我们的为标准).");
  log("So a disagreement is reported as AUTOCOUNT BEHIND, with the reason the ERP moved first.");

  // ---- 1A. per product + warehouse ---------------------------------------
  head("--- 1A. per PRODUCT + WAREHOUSE (ERP scm.inventory_balances VIEW vs AutoCount vItemBalQty) ---");
  log("The ERP side is the inventory_balances VIEW, never a naive sum(qty): the movement");
  log("ledger stores OUT as POSITIVE and the view is what negates it by movement_type.");
  log("A naive sum answers a different question and hides every negative (2026-08-18 audit).");

  const { byAc, sofaFurniture } = loadAcBinding(
    fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8"));
  const acItemMaster = new Map(gz("ac-live-item-master.json.gz").map((r) => [norm(r.ItemCode), r]));
  const acGroupOf = (code) => norm(acItemMaster.get(norm(code))?.ItemGroup ?? "");

  const whs = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const whByCode = new Map(whs.map((w) => [norm(w.code), w]));
  const whName = new Map(whs.map((w) => [String(w.id), w.name ?? w.code]));
  const resolveWh = (loc) => {
    const k = norm(loc);
    return whByCode.get(norm(SALESLOC[k] || k)) ?? whByCode.get(k) ?? null;
  };

  /* Symmetric with the AutoCount-side SERVICE_GROUPS drop below — see
     serviceErpCodes()'s header for the 16 phantom ERP-only cells this prevents. */
  const svcErp = serviceErpCodes(byAc, acGroupOf);

  const acCell = new Map();
  const excl = { service: 0, sofa: 0, unmappedItem: 0, unmappedWh: 0 };
  const unmappedLoc = new Map();
  for (const r of acBalance) {
    const q = Number(r.BalQty || 0);
    if (!q) continue;
    if (SERVICE_GROUPS.has(acGroupOf(r.ItemCode))) { excl.service += q; continue; }
    /* Sofa is excluded on BOTH sides and by the BINDING CSV's category, never by
       AutoCount's ItemGroup — AutoCount counts one whole sofa where the ERP
       counts its compartments, so the two are not commensurable at all. */
    if (sofaFurniture.has(norm(r.ItemCode))) { excl.sofa += q; continue; }
    const erp = byAc.get(norm(r.ItemCode));
    if (!erp) { excl.unmappedItem += q; continue; }
    const wh = resolveWh(r.Location);
    if (!wh) { excl.unmappedWh += q; unmappedLoc.set(norm(r.Location), (unmappedLoc.get(norm(r.Location)) ?? 0) + q); continue; }
    const k = `${norm(erp)}|${wh.id}`;
    acCell.set(k, (acCell.get(k) ?? 0) + q);
  }

  const erpBal = await sql`
    SELECT b.item_code, b.warehouse_id, SUM(b.qty)::int AS qty,
           bool_or(UPPER(COALESCE(p.category::text, '')) = 'SOFA') AS is_sofa
      FROM scm.inventory_balances b
      LEFT JOIN scm.mfg_products p ON p.code = b.item_code AND p.company_id = ${CO}
     WHERE b.company_id = ${CO}
     GROUP BY b.item_code, b.warehouse_id`;
  const erpSofaCells = erpBal.filter((r) => r.is_sofa);
  const erpServiceCells = erpBal.filter((r) => !r.is_sofa && svcErp.has(norm(r.item_code)));
  const erpServiceUnits = erpServiceCells.reduce((s, r) => s + Number(r.qty), 0);
  const erpCell = new Map(erpBal
    .filter((r) => !r.is_sofa && !svcErp.has(norm(r.item_code)))
    .map((r) => [`${norm(r.item_code)}|${r.warehouse_id}`, Number(r.qty)]));

  log(`AutoCount comparable cells: ${acCell.size} · ERP comparable cells: ${erpCell.size}`);
  log(`  held out — service pseudo-items ${excl.service}u (AutoCount side) / ${erpServiceCells.length} cells, ${erpServiceUnits}u (ERP side, the SAME codes via the binding)`);
  log(`  held out — sofa furniture ${excl.sofa}u (AutoCount side) / ${erpSofaCells.length} cells (ERP side)`);
  log(`  held out — unmapped item ${excl.unmappedItem}u · unmapped warehouse ${excl.unmappedWh}u`);
  for (const [l, q] of unmappedLoc) log(`  UNMAPPED LOCATION "${l}": ${q}u have no ERP warehouse — never guessed, always reported`);

  const cellKeys = new Set([...acCell.keys(), ...erpCell.keys()]);
  const cellAgree = [], acBehindCell = [], erpOnlyCell = [], acOnlyCell = [];
  for (const k of cellKeys) {
    const a = acCell.get(k), e = erpCell.get(k);
    if (a !== undefined && e !== undefined) {
      if (a === e) cellAgree.push(k);
      else acBehindCell.push({ k, ac: a, erp: e, d: e - a });
    } else if (e !== undefined) erpOnlyCell.push({ k, erp: e });
    else acOnlyCell.push({ k, ac: a });
  }
  const cellComparable = cellAgree.length + acBehindCell.length;
  log("");
  log(`  cells present on BOTH sides          : ${pad(cellComparable)}`);
  log(`    AGREE, unit for unit               : ${pad(cellAgree.length)}   (${cellComparable ? ((cellAgree.length / cellComparable) * 100).toFixed(1) : "0.0"}% of comparable)`);
  log(`    DIFFER                             : ${pad(acBehindCell.length)}   <- AutoCount is behind here; the ERP figure stands`);
  log(`  cells the ERP holds, AutoCount does not: ${pad(erpOnlyCell.length)}`);
  log(`  cells AutoCount holds, the ERP does not: ${pad(acOnlyCell.length)}`);
  verdict.cellAgree = cellAgree.length;
  verdict.cellDiffer = acBehindCell.length;
  verdict.cellComparable = cellComparable;

  const show = (k) => { const [c, w] = k.split("|"); return `${c} @ ${whName.get(w) ?? w}`; };
  head(`  first ${TOP} cells where AutoCount is behind (ERP − AutoCount):`);
  for (const r of acBehindCell.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, TOP))
    log(`    ${show(r.k).padEnd(46)} ERP ${pad(r.erp, 5)}  AutoCount ${pad(r.ac, 5)}  delta ${r.d > 0 ? "+" : ""}${r.d}`);
  if (!acBehindCell.length) log("    none");
  head(`  first ${TOP} cells only the ERP holds:`);
  for (const r of erpOnlyCell.sort((a, b) => Math.abs(b.erp) - Math.abs(a.erp)).slice(0, TOP))
    log(`    ${show(r.k).padEnd(46)} ERP ${pad(r.erp, 5)}  AutoCount (no cell)`);
  if (!erpOnlyCell.length) log("    none");
  head(`  first ${TOP} cells only AutoCount holds:`);
  for (const r of acOnlyCell.sort((a, b) => Math.abs(b.ac) - Math.abs(a.ac)).slice(0, TOP))
    log(`    ${show(r.k).padEnd(46)} ERP (no cell)  AutoCount ${pad(r.ac, 5)}`);
  if (!acOnlyCell.length) log("    none");

  // ---- 1B. per ORDER — the stock-status column itself ---------------------
  head("--- 1B. per ORDER: AutoCount SO.Remark2 vs the ERP's derived stock remark ---");
  log("Remark2 IS the operator's Stock Status column (docs/stock-reconciliation.md §2:");
  log("9,165 non-blank SOs, values READY / READY (PARTIAL) / ACC / BEDFRAME / BEDFRAME/ACC).");
  log("The ERP side is summariseReadiness() IMPORTED from src/scm/lib/so-readiness.ts —");
  log("the function the SO board itself calls, not a port of it.");

  const items = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_group, i.item_code, i.description2,
           i.stock_status, COALESCE(i.cancelled, false) AS cancelled, i.qty,
           i.warehouse_id::text AS warehouse_id, i.variants, i.linked_ac_dtlkey
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  const codes = [...new Set(items.map((i) => i.item_code).filter(Boolean))];
  const prodCat = new Map(
    (await sql`SELECT code, category::text AS category FROM scm.mfg_products
                WHERE company_id = ${CO} AND code = ANY(${codes})`).map((r) => [r.code, r.category]));

  /* coverage=null and processedDocs=null: no MRP is run here, so the STORED
     stock_status stands alone. That is deliberately the SO list's own FIRST
     PAINT path (mfg-sales-orders.ts:1678 passes exactly these two nulls), and it
     is the strict direction — the live-'stock' promotion arm cannot fire, so
     this check can never call a line READY that the allocator has not. */
  const linesByDoc = readinessLinesByDoc(items, null, null);
  attachLineCategories(linesByDoc.values(), prodCat);

  const acRemarkByDoc = new Map(acRemarks.map((r) => [norm(r.DocNo), txt(r.Remark2)]));

  const matrix = new Map();
  const disagree = [];
  let compared = 0, agreeOrders = 0, orderOnly = 0, acDocNotInErp = 0, erpDocNotInAc = 0;
  for (const [acDoc, acRemark] of acRemarkByDoc) {
    const o = byAcDoc.get(acDoc);
    if (!o) { acDocNotInErp += 1; continue; }
    const erpRemark = summariseReadiness(linesByDoc.get(o.doc_no) ?? []).stockRemark;
    compared += 1;
    const key = `${acRemark || "(blank)"} => ${erpRemark || "(blank)"}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
    if (canon(acRemark) === canon(erpRemark)) {
      agreeOrders += 1;
      if (acRemark !== erpRemark) orderOnly += 1;
    } else disagree.push({ acDoc, doc: o.doc_no, ac: acRemark, erp: erpRemark, status: o.status, processed: o.processing_date != null });
  }
  for (const [acDoc] of byAcDoc) if (!acRemarkByDoc.has(acDoc)) erpDocNotInAc += 1;

  /* THE HEADLINE PERCENTAGE IS FLATTERED BY BLANKS, and saying so is the whole
     difference between a measurement and a press release. Most outstanding
     orders are blank on both sides — neither system claims anything is ready —
     and those agreements are true but free. The number the owner actually needs
     is agreement over the orders where AT LEAST ONE side says something, so both
     are printed and the second is the one the verdict leans on. */
  const bothBlank = matrix.get("(blank) => (blank)") ?? 0;
  const spoken = compared - bothBlank;
  const spokenAgree = agreeOrders - bothBlank;
  log("");
  log(`  orders compared (in BOTH the snapshot and the ERP): ${pad(compared)}`);
  log(`    AGREE                                           : ${pad(agreeOrders)}   (${compared ? ((agreeOrders / compared) * 100).toFixed(1) : "0.0"}%)`);
  log(`      ... of which differ only in token ORDER, folded: ${pad(orderOnly)}`);
  log(`      ... of which are BLANK on BOTH sides           : ${pad(bothBlank)}   <- true, but free: neither system claims anything is ready`);
  log(`    DISAGREE                                        : ${pad(disagree.length)}`);
  log("");
  log(`  the number that is NOT flattered by blanks — orders where at least ONE side speaks:`);
  log(`    orders where either side names a readiness      : ${pad(spoken)}`);
  log(`      AGREE                                         : ${pad(spokenAgree)}   (${spoken ? ((spokenAgree / spoken) * 100).toFixed(1) : "0.0"}%)`);
  log(`      DISAGREE                                      : ${pad(disagree.length)}`);
  log(`  in the AutoCount snapshot, absent from the ERP    : ${pad(acDocNotInErp)}`);
  log(`  in the ERP, absent from the AutoCount snapshot    : ${pad(erpDocNotInAc)}   (delivered / invoiced out of the outstanding set, or newer than the export)`);
  verdict.orderCompared = compared;
  verdict.orderAgree = agreeOrders;
  verdict.orderDisagree = disagree.length;
  verdict.orderSpoken = spoken;
  verdict.orderSpokenAgree = spokenAgree;

  /* Every disagreement gets a NAMED cause, and the naming follows the owner's
     ruling: the ERP is the standard, so the classes say what AutoCount has not
     caught up on — except NOT PROCEEDED, which is the one class where the ERP
     genuinely cannot answer yet and it would be dishonest to score either way. */
  const causeOf = (m) => {
    if (!m.processed) return "NOT PROCEEDED — no Processing Date, so the allocator forces every line PENDING by design (owner: 没有 processing date 就代表没有 proceed). Neither side is behind; the ERP cannot answer yet";
    if (m.ac && !m.erp) return "AUTOCOUNT BEHIND (stale READY) — a human typed a readiness into Remark2 that the ERP's allocator cannot find stock for. The ERP figure stands";
    if (!m.ac && m.erp) return "AUTOCOUNT BEHIND (never typed back) — the ERP allocated the stock and nobody wrote it into Remark2";
    return "AUTOCOUNT BEHIND (different categories) — both sides name groups, and they differ. The ERP figure stands";
  };
  const causes = new Map();
  for (const m of disagree) { const c = causeOf(m).split(" — ")[0]; causes.set(c, (causes.get(c) ?? 0) + 1); }
  head("  every disagreement, attributed:");
  for (const [c, n] of [...causes].sort((a, b) => b[1] - a[1])) log(`    ${pad(n)}  ${c}`);
  const notProceeded = causes.get("NOT PROCEEDED") ?? 0;
  const realDisagree = disagree.length - notProceeded;
  log("");
  log(`  → of the ${disagree.length} disagreements, ${notProceeded} are the ERP's own processing-date gate (not drift)`);
  log(`  → ${realDisagree} are AutoCount genuinely behind the ERP`);
  verdict.orderNotProceeded = notProceeded;
  verdict.orderAcBehind = realDisagree;

  head("  agreement matrix (AutoCount Remark2 => ERP stock remark), most common first:");
  for (const [k, n] of [...matrix].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    const [l, r] = k.split(" => ");
    log(`    ${pad(n)}  ${l.padEnd(20)} => ${r}${canon(l === "(blank)" ? "" : l) === canon(r === "(blank)" ? "" : r) ? "" : "   <-- differs"}`);
  }

  head(`  first ${TOP} orders where AutoCount is behind:`);
  const acBehindOrders = disagree.filter((m) => m.processed);
  for (const m of acBehindOrders.slice(0, TOP))
    log(`    ${m.acDoc.padEnd(14)} (${String(m.doc).padEnd(16)} ${String(m.status).padEnd(14)})  AutoCount "${m.ac || "(blank)"}"  vs  ERP "${m.erp || "(blank)"}"  :: ${causeOf(m).split(" — ")[0]}`);
  if (!acBehindOrders.length) log("    none");
  head(`  first ${TOP} orders the ERP cannot answer yet (no Processing Date):`);
  const gated = disagree.filter((m) => !m.processed);
  for (const m of gated.slice(0, TOP))
    log(`    ${m.acDoc.padEnd(14)} (${String(m.doc).padEnd(16)} ${String(m.status).padEnd(14)})  AutoCount "${m.ac || "(blank)"}"  vs  ERP "${m.erp || "(blank)"}"`);
  if (!gated.length) log("    none");

  // ---- 1C. per SO LINE ---------------------------------------------------
  head("--- 1C. per SO LINE (exact key: mfg_sales_order_items.linked_ac_dtlkey = SODTL.DtlKey) ---");
  /* AutoCount has NO per-line readiness field. Established read-only against the
     live book and recorded in check-bedframe-sofa-status-truth.mjs's header:
     SODTL.StockReceived is 'F' on all 13,351 open lines, PurchaseStatus and
     DeliveryStatus are NULL on all of them. So the honest per-line statement is
     "AutoCount holds no line-level answer", and what CAN be compared per line is
     the line's EXISTENCE and its quantity — plus, for the lines on a disagreeing
     order, WHICH lines drive the header disagreement. Inventing a second
     line-level readiness rule to fill the gap is exactly what this repo pays for
     over and over, so it is not done here. */
  const acLineByKey = new Map();
  for (const r of acSoLines) if (r.DtlKey != null) acLineByKey.set(String(r.DtlKey), r);
  const erpKeyed = items.filter((i) => i.linked_ac_dtlkey != null);
  log(`  ERP lines on migrated orders                : ${pad(items.length)}`);
  log(`  ... carrying the exact AutoCount DtlKey      : ${pad(erpKeyed.length)}   (${((erpKeyed.length / items.length) * 100).toFixed(1)}%)`);
  log(`  AutoCount outstanding lines in the snapshot  : ${pad(acLineByKey.size)}`);
  log("  AutoCount holds NO per-line stock status: SODTL.StockReceived / PurchaseStatus /");
  log("  DeliveryStatus are dead on every open line. So per line the comparable facts are");
  log("  EXISTENCE and QUANTITY; readiness is only comparable at the order level (1B).");

  const erpRowsByKey = new Map();
  for (const i of erpKeyed) {
    const k = String(i.linked_ac_dtlkey);
    erpRowsByKey.set(k, (erpRowsByKey.get(k) ?? []).concat(i));
  }
  const matchedKeys = [...erpRowsByKey.keys()].filter((k) => acLineByKey.has(k));
  /* A SOFA AutoCount line is EXPLODED into one ERP line per compartment, and
     every compartment carries the same DtlKey (import-ac-outstanding-so.mjs
     pushes `dtlkey: l.DtlKey` for each piece). So a key holding several ERP rows
     is not a defect and its quantity is legitimately not AutoCount's — it is
     counted apart rather than folded into either answer. */
  const exploded = matchedKeys.filter((k) => erpRowsByKey.get(k).length > 1);
  let lineQtyAgree = 0; const lineQtyDiff = [];
  for (const k of matchedKeys) {
    const rows = erpRowsByKey.get(k);
    if (rows.length !== 1) continue;
    const i = rows[0], a = acLineByKey.get(k);
    const acQty = Math.round(num(a.Qty)) || 1;
    if (Number(i.qty) === acQty) lineQtyAgree += 1;
    else lineQtyDiff.push({ doc: i.doc_no, key: k, code: i.item_code, erp: Number(i.qty), ac: acQty });
  }
  /* The unmatched AutoCount lines split in two, and only the second is a gap.
     The importer DROPS a line with no resolvable item and no money on it
     ("a zero-value blank line is dropped", import-ac-outstanding-so.mjs:242) —
     those are absent from the ERP on purpose, and counting them as missing
     inflates the number by an order of magnitude. */
  const unmatched = [...acLineByKey.keys()].filter((k) => !erpRowsByKey.has(k)).map((k) => acLineByKey.get(k));
  const droppedByDesign = unmatched.filter((a) => !txt(a.ItemCode) && centi(a.UnitPrice) === 0);
  const genuinelyAbsent = unmatched.filter((a) => txt(a.ItemCode) || centi(a.UnitPrice) > 0);
  log("");
  log(`  keys present on BOTH sides                  : ${pad(matchedKeys.length)}`);
  log(`    compared 1:1                              : ${pad(lineQtyAgree + lineQtyDiff.length)}`);
  log(`      quantity AGREES                         : ${pad(lineQtyAgree)}`);
  log(`      quantity DIFFERS                        : ${pad(lineQtyDiff.length)}`);
  log(`    sofa lines exploded into compartments      : ${pad(exploded.length)}   <- one AutoCount line, several ERP lines by design; not comparable on qty`);
  log(`  AutoCount lines with no ERP line on the key : ${pad(unmatched.length)}`);
  log(`    blank item AND no money — the importer drops these by design: ${pad(droppedByDesign.length)}`);
  log(`    GENUINELY ABSENT from the ERP             : ${pad(genuinelyAbsent.length)}`);
  verdict.lineComparable = lineQtyAgree + lineQtyDiff.length;
  verdict.lineQtyAgree = lineQtyAgree;
  verdict.lineQtyDiff = lineQtyDiff.length;
  verdict.lineExploded = exploded.length;
  verdict.lineAcMissingInErp = genuinelyAbsent.length;
  head(`  first ${TOP} lines whose quantity differs:`);
  for (const r of lineQtyDiff.slice(0, TOP))
    log(`    ${String(r.doc).padEnd(16)} DtlKey ${String(r.key).padEnd(9)} ${String(r.code).slice(0, 30).padEnd(32)} ERP ${pad(r.erp, 4)}  AutoCount ${pad(r.ac, 4)}`);
  if (!lineQtyDiff.length) log("    none");
  head(`  first ${TOP} AutoCount lines GENUINELY absent from the ERP:`);
  for (const a of genuinelyAbsent.slice(0, TOP))
    log(`    ${String(a.DocNo).padEnd(14)} DtlKey ${String(a.DtlKey).padEnd(9)} ${String(txt(a.ItemCode) || "(blank)").slice(0, 30).padEnd(32)} qty ${String(a.Qty ?? "-").padEnd(5)} unit ${rm(centi(a.UnitPrice))}`);
  if (!genuinelyAbsent.length) log("    none");

  /* WHICH lines drive a header disagreement. This is the per-line half of the
     owner's question, answered without a second rule: the header remark is a
     rollup of these lines, so the lines that are not READY on a disagreeing
     order ARE the disagreement. */
  const disagreeDocs = new Set(acBehindOrders.map((m) => m.doc));
  const drivers = items.filter((i) => disagreeDocs.has(i.doc_no) && !i.cancelled && norm(i.stock_status) !== "READY");
  const driverByGroup = new Map();
  for (const d of drivers) driverByGroup.set(norm(d.item_group) || "(blank)", (driverByGroup.get(norm(d.item_group) || "(blank)") ?? 0) + 1);
  head(`  the ${drivers.length} non-READY lines that DRIVE those ${acBehindOrders.length} order disagreements, by group:`);
  for (const [g, n] of [...driverByGroup].sort((a, b) => b[1] - a[1])) log(`    ${pad(n)}  ${g}`);
  if (!drivers.length) log("    none");

  // =========================================================================
  // SECTION 2 — PROCESSING DATE completeness
  // =========================================================================
  head("================ 2. PROCESSING DATE completeness ================");
  log("Owner's rule, pinned 2026-08-13: 「只要有 Processing Date，就代表他 Proceed 了」·");
  log("「没有 processing date 就代表没有 proceed」. So an order with no date is not a defect");
  log("BY ITSELF — it is a defect only when AutoCount holds a date the ERP did not receive.");
  log("That is the difference this section can tell, because it JOINS THE SOURCE: the same");
  log("UDF_PDate field unify-processing-date.mjs classified on, from today's snapshot.");

  const acPDate = new Map();
  const acPDateConflict = new Set();
  const acDeliv = new Map();
  for (const r of acSoLines) {
    const doc = norm(r.DocNo);
    const d = String(r.UDF_PDate || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      if (acPDate.has(doc) && acPDate.get(doc) !== d) acPDateConflict.add(doc);
      else acPDate.set(doc, d);
    }
    const dd = String(r.DeliveryDate || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dd) && (!acDeliv.has(doc) || dd < acDeliv.get(doc))) acDeliv.set(doc, dd);
  }
  for (const d of acPDateConflict) acPDate.delete(d);
  log("");
  log(`  AutoCount documents in the snapshot                    : ${pad(acDocSet.size)}`);
  log(`  ... carrying a UDF_PDate                               : ${pad(acPDate.size)}`);
  log(`  ... excluded, their lines disagree on the date          : ${pad(acPDateConflict.size)}`);

  const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const pdHas = [], pdLegit = [], pdMissing = [], pdAhead = [], pdDiffer = [];
  for (const o of orders) {
    const acDoc = norm(o.linked_ac_docno);
    const src = acPDate.get(acDoc);
    const mine = iso(o.processing_date);
    if (mine && src && mine === src) pdHas.push(o);
    else if (mine && src && mine !== src) pdDiffer.push({ o, src, mine });
    else if (mine && !src) pdAhead.push({ o, mine });
    else if (!mine && src) pdMissing.push({ o, src });
    else pdLegit.push(o);
  }
  log("");
  log(`  migrated orders in the ERP                             : ${pad(orders.length)}`);
  log(`    HAVE a Processing Date, and it MATCHES AutoCount's   : ${pad(pdHas.length)}`);
  log(`    HAVE one AutoCount does not (set in the ERP since)   : ${pad(pdAhead.length)}   <- the ERP is ahead; not a gap`);
  log(`    HAVE one that DIFFERS from AutoCount's               : ${pad(pdDiffer.length)}   <- reported, never auto-resolved`);
  log(`    legitimately have NONE (AutoCount has none either)   : ${pad(pdLegit.length)}   <- NOT a gap: no date = not proceeded`);
  log(`    MISSING one they should have                         : ${pad(pdMissing.length)}   <- THE BACKLOG`);
  verdict.pdHave = pdHas.length + pdAhead.length + pdDiffer.length;
  verdict.pdLegitNone = pdLegit.length;
  verdict.pdMissing = pdMissing.length;
  verdict.pdDiffer = pdDiffer.length;

  head(`  first ${TOP} orders MISSING a Processing Date AutoCount holds:`);
  for (const { o, src } of pdMissing.slice(0, TOP))
    log(`    ${String(o.linked_ac_docno).padEnd(14)} (${String(o.doc_no).padEnd(16)} ${String(o.status).padEnd(14)})  AutoCount UDF_PDate ${src}  ERP (none)`);
  if (!pdMissing.length) log("    none");
  head(`  first ${TOP} orders whose Processing Date DIFFERS from AutoCount's:`);
  for (const { o, src, mine } of pdDiffer.slice(0, TOP))
    log(`    ${String(o.linked_ac_docno).padEnd(14)} (${String(o.doc_no).padEnd(16)})  ERP ${mine}  AutoCount ${src}`);
  if (!pdDiffer.length) log("    none");

  /* THE PAIR RULE. Owner: 「processing date 和 delivery date 必须同时有或者同时没
     有」. Reported here because it is the invariant a Processing-Date backfill
     can BREAK — unify-processing-date.mjs refuses to write a date onto an order
     with no delivery date for exactly this reason. */
  const halfPair = orders.filter((o) => !!o.processing_date !== !!o.customer_delivery_date);
  const pdNoDd = halfPair.filter((o) => o.processing_date);
  const ddNoPd = halfPair.filter((o) => !o.processing_date);
  head("  the PAIR RULE (processing date and delivery date are both-or-neither):");
  log(`    Processing Date but NO delivery date : ${pad(pdNoDd.length)}   <- violates the invariant`);
  log(`    delivery date but NO Processing Date : ${pad(ddNoPd.length)}   <- legal: not proceeded yet`);
  log(`    ... of those, AutoCount holds a delivery date the ERP could pair with: ${
    pad(pdNoDd.filter((o) => acDeliv.has(norm(o.linked_ac_docno))).length)}`);
  for (const o of pdNoDd.slice(0, TOP))
    log(`      ${String(o.linked_ac_docno).padEnd(14)} (${String(o.doc_no).padEnd(16)}) processing ${iso(o.processing_date)}, delivery (none)`);
  verdict.pairViolations = pdNoDd.length;

  /* The contradiction the owner's own rule exposes, named rather than
     silently sided with: an order the pipeline advanced past CONFIRMED that
     never proceeded. */
  const advancedUnproceeded = pdLegit.filter((o) => !["DRAFT", "CONFIRMED", "CANCELLED"].includes(norm(o.status)));
  head(`  orders with NO Processing Date yet already past CONFIRMED: ${advancedUnproceeded.length}`);
  for (const o of advancedUnproceeded.slice(0, TOP))
    log(`    ${String(o.linked_ac_docno).padEnd(14)} (${String(o.doc_no).padEnd(16)} ${String(o.status).padEnd(14)})`);
  if (!advancedUnproceeded.length) log("    none");

  // =========================================================================
  // SECTION 3 — PAYMENT completeness
  // =========================================================================
  head("================ 3. PAYMENT completeness ================");
  log("AutoCount side = the cutover importer's OWN formula, not a fresh reading of the book:");
  log("  total = Σ centi(UnitPrice)·qty   (import-ac-outstanding-so.mjs:247)");
  log("  paid  = max(0, total − centi(UDF_BALANCE))            (:317)");
  log("ERP side = Σ scm.mfg_sales_order_payments.amount_sen — the same sum, with no status");
  log("filter, that soProceedGateRefusal itself runs, so this measures the gate's own input.");

  const acTotal = new Map(), acBal = new Map();
  for (const r of acSoLines) {
    const doc = norm(r.DocNo);
    const qty = Math.round(num(r.Qty)) || 1;
    acTotal.set(doc, (acTotal.get(doc) ?? 0) + centi(r.UnitPrice) * qty);
    if (!acBal.has(doc)) acBal.set(doc, centi(r.UDF_BALANCE));   // header value, repeated per line
  }
  const erpPaid = new Map(
    (await sql`SELECT so_doc_no, SUM(amount_sen)::bigint AS sen, COUNT(*)::int AS n
                 FROM scm.mfg_sales_order_payments WHERE company_id = ${CO}
                GROUP BY so_doc_no`).map((r) => [r.so_doc_no, { sen: Number(r.sen), n: r.n }]));

  let payAgree = 0, payNotInSnap = 0, acMoneyTotal = 0, erpMoneyTotal = 0;
  const payDiff = [], totalDiff = [];
  for (const o of orders) {
    const acDoc = norm(o.linked_ac_docno);
    if (!acTotal.has(acDoc)) { payNotInSnap += 1; continue; }
    const t = acTotal.get(acDoc), b = acBal.get(acDoc) ?? 0;
    const acPay = Math.max(0, t - b);
    const mine = erpPaid.get(o.doc_no)?.sen ?? 0;
    acMoneyTotal += acPay; erpMoneyTotal += mine;
    if (acPay === mine) payAgree += 1;
    else payDiff.push({ o, acPay, erpPay: mine, d: mine - acPay, rows: erpPaid.get(o.doc_no)?.n ?? 0 });
    if (Number(o.local_total_sen ?? 0) !== t) totalDiff.push({ o, acTotal: t, erpTotal: Number(o.local_total_sen ?? 0) });
  }
  const payCompared = payAgree + payDiff.length;
  log("");
  log(`  migrated orders in BOTH the ERP and the snapshot : ${pad(payCompared)}`);
  log(`    money AGREES to the sen                        : ${pad(payAgree)}   (${payCompared ? ((payAgree / payCompared) * 100).toFixed(1) : "0.0"}%)`);
  log(`    money DIFFERS                                  : ${pad(payDiff.length)}`);
  log(`  in the ERP, absent from the snapshot             : ${pad(payNotInSnap)}`);
  log("");
  log(`  AutoCount holds against these orders : ${rm(acMoneyTotal)}`);
  log(`  the ERP holds against these orders   : ${rm(erpMoneyTotal)}`);
  log(`  difference (ERP − AutoCount)         : ${erpMoneyTotal - acMoneyTotal >= 0 ? "+" : ""}${rm(erpMoneyTotal - acMoneyTotal)}`);
  verdict.payCompared = payCompared;
  verdict.payAgree = payAgree;
  verdict.payDiffer = payDiff.length;
  verdict.payDeltaSen = erpMoneyTotal - acMoneyTotal;

  const missingInErp = payDiff.filter((r) => r.erpPay < r.acPay);
  const extraInErp = payDiff.filter((r) => r.erpPay > r.acPay);
  log("");
  log(`    of the differences — the ERP holds LESS than AutoCount : ${pad(missingInErp.length)}  (${rm(missingInErp.reduce((s, r) => s + (r.acPay - r.erpPay), 0))} short)`);
  log(`    of the differences — the ERP holds MORE than AutoCount : ${pad(extraInErp.length)}  (${rm(extraInErp.reduce((s, r) => s + (r.erpPay - r.acPay), 0))} extra — payments keyed in the ERP after the export)`);
  head(`  EVERY order where the ERP holds LESS (first ${TOP} shown, all counted above):`);
  for (const r of missingInErp.sort((a, b) => (b.acPay - b.erpPay) - (a.acPay - a.erpPay)).slice(0, TOP))
    log(`    ${String(r.o.linked_ac_docno).padEnd(14)} (${String(r.o.doc_no).padEnd(16)})  AutoCount ${rm(r.acPay).padStart(16)}  ERP ${rm(r.erpPay).padStart(16)}  short ${rm(r.acPay - r.erpPay)}  [${r.rows} ERP payment row(s)]`);
  if (!missingInErp.length) log("    none");
  head(`  first ${TOP} orders where the ERP holds MORE:`);
  for (const r of extraInErp.sort((a, b) => (b.erpPay - b.acPay) - (a.erpPay - a.acPay)).slice(0, TOP))
    log(`    ${String(r.o.linked_ac_docno).padEnd(14)} (${String(r.o.doc_no).padEnd(16)})  AutoCount ${rm(r.acPay).padStart(16)}  ERP ${rm(r.erpPay).padStart(16)}  extra ${rm(r.erpPay - r.acPay)}  [${r.rows} ERP payment row(s)]`);
  if (!extraInErp.length) log("    none");

  /* WHY the money differs, cross-tabbed against what sections 1 and 2 already
     measured. A migrated order whose AutoCount TOTAL also moved has been EDITED
     in the book since the import, so its payment gap is the same delta as its
     total gap — one event, not two findings. Reported here so the payment number
     is not read as 46 separate lost receipts. */
  const pdMissingDocs = new Set(pdMissing.map(({ o }) => o.doc_no));
  const totalDiffDocs = new Set(totalDiff.map((r) => r.o.doc_no));
  const alsoTotal = payDiff.filter((r) => totalDiffDocs.has(r.o.doc_no)).length;
  const alsoPdMissing = payDiff.filter((r) => pdMissingDocs.has(r.o.doc_no)).length;
  log("");
  log("  WHY they differ — cross-tabbed against the other sections:");
  log(`    ... the order's AutoCount TOTAL also differs (the document was edited in the book after the import): ${pad(alsoTotal)} of ${payDiff.length}`);
  log(`    ... the order is ALSO missing its Processing Date (section 2) — the same post-import edit:          ${pad(alsoPdMissing)} of ${payDiff.length}`);
  log("");
  log(`  order TOTALS that differ (a money difference can be a TOTAL difference, not a payment one): ${totalDiff.length}`);
  for (const r of totalDiff.slice(0, TOP))
    log(`    ${String(r.o.linked_ac_docno).padEnd(14)} (${String(r.o.doc_no).padEnd(16)})  AutoCount total ${rm(r.acTotal).padStart(16)}  ERP total ${rm(r.erpTotal).padStart(16)}`);

  /* THE SAME-DAY LOCK IS NOT A DEFECT. paymentRowMutable (so-field-policy.ts)
     locks a non-DRAFT order's payment the day after it was keyed, so every
     'imported' row from the cutover is already immutable — proven on
     HC-SO-013393 (probe-doc-writeback.mjs, Actions run 33375221382). An operator
     reporting "the payment did not save" on a migrated order is meeting that
     rule working as designed. It is counted here so the number is visible, and
     deliberately NOT called a gap. Whether migrated payments should be exempt
     until go-live is an OPEN OWNER DECISION — do not loosen a money gate. */
  const [imp] = await sql`
    SELECT COUNT(*)::int AS n, COUNT(DISTINCT so_doc_no)::int AS docs
      FROM scm.mfg_sales_order_payments p
      JOIN scm.mfg_sales_orders h ON h.doc_no = p.so_doc_no
     WHERE p.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND p.method = 'imported'`;
  log("");
  log(`  cutover-imported payment rows: ${imp.n} across ${imp.docs} orders. They are already`);
  log("  past the same-day edit lock and cannot be corrected in the ERP. That is the lock");
  log("  working as designed, NOT a gap — exempting them is an open owner decision.");

  // =========================================================================
  // SECTION 4 — COLOUR / SEAT SIZE / SOFA COMPARTMENTS
  // =========================================================================
  head("================ 4. COLOUR · SEAT SIZE · SOFA COMPARTMENTS ================");
  log("Owner's rule (2026-09-04): 「还没proceed还没确认的就可以直接放空的」— an order that");
  log("has NOT been proceeded may legitimately carry no colour, no seat size, no compartments.");
  log("So THE BACKLOG IS THE PROCEEDED POPULATION (Processing Date IS NOT NULL). The all-orders");
  log("figure is printed beside it as CONTEXT ONLY and must never be quoted as the work.");
  log("The axis rule is missingVariantAxes() from lib/variant-axes.mjs — the same mirror");
  log("check-sofa-bedframe-completeness.mjs uses, whose deeper 16-cell audit stays the");
  log("authority on compartment CORRECTNESS; this section counts the OUTSTANDING gaps.");

  const prodCodes = new Set((await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`).map((r) => norm(r.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const modelOf = (code) => { const c = norm(code); const i = c.indexOf("-"); const b = i < 0 ? c : c.slice(0, i); return SOFA_MODEL_ALIAS[b] || b; };
  const reclOf = (m) => RECL.some((s) => prodCodes.has(norm(m + s)));
  const compartmentOf = (code) => { const c = norm(code); const i = c.indexOf("-"); return i < 0 ? "" : c.slice(i + 1); };

  const proceededDocs = new Set(orders.filter((o) => o.processing_date != null).map((o) => o.doc_no));
  const variantLines = items.filter((i) => !i.cancelled && ["sofa", "bedframe"].includes(String(i.item_group ?? "").toLowerCase()));

  const measure = (rows) => {
    const out = { lines: 0, sofa: 0, bedframe: 0, colourMissing: 0, colourUnresolved: 0, colourPending: 0, seatMissing: 0, bare1S: 0, bare1SReal: 0 };
    for (const r of rows) {
      const grp = String(r.item_group).toLowerCase();
      out.lines += 1; out[grp] += 1;
      const v = r.variants || {};
      const miss = missingVariantAxes(grp, v, r.item_code).map((a) => a.key);
      if (miss.includes("fabricCode")) out.colourMissing += 1;
      if (miss.includes("seatHeight")) out.seatMissing += 1;
      const code = ["fabricCode", "colorCode", "colourCode", "fabricColor"].map((k) => txt(v[k])).find(Boolean) ?? "";
      if (code && isPendingColour(code)) out.colourPending += 1;
      else if (code && !findColour(code)) out.colourUnresolved += 1;
      if (grp === "sofa" && /^1S$/i.test(compartmentOf(r.item_code))) {
        out.bare1S += 1;
        /* THE SPLIT the owner bought twice. A "-1S" code is either a build the
           decoder could not read (work) or a genuine single seater the book
           itself asks for (correct). Asked of the DECODER, never of the remark. */
        const m = modelOf(r.item_code);
        if (!isSingleSeatBuild(r.description2, parseSofa(r.description2, m, reclOf(m)))) out.bare1SReal += 1;
      }
    }
    return out;
  };

  const proceeded = measure(variantLines.filter((r) => proceededDocs.has(r.doc_no)));
  const allSo = measure(variantLines);
  const row = (label, a, b) => log(`    ${label.padEnd(56)} ${pad(a)}   ${pad(b)}`);
  log("");
  log(`    ${"".padEnd(56)} ${"PROCEEDED".padStart(6)}   ${"all SO".padStart(6)}`);
  log(`    ${"".padEnd(56)} ${"(THE BACKLOG)".padStart(6)}   ${"(context)".padStart(6)}`);
  row("sofa + bedframe lines in the population", proceeded.lines, allSo.lines);
  row("  of which sofa", proceeded.sofa, allSo.sofa);
  row("  of which bedframe", proceeded.bedframe, allSo.bedframe);
  row("COLOUR — no fabric axis at all", proceeded.colourMissing, allSo.colourMissing);
  row("COLOUR — axis present but says TBC / KIV", proceeded.colourPending, allSo.colourPending);
  row("COLOUR — axis present, resolves to no scm.fabric_colours row", proceeded.colourUnresolved, allSo.colourUnresolved);
  row("SEAT SIZE — missing (sofa; CONSOLE exempted)", proceeded.seatMissing, allSo.seatMissing);
  row('COMPARTMENTS — bare "1S" lines, all told', proceeded.bare1S, allSo.bare1S);
  row('COMPARTMENTS — bare "1S" WE COULD NOT READ (the real work)', proceeded.bare1SReal, allSo.bare1SReal);
  verdict.varColour = proceeded.colourMissing;
  verdict.varSeat = proceeded.seatMissing;
  verdict.varCompartment = proceeded.bare1SReal;
  verdict.varPopulation = proceeded.lines;

  const gapLines = variantLines.filter((r) => {
    if (!proceededDocs.has(r.doc_no)) return false;
    const grp = String(r.item_group).toLowerCase();
    return missingVariantAxes(grp, r.variants || {}, r.item_code).length > 0;
  });
  head(`  first ${TOP} PROCEEDED lines with an outstanding axis:`);
  for (const r of gapLines.slice(0, TOP))
    log(`    ${String(r.doc_no).padEnd(16)} ${String(r.item_code).slice(0, 30).padEnd(32)} missing ${
      missingVariantAxes(String(r.item_group).toLowerCase(), r.variants || {}, r.item_code).map((a) => a.label).join(", ")}`);
  if (!gapLines.length) log("    none");

  // =========================================================================
  // VERDICT
  // =========================================================================
  head("================================================================");
  log("  VERDICT");
  log("================================================================");
  log(`  1A  stock balance, product+warehouse : ${verdict.cellAgree} of ${verdict.cellComparable} comparable cells AGREE; ${verdict.cellDiffer} differ`);
  log(`  1B  stock STATUS, per order          : ${verdict.orderAgree} of ${verdict.orderCompared} AGREE; ${verdict.orderDisagree} disagree`);
  log(`        ... excluding blank-on-both       : ${verdict.orderSpokenAgree} of ${verdict.orderSpoken} AGREE  <- the un-flattered figure`);
  log(`        ... of the disagreements       : ${verdict.orderNotProceeded} are the ERP's own no-processing-date gate (not drift)`);
  log(`        ... genuinely AutoCount behind : ${verdict.orderAcBehind}`);
  log(`  1C  per LINE (exact DtlKey)          : ${verdict.lineQtyAgree} of ${verdict.lineComparable} 1:1 lines agree on quantity; ${verdict.lineQtyDiff} differ; ${verdict.lineExploded} sofa lines exploded (not comparable); ${verdict.lineAcMissingInErp} AutoCount lines genuinely absent`);
  log(`  2   processing date                  : ${verdict.pdHave} have one · ${verdict.pdLegitNone} legitimately have none · ${verdict.pdMissing} MISSING one they should have · ${verdict.pdDiffer} differ`);
  log(`  3   payment                          : ${verdict.payAgree} of ${verdict.payCompared} orders agree to the sen; ${verdict.payDiffer} differ; net ${verdict.payDeltaSen >= 0 ? "+" : ""}${rm(verdict.payDeltaSen)} (ERP − AutoCount)`);
  log(`  4   variants on the PROCEEDED set    : colour ${verdict.varColour} · seat size ${verdict.varSeat} · compartments ${verdict.varCompartment}  (over ${verdict.varPopulation} proceeded sofa/bedframe lines)`);
  log("");
  log("  Reading it: the owner's ruling is that the ERP is the standard. Every 'differ' above");
  log("  is AutoCount behind the ERP unless the line says otherwise. The two numbers that are");
  log("  WORK, not drift, are section 2's MISSING count and section 4's proceeded backlog.");
  log("");
  log(`  AutoCount snapshot: ${manifest.exported_at}${ageH > STALE_HOURS ? "  *** STALE ***" : ""}`);
  log("  Read-only run. No row was written.");

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* connection already gone */ }
  /* Non-zero is reserved for "the database could not answer" and for a failed
     self-test. Every legitimate verdict above — including a failing gate —
     exits 0, because the ANSWER is the output. */
  process.exit(1);
});
