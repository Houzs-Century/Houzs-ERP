#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-doc-splits.mjs — is a document split into several children a PARTIAL
// fulfilment, or a DUPLICATE?
//
// WHY THIS EXISTS. Owner, 2026-08-04, looking at two DOs cut from one SO and two
// GRNs against one PO: "为什么一张SO可以开两张DO？？" and "GR 也是".
//
// Both are legal by design — an SO delivered in two trips is two DOs, a PO that
// arrives in two lorries is two GRNs. What the LIST cannot show is whether the
// children cover DIFFERENT quantities (a genuine split) or the SAME ones (a
// duplicate). The source-document chips on those screens are the TRACE, not the
// content: two partial deliveries drawing on the same POs both display the same
// PO chips, which is exactly what makes the screen look wrong when it is right.
//
// So this reports, per parent line: ordered qty, the child documents, what each
// took, and the sum. A parent whose children sum to MORE than it ordered is a
// real over-fulfilment; equal or less is a split, however alarming the list
// looked.
//
// WHY A SCRIPT AND NOT A QUESTION. The owner is not a database console
// (CLAUDE.md). A fact that lives only in production is a workflow he clicks, not
// a SELECT pasted into chat.
//
// READ-ONLY. Two SELECTs, no DDL, no writes, no transaction.
//
// EXITS 0 FOR EVERY LEGITIMATE ANSWER — including "these are duplicates". A red
// job reads as "the check broke"; the ANSWER is the output. Only an unreachable
// database or a malformed query is non-zero.
//
//   DOC=2990-SO-2606-019 node backend/scripts/check-doc-splits.mjs
//   DOC=2990-PO-2606-024 node backend/scripts/check-doc-splits.mjs
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

const doc = (process.env.DOC ?? "").trim();
if (!doc) {
  console.error('DOC not set. Pass a Sales Order or Purchase Order number, e.g. DOC="2990-SO-2606-019".');
  process.exit(1);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/** A fixed-width money/qty column so the report lines up in a run log. */
const pad = (v, n) => String(v).padEnd(n);
const num = (v) => Number(v ?? 0);

try {
  const isSo = /-SO-/i.test(doc);
  const isPo = /-PO-/i.test(doc);
  if (!isSo && !isPo) {
    console.log(`"${doc}" is neither an SO nor a PO number — nothing to check.`);
    process.exit(0);
  }

  if (isSo) {
    /* One row per (SO line, DO that took from it). The LEFT JOIN keeps lines
       nothing has been cut for, because "one line never delivered while another
       went out twice" is the shape worth seeing. CANCELLED children are excluded
       for the same reason the app's remaining() formula excludes them — a
       cancelled DO releases its quantity. */
    /* mfg_sales_order_items carries doc_no itself, so the header is not needed.
       Cancelled SO lines are excluded — they order nothing. */
    const rows = await pg`
      SELECT si.doc_no          AS parent_no,
             si.id              AS line_id,
             si.item_code,
             si.description,
             si.qty             AS ordered_qty,
             d.do_number        AS child_no,
             d.status           AS child_status,
             d.created_at       AS child_created,
             di.qty             AS child_qty
        FROM scm.mfg_sales_order_items si
        LEFT JOIN scm.delivery_order_items di ON di.so_item_id = si.id
        LEFT JOIN scm.delivery_orders d
               ON d.id = di.delivery_order_id AND d.status <> 'CANCELLED'
       WHERE si.doc_no = ${doc}
         AND COALESCE(si.cancelled, false) = false
       ORDER BY si.item_code, d.created_at NULLS FIRST
    `;
    report(doc, "Sales Order", "Delivery Orders", rows);
  } else {
    /* qty_accepted, not qty: a GRN line records what was ACCEPTED, and rejected
       goods never entered stock and must not count against the PO. */
    const rows = await pg`
      SELECT po.po_number       AS parent_no,
             pi.id              AS line_id,
             pi.material_code   AS item_code,
             pi.material_name   AS description,
             pi.qty             AS ordered_qty,
             g.grn_number       AS child_no,
             g.status           AS child_status,
             g.created_at       AS child_created,
             gi.qty_accepted    AS child_qty
        FROM scm.purchase_orders po
        JOIN scm.purchase_order_items pi ON pi.purchase_order_id = po.id
        LEFT JOIN scm.grn_items gi ON gi.purchase_order_item_id = pi.id
        LEFT JOIN scm.grns g
               ON g.id = gi.grn_id AND g.status <> 'CANCELLED'
       WHERE po.po_number = ${doc}
       ORDER BY pi.material_code, g.created_at NULLS FIRST
    `;
    report(doc, "Purchase Order", "Goods Receipts", rows);
  }
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}

function report(docNo, parentLabel, childLabel, rows) {
  if (rows.length === 0) {
    console.log(`No ${parentLabel} found with number ${docNo}.`);
    return;
  }

  const byLine = new Map();
  for (const r of rows) {
    if (!byLine.has(r.line_id)) {
      byLine.set(r.line_id, { item: r.item_code, desc: r.description, ordered: num(r.ordered_qty), children: [] });
    }
    if (r.child_no) {
      byLine.get(r.line_id).children.push({ no: r.child_no, status: r.child_status, qty: num(r.child_qty) });
    }
  }

  const children = new Set();
  let overCount = 0;

  console.log(`${parentLabel} ${docNo} — ${byLine.size} line(s), split across these ${childLabel}:\n`);
  for (const line of byLine.values()) {
    const taken = line.children.reduce((s, ch) => s + ch.qty, 0);
    for (const ch of line.children) children.add(ch.no);
    /* OVER is the only finding that is a problem. Equal means fully fulfilled,
       less means part of the line is still outstanding — both normal. */
    const verdict =
      taken > line.ordered ? `OVER by ${taken - line.ordered}`
      : taken === line.ordered ? "fully covered"
      : `${line.ordered - taken} still outstanding`;
    if (taken > line.ordered) overCount++;

    console.log(`  ${pad(line.item, 18)} ordered ${pad(line.ordered, 6)} taken ${pad(taken, 6)} ${verdict}`);
    if (line.children.length === 0) {
      console.log(`      (nothing cut from this line yet)`);
    }
    for (const ch of line.children) {
      console.log(`      ${pad(ch.no, 22)} ${pad(ch.status ?? "", 12)} qty ${ch.qty}`);
    }
  }

  console.log(`\n${children.size} ${childLabel} touch this ${parentLabel}: ${[...children].join(", ") || "(none)"}`);
  if (overCount > 0) {
    console.log(`\nFINDING: ${overCount} line(s) have been fulfilled BEYOND what was ordered.`);
    console.log("That is a real over-fulfilment — the children double-cover the same quantity.");
  } else {
    console.log("\nNo line is over-fulfilled. Several children on one parent is a PARTIAL");
    console.log("fulfilment, not a duplicate — which is what the list screen cannot show,");
    console.log("because the source-document chips there are the trace, not the quantities.");
  }
}
