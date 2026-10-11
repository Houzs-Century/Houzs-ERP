#!/usr/bin/env node
// Read-only detector for PERMANENTLY-UNCOSTED COGS on shipped Delivery Orders.
//
// WHY THIS EXISTS (owner ask 2026-07-24: "some accessories were already SHIPPED
// but the DO shows NO cost — RM0"). An audit of the scm FIFO costing layer found
// a real, money-critical gap. It is NOT a bug in the pipeline itself — IN/OUT/
// FIFO/allocation are all correct by design — it is a WIRING gap:
//
//   The soft "ship anyway" oversell path lets a DO ship more than the warehouse
//   holds. fn_consume_fifo then costs only what is on hand and DISCARDS the
//   qty_short, so the short units ship at ZERO recorded cost (the OUT movement's
//   total_cost_sen reflects only the available units). That RM0 is meant to be
//   retro-costed LATER by fn_reconcile_uncosted_out (migration 0154) when the
//   replenishing stock arrives — BUT that reconcile is invoked from exactly ONE
//   place: the GRN post handler (backend/src/scm/routes/grns.ts:493). Every OTHER
//   stock-IN path opens lots WITHOUT retro-costing the prior short:
//     stock-transfers.ts, stock-takes.ts, inventory adjustments,
//     purchase-consignment-receives.ts, delivery/consignment/purchase returns.
//   So when an oversold accessory is replenished by an inter-warehouse TRANSFER
//   or a positive STOCK-TAKE (routine in a multi-branch shop) rather than a GRN,
//   the RM0 OUT is NEVER retro-costed. COGS stays understated -> margin
//   OVERSTATED permanently, and inventory_balances (signed movement sum) diverges
//   from v_inventory_value (Sum of inventory_lots.qty_remaining) forever.
//
// This script SIZES that exposure so the owner can decide whether to extend the
// reconcile (or add a sweep). It runs the two queries the audit designed:
//
//   (a) UNCOSTED / RM0 OUT movements on NON-CANCELLED DOs — every shipped DO line
//       whose OUT movement has units with no lot consumption (uncosted_qty > 0)
//       and/or booked at total_cost_sen = 0.
//   (b) Of the SHORT-COSTED buckets in (a), which have OPEN replenishment lots
//       RIGHT NOW (same warehouse+product+variant+company). Those are the TRUE
//       PERMANENT-MISS set: stock is physically present that a GRN-post reconcile
//       WOULD have consumed, but no GRN post ever fired for it, so the OUT sits
//       uncosted while its cover sits unconsumed. For each it estimates the
//       understated COGS at the oldest open lot's unit cost (FIFO), labelled
//       ESTIMATE (the authoritative number only lands when the cost is actually
//       booked).
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no
// backfill, NO change to any costing logic. Every interpolated identifier is a
// schema/column name this file DISCOVERS from information_schema and re-validates
// against ^[a-z_][a-z0-9_]*$; no user input reaches any statement. Exits 0 for
// every legitimate answer (the ANSWER is the output, not the exit code); non-zero
// only when the database is unreachable or a query errors.
//
// Mirrors backend/scripts/check-soak-gate.mjs + diag-do-payments.mjs (the repo's
// read-only-diagnostic shape) and its workflow .github/workflows/uncosted-cogs-check.yml.
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
const dateOnly = (v) => (v == null ? null : String(v).slice(0, 10));
const SAMPLE = 25; // rows to print per section (counts are always full)

// Discover which schema a table lives in (scm on prod; public on some envs).
// Never assume — mirror diag-do-payments.mjs.
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
  notice("=== UNCOSTED COGS DETECTOR — READ-ONLY (no rows changed, no costing logic touched) ===");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  const lotSchema = await schemaOf("inventory_lots");
  const consSchema = await schemaOf("inventory_lot_consumptions");
  const doSchema = await schemaOf("delivery_orders");
  if (!movSchema || !lotSchema || !consSchema || !doSchema) {
    notice("FATAL — one of inventory_movements / inventory_lots / inventory_lot_consumptions / delivery_orders was not found in scm or public. Cannot run. (This is a missing-table condition, not a data answer.)");
    return;
  }
  const movCols = await colsOf(movSchema, "inventory_movements");
  const doCols = await colsOf(doSchema, "delivery_orders");
  const hasCompany = movCols.has("company_id");
  const hasDropship = doCols.has("is_dropship");
  notice(`schemas: inventory_movements=${movSchema}  inventory_lots=${lotSchema}  inventory_lot_consumptions=${consSchema}  delivery_orders=${doSchema}`);
  notice(`movement.company_id present? ${hasCompany ? "YES" : "NO"}   delivery_orders.is_dropship present? ${hasDropship ? "YES" : "NO"}`);
  notice("");

  const M = `"${ident(movSchema)}"."inventory_movements"`;
  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;
  const D = `"${ident(doSchema)}"."delivery_orders"`;
  const companySel = hasCompany ? "m.company_id" : "NULL::int AS company_id";
  const dropshipSel = hasDropship ? "COALESCE(d.is_dropship, false)" : "false";

  // ============================================================
  // QUERY (a) — uncosted / RM0 OUT movements on non-cancelled DOs
  // ============================================================
  // uncosted_qty = shipped qty - qty that actually consumed a lot. > 0 means
  // units shipped with NO lot behind them (the oversell short). total_cost_sen=0
  // with full consumption is the separate "received at 0 / Pending price" case.
  const rowsA = await pg.unsafe(`
    SELECT m.id::text            AS movement_id,
           m.source_doc_no       AS do_no,
           m.source_doc_id::text AS do_id,
           d.status::text        AS do_status,
           ${dropshipSel}        AS is_dropship,
           m.warehouse_id::text  AS warehouse_id,
           m.product_code        AS product_code,
           COALESCE(m.variant_key,'') AS variant_key,
           ${companySel},
           m.qty                 AS shipped_qty,
           COALESCE(c.costed_qty, 0)          AS costed_qty,
           m.qty - COALESCE(c.costed_qty, 0)  AS uncosted_qty,
           COALESCE(m.total_cost_sen, 0)      AS total_cost_sen,
           m.created_at::text    AS created_at
      FROM ${M} m
      JOIN ${D} d ON d.id = m.source_doc_id
      LEFT JOIN (
        SELECT movement_id, SUM(qty_consumed) AS costed_qty
          FROM ${C}
         GROUP BY movement_id
      ) c ON c.movement_id = m.id
     WHERE m.movement_type = 'OUT'
       AND m.source_doc_type = 'DO'
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
       AND ( m.qty - COALESCE(c.costed_qty,0) > 0
             OR COALESCE(m.total_cost_sen,0) = 0 )
     ORDER BY m.created_at ASC, m.id ASC`);

  // Split the two mechanisms apart.
  const shortCosted = rowsA.filter((r) => Number(r.uncosted_qty) > 0); // oversell short — the permanent-miss candidate
  const zeroPriced = rowsA.filter((r) => Number(r.uncosted_qty) <= 0 && Number(r.total_cost_sen) === 0); // received at 0 / Pending — recost-pending
  const shortUnits = shortCosted.reduce((a, r) => a + Number(r.uncosted_qty), 0);

  notice("================ (a) UNCOSTED / RM0 OUT movements on non-cancelled DOs ================");
  notice(`  total flagged OUT movements                : ${rowsA.length}`);
  notice(`   - SHORT-COSTED (uncosted_qty > 0)         : ${shortCosted.length}  (units with no lot consumed: ${shortUnits})`);
  notice(`   - ZERO-PRICED  (fully consumed at RM0)    : ${zeroPriced.length}  (received at 0 / Pending price — self-heals on PI recost)`);
  notice("");
  if (shortCosted.length) {
    notice(`  sample of SHORT-COSTED (up to ${SAMPLE}, oldest first):`);
    notice(`    ${pad("DO", 16)} ${pad("status", 11)} ${pad("dropship", 9)} ${pad("product", 20)} ${pad("shipped", 8)} ${pad("costed", 7)} ${pad("uncosted", 9)} ${pad("cost", 12)} created`);
    for (const r of shortCosted.slice(0, SAMPLE)) {
      notice(`    ${pad(r.do_no ?? "-", 16)} ${pad(r.do_status ?? "-", 11)} ${pad(r.is_dropship ? "yes" : "no", 9)} ${pad(r.product_code ?? "-", 20)} ${pad(r.shipped_qty, 8)} ${pad(r.costed_qty, 7)} ${pad(r.uncosted_qty, 9)} ${pad(rm(r.total_cost_sen), 12)} ${dateOnly(r.created_at) ?? "-"}`);
    }
    if (shortCosted.length > SAMPLE) notice(`    ... and ${shortCosted.length - SAMPLE} more.`);
    notice("");
  }
  // Note the drop-ship split: drop-ship shorts are owned by the batched reconcile
  // (0088) and are excluded from 0154's non-drop-ship path.
  const dropshipShorts = shortCosted.filter((r) => r.is_dropship).length;
  notice(`  of the short-costed, is_dropship = true    : ${dropshipShorts}  (owned by the 0088 batched drop-ship reconcile — different path)`);
  notice(`  of the short-costed, is_dropship = false   : ${shortCosted.length - dropshipShorts}  (the 0154 non-drop-ship path — only these are the oversell gap)`);
  notice("");

  // ============================================================
  // QUERY (b) — which short-costed buckets have OPEN replenishment lots NOW?
  // ============================================================
  // The TRUE permanent-miss set: an uncosted short whose cover is physically in
  // stock. A GRN-post reconcile WOULD consume it; because the cover arrived via a
  // non-GRN path, it never did. Match on (warehouse, product, variant[, company])
  // exactly as fn_reconcile_uncosted_out does.
  notice("================ (b) TRUE PERMANENT-MISS — short-costed OUTs with OPEN cover lots now ================");
  // Only non-drop-ship shorts are in scope for the 0154 path.
  const scope = shortCosted.filter((r) => !r.is_dropship);
  if (scope.length === 0) {
    notice("  none — no non-drop-ship short-costed OUTs, so nothing to cross-check against open lots.");
    notice("");
    notice("=== END — read-only, no rows changed. ===");
    return;
  }

  // Distinct buckets to look up cover for.
  const bucketKey = (r) => `${r.warehouse_id}::${r.product_code}::${r.variant_key}::${hasCompany ? r.company_id ?? "" : ""}`;
  const buckets = new Map();
  for (const r of scope) if (!buckets.has(bucketKey(r))) buckets.set(bucketKey(r), r);
  const productCodes = [...new Set(scope.map((r) => r.product_code).filter(Boolean).map(String))];

  // Pull open lots for those products (chunked IN, positional params — values
  // bound, never inlined), then match buckets in JS on the full key.
  const lotCompanySel = (await colsOf(lotSchema, "inventory_lots")).has("company_id") ? "company_id" : "NULL::int AS company_id";
  const openLots = [];
  for (let i = 0; i < productCodes.length; i += 100) {
    const chunk = productCodes.slice(i, i + 100);
    const ph = chunk.map((_, j) => `$${j + 1}`).join(",");
    const q =
      `SELECT warehouse_id::text AS warehouse_id, product_code, COALESCE(variant_key,'') AS variant_key, ` +
      `${lotCompanySel === "company_id" ? "company_id" : "NULL::int AS company_id"}, ` +
      `qty_remaining, unit_cost_sen, received_at::text AS received_at ` +
      `FROM ${L} WHERE qty_remaining > 0 AND product_code IN (${ph})`;
    openLots.push(...(await pg.unsafe(q, chunk)));
  }
  // Aggregate lots per bucket: total open qty + oldest-lot unit cost (FIFO cost
  // the reconcile would apply first).
  const lotsByBucket = new Map();
  for (const l of openLots) {
    const k = `${l.warehouse_id}::${l.product_code}::${l.variant_key}::${hasCompany ? l.company_id ?? "" : ""}`;
    if (!buckets.has(k)) continue;
    const cur = lotsByBucket.get(k) ?? { open_qty: 0, lots: [] };
    cur.open_qty += Number(l.qty_remaining);
    cur.lots.push(l);
    lotsByBucket.set(k, cur);
  }
  for (const v of lotsByBucket.values()) v.lots.sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0));

  // Per short-costed OUT, estimate recoverable (understated) COGS = uncosted_qty
  // walked against that bucket's open lots, oldest first (a read-only mirror of
  // what fn_reconcile_uncosted_out would book — NOT applied here).
  let missCount = 0, missUnits = 0, estUnderstatedSen = 0;
  const missRows = [];
  for (const r of scope) {
    const k = bucketKey(r);
    const cover = lotsByBucket.get(k);
    if (!cover || cover.open_qty <= 0) continue; // no cover in stock -> genuinely awaiting replenishment, not a miss yet
    let need = Number(r.uncosted_qty);
    let estSen = 0, coverable = 0;
    for (const l of cover.lots) {
      if (need <= 0) break;
      const take = Math.min(Number(l.qty_remaining), need);
      estSen += take * Number(l.unit_cost_sen);
      coverable += take;
      need -= take;
    }
    if (coverable <= 0) continue;
    missCount += 1;
    missUnits += coverable;
    estUnderstatedSen += estSen;
    missRows.push({ ...r, coverable, estSen, open_qty: cover.open_qty });
  }

  notice(`  short-costed non-drop-ship OUTs in scope   : ${scope.length}`);
  notice(`  ... with OPEN cover lots in stock NOW      : ${missCount}   <-- TRUE PERMANENT-MISS (a reconcile never fired for present stock)`);
  notice(`  coverable uncosted units                   : ${missUnits}`);
  notice(`  ESTIMATED understated COGS (oldest-lot FIFO): ${rm(estUnderstatedSen)}  (${estUnderstatedSen} sen) -- ESTIMATE only; real cost books when it is actually costed`);
  notice("");
  if (missRows.length) {
    missRows.sort((a, b) => b.estSen - a.estSen);
    notice(`  sample of PERMANENT-MISS (up to ${SAMPLE}, largest estimate first):`);
    notice(`    ${pad("DO", 16)} ${pad("product", 20)} ${pad("uncosted", 9)} ${pad("coverable", 10)} ${pad("openLots", 9)} ${pad("est.COGS", 12)} created`);
    for (const r of missRows.slice(0, SAMPLE)) {
      notice(`    ${pad(r.do_no ?? "-", 16)} ${pad(r.product_code ?? "-", 20)} ${pad(r.uncosted_qty, 9)} ${pad(r.coverable, 10)} ${pad(r.open_qty, 9)} ${pad(rm(r.estSen), 12)} ${dateOnly(r.created_at) ?? "-"}`);
    }
    if (missRows.length > SAMPLE) notice(`    ... and ${missRows.length - SAMPLE} more.`);
    notice("");
  }

  notice("  INTERPRETATION (owner decides the fix — this script does NOT change anything):");
  notice("   - The PERMANENT-MISS rows have replenishment stock present that a GRN-post reconcile would have consumed, but did not, because the cover arrived via a non-GRN IN path (transfer / stock-take / adjustment / consignment-receive / return).");
  notice("   - Extending fn_reconcile_uncosted_out's caller to those IN paths (or adding a periodic sweep) would retro-cost exactly this set. That is a costing-logic change and is DEFERRED to the owner — see docs/inventory-costing-oversell-coe.md.");
  notice("   - The ZERO-PRICED rows in (a) are a DIFFERENT, self-healing case (PI recost); they are reported for completeness, not counted as permanent-miss.");
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("UNCOSTED_COGS_CHECK_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
