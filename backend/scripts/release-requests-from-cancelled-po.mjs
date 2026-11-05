#!/usr/bin/env node
/* Let go of product requests whose Purchase Order was cancelled (2990-0027).

   WHAT WENT WRONG. A PO raised from a product request claims it: the request
   reads PO_ISSUED with po_id. Cancelling that PO left the request as it was, so
   it still said "PO raised" and refused another order ("already has a Purchase
   Order"). Sim cancelled PO2610-068 and 2990-PDR-2610-009 could not raise a new
   one. The PO cancel now lets go of its request; this puts back the ones that
   were cancelled before that.

   A STUCK ROW is a request reading PO_ISSUED whose po_id names a CANCELLED PO,
   or names nothing at all (the FK is ON DELETE SET NULL, so a PO removed by a
   create rollback leaves po_id NULL behind). It goes back to APPROVED with no
   po_id, the state it was in before the PO claimed it, and one PRODUCT_REQUEST
   audit row says why.

   MODE=plan (default) prints and writes nothing.
   MODE=apply writes, and needs CONFIRM="I HAVE REVIEWED THE DRY-RUN".
   COMPANY_ID (default 1).

   RE-RUN: inert. Keyed on status = 'PO_ISSUED' with a cancelled or missing PO;
   the write sets status to APPROVED, so a second run selects nothing. */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

const stuck = (sql) => sql`
  SELECT r.id, r.request_no, r.status, r.po_id, po.po_number, po.status::text AS po_status
    FROM scm.product_requests r
    LEFT JOIN scm.purchase_orders po ON po.id = r.po_id
   WHERE r.company_id = ${CO} AND r.status = 'PO_ISSUED'
     AND (r.po_id IS NULL OR po.status::text = 'CANCELLED')
   ORDER BY r.request_no`;

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  note(`MODE=${MODE} company=${CO}`);
  const rows = await stuck(sql);
  note(`=== REQUESTS ON A CANCELLED / MISSING PO: ${rows.length} ===`);
  for (const r of rows) note(`  ${r.request_no}  PO_ISSUED on ${r.po_number ?? "(no PO)"} ${r.po_status ?? ""}  ->  APPROVED, no PO`);

  if (!APPLY) {
    note('PLAN ONLY - nothing was written. MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" to write.');
    await sql.end({ timeout: 5 });
    return;
  }

  note("--- APPLY ---");
  await sql.begin(async (tx) => {
    for (const r of rows) {
      const moved = await tx`
        UPDATE scm.product_requests SET status = 'APPROVED', po_id = NULL, updated_at = now()
         WHERE company_id = ${CO} AND id = ${r.id} AND status = 'PO_ISSUED'
           AND po_id IS NOT DISTINCT FROM ${r.po_id}
        RETURNING id`;
      if (moved.length !== 1) throw new Error(`${r.request_no} changed under the run - refusing`);
      await tx`
        INSERT INTO scm.entity_audit_log
          (entity_type, entity_id, entity_doc_no, company_id, action, actor_id, actor_name_snapshot,
           field_changes, status_snapshot, source, note)
        VALUES ('PRODUCT_REQUEST', ${String(r.id)}, ${r.request_no}, ${CO}, 'UPDATE', NULL,
                'release-requests-from-cancelled-po',
                ${tx.json([{ field: "status", from: "PO_ISSUED", to: "APPROVED" }, { field: "poNumber", from: r.po_number ?? null, to: null }])},
                'APPROVED', 'repair',
                ${`${r.po_number ?? "Purchase Order"} cancelled - request approved again (2990-0027)`})`;
      note(`  ${r.request_no} released`);
    }
  });

  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    note("--- VERIFY (fresh connection) ---");
    const ids = rows.map((r) => r.id);
    const after = ids.length
      ? await v`SELECT request_no, status, po_id FROM scm.product_requests WHERE company_id = ${CO} AND id = ANY(${ids})`
      : [];
    for (const a of after) {
      if (a.status !== "APPROVED" || a.po_id !== null) { fails++; bad(`${a.request_no} reads ${a.status} po_id=${a.po_id}`); }
    }
    const left = await stuck(v);
    note(`  requests still PO_ISSUED on a cancelled / missing PO (must be 0): ${left.length}`);
    if (left.length) fails++;
    note(`  VERIFY ${fails === 0 ? "PASS" : `FAILED with ${fails} problem(s)`}`);
  } finally { await v.end({ timeout: 5 }); }
  await sql.end({ timeout: 5 });
  if (fails) process.exit(1);
}

main().catch((e) => { bad(e.message); process.exit(1); });
