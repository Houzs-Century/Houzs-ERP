#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-po-so-links.mjs — does the PO agree with the SO about who they belong to?
//
// WHY THIS EXISTS. Owner, 2026-08-04: "当 MRP 分配了之后，你要看一下我们的 PO，确认
// 它分配去的 SO 是哪一张，同时也要确认 SO 对应去的 PO 是哪一张，确保两边都是对的".
//
// THE TWO DIRECTIONS ARE BUILT BY DIFFERENT CODE, which is precisely why they
// can disagree:
//
//   PO -> SO   po-so-coverage.ts merges THREE sources and lets STATIC beat
//              FLOATING: the stored link (purchase_order_items.so_item_id), a
//              delivered-SO lock derived from the DO ledger, and live MRP
//              coverage.
//   SO -> PO   mfg-sales-orders.ts builds its own (coverage_po,
//              shipped_source_pos, ready_source_pos).
//
// WHAT THIS CHECKS, and what it deliberately does NOT.
//
// It checks the STORED LINK only — `purchase_order_items.so_item_id`. That is
// the one hard fact both sides must honour, and the only one where "wrong" has a
// meaning. The MRP half is a live allocation: it moves as demand moves, the UI
// already marks it with a dashed chip and a "~", and the owner has said that
// soft match is fine ("因为是软匹配…他的款项只是借一个 SO 的东西来开 PO"). A
// floating assignment differing between two screens is the design, not a bug.
//
// So the faults it looks for are the ones that are unambiguously wrong:
//   1. DANGLING     so_item_id points at an SO line that no longer exists
//   2. CANCELLED    the linked SO line is cancelled, or its SO is
//   3. MISMATCH     the PO line and the SO line name DIFFERENT item codes
//   4. CROSS-COMPANY the PO and the SO belong to different companies
//   5. OVER-ORDERED  linked PO qty exceeds what the SO line ordered
//
// A PO line with NO link is NOT a fault — that is a stock PO, and most of them
// are. It is counted so the ratio is visible, never flagged.
//
// READ-ONLY. SELECT only, no DDL, no writes, no transaction. Exits 0 always.
//
//   node backend/scripts/check-po-so-links.mjs
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

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const pad = (v, n) => String(v ?? "").padEnd(n);
const rpad = (v, n) => String(v ?? "").padStart(n);
const num = (v) => Number(v ?? 0);
const codeKey = (v) => String(v ?? "").trim().toUpperCase();

try {
  // ── The population ────────────────────────────────────────────────────────
  const [counts] = await pg`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE pi.so_item_id IS NOT NULL) AS linked
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
     WHERE po.status IS DISTINCT FROM 'CANCELLED'`;
  console.log(`\nPO lines on non-cancelled POs: ${num(counts.total)}`);
  console.log(`  linked to an SO line (stored so_item_id): ${num(counts.linked)}`);
  console.log(`  no link (stock PO / soft match)         : ${num(counts.total) - num(counts.linked)}`);
  console.log(`\nOnly the LINKED ones can be wrong. A PO raised for stock is not a fault.\n`);

  /* LEFT JOIN, deliberately: an INNER JOIN would hide fault #1 (a link pointing
     at a row that no longer exists) — the very case a link-following query
     cannot see, which is the lesson from the delivery-side incident. */
  const rows = await pg`
    SELECT po.po_number, po.status AS po_status, po.company_id AS po_co,
           pi.id AS po_item_id, pi.material_code, pi.qty AS po_qty,
           pi.so_item_id,
           si.id AS so_item_exists, si.doc_no, si.item_code, si.qty AS so_qty,
           COALESCE(si.cancelled, false) AS so_line_cancelled,
           so.status AS so_status, so.company_id AS so_co
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = pi.so_item_id
      LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = si.doc_no
     WHERE pi.so_item_id IS NOT NULL
       AND po.status IS DISTINCT FROM 'CANCELLED'
     ORDER BY po.po_number`;

  const dangling = [], cancelled = [], mismatch = [], crossCo = [];
  for (const r of rows) {
    if (!r.so_item_exists) { dangling.push(r); continue; }
    if (r.so_line_cancelled === true || String(r.so_status).toUpperCase() === "CANCELLED") cancelled.push(r);
    if (codeKey(r.material_code) !== codeKey(r.item_code)) mismatch.push(r);
    if (r.po_co != null && r.so_co != null && r.po_co !== r.so_co) crossCo.push(r);
  }

  section("1. DANGLING — so_item_id points at an SO line that no longer exists", dangling,
    (r) => `${pad(r.po_number, 22)} ${pad(r.material_code, 30)} qty ${rpad(num(r.po_qty), 5)}  so_item_id=${r.so_item_id}`,
    "The PO believes it is for an order the system cannot find. The FK is ON DELETE SET NULL,\n" +
    "so a surviving non-null value pointing at nothing means the row went another way.");

  section("2. CANCELLED — the PO line is still linked to a cancelled SO line or SO", cancelled,
    (r) => `${pad(r.po_number, 22)} ${pad(r.material_code, 30)} -> ${pad(r.doc_no, 22)} ${r.so_line_cancelled ? "line cancelled" : `SO ${r.so_status}`}`,
    "The goods are still on order against demand that no longer exists.");

  section("3. MISMATCH — the PO line and its SO line name DIFFERENT items", mismatch,
    (r) => `${pad(r.po_number, 22)} PO="${r.material_code}"  vs  ${pad(r.doc_no, 22)} SO="${r.item_code}"`,
    "The link says these are the same goods and the codes say they are not. Whichever screen\n" +
    "you read, one of them is showing the wrong assignment.");

  section("4. CROSS-COMPANY — the PO and the SO belong to different companies", crossCo,
    (r) => `${pad(r.po_number, 22)} co=${r.po_co}  ->  ${pad(r.doc_no, 22)} co=${r.so_co}`,
    "One company's purchase is assigned to another company's order.");

  // ── 5. Over-ordering, the reverse direction ───────────────────────────────
  /* SO -> PO. Sum every LIVE PO line pointing at each SO line and compare with
     what that line ordered. More on order than was sold is not automatically
     wrong (a buffer is a decision), so this reports rather than accuses — but a
     large excess is usually a link that should have gone to a different line. */
  const over = await pg`
    SELECT si.doc_no, si.item_code, si.qty AS so_qty,
           SUM(pi.qty) AS po_qty,
           COUNT(*) AS po_lines,
           STRING_AGG(DISTINCT po.po_number, ', ') AS pos
      FROM scm.mfg_sales_order_items si
      JOIN scm.purchase_order_items pi ON pi.so_item_id = si.id
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
     WHERE COALESCE(si.cancelled, false) = false
       AND po.status IS DISTINCT FROM 'CANCELLED'
     GROUP BY si.id, si.doc_no, si.item_code, si.qty
    HAVING SUM(pi.qty) > si.qty
     ORDER BY (SUM(pi.qty) - si.qty) DESC`;

  section("5. OVER-ORDERED — linked PO qty exceeds what the SO line ordered", over,
    (r) => `${pad(r.doc_no, 22)} ${pad(r.item_code, 30)} ordered ${rpad(num(r.so_qty), 5)} on PO ${rpad(num(r.po_qty), 5)} (+${num(r.po_qty) - num(r.so_qty)})  ${r.pos}`,
    "Reported, not accused: buying a buffer is a decision. A large excess usually means a link\n" +
    "that belongs on a different SO line.");

  const faults = dangling.length + cancelled.length + mismatch.length + crossCo.length;
  console.log("=".repeat(74));
  console.log(faults === 0
    ? `VERDICT: every stored PO->SO link resolves, matches on item code, and stays inside one company.\n` +
      `${over.length > 0 ? `${over.length} SO line(s) have more on order than ordered — listed above for review, not a fault.` : "No over-ordering either."}`
    : `VERDICT: ${faults} stored link(s) are wrong — see the sections above.`);
  console.log("=".repeat(74));
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}

function section(title, rows, fmt, note) {
  console.log(`${title}\n`);
  if (rows.length === 0) { console.log("  none.\n"); return; }
  console.log(`  ${rows.length} found:`);
  for (const r of rows.slice(0, 50)) console.log(`    ${fmt(r)}`);
  if (rows.length > 50) console.log(`    ... and ${rows.length - 50} more (capped at 50 so the log stays readable).`);
  if (note) console.log(`\n  ${note.replace(/\n/g, "\n  ")}`);
  console.log("");
}
