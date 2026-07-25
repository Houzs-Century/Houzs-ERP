#!/usr/bin/env node
// Read-only detector for POSTED-DOCUMENT vs MISSING-MOVEMENT (audit R1).
//
// WHY THIS EXISTS (inventory-costing-integrity audit 2026-07-25, risk R1).
// writeMovements is best-effort: "a failed movement insert does NOT roll back the
// document post (audit-DLQ style)" (backend/src/scm/lib/inventory-movements.ts:11,
// 104-141). Every post handler — GRN postGrnAndRollup, deductInventoryForDo
// (delivery-orders-mfg.ts:833,2889), a DR's increaseInventoryForReturn
// (delivery-returns.ts:304), a STOCK_TRANSFER's fn_stock_transfer_apply
// (stock-transfers.ts:206), a STOCK_TAKE POST (stock-takes.ts:729) — logs the
// failure but LEAVES the document in its posted/shipped status. So a GRN can read
// "POSTED" with no lot, a DO "DISPATCHED" with no OUT and no COGS. The two shipped
// ledger detectors reconcile the LEDGERS against each other, not the DOCUMENTS
// against the ledger, so a doc that posted with ZERO movements is invisible to
// them (there is nothing to be inconsistent with).
//
// This SIZES that exposure: for each NON-cancelled document in a posted/shipped
// state, it asserts >=1 inventory_movements row exists for (source_doc_type,
// source_doc_id) and lists the ORPHANS (posted doc, zero movements), grouped by
// doc type with counts. Covered doc types + the "posted/shipped, not cancelled"
// status predicate for each, read from the routes that write their movements:
//   GRN            grns                status = POSTED               (DRAFT excluded)
//   DO             delivery_orders     DISPATCHED/IN_TRANSIT/SIGNED/DELIVERED/INVOICED/COMPLETED
//                                      (DRAFT + LOADED are pre-ship, no OUT yet)
//   DR             delivery_returns    RECEIVED/INSPECTED/REFUNDED    (created RECEIVED)
//   STOCK_TRANSFER stock_transfers     POSTED                        (DRAFT removed mig 0078)
//   STOCK_TAKE     stock_takes         POSTED                        (OPEN excluded)
//
// KNOWN-LEGITIMATE zero-movement cases (annotated per group, NOT bugs — the owner
// separates these from the real orphans):
//   * STOCK_TAKE — a POST whose counted qty equals live for EVERY line writes NO
//     ADJUSTMENT (stock-takes.ts:719 `if (adjustment === 0) continue`). A
//     zero-variance stock take legitimately has zero movements.
//   * DO / DR / GRN — a document whose only lines are service SKUs (SVC-*, FIFO-
//     exempt) or zero-qty lines legitimately writes no movement.
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no marker
// rows, NO change to any costing/post/movement logic. Every interpolated
// identifier is a schema/column/status name DISCOVERED from information_schema (or
// a hardcoded ^[A-Z_]+$ status whitelist) and re-validated; no user input reaches
// any statement. Exits 0 for every legitimate answer (the ANSWER is the output,
// not the exit code); non-zero only when the database is unreachable or a query
// errors.
//
// Mirrors backend/scripts/check-costless-stock.mjs + check-inventory-integrity.mjs
// (the repo's read-only-diagnostic shape) and its workflow
// .github/workflows/posted-doc-movements-check.yml.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs / check-costless-stock.mjs: env wins so
// CI needs no .dev.vars.
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
// Status literals are our own constants, never user input. Validate hard and
// build a single-quoted IN list. Guards against any future typo becoming SQL.
const statusList = (arr) =>
  arr
    .map((s) => {
      if (!/^[A-Z_]+$/.test(s)) throw new Error(`unsafe status literal: ${s}`);
      return `'${s}'`;
    })
    .join(",");

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const pad = (s, n) => String(s).padEnd(n);
const short = (s, n) => {
  const v = s == null ? "-" : String(s);
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};
const SAMPLE = 25; // rows to print per group (counts are always full)

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
// Pick the first candidate column that actually exists — the audit named some
// columns; discover the real one rather than hardcode-and-crash.
const pickCol = (cols, candidates) => candidates.find((c) => cols.has(c)) ?? null;

// Per-doc-type config. `noCandidates` is probed against information_schema so a
// renamed doc-number column degrades to "(id)" instead of crashing.
const DOC_TYPES = [
  {
    type: "GRN",
    table: "grns",
    noCandidates: ["grn_number", "grn_no", "doc_no"],
    posted: ["POSTED"],
    note: "GRN posts its IN movements at status POSTED (grns.ts postGrnAndRollup). A service-only / zero-accepted GRN legitimately writes none.",
  },
  {
    type: "DO",
    table: "delivery_orders",
    noCandidates: ["do_number", "do_no", "doc_no"],
    posted: ["DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED", "COMPLETED"],
    note: "A DO writes its OUT on ship (deductInventoryForDo); DRAFT/LOADED are pre-ship (no OUT yet). A service-only DO (SVC-* lines, FIFO-exempt) legitimately writes none.",
  },
  {
    type: "DR",
    table: "delivery_returns",
    noCandidates: ["return_number", "dr_number", "doc_no"],
    posted: ["RECEIVED", "INSPECTED", "REFUNDED"],
    note: "A DR writes its IN when received (increaseInventoryForReturn). A zero-qty / service-only return legitimately writes none.",
  },
  {
    type: "STOCK_TRANSFER",
    table: "stock_transfers",
    noCandidates: ["transfer_no", "transfer_number", "doc_no"],
    posted: ["POSTED"],
    note: "A transfer applies its OUT+IN via fn_stock_transfer_apply at POSTED. A transfer of only un-stocked lines would write none.",
  },
  {
    type: "STOCK_TAKE",
    table: "stock_takes",
    noCandidates: ["take_no", "take_number", "doc_no"],
    posted: ["POSTED"],
    note: "EXPECTED zero-movement case: a stock take whose counted qty equals live for EVERY line writes NO ADJUSTMENT (stock-takes.ts:719). A zero-variance POST is not an orphan.",
  },
];

async function main() {
  notice("=== POSTED-DOC vs MISSING-MOVEMENT DETECTOR (R1) — READ-ONLY (no rows changed, no post/movement logic touched) ===");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  if (!movSchema) {
    notice("FATAL — inventory_movements not found in scm or public. Cannot run. (Missing-table condition, not a data answer.)");
    return;
  }
  const movCols = await colsOf(movSchema, "inventory_movements");
  for (const need of ["source_doc_type", "source_doc_id"]) {
    if (!movCols.has(need)) {
      notice(`FATAL — inventory_movements has no ${need} column in ${movSchema}. Cannot run. (Schema mismatch, not a data answer.)`);
      return;
    }
  }
  const M = `"${ident(movSchema)}"."inventory_movements"`;
  notice(`schema: inventory_movements=${movSchema}`);
  notice("");

  const summary = [];

  for (const cfg of DOC_TYPES) {
    const dschema = await schemaOf(cfg.table);
    notice(`================ ${cfg.type}  (${cfg.table}) ================`);
    if (!dschema) {
      notice(`  SKIP — table ${cfg.table} not found in scm or public. (Not an answer; the doc type is absent on this DB.)`);
      notice("");
      summary.push({ type: cfg.type, skipped: true });
      continue;
    }
    const cols = await colsOf(dschema, cfg.table);
    if (!cols.has("status")) {
      notice(`  SKIP — ${cfg.table} has no status column in ${dschema}; cannot apply the posted predicate. (Schema mismatch, not an answer.)`);
      notice("");
      summary.push({ type: cfg.type, skipped: true });
      continue;
    }
    const noCol = pickCol(cols, cfg.noCandidates);
    const hasCompany = cols.has("company_id");
    const D = `"${ident(dschema)}"."${ident(cfg.table)}"`;
    const noSel = noCol ? `d."${ident(noCol)}"::text` : "d.id::text";
    const coSel = hasCompany ? "d.company_id" : "NULL::int AS company_id";

    notice(`  discovered: doc-no column=${noCol ?? "(none — using id)"}   company_id=${hasCompany ? "YES" : "NO"}   posted statuses=${cfg.posted.join("/")}`);

    // A posted/shipped, non-cancelled document with ZERO movements for its
    // (source_doc_type, source_doc_id). source_doc_id is a uuid on both sides;
    // cast to text so the NOT EXISTS never trips a type mismatch on odd envs.
    const orphans = await pg.unsafe(`
      SELECT d.id::text            AS doc_id,
             ${noSel}              AS doc_no,
             UPPER(d.status::text) AS status,
             ${coSel}
        FROM ${D} d
       WHERE UPPER(d.status::text) IN (${statusList(cfg.posted)})
         AND NOT EXISTS (
               SELECT 1 FROM ${M} m
                WHERE m.source_doc_type = '${cfg.type}'
                  AND m.source_doc_id::text = d.id::text
             )
       ORDER BY d.id::text`);

    // Denominator: how many posted docs of this type exist, for context.
    const totalRow = await pg.unsafe(`
      SELECT COUNT(*)::int AS n
        FROM ${D} d
       WHERE UPPER(d.status::text) IN (${statusList(cfg.posted)})`);
    const total = Number(totalRow[0]?.n ?? 0);

    notice(`  posted/shipped docs of this type          : ${total}`);
    notice(`  ... with ZERO movements (orphans)         : ${orphans.length}`);
    if (cfg.note) notice(`  note: ${cfg.note}`);
    notice("");
    if (orphans.length) {
      notice(`  sample (up to ${SAMPLE}):`);
      notice(`    ${pad("docNo", 22)} ${pad("status", 12)} ${pad("co", 3)} docId`);
      for (const r of orphans.slice(0, SAMPLE)) {
        notice(`    ${pad(short(r.doc_no, 22), 22)} ${pad(short(r.status, 12), 12)} ${pad(r.company_id ?? "-", 3)} ${short(r.doc_id, 40)}`);
      }
      if (orphans.length > SAMPLE) notice(`    ... and ${orphans.length - SAMPLE} more.`);
    }
    notice("");
    summary.push({ type: cfg.type, total, orphans: orphans.length });
  }

  notice("================ SUMMARY ================");
  for (const s of summary) {
    if (s.skipped) { notice(`  ${pad(s.type, 16)} : SKIPPED (table/column absent)`); continue; }
    notice(`  ${pad(s.type, 16)} : ${s.orphans} orphan(s) of ${s.total} posted doc(s)`);
  }
  notice("");
  notice("  INTERPRETATION (owner decides — this script changes NOTHING):");
  notice("   - An orphan is a document the system considers posted/shipped whose stock movement never landed (writeMovements");
  notice("     returned {ok:false} and the post was left standing). qty AND cost are wrong for that doc: a GRN with no lot,");
  notice("     a DO with no OUT and no COGS. Root cause + why the audit-DLQ posture is DELIBERATE (do NOT make writeMovements");
  notice("     throw without owner sign-off) are in docs/inventory-costing-integrity-audit.md (R1).");
  notice("   - Subtract the annotated legitimate cases per group (zero-variance stock takes; service-only / zero-qty docs)");
  notice("     before treating a count as the defect size.");
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("POSTED_DOC_MOVEMENTS_CHECK_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
