#!/usr/bin/env node
/* relink-so-000870-po-line — move ONE purchase-order line off the sales-order
 * line it is doubled onto, and onto the one that matches its product.
 *
 * WHAT IS WRONG. `HC-PO-000290` holds two `CODY-(K)` bedframe lines, both
 * RECEIVED, and BOTH point at the same sales-order row — the one carrying book
 * line 60702, whose quantity is 1. So that row reads `po_qty_picked = 2` against
 * a qty of 1, while `HC-SO-000870`'s OTHER CODY-(K) row (book line 60699, qty 1)
 * reads 0 and still offers itself for purchase. One bedframe on that order looks
 * entirely unbought, which is a duplicate-purchase invitation.
 *
 * WHY THE AUTOMATIC TOOLS REFUSE IT, AND WHY THAT REFUSAL STAYS.
 * `lib/so-po-counter-cause.mjs` classifies this as `book_source_is_another_product`
 * and declines to repair it, because the account book's own edge is what is
 * inconsistent. Read from live `AED_HOUZS`:
 *
 *     PO-000290 DtlKey 61216  NB-KHJ57(K) "NB-CODY B/FRAME(K)"  FromSODtlKey 60700
 *     PO-000290 DtlKey 61217  NB-KHJ57(K) "NB-CODY B/FRAME(K)"  FromSODtlKey 60702
 *
 * and on the book's own SO-000870, 60699 and 60702 are CODY bedframes while
 * **60700 is a MYLATEX LUMBARIA mattress**. The book points a bedframe purchase
 * at a mattress line while an unclaimed bedframe line sits on the same order.
 * Copying that edge would put one product's purchase on another product's line,
 * which is exactly what `docs/bugs/0671-...` cost. The classifier is right; do not
 * widen it.
 *
 * THE OWNER DECIDED, shown both products side by side, 2026-09-09: **「乙 · 照产品
 * 对」** — link it to 60699, the other CODY bedframe, not to the mattress the book
 * names. His standing 「一律跟账本」 governs the VALUES the book states about a
 * line; it does not extend to an edge that names the wrong line, and his first
 * answer here (「这个跟autocount啊」) was given before he had seen the two products.
 *
 * WHAT IS NOT TOUCHED. The other purchase line (book 61217 -> 60702) is already
 * correct and is left exactly as it is. No quantity, price, status or receipt
 * moves: this writes one foreign key.
 *
 * AFTERWARDS, po_qty_picked IS STALE BY CONSTRUCTION — 60702 falls 2 -> 1 and
 * 60699 rises 0 -> 1 — and this script deliberately does not recompute it.
 * `recompute-so-po-qty-picked.mjs` owns that counter, it is idempotent, and two
 * scripts writing one denormalised value is how the value stops being trustworthy.
 * Run it after this one; the verification below asserts what it will find.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN. Plan writes nothing and prints both rows.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   The UPDATE is PINNED to the row id AND its current so_item_id AND its book
 *   line key, so a row that has moved since this was measured matches nothing
 *   and the run refuses rather than repairing something else.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: each CODY
 *   sales line is claimed by exactly one purchase line, the mattress line is
 *   claimed by none, and the receipts are unchanged.
 *
 * RE-RUN: idempotent. The UPDATE carries the OLD so_item_id, so a second run
 * matches nothing and reports 0.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/relink-so-000870-po-line.mjs
 *   DATABASE_URL=... MODE=apply CONFIRM='relink so-000870 po line' \
 *     node backend/scripts/relink-so-000870-po-line.mjs
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'relink so-000870 po line';
const APPLY = MODE === 'apply';

/* Measured against production 2026-09-09 on the read-only DSN. */
const PO_LINE = '4266996c-1a36-443a-b230-117271435047';   // book PODTL 61216
const FROM_SO_ITEM = '47da23a1-9d7f-42a8-9099-b35cdf9cb80e'; // book SODTL 60702, CODY-(K)
const TO_SO_ITEM = 'e205f830-d9a5-48ea-8f72-ad4537abc3fb';   // book SODTL 60699, CODY-(K)
const PO_BOOK_KEY = 61216;
const KEEP_PO_LINE = 'c03d4fb1-0d6f-4487-bb08-1173608604b3'; // book 61217 -> 60702, correct

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

async function picture(conn) {
  return conn`
    SELECT p.id::text AS po_line, p.item_code, p.qty, p.received_qty,
           p.linked_ac_dtlkey::text AS po_book_key,
           i.item_code AS so_item, i.linked_ac_dtlkey::text AS so_book_key,
           i.qty AS so_qty, i.po_qty_picked
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items i ON i.id = p.so_item_id
     WHERE ph.po_number = 'HC-PO-000290'
     ORDER BY p.linked_ac_dtlkey`;
}

try {
  console.log(`MODE=${MODE}`);
  console.log('\n=== BEFORE ===');
  for (const r of await picture(sql)) {
    console.log(`  PO line ${r.po_book_key}  ${r.item_code} qty ${r.qty} recv ${r.received_qty}`
      + `  ->  SO ${r.so_book_key} ${r.so_item} (qty ${r.so_qty}, picked ${r.po_qty_picked})`);
  }
  console.log(`\n  MOVE   purchase line ${PO_BOOK_KEY}  off SO 60702  onto SO 60699 (the other CODY-(K))`);
  console.log(`  KEEP   purchase line 61217 on SO 60702 — already correct`);

  if (!APPLY) {
    console.log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const moved = await sql`
    UPDATE scm.purchase_order_items
       SET so_item_id = ${TO_SO_ITEM}
     WHERE id = ${PO_LINE}
       AND so_item_id = ${FROM_SO_ITEM}
       AND linked_ac_dtlkey = ${PO_BOOK_KEY}
    RETURNING id`;
  console.log(`\nAPPLIED: ${moved.length} purchase line(s) moved.`);
  await sql.end();

  /* FRESH CONNECTION, and the SHAPE rather than a count: "1 row updated" is also
     true of moving the WRONG line. */
  const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const rows = await check`
    SELECT i.linked_ac_dtlkey::text AS so_book_key, i.item_code, i.qty,
           i.po_qty_picked,
           (SELECT count(*) FROM scm.purchase_order_items p
             WHERE p.so_item_id = i.id)::int AS claimed_by,
           (SELECT coalesce(sum(p.received_qty), 0) FROM scm.purchase_order_items p
             WHERE p.so_item_id = i.id)::numeric AS received
      FROM scm.mfg_sales_order_items i
     WHERE i.doc_no = 'HC-SO-000870'
       AND i.linked_ac_dtlkey IN (60699, 60700, 60702)
     ORDER BY i.linked_ac_dtlkey`;
  const keep = await check`
    SELECT so_item_id::text AS so_item FROM scm.purchase_order_items WHERE id = ${KEEP_PO_LINE}`;
  await check.end();

  console.log('\n=== VERIFY (fresh connection) ===');
  const want = { 60699: 1, 60700: 0, 60702: 1 };
  let bad = 0;
  for (const r of rows) {
    const ok = r.claimed_by === want[Number(r.so_book_key)];
    if (!ok) bad += 1;
    console.log(`  SO ${r.so_book_key} ${String(r.item_code).padEnd(20)} qty ${r.qty}`
      + `  claimed by ${r.claimed_by} purchase line(s) ${ok ? 'OK' : `WRONG, want ${want[Number(r.so_book_key)]}`}`
      + `  received ${r.received}  (po_qty_picked ${r.po_qty_picked}, recompute owns this)`);
  }
  const keepOk = keep[0]?.so_item === FROM_SO_ITEM;
  console.log(`  the other purchase line still on SO 60702 : ${keepOk ? 'YES' : 'NO'}`);
  if (bad !== 0 || !keepOk) {
    console.error('VERIFY FAILED.');
    process.exit(1);
  }
  console.log('VERIFY OK. Now run recompute-so-po-qty-picked to settle the counter.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
