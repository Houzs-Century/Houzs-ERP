#!/usr/bin/env node
// Read-only audit: scan-origin Sales Orders whose header `deposit_sen` is an
// ORPHAN — a paid figure with no `is_deposit` ledger row to back it — so the
// paid rollup (`soPaidSen`) double-counts it once any payment is recorded.
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// The answer lives only in production, and the owner rule (CLAUDE.md) is that a
// production fact is a script + a manual workflow reading `secrets.DATABASE_URL`,
// NOT a SELECT pasted into chat for a human holding the DSN to run. This is the
// diagnostic half of docs/bugs/0785-* ("A receiptless scan draft double-counted
// its deposit"): the code fix stops NEW orders orphaning a header deposit; this
// lists the orders ALREADY in that state so a repair can be decided. It writes
// NOTHING — the repair (zeroing the orphan `deposit_sen`) is a separate,
// owner-approved change.
//
// THE ROLLUP, restated (backend/src/scm/shared/so-outstanding.ts:102):
//   paid = (an is_deposit ledger row exists ? 0 : header deposit_sen)
//          + Σ (all ledger rows)
// So a header deposit with NO is_deposit row is added ON TOP of every ordinary
// payment row. For a SCAN order that is a bug: the slip's handwritten deposit was
// stamped on the header automatically, and the operator later re-entered the SAME
// money as an ordinary payment — the header copy is phantom.
//
// SCOPE = scan-origin only (`slip_image_key IS NOT NULL`). A LEGACY migrated SO
// legitimately carries a header-only deposit that a later balance payment adds
// ON TOP of (different money) — including it would be a false positive. Scan
// orders are the population whose header deposit and manual payment are the SAME
// money, which is exactly the double this audit is for.
//
// Two buckets, both surfaced:
//   REALIZED — deposit_sen > 0, no is_deposit row, AND >= 1 payment row.
//              The paid aggregate over-states by `deposit_sen` right now.
//   AT RISK  — deposit_sen > 0, no is_deposit row, and ZERO payment rows.
//              Not doubled yet, but the header deposit is unbacked (and may be a
//              slip-read figure never actually collected) — verify before a
//              payment is added and doubles it.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer (finding zero orphans is a valid answer, not a failure);
// only an unreachable database or a query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs / check-soak-gate.mjs: env wins so CI
// needs no .dev.vars. Match only the field we want and never fall through to the
// raw line (CLAUDE.md: never print a secret-bearing line).
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

// `notice` surfaces the verdict on the workflow run's summary page, so the answer
// is readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

// 100 sen = RM 1.
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ONE statement. Per-SO payment aggregates joined to the scan-origin header,
  // filtered to orphan deposits (no is_deposit row backs deposit_sen).
  const rows = await pg`
    SELECT so.doc_no,
           so.status,
           so.company_id,
           so.deposit_sen,
           so.total_revenue_sen,
           COALESCE(p.row_count, 0)                              AS payment_rows,
           COALESCE(p.total_sum, 0)                              AS ledger_sum_sen,
           COALESCE(p.non_deposit_sum, 0)                        AS non_deposit_sum_sen,
           -- what the rollup currently SHOWS as paid:
           ((CASE WHEN COALESCE(p.has_deposit, false) THEN 0 ELSE so.deposit_sen END)
             + COALESCE(p.total_sum, 0))                         AS shown_paid_sen,
           -- the phantom amount the header adds on top of the ledger:
           so.deposit_sen                                        AS overcount_sen,
           -- high-confidence flag: a booked payment equals the header deposit,
           -- i.e. the operator re-entered the SAME money the slip put on the header.
           (COALESCE(p.non_deposit_sum, 0) >= so.deposit_sen)    AS non_deposit_covers_deposit
    FROM mfg_sales_orders so
    LEFT JOIN (
      SELECT so_doc_no,
             count(*)                                                             AS row_count,
             sum(amount_sen)                                                      AS total_sum,
             sum(amount_sen) FILTER (WHERE NOT COALESCE(is_deposit, false))       AS non_deposit_sum,
             bool_or(COALESCE(is_deposit, false))                                 AS has_deposit
      FROM mfg_sales_order_payments
      GROUP BY so_doc_no
    ) p ON p.so_doc_no = so.doc_no
    WHERE so.slip_image_key IS NOT NULL           -- scan-origin only
      AND so.deposit_sen > 0
      AND COALESCE(p.has_deposit, false) = false  -- no is_deposit row backs the header
      AND so.status <> 'CANCELLED'
    ORDER BY (COALESCE(p.row_count, 0) > 0) DESC, so.deposit_sen DESC`;

  const realized = rows.filter((r) => Number(r.payment_rows) > 0);
  const atRisk = rows.filter((r) => Number(r.payment_rows) === 0);
  const overcountTotal = realized.reduce((s, r) => s + Number(r.overcount_sen ?? 0), 0);

  if (rows.length === 0) {
    notice("NO ORPHAN SCAN DEPOSITS — every scan-origin SO with a header deposit has a backing is_deposit ledger row. Nothing to repair.");
  } else {
    notice(`ORPHAN SCAN DEPOSITS FOUND — ${rows.length} SO(s): ${realized.length} already double-counting (over-stated Paid by ${rm(overcountTotal)} total), ${atRisk.length} at risk.`);
    notice("This audit WROTE NOTHING. The repair (zeroing each orphan deposit_sen) is a separate, owner-approved change — see docs/bugs/0785-*.");

    if (realized.length > 0) {
      console.log(`\n=== REALIZED DOUBLE-COUNT (${realized.length}) — Paid is over-stated NOW, balance-to-collect is understated ===`);
      console.log("doc_no            status      deposit     shown_paid   ledger_sum   rows  same-money");
      for (const r of realized) {
        console.log(
          `${String(r.doc_no).padEnd(17)} ${String(r.status).padEnd(11)} ` +
          `${rm(r.deposit_sen).padStart(11)} ${rm(r.shown_paid_sen).padStart(12)} ` +
          `${rm(r.ledger_sum_sen).padStart(12)} ${String(r.payment_rows).padStart(4)}  ` +
          `${r.non_deposit_covers_deposit ? "yes" : "check"}`,
        );
      }
    }

    if (atRisk.length > 0) {
      console.log(`\n=== AT RISK (${atRisk.length}) — header deposit, no payment rows yet; verify the deposit was really collected before a payment doubles it ===`);
      console.log("doc_no            status      deposit     total_rev");
      for (const r of atRisk) {
        console.log(
          `${String(r.doc_no).padEnd(17)} ${String(r.status).padEnd(11)} ` +
          `${rm(r.deposit_sen).padStart(11)} ${rm(r.total_revenue_sen).padStart(11)}`,
        );
      }
    }
    console.log("");
  }
} finally {
  await pg.end({ timeout: 5 });
}
