#!/usr/bin/env node
// Go-live readiness — the three questions the owner asked before switching the
// floor onto the ERP (2026-08-10), answered with numbers rather than opinion:
//
//   A. Is COGS actually complete? (zero-cost stock, uncosted movements,
//      negative/understocked buckets)
//   B. Did every non-sofa product line land, bedframe included?
//   C. WHICH sales orders are ready and which are not — and for the not-ready,
//      WHY. Owner's case: an SO is processed, its PO already became a GRN, the
//      stock is physically in — so it should read READY.
//
// Read-only. SELECT only, no writes.
import postgres from "postgres";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
/* The ONE name of the Processing Date column, spliced as SQL text rather than
   bound as a parameter — see lib/so-processing-date.mjs for why. */
const PDATE = soProcessingDateFragment(sql);
const CO = 1;

async function main() {
  log("═══ A. COGS / cost coverage ═══");
  const [lots] = await sql`SELECT COUNT(*) lots, COUNT(*) FILTER (WHERE unit_cost_sen = 0 OR unit_cost_sen IS NULL) zero,
      COALESCE(SUM(qty_remaining), 0) qty, COALESCE(SUM(qty_remaining) FILTER (WHERE unit_cost_sen = 0 OR unit_cost_sen IS NULL), 0) zero_qty
    FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;
  log(`open FIFO lots: ${lots.lots} (${lots.zero} at zero cost); units on hand: ${lots.qty} (zero-cost: ${lots.zero_qty})`);
  const zeroTop = await sql`SELECT product_code, SUM(qty_remaining)::int q FROM scm.inventory_lots
    WHERE company_id = ${CO} AND qty_remaining > 0 AND (unit_cost_sen = 0 OR unit_cost_sen IS NULL)
    GROUP BY product_code ORDER BY q DESC LIMIT 12`;
  for (const r of zeroTop) log(`   zero-cost: ${r.product_code} x${r.q}`);

  const neg = await sql`SELECT product_code, warehouse_id, variant_key, qty FROM scm.inventory_balances
    WHERE company_id = ${CO} AND qty < 0 ORDER BY qty LIMIT 15`;
  log(`NEGATIVE (understocked) buckets: ${neg.length}${neg.length ? "" : " — none"}`);
  for (const r of neg) log(`   ${r.product_code} [${r.variant_key || "(no variant)"}] qty ${r.qty}`);

  const [mv] = await sql`SELECT COUNT(*) n, COUNT(*) FILTER (WHERE movement_type = 'OUT' AND (total_cost_sen IS NULL OR total_cost_sen = 0)) out_uncosted
    FROM scm.inventory_movements WHERE company_id = ${CO}`;
  log(`movements: ${mv.n}; OUT movements with no cost (would understate COGS): ${mv.out_uncosted}`);

  log("");
  log("═══ B. what stock actually landed ═══");
  // category is an ENUM — cast before defaulting, or Postgres tries to coerce
  // the literal into scm.mfg_product_category and rejects it.
  const grp = await sql`SELECT COALESCE(p.category::text, '(unmapped)') grp,
      COUNT(DISTINCT b.product_code)::int skus, SUM(b.qty)::int units,
      COUNT(*) FILTER (WHERE COALESCE(b.variant_key, '') = '')::int no_variant_rows
    FROM scm.inventory_balances b
    LEFT JOIN scm.mfg_products p ON p.code = b.product_code AND p.company_id = ${CO}
    WHERE b.company_id = ${CO} AND b.qty <> 0 GROUP BY 1 ORDER BY units DESC`;
  for (const r of grp) log(`   ${r.grp}: ${r.skus} SKUs / ${r.units} units (rows with NO variant: ${r.no_variant_rows})`);

  log("");
  log("═══ C. sales-order readiness ═══");
  /* "Processed" = carries a Processing Date, and that date is
     internal_expected_dd — the column the UI writes and the only one
     soProcessingLocked and MRP read. proceeded_at is the IN_PRODUCTION stamp,
     so every readiness number below used to describe a smaller population than
     the screens the owner compares them against. */
  const [hdr] = await sql`SELECT COUNT(*) total,
      COUNT(*) FILTER (WHERE ${PDATE} IS NOT NULL) processed,
      COUNT(*) FILTER (WHERE status = 'READY_TO_SHIP') ready_hdr
    FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  log(`live orders: ${hdr.total}; with a processing date: ${hdr.processed}; header READY_TO_SHIP: ${hdr.ready_hdr}`);

  const byStatus = await sql`SELECT i.stock_status, COUNT(*)::int n FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.${PDATE} IS NOT NULL AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
    GROUP BY 1 ORDER BY n DESC`;
  log(`lines on PROCESSED orders, by stock status: ${byStatus.map((r) => `${r.stock_status ?? "(null)"}=${r.n}`).join(", ")}`);

  /* The owner's exact case: line is PENDING, but the PO raised for it has been
     received. Either the goods are sitting in a bucket the allocator cannot
     match (variant/warehouse), or the allocation simply has not re-run. This
     is the list to act on. */
  const stuck = await sql`
    SELECT h.doc_no, i.item_code, i.item_group, i.qty, i.stock_status,
           COALESCE(i.variants->>'colourId', '') colour,
           po.po_number, poi.qty po_qty, poi.received_qty,
           (SELECT COALESCE(SUM(b.qty), 0) FROM scm.inventory_balances b
              WHERE b.company_id = ${CO} AND b.product_code = i.item_code) onhand_any_variant
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE h.company_id = ${CO} AND h.${PDATE} IS NOT NULL
      AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND COALESCE(poi.received_qty,0) > 0
      AND i.stock_status <> 'READY'
    ORDER BY h.doc_no LIMIT 40`;
  log(`PROCESSED lines whose dedicated PO is (partly) RECEIVED but line is not READY: ${stuck.length}`);
  for (const r of stuck) {
    log(`   ${r.doc_no} ${r.item_code} [${r.item_group}] qty${r.qty} ${r.stock_status} | PO ${r.po_number} recv ${r.received_qty}/${r.po_qty} | on hand (any variant): ${r.onhand_any_variant} | colour ${r.colour || "-"}`);
  }

  /* Why a bedframe line can look short while the stock is physically there:
     the AutoCount stock snapshot carries NO variant, so it landed under the
     blank variant_key, while SO bedframe lines carry a colour/height variant.
     The allocator matches warehouse+code+variant_key, so the two never meet.
     Quantify it before deciding the fix. */
  const bfMismatch = await sql`
    WITH bf_need AS (
      SELECT i.item_code, COUNT(*)::int lines, SUM(i.qty)::int need
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = ${CO} AND h.${PDATE} IS NOT NULL AND i.item_group = 'bedframe'
        AND COALESCE(i.cancelled,false) = false AND i.stock_status <> 'READY'
        AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      GROUP BY 1
    )
    SELECT n.item_code, n.lines, n.need,
      COALESCE((SELECT SUM(b.qty) FROM scm.inventory_balances b
                WHERE b.company_id = ${CO} AND b.product_code = n.item_code AND COALESCE(b.variant_key,'') = ''), 0)::int blank_variant_stock,
      COALESCE((SELECT SUM(b.qty) FROM scm.inventory_balances b
                WHERE b.company_id = ${CO} AND b.product_code = n.item_code AND COALESCE(b.variant_key,'') <> ''), 0)::int variant_stock
    FROM bf_need n WHERE EXISTS (SELECT 1 FROM scm.inventory_balances b
       WHERE b.company_id = ${CO} AND b.product_code = n.item_code AND b.qty > 0)
    ORDER BY n.need DESC LIMIT 25`;
  log(`bedframe SKUs wanted by not-ready lines that DO have stock on hand: ${bfMismatch.length}`);
  for (const r of bfMismatch) {
    log(`   ${r.item_code}: need ${r.need} over ${r.lines} lines | stock blank-variant ${r.blank_variant_stock}, with-variant ${r.variant_stock}`);
  }

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
