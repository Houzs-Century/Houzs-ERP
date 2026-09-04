// Read-only integrity report on Delivery Orders vs their source Sales Order
// lines. Answers the owner's live question — "why is the same SO delivered on
// two DOs, and is that why stock is wrong?" — WITHOUT anyone opening a SQL
// console or handling the production DSN. GitHub Actions already holds
// secrets.DATABASE_URL for the deploy, so the check runs there. Manual trigger
// only (do-integrity-check.yml). Copy of the check-soak-gate.mjs contract.
//
// WHAT IT CHECKS — three read-only SELECTs, no writes, no DDL, no transaction:
//
//   R1  OVER-DELIVERY  (the smoking gun; ALWAYS a bug)
//       An SO line where  Σdelivered − Σreturned  >  ordered qty.
//       This is a pure arithmetic invariant: you cannot legitimately ship more
//       than was ordered. It is exactly what a duplicate / double-converted DO
//       produces, and each such line means stock was deducted more than once.
//       "delivered" and "returned" use the SAME definition the app itself uses
//       in soDeliverableRemaining (delivery-orders-mfg.ts): a DO line counts
//       only when its parent DO status is not one of DO_NOT_DELIVERED_STATES
//       (CANCELLED plus the pre-ship pair DRAFT and LOADED); a return counts
//       only when its parent DR status is NOT CANCELLED. The set is IMPORTED
//       from the mirror rather than typed here, so this report and the app's
//       "deliverable remaining" cannot disagree — which is a stronger claim
//       than the one this comment used to make while both sides were spelling
//       the rule with two states instead of three (2026-08-20).
//
//   R2  SHIPPED-BUT-NOT-READY  (candidates, NOT proof)
//       An SO line that has a live (non-cancelled/non-draft) DO but whose
//       CURRENT stock_status is not READY. stock_status is a mutable snapshot,
//       not history, so a line could have gone READY -> shipped -> some other
//       state legitimately. These are lines to eyeball, not a verdict.
//
//   R3  SUMMARY — counts + total excess qty, per company, so the blast radius
//       is one glance.
//
//   R4  PRE-SHIP STUCK  (reachability, added 2026-08-20)
//       Delivery orders sitting in LOADED, and how many of them the dispatch
//       gate would REFUSE. `delivery_orders.status` is DEFAULT 'LOADED' NOT
//       NULL (2990s-full-schema.sql:199) while both application create paths
//       write DRAFT or DISPATCHED explicitly, so the source can prove we never
//       WRITE the value and cannot prove nothing IS it — an import that omitted
//       the column, a hand repair, or PATCH /:id/status (whose guard accepts
//       every DO_STATUSES member) all reach it. The answer lives in production
//       and nowhere else.
//       It matters because the delivered sums in R1/R3 above — and the app's
//       own soDeliverableRemaining — exclude only CANCELLED and DRAFT, so a
//       LOADED DO counts its OWN lines as already delivered. The confirm gate
//       (LOADED -> DISPATCHED) then compares this DO's qty against a remaining
//       figure that already subtracted it and 409s whenever
//       2 x own_qty > ordered_qty, i.e. on any full delivery. Goods on the
//       lorry, button refuses. ZERO is a real answer here, not a missing one.
//
// EXIT CODE: 0 for every legitimate answer — finding over-deliveries is a
// RESULT, not a failure; the answer is the output. Only an unreachable DB or a
// query error exits non-zero (a red job must mean "the check broke").
//
// The live schema is scm.* (the 2990s-full-schema.sql baseline shows public.*;
// production runs the scm schema — every app query is sb.from('...') against
// scm, and migrations-pg create scm.*). All tables below are scm-qualified.
import { readFileSync } from "node:fs";
import postgres from "postgres";
// The SAME set the app reads (src/scm/shared/do-shipped-states.ts), through the
// .mjs mirror an audit can import. Hand-typing it here is how a report and the
// code it reports on come to disagree — which is exactly what happened: this
// file said "this report and the app's deliverable remaining can never
// disagree" while both were spelling a three-state rule with two states.
import { DO_NOT_DELIVERED_SQL_IN } from "./lib/do-shipped-states.mjs";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
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

// `::notice::` surfaces on the workflow run's summary page, so the answer is
// readable without opening the log. Plain console.log off Actions.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const SHOW = 25; // cap sample rows per report; the count line reports the total.

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── R1: OVER-DELIVERY — delivered − returned > ordered, per SO line ────────
  const over = await pg`
    WITH delivered AS (
      SELECT doi.so_item_id,
             SUM(doi.qty)::numeric              AS delivered_qty,
             array_agg(DISTINCT d.do_number)    AS do_numbers,
             MIN(d.company_id)                  AS company_id
      FROM scm.delivery_order_items doi
      JOIN scm.delivery_orders d ON d.id = doi.delivery_order_id
      WHERE doi.so_item_id IS NOT NULL
        AND upper(coalesce(d.status::text, '')) NOT IN ${pg.unsafe(DO_NOT_DELIVERED_SQL_IN)}
      GROUP BY doi.so_item_id
    ),
    returned AS (
      SELECT doi.so_item_id,
             SUM(dri.qty_returned)::numeric AS returned_qty
      FROM scm.delivery_return_items dri
      JOIN scm.delivery_returns dr    ON dr.id  = dri.delivery_return_id
      JOIN scm.delivery_order_items doi ON doi.id = dri.do_item_id
      JOIN scm.delivery_orders d      ON d.id  = doi.delivery_order_id
      WHERE upper(coalesce(dr.status::text, '')) <> 'CANCELLED'
        AND upper(coalesce(d.status::text, ''))  NOT IN ${pg.unsafe(DO_NOT_DELIVERED_SQL_IN)}
      GROUP BY doi.so_item_id
    )
    SELECT soi.doc_no,
           soi.item_code,
           soi.qty::numeric                                   AS ordered,
           del.delivered_qty,
           coalesce(ret.returned_qty, 0)                      AS returned_qty,
           (del.delivered_qty - coalesce(ret.returned_qty, 0)) AS net_delivered,
           (del.delivered_qty - coalesce(ret.returned_qty, 0) - soi.qty) AS over_by,
           del.company_id,
           del.do_numbers
    FROM scm.mfg_sales_order_items soi
    JOIN delivered del ON del.so_item_id = soi.id
    LEFT JOIN returned ret ON ret.so_item_id = soi.id
    WHERE soi.cancelled = false
      AND (del.delivered_qty - coalesce(ret.returned_qty, 0)) > soi.qty
    ORDER BY over_by DESC, soi.doc_no`;

  notice(`R1 OVER-DELIVERY — SO lines shipped beyond ordered qty: ${over.length}`);
  if (over.length === 0) {
    notice("R1: none. No SO line has net delivered > ordered. No double-ship detected.");
  } else {
    const excess = over.reduce((s, r) => s + Number(r.over_by), 0);
    notice(`R1: total EXCESS units shipped across all lines: ${excess}. Each is a stock double-deduction.`);
    for (const r of over.slice(0, SHOW)) {
      notice(
        `R1  co#${r.company_id ?? "?"}  ${r.doc_no}  ${r.item_code}  ` +
          `ordered=${r.ordered} netDelivered=${r.net_delivered} OVER_BY=${r.over_by}  ` +
          `DOs=[${(r.do_numbers ?? []).join(", ")}]`,
      );
    }
    if (over.length > SHOW) notice(`R1: … ${over.length - SHOW} more not shown (see count above).`);
  }

  // ── R2: SHIPPED-BUT-NOT-READY — candidates to eyeball, not a verdict ───────
  const notReady = await pg`
    SELECT soi.doc_no,
           soi.item_code,
           soi.qty::numeric               AS ordered,
           soi.stock_status,
           MIN(d.company_id)              AS company_id,
           array_agg(DISTINCT d.do_number) AS do_numbers
    FROM scm.mfg_sales_order_items soi
    JOIN scm.delivery_order_items doi ON doi.so_item_id = soi.id
    JOIN scm.delivery_orders d        ON d.id = doi.delivery_order_id
    WHERE soi.cancelled = false
      AND upper(coalesce(d.status::text, '')) NOT IN ${pg.unsafe(DO_NOT_DELIVERED_SQL_IN)}
      AND upper(coalesce(soi.stock_status, '')) <> 'READY'
    GROUP BY soi.doc_no, soi.item_code, soi.qty, soi.stock_status
    ORDER BY soi.doc_no`;

  notice(`R2 SHIPPED-BUT-NOT-READY (candidates, review) — shipped lines whose current stock_status <> READY: ${notReady.length}`);
  for (const r of notReady.slice(0, SHOW)) {
    notice(
      `R2  co#${r.company_id ?? "?"}  ${r.doc_no}  ${r.item_code}  ` +
        `stock_status=${r.stock_status}  DOs=[${(r.do_numbers ?? []).join(", ")}]`,
    );
  }
  if (notReady.length > SHOW) notice(`R2: … ${notReady.length - SHOW} more not shown.`);

  // ── R3: SUMMARY — per-company blast radius ─────────────────────────────────
  const summary = await pg`
    WITH delivered AS (
      SELECT doi.so_item_id, SUM(doi.qty)::numeric AS delivered_qty, MIN(d.company_id) AS company_id
      FROM scm.delivery_order_items doi
      JOIN scm.delivery_orders d ON d.id = doi.delivery_order_id
      WHERE doi.so_item_id IS NOT NULL
        AND upper(coalesce(d.status::text, '')) NOT IN ${pg.unsafe(DO_NOT_DELIVERED_SQL_IN)}
      GROUP BY doi.so_item_id
    ),
    returned AS (
      SELECT doi.so_item_id, SUM(dri.qty_returned)::numeric AS returned_qty
      FROM scm.delivery_return_items dri
      JOIN scm.delivery_returns dr      ON dr.id  = dri.delivery_return_id
      JOIN scm.delivery_order_items doi ON doi.id = dri.do_item_id
      JOIN scm.delivery_orders d        ON d.id  = doi.delivery_order_id
      WHERE upper(coalesce(dr.status::text, '')) <> 'CANCELLED'
        AND upper(coalesce(d.status::text, ''))  NOT IN ${pg.unsafe(DO_NOT_DELIVERED_SQL_IN)}
      GROUP BY doi.so_item_id
    ),
    over_lines AS (
      SELECT del.company_id,
             (del.delivered_qty - coalesce(ret.returned_qty, 0) - soi.qty) AS over_by
      FROM scm.mfg_sales_order_items soi
      JOIN delivered del ON del.so_item_id = soi.id
      LEFT JOIN returned ret ON ret.so_item_id = soi.id
      WHERE soi.cancelled = false
        AND (del.delivered_qty - coalesce(ret.returned_qty, 0)) > soi.qty
    )
    SELECT coalesce(company_id::text, '?') AS company_id,
           count(*)        AS over_lines,
           sum(over_by)    AS excess_units
    FROM over_lines
    GROUP BY company_id
    ORDER BY company_id`;

  if (summary.length === 0) {
    notice("R3 SUMMARY: 0 over-delivered lines in any company.");
  } else {
    for (const r of summary) {
      notice(`R3 SUMMARY  company ${r.company_id}: ${r.over_lines} over-delivered line(s), ${r.excess_units} excess unit(s).`);
    }
  }

  // ── R4: PRE-SHIP STUCK — delivery orders in LOADED ─────────────────────────
  const loaded = await pg`
    SELECT coalesce(company_id::text, '?') AS company_id, count(*) AS n
      FROM scm.delivery_orders
     WHERE upper(coalesce(status::text, '')) = 'LOADED'
     GROUP BY 1
     ORDER BY 1`;

  if (loaded.length === 0) {
    notice("R4 PRE-SHIP STUCK: 0 delivery orders in LOADED, in any company.");
    notice(
      "R4: that is a real answer, not a missing one — but it is NOT proof the " +
        "state is unreachable. The column defaults to LOADED and PATCH " +
        "/:id/status accepts it, so the blind spot is worth closing before it " +
        "costs a dispatch rather than after.",
    );
  } else {
    let total = 0;
    for (const r of loaded) {
      total += Number(r.n);
      notice(`R4 PRE-SHIP STUCK  company ${r.company_id}: ${r.n} delivery order(s) in LOADED.`);
    }
    notice(`R4 PRE-SHIP STUCK: ${total} LOADED delivery order(s) in total.`);
  }

  /* R4b — of those, the ones that would GENUINELY over-deliver, i.e. the ones
     the confirm gate is right to refuse. `delivered` uses the shared
     DO_NOT_DELIVERED_STATES like every other query here, so a LOADED DO is NOT
     counted against itself and `remaining` is the order's real open qty.

     Read the ORIGINAL reading of this section with care: run 32368212535
     (2026-08-20T12:19Z) ran it while `delivered` still excluded only
     {CANCELLED, DRAFT}, so it measured the OLD behaviour — how many LOADED DOs
     the gate would refuse against themselves. It answered 0, as did R4. Since
     the fix the two questions have different meanings and the same answer, and
     this comment is here so the next reader does not compare them as if they
     were one number. */
  const blocked = await pg`
    WITH delivered AS (
      SELECT doi.so_item_id, SUM(doi.qty)::numeric AS delivered_qty
      FROM scm.delivery_order_items doi
      JOIN scm.delivery_orders d ON d.id = doi.delivery_order_id
      WHERE doi.so_item_id IS NOT NULL
        AND upper(coalesce(d.status::text, '')) NOT IN ${pg.unsafe(DO_NOT_DELIVERED_SQL_IN)}
      GROUP BY doi.so_item_id
    ),
    returned AS (
      SELECT doi.so_item_id, SUM(dri.qty_returned)::numeric AS returned_qty
      FROM scm.delivery_return_items dri
      JOIN scm.delivery_returns dr      ON dr.id  = dri.delivery_return_id
      JOIN scm.delivery_order_items doi ON doi.id = dri.do_item_id
      JOIN scm.delivery_orders d        ON d.id  = doi.delivery_order_id
      WHERE upper(coalesce(dr.status::text, '')) <> 'CANCELLED'
        AND upper(coalesce(d.status::text, ''))  NOT IN ${pg.unsafe(DO_NOT_DELIVERED_SQL_IN)}
      GROUP BY doi.so_item_id
    )
    SELECT d.id, d.do_number, coalesce(d.company_id::text, '?') AS company_id
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items doi ON doi.delivery_order_id = d.id
      JOIN scm.mfg_sales_order_items soi ON soi.id = doi.so_item_id
      LEFT JOIN delivered del ON del.so_item_id = doi.so_item_id
      LEFT JOIN returned ret  ON ret.so_item_id = doi.so_item_id
     WHERE upper(coalesce(d.status::text, '')) = 'LOADED'
       AND doi.qty > (soi.qty - coalesce(del.delivered_qty, 0) + coalesce(ret.returned_qty, 0))
     GROUP BY d.id, d.do_number, d.company_id
     ORDER BY d.do_number`;

  if (blocked.length === 0) {
    notice("R4b LOADED AND GENUINELY OVER-DELIVERING: 0 — no LOADED delivery order would be refused on dispatch.");
  } else {
    notice(`R4b LOADED AND GENUINELY OVER-DELIVERING: ${blocked.length} LOADED delivery order(s) would be refused on dispatch.`);
    for (const r of blocked.slice(0, SHOW)) {
      notice(`R4b  company ${r.company_id}  ${r.do_number}`);
    }
    if (blocked.length > SHOW) notice(`R4b: … ${blocked.length - SHOW} more not shown.`);
  }

  // ── R5: EMPTY SHIPPED DOCUMENTS — line rows gone, evidence broken (2026-09-04)
  // A delivery order that counts as delivered (every state but DRAFT and
  // CANCELLED) yet holds ZERO rows in delivery_order_items. Three 2990
  // documents had this shape from 2026-07-23 to 2026-09-04 (their rows sat
  // under vanished header ids); syncSoDeliveredFromDo read them as "nothing
  // delivered" and released three delivered orders back into MRP. ALWAYS a
  // bug: an empty shipped document is never an answer. Mig 20260904T0800
  // refuses the state at the database; the hourly do-link-orphan-sentinel
  // alarms on it; this section is the on-demand census with the header's own
  // line_count and OUT-movement count beside each, so the reader can see what
  // the document CLAIMS it shipped.
  const emptyShipped = await pg`
    SELECT coalesce(d.company_id::text, '?') AS company_id,
           d.do_number, d.so_doc_no, d.status::text AS status, d.line_count,
           (SELECT count(*) FROM scm.inventory_movements m
             WHERE m.source_doc_type::text = 'DO' AND m.movement_type::text = 'OUT'
               AND (m.source_doc_no = d.do_number OR m.source_doc_id::text = d.id::text)) AS out_movements
      FROM scm.delivery_orders d
     WHERE upper(coalesce(d.status::text, '')) NOT IN ${pg.unsafe(DO_NOT_DELIVERED_SQL_IN)}
       AND NOT EXISTS (SELECT 1 FROM scm.delivery_order_items i WHERE i.delivery_order_id = d.id)
     ORDER BY d.company_id, d.do_number`;

  notice(`R5 EMPTY SHIPPED DOCUMENTS — delivered/shipped delivery orders with NO line rows: ${emptyShipped.length}`);
  if (emptyShipped.length === 0) {
    notice("R5: none. Every shipped delivery order still holds the rows that say what shipped.");
  } else {
    for (const r of emptyShipped.slice(0, SHOW)) {
      notice(
        `R5  co#${r.company_id}  ${r.do_number}  from ${r.so_doc_no ?? "-"}  status=${r.status}  ` +
          `line_count=${r.line_count ?? "?"}  OUT movements=${r.out_movements}`,
      );
    }
    if (emptyShipped.length > SHOW) notice(`R5: … ${emptyShipped.length - SHOW} more not shown.`);
  }

  // R5b — the rows themselves, wherever they went: line rows whose header does
  // not exist. The FK is ON DELETE CASCADE, so these are written by a path that
  // bypassed it. Eight existed until the 2026-09-04 re-parent.
  const headerless = await pg`
    SELECT i.delivery_order_id, count(*) AS rows, min(i.created_at) AS first_at,
           string_agg(DISTINCT coalesce(s.doc_no, '?'), ', ') AS so_docs
      FROM scm.delivery_order_items i
      LEFT JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
      LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
     WHERE d.id IS NULL
     GROUP BY i.delivery_order_id
     ORDER BY first_at`;
  notice(`R5b HEADERLESS LINE ROWS — delivery_order_items whose delivery_order_id has no header: ${headerless.length} group(s)`);
  for (const r of headerless.slice(0, SHOW)) {
    notice(`R5b  ${r.delivery_order_id}  ${r.rows} row(s)  first ${r.first_at}  SO(s) ${r.so_docs}`);
  }

  notice("DONE (read-only). Interpret R1 and R5 as the authoritative bug lists; R2 as candidates to review; R4 as reachability.");
} finally {
  await pg.end({ timeout: 5 });
}
