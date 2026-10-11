/* Repair the PO lines whose received_qty exceeds what was ordered.
 *
 * WHAT WENT WRONG. import-ac-so-linked-pos.mjs read AutoCount's GrQty as a
 * per-line receipt. It is a per-(DocNo, ItemCode) received ROLLUP stamped
 * identically onto every detail line of the group, so every line of a repeated
 * item claimed the WHOLE group's receipt. create-migrated-documents.mjs then
 * mirrored that inflated counter straight into grn_items.qty_received /
 * qty_accepted / line_total_centi, which is why ONE migrated GRN shows the same
 * 2 against four lines that each ordered 1. Production carries 65 such PO lines
 * and 73 excess units. The importer is fixed (lib/apportion-received.mjs); this
 * repairs the rows it already wrote.
 *
 * WHY CLAMPING TO qty IS THE EXACT ANSWER HERE, NOT AN APPROXIMATION.
 * Measured on the committed snapshot (backend/tests-node/apportionReceived.test.ts
 * asserts it): every one of the 59 affected AutoCount source lines belongs to a
 * group whose rollup is >= the group's TOTAL ordered qty — i.e. a group that was
 * FULLY received. For a fully-received group the correct per-line receipt is
 * exactly that line's own qty, so received_qty := qty restores AutoCount's
 * number to the unit and the group total is preserved. The 9 genuinely PARTIAL
 * groups in the snapshot produce no over-received line at all, so none of them
 * is touched by this repair and nothing is silently rounded up to "fully
 * received".
 *
 * THIS SCRIPT MOVES NO STOCK, AND REFUSES TO TOUCH ANYTHING THAT DID.
 * Correcting a document quantity and reversing an inventory movement are
 * different acts with different blast radius. Every GRN behind these lines is
 * migrated_no_stock = true and posts NO movement (inventory_balances is a VIEW
 * over movements, so on-hand is untouched by all 73 excess units). This script
 * verifies that per line rather than trusting it: any PO line whose GRN carries
 * even one inventory movement is SKIPPED and reported for an owner decision. It
 * never writes to scm.inventory_movements.
 *
 * SAFETY. DRY-RUN by default; APPLY=1 writes. Idempotent and convergent — a
 * second run finds nothing because the predicate (received_qty > qty) no longer
 * matches. Each PO line is repaired in its own transaction. Anything ambiguous
 * is skipped and reported, never guessed.
 *
 *   node backend/scripts/repair-over-received-po-lines.mjs          # dry run
 *   APPLY=1 node backend/scripts/repair-over-received-po-lines.mjs  # write
 */

import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

const APPLY = process.env.APPLY === '1';
const log = (...a) => console.log(...a);

/** Statuses whose GRN lines count as a live receipt — matches recomputePoReceived. */
const NON_COUNTING = new Set(['DRAFT', 'CANCELLED']);

/**
 * Decide what to do with each over-received PO line. Pure, so it is testable
 * without a database (backend/tests-node/repairOverReceived.test.ts).
 *
 * @param {Array<{
 *   poItemId: string, poNumber: string, materialCode: string,
 *   qty: number, receivedQty: number, unitPriceCenti: number,
 *   grnLines: Array<{ id: string, grnId: string, grnNumber: string, status: string,
 *                     migrated: boolean, qtyAccepted: number, qtyReceived: number,
 *                     qtyRejected: number, returnedQty: number, movements: number }>
 * }>} lines
 * @returns {{ repair: Array<object>, skip: Array<object> }}
 */
export function planRepair(lines) {
  const repair = [];
  const skip = [];

  for (const l of lines) {
    const live = l.grnLines.filter((g) => !NON_COUNTING.has(String(g.status).toUpperCase()));

    // Stock actually moved behind this receipt: a document-quantity edit is the
    // WRONG instrument. Report it and let the owner decide on a reversal.
    const moved = live.filter((g) => Number(g.movements) > 0);
    if (moved.length > 0) {
      skip.push({
        ...l,
        reason: 'grn_has_inventory_movements',
        detail: `GRN ${moved.map((g) => `${g.grnNumber} (${g.movements} movement(s))`).join(', ')} — correcting the document would leave stock and paperwork disagreeing. Needs an explicit reversal decision, not a clamp.`,
      });
      continue;
    }

    if (live.length === 0) {
      skip.push({
        ...l,
        reason: 'no_live_grn_line',
        detail: `received_qty ${l.receivedQty} is not backed by any live GRN line, so the correct value cannot be derived from the receipt trail. Not guessed.`,
      });
      continue;
    }

    if (live.length > 1) {
      skip.push({
        ...l,
        reason: 'multiple_live_grn_lines',
        detail: `${live.length} live GRN lines (${live.map((g) => g.grnNumber).join(', ')}) — apportioning the correction across them is ambiguous. Not guessed.`,
      });
      continue;
    }

    const g = live[0];
    const target = l.qty;                       // exact for a fully-received group
    const newAccepted = target + Number(g.returnedQty || 0);
    const newReceived = newAccepted + Number(g.qtyRejected || 0);
    const newLineTotal = Math.round(newAccepted * Number(l.unitPriceCenti || 0));

    const grnChanged =
      newAccepted !== Number(g.qtyAccepted) || newReceived !== Number(g.qtyReceived);
    const poChanged = target !== Number(l.receivedQty);
    if (!grnChanged && !poChanged) {
      skip.push({ ...l, reason: 'already_correct', detail: 'nothing to change' });
      continue;
    }

    repair.push({
      poItemId: l.poItemId,
      poNumber: l.poNumber,
      materialCode: l.materialCode,
      qty: l.qty,
      fromReceived: Number(l.receivedQty),
      toReceived: target,
      unitsRemoved: Number(l.receivedQty) - target,
      grnItemId: g.id,
      grnNumber: g.grnNumber,
      migrated: g.migrated,
      fromAccepted: Number(g.qtyAccepted),
      toAccepted: newAccepted,
      toQtyReceived: newReceived,
      toLineTotalCenti: newLineTotal,
    });
  }

  return { repair, skip };
}

async function main() {
  const DSN = process.env.DATABASE_URL;
  if (!DSN) {
    console.error('need DATABASE_URL');
    process.exit(2);
  }
  const sql = postgres(DSN, { prepare: false, max: 1 });

  try {
    log('═══ Over-received PO lines — repair ═══');
    log(APPLY ? 'MODE: APPLY (writes)' : 'MODE: DRY-RUN (no writes; set APPLY=1 to write)');
    log('');

    const rows = await sql`
      SELECT poi.id                AS po_item_id,
             po.po_number          AS po_number,
             poi.material_code     AS material_code,
             poi.qty               AS qty,
             poi.received_qty      AS received_qty,
             poi.unit_price_centi  AS unit_price_centi,
             gi.id                 AS grn_item_id,
             gi.grn_id             AS grn_id,
             gi.qty_accepted       AS qty_accepted,
             gi.qty_received       AS qty_received,
             gi.qty_rejected       AS qty_rejected,
             COALESCE(gi.returned_qty, 0) AS returned_qty,
             g.grn_number          AS grn_number,
             g.status::text        AS grn_status,
             g.migrated_no_stock   AS migrated,
             (SELECT COUNT(*) FROM scm.inventory_movements m
               WHERE m.source_doc_type = 'GRN' AND m.source_doc_id = g.id) AS movements
        FROM scm.purchase_order_items poi
        JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
        LEFT JOIN scm.grn_items gi ON gi.purchase_order_item_id = poi.id
        LEFT JOIN scm.grns g       ON g.id = gi.grn_id
       WHERE poi.received_qty > poi.qty
       ORDER BY po.po_number, poi.material_code, poi.id`;

    // Collapse the join back into one entry per PO line.
    const byLine = new Map();
    for (const r of rows) {
      if (!byLine.has(r.po_item_id)) {
        byLine.set(r.po_item_id, {
          poItemId: r.po_item_id,
          poNumber: r.po_number,
          materialCode: r.material_code,
          qty: Number(r.qty),
          receivedQty: Number(r.received_qty),
          unitPriceCenti: Number(r.unit_price_centi || 0),
          grnLines: [],
        });
      }
      if (r.grn_item_id) {
        byLine.get(r.po_item_id).grnLines.push({
          id: r.grn_item_id,
          grnId: r.grn_id,
          grnNumber: r.grn_number,
          status: r.grn_status,
          migrated: r.migrated,
          qtyAccepted: Number(r.qty_accepted || 0),
          qtyReceived: Number(r.qty_received || 0),
          qtyRejected: Number(r.qty_rejected || 0),
          returnedQty: Number(r.returned_qty || 0),
          movements: Number(r.movements || 0),
        });
      }
    }

    const lines = [...byLine.values()];
    const totalExcess = lines.reduce((s, l) => s + (l.receivedQty - l.qty), 0);
    log(`over-received PO lines found : ${lines.length}`);
    log(`excess units                 : ${totalExcess}`);
    log('');

    if (lines.length === 0) {
      log('Nothing to repair — every PO line is within its ordered qty.');
      return;
    }

    const { repair, skip } = planRepair(lines);

    log(`── PLAN ────────────────────────────────────────────────`);
    log(`lines to repair              : ${repair.length}`);
    log(`excess units to remove       : ${repair.reduce((s, r) => s + r.unitsRemoved, 0)}`);
    log(`GRN lines to correct         : ${repair.length}`);
    log(`  of those on migrated GRNs  : ${repair.filter((r) => r.migrated).length}`);
    log(`lines SKIPPED (not guessed)  : ${skip.length}`);
    for (const [reason, n] of Object.entries(
      skip.reduce((a, s) => ({ ...a, [s.reason]: (a[s.reason] ?? 0) + 1 }), {}),
    )) {
      log(`    ${reason}: ${n}`);
    }
    log('');
    log('INVENTORY MOVEMENTS: this script writes none, and skips any line whose GRN has any.');
    log('');

    for (const r of repair.slice(0, 40)) {
      log(`   ${r.poNumber} ${r.materialCode}: ordered ${r.qty}, received ${r.fromReceived} -> ${r.toReceived}` +
          `  |  ${r.grnNumber} accepted ${r.fromAccepted} -> ${r.toAccepted}${r.migrated ? ' [migrated]' : ''}`);
    }
    if (repair.length > 40) log(`   ... and ${repair.length - 40} more`);

    if (skip.length) {
      log('');
      log('── SKIPPED, for a human ────────────────────────────────');
      for (const s of skip) log(`   ${s.poNumber} ${s.materialCode} [${s.reason}] ${s.detail}`);
    }

    if (!APPLY) {
      log('');
      log('DRY-RUN — nothing was written. Set APPLY=1 to apply the plan above.');
      return;
    }

    let done = 0;
    for (const r of repair) {
      await sql.begin(async (tx) => {
        // GRN line first, then the PO counter. Both writes move DOWNWARD, so
        // neither can trip the 0277 receipt-ceiling triggers in either order.
        await tx`UPDATE scm.grn_items
                    SET qty_accepted     = ${r.toAccepted},
                        qty_received     = ${r.toQtyReceived},
                        line_total_centi = ${r.toLineTotalCenti}
                  WHERE id = ${r.grnItemId}`;
        await tx`UPDATE scm.purchase_order_items
                    SET received_qty = ${r.toReceived}
                  WHERE id = ${r.poItemId}`;
      });
      done += 1;
      if (done % 25 === 0) log(`  ..${done}/${repair.length}`);
    }

    log('');
    log(`DONE. PO lines repaired: ${done}. GRN lines corrected: ${done}. Inventory movements written: 0.`);
    log('PO header statuses were deliberately NOT touched: every repaired line still has');
    log('received_qty == qty, so it remains fully received and no PO changes classification.');
  } finally {
    await sql.end();
  }
}

// Only run when executed directly, so the planner can be imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
