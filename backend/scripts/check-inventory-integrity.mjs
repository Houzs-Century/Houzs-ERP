#!/usr/bin/env node
// Read-only reconciliation between the two inventory ledgers that MUST agree:
// the MOVEMENT ledger (inventory_movements — the running IN/OUT/ADJUSTMENT rows
// the Stock Breakdown drawer shows) and the FIFO ledger (inventory_lots +
// inventory_lot_consumptions — the owned lots and the COGS behind each ship).
//
// WHY THIS EXISTS (owner report 2026-07-25: SKU "MAKOTO RC(S)-FVI BRONZE", KL).
// The Stock Breakdown drawer showed FOUR movements ending at running balance 3
// (5 IN - 2 OUT), but the FIFO lots summed to 4 and COGS had only ONE
// consumption — two OUT movements on the SAME DO (2990-DO-2607-018, 11:47 and
// 12:22) but only one lot-consumption. The movement ledger and the FIFO ledger
// DISAGREE. Traced root cause (docs/inventory-ledger-divergence-coe.md): the
// FIFO trigger's OUT branch (scripts/scm-schema/inventory-fifo-trigger.sql:176)
// ALWAYS runs fn_consume_fifo for every OUT movement but DISCARDS the qty_short
// it returns — so an OUT whose (warehouse, product, variant[, batch]) key
// matches ZERO open lots is recorded as a real movement (balance decrements) yet
// consumes nothing and decrements no lot (lots + COGS unchanged). The second
// MAKOTO OUT is a resyncInventoryForDo DELTA OUT (delivery-orders-mfg.ts:1141)
// written when the shipped DO was edited 35 min later; its consume key matched
// no open lot (sofa batch / variant mismatch), so it shorted against stock that
// was physically present — a FALSE short, discarded.
//
// This script SIZES that divergence across ALL SKUs / warehouses / companies, so
// the owner can see the exposure before deciding on a fix + a data repair (both
// DEFERRED — see the COE). It reports two independent concerns, one SELECT each:
//
//   (1) QUANTITY DRIFT — buckets where the signed movement sum (exactly the
//       scm.inventory_balances convention: IN +qty, OUT -qty, ADJUSTMENT/TRANSFER
//       +qty) does NOT equal the sum of inventory_lots.qty_remaining. This is the
//       MAKOTO 3-vs-4 case. Delta > 0 = movements say fewer on hand than the lots
//       hold (an OUT consumed nothing); delta < 0 = lots hold fewer than the
//       movements imply.
//
//   (2) UNCOSTED OUT — buckets where Sum(OUT movement qty) does NOT equal
//       Sum(qty_consumed) in inventory_lot_consumptions for those OUT movements.
//       The unmatched units shipped with NO COGS behind them (the 2-OUT-vs-1-COGS
//       case). RM exposure is ESTIMATED at the bucket's current open-lot weighted
//       average cost (labelled ESTIMATE — the real cost only books when the units
//       are actually costed).
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no marker
// rows, NO change to any costing logic. Every interpolated identifier is a
// schema/column name DISCOVERED from information_schema and re-validated against
// ^[a-z_][a-z0-9_]*$; no user input reaches any statement. Exits 0 for every
// legitimate answer (the ANSWER is the output, not the exit code); non-zero only
// when the database is unreachable or a query errors.
//
// Mirrors backend/scripts/check-uncosted-cogs.mjs + check-soak-gate.mjs (the
// repo's read-only-diagnostic shape) and its workflow
// .github/workflows/inventory-integrity-check.yml.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs / check-soak-gate.mjs: env wins so CI
// needs no .dev.vars.
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

// `notice` surfaces each line on the workflow run's summary page so the verdict
// is readable without opening the log.
const notice = (m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const SAFE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const pad = (s, n) => String(s).padEnd(n);
const rm = (sen) => (sen == null ? "-" : `RM${(Number(sen) / 100).toFixed(2)}`);
const short = (s, n) => {
  const v = s == null ? "-" : String(s);
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};
const SAMPLE = 30; // rows to print per section (counts + totals are always full)

// Discover which schema a table lives in (scm on prod; public on some envs).
// Never assume — mirror check-uncosted-cogs.mjs.
async function schemaOf(table) {
  ident(table);
  const r = await pg`
    SELECT table_schema FROM information_schema.tables
     WHERE table_name = ${table}
       AND table_schema IN ('scm','public')
       AND table_type = 'BASE TABLE'
     ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END`;
  return r[0]?.table_schema ?? null;
}
async function colsOf(schema, table) {
  const r = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}

async function main() {
  notice("=== INVENTORY LEDGER INTEGRITY DETECTOR — READ-ONLY (no rows changed, no costing logic touched) ===");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  const lotSchema = await schemaOf("inventory_lots");
  const consSchema = await schemaOf("inventory_lot_consumptions");
  if (!movSchema || !lotSchema || !consSchema) {
    notice("FATAL — one of inventory_movements / inventory_lots / inventory_lot_consumptions was not found in scm or public. Cannot run. (This is a missing-table condition, not a data answer.)");
    return;
  }
  const movCols = await colsOf(movSchema, "inventory_movements");
  const lotCols = await colsOf(lotSchema, "inventory_lots");
  const movHasCompany = movCols.has("company_id");
  const lotHasCompany = lotCols.has("company_id");
  // Group by company only when BOTH ledgers carry it (they do on prod since 0061);
  // otherwise fall back to (warehouse, product, variant) so the join still lines up.
  const byCompany = movHasCompany && lotHasCompany;
  notice(`schemas: inventory_movements=${movSchema}  inventory_lots=${lotSchema}  inventory_lot_consumptions=${consSchema}`);
  notice(`company_id present? movements=${movHasCompany ? "YES" : "NO"}  lots=${lotHasCompany ? "YES" : "NO"}  -> grouping ${byCompany ? "WITH" : "WITHOUT"} company_id`);
  notice("");

  const M = `"${ident(movSchema)}"."inventory_movements"`;
  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;
  // Optional company column, spliced identically into every CTE so the FULL JOIN
  // keys line up. NULL::int keeps the SELECT list shape stable when absent.
  const coSel = byCompany ? "company_id" : "NULL::int AS company_id";
  const coGrp = byCompany ? ", company_id" : "";

  // ============================================================
  // (1) QUANTITY DRIFT — signed movement sum vs sum(lot.qty_remaining)
  // ============================================================
  // The signed CASE is byte-identical to scm.inventory_balances (migration 0084),
  // so a drift here is the SAME divergence the app's own on-hand views show.
  const driftRows = await pg.unsafe(`
    WITH mov AS (
      SELECT ${coSel},
             warehouse_id::text AS warehouse_id,
             product_code,
             COALESCE(variant_key,'') AS variant_key,
             SUM(CASE movement_type
                   WHEN 'IN' THEN qty
                   WHEN 'OUT' THEN -qty
                   WHEN 'ADJUSTMENT' THEN qty
                   WHEN 'TRANSFER' THEN qty
                   ELSE 0 END) AS mov_qty,
             MAX(product_name) AS product_name
        FROM ${M}
       GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')${coGrp}
    ),
    lot AS (
      SELECT ${coSel},
             warehouse_id::text AS warehouse_id,
             product_code,
             COALESCE(variant_key,'') AS variant_key,
             SUM(qty_remaining) AS lot_qty
        FROM ${L}
       GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')${coGrp}
    )
    SELECT COALESCE(mov.company_id, lot.company_id)       AS company_id,
           COALESCE(mov.warehouse_id, lot.warehouse_id)   AS warehouse_id,
           COALESCE(mov.product_code, lot.product_code)   AS product_code,
           COALESCE(mov.variant_key, lot.variant_key)     AS variant_key,
           COALESCE(mov.product_name, '')                 AS product_name,
           COALESCE(mov.mov_qty, 0)                        AS mov_qty,
           COALESCE(lot.lot_qty, 0)                        AS lot_qty,
           COALESCE(mov.mov_qty, 0) - COALESCE(lot.lot_qty, 0) AS delta
      FROM mov
      FULL OUTER JOIN lot
        ON  mov.warehouse_id = lot.warehouse_id
        AND mov.product_code = lot.product_code
        AND mov.variant_key  = lot.variant_key
        ${byCompany ? "AND mov.company_id = lot.company_id" : ""}
     WHERE COALESCE(mov.mov_qty, 0) <> COALESCE(lot.lot_qty, 0)
     ORDER BY ABS(COALESCE(mov.mov_qty, 0) - COALESCE(lot.lot_qty, 0)) DESC, product_code ASC`);

  const totalDriftUnits = driftRows.reduce((a, r) => a + Math.abs(Number(r.delta)), 0);
  notice("================ (1) QUANTITY DRIFT — movement ledger vs FIFO lots ================");
  notice("  Sigma(inventory_movements, signed) should EQUAL Sigma(inventory_lots.qty_remaining) for every bucket.");
  notice(`  buckets in drift                 : ${driftRows.length}`);
  notice(`  total absolute unit drift        : ${totalDriftUnits}`);
  notice("");
  if (driftRows.length) {
    notice(`  sample (up to ${SAMPLE}, largest |delta| first):`);
    notice(`    ${pad("product", 22)} ${pad("variant", 10)} ${pad("co", 3)} ${pad("movQty", 7)} ${pad("lotQty", 7)} ${pad("delta", 7)} warehouse`);
    for (const r of driftRows.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.product_code, 22), 22)} ${pad(short(r.variant_key, 10), 10)} ${pad(r.company_id ?? "-", 3)} ${pad(r.mov_qty, 7)} ${pad(r.lot_qty, 7)} ${pad(r.delta, 7)} ${short(r.warehouse_id, 40)}`);
    }
    if (driftRows.length > SAMPLE) notice(`    ... and ${driftRows.length - SAMPLE} more.`);
    notice("");
  } else {
    notice("  none — every bucket's movement sum equals its lot sum. (No MAKOTO-style drift.)");
    notice("");
  }

  // ============================================================
  // (2) UNCOSTED OUT — Sigma(OUT qty) vs Sigma(consumed qty) per bucket
  // ============================================================
  // costed_qty = qty_consumed summed over the consumptions linked (movement_id)
  // to each OUT movement. uncosted = OUT qty - costed_qty > 0 means units shipped
  // with no lot behind them (the 2-OUT-vs-1-COGS case). RM exposure is ESTIMATED
  // at the bucket's current open-lot weighted-average cost.
  const uncostedRows = await pg.unsafe(`
    WITH out_mov AS (
      SELECT ${coSel},
             m.warehouse_id::text AS warehouse_id,
             m.product_code,
             COALESCE(m.variant_key,'') AS variant_key,
             MAX(m.product_name) AS product_name,
             SUM(m.qty) AS out_qty,
             SUM(COALESCE(c.costed_qty, 0)) AS costed_qty,
             SUM(COALESCE(m.total_cost_sen, 0)) AS out_cost_sen
        FROM ${M} m
        LEFT JOIN (
          SELECT movement_id, SUM(qty_consumed) AS costed_qty
            FROM ${C}
           GROUP BY movement_id
        ) c ON c.movement_id = m.id
       WHERE m.movement_type = 'OUT'
       GROUP BY m.warehouse_id, m.product_code, COALESCE(m.variant_key,'')${byCompany ? ", m.company_id" : ""}
    ),
    lotcost AS (
      SELECT ${coSel},
             warehouse_id::text AS warehouse_id,
             product_code,
             COALESCE(variant_key,'') AS variant_key,
             CASE WHEN SUM(qty_remaining) > 0
                  THEN SUM(qty_remaining * unit_cost_sen) / SUM(qty_remaining)
                  ELSE 0 END AS avg_cost_sen
        FROM ${L}
       WHERE qty_remaining > 0
       GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')${coGrp}
    )
    SELECT o.company_id,
           o.warehouse_id,
           o.product_code,
           o.variant_key,
           COALESCE(o.product_name,'') AS product_name,
           o.out_qty,
           o.costed_qty,
           o.out_qty - o.costed_qty AS uncosted_qty,
           o.out_cost_sen,
           COALESCE(lc.avg_cost_sen, 0) AS avg_cost_sen,
           (o.out_qty - o.costed_qty) * COALESCE(lc.avg_cost_sen, 0) AS est_exposure_sen
      FROM out_mov o
      LEFT JOIN lotcost lc
        ON  o.warehouse_id = lc.warehouse_id
        AND o.product_code = lc.product_code
        AND o.variant_key  = lc.variant_key
        ${byCompany ? "AND o.company_id = lc.company_id" : ""}
     WHERE o.out_qty <> o.costed_qty
     ORDER BY (o.out_qty - o.costed_qty) DESC, product_code ASC`);

  const totalUncostedUnits = uncostedRows.reduce((a, r) => a + Number(r.uncosted_qty), 0);
  const totalExposureSen = uncostedRows.reduce((a, r) => a + Number(r.est_exposure_sen), 0);
  notice("================ (2) UNCOSTED OUT — OUT movement qty vs consumed qty ================");
  notice("  Sigma(OUT qty) should EQUAL Sigma(qty_consumed) in inventory_lot_consumptions for every bucket.");
  notice(`  buckets with uncosted OUT units  : ${uncostedRows.length}`);
  notice(`  total uncosted OUT units         : ${totalUncostedUnits}`);
  notice(`  ESTIMATED RM exposure (open-lot avg cost): ${rm(totalExposureSen)}  (${totalExposureSen} sen) -- ESTIMATE only`);
  notice("");
  if (uncostedRows.length) {
    notice(`  sample (up to ${SAMPLE}, most uncosted units first):`);
    notice(`    ${pad("product", 22)} ${pad("variant", 10)} ${pad("co", 3)} ${pad("outQty", 7)} ${pad("costed", 7)} ${pad("uncost", 7)} ${pad("est.RM", 12)} warehouse`);
    for (const r of uncostedRows.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.product_code, 22), 22)} ${pad(short(r.variant_key, 10), 10)} ${pad(r.company_id ?? "-", 3)} ${pad(r.out_qty, 7)} ${pad(r.costed_qty, 7)} ${pad(r.uncosted_qty, 7)} ${pad(rm(r.est_exposure_sen), 12)} ${short(r.warehouse_id, 40)}`);
    }
    if (uncostedRows.length > SAMPLE) notice(`    ... and ${uncostedRows.length - SAMPLE} more.`);
    notice("");
  } else {
    notice("  none — every bucket's OUT qty is fully backed by lot consumptions.");
    notice("");
  }

  // ============================================================
  // TOTALS — the size the owner asked for
  // ============================================================
  notice("================ SUMMARY ================");
  notice(`  (1) quantity-drift buckets       : ${driftRows.length}   (total |unit| drift ${totalDriftUnits})`);
  notice(`  (2) uncosted-OUT buckets         : ${uncostedRows.length}   (total uncosted units ${totalUncostedUnits})`);
  notice(`      estimated RM exposure        : ${rm(totalExposureSen)}  -- ESTIMATE, at current open-lot avg cost`);
  notice("");
  notice("  INTERPRETATION (owner decides the fix — this script changes NOTHING):");
  notice("   - A bucket in BOTH lists with delta > 0 and uncosted_qty > 0 is the MAKOTO pattern: an OUT movement");
  notice("     recorded (balance decremented) whose FIFO consume matched no open lot, so lots + COGS never moved.");
  notice("   - Root cause + the DEFERRED fix (extend the consume/repair path; then a careful data repair) are in");
  notice("     docs/inventory-ledger-divergence-coe.md. Both are owner-approved, STAGING-first changes — NOT here.");
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("INVENTORY_INTEGRITY_CHECK_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
