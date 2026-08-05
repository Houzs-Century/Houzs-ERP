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
if (!doNo) {
  console.error("DO not set. Pass the delivery order number, e.g. 2990-DO-2607-017.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const rpad = (s, n) => String(s ?? "").padEnd(n);
const lpad = (s, n) => String(s ?? "").padStart(n);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
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
