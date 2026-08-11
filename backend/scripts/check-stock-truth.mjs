#!/usr/bin/env node
// ============================================================================
// STOCK TRUTH CHECK — is the stock BALANCE right, is the FIFO ledger sound, and
// is COGS drawn from a real cost? Read-only, re-runnable, one VERDICT block.
// ============================================================================
//
// WHY THIS EXISTS. The owner asked (2026-08-11): "你会跟我确保他的 stock
// movement 还有他的 costing ... 全部都会准是吗?" and "你确保整个 stock balance
// 准,然后 stock costing 也准了。跟着 FIFO". An answer produced once, by hand,
// is worth nothing the next morning. This is the standing instrument that
// answers it on demand, so any repair lane can be judged against a number that
// was measured the same way before and after.
//
// It reports three things and NEVER changes one:
//
//   (A) BALANCE vs AutoCount — cell by cell, per item AND per location, the ERP
//       on-hand against AutoCount's own vItemBalQty. Split into agree / ERP
//       higher / ERP lower / item-not-mapped / location-not-mapped / ERP-only.
//
//       THREE THINGS ARE HELD OUT OF THAT COMPARISON, and each is PRINTED with
//       its cell and unit counts rather than silently dropped — the report says
//       what it did not look at. Every one of them was found by running the
//       check and disbelieving its own headline:
//
//         SOFA FURNITURE, on BOTH sides. The owner's ruling ("沙发库存不准的,因为
//           我们接下来跑 compartment 了 ... pillow 就ok", 2026-08-10) — the
//           whole-sofa balance was deliberately never imported. The exclusion
//           must be symmetric: AutoCount counts ONE sofa where the ERP counts its
//           compartments, so holding out only AutoCount's side leaves every ERP
//           compartment cell reporting as ERP-only. The first run of this check
//           did exactly that and invented 12 phantom cells. Sofa PILLOWS are
//           category ACC and are NOT excluded.
//         NON-STOCK charge items (categories SERVICE and TRANS). AutoCount books
//           DISPOSE, TRANSPORTATION CHARGES and STORAGE as items whose balance
//           runs ever more negative as they are billed out. They are not goods.
//           They contributed 4,048 of the 4,209 units the first run headlined as
//           "ERP HIGHER" — 96% of a number that read as phantom stock.
//         AC-NEGATIVE cells. A negative AutoCount on-hand is an over-issue; the
//           ERP's ledger cannot represent one, so the difference is arithmetic
//           rather than missing stock.
//
//       What survives all three is the real divergence, and that is what the
//       VERDICT line counts.
//
//   (B) FIFO INTEGRITY — four invariants that must hold if the layer ledger is
//       trustworthy:
//         B1 every layer's remaining = received - consumed;
//         B2 no layer negative, none remaining more than it received;
//         B3 every SHIPPED unit carries a cost — shipments only. The cutover
//            relayer reversed the whole opening balance with negative
//            adjustments, and those consume their lots without shipping
//            anything; counting them made the first run declare FIFO NOT SOUND
//            on 8,295 units while its own section C found 0 units actually
//            shipped from a zero-cost layer;
//         B4 layer quantity reconciles to the movement ledger (per bucket);
//         B5 total inventory value equals the sum of the layers.
//       Zero-cost OPEN layers are reported separately, with units and the
//       documents behind them, because those are stock on the books with no
//       basis — they book RM0 COGS the moment FIFO reaches them.
//
//   (C) DELIVERED COGS — for lines that have actually shipped, was the cost
//       drawn from a layer that had a real cost? Counts the delivered units
//       whose COGS is zero and gives the RM impact.
//
// WHAT "RM IMPACT" MEANS HERE, EXACTLY. For a zero-COGS delivered line the true
// cost is UNKNOWN — that is the whole problem. So the figure reported as impact
// is the REVENUE those lines booked with nothing behind it (exact, from
// line_total_centi): the amount currently shown as 100% margin. Any figure for
// "what it should have cost" would be an invention, and a plausible wrong number
// is worse than a blank. Where an estimate IS offered it is labelled ESTIMATE
// and derived from the bucket's own open layers.
//
// RELATION TO THE CHECKS THAT ALREADY EXIST. This does not replace them and
// does not re-derive their numbers:
//   check-inventory-integrity.mjs — movement-vs-lot drift and uncosted OUT, per
//       bucket, with samples. B4 here reports only the HEADLINE count and points
//       at it.
//   check-costless-stock.mjs — zero-cost open lots split by whether a Purchase
//       Invoice can still heal them. B6 here reports the totals and the source
//       documents; that script is the one that classifies them.
//   check-uncosted-cogs.mjs — the movement-side view of uncosted shipments.
//       Section C here is the DOCUMENT-side view: what the delivery order and
//       therefore the sales invoice and the margin report actually show.
// Nothing above compares the ERP against AutoCount per item AND location. That
// gap is section A, and it is the reason this file exists.
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no marker
// rows, no change to any costing logic. Every interpolated identifier is a
// schema/column name DISCOVERED from information_schema and re-validated against
// ^[a-z_][a-z0-9_]*$; no external input reaches any statement. Exits 0 for every
// legitimate answer (the ANSWER is the output, not the exit code); non-zero only
// when the database is unreachable, the AutoCount snapshot is missing, or a
// query errors.
//
// Workflow: .github/workflows/stock-truth-check.yml (manual dispatch only — a
// production read must never become routine CI noise).
// AutoCount side: scripts/export-ac-item-location-balance.py refreshes
// data/ac-item-location-balance.json.gz from the live book over read-only ODBC.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");

// Same resolution order as pg-migrate.mjs / check-inventory-integrity.mjs: env
// wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

// The AutoCount book this compares against is Houzs Century's (AED_HOUZS), which
// is company 1. Overridable, but printed so the report always says whose stock
// it just checked.
const COMPANY = Number(process.env.COMPANY ?? 1);
// Past this many days the AutoCount snapshot is old enough that a divergence
// could be nothing but the days in between. The check keeps running — it just
// stops claiming the divergence is the ERP's fault.
const MAX_AGE_DAYS = Number(process.env.AC_SNAPSHOT_MAX_AGE_DAYS ?? 2);
const SAMPLE = Number(process.env.SAMPLE ?? 25);

// `notice` surfaces each line on the workflow run's summary page so the verdict
// is readable without opening the log.
const notice = (m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const SAFE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (v) => Number(v ?? 0);
const pad = (s, w) => String(s).padEnd(w);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* ── AutoCount-side inputs ──────────────────────────────────────────────────
   norm() is the same normalisation import-ac-stock-balance.mjs used to resolve
   these codes, so a cell this check calls "not mapped" is exactly a cell that
   import could not have written either. Trailing spaces are real in the
   AutoCount location list ("C&C K.J "), which is why trim comes first. */
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* AutoCount location code -> ERP warehouse CODE. Lifted verbatim from
   import-ac-stock-balance.mjs so the check resolves locations exactly the way
   the import that created the opening balance did. A location with no confident
   ERP home is NOT guessed — it is reported. */
const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY",
  "EM DISP": "EM DISPLAY", "C&C DISP": "C&C DISPLAY",
  "SERV KL": "KL SERVICE", "SERV PG": "PG SERVICE",
  SUNWAY: "SUNWAY SHOWROOM", "KELANA.J": "KELANA.J SHOWROOM",
};

function loadAcSnapshot() {
  const f = path.join(DATA, "ac-item-location-balance.json.gz");
  let raw;
  try {
    raw = gunzipSync(readFileSync(f)).toString("utf8").replace(/^﻿/, "");
  } catch (e) {
    throw new Error(
      `AutoCount snapshot missing or unreadable: ${f}\n` +
      `Refresh it on a machine that can reach the AutoCount box:\n` +
      `  AC_DB_CRED_FILE=<cred file> python scripts/export-ac-item-location-balance.py\n` +
      `(${e.message})`);
  }
  const j = JSON.parse(raw);
  return { rows: j.rows ?? j, pulledAt: j.pulled_at ?? null, source: j.source ?? "unknown" };
}

/* Categories that are not stock at all. AutoCount books a delivery charge, a
   disposal fee and a storage fee as ITEMS, so they appear in vItemBalQty with a
   running balance that goes ever more negative as they are charged out. They are
   not goods, the ERP holds no stock row for them, and comparing them produces a
   difference for every one. See NON-STOCK in section A. */
const NON_STOCK_CATS = new Set(["SERVICE", "TRANS"]);

function loadMapping() {
  const csv = readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift(); // header: ac_code,erp_code,status,category,supplier
  const acToErp = new Map();
  const sofaCodes = new Set();
  const nonStockCodes = new Set();
  // The ERP-side twins, so an exclusion applied to AutoCount can be applied to
  // the ERP as well. Without these the exclusion is one-sided and invents cells.
  const sofaErpCodes = new Set();
  const nonStockErpCodes = new Set();
  const category = new Map();
  for (const ln of csv) {
    const f = parseCsvLine(ln);
    if (!f[0]) continue;
    const ac = norm(f[0]);
    const erp = f[1]?.trim();
    if (erp) acToErp.set(ac, erp);
    const cat = (f[3] || "").trim().toUpperCase();
    category.set(ac, cat);
    /* Category, not spelling. "AMN-SOFA PILLOW" and "THL-SOFA PILLOW" carry SOFA
       in the CODE but are ordinary accessories (category ACC) — the cutover's
       first /SOFA/i filter threw 205 units of real countable stock away with the
       furniture, which is recorded in docs/autocount-cutover-ledger.md §3 as a
       known consequence. The owner's exclusion is about sofa FURNITURE only:
       "pillow 就ok". */
    if (cat === "SOFA") { sofaCodes.add(ac); if (erp) sofaErpCodes.add(norm(erp)); }
    if (NON_STOCK_CATS.has(cat)) { nonStockCodes.add(ac); if (erp) nonStockErpCodes.add(norm(erp)); }
  }
  return { acToErp, sofaCodes, nonStockCodes, sofaErpCodes, nonStockErpCodes, category };
}

/* ── schema discovery ─────────────────────────────────────────────────────── */
async function cols(schema, table) {
  const r = await sql`SELECT column_name FROM information_schema.columns
                      WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}
async function tableSchema(table) {
  const r = await sql`SELECT table_schema FROM information_schema.tables
                      WHERE table_name = ${table} AND table_schema IN ('scm','public')
                      ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END LIMIT 1`;
  return r[0]?.table_schema ?? null;
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION A — stock BALANCE: the ERP against AutoCount, cell by cell
   ════════════════════════════════════════════════════════════════════════════ */
async function sectionA(state) {
  notice("");
  notice("================ (A) STOCK BALANCE — ERP vs live AutoCount, per item x location ================");

  const snap = loadAcSnapshot();
  const ageMs = snap.pulledAt ? Date.now() - Date.parse(snap.pulledAt) : null;
  const ageDays = ageMs == null ? null : ageMs / 86400000;
  const stale = ageDays != null && ageDays > MAX_AGE_DAYS;
  notice(`  AutoCount source   : ${snap.source}`);
  notice(`  snapshot pulled_at : ${snap.pulledAt ?? "UNKNOWN"}${ageDays == null ? "" : `  (${ageDays.toFixed(2)} days old)`}`);
  if (stale) {
    notice(`  !! SNAPSHOT IS STALE (> ${MAX_AGE_DAYS} days). Differences below may be movements since the pull,`);
    notice(`     NOT ERP defects. Re-run scripts/export-ac-item-location-balance.py before believing them.`);
  }
  notice(`  AutoCount rows     : ${snap.rows.length}`);

  const { acToErp, sofaCodes, nonStockCodes, sofaErpCodes, nonStockErpCodes } = loadMapping();

  // Naming the company is a courtesy, not a dependency — if the master is not
  // where this expects it, the check still runs and just says so.
  let coLabel = "(companies master unreadable)";
  try {
    const co = await sql`SELECT id, code, name FROM public.companies WHERE id = ${COMPANY}`;
    coLabel = co[0] ? `(${co[0].code ?? "-"} / ${co[0].name ?? "-"})` : "(NOT FOUND in public.companies)";
  } catch { /* keep the default label */ }
  notice(`  company scope      : ${COMPANY} ${coLabel}`);

  const whs = await sql`SELECT id, code, name, is_active FROM scm.warehouses WHERE company_id = ${COMPANY}`;
  const whByCode = new Map(whs.map((w) => [String(w.code).toUpperCase(), w]));
  const whById = new Map(whs.map((w) => [w.id, w]));
  const resolveWh = (loc) => {
    const k = norm(loc);
    return whByCode.get((SALESLOC[k] || k).toUpperCase()) ?? whByCode.get(k) ?? null;
  };
  notice(`  ERP warehouses     : ${whs.length} (${whs.map((w) => w.code).join(", ")})`);

  /* The ERP's own sofa list. The exclusion has to be SYMMETRIC: AutoCount counts
     ONE whole sofa where the ERP counts its compartments (AMN-SF9028 SOFA is
     9028-1S, 9028-CNR, ... in here), so the two sides are not commensurable at
     all. Holding sofa out on the AutoCount side alone leaves every ERP
     compartment cell with nothing to compare against, and it reports as ERP-only
     — a gap invented by the filter rather than found by it. That is exactly what
     the previous run did: all 12 of its "ERP-only" cells were compartment codes.
     Two independent sources are unioned because neither is complete on its own:
     the binding CSV knows the whole-sofa -> lead-compartment mapping, and the ERP
     product master knows the compartments the CSV never named. */
  let erpSofaFromMaster = new Set();
  let sofaMasterNote = "";
  try {
    const mpCols = await cols("scm", "mfg_products");
    if (!mpCols.has("code") || !mpCols.has("category")) {
      sofaMasterNote = " (scm.mfg_products lacks code/category — CSV only)";
    } else {
      const co = mpCols.has("company_id") ? sql`AND company_id = ${COMPANY}` : sql``;
      const rows = await sql`SELECT DISTINCT code FROM scm.mfg_products
                              WHERE UPPER(COALESCE(category::text, '')) = 'SOFA' ${co}`;
      erpSofaFromMaster = new Set(rows.map((r) => norm(r.code)));
    }
  } catch (e) {
    sofaMasterNote = ` (scm.mfg_products unreadable: ${e.message} — CSV only)`;
  }
  const erpSofa = new Set([...sofaErpCodes, ...erpSofaFromMaster]);
  notice(`  ERP sofa codes     : ${erpSofa.size} (${erpSofaFromMaster.size} from scm.mfg_products category SOFA, ${sofaErpCodes.size} from the binding CSV)${sofaMasterNote}`);

  // ERP on-hand per (warehouse, product), summed over every variant_key — the
  // AutoCount side has no variant dimension, so the comparison can only be made
  // at product granularity. inventory_balances is a VIEW over the movement
  // ledger, i.e. exactly what the ERP believes it holds.
  const erpRows = await sql`SELECT warehouse_id, product_code, SUM(qty)::bigint AS qty
                              FROM scm.inventory_balances
                             WHERE company_id = ${COMPANY}
                             GROUP BY warehouse_id, product_code`;
  const erpBy = new Map();
  let erpSofaCells = 0, erpSofaUnits = 0, erpNonStockCells = 0, erpNonStockUnits = 0;
  for (const r of erpRows) {
    const code = norm(r.product_code);
    const qty = n(r.qty);
    if (erpSofa.has(code)) { if (qty !== 0) { erpSofaCells++; erpSofaUnits += qty; } continue; }
    if (nonStockErpCodes.has(code)) { if (qty !== 0) { erpNonStockCells++; erpNonStockUnits += qty; } continue; }
    erpBy.set(`${code}|${r.warehouse_id}`, qty);
  }

  /* Fold the AutoCount side onto ERP keys FIRST. The mapping is many-to-one —
     NB-KHJ21(Q) and HOK-1041 (Q) both resolve to ERP VICTORIA-(Q) — so comparing
     per AutoCount row would report two false divergences where the ERP correctly
     holds the sum. */
  const acBy = new Map();          // erpKey -> { qty, items:Set }
  const unmappedItem = new Map();  // ac code -> units (non-zero only)
  const unmappedLoc = new Map();   // ac location -> {cells, units}
  let sofaCells = 0, sofaUnits = 0, sofaCodesSeen = new Set();
  let nonStockCells = 0, nonStockUnits = 0, nonStockSeen = new Set();
  let acRowsConsidered = 0;

  for (const r of snap.rows) {
    const ac = norm(r.ItemCode);
    const qty = Math.round(n(r.BalQty));
    if (sofaCodes.has(ac)) {
      if (qty !== 0) { sofaCells++; sofaUnits += qty; sofaCodesSeen.add(ac); }
      continue;                                   // owner's ruling — excluded, and said so above
    }
    /* NON-STOCK. A charge item is not goods. AutoCount carries DISPOSE,
       TRANSPORTATION CHARGES and STORAGE as items whose balance runs negative as
       they are billed out, so every one of them differs from the ERP's (correct)
       absence of a stock row. In the previous run these four codes alone
       contributed 4,048 of the 4,209 units reported as "ERP HIGHER" — 96% of a
       headline that read as missing stock and was nothing of the kind. */
    if (nonStockCodes.has(ac)) {
      if (qty !== 0) { nonStockCells++; nonStockUnits += qty; nonStockSeen.add(ac); }
      continue;
    }
    acRowsConsidered++;
    const erpCode = acToErp.get(ac);
    if (!erpCode) {
      if (qty !== 0) unmappedItem.set(ac, (unmappedItem.get(ac) ?? 0) + qty);
      continue;
    }
    const wh = resolveWh(r.Location);
    if (!wh) {
      const k = String(r.Location ?? "");
      const cur = unmappedLoc.get(k) ?? { cells: 0, units: 0 };
      if (qty !== 0) { cur.cells++; cur.units += qty; unmappedLoc.set(k, cur); }
      continue;
    }
    const key = `${norm(erpCode)}|${wh.id}`;
    const cur = acBy.get(key) ?? { qty: 0, items: new Set() };
    cur.qty += qty;
    cur.items.add(r.ItemCode);
    acBy.set(key, cur);
  }

  // Compare over the UNION of both sides. A cell the ERP holds that AutoCount
  // has no row for is not "agreement by absence" — it is ERP-only stock, and it
  // gets its own bucket.
  const keys = new Set([...acBy.keys(), ...erpBy.keys()]);
  const agree = [], higher = [], lower = [], erpOnly = [], acNegative = [];
  for (const key of keys) {
    const [code, whId] = key.split("|");
    const a = acBy.get(key);
    const e = erpBy.get(key) ?? 0;
    if (!a) { if (e !== 0) erpOnly.push({ code, whId, erp: e }); continue; }
    const row = { code, whId, ac: a.qty, erp: e, delta: e - a.qty, items: [...a.items] };
    /* A NEGATIVE AutoCount balance is not a quantity the ERP can be wrong about.
       It means AutoCount issued more than it received — an over-issue or a
       not-yet-received receipt — and the ERP's stock ledger cannot represent it,
       so the difference is arithmetic, not a defect. Left in the ERP-HIGHER
       bucket it inflates the headline by its full magnitude and reads as stock
       the ERP invented. Reported on its own line instead. */
    if (row.ac < 0) { acNegative.push(row); continue; }
    if (row.delta === 0) agree.push(row);
    else if (row.delta > 0) higher.push(row);
    else lower.push(row);
  }
  const sumBy = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  higher.sort((x, y) => y.delta - x.delta);
  lower.sort((x, y) => x.delta - y.delta);
  erpOnly.sort((x, y) => Math.abs(y.erp) - Math.abs(x.erp));
  acNegative.sort((x, y) => x.ac - y.ac);

  const agreeNonZero = agree.filter((r) => r.ac !== 0 || r.erp !== 0);
  notice("");
  notice(`  cells compared                    : ${agree.length + higher.length + lower.length}   (of which both sides zero: ${agree.length - agreeNonZero.length})`);
  notice(`  AGREE                             : ${agree.length}   (non-zero cells that agree: ${agreeNonZero.length}, units ${sumBy(agreeNonZero, (r) => r.erp)})`);
  notice(`  ERP HIGHER than AutoCount         : ${higher.length} cells, +${sumBy(higher, (r) => r.delta)} units`);
  notice(`  ERP LOWER than AutoCount          : ${lower.length} cells, ${sumBy(lower, (r) => r.delta)} units`);
  notice(`  ERP-ONLY (no AutoCount row maps)  : ${erpOnly.length} cells, ${sumBy(erpOnly, (r) => r.erp)} units`);
  notice(`  ITEM NOT MAPPED (AC -> ERP)       : ${unmappedItem.size} AutoCount codes, ${[...unmappedItem.values()].reduce((s, v) => s + v, 0)} units`);
  notice(`  LOCATION NOT MAPPED (AC -> ERP)   : ${unmappedLoc.size} AutoCount locations, ${[...unmappedLoc.values()].reduce((s, v) => s + v.units, 0)} units`);
  notice("");
  notice(`  NOT COMPARABLE — reported, not counted as divergence:`);
  notice(`    AC NEGATIVE BALANCE             : ${acNegative.length} cells, AutoCount ${sumBy(acNegative, (r) => r.ac)} units vs ERP ${sumBy(acNegative, (r) => r.erp)} units`);
  notice(`      AutoCount issued more than it received on these; the ERP's ledger cannot hold a negative on-hand,`);
  notice(`      so the difference is arithmetic rather than missing stock.`);
  notice(`    NON-STOCK (SERVICE / TRANS)     : ${nonStockSeen.size} AutoCount codes / ${nonStockCells} cells / ${nonStockUnits} units held out on the AutoCount side;`);
  notice(`                                      ${erpNonStockCells} cells / ${erpNonStockUnits} units held out on the ERP side.`);
  notice(`      Charge items (DISPOSE, TRANSPORTATION CHARGES, STORAGE), not goods. AutoCount books them as items`);
  notice(`      whose balance runs negative as they are billed; the ERP holds no stock row for them, correctly.`);
  notice("");
  notice(`  SOFA FURNITURE EXCLUDED — owner's ruling 2026-08-10 ("沙发库存不准的 ... pillow 就ok"):`);
  notice(`    AutoCount side: ${sofaCodesSeen.size} sofa codes / ${sofaCells} non-zero cells / ${sofaUnits} units NOT compared.`);
  notice(`    ERP side      : ${erpSofaCells} compartment cells / ${erpSofaUnits} units NOT compared.`);
  notice(`    The exclusion is SYMMETRIC on purpose. AutoCount counts one whole sofa where the ERP counts its`);
  notice(`    compartments, so the two sides are not commensurable; excluding only AutoCount's would leave every`);
  notice(`    ERP compartment cell reporting as ERP-only — a gap invented by the filter, not found by it.`);
  notice(`    Sofa PILLOW accessories are NOT excluded (category ACC, real countable stock).`);

  if (higher.length) {
    notice("");
    notice(`  --- ERP HIGHER (top ${Math.min(SAMPLE, higher.length)} of ${higher.length}) ---`);
    for (const r of higher.slice(0, SAMPLE))
      notice(`    +${pad(r.delta, 6)} ${pad(r.code, 34)} @ ${pad(whById.get(r.whId)?.code ?? r.whId, 18)} ERP ${r.erp} vs AC ${r.ac}   [AC: ${r.items.join(", ")}]`);
  }
  if (lower.length) {
    notice("");
    notice(`  --- ERP LOWER (top ${Math.min(SAMPLE, lower.length)} of ${lower.length}) ---`);
    for (const r of lower.slice(0, SAMPLE))
      notice(`    ${pad(r.delta, 7)} ${pad(r.code, 34)} @ ${pad(whById.get(r.whId)?.code ?? r.whId, 18)} ERP ${r.erp} vs AC ${r.ac}   [AC: ${r.items.join(", ")}]`);
  }
  if (erpOnly.length) {
    notice("");
    notice(`  --- ERP-ONLY cells (top ${Math.min(SAMPLE, erpOnly.length)} of ${erpOnly.length}) — the ERP holds stock AutoCount has no row for ---`);
    for (const r of erpOnly.slice(0, SAMPLE))
      notice(`    ${pad(r.erp, 7)} ${pad(r.code, 34)} @ ${whById.get(r.whId)?.code ?? r.whId}`);
  }
  if (acNegative.length) {
    notice("");
    notice(`  --- AC NEGATIVE BALANCE (top ${Math.min(SAMPLE, acNegative.length)} of ${acNegative.length}) — AutoCount is below zero, the ERP cannot be ---`);
    for (const r of acNegative.slice(0, SAMPLE))
      notice(`    AC ${pad(r.ac, 8)} ERP ${pad(r.erp, 6)} ${pad(r.code, 34)} @ ${pad(whById.get(r.whId)?.code ?? r.whId, 18)} [AC: ${r.items.join(", ")}]`);
  }
  if (unmappedItem.size) {
    notice("");
    notice(`  --- ITEM NOT MAPPED (top ${Math.min(SAMPLE, unmappedItem.size)} of ${unmappedItem.size}) — AutoCount stock with no ERP product ---`);
    for (const [k, v] of [...unmappedItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, SAMPLE))
      notice(`    ${pad(v, 7)} ${k}`);
  }
  if (unmappedLoc.size) {
    notice("");
    notice(`  --- LOCATION NOT MAPPED — AutoCount stock at a location with no ERP warehouse ---`);
    for (const [k, v] of [...unmappedLoc.entries()].sort((a, b) => b[1].units - a[1].units))
      notice(`    "${k}"  ${v.cells} cells / ${v.units} units`);
  }

  state.A = {
    stale, ageDays, cells: agree.length + higher.length + lower.length,
    agree: agree.length, agreeNonZero: agreeNonZero.length,
    higher: higher.length, higherUnits: sumBy(higher, (r) => r.delta),
    lower: lower.length, lowerUnits: sumBy(lower, (r) => r.delta),
    erpOnly: erpOnly.length, erpOnlyUnits: sumBy(erpOnly, (r) => r.erp),
    unmappedItems: unmappedItem.size, unmappedItemUnits: [...unmappedItem.values()].reduce((s, v) => s + v, 0),
    unmappedLocs: unmappedLoc.size, unmappedLocUnits: [...unmappedLoc.values()].reduce((s, v) => s + v.units, 0),
    sofaCodes: sofaCodesSeen.size, sofaCells, sofaUnits, erpSofaCells, erpSofaUnits,
    acNegative: acNegative.length, acNegativeAcUnits: sumBy(acNegative, (r) => r.ac),
    nonStockCodes: nonStockSeen.size, nonStockCells, nonStockUnits,
    acRowsConsidered,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION B — FIFO integrity
   ════════════════════════════════════════════════════════════════════════════ */
async function sectionB(state) {
  notice("");
  notice("================ (B) FIFO INTEGRITY — the layer ledger's own invariants ================");

  const lotSchema = ident(await tableSchema("inventory_lots") ?? "scm");
  const consSchema = ident(await tableSchema("inventory_lot_consumptions") ?? "scm");
  const movSchema = ident(await tableSchema("inventory_movements") ?? "scm");
  const lotCols = await cols(lotSchema, "inventory_lots");
  const hasCo = lotCols.has("company_id");
  const coFilter = hasCo ? `WHERE l.company_id = ${COMPANY}` : "";
  const coFilterAnd = hasCo ? `AND l.company_id = ${COMPANY}` : "";
  notice(`  schemas: lots=${lotSchema} consumptions=${consSchema} movements=${movSchema}; company scoping ${hasCo ? `ON (company ${COMPANY})` : "OFF (no company_id column)"}`);

  /* B1 — remaining = received - consumed, per layer. The trigger maintains
     qty_remaining by UPDATE while inventory_lot_consumptions records what was
     taken; if the two ever disagree, one of them is lying about how much stock
     is left and every downstream valuation inherits it. */
  const b1 = await sql.unsafe(`
    SELECT l.id, l.product_code, l.variant_key, l.batch_no, l.source_doc_type, l.source_doc_no,
           l.qty_received, l.qty_remaining, COALESCE(c.consumed, 0)::bigint AS consumed,
           (l.qty_remaining - (l.qty_received - COALESCE(c.consumed, 0)))::bigint AS drift
      FROM ${lotSchema}.inventory_lots l
      LEFT JOIN (SELECT lot_id, SUM(qty_consumed)::bigint AS consumed
                   FROM ${consSchema}.inventory_lot_consumptions GROUP BY lot_id) c ON c.lot_id = l.id
     ${coFilter}
       ${hasCo ? "AND" : "WHERE"} l.qty_remaining <> l.qty_received - COALESCE(c.consumed, 0)
     ORDER BY ABS(l.qty_remaining - (l.qty_received - COALESCE(c.consumed, 0))) DESC`);
  const b1Total = await sql.unsafe(
    `SELECT COUNT(*)::bigint AS lots, COALESCE(SUM(l.qty_remaining),0)::bigint AS open_units
       FROM ${lotSchema}.inventory_lots l ${coFilter}`);
  notice("");
  notice(`  B1 remaining = received - consumed : ${b1.length === 0 ? "OK — every layer reconciles" : `BROKEN on ${b1.length} layers`}   (layers checked: ${n(b1Total[0].lots)})`);
  for (const r of b1.slice(0, SAMPLE))
    notice(`     drift ${r.drift}  ${r.product_code} [${r.variant_key || "-"}] batch=${r.batch_no ?? "-"} received=${r.qty_received} remaining=${r.qty_remaining} consumed=${r.consumed}  src=${r.source_doc_type ?? "-"} ${r.source_doc_no ?? ""}`);

  /* B2 — impossible layers. A negative remaining means FIFO consumed past the
     end of a layer; remaining > received means something added back into a
     layer instead of opening a new one. Either makes the valuation nonsense. */
  const b2 = await sql.unsafe(`
    SELECT COUNT(*) FILTER (WHERE l.qty_remaining < 0)::bigint AS negative,
           COALESCE(SUM(l.qty_remaining) FILTER (WHERE l.qty_remaining < 0), 0)::bigint AS negative_units,
           COUNT(*) FILTER (WHERE l.qty_remaining > l.qty_received)::bigint AS over_remaining,
           COUNT(*) FILTER (WHERE l.qty_received < 0)::bigint AS negative_received
      FROM ${lotSchema}.inventory_lots l ${coFilter}`);
  const B2 = b2[0];
  notice(`  B2 no impossible layer             : negative remaining ${n(B2.negative)} (${n(B2.negative_units)} units); remaining > received ${n(B2.over_remaining)}; negative received ${n(B2.negative_received)}`);

  /* B3 — every consumed unit carries a cost. A consumption at unit_cost_sen = 0
     on a SHIPMENT is the COGS of a unit that left the building with nothing
     booked against it, and that is the defect this invariant is for.

     But not every consumption is a shipment. The cutover relayer
     (import-ac-stock-layers.mjs) reversed the whole flat opening balance with
     negative ADJUSTMENTs before re-opening it as real FIFO layers, and every one
     of those reversals consumes its lot. They are bookkeeping, they ship
     nothing, and the flat lots they unwound were the zero-cost ones by
     definition. Counting them as uncosted COGS is what made the previous run
     report "865 rows / 8,295 units" and declare FIFO NOT SOUND, while section C
     of the very same run found 0 units actually shipped from a zero-cost layer.
     Split by document type, and let only shipments decide the verdict. */
  const b3 = await sql.unsafe(`
    SELECT COUNT(*)::bigint AS rows_all, COALESCE(SUM(c.qty_consumed),0)::bigint AS units_all,
           COUNT(*) FILTER (WHERE c.unit_cost_sen <= 0)::bigint AS rows_zero,
           COALESCE(SUM(c.qty_consumed) FILTER (WHERE c.unit_cost_sen <= 0),0)::bigint AS units_zero,
           COUNT(*) FILTER (WHERE c.unit_cost_sen <= 0 AND COALESCE(c.source_doc_type,'') = 'DO')::bigint AS rows_zero_ship,
           COALESCE(SUM(c.qty_consumed) FILTER (WHERE c.unit_cost_sen <= 0 AND COALESCE(c.source_doc_type,'') = 'DO'),0)::bigint AS units_zero_ship,
           COALESCE(SUM(c.total_cost_sen),0)::bigint AS cogs_sen
      FROM ${consSchema}.inventory_lot_consumptions c
      JOIN ${lotSchema}.inventory_lots l ON l.id = c.lot_id ${coFilter}`);
  const B3 = b3[0];
  const zeroShipRows = n(B3.rows_zero_ship), zeroShipUnits = n(B3.units_zero_ship);
  const zeroNonShipRows = n(B3.rows_zero) - zeroShipRows, zeroNonShipUnits = n(B3.units_zero) - zeroShipUnits;
  notice(`  B3 every SHIPPED unit has a cost   : ${zeroShipRows === 0 ? "OK — no shipment drew from a zero-cost layer" : `BROKEN — ${zeroShipRows} shipment consumption rows at cost 0 (${zeroShipUnits} units)`}`);
  notice(`     [total consumed ${n(B3.units_all)} units over ${n(B3.rows_all)} rows, booked COGS ${rm(B3.cogs_sen)}]`);
  if (zeroNonShipRows > 0)
    notice(`     NOT COUNTED — ${zeroNonShipRows} zero-cost consumption rows (${zeroNonShipUnits} units) are non-shipment: cutover reversals and adjustments, which ship nothing.`);
  if (n(B3.rows_zero) > 0) {
    const b3d = await sql.unsafe(`
      SELECT COALESCE(c.source_doc_type,'(none)') AS src, COUNT(*)::bigint AS rows,
             COALESCE(SUM(c.qty_consumed),0)::bigint AS units
        FROM ${consSchema}.inventory_lot_consumptions c
        JOIN ${lotSchema}.inventory_lots l ON l.id = c.lot_id ${coFilter}
       ${hasCo ? "AND" : "WHERE"} c.unit_cost_sen <= 0
       GROUP BY 1 ORDER BY 3 DESC`);
    for (const r of b3d) notice(`     by document type: ${pad(r.src, 14)} ${pad(n(r.rows), 6)} rows / ${n(r.units)} units${r.src === "DO" ? "   <-- SHIPMENTS, these are real uncosted COGS" : "   (not a shipment)"}`);
  }

  /* B4 — the layer ledger against the movement ledger, per bucket. These are two
     independent books of the same stock; if they disagree the balance shown in
     the UI and the value shown on the valuation are describing different piles.
     Detail, root cause and samples live in check-inventory-integrity.mjs — this
     reports only whether the invariant holds today. */
  const b4 = await sql.unsafe(`
    WITH mv AS (
      SELECT warehouse_id, product_code, variant_key,
             SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                    WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END)::bigint AS qty
        FROM ${movSchema}.inventory_movements
       ${hasCo ? `WHERE company_id = ${COMPANY}` : ""}
       GROUP BY 1,2,3),
    lt AS (
      SELECT l.warehouse_id, l.product_code, l.variant_key, SUM(l.qty_remaining)::bigint AS qty
        FROM ${lotSchema}.inventory_lots l ${coFilter}
       GROUP BY 1,2,3)
    SELECT COALESCE(mv.warehouse_id, lt.warehouse_id) AS warehouse_id,
           COALESCE(mv.product_code, lt.product_code) AS product_code,
           COALESCE(mv.variant_key, lt.variant_key) AS variant_key,
           COALESCE(mv.qty,0) AS mv_qty, COALESCE(lt.qty,0) AS lot_qty,
           (COALESCE(mv.qty,0) - COALESCE(lt.qty,0)) AS delta
      FROM mv FULL OUTER JOIN lt
        ON mv.warehouse_id = lt.warehouse_id AND mv.product_code = lt.product_code AND mv.variant_key = lt.variant_key
     WHERE COALESCE(mv.qty,0) <> COALESCE(lt.qty,0)
     ORDER BY ABS(COALESCE(mv.qty,0) - COALESCE(lt.qty,0)) DESC`);
  const b4Units = b4.reduce((s, r) => s + Math.abs(n(r.delta)), 0);
  notice(`  B4 layers reconcile to movements   : ${b4.length === 0 ? "OK" : `${b4.length} buckets diverge, ${b4Units} units absolute`}   (detail: check-inventory-integrity.mjs)`);
  for (const r of b4.slice(0, SAMPLE))
    notice(`     delta ${pad(n(r.delta), 6)} ${pad(r.product_code, 34)} [${r.variant_key || "-"}] movements=${n(r.mv_qty)} layers=${n(r.lot_qty)}`);

  /* B5 — total inventory value equals the sum of the layers. The reported value
     comes from scm.v_inventory_all_skus, which the Inventory screen reads; that
     view restricts to ACTIVE warehouses and ACTIVE products, so any difference
     from the raw layer sum is value the screen cannot show. Reporting BOTH
     numbers is the point: one of them is what the owner sees. */
  const b5 = await sql.unsafe(`
    SELECT COALESCE(SUM(l.qty_remaining * l.unit_cost_sen),0)::bigint AS value_sen,
           COALESCE(SUM(l.qty_remaining),0)::bigint AS units
      FROM ${lotSchema}.inventory_lots l
     WHERE l.qty_remaining > 0 ${coFilterAnd}`);
  let viewValue = null, viewNote = "";
  const viewSchema = await tableSchema("v_inventory_all_skus");
  if (viewSchema) {
    const viewCols = await cols(viewSchema, "v_inventory_all_skus");
    const where = viewCols.has("company_id") ? `WHERE company_id = ${COMPANY}` : "";
    if (!where) viewNote = " (view has no company_id — figure spans every company)";
    try {
      const vv = await sql.unsafe(
        `SELECT COALESCE(SUM(value_sen),0)::bigint AS value_sen FROM ${ident(viewSchema)}.v_inventory_all_skus ${where}`);
      viewValue = n(vv[0].value_sen);
    } catch (e) { viewNote = ` (view read failed: ${e.message})`; }
  } else viewNote = " (view not present)";
  notice(`  B5 total value = sum of layers     : layers ${rm(b5[0].value_sen)} over ${n(b5[0].units)} open units`);
  if (viewValue == null) notice(`     reported value (v_inventory_all_skus): UNAVAILABLE${viewNote}`);
  else {
    const d = viewValue - n(b5[0].value_sen);
    notice(`     reported value (v_inventory_all_skus): ${rm(viewValue)}${viewNote}  ->  ${d === 0 ? "EQUAL" : `DIFFERS by ${rm(d)}`}`);
    if (d !== 0) notice(`     a difference here is value held on an INACTIVE warehouse or a non-ACTIVE product: real stock the Inventory screen does not add up.`);
  }

  /* B6 — zero-cost OPEN layers, with the documents behind them. Not a broken
     invariant: a layer legitimately opens at 0 while a Purchase Invoice is
     pending. It is reported separately because those units will book RM0 COGS
     if FIFO reaches them first. check-costless-stock.mjs splits them into
     "a PI can still heal this" vs "permanent". */
  const b6 = await sql.unsafe(`
    SELECT COALESCE(l.source_doc_type,'(none)') AS src, COUNT(*)::bigint AS lots,
           COALESCE(SUM(l.qty_remaining),0)::bigint AS units
      FROM ${lotSchema}.inventory_lots l
     WHERE l.qty_remaining > 0 AND l.unit_cost_sen <= 0 ${coFilterAnd}
     GROUP BY 1 ORDER BY 3 DESC`);
  const b6Lots = b6.reduce((s, r) => s + n(r.lots), 0);
  const b6Units = b6.reduce((s, r) => s + n(r.units), 0);
  notice("");
  notice(`  B6 ZERO-COST OPEN LAYERS           : ${b6Lots} layers holding ${b6Units} units with NO cost basis`);
  for (const r of b6) notice(`     ${pad(r.src, 16)} ${pad(n(r.lots), 6)} layers / ${n(r.units)} units`);
  if (b6Lots > 0) {
    const b6d = await sql.unsafe(`
      SELECT COALESCE(l.source_doc_no,'(none)') AS doc, COALESCE(l.source_doc_type,'(none)') AS src,
             COUNT(*)::bigint AS lots, COALESCE(SUM(l.qty_remaining),0)::bigint AS units
        FROM ${lotSchema}.inventory_lots l
       WHERE l.qty_remaining > 0 AND l.unit_cost_sen <= 0 ${coFilterAnd}
       GROUP BY 1,2 ORDER BY 4 DESC LIMIT ${SAMPLE}`);
    notice(`     --- documents behind them (top ${b6d.length}) ---`);
    for (const r of b6d) notice(`     ${pad(r.src, 14)} ${pad(r.doc, 28)} ${pad(n(r.lots), 5)} layers / ${n(r.units)} units`);
  }

  state.B = {
    lots: n(b1Total[0].lots), b1Broken: b1.length,
    negative: n(B2.negative), negativeUnits: n(B2.negative_units), overRemaining: n(B2.over_remaining),
    consumedRows: n(B3.rows_all), consumedUnits: n(B3.units_all), cogsSen: n(B3.cogs_sen),
    zeroCostConsRows: n(B3.rows_zero), zeroCostConsUnits: n(B3.units_zero),
    zeroShipRows, zeroShipUnits, zeroNonShipRows, zeroNonShipUnits,
    b4Buckets: b4.length, b4Units,
    layerValueSen: n(b5[0].value_sen), openUnits: n(b5[0].units), viewValueSen: viewValue,
    zeroCostLots: b6Lots, zeroCostUnits: b6Units,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION C — delivered COGS
   ════════════════════════════════════════════════════════════════════════════ */
const SHIPPED_STATES = ["DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED"];

async function sectionC(state) {
  notice("");
  notice("================ (C) DELIVERED COGS — did shipped units draw cost from a real layer? ================");

  const doSchema = ident(await tableSchema("delivery_orders") ?? "scm");
  const doiCols = await cols(doSchema, "delivery_order_items");
  const doCols = await cols(doSchema, "delivery_orders");
  const costCol = ["unit_cost_centi"].find((c) => doiCols.has(c));
  const lineCostCol = ["line_cost_centi"].find((c) => doiCols.has(c));
  const revCol = ["line_total_centi"].find((c) => doiCols.has(c));
  const migCol = doCols.has("migrated_no_stock") ? "migrated_no_stock" : null;
  notice(`  columns: delivery_order_items.${costCol ?? "unit_cost_centi MISSING"} / ${lineCostCol ?? "line_cost_centi MISSING"} / ${revCol ?? "line_total_centi MISSING"}; delivery_orders.${migCol ?? "migrated_no_stock ABSENT"}`);
  if (!costCol || !revCol) {
    notice("  CANNOT MEASURE: the delivered-cost columns are not present on this database. Reporting nothing rather than a guess.");
    state.C = { unavailable: true };
    return;
  }

  const states = SHIPPED_STATES.map((s) => `'${ident(s.toLowerCase()).toUpperCase()}'`).join(",");
  const coFilter = doCols.has("company_id") ? `AND d.company_id = ${COMPANY}` : "";
  const migSel = migCol ? `COALESCE(d.${migCol}, false)` : "false";

  /* The document-side question. This is the number the owner sees: a delivery
     order line, and therefore the sales invoice built from it and the margin on
     the Sales report, carrying a zero cost. Service lines are excluded — a
     delivery fee has no stock and no COGS, so counting it would inflate the
     finding. */
  const svc = doiCols.has("item_group") ? `AND COALESCE(i.item_group,'') NOT IN ('SERVICE','TRANS','TRANSPORT')` : "";
  const c1 = await sql.unsafe(`
    SELECT ${migSel} AS migrated,
           COUNT(*)::bigint AS lines,
           COALESCE(SUM(i.qty),0)::bigint AS units,
           COUNT(*) FILTER (WHERE COALESCE(i.${costCol},0) <= 0)::bigint AS zero_lines,
           COALESCE(SUM(i.qty) FILTER (WHERE COALESCE(i.${costCol},0) <= 0),0)::bigint AS zero_units,
           COALESCE(SUM(i.${revCol}) FILTER (WHERE COALESCE(i.${costCol},0) <= 0),0)::bigint AS zero_revenue_centi,
           COALESCE(SUM(i.qty * i.${costCol}),0)::bigint AS booked_cost_centi
      FROM ${doSchema}.delivery_order_items i
      JOIN ${doSchema}.delivery_orders d ON d.id = i.delivery_order_id
     WHERE d.status IN (${states}) AND i.qty > 0 ${svc} ${coFilter}
     GROUP BY 1 ORDER BY 1`);

  let tLines = 0, tUnits = 0, zLines = 0, zUnits = 0, zRev = 0, booked = 0;
  const byOrigin = new Map(c1.map((r) => [String(r.migrated), r]));
  notice("");
  notice(`  delivered lines by origin (statuses ${SHIPPED_STATES.join("/")}, service lines excluded):`);
  /* Both rows print even at zero. The previous run emitted only the MIGRATED row,
     so "70 of 70 delivered units carry zero COGS" read as a total failure of
     costing when what it actually meant was that this company has not shipped a
     single NORMAL delivery order yet. An absent row is an answer; a missing row
     is a trap. */
  for (const key of ["false", "true"]) {
    const r = byOrigin.get(key);
    const label = key === "true" ? "MIGRATED (no movements posted)" : "NORMAL   (movements posted)   ";
    if (!r) { notice(`    ${label} : ${pad(0, 6)} lines / ${pad(0, 7)} units | none exist`); continue; }
    tLines += n(r.lines); tUnits += n(r.units); zLines += n(r.zero_lines);
    zUnits += n(r.zero_units); zRev += n(r.zero_revenue_centi); booked += n(r.booked_cost_centi);
    notice(`    ${label} : ${pad(n(r.lines), 6)} lines / ${pad(n(r.units), 7)} units | zero-cost ${n(r.zero_lines)} lines / ${n(r.zero_units)} units | revenue behind them ${rm(n(r.zero_revenue_centi))}`);
  }
  const migOnly = !byOrigin.has("false") && byOrigin.has("true");
  notice("");
  notice(`  DELIVERED UNITS WITH ZERO COGS     : ${zUnits} units on ${zLines} lines (of ${tUnits} units on ${tLines} lines delivered)`);
  notice(`  RM IMPACT (revenue booked at 100% margin, EXACT from line_total_centi): ${rm(zRev)}`);
  notice(`  cost actually booked on delivered lines: ${rm(booked)}`);
  if (migOnly)
    notice(`  READ THIS BEFORE THE RATIO: every delivered line here is MIGRATED. Company ${COMPANY} has shipped NO normal`);
  if (migOnly)
    notice(`        delivery order yet, so "${zUnits} of ${tUnits}" is 100% by construction, not a costing collapse.`);
  if (zRev === 0 && zLines > 0)
    notice(`  WHY THE RM IMPACT IS ZERO: those lines carry no PRICE either — the migration wrote neither cost nor`);
  if (zRev === 0 && zLines > 0)
    notice(`        price (create-migrated-documents.mjs). That is its own finding: converted as-is they become`);
  if (zRev === 0 && zLines > 0)
    notice(`        zero-value sales invoices. It is NOT evidence that the uncosted units are harmless.`);
  notice(`  NOTE: the true cost of those units is UNKNOWN — that is the defect. The figure above is the revenue`);
  notice(`        carrying no cost, which is exact. No estimate of "what it should have cost" is asserted here.`);

  if (migCol) {
    notice("");
    notice(`  Why the split matters: a MIGRATED delivery order (migration 0276 migrated_no_stock) posts NO inventory`);
    notice(`  movement at all — the AutoCount opening balance already counted those goods. It therefore consumes no`);
    notice(`  layer and can never acquire a cost from FIFO. Converting one to a Sales Invoice copies the DO line cost`);
    notice(`  verbatim, so a zero here becomes a 100%-margin invoice.`);
  }

  /* The movement-side cross-check, so the document answer is not taken on
     trust. An OUT movement on a live delivery order that booked total_cost_sen
     = 0 is the same failure seen from the stock ledger. */
  const movSchema = ident(await tableSchema("inventory_movements") ?? "scm");
  const movCols = await cols(movSchema, "inventory_movements");
  const movCo = movCols.has("company_id") ? `AND m.company_id = ${COMPANY}` : "";
  const c2 = await sql.unsafe(`
    SELECT COUNT(*)::bigint AS outs, COALESCE(SUM(m.qty),0)::bigint AS units,
           COUNT(*) FILTER (WHERE COALESCE(m.total_cost_sen,0) = 0)::bigint AS zero_outs,
           COALESCE(SUM(m.qty) FILTER (WHERE COALESCE(m.total_cost_sen,0) = 0),0)::bigint AS zero_units
      FROM ${movSchema}.inventory_movements m
      JOIN ${doSchema}.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.movement_type = 'OUT' AND m.source_doc_type = 'DO'
       AND d.status <> 'CANCELLED' ${movCo}`);
  const C2 = c2[0];
  notice("");
  notice(`  cross-check from the STOCK side    : ${n(C2.zero_outs)} of ${n(C2.outs)} live DO OUT movements booked total_cost_sen = 0 (${n(C2.zero_units)} of ${n(C2.units)} units)`);

  /* And the layer-side: units that DID consume a layer, but a layer whose cost
     was zero. Those are the shipments the zero-cost open layers of B6 will keep
     producing until the layers are priced. */
  const consSchema = ident(await tableSchema("inventory_lot_consumptions") ?? "scm");
  const c3 = await sql.unsafe(`
    SELECT COALESCE(SUM(c.qty_consumed),0)::bigint AS units, COUNT(*)::bigint AS rows
      FROM ${consSchema}.inventory_lot_consumptions c
     WHERE c.unit_cost_sen <= 0 AND c.source_doc_type = 'DO'`);
  notice(`  units shipped FROM a zero-cost layer: ${n(c3[0].units)} units over ${n(c3[0].rows)} consumption rows`);

  state.C = {
    migOnly,
    lines: tLines, units: tUnits, zeroLines: zLines, zeroUnits: zUnits,
    zeroRevenueCenti: zRev, bookedCostCenti: booked,
    zeroOuts: n(C2.zero_outs), outs: n(C2.outs), zeroOutUnits: n(C2.zero_units),
    zeroLayerUnits: n(c3[0].units),
  };
}

/* ════════════════════════════════════════════════════════════════════════════ */
async function main() {
  notice("=== STOCK TRUTH CHECK — READ-ONLY (no rows changed, no costing logic touched) ===");
  notice(`run at ${new Date().toISOString()}`);
  const state = {};
  await sectionA(state);
  await sectionB(state);
  await sectionC(state);

  const A = state.A, B = state.B, C = state.C;
  notice("");
  notice("================ VERDICT ================");
  const balOk = A.higher === 0 && A.lower === 0 && A.erpOnly === 0;
  notice(`VERDICT BALANCE : ${balOk ? "AGREES" : "DIVERGES"} — ${A.agreeNonZero} of ${A.cells - (A.agree - A.agreeNonZero)} non-zero cells agree; ERP higher ${A.higher} (+${A.higherUnits}u); ERP lower ${A.lower} (${A.lowerUnits}u); ERP-only ${A.erpOnly} (${A.erpOnlyUnits}u); unmapped items ${A.unmappedItems} (${A.unmappedItemUnits}u); unmapped locations ${A.unmappedLocs} (${A.unmappedLocUnits}u)${A.stale ? "; SNAPSHOT STALE" : ""}`);
  notice(`                  NOT COMPARABLE (excluded from the above, by design): AC-negative ${A.acNegative} cells (AC ${A.acNegativeAcUnits}u); non-stock SERVICE/TRANS ${A.nonStockCells} cells (${A.nonStockUnits}u); SOFA ${A.sofaCells} AC cells (${A.sofaUnits}u) / ${A.erpSofaCells} ERP cells (${A.erpSofaUnits}u)`);
  const fifoOk = B.b1Broken === 0 && B.negative === 0 && B.overRemaining === 0 && B.zeroShipRows === 0 && B.b4Buckets === 0;
  notice(`VERDICT FIFO    : ${fifoOk ? "SOUND" : "NOT SOUND"} — B1 layer-arithmetic broken on ${B.b1Broken} of ${B.lots} layers; B2 negative ${B.negative}, over-remaining ${B.overRemaining}; B3 zero-cost SHIPMENT consumptions ${B.zeroShipRows} rows (${B.zeroShipUnits}u) [+${B.zeroNonShipRows} non-shipment rows (${B.zeroNonShipUnits}u) not counted]; B4 layer-vs-movement buckets diverging ${B.b4Buckets} (${B.b4Units}u); B5 layer value ${rm(B.layerValueSen)} vs reported ${B.viewValueSen == null ? "n/a" : rm(B.viewValueSen)}; B6 zero-cost open layers ${B.zeroCostLots} (${B.zeroCostUnits}u)`);
  if (C.unavailable) notice(`VERDICT COGS    : UNMEASURABLE — the delivered-cost columns are absent on this database.`);
  else {
    const cogsOk = C.zeroUnits === 0;
    notice(`VERDICT COGS    : ${cogsOk ? "FULLY COSTED" : "PARTLY UNCOSTED"} — ${C.zeroUnits} of ${C.units} delivered units carry zero COGS on ${C.zeroLines} of ${C.lines} lines; RM impact (revenue with no cost behind it) ${rm(C.zeroRevenueCenti)}; stock-side ${C.zeroOutUnits} units on ${C.zeroOuts} zero-cost DO OUT movements; ${C.zeroLayerUnits} units shipped from a zero-cost layer`);
    if (C.migOnly) notice(`                  ALL of them are MIGRATED lines — this company has shipped no normal delivery order yet, so the ratio is 100% by construction.`);
  }
  notice("");
  notice("This check measured. It repaired nothing. Re-run it after any repair and compare the three VERDICT lines.");
  notice("=== END — read-only, no rows changed. ===");
  await sql.end();
}

main().catch(async (e) => {
  console.error(e?.stack ?? String(e));
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
});
