#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-dev69-revise-po-dates.mjs — put back the PO line delivery dates that a
// Revise PO overwrote with the customer delivery date.
//
// THE DAMAGE (DEV-69, Sim 2026-10-10). reviseBoundPo step 12a re-derived every
// surviving PO line from its SO line and copied the SO line's
// line_delivery_date (the CUSTOMER date) onto purchase_order_items.delivery_date,
// which should be the customer date minus the supplier lead time (PO create,
// mfg-purchase-orders.ts). The header expected_at (earliest line date) moved
// with it. Fixed in lib/po-line-rederive.ts (#4557).
//
// THE EVIDENCE. Every revise first snapshots the PO into scm.po_revisions with
// amendment_id = the SO amendment, so the date the line had BEFORE the revise
// is on record. A line is a target when:
//   - an SO-amendment snapshot holds it with a date (the EARLIEST such snapshot
//     is the date before any revise touched it), and
//   - its date now equals its SO line's customer date, and differs from that
//     snapshot date.
// A PO with a manual PO amendment (a po_revisions row NOT from an SO amendment)
// after that snapshot is printed as REVIEW and not written: a person may have
// set the date on purpose. Cancelled POs are skipped. Lines a revise ADDED have
// no earlier date on record and are not touched.
//
// THE REPAIR. delivery_date := the snapshot date; then each touched PO's
// expected_at := its earliest line date, as reviseBoundPo computes it.
//
// ERP ONLY. Nothing is queued to AutoCount.
//
// DRY-RUN BY DEFAULT: plan runs the UPDATEs in a transaction and ROLLS BACK.
// MODE=apply with the CONFIRM phrase commits, then re-reads on a fresh
// connection. COMPANY_ID limits it to one company; unset = every company.
//
//   npx tsx scripts/repair-dev69-revise-po-dates.mjs
//   MODE=apply CONFIRM="RESTORE REVISED PO LINE DATES" npx tsx scripts/repair-dev69-revise-po-dates.mjs
//
// RE-RUN: inert. A restored line's date no longer equals the customer date (it
// equals the snapshot date), so a second run selects nothing.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "RESTORE REVISED PO LINE DATES";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM=${JSON.stringify(CONFIRM_PHRASE)}. Aborting.`);
  process.exit(2);
}
const COMPANY_ID = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;
if (COMPANY_ID !== null && !Number.isInteger(COMPANY_ID)) {
  console.error(`COMPANY_ID must be an integer, got ${process.env.COMPANY_ID}. Aborting.`);
  process.exit(2);
}

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const DATABASE_URL = resolveUrl();
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const DRY_RUN_ROLLBACK = "DRY-RUN-ROLLBACK";
const sql = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
let fixed = [];

const selectCandidates = (db) => db`
  WITH so_snaps AS (
    SELECT r.po_id, r.created_at, l->>'id' AS line_id, left(l->>'delivery_date', 10) AS snap_date,
           row_number() OVER (PARTITION BY l->>'id' ORDER BY r.revision) AS rn
    FROM scm.po_revisions r
    CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'lines') l
    WHERE r.amendment_id IN (SELECT id FROM scm.so_amendments)
      AND NULLIF(l->>'delivery_date', '') IS NOT NULL
  ),
  first_snap AS (SELECT * FROM so_snaps WHERE rn = 1)
  SELECT poi.id, po.id AS po_id, po.company_id, po.po_number, po.status::text AS status,
         poi.line_no, poi.item_code,
         poi.delivery_date::text AS now_date, soi.line_delivery_date::text AS so_date,
         fs.snap_date, fs.created_at AS first_revise_at,
         EXISTS (
           SELECT 1 FROM scm.po_revisions m
           WHERE m.po_id = po.id AND m.created_at > fs.created_at
             AND (m.amendment_id IS NULL OR m.amendment_id NOT IN (SELECT id FROM scm.so_amendments))
         ) AS manual_after
  FROM first_snap fs
  JOIN scm.purchase_order_items poi ON poi.id::text = fs.line_id
  JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
  JOIN scm.mfg_sales_order_items soi ON soi.id = poi.so_item_id
  WHERE po.status::text <> 'CANCELLED'
    AND poi.delivery_date IS NOT NULL
    AND poi.delivery_date = soi.line_delivery_date
    AND poi.delivery_date::text <> fs.snap_date
    AND (${COMPANY_ID}::int IS NULL OR po.company_id = ${COMPANY_ID}::int)
  ORDER BY po.company_id, po.po_number, poi.line_no`;

try {
  log(`mode=${APPLY ? "APPLY" : "PLAN (rolled back)"}  company=${COMPANY_ID ?? "all"}`);
  await sql.begin(async (tx) => {
    const rows = await selectCandidates(tx);
    const review = rows.filter((r) => r.manual_after);
    const targets = rows.filter((r) => !r.manual_after);
    log(`${rows.length} PO line(s) now carry the customer date after a revise: ${targets.length} to restore, ${review.length} to REVIEW`);
    for (const r of rows) {
      log(`  ${r.manual_after ? "REVIEW " : "RESTORE"}  ${r.po_number}  ${r.status}  line ${r.line_no ?? "?"}  ${r.item_code}  now ${r.now_date} (= SO)  ->  ${r.snap_date}  (first revise ${new Date(r.first_revise_at).toISOString().slice(0, 10)})`);
    }
    if (targets.length === 0) return;

    for (const r of targets) {
      const u = await tx`
        UPDATE scm.purchase_order_items SET delivery_date = ${r.snap_date}::date
        WHERE id = ${r.id} AND delivery_date = ${r.now_date}::date RETURNING id`;
      if (u.length !== 1) throw new Error(`REFUSED: line ${r.id} on ${r.po_number} changed under us`);
    }
    const poIds = [...new Set(targets.map((r) => r.po_id))];
    await tx`
      UPDATE scm.purchase_orders po
      SET expected_at = (SELECT MIN(delivery_date) FROM scm.purchase_order_items WHERE purchase_order_id = po.id),
          updated_at = now()
      WHERE po.id = ANY(${poIds}::uuid[])`;
    fixed = targets.map((r) => ({ id: r.id, want: r.snap_date, po: r.po_number }));
    log(`restored ${targets.length} line(s) on ${poIds.length} purchase order(s); expected_at recomputed`);

    if (!APPLY) throw new Error(DRY_RUN_ROLLBACK);
  });
} catch (e) {
  if (!(e instanceof Error && e.message === DRY_RUN_ROLLBACK)) {
    console.error(e instanceof Error ? e.message : e);
    await sql.end();
    process.exit(1);
  }
  log("plan: rolled back, nothing written. Re-run with MODE=apply and the CONFIRM phrase to commit.");
}
await sql.end();

if (APPLY && fixed.length > 0) {
  const verify = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  const now = await verify`
    SELECT id::text, delivery_date::text AS d FROM scm.purchase_order_items
    WHERE id = ANY(${fixed.map((f) => f.id)}::uuid[])`;
  const again = await selectCandidates(verify);
  await verify.end();
  const got = new Map(now.map((r) => [r.id, r.d]));
  const wrong = fixed.filter((f) => got.get(f.id) !== f.want);
  if (wrong.length > 0) {
    console.error(`VERIFY FAILED: ${wrong.map((f) => `${f.po} ${f.id}=${got.get(f.id)} want ${f.want}`).join(", ")}`);
    process.exit(1);
  }
  log(`verify: all ${fixed.length} line(s) hold their restored date on a fresh connection; ${again.filter((r) => !r.manual_after).length} restorable line(s) left`);
}
