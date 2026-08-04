#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scan-unlinked-lines.mjs — how many documents have the DO-2607-005 shape?
//
// WHY THIS EXISTS. 2990-DO-2607-005 and 2990-DO-2607-017 both name
// 2990-SO-2606-019 on their HEADER, both are DISPATCHED, and both deducted the
// same goods — the owner's own Stock Breakdown shows the pillow going out twice
// (-2 on 13/07 under DO-005, -2 on 23/07 under DO-017). DO-005's six lines carry
// NO so_item_id.
//
// THAT IS THE WHOLE MECHANISM. A DO line with no so_item_id:
//   * still deducts stock — deductInventoryForDo reads the DO's OWN lines;
//   * counts toward NO Sales Order line, so soDeliverableRemaining never sees it;
//   * therefore never trips the over-delivery guard, which only inspects linked
//     lines ("Ad-hoc (unlinked) lines are not tracked by soDeliverableRemaining,
//     so they never trip this" — delivery-orders-mfg.ts, the create path).
//
// The SO→DO convert (/from-sos) ALWAYS writes so_item_id, so it cannot produce
// this. The manual create can: `so_doc_no` on the header is free text, and
// nothing requires the lines beneath it to link to that SO.
//
// The Goods Receipt side has the identical shape — grns.purchase_order_id names
// a PO while grn_items.purchase_order_item_id is nullable, so a receipt can add
// stock without counting against any PO line. Owner, 2026-08-04: "包括 GR 那边也是".
//
// WHAT IT REPORTS. Every non-cancelled document whose HEADER names a parent but
// whose lines do not all link to it, and — the part that matters — whether a
// SIBLING document on the same parent covers the same item at the same qty. That
// overlap is the duplicate; an unlinked line with no sibling is untidy, not a
// double deduction.
//
// READ-ONLY. No DDL, no writes, no transaction. Remediation is CANCEL in the
// app, which runs fn_reverse_do_out and restores the original lots at their
// original cost — never a hand-written UPDATE against production.
//
// EXITS 0 EVEN WHEN IT FINDS DUPLICATES. The answer is the output; a red job
// would read as "the check broke".
//
//   node backend/scripts/scan-unlinked-lines.mjs
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
const num = (v) => Number(v ?? 0);
/** Same item at the same quantity is what makes two documents a duplicate. */
const key = (code, qty) => `${String(code ?? "").trim().toUpperCase()}::${num(qty)}`;

try {
  await scanDeliveryOrders();
  await scanGoodsReceipts();
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}

// ---------------------------------------------------------------------------

async function scanDeliveryOrders() {
  banner("DELIVERY ORDERS — header names an SO, lines do not link to it");

  /* Every non-cancelled DO that names an SO and has at least one unlinked line.
     DRAFT is included: it has not deducted yet, but it is the same defect and
     confirming it would deduct. */
  const suspects = await pg`
    SELECT d.id, d.do_number, d.status, d.do_date, d.so_doc_no,
           COUNT(*) FILTER (WHERE di.so_item_id IS NULL) AS unlinked,
           COUNT(*)                                      AS total
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
     WHERE d.so_doc_no IS NOT NULL
       AND d.so_doc_no <> ''
       AND COALESCE(d.status, '') <> 'CANCELLED'
     GROUP BY d.id, d.do_number, d.status, d.do_date, d.so_doc_no
    HAVING COUNT(*) FILTER (WHERE di.so_item_id IS NULL) > 0
     ORDER BY d.so_doc_no, d.do_date
  `;

  if (suspects.length === 0) {
    console.log("None. Every DO that names an SO has its lines linked to it.\n");
    return;
  }
  console.log(`${suspects.length} delivery order(s) carry unlinked lines under an SO header.\n`);

  /* All non-cancelled DOs on the SAME SOs, so an unlinked DO can be compared
     with its siblings. Without this the report says "untidy" where it should
     say "the stock went out twice". */
  const soDocs = [...new Set(suspects.map((s) => s.so_doc_no))];
  const family = await pg`
    SELECT d.id, d.do_number, d.status, d.do_date, d.so_doc_no,
           di.item_code, di.qty, di.so_item_id
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
     WHERE d.so_doc_no IN ${pg(soDocs)}
       AND COALESCE(d.status, '') <> 'CANCELLED'
     ORDER BY d.so_doc_no, d.do_date, di.item_code
  `;

  report({
    suspects,
    family,
    parentOf: (r) => r.so_doc_no,
    docNoOf: (r) => r.do_number,
    lineKey: (l) => key(l.item_code, l.qty),
    linkedOf: (l) => l.so_item_id,
    parentLabel: "Sales Order",
    childLabel: "DO",
  });
}

async function scanGoodsReceipts() {
  banner("GOODS RECEIPTS — header names a PO, lines do not link to it");

  const suspects = await pg`
    SELECT g.id, g.grn_number AS doc_number, g.status, g.received_at AS doc_date,
           po.po_number AS parent_no,
           COUNT(*) FILTER (WHERE gi.purchase_order_item_id IS NULL) AS unlinked,
           COUNT(*)                                                  AS total
      FROM scm.grns g
      JOIN scm.purchase_orders po ON po.id = g.purchase_order_id
      JOIN scm.grn_items gi       ON gi.grn_id = g.id
     WHERE COALESCE(g.status, '') <> 'CANCELLED'
     GROUP BY g.id, g.grn_number, g.status, g.received_at, po.po_number
    HAVING COUNT(*) FILTER (WHERE gi.purchase_order_item_id IS NULL) > 0
     ORDER BY po.po_number, g.received_at
  `;

  if (suspects.length === 0) {
    console.log("None. Every GRN that names a PO has its lines linked to it.\n");
    return;
  }
  console.log(`${suspects.length} goods receipt(s) carry unlinked lines under a PO header.\n`);

  const poNos = [...new Set(suspects.map((s) => s.parent_no))];
  const family = await pg`
    SELECT g.id, g.grn_number AS doc_number, g.status, g.received_at AS doc_date,
           po.po_number AS parent_no,
           gi.material_code AS item_code, gi.qty_accepted AS qty,
           gi.purchase_order_item_id AS link_id
      FROM scm.grns g
      JOIN scm.purchase_orders po ON po.id = g.purchase_order_id
      JOIN scm.grn_items gi       ON gi.grn_id = g.id
     WHERE po.po_number IN ${pg(poNos)}
       AND COALESCE(g.status, '') <> 'CANCELLED'
     ORDER BY po.po_number, g.received_at, gi.material_code
  `;

  report({
    suspects: suspects.map((s) => ({ ...s, do_number: s.doc_number, so_doc_no: s.parent_no })),
    family: family.map((f) => ({ ...f, do_number: f.doc_number, so_doc_no: f.parent_no, so_item_id: f.link_id })),
    parentOf: (r) => r.so_doc_no,
    docNoOf: (r) => r.do_number,
    lineKey: (l) => key(l.item_code, l.qty),
    linkedOf: (l) => l.so_item_id,
    parentLabel: "Purchase Order",
    childLabel: "GRN",
  });
}

// ---------------------------------------------------------------------------

/**
 * One block per parent, listing every child on it, then — for each unlinked
 * child — which of its lines a sibling already covers.
 *
 * OVERLAP is the finding. Two children on one parent is a legitimate split; the
 * same item at the same qty on both is the same goods moved twice.
 */
function report({ suspects, family, parentOf, docNoOf, lineKey, linkedOf, parentLabel, childLabel }) {
  const byParent = new Map();
  for (const l of family) {
    const p = parentOf(l);
    if (!byParent.has(p)) byParent.set(p, new Map());
    const docs = byParent.get(p);
    const no = docNoOf(l);
    if (!docs.has(no)) docs.set(no, { no, status: l.status, date: l.doc_date ?? l.do_date, lines: [] });
    docs.get(no).lines.push(l);
  }

  const duplicates = [];

  for (const parent of [...new Set(suspects.map(parentOf))]) {
    const docs = [...(byParent.get(parent)?.values() ?? [])];
    console.log(`${parentLabel} ${parent} — ${docs.length} ${childLabel}(s)`);
    for (const d of docs) {
      const unlinked = d.lines.filter((l) => !linkedOf(l)).length;
      const tag = unlinked === 0 ? "all linked"
        : unlinked === d.lines.length ? `ALL ${unlinked} LINES UNLINKED`
        : `${unlinked}/${d.lines.length} unlinked`;
      console.log(`  ${pad(d.no, 22)} ${pad(d.status, 12)} ${pad(fmtDate(d.date), 12)} ${tag}`);
    }

    /* Compare each unlinked child against its siblings' line multisets. A qty
       matched once must not be matched again, or one sibling line would "cover"
       two of ours and inflate the overlap. */
    for (const d of docs) {
      const mine = d.lines.filter((l) => !linkedOf(l));
      if (mine.length === 0) continue;

      const pool = new Map();
      for (const sib of docs) {
        if (sib.no === d.no) continue;
        for (const l of sib.lines) {
          const k = lineKey(l);
          if (!pool.has(k)) pool.set(k, []);
          pool.get(k).push(sib.no);
        }
      }

      const hits = [];
      for (const l of mine) {
        const k = lineKey(l);
        const owners = pool.get(k);
        if (owners && owners.length > 0) hits.push({ line: l, by: owners.shift() });
      }

      if (hits.length === 0) {
        console.log(`    ${d.no}: unlinked, but no sibling covers the same goods — untidy, not a double movement.`);
        continue;
      }

      console.log(`    ${d.no}: DUPLICATE — ${hits.length}/${mine.length} unlinked line(s) already covered by a sibling:`);
      for (const h of hits) {
        console.log(`        ${pad(h.line.item_code, 30)} qty ${pad(num(h.line.qty), 6)} also on ${h.by}`);
      }
      duplicates.push({ parent, doc: d.no, status: d.status, date: fmtDate(d.date), lines: hits.length, childLabel });
    }
    console.log("");
  }

  if (duplicates.length === 0) {
    console.log(`No ${childLabel} double-covers goods a sibling already moved.\n`);
    return;
  }

  console.log(`FINDING — ${duplicates.length} ${childLabel}(s) moved goods a sibling had already moved:\n`);
  for (const d of duplicates) {
    console.log(`  ${pad(d.doc, 22)} ${pad(d.status, 12)} ${pad(d.date, 12)} on ${d.parent} — ${d.lines} duplicated line(s)`);
  }
  console.log(`\nCancel these in the app, NOT in SQL: the cancel path runs the reversal`);
  console.log(`function, which restores the original lots at their original cost and`);
  console.log(`removes the cancelled document's COGS rows. A hand-written UPDATE would`);
  console.log(`move the quantity back and leave the costing ledger wrong.\n`);
}

function fmtDate(v) {
  if (!v) return "";
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function banner(t) {
  console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}\n`);
}
