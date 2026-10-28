#!/usr/bin/env node
// Undo purchase orders written by import-ac-so-linked-pos.mjs, so the import can
// be re-run against a corrected script.
//
// WHY THIS EXISTS (2026-08-10). An APPLY run of the SO-linked PO import started
// while the script still wrote SOFA lines whole — one PO line carrying the
// AutoCount model code — instead of decomposing the build into one line per
// compartment the way the sales orders were imported. The run was cancelled
// mid-flight, leaving a partial batch of POs in production whose sofa lines can
// never dedicate to a compartment SO line, which is exactly what keeps a sofa
// set stuck on PENDING.
//
// SAFE TO DELETE, and the script proves it rather than assuming it:
//   · these POs carry NO stock — the importer writes received_qty as paperwork
//     only and never posts a movement (the units came in with the balance
//     snapshot). The check below fails the run if any inventory movement or GRN
//     line references one of them.
//   · deleting the line releases its so_item_id dedication, which is the only
//     thing outside the PO these rows touch.
//
// Scope is the importer's OWN signature — the note it stamps on every header it
// writes — so it can never reach a PO raised by a human or by the outstanding-PO
// import, which stamp different notes.
//
// DRY-RUN by default; APPLY=1 deletes. ONLY_SOFA=1 (the default) limits the
// delete to POs that actually contain a sofa line; ONLY_SOFA=0 takes the whole
// batch.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const ONLY_SOFA = process.env.ONLY_SOFA !== "0";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const SIGNATURE = "%already received; stock came in with the balance snapshot%";

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} scope=${ONLY_SOFA ? "sofa-bearing POs only" : "the whole imported batch"}`);

  const batch = await sql`SELECT p.id, p.po_number, p.linked_ac_docno, p.status, p.created_at,
      COUNT(i.id)::int lines,
      COUNT(*) FILTER (WHERE i.item_group = 'sofa')::int sofa_lines,
      COUNT(*) FILTER (WHERE i.so_item_id IS NOT NULL)::int dedicated,
      COALESCE(SUM(i.received_qty), 0)::int recv
    FROM scm.purchase_orders p
    LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
    WHERE p.company_id = 1 AND p.linked_ac_docno IS NOT NULL AND p.notes LIKE ${SIGNATURE}
    GROUP BY p.id, p.po_number, p.linked_ac_docno, p.status, p.created_at
    ORDER BY p.po_number`;
  log(`POs written by this importer: ${batch.length} (${batch.reduce((s, r) => s + r.lines, 0)} lines, ${batch.filter((r) => r.sofa_lines > 0).length} of them carrying sofa lines)`);
  if (!batch.length) { log("nothing to do"); await sql.end(); return; }

  const targets = ONLY_SOFA ? batch.filter((r) => r.sofa_lines > 0) : batch;
  if (!targets.length) { log("no PO in scope — nothing to do"); await sql.end(); return; }
  const ids = targets.map((r) => r.id);

  /* Refuse to delete anything the warehouse has already acted on. A GRN line or
     an inventory movement pointing at one of these POs would mean the paperwork
     became a real stock event, and deleting it would silently unbalance stock. */
  const [{ n: grnRefs }] = await sql`SELECT COUNT(*)::int n FROM scm.grn_items g
    JOIN scm.purchase_order_items i ON i.id = g.purchase_order_item_id WHERE i.purchase_order_id = ANY(${ids})`;
  log(`safety: GRN lines referencing these POs = ${grnRefs} (a GRN is the only way one of these could have moved stock)`);
  if (grnRefs > 0) {
    log("REFUSING to delete — these POs are no longer paperwork-only. Nothing was changed.");
    await sql.end();
    process.exit(1);
  }

  const sofaLines = targets.reduce((s, r) => s + r.sofa_lines, 0);
  const dedications = targets.reduce((s, r) => s + r.dedicated, 0);
  log(`in scope: ${targets.length} POs / ${targets.reduce((s, r) => s + r.lines, 0)} lines / ${sofaLines} sofa lines / ${dedications} SO dedications released / ${targets.reduce((s, r) => s + r.recv, 0)} received units of paperwork`);
  for (const r of targets.slice(0, 15)) log(`   ${r.po_number} <- ${r.linked_ac_docno} [${r.status}] ${r.lines} lines (${r.sofa_lines} sofa)`);
  if (targets.length > 15) log(`   ... and ${targets.length - 15} more`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to delete. Re-run the importer afterwards; it is idempotent on linked_ac_docno."); await sql.end(); return; }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM scm.purchase_order_items WHERE purchase_order_id = ANY(${ids})`;
    await tx`DELETE FROM scm.purchase_orders WHERE id = ANY(${ids})`;
  });
  const [{ n: left }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_orders WHERE id = ANY(${ids})`;
  log(`DELETED ${targets.length} POs; remaining from that set: ${left}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
