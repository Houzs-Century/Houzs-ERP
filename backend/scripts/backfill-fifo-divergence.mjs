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
// Env: DATABASE_URL (or .dev.vars). APPLY=true to commit (default dry-run).
//      BEFORE_TS=<ISO> optional cutoff (default: now) — only OUTs created before it
//      are eligible, mirroring the function's temporal guard.
// Mirrors the read-only shape of check-inventory-integrity.mjs; this one WRITES
// only under APPLY=true.
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

const APPLY = /^(1|true|yes)$/i.test(process.env.APPLY ?? "");
const BEFORE_TS = process.env.BEFORE_TS || new Date().toISOString();

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

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("BACKFILL_FIFO_DIVERGENCE_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
