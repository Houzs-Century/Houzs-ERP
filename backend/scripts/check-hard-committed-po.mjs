// READ-ONLY. Sizes the ship-before-arrival binding, in three parts.
//
// Shipping before the goods land writes a negative OUT. When it is bound to the
// incoming PO's batch AND the DO is flagged is_dropship, fn_reconcile_dropship_batch
// nets it on receipt. Two things can go wrong, and this counts both:
//
//   (A) STRANDED — an unconsumed OUT that the reconcile can NEVER claim, because
//       the DO is not flagged is_dropship or the movement carries no batch_no.
//       These sit at RM0 cost forever (the plain "Ship anyway" path).
//   (B) DOUBLE-PROMISED — mrp.ts:502 computes incoming supply as
//       (qty - received_qty) with NO deduction for units already hard-committed
//       to an outstanding drop-ship OUT. So the same undelivered PO units can be
//       offered to a second SO, which gets nothing when the goods land and the
//       reconcile nets the first shipment instead.
// NOTE: status/currency columns in this schema are ENUMS, not text. COALESCE(col,'')
// tries to coerce '' INTO the enum and fails with "invalid input value for enum".
// Always ::text BEFORE any string function — the same trap that had
// check-foreign-rate-one.mjs silently dead until 2026-07-30.
import postgres from "postgres";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

async function main() {
  notice("=== HARD-COMMITTED PO / SHIP-BEFORE-ARRIVAL DETECTOR — READ-ONLY ===");

  // Every OUT still short of its consume — the unfulfilled part of a shipment.
  const outs = await sql`
    SELECT m.id, m.source_doc_no, m.product_code, m.variant_key, m.batch_no,
           m.warehouse_id, ABS(m.qty) AS out_qty, m.created_at,
           d.is_dropship, UPPER(COALESCE(d.status::text,'')) AS do_status,
           COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c
                      WHERE c.movement_id = m.id), 0) AS consumed
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.movement_type = 'OUT' AND m.source_doc_type = 'DO'
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
     ORDER BY m.created_at`;
  const short = outs.filter((r) => Number(r.out_qty) - Number(r.consumed) > 0);

  notice("================ (A) SHORT OUTs — can the receipt reconcile ever claim them? ================");
  const claimable = short.filter((r) => r.is_dropship === true && r.batch_no);
  const strandedNoFlag = short.filter((r) => r.is_dropship !== true);
  const strandedNoBatch = short.filter((r) => r.is_dropship === true && !r.batch_no);
  const units = (a) => a.reduce((s, r) => s + (Number(r.out_qty) - Number(r.consumed)), 0);
  notice(`  short OUTs total                         : ${short.length}  (${units(short)} units)`);
  notice(`   - CLAIMABLE (is_dropship + batch_no)     : ${claimable.length}  (${units(claimable)} units)  -> nets on receipt`);
  notice(`   - STRANDED, DO not flagged is_dropship   : ${strandedNoFlag.length}  (${units(strandedNoFlag)} units)  -> reconcile SKIPS these forever`);
  notice(`   - STRANDED, flagged but NO batch_no      : ${strandedNoBatch.length}  (${units(strandedNoBatch)} units)  -> reconcile matches on batch_no, so also never`);
  for (const r of [...strandedNoFlag, ...strandedNoBatch].slice(0, 25)) {
    notice(`    ${pad(r.source_doc_no, 20)} ${pad(r.product_code, 22)} ${pad(r.variant_key, 12)} batch=${pad(r.batch_no ?? "(none)", 14)} dropship=${r.is_dropship === true ? "Y" : "N"} short=${Number(r.out_qty) - Number(r.consumed)} ${String(r.created_at).slice(0, 10)}`);
  }

  // (B) the double-promise: claimable commitments vs what MRP still offers.
  notice("================ (B) DOUBLE-PROMISED PO SUPPLY — MRP offers what is already committed ================");
  notice("  mrp.ts computes incoming supply as (qty - received_qty). A unit already");
  notice("  hard-committed to an outstanding drop-ship OUT is still inside that figure.");
  if (!claimable.length) notice("  no outstanding claimable commitments — nothing is double-promised right now.");
  else {
    const rows = await sql`
      SELECT poi.material_code, poi.variants, poi.qty, poi.received_qty,
             po.po_number, UPPER(COALESCE(po.status::text,'')) AS po_status
        FROM scm.purchase_order_items poi
        JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
       WHERE UPPER(COALESCE(po.status::text,'')) NOT IN ('CANCELLED','DRAFT')
         AND (poi.qty - COALESCE(poi.received_qty,0)) > 0
         AND poi.material_code IN ${sql([...new Set(claimable.map((r) => r.product_code))])}`;
    notice(`  open PO lines for the committed SKUs      : ${rows.length}`);
    const committedBySku = new Map();
    for (const r of claimable) committedBySku.set(r.product_code, (committedBySku.get(r.product_code) ?? 0) + (Number(r.out_qty) - Number(r.consumed)));
    notice(`    ${pad("SKU", 24)} ${pad("committed", 10)} ${pad("PO", 20)} ${pad("openLeft", 9)} status`);
    for (const r of rows.slice(0, 30)) {
      const c = committedBySku.get(r.material_code) ?? 0;
      const left = Number(r.qty) - Number(r.received_qty ?? 0);
      notice(`    ${pad(r.material_code, 24)} ${pad(c, 10)} ${pad(r.po_number, 20)} ${pad(left, 9)} ${r.po_status}${c > 0 ? "   <- MRP still offers these open units" : ""}`);
    }
    notice("  ^ where 'committed' > 0 for a SKU, that many of the open units are already");
    notice("    spoken for. MRP does not know, so it can promise them to another SO.");
  }

  // (C) the link that decides which path a shipment can take at all.
  notice("================ (C) SO->PO LINK COVERAGE (so_item_id) ================");
  const [{ total, linked }] = await sql`
    SELECT COUNT(*)::int AS total, COUNT(so_item_id)::int AS linked
      FROM scm.purchase_order_items`;
  notice(`  purchase_order_items rows                 : ${total}`);
  notice(`   - with so_item_id set (drop-ship capable) : ${linked}`);
  notice(`   - NULL (can only ever ship-anyway)        : ${total - linked}`);
  notice("=== END — read-only, no rows changed. ===");
}
main().then(() => sql.end()).catch((e) => { console.error("HARD_COMMITTED_PO_FAIL", e?.message ?? e); process.exit(1); });
