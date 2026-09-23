#!/usr/bin/env node
// Make `scm.mfg_sales_orders.open_to_all` agree with the rule in
// scripts/lib/so-open-to-all-rule.mjs: OPEN the imported AutoCount orders that
// are still outstanding, WITHDRAW the flag from every other order.
//
// WHY THIS EXISTS — and what it replaces. On 2026-09-11 the owner opened the
// whole go-live import ("把这些 sales order open to all") and
// backfill-so-open-to-all.mjs flipped all 2,882 of them. On 2026-09-23, after
// tracing why a Sales Executive could edit HC-SO-003645 (he is neither its
// salesperson nor on its share list — `open_to_all` short-circuits
// soDocOutOfScope, which the SO WRITE gate selfScopedSalesBlocked calls too),
// the owner narrowed it: 「未交完的 2,580 张保持 open,其余收回去」. This
// script is that ruling, and it SUPERSEDES the backfill — which is deleted in
// the same PR, because re-running it would re-open the finished orders this
// closes. One rule, one writer.
//
// RECONCILER, NOT A ONE-SHOT. It converges in both directions, so it is also
// the answer to "an order finished after the last run": run it again and the
// flag follows the status. Nothing flips the flag automatically when a status
// changes — deliberately: an automatic withdraw belongs in a trigger or the
// status transition itself, and neither is this script's decision to take.
//
// THE PLAN IS THE WRITE. Rows are classified in JS by the shared rule, and the
// UPDATEs then name the exact doc_nos that were printed (`= ANY($1)`) rather
// than re-deriving a predicate in SQL. A second copy of the predicate is how a
// preview and an apply come to disagree, and here the disagreement would be
// silent.
//
// PLAN BY DEFAULT. Prints the counts, the status breakdown and samples, and
// writes nothing unless MODE=apply (or --apply) AND CONFIRM is the spelled-out
// phrase below — a row count is not a confirmation. After writing it re-reads
// on a SECOND, FRESH connection and asserts every row now agrees with the rule
// (the session that wrote is the worst witness).
//
// SAFETY. One column, two UPDATEs. scm.mfg_sales_orders' triggers are
// canonicalize_venue (UPDATE OF venue) and sync_access_staff_ids (UPDATE OF
// salesperson_id / collaborator_staff_ids / access_staff_ids) — neither fires
// for an open_to_all-only write. There is no updated_at trigger (the API owns
// that column), so this cannot nudge an updated_at-watermark AutoCount delta
// sync, and `open_to_all` has no counterpart in the book at all. Nothing here
// reaches AutoCount.
//
// RE-RUN: safe, idempotent and expected. A second run re-reads the corpus and
// plans only the DIFFERENCE, so an already-reconciled tree reports "nothing to
// do" and writes nothing; run it again after more orders are delivered and it
// withdraws exactly those.
//
// Exits 0 for every legitimate answer (dry run, applied, nothing to do); 2 when
// CONFIRM is missing on the apply path; 1 only for an unreachable database or a
// failed verification.
//
// Usage:
//   npx tsx scripts/reconcile-so-open-to-all.mjs
//   MODE=apply CONFIRM='open outstanding sales orders only' \
//     npx tsx scripts/reconcile-so-open-to-all.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
/* The came-FROM-AutoCount rule, in ITS one home — the same module the app's
   own guards decide with, so this cannot answer a different question from the
   thing it is reconciling. `linked_ac_docno IS NOT NULL` is NOT that rule: the
   write-back stamps it on the ERP's own orders (docs/bugs/0703). */
import { soIsMigratedShape } from "../src/scm/lib/so-is-migrated.ts";
import { planOpenToAll, shouldBeOpenToAll } from "./lib/so-open-to-all-rule.mjs";

const APPLY = process.argv.includes("--apply") || process.env.MODE === "apply";
// A phrase typed on purpose, not CONFIRM=1 — guards the apply path.
const CONFIRM_PHRASE = "open outstanding sales orders only";

// Same resolution order as pg-migrate.mjs / check-soak-gate.mjs: env wins so CI
// needs no .dev.vars. Match only the field and print nothing of the file.
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

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(
    `Refusing to apply: set CONFIRM='${CONFIRM_PHRASE}' to write. Nothing changed.`,
  );
  process.exit(2);
}

// `notice` surfaces the verdict on the workflow run's summary page.
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const warn = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `WARNING: ${msg}`);

const tally = (rows, pick) => {
  const m = new Map();
  for (const r of rows) m.set(pick(r), (m.get(pick(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join("  ");
};

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  /* The whole header corpus — a few thousand rows, four columns. Classifying in
     JS by the real module is what check-so-open-for-new.mjs already does, and it
     is the only way this script is guaranteed to agree with the app. */
  const headers = await pg`
    SELECT doc_no, linked_ac_docno, status, open_to_all, company_id
      FROM scm.mfg_sales_orders`;

  const rows = headers.map((r) => ({
    docNo: r.doc_no,
    status: r.status,
    openToAll: r.open_to_all === true,
    isMigrated: soIsMigratedShape(r.doc_no, r.linked_ac_docno),
  }));

  const { toOpen, toClose, wantOpen } = planOpenToAll(rows);
  const openNow = rows.filter((r) => r.openToAll);
  const closing = rows.filter((r) => toClose.includes(r.docNo));

  notice(`Sales Orders total                 : ${rows.length}`);
  notice(`  imported (AutoCount shape)       : ${rows.filter((r) => r.isMigrated).length}`);
  notice(`  open_to_all NOW                  : ${openNow.length}`);
  notice(`  open_to_all BY THE RULE          : ${wantOpen.length}   [imported AND not terminal]`);
  notice(`  to OPEN  -> true                 : ${toOpen.length}`);
  notice(`  to CLOSE -> false                : ${toClose.length}`);
  if (closing.length > 0) notice(`  closing, by status               : ${tally(closing, (r) => r.status ?? "(null)")}`);
  if (toClose.length > 0) notice(`  close samples: ${toClose.slice(0, 5).join(", ")}`);
  if (toOpen.length > 0) notice(`  open  samples: ${toOpen.slice(0, 5).join(", ")}`);

  if (toOpen.length === 0 && toClose.length === 0) {
    notice("Nothing to do — every order already agrees with the rule.");
  } else if (!APPLY) {
    notice(`DRY RUN — nothing written. Re-run with MODE=apply and CONFIRM='${CONFIRM_PHRASE}'.`);
  } else {
    if (toClose.length > 0) {
      const closed = await pg`
        UPDATE scm.mfg_sales_orders SET open_to_all = false
         WHERE doc_no = ANY(${toClose}) AND open_to_all = true
        RETURNING doc_no`;
      notice(`APPLIED — withdrew open_to_all from ${closed.length} order(s).`);
    }
    if (toOpen.length > 0) {
      const opened = await pg`
        UPDATE scm.mfg_sales_orders SET open_to_all = true
         WHERE doc_no = ANY(${toOpen}) AND open_to_all = false
        RETURNING doc_no`;
      notice(`APPLIED — opened ${opened.length} order(s).`);
    }

    /* Fresh-connection verification. Not a row count: re-read the corpus, run
       the SAME rule over it, and assert nothing disagrees. */
    const verify = postgres(url, { ssl: "require", prepare: false, max: 1 });
    try {
      const after = await verify`
        SELECT doc_no, linked_ac_docno, status, open_to_all
          FROM scm.mfg_sales_orders`;
      const wrong = after.filter((r) =>
        (r.open_to_all === true) !== shouldBeOpenToAll({
          isMigrated: soIsMigratedShape(r.doc_no, r.linked_ac_docno),
          status: r.status,
        }));
      const openAfter = after.filter((r) => r.open_to_all === true);
      notice(`verify (fresh conn): open_to_all = true on ${openAfter.length} order(s); ${wrong.length} disagree with the rule.`);
      if (wrong.length > 0) {
        console.error(`VERIFY FAILED — ${wrong.length} order(s) disagree, e.g. ${wrong.slice(0, 5).map((r) => `${r.doc_no}(${r.status}, open=${r.open_to_all})`).join(", ")}`);
        process.exitCode = 1;
      } else {
        notice("verify OK — every order's open_to_all now matches the rule.");
      }
    } finally {
      await verify.end({ timeout: 5 });
    }
  }

  if (!APPLY) warn("Read-only run: this script wrote nothing.");
} finally {
  await pg.end({ timeout: 5 });
}
