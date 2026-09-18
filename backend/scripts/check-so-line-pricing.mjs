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
//      IS an add-on this is where it shows. Each special is TAGGED with the
//      `variants` key it came from, and the line's full key inventory is printed
//      under it — see SPECIAL_KEYS below for the wrong answer that bought both.
//
//   2b. The line's stored Description 2 beside those specials. On a line whose
//      spec has been amended these two are meant to say the same sentence; when
//      they disagree, the printed document disagrees with itself and that is
//      the finding.
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

/** The keys `buildVariantSummary` reads for the SPECIAL segment it prints on
 *  every customer document — backend/src/scm/shared/variant-summary.ts.
 *
 *  This list is COPIED, not imported: the renderer is TypeScript in `src/` and
 *  this script is a dependency-free `.mjs` that runs before any build. So it can
 *  DRIFT, and the drift is not harmless — it already cost a wrong answer.
 *
 *  On 2026-09-10 this probe read `specials` / `customSpecials` /
 *  `specialsRecorded` and reported that HC-SO-012312's two HILTON bedframes no
 *  longer carried "Right Drawer", while their printed Description 2 still said
 *  they did. The renderer reads `variants.specials ?? variants.special`, and
 *  nothing here read the SINGULAR key — so a line storing its add-ons under
 *  `special` showed as clean here and as carrying the drawer on the document.
 *  A probe that reads different keys from the surface it is checking reports a
 *  clean run it has not earned (CLAUDE.md: "a checker that cannot match reports
 *  a clean run"), and here it pointed an investigation at the wrong half.
 *
 *  `specialChoices` is not a special of its own — it annotates a picked code
 *  ("Right Drawer (10\")") — but it is printed below because a choice attached
 *  to a code that is no longer picked is exactly the kind of leftover worth
 *  seeing. */
const SPECIAL_KEYS = ["specials", "special", "customSpecials", "specialsRecorded", "specialChoices"];

const flat = (v) =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
    : typeof v === "string"
      ? [v]
      : [JSON.stringify(v)];

/** The specials on a line, however they were written.
 *
 *  `variants` is jsonb and this family of keys has been through several shapes
 *  (docs/bugs/0053-*, 0018-*), so this reads defensively and says what it found
 *  rather than assuming one. An unreadable shape prints as-is — a probe that
 *  swallowed it would hide the very row worth looking at.
 *
 *  Deliberately a UNION over every key above, including the two the renderer
 *  treats as alternatives (`specials ?? special`). The renderer has to pick one;
 *  a probe must not, because "which key is this line actually using" is the
 *  question being asked. Each value is TAGGED with the key it came from, so two
 *  keys disagreeing reads as a disagreement instead of a longer list. */
function specialsOf(variants) {
  if (variants == null || typeof variants !== "object") return "";
  const out = [];
  for (const key of SPECIAL_KEYS) {
    const v = variants[key];
    if (v == null) continue;
    for (const item of flat(v)) out.push(`${key}=${item}`);
  }
  return out.join(" | ");
}

/** Every key the line's `variants` actually holds.
 *
 *  Printed because the list above can only find what it knows to look for, and
 *  the failure it was written for was a key nobody had listed. Names only, no
 *  values: the values are money, addresses and remarks, and this prints into a
 *  CI log. A key whose name is new to you is the finding — read it with a
 *  targeted query, do not widen this dump. */
const variantKeys = (variants) =>
  variants != null && typeof variants === "object" ? Object.keys(variants).sort().join(", ") : "";

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
      /* description2 on a MIGRATED line started as the AutoCount text, but it is
         not frozen: the direct edit path writes it, and an approved SPEC
         amendment REBUILDS it from `variants`
         (scm/lib/so-revision.ts, the `change === 'SPEC'` branch). So printing it
         beside the specials above is a comparison of two things that are meant
         to say the same sentence — and when they do not, one of them is stale
         and the customer document is contradicting itself. */
      if (l.description2) note(`      book text: ${l.description2}`);
      const keys = variantKeys(l.variants);
      if (keys) note(`      variant keys: ${keys}`);
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
