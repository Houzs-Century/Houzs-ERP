#!/usr/bin/env node
/* repair-delivered-status-and-sofa-links — two repairs the owner approved on
 * 2026-09-09, both of them cutover residue, neither of them a code defect.
 *
 * CASE A — a delivered line still reads PENDING.
 *   `so-delivery-sync.ts:345` is the sole writer that lands a fully shipped line
 *   on READY, and it fires on a DO / DR mutation. The August cutover wrote its
 *   delivery orders STRAIGHT INTO THE DATABASE, so it never fired for them and
 *   those lines kept whatever status they had — PENDING, for goods that shipped
 *   off a purchase order. `docs/bugs/0738` fixed the CONSEQUENCE (the roll-up no
 *   longer counts such a line as short); this fixes the DATA, so every other
 *   reader of the raw column sees the truth too.
 *   The write is exactly what the reconciler would have written:
 *   `stock_status='READY', stock_qty_ready=qty`.
 *
 * CASE B — HC-PO-009024's three sofa lines carry no sales-order link.
 *   The purchase order was raised FOR HC-SO-012025 (WINNIE) and lists all five
 *   pieces; three of its lines were never linked. The consequence is on two
 *   screens: MRP asks the buyer to order three sofa pieces that are already on
 *   order, and the sales line can never read READY, because a company-1 sofa
 *   line lights ONLY through its own purchase order (HARD_BOUND_COMPANY_ID).
 *   The two documents list the SAME five pieces — verified before this script
 *   was written — so this is a linking gap, not a content mismatch.
 *
 * NOT IN THIS SCRIPT, and the reason is the point of running a plan first.
 * HC-PO-010085 / HC-SO-010287 (Jack Lai, the mirrored arms) was the third
 * approved repair. Re-read on 2026-09-09 before writing anything, that purchase
 * order now lists `9058-1A(RHF)` + `9058-2A(LHF)` — the SAME multiset as its
 * sales order — and all three of its lines are linked. Somebody corrected it
 * between the measurement and the repair. Building the fix from the earlier
 * reading would have written a "correction" onto data that is already right.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN. Plan writes nothing and prints every row.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE, not a
 *   row count — a count was what let the jsonb double-encoding repair reproduce
 *   the bug it was written to undo on 7 production rows.
 *
 * RE-RUN: idempotent. Case A's UPDATE carries `stock_status <> 'READY'` and
 * case B's carries `so_item_id IS NULL`, so a second run selects nothing, writes
 * nothing and reports 0 rows — the same shape as a first run against a clean
 * database. It is safe to run twice, and safe to run after the allocator has
 * already moved some of the population.
 *
 * Env:  DATABASE_URL (required)
 *       MODE=plan|apply (default plan)
 *       CONFIRM (required when MODE=apply)
 *       ONLY=A|B  optional, run one case
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/repair-delivered-status-and-sofa-links.mjs
 *   DATABASE_URL=... MODE=apply CONFIRM='repair delivered status and sofa links' \
 *     node backend/scripts/repair-delivered-status-and-sofa-links.mjs
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'repair delivered status and sofa links';
const ONLY = (process.env.ONLY ?? '').toUpperCase();
const APPLY = MODE === 'apply';

const PO_NUMBER = 'HC-PO-009024';
const SO_DOC_NO = 'HC-SO-012025';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}'. Refusing to write.`);
  process.exit(2);
}

const out = (m = '') => console.log(m);
const head = (m) => { out(''); out('='.repeat(76)); out(m); out('='.repeat(76)); };

const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20 });

/* The population, expressed ONCE. Both the plan, the write and the verification
   read it from here — a repair whose verification re-derives its own population
   is checking a different question from the one it wrote. */
const staleDeliveredLines = () => sql`
  SELECT i.id, i.doc_no, i.item_code, i.qty, i.stock_status, i.stock_qty_ready
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE h.company_id = 1
     AND COALESCE(i.cancelled, false) = false
     AND i.qty > 0
     AND h.status NOT IN ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED','DRAFT')
     AND UPPER(COALESCE(i.item_group,'')) NOT LIKE '%SERVICE%'
     AND COALESCE(i.stock_status,'') <> 'READY'
     AND COALESCE((
           SELECT SUM(d.qty) FROM scm.delivery_order_items d
             JOIN scm.delivery_orders dh ON dh.id = d.delivery_order_id
            WHERE d.so_item_id = i.id AND dh.status NOT IN ('CANCELLED','DRAFT')
         ), 0) >= i.qty
   ORDER BY i.doc_no, i.item_code`;

/* Case B pairs a PO line to an SO line BY ITEM CODE inside one document pair.
   The product-identity gate is therefore structural, not an afterthought: a pair
   that does not name the same product cannot be produced by this query at all.
   Skipping that comparison is what put nine sales-order lines on a different bed
   (docs/bugs/0671). */
const sofaLinkPairs = () => sql`
  SELECT p.id AS po_item_id, p.item_code, p.qty AS po_qty,
         s.id AS so_item_id, s.qty AS so_qty, s.line_no
    FROM scm.purchase_order_items p
    JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
    JOIN scm.mfg_sales_order_items s
      ON s.doc_no = ${SO_DOC_NO}
     AND COALESCE(s.cancelled, false) = false
     AND UPPER(TRIM(s.item_code)) = UPPER(TRIM(p.item_code))
   WHERE ph.po_number = ${PO_NUMBER}
     AND p.so_item_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM scm.purchase_order_items x
        WHERE x.so_item_id = s.id AND x.id <> p.id)
   ORDER BY p.item_code`;

async function main() {
  head(`REPAIR — MODE=${MODE}${ONLY ? ` ONLY=${ONLY}` : ''}`);
  out(APPLY ? 'APPLY: rows below WILL be written.' : 'PLAN: nothing is written.');

  let caseARows = [];
  let caseBRows = [];

  if (ONLY !== 'B') {
    head('CASE A — delivered lines still reading PENDING');
    caseARows = await staleDeliveredLines();
    out(`${caseARows.length} line(s) across ${new Set(caseARows.map((r) => r.doc_no)).size} order(s).`);
    out('');
    for (const r of caseARows.slice(0, 25)) {
      out(`  ${r.doc_no.padEnd(16)} ${String(r.item_code ?? '').slice(0, 26).padEnd(26)} qty ${String(r.qty).padEnd(4)} ${r.stock_status} -> READY (qty_ready ${r.stock_qty_ready} -> ${r.qty})`);
    }
    if (caseARows.length > 25) out(`  ... and ${caseARows.length - 25} more`);
  }

  if (ONLY !== 'A') {
    head(`CASE B — ${PO_NUMBER} lines with no link to ${SO_DOC_NO}`);
    caseBRows = await sofaLinkPairs();
    out(`${caseBRows.length} pair(s) — each matched BY ITEM CODE inside this one document pair.`);
    out('');
    for (const r of caseBRows) {
      out(`  PO line ${String(r.item_code).padEnd(24)} qty ${r.po_qty}  ->  SO line_no ${String(r.line_no).padEnd(4)} qty ${r.so_qty}`);
    }
    /* THE COUNT IS A GATE, not a report. This repair was written against a
       document pair whose unlinked remainder was exactly three; if it is not,
       something moved and a human should look before anything is written. */
    if (caseBRows.length !== 3) {
      out('');
      out(`REFUSING case B: expected exactly 3 unlinked pairs, found ${caseBRows.length}.`);
      out('The document pair has changed since this repair was written. Re-measure first.');
      if (APPLY) { await sql.end({ timeout: 5 }); process.exit(3); }
    }
  }

  if (!APPLY) {
    head('PLAN ONLY — nothing written');
    out(`To apply:  MODE=apply CONFIRM='${CONFIRM_PHRASE}'`);
    await sql.end({ timeout: 5 });
    return;
  }

  head('APPLYING');
  let wroteA = 0;
  let wroteB = 0;

  if (ONLY !== 'B' && caseARows.length > 0) {
    for (const r of caseARows) {
      const res = await sql`
        UPDATE scm.mfg_sales_order_items
           SET stock_status = 'READY', stock_qty_ready = ${r.qty}
         WHERE id = ${r.id} AND stock_status <> 'READY'`;
      wroteA += res.count ?? 0;
    }
    out(`case A: ${wroteA} line(s) updated.`);
  }

  if (ONLY !== 'A' && caseBRows.length === 3) {
    for (const r of caseBRows) {
      const res = await sql`
        UPDATE scm.purchase_order_items
           SET so_item_id = ${r.so_item_id}
         WHERE id = ${r.po_item_id} AND so_item_id IS NULL`;
      wroteB += res.count ?? 0;
    }
    out(`case B: ${wroteB} link(s) written.`);
  }

  await sql.end({ timeout: 5 });

  /* ── VERIFY ON A FRESH CONNECTION, AND ON THE SHAPE ──────────────────────
     A new client, so nothing is read back out of the writing session's state,
     and the assertions are about what the rows now LOOK LIKE — not how many
     were touched. A row count is exactly what reported 7 of 7 while the jsonb
     repair was reproducing the bug it existed to undo. */
  head('VERIFY (fresh connection, shape not count)');
  const v = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20 });
  let bad = 0;
  try {
    if (ONLY !== 'B') {
      const left = await v`
        SELECT count(*)::int AS n FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
         WHERE h.company_id = 1 AND COALESCE(i.cancelled,false) = false AND i.qty > 0
           AND h.status NOT IN ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED','DRAFT')
           AND UPPER(COALESCE(i.item_group,'')) NOT LIKE '%SERVICE%'
           AND COALESCE(i.stock_status,'') <> 'READY'
           AND COALESCE((SELECT SUM(d.qty) FROM scm.delivery_order_items d
                           JOIN scm.delivery_orders dh ON dh.id = d.delivery_order_id
                          WHERE d.so_item_id = i.id AND dh.status NOT IN ('CANCELLED','DRAFT')),0) >= i.qty`;
      out(`  case A: delivered lines still not READY = ${left[0].n}  (expected 0)`);
      if (left[0].n !== 0) bad += 1;

      /* THE SHAPE: a repaired line must carry qty_ready EQUAL to its qty. A
         status of READY with qty_ready 0 is the half-written row this asserts
         against, and no row count can see it. */
      const shape = await v`
        SELECT count(*)::int AS n FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
         WHERE h.company_id = 1 AND i.stock_status = 'READY'
           AND COALESCE(i.stock_qty_ready,0) <> i.qty
           AND COALESCE((SELECT SUM(d.qty) FROM scm.delivery_order_items d
                           JOIN scm.delivery_orders dh ON dh.id = d.delivery_order_id
                          WHERE d.so_item_id = i.id AND dh.status NOT IN ('CANCELLED','DRAFT')),0) >= i.qty`;
      out(`  case A: delivered READY lines whose qty_ready <> qty = ${shape[0].n}  (expected 0)`);
      if (shape[0].n !== 0) bad += 1;
    }

    if (ONLY !== 'A') {
      const rows = await v`
        SELECT p.item_code, p.so_item_id, s.item_code AS so_item_code, s.doc_no
          FROM scm.purchase_order_items p
          JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
          LEFT JOIN scm.mfg_sales_order_items s ON s.id = p.so_item_id
         WHERE ph.po_number = ${PO_NUMBER} AND p.item_code ~ '^[0-9]{4}-'
         ORDER BY p.item_code`;
      const unlinked = rows.filter((r) => !r.so_item_id).length;
      /* THE SHAPE, and it is the one that matters: every link must point at a
         line on the RIGHT ORDER naming the SAME product. A link that exists but
         points elsewhere is worse than no link, and counting links cannot see
         it. */
      const wrong = rows.filter((r) => r.so_item_id
        && (r.doc_no !== SO_DOC_NO
          || String(r.so_item_code ?? '').trim().toUpperCase() !== String(r.item_code ?? '').trim().toUpperCase()));
      out(`  case B: ${PO_NUMBER} sofa lines still unlinked = ${unlinked}  (expected 0)`);
      out(`  case B: links pointing at the wrong order or a different product = ${wrong.length}  (expected 0)`);
      if (unlinked !== 0 || wrong.length !== 0) bad += 1;
      for (const r of rows) {
        out(`     ${String(r.item_code).padEnd(24)} -> ${r.so_item_id ? `${r.doc_no} ${r.so_item_code}` : 'UNLINKED'}`);
      }
    }
  } finally {
    await v.end({ timeout: 5 });
  }

  head(bad === 0 ? 'VERIFIED' : 'VERIFICATION FAILED');
  if (bad !== 0) process.exit(1);
  out('');
  out('FOLLOW-UP, not done here: case B changes what po_qty_picked should be for');
  out('those sales-order lines. recomputeSoPicked is self-healing and re-derives');
  out('it on the next operation that touches them; the stock allocator re-runs on');
  out('its own five-minute sweep and will light the sofa from its received PO.');
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
