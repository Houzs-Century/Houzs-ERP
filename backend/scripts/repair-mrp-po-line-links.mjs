// Repair the two data defects that make a company-1 sofa / bedframe sales-order
// line read SHORT on the MRP page even though its purchase order exists.
//
// WHY THIS SCRIPT EXISTS. Since 2026-09-09 a company-1 hard-bound line (sofa,
// bedframe, (SP) mattress) is covered ONLY by a purchase-order line that is
//   (a) linked to that very sales-order line (`so_item_id`), and
//   (b) itself on a hard-bound `item_group`.
// See `isHardBoundLine` / `HARD_BOUND_COMPANY_ID` in scm/lib/so-stock-allocation.ts
// and the `isDedicated` branch in scm/routes/mrp.ts. The rule is the owner's,
// ruled three times, and it is right. What it exposed is that a handful of
// purchase-order lines fail (a) or (b) through a pure data defect, so the buyer
// is asked to order goods that are already on order and the sales order can
// never reach READY. Owner-reported 2026-09-11: HC-SO-011114 (`9058-STOOL`
// reads SHORT while HC-PO-010045 carries it) and HC-SO-013389 (`8030-1A(LHF)`
// reads SHORT while HC-PO-010087 carries it).
//
// TWO CLASSES, deliberately separate — different evidence, different blast radius:
//
//   CLASS A — MISSING LINK. A hard-bound purchase-order line with no
//     `so_item_id`. Repairable ONLY when the evidence is unambiguous: the SAME
//     purchase order's other lines resolve to exactly ONE sales order, and on
//     that sales order exactly ONE live line shares this item code and
//     warehouse and carries no live purchase-order link of its own. Anything
//     looser is refused — `docs/mrp-stock-vs-bound-rules-2026-09-09.md` §3
//     measured what a looser match costs: "an open PO somewhere carries this
//     item code" returned 10 lines and paired four unrelated customers, because
//     sofa compartment codes repeat across orders.
//
//   CLASS B — WRONG CATEGORY. A purchase-order line that IS linked to a
//     hard-bound sales-order line but whose own `item_group` is not hard-bound
//     (prod today: exactly one line, `others` on a `sofa`). Repaired by copying
//     the sales-order line's group onto it. Guarded on `received_qty = 0`:
//     `item_group` feeds the variant key, so a line with goods already received
//     under the old grouping is left for a human.
//
// MODE=plan (default) is READ-ONLY and prints exactly what apply would do.
// MODE=apply needs CONFIRM="REPAIR PO LINKS" and writes ONE column per row —
// `so_item_id` (A) or `item_group` (B). Never qty, never price, never status.
//
// RE-RUN: idempotent and self-narrowing. Every repaired row stops matching its
// own plan query the moment it is written — class A selects `so_item_id is
// null`, class B selects a non-hard-bound `item_group` — so a second apply
// finds nothing to do and reports 0 / 0. A row somebody else has since changed
// is left alone and logged as a ::warning:: rather than overwritten.
//
// AFTER AN APPLY the allocator must re-walk the touched sales orders before the
// screens agree: run the "Recompute SO stock allocation" workflow. This script
// does NOT do it for you and does not claim it did.
//
// ENUM TRAP (house rule): status columns are enums — `::text` before comparing,
// never COALESCE(col,'').
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }

const MODE = (process.env.MODE ?? "plan").toLowerCase();
const CONFIRM = process.env.CONFIRM ?? "";
const COMPANY = String(process.env.COMPANY ?? "1");
const CONFIRM_PHRASE = "REPAIR PO LINKS";

if (MODE !== "plan" && MODE !== "apply") {
  console.error(`MODE must be plan or apply (got "${MODE}")`); process.exit(1);
}
if (MODE === "apply" && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}"`); process.exit(1);
}
/* The rule this repair serves is company-1-only (HARD_BOUND_COMPANY_ID). On any
   other company a pooled purchase order covers the line regardless of the link,
   so there is no defect to repair and a write would be unexplained. */
if (COMPANY !== "1") {
  console.error(`COMPANY must be 1 — the hard-bound rule is company-1 only (got "${COMPANY}")`);
  process.exit(1);
}

const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

/* Ported from scm/lib/so-stock-allocation.ts `isHardBoundLine` — held as one
   SQL predicate so the plan and the engine cannot disagree about which lines
   the rule covers. Change one, change the other. */
const PO_HARD_BOUND = sql`(lower(coalesce(it.item_group,'')) in ('sofa','bedframe')
  or (lower(coalesce(it.item_group,'')) = 'mattress' and it.item_code ~* '\(SP\)\s*$'))`;
const SO_HARD_BOUND = sql`(lower(coalesce(i.item_group,'')) in ('sofa','bedframe')
  or (lower(coalesce(i.item_group,'')) = 'mattress' and i.item_code ~* '\(SP\)\s*$'))`;
/* A cancelled purchase order proves nothing and must never be linked to. */
const PO_ALIVE = sql`p.status::text <> 'CANCELLED'`;

async function planClassA() {
  const rows = await sql`
    with unlinked as (
      select it.id, it.item_code, it.item_group, it.qty, it.received_qty,
             it.warehouse_id, it.variants, p.po_number, p.status::text as po_status
      from scm.purchase_order_items it
      join scm.purchase_orders p on p.id = it.purchase_order_id
      where it.company_id::text = ${COMPANY}
        and it.so_item_id is null
        and ${PO_HARD_BOUND}
        and ${PO_ALIVE}
    ),
    sibling as (
      select u.id,
             (select count(distinct i2.doc_no)
                from scm.purchase_order_items it2
                join scm.purchase_orders p2 on p2.id = it2.purchase_order_id
                join scm.mfg_sales_order_items i2 on i2.id = it2.so_item_id
               where p2.po_number = u.po_number) as sibling_so_count,
             (select min(i2.doc_no)
                from scm.purchase_order_items it2
                join scm.purchase_orders p2 on p2.id = it2.purchase_order_id
                join scm.mfg_sales_order_items i2 on i2.id = it2.so_item_id
               where p2.po_number = u.po_number) as sibling_so
      from unlinked u
    )
    select u.*, s.sibling_so, s.sibling_so_count
    from unlinked u join sibling s on s.id = u.id
    order by u.po_number, u.item_code`;

  const out = [];
  for (const r of rows) {
    const base = {
      poItemId: r.id, poNumber: r.po_number, poStatus: r.po_status,
      itemCode: r.item_code, itemGroup: r.item_group, qty: r.qty,
      receivedQty: r.received_qty, soDocNo: r.sibling_so,
      poVariants: JSON.stringify(r.variants ?? {}),
    };
    if (Number(r.sibling_so_count) !== 1) {
      out.push({ ...base, verdict: "SKIP", reason:
        Number(r.sibling_so_count) === 0
          ? "no other line on this PO is linked to any sales order — nothing proves which order it is for"
          : `this PO's other lines point at ${r.sibling_so_count} different sales orders` });
      continue;
    }
    /* Candidate lines on THAT order: same code, same warehouse, still live, and
       not already covered by a live purchase-order line of their own. */
    const cands = await sql`
      select i.id, i.line_no, i.item_group, i.qty, i.variants
      from scm.mfg_sales_order_items i
      where i.doc_no = ${r.sibling_so}
        and i.item_code = ${r.item_code}
        and i.cancelled = false
        and i.warehouse_id is not distinct from ${r.warehouse_id}
        and not exists (
          select 1 from scm.purchase_order_items x
          join scm.purchase_orders xp on xp.id = x.purchase_order_id
          where x.so_item_id = i.id and xp.status::text <> 'CANCELLED')
      order by i.line_no`;
    if (cands.length !== 1) {
      out.push({ ...base, verdict: "SKIP", reason:
        cands.length === 0
          ? `${r.sibling_so} has no uncovered live line with item code ${r.item_code} in this warehouse (the order was probably amended after the PO was raised)`
          : `${r.sibling_so} has ${cands.length} uncovered lines with item code ${r.item_code} — which one this PO buys cannot be derived` });
      continue;
    }
    const c = cands[0];
    out.push({ ...base, verdict: "REPAIR", soItemId: c.id, soLineNo: c.line_no,
      soVariants: JSON.stringify(c.variants ?? {}),
      variantsAgree: JSON.stringify(r.variants ?? {}) === JSON.stringify(c.variants ?? {}) });
  }
  return out;
}

async function planClassB() {
  const rows = await sql`
    select it.id as po_item_id, p.po_number, p.status::text as po_status,
           it.item_code, it.item_group as po_group, it.qty, it.received_qty,
           i.id as so_item_id, i.doc_no as so_doc_no, i.line_no as so_line_no,
           i.item_group as so_group
    from scm.purchase_order_items it
    join scm.purchase_orders p on p.id = it.purchase_order_id
    join scm.mfg_sales_order_items i on i.id = it.so_item_id
    where it.company_id::text = ${COMPANY}
      and ${PO_ALIVE}
      and i.cancelled = false
      and ${SO_HARD_BOUND}
      and not ${PO_HARD_BOUND}
    order by p.po_number, it.item_code`;
  return rows.map((r) => ({
    poItemId: r.po_item_id, poNumber: r.po_number, poStatus: r.po_status,
    itemCode: r.item_code, fromGroup: r.po_group, toGroup: r.so_group,
    soDocNo: r.so_doc_no, soLineNo: r.so_line_no, qty: r.qty, receivedQty: r.received_qty,
    /* item_group feeds the variant key. Rewriting it under goods already
       received would move the receipt's bucket out from under it. */
    verdict: Number(r.received_qty ?? 0) === 0 ? "REPAIR" : "SKIP",
    reason: Number(r.received_qty ?? 0) === 0 ? null
      : `${r.received_qty} unit(s) already received under item_group "${r.po_group}" — changing the group would move the receipt's variant bucket; needs a human`,
  }));
}

const a = await planClassA();
const b = await planClassB();

console.log("\n=== CLASS A — hard-bound PO lines with no sales-order link ===");
console.log(`${pad("PO", 16)}${pad("ITEM", 18)}${pad("PO ST", 12)}${pad("-> SO", 16)}${pad("LN", 4)}VERDICT / REASON`);
for (const r of a) {
  console.log(`${pad(r.poNumber, 16)}${pad(r.itemCode, 18)}${pad(r.poStatus, 12)}${pad(r.soDocNo ?? "?", 16)}${pad(r.soLineNo ?? "", 4)}${r.verdict}${r.reason ? " — " + r.reason : ""}`);
  if (r.verdict === "REPAIR" && !r.variantsAgree) {
    console.log(`${" ".repeat(66)}note: variants differ — PO ${r.poVariants} vs SO ${r.soVariants}`);
  }
}
console.log("\n=== CLASS B — PO lines whose category is not hard-bound but whose SO line is ===");
console.log(`${pad("PO", 16)}${pad("ITEM", 18)}${pad("GROUP", 22)}${pad("SO", 16)}${pad("LN", 4)}VERDICT / REASON`);
for (const r of b) {
  console.log(`${pad(r.poNumber, 16)}${pad(r.itemCode, 18)}${pad(`${r.fromGroup} -> ${r.toGroup}`, 22)}${pad(r.soDocNo, 16)}${pad(r.soLineNo ?? "", 4)}${r.verdict}${r.reason ? " — " + r.reason : ""}`);
}

const doA = a.filter((r) => r.verdict === "REPAIR");
const doB = b.filter((r) => r.verdict === "REPAIR");
const skips = [...a, ...b].filter((r) => r.verdict === "SKIP");
notice(`plan: ${doA.length} link repair(s), ${doB.length} category repair(s), ${skips.length} left for a human`);

if (MODE === "plan") {
  console.log(`\nPLAN ONLY — nothing was written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
  await sql.end();
  process.exit(0);
}

let wroteA = 0, wroteB = 0;
const touchedSos = new Set();
await sql.begin(async (tx) => {
  for (const r of doA) {
    /* Re-assert the precondition inside the transaction: the plan may have been
       read minutes ago, and a link added since must not be overwritten. */
    const res = await tx`update scm.purchase_order_items
      set so_item_id = ${r.soItemId}
      where id = ${r.poItemId} and so_item_id is null
      returning id`;
    if (res.length === 1) { wroteA += 1; touchedSos.add(r.soDocNo); }
    else console.log(`::warning::${r.poNumber}/${r.itemCode} was linked by someone else since the plan — left alone`);
  }
  for (const r of doB) {
    const res = await tx`update scm.purchase_order_items
      set item_group = ${r.toGroup}
      where id = ${r.poItemId} and item_group = ${r.fromGroup} and coalesce(received_qty,0) = 0
      returning id`;
    if (res.length === 1) { wroteB += 1; touchedSos.add(r.soDocNo); }
    else console.log(`::warning::${r.poNumber}/${r.itemCode} changed since the plan — left alone`);
  }
});

notice(`APPLIED: ${wroteA} link repair(s), ${wroteB} category repair(s) across ${touchedSos.size} sales order(s)`);
console.log(`\nSales orders touched: ${[...touchedSos].sort().join(", ")}`);

/* ── Verification, on a FRESH connection ───────────────────────────────────
   A row count is not a shape. `update ... returning id` reports one row for a
   write that put the WRONG value in the column, and this repair's whole point
   is the value: a link that names some other order's line is worse than no
   link at all — it would make MRP claim a sofa is on order when it is not.
   So this re-opens a new connection (nothing cached, nothing in the
   transaction that just committed) and asserts what the row now SAYS: the
   purchase-order line points at the intended sales-order line, that line is
   live, on the sales order we meant, and both sides finally agree on a
   hard-bound group. Any row that fails is printed and the script exits 1 —
   the write already committed, so the honest outcome is a loud verdict, not a
   silent pass. */
await sql.end();
const verify = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const bad = [];
for (const r of doA) {
  const [row] = await verify`
    select it.so_item_id::text as so_item_id, it.item_group as po_group,
           i.doc_no, i.line_no, i.cancelled, i.item_group as so_group
    from scm.purchase_order_items it
    left join scm.mfg_sales_order_items i on i.id = it.so_item_id
    where it.id = ${r.poItemId}`;
  if (!row || row.so_item_id !== r.soItemId || row.doc_no !== r.soDocNo
      || row.cancelled !== false || String(row.line_no) !== String(r.soLineNo)) {
    bad.push(`A ${r.poNumber}/${r.itemCode}: expected -> ${r.soDocNo} line ${r.soLineNo} (${r.soItemId}), reads ${JSON.stringify(row)}`);
  }
}
for (const r of doB) {
  const [row] = await verify`
    select it.item_group as po_group, coalesce(it.received_qty,0)::int as received,
           i.doc_no, i.item_group as so_group
    from scm.purchase_order_items it
    join scm.mfg_sales_order_items i on i.id = it.so_item_id
    where it.id = ${r.poItemId}`;
  if (!row || row.po_group !== r.toGroup || row.so_group !== r.toGroup || row.doc_no !== r.soDocNo) {
    bad.push(`B ${r.poNumber}/${r.itemCode}: expected group "${r.toGroup}" on ${r.soDocNo}, reads ${JSON.stringify(row)}`);
  }
}
await verify.end();

if (bad.length > 0) {
  console.log("\n=== VERIFICATION FAILED — the write landed but does not read back correctly ===");
  for (const line of bad) console.log(`::error::${line}`);
  console.log(`${bad.length} of ${doA.length + doB.length} repaired row(s) do not match the plan. Investigate before recomputing.`);
  process.exit(1);
}
notice(`verified on a fresh connection: all ${doA.length + doB.length} repaired row(s) read back as planned`);

console.log("\nNOT DONE BY THIS SCRIPT: the allocator has not re-walked these orders.");
console.log('Run the "Recompute SO stock allocation" workflow before reading MRP or the SO screen.');
