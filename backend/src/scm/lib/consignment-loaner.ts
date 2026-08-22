// ----------------------------------------------------------------------------
// consignment-loaner — VALUE-NEUTRAL stock movement for the sales-consignment
// ("loaner") workflow.
//
// A Consignment Note (CS_DO) ships goods OUT to a customer on loan; a
// Consignment Return (CS_DR) brings them back. Unlike a Delivery Order (which
// is a real sale: FIFO consume + COGS) or a Delivery Return (a real receive-in),
// the goods stay MY asset the entire time — ownership never changes. So the only
// stock effect is a VALUE-NEUTRAL TRANSFER between the shipping warehouse and the
// hidden "Consignment (Out)" warehouse (migration 0152, is_consignment = true):
//
//   CS_DO ship   → transfer  shippingWarehouse → consignmentWarehouse
//   CS_DR return → transfer  consignmentWarehouse → shippingWarehouse
//
// No margin / COGS is realised; total inventory valuation is unchanged (the
// units just sit in a different, non-sellable warehouse). SO allocation + MRP
// never target the consignment warehouse (0118 keeps every line in its own
// warehouse), so consigned stock can't be double-sold.
//
// The transfer mechanic mirrors apps/api/src/routes/stock-transfers.ts: insert
// an OUT @from (the FIFO trigger fills total_cost_sen), read it back, derive the
// weighted unit cost, then insert an IN @to carrying that cost + the source
// dye-lot batch (resolved unambiguously from the source warehouse's open lots).
//
// IDEMPOTENCY: the OUT leg is tagged with the CS_DO / CS_DR source type, whose
// partial UNIQUE index (uq_inv_mov_cs_*_source, migration 0153) — keyed on
// (source_doc_type, source_doc_id, item_code, variant_key) — guarantees a
// note can only move stock once. Because that index does NOT include
// warehouse_id, both legs of a single transfer CANNOT share the CS_* type (the
// OUT @from and IN @to would collide on the same product/variant). So only the
// canonical OUT leg carries the CS_* type; the paired IN leg is written under
// 'STOCK_TRANSFER' (same source_doc_id) so it never collides. reverseLoaner
// re-derives both legs and runs the transfer in the opposite direction.
//
// Best-effort throughout (audit-DLQ posture): a failed movement insert is logged
// but never rolls back the note — same as inventory-movements.ts.
// ----------------------------------------------------------------------------

import { writeMovements } from './inventory-movements';
import { reconcileUncostedAfterIn } from './oversell-retrocost';

export type LoanerSourceType = 'CS_DO' | 'CS_DR';

export type LoanerLine = {
  item_code: string;
  /** Migration 0095 attribute-composition bucket key. '' = unclassified. */
  variant_key: string;
  product_name: string | null;
  qty: number;
};

/**
 * The hidden Consignment (Out) warehouse id (migration 0152) FOR ONE COMPANY,
 * or null when that company hasn't seeded one. Callers skip the transfer when
 * null.
 *
 * `companyId` IS REQUIRED, for the same reason `defaultWarehouseId` took the
 * same medicine on 2026-08-03 (lib/inventory-movements.ts, which spells the
 * incident out): a warehouse lookup with no company predicate is a
 * cross-company draw decided silently by whatever the database returns first.
 *
 * This one was worse than a draw, because it also had `.maybeSingle()` and no
 * `error` binding. Three failure modes sat behind one `null`:
 *   · GLOBAL SINGLETON — `scm.warehouses` is per-company (migration 0086), so
 *     `is_consignment = true` can legitimately be true once PER COMPANY. The
 *     unscoped read treated the whole table as if only one such warehouse could
 *     exist anywhere;
 *   · WRONG COMPANY'S WAREHOUSE — with exactly one seeded, every company
 *     resolved to it, so one organisation's consignment stock would have moved
 *     into another organisation's warehouse row;
 *   · TWO ROWS = SILENT NULL — the moment a second company seeded its own,
 *     PostgREST's `.maybeSingle()` errors on multiple rows, the discarded
 *     `error` made that identical to "not seeded", and the documented caller
 *     behaviour is to SKIP the stock transfer. So seeding a warehouse correctly
 *     would have quietly disabled the loaner movement for BOTH companies.
 *
 * Ordered and limited rather than `.maybeSingle()`, so a company that somehow
 * holds two consignment warehouses gets a deterministic answer instead of an
 * error rendered as an absence.
 *
 * NOTE FOR WHOEVER WIRES THIS UP: this module currently has no importers —
 * `transferLoaner` and `reverseLoaner` are exported and uncalled — so nothing in
 * production reaches this today. That is exactly why the signature is being
 * fixed now: the trap is cheaper to disarm before it has callers than after.
 */
export async function consignmentWarehouseId(
  sb: any,
  companyId: number | undefined,
): Promise<string | null> {
  if (companyId === undefined) return null;
  const { data } = await sb.from('warehouses')
    .select('id')
    .eq('is_consignment', true)
    .eq('company_id', companyId)
    .order('code', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/* Resolve the dye-lot batch each line moves so a batched (sofa) lot keeps its
   batch_no across the warehouse hop — otherwise the destination can't satisfy a
   batch-scoped sofa ship. Reads OPEN lots at the SOURCE warehouse; for each
   (item_code, variant_key) bucket carries the batch ONLY when the source
   stock sits in a single non-null batch. Multi-batch / plain stock → un-batched
   (plain FIFO), never a guessed dye-lot. Forward-compat: view/column absent
   pre-0120 → empty map → every line un-batched. Mirrors stock-transfers.ts. */
async function resolveSourceBatches(
  sb: any,
  fromWh: string,
): Promise<Map<string, string | null>> {
  const batchByBucket = new Map<string, string | null>();
  try {
    const { data: lots, error } = await sb
      .from('v_inventory_lots_open')
      .select('warehouse_id, item_code, variant_key, batch_no, qty_remaining')
      .eq('warehouse_id', fromWh)
      .not('batch_no', 'is', null)
      .gt('qty_remaining', 0);
    if (!error) {
      const batchesByBucket = new Map<string, Set<string>>();
      for (const r of (lots ?? []) as Array<{
        item_code: string; variant_key: string | null; batch_no: string | null;
      }>) {
        if (!r.batch_no) continue;
        const k = `${r.item_code}::${r.variant_key ?? ''}`;
        const set = batchesByBucket.get(k) ?? new Set<string>();
        set.add(r.batch_no);
        batchesByBucket.set(k, set);
      }
      for (const [k, set] of batchesByBucket.entries()) {
        batchByBucket.set(k, set.size === 1 ? [...set][0]! : null);
      }
    }
  } catch { /* view/column absent pre-0120 — every line un-batched (plain FIFO) */ }
  return batchByBucket;
}

/**
 * Value-neutral loaner transfer of `lines` from `fromWh` to `toWh`.
 *
 * For each line:
 *   1) Insert an OUT @fromWh (the FIFO trigger fills total_cost_sen). This OUT
 *      carries the CS_DO / CS_DR source type — its partial UNIQUE index is the
 *      per-doc idempotency backstop.
 *   2) Read the OUT back, derive unit_cost = total_cost / qty (weighted avg).
 *   3) Insert an IN @toWh carrying that unit_cost_sen + the source dye-lot batch.
 *      The IN is tagged 'STOCK_TRANSFER' (same source_doc_id) so it never
 *      collides with the OUT on the CS_* unique index (which omits warehouse_id).
 *
 * Goods stay owned — no COGS, no margin: total valuation is unchanged, only the
 * physical location moves. Best-effort; returns the per-line error strings (if
 * any) so the caller can log without rolling back the note.
 */
export async function transferLoaner(
  sb: any,
  fromWh: string,
  toWh: string,
  lines: LoanerLine[],
  sourceDocType: LoanerSourceType,
  sourceDocId: string,
  sourceDocNo: string,
  userId: string | null,
  // Multi-company (mig 0061): stamp the source doc's company on every movement.
  companyId: number | null | undefined,
): Promise<string[]> {
  const errors: string[] = [];
  if (!fromWh || !toWh || fromWh === toWh || lines.length === 0) return errors;
  const companyCol = companyId != null ? { company_id: companyId } : {};

  const batchByBucket = await resolveSourceBatches(sb, fromWh);

  /* Collapse identical (item_code, variant_key) lines into one OUT/IN pair so
     the CS_* unique index (which omits warehouse_id) is never hit twice for the
     same (doc, product, variant). A note can legitimately list the same product
     across two lines (qty split). */
  const byKey = new Map<string, LoanerLine>();
  for (const ln of lines) {
    const qty = Number(ln.qty ?? 0);
    if (qty <= 0 || !ln.item_code) continue;
    const variantKey = ln.variant_key ?? '';
    const k = `${ln.item_code}::${variantKey}`;
    const cur = byKey.get(k);
    if (cur) { cur.qty += qty; }
    else byKey.set(k, { item_code: ln.item_code, variant_key: variantKey, product_name: ln.product_name ?? null, qty });
  }

  for (const ln of byKey.values()) {
    const variantKey = ln.variant_key ?? '';
    const batchNo = batchByBucket.get(`${ln.item_code}::${variantKey}`) ?? null;

    // 1) OUT @from — the FIFO trigger consumes the source lot(s) and fills
    //    total_cost_sen. CS_* source type = idempotency backstop for the ship.
    const { data: outRow, error: outErr } = await sb.from('inventory_movements').insert({
      ...companyCol,
      movement_type:   'OUT',
      warehouse_id:    fromWh,
      item_code:    ln.item_code,
      variant_key:     variantKey,
      product_name:    ln.product_name,
      qty:             ln.qty,
      source_doc_type: sourceDocType,
      source_doc_id:   sourceDocId,
      source_doc_no:   sourceDocNo,
      ...(batchNo ? { batch_no: batchNo } : {}),
      performed_by:    userId,
      notes:           `Consignment loaner transfer to warehouse ${toWh} (value-neutral)`,
    }).select('id, qty, unit_cost_sen, total_cost_sen').single();
    if (outErr || !outRow) {
      errors.push(`OUT ${ln.item_code}: ${outErr?.message ?? 'no data'}`);
      continue;
    }

    // 2) Derive the IN's unit cost from the OUT's booked FIFO cost so the
    //    destination lot opens at the same basis (value-neutral).
    const outQty   = Number((outRow as { qty: number }).qty ?? ln.qty);
    const outTotal = Number((outRow as { total_cost_sen: number | null }).total_cost_sen ?? 0);
    const inUnitCost = outQty > 0 ? Math.round(outTotal / outQty) : 0;

    // 3) IN @to — under STOCK_TRANSFER (NOT the CS_* type) so it never collides
    //    with the OUT on the CS_* unique index. Same source_doc_id ties the pair.
    const inOk = await writeMovements(sb, [{
      movement_type:   'IN',
      warehouse_id:    toWh,
      item_code:    ln.item_code,
      variant_key:     variantKey,
      product_name:    ln.product_name,
      qty:             ln.qty,
      unit_cost_sen:   inUnitCost,
      source_doc_type: 'STOCK_TRANSFER',
      source_doc_id:   sourceDocId,
      source_doc_no:   sourceDocNo,
      ...(batchNo ? { batch_no: batchNo } : {}),
      performed_by:    userId,
      notes:           `Consignment loaner transfer from warehouse ${fromWh} (value-neutral)`,
    }], companyId);
    if (!inOk.ok) errors.push(`IN ${ln.item_code}: ${inOk.reason ?? 'unknown'}`);
    /* Oversell retro-cost (0154) — the loaner hop opens a lot at the DESTINATION,
       so a prior "ship anyway" DO that went out at RM0 there can now be costed
       from it. Wired 2026-07-29; until then only the GRN post reconciled, so
       stock arriving by transfer never repaired the earlier shipment (COE §2).
       Best-effort — never fails the loaner. */
    if (inOk.ok) {
      await reconcileUncostedAfterIn(sb, [{
        movement_type: 'IN', warehouse_id: toWh, item_code: ln.item_code,
        variant_key: variantKey, qty: ln.qty,
      }], userId);
    }
  }

  /* Re-walk allocation: a transfer is net-zero in TOTAL but not per BUCKET, and
     the bucket is what allocation reads.

     This comment used to say "SO allocation sums every warehouse", which has
     been false since migration 0118 (2026-05-31) — a line draws only its own
     warehouse's stock (so-stock-allocation.ts:471, :564). The re-walk is not a
     safety net for a failed leg; it is the POINT. Moving a unit from KL to PJ
     changes nothing in total and everything to a PJ line that could not see it
     five seconds ago. Best-effort. */
  try {
    const { recomputeSoStockAllocation } = await import('./so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[consignment-loaner] post-transfer allocation failed:', e); }

  return errors;
}

/**
 * Reverse a prior loaner transfer (used on cancel). We re-derive the original
 * transfer's net effect from THIS doc's own movements and run transferLoaner in
 * the OPPOSITE direction (swap from/to), with a '-CANCEL' source-doc-no suffix.
 *
 * Why not reverseMovements: its balancing row reuses the CS_* (source_doc_type,
 * source_doc_id, item_code, variant_key) key, which the partial UNIQUE index
 * uq_inv_mov_cs_*_source (migration 0153, keyed WITHOUT movement_type) rejects —
 * the same-key opposite collides and the insert silently fails, leaving the
 * loaner permanently relocated. Running transferLoaner in reverse sidesteps that
 * (the reversing OUT consumes from the consignment warehouse under a fresh
 * STOCK_TRANSFER leg, and the reversing CS_* OUT is a brand-new product/variant
 * at the original source warehouse — but to stay clear of the index entirely the
 * reversal is written wholly under STOCK_TRANSFER via a direct pair).
 *
 * IDEMPOTENCY: the reversal pre-checks for an existing '-CANCEL' STOCK_TRANSFER
 * row tagged with this doc id and skips if found, so a double-cancel is a no-op.
 * Best-effort.
 */
export async function reverseLoaner(
  sb: any,
  sourceDocType: LoanerSourceType,
  sourceDocId: string,
  sourceDocNo: string,
  fromWh: string,
  toWh: string,
  userId: string | null,
  // Multi-company (mig 0061): stamp the source doc's company on every movement.
  companyId: number | null | undefined,
): Promise<string[]> {
  const errors: string[] = [];
  if (!fromWh || !toWh || fromWh === toWh) return errors;
  const companyCol = companyId != null ? { company_id: companyId } : {};
  const cancelNo = `${sourceDocNo}-CANCEL`;

  // Idempotency — has this doc already been reversed? The reversal writes its
  // legs under STOCK_TRANSFER with the '-CANCEL' source_doc_no.
  const { count: alreadyReversed } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_id', sourceDocId)
    .eq('source_doc_type', 'STOCK_TRANSFER')
    .eq('source_doc_no', cancelNo);
  if ((alreadyReversed ?? 0) > 0) return errors;

  // Re-derive the original transfer's net OUT @fromWh from THIS doc's own
  // movements: the canonical OUT leg carries the CS_* type, batch_no, qty and
  // cost. Net per (product, variant, batch) bucket so a partial original (a
  // failed leg) only reverses what actually moved.
  const sel = 'movement_type, warehouse_id, item_code, variant_key, batch_no, qty, total_cost_sen, product_name';
  let movsRes = await sb.from('inventory_movements').select(sel)
    .eq('source_doc_type', sourceDocType).eq('source_doc_id', sourceDocId);
  if (movsRes.error && (movsRes.error.message ?? '').includes('batch_no')) {
    movsRes = await sb.from('inventory_movements')
      .select('movement_type, warehouse_id, item_code, variant_key, qty, total_cost_sen, product_name')
      .eq('source_doc_type', sourceDocType).eq('source_doc_id', sourceDocId);
  }
  if (movsRes.error) { errors.push(`reverse load: ${movsRes.error.message}`); return errors; }

  type Agg = {
    item_code: string; variant_key: string; batch_no: string | null;
    product_name: string | null; net_out: number; out_total_cost: number; out_qty: number;
  };
  const byBucket = new Map<string, Agg>();
  for (const m of (movsRes.data ?? []) as Array<{
    movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null;
    batch_no?: string | null; qty: number; total_cost_sen: number | null; product_name: string | null;
  }>) {
    if (m.movement_type !== 'OUT') continue; // the CS_* leg that left fromWh
    const variant_key = m.variant_key ?? '';
    const batch_no = m.batch_no ?? null;
    const k = `${m.item_code}::${variant_key}::${batch_no ?? ''}`;
    let agg = byBucket.get(k);
    if (!agg) { agg = { item_code: m.item_code, variant_key, batch_no, product_name: m.product_name, net_out: 0, out_total_cost: 0, out_qty: 0 }; byBucket.set(k, agg); }
    const q = Number(m.qty ?? 0);
    agg.net_out += q; agg.out_qty += q; agg.out_total_cost += Number(m.total_cost_sen ?? 0);
    if (!agg.product_name) agg.product_name = m.product_name;
  }

  /* Run the OPPOSITE transfer: pull each bucket OUT of the consignment side (the
     original `toWh`) and IN @ the original source (`fromWh`). Both reversal legs
     are written under STOCK_TRANSFER with the '-CANCEL' doc-no so they sidestep
     the CS_* unique index entirely and the idempotency pre-check can find them.
     The reversing OUT lets the FIFO trigger consume the consignment lot; the
     reversing IN re-opens the source lot at the same weighted cost basis. */
  for (const b of byBucket.values()) {
    if (b.net_out <= 0) continue;
    const unitCost = b.out_qty > 0 ? Math.round(b.out_total_cost / b.out_qty) : 0;

    const { error: outErr } = await sb.from('inventory_movements').insert({
      ...companyCol,
      movement_type:   'OUT',
      warehouse_id:    toWh,                 // consignment side gives the loaner back
      item_code:    b.item_code,
      variant_key:     b.variant_key,
      product_name:    b.product_name,
      qty:             b.net_out,
      source_doc_type: 'STOCK_TRANSFER',
      source_doc_id:   sourceDocId,
      source_doc_no:   cancelNo,
      ...(b.batch_no ? { batch_no: b.batch_no } : {}),
      performed_by:    userId,
      notes:           `Consignment loaner cancelled — reversing transfer (value-neutral)`,
    }).select('id').single();
    if (outErr) { errors.push(`reverse OUT ${b.item_code}: ${outErr.message}`); continue; }

    const inOk = await writeMovements(sb, [{
      movement_type:   'IN',
      warehouse_id:    fromWh,               // stock returns to the source shelf
      item_code:    b.item_code,
      variant_key:     b.variant_key,
      product_name:    b.product_name,
      qty:             b.net_out,
      unit_cost_sen:   unitCost,
      source_doc_type: 'STOCK_TRANSFER',
      source_doc_id:   sourceDocId,
      source_doc_no:   cancelNo,
      ...(b.batch_no ? { batch_no: b.batch_no } : {}),
      performed_by:    userId,
      notes:           `Consignment loaner cancelled — reversing transfer (value-neutral)`,
    }], companyId);
    if (!inOk.ok) errors.push(`reverse IN ${b.item_code}: ${inOk.reason ?? 'unknown'}`);
    /* Same as the forward hop: the reversal re-opens a lot at the SOURCE shelf. */
    if (inOk.ok) {
      await reconcileUncostedAfterIn(sb, [{
        movement_type: 'IN', warehouse_id: fromWh, item_code: b.item_code,
        variant_key: b.variant_key, qty: b.net_out,
      }], userId);
    }
  }

  try {
    const { recomputeSoStockAllocation } = await import('./so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[consignment-loaner] post-reverse allocation failed:', e); }

  return errors;
}
