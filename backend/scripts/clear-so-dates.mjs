#!/usr/bin/env node
// ---------------------------------------------------------------------------
// clear-so-dates.mjs — remove ONE sales order's Processing Date and Delivery
// Date, and prove nothing else on it moved.
//
// Owner, 2026-09-09, on HC-SO-013495: 「这个remove掉processing date和delivery
// date」 and 「我让sales 重新proceed」. His reason, in his own logic: the colour
// is `tbc`, so the factory cannot build it, so it cannot really be in
// production. Sales re-proceeds it once a colour is chosen.
//
// THIS IS THE FIRST TIME A PROCEED DATE HAS BEEN CLEARED HERE, and it is a
// production write on a live order, so the whole script is built around one
// question: did anything ELSE move? The answer is not a row count. It is
// scripts/lib/so-date-clear-plan.mjs asserting, column by column, that the two
// dates went to NULL, that `version` bumped by exactly one, and that every
// other column of the header and of every line came back byte-identical.
//
// ── WHICH COLUMNS ───────────────────────────────────────────────────────────
//   processing_date         THE name. Migration 0286 renamed
//                           internal_expected_dd; `proceeded_at` is a retired
//                           twin. Naming a dead one is 42703, which fails the
//                           WHOLE statement — a "0 defects" run that touched one
//                           reported nothing at all. The spelling is pinned by
//                           tests/soDateClearPlan.test.mjs.
//   customer_delivery_date  the HEADER's delivery date: the column
//                           soDatePairCascadeColumns names when a Processing
//                           Date clear cascades, and the one apply_so_header_cas
//                           writes through p_delivery_date. NOT
//                           amended_delivery_date (a confirmed reschedule; NULL
//                           here) and NOT line_delivery_date (the mirror).
//   version                 the optimistic-concurrency token. Bumped by one, as
//                           the header PATCH does — otherwise a browser holding
//                           the pre-clear form saves afterwards and puts both
//                           dates straight back.
//   line_delivery_date /    the per-line MIRROR of the header date, cleared the
//   line_delivery_date_     way apply_so_header_cas clears it. Not a line edit:
//   overridden              one fact stored twice. Leaving it is a HALF clear —
//                           effectiveSoDelivery falls through to it as a last
//                           resort, so the order would still read as dated
//                           demand to MRP, the allocator and the delivery board.
//
// Nothing else. No status (measured: this order is CONFIRMED, and
// statusAfterProcessingDateCleared only ever moves an order OUT of
// IN_PRODUCTION, so there is no move to make). No payment column — 「多收钱也
// ok」 means those are never re-derived. No item code, quantity or money.
//
// ── CAN THIS MOVE STOCK? NO, AND IT WAS READ, NOT ASSUMED ──────────────────
// pg_trigger on production, probe run 34315803944:
//   scm.mfg_sales_orders       ONE trigger, trg_mfg_sales_orders_canonicalize_
//                              venue, BEFORE INSERT OR UPDATE **OF venue**. This
//                              write does not touch venue, so it does not fire.
//   scm.mfg_sales_order_items  ONE trigger, trg_mfg_so_item_delete_audit, AFTER
//                              **DELETE**. This write deletes nothing.
// Neither reads or writes an inventory table. And the order has no delivery
// note, no purchase order dedicated to its lines, no invoice and zero
// inventory_movements rows, so there is no allocation to give back.
//
// ── PLAN, THEN APPLY, AND THE PLAN IS PERFORMED ────────────────────────────
// MODE=plan (the default) does the REAL write inside a transaction it then
// ROLLS BACK, and runs the same shape assertion over the result — so what you
// read is what would happen, not a description of it. MODE=apply additionally
// needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", and refuses unless the live
// row's digest still equals the one committed in data/clear-so-dates-plan.json:
// if the order moved between the plan and the apply, nobody has reviewed the
// row being written.
//
// RE-RUN: inert. A second run finds both dates already NULL and both mirrors
// already NULL, reports `already clear — nothing to do`, and writes nothing —
// so it cannot bump `version` a second time and invalidate a form somebody has
// legitimately open.
//
//   DATABASE_URL=... node backend/scripts/clear-so-dates.mjs
//   DATABASE_URL=... MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" \
//     node backend/scripts/clear-so-dates.mjs
// ---------------------------------------------------------------------------
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import {
  HEADER_CLEARS,
  LINE_CLEARS,
  HEADER_CHANGED_COLUMNS,
  stableDigest,
  planClear,
  verifyCleared,
} from "./lib/so-date-clear-plan.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }

const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
if (MODE === "apply" && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". Nothing was written.`);
  process.exit(2);
}
if (MODE !== "plan" && MODE !== "apply") {
  console.error(`REFUSED: MODE must be plan or apply, got "${MODE}".`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAN = JSON.parse(readFileSync(path.join(here, "data", "clear-so-dates-plan.json"), "utf8"));
const DOC = (process.env.DOC || PLAN.docNo).trim();
const CO = Number(process.env.COMPANY || PLAN.companyId);

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const newSql = () => postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/* THE ONE DOCUMENT, AND NO OTHER. Every statement below carries both the
   doc_no and the company_id; the plan file names them and DOC/COMPANY can only
   narrow to the same pair, never widen. */
if (DOC !== PLAN.docNo || CO !== Number(PLAN.companyId)) {
  console.error(`REFUSED: this script is scoped to ${PLAN.docNo} / company ${PLAN.companyId}; got ${DOC} / ${CO}.`);
  process.exit(2);
}

const sql = newSql();
let exitCode = 0;

const readHeader = (client) => client`
  SELECT * FROM scm.mfg_sales_orders WHERE doc_no = ${DOC} AND company_id = ${CO}`;
const readLines = (client) => client`
  SELECT * FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC} AND company_id = ${CO}`;

const report = (title, v) => {
  plain(`\n--- ${title} ---`);
  if (v.ok) { log(`  SHAPE OK — the two dates are NULL, version bumped by one, nothing else moved.`); return; }
  for (const p of v.problems) plain(`  PROBLEM: ${p}`);
};

try {
  plain("=".repeat(78));
  log(`clear-so-dates — MODE=${MODE} doc=${DOC} company=${CO}`);
  plain("=".repeat(78));

  const before = (await readHeader(sql))[0] ?? null;
  const beforeLines = await readLines(sql);
  const plan = planClear({ docNo: DOC, companyId: CO, header: before, lines: beforeLines });

  if (plan.refusal) {
    console.error(`REFUSED: ${plan.refusal}`);
    exitCode = 2;
  } else {
    plain("\n--- what the order holds now ---");
    plain(`  status                   ${before.status}`);
    plain(`  version                  ${before.version}`);
    plain(`  processing_date          ${before.processing_date ?? "NULL"}`);
    plain(`  customer_delivery_date   ${before.customer_delivery_date ?? "NULL"}`);
    plain(`  amended_delivery_date    ${before.amended_delivery_date ?? "NULL"}  (untouched by this lane)`);
    for (const l of beforeLines) {
      plain(`  line ${l.line_no} ${l.item_code}: line_delivery_date=${l.line_delivery_date ?? "NULL"} overridden=${l.line_delivery_date_overridden}`);
    }
    plain(`\n  digest (every column except ${HEADER_CHANGED_COLUMNS.join(", ")}):`);
    plain(`    ${plan.digest}`);
    plain(`  committed plan digest:`);
    plain(`    ${PLAN.headerDigest || "(not yet recorded — run MODE=plan, then commit it)"}`);

    if (plan.alreadyClear) {
      log("already clear — nothing to do. Re-running this script is inert by design.");
    } else {
      /* THE DIGEST GATE. At apply, the row must be the row the plan was read
         from and reviewed against. A mismatch means somebody edited the order
         in between, so the thing about to be written is not the thing anyone
         approved — refuse, do not merge the two. */
      if (MODE === "apply") {
        if (!PLAN.headerDigest) {
          console.error("REFUSED: data/clear-so-dates-plan.json carries no headerDigest. Run MODE=plan and commit the digest it prints.");
          exitCode = 2;
        } else if (PLAN.headerDigest !== plan.digest) {
          console.error("REFUSED: the order has changed since the plan was reviewed.");
          console.error(`  committed ${PLAN.headerDigest}`);
          console.error(`  live      ${plan.digest}`);
          exitCode = 2;
        }
      }

      if (exitCode === 0) {
        const ROLLBACK = Symbol("plan-only");
        let planVerify = null;
        try {
          await sql.begin(async (tx) => {
            await tx`
              UPDATE scm.mfg_sales_orders
                 SET processing_date = ${HEADER_CLEARS.processing_date},
                     customer_delivery_date = ${HEADER_CLEARS.customer_delivery_date},
                     version = ${plan.headerSets.version}
               WHERE doc_no = ${DOC} AND company_id = ${CO} AND version = ${before.version}`;
            await tx`
              UPDATE scm.mfg_sales_order_items
                 SET line_delivery_date = ${LINE_CLEARS.line_delivery_date},
                     line_delivery_date_overridden = ${LINE_CLEARS.line_delivery_date_overridden}
               WHERE doc_no = ${DOC} AND company_id = ${CO}`;

            /* Read back INSIDE the transaction so the plan run shows the real
               post-write shape rather than describing one. */
            const midH = (await readHeader(tx))[0] ?? null;
            const midL = await readLines(tx);
            planVerify = verifyCleared({ before, after: midH, beforeLines, afterLines: midL });
            if (MODE !== "apply") throw ROLLBACK;
          });
        } catch (e) {
          if (e !== ROLLBACK) throw e;
        }

        report(MODE === "apply" ? "in-transaction check" : "PLAN — performed, then rolled back", planVerify ?? { ok: false, problems: ["the transaction produced no read-back"] });
        if (!planVerify?.ok) exitCode = 1;

        if (MODE === "apply" && planVerify?.ok) {
          /* THE FRESH CONNECTION. A read on the client that did the write is
             the worst available witness that the write landed — it can be
             served from that session's own view. This opens a genuinely NEW
             one, so what follows is an assertion about what is COMMITTED and
             visible to everybody else.

             Spelled out as a `postgres(...)` call rather than through newSql()
             on purpose: a reader (and check-release-discipline.mjs, which
             counts connections) can see a second, separate client here without
             having to resolve a helper. */
          const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
          try {
            const afterH = (await readHeader(fresh))[0] ?? null;
            const afterL = await readLines(fresh);
            const v = verifyCleared({ before, after: afterH, beforeLines, afterLines: afterL });
            plain("\n--- read back on a FRESH connection ---");
            plain(`  processing_date          ${afterH?.processing_date ?? "NULL"}`);
            plain(`  customer_delivery_date   ${afterH?.customer_delivery_date ?? "NULL"}`);
            plain(`  amended_delivery_date    ${afterH?.amended_delivery_date ?? "NULL"}`);
            plain(`  status                   ${afterH?.status}`);
            plain(`  version                  ${afterH?.version}`);
            plain(`  PROCEEDED (processing_date IS NOT NULL) = ${afterH?.processing_date != null}`);
            for (const l of afterL) {
              plain(`  line ${l.line_no} ${l.item_code}: line_delivery_date=${l.line_delivery_date ?? "NULL"} overridden=${l.line_delivery_date_overridden}`);
            }
            report("FRESH-CONNECTION SHAPE", v);
            if (!v.ok) exitCode = 1;
          } finally {
            await fresh.end({ timeout: 5 });
          }
        }
      }
    }
  }

  plain("\n" + "=".repeat(78));
  log(MODE === "apply" && exitCode === 0 ? "APPLIED." : MODE === "apply" ? "APPLY FAILED — read the problems above." : "PLAN ONLY — nothing was written.");
  plain("=".repeat(78));
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(exitCode);
