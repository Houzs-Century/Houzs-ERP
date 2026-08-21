#!/usr/bin/env node
/* Read-only: which goods receipts told their purchase order they had arrived,
   and which ones did not?

   WHY. Owner, 2026-08-21, two questions that turned out to be ONE column:

     「然后我不是收货了吗？为什么是show PO outstanding？还显示ordered？」
     「为什么 AutoCount 这一边 GRN 是进不进去的？不是 convert 而已嘛？」

   `grn_items.purchase_order_item_id` answers both:

     · MRP calls a PO line outstanding while `qty > received_qty`
       (`routes/mrp.ts:862`). `received_qty` is written by
       `recomputePoReceived`, whose FIRST act is to drop every null
       `purchase_order_item_id` (`routes/grns.ts:844`). A receipt line with no
       link therefore puts goods in the warehouse and leaves the PO open
       forever.
     · `readConvertSourceKeys` resolves WHICH PO lines a conversion took from
       the same column (`lib/autocount-convert-lines.ts`). No link, nothing to
       name, and `POST /grns` records the receipt as parentless instead of
       sending it.

   The New GRN form has three ways in (`GrnNew.tsx:5-16`). Two of them carry the
   link — the single-PO dropdown and the From-PO-multi picker. The third, the
   dashed "Add another item" button, writes `purchaseOrderItemId: null` by
   design, because a hand-entered receipt genuinely has no parent line. A
   receipt can therefore be MIXED: some lines linked, some not, in one document.

   ── WHAT IT MEASURES ──────────────────────────────────────────────────────
   Per posted, non-cancelled GRN in scope, its lines are classified:

     ALL     every line carries a purchase_order_item_id
     MIXED   some do, some do not          <- the shape that decides the
     NONE    no line does                     AutoCount question
     EMPTY   no lines at all

   Then, for the population that can actually hurt: an UNLINKED line whose own
   supplier had an OPEN PO line for the SAME item_code at the time the receipt
   posted. Those are receipts where the goods arrived against a real order and
   the order was never told. That is the MRP symptom, counted.

   THE COMPLEMENT OF diag-po-receipt-drift, not a duplicate of it. That probe
   asks whether a PO line's stored `received_qty` still agrees with the GRN
   lines that received against it — and its first clause is
   `WHERE gi.purchase_order_item_id IS NOT NULL`
   (`backend/scripts/diag-po-receipt-drift.mjs:42`). A receipt line with no link
   is therefore invisible to it BY CONSTRUCTION: there is no disagreement to
   find, because the line was never in the sum. It watches route B below; this
   watches route A, which nothing watched.

     route A  the line carried no `purchase_order_item_id` — measured here
     route B  the line was linked and the recount FAILED — `recomputePoReceived`
              is deliberately non-throwing (a recount hiccup must not un-receive
              committed stock, `grns.ts:847`), and before 2026-07-31 it also
              swallowed the outcome: eleven receipts
              (2990-GRN-2607-011..-021) put their stock away and left their POs
              untouched for nine days, with only a console.error in a log with
              no retention. It now writes `RECOUNT_FAILED` to the GRN's own
              audit trail, which is what section 3 counts. Run
              `diag-po-receipt-drift` for the authoritative answer on route B —
              it compares state against the ledger and exits non-zero on drift.

   ── WHAT IT DOES NOT MEASURE ──────────────────────────────────────────────
   · It does not replay the receipt. "Open PO line for the same item_code" is a
     matching HEURISTIC on (supplier, item_code) — it does not know the operator
     meant that PO line. It is therefore an UPPER bound on the MRP symptom and
     is labelled as one. The exact answer for one document comes from the GRN=
     input below, which prints the lines and lets a human read them.
   · Variants are NOT part of the match. Two PO lines for the same code in
     different fabrics both count as candidates; this can only make the upper
     bound larger, never smaller.
   · It says nothing about batch_no. An earlier hypothesis blamed the batch
     bucket; the received_qty path above is the one the code actually takes.

   Read-only: SELECTs only. No DDL, no writes, no transaction, no lock. Exits 0
   for every legitimate answer, including zero findings; non-zero only if the
   database could not answer. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const ONE_GRN = (process.env.GRN ?? "").trim();

/* The company filter as a FRAGMENT, not a null bound into a comparison — the
   idiom probe-so-stock-status-stale.mjs:74 already proves against this book.
   One fragment per table alias rather than one helper taking the column name:
   the column is then a literal in the template, so no path exists for a name to
   be assembled at runtime and nobody has to check later whether one could. */
const coG = CO == null ? sql`` : sql`AND g.company_id = ${CO}`;
const coA = CO == null ? sql`` : sql`AND a.company_id = ${CO}`;

const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);

async function main() {
  note("=== GRN -> PO link probe (read-only) ===");
  note(`scope: ${CO == null ? "BOTH companies" : `company ${CO}`}`);
  if (ONE_GRN) note(`single document: ${ONE_GRN}`);
  note("");

  /* ── 1. Every receipt in scope, with its line link counts ────────────────
     Cancelled receipts are excluded: they are not claiming to have received
     anything, so an unlinked line on one is not a missing rollup. */
  const grns = await sql`
    SELECT g.id,
           g.grn_number,
           g.company_id,
           g.status,
           g.created_at,
           g.supplier_id,
           COUNT(i.id)                                       AS line_count,
           COUNT(i.purchase_order_item_id)                   AS linked_count
      FROM scm.grns g
      LEFT JOIN scm.grn_items i ON i.grn_id = g.id
     WHERE COALESCE(g.status, '') <> 'CANCELLED'
       ${coG}
     GROUP BY g.id, g.grn_number, g.company_id, g.status, g.created_at, g.supplier_id
     ORDER BY g.created_at DESC
  `;

  const bucket = { ALL: [], MIXED: [], NONE: [], EMPTY: [] };
  for (const g of grns) {
    const lines = Number(g.line_count);
    const linked = Number(g.linked_count);
    if (lines === 0) bucket.EMPTY.push(g);
    else if (linked === lines) bucket.ALL.push(g);
    else if (linked === 0) bucket.NONE.push(g);
    else bucket.MIXED.push(g);
  }

  const total = grns.length;
  note("── How every receipt links to its purchase order ──");
  note(`  receipts in scope                     ${rpad(total, 7)}`);
  for (const k of ["ALL", "MIXED", "NONE", "EMPTY"]) {
    note(`  ${pad(k === "ALL" ? "ALL lines linked" :
                 k === "MIXED" ? "MIXED — some linked, some not" :
                 k === "NONE" ? "NONE linked (hand-entered)" :
                 "EMPTY — no lines", 37)}${rpad(bucket[k].length, 7)}  ${pct(bucket[k].length, total)}`);
  }
  note("");
  note("  MIXED is the shape that decides the AutoCount question: a conversion");
  note("  can name the linked lines with their real quantities, but AutoCount's");
  note("  goods-received note would then be SHORT the hand-entered ones.");
  note("");

  /* ── 2. The MRP symptom, as an UPPER bound ───────────────────────────────
     An unlinked receipt line whose supplier had an OPEN PO line for the same
     item_code. `open` is measured NOW, not at receipt time: a PO line that has
     since been closed by some other receipt is not evidence of a missing
     rollup, and excluding it keeps the bound honest in the conservative
     direction. */
  const orphans = await sql`
    WITH unlinked AS (
      SELECT i.id, i.grn_id, i.item_code, i.qty_accepted, g.supplier_id, g.grn_number, g.company_id
        FROM scm.grn_items i
        JOIN scm.grns g ON g.id = i.grn_id
       WHERE i.purchase_order_item_id IS NULL
         AND COALESCE(g.status, '') NOT IN ('CANCELLED', 'DRAFT')
         AND COALESCE(i.qty_accepted, 0) > 0
         ${coG}
    )
    SELECT u.grn_number,
           u.item_code,
           u.qty_accepted,
           p.po_number,
           pi.qty,
           pi.received_qty,
           (pi.qty - COALESCE(pi.received_qty, 0)) AS still_open
      FROM unlinked u
      JOIN scm.purchase_order_items pi ON pi.item_code = u.item_code
      JOIN scm.purchase_orders p       ON p.id = pi.purchase_order_id
                                      AND p.supplier_id = u.supplier_id
                                      AND p.company_id  = u.company_id
     WHERE pi.qty - COALESCE(pi.received_qty, 0) > 0
       AND COALESCE(p.status, '') NOT IN ('CANCELLED', 'DRAFT', 'CLOSED')
     ORDER BY u.grn_number DESC, u.item_code
  `;

  const orphanGrns = new Set(orphans.map((r) => r.grn_number));
  note("── The MRP symptom, as an UPPER bound ──");
  note(`  hand-entered receipt lines whose supplier`);
  note(`  still has an OPEN PO line for that item  ${rpad(orphans.length, 7)}`);
  note(`  receipts involved                        ${rpad(orphanGrns.size, 7)}`);
  note("");
  note("  UPPER BOUND, not a count of defects: the match is on");
  note("  (supplier, item_code) only. It cannot know the operator meant that PO");
  note("  line, and it ignores variants — both widen it, neither narrows it.");
  note("");
  if (orphans.length) {
    note("  Newest 15:");
    note(`    ${pad("RECEIPT", 20)}${pad("ITEM", 22)}${rpad("RECVD", 8)}  ${pad("OPEN PO", 20)}${rpad("ORDERED", 9)}${rpad("BOOKED", 8)}${rpad("STILL OPEN", 12)}`);
    for (const r of orphans.slice(0, 15)) {
      note(`    ${pad(r.grn_number, 20)}${pad(r.item_code, 22)}${rpad(r.qty_accepted, 8)}  ${pad(r.po_number, 20)}${rpad(r.qty, 9)}${rpad(r.received_qty ?? 0, 8)}${rpad(r.still_open, 12)}`);
    }
    note("");
  }

  /* ── 3. Route B, for contrast: the line WAS linked and the recount failed ─
     `scm.entity_audit_log`, entity_type 'GRN', action 'RECOUNT_FAILED' — the
     exact row postGrnAndRollup writes (grns.ts:471-484). `entity_id` is TEXT in
     migration 0139, so the join casts rather than assuming a uuid column.

     This is a FLOOR, not the answer: it only sees failures the failing code
     managed to record, which is why diag-po-receipt-drift exists and compares
     state against the ledger instead. Reported here so the two routes are
     visibly separate rather than one being assumed. */
  note("── Route B, for contrast: linked, but the recount failed ──");
  try {
    const recountFailures = await sql`
      SELECT a.entity_doc_no,
             a.created_at,
             LEFT(COALESCE(a.note, ''), 150) AS note
        FROM scm.entity_audit_log a
       WHERE a.entity_type = 'GRN'
         AND a.action = 'RECOUNT_FAILED'
         ${coA}
       ORDER BY a.created_at DESC
       LIMIT 25
    `;
    note(`  RECOUNT_FAILED rows on receipts         ${rpad(recountFailures.length, 7)}${recountFailures.length === 25 ? "  (capped at 25)" : ""}`);
    note("  A FLOOR: it counts only failures the failing code recorded. For the");
    note("  authoritative answer on route B run diag-po-receipt-drift, which");
    note("  compares received_qty against the ledger and exits non-zero on drift.");
    for (const r of recountFailures.slice(0, 10)) {
      note(`    ${pad(r.entity_doc_no ?? "(no number)", 20)}${String(r.created_at).slice(0, 19)}`);
      if (r.note) note(`      ${r.note}`);
    }
    note("");
  } catch (e) {
    /* A miss must SAY it missed — a silent skip would read as "no failures". */
    note(`  NOT MEASURED — the audit read failed: ${String(e?.message ?? e).slice(0, 120)}`);
    note("  Treat section 2 as the only measured route, not as the whole answer.");
    note("");
  }

  /* ── 4. One named document, line by line ─────────────────────────────────
     The corpus numbers above are bounds. For the receipt actually in front of
     the owner, print the lines and let a human read them. */
  if (ONE_GRN) {
    const rows = await sql`
      SELECT g.grn_number,
             g.status,
             g.created_at,
             i.item_code,
             i.material_name,
             i.qty_accepted,
             i.purchase_order_item_id,
             p.po_number,
             pi.qty            AS po_qty,
             pi.received_qty   AS po_received
        FROM scm.grns g
        JOIN scm.grn_items i ON i.grn_id = g.id
        LEFT JOIN scm.purchase_order_items pi ON pi.id = i.purchase_order_item_id
        LEFT JOIN scm.purchase_orders p       ON p.id = pi.purchase_order_id
       WHERE g.grn_number = ${ONE_GRN}
         ${coG}
       ORDER BY i.item_code
    `;
    note(`── ${ONE_GRN}, line by line ──`);
    if (!rows.length) {
      note(`  No receipt numbered ${ONE_GRN} in scope. Check the number and the company.`);
    } else {
      note(`  status ${rows[0].status}   created ${String(rows[0].created_at).slice(0, 19)}`);
      note("");
      note(`  ${pad("ITEM", 22)}${rpad("RECVD", 8)}  ${pad("LINKED TO", 24)}${rpad("PO QTY", 8)}${rpad("BOOKED", 8)}`);
      for (const r of rows) {
        const link = r.purchase_order_item_id ? (r.po_number ?? "(po row missing)") : "— NOT LINKED —";
        note(`  ${pad(r.item_code, 22)}${rpad(r.qty_accepted, 8)}  ${pad(link, 24)}${rpad(r.po_qty ?? "", 8)}${rpad(r.po_received ?? "", 8)}`);
      }
      const unlinked = rows.filter((r) => !r.purchase_order_item_id).length;
      note("");
      note(`  ${unlinked} of ${rows.length} line(s) carry NO link to a purchase-order line.`);
      if (unlinked) {
        note("  Those quantities never reached purchase_order_items.received_qty, so");
        note("  MRP still counts the order as outstanding, and the conversion to");
        note("  AutoCount has nothing to name for them.");
      }
    }
    note("");
  } else {
    note("Pass GRN=<number> to print one receipt line by line.");
    note("");
  }

  note("=== end (read-only; nothing was written) ===");
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error(e);
    try { await sql.end(); } catch { /* connection already gone */ }
    /* Non-zero is reserved for "the database could not answer". Every
       legitimate result above exits 0, including zero findings. */
    process.exit(1);
  });
