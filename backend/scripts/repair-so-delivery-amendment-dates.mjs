#!/usr/bin/env node
// repair-so-delivery-amendment-dates — restamp approved DELIVERY-lane SO
// amendments that an AutoCount book re-sync silently reverted.
//
// WHY THIS EXISTS (proven, not inferred). Before
// fix/so-delivery-amendment-writes-amended-date, applySoAmendment wrote an
// approved delivery-date change to `customer_delivery_date` ONLY and left
// `amended_delivery_date` NULL. Every AutoCount -> ERP delivery-date re-sync
// skips a header ONLY when `amended_delivery_date` is set, so the next re-sync
// clobbered the approved date back to the AutoCount book value. Reported on
// HC-SO-011177 (approved 02/11 -> 19/10 on 2026-09-11, reverted to 02/11 by a
// header-only book re-sync at 2026-09-16 06:54). Measured on the live database
// 2026-09-22: 7 company-1 orders whose approved delivery amendment is not
// reflected in the header. BUG-HISTORY 2026-09-22.
//
// WHAT IT SETS, per affected SO, to exactly the state the fixed code now writes
// at approve time:
//   customer_delivery_date        = the approved date  (the SO detail's "Delivery
//                                   Date" and the HC delivery sheet read this RAW,
//                                   so it must land here to be SEEN)
//   amended_delivery_date         = the approved date  (what every AutoCount ->
//                                   ERP re-sync guard checks, so it STICKS)
//   line_delivery_date            = the approved date on every non-cancelled line
//   line_delivery_date_overridden = true               (so the book LINE re-sync
//                                   leaves the lines alone)
// The customer's ORIGINAL date is left as history in the amendment's
// `old_header_snapshot` and the `AMENDMENT_SO_APPROVED` audit row — nothing here
// touches that trail.
//
// SCOPE: company_id = 1 only (the AutoCount-linked book). The approved date is
// the LATEST SO_APPROVED DELIVERY-lane amendment carrying `customerDeliveryDate`.
// An SO already holding the approved date in BOTH header columns is skipped
// (idempotent), and a re-run re-reads on a fresh connection and asserts none of
// the touched orders still disagree.
//
// DEFAULT IS PLAN — it writes nothing and prints every intended change. APPLY
// needs MODE=apply and CONFIRM="RESTAMP-DELIVERY-AMENDMENTS".
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "RESTAMP-DELIVERY-AMENDMENTS";
const COMPANY = 1;

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  /* The LATEST approved DELIVERY-lane amendment per SO that carries a delivery
     date, joined to the header. `approved` is the date the approver signed for;
     a row is in scope only when the header does not already hold it in BOTH
     columns. `DISTINCT FROM` so a NULL amended_delivery_date counts as a diff. */
  const rows = await sql`
    WITH latest AS (
      SELECT DISTINCT ON (a.so_doc_no) a.so_doc_no,
             a.header_changes->>'customerDeliveryDate' AS approved
        FROM scm.so_amendments a
       WHERE a.company_id = ${COMPANY}
         AND a.lane = 'DELIVERY'
         AND a.status = 'SO_APPROVED'
         AND a.header_changes ? 'customerDeliveryDate'
       ORDER BY a.so_doc_no, a.so_approved_at DESC NULLS LAST
    )
    SELECT l.so_doc_no, l.approved,
           to_char(s.customer_delivery_date, 'YYYY-MM-DD') AS cust,
           to_char(s.amended_delivery_date,  'YYYY-MM-DD') AS amended
      FROM latest l
      JOIN scm.mfg_sales_orders s
        ON s.doc_no = l.so_doc_no AND s.company_id = ${COMPANY}
     WHERE l.approved IS NOT NULL
       AND (s.customer_delivery_date IS DISTINCT FROM l.approved::date
            OR s.amended_delivery_date IS DISTINCT FROM l.approved::date)
     ORDER BY l.so_doc_no`;

  log(`company ${COMPANY}: ${rows.length} order(s) whose approved delivery amendment is not reflected in the header`);
  for (const r of rows) {
    log(`   ${r.so_doc_no}: header cust=${r.cust ?? "(blank)"} amended=${r.amended ?? "(blank)"}  ->  both ${r.approved}`);
  }

  if (rows.length === 0) { log("nothing to repair."); await sql.end(); return; }

  if (MODE !== "apply") {
    log(`PLAN: nothing written. Re-run MODE=apply CONFIRM=${CONFIRM_PHRASE} to apply.`);
    await sql.end();
    return;
  }
  if (CONFIRM !== CONFIRM_PHRASE) { await sql.end(); die(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}"`); }

  let headers = 0; let lines = 0;
  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        UPDATE scm.mfg_sales_orders
           SET customer_delivery_date = ${r.approved}::date,
               amended_delivery_date  = ${r.approved}::date
         WHERE doc_no = ${r.so_doc_no} AND company_id = ${COMPANY}`;
      headers += 1;
      const res = await tx`
        UPDATE scm.mfg_sales_order_items
           SET line_delivery_date = ${r.approved}::date,
               line_delivery_date_overridden = true
         WHERE doc_no = ${r.so_doc_no}
           AND COALESCE(cancelled, false) = false
       RETURNING id`;
      lines += res.length;
    }
  });
  log(`APPLIED: ${headers} header(s) + ${lines} line(s) written.`);
  await sql.end();

  // Verify on a FRESH connection — a read inside the writing session can be
  // served from that session's own snapshot and prove nothing.
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const want = new Map(rows.map((r) => [r.so_doc_no, r.approved]));
  const back = await v`
    SELECT doc_no,
           to_char(customer_delivery_date, 'YYYY-MM-DD') AS cust,
           to_char(amended_delivery_date,  'YYYY-MM-DD') AS amended
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY} AND doc_no = ANY(${[...want.keys()]})`;
  await v.end();
  const bad = back.filter((r) => r.cust !== want.get(r.doc_no) || r.amended !== want.get(r.doc_no));
  if (bad.length) die(`VERIFY FAILED: ${bad.length} order(s) still do not hold the approved date`);
  log(`VERIFIED on a fresh connection: ${back.length} order(s) now hold the approved delivery date in both header columns.`);
}

main().catch((e) => die(e?.message ?? String(e)));
