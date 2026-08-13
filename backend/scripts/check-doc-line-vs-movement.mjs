// Read-only: for ONE delivery order, its document LINES beside its inventory
// MOVEMENTS, so an orphan on either side is named.
//
// WHY THIS EXISTS
//
// `check-posted-doc-movements.mjs` finds the case where a posted document wrote
// NO movements. This is the mirror it could not see: a movement that exists with
// no document line behind it. Nothing looked for that, which is how one survived
// long enough to make an Inventory row read "1 + 1 − 2 = −1".
//
// THE CASE THAT PROMPTED IT (2026-08-05). `reconcile-sku.mjs` on the four
// drifting sofas returned the same shape every time — the movement ledger
// carrying one more shipment than the documents allow:
//
//   XAMMAR-1A(LHF)   OUT movements: 2990-DO-2607-016, 2990-DO-2607-017
//                    documents say "DO shipped (non-cancelled) −1", not −2
//                    DOCUMENT stock 0 · movement −1 WRONG · lots 0 matches
//
// `verify-do-cancel.mjs` shows 2990-DO-2607-017 is DISPATCHED — a live delivery,
// never cancelled — so the usual explanation (a cancel whose reversal never ran)
// does not apply. Something wrote OUT movements for five SKUs on that DO which
// its lines do not account for.
//
// WHAT IT PRINTS, per item code on the named DO:
//   line qty      what delivery_order_items says was delivered
//   movement qty  what inventory_movements actually moved
//   verdict       AGREE / ORPHAN MOVEMENT (no line) / MISSING MOVEMENT (no move)
//                 / MISMATCH (both exist, different quantities)
//
// It names the fault; it does not repair it. Repair needs the documents read
// (reconcile-sku.mjs) and a decision about which side to correct.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — the answer IS the output.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { DO_STOCK_OUT_STATES } from "./lib/do-shipped-states.mjs";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
const doNo = (process.env.DO || "").trim();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
// No DO given -> SWEEP MODE: every shipped DO and every posted GRN, item level.

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const rpad = (s, n) => String(s ?? "").padEnd(n);
const lpad = (s, n) => String(s ?? "").padStart(n);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* ── SWEEP MODE — the catalogue-wide answer to "出的全部记录都对得上吗?" ──────
   The posted-doc detector proves every shipped document wrote SOME movement;
   this proves the QUANTITIES agree per item, in both directions:
     DO : line qty  vs  net OUT (OUT − resync INs) per item
     GRN: accepted  vs  IN per item
   Service lines never move stock by design and are excluded. A cancelled doc is
   excluded (its movements are legitimately reversed/netted). An orphan movement
   here is stock that moved with no document line behind it — the exact shape
   that made the movement ledger disagree with the documents on the four sofas
   while every document looked correct on its own. */
async function sweep() {
  const SHIPPED = DO_STOCK_OUT_STATES;

  notice("SWEEP MODE — every shipped DO and posted GRN, document lines vs movements, per item.");

  const doRows = await pg`
    WITH lines AS (
      SELECT d.id AS doc_id, d.do_number AS doc_no, i.item_code,
             SUM(i.qty)::numeric AS doc_qty
        FROM scm.delivery_orders d
        JOIN scm.delivery_order_items i ON i.delivery_order_id = d.id
       WHERE upper(d.status::text) = ANY(${SHIPPED})
         AND NOT (i.item_code ILIKE 'SVC-%' OR lower(COALESCE(i.item_group,'')) = 'service')
       GROUP BY 1, 2, 3
    ), moves AS (
      SELECT m.source_doc_id AS doc_id, m.product_code AS item_code,
             SUM(CASE WHEN m.movement_type = 'OUT' THEN ABS(m.qty) ELSE 0 END)::numeric
           - SUM(CASE WHEN m.movement_type = 'IN'  THEN ABS(m.qty) ELSE 0 END)::numeric AS net_out
        FROM scm.inventory_movements m
        JOIN scm.delivery_orders d ON d.id = m.source_doc_id
       WHERE m.source_doc_type = 'DO' AND upper(d.status::text) = ANY(${SHIPPED})
       GROUP BY 1, 2
    )
    SELECT COALESCE(l.doc_no, (SELECT do_number FROM scm.delivery_orders WHERE id = m.doc_id)) AS doc_no,
           COALESCE(l.item_code, m.item_code) AS item_code,
           l.doc_qty, m.net_out
      FROM lines l
      FULL OUTER JOIN moves m ON l.doc_id = m.doc_id AND l.item_code = m.item_code
     WHERE COALESCE(l.doc_qty, 0) <> COALESCE(m.net_out, 0)
     ORDER BY 1, 2`;

  const grnRows = await pg`
    WITH lines AS (
      SELECT g.id AS doc_id, g.grn_number AS doc_no, i.material_code AS item_code,
             SUM(i.qty_accepted)::numeric AS doc_qty
        FROM scm.grns g
        JOIN scm.grn_items i ON i.grn_id = g.id
       WHERE upper(g.status::text) = 'POSTED'
         AND NOT (i.material_code ILIKE 'SVC-%' OR lower(COALESCE(i.item_group,'')) = 'service')
       GROUP BY 1, 2, 3
    ), moves AS (
      SELECT m.source_doc_id AS doc_id, m.product_code AS item_code,
             SUM(ABS(m.qty))::numeric AS in_qty
        FROM scm.inventory_movements m
        JOIN scm.grns g ON g.id = m.source_doc_id
       WHERE m.source_doc_type = 'GRN' AND m.movement_type = 'IN'
         AND upper(g.status::text) = 'POSTED'
       GROUP BY 1, 2
    )
    SELECT COALESCE(l.doc_no, (SELECT grn_number FROM scm.grns WHERE id = m.doc_id)) AS doc_no,
           COALESCE(l.item_code, m.item_code) AS item_code,
           l.doc_qty, m.in_qty AS net_out
      FROM lines l
      FULL OUTER JOIN moves m ON l.doc_id = m.doc_id AND l.item_code = m.item_code
     WHERE COALESCE(l.doc_qty, 0) <> COALESCE(m.in_qty, 0)
     ORDER BY 1, 2`;

  const report = (label, rows) => {
    if (rows.length === 0) {
      notice(`${label}: every item on every document matches its movements exactly.`);
      return;
    }
    notice(`${label}: ${rows.length} item(s) where document and movements DISAGREE:`);
    console.log(`  ${rpad("doc", 22)}${rpad("item", 34)}doc qty  moved`);
    for (const r of rows) {
      console.log(
        `  ${rpad(r.doc_no, 22)}${rpad(r.item_code, 34)}${String(r.doc_qty ?? "—").padStart(7)}  ${String(r.net_out ?? "—").padStart(5)}` +
          (r.doc_qty == null ? "   <- ORPHAN MOVEMENT (no line)" : r.net_out == null ? "   <- line moved nothing" : ""),
      );
    }
  };

  report("DO (out)", doRows);
  report("GRN (in)", grnRows);
  console.log("");
  notice(
    doRows.length === 0 && grnRows.length === 0
      ? "VERDICT: every IN and every OUT is backed by a document line, and every quantity agrees."
      : "VERDICT: the rows above are the complete list of document/ledger quantity disagreements. Settle each with reconcile-sku before repairing.",
  );
}

try {
  if (!doNo) {
    await sweep();
    process.exit(0);
  }
  const [doc] = await pg`
    SELECT id, do_number, status, created_at
      FROM scm.delivery_orders
     WHERE do_number = ${doNo}`;

  if (!doc) {
    notice(`No delivery order named ${doNo}. Nothing to compare.`);
    process.exit(0);
  }

  console.log(`\nDelivery Order ${doc.do_number}`);
  console.log(`  status   ${doc.status}`);
  console.log(`  created  ${String(doc.created_at).slice(0, 10)}\n`);

  /* Bucketed by ITEM CODE, not by variant. `delivery_order_items` carries
     `variants` as jsonb and has no `variant_key` column — the key is computed in
     application code — so a variant-level join is not available in SQL here.
     Item level is enough to name an orphan SKU; once one is named,
     reconcile-sku.mjs prints that SKU's per-variant split. Movements are matched
     by source_doc_id, the DO's own id, which is what the writers stamp. */
  const rows = await pg`
    WITH lines AS (
      SELECT item_code, SUM(qty)::numeric AS qty
        FROM scm.delivery_order_items
       WHERE delivery_order_id = ${doc.id}
       GROUP BY 1
    ), moves AS (
      SELECT product_code AS item_code, SUM(qty)::numeric AS qty
        FROM scm.inventory_movements
       WHERE source_doc_id = ${doc.id}
       GROUP BY 1
    )
    SELECT COALESCE(l.item_code, m.item_code) AS item_code,
           l.qty                              AS line_qty,
           m.qty                              AS move_qty
      FROM lines l
      FULL OUTER JOIN moves m ON l.item_code = m.item_code
     ORDER BY 1`;

  if (rows.length === 0) {
    notice(`${doNo} has neither lines nor movements. Nothing to compare.`);
    process.exit(0);
  }

  console.log(`  ${rpad("item", 40)}${lpad("line", 7)}${lpad("moved", 8)}  verdict`);
  let orphans = 0;
  let missing = 0;
  let mismatched = 0;
  for (const r of rows) {
    const line = r.line_qty === null ? null : Number(r.line_qty);
    /* Movements are signed: a DO writes OUT as a negative. Compare magnitudes,
       and report the raw figure so the sign is still visible. */
    const moved = r.move_qty === null ? null : Number(r.move_qty);
    let verdict;
    if (line === null) { verdict = "ORPHAN MOVEMENT — no line on this DO"; orphans++; }
    else if (moved === null) { verdict = "MISSING MOVEMENT — line moved nothing"; missing++; }
    else if (Math.abs(moved) !== Math.abs(line)) { verdict = "MISMATCH"; mismatched++; }
    else verdict = "agree";
    console.log(
      `  ${rpad(r.item_code, 40)}${lpad(line ?? "—", 7)}${lpad(moved ?? "—", 8)}  ${verdict}`,
    );
  }

  console.log("");
  if (orphans === 0 && missing === 0 && mismatched === 0) {
    notice(`${doNo}: every bucket agrees. The fault is not on this document.`);
  } else {
    notice(
      `${doNo}: ${orphans} orphan movement(s), ${missing} missing, ${mismatched} mismatched.`,
    );
    if (orphans > 0) {
      notice(
        "An ORPHAN MOVEMENT moved stock that this document does not account for. " +
          "It is why the movement ledger can disagree with the documents while " +
          "every document looks correct on its own. Settle the SKU with " +
          "reconcile-sku.mjs before deciding what to reverse — and do not delete " +
          "a movement whose lot consumption is still carrying COGS.",
      );
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}
