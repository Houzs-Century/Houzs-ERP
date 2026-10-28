#!/usr/bin/env node
// Read-only detector for DOUBLE-POSTED stock movements and OUT movements that
// SKIPPED the FIFO consume (write-without-consume). It answers the owner's
// question directly — "会不会 GR 两次、DO 两次?" (can a document post its stock
// movements TWICE, or move stock without the FIFO consume firing?) — across
// EVERY inventory-affecting document, from production ground truth.
//
// WHY THIS EXISTS (owner ask 2026-07-25, after the MAKOTO ledger divergence:
// docs/inventory-ledger-divergence-coe.md). A DO edited 35 min after shipping
// wrote a resync DELTA OUT whose consume matched no lot, so the movement ledger
// decremented while the FIFO ledger did not. The audit
// (docs/inventory-idempotency-audit.md) then checked every OTHER post path for
// the same class of fault: a second post that doubles stock, or an OUT that
// records a movement without a matching lot consumption.
//
// It reports THREE things, all SELECT-only:
//
//   (0) IDEMPOTENCY BACKSTOPS — the partial UNIQUE indexes that actually exist
//       on inventory_movements RIGHT NOW (read from pg_indexes). This is the
//       ground truth on WHICH source_doc_types have a DB-level double-post net
//       (DO / DR / CS_DO / CS_DR are expected; GRN / PURCHASE_RETURN /
//       STOCK_TRANSFER / STOCK_TAKE / ADJUSTMENT / PC_* are NOT — they rely on
//       application-level guards only). It also resolves the repo's internal
//       contradiction (code says migration 0100 created uq_inv_mov_do_source but
//       also that 0109 "dropped the per-bucket UNIQUE") against reality.
//
//   (A) DOUBLE-POSTED buckets — (source_doc_type, source_doc_id, warehouse,
//       product, variant, batch, movement_type) groups with MORE THAN ONE row.
//       Split into:
//         - SINGLE-POST types (GRN, PURCHASE_RETURN, STOCK_TRANSFER, STOCK_TAKE):
//           these post exactly ONE movement per bucket — no resync path writes a
//           second — so count > 1 is a HARD double-post signal (a doubled GR /
//           doubled stock-IN, the exact "GR 两次" case).
//         - RESYNC types (DO, DR, CS_DO, CS_DR, PC_RECEIVE, PC_RETURN, the
//           consignment notes): a shipped-doc EDIT legitimately writes additional
//           DELTA rows, so count > 1 is EXPECTED here and is surfaced for context
//           only, NOT flagged as a defect. (Net-level divergence for these is the
//           job of check-inventory-integrity.mjs.)
//
//   (B) WRITE-WITHOUT-CONSUME — OUT movements (and negative ADJUSTMENT
//       write-offs) whose consumed qty (Σ inventory_lot_consumptions.qty_consumed
//       for that movement_id) is LESS THAN the movement qty. The shortfall is the
//       discarded qty_short: the FIFO trigger's OUT branch runs the consumer,
//       matches fewer (or zero) lots than the movement demands, and throws the
//       remainder away — the movement decrements the running balance but books no
//       (or partial) COGS and decrements no (or fewer) lots. This is the MAKOTO
//       mechanism at the per-MOVEMENT grain (check-inventory-integrity sizes it
//       per BUCKET); it lists the exact document + date so each can be traced.
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
// .github/workflows/duplicate-movements-check.yml.
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
const short = (s, n) => {
  const v = s == null ? "-" : String(s);
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};
const SAMPLE = 30; // rows to print per section (counts + totals are always full)

// Source-doc types that post EXACTLY ONE movement per bucket — no resync path
// writes a second. count > 1 for these is a hard double-post. (See the audit's
// per-path table: GRN post, PURCHASE_RETURN post, STOCK_TRANSFER auto-post,
// STOCK_TAKE post each write once.)
const SINGLE_POST_TYPES = new Set(["GRN", "PURCHASE_RETURN", "STOCK_TRANSFER", "STOCK_TAKE"]);

// Discover which schema a table lives in (scm on prod; public on some envs).
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
  notice("=== DUPLICATE / WRITE-WITHOUT-CONSUME MOVEMENT DETECTOR — READ-ONLY (no rows changed, no costing logic touched) ===");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  const consSchema = await schemaOf("inventory_lot_consumptions");
  if (!movSchema || !consSchema) {
    notice("FATAL — inventory_movements or inventory_lot_consumptions was not found in scm or public. Cannot run. (Missing-table condition, not a data answer.)");
    return;
  }
  const movCols = await colsOf(movSchema, "inventory_movements");
  const hasBatch = movCols.has("batch_no");
  const hasCompany = movCols.has("company_id");
  const M = `"${ident(movSchema)}"."inventory_movements"`;
  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;
  notice(`schemas: inventory_movements=${movSchema}  inventory_lot_consumptions=${consSchema}`);
  notice(`columns: batch_no present? ${hasBatch ? "YES" : "NO"}   company_id present? ${hasCompany ? "YES" : "NO"}`);
  notice("");

  // batch segment: only join batch_no into the bucket key when the column exists.
  const batchKey = hasBatch ? "COALESCE(batch_no,'')" : "''::text";

  // ============================================================
  // (0) IDEMPOTENCY BACKSTOPS — actual UNIQUE indexes on inventory_movements
  // ============================================================
  // Ground truth on which source_doc_types have a DB-level double-post net. Read
  // straight from pg_indexes — no assumption about what the repo's migrations say
  // (the DO/DR guards are 2990s-ported DDL that live only in prod).
  const idxRows = await pg`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = ${movSchema}
       AND tablename = 'inventory_movements'
       AND indexdef ILIKE '%UNIQUE%'
     ORDER BY indexname`;
  notice("================ (0) IDEMPOTENCY BACKSTOPS — UNIQUE indexes on inventory_movements (DB double-post net) ================");
  if (idxRows.length === 0) {
    notice("  NONE — inventory_movements has NO unique index. EVERY post path relies solely on application-level guards.");
  } else {
    notice(`  ${idxRows.length} unique index(es) present:`);
    for (const r of idxRows) {
      // Print the predicate/columns so the owner sees the EXACT key + which doc type it covers.
      notice(`    - ${r.indexname}`);
      notice(`        ${short(r.indexdef.replace(/\s+/g, " "), 200)}`);
    }
  }
  notice("  NOTE: source_doc_types WITHOUT a unique index here (GRN, PURCHASE_RETURN, STOCK_TRANSFER, STOCK_TAKE, ADJUSTMENT, PC_RECEIVE, PC_RETURN)");
  notice("        have NO DB backstop — a double post is prevented only by app-level status gates / ledger-delta logic (see docs/inventory-idempotency-audit.md).");
  notice("");

  // ============================================================
  // (A) DOUBLE-POSTED buckets — >1 movement row per (doc, bucket, type)
  // ============================================================
  const dupRows = await pg.unsafe(`
    SELECT source_doc_type,
           source_doc_id::text            AS source_doc_id,
           MAX(source_doc_no)             AS source_doc_no,
           warehouse_id::text             AS warehouse_id,
           item_code,
           COALESCE(variant_key,'')       AS variant_key,
           ${batchKey}                    AS batch_no,
           movement_type,
           COUNT(*)                       AS row_count,
           SUM(qty)                       AS total_qty,
           MIN(created_at)::text          AS first_at,
           MAX(created_at)::text          AS last_at
      FROM ${M}
     WHERE source_doc_id IS NOT NULL
       AND movement_type IN ('IN','OUT')
     GROUP BY source_doc_type, source_doc_id, warehouse_id, item_code,
              COALESCE(variant_key,''), ${batchKey}, movement_type
    HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC, source_doc_type ASC`);

  const hardDupes = dupRows.filter((r) => SINGLE_POST_TYPES.has(String(r.source_doc_type ?? "").toUpperCase()));
  const resyncDupes = dupRows.filter((r) => !SINGLE_POST_TYPES.has(String(r.source_doc_type ?? "").toUpperCase()));

  notice("================ (A) DOUBLE-POSTED buckets — more than one movement row per (doc, warehouse, product, variant, batch, type) ================");
  notice(`  HARD double-post (single-post types: ${[...SINGLE_POST_TYPES].join(", ")}): ${hardDupes.length}`);
  notice("     ^ these post exactly ONE movement per bucket — count > 1 is a doubled post (the 'GR 两次' case). INVESTIGATE each.");
  notice(`  Multi-row on RESYNC types (DO/DR/CS_*/PC_*/consignment notes): ${resyncDupes.length}   (EXPECTED — shipped-doc edits write delta rows; shown for context, not a defect)`);
  notice("");
  if (hardDupes.length) {
    notice(`  HARD double-post sample (up to ${SAMPLE}, most rows first):`);
    notice(`    ${pad("docType", 16)} ${pad("docNo", 18)} ${pad("type", 4)} ${pad("rows", 4)} ${pad("Σqty", 6)} ${pad("product", 20)} ${pad("variant", 10)} ${pad("first", 10)} ${pad("last", 10)} warehouse`);
    for (const r of hardDupes.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.source_doc_type, 16), 16)} ${pad(short(r.source_doc_no, 18), 18)} ${pad(r.movement_type, 4)} ${pad(r.row_count, 4)} ${pad(r.total_qty, 6)} ${pad(short(r.item_code, 20), 20)} ${pad(short(r.variant_key, 10), 10)} ${pad(dateOnly(r.first_at) ?? "-", 10)} ${pad(dateOnly(r.last_at) ?? "-", 10)} ${short(r.warehouse_id, 40)}`);
    }
    if (hardDupes.length > SAMPLE) notice(`    ... and ${hardDupes.length - SAMPLE} more.`);
    notice("");
  } else {
    notice("  none — no single-post document has more than one movement per bucket. (No doubled GRN / PR / transfer / stock-take.)");
    notice("");
  }
  if (resyncDupes.length) {
    notice(`  RESYNC-type multi-row sample (up to ${SAMPLE}, context only):`);
    notice(`    ${pad("docType", 16)} ${pad("docNo", 18)} ${pad("type", 4)} ${pad("rows", 4)} ${pad("Σqty", 6)} ${pad("product", 20)} warehouse`);
    for (const r of resyncDupes.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.source_doc_type, 16), 16)} ${pad(short(r.source_doc_no, 18), 18)} ${pad(r.movement_type, 4)} ${pad(r.row_count, 4)} ${pad(r.total_qty, 6)} ${pad(short(r.item_code, 20), 20)} ${short(r.warehouse_id, 40)}`);
    }
    if (resyncDupes.length > SAMPLE) notice(`    ... and ${resyncDupes.length - SAMPLE} more.`);
    notice("");
  }

  // ============================================================
  // (B) WRITE-WITHOUT-CONSUME — OUT / negative-ADJUSTMENT movements consumed < qty
  // ============================================================
  // Per outgoing movement, Σ qty_consumed from inventory_lot_consumptions(movement_id).
  // consumed < |qty| means the FIFO trigger shorted the consume and discarded the
  // remainder (the MAKOTO discard), at the per-MOVEMENT grain.
  const woutRows = await pg.unsafe(`
    WITH out_mov AS (
      SELECT m.id::text            AS movement_id,
             m.movement_type,
             m.source_doc_type,
             m.source_doc_no,
             m.source_doc_id::text AS source_doc_id,
             m.warehouse_id::text  AS warehouse_id,
             m.item_code,
             COALESCE(m.variant_key,'') AS variant_key,
             ${hasBatch ? "COALESCE(m.batch_no,'')" : "''::text"} AS batch_no,
             ABS(m.qty)            AS out_qty,
             COALESCE(m.total_cost_sen,0) AS total_cost_sen,
             m.created_at::text    AS created_at,
             COALESCE(c.consumed, 0) AS consumed
        FROM ${M} m
        LEFT JOIN (
          SELECT movement_id, SUM(qty_consumed) AS consumed
            FROM ${C}
           GROUP BY movement_id
        ) c ON c.movement_id = m.id
       WHERE (m.movement_type = 'OUT')
          OR (m.movement_type = 'ADJUSTMENT' AND m.qty < 0)
    )
    SELECT *, (out_qty - consumed) AS shortfall
      FROM out_mov
     WHERE out_qty > consumed
     ORDER BY (out_qty - consumed) DESC, created_at ASC`);

  const totalShort = woutRows.reduce((a, r) => a + Number(r.shortfall), 0);
  const zeroConsume = woutRows.filter((r) => Number(r.consumed) === 0).length;
  notice("================ (B) WRITE-WITHOUT-CONSUME — outgoing movements whose consumed qty < movement qty ================");
  notice("  Each OUT / negative-ADJUSTMENT should consume its full qty from inventory_lot_consumptions. A shortfall is discarded qty_short (the MAKOTO mechanism).");
  notice(`  outgoing movements short of consume : ${woutRows.length}`);
  notice(`   - of those, consumed NOTHING (0)   : ${zeroConsume}   (movement decremented balance, booked no COGS, decremented no lot)`);
  notice(`  total shorted (uncosted) units      : ${totalShort}`);
  notice("");
  if (woutRows.length) {
    notice(`  sample (up to ${SAMPLE}, largest shortfall first):`);
    notice(`    ${pad("docType", 12)} ${pad("docNo", 18)} ${pad("type", 4)} ${pad("outQty", 6)} ${pad("consumed", 8)} ${pad("short", 6)} ${pad("cost", 11)} ${pad("product", 20)} ${pad("variant", 10)} created`);
    for (const r of woutRows.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.source_doc_type, 12), 12)} ${pad(short(r.source_doc_no, 18), 18)} ${pad(r.movement_type, 4)} ${pad(r.out_qty, 6)} ${pad(r.consumed, 8)} ${pad(r.shortfall, 6)} ${pad(rm(r.total_cost_sen), 11)} ${pad(short(r.item_code, 20), 20)} ${pad(short(r.variant_key, 10), 10)} ${dateOnly(r.created_at) ?? "-"}`);
    }
    if (woutRows.length > SAMPLE) notice(`    ... and ${woutRows.length - SAMPLE} more.`);
    notice("");
  } else {
    notice("  none — every outgoing movement consumed its full qty. (No MAKOTO-style discarded short.)");
    notice("");
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  notice("================ SUMMARY ================");
  notice(`  (0) unique-index backstops on inventory_movements : ${idxRows.length}`);
  notice(`  (A) HARD double-posted buckets (single-post types) : ${hardDupes.length}`);
  notice(`      multi-row on resync types (expected)           : ${resyncDupes.length}`);
  notice(`  (B) write-without-consume movements                : ${woutRows.length}   (total shorted units ${totalShort})`);
  notice("");
  notice("  INTERPRETATION (owner decides the fix — this script changes NOTHING):");
  notice("   - (A) HARD > 0: a GRN / PURCHASE_RETURN / STOCK_TRANSFER / STOCK_TAKE wrote the SAME bucket twice — a doubled post (doubled stock + doubled value). The recommended guard is a per-doc UNIQUE index or an atomic status compare-and-swap; see docs/inventory-idempotency-audit.md.");
  notice("   - (B) > 0: an outgoing movement recorded without a full FIFO consume — the discarded qty_short. Same root cause + DEFERRED fix as docs/inventory-ledger-divergence-coe.md.");
  notice("   - Both are owner-approved, STAGING-first changes to the money-critical FIFO layer — NOT applied here.");
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("DUPLICATE_MOVEMENTS_CHECK_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
