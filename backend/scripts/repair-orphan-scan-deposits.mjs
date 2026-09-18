#!/usr/bin/env node
// Repair the orphan scan-deposit double-count (docs/bugs/0785): zero the header
// `scm.mfg_sales_orders.deposit_sen` on scan-origin orders where it is NOT backed
// by an `is_deposit` ledger row AND real payment rows exist — so `soPaidSen`
// ((is_deposit-row ? 0 : deposit_sen) + Σ rows) stops adding the phantom deposit
// on top of the real payments. After the repair, Paid = the ledger sum (the money
// actually collected) and the web / PDF / balance all agree.
//
// DRY-RUN BY DEFAULT. Set MODE=apply to write. Mirrors the repo's other repair
// scripts (align-backfill-*, backfill-*): one idempotent UPDATE, re-evaluated at
// apply time so a row that is no longer orphan is skipped. Exits 0 on success;
// non-zero only for an unreachable DB or a query error.
//
// SCOPE — deliberately EXACTLY the "realized double-count" set:
//   scan-origin (slip_image_key IS NOT NULL), deposit_sen > 0, not CANCELLED,
//   HAS >= 1 payment row, and NO is_deposit row.
// The "at risk" orders (deposit_sen > 0 but ZERO payment rows — e.g. a full
// payment recorded only on the header) are NOT touched: zeroing them would erase
// money that IS displaying correctly today. Those get a proper ledger row by hand
// (they need the payment's method/date/approval, which this repair does not have).
//
// Tables are SCHEMA-QUALIFIED `scm.*` — a raw postgres connection defaults to the
// `public` search_path, where a legacy table still carries pre-0305 `_centi`
// columns (see docs/bugs/0785 and check-orphan-scan-deposits.mjs).
import { readFileSync } from "node:fs";
import postgres from "postgres";

const apply = String(process.env.MODE || "dry-run").toLowerCase() === "apply";

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

const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

// The orphan predicate — identical in the plan SELECT and the apply UPDATE, so
// what you see planned is exactly what gets written (idempotent, self-checking).
// A factory returns a FRESH fragment per query (postgres.js fragments are not
// meant to be reused across executions). References the outer `so` alias.
const orphanWhere = () => pg`
      so.slip_image_key IS NOT NULL
  AND so.deposit_sen > 0
  AND so.status <> 'CANCELLED'
  AND EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments p
              WHERE p.so_doc_no = so.doc_no)
  AND NOT EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments d
                  WHERE d.so_doc_no = so.doc_no AND COALESCE(d.is_deposit, false) = true)`;

try {
  const plan = await pg`
    SELECT so.doc_no,
           so.status,
           so.deposit_sen,
           so.total_revenue_sen,
           COALESCE((SELECT sum(p.amount_sen) FROM scm.mfg_sales_order_payments p
                     WHERE p.so_doc_no = so.doc_no), 0)                  AS ledger_sum_sen,
           COALESCE((SELECT count(*) FROM scm.mfg_sales_order_payments p
                     WHERE p.so_doc_no = so.doc_no), 0)                  AS payment_rows
    FROM scm.mfg_sales_orders so
    WHERE ${orphanWhere()}
    ORDER BY so.deposit_sen DESC`;

  // Informational only: the AT-RISK set the repair intentionally does NOT touch.
  const atRisk = await pg`
    SELECT count(*)::int AS n
    FROM scm.mfg_sales_orders so
    WHERE so.slip_image_key IS NOT NULL
      AND so.deposit_sen > 0
      AND so.status <> 'CANCELLED'
      AND NOT EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no = so.doc_no)`;

  const totalOvercount = plan.reduce((s, r) => s + Number(r.deposit_sen ?? 0), 0);

  console.log(`MODE: ${apply ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);
  console.log(`Orphan orders to repair: ${plan.length}  |  phantom deposit to remove: ${rm(totalOvercount)}`);
  console.log(`AT-RISK (NOT touched — no payment rows, needs a manual ledger row): ${atRisk[0]?.n ?? 0}\n`);

  if (plan.length > 0) {
    console.log("doc_no            status        deposit(zero)  paid: now  -> after   balance: now -> after");
    for (const r of plan) {
      const dep = Number(r.deposit_sen ?? 0);
      const ledger = Number(r.ledger_sum_sen ?? 0);
      const total = Number(r.total_revenue_sen ?? 0);
      const paidNow = dep + ledger;          // soPaidSen today (no is_deposit row)
      const paidAfter = ledger;              // after deposit_sen -> 0
      const balNow = total - paidNow;
      const balAfter = total - paidAfter;
      console.log(
        `${String(r.doc_no).padEnd(17)} ${String(r.status).padEnd(13)} ` +
        `${rm(dep).padStart(11)}   ${rm(paidNow).padStart(10)} -> ${rm(paidAfter).padStart(10)}   ` +
        `${rm(balNow).padStart(10)} -> ${rm(balAfter).padStart(10)}`,
      );
    }
    console.log("");
  }

  if (!apply) {
    console.log("DRY-RUN only — nothing was written. Re-run with MODE=apply to zero the phantom deposits above.");
  } else {
    const res = await pg`
      UPDATE scm.mfg_sales_orders so
      SET deposit_sen = 0, updated_at = now()
      WHERE ${orphanWhere()}`;
    console.log(`APPLIED — zeroed deposit_sen on ${res.count} order(s).`);
    const left = await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders so WHERE ${orphanWhere()}`;
    console.log(`Remaining orphan orders after repair: ${left[0]?.n ?? 0} (should be 0).`);
  }
} finally {
  await pg.end({ timeout: 5 });
}
