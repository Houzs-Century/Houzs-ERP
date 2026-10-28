#!/usr/bin/env node
// Read-only detector for COST-LESS OWNED STOCK: open FIFO lots that carry a
// non-positive unit_cost_sen (0 or negative) while still holding qty_remaining.
// Such a lot sits on the books as OWNED quantity with NO cost basis, so when a
// later sale consumes it FIFO the OUT movement books RM0 COGS and margin reads as
// pure profit — permanently, for those units.
//
// WHY THIS EXISTS (costing-integrity audit 2026-07-25, class 4 "cost-less stock").
// The FIFO trigger's positive-ADJUSTMENT branch costs a new lot as
//   v_unit_cost := COALESCE(NULLIF(NEW.unit_cost_sen, 0), v_avg_cost, 0)
// (scripts/scm-schema/inventory-fifo-trigger.sql:212) — the SKU's current open-lot
// weighted average when the caller passes no cost. Two write paths rely on that
// fallback and hit its FLOOR of 0 when the SKU has NO open lots to average:
//   * Stock-take POST always writes the variance ADJUSTMENT with unit_cost_sen = 0
//     (routes/stock-takes.ts:727) — "trigger recomputes cost".
//   * Manual stock adjustment passes unit_cost_sen only if the operator typed one
//     (routes/inventory-adjustments.ts:125); a found-stock increase with the field
//     left blank sends 0.
// When either lands on a SKU whose open lots sum to 0 (first-ever stock, or all
// prior lots already consumed), v_avg_cost resolves 0 and the new lot opens at
// unit_cost_sen = 0. Unlike a GRN "Pending price" lot — which recostFromGrn heals
// when the supplier's Purchase Invoice arrives — an ADJUSTMENT / STOCK_TAKE lot is
// NEVER re-costed (recost is keyed to grn_items only), so the RM0 basis is
// PERMANENT and under-states COGS the moment FIFO reaches that lot.
//
// This SIZES that exposure across ALL SKUs / warehouses / companies, split by the
// lot's source so the owner can separate the PERMANENT defect from the benign
// self-healing pending-price case:
//   (1) PERMANENT  — open lots with unit_cost_sen <= 0 whose source_doc_type is
//       ADJUSTMENT or STOCK_TAKE (no PI will ever heal them). The real finding.
//   (2) PENDING    — open lots with unit_cost_sen <= 0 whose source_doc_type is
//       GRN (awaiting a Purchase Invoice; recostFromGrn heals these). Informational.
//   (3) OTHER      — any remaining cost-less open lots (returns / transfers /
//       consignment), listed so nothing is hidden.
// For each row it also shows whether the SKU has ANY other OPEN lot with a
// positive cost (a reference basis a future repair could re-cost from) — when
// present the fix is "stamp the known avg cost"; when absent the cost is genuinely
// unknown and the owner must supply it.
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no marker
// rows, NO change to any costing logic. Every interpolated identifier is a
// schema/column name DISCOVERED from information_schema and re-validated against
// ^[a-z_][a-z0-9_]*$; no user input reaches any statement. Exits 0 for every
// legitimate answer (the ANSWER is the output, not the exit code); non-zero only
// when the database is unreachable or a query errors.
//
// Mirrors backend/scripts/check-inventory-integrity.mjs + check-uncosted-cogs.mjs
// (the repo's read-only-diagnostic shape) and its workflow
// .github/workflows/costless-stock-check.yml.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
const short = (s, n) => {
  const v = s == null ? "-" : String(s);
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};
const SAMPLE = 30; // rows to print per section (counts + totals are always full)

// Discover which schema a table lives in (scm on prod; public on some envs).
// Never assume — mirror check-inventory-integrity.mjs.
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
  notice("=== COST-LESS STOCK DETECTOR — READ-ONLY (no rows changed, no costing logic touched) ===");
  notice("");

  const lotSchema = await schemaOf("inventory_lots");
  if (!lotSchema) {
    notice("FATAL — inventory_lots was not found in scm or public. Cannot run. (Missing-table condition, not a data answer.)");
    return;
  }
  const lotCols = await colsOf(lotSchema, "inventory_lots");
  for (const need of ["qty_remaining", "unit_cost_sen", "source_doc_type", "item_code", "warehouse_id"]) {
    if (!lotCols.has(need)) {
      notice(`FATAL — inventory_lots has no ${need} column in ${lotSchema}. Cannot run. (Schema mismatch, not a data answer.)`);
      return;
    }
  }
  const hasCompany = lotCols.has("company_id");
  const hasVariant = lotCols.has("variant_key");
  const hasBatch = lotCols.has("batch_no");
  const hasSourceNo = lotCols.has("source_doc_no");
  notice(`schema: inventory_lots=${lotSchema}   company_id=${hasCompany ? "YES" : "NO"}  variant_key=${hasVariant ? "YES" : "NO"}  batch_no=${hasBatch ? "YES" : "NO"}`);
  notice("");

  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  const coSel = hasCompany ? "company_id" : "NULL::int AS company_id";
  const vkSel = hasVariant ? "COALESCE(variant_key,'')" : "''";
  const noSel = hasSourceNo ? "source_doc_no" : "NULL::text AS source_doc_no";

  // One pass over the OPEN, cost-less lots. Classify each by source and note
  // whether the SKU bucket has a positive-cost open lot elsewhere (a reference
  // basis). All read-only.
  const rows = await pg.unsafe(`
    WITH costless AS (
      SELECT ${coSel},
             warehouse_id::text AS warehouse_id,
             item_code,
             ${vkSel} AS variant_key,
             UPPER(COALESCE(source_doc_type,'')) AS src,
             ${noSel},
             MAX(product_name) AS product_name,
             SUM(qty_remaining) AS costless_qty
        FROM ${L}
       WHERE qty_remaining > 0
         AND COALESCE(unit_cost_sen, 0) <= 0
       GROUP BY warehouse_id, item_code, ${vkSel},
                UPPER(COALESCE(source_doc_type,'')), ${noSel}${hasCompany ? ", company_id" : ""}
    ),
    ref AS (
      SELECT warehouse_id::text AS warehouse_id,
             item_code,
             ${vkSel} AS variant_key,
             CASE WHEN SUM(CASE WHEN unit_cost_sen > 0 THEN qty_remaining ELSE 0 END) > 0
                  THEN SUM(CASE WHEN unit_cost_sen > 0 THEN qty_remaining * unit_cost_sen ELSE 0 END)
                     / SUM(CASE WHEN unit_cost_sen > 0 THEN qty_remaining ELSE 0 END)
                  ELSE NULL END AS ref_avg_cost_sen
        FROM ${L}
       WHERE qty_remaining > 0
       GROUP BY warehouse_id, item_code, ${vkSel}
    )
    SELECT c.company_id, c.warehouse_id, c.item_code, c.variant_key, c.src,
           c.source_doc_no, c.product_name, c.costless_qty,
           r.ref_avg_cost_sen
      FROM costless c
      LEFT JOIN ref r
        ON r.warehouse_id = c.warehouse_id
       AND r.item_code = c.item_code
       AND r.variant_key  = c.variant_key
     ORDER BY c.costless_qty DESC, c.item_code ASC`);

  const isPermanent = (src) => src === "ADJUSTMENT" || src === "STOCK_TAKE";
  const isPending = (src) => src === "GRN";
  const permanent = rows.filter((r) => isPermanent(r.src));
  const pending = rows.filter((r) => isPending(r.src));
  const other = rows.filter((r) => !isPermanent(r.src) && !isPending(r.src));

  const sumQty = (rs) => rs.reduce((a, r) => a + Number(r.costless_qty), 0);
  const rm = (sen) => (sen == null ? "-" : `RM${(Number(sen) / 100).toFixed(2)}`);

  const printSection = (title, rs, note) => {
    notice(`================ ${title} ================`);
    if (note) notice(`  ${note}`);
    notice(`  buckets                          : ${rs.length}`);
    notice(`  cost-less owned units            : ${sumQty(rs)}`);
    notice("");
    if (rs.length) {
      notice(`  sample (up to ${SAMPLE}, most units first):`);
      notice(`    ${pad("product", 22)} ${pad("variant", 10)} ${pad("co", 3)} ${pad("src", 11)} ${pad("units", 6)} ${pad("refAvgCost", 12)} warehouse`);
      for (const r of rs.slice(0, SAMPLE)) {
        notice(`    ${pad(short(r.item_code, 22), 22)} ${pad(short(r.variant_key, 10), 10)} ${pad(r.company_id ?? "-", 3)} ${pad(short(r.src, 11), 11)} ${pad(r.costless_qty, 6)} ${pad(r.ref_avg_cost_sen == null ? "(unknown)" : rm(r.ref_avg_cost_sen), 12)} ${short(r.warehouse_id, 40)}`);
      }
      if (rs.length > SAMPLE) notice(`    ... and ${rs.length - SAMPLE} more.`);
    }
    notice("");
  };

  printSection(
    "(1) PERMANENT cost-less stock — ADJUSTMENT / STOCK_TAKE lots (the defect)",
    permanent,
    "These open lots carry RM0 cost and NO path re-costs them (recost is GRN-keyed). A future FIFO sale books RM0 COGS on these units. refAvgCost = the SKU's other open lots' avg cost, a candidate repair basis; (unknown) = no priced lot to borrow from.",
  );
  printSection(
    "(2) PENDING cost-less stock — GRN lots awaiting a Purchase Invoice (self-heals)",
    pending,
    "Expected: a GRN received at 0/Pending price. recostFromGrn stamps the real cost when the PI lands. Shown for completeness — NOT the defect.",
  );
  if (other.length) {
    printSection(
      "(3) OTHER cost-less stock — returns / transfers / consignment / unknown source",
      other,
      "Cost-less open lots from other sources — surfaced so nothing is hidden; the owner judges each source.",
    );
  }

  notice("================ SUMMARY ================");
  notice(`  (1) PERMANENT (ADJUSTMENT/STOCK_TAKE) buckets : ${permanent.length}   (units ${sumQty(permanent)})`);
  notice(`  (2) PENDING   (GRN, self-heals) buckets       : ${pending.length}   (units ${sumQty(pending)})`);
  notice(`  (3) OTHER buckets                             : ${other.length}   (units ${sumQty(other)})`);
  notice("");
  notice("  INTERPRETATION (owner decides the fix — this script changes NOTHING):");
  notice("   - Section (1) is the money finding: owned stock on the books with a RM0 basis that will under-state");
  notice("     COGS when it sells. Root cause + the DEFERRED fix (force a cost on the write path; then re-cost the");
  notice("     stranded lots at their refAvgCost or an owner-supplied basis) are in docs/inventory-costing-integrity-audit.md.");
  notice("   - Section (2) is benign — those heal when the supplier PI is entered.");
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("COSTLESS_STOCK_CHECK_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
