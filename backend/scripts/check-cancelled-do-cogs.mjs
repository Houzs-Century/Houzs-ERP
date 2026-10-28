#!/usr/bin/env node
// Read-only detector for CANCELLED-DO COGS STILL IN THE CONSUMPTION STREAM (R4).
//
// WHY THIS EXISTS (inventory-costing-integrity audit 2026-07-25, risk R4).
// reverseInventoryForDo reverses a cancelled DO by writing a POSITIVE ADJUSTMENT
// (or a batch-restoring IN for sofa buckets) per bucket
// (backend/src/scm/routes/delivery-orders-mfg.ts:1435-1461). For a NORMAL
// (non-dropship) DO it does NOT delete the original inventory_lot_consumptions the
// ship wrote — only the DROP-SHIP path does, inside fn_reverse_dropship_do_out
// (:1365-1389). So after a non-dropship cancel the signed movement balance returns
// to 0 (qty is correct) BUT the COGS ledger still carries the cancelled sale's
// consumptions. Any COGS report summed from inventory_lot_consumptions counts a
// cancelled delivery, and the re-added lot's basis is an average at the BACK of
// the FIFO queue, not the original per-lot costs.
//
// This SIZES the cancelled-sale COGS still counted. inventory_lot_consumptions
// carries source_doc_type / source_doc_id directly (FIFO trigger, fn_consume_fifo),
// so it joins consumptions with source_doc_type='DO' to delivery_orders on
// source_doc_id and keeps the rows whose DO status = CANCELLED. It splits the
// result by the DO's is_dropship flag:
//   * NON-DROPSHIP (is_dropship = false / absent) — the R4 finding: these
//     consumptions SHOULD have been left (the path does not delete them) and are
//     the cancelled-sale COGS the owner is sizing.
//   * DROPSHIP (is_dropship = true) — fn_reverse_dropship_do_out DELETES a
//     dropship DO's consumptions on cancel, so a dropship row appearing here is an
//     ANOMALY (the fn was missing/failed at cancel time) and is flagged separately,
//     not counted in the R4 total.
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no marker
// rows, NO change to any costing / cancel-reversal logic. Every interpolated
// identifier is a schema/column name DISCOVERED from information_schema and
// re-validated against ^[a-z_][a-z0-9_]*$; no user input reaches any statement.
// Exits 0 for every legitimate answer (the ANSWER is the output, not the exit
// code); non-zero only when the database is unreachable or a query errors.
//
// Mirrors backend/scripts/check-uncosted-cogs.mjs + check-costless-stock.mjs (the
// repo's read-only-diagnostic shape) and its workflow
// .github/workflows/cancelled-do-cogs-check.yml.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
const SAMPLE = 25;

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
const pickCol = (cols, candidates) => candidates.find((c) => cols.has(c)) ?? null;

async function main() {
  notice("=== CANCELLED-DO COGS DETECTOR (R4) — READ-ONLY (no rows changed, no cancel/costing logic touched) ===");
  notice("");

  const consSchema = await schemaOf("inventory_lot_consumptions");
  const doSchema = await schemaOf("delivery_orders");
  if (!consSchema || !doSchema) {
    notice("FATAL — inventory_lot_consumptions or delivery_orders not found in scm or public. Cannot run. (Missing-table condition, not a data answer.)");
    return;
  }
  const consCols = await colsOf(consSchema, "inventory_lot_consumptions");
  const doCols = await colsOf(doSchema, "delivery_orders");
  for (const need of ["source_doc_type", "source_doc_id", "qty_consumed", "total_cost_sen"]) {
    if (!consCols.has(need)) {
      notice(`FATAL — inventory_lot_consumptions has no ${need} column in ${consSchema}. Cannot run. (Schema mismatch, not a data answer.)`);
      return;
    }
  }
  if (!doCols.has("status")) {
    notice(`FATAL — delivery_orders has no status column in ${doSchema}; cannot identify cancelled DOs. (Schema mismatch, not a data answer.)`);
    return;
  }
  const hasDropship = doCols.has("is_dropship");
  const hasConsCompany = consCols.has("company_id");
  const doNoCol = pickCol(doCols, ["do_number", "do_no", "doc_no"]);

  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;
  const D = `"${ident(doSchema)}"."delivery_orders"`;
  const dropSel = hasDropship ? "COALESCE(d.is_dropship, false)" : "false";
  const coSel = hasConsCompany ? "c.company_id" : "NULL::int AS company_id";
  const doNoSel = doNoCol ? `d."${ident(doNoCol)}"::text` : "d.id::text";

  notice(`schemas: inventory_lot_consumptions=${consSchema}  delivery_orders=${doSchema}`);
  notice(`discovered: delivery_orders.is_dropship=${hasDropship ? "YES" : "NO (all treated non-dropship)"}   consumption.company_id=${hasConsCompany ? "YES" : "NO"}   do-no column=${doNoCol ?? "(id)"}`);
  notice("");

  // Every consumption attributed to a CANCELLED DO, aggregated per DO so the
  // owner sees documents, not individual lot draws. total_cost_sen is the COGS
  // the ship booked and the cancel left standing.
  const rows = await pg.unsafe(`
    SELECT d.id::text            AS do_id,
           ${doNoSel}            AS do_no,
           ${dropSel}            AS is_dropship,
           ${coSel},
           COUNT(*)              AS consumption_rows,
           SUM(c.qty_consumed)   AS qty_consumed,
           SUM(c.total_cost_sen) AS cogs_sen
      FROM ${C} c
      JOIN ${D} d ON d.id::text = c.source_doc_id::text
     WHERE c.source_doc_type = 'DO'
       AND UPPER(COALESCE(d.status::text,'')) = 'CANCELLED'
     GROUP BY d.id::text, ${doNoSel}, ${dropSel}${hasConsCompany ? ", c.company_id" : ""}
     ORDER BY SUM(c.total_cost_sen) DESC, d.id::text`);

  const nonDropship = rows.filter((r) => r.is_dropship !== true);
  const dropship = rows.filter((r) => r.is_dropship === true);

  const sumCogs = (rs) => rs.reduce((a, r) => a + Number(r.cogs_sen), 0);
  const sumQty = (rs) => rs.reduce((a, r) => a + Number(r.qty_consumed), 0);
  const sumRows = (rs) => rs.reduce((a, r) => a + Number(r.consumption_rows), 0);

  const printSection = (title, rs, note) => {
    notice(`================ ${title} ================`);
    if (note) notice(`  ${note}`);
    notice(`  cancelled DOs with residual consumptions  : ${rs.length}`);
    notice(`  consumption rows                          : ${sumRows(rs)}`);
    notice(`  units still attributed to cancelled sales : ${sumQty(rs)}`);
    notice(`  cancelled-sale COGS still in the stream   : ${rm(sumCogs(rs))}  (${sumCogs(rs)} sen)`);
    notice("");
    if (rs.length) {
      notice(`  sample (up to ${SAMPLE}, largest COGS first):`);
      notice(`    ${pad("doNo", 20)} ${pad("co", 3)} ${pad("rows", 5)} ${pad("units", 6)} ${pad("cogs", 14)} doId`);
      for (const r of rs.slice(0, SAMPLE)) {
        notice(`    ${pad(short(r.do_no, 20), 20)} ${pad(r.company_id ?? "-", 3)} ${pad(r.consumption_rows, 5)} ${pad(r.qty_consumed, 6)} ${pad(rm(r.cogs_sen), 14)} ${short(r.do_id, 40)}`);
      }
      if (rs.length > SAMPLE) notice(`    ... and ${rs.length - SAMPLE} more.`);
    }
    notice("");
  };

  printSection(
    "(1) NON-DROPSHIP cancelled-DO COGS — the R4 finding",
    nonDropship,
    "reverseInventoryForDo restores qty via a positive ADJUSTMENT but does NOT delete these consumptions, so a cancelled sale's COGS is still counted. Owner decides whether the non-dropship cancel should also restore consumptions (mirror fn_reverse_dropship_do_out).",
  );
  if (hasDropship) {
    printSection(
      "(2) DROPSHIP cancelled-DO COGS — ANOMALY (should be zero)",
      dropship,
      "fn_reverse_dropship_do_out DELETES a dropship DO's consumptions on cancel, so any row here means that fn was missing/failed at cancel time. NOT counted in the R4 total — flagged for investigation.",
    );
  }

  notice("================ SUMMARY ================");
  notice(`  (1) NON-DROPSHIP (R4)  : ${nonDropship.length} DO(s)   ${rm(sumCogs(nonDropship))} cancelled-sale COGS still counted`);
  if (hasDropship) notice(`  (2) DROPSHIP (anomaly) : ${dropship.length} DO(s)   ${rm(sumCogs(dropship))} (should be 0 — investigate if non-zero)`);
  else notice("  (dropship split unavailable — delivery_orders.is_dropship absent on this DB; all rows shown as non-dropship)");
  notice("");
  notice("  INTERPRETATION (owner decides — this script changes NOTHING):");
  notice("   - Section (1) is the R4 size: COGS from cancelled deliveries still summed in inventory_lot_consumptions. Qty is");
  notice("     correct (the cancel add-back nets the balance to 0); only the COGS attribution + FIFO re-ordering are unguarded.");
  notice("   - Root cause + the DEFERRED decision (mirror fn_reverse_dropship_do_out for the non-dropship path) are in");
  notice("     docs/inventory-costing-integrity-audit.md (R4). This detector changes no data.");
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("CANCELLED_DO_COGS_CHECK_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
