#!/usr/bin/env node
// ---------------------------------------------------------------------------
// reconcile-sku.mjs — read the ledger instead of reasoning about it.
//
// WHY THIS EXISTS. Owner, 2026-08-04, after I had changed my story twice about
// 2990-DO-2607-005: "你确定吗？因为那天你说这张 DO 没有出货、没有扣掉库存，现在又
// 说有扣掉库存 … 你就直接看我们的历史记录".
//
// He is right, and the method was the problem. My first answer came from a query
// that could not see unlinked lines; my third came from a movement list printed
// with LIMIT 8 that I read as a complete history. Both were inference dressed as
// evidence. This script does what he asked, in his order:
//
//   PART 1  every GRN receipt, every DO shipment, every adjustment — COMPLETE,
//           no LIMIT anywhere — then the arithmetic against BOTH stock ledgers
//   PART 2  PO: what is still coming in
//   PART 3  SO: what is still due to go out
//   PART 4  the SO/DO linkage on each shipment, which is what decides whether
//           the "Assigned SO" a document shows is real or decorative
//
// WHAT THE TWO STOCK LEDGERS ARE, because they answer different questions and
// this is the distinction I kept blurring:
//
//   MOVEMENT balance = Σ(IN +qty, OUT -qty, ADJUSTMENT +qty, TRANSFER +qty)
//                      — signed exactly as the scm.inventory_balances VIEW does
//                      it. This is "how many units moved", and it is what the
//                      Inventory screen's `stock` column reads.
//   LOT balance      = Σ inventory_lots.qty_remaining
//                      — "how many units are claimable at a known cost". This is
//                      what FIFO consumes and what COGS is drawn from.
//
// They must agree. A DO can decrement the movement ledger and consume NO lot —
// that is a real, silent state (the OUT branch discards its shortfall,
// docs/inventory-ledger-divergence-coe.md), and it is exactly the difference
// between "this DO deducted stock" (movements: yes) and "this DO cost anything"
// (lots: no). Saying "it deducted" or "it did not" without naming WHICH ledger
// is how I contradicted myself.
//
// The Inventory screen's six planning columns, for reading Parts 2 and 3
// against what he actually sees (inventory.ts):
//   stock, incoming_qty (open PO arriving <=30d), committed_scheduled (open SO
//   demand WITH a delivery date), unscheduled_qty (open SO demand without one),
//   available_qty = stock + incoming - committed_scheduled, surplus_qty.
//
// READ-ONLY. SELECT only, no DDL, no writes, no transaction. Exits 0 always —
// the reconciliation IS the output.
//
//   SKU="NTYR MEMORY CONTOUR PILLOW" node backend/scripts/reconcile-sku.mjs
//   DO=2990-DO-2607-005              node backend/scripts/reconcile-sku.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const skuArg = (process.env.SKU ?? "").trim();
const doArg = (process.env.DO ?? "").trim();
if (!skuArg && !doArg) {
  console.error('Set SKU="<product code>" or DO="<do number>" (DO reconciles every SKU on that document).');
  process.exit(1);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const pad = (v, n) => String(v ?? "").padEnd(n);
const rpad = (v, n) => String(v ?? "").padStart(n);
const num = (v) => Number(v ?? 0);
const day = (v) => (v ? String(v).slice(0, 10) : "");

try {
  let codes = [];
  if (doArg) {
    const rows = await pg`
      SELECT DISTINCT di.item_code
        FROM scm.delivery_order_items di
        JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
       WHERE d.do_number = ${doArg}
       ORDER BY di.item_code`;
    codes = rows.map((r) => r.item_code).filter(Boolean);
    if (codes.length === 0) {
      console.log(`No delivery order numbered ${doArg}, or it has no lines.`);
      process.exit(0);
    }
    console.log(`Reconciling every SKU on ${doArg}: ${codes.length}\n`);
  } else {
    codes = [skuArg];
  }

  for (const code of codes) await reconcile(code);
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}

// ---------------------------------------------------------------------------

async function reconcile(code) {
  console.log("\n" + "=".repeat(78));
  console.log(code);
  console.log("=".repeat(78));

  /* SERVICE lines carry no stock and write no movement. Saying so up front stops
     an empty ledger reading as a missing one. */
  /* consumed = the qty this movement actually drew from the FIFO ledger, read
     from inventory_lot_consumptions DIRECTLY.

     It was total_cost_sen, and that was wrong — a proxy, not the fact. The
     cancel path ZEROES an OUT's cost stamps on purpose (fn_reverse_do_out step
     b: "their consumptions are gone, so a stamped cost would be a COGS figure
     with no ledger backing"), so a cost of 0 means EITHER "consumed nothing"
     OR "was cancelled". The first run of this script labelled a cancelled DO as
     having consumed no lot and pointed at the wrong document. Reading the
     consumption rows says which is which, with no inference. */
  const movs = await pg`
    SELECT m.movement_type, m.qty, m.source_doc_type, m.source_doc_no, m.created_at,
           COALESCE(m.variant_key,'') AS vkey, m.warehouse_id, m.total_cost_sen,
           COALESCE((SELECT SUM(c.qty_consumed)
                       FROM scm.inventory_lot_consumptions c
                      WHERE c.movement_id = m.id), 0) AS consumed
      FROM scm.inventory_movements m
     WHERE m.item_code = ${code}
     ORDER BY m.created_at`;
  if (movs.length === 0) {
    console.log("\nNo stock movements at all — this is a SERVICE line (delivery fee, disposal)");
    console.log("or a code that has never moved. Nothing to reconcile.\n");
    return;
  }

  // ── PART 1 ────────────────────────────────────────────────────────────────
  console.log("\nPART 1 — WHAT CAME IN, WHAT WENT OUT (complete, nothing truncated)\n");

  const ins = movs.filter((m) => m.movement_type === "IN");
  const outs = movs.filter((m) => m.movement_type === "OUT");
  const adjs = movs.filter((m) => m.movement_type === "ADJUSTMENT" || m.movement_type === "TRANSFER");

  console.log(`  IN  — ${ins.length} receipt(s)`);
  for (const m of ins) console.log(`      ${pad(day(m.created_at), 12)} +${rpad(num(m.qty), 5)}  ${m.source_doc_no ?? "(no doc)"}`);
  const totalIn = ins.reduce((s, m) => s + num(m.qty), 0);
  console.log(`      ${pad("", 12)} ${rpad(`= ${totalIn}`, 7)}  total received\n`);

  console.log(`  OUT — ${outs.length} shipment(s)`);
  console.log(`      ${pad("date", 12)} ${rpad("qty", 6)}  ${pad("document", 24)} drew from FIFO`);
  for (const m of outs) {
    /* Three genuinely different states, which the cost stamp alone cannot tell
       apart — and conflating them is how "did this DO deduct stock?" got two
       different answers out of me:
         consumed == qty   normal: balance down AND a lot drawn at a real cost
         consumed == 0     the OUT stands but NOTHING was drawn — no COGS. The
                           balance moved, the FIFO ledger did not.
         0 < consumed < q  partially short. */
    const c = num(m.consumed), q = num(m.qty);
    const state = c === 0 ? "NOTHING — no lot drawn, no COGS"
      : c < q ? `${c} of ${q} — partially short`
      : `${c}`;
    console.log(`      ${pad(day(m.created_at), 12)} -${rpad(q, 5)}  ${pad(m.source_doc_no ?? "(no doc)", 24)} ${state}`);
  }
  const totalOut = outs.reduce((s, m) => s + num(m.qty), 0);
  console.log(`      ${pad("", 12)} ${rpad(`= ${totalOut}`, 7)}  total shipped\n`);

  if (adjs.length > 0) {
    console.log(`  ADJUSTMENT / TRANSFER — ${adjs.length}`);
    for (const m of adjs) console.log(`      ${pad(day(m.created_at), 12)} ${rpad(num(m.qty) >= 0 ? `+${num(m.qty)}` : num(m.qty), 6)}  ${pad(m.source_doc_no ?? "", 24)} ${m.movement_type}`);
    console.log("");
  }
  const totalAdj = adjs.reduce((s, m) => s + num(m.qty), 0);

  const movBalance = totalIn - totalOut + totalAdj;
  const [lotRow] = await pg`
    SELECT COALESCE(SUM(qty_remaining), 0) AS qty
      FROM scm.inventory_lots WHERE item_code = ${code}`;
  const lotBalance = num(lotRow.qty);

  console.log("  THE ARITHMETIC");
  console.log(`      received            ${rpad(totalIn, 8)}`);
  console.log(`      shipped             ${rpad(-totalOut, 8)}`);
  console.log(`      adjustments         ${rpad(totalAdj >= 0 ? `+${totalAdj}` : totalAdj, 8)}`);
  console.log(`      ------------------------------`);
  console.log(`      MOVEMENT balance    ${rpad(movBalance, 8)}   <- what the Inventory screen's "stock" shows`);
  console.log(`      LOT balance         ${rpad(lotBalance, 8)}   <- what FIFO can actually claim and cost`);
  const shipped = outs.reduce((s, m) => s + num(m.qty), 0);
  const drawn = outs.reduce((s, m) => s + num(m.consumed), 0);
  console.log(
    movBalance === lotBalance
      ? `      AGREE.\n`
      : `      DISAGREE by ${movBalance - lotBalance}.\n`,
  );
  if (shipped !== drawn) {
    /* This line is the explanation, not a second finding: units that left the
       balance without drawing a lot are exactly the gap between the two
       ledgers, and they also shipped with no COGS booked. */
    console.log(`      ${shipped - drawn} unit(s) shipped WITHOUT drawing a lot — ${shipped} shipped vs ${drawn} drawn.`);
    console.log(`      Those units carry no COGS, so any margin on them is overstated.\n`);
  }

  /* The variant split matters: movements and lots are keyed by
     (warehouse, product, variant), so a SKU can reconcile in total while two
     variants are equal-and-opposite — the XAMMAR/OMMBUC family shape. */
  const byVariant = await pg`
    SELECT COALESCE(m.variant_key,'') AS vkey,
           SUM(CASE m.movement_type WHEN 'IN' THEN m.qty WHEN 'OUT' THEN -m.qty
                                    WHEN 'ADJUSTMENT' THEN m.qty WHEN 'TRANSFER' THEN m.qty
                                    ELSE 0 END) AS mov
      FROM scm.inventory_movements m
     WHERE m.item_code = ${code}
     GROUP BY COALESCE(m.variant_key,'')
     ORDER BY 1`;
  if (byVariant.length > 1) {
    console.log("  PER VARIANT (movements and lots are keyed by variant, so a SKU can");
    console.log("  balance overall while two variants cancel each other out)\n");
    for (const v of byVariant) {
      const [lv] = await pg`
        SELECT COALESCE(SUM(qty_remaining),0) AS qty FROM scm.inventory_lots
         WHERE item_code = ${code} AND COALESCE(variant_key,'') = ${v.vkey}`;
      const mv = num(v.mov), lq = num(lv.qty);
      console.log(`      ${pad(v.vkey || "(none)", 34)} movements ${rpad(mv, 6)}  lots ${rpad(lq, 6)}  ${mv === lq ? "agree" : `DRIFT ${mv - lq}`}`);
    }
    console.log("");
  }

  /* WHERE DOES EACH OPEN LOT COME FROM?
     Owner, 2026-08-04: "你不应该问我实体的数字是多少，根据我们的系统来说，我们进的
     数量和我们出的数量必须是对得上的 … 你必须得从根本上、根源性地去解决它".
     He is right: GRN in minus non-cancelled DO out IS the answer, so a lot
     ledger that disagrees is wrong and no physical count is needed to say so.
     But saying WHICH lot is wrong, and what opened it, needs the lots
     themselves — a phantom opened by a GRN is a different fault from one minted
     by a cancel's add-back, and they have different repairs. */
  const lots = await pg`
    SELECT l.id, l.source_doc_no, l.qty_received, l.qty_remaining, l.received_at,
           COALESCE(l.variant_key,'') AS vkey, l.batch_no,
           m.movement_type AS opened_by_type, m.source_doc_no AS opened_by_doc
      FROM scm.inventory_lots l
      LEFT JOIN scm.inventory_movements m ON m.id = l.movement_id
     WHERE l.item_code = ${code}
     ORDER BY l.received_at`;
  if (lots.length > 0) {
    console.log("  EVERY LOT, AND WHAT OPENED IT\n");
    console.log(`      ${pad("opened by", 26)} ${rpad("recv", 6)} ${rpad("left", 6)}  ${pad("type", 12)} variant`);
    for (const l of lots) {
      /* A lot opened by an ADJUSTMENT is the tell for a cancel add-back that
         minted stock instead of only restoring the balance — fn_reverse_do_out
         closes the lot it mints, so an OPEN one means the route-side legacy
         fallback ran instead, or the close did not take. */
      const suspect = num(l.qty_remaining) > 0 && String(l.opened_by_type ?? "") === "ADJUSTMENT"
        ? "   <- OPEN lot minted by an ADJUSTMENT (cancel add-back should have closed it)" : "";
      console.log(`      ${pad(l.opened_by_doc ?? l.source_doc_no ?? "(unknown)", 26)} ${rpad(num(l.qty_received), 6)} ${rpad(num(l.qty_remaining), 6)}  ${pad(l.opened_by_type ?? "?", 12)} ${l.vkey || "(none)"}${suspect}`);
    }
    console.log("");
  }

  /* WALK THE WHOLE FLOW, not just GRN and DO.
     Owner, 2026-08-04: "你就一个一个排查，当做你重新录入一遍数据。GR 就是进货，DO
     就是出货，然后查看在全套系统里还有什么东西可以进出货".

     He is right that the earlier version was incomplete. GRN in minus DO out is
     the answer ONLY when nothing else moved the goods, and eight other things
     can:

       IN   GRN receipt · Delivery Return · consignment receive · consignment
            return-in · Stock Take (+) · Inventory Adjustment (+) · Stock
            Transfer in · a cancelled DO's add-back
       OUT  DO shipment · Purchase Return · consignment note out · consignment
            return-out · Stock Take (-) · Inventory Adjustment (-) · Stock
            Transfer out

     Grouping the movements by source_doc_type re-walks every one of those by
     construction: a stock change that wrote no movement does not exist, so
     nothing can hide from this breakdown. The GRN/DO figures stay, because they
     are the two the owner reconciles by hand — but they are now shown as part of
     the whole flow rather than as if they were all of it. */
  const byDocType = await pg`
    SELECT COALESCE(source_doc_type, '(none)') AS doc_type,
           SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                  WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty
                                  ELSE 0 END) AS net,
           COUNT(*) AS rows
      FROM scm.inventory_movements
     WHERE item_code = ${code}
     GROUP BY COALESCE(source_doc_type, '(none)')
     ORDER BY 1`;
  console.log("  EVERY WAY THIS SKU MOVED — the whole flow, walked again\n");
  for (const d of byDocType) {
    const n = num(d.net);
    console.log(`      ${pad(d.doc_type, 16)} ${rpad(n >= 0 ? `+${n}` : n, 8)}   ${num(d.rows)} movement(s)`);
  }
  console.log(`      ${pad("", 16)} --------`);
  console.log(`      ${pad("net", 16)} ${rpad(movBalance, 8)}\n`);

  /* THE DOCUMENT TRUTH. Cancelled documents release their quantity, so they are
     excluded — the same rule soDeliverableRemaining and the movement reversal
     both follow. Delivery Returns come back IN and Purchase Returns go OUT, so
     both belong in the arithmetic; leaving them out was the gap. */
  const [docTruth] = await pg`
    SELECT
      COALESCE((SELECT SUM(gi.qty_accepted)
                  FROM scm.grn_items gi
                  JOIN scm.grns g ON g.id = gi.grn_id
                 WHERE gi.item_code = ${code}
                   AND g.status IS DISTINCT FROM 'CANCELLED'), 0) AS received,
      COALESCE((SELECT SUM(di.qty)
                  FROM scm.delivery_order_items di
                  JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
                 WHERE di.item_code = ${code}
                   AND d.status IS DISTINCT FROM 'CANCELLED'), 0) AS shipped,
      COALESCE((SELECT SUM(dri.qty_returned)
                  FROM scm.delivery_return_items dri
                  JOIN scm.delivery_returns dr ON dr.id = dri.delivery_return_id
                 WHERE dri.item_code = ${code}
                   AND dr.status IS DISTINCT FROM 'CANCELLED'), 0) AS returned_in,
      COALESCE((SELECT SUM(pri.qty_returned)
                  FROM scm.purchase_return_items pri
                  JOIN scm.purchase_returns pr ON pr.id = pri.purchase_return_id
                 WHERE pri.item_code = ${code}
                   AND pr.status IS DISTINCT FROM 'CANCELLED'), 0) AS returned_out`;

  /* Whatever the documents above do NOT explain — stock takes, inventory
     adjustments, transfers, consignment — read straight off the ledger by
     source_doc_type, so the total is complete rather than "the four I thought
     of". */
  /* The four the block above counts from their own document tables. The full set
     written anywhere in scm is: ADJUSTMENT, CONSIGNMENT_NOTE, DO, DR, GRN,
     PC_RECEIVE, PURCHASE_RETURN, STOCK_TAKE, STOCK_TRANSFER — verified by
     grepping the writers, not assumed. A Purchase Return stamps
     'PURCHASE_RETURN', NOT 'PR'; getting that wrong would double-count it. */
  const DOC_ACCOUNTED = new Set(['GRN', 'DO', 'DR', 'PURCHASE_RETURN']);

  /* A cancel add-back is NOT an independent stock event — it is the other half
     of the reversal whose first half is the cancelled DO's OUT. The DO figure
     above already excludes cancelled deliveries, so counting the add-back too
     credits the same reversal twice.
     Caught by this script flagging the movement ledger as WRONG on a SKU whose
     movement ledger had already been proven right: 1 - 1 + 1 = 1 against a
     ledger reading 0. When a check disagrees with something already established,
     suspect the check. */
  const [{ cancel_addback: cancelAddBack }] = await pg`
    SELECT COALESCE(SUM(m.qty), 0) AS cancel_addback
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.item_code = ${code}
       AND m.source_doc_type = 'ADJUSTMENT'
       AND UPPER(COALESCE(d.status::text,'')) = 'CANCELLED'`;

  const otherNet = byDocType
    .filter((d) => !DOC_ACCOUNTED.has(String(d.doc_type)))
    .reduce((s, d) => s + num(d.net), 0) - num(cancelAddBack);

  const docStock = num(docTruth.received) - num(docTruth.shipped)
    + num(docTruth.returned_in) - num(docTruth.returned_out) + otherNet;

  console.log("  WHAT THE DOCUMENTS SAY THE STOCK MUST BE (no physical count needed)");
  console.log(`      GRN received      (non-cancelled)   ${rpad(num(docTruth.received), 8)}`);
  console.log(`      DO shipped        (non-cancelled)   ${rpad(-num(docTruth.shipped), 8)}`);
  console.log(`      Delivery Returns  back in           ${rpad(num(docTruth.returned_in), 8)}`);
  console.log(`      Purchase Returns  back out          ${rpad(-num(docTruth.returned_out), 8)}`);
  console.log(`      everything else   (takes/adjustments/transfers/consignment)  ${rpad(otherNet >= 0 ? `+${otherNet}` : otherNet, 8)}`);
  if (num(cancelAddBack) !== 0) {
    console.log(`        (a cancel add-back of ${num(cancelAddBack)} is excluded — the cancelled DO's`);
    console.log(`         shipment is already out of the DO figure; counting both double-credits it)`);
  }
  console.log(`      ------------------------------------------`);
  console.log(`      DOCUMENT stock                      ${rpad(docStock, 8)}`);
  console.log(`      movement ledger                     ${rpad(movBalance, 8)}  ${movBalance === docStock ? "matches" : "WRONG"}`);
  console.log(`      lot ledger                          ${rpad(lotBalance, 8)}  ${lotBalance === docStock ? "matches" : "WRONG"}\n`);

  // ── PART 2 ────────────────────────────────────────────────────────────────
  console.log("PART 2 — PO: WHAT IS STILL COMING IN\n");
  const poLines = await pg`
    SELECT po.po_number, po.status, pi.qty, pi.received_qty
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
     WHERE pi.item_code = ${code}
     ORDER BY po.po_number`;
  if (poLines.length === 0) {
    console.log("  No purchase order has ever ordered this code.\n");
  } else {
    let outstanding = 0;
    for (const p of poLines) {
      const left = Math.max(0, num(p.qty) - num(p.received_qty));
      /* Only a LIVE PO can still deliver — the Inventory screen counts
         SUBMITTED / PARTIALLY_RECEIVED as incoming and nothing else. */
      const live = ["SUBMITTED", "PARTIALLY_RECEIVED"].includes(String(p.status).toUpperCase());
      if (live) outstanding += left;
      console.log(`  ${pad(p.po_number, 22)} ${pad(p.status, 20)} ordered ${rpad(num(p.qty), 5)} received ${rpad(num(p.received_qty), 5)} outstanding ${rpad(live ? left : 0, 5)}${live ? "" : "   (not a live PO)"}`);
    }
    console.log(`\n  STILL INCOMING (live POs only): ${outstanding}\n`);
  }

  // ── PART 3 ────────────────────────────────────────────────────────────────
  console.log("PART 3 — SO: WHAT IS STILL DUE TO GO OUT\n");
  /* customer_delivery_date is on the SO HEADER, not the line — it is what splits
     the Inventory screen's committed_scheduled from unscheduled_qty. */
  const soLines = await pg`
    SELECT si.id, si.doc_no, si.qty, so.status, so.customer_delivery_date
      FROM scm.mfg_sales_order_items si
      JOIN scm.mfg_sales_orders so ON so.doc_no = si.doc_no
     WHERE si.item_code = ${code}
       AND COALESCE(si.cancelled, false) = false
     ORDER BY si.doc_no`;
  if (soLines.length === 0) {
    console.log("  No sales order has ever ordered this code.\n");
  } else {
    /* remaining = ordered - Σ non-cancelled DO lines + Σ returns, the same
       formula soDeliverableRemaining uses. Anything else would be a second
       definition of "still due", which is how these numbers start disagreeing. */
    const ids = soLines.map((l) => l.id);
    const delivered = await pg`
      SELECT di.so_item_id, COALESCE(SUM(di.qty),0) AS qty
        FROM scm.delivery_order_items di
        JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
       WHERE di.so_item_id IN ${pg(ids)}
         AND d.status IS DISTINCT FROM 'CANCELLED'
       GROUP BY di.so_item_id`;
    const delMap = new Map(delivered.map((r) => [r.so_item_id, num(r.qty)]));

    let openDemand = 0;
    const DONE = new Set(["DELIVERED", "INVOICED", "CLOSED", "CANCELLED"]);
    for (const l of soLines) {
      const del = delMap.get(l.id) ?? 0;
      const remaining = num(l.qty) - del;
      const open = !DONE.has(String(l.status).toUpperCase()) && remaining > 0;
      if (open) openDemand += remaining;
      console.log(`  ${pad(l.doc_no, 22)} ${pad(l.status, 16)} ordered ${rpad(num(l.qty), 5)} delivered ${rpad(del, 5)} remaining ${rpad(remaining, 5)} ${l.customer_delivery_date ? day(l.customer_delivery_date) : "(no date)"}${open ? "" : "   (closed)"}`);
    }
    console.log(`\n  STILL DUE OUT (open SO lines): ${openDemand}\n`);
  }

  // ── PART 4 ────────────────────────────────────────────────────────────────
  console.log("PART 4 — IS THE ASSIGNED SO ON EACH SHIPMENT REAL?\n");
  const doLines = await pg`
    SELECT d.do_number, d.status, d.so_doc_no AS header_so, di.qty, di.so_item_id,
           si.doc_no AS line_so
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
     WHERE di.item_code = ${code}
     ORDER BY d.do_date, d.do_number`;
  if (doLines.length === 0) {
    console.log("  This code has never been on a delivery order.\n");
    return;
  }
  console.log("  A shipment's header can NAME a Sales Order while its line links to");
  console.log("  nothing. The header is a label; the LINE is what the remaining-qty");
  console.log("  ceiling counts. When they differ, the label is decorative.\n");
  for (const l of doLines) {
    const linked = l.so_item_id ? `line -> ${l.line_so}` : "LINE LINKS TO NOTHING";
    const agree = l.so_item_id && l.line_so === l.header_so;
    const flag = !l.so_item_id ? "  <- takes no SO quantity" : agree ? "" : "  <- header and line name DIFFERENT orders";
    console.log(`  ${pad(l.do_number, 22)} ${pad(l.status, 12)} qty ${rpad(num(l.qty), 4)}  header: ${pad(l.header_so ?? "(none)", 22)} ${pad(linked, 30)}${flag}`);
  }
  console.log("");
}
