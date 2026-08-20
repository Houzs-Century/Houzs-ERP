#!/usr/bin/env node
// READ-ONLY sentinel for delivery lines that have lost their Sales-Order link.
//
// WHAT IT WATCHES. `delivery_order_items.so_item_id` is the key MRP's
// delivered-netting and the CONFIRMED -> DELIVERED flip resolve on. On
// 2026-08-17 twenty-six live lines were found with it NULL under a DO whose
// header still named the order: the goods had shipped, the orders read
// CONFIRMED, and MRP was asking Procurement to buy them again. #2225 closed the
// write-side hole and #2355 gave both engines a second reading off the DO
// header, so the SYMPTOM is covered twice over.
//
// SO WHY AN ALARM AT ALL. Because the CAUSE was never found. Neither closed
// theory fits: the FK's ON DELETE SET NULL needs the SO line deleted, and those
// lines are all still present with their original created_at; #2225's
// client-omits-the-field needs a write path that does not set it, and
// 2990-DO-2608-008 came through POST /from-sos, which does, and flipped its SO
// to DELIVERED six seconds later — impossible without the links. A third
// mechanism blanked them and it is still live.
//
// The fix makes that mechanism SILENT, and that is the exact reason this file
// exists. Before, corruption announced itself as a wrong MRP row somebody
// eventually complained about. Now the fallback absorbs it and nothing looks
// wrong — until an order shape the fallback cannot reach comes along. An
// invariant nobody measures is one that quietly stops holding.
//
// EXITS NON-ZERO on alarm so the scheduled workflow FAILS and the owner gets
// the standard failed-workflow email — the same alarm channel
// mirror-drift-sentinel.mjs uses, and the only notifier this repo has.
//
// IT DOES NOT GO GREEN WHEN IT CANNOT CHECK. mirror-drift-sentinel.mjs spent
// months printing SKIP and exiting 0 against credentials nobody had set, and a
// real stall sat under that green tick for days. DATABASE_URL is a secret this
// repo already has and already uses; its absence here is a misconfiguration,
// not a reason to report health, so it exits 1.
//
// Usage: node backend/scripts/do-link-orphan-sentinel.mjs
import postgres from "postgres";

/* BASELINE = the orphans that are known, understood and deliberately left.
   Exactly one on 2026-08-17: 2990-DO-2607-013's NTYR pillow. Its SO line
   (2990-SO-2606-030, ordered 1) is already fully delivered by
   2990-DO-2608-010, so re-linking it would report 2 delivered against 1
   ordered. repair-do-so-item-links.mjs refuses it by design and a human has to
   decide whether it is a re-delivery or a duplicate document.

   RAISING THIS NUMBER TO GET GREEN IS THE ONE THING NOT TO DO. It is the count
   of orphans we have an ANSWER for, not a tolerance. A new orphan is the event
   this sentinel exists to report. */
const BASELINE_ORPHANS = 1;

/* BASELINE = goods lines that carry NO warehouse and therefore can never be
   allocated stock (allocation buckets by warehouse+item+variant). Ten on
   2026-08-18, every one on a 2990 order whose header has no state, no
   sales_location and no city — nothing can derive a warehouse for them, so
   they wait for a human to assign one. The other eight found that day were
   repaired from their orders' own sibling warehouse.
   Same rule as above: this is the count we have an ANSWER for, not a
   tolerance. A new one means a write path is still dropping the field.
   Related: lib/null-warehouse-signal.ts logs the path as it happens. */
const BASELINE_NULL_WAREHOUSE = 10;

/* BASELINE = from_mrp PO lines whose so_item_id is NULL and cannot be rebound
   by force (their source SO's lines are already claimed by a different PO).
   Two on 2026-08-19, both on 2990-PO-2606-016 — a human question, not a
   matching one. 39 such lines existed that day (35% of every from_mrp line in
   use) and NOTHING reported them; 37+3 were rebound 1:1 from each PO's own
   'From SOs:' note. Same ON DELETE SET NULL family as the DO side above — but
   the DO side at least announces itself through MRP re-ordering; the PO side
   has no tell: bound-mode readiness cannot tie received stock to its order,
   so the SO sits at PENDING while the goods sit on the shelf. Same rule as
   every baseline here: the count we have an ANSWER for, never a tolerance. */
const BASELINE_PO_UNBOUND = 2;

const url = process.env.SENTINEL_HOUZS_DB_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("FAIL: no DATABASE_URL (or SENTINEL_HOUZS_DB_URL). This sentinel does not report health it did not measure.");
  process.exit(1);
}

const alarms = [];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  /* 1. Orphan lines under a DO that still NAMES its Sales Order. These are the
        ones #2355's fallback can still attribute, so they do not (yet) produce
        a wrong MRP figure — but each one is a fresh instance of the unexplained
        mechanism, which is what we are here to catch. */
  const [{ orphans, docs }] = await pg`
    SELECT COUNT(*)::int AS orphans, COUNT(DISTINCT d.id)::int AS docs
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
     WHERE d.so_doc_no IS NOT NULL
       AND d.status::text <> 'CANCELLED'
       AND di.so_item_id IS NULL`;

  /* 1b. WHICH lines — because the ALARM has told the reader to "cross-check the
         SO-line deletes printed above" since the day it was written, while
         printing only a COUNT. There was nothing to cross-check against, so the
         instruction could not be followed by anyone, ever.

         Naming the documents is what turns this from an alert into a diagnosis:
         the leading theory (2026-08-20) is that the SVC-DELIVERY rebuild at
         mfg-sales-orders.ts:6436 deletes and reinserts the delivery-charge line,
         and ON DELETE SET NULL blanks any DO line pointing at the old one. That
         theory predicts these rows are DELIVERY-CHARGE lines. If they are beds
         and mattresses, it is wrong — which is the point of printing them. */
  const orphanRows = await pg`
    SELECT d.do_number AS do_doc_no, d.so_doc_no, di.item_code, di.qty
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
     WHERE d.so_doc_no IS NOT NULL
       AND d.status::text <> 'CANCELLED'
       AND di.so_item_id IS NULL
     ORDER BY d.do_number, di.item_code
     LIMIT 50`;

  /* 2. The shape the fallback CANNOT see: no per-line link AND no so_doc_no on
        the header, so neither reading can attribute the shipment. Zero today.
        This is a stricter alarm than (1) — any of these is already causing a
        wrong figure somewhere, not merely at risk of it. */
  const [{ invisible }] = await pg`
    SELECT COUNT(*)::int AS invisible
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
     WHERE d.so_doc_no IS NULL
       AND d.status::text <> 'CANCELLED'
       AND di.so_item_id IS NULL
       AND EXISTS (SELECT 1 FROM scm.inventory_movements m
                    WHERE m.source_doc_id = d.id AND m.source_doc_type::text = 'DO')`;

  /* 3. Did anything DELETE an SO line since the last run? Read from mig 0302's
        forensic table. Not an alarm on its own — deleting a line is a legal
        operation — but printed WITH the orphan count so the two can be
        correlated by eye in one place. If orphans rise and this stayed empty,
        the FK path is falsified and that theory can be retired. */
  /* 3. Goods lines with no warehouse. A NULL-warehouse line matches no
        allocation bucket, so it never leaves PENDING and never shows an
        incoming PO — even when its goods have been received into the right
        bucket in the right warehouse. Reported 2026-08-18 as "the system did
        not capture the data"; three separate write paths had produced 18 of
        them since June, and none of the three said anything at the time. */
  const [{ nullWarehouse }] = await pg`
    SELECT COUNT(*)::int AS "nullWarehouse"
      FROM scm.mfg_sales_order_items s
      JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
     WHERE s.cancelled = false
       AND s.warehouse_id IS NULL
       AND s.item_group <> 'service'
       AND h.status::text NOT IN ('CANCELLED','DRAFT')`;

  /* 3b. PO->SO links lost on the purchase side. from_mrp marks lines raised
        FROM a Sales Order (both converters stamp it), so every one of these
        is a line that HAD a link and lost it. */
  const [{ poUnbound }] = await pg`
    SELECT COUNT(*)::int AS "poUnbound"
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.status::text NOT IN ('CANCELLED','DRAFT')
       AND i.from_mrp = true
       AND i.so_item_id IS NULL`;

  const recentDeletes = await pg`
    SELECT to_char(deleted_at, 'YYYY-MM-DD HH24:MI') AS at, doc_no, item_code,
           COALESCE(jwt_claims->>'email', jwt_claims->>'sub', db_user) AS who,
           application_name
      FROM scm.mfg_so_item_deletions
     WHERE deleted_at > now() - interval '25 hours'
     ORDER BY deleted_at DESC
     LIMIT 20`.catch(() => []); // table absent until 0302 deploys — not an alarm

  console.log(`orphan DO lines (header names the SO): ${orphans} across ${docs} document(s) [baseline ${BASELINE_ORPHANS}]`);
  if (orphanRows.length > 0) {
    console.log(`  the orphaned lines (up to 50) — item_code is the cross-check:`);
    for (const r of orphanRows) {
      console.log(`    ${r.do_doc_no ?? "-"}  from ${r.so_doc_no ?? "-"}  ${r.item_code ?? "-"}  qty ${r.qty ?? "?"}`);
    }
  }
  console.log(`unattributable lines (no link, no so_doc_no, stock moved): ${invisible}`);
  console.log(`SO-line deletes in the last 25h: ${recentDeletes.length}`);
  console.log(`goods lines with no warehouse: ${nullWarehouse} [baseline ${BASELINE_NULL_WAREHOUSE}]`);
  console.log(`from_mrp PO lines with no SO link: ${poUnbound} [baseline ${BASELINE_PO_UNBOUND}]`);
  for (const d of recentDeletes) {
    console.log(`  ${d.at}  ${d.doc_no ?? "-"}  ${d.item_code ?? "-"}  by ${d.who ?? "?"}  (${d.application_name ?? "-"})`);
  }

  if (orphans > BASELINE_ORPHANS) {
    alarms.push(
      `${orphans - BASELINE_ORPHANS} NEW orphaned delivery line(s) since the 2026-08-17 repair ` +
      `(${orphans} total vs baseline ${BASELINE_ORPHANS}). The mechanism that blanks so_item_id is live. ` +
      `Cross-check the SO-line deletes printed above: if none match, the ON DELETE SET NULL FK is NOT the cause.`,
    );
  }
  if (poUnbound > BASELINE_PO_UNBOUND) {
    alarms.push(
      `${poUnbound - BASELINE_PO_UNBOUND} NEW unbound from_mrp PO line(s) (${poUnbound} total vs baseline ${BASELINE_PO_UNBOUND}). ` +
      `Each was raised FROM a Sales Order and lost its so_item_id — bound-mode readiness cannot tie its received ` +
      `stock to the order, so the SO sits at PENDING while the goods sit on the shelf. ` +
      `Repair: the repair-do-so-item-links.mjs pattern, source SO from the PO's own note.`,
    );
  }
  if (nullWarehouse > BASELINE_NULL_WAREHOUSE) {
    alarms.push(
      `${nullWarehouse - BASELINE_NULL_WAREHOUSE} NEW goods line(s) written with no warehouse ` +
      `(${nullWarehouse} total vs baseline ${BASELINE_NULL_WAREHOUSE}). They can never be allocated stock: ` +
      `they will sit at PENDING with no incoming PO while their goods sit in the warehouse. ` +
      `Grep the Worker log for [null-warehouse] — it names the write path, the document and the item.`,
    );
  }
  if (invisible > 0) {
    alarms.push(
      `${invisible} delivery line(s) carry neither a per-line SO link nor a so_doc_no on the header, ` +
      `and stock moved against them. Neither coverage reading can see these — MRP is wrong about them right now.`,
    );
  }
} finally {
  await pg.end({ timeout: 5 });
}

if (alarms.length > 0) {
  console.error("\nALARM:");
  for (const a of alarms) console.error(`  - ${a}`);
  process.exit(1);
}
console.log("\nOK — no new orphaned delivery lines.");
