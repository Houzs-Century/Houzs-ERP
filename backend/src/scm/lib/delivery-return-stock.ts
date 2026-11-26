
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

export async function resolveDrLineWarehouses(
  sb: any,
  items: Array<{ id: string; do_item_id?: string | null }>,
  drHeaderWarehouseId: string | null,
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const doItemIds = [...new Set(items
    .map((it) => it.do_item_id ?? null)
    .filter((x): x is string => !!x))];

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
    } catch { }
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

export async function drStockInCore(sb: Db, deliveryReturnId: string, performedBy: string): Promise<DrStockResult> {
  const done = (errors: string[]): DrStockResult => ({ errors, written: [] });
  const { count: existing, error: existingErr } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_type', 'DR')
    .eq('source_doc_id', deliveryReturnId)
    .eq('movement_type', 'IN');
  if (existingErr) return done([unreadableMovementError('the stock already booked for this return', existingErr)]);
  if ((existing ?? 0) > 0) return done([]);

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

  const byKey = new Map<string, {
    warehouse_id: string; item_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number; batch_no: string | null;
  }>();
  const drKeyLine = (it: { id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }) =>
    ({ item_code: it.item_code, item_group: it.item_group ?? null, variants: it.variants ?? null, warehouse_id: lineWh.get(it.id) ?? null });
  const drKeyOf = await stockBucketKeyResolver(sb, (drHeader as { company_id?: number | null } | null)?.company_id ?? null,
    (items as Array<{ id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }>).map(drKeyLine));
  for (const it of (items as Array<{ id: string; item_code: string; description: string | null; qty_returned: number; item_group?: string | null; variants?: VariantAttrs | null; unit_cost_sen?: number | null }>)) {
    if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
    const qty = Number(it.qty_returned ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue;
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
    unit_cost_sen: m.unit_cost_sen,
    source_doc_type: 'DR' as const,
    source_doc_id: deliveryReturnId,
    source_doc_no: drNo,
    performed_by: performedBy,
    ...(m.batch_no ? { batch_no: m.batch_no } : {}),
  }));
  if (movements.length === 0) return done([]);
  const res = await writeMovements(sb, movements, (drHeader as { company_id?: number | null } | null)?.company_id ?? null);
  if (!res.ok) return done([`IN ${drNo}: ${res.reason ?? 'unknown'}`]);
  return { errors: [], written: movements };
}

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
      if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
      const qty = Number(it.qty_returned ?? 0);
      if (qty <= 0) continue;
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) continue;
      const variant_key = computeVariantKey(it.item_group ?? null, it.variants ?? null);
      const batch_no = lineBatch.get(it.id) ?? null;
      const k = `${warehouseId}::${it.item_code}::${variant_key}::${batch_no ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) { cur.qty += qty; }
      else targetByBucket.set(k, { warehouse_id: warehouseId, item_code: it.item_code, variant_key, batch_no, product_name: it.description, qty, unit_cost_sen: Number(it.unit_cost_sen ?? 0) });
    }
  }

  type Agg = { net_in: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  const addMov = (m: { movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null; batch_no?: string | null; qty: number; product_name: string | null }) => {
    const k = `${m.warehouse_id}::${m.item_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let agg = aggByBucket.get(k);
    if (!agg) { agg = { net_in: 0, product_name: m.product_name }; aggByBucket.set(k, agg); }
    const q = Number(m.qty ?? 0);
    if (m.movement_type === 'IN') agg.net_in += q;
    else if (m.movement_type === 'OUT') agg.net_in -= q;
    else if (m.movement_type === 'ADJUSTMENT') agg.net_in += q;
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
  foldTargetsIntoOwnBuckets(targetByBucket, aggByBucket.keys(), (drHeader as { company_id?: number | null }).company_id ?? null);

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
      writes.push(delta > 0
        ? { ...base, movement_type: 'IN', qty: delta, unit_cost_sen: t?.unit_cost_sen ?? 0, batch_no: batchNo }
        : { ...base, movement_type: 'OUT', qty: -delta, batch_no: batchNo });
    } else {
      writes.push({
        ...base,
        movement_type: 'ADJUSTMENT',
        qty: delta,
        unit_cost_sen: delta > 0 ? (t?.unit_cost_sen ?? 0) : 0,
      });
    }
  }
  if (writes.length === 0) return done([]);
  const wrote = await writeMovements(sb, writes, (drHeader as { company_id?: number | null } | null)?.company_id ?? null);
  if (!wrote.ok) return done(['return resync: ' + (wrote.reason ?? 'unknown')]);
  return { errors: [], written: writes };
}


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
  } catch { }
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
