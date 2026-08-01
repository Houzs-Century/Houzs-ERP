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
// Env: DATABASE_URL (or .dev.vars). APPLY=true to commit (default dry-run).
//      MODE=retro-cost | relabel | basis-cost   (default retro-cost)
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
} from "./lib/ledger-repair-core.mjs";

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
if (!["retro-cost", "relabel", "basis-cost", "reconstruct"].includes(MODE)) {
  console.error(`MODE must be retro-cost | relabel | basis-cost | reconstruct (got "${MODE}")`);
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
  notice("=== FIFO LEDGER DIVERGENCE — RECONSTRUCT DROPPED CONSUMPTIONS (W4 phase 1) ===");
  notice(`mode: ${APPLY ? "APPLY (writes COMMITTED)" : "DRY-RUN (writes exercised per family, then ROLLED BACK — nothing persisted)"}`);
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

  // Families = distinct (company, warehouse, product) of the 2a-violating lots.
  const deficitLots = await pg.unsafe(`
    WITH c AS (SELECT lot_id, SUM(qty_consumed)::int AS consumed FROM ${C} GROUP BY lot_id)
    SELECT l.id::text AS lot_id, ${byCompany ? "l.company_id" : "NULL::int AS company_id"},
           l.warehouse_id::text AS warehouse_id, l.product_code,
           COALESCE(l.variant_key,'') AS variant_key, l.batch_no,
           l.qty_received, l.qty_remaining, COALESCE(c.consumed,0)::int AS consumed,
           l.unit_cost_sen, l.received_at
      FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
     WHERE l.qty_received - COALESCE(c.consumed,0) - l.qty_remaining > 0
     ORDER BY l.received_at, l.id`);
  notice(`lots violating conservation (received - consumed != remaining; the audit-2a lens): ${deficitLots.length}`);
  if (deficitLots.length === 0) {
    notice("Nothing to reconstruct — every lot conserves. (Audit 2a / 10a clean.)");
    notice("=== END ===");
    return;
  }

  const famKey = (r) => `${r.company_id ?? ""}::${r.warehouse_id}::${r.product_code}`;
  const families = new Map();
  for (const l of deficitLots) {
    const k = famKey(l);
    const f = families.get(k) ?? { companyId: l.company_id, warehouseId: l.warehouse_id, productCode: l.product_code, lots: [] };
    f.lots.push(l);
    families.set(k, f);
  }
  notice(`families (company, warehouse, product) to examine: ${families.size}`);

  let familiesPlanned = 0, familiesRefused = 0, rowsPlanned = 0, rmStamped = 0;
  for (const f of families.values()) {
    notice("");
    notice(`----- family ${f.productCode} co=${f.companyId ?? "-"} wh=${f.warehouseId} -----`);
    // Movement side: every consuming movement of the family (ANY sibling
    // variant key — the split is exactly why the keys cannot pre-filter).
    const movs = await pg.unsafe(`
      SELECT m.id::text AS id, m.movement_type, m.qty, COALESCE(m.variant_key,'') AS variant_key,
             m.total_cost_sen, m.created_at, m.source_doc_type, m.source_doc_id::text AS source_doc_id,
             m.source_doc_no, COALESCE(c.cons,0)::int AS consumed, COALESCE(c.cons_cost,0)::bigint AS consumed_cost
        FROM ${M} m
        LEFT JOIN (SELECT movement_id, SUM(qty_consumed)::int AS cons, COALESCE(SUM(total_cost_sen), 0)::bigint AS cons_cost FROM ${C} GROUP BY movement_id) c
          ON c.movement_id = m.id
       WHERE (m.movement_type = 'OUT' OR (m.movement_type = 'ADJUSTMENT' AND m.qty < 0))
         AND m.warehouse_id::text = $1 AND m.product_code = $2${byCompany ? " AND m.company_id = $3" : ""}
       ORDER BY m.created_at, m.id`,
      byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);

    const plan = planFamilyReconstruction({
      movements: movs.map((m) => ({
        movementId: m.id, qty: m.qty, alreadyConsumed: m.consumed,
        alreadyConsumedCostSen: Number(m.consumed_cost ?? 0),
        totalCostSen: m.total_cost_sen, createdAt: m.created_at?.toISOString?.() ?? String(m.created_at),
      })),
      lots: f.lots.map((l) => ({
        lotId: l.lot_id, qtyReceived: l.qty_received, qtyRemaining: l.qty_remaining,
        consumed: l.consumed, unitCostSen: l.unit_cost_sen,
        receivedAt: l.received_at?.toISOString?.() ?? String(l.received_at),
      })),
    });

    // BOTH sides printed row by row, verdict or not — this output is the
    // diagnosis the relabel could not give.
    notice(`  movement shortfalls (${plan.shorts.length}):`);
    for (const s of plan.shorts) {
      const m = movs.find((x) => x.id === s.movementId);
      notice(`    movement ${s.movementId}  ${m?.movement_type} qty=${m?.qty} key="${m?.variant_key}" cost=${rm(m?.total_cost_sen)}  ${m?.source_doc_type ?? "-"} ${m?.source_doc_no ?? "-"}  shortfall=${s.shortfall}`);
    }
    notice(`  lot deficits (${plan.deficits.length}):`);
    for (const d of plan.deficits) {
      const l = f.lots.find((x) => x.lot_id === d.lotId);
      notice(`    lot ${d.lotId}  key="${l?.variant_key}" batch=${l?.batch_no ?? "-"} recv=${l?.qty_received} cons=${l?.consumed} rem=${l?.qty_remaining} @ ${rm(l?.unit_cost_sen)}/u  deficit=${d.deficit}`);
    }
    if (plan.verdict !== "reconstruct") {
      notice(`  REFUSED (${plan.verdict})${plan.verdict === "sums-mismatch" ? ` — Sigma(shortfall)=${plan.totalShort} != Sigma(deficit)=${plan.totalDeficit}; the two sides do not describe the same missing rows` : ""}${plan.conflicts ? ` — cost conflicts: ${plan.conflicts.map((cf) => `${cf.movementId} stored ${rm(cf.storedCostSen)} vs existing-rows ${rm(cf.existingConsumedCostSen)} + paired ${rm(cf.pairedCostSen)}`).join("; ")}` : ""}`);
      familiesRefused += 1;
      continue;
    }
    notice(`  PLAN — ${plan.pairs.length} consumption row(s) to reconstruct:`);
    for (const pr of plan.pairs) notice(`    movement ${pr.movementId} <- lot ${pr.lotId}: qty=${pr.qty} @ ${pr.unitCostSen} sen = ${rm(pr.qty * pr.unitCostSen)}`);
    if (plan.stamps.length) {
      notice(`  movements whose cost stamps FROM the new rows (stored cost was 0): ${plan.stamps.length}  (RM impact ${rm(plan.rmStampedSen)})`);
      for (const s of plan.stamps) notice(`    movement ${s.movementId} -> total_cost_sen ${s.newTotalCostSen}`);
    } else {
      notice("  every movement's stored cost EQUALS its paired cost — pure re-link, RM impact 0");
    }

    // Execute per family — commit under APPLY, rolled back for dry-run — with
    // an in-transaction CAS: the family is re-planned from fresh reads and
    // must produce the identical pairing, or nothing is written for it.
    try {
      await pg.begin(async (sql) => {
        const freshLots = await sql.unsafe(`
          WITH c AS (SELECT lot_id, SUM(qty_consumed)::int AS consumed FROM ${C} GROUP BY lot_id)
          SELECT l.id::text AS lot_id, l.qty_received, l.qty_remaining, COALESCE(c.consumed,0)::int AS consumed,
                 l.unit_cost_sen, l.received_at
            FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
           WHERE l.warehouse_id::text = $1 AND l.product_code = $2${byCompany ? " AND l.company_id = $3" : ""}
             AND l.qty_received - COALESCE(c.consumed,0) - l.qty_remaining > 0
           ORDER BY l.received_at, l.id FOR UPDATE OF l`,
          byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
        const freshMovs = await sql.unsafe(`
          SELECT m.id::text AS id, m.qty, m.total_cost_sen, m.created_at, COALESCE(c.cons,0)::int AS consumed, COALESCE(c.cons_cost,0)::bigint AS consumed_cost
            FROM ${M} m
            LEFT JOIN (SELECT movement_id, SUM(qty_consumed)::int AS cons, COALESCE(SUM(total_cost_sen), 0)::bigint AS cons_cost FROM ${C} GROUP BY movement_id) c
              ON c.movement_id = m.id
           WHERE (m.movement_type = 'OUT' OR (m.movement_type = 'ADJUSTMENT' AND m.qty < 0))
             AND m.warehouse_id::text = $1 AND m.product_code = $2${byCompany ? " AND m.company_id = $3" : ""}
           ORDER BY m.created_at, m.id`,
          byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
        const fresh = planFamilyReconstruction({
          movements: freshMovs.map((m) => ({ movementId: m.id, qty: m.qty, alreadyConsumed: m.consumed, alreadyConsumedCostSen: Number(m.consumed_cost ?? 0), totalCostSen: m.total_cost_sen, createdAt: m.created_at?.toISOString?.() ?? String(m.created_at) })),
          lots: freshLots.map((l) => ({ lotId: l.lot_id, qtyReceived: l.qty_received, qtyRemaining: l.qty_remaining, consumed: l.consumed, unitCostSen: l.unit_cost_sen, receivedAt: l.received_at?.toISOString?.() ?? String(l.received_at) })),
        });
        if (fresh.verdict !== "reconstruct" || JSON.stringify(fresh.pairs) !== JSON.stringify(plan.pairs)) {
          throw new Error(`family changed since the plan (fresh verdict ${fresh.verdict}) — nothing written for it; re-run the dry run`);
        }
        const movById = new Map(movs.map((m) => [m.id, m]));
        const lotById = new Map(f.lots.map((l) => [l.lot_id, l]));
        for (const pr of plan.pairs) {
          const m = movById.get(pr.movementId);
          const l = lotById.get(pr.lotId);
          await sql.unsafe(`
            INSERT INTO ${C} (
              lot_id, warehouse_id, product_code, variant_key,
              qty_consumed, unit_cost_sen, total_cost_sen,
              source_doc_type, source_doc_id, source_doc_no, movement_id, created_by, company_id
            ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11::uuid, NULL, $12)`,
            [pr.lotId, f.warehouseId, f.productCode, m.variant_key,
              pr.qty, pr.unitCostSen, pr.qty * pr.unitCostSen,
              m.source_doc_type, m.source_doc_id, m.source_doc_no, pr.movementId,
              l.company_id ?? f.companyId]);
        }
        for (const s of plan.stamps) {
          await sql.unsafe(`
            UPDATE ${M} m SET total_cost_sen = sub.total, unit_cost_sen = CASE WHEN ABS(m.qty) > 0 THEN sub.total / ABS(m.qty) ELSE 0 END
              FROM (SELECT COALESCE(SUM(total_cost_sen),0)::int AS total FROM ${C} WHERE movement_id = $1::uuid) sub
             WHERE m.id = $1::uuid`, [s.movementId]);
        }
        // Verify: the family's 2a lens must read CLEAN now.
        const after = await sql.unsafe(`
          WITH c AS (SELECT lot_id, SUM(qty_consumed)::int AS consumed FROM ${C} GROUP BY lot_id)
          SELECT count(*)::int AS n FROM ${L} l LEFT JOIN c ON c.lot_id = l.id
           WHERE l.warehouse_id::text = $1 AND l.product_code = $2${byCompany ? " AND l.company_id = $3" : ""}
             AND l.qty_received - COALESCE(c.consumed,0) - l.qty_remaining <> 0`,
          byCompany ? [f.warehouseId, f.productCode, f.companyId] : [f.warehouseId, f.productCode]);
        if (Number(after[0].n) !== 0) throw new Error(`family still has ${after[0].n} non-conserving lot(s) after reconstruction — rolled back`);
        if (!APPLY) throw { __rollback: true };
      });
      notice(APPLY ? `  APPLIED — ${plan.pairs.length} consumption row(s) written; family conserves.` : "  DRY-RUN VERIFIED (then rolled back) — the apply would leave every lot of this family conserving.");
      familiesPlanned += 1;
      rowsPlanned += plan.pairs.length;
      rmStamped += plan.rmStampedSen;
    } catch (e) {
      if (e && e.__rollback) {
        notice("  DRY-RUN VERIFIED (then rolled back) — the apply would leave every lot of this family conserving.");
        familiesPlanned += 1;
        rowsPlanned += plan.pairs.length;
        rmStamped += plan.rmStampedSen;
      } else {
        warn(`  family FAILED (rolled back, others unaffected): ${e?.message ?? e}`);
        familiesRefused += 1;
      }
    }
  }

  notice("");
  notice("================ SUMMARY ================");
  notice(`  families ${APPLY ? "reconstructed" : "that WOULD reconstruct"} : ${familiesPlanned}`);
  notice(`  consumption rows ${APPLY ? "written" : "planned"}          : ${rowsPlanned}`);
  notice(`  RM stamped onto zero-cost movements       : ${rm(rmStamped)}  (0 = pure re-link)`);
  notice(`  families refused (evidence does not pair) : ${familiesRefused}`);
  notice("");
  notice("NEXT: run MODE=relabel — the reconstructed rows are the lot evidence it demands; the paired");
  notice("+/- drift (audit 1 and 2b) closes there, at RM0. Then re-run the integrity check + audit.");
  notice(APPLY ? "APPLIED — committed." : "DRY-RUN — every family was exercised inside a transaction and rolled back; nothing was written.");
  notice("=== END ===");
}

const entry = MODE === "relabel" ? runRelabel : MODE === "basis-cost" ? runBasisCost : MODE === "reconstruct" ? runReconstruct : main;
entry()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("BACKFILL_FIFO_DIVERGENCE_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
