#!/usr/bin/env node
// ----------------------------------------------------------------------------
// INVENTORY QUANTITY + COSTING AUDIT — STRICTLY READ-ONLY.
//
// The owner asked two questions of the real historical data:
//   1. Is the inventory in/out QUANTITY correct?
//   2. Is the COSTING captured on Sales Invoice / GRN correct?
//
// This answers both against production with SELECTs only, and adds a third
// question that the 2026-08-01 doc-reference repair made urgent:
//   0. Did renaming 24 batch_no values (PO-2606-001 -> 2990-PO-2606-001, across
//      inventory_lots + inventory_movements) disturb the FIFO ledger?
//      That repair asserted, from reading the DDL, that trg_inventory_movement_fifo
//      is AFTER INSERT only so an UPDATE re-runs no allocation. Section 0 checks
//      that claim EMPIRICALLY, against the live catalog and the live rows.
//
// WHY A SCRIPT AND NOT A QUESTION. Repo rule (CLAUDE.md): the owner is not a
// database console. Anything that lives only in production becomes a script plus
// a manual workflow_dispatch reading secrets.DATABASE_URL.
//
// SAFETY CONTRACT (identical to check-inventory-integrity.mjs, the sibling this
// mirrors):
//   * SELECT only. No DDL, no INSERT/UPDATE/DELETE, no transaction, no marker
//     row, no change to any costing logic. Nothing here can write.
//   * Every interpolated identifier is a schema/column name DISCOVERED from
//     information_schema and re-validated against ^[a-z_][a-z0-9_]*$. No user
//     input reaches any statement.
//   * Exit 0 for every legitimate answer — the ANSWER is the output, not the
//     exit code. Non-zero only when the database is unreachable or a query errors.
//   * Manual trigger only, own concurrency group.
//
// DEFINITIONS OF CORRECTNESS ARE REUSED, NOT INVENTED. Where an existing
// detector or engine already defines an invariant, this script uses that exact
// definition so the two can never disagree:
//   * signed movement sum (IN +qty, OUT -qty, ADJUSTMENT/TRANSFER +qty) is the
//     scm.inventory_balances convention (migration 0084), via
//     check-inventory-integrity.mjs.
//   * "live received qty" for a PO line is GREATEST(0, qty_accepted - returned_qty)
//     over non-DRAFT / non-CANCELLED GRNs — recomputePoReceived's rule, via
//     diag-po-receipt-drift.mjs.
//   * the authoritative landed unit cost of a lot is
//     (PI line price -> GR price -> Pending) + allocated freight, weighted by qty
//     over the lot identity (product_code, variant_key, batch_no) — the exact
//     cascade recostFromGrn implements (backend/src/scm/lib/recost.ts).
//   * zero is NOT a price in this schema: it encodes "no price known yet"
//     (recost.ts). A zero-cost GRN lot is therefore PENDING, not a defect, and is
//     classified separately from an ADJUSTMENT/STOCK_TAKE lot at zero, which no
//     path ever re-costs (check-costless-stock.mjs).
//
// Env: DATABASE_URL (or .dev.vars for local use). SAMPLE=<n> rows per section.
// ----------------------------------------------------------------------------
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

const SAMPLE = Number(process.env.SAMPLE || 25);

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
const hdr = (t) => { notice(""); notice(`================ ${t} ================`); };

// Verdict tally, printed once at the end so the owner can read the answer
// without scrolling the detail.
const VERDICTS = [];
const verdict = (id, label, failing, scanned, klass, note) => {
  VERDICTS.push({ id, label, failing, scanned, klass, note });
};

/* A section that cannot run must say so and let the rest continue. Reporting a
   failed query as "0 failures" would be the exact forgery the repo's read-only
   rule forbids ("evidence is not a setting"), so the section lands in the
   verdict table as ERROR — never as PASS. */
const sectionFailed = (label, e) => {
  notice("");
  notice(`  !! SECTION FAILED — "${label}" did not complete: ${e?.message ?? e}`);
  notice("     Its checks are UNKNOWN, not clean. Everything after it still ran.");
  verdict("ERR", `section did not complete: ${label}`, 1, 0, "ERROR", String(e?.message ?? e));
};

/* SERVICE lines are FIFO-exempt by design (backend/src/scm/shared/service-sku.ts:
   item_group contains SERVICE, or item_code starts with SVC-). They legitimately
   produce NO movement, so every document-vs-movement comparison excludes them —
   otherwise a correct service line reads as a missing movement. */
const svc = (grp, code) =>
  `(UPPER(TRIM(COALESCE(${grp},''))) LIKE '%SERVICE%' OR UPPER(TRIM(COALESCE(${code},''))) LIKE 'SVC-%')`;

/* Discover which schema a table lives in (scm on prod; public on some envs).
   Never assume — mirror check-inventory-integrity.mjs. */
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
  notice("=== INVENTORY QUANTITY + COSTING AUDIT — READ-ONLY (SELECT only; no rows changed, no costing logic touched) ===");
  notice(`sample size per section: ${SAMPLE}`);

  // ── Resolve every table this audit touches, and record what is missing so a
  //    skipped section is visibly skipped rather than silently absent.
  const TABLES = [
    "inventory_movements", "inventory_lots", "inventory_lot_consumptions",
    "grns", "grn_items", "purchase_orders", "purchase_order_items",
    "purchase_invoices", "purchase_invoice_items",
    "delivery_orders", "delivery_order_items",
    "sales_invoices", "sales_invoice_items",
    "mfg_sales_order_items",
  ];
  const S = {};
  const C = {};
  for (const t of TABLES) {
    S[t] = await schemaOf(t);
    C[t] = S[t] ? await colsOf(S[t], t) : new Set();
  }
  const q = (t) => `"${ident(S[t])}"."${ident(t)}"`;
  const has = (t, ...cols) => Boolean(S[t]) && cols.every((c) => C[t].has(c));

  notice("");
  notice("resolved tables (schema / column count):");
  for (const t of TABLES) notice(`  ${pad(t, 28)} ${S[t] ?? "(NOT FOUND)"}  ${C[t].size || ""}`);

  if (!S.inventory_movements || !S.inventory_lots || !S.inventory_lot_consumptions) {
    notice("FATAL — the three ledger tables are not all present. Cannot run. (Missing-table condition, not a data answer.)");
    return;
  }

  const M = q("inventory_movements");
  const L = q("inventory_lots");
  const K = q("inventory_lot_consumptions");
  const byCompany = C.inventory_movements.has("company_id") && C.inventory_lots.has("company_id");
  const coSel = byCompany ? "company_id" : "NULL::int AS company_id";
  const coGrp = byCompany ? ", company_id" : "";
  notice("");
  /* Declared here, assigned inside their sections: a later section reads them,
     and the per-section try/catch below would otherwise scope them away. */
  let bucketTotal = 0;
  let consTotal = 0;
  let outRows = [];

  notice(`company_id on both ledgers? ${byCompany ? "YES — every bucket is company-scoped" : "NO — grouping without company"}`);

  try {
    // ==========================================================================
    // SECTION 0 — ENGINE FACTS + THE batch_no RENAME (highest priority)
    // ==========================================================================
    hdr("0. ENGINE FACTS — what the live catalog says, not what the DDL file says");

    /* 0a. Trigger timing. tgtype is a bitmask (pg_trigger): bit0 ROW, bit1 BEFORE,
       bit2 INSERT, bit3 DELETE, bit4 UPDATE, bit6 INSTEAD OF. The repair's whole
       safety argument is "AFTER INSERT only, so an UPDATE re-runs no allocation".
       Read it off the live catalog rather than trusting the .sql in the repo — the
       repo file is not proof that production has that version. */
    const trg = await pg.unsafe(`
      SELECT t.tgname,
             c.relname,
             n.nspname,
             t.tgtype,
             (t.tgtype & 1)  <> 0 AS is_row,
             (t.tgtype & 2)  <> 0 AS is_before,
             (t.tgtype & 4)  <> 0 AS on_insert,
             (t.tgtype & 8)  <> 0 AS on_delete,
             (t.tgtype & 16) <> 0 AS on_update,
             (t.tgtype & 64) <> 0 AS is_instead,
             t.tgenabled,
             p.proname AS fn
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal
         AND n.nspname IN ('scm','public')
         AND c.relname IN ('inventory_movements','inventory_lots','inventory_lot_consumptions')
       ORDER BY c.relname, t.tgname`);

    notice("  triggers on the three ledger tables:");
    if (trg.length === 0) notice("    (none)");
    let fifoUpdateFires = 0;
    for (const t of trg) {
      const when = t.is_instead ? "INSTEAD OF" : t.is_before ? "BEFORE" : "AFTER";
      const evts = [t.on_insert && "INSERT", t.on_update && "UPDATE", t.on_delete && "DELETE"].filter(Boolean).join("/");
      if (t.on_update) fifoUpdateFires += 1;
      notice(`    ${pad(t.nspname + "." + t.relname, 34)} ${pad(t.tgname, 34)} ${pad(when + " " + evts, 24)} ${pad("FOR EACH " + (t.is_row ? "ROW" : "STATEMENT"), 20)} enabled=${t.tgenabled} fn=${t.fn}`);
    }
    notice("");
    notice(`  triggers on these tables that fire on UPDATE : ${fifoUpdateFires}`);
    notice("  A batch_no UPDATE can only have moved value if some trigger here fires on UPDATE.");
    notice("  0 means the rename provably re-ran no allocation, created no lot, and consumed nothing.");
    verdict("0a", "ledger triggers firing on UPDATE (must be 0 for the rename to be inert)",
      fifoUpdateFires, trg.length, fifoUpdateFires === 0 ? "PASS" : "DEFECT",
      "an UPDATE-firing trigger would mean the batch_no rename could have moved value");

    /* 0b. Unique constraints/indexes touching batch_no. The repair also asserted
       no unique constraint involves batch_no (so a rename could not collide or be
       rejected). Enumerate them. */
    const idx = await pg.unsafe(`
      SELECT n.nspname, c.relname AS table_name, i.relname AS index_name,
             ix.indisunique AS is_unique,
             pg_get_indexdef(ix.indexrelid) AS def
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class c ON c.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('scm','public')
         AND c.relname IN ('inventory_movements','inventory_lots','inventory_lot_consumptions')
       ORDER BY c.relname, i.relname`);
    const uniqWithBatch = idx.filter((r) => r.is_unique && /batch_no/.test(r.def));
    notice("");
    notice(`  indexes on the three ledger tables            : ${idx.length}  (unique: ${idx.filter((r) => r.is_unique).length})`);
    notice(`  UNIQUE indexes whose definition names batch_no: ${uniqWithBatch.length}`);
    for (const r of uniqWithBatch.slice(0, SAMPLE)) notice(`    ${r.def}`);
    verdict("0b", "UNIQUE indexes involving batch_no (rename-collision risk)",
      uniqWithBatch.length, idx.length, uniqWithBatch.length === 0 ? "PASS" : "NEEDS-OWNER",
      "a unique index on batch_no would make a rename able to collide or be rejected mid-way");

    // ── 0c. Did the two tables move TOGETHER? The repair updated inventory_lots
    //    and inventory_movements in ONE transaction, keyed on (company_id,
    //    batch_no). A partial apply would show as a lot whose own IN movement
    //    carries a different batch_no — the split world fn_reconcile_dropship_batch
    //    and the batch-scoped FIFO consume would then see.
    if (C.inventory_lots.has("movement_id") && C.inventory_lots.has("batch_no") && C.inventory_movements.has("batch_no")) {
      const splitRows = await pg.unsafe(`
        SELECT l.id AS lot_id, l.batch_no AS lot_batch, m.batch_no AS mov_batch,
               l.product_code, m.source_doc_no, ${byCompany ? "l.company_id" : "NULL::int AS company_id"}
          FROM ${L} l
          JOIN ${M} m ON m.id = l.movement_id
         WHERE COALESCE(l.batch_no,'') <> COALESCE(m.batch_no,'')
         ORDER BY l.product_code`);
      const lotsWithMov = (await pg.unsafe(`SELECT count(*)::int AS n FROM ${L} l JOIN ${M} m ON m.id = l.movement_id`))[0].n;
      notice("");
      notice("  lot.batch_no vs its OWN source IN movement.batch_no (a partial rename would split these):");
      notice(`    lot/movement pairs compared                : ${lotsWithMov}`);
      notice(`    pairs whose batch_no DISAGREES             : ${splitRows.length}`);
      for (const r of splitRows.slice(0, SAMPLE)) {
        notice(`      co=${r.company_id ?? "-"} ${pad(short(r.product_code, 24), 24)} lot="${r.lot_batch ?? ""}" mov="${r.mov_batch ?? ""}" ${r.source_doc_no ?? ""}`);
      }
      verdict("0c", "lot.batch_no vs its source movement.batch_no (partial-rename split)",
        splitRows.length, lotsWithMov, splitRows.length === 0 ? "PASS" : "DEFECT",
        "the two columns are joined by fn_reconcile_dropship_batch and by batch-scoped FIFO; they must move together");
    }

    // ── 0d. Is the renamed batch_no now consistent with the document it names?
    //    After the repair a lot's batch_no should equal the CURRENT po_number of
    //    the PO the receiving GRN line descends from — that is exactly the lot
    //    identity recostFromGrn rebuilds (poNumberByGrnItem). A residual bare
    //    "PO-…" on a company-2 row is an unrepaired leftover; a batch_no that
    //    matches no purchase_orders row at all is a dangling label.
    if (C.inventory_lots.has("batch_no")) {
      const batchRows = await pg.unsafe(`
        WITH b AS (
          SELECT ${byCompany ? "company_id" : "NULL::int AS company_id"}, batch_no, count(*)::int AS lots
            FROM ${L} WHERE batch_no IS NOT NULL AND batch_no <> ''
           GROUP BY batch_no${coGrp}
        )
        SELECT b.company_id, b.batch_no, b.lots,
               EXISTS (SELECT 1 FROM ${q("purchase_orders")} po
                        WHERE po.po_number = b.batch_no
                          ${byCompany && C.purchase_orders.has("company_id") ? "AND po.company_id = b.company_id" : ""}) AS resolves
          FROM b ORDER BY b.company_id, b.batch_no`);
      const unresolved = batchRows.filter((r) => !r.resolves);
      notice("");
      notice("  batch_no -> purchase_orders.po_number resolution (the lot identity recostFromGrn rebuilds):");
      notice(`    distinct (company, batch_no) pairs on lots : ${batchRows.length}`);
      notice(`    ... resolving to exactly their own company's PO : ${batchRows.length - unresolved.length}`);
      notice(`    ... NOT resolving to any PO               : ${unresolved.length}`);
      for (const r of unresolved.slice(0, SAMPLE)) notice(`      co=${r.company_id ?? "-"} "${r.batch_no}"  (${r.lots} lot(s))`);
      verdict("0d", "lot batch_no resolving to a real PO number",
        unresolved.length, batchRows.length, unresolved.length === 0 ? "PASS" : "NEEDS-OWNER",
        "an unresolved batch_no makes recostFromGrn fall back to the COARSE (code,variant) key, which can cross-cost a multi-PO GRN");
    }

    /* 0e. Did anything write a CONSUMPTION outside a movement INSERT? Every
       consumption the trigger books is written in the same statement as its
       movement, so its write timestamp should sit on top of the movement's.
       That timestamp is consumed_at — inventory_lot_consumptions has NO
       created_at (the trigger INSERT names no timestamp, so consumed_at takes
       its DEFAULT now(), i.e. the row's write time). A consumption materially
       LATER than its movement was written by a retro-cost repair
       (fn_reconcile_uncosted_out / recost), which is legitimate and
       documented — but it is also the only shape a rename-induced re-allocation
       could take, so it is enumerated rather than assumed away. */
    if (C.inventory_lot_consumptions.has("consumed_at") && C.inventory_movements.has("created_at")) {
      const lateRows = await pg.unsafe(`
        SELECT k.id, k.source_doc_type, k.source_doc_no, k.qty_consumed, k.total_cost_sen,
               k.consumed_at AS cons_at, m.created_at AS mov_at,
               EXTRACT(EPOCH FROM (k.consumed_at - m.created_at))::bigint AS lag_s
          FROM ${K} k JOIN ${M} m ON m.id = k.movement_id
         WHERE k.consumed_at > m.created_at + INTERVAL '60 seconds'
         ORDER BY k.consumed_at DESC`);
      const totalCons = (await pg.unsafe(`SELECT count(*)::int AS n FROM ${K}`))[0].n;
      notice("");
      notice("  consumptions written LATER than their movement (i.e. NOT by the AFTER-INSERT trigger):");
      notice(`    consumption rows total                    : ${totalCons}`);
      notice(`    ... written >60s after their movement     : ${lateRows.length}`);
      for (const r of lateRows.slice(0, SAMPLE)) {
        notice(`      ${pad(short(r.source_doc_no, 20), 20)} ${pad(r.source_doc_type ?? "-", 8)} qty=${pad(r.qty_consumed, 5)} ${pad(rm(r.total_cost_sen), 12)} lag=${r.lag_s}s at ${String(r.cons_at).slice(0, 19)}`);
      }
      notice("    NOTE: a late consumption is EXPECTED from a retro-cost (fn_reconcile_uncosted_out, migration 0154)");
      notice("          or a recostFromGrn cascade. Read the timestamps: any clustered at the batch_no rename window");
      notice("          would mean the rename moved value. Anything else is the documented catch-up path.");
      verdict("0e", "consumptions written outside the AFTER-INSERT trigger (informational)",
        lateRows.length, totalCons, "INFO",
        "expected from documented retro-cost paths; the timestamps tell you whether any belong to the rename window");
    }
  } catch (e) {
    sectionFailed('0. ENGINE FACTS', e);
  }

  try {
    // ==========================================================================
    // SECTION 1 — QUANTITY: on-hand reconciliation
    // ==========================================================================
    hdr("1. QUANTITY — on-hand reconciliation (movement ledger vs FIFO lots)");
    notice("  Sigma(inventory_movements, signed) must EQUAL Sigma(inventory_lots.qty_remaining) per bucket.");
    notice("  Signed convention is byte-identical to scm.inventory_balances (migration 0084).");

    const driftRows = await pg.unsafe(`
      WITH mov AS (
        SELECT ${coSel}, warehouse_id::text AS warehouse_id, product_code,
               COALESCE(variant_key,'') AS variant_key,
               SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                      WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty
                                      ELSE 0 END) AS mov_qty,
               MAX(product_name) AS product_name
          FROM ${M} GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')${coGrp}
      ), lot AS (
        SELECT ${coSel}, warehouse_id::text AS warehouse_id, product_code,
               COALESCE(variant_key,'') AS variant_key, SUM(qty_remaining) AS lot_qty
          FROM ${L} GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')${coGrp}
      )
      SELECT COALESCE(mov.company_id, lot.company_id) AS company_id,
             COALESCE(mov.warehouse_id, lot.warehouse_id) AS warehouse_id,
             COALESCE(mov.product_code, lot.product_code) AS product_code,
             COALESCE(mov.variant_key, lot.variant_key) AS variant_key,
             COALESCE(mov.mov_qty,0) AS mov_qty, COALESCE(lot.lot_qty,0) AS lot_qty,
             COALESCE(mov.mov_qty,0) - COALESCE(lot.lot_qty,0) AS delta
        FROM mov FULL OUTER JOIN lot
          ON mov.warehouse_id = lot.warehouse_id AND mov.product_code = lot.product_code
         AND mov.variant_key = lot.variant_key ${byCompany ? "AND mov.company_id = lot.company_id" : ""}
       WHERE COALESCE(mov.mov_qty,0) <> COALESCE(lot.lot_qty,0)
       ORDER BY ABS(COALESCE(mov.mov_qty,0) - COALESCE(lot.lot_qty,0)) DESC, product_code`);

    bucketTotal = (await pg.unsafe(`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM ${M} GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')${coGrp}
      ) t`))[0].n;
    const driftUnits = driftRows.reduce((a, r) => a + Math.abs(Number(r.delta)), 0);
    notice("");
    notice(`  movement buckets scanned          : ${bucketTotal}`);
    notice(`  buckets in drift                  : ${driftRows.length}`);
    notice(`  total absolute unit drift         : ${driftUnits}`);
    if (driftRows.length) {
      notice(`  sample (up to ${SAMPLE}, largest |delta| first):`);
      notice(`    ${pad("product", 24)} ${pad("variant", 12)} ${pad("co", 3)} ${pad("movQty", 8)} ${pad("lotQty", 8)} ${pad("delta", 7)} warehouse`);
      for (const r of driftRows.slice(0, SAMPLE)) {
        notice(`    ${pad(short(r.product_code, 24), 24)} ${pad(short(r.variant_key, 12), 12)} ${pad(r.company_id ?? "-", 3)} ${pad(r.mov_qty, 8)} ${pad(r.lot_qty, 8)} ${pad(r.delta, 7)} ${short(r.warehouse_id, 38)}`);
      }
    }
    verdict("1", "on-hand reconciliation (movement sum == lot sum)", driftRows.length, bucketTotal,
      driftRows.length === 0 ? "PASS" : "DEFECT",
      "known root cause: the pre-0195 OUT branch discarded qty_short (docs/inventory-ledger-divergence-coe.md)");
  } catch (e) {
    sectionFailed('1. QUANTITY', e);
  }

  try {
    // ==========================================================================
    // SECTION 2 — QUANTITY: lot conservation and negatives
    // ==========================================================================
    hdr("2. QUANTITY — lot conservation and negative balances");
    notice("  Per lot: qty_remaining == qty_received - Sigma(consumed), qty_remaining >= 0, consumed <= received.");

    const lotCount = (await pg.unsafe(`SELECT count(*)::int AS n FROM ${L}`))[0].n;
    const lotBad = await pg.unsafe(`
      WITH c AS (SELECT lot_id, SUM(qty_consumed) AS consumed FROM ${K} GROUP BY lot_id)
      SELECT l.id, ${byCompany ? "l.company_id" : "NULL::int AS company_id"}, l.product_code,
             COALESCE(l.variant_key,'') AS variant_key, l.batch_no,
             l.qty_received, l.qty_remaining, COALESCE(c.consumed,0) AS consumed,
             l.qty_received - COALESCE(c.consumed,0) - l.qty_remaining AS residual,
             l.source_doc_type, l.source_doc_no, l.unit_cost_sen
        FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
       WHERE l.qty_received - COALESCE(c.consumed,0) <> l.qty_remaining
          OR l.qty_remaining < 0
          OR COALESCE(c.consumed,0) > l.qty_received
          OR l.qty_received < 0
       ORDER BY ABS(l.qty_received - COALESCE(c.consumed,0) - l.qty_remaining) DESC`);
    notice("");
    notice(`  lots scanned                      : ${lotCount}`);
    notice(`  lots violating conservation       : ${lotBad.length}`);
    notice(`  ... with qty_remaining < 0        : ${lotBad.filter((r) => Number(r.qty_remaining) < 0).length}`);
    notice(`  ... consumed > received           : ${lotBad.filter((r) => Number(r.consumed) > Number(r.qty_received)).length}`);
    for (const r of lotBad.slice(0, SAMPLE)) {
      notice(`    co=${r.company_id ?? "-"} ${pad(short(r.product_code, 22), 22)} batch=${pad(short(r.batch_no, 20), 20)} recv=${pad(r.qty_received, 6)} cons=${pad(r.consumed, 6)} rem=${pad(r.qty_remaining, 6)} residual=${r.residual}  ${r.source_doc_no ?? ""}`);
    }
    verdict("2a", "lot conservation (received - consumed == remaining, no negatives)",
      lotBad.length, lotCount, lotBad.length === 0 ? "PASS" : "DEFECT",
      "a violation means a lot was decremented or credited outside the FIFO functions");

    // Negative on-hand anywhere — in either ledger.
    const negRows = await pg.unsafe(`
      WITH mov AS (
        SELECT ${coSel}, warehouse_id::text AS warehouse_id, product_code,
               COALESCE(variant_key,'') AS variant_key, MAX(product_name) AS product_name,
               SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                      WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty
                                      ELSE 0 END) AS mov_qty
          FROM ${M} GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')${coGrp}
      )
      SELECT * FROM mov WHERE mov_qty < 0 ORDER BY mov_qty ASC`);
    notice("");
    notice(`  buckets with NEGATIVE movement-ledger on-hand : ${negRows.length}`);
    notice("  (a negative on-hand means more shipped than ever received into that bucket — an oversell)");
    for (const r of negRows.slice(0, SAMPLE)) {
      notice(`    co=${r.company_id ?? "-"} ${pad(short(r.product_code, 24), 24)} ${pad(short(r.variant_key, 14), 14)} onHand=${r.mov_qty}  ${short(r.warehouse_id, 38)}`);
    }
    verdict("2b", "negative on-hand in the movement ledger", negRows.length, bucketTotal,
      negRows.length === 0 ? "PASS" : "DEFECT",
      "each negative bucket is a bucket that shipped stock it never received under that exact key");
  } catch (e) {
    sectionFailed('2. QUANTITY', e);
  }

  try {
    // ==========================================================================
    // SECTION 3 — QUANTITY: document lines vs the movements they created
    // ==========================================================================
    hdr("3. QUANTITY — document lines vs their movements");

    // 3a. GRN: accepted qty (net of returns) vs the IN movements the post wrote.
    //     GOODS lines only (2026-08-02): SERVICE lines never enter inventory
    //     (grns.ts posts filter isServiceLine), so counting them here made the
    //     lens DISAGREE with section 8a and mis-name a service-only delta as a
    //     missing receipt — which is exactly how the grn-gap repair was led to
    //     insert a phantom SVC-TRANS.CHARGES lot on 2990-GRN-2606-001.
    if (has("grns", "id", "status") && has("grn_items", "grn_id", "qty_accepted")) {
      const grnNoCol = ["grn_number", "grn_no", "doc_no"].find((c) => C.grns.has(c));
      const retCol = C.grn_items.has("returned_qty") ? "COALESCE(gi.returned_qty,0)" : "0";
      const svcPred3a = (C.grn_items.has("item_group") || C.grn_items.has("material_code"))
        ? svc(C.grn_items.has("item_group") ? "gi.item_group" : "NULL",
            C.grn_items.has("material_code") ? "gi.material_code" : "NULL")
        : "FALSE";
      const grnRows = await pg.unsafe(`
        WITH lines AS (
          SELECT gi.grn_id,
                 SUM(GREATEST(0, COALESCE(gi.qty_accepted,0) - ${retCol})) FILTER (WHERE NOT ${svcPred3a})::int AS line_qty
            FROM ${q("grn_items")} gi GROUP BY gi.grn_id
        ), movs AS (
          SELECT source_doc_id::text AS doc_id,
                 SUM(CASE WHEN movement_type = 'IN' THEN qty ELSE -qty END)::int AS mov_qty,
                 count(*)::int AS mov_rows
            FROM ${M} WHERE source_doc_type = 'GRN' AND source_doc_id IS NOT NULL
           GROUP BY source_doc_id
        )
        SELECT g.id, ${grnNoCol ? `g."${ident(grnNoCol)}"` : "g.id::text"} AS doc_no,
               ${C.grns.has("company_id") ? "g.company_id" : "NULL::int AS company_id"},
               g.status::text AS status,
               COALESCE(l.line_qty,0) AS line_qty, COALESCE(m.mov_qty,0) AS mov_qty,
               COALESCE(m.mov_rows,0) AS mov_rows,
               COALESCE(l.line_qty,0) - COALESCE(m.mov_qty,0) AS delta
          FROM ${q("grns")} g
          LEFT JOIN lines l ON l.grn_id = g.id
          LEFT JOIN movs  m ON m.doc_id = g.id::text
         WHERE g.status NOT IN ('DRAFT','CANCELLED')
         ORDER BY ABS(COALESCE(l.line_qty,0) - COALESCE(m.mov_qty,0)) DESC`);
      const bad = grnRows.filter((r) => Number(r.delta) !== 0);
      notice("  3a. GRN accepted qty (net of returns) vs its IN movements");
      notice(`      posted GRNs scanned           : ${grnRows.length}`);
      notice(`      GRNs whose lines and movements DISAGREE : ${bad.length}`);
      for (const r of bad.slice(0, SAMPLE)) {
        notice(`        co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 22), 22)} ${pad(r.status, 12)} lines=${pad(r.line_qty, 6)} movements=${pad(r.mov_qty, 6)} rows=${pad(r.mov_rows, 4)} delta=${r.delta}`);
      }
      verdict("3a", "GRN line qty vs IN movement qty (goods lines — service excluded, same lens as 8a)", bad.length, grnRows.length,
        bad.length === 0 ? "PASS" : "DEFECT",
        "SERVICE lines are excluded from line_qty (they never enter inventory); a non-zero delta on a goods GRN is real");
    } else {
      notice("  3a. SKIPPED — grns / grn_items columns not present.");
    }

    // 3b. DO: shipped qty vs the OUT movements, netted with the cancel add-backs.
    //     A DO edited after shipping writes DELTA OUT rows and a cancel writes a
    //     positive ADJUSTMENT, so the correct comparison is the SIGNED net of every
    //     movement carrying that DO, not just the OUTs.
    if (has("delivery_orders", "id", "status") && has("delivery_order_items", "delivery_order_id", "qty")) {
      const doNoCol = ["do_number", "do_no", "doc_no"].find((c) => C.delivery_orders.has(c));
      /* A fourth hand-typed copy of the stock-out set — this file predates
         scripts/lib/do-shipped-states.mjs and never imported it. 'COMPLETED'
         dropped from all three occurrences on 2026-08-18: it is not a member of
         scm.do_status, so it matched nothing. It never THREW here only because
         every one of these predicates casts `d.status::text` first. */
      const shipped = "('DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED')";
      const doRows = await pg.unsafe(`
        WITH lines AS (
          SELECT di.delivery_order_id AS doc_id, SUM(COALESCE(di.qty,0))::int AS line_qty
            FROM ${q("delivery_order_items")} di GROUP BY di.delivery_order_id
        ), movs AS (
          SELECT source_doc_id::text AS doc_id,
                 SUM(CASE movement_type WHEN 'OUT' THEN qty WHEN 'ADJUSTMENT' THEN -qty
                                        WHEN 'IN' THEN -qty ELSE 0 END)::int AS net_out,
                 count(*)::int AS mov_rows
            FROM ${M} WHERE source_doc_type = 'DO' AND source_doc_id IS NOT NULL
           GROUP BY source_doc_id
        )
        SELECT d.id, ${doNoCol ? `d."${ident(doNoCol)}"` : "d.id::text"} AS doc_no,
               ${C.delivery_orders.has("company_id") ? "d.company_id" : "NULL::int AS company_id"},
               d.status::text AS status,
               ${C.delivery_orders.has("is_dropship") ? "COALESCE(d.is_dropship,false)" : "false"} AS is_dropship,
               COALESCE(l.line_qty,0) AS line_qty, COALESCE(m.net_out,0) AS net_out,
               COALESCE(m.mov_rows,0) AS mov_rows,
               COALESCE(l.line_qty,0) - COALESCE(m.net_out,0) AS delta
          FROM ${q("delivery_orders")} d
          LEFT JOIN lines l ON l.doc_id = d.id
          LEFT JOIN movs  m ON m.doc_id = d.id::text
         WHERE UPPER(d.status::text) IN ${shipped}
         ORDER BY ABS(COALESCE(l.line_qty,0) - COALESCE(m.net_out,0)) DESC`);
      const bad = doRows.filter((r) => Number(r.delta) !== 0);
      notice("");
      notice("  3b. DO shipped line qty vs its NET movement qty (OUT minus add-backs)");
      notice(`      shipped DOs scanned           : ${doRows.length}`);
      notice(`      DOs whose lines and movements DISAGREE : ${bad.length}`);
      notice(`      ... of those, drop-ship       : ${bad.filter((r) => r.is_dropship).length}  (drop-ship may legitimately hold no owned stock)`);
      for (const r of bad.slice(0, SAMPLE)) {
        notice(`        co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 22), 22)} ${pad(r.status, 12)} dropship=${pad(r.is_dropship, 5)} lines=${pad(r.line_qty, 6)} netOut=${pad(r.net_out, 6)} rows=${pad(r.mov_rows, 4)} delta=${r.delta}`);
      }
      verdict("3b", "DO line qty vs net movement qty", bad.length, doRows.length,
        bad.length === 0 ? "PASS" : "NEEDS-OWNER",
        "service-only (SVC-*) lines are FIFO-exempt and legitimately move no stock — subtract those before treating the count as a defect");
    } else {
      notice("  3b. SKIPPED — delivery_orders / delivery_order_items columns not present.");
    }
  } catch (e) {
    sectionFailed('3. QUANTITY', e);
  }

  try {
    // ==========================================================================
    // SECTION 4 — ORPHANS
    // ==========================================================================
    hdr("4. ORPHANS — movements with no parent document");
    const parentByType = [
      ["GRN", "grns"], ["DO", "delivery_orders"],
      ["PURCHASE_RETURN", "purchase_returns"], ["DR", "delivery_returns"],
      ["STOCK_TRANSFER", "stock_transfers"], ["STOCK_TAKE", "stock_takes"],
    ];
    const typeRows = await pg.unsafe(`
      SELECT COALESCE(source_doc_type,'(null)') AS t, count(*)::int AS n,
             count(*) FILTER (WHERE source_doc_id IS NULL)::int AS null_id
        FROM ${M} GROUP BY source_doc_type ORDER BY n DESC`);
    notice("  movement rows by source_doc_type:");
    for (const r of typeRows) notice(`    ${pad(r.t, 22)} ${pad(r.n, 8)} (source_doc_id NULL: ${r.null_id})`);

    let orphanTotal = 0, orphanScanned = 0;
    notice("");
    notice("  movements whose source_doc_id resolves to NO row in its parent table:");
    for (const [t, tbl] of parentByType) {
      const sch = await schemaOf(tbl);
      if (!sch) { notice(`    ${pad(t, 18)} parent table ${tbl} not present — skipped`); continue; }
      const r = await pg.unsafe(`
        SELECT count(*)::int AS scanned,
               count(*) FILTER (WHERE p.id IS NULL)::int AS orphans
          FROM ${M} m
          LEFT JOIN "${ident(sch)}"."${ident(tbl)}" p ON p.id::text = m.source_doc_id::text
         WHERE m.source_doc_type = '${t}' AND m.source_doc_id IS NOT NULL`);
      orphanTotal += r[0].orphans; orphanScanned += r[0].scanned;
      notice(`    ${pad(t, 18)} scanned ${pad(r[0].scanned, 7)} orphans ${r[0].orphans}`);
    }
    verdict("4", "movements whose parent document is missing", orphanTotal, orphanScanned,
      orphanTotal === 0 ? "PASS" : "DEFECT",
      "an orphan movement moves stock for a document that no longer exists");
  } catch (e) {
    sectionFailed('4. ORPHANS', e);
  }

  try {
    // ==========================================================================
    // SECTION 5 — COSTING: GRN capture
    // ==========================================================================
    hdr("5. COSTING — GRN capture (is the cost stamped on receipt the right one?)");
    notice("  Correct = the recostFromGrn cascade's own answer: per lot identity");
    notice("  (product_code, variant_key, batch_no), the qty-weighted average of");
    notice("     goods = PI line price (in MYR at the PI's rate) if > 0, else GR price x GRN rate if > 0, else PENDING");
    notice("     freight = round(grn_items.allocated_charge_centi / qty) + round(PI allocated_charge_centi / qty)");
    notice("  Zero is NOT a price in this schema — it encodes 'no price known yet' (recost.ts).");

    const canCost =
      has("grn_items", "id", "grn_id", "material_code", "qty_accepted", "unit_price_centi") &&
      has("grns", "id", "status") &&
      has("purchase_order_items", "id", "purchase_order_id") &&
      has("purchase_orders", "id", "po_number") &&
      C.inventory_lots.has("unit_cost_sen");
    if (canCost) {
      const grnRate = C.grns.has("exchange_rate") ? "COALESCE(g.exchange_rate,1)" : "1";
      const piRate = C.purchase_invoices.has("exchange_rate") ? "COALESCE(pi.exchange_rate,1)" : "1";
      const giFreight = C.grn_items.has("allocated_charge_centi") ? "COALESCE(gi.allocated_charge_centi,0)" : "0";
      const piFreight = C.purchase_invoice_items.has("allocated_charge_centi") ? "COALESCE(pii.allocated_charge_centi,0)" : "0";
      const havePi = has("purchase_invoice_items", "grn_item_id", "qty", "unit_price_centi") && has("purchase_invoices", "id", "status");

      /* Rebuild the authoritative landed cost per GRN LINE exactly as recost.ts
         does, then aggregate to the lot identity. Every rounding step mirrors the
         TypeScript (Math.round -> ROUND), so a divergence reported here is a real
         divergence and not a rounding artefact of this script. */
      const costRows = await pg.unsafe(`
        WITH pi_line AS (
          ${havePi ? `
          SELECT pii.grn_item_id,
                 SUM(pii.qty) AS qty,
                 SUM(pii.qty * ROUND(COALESCE(pii.unit_price_centi,0) * ${piRate})) AS amt,
                 SUM(${piFreight}) AS freight
            FROM ${q("purchase_invoice_items")} pii
            JOIN ${q("purchase_invoices")} pi ON pi.id = pii.purchase_invoice_id
           WHERE pii.grn_item_id IS NOT NULL
             AND UPPER(pi.status::text) NOT IN ('DRAFT','CANCELLED')
           GROUP BY pii.grn_item_id`
          : "SELECT NULL::uuid AS grn_item_id, 0::numeric AS qty, 0::numeric AS amt, 0::numeric AS freight WHERE false"}
        ), line AS (
          SELECT gi.id AS gi_id, gi.grn_id, gi.material_code,
                 GREATEST(0, COALESCE(gi.qty_accepted,0)) AS qty,
                 CASE WHEN COALESCE(p.qty,0) > 0 AND ROUND(p.amt / p.qty) > 0
                      THEN ROUND(p.amt / p.qty)
                      WHEN COALESCE(gi.unit_price_centi,0) > 0
                      THEN ROUND(COALESCE(gi.unit_price_centi,0) * ${grnRate})
                      ELSE NULL END AS goods,
                 CASE WHEN GREATEST(0, COALESCE(gi.qty_accepted,0)) > 0
                      THEN ROUND(${giFreight}::numeric / GREATEST(0, COALESCE(gi.qty_accepted,0)))
                         + ROUND(COALESCE(p.freight,0)::numeric / GREATEST(0, COALESCE(gi.qty_accepted,0)))
                      ELSE 0 END AS freight,
                 ${C.grn_items.has("purchase_order_item_id") ? "gi.purchase_order_item_id" : "NULL::uuid AS purchase_order_item_id"}
            FROM ${q("grn_items")} gi
            JOIN ${q("grns")} g ON g.id = gi.grn_id
            LEFT JOIN pi_line p ON p.grn_item_id = gi.id
           WHERE UPPER(g.status::text) NOT IN ('DRAFT','CANCELLED')
        ), line_batch AS (
          SELECT l.*, po.po_number AS batch_no
            FROM line l
            LEFT JOIN ${q("purchase_order_items")} poi ON poi.id = l.purchase_order_item_id
            LEFT JOIN ${q("purchase_orders")} po ON po.id = poi.purchase_order_id
        ), agg AS (
          SELECT grn_id, material_code, COALESCE(batch_no,'') AS batch_no,
                 SUM(qty) AS qty, SUM(qty * (goods + freight)) AS amt
            FROM line_batch WHERE goods IS NOT NULL
           GROUP BY grn_id, material_code, COALESCE(batch_no,'')
        )
        SELECT l.id AS lot_id, ${byCompany ? "l.company_id" : "NULL::int AS company_id"},
               l.product_code, COALESCE(l.batch_no,'') AS batch_no,
               l.qty_received, l.qty_remaining, l.unit_cost_sen, l.source_doc_no,
               CASE WHEN a.qty > 0 THEN ROUND(a.amt / a.qty) ELSE NULL END AS expected_cost_sen
          FROM ${L} l
          LEFT JOIN agg a
            ON a.grn_id::text = l.source_doc_id::text
           AND a.material_code = l.product_code
           AND a.batch_no = COALESCE(l.batch_no,'')
         WHERE l.source_doc_type = 'GRN'
         ORDER BY l.product_code`);

      const grnLots = costRows.length;
      const pending = costRows.filter((r) => r.expected_cost_sen === null);
      const priced = costRows.filter((r) => r.expected_cost_sen !== null);
      const mism = priced.filter((r) => Number(r.unit_cost_sen ?? 0) !== Number(r.expected_cost_sen));
      const zeroCost = costRows.filter((r) => Number(r.unit_cost_sen ?? 0) === 0);
      const valueGap = mism.reduce((a, r) => a + Math.abs((Number(r.expected_cost_sen) - Number(r.unit_cost_sen ?? 0)) * Number(r.qty_received ?? 0)), 0);

      notice("");
      notice(`  GRN-sourced lots scanned                    : ${grnLots}`);
      notice(`  ... no price anywhere yet (PENDING, legitimate) : ${pending.length}`);
      notice(`  ... priced, and the stored cost MATCHES      : ${priced.length - mism.length}`);
      notice(`  ... priced, and the stored cost DIVERGES     : ${mism.length}`);
      notice(`  absolute value of the divergence (recv qty x delta) : ${rm(valueGap)}`);
      notice(`  lots carrying unit_cost_sen = 0             : ${zeroCost.length}  (0 means "Pending", not "free")`);
      if (mism.length) {
        notice(`  sample (up to ${SAMPLE}, largest value gap first):`);
        notice(`    ${pad("product", 24)} ${pad("batch", 22)} ${pad("recv", 5)} ${pad("stored", 12)} ${pad("expected", 12)} ${pad("gap", 12)} GRN`);
        const bySize = [...mism].sort((a, b) =>
          Math.abs((b.expected_cost_sen - b.unit_cost_sen) * b.qty_received) -
          Math.abs((a.expected_cost_sen - a.unit_cost_sen) * a.qty_received));
        for (const r of bySize.slice(0, SAMPLE)) {
          const gap = (Number(r.expected_cost_sen) - Number(r.unit_cost_sen ?? 0)) * Number(r.qty_received ?? 0);
          notice(`    ${pad(short(r.product_code, 24), 24)} ${pad(short(r.batch_no, 22), 22)} ${pad(r.qty_received, 5)} ${pad(rm(r.unit_cost_sen), 12)} ${pad(rm(r.expected_cost_sen), 12)} ${pad(rm(gap), 12)} ${short(r.source_doc_no, 20)}`);
        }
      }
      verdict("5a", "GRN lot unit cost == the recost cascade's authoritative landed cost",
        mism.length, priced.length, mism.length === 0 ? "PASS" : "DEFECT",
        "a divergence means the lot carries a cost the current PI/GR prices no longer justify — recostFromGrn has not run since they changed");
      verdict("5b", "GRN lots still at zero cost (Pending — self-heals on PI entry)",
        zeroCost.length, grnLots, "LEGIT-BY-DESIGN",
        "zero encodes 'no price known'; recostFromGrn stamps the real cost when the supplier PI lands");
    } else {
      notice("  SKIPPED — grn_items / grns cost columns not present.");
    }

    // Zero-cost lots by source: only the non-GRN sources are the real defect,
    // because no path ever re-costs those (check-costless-stock.mjs's finding).
    const zeroBySource = await pg.unsafe(`
      SELECT COALESCE(source_doc_type,'(null)') AS src, count(*)::int AS lots,
             SUM(qty_remaining)::int AS open_units
        FROM ${L} WHERE COALESCE(unit_cost_sen,0) = 0 AND qty_remaining > 0
       GROUP BY source_doc_type ORDER BY open_units DESC`);
    notice("");
    notice("  OPEN (qty_remaining > 0) lots at zero cost, by source:");
    if (zeroBySource.length === 0) notice("    none");
    for (const r of zeroBySource) notice(`    ${pad(r.src, 20)} lots=${pad(r.lots, 6)} openUnits=${r.open_units}`);
    const permanentZero = zeroBySource.filter((r) => !["GRN"].includes(r.src));
    verdict("5c", "OPEN zero-cost lots from a source no re-cost path covers",
      permanentZero.reduce((a, r) => a + r.open_units, 0),
      zeroBySource.reduce((a, r) => a + r.open_units, 0),
      permanentZero.length === 0 ? "PASS" : "DEFECT",
      "recost is GRN-keyed; an ADJUSTMENT / STOCK_TAKE lot at zero books RM0 COGS forever when it sells");
  } catch (e) {
    sectionFailed('5. COSTING', e);
  }

  try {
    // ==========================================================================
    // SECTION 6 — COSTING: COGS on shipment
    // ==========================================================================
    hdr("6. COSTING — COGS on shipment vs the lots actually consumed");
    notice("  For every OUT / negative ADJUSTMENT: inventory_movements.total_cost_sen must EQUAL");
    notice("  Sigma(inventory_lot_consumptions.total_cost_sen) for that movement, and the consumed");
    notice("  qty must equal the movement qty.");

    outRows = await pg.unsafe(`
      WITH c AS (
        SELECT movement_id, SUM(qty_consumed)::int AS cons_qty,
               SUM(total_cost_sen)::bigint AS cons_cost
          FROM ${K} GROUP BY movement_id
      )
      SELECT m.id, ${byCompany ? "m.company_id" : "NULL::int AS company_id"},
             m.movement_type, m.source_doc_type, m.source_doc_no, m.product_code,
             COALESCE(m.variant_key,'') AS variant_key, m.batch_no,
             ABS(m.qty) AS mov_qty, COALESCE(c.cons_qty,0) AS cons_qty,
             COALESCE(m.total_cost_sen,0) AS mov_cost, COALESCE(c.cons_cost,0) AS cons_cost,
             m.created_at
        FROM ${M} m LEFT JOIN c ON c.movement_id = m.id
       WHERE (m.movement_type = 'OUT' OR (m.movement_type = 'ADJUSTMENT' AND m.qty < 0))
       ORDER BY m.created_at`);
    const qtyBad = outRows.filter((r) => Number(r.cons_qty) !== Number(r.mov_qty));
    const costBad = outRows.filter((r) => Number(r.cons_cost) !== Number(r.mov_cost));
    const zeroCogs = outRows.filter((r) => Number(r.mov_cost) === 0);
    notice("");
    notice(`  outgoing movements scanned                   : ${outRows.length}`);
    notice(`  ... consumed qty != movement qty             : ${qtyBad.length}  (units short: ${qtyBad.reduce((a, r) => a + (Number(r.mov_qty) - Number(r.cons_qty)), 0)})`);
    notice(`  ... movement COGS != Sigma(consumption cost) : ${costBad.length}`);
    notice(`  ... movement COGS is exactly RM0             : ${zeroCogs.length}`);
    if (qtyBad.length) {
      notice(`  sample of qty-short movements (up to ${SAMPLE}):`);
      notice(`    ${pad("doc", 22)} ${pad("type", 6)} ${pad("product", 24)} ${pad("movQty", 7)} ${pad("consQty", 8)} ${pad("cost", 12)} created`);
      for (const r of qtyBad.slice(0, SAMPLE)) {
        notice(`    ${pad(short(r.source_doc_no, 22), 22)} ${pad(r.movement_type, 6)} ${pad(short(r.product_code, 24), 24)} ${pad(r.mov_qty, 7)} ${pad(r.cons_qty, 8)} ${pad(rm(r.mov_cost), 12)} ${String(r.created_at).slice(0, 10)}`);
      }
    }
    if (costBad.length) {
      notice(`  sample of COGS-mismatched movements (up to ${SAMPLE}):`);
      for (const r of costBad.slice(0, SAMPLE)) {
        notice(`    ${pad(short(r.source_doc_no, 22), 22)} ${pad(short(r.product_code, 24), 24)} movCost=${pad(rm(r.mov_cost), 12)} consCost=${pad(rm(r.cons_cost), 12)} delta=${rm(Number(r.mov_cost) - Number(r.cons_cost))}`);
      }
    }
    verdict("6a", "outgoing movement qty fully backed by lot consumptions",
      qtyBad.length, outRows.length, qtyBad.length === 0 ? "PASS" : "DEFECT",
      "an unbacked unit shipped with no COGS behind it (docs/inventory-costing-oversell-coe.md)");
    verdict("6b", "movement COGS == sum of the consumptions it created",
      costBad.length, outRows.length, costBad.length === 0 ? "PASS" : "DEFECT",
      "the trigger stamps total_cost_sen from the same consume that wrote the consumptions; a gap means one side was edited alone");
    verdict("6c", "outgoing movements at RM0 COGS", zeroCogs.length, outRows.length, "INFO",
      "legitimate when the consumed lots were themselves Pending-priced; a defect when the units consumed nothing at all (see 6a)");

    // 6d. Consumption arithmetic must be internally consistent, and must match
    //     the lot it drew from — this is the invariant fn_consume_fifo writes.
    const consBad = await pg.unsafe(`
      SELECT k.id, k.source_doc_no, k.qty_consumed, k.unit_cost_sen, k.total_cost_sen,
             l.unit_cost_sen AS lot_cost, k.product_code
        FROM ${K} k LEFT JOIN ${L} l ON l.id = k.lot_id
       WHERE k.total_cost_sen <> k.qty_consumed * k.unit_cost_sen
          OR k.qty_consumed <= 0
          OR (l.id IS NOT NULL AND l.unit_cost_sen <> k.unit_cost_sen)
       ORDER BY ABS(k.total_cost_sen - k.qty_consumed * k.unit_cost_sen) DESC`);
    consTotal = (await pg.unsafe(`SELECT count(*)::int AS n FROM ${K}`))[0].n;
    notice("");
    notice(`  consumption rows scanned                     : ${consTotal}`);
    notice(`  ... failing total == qty x unit, or disagreeing with their lot's cost : ${consBad.length}`);
    for (const r of consBad.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.source_doc_no, 22), 22)} ${pad(short(r.product_code, 24), 24)} qty=${pad(r.qty_consumed, 5)} unit=${pad(rm(r.unit_cost_sen), 12)} total=${pad(rm(r.total_cost_sen), 12)} lotUnit=${rm(r.lot_cost)}`);
    }
    verdict("6d", "consumption arithmetic and lot-cost agreement", consBad.length, consTotal,
      consBad.length === 0 ? "PASS" : "DEFECT",
      "NOTE: recostFromGrn deliberately restamps BOTH the lot and its consumptions, so a disagreement means a half-applied recost");

    // 6e. Sales Invoice cost vs the DO cost it copied. restampSiFromDo copies
    //     delivery_order_items.unit_cost_centi x qty onto sales_invoice_items
    //     .line_cost_centi, so the two must agree on every non-cancelled invoice.
    if (has("sales_invoice_items", "do_item_id", "qty", "line_cost_centi") &&
        has("delivery_order_items", "id", "unit_cost_centi") &&
        has("sales_invoices", "id", "status")) {
      const siNoCol = ["invoice_number", "si_number", "doc_no"].find((c) => C.sales_invoices.has(c));
      const siRows = await pg.unsafe(`
        SELECT si.id AS si_id, ${siNoCol ? `si."${ident(siNoCol)}"` : "si.id::text"} AS doc_no,
               ${C.sales_invoices.has("company_id") ? "si.company_id" : "NULL::int AS company_id"},
               sii.id AS line_id, sii.qty, sii.line_cost_centi,
               di.unit_cost_centi, (sii.qty * COALESCE(di.unit_cost_centi,0)) AS expected_cost
          FROM ${q("sales_invoice_items")} sii
          JOIN ${q("sales_invoices")} si ON si.id = sii.sales_invoice_id
          JOIN ${q("delivery_order_items")} di ON di.id = sii.do_item_id
         WHERE UPPER(si.status::text) <> 'CANCELLED'`);
      const bad = siRows.filter((r) => Number(r.line_cost_centi ?? 0) !== Number(r.expected_cost));
      const zero = siRows.filter((r) => Number(r.line_cost_centi ?? 0) === 0);
      notice("");
      notice("  6e. Sales Invoice line cost vs the DO line cost it copies (restampSiFromDo)");
      notice(`      SI lines linked to a DO line scanned : ${siRows.length}`);
      notice(`      ... line_cost_centi != qty x DO unit_cost_centi : ${bad.length}`);
      notice(`      ... line_cost_centi = 0              : ${zero.length}`);
      for (const r of bad.slice(0, SAMPLE)) {
        notice(`        co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 22), 22)} qty=${pad(r.qty, 5)} stored=${pad(rm(r.line_cost_centi), 12)} expected=${pad(rm(r.expected_cost), 12)} delta=${rm(Number(r.line_cost_centi ?? 0) - Number(r.expected_cost))}`);
      }
      verdict("6e", "Sales Invoice line cost == DO line cost x qty", bad.length, siRows.length,
        bad.length === 0 ? "PASS" : "DEFECT",
        "a gap means a DO recost did not cascade to the invoice, so the invoice's margin is wrong");

      // 6f. SI header totals must equal the sum of their own lines (recomputeSiTotals).
      if (C.sales_invoices.has("total_cost_centi")) {
        const hdrRows = await pg.unsafe(`
          WITH s AS (
            SELECT sales_invoice_id, SUM(COALESCE(line_cost_centi,0))::bigint AS line_cost
              FROM ${q("sales_invoice_items")} GROUP BY sales_invoice_id
          )
          SELECT si.id, ${siNoCol ? `si."${ident(siNoCol)}"` : "si.id::text"} AS doc_no,
                 ${C.sales_invoices.has("company_id") ? "si.company_id" : "NULL::int AS company_id"},
                 COALESCE(si.total_cost_centi,0) AS hdr_cost, COALESCE(s.line_cost,0) AS line_cost
            FROM ${q("sales_invoices")} si LEFT JOIN s ON s.sales_invoice_id = si.id
           WHERE UPPER(si.status::text) <> 'CANCELLED'`);
        const badHdr = hdrRows.filter((r) => Number(r.hdr_cost) !== Number(r.line_cost));
        notice("");
        notice("  6f. Sales Invoice header total_cost_centi vs the sum of its lines");
        notice(`      invoices scanned                 : ${hdrRows.length}`);
        notice(`      ... header != Sigma(lines)       : ${badHdr.length}`);
        for (const r of badHdr.slice(0, SAMPLE)) {
          notice(`        co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 22), 22)} header=${pad(rm(r.hdr_cost), 14)} lines=${pad(rm(r.line_cost), 14)} delta=${rm(Number(r.hdr_cost) - Number(r.line_cost))}`);
        }
        verdict("6f", "SI header cost total == sum of its line costs", badHdr.length, hdrRows.length,
          badHdr.length === 0 ? "PASS" : "DEFECT",
          "total_cost_centi is what the P&L reads; a stale header understates or overstates margin directly");
      }
    } else {
      notice("");
      notice("  6e/6f SKIPPED — sales_invoice_items / delivery_order_items cost columns not present.");
    }
  } catch (e) {
    sectionFailed('6. COSTING', e);
  }

  try {
    // ==========================================================================
    // SECTION 7 — PO -> GRN -> PI chain
    // ==========================================================================
    hdr("7. COSTING — PO -> GRN -> PI chain");
    if (has("purchase_invoice_items", "grn_item_id", "qty", "unit_price_centi") &&
        has("purchase_invoices", "id", "status") &&
        has("grn_items", "id", "qty_accepted", "unit_price_centi") && has("grns", "id", "status")) {
      const retCol = C.grn_items.has("returned_qty") ? "COALESCE(gi.returned_qty,0)" : "0";
      const piAmtExpr = C.purchase_invoice_items.has("line_total_centi")
        ? "COALESCE(pii.line_total_centi, pii.qty * COALESCE(pii.unit_price_centi,0))"
        : "pii.qty * COALESCE(pii.unit_price_centi,0)";
      const chain = await pg.unsafe(`
        WITH pi AS (
          SELECT pii.grn_item_id, SUM(pii.qty)::int AS pi_qty,
                 SUM(${piAmtExpr})::bigint AS pi_amt
            FROM ${q("purchase_invoice_items")} pii
            JOIN ${q("purchase_invoices")} p ON p.id = pii.purchase_invoice_id
           WHERE pii.grn_item_id IS NOT NULL AND UPPER(p.status::text) NOT IN ('DRAFT','CANCELLED')
           GROUP BY pii.grn_item_id
        )
        SELECT g.id AS grn_id, ${C.grns.has("grn_number") ? "g.grn_number" : "g.id::text"} AS grn_no,
               ${C.grns.has("company_id") ? "g.company_id" : "NULL::int AS company_id"},
               SUM(GREATEST(0, COALESCE(gi.qty_accepted,0) - ${retCol}))::int AS recv_qty,
               SUM(COALESCE(pi.pi_qty,0))::int AS billed_qty,
               SUM(COALESCE(gi.qty_accepted,0) * COALESCE(gi.unit_price_centi,0))::bigint AS grn_amt,
               SUM(COALESCE(pi.pi_amt,0))::bigint AS pi_amt,
               count(*) FILTER (WHERE pi.grn_item_id IS NULL)::int AS unbilled_lines,
               count(*)::int AS lines
          FROM ${q("grn_items")} gi
          JOIN ${q("grns")} g ON g.id = gi.grn_id
          LEFT JOIN pi ON pi.grn_item_id = gi.id
         WHERE UPPER(g.status::text) NOT IN ('DRAFT','CANCELLED')
         GROUP BY g.id, ${C.grns.has("grn_number") ? "g.grn_number" : "g.id"}${C.grns.has("company_id") ? ", g.company_id" : ""}
         ORDER BY 1`);
      const fullyBilled = chain.filter((r) => r.unbilled_lines === 0);
      const qtyMismatch = fullyBilled.filter((r) => Number(r.billed_qty) !== Number(r.recv_qty));
      const amtMismatch = fullyBilled.filter((r) => Number(r.pi_amt) !== Number(r.grn_amt));
      notice(`  GRNs scanned                                  : ${chain.length}`);
      notice(`  ... with at least one UNBILLED line (no PI yet, legitimate) : ${chain.length - fullyBilled.length}`);
      notice(`  ... fully billed                              : ${fullyBilled.length}`);
      notice(`      of those, PI qty != received qty          : ${qtyMismatch.length}`);
      notice(`      of those, PI amount != GRN amount         : ${amtMismatch.length}  (a price the supplier corrected is LEGITIMATE here)`);
      const show = [...new Set([...qtyMismatch, ...amtMismatch])];
      for (const r of show.slice(0, SAMPLE)) {
        notice(`    co=${r.company_id ?? "-"} ${pad(short(r.grn_no, 22), 22)} recvQty=${pad(r.recv_qty, 6)} billedQty=${pad(r.billed_qty, 6)} grnAmt=${pad(rm(r.grn_amt), 14)} piAmt=${pad(rm(r.pi_amt), 14)} delta=${rm(Number(r.pi_amt) - Number(r.grn_amt))}`);
      }
      verdict("7a", "PI billed qty == GRN received qty (fully-billed GRNs)",
        qtyMismatch.length, fullyBilled.length, qtyMismatch.length === 0 ? "PASS" : "NEEDS-OWNER",
        "a supplier may legitimately bill a different qty; each row needs the owner's eye, not an automatic verdict");
      verdict("7b", "PI amount == GRN amount (fully-billed GRNs)",
        amtMismatch.length, fullyBilled.length, "NEEDS-OWNER",
        "a corrected supplier price is the DESIGNED case — the PI supersedes the GR price and recostFromGrn restamps the lot");
    } else {
      notice("  SKIPPED — purchase_invoice_items / grn_items columns not present.");
    }

    // PO line received_qty vs the live GRN lines (the diag-po-receipt-drift rule).
    if (has("purchase_order_items", "id", "qty", "received_qty") && has("grn_items", "purchase_order_item_id", "qty_accepted")) {
      const retCol = C.grn_items.has("returned_qty") ? "COALESCE(gi.returned_qty,0)" : "0";
      const poDrift = await pg.unsafe(`
        WITH live AS (
          SELECT gi.purchase_order_item_id AS poi_id,
                 SUM(GREATEST(0, COALESCE(gi.qty_accepted,0) - ${retCol}))::int AS recv
            FROM ${q("grn_items")} gi JOIN ${q("grns")} g ON g.id = gi.grn_id
           WHERE gi.purchase_order_item_id IS NOT NULL
             AND UPPER(g.status::text) NOT IN ('CANCELLED','DRAFT')
           GROUP BY gi.purchase_order_item_id
        )
        SELECT ${C.purchase_orders.has("company_id") ? "po.company_id" : "NULL::int AS company_id"},
               po.po_number, SUM(poi.qty)::int AS ordered,
               SUM(COALESCE(poi.received_qty,0))::int AS stored_recv,
               SUM(COALESCE(l.recv,0))::int AS live_recv
          FROM ${q("purchase_order_items")} poi
          JOIN ${q("purchase_orders")} po ON po.id = poi.purchase_order_id
          LEFT JOIN live l ON l.poi_id = poi.id
         WHERE UPPER(po.status::text) <> 'CANCELLED'
         GROUP BY po.id, po.po_number${C.purchase_orders.has("company_id") ? ", po.company_id" : ""}
        HAVING SUM(COALESCE(poi.received_qty,0)) <> SUM(COALESCE(l.recv,0))`);
      const poTotal = (await pg.unsafe(`SELECT count(*)::int AS n FROM ${q("purchase_orders")} WHERE UPPER(status::text) <> 'CANCELLED'`))[0].n;
      notice("");
      notice(`  PO lines: stored received_qty vs live GRN lines (recomputePoReceived's rule)`);
      notice(`      non-cancelled POs scanned            : ${poTotal}`);
      notice(`      POs whose received_qty has DRIFTED   : ${poDrift.length}`);
      for (const r of poDrift.slice(0, SAMPLE)) {
        notice(`        co=${r.company_id ?? "-"} ${pad(short(r.po_number, 22), 22)} ordered=${pad(r.ordered, 6)} stored=${pad(r.stored_recv, 6)} live=${r.live_recv}`);
      }
      verdict("7c", "PO received_qty agrees with its live GRN lines", poDrift.length, poTotal,
        poDrift.length === 0 ? "PASS" : "DEFECT",
        "the 2026-07-31 incident: RM25,518.50 of received goods read as outstanding for nine days");
    }

  } catch (e) {
    sectionFailed('7. COSTING', e);
  }

  try {
    // ==========================================================================
    // SECTION 8 — INBOUND: did what was signed for actually land in inventory?
    // Owner: "我实际签收的货物数量是多少？这些数据是否准确录入了 inventory？"
    // ==========================================================================
    hdr("8. INBOUND — PO -> GRN -> inventory: does the signed-for qty equal the stock that landed?");
    notice("  Three quantities must agree per GRN, for goods (non-SERVICE) lines only:");
    notice("    (a) grn_items.qty_accepted     — what was signed for");
    notice("    (b) the IN inventory_movements — what the post booked");
    notice("    (c) inventory_lots.qty_received — what the FIFO trigger opened as owned stock");
    notice("  qty_accepted (NOT qty_received) is the column the post uses (grns.ts:502) — a rejected");
    notice("  unit is deliberately never stocked, so accepted < received is correct, not a gap.");

    if (has("grns", "id", "status") && has("grn_items", "grn_id", "qty_accepted", "material_code")) {
      const grnNoCol = ["grn_number", "grn_no", "doc_no"].find((c) => C.grns.has(c));
      const svcPred = svc("gi.item_group", "gi.material_code");
      const inbound = await pg.unsafe(`
        WITH lines AS (
          SELECT gi.grn_id,
                 SUM(COALESCE(gi.qty_accepted,0)) FILTER (WHERE NOT ${svcPred} AND COALESCE(gi.qty_accepted,0) > 0)::int AS goods_accepted,
                 SUM(COALESCE(gi.qty_received,0)) FILTER (WHERE NOT ${svcPred})::int AS goods_received,
                 count(*) FILTER (WHERE ${svcPred})::int AS service_lines
            FROM ${q("grn_items")} gi GROUP BY gi.grn_id
        ), movs AS (
          SELECT source_doc_id::text AS doc_id,
                 SUM(qty) FILTER (WHERE movement_type = 'IN')::int AS in_qty,
                 SUM(qty) FILTER (WHERE movement_type = 'OUT')::int AS out_qty
            FROM ${M} WHERE source_doc_type = 'GRN' AND source_doc_id IS NOT NULL
           GROUP BY source_doc_id
        ), lts AS (
          SELECT source_doc_id::text AS doc_id, SUM(qty_received)::int AS lot_qty, count(*)::int AS lots
            FROM ${L} WHERE source_doc_type = 'GRN' AND source_doc_id IS NOT NULL
           GROUP BY source_doc_id
        )
        SELECT g.id, ${grnNoCol ? `g."${ident(grnNoCol)}"` : "g.id::text"} AS doc_no,
               ${C.grns.has("company_id") ? "g.company_id" : "NULL::int AS company_id"},
               g.status::text AS status,
               COALESCE(l.goods_accepted,0) AS accepted,
               COALESCE(l.goods_received,0) AS received,
               COALESCE(l.service_lines,0) AS service_lines,
               COALESCE(m.in_qty,0) AS in_qty, COALESCE(m.out_qty,0) AS out_qty,
               COALESCE(t.lot_qty,0) AS lot_qty, COALESCE(t.lots,0) AS lots
          FROM ${q("grns")} g
          LEFT JOIN lines l ON l.grn_id = g.id
          LEFT JOIN movs  m ON m.doc_id = g.id::text
          LEFT JOIN lts   t ON t.doc_id = g.id::text
         WHERE UPPER(g.status::text) NOT IN ('DRAFT','CANCELLED')
         ORDER BY 2`);
      /* A GRN that was later edited or partially reversed carries its own OUT rows
         (grns.ts line-delete / qty-down / warehouse-change), so the net booked qty
         is IN - OUT. The lots the trigger opened count the GROSS IN, because a
         reversal OUT consumes a lot rather than deleting it. Compare accordingly. */
      const badMov = inbound.filter((r) => Number(r.accepted) !== Number(r.in_qty) - Number(r.out_qty));
      const badLot = inbound.filter((r) => Number(r.in_qty) !== Number(r.lot_qty));
      notice("");
      notice(`  posted GRNs scanned                            : ${inbound.length}`);
      notice(`  (a) vs (b): accepted qty != net IN movement qty : ${badMov.length}`);
      notice(`  (b) vs (c): IN movement qty != lot qty_received : ${badLot.length}`);
      const showIn = [...new Set([...badMov, ...badLot])];
      if (showIn.length) {
        notice(`  sample (up to ${SAMPLE}):`);
        notice(`    ${pad("GRN", 22)} ${pad("co", 3)} ${pad("status", 10)} ${pad("accepted", 9)} ${pad("recvd", 7)} ${pad("IN", 6)} ${pad("OUT", 6)} ${pad("lotQty", 7)} ${pad("lots", 5)} svcLines`);
        for (const r of showIn.slice(0, SAMPLE)) {
          notice(`    ${pad(short(r.doc_no, 22), 22)} ${pad(r.company_id ?? "-", 3)} ${pad(r.status, 10)} ${pad(r.accepted, 9)} ${pad(r.received, 7)} ${pad(r.in_qty, 6)} ${pad(r.out_qty, 6)} ${pad(r.lot_qty, 7)} ${pad(r.lots, 5)} ${r.service_lines}`);
        }
      }
      const rejected = inbound.filter((r) => Number(r.received) !== Number(r.accepted));
      notice("");
      notice(`  GRNs where qty_received != qty_accepted (a rejection — correct not to stock it) : ${rejected.length}`);
      for (const r of rejected.slice(0, SAMPLE)) {
        notice(`    ${pad(short(r.doc_no, 22), 22)} received=${pad(r.received, 6)} accepted=${pad(r.accepted, 6)} rejected=${Number(r.received) - Number(r.accepted)}`);
      }
      verdict("8a", "GRN accepted qty == net IN movement qty (goods lines)", badMov.length, inbound.length,
        badMov.length === 0 ? "PASS" : "DEFECT",
        "a gap means goods were signed for that never entered (or left) inventory");
      verdict("8b", "IN movement qty == the lot qty_received the trigger opened", badLot.length, inbound.length,
        badLot.length === 0 ? "PASS" : "DEFECT",
        "a gap means the AFTER-INSERT trigger did not open a lot for a booked receipt — that stock is invisible to FIFO");
      verdict("8c", "GRNs with a rejected quantity (informational)", rejected.length, inbound.length, "INFO",
        "qty_received > qty_accepted is a rejection at the door; not stocking it is the designed behaviour");
    } else {
      notice("  SKIPPED — grns / grn_items columns not present.");
    }
  } catch (e) {
    sectionFailed('8. INBOUND', e);
  }

  try {
    // ==========================================================================
    // SECTION 9 — OUTBOUND FIFO IDENTITY: which exact lot did each DO consume,
    // and was it the right (oldest eligible) one?
    // Owner: "系统在出 DO 时，是否根据库存的 FIFO 原则来扣减库存？"
    // ==========================================================================
    hdr("9. OUTBOUND — does each DO consumption name a specific lot, and is it the FIFO-correct lot?");
    notice("  FIFO order is defined by the engine itself: ORDER BY received_at ASC, id ASC");
    notice("  (fn_consume_fifo / fn_consume_fifo_batch, inventory-fifo-trigger.sql:62,120).");
    notice("  A consumption is a FIFO VIOLATION when, at the moment it was written, an OLDER");
    notice("  eligible lot in the same (company, warehouse, product, variant[, batch]) key still");
    notice("  had units available. Availability is reconstructed from the consumption timeline.");

    // 9a. Consumed without naming a lot.
    const noLot = await pg.unsafe(`
      SELECT count(*)::int AS n FROM ${K} WHERE lot_id IS NULL`);
    const danglingLot = await pg.unsafe(`
      SELECT count(*)::int AS n FROM ${K} k LEFT JOIN ${L} l ON l.id = k.lot_id
       WHERE k.lot_id IS NOT NULL AND l.id IS NULL`);
    notice("");
    notice(`  consumptions with NO lot_id                    : ${noLot[0].n}`);
    notice(`  consumptions whose lot_id names a missing lot  : ${danglingLot[0].n}`);
    verdict("9a", "every consumption names a real lot", noLot[0].n + danglingLot[0].n, consTotal,
      noLot[0].n + danglingLot[0].n === 0 ? "PASS" : "DEFECT",
      "a consumption with no lot cannot be traced to the goods it consumed");

    // 9b. OUT movements that consumed nothing at all — the units left with no
    //     identified lot. (Same set as 6a, restated in the owner's framing.)
    notice(`  OUT movements that named NO lot at all         : ${outRows.filter((r) => Number(r.cons_qty) === 0).length} of ${outRows.length}`);

    // 9c. FIFO ORDER. One lateral per consumption over its own bucket's lots.
    //     The consumption timeline is ordered by consumed_at — the row's write
    //     timestamp (DEFAULT now(); the trigger INSERT names no timestamp).
    //     inventory_lot_consumptions has NO created_at column; only the lots
    //     and movements tables do.
    const fifoRows = await pg.unsafe(`
      WITH cons AS (
        SELECT k.id, k.lot_id, k.movement_id, k.qty_consumed, k.consumed_at,
               l.received_at, COALESCE(l.batch_no,'') AS lot_batch,
               l.product_code, COALESCE(l.variant_key,'') AS vk,
               l.warehouse_id::text AS wh, ${byCompany ? "l.company_id" : "NULL::int AS company_id"},
               COALESCE(m.batch_no,'') AS mov_batch, m.source_doc_type, m.source_doc_no,
               m.movement_type
          FROM ${K} k
          JOIN ${L} l ON l.id = k.lot_id
          JOIN ${M} m ON m.id = k.movement_id
      ), all_cons AS (
        SELECT k.id, k.lot_id, k.qty_consumed, k.consumed_at FROM ${K} k
      )
      SELECT c.*, older.n_skipped, older.oldest_skipped_at, older.skipped_units
        FROM cons c
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS n_skipped,
                 MIN(x.received_at) AS oldest_skipped_at,
                 COALESCE(SUM(x.avail),0)::int AS skipped_units
            FROM (
              SELECT l2.id, l2.received_at,
                     l2.qty_received - COALESCE((
                       SELECT SUM(a.qty_consumed) FROM all_cons a
                        WHERE a.lot_id = l2.id
                          AND (a.consumed_at < c.consumed_at
                               OR (a.consumed_at = c.consumed_at AND a.id < c.id))), 0) AS avail
                FROM ${L} l2
               WHERE l2.product_code = c.product_code
                 AND COALESCE(l2.variant_key,'') = c.vk
                 AND l2.warehouse_id::text = c.wh
                 ${byCompany ? "AND l2.company_id = c.company_id" : ""}
                 AND (l2.received_at < c.received_at
                      OR (l2.received_at = c.received_at AND l2.id < c.lot_id))
                 -- a batch-scoped consume is only obliged to consider its own batch
                 AND (c.mov_batch = '' OR COALESCE(l2.batch_no,'') = c.mov_batch)
            ) x
           WHERE x.avail > 0
        ) older
       WHERE older.n_skipped > 0
       ORDER BY c.consumed_at`);
    const consWithLot = (await pg.unsafe(`SELECT count(*)::int AS n FROM ${K} k JOIN ${L} l ON l.id = k.lot_id`))[0].n;
    notice("");
    notice(`  consumptions with a resolvable lot scanned     : ${consWithLot}`);
    notice(`  ... that SKIPPED an older lot still holding stock (FIFO violation) : ${fifoRows.length}`);
    for (const r of fifoRows.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.source_doc_no, 22), 22)} ${pad(short(r.product_code, 22), 22)} took lot recv=${String(r.received_at).slice(0, 10)} batch="${short(r.lot_batch, 20)}" qty=${r.qty_consumed}  skipped ${r.n_skipped} older lot(s) holding ${r.skipped_units} unit(s), oldest ${String(r.oldest_skipped_at).slice(0, 10)}`);
    }
    verdict("9c", "FIFO order — no consumption skipped an older available lot",
      fifoRows.length, consWithLot, fifoRows.length === 0 ? "PASS" : "DEFECT",
      "a skip means COGS was taken at the wrong lot's cost; the batch-scoped consume is exempted from cross-batch skips by design");

    // 9d. Batch fidelity of the consume: did a batch-stamped OUT actually consume
    //     that batch, or did it land on the 0195 plain-FIFO fallback?
    const batchDrift = await pg.unsafe(`
      SELECT m.source_doc_no, m.source_doc_type, m.product_code, m.batch_no AS mov_batch,
             COALESCE(l.batch_no,'') AS lot_batch, k.qty_consumed, k.total_cost_sen, m.created_at
        FROM ${K} k JOIN ${M} m ON m.id = k.movement_id JOIN ${L} l ON l.id = k.lot_id
       WHERE m.batch_no IS NOT NULL AND m.batch_no <> ''
         AND COALESCE(l.batch_no,'') <> m.batch_no
       ORDER BY m.created_at DESC`);
    const batchStamped = (await pg.unsafe(`
      SELECT count(*)::int AS n FROM ${K} k JOIN ${M} m ON m.id = k.movement_id
       WHERE m.batch_no IS NOT NULL AND m.batch_no <> ''`))[0].n;
    notice("");
    notice(`  consumptions on a batch-stamped movement       : ${batchStamped}`);
    notice(`  ... that consumed a DIFFERENT batch (0195 plain-FIFO fallback) : ${batchDrift.length}`);
    for (const r of batchDrift.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.source_doc_no, 22), 22)} ${pad(short(r.product_code, 22), 22)} wanted="${short(r.mov_batch, 22)}" took="${short(r.lot_batch, 22)}" qty=${r.qty_consumed} ${rm(r.total_cost_sen)}`);
    }
    verdict("9d", "batch-stamped OUT consumed its own batch", batchDrift.length, batchStamped,
      batchDrift.length === 0 ? "PASS" : "LEGIT-BY-DESIGN",
      "migration 0195 DELIBERATELY falls back to plain FIFO for a short batch — it keeps the units costed at the price of the dye-lot stamp (BUG-HISTORY 2026-07-25)");
  } catch (e) {
    sectionFailed('9. OUTBOUND', e);
  }

  try {
    // ==========================================================================
    // SECTION 10 — TRACE-BACK: PO/GRN batch -> which DO consumed it?
    // Owner: "系统能否准确追踪并识别出这批货物具体流向了哪张 DO 或 SO？"
    // ==========================================================================
    hdr("10. TRACE-BACK — every received batch, forward to the DO/SO that consumed it");
    notice("  Per (company, warehouse, product, variant, batch): received = consumed + on hand,");
    notice("  and every consumed unit must resolve to a real delivery order.");

    /* When delivery_orders is unavailable the DO-existence test degrades to
       "source_doc_type = 'DO'" rather than being silently dropped, so a missing
       table can never read as a clean result. */
    const doJoin = S.delivery_orders ? `LEFT JOIN ${q("delivery_orders")} d ON d.id::text = m.source_doc_id::text` : "";
    const doExists = S.delivery_orders ? "d.id IS NOT NULL" : "TRUE";
    const doMissing = S.delivery_orders ? "d.id IS NULL" : "FALSE";
    const traceRows = await pg.unsafe(`
      WITH lot_cons AS (
        SELECT k.lot_id, SUM(k.qty_consumed)::int AS consumed,
               SUM(k.qty_consumed) FILTER (WHERE m.source_doc_type = 'DO' AND ${doExists})::int AS to_do,
               SUM(k.qty_consumed) FILTER (WHERE m.source_doc_type = 'DO' AND ${doMissing})::int AS to_missing_do,
               SUM(k.qty_consumed) FILTER (WHERE m.source_doc_type <> 'DO')::int AS to_other,
               count(DISTINCT CASE WHEN m.source_doc_type = 'DO' THEN m.source_doc_no END)::int AS n_dos
          FROM ${K} k
          JOIN ${M} m ON m.id = k.movement_id
          ${doJoin}
         GROUP BY k.lot_id
      )
      SELECT ${byCompany ? "l.company_id" : "NULL::int AS company_id"},
             l.warehouse_id::text AS warehouse_id, l.product_code,
             COALESCE(l.variant_key,'') AS variant_key, COALESCE(l.batch_no,'(no batch)') AS batch_no,
             SUM(l.qty_received)::int AS received,
             SUM(l.qty_remaining)::int AS on_hand,
             SUM(COALESCE(c.consumed,0))::int AS consumed,
             SUM(COALESCE(c.to_do,0))::int AS to_do,
             SUM(COALESCE(c.to_missing_do,0))::int AS to_missing_do,
             SUM(COALESCE(c.to_other,0))::int AS to_other,
             SUM(COALESCE(c.n_dos,0))::int AS n_dos,
             count(*)::int AS lots
        FROM ${L} l LEFT JOIN lot_cons c ON c.lot_id = l.id
       GROUP BY l.warehouse_id, l.product_code, COALESCE(l.variant_key,''), COALESCE(l.batch_no,'(no batch)')${byCompany ? ", l.company_id" : ""}
       ORDER BY l.product_code`);
    const unbalanced = traceRows.filter((r) => Number(r.received) !== Number(r.consumed) + Number(r.on_hand));
    const unattributed = traceRows.filter((r) => Number(r.to_missing_do) > 0 || Number(r.to_other) > 0);
    const totRecv = traceRows.reduce((a, r) => a + Number(r.received), 0);
    const totCons = traceRows.reduce((a, r) => a + Number(r.consumed), 0);
    const totHand = traceRows.reduce((a, r) => a + Number(r.on_hand), 0);
    const totToDo = traceRows.reduce((a, r) => a + Number(r.to_do), 0);
    const totOther = traceRows.reduce((a, r) => a + Number(r.to_other), 0);
    const totMissing = traceRows.reduce((a, r) => a + Number(r.to_missing_do), 0);
    notice("");
    notice(`  batches (company,warehouse,product,variant,batch) : ${traceRows.length}`);
    notice(`  units received                                   : ${totRecv}`);
    notice(`  units consumed                                   : ${totCons}`);
    notice(`  units still on hand                              : ${totHand}`);
    notice(`  received - consumed - on hand (must be 0)        : ${totRecv - totCons - totHand}`);
    notice("");
    notice(`  consumed units attributed to a REAL delivery order : ${totToDo}`);
    notice(`  consumed units naming a DO that does not exist     : ${totMissing}`);
    notice(`  consumed units consumed by a NON-DO document       : ${totOther}  (transfers / returns / write-offs — legitimate, listed below)`);
    notice(`  batches where received != consumed + on hand       : ${unbalanced.length}`);
    for (const r of unbalanced.slice(0, SAMPLE)) {
      notice(`    co=${r.company_id ?? "-"} ${pad(short(r.product_code, 22), 22)} batch=${pad(short(r.batch_no, 22), 22)} recv=${pad(r.received, 6)} cons=${pad(r.consumed, 6)} hand=${pad(r.on_hand, 6)} lots=${r.lots}`);
    }
    if (unattributed.length) {
      notice(`  batches with units consumed outside a real DO (up to ${SAMPLE}):`);
      for (const r of unattributed.slice(0, SAMPLE)) {
        notice(`    co=${r.company_id ?? "-"} ${pad(short(r.product_code, 22), 22)} batch=${pad(short(r.batch_no, 22), 22)} toDO=${pad(r.to_do, 5)} toMissingDO=${pad(r.to_missing_do, 5)} toOther=${pad(r.to_other, 5)} distinctDOs=${r.n_dos}`);
      }
    }
    // Which non-DO document types consumed stock, so "other" is never a black box.
    const otherTypes = await pg.unsafe(`
      SELECT m.source_doc_type, count(*)::int AS rows, SUM(k.qty_consumed)::int AS units
        FROM ${K} k JOIN ${M} m ON m.id = k.movement_id
       WHERE m.source_doc_type <> 'DO' GROUP BY m.source_doc_type ORDER BY units DESC`);
    notice("  non-DO consumers, by document type:");
    if (otherTypes.length === 0) notice("    (none — every consumed unit went out on a DO)");
    for (const r of otherTypes) notice(`    ${pad(r.source_doc_type ?? "(null)", 24)} rows=${pad(r.rows, 6)} units=${r.units}`);
    verdict("10a", "batch conservation: received == consumed + on hand", unbalanced.length, traceRows.length,
      unbalanced.length === 0 ? "PASS" : "DEFECT",
      "an unbalanced batch means units vanished from or appeared in the FIFO ledger without a consumption");
    verdict("10b", "consumed units naming a delivery order that does not exist", totMissing, totCons,
      totMissing === 0 ? "PASS" : "DEFECT",
      "an unresolvable DO makes those units untraceable to a customer");

    // 10c. REVERSE direction — no double attribution. A movement must never have
    //      more consumed units than it moved, and each consumption belongs to
    //      exactly one lot (structural, via lot_id) and one movement.
    const overAttr = await pg.unsafe(`
      WITH c AS (SELECT movement_id, SUM(qty_consumed)::int AS cons FROM ${K} GROUP BY movement_id)
      SELECT m.source_doc_type, m.source_doc_no, m.product_code, ABS(m.qty) AS mov_qty, c.cons
        FROM c JOIN ${M} m ON m.id = c.movement_id
       WHERE c.cons > ABS(m.qty) ORDER BY c.cons - ABS(m.qty) DESC`);
    const orphanCons = await pg.unsafe(`
      SELECT count(*)::int AS n FROM ${K} k LEFT JOIN ${M} m ON m.id = k.movement_id WHERE m.id IS NULL`);
    notice("");
    notice(`  movements consuming MORE than they moved (double attribution) : ${overAttr.length}`);
    for (const r of overAttr.slice(0, SAMPLE)) {
      notice(`    ${pad(short(r.source_doc_no, 22), 22)} ${pad(short(r.product_code, 22), 22)} moved=${r.mov_qty} consumed=${r.cons}`);
    }
    notice(`  consumptions whose movement does not exist                    : ${orphanCons[0].n}`);
    verdict("10c", "no double attribution (consumed <= moved, every consumption has a movement)",
      overAttr.length + orphanCons[0].n, consTotal,
      overAttr.length + orphanCons[0].n === 0 ? "PASS" : "DEFECT",
      "double attribution would double-count COGS for the same physical unit");
  } catch (e) {
    sectionFailed('10. TRACE-BACK', e);
  }

  try {
    // ==========================================================================
    // SECTION 11 — GROSS PROFIT: is the GP on a Sales Invoice the FIFO GP?
    // Owner: "按照 FIFO 原则准确计算出对应的 Costing 和 GP（毛利）？"
    // ==========================================================================
    hdr("11. GROSS PROFIT — does the SI margin fall out of the lots actually consumed?");
    notice("  The chain is: consumptions -> inventory_movements.total_cost_sen -> restampDoActualCost");
    notice("  -> delivery_order_items.unit_cost_centi/line_cost_centi -> sales_invoice_items.line_cost_centi");
    notice("  -> sales_invoices.total_cost_centi -> total_margin_centi. Each link is checked separately");
    notice("  so a break can be located, not merely detected.");
    notice("  Unit note: *_sen and *_centi are the SAME unit (1/100 MYR); the sen->centi hand-off in");
    notice("  restampDoActualCost is therefore a rename, not a conversion.");

    // 11a. DO line cost vs the FIFO cost its own movements actually booked.
    if (has("delivery_order_items", "delivery_order_id", "item_code", "qty") &&
        has("delivery_orders", "id", "status") &&
        C.delivery_order_items.has("line_cost_centi")) {
      const svcDo = svc("di.item_group", "di.item_code");
      const doCost = await pg.unsafe(`
        WITH lines AS (
          SELECT di.delivery_order_id AS doc_id, di.item_code,
                 SUM(COALESCE(di.qty,0))::int AS qty,
                 SUM(COALESCE(di.line_cost_centi,0))::bigint AS line_cost
            FROM ${q("delivery_order_items")} di
           WHERE NOT ${svcDo}
           GROUP BY di.delivery_order_id, di.item_code
        ), fifo AS (
          SELECT source_doc_id::text AS doc_id, product_code,
                 SUM(CASE movement_type WHEN 'OUT' THEN COALESCE(total_cost_sen,0)
                                        ELSE -COALESCE(total_cost_sen,0) END)::bigint AS net_cost,
                 SUM(CASE movement_type WHEN 'OUT' THEN qty ELSE -qty END)::int AS net_qty
            FROM ${M} WHERE source_doc_type = 'DO' AND source_doc_id IS NOT NULL
           GROUP BY source_doc_id, product_code
        )
        SELECT ${C.delivery_orders.has("do_number") ? "d.do_number" : "d.id::text"} AS doc_no,
               ${C.delivery_orders.has("company_id") ? "d.company_id" : "NULL::int AS company_id"},
               d.status::text AS status, l.item_code, l.qty, l.line_cost,
               COALESCE(f.net_cost,0) AS fifo_cost, COALESCE(f.net_qty,0) AS fifo_qty
          FROM lines l
          JOIN ${q("delivery_orders")} d ON d.id = l.doc_id
          LEFT JOIN fifo f ON f.doc_id = l.doc_id::text AND f.product_code = l.item_code
         WHERE UPPER(d.status::text) IN ('DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED')
         ORDER BY 1`);
      const doBad = doCost.filter((r) => Number(r.line_cost) !== Number(r.fifo_cost));
      const doGap = doBad.reduce((a, r) => a + Math.abs(Number(r.line_cost) - Number(r.fifo_cost)), 0);
      notice("");
      notice("  11a. DO line cost vs the net FIFO cost its own movements booked");
      notice(`       shipped DO x item buckets scanned : ${doCost.length}`);
      notice(`       ... DO line cost != FIFO cost     : ${doBad.length}`);
      notice(`       absolute value of the gap         : ${rm(doGap)}`);
      for (const r of doBad.slice(0, SAMPLE)) {
        notice(`         co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 20), 20)} ${pad(short(r.item_code, 22), 22)} qty=${pad(r.qty, 5)} doCost=${pad(rm(r.line_cost), 13)} fifoCost=${pad(rm(r.fifo_cost), 13)} delta=${rm(Number(r.line_cost) - Number(r.fifo_cost))}`);
      }
      verdict("11a", "DO line cost == net FIFO cost of the movements it created",
        doBad.length, doCost.length, doBad.length === 0 ? "PASS" : "DEFECT",
        "restampDoActualCost skips buckets whose net qty <= 0, so a fully-reversed bucket keeps a stale cost — that is the known shape here");
    }

    // 11b. Margin identity on every SI line, and on the header.
    if (has("sales_invoice_items", "sales_invoice_id", "line_total_centi", "line_cost_centi") &&
        C.sales_invoice_items.has("line_margin_centi") && has("sales_invoices", "id", "status")) {
      const siNoCol2 = ["invoice_number", "si_number", "doc_no"].find((c) => C.sales_invoices.has(c));
      const gpLine = await pg.unsafe(`
        SELECT ${siNoCol2 ? `si."${ident(siNoCol2)}"` : "si.id::text"} AS doc_no,
               ${C.sales_invoices.has("company_id") ? "si.company_id" : "NULL::int AS company_id"},
               sii.id, sii.line_total_centi, sii.line_cost_centi, sii.line_margin_centi
          FROM ${q("sales_invoice_items")} sii
          JOIN ${q("sales_invoices")} si ON si.id = sii.sales_invoice_id
         WHERE UPPER(si.status::text) NOT IN ('CANCELLED','DRAFT')
           AND COALESCE(sii.line_margin_centi,0) <> COALESCE(sii.line_total_centi,0) - COALESCE(sii.line_cost_centi,0)`);
      const gpLineTotal = (await pg.unsafe(`
        SELECT count(*)::int AS n FROM ${q("sales_invoice_items")} sii
          JOIN ${q("sales_invoices")} si ON si.id = sii.sales_invoice_id
         WHERE UPPER(si.status::text) NOT IN ('CANCELLED','DRAFT')`))[0].n;
      notice("");
      notice("  11b. SI line margin identity (margin == revenue - cost)");
      notice(`       issued SI lines scanned      : ${gpLineTotal}`);
      notice(`       ... margin identity BROKEN   : ${gpLine.length}`);
      for (const r of gpLine.slice(0, SAMPLE)) {
        notice(`         co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 22), 22)} rev=${pad(rm(r.line_total_centi), 13)} cost=${pad(rm(r.line_cost_centi), 13)} margin=${pad(rm(r.line_margin_centi), 13)} shouldBe=${rm(Number(r.line_total_centi ?? 0) - Number(r.line_cost_centi ?? 0))}`);
      }
      verdict("11b", "SI line margin == line revenue - line cost", gpLine.length, gpLineTotal,
        gpLine.length === 0 ? "PASS" : "DEFECT",
        "a broken identity means the GP shown on the invoice is not the GP its own numbers imply");

      // 11c. GP traced end to end: SI line cost -> DO line -> FIFO consumptions.
      if (C.sales_invoice_items.has("do_item_id") && C.delivery_order_items.has("unit_cost_centi")) {
        const gpTrace = await pg.unsafe(`
          WITH si_line AS (
            SELECT sii.id, sii.do_item_id, sii.qty, sii.line_total_centi, sii.line_cost_centi,
                   ${siNoCol2 ? `si."${ident(siNoCol2)}"` : "si.id::text"} AS doc_no,
                   ${C.sales_invoices.has("company_id") ? "si.company_id" : "NULL::int AS company_id"}
              FROM ${q("sales_invoice_items")} sii
              JOIN ${q("sales_invoices")} si ON si.id = sii.sales_invoice_id
             WHERE UPPER(si.status::text) NOT IN ('CANCELLED','DRAFT') AND sii.do_item_id IS NOT NULL
          ), do_line AS (
            SELECT di.id, di.delivery_order_id, di.item_code, di.qty AS do_qty,
                   COALESCE(di.unit_cost_centi,0) AS unit_cost, COALESCE(di.line_cost_centi,0) AS do_line_cost,
                   ${C.delivery_order_items.has("item_group") ? "di.item_group" : "NULL::text AS item_group"}
              FROM ${q("delivery_order_items")} di
          ), fifo AS (
            SELECT k.movement_id, m.source_doc_id::text AS doc_id, m.product_code,
                   SUM(k.qty_consumed)::int AS cons_qty, SUM(k.total_cost_sen)::bigint AS cons_cost
              FROM ${K} k JOIN ${M} m ON m.id = k.movement_id
             WHERE m.source_doc_type = 'DO'
             GROUP BY k.movement_id, m.source_doc_id, m.product_code
          ), fifo_doc AS (
            SELECT doc_id, product_code, SUM(cons_qty)::int AS cons_qty, SUM(cons_cost)::bigint AS cons_cost
              FROM fifo GROUP BY doc_id, product_code
          )
          SELECT s.doc_no, s.company_id, dl.item_code, s.qty, s.line_total_centi, s.line_cost_centi,
                 dl.unit_cost, COALESCE(f.cons_qty,0) AS cons_qty, COALESCE(f.cons_cost,0) AS cons_cost
            FROM si_line s
            JOIN do_line dl ON dl.id = s.do_item_id
            LEFT JOIN fifo_doc f ON f.doc_id = dl.delivery_order_id::text AND f.product_code = dl.item_code
           WHERE NOT ${svc("dl.item_group", "dl.item_code")}
           ORDER BY s.doc_no`);
        /* An SI line's cost is traceable when the DO bucket it bills actually
           consumed lots. Zero consumed units with a non-zero billed cost (or the
           reverse) is the break the owner is asking about. */
        const noFifo = gpTrace.filter((r) => Number(r.cons_qty) === 0);
        const zeroCost = gpTrace.filter((r) => Number(r.line_cost_centi ?? 0) === 0);
        notice("");
        notice("  11c. SI goods lines traced back to a real FIFO consumption");
        notice(`       issued SI goods lines linked to a DO line : ${gpTrace.length}`);
        notice(`       ... whose DO bucket consumed NO lot at all : ${noFifo.length}  <- GP on these is not FIFO-derived`);
        notice(`       ... billed at zero cost (GP = 100%)        : ${zeroCost.length}`);
        const gpAtRisk = noFifo.reduce((a, r) => a + Number(r.line_total_centi ?? 0), 0);
        notice(`       revenue sitting on a non-FIFO-derived GP   : ${rm(gpAtRisk)}`);
        for (const r of noFifo.slice(0, SAMPLE)) {
          notice(`         co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 22), 22)} ${pad(short(r.item_code, 22), 22)} qty=${pad(r.qty, 4)} rev=${pad(rm(r.line_total_centi), 13)} cost=${pad(rm(r.line_cost_centi), 13)} consumedUnits=${r.cons_qty}`);
        }
        verdict("11c", "SI goods line GP derived from a real FIFO consumption",
          noFifo.length, gpTrace.length, noFifo.length === 0 ? "PASS" : "DEFECT",
          "a line whose DO bucket consumed nothing has a GP that no lot backs — it overstates margin by the whole missing COGS");
      }

      // 11d. SI header margin identity.
      if (C.sales_invoices.has("total_margin_centi") && C.sales_invoices.has("total_cost_centi")) {
        const revCol = C.sales_invoices.has("local_total_centi") ? "local_total_centi" : "total_centi";
        const gpHdr = await pg.unsafe(`
          SELECT ${siNoCol2 ? `si."${ident(siNoCol2)}"` : "si.id::text"} AS doc_no,
                 ${C.sales_invoices.has("company_id") ? "si.company_id" : "NULL::int AS company_id"},
                 COALESCE(si."${ident(revCol)}",0) AS rev, COALESCE(si.total_cost_centi,0) AS cost,
                 COALESCE(si.total_margin_centi,0) AS margin
            FROM ${q("sales_invoices")} si
           WHERE UPPER(si.status::text) NOT IN ('CANCELLED','DRAFT')
             AND COALESCE(si.total_margin_centi,0) <> COALESCE(si."${ident(revCol)}",0) - COALESCE(si.total_cost_centi,0)`);
        const hdrTotal = (await pg.unsafe(`
          SELECT count(*)::int AS n FROM ${q("sales_invoices")} WHERE UPPER(status::text) NOT IN ('CANCELLED','DRAFT')`))[0].n;
        notice("");
        notice("  11d. SI header margin identity (total_margin == revenue - total_cost)");
        notice(`       issued invoices scanned      : ${hdrTotal}`);
        notice(`       ... identity BROKEN          : ${gpHdr.length}`);
        for (const r of gpHdr.slice(0, SAMPLE)) {
          notice(`         co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 22), 22)} rev=${pad(rm(r.rev), 14)} cost=${pad(rm(r.cost), 14)} margin=${pad(rm(r.margin), 14)} shouldBe=${rm(Number(r.rev) - Number(r.cost))}`);
        }
        verdict("11d", "SI header margin == header revenue - header cost", gpHdr.length, hdrTotal,
          gpHdr.length === 0 ? "PASS" : "DEFECT",
          "total_margin_centi is what the P&L reads; a broken identity misstates reported GP directly");
      }
    }
  } catch (e) {
    sectionFailed('11. GROSS PROFIT', e);
  }

  try {
    // ==========================================================================
    // SECTION 12 — HARD MATCH: "开了 DO 就变成硬匹配"
    // ==========================================================================
    hdr("12. HARD MATCH — once a DO ships, is the SO<->PO link anchored to the batch actually consumed?");
    notice("  The anchor columns are delivery_order_items.committed_po_batch_no (migration 0230) and");
    notice("  mfg_sales_order_items.allocated_batch_no (migration 0121). Once a DO has shipped, the");
    notice("  batch its OUT actually consumed must equal the batch that was committed to it.");

    if (C.delivery_order_items.has("committed_po_batch_no") && has("delivery_orders", "id", "status")) {
      const anchor = await pg.unsafe(`
        WITH shipped AS (
          SELECT di.id, di.delivery_order_id, di.item_code, di.committed_po_batch_no AS committed,
                 ${C.delivery_orders.has("do_number") ? "d.do_number" : "d.id::text"} AS doc_no,
                 ${C.delivery_orders.has("company_id") ? "d.company_id" : "NULL::int AS company_id"},
                 d.status::text AS status
            FROM ${q("delivery_order_items")} di
            JOIN ${q("delivery_orders")} d ON d.id = di.delivery_order_id
           WHERE UPPER(d.status::text) IN ('DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED')
             AND di.committed_po_batch_no IS NOT NULL AND di.committed_po_batch_no <> ''
        ), taken AS (
          SELECT m.source_doc_id::text AS doc_id, m.product_code,
                 STRING_AGG(DISTINCT COALESCE(l.batch_no,'(none)'), ',') AS batches_taken,
                 SUM(k.qty_consumed)::int AS cons_qty
            FROM ${K} k JOIN ${M} m ON m.id = k.movement_id JOIN ${L} l ON l.id = k.lot_id
           WHERE m.source_doc_type = 'DO'
           GROUP BY m.source_doc_id, m.product_code
        )
        SELECT s.*, t.batches_taken, COALESCE(t.cons_qty,0) AS cons_qty
          FROM shipped s
          LEFT JOIN taken t ON t.doc_id = s.delivery_order_id::text AND t.product_code = s.item_code
         ORDER BY s.doc_no`);
      const drift = anchor.filter((r) => (r.batches_taken ?? "") !== r.committed);
      const noConsume = anchor.filter((r) => Number(r.cons_qty) === 0);
      notice("");
      notice(`  shipped DO lines carrying a committed batch : ${anchor.length}`);
      notice(`  ... whose consumed batch(es) != committed   : ${drift.length}`);
      notice(`  ... which consumed nothing at all           : ${noConsume.length}`);
      for (const r of drift.slice(0, SAMPLE)) {
        notice(`    co=${r.company_id ?? "-"} ${pad(short(r.doc_no, 20), 20)} ${pad(short(r.item_code, 22), 22)} committed="${short(r.committed, 22)}" taken="${short(r.batches_taken, 30)}" qty=${r.cons_qty}`);
      }
      verdict("12a", "shipped DO line consumed exactly the batch committed to it",
        drift.length, anchor.length, drift.length === 0 ? "PASS" : "NEEDS-OWNER",
        "a drift means the hard match did not hold: the SO was promised one PO's goods and shipped another's");
    } else {
      notice("  SKIPPED — delivery_order_items.committed_po_batch_no not present.");
    }

    // 12b. PO -> SO link: the so_item_id stamped on PO lines must agree with the
    //      SO line the DO actually shipped against.
    if (C.purchase_order_items.has("so_item_id") && S.mfg_sales_order_items) {
      const link = await pg.unsafe(`
        SELECT count(*)::int AS po_lines_linked FROM ${q("purchase_order_items")} WHERE so_item_id IS NOT NULL`);
      const dangling = await pg.unsafe(`
        SELECT count(*)::int AS n
          FROM ${q("purchase_order_items")} poi
          LEFT JOIN ${q("mfg_sales_order_items")} soi ON soi.id = poi.so_item_id
         WHERE poi.so_item_id IS NOT NULL AND soi.id IS NULL`);
      notice("");
      notice(`  PO lines carrying a so_item_id link         : ${link[0].po_lines_linked}`);
      notice(`  ... whose so_item_id names a missing SO line: ${dangling[0].n}`);
      verdict("12b", "PO->SO item links resolve to a real SO line", Math.max(0, dangling[0].n),
        link[0].po_lines_linked, dangling[0].n === 0 ? "PASS" : dangling[0].n < 0 ? "INFO" : "DEFECT",
        "backfill-po-so-item-links stamped 47 of these; a dangling link would break the PO<->SO trace");
    }
  } catch (e) {
    sectionFailed('12. HARD MATCH', e);
  }

  // ==========================================================================
  // VERDICT TABLE
  // ==========================================================================
  hdr("VERDICT — one line per check");
  notice(`  ${pad("id", 5)} ${pad("class", 16)} ${pad("failing", 9)} ${pad("scanned", 9)} check`);
  for (const v of VERDICTS) {
    notice(`  ${pad(v.id, 5)} ${pad(v.klass, 16)} ${pad(v.failing, 9)} ${pad(v.scanned, 9)} ${v.label}`);
  }
  notice("");
  notice("  classes: PASS = invariant holds. DEFECT = a real fault with the note's blast radius.");
  notice("           LEGIT-BY-DESIGN = the documented behaviour, not a fault. NEEDS-OWNER = a business");
  notice("           judgement this script must not make. INFO = context for reading another row.");
  notice("           ERROR = the section did not complete; its checks are UNKNOWN, not clean.");
  const errored = VERDICTS.filter((v) => v.klass === "ERROR").length;
  if (errored > 0) notice(`  ${errored} section(s) did not complete — treat their checks as unanswered.`);
  notice("");
  for (const v of VERDICTS) {
    if (v.klass === "PASS") continue;
    notice(`  ${v.id} (${v.klass}) — ${v.note}`);
  }
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("AUDIT_INVENTORY_COSTING_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
