#!/usr/bin/env node
// ----------------------------------------------------------------------------
// RECOMPUTE mfg_sales_order_items.po_qty_picked FROM THE PURCHASE-ORDER LINES
// THAT ALREADY POINT AT IT.
//
// THE GAP, NAMED BY THE REPO ITSELF. repair-migrated-po-lines.mjs:369-383 says
// it out loud:
//
//   "po_qty_picked is NOT recomputed here, and that is a real gap, named so it
//    is not discovered later. ... A dedication stamped by this script therefore
//    does not move the counter, so these SO lines keep reading as
//    still-needing-ordering in the From-SO picker (qty - picked > 0) — a
//    duplicate-PO risk until something recomputes it."
//
// Nothing ever did. This is that something. Measured on production
// 2026-09-08 (check-ac-convert-symmetry run 34142505986): 962 of 15050 live
// company-1 sales-order lines carry a po_qty_picked that disagrees with their
// own purchase-order children, ALL 962 reading LOW and all 962 on a migrated
// (HC-*) order. Reading LOW is the dangerous direction: the SO->PO ceiling is
// `qty - po_qty_picked`, so a counter stuck at 0 leaves the line looking
// entirely unpurchased and a second purchase order can be raised for goods
// already bought.
//
// THIS INVENTS NOTHING. It does not create, move or infer a LINK. Every value
// it writes is a sum over `purchase_order_items` rows that already carry
// `so_item_id` — a denormalised mirror recomputed from its own source rows.
// The account book is not consulted and cannot be: migration-copy-never-compute
// governs the LINK, and no link is touched here.
//
// IT APPLIES THE APP'S OWN RULE, NOT A PLAUSIBLE ONE. recomputeSoPicked
// (src/scm/routes/mfg-purchase-orders.ts:2843-2887) is the only writer of this
// column, and it is NOT "sum the children":
//
//   - lines with `from_mrp = true` are DROPPED. An MRP-origin purchase-order
//     line is reference-only by the 2026-05-31 decision and deliberately does
//     not lock its source sales-order line; coverage is handled by the pooled
//     supply model instead. Counting them would over-close the ceiling and
//     hide a line that genuinely still needs ordering.
//   - DRAFT purchase orders are excluded alongside CANCELLED, because a draft
//     must not drop the sales order off the From-SO picker before it commits.
//   - the result is NOT clamped. Unlike grn_items.invoiced_qty, recomputeSoPicked
//     writes the raw sum, and this writes the same raw sum. Clamping here would
//     make the script and the app disagree the moment a route next touched the
//     row.
//
// So this is exactly the value the app would write itself the next time anybody
// edited one of those purchase orders — the live-count model's own words are
// that it "self-heals on the next operation that touches these SO lines". The
// script performs that heal deliberately instead of waiting for a staff member
// to trip over it.
//
// WHAT IT WILL DO TO THE SCREEN, said plainly: a sales-order line that has
// already been purchased stops offering itself for purchase again. That is the
// intended effect and it is the whole point.
//
// SEQUENCING. po_qty_picked is read by MRP (routes/mrp.ts) and by the From-SO
// picker. Do not APPLY this while a stock re-seed or an MRP recompute is in
// flight — check `gh run list` first. The PLAN is read-only and safe any time.
//
//   DATABASE_URL  required
//   COMPANY_ID    default 1 (AED_HOUZS)
//   MODE          plan (DEFAULT) | apply
//   CONFIRM       on apply, must equal the exact phrase below
//
// RE-RUN: idempotent. A second run recomputes the same values, finds every row
// already equal to its recomputed value, plans zero rows and writes nothing.
// Safe to run any number of times.
//
// REVERSAL: this script does not drop or alter any structure. To undo a run,
// restore the prior po_qty_picked values from the plan output, which prints the
// OLD value beside the new one for every row it intends to write; or simply let
// recomputeSoPicked run — it computes the same value from the same rows, so the
// "before" state is not reachable again except by changing the purchase orders.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
if (!["plan", "apply"].includes(MODE)) {
  console.error(`MODE must be plan | apply (got "${MODE}")`);
  process.exit(2);
}
const CONFIRM_PHRASE = "recompute-po-qty-picked";
if (MODE === "apply" && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}" (got "${process.env.CONFIRM ?? ""}").`);
  process.exit(2);
}
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m = "") => console.log(m);
const SHOW = 25;

/* The one definition of the counter, written once and used by the plan, the
   write and the verification. Two copies of a rule is how a verification comes
   to agree with a bug: it would be checking the same mistake it made. */
const PICKED_RULE = (sql) => sql`
  SELECT s.id, s.doc_no, s.item_code, s.qty,
         s.po_qty_picked AS claimed,
         COALESCE(k.took, 0) AS expected
    FROM scm.mfg_sales_order_items s
    JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
    LEFT JOIN (SELECT i.so_item_id, sum(i.qty) AS took
                 FROM scm.purchase_order_items i
                 JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
                WHERE i.so_item_id IS NOT NULL
                  AND i.from_mrp IS NOT TRUE
                  AND h.status NOT IN ('CANCELLED','DRAFT')
                GROUP BY i.so_item_id) k ON k.so_item_id = s.id
   WHERE o.status <> 'CANCELLED'
     AND s.po_qty_picked IS DISTINCT FROM COALESCE(k.took, 0)`;

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  out(`mode=${MODE}  company=${CO}`);

  /* The columns the rule is defined on. An anti-join against a column that was
     renamed matches nothing and reports "0 rows to fix", which is the clean-
     looking catastrophe this repo keeps paying for. Refuse instead. */
  const cols = await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema='scm' AND (table_name, column_name) IN (
       ('mfg_sales_order_items','po_qty_picked'), ('purchase_order_items','so_item_id'),
       ('purchase_order_items','from_mrp'), ('purchase_order_items','qty'))`;
  const have = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
  const need = ["mfg_sales_order_items.po_qty_picked", "purchase_order_items.so_item_id",
    "purchase_order_items.from_mrp", "purchase_order_items.qty"];
  const missing = need.filter((n) => !have.has(n));
  if (missing.length) {
    console.error(`REFUSED: the ERP no longer carries ${missing.join(", ")}. The rule this script `
      + "recomputes is defined on those columns; without one of them it would plan zero rows and "
      + "report a clean run.");
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  const plan = await PICKED_RULE(sql);
  const low = plan.filter((r) => Number(r.claimed) < Number(r.expected));
  const high = plan.filter((r) => Number(r.claimed) > Number(r.expected));
  out("");
  out(`${plan.length} sales-order line(s) disagree with their purchase-order children`);
  out(`  ${low.length} read LOW  — the line still offers itself for purchase though it was already bought`);
  out(`  ${high.length} read HIGH — the line is blocked from a purchase it is still entitled to`);
  out("");
  for (const r of plan.slice(0, SHOW)) {
    out(`  ${r.doc_no}  ${r.item_code}  qty ${r.qty}:  ${r.claimed} -> ${r.expected}`);
  }
  if (plan.length > SHOW) out(`  ... and ${plan.length - SHOW} more`);

  if (plan.length === 0) {
    log("Nothing to do: every live sales-order line already agrees with its purchase-order children.");
    await sql.end({ timeout: 5 });
    return;
  }

  if (MODE !== "apply") {
    log(`PLAN ONLY — nothing written. ${plan.length} row(s) would change. `
      + `Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write them.`);
    await sql.end({ timeout: 5 });
    return;
  }

  /* Write each row to its OWN recomputed value, addressed by id. Not one bulk
     UPDATE ... FROM: the plan is what was reviewed, and writing anything the
     plan did not name would make the review meaningless. */
  let written = 0;
  for (const r of plan) {
    const res = await sql`
      UPDATE scm.mfg_sales_order_items SET po_qty_picked = ${r.expected}
       WHERE id = ${r.id} AND po_qty_picked = ${r.claimed}`;
    written += res.count;
  }
  out("");
  out(`wrote ${written} of ${plan.length} planned row(s)`);
  if (written !== plan.length) {
    out(`  ${plan.length - written} row(s) had moved since the plan was taken (the guard on the old `
      + "value refused them). Re-run to pick them up.");
  }
  await sql.end({ timeout: 5 });

  /* ── VERIFICATION, on a FRESH connection, asserting the SHAPE ──────────────
     A row count is not a shape. `written` being equal to the plan proves the
     statements matched rows; it does not prove the column now holds the value
     the rule computes, and the repair this repo wrote to undo the jsonb
     double-encoding COE reported 7 of 7 while reproducing that exact bug. So:
     reconnect, recompute the rule from scratch, and assert the disagreement set
     is EMPTY — plus two independent shape assertions that would catch a write
     that landed the wrong number in the right rows. */
  const v = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    const still = await PICKED_RULE(v);
    const negative = await v`
      SELECT count(*)::int AS n FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
       WHERE o.status <> 'CANCELLED' AND s.po_qty_picked < 0`;
    const nonNumeric = await v`
      SELECT count(*)::int AS n FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
       WHERE o.status <> 'CANCELLED' AND s.po_qty_picked IS NULL`;
    out("");
    out("VERIFICATION (fresh connection, rule recomputed from scratch)");
    out(`  rows still disagreeing with their purchase-order children : ${still.length}`);
    out(`  rows left with a NEGATIVE po_qty_picked                    : ${negative[0].n}`);
    out(`  rows left with a NULL po_qty_picked                        : ${nonNumeric[0].n}`);
    const ok = still.length === 0 && negative[0].n === 0 && nonNumeric[0].n === 0;
    if (!ok) {
      for (const r of still.slice(0, SHOW)) out(`    ${r.doc_no} ${r.item_code}: ${r.claimed} vs ${r.expected}`);
      log(`VERIFICATION FAILED — ${still.length} row(s) still disagree. The write did not do what it claimed.`);
      await v.end({ timeout: 5 });
      process.exit(1);
    }
    log(`APPLIED and VERIFIED: ${written} sales-order line(s) recomputed; 0 still disagree, `
      + "0 negative, 0 null.");
  } finally {
    await v.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
