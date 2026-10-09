#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-dev66-po-received-status.mjs — mark RECEIVED the purchase orders whose
// every line is already received in full but whose status still says
// SUBMITTED / PARTIALLY_RECEIVED.
//
// THE DAMAGE (DEV-66, 2026-10-09). Sim: "PO outstanding no show 0 item". The
// Outstanding tab is status SUBMITTED + PARTIALLY_RECEIVED. On production 83 of
// its 398 company-1 orders had Remaining 0 on every line (64 SUBMITTED, 19
// PARTIALLY_RECEIVED), all AutoCount cutover orders (linked_ac_docno set,
// po_date 2026-06-19 .. 08-28). import-ac-outstanding-po.mjs only ever writes
// SUBMITTED / PARTIALLY_RECEIVED; their received_qty was filled in afterwards
// without the status recount the GRN path runs (grns.ts recomputePoReceived).
//
// THE REPAIR. The same rule recomputePoReceived applies: a PO with lines, every
// one of them received_qty >= qty, is RECEIVED. received_at is the latest live
// GRN date that received one of its lines, else now(). Orders on hold (marker
// columns, mig 0324) are left alone, as a writer re-deriving a status must not
// touch one.
//
// ERP ONLY. Nothing is queued to AutoCount: a repair client does not push to
// the account book (tests/acWritebackPushAllowlist.test.mjs).
//
// DRY-RUN BY DEFAULT: plan runs the UPDATE inside a transaction and ROLLS BACK.
// MODE=apply with the CONFIRM phrase commits, then re-reads on a fresh
// connection. COMPANY_ID limits it to one company; unset = every company.
//
//   npx tsx scripts/repair-dev66-po-received-status.mjs
//   MODE=apply CONFIRM="MARK FULLY RECEIVED POS RECEIVED" npx tsx scripts/repair-dev66-po-received-status.mjs
//
// RE-RUN: inert. The select is status IN (SUBMITTED, PARTIALLY_RECEIVED), which
// the write turns into RECEIVED, so a second run selects nothing.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "MARK FULLY RECEIVED POS RECEIVED";
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
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;

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
let targetIds = [];

const selectTargets = (db) => db`
  WITH lines AS (
    SELECT poi.purchase_order_id AS po_id,
           COUNT(*)::int AS n,
           bool_and(COALESCE(poi.received_qty, 0) >= poi.qty) AS fully
    FROM scm.purchase_order_items poi
    GROUP BY poi.purchase_order_id
  ),
  grn_dates AS (
    SELECT poi.purchase_order_id AS po_id, MAX(g.received_at) AS last_grn
    FROM scm.purchase_order_items poi
    JOIN scm.grn_items gi ON gi.purchase_order_item_id = poi.id
    JOIN scm.grns g ON g.id = gi.grn_id
    WHERE g.status NOT IN ('CANCELLED', 'DRAFT')
    GROUP BY poi.purchase_order_id
  )
  SELECT po.id, po.company_id, po.po_number, po.linked_ac_docno, po.status::text AS status,
         po.po_date, po.total_sen, l.n AS line_count, gd.last_grn
  FROM scm.purchase_orders po
  JOIN lines l ON l.po_id = po.id
  LEFT JOIN grn_dates gd ON gd.po_id = po.id
  WHERE po.status IN ('SUBMITTED', 'PARTIALLY_RECEIVED')
    AND l.n > 0 AND l.fully
    AND po.on_hold IS NOT TRUE
    AND (${COMPANY_ID}::int IS NULL OR po.company_id = ${COMPANY_ID}::int)
  ORDER BY po.company_id, po.po_number`;

try {
  log(`mode=${APPLY ? "APPLY" : "PLAN (rolled back)"}  company=${COMPANY_ID ?? "all"}`);
  await sql.begin(async (tx) => {
    const rows = await selectTargets(tx);
    targetIds = rows.map((r) => r.id);
    const byKey = new Map();
    for (const r of rows) {
      const k = `company ${r.company_id} ${r.status}`;
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    log(`${rows.length} purchase order(s) fully received but not RECEIVED`);
    for (const [k, n] of byKey) log(`  ${k}: ${n}`);
    log(`  with a live GRN behind them: ${rows.filter((r) => r.last_grn).length}; AutoCount-linked: ${rows.filter((r) => r.linked_ac_docno).length}`);
    for (const r of rows) {
      const d = r.po_date instanceof Date ? r.po_date.toISOString().slice(0, 10) : r.po_date;
      const g = r.last_grn instanceof Date ? r.last_grn.toISOString().slice(0, 10) : r.last_grn ?? "-";
      log(`  ${r.po_number}  ${r.status}  ${d}  ${r.line_count} line(s)  ${rm(r.total_sen)}  last GRN ${g}`);
    }
    if (rows.length === 0) return;

    const updated = await tx`
      UPDATE scm.purchase_orders po
      SET status = 'RECEIVED',
          received_at = COALESCE(po.received_at, (
            SELECT MAX(g.received_at)::timestamptz
            FROM scm.purchase_order_items poi
            JOIN scm.grn_items gi ON gi.purchase_order_item_id = poi.id
            JOIN scm.grns g ON g.id = gi.grn_id
            WHERE poi.purchase_order_id = po.id AND g.status NOT IN ('CANCELLED', 'DRAFT')
          ), now()),
          updated_at = now()
      WHERE po.id = ANY(${targetIds}::uuid[])
        AND po.status IN ('SUBMITTED', 'PARTIALLY_RECEIVED')
      RETURNING po.id`;
    if (updated.length !== rows.length) throw new Error(`REFUSED: updated ${updated.length}, expected ${rows.length}`);
    log(`updated ${updated.length} purchase order(s) to RECEIVED`);

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

if (APPLY && targetIds.length > 0) {
  const verify = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  const left = await verify`
    SELECT po_number, status::text AS status FROM scm.purchase_orders
    WHERE id = ANY(${targetIds}::uuid[]) AND status <> 'RECEIVED'`;
  const again = await selectTargets(verify);
  await verify.end();
  if (left.length > 0) {
    console.error(`VERIFY FAILED: ${left.length} not RECEIVED: ${left.map((r) => `${r.po_number}=${r.status}`).join(", ")}`);
    process.exit(1);
  }
  log(`verify: all ${targetIds.length} RECEIVED on a fresh connection; ${again.length} fully received order(s) still open`);
}
