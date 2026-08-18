// Read-only stock-exception report: the negatives and ledger disagreements a
// controller clears at period close, surfaced so nobody has to hand-query prod.
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// On 2026-08-18 a proactive integrity sweep of production found five
// negative-stock buckets and eight movement-vs-lot disagreements. Reading the
// raw rows as "the system shipped goods it never had" was WRONG — four of the
// five were the ship-anyway flow working exactly as designed (an operator saw
// no stock, insisted, the system shipped at cost 0 and the balance sits at -1
// until the PO lands). The only way to tell the benign case from a real one was
// to hand-run a dozen SELECTs against the production pooler. That is precisely
// the cost this pattern removes: SAP and NetSuite both SURFACE these as a
// standing exception list a human reads, rather than making someone reconstruct
// it each time.
//
// It answers three questions, and LABELS each row so the benign ones read as
// benign:
//   1. Which (company, warehouse, product, variant) buckets are negative?
//   2. For each, WHY — ship-anyway-pending / variant-key-split / investigate.
//   3. Where do the two stock ledgers (movements vs lots) disagree?
//
// A negative is NOT automatically a fault. This is why the job EXITS 0 in every
// case where the database answered: the output is the answer, and a red job
// would read as "the check broke". Only an unreachable DB or a query error
// exits non-zero. Strictly SELECTs — no DDL, no writes, no transaction.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
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

// `notice` surfaces the headline on the run's summary page; the detail goes to
// the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // Negative buckets, from the VIEW that applies movement direction. A naive
  // sum(qty) over inventory_movements is WRONG here — OUT is stored positive and
  // the view negates it — and that mistake hides every negative.
  const negatives = await pg`
    SELECT company_id, warehouse_id, product_code, variant_key, qty
    FROM scm.inventory_balances
    WHERE qty < 0
    ORDER BY company_id, product_code, variant_key`;

  // Product-level net per (company, warehouse, product): if this is >= 0 while a
  // single variant bucket is negative, the negative is a variant-key SPLIT
  // (received under one spec-key, delivered under another) — the product total
  // is fine, only the per-variant ledger is uneven.
  const productNet = await pg`
    SELECT company_id, warehouse_id, product_code, SUM(qty) AS net
    FROM scm.inventory_balances
    GROUP BY company_id, warehouse_id, product_code`;
  const netKey = (r) => `${r.company_id}|${r.warehouse_id}|${r.product_code}`;
  const netOf = new Map(productNet.map((r) => [netKey(r), Number(r.net)]));

  // Ship-anyway fingerprint: an OUT movement booked at cost 0 for this exact
  // bucket. The ship-anyway path leaves short units at unit_cost 0 (see
  // delivery-orders-mfg.ts), so a zero-cost OUT is the signature of "operator
  // insisted, shipped without stock, clears when the receipt lands".
  const zeroCostOut = await pg`
    SELECT DISTINCT company_id, warehouse_id, product_code, variant_key
    FROM scm.inventory_movements
    WHERE movement_type = 'OUT' AND COALESCE(total_cost_sen, 0) = 0`;
  const bucketKey = (r) =>
    `${r.company_id}|${r.warehouse_id}|${r.product_code}|${r.variant_key ?? ""}`;
  const shipAnyway = new Set(zeroCostOut.map(bucketKey));

  // The two ledgers: movement-derived balance vs lot-derived remaining. In a
  // clean book they agree; where they do not, a controller has an exception to
  // clear. Reported as its own section, not merged into the negatives.
  const ledgerMismatch = await pg`
    WITH mv AS (
      SELECT company_id, warehouse_id, product_code, variant_key, qty
      FROM scm.inventory_balances),
    lot AS (
      SELECT company_id, warehouse_id, product_code, variant_key,
             SUM(qty_remaining) AS q
      FROM scm.inventory_lots
      GROUP BY company_id, warehouse_id, product_code, variant_key)
    SELECT COALESCE(mv.company_id, lot.company_id) AS company_id,
           COALESCE(mv.product_code, lot.product_code) AS product_code,
           COALESCE(mv.variant_key, lot.variant_key) AS variant_key,
           COALESCE(mv.qty, 0) AS mv_qty,
           COALESCE(lot.q, 0) AS lot_qty
    FROM mv FULL OUTER JOIN lot
      ON mv.company_id = lot.company_id
     AND mv.warehouse_id = lot.warehouse_id
     AND mv.product_code = lot.product_code
     AND COALESCE(mv.variant_key, '') = COALESCE(lot.variant_key, '')
    WHERE COALESCE(mv.qty, 0) <> COALESCE(lot.q, 0)
    ORDER BY ABS(COALESCE(mv.qty, 0) - COALESCE(lot.q, 0)) DESC`;

  // Classify each negative.
  let shipAnywayN = 0, splitN = 0, investigateN = 0;
  const rows = negatives.map((r) => {
    let label;
    if ((netOf.get(netKey(r)) ?? 0) >= 0) { label = "variant-key-split"; splitN++; }
    else if (shipAnyway.has(bucketKey(r))) { label = "ship-anyway-pending"; shipAnywayN++; }
    else { label = "INVESTIGATE"; investigateN++; }
    return { ...r, label };
  });

  console.log(`\nNEGATIVE STOCK — ${negatives.length} bucket(s)`);
  console.log("  label meanings: ship-anyway-pending = shipped on insist, clears when the receipt lands;");
  console.log("                  variant-key-split = product total is fine, one spec-key bucket is uneven;");
  console.log("                  INVESTIGATE = neither — a real shortage to chase.\n");
  for (const r of rows) {
    console.log(
      `  [${r.label}] company ${r.company_id}  ${r.product_code}  qty ${r.qty}` +
      `  variant="${(r.variant_key ?? "").slice(0, 60)}"`);
  }

  console.log(`\nLEDGER MISMATCH (movements vs lots) — ${ledgerMismatch.length} bucket(s)`);
  for (const r of ledgerMismatch) {
    console.log(
      `  company ${r.company_id}  ${r.product_code}  movements=${r.mv_qty} lots=${r.lot_qty}` +
      `  diff=${Number(r.mv_qty) - Number(r.lot_qty)}`);
  }

  notice(
    `Stock exceptions: ${negatives.length} negative ` +
    `(${shipAnywayN} ship-anyway, ${splitN} variant-split, ${investigateN} INVESTIGATE), ` +
    `${ledgerMismatch.length} ledger-mismatch. ` +
    (investigateN > 0
      ? `${investigateN} negative bucket(s) need a human — see the log.`
      : `No negative bucket is unexplained.`));
} catch (err) {
  console.error(`Query failed: ${err.message}`);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
