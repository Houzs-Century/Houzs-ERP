#!/usr/bin/env node
// ----------------------------------------------------------------------------
// repair-migrated-do-prices — the migrated delivery orders carry no money.
//
// WHAT IS WRONG. `create-migrated-documents.mjs` doDos() inserted
// `scm.delivery_order_items` naming ten columns and NONE of the price ones,
// while doGrns() in the same file always wrote `unit_price_sen` and
// `line_total_sen`. Both price columns are `integer DEFAULT 0 NOT NULL`, so the
// omission is silent: every migrated delivery order reads RM 0.00, and so does
// the Revenue tile above the list, which sums the same column.
//
// WHY IT IS NOT COSMETIC. The DO line's unit price prefills a NEW Sales Invoice
// (scm/lib/do-line-remaining.ts:326 -> pages/scm-v2/SalesInvoiceFromDo.tsx:321),
// the SI price-drift guard SKIPS a zero on purpose ("an agreed price of 0 has
// no ratio to drift from", sales-invoices.ts:512), and `migrated_no_stock`
// gates the sales invoice (post-si-revenue.ts:49) and the purchase invoice
// (purchase-invoices.ts:301) but NOT the DO -> SI path. An operator invoicing
// one of these was prefilled RM 0.00 with nothing said.
//
// WHERE THE PRICE COMES FROM. `mfg_sales_order_items.unit_price_sen`, reached
// through the `so_item_id` the migrated line already carries — the same source
// the interactive create path reads (soDeliverableRemaining ->
// delivery-orders-mfg.ts:4058). Nothing is invented.
//
// THE DISCOUNT IS NOT CARRIED, deliberately, and the writer fix says the same:
// `discount_sen` on an SO line is a LINE amount, not a per-unit one, and one
// migrated SO line is routinely split across several AutoCount delivery notes.
// Copying it whole onto each split would deduct it once per delivery; dividing
// it needs a rule nobody has written. A per-UNIT price is well defined; the
// discount stays 0 and the figure is honestly undiscounted.
//
// SCOPE, kept as narrow as the defect. Only lines that are BOTH
// `line_total_sen = 0` AND on a delivery order with `migrated_no_stock = true`
// AND carry a `so_item_id` whose SO line has a price > 0. A genuinely free line
// (a gift, a zero-priced service) is left alone because its SO line is 0 too.
// A line with no `so_item_id` is REPORTED and never guessed at.
//
// The category buckets, cost, margin and line_count beyond the header total are
// deliberately NOT restated here — `recomputeDoTotals` (delivery-orders-mfg.ts)
// is that rule's one home, and a second copy in a repair script is how two
// answers start. The header's `local_total_sen` IS written, because that is the
// figure the list and its Revenue tile read and it is a plain sum.
//
//   DATABASE_URL   required
//   COMPANY        a company id, or `all` (default all)
//   MODE           plan (default) | apply
//   CONFIRM        on apply, exactly: THE PRICE COMES FROM THE SALES ORDER
//
// RE-RUN: convergent. The selection is `line_total_sen = 0`, so a second run
// finds the repaired lines already priced and plans nothing. A line whose SO
// line is genuinely 0 stays eligible and is re-reported every run — that is an
// open question about the data, not an unfinished repair.
//
// -- REVERSAL: the previous values were all 0 by construction (the columns are
// DEFAULT 0 NOT NULL and the writer never named them), so the undo is
// `UPDATE scm.delivery_order_items SET unit_price_sen = 0, line_total_sen = 0,
// unit_cost_sen = 0, line_cost_sen = 0 WHERE id = ANY(<the ids this run printed>)`
// plus `local_total_sen = 0` on the headers it printed. The apply prints every
// id it touches for exactly this reason.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }

const RAW = String(process.env.COMPANY ?? "all").trim().toLowerCase();
const ALL = RAW === "all" || RAW === "";
const COMPANY = ALL ? null : Number(RAW);
if (!ALL && !Number.isInteger(COMPANY)) { console.error(`COMPANY must be an id or "all" (got "${RAW}")`); process.exit(2); }

const MODE = (process.env.MODE ?? "plan").trim().toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "THE PRICE COMES FROM THE SALES ORDER";
if (APPLY && (process.env.CONFIRM ?? "") !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" exactly. Refusing.`);
  process.exit(2);
}
if (MODE !== "plan" && MODE !== "apply") { console.error(`MODE must be plan | apply (got "${MODE}")`); process.exit(2); }

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  log(`mode=${MODE} company=${ALL ? "all" : COMPANY}`);

  const rows = await sql`
    SELECT di.id, di.delivery_order_id, di.qty, di.so_item_id,
           d.do_number, d.company_id,
           si.unit_price_sen AS so_unit_price_sen,
           si.unit_cost_sen  AS so_unit_cost_sen
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
     WHERE d.migrated_no_stock IS TRUE
       AND di.line_total_sen = 0
       AND (${ALL} OR d.company_id = ${COMPANY ?? 0})
     ORDER BY d.do_number, di.id`;

  log(`zero-priced lines on migrated delivery orders: ${rows.length}`);
  if (rows.length === 0) { log("Nothing to repair."); await sql.end(); process.exit(0); }

  const noLink = rows.filter((r) => !r.so_item_id);
  const zeroSource = rows.filter((r) => r.so_item_id && !(Number(r.so_unit_price_sen) > 0));
  const fixable = rows.filter((r) => r.so_item_id && Number(r.so_unit_price_sen) > 0);

  log(`  no so_item_id — REPORTED, never guessed : ${noLink.length}`);
  log(`  sales-order line is itself 0 — left alone: ${zeroSource.length}`);
  log(`  repairable from the sales order          : ${fixable.length}`);
  for (const r of noLink.slice(0, 15)) log(`    UNLINKED  ${r.do_number}  line ${r.id}`);
  for (const r of zeroSource.slice(0, 15)) log(`    SO-IS-ZERO ${r.do_number}  line ${r.id}`);

  const byDo = new Map();
  for (const r of fixable) {
    const unit = Math.round(Number(r.so_unit_price_sen));
    const cost = Math.round(Number(r.so_unit_cost_sen ?? 0));
    const qty = Number(r.qty);
    const lineTotal = Math.max(0, Math.round(qty * unit));
    const cur = byDo.get(r.delivery_order_id) ?? { doNumber: r.do_number, lines: [], total: 0 };
    cur.lines.push({ id: r.id, unit, cost, lineTotal, lineCost: Math.round(qty * cost), qty });
    cur.total += lineTotal;
    byDo.set(r.delivery_order_id, cur);
  }
  log("");
  log(`documents affected: ${byDo.size}`);
  for (const [doId, v] of [...byDo.entries()].slice(0, 20)) {
    log(`  ${v.doNumber}  ${v.lines.length} line(s)  -> local_total_sen ${v.total}  [${doId}]`);
  }
  if (byDo.size > 20) log(`  ... and ${byDo.size - 20} more`);

  if (!APPLY) {
    log("");
    log(`PLAN ONLY. Nothing was written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    process.exit(0);
  }

  /* The header total is written from the SUM OF THE WHOLE DOCUMENT, not from the
     lines this run touched: a document can hold a priced line already (a later
     hand edit) and adding only the repaired ones would understate it. */
  let lines = 0, docs = 0;
  for (const [doId, v] of byDo.entries()) {
    await sql.begin(async (tx) => {
      for (const l of v.lines) {
        await tx`UPDATE scm.delivery_order_items
                    SET unit_price_sen = ${l.unit}, line_total_sen = ${l.lineTotal},
                        unit_cost_sen = ${l.cost}, line_cost_sen = ${l.lineCost}
                  WHERE id = ${l.id} AND line_total_sen = 0`;
        lines += 1;
      }
      await tx`UPDATE scm.delivery_orders d
                  SET local_total_sen = COALESCE(
                        (SELECT SUM(line_total_sen) FROM scm.delivery_order_items WHERE delivery_order_id = d.id), 0)
                WHERE d.id = ${doId}`;
      docs += 1;
    });
    log(`  applied ${v.doNumber}: ${v.lines.map((l) => l.id).join(",")}`);
  }
  log(`APPLIED. lines=${lines} documents=${docs}`);

  await sql.end();

  /* VERIFY ON A FRESH CONNECTION, AND ASSERT THE SHAPE, NOT THE COUNT. A count
     of updated rows was true while the jsonb double-encoding repair reproduced
     the very bug it was undoing on 7 production rows (CLAUDE.md). What must be
     true here is a SHAPE: no repaired line may still be zero, none may be
     negative, and every touched header must equal the sum of its own lines. */
  const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const ids = [...byDo.values()].flatMap((v) => v.lines.map((l) => l.id));
  const [bad] = await check`
    SELECT count(*) FILTER (WHERE line_total_sen <= 0)            AS still_zero,
           count(*) FILTER (WHERE unit_price_sen <= 0)            AS no_unit_price,
           count(*) FILTER (WHERE line_total_sen <> qty * unit_price_sen) AS not_qty_times_unit
      FROM scm.delivery_order_items WHERE id = ANY(${ids})`;
  const headerDrift = await check`
    SELECT d.do_number, d.local_total_sen,
           COALESCE((SELECT SUM(line_total_sen) FROM scm.delivery_order_items WHERE delivery_order_id = d.id), 0) AS line_sum
      FROM scm.delivery_orders d WHERE d.id = ANY(${[...byDo.keys()]})
       AND d.local_total_sen IS DISTINCT FROM
           COALESCE((SELECT SUM(line_total_sen) FROM scm.delivery_order_items WHERE delivery_order_id = d.id), 0)`;
  await check.end();

  const problems = [];
  if (Number(bad.still_zero) > 0) problems.push(`${bad.still_zero} repaired line(s) are STILL zero`);
  if (Number(bad.no_unit_price) > 0) problems.push(`${bad.no_unit_price} repaired line(s) carry no unit price`);
  if (Number(bad.not_qty_times_unit) > 0) problems.push(`${bad.not_qty_times_unit} line(s) where line_total <> qty x unit`);
  if (headerDrift.length > 0) problems.push(`${headerDrift.length} header(s) disagree with their own lines: ${headerDrift.map((h) => h.do_number).join(", ")}`);

  if (problems.length) {
    console.error(`VERIFY FAILED (fresh connection, shape check): ${problems.join("; ")}`);
    process.exit(1);
  }
  log(`VERIFIED on a fresh connection: ${ids.length} line(s) priced, ${byDo.size} header(s) equal their own line sum.`);
  process.exit(0);
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
