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
  const movs = await pg`
    SELECT movement_type, qty, source_doc_type, source_doc_no, created_at,
           COALESCE(variant_key,'') AS vkey, warehouse_id, total_cost_sen
      FROM scm.inventory_movements
     WHERE product_code = ${code}
     ORDER BY created_at`;
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
  for (const m of outs) {
    /* A zero cost stamp on an OUT means it consumed NO lot: the goods left the
       balance but nothing was drawn from the FIFO ledger and no COGS was
       booked. This is the exact state that makes "did it deduct stock?"
       ambiguous, so it is labelled rather than left to be inferred. */
    const uncosted = num(m.total_cost_sen) === 0 ? "   <- consumed no lot, no COGS" : "";
    console.log(`      ${pad(day(m.created_at), 12)} -${rpad(num(m.qty), 5)}  ${pad(m.source_doc_no ?? "(no doc)", 24)}${uncosted}`);
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
      FROM scm.inventory_lots WHERE product_code = ${code}`;
  const lotBalance = num(lotRow.qty);

  console.log("  THE ARITHMETIC");
  console.log(`      received            ${rpad(totalIn, 8)}`);
  console.log(`      shipped             ${rpad(-totalOut, 8)}`);
  console.log(`      adjustments         ${rpad(totalAdj >= 0 ? `+${totalAdj}` : totalAdj, 8)}`);
  console.log(`      ------------------------------`);
  console.log(`      MOVEMENT balance    ${rpad(movBalance, 8)}   <- what the Inventory screen's "stock" shows`);
  console.log(`      LOT balance         ${rpad(lotBalance, 8)}   <- what FIFO can actually claim and cost`);
  console.log(
    movBalance === lotBalance
      ? `      AGREE.\n`
      : `      DISAGREE by ${movBalance - lotBalance}. One of the two is wrong; see the uncosted OUTs above.\n`,
  );

  /* The variant split matters: movements and lots are keyed by
     (warehouse, product, variant), so a SKU can reconcile in total while two
     variants are equal-and-opposite — the XAMMAR/OMMBUC family shape. */
  const byVariant = await pg`
    SELECT COALESCE(m.variant_key,'') AS vkey,
           SUM(CASE m.movement_type WHEN 'IN' THEN m.qty WHEN 'OUT' THEN -m.qty
                                    WHEN 'ADJUSTMENT' THEN m.qty WHEN 'TRANSFER' THEN m.qty
                                    ELSE 0 END) AS mov
      FROM scm.inventory_movements m
     WHERE m.product_code = ${code}
     GROUP BY COALESCE(m.variant_key,'')
     ORDER BY 1`;
  if (byVariant.length > 1) {
    console.log("  PER VARIANT (movements and lots are keyed by variant, so a SKU can");
    console.log("  balance overall while two variants cancel each other out)\n");
    for (const v of byVariant) {
      const [lv] = await pg`
        SELECT COALESCE(SUM(qty_remaining),0) AS qty FROM scm.inventory_lots
         WHERE product_code = ${code} AND COALESCE(variant_key,'') = ${v.vkey}`;
      const mv = num(v.mov), lq = num(lv.qty);
      console.log(`      ${pad(v.vkey || "(none)", 34)} movements ${rpad(mv, 6)}  lots ${rpad(lq, 6)}  ${mv === lq ? "agree" : `DRIFT ${mv - lq}`}`);
    }
    console.log("");
  }

  // ── PART 2 ────────────────────────────────────────────────────────────────
  console.log("PART 2 — PO: WHAT IS STILL COMING IN\n");
  const poLines = await pg`
    SELECT po.po_number, po.status, pi.qty, pi.received_qty
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
     WHERE pi.material_code = ${code}
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
