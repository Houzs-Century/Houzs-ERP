#!/usr/bin/env node
// ----------------------------------------------------------------------------
// HISTORICAL DATA REPAIR for the movement-vs-FIFO ledger divergence.
//
// The go-forward engine fix (migration 0195 — the OUT-branch batch→plain-FIFO
// fallback) stops NEW OUTs from diverging. It does NOT touch the rows that
// ALREADY diverged. This script repairs those: for EVERY (warehouse, product,
// variant[, company]) bucket where the two ledgers disagree, it retro-costs the
// uncosted OUTs and decrements the covering open lots so that, afterward:
//     Σ(inventory_movements, signed)  ==  Σ(inventory_lots.qty_remaining)
//     Σ(OUT qty)                      ==  Σ(inventory_lot_consumptions.qty_consumed)
//
// HOW — it REUSES the audited, idempotent DB function scm.fn_reconcile_uncosted_out
// (migration 0154), the SAME mechanism the GRN receipt path already uses to catch
// up oversold shorts. Per bucket it consumes each prior uncosted DO OUT's
// outstanding shortfall from that bucket's CURRENT open lots (plain FIFO, real
// lot cost), booking inventory_lot_consumptions + decrementing inventory_lots +
// restamping the OUT COGS. Nothing here re-implements FIFO — it drives the tested
// function across the full divergent set the detector (check-inventory-integrity
// .mjs) reports.
//
// ── SAFETY — this WRITES to the money-critical FIFO ledger ────────────────────
//   * DRY-RUN BY DEFAULT. With no APPLY flag it runs every bucket's reconcile
//     INSIDE a transaction and ROLLS BACK — measuring the EXACT before/after
//     effect (qty retro-costed, RM booked, lots decremented, drift closed) while
//     writing NOTHING. Set APPLY=true to COMMIT. Even then this is STAGING-FIRST.
//   * IDEMPOTENT. fn_reconcile_uncosted_out recomputes each OUT's shortfall from
//     the ledger every run (ABS(qty) − Σ already-consumed), so a bucket reconciled
//     once books 0 on re-run — running APPLY twice is a no-op the second time.
//   * PER-BUCKET TRANSACTION. Each bucket commits (or rolls back) on its own, so a
//     failure on one SKU can never leave another half-repaired. Buckets are
//     independent (the function only touches its own warehouse+product+variant).
//   * MANUAL ONLY, own concurrency group — see .github/workflows/backfill-fifo-
//     divergence.yml. Never scheduled, never auto-run.
//   * AUDITABLE. Every bucket's change set is printed. The consumptions it books
//     carry the OUT's own source_doc_* so the repair is traceable to the DO.
//
// ── NOT in scope (by design) ──────────────────────────────────────────────────
//   * Non-DO uncosted OUTs (PURCHASE_RETURN / STOCK_TRANSFER / consignment) and
//     drop-ship / CANCELLED DO OUTs are OUTSIDE fn_reconcile_uncosted_out's guards
//     — this script REPORTS them as "not auto-repairable (owner review)" and
//     changes nothing for them.
//   * A bucket whose shortfall exceeds its CURRENT open lots is partially repaired
//     (as much as stock covers) and the residual is reported — it catches up on
//     the next receipt via the existing path, or via a re-run after restocking.
//
// ── MODES (2026-08-01, ledger-perfection W3/W4) ──────────────────────────────
// The audit + detector split the remaining divergence into three classes, and
// each class gets its own explicit mode — never one blanket pass:
//
//   MODE=retro-cost (default — the original behaviour, unchanged). Drives
//     scm.fn_reconcile_uncosted_out over every uncosted-OUT bucket; consumes
//     REAL open lots at REAL cost. Never fabricates a cost.
//
//   MODE=relabel (W4). The 2990-import variant-key split: a movement's
//     variant_key disagrees with the lot its OWN consumptions (or its own
//     opened lot, via inventory_lots.movement_id) point at, so per-bucket sums
//     drift in equal-and-opposite pairs (audit sections 1 + 2b — the XAMMAR
//     family) while every cost is already right. The repair relabels the
//     MOVEMENT (and its consumption rows — the FIFO trigger's own invariant is
//     that the three agree) to the lot's key. The lot side is never touched,
//     no cost column is written, RM impact is ZERO by construction. Evidence
//     per movement is its own ledger trail, decided by classifyMovementRelabel
//     (lib/ledger-repair-core.mjs); movements whose lots disagree among
//     themselves, or that touch no lot, are reported and refused.
//
//   MODE=basis-cost (W3). OUTs that shipped when NOTHING was on hand and no
//     later receipt ever retro-costed them: fn_reconcile_uncosted_out is
//     correct to book nothing (it never fabricates), so their COGS is RM0
//     forever unless a REFERENCE cost is seeded. Owner-directed, for NAMED DOs
//     only (DOS env, required): per short bucket it seeds a compensating lot at
//     the basis cost — the most recent same-(product, variant) GRN landed unit
//     cost in the same company, else the product's latest PO line cost
//     (pickCostBasis) — then drives THE SAME fn_reconcile_uncosted_out over
//     the bucket, which consumes the seeded lot and restamps the OUT exactly
//     as a real receipt would (the 0154 mechanism, not a third one). Refused
//     whenever the ledger offers something truer: open lots exist (use
//     retro-cost), an older competing uncosted OUT would claim the lot first,
//     or the seeded lot is not FULLY consumed by the named targets (verified
//     in-transaction; anything else rolls back). The movement-vs-lot QUANTITY
//     drift of these buckets is NOT closed here and is reported honestly: the
//     units really did ship without a receipt under that key.
//
//   MODE=doc-relabel (2026-08-01, document-evidence round — owner: "为什么你
//     不看 SO PO DO GR 去解决呢？"). The residual buckets the ledger-evidence
//     modes REFUSED (relabel: no-lot-evidence; reconstruct: over-consumed) are
//     resolved from the DOCUMENT chain instead: an OUT names its DO -> the DO
//     line carries variants + so_item_id -> the SO line corroborates; an IN /
//     lot names its GRN -> the GRN line carries variants + purchase_order_item
//     -> the PO line corroborates. Each side's TRUE variant key is computed
//     from the document variants (variantKeyMirror === computeVariantKey,
//     lockstep-tested) and rows are relabelled to the key their OWN paperwork
//     proves (planDocKeyAlignment, lib/doc-evidence-core.mjs) — with the
//     citation (doc no + line + variants JSON -> key) printed per row. The
//     audit-2a over-consumed lots are corrected per document too
//     (planOverConsumedCorrection): the DO's net documented qty must back
//     every shipped unit, and the excess consumption re-points to the sibling
//     receipt the documents prove holds the same goods (donor decremented,
//     0154 cost convention kept, RM delta reported). ONLY rows whose
//     documents themselves disagree, or that shipped goods no family receipt
//     ever covered, land on the final STOCKTAKE list — printed with evidence.
//     Family conservation is verified in-transaction; dry-run rolls back.
//
// Env: DATABASE_URL (or .dev.vars). APPLY=true to commit (default dry-run).
//      MODE=retro-cost | relabel | basis-cost | reconstruct | doc-relabel   (default retro-cost)
//      BEFORE_TS=<ISO> optional cutoff (default: now) — only OUTs created before it
//      are eligible, mirroring the function's temporal guard (retro-cost mode).
//      DOS=<comma-separated DO numbers> — basis-cost mode only, REQUIRED there.
// Mirrors the read-only shape of check-inventory-integrity.mjs; this one WRITES
// only under APPLY=true.
// ----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  classifyMovementRelabel,
  projectRelabelledDrift,
  pickCostBasis,
  planFamilyReconstruction,
  classifyLotConservation,
  planSurplusCorrection,
} from "./lib/ledger-repair-core.mjs";
import {
  resolveDocLineKey,
  planDocKeyAlignment,
  planOverConsumedCorrection,
  normalizeVariantKeyQuotes,
  isRepairSeeded,
} from "./lib/doc-evidence-core.mjs";
import { companyPrefix } from "./lib/doc-ref-repair-core.mjs";

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

const APPLY = /^(1|true|yes)$/i.test(process.env.APPLY ?? "");
const BEFORE_TS = process.env.BEFORE_TS || new Date().toISOString();
const MODE = (process.env.MODE || "retro-cost").trim().toLowerCase();
const DOS = (process.env.DOS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!["retro-cost", "relabel", "basis-cost", "reconstruct", "doc-relabel"].includes(MODE)) {
  console.error(`MODE must be retro-cost | relabel | basis-cost | reconstruct | doc-relabel (got "${MODE}")`);
  process.exit(2);
}
if (MODE === "basis-cost" && DOS.length === 0) {
  console.error("MODE=basis-cost requires DOS=<comma-separated DO numbers> — this mode seeds a REFERENCE cost and must never run open-ended.");
  process.exit(2);
}

const notice = (m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

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
  notice("=== FIFO LEDGER DIVERGENCE — HISTORICAL BACKFILL / REPAIR ===");
  notice(`mode: ${APPLY ? "APPLY (writes COMMITTED)" : "DRY-RUN (every change ROLLED BACK — nothing written)"}`);
  notice(`eligibility cutoff (BEFORE_TS): ${BEFORE_TS}  (only OUTs created before this are repaired)`);
  if (APPLY) warn("APPLY=true — this WILL write to the money-critical FIFO ledger. This must be run STAGING-FIRST, with owner sign-off, after reviewing a DRY-RUN.");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  const lotSchema = await schemaOf("inventory_lots");
  const consSchema = await schemaOf("inventory_lot_consumptions");
  if (!movSchema || !lotSchema || !consSchema) {
    notice("FATAL — inventory_movements / inventory_lots / inventory_lot_consumptions not found in scm or public. Cannot run.");
    return;
  }
  // The repair function must exist (migration 0154). Without it there is nothing
  // to drive — stop rather than guess.
  const fnRows = await pg`
    SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'fn_reconcile_uncosted_out' AND n.nspname IN ('scm','public')
     ORDER BY CASE n.nspname WHEN 'scm' THEN 0 ELSE 1 END LIMIT 1`;
  if (fnRows.length === 0) {
    notice("FATAL — scm.fn_reconcile_uncosted_out (migration 0154) is not present. Apply 0154 first; this script only drives it.");
    return;
  }
  const fnSchema = ident(fnRows[0].nspname);

  const movCols = await colsOf(movSchema, "inventory_movements");
  const lotCols = await colsOf(lotSchema, "inventory_lots");
  const byCompany = movCols.has("company_id") && lotCols.has("company_id");
  notice(`schemas: movements=${movSchema} lots=${lotSchema} consumptions=${consSchema}  |  company-scoped: ${byCompany ? "YES" : "NO"}`);
  notice("");

  const M = `"${ident(movSchema)}"."inventory_movements"`;
  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;
  const coSel = byCompany ? "company_id" : "NULL::int AS company_id";
  const coGrp = byCompany ? ", company_id" : "";

  // ── Candidate buckets: every bucket whose Σ(OUT qty) ≠ Σ(consumed qty).
  //    This is the repairable lens — the uncosted-OUT set the detector reports.
  const buckets = await pg.unsafe(`
    WITH out_mov AS (
      SELECT ${coSel},
             m.warehouse_id::text AS warehouse_id,
             m.product_code,
             COALESCE(m.variant_key,'') AS variant_key,
             MAX(m.product_name) AS product_name,
             SUM(m.qty) AS out_qty,
             SUM(COALESCE(c.costed_qty,0)) AS costed_qty
        FROM ${M} m
        LEFT JOIN (
          SELECT movement_id, SUM(qty_consumed) AS costed_qty
            FROM ${C} GROUP BY movement_id
        ) c ON c.movement_id = m.id
       WHERE m.movement_type = 'OUT'
       GROUP BY m.warehouse_id, m.product_code, COALESCE(m.variant_key,'')${byCompany ? ", m.company_id" : ""}
    )
    SELECT company_id, warehouse_id, product_code, variant_key,
           COALESCE(product_name,'') AS product_name,
           out_qty, costed_qty, (out_qty - costed_qty) AS uncosted_qty
      FROM out_mov
     WHERE out_qty <> costed_qty
     ORDER BY (out_qty - costed_qty) DESC, product_code ASC`);

  notice(`buckets with uncosted OUT units (Σ OUT qty ≠ Σ consumed): ${buckets.length}`);
  notice("");
  if (buckets.length === 0) {
    notice("Nothing to repair — every OUT is fully backed by lot consumptions. (Ledgers already reconcile.)");
    notice("=== END ===");
    return;
  }

  // Per-bucket measurement of the two invariants, used before + after the repair.
  //   mov_qty  = signed movement sum (byte-identical to scm.inventory_balances)
  //   lot_qty  = Σ inventory_lots.qty_remaining
  //   out_qty / consumed_qty = the uncosted-OUT lens
  //   out_cost = Σ OUT total_cost_sen (RM booked against OUTs)
  const measureSql = `
    WITH b AS (SELECT $1::text AS wh, $2::text AS pc, $3::text AS vk${byCompany ? ", $4::int AS co" : ""})
    SELECT
      (SELECT COALESCE(SUM(CASE movement_type
                 WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                 WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END),0)
         FROM ${M}, b
        WHERE warehouse_id::text = b.wh AND product_code = b.pc
          AND COALESCE(variant_key,'') = b.vk${byCompany ? " AND company_id = b.co" : ""}) AS mov_qty,
      (SELECT COALESCE(SUM(qty_remaining),0) FROM ${L}, b
        WHERE warehouse_id::text = b.wh AND product_code = b.pc
          AND COALESCE(variant_key,'') = b.vk${byCompany ? " AND company_id = b.co" : ""}) AS lot_qty,
      (SELECT COALESCE(SUM(qty),0) FROM ${M}, b
        WHERE movement_type = 'OUT' AND warehouse_id::text = b.wh AND product_code = b.pc
          AND COALESCE(variant_key,'') = b.vk${byCompany ? " AND company_id = b.co" : ""}) AS out_qty,
      (SELECT COALESCE(SUM(total_cost_sen),0) FROM ${M}, b
        WHERE movement_type = 'OUT' AND warehouse_id::text = b.wh AND product_code = b.pc
          AND COALESCE(variant_key,'') = b.vk${byCompany ? " AND company_id = b.co" : ""}) AS out_cost,
      (SELECT COALESCE(SUM(c.qty_consumed),0)
         FROM ${C} c JOIN ${M} m ON m.id = c.movement_id, b
        WHERE m.movement_type = 'OUT' AND m.warehouse_id::text = b.wh AND m.product_code = b.pc
          AND COALESCE(m.variant_key,'') = b.vk${byCompany ? " AND m.company_id = b.co" : ""}) AS consumed_qty`;

  const params = (b) => (byCompany ? [b.warehouse_id, b.product_code, b.variant_key, b.company_id] : [b.warehouse_id, b.product_code, b.variant_key]);
  const measure = async (sql, b) => (await sql.unsafe(measureSql, params(b)))[0];

  notice("================ PER-BUCKET REPAIR PLAN ================");
  notice(`  ${pad("product", 22)} ${pad("variant", 10)} ${pad("co", 3)} ${pad("reconc", 7)} ${pad("RM booked", 12)} ${pad("lots-", 7)} ${pad("drift→", 12)} ${pad("uncost→", 12)} warehouse`);

  let totRepaired = 0, totCostBooked = 0, totBucketsFullyFixed = 0, totResidual = 0;
  const notRepairable = [];

  for (const b of buckets) {
    // Each bucket in its OWN transaction — commit under APPLY, rollback for dry-run.
    // A failure here rolls back ONLY this bucket (the others are untouched).
    try {
      const row = await pg.begin(async (sql) => {
        const before = await measure(sql, b);
        const rec = await sql.unsafe(
          `SELECT "${fnSchema}".fn_reconcile_uncosted_out($1::uuid, $2::text, $3::text, $4::timestamptz, NULL::uuid) AS n`,
          [b.warehouse_id, b.product_code, b.variant_key, BEFORE_TS],
        );
        const reconciled = Number(rec[0]?.n ?? 0);
        const after = await measure(sql, b);
        if (!APPLY) {
          // DRY-RUN: undo everything the function just did. Nothing persists.
          throw { __rollback: true, before, after, reconciled };
        }
        return { before, after, reconciled };
      });
      recordAndPrint(b, row.before, row.after, row.reconciled);
    } catch (e) {
      if (e && e.__rollback) {
        recordAndPrint(b, e.before, e.after, e.reconciled);
      } else {
        warn(`bucket ${short(b.product_code, 22)}/${short(b.variant_key, 10)} FAILED (rolled back, others unaffected): ${e?.message ?? e}`);
      }
    }
  }

  function recordAndPrint(b, before, after, reconciled) {
    const costBooked = Number(after.out_cost) - Number(before.out_cost);
    const lotsDown = Number(before.lot_qty) - Number(after.lot_qty);
    const driftBefore = Number(before.mov_qty) - Number(before.lot_qty);
    const driftAfter = Number(after.mov_qty) - Number(after.lot_qty);
    const uncostBefore = Number(before.out_qty) - Number(before.consumed_qty);
    const uncostAfter = Number(after.out_qty) - Number(after.consumed_qty);
    totRepaired += reconciled;
    totCostBooked += costBooked;
    if (uncostAfter === 0 && driftAfter === 0) totBucketsFullyFixed += 1;
    if (uncostAfter > 0) { totResidual += uncostAfter; }
    if (reconciled === 0) {
      // fn_reconcile_uncosted_out declined the whole bucket — the uncosted OUTs
      // are outside its guards (non-DO / drop-ship / CANCELLED) or no open lot
      // covers them. Report for owner review; nothing was (or would be) changed.
      notRepairable.push({ b, uncostBefore, driftBefore });
    }
    notice(`  ${pad(short(b.product_code, 22), 22)} ${pad(short(b.variant_key, 10), 10)} ${pad(b.company_id ?? "-", 3)} ${pad(reconciled, 7)} ${pad(rm(costBooked), 12)} ${pad(lotsDown, 7)} ${pad(`${driftBefore}→${driftAfter}`, 12)} ${pad(`${uncostBefore}→${uncostAfter}`, 12)} ${short(b.warehouse_id, 30)}`);
  }

  notice("");
  notice("================ SUMMARY ================");
  notice(`  buckets scanned                         : ${buckets.length}`);
  notice(`  units retro-costed (reconciled)         : ${totRepaired}`);
  notice(`  RM booked onto previously-uncosted OUTs : ${rm(totCostBooked)}`);
  notice(`  buckets fully reconciled after repair   : ${totBucketsFullyFixed}`);
  notice(`  residual uncosted units (need restock / later receipt): ${totResidual}`);
  notice("");
  if (notRepairable.length) {
    notice(`  NOT auto-repairable by fn_reconcile_uncosted_out (0154 guards: DO-only, non-drop-ship, non-cancelled, needs open lots) — OWNER REVIEW: ${notRepairable.length}`);
    for (const nr of notRepairable.slice(0, 30)) {
      notice(`    ${pad(short(nr.b.product_code, 22), 22)} ${pad(short(nr.b.variant_key, 10), 10)} co=${nr.b.company_id ?? "-"} uncosted=${nr.uncostBefore} drift=${nr.driftBefore} wh=${short(nr.b.warehouse_id, 30)}`);
    }
    if (notRepairable.length > 30) notice(`    ... and ${notRepairable.length - 30} more.`);
    notice("");
  }
  notice(APPLY
    ? "APPLIED — the above changes were COMMITTED. Re-run the detector (check-inventory-integrity.mjs) to confirm the ledgers now reconcile."
    : "DRY-RUN — nothing was written. Review the plan above, then run STAGING-FIRST with APPLY=true, verify, and only then prod (owner go).");
  notice("=== END ===");
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE=relabel (W4) — unify the 2990-import variant-key split, labels only.
// ─────────────────────────────────────────────────────────────────────────────
async function runRelabel() {
  notice("=== FIFO LEDGER DIVERGENCE — VARIANT-KEY RELABEL (W4: import key split) ===");
  notice(`mode: ${APPLY ? "APPLY (writes COMMITTED)" : "DRY-RUN (plan only — nothing written)"}`);
  notice("Rule: a movement in a DRIFTED bucket whose OWN consumptions (or own opened lot) all sit under");
  notice("ONE different variant_key is relabelled to that key; its consumption rows follow (the FIFO");
  notice("trigger's invariant is that movement, consumption and lot agree). Lots are NEVER touched, no");
  notice("cost column is written — RM impact is zero by construction.");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  const lotSchema = await schemaOf("inventory_lots");
  const consSchema = await schemaOf("inventory_lot_consumptions");
  if (!movSchema || !lotSchema || !consSchema) {
    notice("FATAL — inventory_movements / inventory_lots / inventory_lot_consumptions not found. Cannot run.");
    return;
  }
  const movCols = await colsOf(movSchema, "inventory_movements");
  const lotCols = await colsOf(lotSchema, "inventory_lots");
  const byCompany = movCols.has("company_id") && lotCols.has("company_id");
  const M = `"${ident(movSchema)}"."inventory_movements"`;
  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;
  const coSel = byCompany ? "company_id" : "NULL::int AS company_id";
  const coGrp = byCompany ? ", company_id" : "";

  // (1) The drifted buckets — the detector's quantity-drift lens, verbatim.
  const drift = await pg.unsafe(`
    WITH mov AS (
      SELECT ${coSel}, warehouse_id::text AS warehouse_id, product_code,
             COALESCE(variant_key,'') AS variant_key,
             SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                    WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty
                                    ELSE 0 END) AS mov_qty
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
           COALESCE(mov.mov_qty,0) AS mov_qty, COALESCE(lot.lot_qty,0) AS lot_qty
      FROM mov FULL OUTER JOIN lot
        ON mov.warehouse_id = lot.warehouse_id AND mov.product_code = lot.product_code
       AND mov.variant_key = lot.variant_key ${byCompany ? "AND mov.company_id = lot.company_id" : ""}
     WHERE COALESCE(mov.mov_qty,0) <> COALESCE(lot.lot_qty,0)
     ORDER BY product_code, variant_key`);
  notice(`buckets in drift (movement sum != lot remaining): ${drift.length}`);
  if (drift.length === 0) {
    notice("Nothing to relabel — no bucket drifts. (Detector section (1) is clean.)");
    notice("=== END ===");
    return;
  }

  // (2) Families = distinct (company, warehouse, product) of the drifted
  // buckets. Relabels move qty BETWEEN sibling keys of one family, so the
  // projection needs every sibling bucket's sums, drifted or not.
  const famKey = (r) => `${r.company_id ?? ""}::${r.warehouse_id}::${r.product_code}`;
  const bKey = (r) => `${famKey(r)}::${r.variant_key}`;
  const driftedBucketKeys = new Set(drift.map(bKey));
  const families = [...new Map(drift.map((r) => [famKey(r), r])).values()];

  const buckets = new Map(); // full-key -> { movQty, lotQty }
  for (const f of families) {
    const rows = await pg.unsafe(`
      WITH mov AS (
        SELECT COALESCE(variant_key,'') AS variant_key,
               SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                      WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty
                                      ELSE 0 END) AS mov_qty
          FROM ${M} WHERE warehouse_id::text = $1 AND product_code = $2${byCompany ? " AND company_id = $3" : ""}
         GROUP BY COALESCE(variant_key,'')
      ), lot AS (
        SELECT COALESCE(variant_key,'') AS variant_key, SUM(qty_remaining) AS lot_qty
          FROM ${L} WHERE warehouse_id::text = $1 AND product_code = $2${byCompany ? " AND company_id = $3" : ""}
         GROUP BY COALESCE(variant_key,'')
      )
      SELECT COALESCE(mov.variant_key, lot.variant_key) AS variant_key,
             COALESCE(mov.mov_qty,0) AS mov_qty, COALESCE(lot.lot_qty,0) AS lot_qty
        FROM mov FULL OUTER JOIN lot ON mov.variant_key = lot.variant_key`,
      byCompany ? [f.warehouse_id, f.product_code, f.company_id] : [f.warehouse_id, f.product_code]);
    for (const r of rows) {
      buckets.set(`${famKey(f)}::${r.variant_key}`, { movQty: Number(r.mov_qty), lotQty: Number(r.lot_qty) });
    }
  }

  // (3) Movements of the DRIFTED buckets only (blast radius = the audited
  // wound), with each movement's own lot evidence.
  const relabels = []; // { movementId, row, oldKey, newKey, signedQty, fullFrom, fullTo, evidence }
  const refusals = [];
  let rmAffectedSen = 0;
  for (const d of drift) {
    const movs = await pg.unsafe(`
      SELECT id::text AS id, movement_type, qty, COALESCE(variant_key,'') AS variant_key,
             batch_no, total_cost_sen, source_doc_type, source_doc_no, created_at
        FROM ${M}
       WHERE warehouse_id::text = $1 AND product_code = $2 AND COALESCE(variant_key,'') = $3${byCompany ? " AND company_id = $4" : ""}
       ORDER BY created_at, id`,
      byCompany ? [d.warehouse_id, d.product_code, d.variant_key, d.company_id] : [d.warehouse_id, d.product_code, d.variant_key]);
    const movIds = movs.map((m) => m.id);
    if (movIds.length === 0) continue;
    const consRows = await pg.unsafe(`
      SELECT k.movement_id::text AS movement_id, l.id::text AS lot_id,
             COALESCE(l.variant_key,'') AS lot_key, k.qty_consumed
        FROM ${C} k JOIN ${L} l ON l.id = k.lot_id
       WHERE k.movement_id::text = ANY($1)`, [movIds]);
    const openedRows = await pg.unsafe(`
      SELECT movement_id::text AS movement_id, id::text AS lot_id, COALESCE(variant_key,'') AS lot_key
        FROM ${L} WHERE movement_id::text = ANY($1)`, [movIds]);
    const consByMov = new Map();
    for (const r of consRows) {
      const arr = consByMov.get(r.movement_id) ?? [];
      arr.push(r);
      consByMov.set(r.movement_id, arr);
    }
    const openedByMov = new Map();
    for (const r of openedRows) {
      const arr = openedByMov.get(r.movement_id) ?? [];
      arr.push(r);
      openedByMov.set(r.movement_id, arr);
    }
    for (const m of movs) {
      const cons = consByMov.get(m.id) ?? [];
      const opened = openedByMov.get(m.id) ?? [];
      const openedKeys = [...new Set(opened.map((o) => o.lot_key))];
      if (openedKeys.length > 1) {
        // The trigger opens exactly ONE lot per IN; more than one key pointing
        // back at this movement is import damage this rule holds no answer
        // for. Refused explicitly — never fed to the classifier.
        refusals.push({ d, m, verdict: "mixed-lot-keys", lotKeys: openedKeys });
        continue;
      }
      const v = classifyMovementRelabel({
        movementId: m.id,
        movementType: m.movement_type,
        qty: Number(m.qty),
        variantKey: m.variant_key,
        consumptionLotKeys: cons.map((c) => c.lot_key),
        openedLotKey: opened.length === 0 ? undefined : openedKeys[0],
      });
      if (v.verdict === "relabel") {
        const type = String(m.movement_type).toUpperCase();
        const signedQty = type === "IN" ? Number(m.qty) : type === "OUT" ? -Number(m.qty) : Number(m.qty);
        relabels.push({
          movementId: m.id, d, oldKey: m.variant_key, newKey: v.newKey, signedQty,
          fullFrom: `${famKey(d)}::${m.variant_key}`, fullTo: `${famKey(d)}::${v.newKey}`,
          m, consCount: cons.length,
          evidence: cons.length > 0
            ? `consumed lots ${[...new Set(cons.map((c) => c.lot_id))].join(", ")} (key "${v.newKey}")`
            : `opened lot ${opened.map((o) => o.lot_id).join(", ")} (key "${v.newKey}")`,
        });
        rmAffectedSen += Number(m.total_cost_sen ?? 0);
      } else if (v.verdict !== "consistent") {
        refusals.push({ d, m, verdict: v.verdict, lotKeys: v.lotKeys });
      }
    }
  }

  notice("");
  notice("================ RELABEL PLAN ================");
  notice(`movements to relabel: ${relabels.length}`);
  for (const r of relabels) {
    notice(`  movement ${r.movementId}  ${r.m.movement_type} qty=${r.m.qty}  ${r.m.source_doc_type ?? "-"} ${r.m.source_doc_no ?? "-"}  co=${r.d.company_id ?? "-"} wh=${short(r.d.warehouse_id, 30)}`);
    notice(`    ${r.d.product_code}: "${r.oldKey}"  ->  "${r.newKey}"   evidence: ${r.evidence}`);
    if (r.consCount > 0) notice(`    ${r.consCount} consumption row(s) follow the movement (their variant_key is the movement's copy)`);
  }
  if (refusals.length) {
    notice("");
    notice(`movements in drifted buckets LEFT ALONE (no or conflicting lot evidence): ${refusals.length}`);
    for (const r of refusals) {
      notice(`  movement ${r.m.id}  ${r.m.movement_type} qty=${r.m.qty}  ${r.m.source_doc_type ?? "-"} ${r.m.source_doc_no ?? "-"}  key="${r.m.variant_key}"  -> ${r.verdict}${r.lotKeys ? ` [lots under: ${r.lotKeys.join(" | ")}]` : ""}`);
      if (r.verdict === "no-lot-evidence" && String(r.m.movement_type).toUpperCase() === "OUT") {
        notice(Number(r.m.total_cost_sen ?? 0) > 0
          ? "    (COSTED but consumed nothing — the import dropped its consumption rows; run MODE=reconstruct FIRST, then this mode again)"
          : "    (an uncosted OUT — MODE=retro-cost / MODE=basis-cost territory, not a label problem)");
      }
    }
  }

  // (4) Projection: what every touched bucket reads AFTER the relabels.
  const projected = projectRelabelledDrift(buckets, relabels.map((r) => ({ fromKey: r.fullFrom, toKey: r.fullTo, signedQty: r.signedQty })));
  const touched = new Set([...driftedBucketKeys, ...relabels.map((r) => r.fullTo)]);
  notice("");
  notice("================ PER-BUCKET before -> after ================");
  notice(`  ${pad("product", 24)} ${pad("variant", 26)} ${pad("co", 3)} ${pad("mov before", 11)} ${pad("mov after", 10)} ${pad("lot", 6)} ${pad("drift before->after", 22)}`);
  let closed = 0, residual = 0;
  for (const key of [...touched].sort()) {
    const [co, wh, prod, ...vkParts] = key.split("::");
    const vk = vkParts.join("::");
    const before = buckets.get(key) ?? { movQty: 0, lotQty: 0 };
    const after = projected.get(key) ?? before;
    const dBefore = before.movQty - before.lotQty;
    const dAfter = after.movQty - after.lotQty;
    if (dBefore !== 0 && dAfter === 0) closed += 1;
    if (dAfter !== 0) residual += 1;
    notice(`  ${pad(short(prod, 24), 24)} ${pad(short(vk, 26), 26)} ${pad(co || "-", 3)} ${pad(before.movQty, 11)} ${pad(after.movQty, 10)} ${pad(before.lotQty, 6)} ${pad(`${dBefore} -> ${dAfter}`, 22)} ${short(wh, 30)}`);
  }
  notice("");
  notice("================ SUMMARY ================");
  notice(`  movements to relabel                    : ${relabels.length}`);
  notice(`  consumption rows following them         : ${relabels.reduce((a, r) => a + r.consCount, 0)}`);
  notice(`  buckets whose drift CLOSES              : ${closed}`);
  notice(`  buckets still drifted after (honest)    : ${residual}  (their movements had no or conflicting lot evidence)`);
  notice(`  RM impact                               : RM0.00 — variant_key is a label; no cost column is in any UPDATE`);
  notice(`  (sum of total_cost_sen on the relabelled movements, unchanged by this repair: ${rm(rmAffectedSen)})`);

  if (!APPLY) {
    notice("");
    notice("DRY-RUN — nothing was written. Review the plan, then re-run with apply=APPLY + the confirmation phrase.");
    notice("=== END ===");
    return;
  }
  if (relabels.length === 0) { notice("APPLY requested but the plan is empty — nothing written."); notice("=== END ==="); return; }

  // ONE transaction for the whole label set: the pairs are only consistent
  // together, and a movement whose key changed since planning aborts everything.
  const res = await pg.begin(async (sql) => {
    let movRows = 0, consRows2 = 0;
    for (const r of relabels) {
      const u = await sql.unsafe(
        `UPDATE ${M} SET variant_key = $1 WHERE id::text = $2 AND COALESCE(variant_key,'') = $3`,
        [r.newKey, r.movementId, r.oldKey]);
      if (u.count !== 1) throw new Error(`movement ${r.movementId} changed since the plan (CAS matched ${u.count} rows) — whole relabel rolled back; re-run the dry run`);
      const k = await sql.unsafe(
        `UPDATE ${C} SET variant_key = $1 WHERE movement_id::text = $2`,
        [r.newKey, r.movementId]);
      movRows += u.count;
      consRows2 += k.count;
    }
    return { movRows, consRows2 };
  });
  notice("");
  notice(`APPLIED — inventory_movements=${res.movRows} row(s), inventory_lot_consumptions=${res.consRows2} row(s), one transaction.`);
  notice("Re-run this mode in DRY-RUN (expect an empty plan) and the integrity check to confirm the drift closed.");
  notice("=== END ===");
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE=basis-cost (W3) — seed a reference-cost lot for named DOs' short OUTs,
// then drive the SAME fn_reconcile_uncosted_out over the bucket.
// ─────────────────────────────────────────────────────────────────────────────
const BASIS_MARKER = "repair:uncosted-out-basis";

async function runBasisCost() {
  notice("=== FIFO LEDGER DIVERGENCE — BASIS COST SEED (W3: shorts with no stock to draw on) ===");
  notice(`mode: ${APPLY ? "APPLY (writes COMMITTED)" : "DRY-RUN (each bucket exercised in a transaction and ROLLED BACK — nothing written)"}`);
  notice(`named delivery orders: ${DOS.join(", ")}`);
  if (APPLY) warn("APPLY=true — this seeds a REFERENCE-cost lot (not a real receipt) and books COGS from it. Owner-directed, named DOs only.");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  const lotSchema = await schemaOf("inventory_lots");
  const consSchema = await schemaOf("inventory_lot_consumptions");
  if (!movSchema || !lotSchema || !consSchema) {
    notice("FATAL — ledger tables not found. Cannot run.");
    return;
  }
  const fnRows = await pg`
    SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'fn_reconcile_uncosted_out' AND n.nspname IN ('scm','public')
     ORDER BY CASE n.nspname WHEN 'scm' THEN 0 ELSE 1 END LIMIT 1`;
  if (fnRows.length === 0) {
    notice("FATAL — scm.fn_reconcile_uncosted_out (0154/0230) is not present. This mode only drives it.");
    return;
  }
  const fnSchema = ident(fnRows[0].nspname);
  const M = `"${ident(movSchema)}"."inventory_movements"`;
  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;

  const dos = await pg`
    SELECT id::text AS id, do_number, company_id, status::text AS status,
           COALESCE(is_dropship, FALSE) AS is_dropship
      FROM scm.delivery_orders WHERE do_number = ANY(${DOS})`;
  for (const want of DOS) {
    if (!dos.some((d) => d.do_number === want)) notice(`"${want}" matches NO delivery order — skipped (check the number).`);
  }
  const eligibleDos = [];
  for (const d of dos) {
    if (String(d.status).toUpperCase() === "CANCELLED") { notice(`${d.do_number}: SKIP — CANCELLED (its OUTs were reversed; 0154 excludes it).`); continue; }
    if (d.is_dropship) { notice(`${d.do_number}: SKIP — is_dropship (batched coverage belongs to fn_reconcile_dropship_batch, 0088).`); continue; }
    eligibleDos.push(d);
  }
  if (eligibleDos.length === 0) { notice("No eligible DO — nothing to do."); notice("=== END ==="); return; }
  const doIds = eligibleDos.map((d) => d.id);
  const doById = new Map(eligibleDos.map((d) => [d.id, d]));

  // The named DOs' OUT movements that still carry uncosted qty.
  const targets = await pg.unsafe(`
    SELECT m.id::text AS id, m.qty, m.company_id, m.warehouse_id::text AS warehouse_id,
           m.product_code, m.product_name, COALESCE(m.variant_key,'') AS variant_key,
           m.batch_no, m.unit_cost_sen, m.total_cost_sen, m.created_at,
           m.source_doc_id::text AS do_id, m.source_doc_no,
           COALESCE(c.cons, 0)::int AS consumed
      FROM ${M} m
      LEFT JOIN (SELECT movement_id, SUM(qty_consumed) AS cons FROM ${C} GROUP BY movement_id) c
        ON c.movement_id = m.id
     WHERE m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND m.source_doc_id::text = ANY($1)
     ORDER BY m.created_at, m.id`, [doIds]);
  const shortTargets = targets.filter((t) => Math.abs(Number(t.qty)) - Number(t.consumed) > 0);
  notice(`OUT movements on the named DOs: ${targets.length}; still uncosted (shortfall > 0): ${shortTargets.length}`);
  for (const t of targets) {
    const shortfall = Math.abs(Number(t.qty)) - Number(t.consumed);
    notice(`  movement ${t.id}  ${doById.get(t.do_id)?.do_number ?? t.source_doc_no}  ${t.product_code} "${t.variant_key}" qty=${t.qty} consumed=${t.consumed} shortfall=${shortfall}${shortfall === 0 ? "  (already fully costed — idempotent skip)" : ""}`);
  }
  if (shortTargets.length === 0) {
    notice("Every OUT on the named DOs is already fully costed — nothing to do. (Idempotent.)");
    notice("=== END ===");
    return;
  }

  // Group by SKU bucket; one seeded lot covers the bucket's named shortfall.
  const bucketsMap = new Map();
  for (const t of shortTargets) {
    const key = `${t.company_id}::${t.warehouse_id}::${t.product_code}::${t.variant_key}`;
    const b = bucketsMap.get(key) ?? {
      companyId: Number(t.company_id), warehouseId: t.warehouse_id,
      productCode: t.product_code, productName: t.product_name, variantKey: t.variant_key,
      targets: [],
    };
    b.targets.push(t);
    bucketsMap.set(key, b);
  }

  const affectedDoNumbers = new Set();
  let seededUnits = 0, seededCostSen = 0, refusedBuckets = 0;
  for (const b of bucketsMap.values()) {
    const shortfall = b.targets.reduce((a, t) => a + (Math.abs(Number(t.qty)) - Number(t.consumed)), 0);
    notice("");
    notice(`----- bucket ${b.productCode} "${b.variantKey}" co=${b.companyId} wh=${b.warehouseId} — named shortfall ${shortfall} unit(s) -----`);

    // Refusal 1: real stock exists — the truer repair is MODE=retro-cost.
    const open = await pg.unsafe(`
      SELECT count(*)::int AS n, COALESCE(SUM(qty_remaining), 0)::int AS units FROM ${L}
       WHERE warehouse_id::text = $1 AND product_code = $2 AND COALESCE(variant_key,'') = $3
         AND company_id = $4 AND qty_remaining > 0`,
      [b.warehouseId, b.productCode, b.variantKey, b.companyId]);
    if (Number(open[0].n) > 0) {
      notice(`  REFUSED — ${open[0].units} unit(s) already on hand in ${open[0].n} open lot(s). Run MODE=retro-cost: real lots at real cost beat a reference basis.`);
      refusedBuckets += 1;
      continue;
    }

    // Context: every OTHER uncosted DO OUT in this bucket. An OLDER one would
    // have first claim on any lot (0154 walks oldest-first) — the in-transaction
    // verification below is the hard guard; this is the visible evidence.
    const others = await pg.unsafe(`
      SELECT m.id::text AS id, m.qty, m.source_doc_no, m.created_at,
             COALESCE(c.cons, 0)::int AS consumed
        FROM ${M} m
        LEFT JOIN (SELECT movement_id, SUM(qty_consumed) AS cons FROM ${C} GROUP BY movement_id) c
          ON c.movement_id = m.id
       WHERE m.movement_type = 'OUT' AND m.source_doc_type = 'DO'
         AND m.warehouse_id::text = $1 AND m.product_code = $2 AND COALESCE(m.variant_key,'') = $3
         AND m.company_id = $4 AND NOT (m.id::text = ANY($5))
       ORDER BY m.created_at, m.id`,
      [b.warehouseId, b.productCode, b.variantKey, b.companyId, b.targets.map((t) => t.id)]);
    const otherShort = others.filter((o) => Math.abs(Number(o.qty)) - Number(o.consumed) > 0);
    if (otherShort.length > 0) {
      notice(`  bucket also holds ${otherShort.length} OTHER uncosted DO OUT(s) — listed for the verification below:`);
      for (const o of otherShort) notice(`    movement ${o.id}  ${o.source_doc_no}  qty=${o.qty} consumed=${o.consumed}  at ${o.created_at?.toISOString?.() ?? o.created_at}`);
    }

    // The basis: newest same-(product, variant) GRN landed cost in this
    // company; else the product's latest PO line cost. Zero costs are skipped.
    const grnCands = await pg.unsafe(`
      SELECT unit_cost_sen, source_doc_no, created_at FROM ${M}
       WHERE movement_type = 'IN' AND source_doc_type = 'GRN' AND company_id = $1
         AND product_code = $2 AND COALESCE(variant_key,'') = $3
       ORDER BY created_at DESC, id DESC LIMIT 20`,
      [b.companyId, b.productCode, b.variantKey]);
    const poCands = await pg`
      SELECT COALESCE(NULLIF(poi.unit_cost_centi, 0), poi.unit_price_centi) AS cost_sen,
             po.po_number,
             CASE WHEN COALESCE(poi.unit_cost_centi, 0) > 0 THEN 'unit_cost_centi' ELSE 'unit_price_centi' END AS cost_col,
             poi.created_at
        FROM scm.purchase_order_items poi
        JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.company_id = ${b.companyId} AND poi.material_code = ${b.productCode}
       ORDER BY poi.created_at DESC, poi.id DESC LIMIT 20`;
    const basis = pickCostBasis({
      grnCandidates: grnCands.map((g) => ({ unitCostSen: Number(g.unit_cost_sen ?? 0), docNo: g.source_doc_no })),
      poCandidates: poCands.map((p) => ({ unitCostSen: Number(p.cost_sen ?? 0), docNo: p.po_number, col: p.cost_col })),
    });
    if (basis.source == null) {
      notice(`  REFUSED — no GRN movement and no PO line carries a nonzero cost for ${b.productCode} in company ${b.companyId} (skipped ${basis.skippedZeroCost} zero-cost candidate(s)). No honest basis exists; owner decision.`);
      refusedBuckets += 1;
      continue;
    }
    const basisCol = basis.source === "PO" ? ` (${poCands.find((p) => p.po_number === basis.docNo)?.cost_col ?? "unit_price_centi"})` : " (IN movement landed unit_cost_sen)";
    notice(`  BASIS per unit: ${basis.unitCostSen} sen = ${rm(basis.unitCostSen)}  from ${basis.source} ${basis.docNo}${basisCol}${basis.skippedZeroCost ? `; ${basis.skippedZeroCost} newer zero-cost candidate(s) skipped` : ""}`);
    for (const t of b.targets) {
      const sf = Math.abs(Number(t.qty)) - Number(t.consumed);
      notice(`    -> ${doById.get(t.do_id)?.do_number}  movement ${t.id}: ${sf} unit(s) x ${rm(basis.unitCostSen)} = ${rm(sf * basis.unitCostSen)}`);
    }

    // Seed + reconcile + verify, atomically. DRY-RUN rolls back at the end.
    try {
      const out = await pg.begin(async (sql) => {
        const seeded = await sql.unsafe(`
          INSERT INTO ${L} (
            warehouse_id, product_code, product_name, variant_key,
            qty_received, qty_remaining, unit_cost_sen, received_at,
            source_doc_type, source_doc_id, source_doc_no, movement_id,
            created_by, batch_no, company_id, notes
          ) VALUES ($1::uuid, $2, $3, $4, $5, $5, $6, now(), NULL, NULL, NULL, NULL, NULL, NULL, $7, $8)
          RETURNING id::text AS id`,
          [b.warehouseId, b.productCode, b.productName ?? b.productCode, b.variantKey,
            shortfall, basis.unitCostSen,
            b.companyId,
            `${BASIS_MARKER}: reference-cost lot for ${[...new Set(b.targets.map((t) => doById.get(t.do_id)?.do_number ?? t.source_doc_no))].join(" + ")} (basis ${basis.source} ${basis.docNo} @ ${basis.unitCostSen} sen/unit); consumed immediately by fn_reconcile_uncosted_out`]);
        const lotId = seeded[0].id;
        const rec = await sql.unsafe(
          `SELECT "${fnSchema}".fn_reconcile_uncosted_out($1::uuid, $2::text, $3::text, $4::timestamptz, NULL::uuid) AS n`,
          [b.warehouseId, b.productCode, b.variantKey, new Date().toISOString()]);
        const reconciled = Number(rec[0]?.n ?? 0);

        // VERIFY inside the transaction — anything unexpected rolls back:
        const lotAfter = await sql.unsafe(`SELECT qty_remaining FROM ${L} WHERE id::text = $1`, [lotId]);
        const lotCons = await sql.unsafe(`
          SELECT movement_id::text AS movement_id, SUM(qty_consumed)::int AS qty FROM ${C}
           WHERE lot_id::text = $1 GROUP BY movement_id`, [lotId]);
        const targetIds = new Set(b.targets.map((t) => t.id));
        const thieves = lotCons.filter((r) => !targetIds.has(r.movement_id));
        const stamped = await sql.unsafe(`
          SELECT m.id::text AS id, m.unit_cost_sen, m.total_cost_sen, COALESCE(c.cons,0)::int AS consumed
            FROM ${M} m
            LEFT JOIN (SELECT movement_id, SUM(qty_consumed) AS cons FROM ${C} GROUP BY movement_id) c ON c.movement_id = m.id
           WHERE m.id::text = ANY($1)`, [[...targetIds]]);
        const stillShort = stamped.filter((s) => {
          const t = b.targets.find((x) => x.id === s.id);
          return Math.abs(Number(t.qty)) - Number(s.consumed) > 0;
        });
        const problems = [];
        if (reconciled !== shortfall) problems.push(`fn reconciled ${reconciled} unit(s), expected ${shortfall}`);
        if (Number(lotAfter[0]?.qty_remaining ?? -1) !== 0) problems.push(`seeded lot has ${lotAfter[0]?.qty_remaining} unit(s) left, expected 0`);
        if (thieves.length > 0) problems.push(`seeded lot was consumed by NON-target movement(s): ${thieves.map((t) => `${t.movement_id} (${t.qty})`).join(", ")} — an older short has first claim; resolve it first`);
        if (stillShort.length > 0) problems.push(`target(s) still short after reconcile: ${stillShort.map((s) => s.id).join(", ")} (0230 strict-batch exclusion or a competing claim)`);
        if (problems.length > 0) throw { __refuse: true, problems };

        const evidence = { lotId, reconciled, stamped };
        if (!APPLY) throw { __rollback: true, evidence };
        return evidence;
      });
      // APPLY committed.
      notice(`  APPLIED — lot ${out.lotId} seeded (${shortfall} @ ${basis.unitCostSen} sen) and fully consumed; per movement after restamp:`);
      for (const s of out.stamped) notice(`    movement ${s.id}: unit_cost_sen=${s.unit_cost_sen} total_cost_sen=${s.total_cost_sen} consumed=${s.consumed}`);
      seededUnits += shortfall;
      seededCostSen += shortfall * basis.unitCostSen;
      for (const t of b.targets) affectedDoNumbers.add(doById.get(t.do_id)?.do_number ?? t.source_doc_no);
    } catch (e) {
      if (e && e.__rollback) {
        notice(`  DRY-RUN VERIFIED (then rolled back) — the apply would: seed lot ${e.evidence.lotId} (${shortfall} @ ${basis.unitCostSen} sen), reconcile ${e.evidence.reconciled} unit(s); per movement:`);
        for (const s of e.evidence.stamped) notice(`    movement ${s.id}: unit_cost_sen=${s.unit_cost_sen} total_cost_sen=${s.total_cost_sen} consumed=${s.consumed}`);
        seededUnits += shortfall;
        seededCostSen += shortfall * basis.unitCostSen;
        for (const t of b.targets) affectedDoNumbers.add(doById.get(t.do_id)?.do_number ?? t.source_doc_no);
      } else if (e && e.__refuse) {
        notice(`  REFUSED (rolled back, nothing written): ${e.problems.join("; ")}`);
        refusedBuckets += 1;
      } else {
        warn(`  bucket FAILED (rolled back, others unaffected): ${e?.message ?? e}`);
        refusedBuckets += 1;
      }
    }
  }

  notice("");
  notice("================ SUMMARY ================");
  notice(`  units ${APPLY ? "costed" : "that WOULD be costed"}          : ${seededUnits}`);
  notice(`  COGS ${APPLY ? "booked" : "that WOULD be booked"}           : ${rm(seededCostSen)}  (reference basis, printed per bucket above)`);
  notice(`  buckets refused                    : ${refusedBuckets}`);
  notice("  NOTE — the movement-vs-lot QUANTITY drift of these buckets does NOT close here: the units");
  notice("  really did ship without a receipt under that key. This mode repairs COSTING (detector");
  notice("  section (2)); the residual quantity story stays visible in section (1) and the audit's 2b.");
  if (affectedDoNumbers.size > 0) {
    notice("");
    notice(`  NEXT (after APPLY): dispatch "Restamp DO actual cost" for: ${[...affectedDoNumbers].join(", ")}`);
    notice("  so the DO lines (and any Sales Invoice) carry the movement's new cost.");
  }
  notice(APPLY ? "APPLIED — changes committed." : "DRY-RUN — every bucket was exercised inside a transaction and rolled back; nothing was written.");
  notice("=== END ===");
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE=reconstruct (W4 phase 1, live run 2026-08-01) — rebuild the consumption
// rows the 2990 import dropped, where the family's own arithmetic proves them.
//
// WHY. MODE=relabel planned ZERO for the XAMMAR family: every OUT in the
// drifted buckets was refused `no-lot-evidence`, because the import copied the
// OUT movements (costed) and the lots (ALREADY decremented — audit 2a:
// received - consumed != remaining; 10a agrees per batch) but NOT the
// inventory_lot_consumptions rows linking them. The relabel demands that trail
// and it never existed. This mode writes the missing rows — nothing else —
// under family-exact guards (planFamilyReconstruction): Sigma(movement
// shortfall) === Sigma(lot deficit), FIFO pairing covers everything, and per
// movement the paired cost EQUALS its stored total_cost_sen (pure re-link,
// RM0) or the stored cost is 0 (stamped from the new rows, 0154-style, RM
// reported). Any other shape refuses the WHOLE family and prints both sides
// row by row — the refusal output IS the diagnosis.
//
// Drift does NOT close here (movements still sit under their old key; lots'
// remaining is already the truth). Run MODE=relabel AFTERWARDS — with the
// reconstructed rows it finally has the evidence it demands, and the paired
// +/- drift closes at RM0. consumed_at on the new rows is now() — the true
// consumption date was lost with the dropped rows; backdating would fabricate
// chronology the audit reads.
// ─────────────────────────────────────────────────────────────────────────────
async function runReconstruct() {
  notice("=== FIFO LEDGER DIVERGENCE — RECONSTRUCT (W4 phase 1): the audit-2a candidates, both directions ===");
  notice(`mode: ${APPLY ? "APPLY (writes COMMITTED)" : "DRY-RUN (writes exercised per family, then ROLLED BACK — nothing persisted)"}`);
  notice("Candidates come from the costing audit's OWN 2a lens, lifted VERBATIM (round-2 lesson: a deficit-only");
  notice("candidate query reported 'every lot conserves' on the same day the audit counted 13 — the two tools");
  notice("must never be able to disagree). Per lot, both sides print: the audit's numbers and this tool's");
  notice("classification. DEFICIT lots (rows missing) pair via planFamilyReconstruction; SURPLUS lots (rows");
  notice("present, remaining never decremented — the import double-count) restore remaining = received -");
  notice("consumed, pricing the removed double-counted units as an INVENTORY-VALUE impact (COGS already booked");
  notice("by the existing rows). Every other arm is refused and reported row by row.");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  const lotSchema = await schemaOf("inventory_lots");
  const consSchema = await schemaOf("inventory_lot_consumptions");
  if (!movSchema || !lotSchema || !consSchema) {
    notice("FATAL — ledger tables not found. Cannot run.");
    return;
  }
  const movCols = await colsOf(movSchema, "inventory_movements");
  const lotCols = await colsOf(lotSchema, "inventory_lots");
  const byCompany = movCols.has("company_id") && lotCols.has("company_id");
  const M = `"${ident(movSchema)}"."inventory_movements"`;
  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;

  // ── Candidates: the audit's 2a WHERE, verbatim (audit-inventory-costing.mjs
  // section 2 — same CTE, same four arms, same no-cast SUM). Only the SELECT
  // list is wider, for grouping and printing; the row SET is the audit's.
  const candidates = await pg.unsafe(`
    WITH c AS (SELECT lot_id, SUM(qty_consumed) AS consumed FROM ${C} GROUP BY lot_id)
    SELECT l.id::text AS lot_id, ${byCompany ? "l.company_id" : "NULL::int AS company_id"},
           l.warehouse_id::text AS warehouse_id, l.product_code,
           COALESCE(l.variant_key,'') AS variant_key, l.batch_no,
           l.qty_received, l.qty_remaining, COALESCE(c.consumed,0) AS consumed,
           l.qty_received - COALESCE(c.consumed,0) - l.qty_remaining AS residual,
           l.unit_cost_sen, l.received_at
      FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
     WHERE l.qty_received - COALESCE(c.consumed,0) <> l.qty_remaining
        OR l.qty_remaining < 0
        OR COALESCE(c.consumed,0) > l.qty_received
        OR l.qty_received < 0
     ORDER BY l.received_at, l.id`);
  notice(`audit-2a candidate lots (VERBATIM lens — this number must equal the audit's 2a count): ${candidates.length}`);
  if (candidates.length === 0) {
    notice("Nothing to reconstruct — the audit-2a lens finds no lot. If the audit disagrees, the two runs saw different data (re-run the audit), because the SQL is now the same.");
    notice("=== END ===");
    return;
  }

  const classCounts = new Map();
  for (const l of candidates) {
    l.klass = classifyLotConservation({ qtyReceived: l.qty_received, consumed: l.consumed, qtyRemaining: l.qty_remaining });
    classCounts.set(l.klass.verdict, (classCounts.get(l.klass.verdict) ?? 0) + 1);
  }
  notice(`by class: ${[...classCounts.entries()].map(([k, n]) => `${k}=${n}`).join("  ")}`);

  const famKey = (r) => `${r.company_id ?? ""}::${r.warehouse_id}::${r.product_code}`;
  const families = new Map();
  for (const l of candidates) {
    const k = famKey(l);
    const f = families.get(k) ?? { companyId: l.company_id, warehouseId: l.warehouse_id, productCode: l.product_code, lots: [] };
    f.lots.push(l);
    families.set(k, f);
  }
  notice(`families (company, warehouse, product): ${families.size}`);

  let familiesPlanned = 0, familiesRefused = 0, rowsPlanned = 0, rmStamped = 0;
  let surplusLotsN = 0, surplusUnits = 0, surplusValueSen = 0;
  for (const f of families.values()) {
    notice("");
    notice(`----- family ${f.productCode} co=${f.companyId ?? "-"} wh=${f.warehouseId} -----`);

    // The audit's 10a conservation numbers for this family, reproduced from
    // the same tables (received == consumed + on hand per variant+batch), so
    // the owner can cross-check this tool against the audit run directly.
    const tenA = await pg.unsafe(`
      WITH c AS (SELECT lot_id, SUM(qty_consumed) AS consumed FROM ${C} GROUP BY lot_id)
      SELECT COALESCE(l.variant_key,'') AS variant_key, COALESCE(l.batch_no,'(no batch)') AS batch_no,
             SUM(l.qty_received)::int AS received, SUM(l.qty_remaining)::int AS on_hand,
             SUM(COALESCE(c.consumed,0))::int AS consumed
        FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
       WHERE l.warehouse_id::text = $1 AND l.product_code = $2${byCompany ? " AND l.company_id = $3" : ""}
       GROUP BY COALESCE(l.variant_key,''), COALESCE(l.batch_no,'(no batch)')
      HAVING SUM(l.qty_received) <> SUM(COALESCE(c.consumed,0)) + SUM(l.qty_remaining)`,
      byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
    notice(`  audit-10a unbalanced (variant, batch) groups in this family: ${tenA.length}`);
    for (const t of tenA) notice(`    key="${t.variant_key}" batch=${t.batch_no}: received=${t.received} consumed=${t.consumed} onHand=${t.on_hand} (received - consumed - onHand = ${t.received - t.consumed - t.on_hand})`);

    // Per lot: BOTH SIDES — the audit's numbers and this tool's classification.
    for (const l of f.lots) {
      notice(`  lot ${l.lot_id}  key="${l.variant_key}" batch=${l.batch_no ?? "-"} @ ${rm(l.unit_cost_sen)}/u`);
      notice(`    audit 2a: received=${l.qty_received} consumed=${l.consumed} remaining=${l.qty_remaining} residual=${l.residual}  ->  classified ${l.klass.verdict}`);
    }

    const deficitLots = f.lots.filter((l) => l.klass.verdict === "deficit");
    const surplus = f.lots.filter((l) => l.klass.verdict === "surplus");
    const refusedLots = f.lots.filter((l) => !["deficit", "surplus"].includes(l.klass.verdict));
    for (const l of refusedLots) {
      notice(`  REFUSED lot ${l.lot_id} (${l.klass.verdict}) — no provable correction; owner review.`);
    }

    // ── DEFICIT side: the missing-rows pairing (unchanged mechanism). ──
    let deficitPlan = null;
    if (deficitLots.length > 0) {
      const movs = await pg.unsafe(`
        SELECT m.id::text AS id, m.movement_type, m.qty, COALESCE(m.variant_key,'') AS variant_key,
               m.total_cost_sen, m.created_at, m.source_doc_type, m.source_doc_id::text AS source_doc_id,
               m.source_doc_no, COALESCE(c.cons,0)::int AS consumed, COALESCE(c.cons_cost,0)::bigint AS consumed_cost
          FROM ${M} m
          LEFT JOIN (SELECT movement_id, SUM(qty_consumed)::int AS cons, COALESCE(SUM(total_cost_sen), 0)::bigint AS cons_cost FROM ${C} GROUP BY movement_id) c
            ON c.movement_id = m.id
         WHERE (m.movement_type = 'OUT' OR (m.movement_type = 'ADJUSTMENT' AND m.qty < 0))
           AND m.warehouse_id::text = $1 AND m.product_code = $2${byCompany ? " AND m.company_id = $3" : ""}
           /* A CANCELLED DO's OUTs are NOT a shortfall to repair. The cancel
              path DELETES their consumptions and zeroes their cost stamps on
              purpose (fn_reverse_do_out steps a + b), and writes a balancing
              add-back — so Sigma(OUT) > Sigma(consumed) is the CORRECT end state
              for a cancelled delivery, not a deficit.

              Without this, the 2026-08-04 dry-run planned to reconstruct
              consumption rows for 2990-DO-2607-005 across three SKUs and stamp
              RM3641.60 of COGS onto a delivery order the owner had just
              cancelled — re-creating precisely the fault
              check-cancelled-do-cogs.mjs exists to detect.

              basis-cost mode already skips cancelled DOs by name (":SKIP —
              CANCELLED (its OUTs were reversed; 0154 excludes it)"); the deficit
              side never inherited that rule. */
           AND NOT EXISTS (
             SELECT 1 FROM scm.delivery_orders d
              WHERE m.source_doc_type = 'DO'
                AND d.id = m.source_doc_id
                AND UPPER(COALESCE(d.status::text,'')) = 'CANCELLED')
         ORDER BY m.created_at, m.id`,
        byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
      deficitPlan = {
        movs,
        plan: planFamilyReconstruction({
          movements: movs.map((m) => ({
            movementId: m.id, qty: m.qty, alreadyConsumed: m.consumed,
            alreadyConsumedCostSen: Number(m.consumed_cost ?? 0),
            totalCostSen: m.total_cost_sen, createdAt: m.created_at?.toISOString?.() ?? String(m.created_at),
          })),
          lots: deficitLots.map((l) => ({
            lotId: l.lot_id, qtyReceived: l.qty_received, qtyRemaining: l.qty_remaining,
            consumed: l.consumed, unitCostSen: l.unit_cost_sen,
            receivedAt: l.received_at?.toISOString?.() ?? String(l.received_at),
          })),
        }),
      };
      const plan = deficitPlan.plan;
      notice(`  DEFICIT side — movement shortfalls (${plan.shorts.length}):`);
      for (const sh of plan.shorts) {
        const m = movs.find((x) => x.id === sh.movementId);
        notice(`    movement ${sh.movementId}  ${m?.movement_type} qty=${m?.qty} key="${m?.variant_key}" cost=${rm(m?.total_cost_sen)}  ${m?.source_doc_type ?? "-"} ${m?.source_doc_no ?? "-"}  shortfall=${sh.shortfall}`);
      }
      if (plan.verdict !== "reconstruct") {
        notice(`  DEFICIT side REFUSED (${plan.verdict})${plan.verdict === "sums-mismatch" ? ` — Sigma(shortfall)=${plan.totalShort} != Sigma(deficit)=${plan.totalDeficit}` : ""}${plan.conflicts ? ` — cost conflicts: ${plan.conflicts.map((cf) => `${cf.movementId} stored ${rm(cf.storedCostSen)} vs existing-rows ${rm(cf.existingConsumedCostSen)} + paired ${rm(cf.pairedCostSen)}`).join("; ")}` : ""}`);
        deficitPlan = null;
      } else {
        notice(`  DEFICIT side PLAN — ${plan.pairs.length} consumption row(s) to reconstruct:`);
        for (const pr of plan.pairs) notice(`    movement ${pr.movementId} <- lot ${pr.lotId}: qty=${pr.qty} @ ${pr.unitCostSen} sen = ${rm(pr.qty * pr.unitCostSen)}`);
        for (const st of plan.stamps) notice(`    movement ${st.movementId} cost stamps to ${st.newTotalCostSen} (was covering only its existing rows)`);
      }
    }

    // ── SURPLUS side: restore remaining = received - consumed, guarded. ──
    const surplusPlans = [];
    for (const l of surplus) {
      const refs = await pg.unsafe(`
        SELECT k.movement_id::text AS movement_id,
               SUM(k.qty_consumed)::int AS from_this_lot,
               (m.id IS NOT NULL) AS mov_exists,
               COALESCE(ABS(m.qty), 0)::int AS abs_qty,
               COALESCE(mc.cons, 0)::int AS consumed_total
          FROM ${C} k
          LEFT JOIN ${M} m ON m.id = k.movement_id
          LEFT JOIN (SELECT movement_id, SUM(qty_consumed)::int AS cons FROM ${C} GROUP BY movement_id) mc
            ON mc.movement_id = k.movement_id
         WHERE k.lot_id::text = $1
         GROUP BY k.movement_id, m.id, m.qty, mc.cons`, [l.lot_id]);
      const v = planSurplusCorrection({
        qtyReceived: l.qty_received, consumed: l.consumed, qtyRemaining: l.qty_remaining,
        referencedMovements: refs.map((r) => ({
          movementId: r.movement_id, exists: r.mov_exists === true,
          absQty: r.abs_qty, consumedTotal: r.consumed_total,
        })),
      });
      if (v.verdict !== "correct") {
        notice(`  SURPLUS lot ${l.lot_id} REFUSED (${v.verdict}${v.missing ? `: ${v.missing.join(", ")}` : ""}${v.over ? `: ${v.over.join(", ")}` : ""}) — its consumption rows are not honest evidence; owner review.`);
        continue;
      }
      const valueSen = v.delta * Number(l.unit_cost_sen ?? 0);
      notice(`  SURPLUS lot ${l.lot_id} PLAN: qty_remaining ${l.qty_remaining} -> ${v.newRemaining} (removes ${v.delta} double-counted unit(s); INVENTORY VALUE -${rm(valueSen)}; COGS unchanged — the rows already booked it)`);
      notice(`    evidence: ${refs.length} consuming movement(s), all real, none over-attributed (audit 10c lens)`);
      surplusPlans.push({ lot: l, newRemaining: v.newRemaining, delta: v.delta, valueSen });
    }

    if (!deficitPlan && surplusPlans.length === 0) {
      notice("  family: nothing provable — all candidates refused above.");
      familiesRefused += 1;
      continue;
    }

    // ── Execute per family — commit under APPLY, rolled back for dry-run,
    // fresh-read CAS, and the family must read CLEAN on the VERBATIM 2a lens
    // afterwards (all four arms) except the knowingly-refused lots, or
    // everything rolls back. ──
    try {
      await pg.begin(async (sql) => {
        if (deficitPlan) {
          const freshLots = await sql.unsafe(`
            WITH c AS (SELECT lot_id, SUM(qty_consumed) AS consumed FROM ${C} GROUP BY lot_id)
            SELECT l.id::text AS lot_id, l.qty_received, l.qty_remaining, COALESCE(c.consumed,0) AS consumed,
                   l.unit_cost_sen, l.received_at
              FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
             WHERE l.id::text = ANY($1)
             ORDER BY l.received_at, l.id FOR UPDATE OF l`,
            [deficitPlan.plan.deficits.map((d) => d.lotId)]);
          const freshMovs = await sql.unsafe(`
            SELECT m.id::text AS id, m.qty, m.total_cost_sen, m.created_at, COALESCE(c.cons,0)::int AS consumed, COALESCE(c.cons_cost,0)::bigint AS consumed_cost
              FROM ${M} m
              LEFT JOIN (SELECT movement_id, SUM(qty_consumed)::int AS cons, COALESCE(SUM(total_cost_sen),0)::bigint AS cons_cost FROM ${C} GROUP BY movement_id) c
                ON c.movement_id = m.id
             WHERE (m.movement_type = 'OUT' OR (m.movement_type = 'ADJUSTMENT' AND m.qty < 0))
               AND m.warehouse_id::text = $1 AND m.product_code = $2${byCompany ? " AND m.company_id = $3" : ""}
             ORDER BY m.created_at, m.id`,
            byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
          const fresh = planFamilyReconstruction({
            movements: freshMovs.map((m) => ({ movementId: m.id, qty: m.qty, alreadyConsumed: m.consumed, alreadyConsumedCostSen: Number(m.consumed_cost ?? 0), totalCostSen: m.total_cost_sen, createdAt: m.created_at?.toISOString?.() ?? String(m.created_at) })),
            lots: freshLots.map((l) => ({ lotId: l.lot_id, qtyReceived: l.qty_received, qtyRemaining: l.qty_remaining, consumed: l.consumed, unitCostSen: l.unit_cost_sen, receivedAt: l.received_at?.toISOString?.() ?? String(l.received_at) })),
          });
          if (fresh.verdict !== "reconstruct" || JSON.stringify(fresh.pairs) !== JSON.stringify(deficitPlan.plan.pairs)) {
            throw new Error(`deficit side changed since the plan (fresh verdict ${fresh.verdict}) — family rolled back; re-run the dry run`);
          }
          const movById = new Map(deficitPlan.movs.map((m) => [m.id, m]));
          for (const pr of deficitPlan.plan.pairs) {
            const m = movById.get(pr.movementId);
            await sql.unsafe(`
              INSERT INTO ${C} (
                lot_id, warehouse_id, product_code, variant_key,
                qty_consumed, unit_cost_sen, total_cost_sen,
                source_doc_type, source_doc_id, source_doc_no, movement_id, created_by, company_id
              ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11::uuid, NULL, $12)`,
              [pr.lotId, f.warehouseId, f.productCode, m.variant_key,
                pr.qty, pr.unitCostSen, pr.qty * pr.unitCostSen,
                m.source_doc_type, m.source_doc_id, m.source_doc_no, pr.movementId,
                f.companyId]);
          }
          for (const st of deficitPlan.plan.stamps) {
            await sql.unsafe(`
              UPDATE ${M} m SET total_cost_sen = sub.total, unit_cost_sen = CASE WHEN ABS(m.qty) > 0 THEN sub.total / ABS(m.qty) ELSE 0 END
                FROM (SELECT COALESCE(SUM(total_cost_sen),0)::int AS total FROM ${C} WHERE movement_id = $1::uuid) sub
               WHERE m.id = $1::uuid`, [st.movementId]);
          }
        }
        for (const sp of surplusPlans) {
          const u = await sql.unsafe(
            `UPDATE ${L} SET qty_remaining = $1 WHERE id::text = $2 AND qty_remaining = $3`,
            [sp.newRemaining, sp.lot.lot_id, sp.lot.qty_remaining]);
          if (u.count !== 1) throw new Error(`surplus lot ${sp.lot.lot_id} changed since the plan (CAS matched ${u.count}) — family rolled back; re-run the dry run`);
        }
        // The family must now be CLEAN on the audit's verbatim four-arm lens,
        // apart from the lots this run KNOWINGLY refused above.
        const after = await sql.unsafe(`
          WITH c AS (SELECT lot_id, SUM(qty_consumed) AS consumed FROM ${C} GROUP BY lot_id)
          SELECT count(*)::int AS n FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
           WHERE l.warehouse_id::text = $1 AND l.product_code = $2${byCompany ? " AND l.company_id = $3" : ""}
             AND (l.qty_received - COALESCE(c.consumed,0) <> l.qty_remaining
               OR l.qty_remaining < 0
               OR COALESCE(c.consumed,0) > l.qty_received
               OR l.qty_received < 0)`,
          byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
        const residualLots = Number(after[0].n);
        const refusedCount = refusedLots.length
          + surplus.filter((l) => !surplusPlans.some((sp) => sp.lot.lot_id === l.lot_id)).length
          + (deficitPlan ? 0 : deficitLots.length);
        if (residualLots !== refusedCount) {
          throw new Error(`family still has ${residualLots} audit-2a lot(s) after the repair but only ${refusedCount} were knowingly refused — rolled back; the plan does not fully explain the family`);
        }
        if (!APPLY) throw { __rollback: true };
      });
      const wrote = (deficitPlan ? deficitPlan.plan.pairs.length : 0);
      notice(APPLY
        ? `  APPLIED — ${wrote} consumption row(s) written, ${surplusPlans.length} surplus lot(s) corrected; every non-refused lot of this family conserves on the audit's own lens.`
        : "  DRY-RUN VERIFIED (then rolled back) — the apply would leave every non-refused lot of this family conserving on the audit's own lens.");
      familiesPlanned += 1;
      rowsPlanned += wrote;
      rmStamped += deficitPlan ? deficitPlan.plan.rmStampedSen : 0;
      surplusLotsN += surplusPlans.length;
      surplusUnits += surplusPlans.reduce((a, sp) => a + sp.delta, 0);
      surplusValueSen += surplusPlans.reduce((a, sp) => a + sp.valueSen, 0);
    } catch (e) {
      if (e && e.__rollback) {
        const wrote = (deficitPlan ? deficitPlan.plan.pairs.length : 0);
        notice("  DRY-RUN VERIFIED (then rolled back) — the apply would leave every non-refused lot of this family conserving on the audit's own lens.");
        familiesPlanned += 1;
        rowsPlanned += wrote;
        rmStamped += deficitPlan ? deficitPlan.plan.rmStampedSen : 0;
        surplusLotsN += surplusPlans.length;
        surplusUnits += surplusPlans.reduce((a, sp) => a + sp.delta, 0);
        surplusValueSen += surplusPlans.reduce((a, sp) => a + sp.valueSen, 0);
      } else {
        warn(`  family FAILED (rolled back, others unaffected): ${e?.message ?? e}`);
        familiesRefused += 1;
      }
    }
  }

  notice("");
  notice("================ SUMMARY ================");
  notice(`  audit-2a candidate lots                    : ${candidates.length}  (must equal the audit's 2a count)`);
  notice(`  families ${APPLY ? "repaired" : "that WOULD repair"}                : ${familiesPlanned}`);
  notice(`  consumption rows ${APPLY ? "written" : "planned"} (deficit side): ${rowsPlanned}`);
  notice(`  RM stamped onto movements whose cost missed them: ${rm(rmStamped)}  (0 = pure re-link)`);
  notice(`  surplus lots ${APPLY ? "corrected" : "to correct"}               : ${surplusLotsN}  (${surplusUnits} double-counted unit(s) off on-hand; INVENTORY VALUE -${rm(surplusValueSen)}; COGS unchanged)`);
  notice(`  families refused                           : ${familiesRefused}`);
  notice("");
  notice("NEXT: MODE=relabel (drift pairs close once movements and lots agree), then re-run the integrity");
  notice("check + the costing audit — sections 2a and 10a must read the SAME zero this tool now reads.");
  notice(APPLY ? "APPLIED — committed." : "DRY-RUN — every family was exercised inside a transaction and rolled back; nothing was written.");
  notice("=== END ===");
}


// ─────────────────────────────────────────────────────────────────────────────
// MODE=doc-relabel (document-evidence round, 2026-08-01) — resolve the
// residual 1/2a/2b/10a buckets from the DOCUMENT chain the earlier modes never
// read. See the header block and lib/doc-evidence-core.mjs for the rules; this
// runner only fetches, prints and executes.
// ─────────────────────────────────────────────────────────────────────────────
async function runDocRelabel() {
  notice("=== FIFO LEDGER DIVERGENCE — DOC-RELABEL (document-evidence resolution of the audit residuals) ===");
  notice(`mode: ${APPLY ? "APPLY (writes COMMITTED)" : "DRY-RUN (writes exercised per family, then ROLLED BACK — nothing persisted)"}`);
  notice("Evidence: OUT -> DO line (variants, so_item_id -> SO line) ; IN/lot -> GRN line (variants,");
  notice("purchase_order_item -> PO line). TRUE keys via computeVariantKey (lockstep mirror). Rows follow the");
  notice("key their OWN document proves; over-consumed lots re-point their excess to the document-proven");
  notice("sibling receipt. Documents disagreeing, or shipment with no family receipt, land on the STOCKTAKE");
  notice("list at the end — nothing there is guessed.");
  notice("");

  const movSchema = await schemaOf("inventory_movements");
  const lotSchema = await schemaOf("inventory_lots");
  const consSchema = await schemaOf("inventory_lot_consumptions");
  if (!movSchema || !lotSchema || !consSchema) {
    notice("FATAL — ledger tables not found. Cannot run.");
    return;
  }
  const movCols = await colsOf(movSchema, "inventory_movements");
  const lotCols = await colsOf(lotSchema, "inventory_lots");
  const byCompany = movCols.has("company_id") && lotCols.has("company_id");
  const M = `"${ident(movSchema)}"."inventory_movements"`;
  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  const C = `"${ident(consSchema)}"."inventory_lot_consumptions"`;
  const coSel = byCompany ? "company_id" : "NULL::int AS company_id";
  const coGrp = byCompany ? ", company_id" : "";

  // Company codes, for the prefixed-number document resolution fallback (the
  // doc-ref-repair rule: a bare pre-import number resolves only when prefixed
  // with the owning company's own code).
  const companyRows = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  const codeById = new Map(companyRows.map((r) => [Number(r.id), String(r.code ?? "")]));

  // ── The residual lenses, verbatim (round-2 lesson: this tool and the audit
  //    must not be able to disagree on the candidate set).
  const drift = await pg.unsafe(`
    WITH mov AS (
      SELECT ${coSel}, warehouse_id::text AS warehouse_id, product_code,
             COALESCE(variant_key,'') AS variant_key,
             SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                    WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty
                                    ELSE 0 END) AS mov_qty
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
           COALESCE(mov.mov_qty,0) AS mov_qty, COALESCE(lot.lot_qty,0) AS lot_qty
      FROM mov FULL OUTER JOIN lot
        ON mov.warehouse_id = lot.warehouse_id AND mov.product_code = lot.product_code
       AND mov.variant_key = lot.variant_key ${byCompany ? "AND mov.company_id = lot.company_id" : ""}
     WHERE COALESCE(mov.mov_qty,0) <> COALESCE(lot.lot_qty,0)
        OR COALESCE(mov.mov_qty,0) < 0
     ORDER BY product_code, variant_key`);
  const overLots = await pg.unsafe(`
    WITH c AS (SELECT lot_id, SUM(qty_consumed) AS consumed FROM ${C} GROUP BY lot_id)
    SELECT l.id::text AS lot_id, ${byCompany ? "l.company_id" : "NULL::int AS company_id"},
           l.warehouse_id::text AS warehouse_id, l.product_code,
           COALESCE(l.variant_key,'') AS variant_key, l.batch_no,
           l.qty_received, l.qty_remaining, COALESCE(c.consumed,0) AS consumed,
           l.unit_cost_sen, l.received_at
      FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
     WHERE COALESCE(c.consumed,0) > l.qty_received
     ORDER BY l.received_at, l.id`);
  notice(`residual lens: drifted-or-negative buckets=${drift.length} (audit 1 + 2b), over-consumed lots=${overLots.length} (audit 2a's refused arm)`);
  if (drift.length === 0 && overLots.length === 0) {
    notice("Nothing to resolve — the residual lenses are clean. (Idempotent re-run lands here.)");
    notice("=== END ===");
    return;
  }

  const famKey = (r) => `${r.company_id ?? ""}::${r.warehouse_id}::${r.product_code}`;
  const families = new Map();
  for (const r of drift) {
    const f = families.get(famKey(r)) ?? { companyId: r.company_id, warehouseId: r.warehouse_id, productCode: r.product_code, driftBuckets: [], overLots: [] };
    f.driftBuckets.push(r);
    families.set(famKey(r), f);
  }
  for (const l of overLots) {
    const f = families.get(famKey(l)) ?? { companyId: l.company_id, warehouseId: l.warehouseId ?? l.warehouse_id, productCode: l.product_code, driftBuckets: [], overLots: [] };
    f.warehouseId = f.warehouseId ?? l.warehouse_id;
    f.overLots.push(l);
    families.set(famKey(l), f);
  }
  notice(`families (company, warehouse, product): ${families.size}`);

  const stocktake = []; // { family, kind, detail } — the honest residue, printed at the end
  const repairSeeded = []; // repair-seeded rows — expected by design, printed apart from the stocktake list
  let famPlanned = 0, famRefused = 0;
  let movRelabels = 0, lotRelabels = 0, consFollow = 0, repointMoves = 0, repointUnits = 0, rmDeltaTotal = 0;

  for (const f of families.values()) {
    notice("");
    notice(`----- family ${f.productCode} co=${f.companyId ?? "-"} wh=${f.warehouseId} -----`);
    for (const b of f.driftBuckets) {
      notice(`  bucket key="${b.variant_key}": movQty=${b.mov_qty} lotQty=${b.lot_qty} drift=${Number(b.mov_qty) - Number(b.lot_qty)}${Number(b.mov_qty) < 0 ? "  (NEGATIVE on-hand — audit 2b)" : ""}`);
    }
    for (const l of f.overLots) {
      notice(`  over-consumed lot ${l.lot_id} key="${l.variant_key}" batch=${l.batch_no ?? "-"}: received=${l.qty_received} consumed=${l.consumed} remaining=${l.qty_remaining} (audit 2a)`);
    }

    // ── Family ledger rows.
    const movs = await pg.unsafe(`
      SELECT m.id::text AS id, m.movement_type, m.qty, COALESCE(m.variant_key,'') AS variant_key,
             m.batch_no, m.total_cost_sen, m.unit_cost_sen, m.created_at, m.notes,
             m.source_doc_type, m.source_doc_id::text AS source_doc_id, m.source_doc_no,
             COALESCE(c.cons,0)::int AS consumed, COALESCE(c.cons_cost,0)::bigint AS consumed_cost
        FROM ${M} m
        LEFT JOIN (SELECT movement_id, SUM(qty_consumed)::int AS cons, COALESCE(SUM(total_cost_sen),0)::bigint AS cons_cost FROM ${C} GROUP BY movement_id) c
          ON c.movement_id = m.id
       WHERE m.warehouse_id::text = $1 AND m.product_code = $2${byCompany ? " AND m.company_id = $3" : ""}
       ORDER BY m.created_at, m.id`,
      byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
    const lots = await pg.unsafe(`
      WITH c AS (SELECT lot_id, SUM(qty_consumed) AS consumed FROM ${C} GROUP BY lot_id)
      SELECT l.id::text AS id, COALESCE(l.variant_key,'') AS variant_key, l.batch_no,
             l.qty_received, l.qty_remaining, COALESCE(c.consumed,0)::int AS consumed,
             l.unit_cost_sen, l.received_at, l.movement_id::text AS movement_id, l.notes,
             l.source_doc_type, l.source_doc_id::text AS source_doc_id, l.source_doc_no
        FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
       WHERE l.warehouse_id::text = $1 AND l.product_code = $2${byCompany ? " AND l.company_id = $3" : ""}
       ORDER BY l.received_at, l.id`,
      byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
    const movById = new Map(movs.map((m) => [m.id, m]));

    // A lot's GRN is its own source doc, else the source doc of the IN movement
    // that opened it (repair-seeded lots have neither -> no document).
    const lotGrnId = (l) => {
      if (String(l.source_doc_type ?? "").toUpperCase() === "GRN" && l.source_doc_id) return l.source_doc_id;
      const m = l.movement_id ? movById.get(l.movement_id) : null;
      if (m && String(m.source_doc_type ?? "").toUpperCase() === "GRN" && m.source_doc_id) return m.source_doc_id;
      return null;
    };

    // ── Documents named by the family, resolved id-first then number, then the
    //    number PREFIXED with the owning company's code (the doc-ref-repair
    //    rule: 2990-import ledger rows can still carry a dangling id AND a
    //    bare pre-import number — the live 2026-08-01 run refused those
    //    `no-document` because this exact-string lookup missed them). The
    //    prefixed resolution is READ-ONLY evidence for this mode; the stored
    //    refs themselves stay for part=consumptions / part=ids to repair.
    const famPrefix = companyPrefix(codeById.get(Number(f.companyId)));
    const withPrefix = (no) => (famPrefix && no && !String(no).startsWith(famPrefix) ? `${famPrefix}${no}` : null);
    const doIds = new Set(), doNos = new Set(), grnIds = new Set(), grnNos = new Set();
    for (const m of movs) {
      const t = String(m.source_doc_type ?? "").toUpperCase();
      if (t === "DO") {
        if (m.source_doc_id) doIds.add(m.source_doc_id);
        if (m.source_doc_no) { doNos.add(m.source_doc_no); const p = withPrefix(m.source_doc_no); if (p) doNos.add(p); }
      }
      if (t === "GRN") {
        if (m.source_doc_id) grnIds.add(m.source_doc_id);
        if (m.source_doc_no) { grnNos.add(m.source_doc_no); const p = withPrefix(m.source_doc_no); if (p) grnNos.add(p); }
      }
    }
    for (const l of lots) {
      const gid = lotGrnId(l);
      if (gid) grnIds.add(gid);
      if (String(l.source_doc_type ?? "").toUpperCase() === "GRN" && l.source_doc_no) {
        grnNos.add(l.source_doc_no);
        const p = withPrefix(l.source_doc_no);
        if (p) grnNos.add(p);
      }
    }
    const dosById = new Map(), dosByNo = new Map();
    if (doIds.size || doNos.size) {
      const rows = await pg.unsafe(`
        SELECT id::text AS id, do_number, company_id, status::text AS status
          FROM scm.delivery_orders
         WHERE id::text = ANY($1) OR (do_number = ANY($2)${byCompany ? " AND company_id = $3" : ""})`,
        byCompany ? [[...doIds], [...doNos], f.companyId] : [[...doIds], [...doNos]]);
      for (const r of rows) { dosById.set(r.id, r); dosByNo.set(r.do_number, r); }
    }
    const grnsById = new Map(), grnsByNo = new Map();
    if (grnIds.size || grnNos.size) {
      const rows = await pg.unsafe(`
        SELECT id::text AS id, grn_number, company_id, status::text AS status
          FROM scm.grns
         WHERE id::text = ANY($1) OR (grn_number = ANY($2)${byCompany ? " AND company_id = $3" : ""})`,
        byCompany ? [[...grnIds], [...grnNos], f.companyId] : [[...grnIds], [...grnNos]]);
      for (const r of rows) { grnsById.set(r.id, r); grnsByNo.set(r.grn_number, r); }
    }
    const resolveDoc = (m) => {
      const t = String(m.source_doc_type ?? "").toUpperCase();
      if (t === "DO") {
        return dosById.get(m.source_doc_id) ?? dosByNo.get(m.source_doc_no)
          ?? (withPrefix(m.source_doc_no) ? dosByNo.get(withPrefix(m.source_doc_no)) : null) ?? null;
      }
      if (t === "GRN") {
        return grnsById.get(m.source_doc_id) ?? grnsByNo.get(m.source_doc_no)
          ?? (withPrefix(m.source_doc_no) ? grnsByNo.get(withPrefix(m.source_doc_no)) : null) ?? null;
      }
      return null;
    };

    // ── Document LINES for this product, with upstream corroboration.
    const doLinesByDoc = new Map();
    if (dosById.size || dosByNo.size) {
      const ids = [...new Set([...[...dosById.values()], ...[...dosByNo.values()]].map((d) => d.id))];
      const rows = await pg.unsafe(`
        SELECT di.delivery_order_id::text AS doc_id, di.id::text AS line_id, di.line_no,
               di.item_code, di.qty, di.variants, di.item_group, di.so_item_id::text AS so_item_id,
               si.variants AS so_variants, si.item_group AS so_item_group,
               si.warehouse_id::text AS so_warehouse_id, si.doc_no AS so_doc_no, si.line_no AS so_line_no
          FROM scm.delivery_order_items di
          LEFT JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
         WHERE di.delivery_order_id::text = ANY($1)
           AND UPPER(TRIM(di.item_code)) = UPPER(TRIM($2))
         ORDER BY di.line_no NULLS LAST, di.created_at, di.id`, [ids, f.productCode]);
      for (const r of rows) {
        const arr = doLinesByDoc.get(r.doc_id) ?? [];
        arr.push(r);
        doLinesByDoc.set(r.doc_id, arr);
      }
    }
    const grnLinesByDoc = new Map();
    if (grnsById.size || grnsByNo.size) {
      const ids = [...new Set([...[...grnsById.values()], ...[...grnsByNo.values()]].map((g) => g.id))];
      const rows = await pg.unsafe(`
        SELECT gi.grn_id::text AS doc_id, gi.id::text AS line_id,
               gi.material_code, gi.qty_accepted, COALESCE(gi.returned_qty,0)::int AS returned_qty,
               gi.variants, gi.item_group, gi.purchase_order_item_id::text AS po_item_id,
               poi.variants AS po_variants, poi.item_group AS po_item_group, po.po_number
          FROM scm.grn_items gi
          LEFT JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id
          LEFT JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
         WHERE gi.grn_id::text = ANY($1)
           AND UPPER(TRIM(gi.material_code)) = UPPER(TRIM($2))
         ORDER BY gi.created_at, gi.id`, [ids, f.productCode]);
      for (const r of rows) {
        const arr = grnLinesByDoc.get(r.doc_id) ?? [];
        arr.push(r);
        grnLinesByDoc.set(r.doc_id, arr);
      }
    }

    // Line -> { ref, key, conflict, cite } via the pure rule; the citation
    // carries the variants JSON so every relabel names its paperwork.
    const doLineEval = (docNo, r) => {
      const v = resolveDocLineKey({
        itemGroup: r.item_group,
        variants: r.variants,
        corroborating: r.so_item_id ? { itemGroup: r.so_item_group, variants: r.so_variants } : null,
      });
      return {
        ref: `DO ${docNo} line ${r.line_no ?? r.line_id}`,
        key: v.key,
        conflict: v.verdict === "doc-conflict",
        cite: `DO ${docNo} line ${r.line_no ?? r.line_id} variants ${JSON.stringify(r.variants ?? null)} -> "${v.key}"`
          + (r.so_item_id ? ` | SO ${r.so_doc_no ?? "?"} line ${r.so_line_no ?? "?"} variants ${JSON.stringify(r.so_variants ?? null)} -> "${v.corroboratingKey}" (${v.verdict})` : " | (no SO line linked)"),
        soWarehouseId: r.so_warehouse_id ?? null,
      };
    };
    const grnLineEval = (docNo, r) => {
      const v = resolveDocLineKey({
        itemGroup: r.item_group,
        variants: r.variants,
        corroborating: r.po_item_id ? { itemGroup: r.po_item_group, variants: r.po_variants } : null,
      });
      return {
        ref: `GRN ${docNo} line ${r.line_id}`,
        key: v.key,
        conflict: v.verdict === "doc-conflict",
        cite: `GRN ${docNo} line ${r.line_id} variants ${JSON.stringify(r.variants ?? null)} -> "${v.key}"`
          + (r.po_item_id ? ` | PO ${r.po_number ?? "?"} line ${r.po_item_id} variants ${JSON.stringify(r.po_variants ?? null)} -> "${v.corroboratingKey}" (${v.verdict})` : " | (no PO line linked)"),
      };
    };

    // ── Alignment per document. Blast radius: only rows whose CURRENT bucket
    //    is in the residual lens may be relabelled — a balanced bucket's rows
    //    are reported, never moved (moving them would CREATE drift).
    const lensKeys = new Set(f.driftBuckets.map((b) => String(b.variant_key)));
    const plannedMovKey = new Map(); // movement id -> final key (relabels only)
    const plannedLotKey = new Map(); // lot id -> final key
    const movPlans = []; // { m, newKey, cite, normalized }
    const lotPlans = []; // { l, newKey, cite, normalized }
    const refusals = []; // { kind, id, verdict, detail } — candidates for the stocktake list
    const expected = []; // repair-seeded rows: correct by design, reported, NEVER stocktake
    const consistentLensOuts = []; // doc-CONFIRMED OUTs in lens buckets — stocktake if their key has no receipt

    const movsByDoc = new Map();
    for (const m of movs) {
      const doc = resolveDoc(m);
      if (!doc) {
        if (isRepairSeeded({ movementNotes: m.notes })) {
          expected.push({ kind: "movement", id: m.id, verdict: "repair-seeded", detail: `${m.movement_type} qty=${m.qty} key="${m.variant_key}" — created by ${String(m.notes ?? "").match(/repair:[a-z-]+/)?.[0] ?? "a repair run"}` });
        } else if (lensKeys.has(m.variant_key)) {
          refusals.push({ kind: "movement", id: m.id, verdict: "no-document", detail: `${m.movement_type} qty=${m.qty} key="${m.variant_key}" ${m.source_doc_type ?? "-"} ${m.source_doc_no ?? "-"} — source document resolves nothing (id dangling and number unresolvable even company-prefixed)` });
        }
        continue;
      }
      const t = String(m.source_doc_type).toUpperCase();
      const k = `${t}::${doc.id}`;
      const g = movsByDoc.get(k) ?? { doc, type: t, rows: [] };
      g.rows.push(m);
      movsByDoc.set(k, g);
    }
    for (const { doc, type, rows } of movsByDoc.values()) {
      const rawLines = (type === "DO" ? doLinesByDoc.get(doc.id) : grnLinesByDoc.get(doc.id)) ?? [];
      const docNo = type === "DO" ? doc.do_number : doc.grn_number;
      const lines = rawLines.map((r) => (type === "DO" ? doLineEval(docNo, r) : grnLineEval(docNo, r)));
      const verdicts = planDocKeyAlignment({
        rows: rows.map((m) => ({ id: m.id, ledgerKey: m.variant_key })),
        lines,
      });
      for (const v of verdicts) {
        const m = movById.get(v.id);
        if (v.verdict === "consistent") {
          // The document CONFIRMS this row's key. If it is an OUT in a lens
          // bucket, remember it — should its key end up with no family
          // receipt, the drift is REAL (documented shipment, no receipt
          // anywhere) and belongs on the stocktake list, reported below.
          if (lensKeys.has(m.variant_key) && String(m.movement_type).toUpperCase() === "OUT") {
            consistentLensOuts.push({ m, cite: v.citation?.cite ?? "(document line confirms the stored key)" });
          }
          continue;
        }
        // Blast radius: only lens-bucket rows may relabel — EXCEPT a
        // quote-normalization relabel (ledger key differs from the document's
        // canonical key ONLY by the doubled inch mark). The doubled spelling
        // splits ONE physical bucket in two, so the split must converge
        // wholesale — a balanced `1""` bucket left behind would keep
        // retro-cost (exact-key consume) blind to its lots forever.
        if (!lensKeys.has(m.variant_key) && !(v.verdict === "relabel" && v.normalized)) {
          notice(`  (outside-lens, untouched) movement ${m.id} ${m.movement_type} key="${m.variant_key}" on ${docNo}: ${v.verdict}`);
          continue;
        }
        if (v.verdict === "relabel") {
          // A movement with its OWN consumption trail must not be moved against
          // it — the relabel mode owns that evidence class. Doc evidence may
          // only move rows whose trail is absent or agrees (up to the quote
          // doubling — the trail lot converges via its own GRN in this same
          // run; the post-plan edge check below enforces EXACT final
          // agreement and voids anything that did not converge).
          if (Number(m.consumed) > 0) {
            const consKeys = await pg.unsafe(`
              SELECT DISTINCT COALESCE(l.variant_key,'') AS k
                FROM ${C} c JOIN ${L} l ON l.id = c.lot_id WHERE c.movement_id::text = $1`, [m.id]);
            const keys = consKeys.map((r) => r.k);
            if (!(keys.length === 1 && normalizeVariantKeyQuotes(keys[0]) === v.newKey)) {
              refusals.push({ kind: "movement", id: m.id, verdict: "ledger-doc-conflict", detail: `doc proves "${v.newKey}" but its consumptions sit under [${keys.join(" | ")}] — ${v.citation?.cite ?? ""}` });
              continue;
            }
          }
          movPlans.push({ m, newKey: v.newKey, cite: v.citation?.cite ?? "(citation missing)", docStatus: doc.status, normalized: v.normalized === true });
          plannedMovKey.set(m.id, v.newKey);
        } else {
          refusals.push({ kind: "movement", id: m.id, verdict: v.verdict, detail: `${m.movement_type} qty=${m.qty} key="${m.variant_key}" on ${docNo}${v.candidates ? ` candidates [${v.candidates.join(" | ")}]` : ""}${(v.conflictLines ?? []).length ? ` conflicted lines: ${v.conflictLines.map((l) => l.cite).join(" ; ")}` : ""}` });
        }
      }
    }

    const lotsByGrn = new Map();
    for (const l of lots) {
      const gid = lotGrnId(l);
      if (!gid || !grnsById.get(gid)) {
        // A repair-seeded lot is EXPECTED to resolve no purchase document —
        // the basis-cost seed has no GRN by design (its notes carry the
        // repair: marker) and the grn-gap insert's marker sits on its source
        // movement. Expected, not a defect: reported separately, never on
        // the stocktake list.
        const srcMov = l.movement_id ? movById.get(l.movement_id) : null;
        if (isRepairSeeded({ lotNotes: l.notes, movementNotes: srcMov?.notes })) {
          expected.push({ kind: "lot", id: l.id, verdict: "repair-seeded", detail: `key="${l.variant_key}" received=${l.qty_received} remaining=${l.qty_remaining} — created by ${String(l.notes ?? srcMov?.notes ?? "").match(/repair:[a-z-]+/)?.[0] ?? "a repair run"}; no GRN exists by design` });
          continue;
        }
        if (lensKeys.has(l.variant_key)) refusals.push({ kind: "lot", id: l.id, verdict: "no-document", detail: `key="${l.variant_key}" batch=${l.batch_no ?? "-"} received=${l.qty_received} — no GRN resolves (import-dropped parent?)` });
        continue;
      }
      const g = lotsByGrn.get(gid) ?? { doc: grnsById.get(gid), rows: [] };
      g.rows.push(l);
      lotsByGrn.set(gid, g);
    }
    for (const { doc, rows } of lotsByGrn.values()) {
      const rawLines = grnLinesByDoc.get(doc.id) ?? [];
      const lines = rawLines.map((r) => grnLineEval(doc.grn_number, r));
      const verdicts = planDocKeyAlignment({
        rows: rows.map((l) => ({ id: l.id, ledgerKey: l.variant_key })),
        lines,
      });
      for (const v of verdicts) {
        const l = rows.find((x) => x.id === v.id);
        if (v.verdict === "consistent") continue;
        // Same lens bypass as movements: quote-normalization relabels converge
        // the split bucket even where it is balanced (see above).
        if (!lensKeys.has(l.variant_key) && !(v.verdict === "relabel" && v.normalized)) {
          notice(`  (outside-lens, untouched) lot ${l.id} key="${l.variant_key}" on GRN ${doc.grn_number}: ${v.verdict}`);
          continue;
        }
        if (v.verdict === "relabel") {
          // A lot's consumers follow their MOVEMENT's key; relabelling a lot
          // away from its consumers would break the trigger invariant. Allowed
          // when every consumer's FINAL key equals the new key up to the quote
          // doubling — the consumer converges via its own document in this
          // same run, and the post-plan edge check enforces EXACT final
          // agreement, voiding both sides where it did not.
          const consumers = await pg.unsafe(`
            SELECT DISTINCT c.movement_id::text AS movement_id FROM ${C} c WHERE c.lot_id::text = $1`, [l.id]);
          const badConsumer = consumers.find((cr) => {
            const cm = movById.get(cr.movement_id);
            const finalKey = plannedMovKey.get(cr.movement_id) ?? cm?.variant_key;
            return normalizeVariantKeyQuotes(finalKey ?? "") !== v.newKey;
          });
          if (badConsumer) {
            refusals.push({ kind: "lot", id: l.id, verdict: "consumer-key-mismatch", detail: `doc proves "${v.newKey}" but consumer movement ${badConsumer.movement_id} ends under a different key — ${v.citation?.cite ?? ""}` });
            continue;
          }
          lotPlans.push({ l, newKey: v.newKey, cite: v.citation?.cite ?? "(citation missing)", normalized: v.normalized === true });
          plannedLotKey.set(l.id, v.newKey);
        } else {
          refusals.push({ kind: "lot", id: l.id, verdict: v.verdict, detail: `key="${l.variant_key}" batch=${l.batch_no ?? "-"} on GRN ${doc.grn_number}${v.candidates ? ` candidates [${v.candidates.join(" | ")}]` : ""}` });
        }
      }
    }

    // ── Post-plan consumption-edge check: after BOTH sides planned, every
    // consumption edge (movement <-> lot) must agree EXACTLY on final keys.
    // A planned side whose partner did not converge is VOIDED (refused), and
    // voiding can re-break the partner, so iterate to a fixed point. This is
    // what licenses the normalized in-loop guards above: they admit plans on
    // the promise both sides converge; this check keeps the promise honest.
    {
      const plannedMovIds = movPlans.map((p) => p.m.id);
      const edges = plannedMovIds.length || lotPlans.length
        ? await pg.unsafe(`
            SELECT c.movement_id::text AS movement_id, c.lot_id::text AS lot_id,
                   COALESCE(l.variant_key,'') AS lot_key
              FROM ${C} c JOIN ${L} l ON l.id = c.lot_id
             WHERE c.movement_id::text = ANY($1) OR c.lot_id::text = ANY($2)`,
          [plannedMovIds, lotPlans.map((p) => p.l.id)])
        : [];
      let changed = true;
      while (changed) {
        changed = false;
        for (const e of edges) {
          const cm = movById.get(e.movement_id);
          const movFinal = plannedMovKey.get(e.movement_id) ?? cm?.variant_key ?? null;
          const lotFinal = plannedLotKey.get(e.lot_id) ?? e.lot_key;
          if (movFinal == null || movFinal === lotFinal) continue;
          const mi = movPlans.findIndex((p) => p.m.id === e.movement_id);
          if (mi >= 0) {
            refusals.push({ kind: "movement", id: e.movement_id, verdict: "edge-not-converged", detail: `planned "${movPlans[mi].newKey}" but consumed lot ${e.lot_id} ends at "${lotFinal}" — both sides voided; resolve the lot's document first` });
            plannedMovKey.delete(e.movement_id);
            movPlans.splice(mi, 1);
            changed = true;
          }
          const li2 = lotPlans.findIndex((p) => p.l.id === e.lot_id);
          if (li2 >= 0) {
            refusals.push({ kind: "lot", id: e.lot_id, verdict: "edge-not-converged", detail: `planned "${lotPlans[li2].newKey}" but consumer movement ${e.movement_id} ends at "${movFinal}" — both sides voided; resolve the movement's document first` });
            plannedLotKey.delete(e.lot_id);
            lotPlans.splice(li2, 1);
            changed = true;
          }
          if (mi < 0 && li2 < 0) {
            // Neither side is planned (both already voided or never planned) —
            // nothing further to void on this edge.
          }
        }
      }
    }

    // Receipt-presence guard: an OUT relabelled to a key NOTHING in the family
    // ever received is a shipment with genuinely no receipt — stocktake, not a
    // label move. Matching is quote-normalized: a receipt sitting under the
    // doubled spelling still counts (it converges in this same run when its
    // document resolves; when it cannot, the warning below says so — the
    // relabel is still document-true, but retro-cost's exact-key consume will
    // not reach that receipt until it converges).
    const finalLotKeyOf = (l) => plannedLotKey.get(l.id) ?? l.variant_key;
    const finalMovKeyOf = (m) => plannedMovKey.get(m.id) ?? m.variant_key;
    const receiptFinalKeys = [
      ...lots.filter((l) => Number(l.qty_received) > 0).map((l) => finalLotKeyOf(l)),
      ...movs.filter((m) => String(m.movement_type).toUpperCase() === "IN").map((m) => finalMovKeyOf(m)),
    ];
    const receiptKeys = new Set(receiptFinalKeys);
    const receiptNormKeys = new Set(receiptFinalKeys.map((k) => normalizeVariantKeyQuotes(k)));
    for (let i = movPlans.length - 1; i >= 0; i -= 1) {
      const p = movPlans[i];
      const type = String(p.m.movement_type).toUpperCase();
      if (type !== "OUT") continue;
      if (!receiptNormKeys.has(normalizeVariantKeyQuotes(p.newKey))) {
        refusals.push({ kind: "movement", id: p.m.id, verdict: "no-receipt-in-family", detail: `OUT qty=${p.m.qty} doc proves "${p.newKey}" but the family never received under that key — ${p.cite}` });
        plannedMovKey.delete(p.m.id);
        movPlans.splice(i, 1);
      } else if (!receiptKeys.has(p.newKey)) {
        notice(`  WARNING: OUT ${p.m.id} relabels to "${p.newKey}" whose receipts sit only under a quote-variant spelling that could NOT converge (no document) — retro-cost will not reach them until that receipt's key resolves.`);
      }
    }
    // Doc-CONFIRMED OUTs whose key has no family receipt: the drift is REAL —
    // the paperwork documents the shipment and nothing was ever received under
    // that key anywhere in the family. Report only (basis-cost already covers
    // the COGS side for named DOs; the QUANTITY story is physical-count
    // territory, which is exactly what the stocktake list is for).
    for (const c of consistentLensOuts) {
      if (!receiptNormKeys.has(normalizeVariantKeyQuotes(finalMovKeyOf(c.m)))) {
        refusals.push({ kind: "movement", id: c.m.id, verdict: "documented-shipment-no-receipt", detail: `OUT qty=${c.m.qty} ${c.m.source_doc_type} ${c.m.source_doc_no} — the document CONFIRMS key "${c.m.variant_key}" and the family never received under it; ${c.cite}` });
      }
    }

    // ── Over-consumed lots (2a arm), corrected from the documents.
    const repointPlans = [];
    for (const ol of f.overLots) {
      const l = lots.find((x) => x.id === ol.lot_id);
      if (!l) continue;
      const lotFinalKey = finalLotKeyOf(l);
      const consRows = await pg.unsafe(`
        SELECT id::text AS id, movement_id::text AS movement_id, qty_consumed, unit_cost_sen,
               consumed_at, source_doc_type, source_doc_id::text AS source_doc_id, source_doc_no
          FROM ${C} WHERE lot_id::text = $1 ORDER BY consumed_at, id`, [l.id]);
      if (consRows.some((r) => !r.movement_id)) {
        refusals.push({ kind: "over-consumed", id: l.id, verdict: "orphan-consumptions", detail: "a consumption row names no movement — nothing traceable to re-attribute" });
        continue;
      }
      const consumerIds = [...new Set(consRows.map((r) => r.movement_id))];
      const consumers = consumerIds.map((id) => movById.get(id)).filter(Boolean);
      if (consumers.length !== consumerIds.length) {
        refusals.push({ kind: "over-consumed", id: l.id, verdict: "missing-movement", detail: "a consumption references a movement outside this family or deleted" });
        continue;
      }
      // Single-goods precondition: the lot's document key and every consumer's
      // final key must agree, or the attribution question is cross-goods and
      // no donor answers it.
      const disagree = consumers.filter((m) => finalMovKeyOf(m) !== lotFinalKey);
      if (disagree.length > 0) {
        refusals.push({ kind: "over-consumed", id: l.id, verdict: "doc-conflict", detail: `lot's goods "${lotFinalKey}" vs consumer(s) ${disagree.map((m) => `${m.id} "${finalMovKeyOf(m)}"`).join(", ")} — the documents name different items` });
        continue;
      }
      // Per consuming movement: the DO's documented net qty vs the ledger.
      const movementInputs = [];
      for (const m of consumers) {
        const doc = resolveDoc(m);
        if (!doc || String(m.source_doc_type).toUpperCase() !== "DO") {
          movementInputs.push({ movementId: m.id, absQty: Math.abs(Number(m.qty)), storedTotalCostSen: Number(m.total_cost_sen ?? 0), consumedCostSen: Number(m.consumed_cost ?? 0), docNetQty: null, ledgerShippedQty: null });
          continue;
        }
        const linesRaw = doLinesByDoc.get(doc.id) ?? [];
        const lineIds = linesRaw.map((r) => r.line_id);
        const returned = lineIds.length
          ? await pg.unsafe(`
              SELECT COALESCE(SUM(dri.qty_returned),0)::int AS n
                FROM scm.delivery_return_items dri
                JOIN scm.delivery_returns dr ON dr.id = dri.delivery_return_id
               WHERE dri.do_item_id::text = ANY($1)
                 AND UPPER(COALESCE(dr.status::text,'')) <> 'CANCELLED'`, [lineIds])
          : [{ n: 0 }];
        const docNetQty = linesRaw.reduce((a, r) => a + Number(r.qty ?? 0), 0) - Number(returned[0].n);
        const shipped = await pg.unsafe(`
          SELECT COALESCE(SUM(ABS(qty)),0)::int AS n FROM ${M}
           WHERE movement_type = 'OUT' AND source_doc_type = 'DO'
             AND source_doc_id::text = $1 AND product_code = $2${byCompany ? " AND company_id = $3" : ""}`,
          byCompany ? [doc.id, f.productCode, f.companyId] : [doc.id, f.productCode]);
        movementInputs.push({
          movementId: m.id,
          absQty: Math.abs(Number(m.qty)),
          storedTotalCostSen: Number(m.total_cost_sen ?? 0),
          consumedCostSen: Number(m.consumed_cost ?? 0),
          docNetQty: linesRaw.length === 0 ? null : docNetQty,
          ledgerShippedQty: Number(shipped[0].n),
          docNo: doc.do_number,
        });
      }
      // Donors: sibling lots whose DOCUMENT proves the same goods as this lot.
      const donors = lots
        .filter((x) => x.id !== l.id)
        .map((x) => ({
          lotId: x.id,
          qtyRemaining: Number(x.qty_remaining),
          unitCostSen: Number(x.unit_cost_sen ?? 0),
          receivedAt: x.received_at?.toISOString?.() ?? String(x.received_at),
          docKeyMatches: finalLotKeyOf(x) === lotFinalKey,
          finalKeyMatches: true,
        }));
      const plan = planOverConsumedCorrection({
        lot: { lotId: l.id, qtyReceived: Number(l.qty_received), consumed: Number(l.consumed), qtyRemaining: Number(l.qty_remaining) },
        consumptions: consRows.map((r) => ({ id: r.id, movementId: r.movement_id, qty: Number(r.qty_consumed), unitCostSen: Number(r.unit_cost_sen ?? 0), consumedAt: r.consumed_at?.toISOString?.() ?? String(r.consumed_at) })),
        movements: movementInputs,
        donors,
      });
      notice(`  over-consumed lot ${l.id} "${lotFinalKey}": excess=${plan.excess} -> ${plan.verdict}`);
      for (const mi of movementInputs) {
        notice(`    consumer ${mi.movementId} |qty|=${mi.absQty} ${mi.docNo ? `DO ${mi.docNo} documented-net=${mi.docNetQty} ledger-shipped=${mi.ledgerShippedQty}` : "(no DO document)"}`);
      }
      if (plan.verdict === "repoint") {
        for (const mv of plan.moves) notice(`    MOVE consumption ${mv.consumptionId} (movement ${mv.movementId}): ${mv.qty} unit(s) ${mv.fromLotId} -> ${mv.toLotId} @ ${mv.newUnitCostSen} sen (was ${mv.oldUnitCostSen})`);
        for (const dt of plan.donorTakes) notice(`    DONOR lot ${dt.lotId}: qty_remaining -${dt.qty} (its units are what the DO really shipped)`);
        for (const st of plan.stamps) notice(`    STAMP movement ${st.movementId}: total_cost_sen -> ${st.newTotalCostSen} (delta ${st.deltaSen} sen, reported)`);
        repointPlans.push({ l, plan, consRows });
      } else if (plan.verdict !== "conserves") {
        refusals.push({ kind: "over-consumed", id: l.id, verdict: plan.verdict, detail: JSON.stringify({ excess: plan.excess, overships: plan.overships, donorCapacity: plan.donorCapacity, shortfall: plan.shortfall, conflicts: plan.conflicts }) });
      }
    }

    // ── Plan print + projection.
    notice(`  movement relabels: ${movPlans.length} (${movPlans.filter((p) => p.normalized).length} quote-normalized); lot relabels: ${lotPlans.length} (${lotPlans.filter((p) => p.normalized).length} quote-normalized); over-consumed repoints: ${repointPlans.length}; refusals: ${refusals.length}; repair-seeded (expected): ${expected.length}`);
    for (const p of movPlans) {
      notice(`  RELABEL movement ${p.m.id} ${p.m.movement_type} qty=${p.m.qty} ${p.m.source_doc_type} ${p.m.source_doc_no}${String(p.docStatus ?? "").toUpperCase() === "CANCELLED" ? " (doc CANCELLED)" : ""}`);
      notice(`    "${p.m.variant_key}" -> "${p.newKey}"   evidence: ${p.cite}`);
      if (Number(p.m.consumed) > 0) notice(`    ${p.m.consumed} consumed unit(s) follow (consumption variant_key tracks the movement)`);
    }
    for (const p of lotPlans) {
      notice(`  RELABEL lot ${p.l.id} received=${p.l.qty_received} remaining=${p.l.qty_remaining} batch=${p.l.batch_no ?? "-"}`);
      notice(`    "${p.l.variant_key}" -> "${p.newKey}"   evidence: ${p.cite}`);
    }
    for (const r of refusals) notice(`  REFUSED ${r.kind} ${r.id} (${r.verdict}): ${r.detail}`);
    for (const e of expected) notice(`  EXPECTED ${e.kind} ${e.id} (${e.verdict}): ${e.detail}`);
    for (const e of expected) repairSeeded.push({ family: `${f.productCode} co=${f.companyId} wh=${f.warehouseId}`, ...e });

    if (movPlans.length === 0 && lotPlans.length === 0 && repointPlans.length === 0) {
      notice(`  family: nothing provable from the documents — every candidate row is on the ${refusals.length ? "refusal" : "expected"} list above.`);
      famRefused += 1;
      for (const r of refusals) stocktake.push({ family: `${f.productCode} co=${f.companyId} wh=${f.warehouseId}`, ...r });
      continue;
    }

    // Projection: exact per-bucket (movQty, lotQty) after the plan.
    const projected = new Map();
    const bump = (key, dMov, dLot) => {
      const b = projected.get(key) ?? { movQty: 0, lotQty: 0 };
      b.movQty += dMov; b.lotQty += dLot;
      projected.set(key, b);
    };
    for (const m of movs) {
      const t = String(m.movement_type).toUpperCase();
      const signed = t === "IN" ? Number(m.qty) : t === "OUT" ? -Number(m.qty) : Number(m.qty);
      bump(finalMovKeyOf(m), signed, 0);
    }
    for (const l of lots) bump(finalLotKeyOf(l), 0, Number(l.qty_remaining));
    for (const rp of repointPlans) for (const dt of rp.plan.donorTakes) {
      const donorLot = lots.find((x) => x.id === dt.lotId);
      bump(finalLotKeyOf(donorLot), 0, -dt.qty);
    }
    notice("  projected family buckets after apply (movQty/lotQty):");
    for (const [key, b] of [...projected.entries()].sort()) {
      if (b.movQty === 0 && b.lotQty === 0) continue;
      notice(`    key="${key}": mov=${b.movQty} lot=${b.lotQty} drift=${b.movQty - b.lotQty}${b.movQty - b.lotQty !== 0 ? "  (uncosted OUTs remain until MODE=retro-cost consumes the now-reachable lots)" : ""}`);
    }

    // ── Execute per family — one transaction; CAS everywhere; verify the
    //    observed buckets equal the projection; dry-run rolls back.
    try {
      await pg.begin(async (sql) => {
        for (const p of movPlans) {
          const u = await sql.unsafe(
            `UPDATE ${M} SET variant_key = $1 WHERE id::text = $2 AND COALESCE(variant_key,'') = $3`,
            [p.newKey, p.m.id, p.m.variant_key]);
          if (u.count !== 1) throw new Error(`movement ${p.m.id} changed since the plan (CAS ${u.count}) — family rolled back; re-run the dry run`);
          const k = await sql.unsafe(`UPDATE ${C} SET variant_key = $1 WHERE movement_id::text = $2`, [p.newKey, p.m.id]);
          consFollow += k.count;
        }
        for (const p of lotPlans) {
          const u = await sql.unsafe(
            `UPDATE ${L} SET variant_key = $1 WHERE id::text = $2 AND COALESCE(variant_key,'') = $3`,
            [p.newKey, p.l.id, p.l.variant_key]);
          if (u.count !== 1) throw new Error(`lot ${p.l.id} changed since the plan (CAS ${u.count}) — family rolled back; re-run the dry run`);
        }
        for (const rp of repointPlans) {
          // Group the moves per consumption row: reduce (or fully re-point) the
          // source row, insert the moved slices on their donors. consumed_at is
          // COPIED — the move re-attributes the same physical consumption, so
          // its true date is known (unlike reconstruct, where it was lost).
          const byRow = new Map();
          for (const mv of rp.plan.moves) {
            const arr = byRow.get(mv.consumptionId) ?? [];
            arr.push(mv);
            byRow.set(mv.consumptionId, arr);
          }
          const insertSlice = async (srcId, mv) => sql.unsafe(`
              INSERT INTO ${C} (lot_id, warehouse_id, product_code, variant_key, qty_consumed,
                                unit_cost_sen, total_cost_sen, consumed_at,
                                source_doc_type, source_doc_id, source_doc_no, movement_id, created_by${byCompany ? ", company_id" : ""})
              SELECT $1::uuid, warehouse_id, product_code, variant_key, $2, $3, $4, consumed_at,
                     source_doc_type, source_doc_id, source_doc_no, movement_id, NULL${byCompany ? ", company_id" : ""}
                FROM ${C} WHERE id::text = $5`,
            [mv.toLotId, mv.qty, mv.newUnitCostSen, mv.qty * mv.newUnitCostSen, srcId]);
          for (const [consumptionId, moves] of byRow) {
            const src = rp.consRows.find((r) => r.id === consumptionId);
            const srcQty = Number(src.qty_consumed);
            const totalMove = moves.reduce((a, mv) => a + mv.qty, 0);
            const remainder = srcQty - totalMove;
            if (remainder < 0) throw new Error(`consumption ${consumptionId} plans to move ${totalMove} > its qty ${srcQty} — family rolled back`);
            if (remainder > 0) {
              // Part of the row stays on the original lot at its original cost;
              // the moved slices are fresh rows on their donors.
              const u = await sql.unsafe(
                `UPDATE ${C} SET qty_consumed = $1, total_cost_sen = $2
                  WHERE id::text = $3 AND lot_id::text = $4 AND qty_consumed = $5`,
                [remainder, remainder * Number(src.unit_cost_sen ?? 0), consumptionId, rp.l.id, srcQty]);
              if (u.count !== 1) throw new Error(`consumption ${consumptionId} changed since the plan (CAS ${u.count}) — family rolled back`);
              for (const mv of moves) await insertSlice(consumptionId, mv);
            } else {
              // The whole row moves: re-point it to the first donor slice (the
              // row id and consumed_at survive — this is the same physical
              // consumption, re-attributed), extra slices become fresh rows.
              const first = moves[0];
              const u = await sql.unsafe(
                `UPDATE ${C} SET lot_id = $1::uuid, qty_consumed = $2, unit_cost_sen = $3, total_cost_sen = $4
                  WHERE id::text = $5 AND lot_id::text = $6 AND qty_consumed = $7`,
                [first.toLotId, first.qty, first.newUnitCostSen, first.qty * first.newUnitCostSen, consumptionId, rp.l.id, srcQty]);
              if (u.count !== 1) throw new Error(`consumption ${consumptionId} changed since the plan (CAS ${u.count}) — family rolled back`);
              for (const mv of moves.slice(1)) await insertSlice(consumptionId, mv);
            }
          }
          for (const dt of rp.plan.donorTakes) {
            const donorLot = lots.find((x) => x.id === dt.lotId);
            const u = await sql.unsafe(
              `UPDATE ${L} SET qty_remaining = qty_remaining - $1 WHERE id::text = $2 AND qty_remaining = $3`,
              [dt.qty, dt.lotId, Number(donorLot.qty_remaining)]);
            if (u.count !== 1) throw new Error(`donor lot ${dt.lotId} changed since the plan (CAS ${u.count}) — family rolled back`);
          }
          for (const st of rp.plan.stamps) {
            await sql.unsafe(`
              UPDATE ${M} m SET total_cost_sen = sub.total, unit_cost_sen = CASE WHEN ABS(m.qty) > 0 THEN sub.total / ABS(m.qty) ELSE 0 END
                FROM (SELECT COALESCE(SUM(total_cost_sen),0)::int AS total FROM ${C} WHERE movement_id::text = $1) sub
               WHERE m.id::text = $1`, [st.movementId]);
          }
        }

        // ── VERIFY: observed family buckets must equal the projection exactly.
        const after = await sql.unsafe(`
          WITH mov AS (
            SELECT COALESCE(variant_key,'') AS variant_key,
                   SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                          WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END) AS mov_qty
              FROM ${M} WHERE warehouse_id::text = $1 AND product_code = $2${byCompany ? " AND company_id = $3" : ""}
             GROUP BY COALESCE(variant_key,'')
          ), lot AS (
            SELECT COALESCE(variant_key,'') AS variant_key, SUM(qty_remaining) AS lot_qty
              FROM ${L} WHERE warehouse_id::text = $1 AND product_code = $2${byCompany ? " AND company_id = $3" : ""}
             GROUP BY COALESCE(variant_key,'')
          )
          SELECT COALESCE(mov.variant_key, lot.variant_key) AS variant_key,
                 COALESCE(mov.mov_qty,0) AS mov_qty, COALESCE(lot.lot_qty,0) AS lot_qty
            FROM mov FULL OUTER JOIN lot ON mov.variant_key = lot.variant_key`,
          byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
        for (const row of after) {
          const p = projected.get(String(row.variant_key)) ?? { movQty: 0, lotQty: 0 };
          if (Number(row.mov_qty) !== p.movQty || Number(row.lot_qty) !== p.lotQty) {
            throw new Error(`bucket "${row.variant_key}" reads mov=${row.mov_qty} lot=${row.lot_qty} but the plan projected mov=${p.movQty} lot=${p.lotQty} — family rolled back`);
          }
        }
        // Corrected + donor lots must conserve on the audit's own arms.
        const touchedLotIds = [
          ...repointPlans.map((rp) => rp.l.id),
          ...repointPlans.flatMap((rp) => rp.plan.donorTakes.map((dt) => dt.lotId)),
        ];
        if (touchedLotIds.length) {
          const bad = await sql.unsafe(`
            WITH c AS (SELECT lot_id, SUM(qty_consumed) AS consumed FROM ${C} GROUP BY lot_id)
            SELECT l.id::text AS id FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
             WHERE l.id::text = ANY($1)
               AND (l.qty_received - COALESCE(c.consumed,0) <> l.qty_remaining
                 OR l.qty_remaining < 0 OR COALESCE(c.consumed,0) > l.qty_received OR l.qty_received < 0)`,
            [touchedLotIds]);
          if (bad.length > 0) throw new Error(`lot(s) ${bad.map((b) => b.id).join(", ")} do not conserve after the correction — family rolled back`);
        }
        // Stamped movements: stored total must equal their consumption sum, and
        // no movement may consume more than it moved (audit 10c).
        const movIds = [...new Set(repointPlans.flatMap((rp) => rp.plan.moves.map((mv) => mv.movementId)))];
        if (movIds.length) {
          const chk = await sql.unsafe(`
            WITH c AS (SELECT movement_id, SUM(qty_consumed)::int AS cons, COALESCE(SUM(total_cost_sen),0)::bigint AS cost FROM ${C} GROUP BY movement_id)
            SELECT m.id::text AS id, ABS(m.qty)::int AS abs_qty, m.total_cost_sen, COALESCE(c.cons,0)::int AS cons, COALESCE(c.cost,0)::bigint AS cost
              FROM ${M} m LEFT JOIN c ON c.movement_id = m.id WHERE m.id::text = ANY($1)`, [movIds]);
          for (const r of chk) {
            if (Number(r.cons) > Number(r.abs_qty)) throw new Error(`movement ${r.id} consumes ${r.cons} > |qty| ${r.abs_qty} after repoint — family rolled back`);
            if (Number(r.total_cost_sen ?? 0) !== Number(r.cost)) throw new Error(`movement ${r.id} stored cost ${r.total_cost_sen} != consumption sum ${r.cost} after repoint — family rolled back`);
          }
        }
        if (!APPLY) throw { __rollback: true };
      });
      notice(APPLY
        ? "  APPLIED — relabels + repoints committed; the observed family buckets equal the projection."
        : "  DRY-RUN VERIFIED (then rolled back) — the apply would leave the family exactly on the projection above.");
      famPlanned += 1;
      movRelabels += movPlans.length;
      lotRelabels += lotPlans.length;
      repointMoves += repointPlans.reduce((a, rp) => a + rp.plan.moves.length, 0);
      repointUnits += repointPlans.reduce((a, rp) => a + rp.plan.excess, 0);
      rmDeltaTotal += repointPlans.reduce((a, rp) => a + rp.plan.rmDeltaSen, 0);
      for (const r of refusals) stocktake.push({ family: `${f.productCode} co=${f.companyId} wh=${f.warehouseId}`, ...r });
    } catch (e) {
      if (e && e.__rollback) {
        notice("  DRY-RUN VERIFIED (then rolled back) — the apply would leave the family exactly on the projection above.");
        famPlanned += 1;
        movRelabels += movPlans.length;
        lotRelabels += lotPlans.length;
        repointMoves += repointPlans.reduce((a, rp) => a + rp.plan.moves.length, 0);
        repointUnits += repointPlans.reduce((a, rp) => a + rp.plan.excess, 0);
        rmDeltaTotal += repointPlans.reduce((a, rp) => a + rp.plan.rmDeltaSen, 0);
        for (const r of refusals) stocktake.push({ family: `${f.productCode} co=${f.companyId} wh=${f.warehouseId}`, ...r });
      } else {
        warn(`  family FAILED (rolled back, others unaffected): ${e?.message ?? e}`);
        famRefused += 1;
        for (const r of refusals) stocktake.push({ family: `${f.productCode} co=${f.companyId} wh=${f.warehouseId}`, ...r });
      }
    }
  }

  notice("");
  notice("================ SUMMARY ================");
  notice(`  families examined                          : ${families.size}`);
  notice(`  families ${APPLY ? "repaired" : "that WOULD repair"}                 : ${famPlanned}  (failed/refused wholesale: ${famRefused})`);
  notice(`  movement relabels (doc-proven)             : ${movRelabels}  (consumption rows following: ${consFollow})`);
  notice(`  lot relabels (doc-proven)                  : ${lotRelabels}`);
  notice(`  over-consumed repoints                     : ${repointUnits} unit(s) across ${repointMoves} consumption slice(s)`);
  notice(`  RM delta from repoint cost stamps          : ${rm(rmDeltaTotal)}  (0 = every donor at the same landed cost)`);
  notice("");
  if (repairSeeded.length > 0) {
    notice("================ REPAIR-SEEDED (expected by design — NOT the stocktake list) ================");
    for (const s of repairSeeded) notice(`  ${s.family}  ${s.kind} ${s.id}  ${s.verdict}: ${s.detail}`);
    notice(`  total: ${repairSeeded.length} row(s) created by earlier gated repairs (basis-cost / grn-gap); their missing purchase document is the design, not a defect.`);
    notice("");
  }
  notice("================ STOCKTAKE LIST (documents cannot resolve these — physical count territory) ================");
  if (stocktake.length === 0) {
    notice("  EMPTY — every residual row is resolved by its own paperwork.");
  } else {
    for (const s of stocktake) notice(`  ${s.family}  ${s.kind} ${s.id}  ${s.verdict}: ${s.detail}`);
    notice(`  total: ${stocktake.length} row(s). Nothing above was changed; each line prints the exact document evidence that fell short.`);
  }
  notice("");
  notice("NEXT after APPLY: MODE=retro-cost (relabelled OUTs can now consume the real lots), then Restamp DO");
  notice("actual cost (repointed/re-costed consumptions must flow to DO lines + SIs), then re-run the");
  notice("integrity check + costing audit — sections 1/2a/2b/10a must shrink to exactly the stocktake list.");
  notice(APPLY ? "APPLIED — committed." : "DRY-RUN — every family was exercised inside a transaction and rolled back; nothing was written.");
  notice("=== END ===");
}

const entry = MODE === "relabel" ? runRelabel : MODE === "basis-cost" ? runBasisCost : MODE === "reconstruct" ? runReconstruct : MODE === "doc-relabel" ? runDocRelabel : main;
entry()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("BACKFILL_FIFO_DIVERGENCE_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
