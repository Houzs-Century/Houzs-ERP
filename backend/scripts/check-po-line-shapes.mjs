// READ-ONLY. The two purchase-order-line shapes that hide an open purchase
// order from the MRP page, counted and listed wherever they exist.
//
// WHY THIS IS A SWEEP AND NOT A GUARD. Since 2026-09-09 a company-1 hard-bound
// line (sofa / bedframe / `(SP)` mattress) is covered ONLY by a PO line that
// (a) carries its `so_item_id` and (b) sits on a hard-bound `item_group` —
// `isDedicated` in `scm/routes/mrp.ts`, then section 8's `boundSofa` walk.
// Fail either and MRP calls the sales-order line SHORT while the purchase order
// sits open, and the buyer is told to order goods already on order
// (owner-reported 2026-09-11: HC-PO-010045 / HC-SO-011114 failed (a),
// HC-PO-010087 / HC-SO-013389 failed (b)).
//
// Four routes write a purchase-order line. `convert-from-SO` was the one that
// did not resolve the category from the SKU master, and that is now fixed
// (docs/bugs/0813). **What was never established is which route wrote the rows
// found on 2026-09-11** — the four unlinked lines were born 2026-09-10 17:38-17:44
// UTC with no PO amendment on their documents and no workflow running in that
// window, so the write came through the app and the route is UNKNOWN.
//
// Guarding a route I cannot name would be a fix built on a guess, and refusing
// a write people make daily is the hard wall the owner's standing rule says not
// to build. A sweep catches the SHAPE whichever door produced it, and if one
// keeps reappearing after today's fix, that recurrence is the evidence that
// names the remaining route. Turn it into a guard THEN, not now.
//
// Exits 0 for every legitimate answer INCLUDING a non-empty one: the answer is
// the output, and a red job would read as "the check broke". Reserve non-zero
// for an unreachable database.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const COMPANY = String(process.env.COMPANY ?? "1");

const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

/* Ported from `isHardBoundLine` (scm/lib/so-stock-allocation.ts). Held as one
   predicate so the sweep and the engine cannot disagree about which lines the
   rule covers. Change one, change the other. */
const HARD_BOUND = (t) => sql`(lower(coalesce(${t}.item_group,'')) in ('sofa','bedframe')
  or (lower(coalesce(${t}.item_group,'')) = 'mattress' and ${t}.item_code ~* '\(SP\)\s*$'))`;

/* SELF-TEST. A checker that cannot match must refuse to report, never report a
   clean run (CLAUDE.md: "a verdict computed over nothing must never read as a
   pass"). Both needles are asserted to find SOMETHING before any verdict below
   is trusted: hard-bound lines exist, and catalogued sofa SKUs exist. */
const [{ bound_lines }] = await sql`
  select count(*)::int bound_lines from scm.purchase_order_items it
  where it.company_id::text = ${COMPANY} and ${HARD_BOUND(sql`it`)}`;
const [{ sofa_skus }] = await sql`
  select count(*)::int sofa_skus from scm.mfg_products
  where company_id::text = ${COMPANY} and category::text = 'SOFA'`;
if (bound_lines === 0 || sofa_skus === 0) {
  console.error(`SELF-CHECK FAILED: hard-bound PO lines=${bound_lines}, catalogued sofa SKUs=${sofa_skus}.`);
  console.error("One of the needles matches nothing, so a zero below would mean the matcher is dead, not that the data is clean.");
  await sql.end();
  process.exit(1);
}
notice(`self-check ok — ${bound_lines} hard-bound PO line(s), ${sofa_skus} catalogued sofa SKU(s)`);

/* SHAPE A — a hard-bound PO line with no sales-order link. It can never cover
   a line, and its quantity still counts as PO Outstanding on the SKU row, so
   the page reads "someone ordered this" and no line is lit by it. */
const shapeA = await sql`
  select p.po_number, p.status::text st, it.item_code, it.item_group,
         it.qty, coalesce(it.received_qty,0)::int recv, it.created_at::text born
  from scm.purchase_order_items it
  join scm.purchase_orders p on p.id = it.purchase_order_id
  where it.company_id::text = ${COMPANY}
    and it.so_item_id is null
    and ${HARD_BOUND(sql`it`)}
    and p.status::text <> 'CANCELLED'
  order by it.created_at desc`;

/* SHAPE B — a PO line linked to a hard-bound sales-order line while its OWN
   group is not hard-bound. Linked and still invisible, which is the harder of
   the two to see from the screen: the PO names the right order. */
const shapeB = await sql`
  select p.po_number, p.status::text st, it.item_code,
         it.item_group po_group, i.item_group so_group, i.doc_no,
         coalesce(it.received_qty,0)::int recv, it.created_at::text born
  from scm.purchase_order_items it
  join scm.purchase_orders p on p.id = it.purchase_order_id
  join scm.mfg_sales_order_items i on i.id = it.so_item_id
  where it.company_id::text = ${COMPANY}
    and p.status::text <> 'CANCELLED'
    and i.cancelled = false
    and ${HARD_BOUND(sql`i`)}
    and not ${HARD_BOUND(sql`it`)}
  order by it.created_at desc`;

/* SHAPE C — the same disagreement one level up: the PO line's group contradicts
   its own SKU's catalogued category. Wider than B (it does not need a link) and
   it is what the 2026-08-22 SKU rule exists to prevent, so a hit here says a
   write path is still not applying that rule. */
const shapeC = await sql`
  select p.po_number, p.status::text st, it.item_code,
         it.item_group po_group, pr.category::text sku_category,
         it.created_at::text born
  from scm.purchase_order_items it
  join scm.purchase_orders p on p.id = it.purchase_order_id
  join scm.mfg_products pr on pr.code = it.item_code and pr.company_id = it.company_id
  where it.company_id::text = ${COMPANY}
    and p.status::text <> 'CANCELLED'
    and lower(coalesce(it.item_group,'')) <> lower(pr.category::text)
  order by it.created_at desc`;

console.log(`\n=== A — hard-bound PO line with NO sales-order link (${shapeA.length}) ===`);
if (shapeA.length === 0) console.log("  none");
for (const r of shapeA) {
  console.log(`  ${pad(r.po_number, 16)}${pad(r.item_code, 20)}${pad(r.item_group, 10)}${pad(r.st, 12)}qty ${r.qty} recv ${r.recv}  born ${r.born}`);
}

console.log(`\n=== B — linked to a hard-bound SO line, but the PO line's own group is not (${shapeB.length}) ===`);
if (shapeB.length === 0) console.log("  none");
for (const r of shapeB) {
  console.log(`  ${pad(r.po_number, 16)}${pad(r.item_code, 20)}${pad(`${r.po_group} vs SO ${r.so_group}`, 26)}${pad(r.doc_no, 16)}born ${r.born}`);
}

console.log(`\n=== C — the PO line's group contradicts its own SKU's category (${shapeC.length}) ===`);
if (shapeC.length === 0) console.log("  none");
for (const r of shapeC.slice(0, 40)) {
  console.log(`  ${pad(r.po_number, 16)}${pad(r.item_code, 20)}${pad(`${r.po_group} vs SKU ${r.sku_category}`, 28)}born ${r.born}`);
}
if (shapeC.length > 40) console.log(`  … and ${shapeC.length - 40} more`);

const total = shapeA.length + shapeB.length + shapeC.length;
notice(`PO line shapes: A=${shapeA.length} unlinked, B=${shapeB.length} mis-grouped+linked, C=${shapeC.length} disagree with the SKU`);
if (total === 0) {
  console.log("\nNothing to repair. A and B are what hide an open purchase order from MRP; C is the rule that prevents them.");
} else {
  console.log(`\n${total} row(s) carry a shape that hides a purchase order, or the rule that prevents it.`);
  console.log("A and B are repairable by backend/scripts/repair-mrp-po-line-links.mjs (plan first).");
  console.log("A row BORN after 2026-09-11 is the finding that matters: it means a write path still produces the shape, and its created_at + document name which one.");
}
await sql.end();
