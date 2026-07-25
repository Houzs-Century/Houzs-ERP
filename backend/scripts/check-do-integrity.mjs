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
//       only when its parent DO status is NOT CANCELLED and NOT DRAFT; a return
//       counts only when its parent DR status is NOT CANCELLED. So this report
//       and the app's "deliverable remaining" can never disagree.
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
// EXIT CODE: 0 for every legitimate answer — finding over-deliveries is a
// RESULT, not a failure; the answer is the output. Only an unreachable DB or a
// query error exits non-zero (a red job must mean "the check broke").
//
// The live schema is scm.* (the 2990s-full-schema.sql baseline shows public.*;
// production runs the scm schema — every app query is sb.from('...') against
// scm, and migrations-pg create scm.*). All tables below are scm-qualified.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
        AND upper(coalesce(d.status::text, '')) NOT IN ('CANCELLED', 'DRAFT')
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
        AND upper(coalesce(d.status::text, ''))  NOT IN ('CANCELLED', 'DRAFT')
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
      AND upper(coalesce(d.status::text, '')) NOT IN ('CANCELLED', 'DRAFT')
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
        AND upper(coalesce(d.status::text, '')) NOT IN ('CANCELLED', 'DRAFT')
      GROUP BY doi.so_item_id
    ),
    returned AS (
      SELECT doi.so_item_id, SUM(dri.qty_returned)::numeric AS returned_qty
      FROM scm.delivery_return_items dri
      JOIN scm.delivery_returns dr      ON dr.id  = dri.delivery_return_id
      JOIN scm.delivery_order_items doi ON doi.id = dri.do_item_id
      JOIN scm.delivery_orders d        ON d.id  = doi.delivery_order_id
      WHERE upper(coalesce(dr.status::text, '')) <> 'CANCELLED'
        AND upper(coalesce(d.status::text, ''))  NOT IN ('CANCELLED', 'DRAFT')
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

  notice("DONE (read-only). Interpret R1 as the authoritative bug list; R2 as candidates to review.");
} finally {
  await pg.end({ timeout: 5 });
}
