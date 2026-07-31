// READ-ONLY. Sizes the ship-before-arrival binding, in three parts.
//
// Shipping before the goods land writes a negative OUT. When the receipt-time
// reconcile (scm.fn_reconcile_dropship_batch) can CLAIM that OUT, it nets it and
// stamps the real cost on it. Two things can go wrong, and this counts both:
//
//   (A) STRANDED — an unconsumed OUT the reconcile can NEVER claim, because it
//       carries no batch_no, or because neither claim signal is present. These
//       sit at RM0 cost until some other stock-IN happens to retro-cost them.
//   (B) DOUBLE-PROMISED — units already owed to an outstanding shipment that MRP
//       still offers as free incoming supply.
//
// WHAT COUNTS AS CLAIMABLE CHANGED ON 2026-07-31 (migration 0230). It used to be
// `is_dropship = TRUE AND batch_no` — a HEADER flag that only a confirmed
// drop-ship dialog ever set, which is why the 2026-07-30/31 run found 3 short
// OUTs and ZERO claimable. It is now `batch_no AND (is_dropship OR a line of
// that DO carries committed_po_batch_no = the batch)`, matching the SQL exactly.
// Read the function's OUT-loop predicate before changing this query; if the two
// disagree, this detector is the thing that will be wrong.
//
// SECTION (B) ALSO CHANGED. mrp.ts now deducts claimable commitments from the
// incoming-PO pool AND adds the same units back to on-hand stock (the OUT had
// already taken them off inventory_balances, so deducting alone would count them
// twice). So a claimable commitment is no longer evidence of a double promise —
// it is evidence the deduction has something to do. What (B) reports now is the
// residual: commitments the deduction CANNOT reach, i.e. ones whose PO has no
// open units left to deduct from.
//
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
  // line_committed mirrors fn_reconcile_dropship_batch's per-line EXISTS (0230).
  const outs = await sql`
    SELECT m.id, m.source_doc_no, m.product_code, m.variant_key, m.batch_no,
           m.warehouse_id, ABS(m.qty) AS out_qty, m.created_at,
           d.is_dropship, UPPER(COALESCE(d.status::text,'')) AS do_status,
           EXISTS (SELECT 1 FROM scm.delivery_order_items di
                    WHERE di.delivery_order_id = d.id
                      AND di.committed_po_batch_no = m.batch_no
                      AND di.item_code = m.product_code) AS line_committed,
           COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c
                      WHERE c.movement_id = m.id), 0) AS consumed
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.movement_type = 'OUT' AND m.source_doc_type = 'DO'
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
     ORDER BY m.created_at`;
  const short = outs.filter((r) => Number(r.out_qty) - Number(r.consumed) > 0);

  notice("================ (A) SHORT OUTs — can the receipt reconcile ever claim them? ================");
  const bound = (r) => r.is_dropship === true || r.line_committed === true;
  const claimable = short.filter((r) => r.batch_no && bound(r));
  const strandedNoSignal = short.filter((r) => r.batch_no && !bound(r));
  const strandedNoBatch = short.filter((r) => !r.batch_no);
  const units = (a) => a.reduce((s, r) => s + (Number(r.out_qty) - Number(r.consumed)), 0);
  notice(`  short OUTs total                          : ${short.length}  (${units(short)} units)`);
  notice(`   - CLAIMABLE (batch + dropship|line-bound) : ${claimable.length}  (${units(claimable)} units)  -> nets on receipt`);
  notice(`   - STRANDED, batch but NO claim signal     : ${strandedNoSignal.length}  (${units(strandedNoSignal)} units)  -> reconcile skips; oversell retro-cost (0154) may still repair`);
  notice(`   - STRANDED, NO batch_no at all            : ${strandedNoBatch.length}  (${units(strandedNoBatch)} units)  -> plain oversell; only 0154 can repair`);
  for (const r of [...strandedNoSignal, ...strandedNoBatch].slice(0, 25)) {
    notice(`    ${pad(r.source_doc_no, 20)} ${pad(r.product_code, 22)} ${pad(r.variant_key, 12)} batch=${pad(r.batch_no ?? "(none)", 14)} dropship=${r.is_dropship === true ? "Y" : "N"} lineBound=${r.line_committed === true ? "Y" : "N"} short=${Number(r.out_qty) - Number(r.consumed)} ${String(r.created_at).slice(0, 10)}`);
  }

  // (B) what MRP still offers, AFTER the 0230 deduction has taken its share.
  notice("================ (B) COMMITTED vs OPEN PO SUPPLY — what the MRP deduction can reach ================");
  notice("  mrp.ts deducts a claimable commitment from (qty - received_qty) and adds the same");
  notice("  units back to on-hand (the OUT already took them off inventory_balances). Anything");
  notice("  below with committed > openLeft is a RESIDUAL the deduction cannot reach.");
  if (!claimable.length) notice("  no outstanding claimable commitments — the deduction has nothing to do right now.");
  else {
    const rows = await sql`
      SELECT poi.material_code, poi.qty, poi.received_qty,
             po.po_number, UPPER(COALESCE(po.status::text,'')) AS po_status
        FROM scm.purchase_order_items poi
        JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
       WHERE UPPER(COALESCE(po.status::text,'')) NOT IN ('CANCELLED','DRAFT')
         AND (poi.qty - COALESCE(poi.received_qty,0)) > 0
         AND poi.material_code IN ${sql([...new Set(claimable.map((r) => r.product_code))])}`;
    notice(`  open PO lines for the committed SKUs      : ${rows.length}`);
    // Committed is keyed by (SKU, batch = PO number) — the same pair the
    // deduction pairs on, so a commitment against PO-A is never shown as
    // reducing PO-B.
    const committedByPair = new Map();
    for (const r of claimable) {
      const k = `${r.product_code}::${r.batch_no}`;
      committedByPair.set(k, (committedByPair.get(k) ?? 0) + (Number(r.out_qty) - Number(r.consumed)));
    }
    const openByPair = new Map();
    for (const r of rows) {
      const k = `${r.material_code}::${r.po_number}`;
      openByPair.set(k, (openByPair.get(k) ?? 0) + (Number(r.qty) - Number(r.received_qty ?? 0)));
    }
    notice(`    ${pad("SKU", 24)} ${pad("PO / batch", 20)} ${pad("committed", 10)} ${pad("openLeft", 9)} verdict`);
    let residual = 0;
    for (const [k, c] of committedByPair) {
      const [code, batch] = k.split("::");
      const left = openByPair.get(k) ?? 0;
      const over = Math.max(0, c - left);
      residual += over;
      notice(`    ${pad(code, 24)} ${pad(batch, 20)} ${pad(c, 10)} ${pad(left, 9)} ${over > 0 ? `RESIDUAL ${over} — no open PO units left to deduct from` : "deducted in full"}`);
    }
    notice(`  residual committed units MRP cannot deduct: ${residual}`);
    notice("  ^ a residual means the PO was already fully received (the reconcile simply has not");
    notice("    run yet) or the binding points at a PO that is no longer open — worth a look, not");
    notice("    automatically a fault.");
  }

  // (C) the link a shipment binds through. Since 2026-07-31 a DO can CREATE this
  // link at ship time by hardening the soft MRP allocation the SO screen already
  // shows (scm/lib/harden-so-po-link.ts), so a NULL here is no longer a dead end
  // — it only means no shipment has needed that line yet. What matters now is
  // whether the count is going UP over time.
  notice("================ (C) SO->PO LINK COVERAGE (so_item_id) ================");
  const [{ total, linked }] = await sql`
    SELECT COUNT(*)::int AS total, COUNT(so_item_id)::int AS linked
      FROM scm.purchase_order_items`;
  notice(`  purchase_order_items rows                 : ${total}`);
  notice(`   - with so_item_id set (hard binding)      : ${linked}`);
  notice(`   - NULL (soft/MRP only, or no demand)      : ${total - linked}`);
  notice("  A NULL is only a problem if a shipment could not harden it — those are");
  notice("  logged by the DO ship path as '[ship-commitment] could not harden MRP match'.");
  notice("=== END — read-only, no rows changed. ===");
}
main().then(() => sql.end()).catch((e) => { console.error("HARD_COMMITTED_PO_FAIL", e?.message ?? e); process.exit(1); });
