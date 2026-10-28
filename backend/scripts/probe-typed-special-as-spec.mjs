#!/usr/bin/env node
/* READ-ONLY. If the typed "Custom / other" special order counted as part of the
 * spec, what would move?
 *
 * Owner, 2026-09-14, on MRP handing every custom square pillow the same stock
 * regardless of colour: 「我们的 special order 那边 by typing 的不是也会 under 规格
 * 的嘛？」 then 「只要是有规格的就没问题了啊」.
 *
 * TODAY, traced in code: a TICKED special writes `variants.specials`, which
 * `computeVariantKey` reads (scm/shared/variant-key.ts:135). The TYPED text writes
 * `variants.extraAddonNote`, which no branch reads, and ACCESSORY has no spec
 * attributes at all (ATTRS_BY_GROUP.accessory = []). So every
 * `AMN-SQUARE PILLOW (CUSTOM)` is one stock bucket whatever colour is typed, and
 * MRP allocates PC151-01 stock to a PC151-02 order.
 *
 * The text already rides the chain: the PO line copies `variants` whole
 * (lib/po-convert-line.ts:85) and the receipt keeps the PO line's variants
 * (routes/grns.ts, PR #44). So counting it is a one-line change to the key for NEW
 * documents. What it does to EXISTING ones is the question this answers, before
 * anything is changed:
 *
 *   1. open lines per category that carry typed text, and how many distinct texts;
 *   2. the most common texts per SKU, so a remark that is NOT a spec
 *      ("3 PCS TAKEN", "FOR COMPENSATION…") is visible before it becomes a bucket;
 *   3. on-hand stock for those SKUs by its CURRENT key - stock received before the
 *      change sits in the untyped bucket and would stop covering any typed order;
 *   4. open lines that already have a purchase line or a receipt, whose stock would
 *      have to be re-keyed with them (docs/bugs/0722).
 *
 * Only accessory / mattress / others are measured: those are the categories where
 * the typed text is the spec's only home (memory special-order-text-is-the-home-
 * for-spec). Sofa and bedframe have real spec columns.
 *
 * IT WRITES NOTHING. SELECT only, no DDL, no transaction.
 * RE-RUN: read-only and stateless.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 */
import postgres from 'postgres';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));
const pad = (n, w = 5) => String(n).padStart(w);
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const CATS = ['accessory', 'mattress', 'others'];

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });
try {
  line('='.repeat(78));
  line('TYPED SPECIAL ORDER AS SPEC — what would move (read-only)');
  line('='.repeat(78));

  const rows = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, lower(coalesce(i.item_group,'')) AS grp,
           coalesce(i.qty,0)::numeric AS qty,
           coalesce(i.variants->>'extraAddonNote','') AS note,
           upper(coalesce(h.status::text,'')) AS so_status,
           coalesce(d.shipped,0)::numeric AS shipped,
           (SELECT count(*)::int FROM scm.purchase_order_items p WHERE p.so_item_id = i.id) AS po_lines,
           (SELECT count(*)::int FROM scm.grn_items g
              JOIN scm.purchase_order_items p ON p.id = g.purchase_order_item_id
             WHERE p.so_item_id = i.id) AS grn_lines
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}
      LEFT JOIN (
        SELECT doi.so_item_id, SUM(doi.qty)::numeric AS shipped
          FROM scm.delivery_order_items doi
          JOIN scm.delivery_orders dd ON dd.id = doi.delivery_order_id
         WHERE UPPER(COALESCE(dd.status::text,'')) NOT IN ('DRAFT','CANCELLED')
         GROUP BY doi.so_item_id
      ) d ON d.so_item_id = i.id
     WHERE lower(coalesce(i.item_group,'')) = ANY(${CATS})
       AND coalesce(i.cancelled,false) = false`;

  const open = rows.filter((r) => Number(r.shipped) < Number(r.qty)
    && !['CANCELLED', 'CLOSED', 'COMPLETED', 'DELIVERED'].includes(r.so_status));
  line(`   lines in ${CATS.join('/')}: ${rows.length}   still open (not fully shipped): ${open.length}`);

  rule();
  line('   1. OPEN LINES CARRYING TYPED TEXT');
  line(`   ${'category'.padEnd(12)} ${'open'.padStart(6)} ${'typed'.padStart(6)} ${'distinct'.padStart(9)} ${'w/ PO'.padStart(6)} ${'w/ GR'.padStart(6)}`);
  for (const c of CATS) {
    const o = open.filter((r) => r.grp === c);
    const t = o.filter((r) => norm(r.note));
    line(`   ${c.padEnd(12)} ${pad(o.length, 6)} ${pad(t.length, 6)} ${pad(new Set(t.map((r) => norm(r.note))).size, 9)}`
      + ` ${pad(t.filter((r) => r.po_lines > 0).length, 6)} ${pad(t.filter((r) => r.grn_lines > 0).length, 6)}`);
  }

  rule();
  line('   2. MOST COMMON TYPED TEXTS PER SKU (open lines) — would each become its own bucket');
  const bySku = new Map();
  for (const r of open) {
    if (!norm(r.note)) continue;
    const m = bySku.get(r.item_code) ?? new Map();
    m.set(norm(r.note), (m.get(norm(r.note)) ?? 0) + 1);
    bySku.set(r.item_code, m);
  }
  const skus = [...bySku].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0));
  for (const [sku, m] of skus.slice(0, 12)) {
    const total = [...m.values()].reduce((x, y) => x + y, 0);
    line(`   ${sku}   ${total} typed line(s), ${m.size} distinct`);
    for (const [txt, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 8)) line(`      ${pad(n, 4)}  "${txt}"`);
  }

  rule();
  line('   3. ON-HAND STOCK FOR THOSE SKUs, BY CURRENT KEY');
  line('      stock in the empty key would stop covering ANY typed order once the text counts');
  const skuList = [...bySku.keys()];
  if (skuList.length) {
    const lots = await sql`
      SELECT item_code, coalesce(variant_key,'') AS vk, SUM(qty_remaining)::numeric AS on_hand, count(*)::int AS lots
        FROM scm.inventory_lots
       WHERE company_id = ${CO} AND item_code = ANY(${skuList}) AND qty_remaining > 0
       GROUP BY item_code, coalesce(variant_key,'')
       ORDER BY item_code, on_hand DESC`;
    if (!lots.length) line('      (no on-hand lots)');
    for (const l of lots) line(`      ${String(l.item_code).padEnd(30)} key "${l.vk}"   on hand ${Number(l.on_hand)}   lots ${l.lots}`);
  }

  rule();
  line('READ-ONLY — nothing was written.');
} finally {
  await sql.end({ timeout: 5 });
}
