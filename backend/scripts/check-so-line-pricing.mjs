// Read-only probe: WHERE does one Sales Order's money come from, line by line?
//
// Owner 2026-09-09, on HC-SO-012312 (salesperson Cheah Huan): 「本来 order 床架
// 就是 3 个，只是 orig 是 trion x1, bedframe kiv x2，现在拆开了 多出 rm250」.
// One line came back at RM 250 while the two above it read FOC / RM 0.
//
// The screenshot alone cannot settle it, and two facts on it point AWAY from the
// obvious story: the RM 250 line carries FEWER specials than the two free ones,
// and its UOM is UNIT where theirs is SET. So "the add-ons were charged" is a
// hypothesis, not the answer, and this probe exists to refute or confirm it
// against the row rather than reason from a picture.
//
// WHAT IT PRINTS, for the ONE order named in DOC_NO, and nothing else:
//
//   1. The header's own money columns, including the fee/addon buckets that are
//      NOT line-derived — `fabric_tier_addon_sen` and `delivery_fee_sen` are the
//      two that can put money on an order without any line saying so.
//
//   2. Every line: item code, group, UOM, qty, unit price, discount, line total,
//      cost, cancelled flag — and its SPECIALS, read out of `variants`. The
//      specials are the reason this probe exists: they travel with the variant
//      cascade (docs/bugs/0754-*) and some of them are priced, so if the RM 250
//      IS an add-on this is where it shows.
//
//   3. A reconciliation line: the sum of the lines against the header total, so
//      "the money is not on any line" is a visible answer rather than an
//      inference. That is the shape that would point at a header bucket.
//
// It answers WHERE the money is. It does not answer whether that is correct —
// that is a business call, and a probe that tried to make it would be inventing
// a pricing rule to check the pricing rule against.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — including "no such order", which is a finding — so a red
// job always means the check itself broke. Manual dispatch, own concurrency
// group, never on a schedule.
//
// RE-RUN: safe and free. It reads and prints; running it twice changes nothing.
//
// `status` and `uom` are ENUM-ish columns in this schema, so nothing here
// coerces them through `COALESCE(col, '')` — that idiom asks Postgres to cast ''
// into a type with no such member and dies at execution, which is exactly how
// the sibling probe failed its first dispatch (docs/bugs/0754 in the holders
// series, run 34334122124). Values are read out and formatted in JS instead.
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars. */
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const note = (s) => console.log(`::notice::${s}`);
const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
const num = (s, n) => String(s ?? "").padStart(n);
/* Money is stored in SEN. Print ringgit so the owner reads the same number the
   screen shows him, and keep the raw sen beside the totals for arithmetic. */
const rm = (sen) => (Number(sen ?? 0) / 100).toFixed(2);

/** The specials on a line, however they were written.
 *
 *  `variants` is jsonb and this family of keys has been through several shapes
 *  (docs/bugs/0053-*, 0018-*), so this reads defensively and says what it found
 *  rather than assuming one. An unreadable shape prints as-is — a probe that
 *  swallowed it would hide the very row worth looking at. */
function specialsOf(variants) {
  if (variants == null || typeof variants !== "object") return "";
  const out = [];
  for (const key of ["specials", "customSpecials", "specialsRecorded"]) {
    const v = variants[key];
    if (v == null) continue;
    if (Array.isArray(v)) out.push(...v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))));
    else if (typeof v === "string") out.push(v);
    else out.push(JSON.stringify(v));
  }
  return out.join(" + ");
}

async function main() {
  const docNo = (process.env.DOC_NO ?? "").trim();
  if (!docNo) {
    console.error("Set DOC_NO to the Sales Order to inspect, e.g. DOC_NO=HC-SO-012312.");
    process.exit(1);
  }
  const url = resolveUrl();
  if (!url) {
    console.error("No DATABASE_URL (env or backend/.dev.vars). Cannot answer.");
    process.exit(1);
  }
  const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

  try {
    const [h] = await sql`
      SELECT doc_no, company_id, status, debtor_name, agent, salesperson_id,
             local_total_sen, subtotal_sen, balance_sen, deposit_sen, paid_sen,
             fabric_tier_addon_sen, delivery_fee_sen,
             mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen,
             line_count, linked_ac_docno
        FROM scm.mfg_sales_orders
       WHERE doc_no = ${docNo}`;

    if (!h) {
      /* A finding, not a failure. Exit 0 — see the header. */
      note(`No Sales Order ${docNo} in this database.`);
      return;
    }

    note(`${h.doc_no} — company ${h.company_id}, status ${h.status ?? "-"}, customer ${h.debtor_name ?? "-"}`);
    note(`  migrated from AutoCount: ${h.linked_ac_docno ? `yes (${h.linked_ac_docno})` : "no"}`);
    note(`  HEADER MONEY  total RM ${rm(h.local_total_sen)}  subtotal RM ${rm(h.subtotal_sen)}  deposit RM ${rm(h.deposit_sen)}  paid RM ${rm(h.paid_sen)}`);
    note(`  HEADER BUCKETS that no line has to explain:  fabric tier add-on RM ${rm(h.fabric_tier_addon_sen)}   delivery fee RM ${rm(h.delivery_fee_sen)}`);
    note(`  BY CATEGORY  mattress/sofa RM ${rm(h.mattress_sofa_sen)}  bedframe RM ${rm(h.bedframe_sen)}  accessories RM ${rm(h.accessories_sen)}  service RM ${rm(h.service_sen)}  others RM ${rm(h.others_sen)}`);

    const lines = await sql`
      SELECT id, item_code, item_group, uom, qty, unit_price_sen, discount_sen,
             total_sen, unit_cost_sen, cancelled, description2, variants
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${docNo}
       ORDER BY line_no NULLS LAST, created_at`;

    note(`---- ${lines.length} line(s) ----`);
    note(`  ${pad("ITEM", 22)}${pad("GROUP", 10)}${pad("UOM", 6)}${num("QTY", 5)}${num("UNIT", 10)}${num("DISC", 9)}${num("TOTAL", 10)}  ${pad("CANC", 5)}SPECIALS`);
    let lineSum = 0;
    for (const l of lines) {
      if (!l.cancelled) lineSum += Number(l.total_sen ?? 0);
      note(
        `  ${pad(l.item_code, 22)}${pad(l.item_group, 10)}${pad(l.uom, 6)}${num(l.qty, 5)}` +
        `${num(rm(l.unit_price_sen), 10)}${num(rm(l.discount_sen), 9)}${num(rm(l.total_sen), 10)}  ` +
        `${pad(l.cancelled ? "YES" : "", 5)}${specialsOf(l.variants)}`,
      );
      /* description2 is the AutoCount text — on a migrated order it is what the
         account book itself says this line is, which is the only independent
         opinion available here. */
      if (l.description2) note(`      book text: ${l.description2}`);
    }

    const headerTotal = Number(h.local_total_sen ?? 0);
    const gap = headerTotal - lineSum;
    note(`---- reconciliation ----`);
    note(`  lines (excluding cancelled) RM ${rm(lineSum)}   header total RM ${rm(headerTotal)}   difference RM ${rm(gap)}`);
    note(
      gap === 0
        ? "  The header total is exactly the lines. Any surprise charge is ON a line above."
        : "  The header total is NOT the sum of the lines — look at the HEADER BUCKETS line: money can arrive as a fabric-tier add-on or a delivery fee without any line naming it.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(`check-so-line-pricing failed: ${e?.message ?? e}`);
  process.exit(1);
});
