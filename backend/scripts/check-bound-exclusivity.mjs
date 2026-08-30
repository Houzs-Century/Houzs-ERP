#!/usr/bin/env node
/* check-bound-exclusivity — is the owner's Company-1 hard-binding rule actually
 * HELD by the data? (owner 2026-08-30: "他明明都没有 PO,怎么会 ready 呢?
 * 它一定是根据 PO…Company 1 跟 Company 2 机制是不一样的").
 *
 * The rule (owner 2026-08-10 + 2026-08-29 + 2026-08-30): company 1 bedframe /
 * sofa / (SP) special-order mattress lines light ONLY from their own received
 * purchase order, per line, partial receipt = partial READY. Company 2 (2990)
 * pools. The engine today runs ONE mechanism for both companies and lets an
 * un-receipted bound line fall through to the pooled walk — this check measures
 * whether that fall-through ever actually FIRES in production.
 *
 * READ-ONLY, one connection, SELECTs only. Exit 0 for every legitimate answer.
 * RE-RUN: answers again from current state.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });

// the engine's own out-of-scope set (src/scm/shared/so-terminal-states.ts)
const TERMINAL = ["CANCELLED", "CLOSED", "SHIPPED", "DELIVERED", "INVOICED", "DRAFT"];
const isSp = (code) => /\(SP\)\s*$/i.test(code ?? "");
const isBound = (g, code) => ["bedframe", "sofa"].includes((g ?? "").toLowerCase()) || ((g ?? "").toLowerCase() === "mattress" && isSp(code));

// vocabulary census first — the filter below is only as good as these values
const vocab = await sql`
  SELECT h.company_id, lower(coalesce(i.item_group,'(null)')) AS g, count(*)::int AS n
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE i.cancelled = false AND h.status NOT IN ${sql(TERMINAL)}
   GROUP BY 1, 2 ORDER BY 1, 3 DESC`;
console.log("live-line item_group vocabulary:");
for (const v of vocab) console.log(`  co${v.company_id} ${v.g}: ${v.n}`);

// every live line of the bound groups, both companies
const lines = await sql`
  SELECT i.id, i.doc_no, h.company_id, i.item_code, i.item_group, i.qty,
         i.stock_status, i.stock_qty_ready, i.allocated_batch_no, i.variants,
         i.warehouse_id, h.processing_date
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE i.cancelled = false
     AND h.status NOT IN ${sql(TERMINAL)}
     AND (lower(i.item_group) IN ('bedframe','sofa')
          OR (lower(i.item_group) = 'mattress' AND i.item_code ~* '\\(SP\\)\\s*$'))`;

// their dedications, with receipt + the PO's ship-to warehouse
const ded = await sql`
  SELECT i.so_item_id, i.qty, i.received_qty, p.po_number, p.purchase_location_id
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
   WHERE i.so_item_id IS NOT NULL AND p.status <> 'CANCELLED'`;
const dedByLine = new Map();
for (const d of ded) {
  if (!dedByLine.has(d.so_item_id)) dedByLine.set(d.so_item_id, []);
  dedByLine.get(d.so_item_id).push(d);
}

const blankVariant = (v) => {
  if (v == null) return true;
  const o = typeof v === "string" ? JSON.parse(v || "{}") : v;
  return !Object.entries(o).some(([k, val]) => k !== "specials" && val != null && val !== "" && (!Array.isArray(val) || val.length));
};

for (const co of [1, 2]) {
  const mine = lines.filter((l) => Number(l.company_id) === co && isBound(l.item_group, l.item_code));
  const lit = mine.filter((l) => ["READY", "PARTIAL"].includes((l.stock_status ?? "").toUpperCase()));
  let okReceipt = 0, okBatch = 0, litNoReceipt = [], litNoPo = [], whMismatch = 0;
  for (const l of lit) {
    const ds = dedByLine.get(l.id) ?? [];
    const received = ds.reduce((s, d) => s + Number(d.received_qty ?? 0), 0);
    if (received > 0) {
      okReceipt += 1;
      if (ds.some((d) => d.purchase_location_id && l.warehouse_id && d.purchase_location_id !== l.warehouse_id)) whMismatch += 1;
    } else if ((l.item_group ?? "").toLowerCase() === "sofa" && l.allocated_batch_no) {
      okBatch += 1; // the sofa batch pass — the batch IS a receipt lot
    } else if (ds.length) {
      litNoReceipt.push(l);
    } else {
      litNoPo.push(l);
    }
  }
  console.log(`\n=== company ${co} — bound groups (bedframe / sofa / (SP) mattress) ===`);
  console.log(`live lines: ${mine.length}; lit (READY/PARTIAL): ${lit.length}`);
  console.log(`  lit via own received PO: ${okReceipt} (dedication PO ship-to differs from line warehouse on ${whMismatch})`);
  console.log(`  lit via sofa batch:      ${okBatch}`);
  console.log(`  LIT, dedication exists but NOTHING RECEIVED: ${litNoReceipt.length}${co === 1 ? "  <-- must be 0 under hard binding" : "  (pooled company - informational)"}`);
  for (const l of litNoReceipt.slice(0, 15)) console.log(`     ${l.doc_no} ${l.item_code} wh=${l.warehouse_id ?? "-"} status=${l.stock_status} variant=${blankVariant(l.variants) ? "BLANK" : "typed"} pdate=${l.processing_date ? "yes" : "NO"}`);
  console.log(`  LIT WITH NO PO AT ALL: ${litNoPo.length}${co === 1 ? "  <-- must be 0 under hard binding" : "  (pooled company - informational)"}`);
  for (const l of litNoPo.slice(0, 20)) console.log(`     ${l.doc_no} ${l.item_code} wh=${l.warehouse_id ?? "-"} status=${l.stock_status} qty_ready=${l.stock_qty_ready} variant=${blankVariant(l.variants) ? "BLANK" : "typed"} pdate=${l.processing_date ? "yes" : "NO"}`);
}
console.log(`\nMechanism note (code fact): the engine's bound pass has NO company filter, and a bound line with no receipt FALLS THROUGH to the pooled walk for BOTH companies — any company-1 rows listed above are that fall-through firing.`);
await sql.end();
