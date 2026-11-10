// ----------------------------------------------------------------------------
// scm/lib/delivery-return-stock — a customer return's stock writes.
//
// A Delivery Return books the goods back IN on create, and drains them back out
// (a signed delta per bucket) on cancel and on a line edit / delete. Moved out
// of routes/delivery-returns.ts, which sits at its size ceiling, so the same
// code runs on either client:
//   - DELIVERY_RETURN_MODE=atomic (the default, lib/stock-post-tx.ts): the cancel
//     flip and the drain, or the create's stock IN, commit together or not at
//     all. A DR used to read RECEIVED / CANCELLED with its stock never booked or
//     never drained because each write was its own PostgREST call;
//   - "two-step": the old path, each write committed on its own.
// The retro-cost reconcile, SO allocation and SO re-open run after commit; they
// stay in the route (the allocation ledger counts its call sites there).
// ----------------------------------------------------------------------------

import { writeMovements, defaultWarehouseId } from './inventory-movements';
import { traceDoShipmentSources } from './source-po-trace';
import { shippedBatchOf } from './return-line-batch';
import { HARD_BOUND_COMPANY_ID, isHardBoundLine } from './so-stock-allocation';
import { foldTargetsIntoOwnBuckets, stockBucketKeyResolver } from './stock-bucket-key';
import { hasUnreadableLines, LINES_UNREADABLE, linesUnreadableMessage, ReadFailedError, unreadableMovementError } from './failed-read-refusal';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { STOCK_TX_ROLLED_BACK, stockTxFailureBody, type StockTx, type StockTxClient } from './stock-post-tx';
import { computeVariantKey, isServiceLine, type VariantAttrs } from '../shared';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-condition -- the
   resolvers and the two cores moved here verbatim from routes/delivery-returns.ts
   (counted under that file's ceiling there); PostgREST client, untyped rows. */
type Db = any;
type MovementRow = Parameters<typeof writeMovements>[1][number];

/* INCREASE inventory for a DR exactly once. ROBUST: fires on create (goods are
   received back the moment the return is created). IDEMPOTENT: a pre-insert
   existence check on the DR id skips re-increasing, and the partial UNIQUE
   index uq_inv_mov_dr_source (migration 0102) is the hard backstop against a
   race. DELIVERY_RETURN_MODE=atomic: a movement failure rolls back and the
   create is undone (receiveCreatedDrAtomically). two-step: best-effort, the
   failure is reported and the create stands.

   This is the MIRROR IMAGE of delivery-orders-mfg.ts deductInventoryForDo: it
   writes IN movements (the FIFO trigger from migration 0053/0095 creates a lot
   per IN row), one row per (item_code, variant_key) bucket. The lot's unit
   cost is seeded from the line's unit_cost_sen (sen) so returned stock
   re-enters at its original cost rather than zero. */
/* ── resolveDrLineWarehouses (Agent D 2026-05-31, TASK #32) ───────────────────
   PER-WAREHOUSE CORRECTNESS for the RETURNS side. A Delivery Return must put
   stock BACK into the SAME warehouse the Delivery Order took it OUT of — never a
   single DR-header default. The DO took it from its SO line's warehouse
   (migration 0118), so each DR line resolves its warehouse by tracing
   do_item_id → delivery_order_items.so_item_id → mfg_sales_order_items.
   warehouse_id.

   Resolution order per DR line:
     1. the linked DO line's SO-line warehouse (do_item_id → … → SO line)
     2. the linked DO header's warehouse_id
     3. the DR header's warehouse_id (free/ad-hoc lines — none exist now that
        "no DO, no return" is enforced, but kept as a safety net)
     4. the return's OWN company's default warehouse (last-resort fallback)

   Returns a map of delivery_return_items.id → warehouse_id (or null when even
   the fallbacks are absent — the caller skips those lines). */
export async function resolveDrLineWarehouses(
  sb: any,
  items: Array<{ id: string; do_item_id?: string | null }>,
  drHeaderWarehouseId: string | null,
  /* The return's company (2026-08-03) — step 4 is per company. It used to be a
     company-blind draw across every company's is_default warehouses, decided by
     alphabetical `code` order. */
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const doItemIds = [...new Set(items
    .map((it) => it.do_item_id ?? null)
    .filter((x): x is string => !!x))];

  // do_item_id → { so_item_id, do header warehouse }
  const doLineMeta = new Map<string, { soItemId: string | null; doWarehouseId: string | null }>();
  const soItemIds = new Set<string>();
  if (doItemIds.length > 0) {
    const { data: doLines, error: doLinesErr } = await sb.from('delivery_order_items')
      .select('id, so_item_id, delivery_order_id').in('id', doItemIds);
    if (doLinesErr) throw new ReadFailedError('the delivery order lines', doLinesErr);
    const doRows = (doLines ?? []) as Array<{ id: string; so_item_id: string | null; delivery_order_id: string }>;
    const doIds = [...new Set(doRows.map((r) => r.delivery_order_id).filter(Boolean))];
    const doHeaderWh = new Map<string, string | null>();
    if (doIds.length > 0) {
      const { data: doHeaders, error: doHeadersErr } = await sb.from('delivery_orders')
        .select('id, warehouse_id').in('id', doIds);
      if (doHeadersErr) throw new ReadFailedError('the delivery orders', doHeadersErr);
      for (const d of (doHeaders ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
        doHeaderWh.set(d.id, d.warehouse_id ?? null);
      }
    }
    for (const r of doRows) {
      if (r.so_item_id) soItemIds.add(r.so_item_id);
      doLineMeta.set(r.id, { soItemId: r.so_item_id ?? null, doWarehouseId: doHeaderWh.get(r.delivery_order_id) ?? null });
    }
  }

  // so_item_id → warehouse_id (the authoritative ship-from, 0118).
  const soWh = new Map<string, string | null>();
  if (soItemIds.size > 0) {
    const { data: soRows, error: soRowsErr } = await sb.from('mfg_sales_order_items')
      .select('id, warehouse_id').in('id', [...soItemIds]);
    if (soRowsErr) throw new ReadFailedError('the sales order lines', soRowsErr);
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }

  const fallback = drHeaderWarehouseId ?? (await defaultWarehouseId(sb, companyId));
  for (const it of items) {
    const meta = it.do_item_id ? doLineMeta.get(it.do_item_id) : undefined;
    const fromSo = meta?.soItemId ? (soWh.get(meta.soItemId) ?? null) : null;
    out.set(it.id, fromSo ?? meta?.doWarehouseId ?? fallback);
  }
  return out;
}

/* resolveDrLineBatches (Stage 4, Commander 2026-06-01) — sofa batch per DR line.
   Returned sofa modules must re-enter the SAME dye-lot batch they shipped from,
   so the batch view + batch-scoped consume stay consistent. Trace
   do_item_id → delivery_order_items.so_item_id → mfg_sales_order_items.
   allocated_batch_no. Best-effort: absent column (pre-0121) / non-sofa → no
   entry → plain non-batched IN, identical to the old behaviour.
   A sofa line takes the batch its DO actually shipped from first (2990-0011):
   allocated_batch_no is cleared once the SO is delivered, so a return booked
   after that came back un-batched and MRP could not see it. */
export async function resolveDrLineBatches(
  sb: any,
  items: Array<{ id: string; do_item_id?: string | null; item_code?: string | null; item_group?: string | null; variants?: VariantAttrs | null }>,
  companyId: number | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const doItemIds = [...new Set(items.map((it) => it.do_item_id ?? null).filter((x): x is string => !!x))];
  if (doItemIds.length === 0) return out;
  const { data: doLines, error: doLinesErr } = await sb.from('delivery_order_items')
    .select('id, so_item_id, delivery_order_id').in('id', doItemIds);
  if (doLinesErr) throw new ReadFailedError('the delivery order lines', doLinesErr);
  const doRows = (doLines ?? []) as Array<{ id: string; so_item_id: string | null; delivery_order_id: string | null }>;
  const soByDoLine = new Map<string, string>();
  const doByDoLine = new Map<string, string>();
  const soItemIds = new Set<string>();
  for (const r of doRows) {
    if (r.so_item_id) { soByDoLine.set(r.id, r.so_item_id); soItemIds.add(r.so_item_id); }
    if (r.delivery_order_id) doByDoLine.set(r.id, r.delivery_order_id);
  }
  const isSofa = (it: { item_group?: string | null }) => String(it.item_group ?? '').toUpperCase().includes('SOFA');
  const sofaDoIds = [...new Set(items.filter(isSofa).map((it) => (it.do_item_id ? doByDoLine.get(it.do_item_id) : undefined)).filter((x): x is string => !!x))];
  const shipped = sofaDoIds.length > 0 ? (await traceDoShipmentSources(sb, sofaDoIds)).byBucket : new Map();
  const batchBySo = new Map<string, string>();
  if (soItemIds.size > 0) {
    try {
      const { data: soRows, error } = await sb.from('mfg_sales_order_items')
        .select('id, allocated_batch_no').in('id', [...soItemIds]);
      if (!error) for (const r of (soRows ?? []) as Array<{ id: string; allocated_batch_no: string | null }>) {
        if (r.allocated_batch_no) batchBySo.set(r.id, r.allocated_batch_no);
      }
    } catch { /* column absent pre-0121 — no batches */ }
  }
  for (const it of items) {
    const doId = it.do_item_id ? doByDoLine.get(it.do_item_id) : undefined;
    const fromShip = doId && it.item_code && isSofa(it)
      ? shippedBatchOf(shipped, doId, it.item_code, computeVariantKey(it.item_group ?? null, it.variants ?? null))
      : null;
    const so = it.do_item_id ? soByDoLine.get(it.do_item_id) : undefined;
    const batch = fromShip ?? (so ? batchBySo.get(so) : undefined);
    if (batch) out.set(it.id, batch);
  }
  /* Company 1, hard-bound and not sofa (owner decision A, 2026-11-10): the DO OUT
     carries the bound PO as batch_no (lib/hard-bound-cost-batch.ts), so the
     returned unit re-enters that PO's lot. Only a batch the OUT was actually
     stamped with counts, so a DO shipped before the change still returns
     un-batched, as before, and a DR resync keys the same bucket its IN did. */
  const hbItems = companyId === HARD_BOUND_COMPANY_ID
    ? items.filter((it) => !out.has(it.id) && it.item_code && !isSofa(it) && isHardBoundLine(it.item_group ?? null, it.item_code))
    : [];
  const hbDoIds = [...new Set(hbItems.map((it) => (it.do_item_id ? doByDoLine.get(it.do_item_id) : undefined)).filter((x): x is string => !!x))];
  if (hbDoIds.length > 0) {
    const { data: outs, error: outsErr } = await sb.from('inventory_movements')
      .select('source_doc_id, item_code, variant_key, batch_no')
      .eq('source_doc_type', 'DO')
      .eq('movement_type', 'OUT')
      .in('source_doc_id', hbDoIds)
      .not('batch_no', 'is', null);
    /* An unreadable OUT leaves the line un-batched, which is the old behaviour:
       the unit still re-enters stock, only not tied to its PO lot. */
    if (outsErr) console.error('[dr-batch] DO stock-out batches unreadable, returning un-batched:', outsErr.message); // eslint-disable-line no-console
    const batchesByBucket = new Map<string, Set<string>>();
    for (const m of (outsErr ? [] : outs ?? []) as Array<{ source_doc_id: string; item_code: string; variant_key: string | null; batch_no: string | null }>) {
      if (!m.batch_no) continue;
      const k = `${m.source_doc_id}::${m.item_code}::${m.variant_key ?? ''}`;
      const set = batchesByBucket.get(k) ?? new Set<string>();
      set.add(m.batch_no);
      batchesByBucket.set(k, set);
    }
    for (const it of hbItems) {
      const doId = it.do_item_id ? doByDoLine.get(it.do_item_id) : undefined;
      const set = doId ? batchesByBucket.get(`${doId}::${it.item_code}::${computeVariantKey(it.item_group ?? null, it.variants ?? null)}`) : undefined;
      if (set && set.size === 1) out.set(it.id, [...set][0]!);
    }
  }
  return out;
}

/** What a stock write did. `errors` empty = clean; `written` = the rows that
 *  committed (or will, inside a transaction), the input of the after-commit tail. */
export type DrStockResult = { errors: string[]; written: MovementRow[] };

/* The stock IN of a DR's create (the old increaseInventoryForReturn without its
   retro-cost reconcile, which runs after commit). A failed read refuses with
   nothing written (lib/failed-read-refusal.ts): null is not "no lines". */
export async function drStockInCore(sb: Db, deliveryReturnId: string, performedBy: string): Promise<DrStockResult> {
  const done = (errors: string[]): DrStockResult => ({ errors, written: [] });
  // Idempotency guard #1 — has this DR already written IN movements?
  const { count: existing, error: existingErr } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_type', 'DR')
    .eq('source_doc_id', deliveryReturnId)
    .eq('movement_type', 'IN');
  if (existingErr) return done([unreadableMovementError('the stock already booked for this return', existingErr)]);
  if ((existing ?? 0) > 0) return done([]); // already increased — no-op

  const { data: drHeader, error: headErr } = await sb.from('delivery_returns')
    .select('return_number, warehouse_id, company_id')
    .eq('id', deliveryReturnId).maybeSingle();
  if (headErr) return done([unreadableMovementError('the delivery return', headErr)]);
  const { data: items, error: itemsErr } = await sb.from('delivery_return_items')
    .select('id, do_item_id, item_code, description, qty_returned, item_group, variants, unit_cost_sen')
    .eq('delivery_return_id', deliveryReturnId);
  if (itemsErr) return done([unreadableMovementError('the delivery return lines', itemsErr)]);
  const drHeaderWarehouseId = (drHeader as { warehouse_id: string | null } | null)?.warehouse_id ?? null;
  const drNo = (drHeader as { return_number: string } | null)?.return_number ?? deliveryReturnId;
  if (!items) return done([]);

  // Per-line warehouse — each returned line re-enters the warehouse the DO line
  // shipped from (its SO line's warehouse, 0118), not a single DR-header default.
  // Sofa batch per DR line — returned modules re-enter the batch they shipped from.
  let lineWh: Map<string, string | null>;
  let lineBatch: Map<string, string>;
  try {
    lineWh = await resolveDrLineWarehouses(
      sb,
      items as Array<{ id: string; do_item_id?: string | null }>,
      drHeaderWarehouseId,
      (drHeader as { company_id?: number | null } | null)?.company_id ?? undefined,
    );
    lineBatch = await resolveDrLineBatches(sb, items as Array<{ id: string; do_item_id?: string | null; item_code?: string | null; item_group?: string | null; variants?: VariantAttrs | null }>,
      (drHeader as { company_id?: number | null } | null)?.company_id ?? null);
  } catch (e) {
    if (e instanceof ReadFailedError) return done([e.message]);
    throw e;
  }

  /* Collapse identical (warehouse_id, item_code, variant_key, batch_no) lines
     into one IN row. A DR can list the same product across two lines AND across
     two warehouses (multi-DO merge); bucketing by warehouse keeps each
     warehouse's increase correct + idempotency-safe. batch_no joins the key so a
     returned sofa module re-opens a lot tagged with its own dye-lot batch. Unit
     cost carried from the first line in the bucket (returned stock re-enters at
     its original per-unit cost). */
  const byKey = new Map<string, {
    warehouse_id: string; item_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number; batch_no: string | null;
  }>();
  /* Returned goods go back into the bucket they left: the SKU category's
     canonical key, as the stocked bucket's own string when canonically equal
     (lib/stock-bucket-key.ts). */
  const drKeyLine = (it: { id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }) =>
    ({ item_code: it.item_code, item_group: it.item_group ?? null, variants: it.variants ?? null, warehouse_id: lineWh.get(it.id) ?? null });
  const drKeyOf = await stockBucketKeyResolver(sb, (drHeader as { company_id?: number | null } | null)?.company_id ?? null,
    (items as Array<{ id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }>).map(drKeyLine));
  for (const it of (items as Array<{ id: string; item_code: string; description: string | null; qty_returned: number; item_group?: string | null; variants?: VariantAttrs | null; unit_cost_sen?: number | null }>)) {
    /* P1 SO-SKU spec §4.6 — depth guard: a SERVICE line must never write stock
       IN. The route guards reject them at create/edit; this keeps any line
       that slips through (legacy data, direct DB write) inventory-neutral. */
    if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
    const qty = Number(it.qty_returned ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue; // no resolvable warehouse — skip rather than guess
    const variantKey = drKeyOf(drKeyLine(it));
    const batchNo = lineBatch.get(it.id) ?? null;
    const k = `${warehouseId}::${it.item_code}::${variantKey}::${batchNo ?? ''}`;
    const cur = byKey.get(k);
    if (cur) { cur.qty += qty; }
    else byKey.set(k, {
      warehouse_id: warehouseId,
      item_code: it.item_code,
      variant_key: variantKey,
      product_name: it.description,
      qty,
      unit_cost_sen: Number(it.unit_cost_sen ?? 0),
      batch_no: batchNo,
    });
  }
  const movements = [...byKey.values()].map((m) => ({
    movement_type: 'IN' as const,
    warehouse_id: m.warehouse_id,
    item_code: m.item_code,
    variant_key: m.variant_key,
    product_name: m.product_name,
    qty: m.qty,
    // Seed the FIFO lot's per-unit cost so returned stock re-enters at its
    // original cost (the DO deduction leaves OUT rows costless — the trigger
    // computes the consumed cost — but IN rows must carry the lot cost).
    unit_cost_sen: m.unit_cost_sen,
    source_doc_type: 'DR' as const,
    source_doc_id: deliveryReturnId,
    source_doc_no: drNo,
    performed_by: performedBy,
    ...(m.batch_no ? { batch_no: m.batch_no } : {}),
  }));
  if (movements.length === 0) return done([]);
  /* Capture the write result so the caller can surface a failed stock IN (was
     silently swallowed — DR created with goods NOT booked back and the caller
     never told). Inside the atomic create a failure rolls back. */
  const res = await writeMovements(sb, movements, (drHeader as { company_id?: number | null } | null)?.company_id ?? null);
  if (!res.ok) return done([`IN ${drNo}: ${res.reason ?? 'unknown'}`]);
  return { errors: [], written: movements };
}

/* ── resyncInventoryForReturn (2026-06-01 — DR line-edit/delete/cancel rollback) ──
   A DR books goods BACK INTO stock on create (increaseInventoryForReturn writes
   IN rows under source_doc_type 'DR'). But a later LINE EDIT (qty reduced) or
   LINE DELETE left those IN rows untouched → on-hand stayed permanently inflated
   by the removed qty. This helper re-derives the DR's intended net stock impact
   from its CURRENT lines and writes a single signed ADJUSTMENT delta per bucket
   to close the gap — the exact mirror of resyncInventoryForDo on the DO side.

   It also SUBSUMES the old cancel reversal: when the DR is CANCELLED the target
   is zero, so the delta removes the full remaining net — one code path for every
   rollback (edit / delete / cancel), so the three can't drift.

   BATCH-AWARE (Stage 4): the forward IN rows carry batch_no for sofa/dye-lot
   items (resolveDrLineBatches). A negative delta on a batched bucket is written
   as an OUT carrying that batch_no so the FIFO/lot consumer removes stock from
   the EXACT lot it re-entered (keeping inventory_lots truthful); a positive delta
   on a batched bucket re-opens the lot with an IN. Non-batched buckets use a
   FIFO-neutral signed ADJUSTMENT. Either way the row is tagged
   source_doc_type='ADJUSTMENT' so it sidesteps uq_inv_mov_dr_source (scoped to
   source_doc_type='DR', migration 0102).

   We write the delta as a FIFO-neutral ADJUSTMENT (movement_type 'ADJUSTMENT',
   source_doc_type 'ADJUSTMENT', source_doc_id = DR id). The inventory_balances
   view treats ADJUSTMENT as signed (migration 0095), and the DR source key's
   UNIQUE index (uq_inv_mov_dr_source, 0102) does NOT cover ADJUSTMENT rows, so
   any number of delta rows coexist. IDEMPOTENT by construction: re-running finds
   delta 0 (the prior ADJUSTMENT already closed the gap) → no write. A line edit
   / delete is best-effort (a failure is reported, the edit stands); the cancel
   under DELIVERY_RETURN_MODE=atomic rolls its flip back with a failed drain
   (cancelDrAtomically). */
/* The delta writes of a resync (the old resyncInventoryForReturn without its
   retro-cost reconcile, SO allocation and SO re-open, which the route runs after
   commit). A failed read refuses with nothing written: an unread line list is a
   zero target that drains the whole return, and an unread movement list books
   the whole return a second time. */
export async function drResyncCore(sb: Db, deliveryReturnId: string, performedBy: string): Promise<DrStockResult> {
  const done = (errors: string[]): DrStockResult => ({ errors, written: [] });
  const { data: drHeader, error: headErr } = await sb.from('delivery_returns')
    .select('return_number, status, warehouse_id, company_id')
    .eq('id', deliveryReturnId).maybeSingle();
  if (headErr) return done([unreadableMovementError('the delivery return', headErr)]);
  if (!drHeader) return done([]);
  const drStatus = ((drHeader as { status: string | null }).status ?? '').toUpperCase();
  const drHeaderWarehouseId = (drHeader as { warehouse_id: string | null }).warehouse_id ?? null;
  const drNo = (drHeader as { return_number: string }).return_number ?? deliveryReturnId;

  // 1. TARGET net IN per (warehouse, product, variant, batch_no) bucket = sum of
  //    the DR's CURRENT lines (mirror of increaseInventoryForReturn's bucketing,
  //    batch_no included so a sofa line targets its OWN dye-lot). A CANCELLED DR
  //    has a target of zero — every bucket must drain back out.
  type Bucket = { warehouse_id: string; item_code: string; variant_key: string; batch_no: string | null; product_name: string | null; qty: number; unit_cost_sen: number };
  const targetByBucket = new Map<string, Bucket>();
  if (drStatus !== 'CANCELLED') {
    const { data: items, error: itemsErr } = await sb.from('delivery_return_items')
      .select('id, do_item_id, item_code, description, qty_returned, item_group, variants, unit_cost_sen')
      .eq('delivery_return_id', deliveryReturnId);
    if (itemsErr) return done([unreadableMovementError('the delivery return lines', itemsErr)]);
    const lineRows = (items ?? []) as Array<{ id: string; do_item_id?: string | null; item_code: string; description: string | null; qty_returned: number; item_group?: string | null; variants?: VariantAttrs | null; unit_cost_sen?: number | null }>;
    let lineWh: Map<string, string | null>;
    let lineBatch: Map<string, string>;
    try {
      lineWh = await resolveDrLineWarehouses(
        sb,
        lineRows as Array<{ id: string; do_item_id?: string | null }>,
        drHeaderWarehouseId,
        (drHeader as { company_id?: number | null }).company_id ?? undefined,
      );
      lineBatch = await resolveDrLineBatches(sb, lineRows, (drHeader as { company_id?: number | null }).company_id ?? null);
    } catch (e) {
      if (e instanceof ReadFailedError) return done([e.message]);
      throw e;
    }
    for (const it of lineRows) {
      /* P1 SO-SKU spec §4.6 — SERVICE lines never wrote IN on create, so they
         stay out of the resync TARGET too (else the delta walk would write a
         phantom IN to "catch up"). */
      if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
      const qty = Number(it.qty_returned ?? 0);
      if (qty <= 0) continue;
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) continue; // unresolvable warehouse — skip rather than guess
      const variant_key = computeVariantKey(it.item_group ?? null, it.variants ?? null);
      const batch_no = lineBatch.get(it.id) ?? null;
      const k = `${warehouseId}::${it.item_code}::${variant_key}::${batch_no ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) { cur.qty += qty; }
      else targetByBucket.set(k, { warehouse_id: warehouseId, item_code: it.item_code, variant_key, batch_no, product_name: it.description, qty, unit_cost_sen: Number(it.unit_cost_sen ?? 0) });
    }
  }

  // 2. CURRENT net IN already booked for this DR = Σ IN/OUT rows (source 'DR')
  //    plus Σ prior resync rows (source 'ADJUSTMENT' — signed ADJUSTMENT for
  //    plain buckets, or IN/OUT carrying batch_no for sofa buckets). Bucketing by
  //    batch_no keeps each dye-lot's delta independent. Forward-compat: pre-0120
  //    the batch_no column doesn't exist → retry without it (every batch '').
  type Agg = { net_in: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  const addMov = (m: { movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null; batch_no?: string | null; qty: number; product_name: string | null }) => {
    const k = `${m.warehouse_id}::${m.item_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let agg = aggByBucket.get(k);
    if (!agg) { agg = { net_in: 0, product_name: m.product_name }; aggByBucket.set(k, agg); }
    const q = Number(m.qty ?? 0);
    if (m.movement_type === 'IN') agg.net_in += q;
    else if (m.movement_type === 'OUT') agg.net_in -= q;
    else if (m.movement_type === 'ADJUSTMENT') agg.net_in += q; // already signed
    if (!agg.product_name) agg.product_name = m.product_name;
  };
  const readDrMovs = async (sourceType: string) => {
    const sel = 'movement_type, warehouse_id, item_code, variant_key, batch_no, qty, product_name';
    let res = await sb.from('inventory_movements').select(sel)
      .eq('source_doc_type', sourceType).eq('source_doc_id', deliveryReturnId);
    if (res.error && (res.error.message ?? '').includes('batch_no')) {
      res = await sb.from('inventory_movements')
        .select('movement_type, warehouse_id, item_code, variant_key, qty, product_name')
        .eq('source_doc_type', sourceType).eq('source_doc_id', deliveryReturnId);
    }
    return res;
  };
  for (const sourceType of ['DR', 'ADJUSTMENT']) {
    const res = await readDrMovs(sourceType);
    if (res.error) return done([unreadableMovementError('the stock already booked for this return', res.error)]);
    for (const m of (res.data ?? []) as any[]) addMov(m);
  }
  /* A target canonically equal to a bucket this DR already booked IS that bucket (lib/stock-bucket-key.ts). */
  foldTargetsIntoOwnBuckets(targetByBucket, aggByBucket.keys(), (drHeader as { company_id?: number | null }).company_id ?? null);

  // 3. Per-bucket delta = target − current_net. delta > 0 adds stock back (a line
  //    qty was raised); delta < 0 removes over-booked stock (line reduced /
  //    deleted / DR cancelled). BATCHED bucket → write an IN/OUT carrying batch_no
  //    so the FIFO/lot consumer touches the EXACT dye-lot (keeping inventory_lots
  //    truthful). PLAIN bucket → FIFO-neutral signed ADJUSTMENT. Either way the
  //    row is source_doc_type='ADJUSTMENT' (uq_inv_mov_dr_source is scoped to
  //    source_doc_type='DR', so no collision).
  const allKeys = new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()]);
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  for (const k of allKeys) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { net_in: 0, product_name: null };
    const delta = (t?.qty ?? 0) - a.net_in;
    if (delta === 0) continue;
    const parts = k.split('::');
    const batchNo = parts[3] || null;
    const note = drStatus === 'CANCELLED'
      ? `Delivery return ${drNo} cancelled — reversing return (stock removed)`
      : `Delivery return ${drNo} line edited — resyncing returned stock`;
    const base = {
      warehouse_id: parts[0] ?? '',
      item_code: parts[1] ?? '',
      variant_key: parts[2] ?? '',
      product_name: t?.product_name ?? a.product_name ?? null,
      source_doc_type: 'ADJUSTMENT' as const,
      source_doc_id: deliveryReturnId,
      source_doc_no: drNo,
      performed_by: performedBy,
      notes: note,
    };
    if (batchNo) {
      // Sofa/dye-lot: move the exact lot. + re-opens it (IN), − consumes it (OUT).
      writes.push(delta > 0
        ? { ...base, movement_type: 'IN', qty: delta, unit_cost_sen: t?.unit_cost_sen ?? 0, batch_no: batchNo }
        : { ...base, movement_type: 'OUT', qty: -delta, batch_no: batchNo });
    } else {
      writes.push({
        ...base,
        movement_type: 'ADJUSTMENT',
        qty: delta, // signed: + adds stock, − removes it
        unit_cost_sen: delta > 0 ? (t?.unit_cost_sen ?? 0) : 0,
      });
    }
  }
  if (writes.length === 0) return done([]);
  const wrote = await writeMovements(sb, writes, (drHeader as { company_id?: number | null } | null)?.company_id ?? null);
  if (!wrote.ok) return done(['return resync: ' + (wrote.reason ?? 'unknown')]);
  return { errors: [], written: writes };
}

/* ── The atomic runs (DELIVERY_RETURN_MODE=atomic) ─────────────────────────── */

export type DrStockFailure = { ok: false; reason: string; status: number; detail?: string };

/** The core reported errors: inside the transaction that is a rollback, never a half write. */
export function drStockCoreFailure(errors: string[]): DrStockFailure {
  return {
    ok: false,
    reason: hasUnreadableLines(errors) ? LINES_UNREADABLE : STOCK_TX_ROLLED_BACK,
    status: 503,
    detail: errors.join('; '),
  };
}

/** What the operator reads when an atomic return write rolled back. Nothing was written. */
export function drStockFailureBody(what: 'received' | 'cancelled', f: { reason: string; detail?: string }): object {
  if (f.reason === LINES_UNREADABLE) {
    return { error: LINES_UNREADABLE, message: linesUnreadableMessage('the delivery return', what), ...(f.detail ? { detail: f.detail } : {}) };
  }
  return stockTxFailureBody(what, f);
}

/** The cancel's status write, over the status the caller read and the caller's company. */
export type DrFlipResult = { data: { id: string; status: string } | null; error: { message: string; code?: string } | null };
export type DrFlip = (tx: StockTxClient) => Promise<DrFlipResult>;

/* The flip matched no row or was refused: nothing was written. The route reads
   `flip` exactly as it reads its two-step write (race echo, 409s). */
export type DrFlipMiss = { ok: false; reason: 'flip'; status: 409; flip: DrFlipResult };
export type DrCancelOutcome =
  | { ok: true; data: { id: string; status: string }; written: MovementRow[] }
  | DrFlipMiss
  | DrStockFailure;

export const isDrFlipMiss = (o: DrCancelOutcome): o is DrFlipMiss => !o.ok && 'flip' in o;

/**
 * The cancel: the CAS flip to CANCELLED and the drain of the stock the return
 * booked (target zero, drResyncCore) in ONE transaction. A failed drain rolls
 * the flip back with it, so a return never reads CANCELLED with its goods still
 * on the books.
 */
export async function cancelDrAtomically(tx: StockTx, deliveryReturnId: string, performedBy: string, flip: DrFlip): Promise<DrCancelOutcome> {
  return tx(async (t): Promise<DrCancelOutcome> => {
    const f = await flip(t);
    if (f.error || !f.data) return { ok: false, reason: 'flip', status: 409, flip: f };
    const core = await drResyncCore(t, deliveryReturnId, performedBy);
    if (core.errors.length > 0) return drStockCoreFailure(core.errors);
    return { ok: true, data: f.data, written: core.written };
  });
}

/**
 * The create's stock IN in one transaction. The DR header and lines were
 * inserted (RECEIVED) before this runs, so when it rolls back no stock moved and
 * the just-created return is deleted again (its lines first, scoped to the
 * company): a return that says RECEIVED with nothing booked is the outcome this
 * exists to prevent. `removed` false = the delete failed too; the body says so.
 */
export async function receiveCreatedDrAtomically(
  tx: StockTx, sb: Db, deliveryReturnId: string, returnNumber: string, companyId: number | null, performedBy: string,
): Promise<{ ok: true; written: MovementRow[] } | { ok: false; removed: boolean; body: object }> {
  const out = await tx(async (t): Promise<{ ok: true; written: MovementRow[] } | DrStockFailure> => {
    const core = await drStockInCore(t, deliveryReturnId, performedBy);
    if (core.errors.length > 0) return drStockCoreFailure(core.errors);
    return { ok: true, written: core.written };
  });
  if (out.ok) return out;
  let removed = false;
  try {
    const items = await scopeToCompanyIdOrOpen(sb.from('delivery_return_items').delete().eq('delivery_return_id', deliveryReturnId), companyId);
    const head = items?.error ? items : await scopeToCompanyIdOrOpen(sb.from('delivery_returns').delete().eq('id', deliveryReturnId), companyId);
    removed = !items?.error && !head?.error;
  } catch { /* reported below */ }
  const base = drStockFailureBody('received', out) as { message?: string };
  return {
    ok: false,
    removed,
    body: {
      ...base,
      message: removed
        ? `Nothing was received: the stock change was rolled back and ${returnNumber} was not kept. Please try again.`
        : `Nothing was received: the stock change was rolled back, but ${returnNumber} could not be removed. Cancel it before raising the return again.`,
      removed,
    },
  };
}
