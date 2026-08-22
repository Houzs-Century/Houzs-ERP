#!/usr/bin/env node
/* Read-only: how much stock is sitting in the WRONG bucket because its line's
   category was blank, and how much sofa stock can never be allocated because it
   carries no batch number?

   WHY. Owner 2026-08-22, walking the real UI: a sofa received minutes earlier
   showed stock 1, available 0, the variant row reading "Standard", and the
   delivery order refused it as short. Traced (docs/bugs/0514): `item_group` is
   an INPUT TO THE STOCK BUCKET — `computeVariantKey` composes a sofa's fabric /
   seat / leg ONLY for a sofa or bedframe group, so a line that reached the
   database with a blank or `others` group keys its stock with the PRODUCT CODE
   ALONE. The goods are in the warehouse, at the right value, with their
   `variants` jsonb fully intact, and invisible to every sofa order.
   The write paths are fixed. THE ROWS ALREADY WRITTEN ARE NOT, and the owner's
   instruction was explicit: measure first, then he decides. This probe is the
   measurement. It moves nothing.

   ── THE QUESTION IT ASKS, AND WHY IT IS THE RIGHT ONE ─────────────────────
   Not "does this line look like a sofa" — that is a guess dressed as a rule.
   It asks the only question that decides anything:

       WOULD THIS LINE KEY DIFFERENTLY IF ITS GROUP WERE RIGHT?

   i.e. `computeVariantKey(storedGroup, variants)` vs
        `computeVariantKey(masterCategory, variants)`

   where masterCategory is `mfg_products.category` — the SKU's own answer, which
   is what the fixed write paths now use. Both sides come from the REAL function
   imported out of src/, never a restatement of it: a probe that re-implements
   the rule it is measuring can only ever confirm itself.

   A line whose two keys agree is fine, whatever its group says. A line whose
   keys DIFFER is stock the system cannot find.

   ── THE SECOND, SEPARATE POPULATION ──────────────────────────────────────
   Sofa allocation reads ONLY lots carrying a batch_no
   (`sofa-set-coverage.ts:65`), and a batch_no is stamped at GRN only when the
   receipt line links to a purchase-order line (`grns.ts:565`). So a sofa
   received WITHOUT that link has no batch number, and both the allocator AND
   the delivery-order guard refuse it — it is not mis-bucketed, it is
   un-allocatable. Different cause, different repair, counted separately.

   ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
   · It changes nothing. SELECTs only.
   · It does not decide the repair. Re-keying in place and a compensating
     adjustment pair are different trades with different audit consequences;
     that is the owner's call and it needs these numbers first.
   · It does not judge a line with no variants at all. A genuine accessory with
     a blank group keys identically either way and is not counted.

   Read-only: SELECTs only. No DDL, no writes, no transaction, no lock. Exits 0
   for every legitimate answer, including zero findings; non-zero only if the
   database could not answer, or if a section could not be read at all. */
import postgres from "postgres";
import { computeVariantKey } from "../src/scm/shared/variant-key.ts";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — the database cannot be asked. Nothing was measured.");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;

const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);
const money = (sen) => `RM ${(Number(sen ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const why = (e) => {
  const m = String(e?.message ?? "").trim();
  return (m || e?.name || "unknown error") + (e?.code ? ` [${e.code}]` : "");
};

let sectionsMeasured = 0;
const TOTAL_SECTIONS = 3;

/* The document line tables that feed a stock movement, with the column that
   holds the category. Kept explicit rather than derived: this list is the
   probe's SCOPE and a reader must be able to see it without running anything. */
const LINE_TABLES = [
  { label: "销售单 Sales order",     table: "mfg_sales_order_items" },
  { label: "采购单 Purchase order",  table: "purchase_order_items" },
  { label: "收货单 Goods receipt",   table: "grn_items" },
  { label: "送货单 Delivery order",  table: "delivery_order_items" },
  { label: "寄售单 Consignment",     table: "consignment_order_items" },
];

async function main() {
  note("=== 进错桶的库存 — 只读普查 ===");
  note(`scope: ${CO == null ? "两家公司" : `company ${CO}`}`);
  note("");

  /* ── 0. RAW CENSUS ───────────────────────────────────────────────────────
     No predicate at all. A filtered number is only worth reading next to the
     unfiltered one — a probe that reports "0 affected" over a table it could
     not read looks exactly like a clean bill of health. */
  note("── 每张表总共几行（不带任何条件）──");
  for (const t of LINE_TABLES) {
    try {
      const [r] = await sql`SELECT COUNT(*) AS n FROM scm.${sql(t.table)}`;
      note(`   ${pad(t.label, 26)}${rpad(r.n, 9)} 行`);
    } catch (e) {
      note(`   ${pad(t.label, 26)}读不到 — ${why(e).slice(0, 90)}`);
    }
  }
  note("");

  /* ── 1. LINES WHOSE KEY WOULD CHANGE ─────────────────────────────────────
     The whole question, asked with the real function on both sides. */
  note("── 第一类：类别错了，钥匙就错了 ──");
  note("   问的是：这一行如果类别是对的，钥匙会不会不一样？");
  note("");
  const perTable = [];
  for (const t of LINE_TABLES) {
    try {
      const rows = await sql`
        SELECT i.item_code,
               i.item_group,
               i.variants,
               p.category AS master_category
          FROM scm.${sql(t.table)} i
          JOIN scm.mfg_products p
            ON p.code = i.item_code
           AND (${CO}::int IS NULL OR p.company_id = ${CO}::int)
         WHERE i.variants IS NOT NULL
           AND (${CO}::int IS NULL OR i.company_id = ${CO}::int)
      `;
      let checked = 0;
      let wrong = 0;
      const byCode = new Map();
      for (const r of rows) {
        const variants = r.variants ?? null;
        if (!variants || Object.keys(variants).length === 0) continue;
        checked++;
        const stored = computeVariantKey(r.item_group ?? null, variants);
        const master = computeVariantKey(r.master_category ?? null, variants);
        if (stored === master) continue;
        wrong++;
        const k = `${r.item_code}::${r.item_group ?? "(空白)"}`;
        byCode.set(k, (byCode.get(k) ?? 0) + 1);
      }
      perTable.push({ label: t.label, checked, wrong, byCode });
      note(`   ${pad(t.label, 26)}${rpad(wrong, 7)} / ${checked} 行带规格的行，钥匙会变`);
      for (const [k, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        const [code, grp] = k.split("::");
        note(`        ${pad(code, 24)}存的类别 ${pad(grp, 12)}${rpad(n, 6)} 行`);
      }
    } catch (e) {
      perTable.push({ label: t.label, unreadable: true });
      note(`   ${pad(t.label, 26)}读不到 — ${why(e).slice(0, 90)}`);
    }
  }
  if (perTable.some((x) => !x.unreadable)) sectionsMeasured++;
  note("");

  /* ── 2. THE MONEY ────────────────────────────────────────────────────────
     Lines are the cause; STOCK is what it costs. Only OPEN lots count — a lot
     already consumed is history, not money standing in a warehouse nobody can
     reach. */
  note("── 第二类：现在还站在仓库里、拿不到的货 ──");
  try {
    const lots = await sql`
      SELECT l.item_code,
             l.variant_key,
             l.warehouse_id,
             l.qty_remaining,
             l.remaining_value_sen,
             l.batch_no,
             p.category AS master_category
        FROM scm.v_inventory_lots_open l
        JOIN scm.mfg_products p
          ON p.code = l.item_code
         AND (${CO}::int IS NULL OR p.company_id = ${CO}::int)
       WHERE COALESCE(l.qty_remaining, 0) > 0
         AND COALESCE(l.variant_key, '') = ''
         AND LOWER(COALESCE(p.category, '')) IN ('sofa', 'bedframe')
    `;
    let qty = 0;
    let valueSen = 0;
    const byCode = new Map();
    for (const r of lots) {
      const q = Number(r.qty_remaining ?? 0);
      const v = Number(r.remaining_value_sen ?? 0);
      qty += q; valueSen += v;
      const cur = byCode.get(r.item_code) ?? { qty: 0, valueSen: 0, cat: r.master_category };
      cur.qty += q; cur.valueSen += v;
      byCode.set(r.item_code, cur);
    }
    sectionsMeasured++;
    note(`   沙发／床架的货，钥匙是空的：${rpad(qty, 7)} 件   ${money(valueSen)}`);
    note(`   （产品主档说它是沙发或床架，可是库存里它没有规格）`);
    if (byCode.size) {
      note("");
      note(`   ${pad("料号", 26)}${pad("主档类别", 12)}${rpad("件", 7)}   金额`);
      for (const [code, x] of [...byCode.entries()].sort((a, b) => b[1].valueSen - a[1].valueSen).slice(0, 20)) {
        note(`   ${pad(code, 26)}${pad(x.cat ?? "", 12)}${rpad(x.qty, 7)}   ${money(x.valueSen)}`);
      }
      if (byCode.size > 20) note(`   … 另外 ${byCode.size - 20} 个料号没印出来（没有漏掉，只是没印）`);
    }
  } catch (e) {
    note(`   读不到 — ${why(e).slice(0, 120)}`);
    note("   这一节没有量到，不要当成「没有问题」。");
  }
  note("");

  /* ── 3. THE OTHER POPULATION: sofa lots with no batch ─────────────────────
     Different cause, different repair. A sofa lot with no batch_no is not in
     the wrong bucket — it is in the right one and still unusable, because both
     the allocator and the DO guard read only batched lots. */
  note("── 第三类：沙发有货、但没有批号 ──");
  try {
    const rows = await sql`
      SELECT l.item_code,
             SUM(COALESCE(l.qty_remaining, 0))        AS qty,
             SUM(COALESCE(l.remaining_value_sen, 0))  AS value_sen
        FROM scm.v_inventory_lots_open l
        JOIN scm.mfg_products p
          ON p.code = l.item_code
         AND (${CO}::int IS NULL OR p.company_id = ${CO}::int)
       WHERE COALESCE(l.qty_remaining, 0) > 0
         AND l.batch_no IS NULL
         AND LOWER(COALESCE(p.category, '')) = 'sofa'
       GROUP BY l.item_code
       ORDER BY 3 DESC
    `;
    sectionsMeasured++;
    const qty = rows.reduce((n, r) => n + Number(r.qty ?? 0), 0);
    const val = rows.reduce((n, r) => n + Number(r.value_sen ?? 0), 0);
    note(`   没有批号的沙发：${rpad(qty, 7)} 件   ${money(val)}   （${rows.length} 个料号）`);
    note("   沙发的分配和出货都只看有批号的批次，所以这批货两边都动不了。");
    note("   批号只有在收货行接到采购单行的时候才盖得上去。");
    for (const r of rows.slice(0, 15)) {
      note(`   ${pad(r.item_code, 26)}${rpad(r.qty, 7)}   ${money(r.value_sen)}`);
    }
    if (rows.length > 15) note(`   … 另外 ${rows.length - 15} 个料号没印出来`);
  } catch (e) {
    note(`   读不到 — ${why(e).slice(0, 120)}`);
    note("   这一节没有量到，不要当成「没有问题」。");
  }
  note("");

  note("=== 完 — 只读，什么都没有改 ===");
  note("");
  note("第一类和第二类是同一个病：类别空掉 → 钥匙只剩料号 → 货进错桶。");
  note("第三类是另一个病：沙发没接到采购单 → 没批号 → 分配和出货都拿不到。");
  note("两种要怎么补，是老板的决定 —— 这支脚本只负责给数字。");

  if (sectionsMeasured < TOTAL_SECTIONS) {
    console.error(`Only ${sectionsMeasured} of ${TOTAL_SECTIONS} sections could be read. This is NOT a clean result.`);
    process.exitCode = 1;
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error(e);
    try { await sql.end(); } catch { /* connection already gone */ }
    process.exit(1);
  });
