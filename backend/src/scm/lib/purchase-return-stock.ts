
import { writeMovements, reverseMovementsCore, defaultWarehouseId } from './inventory-movements';
import * as bk from './stock-bucket-key';
import { hasUnreadableLines, LINES_UNREADABLE, linesUnreadableMessage, ReadFailedError, unreadableMovementError } from './failed-read-refusal';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { STOCK_TX_ROLLED_BACK, stockTxFailureBody, type StockTx, type StockTxClient } from './stock-post-tx';
import { recomputePoReceived } from '../routes/grns';
import type { VariantAttrs } from '../shared';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-condition -- the
   recount, the resolver and the OUT writer moved here verbatim from
   routes/purchase-returns.ts (counted under that file's ceiling there);
   PostgREST client, untyped rows. */
type Db = any;
type MovementRow = Parameters<typeof writeMovements>[1][number];

export type PrRecount = { ok: true } | { ok: false; reason: string };

export async function recountGrnReturned(sb: Db, grnItemId: string): Promise<PrRecount> {
  if (!grnItemId) return { ok: true };
  const { data: prLines, error: prLinesErr } = await sb.from('purchase_return_items')
    .select('qty_returned, purchase_return_id')
    .eq('grn_item_id', grnItemId);
  if (prLinesErr) {
    return { ok: false, reason: `PR line read failed — returned_qty left unchanged: ${grnItemId} ${prLinesErr.message}` };
  }
  const rows = (prLines ?? []) as Array<{ qty_returned: number; purchase_return_id: string }>;
  const prIds = [...new Set(rows.map((r) => r.purchase_return_id).filter(Boolean))];
  const cancelled = new Set<string>();
  /* HC-0221: a CREDIT return the supplier will not replace keeps the PO received. */
  const noReplacement = new Set<string>();
  if (prIds.length > 0) {
    const { data: prs, error: prsErr } = await sb.from('purchase_returns').select('id, status, kind, supplier_replaces').in('id', prIds);
    if (prsErr) {
      return { ok: false, reason: `PR status read failed — returned_qty left unchanged: ${grnItemId} ${prsErr.message}` };
    }
    for (const p of (prs ?? []) as Array<{ id: string; status: string; kind: string | null; supplier_replaces: boolean | null }>) {
      if ((p.status ?? '').toUpperCase() === 'CANCELLED' || p.kind === 'REPAIR') cancelled.add(p.id);
      else if (p.supplier_replaces === false) noReplacement.add(p.id);
    }
  }
  let returned = 0;
  let closed = 0;
  for (const r of rows) {
    if (cancelled.has(r.purchase_return_id)) continue;
    returned += Number(r.qty_returned ?? 0);
    if (noReplacement.has(r.purchase_return_id)) closed += Number(r.qty_returned ?? 0);
  }

  const { data: gi, error: giErr } = await sb.from('grn_items')
    .select('qty_accepted, purchase_order_item_id').eq('id', grnItemId).maybeSingle();
  if (giErr) return { ok: false, reason: `GRN line read failed — returned_qty left unchanged: ${grnItemId} ${giErr.message}` };
  if (!gi) return { ok: true };
  const accepted = (gi as { qty_accepted: number }).qty_accepted ?? 0;
  const next = Math.min(accepted, Math.max(0, returned));
  const nextClosed = Math.min(next, Math.max(0, closed));
  const { error: updErr } = await sb.from('grn_items').update({ returned_qty: next, returned_closed_qty: nextClosed }).eq('id', grnItemId);
  if (updErr) {
    return { ok: false, reason: `returned_qty update failed — GRN line left STALE: ${grnItemId} ${updErr.message}` };
  }
  const poItemId = (gi as { purchase_order_item_id: string | null }).purchase_order_item_id;
  if (!poItemId) return { ok: true };
  const po = await recomputePoReceived(sb, [poItemId]);
  return po.ok ? { ok: true } : { ok: false, reason: `PO received recount: ${po.reason ?? 'unknown'}` };
}

/** Every GRN line a return draws on, recounted; the first failure stops it. */
export async function recountGrnLines(sb: Db, grnItemIds: ReadonlyArray<string | null | undefined>): Promise<PrRecount> {
  for (const id of new Set(grnItemIds.filter((x): x is string => !!x))) {
    const r = await recountGrnReturned(sb, id);
    if (!r.ok) return r;
  }
  return { ok: true };
}

export async function resolvePrLineWarehouses(
  sb: any,
  items: Array<{ id: string; grn_item_id?: string | null }>,
  primaryGrnId: string | null,
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const grnItemIds = [...new Set(items
    .map((it) => it.grn_item_id ?? null)
    .filter((x): x is string => !!x))];

  const grnItemToGrn = new Map<string, string | null>();
  const grnIds = new Set<string>();
  if (grnItemIds.length > 0) {
    const { data: giRows, error: giErr } = await sb.from('grn_items')
      .select('id, grn_id').in('id', grnItemIds);
    if (giErr) throw new ReadFailedError('the receipt lines', giErr);
    for (const r of (giRows ?? []) as Array<{ id: string; grn_id: string | null }>) {
      grnItemToGrn.set(r.id, r.grn_id ?? null);
      if (r.grn_id) grnIds.add(r.grn_id);
    }
  }
  if (primaryGrnId) grnIds.add(primaryGrnId);
  const grnWh = new Map<string, string | null>();
  if (grnIds.size > 0) {
    const { data: grnRows, error: grnErr } = await sb.from('grns')
      .select('id, warehouse_id').in('id', [...grnIds]);
    if (grnErr) throw new ReadFailedError('the receipts', grnErr);
    for (const r of (grnRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      grnWh.set(r.id, r.warehouse_id ?? null);
    }
  }

  const fallback = (primaryGrnId ? grnWh.get(primaryGrnId) ?? null : null) ?? (await defaultWarehouseId(sb, companyId));
  for (const it of items) {
    const grnId = it.grn_item_id ? (grnItemToGrn.get(it.grn_item_id) ?? null) : null;
    const fromGrn = grnId ? (grnWh.get(grnId) ?? null) : null;
    out.set(it.id, fromGrn ?? fallback);
  }
  return out;
}

export type PrStockOut = { errors: string[]; wrote: boolean };
export async function prStockOutCore(sb: Db, prId: string, returnNumber: string, grnId: string | null, userId: string): Promise<PrStockOut> {
  const done = (errors: string[], wrote = false): PrStockOut => ({ errors, wrote });
  const { data: prHeader, error: prHeaderErr } = await sb.from('purchase_returns')
    .select('company_id, kind, repair_warehouse_id').eq('id', prId).maybeSingle();
  if (prHeaderErr) return done([unreadableMovementError('the purchase return', prHeaderErr)]);
  const prHead = prHeader as { company_id?: number | null; kind?: string | null; repair_warehouse_id?: string | null } | null;
  const prCompanyId = prHead?.company_id ?? null;
  const repairWarehouseId = prHead?.kind === 'REPAIR' ? (prHead.repair_warehouse_id ?? null) : null;
  const { data: items, error: itemsErr } = await sb.from('purchase_return_items')
    .select('id, grn_item_id, item_code, material_name, qty_returned, item_group, variants')
    .eq('purchase_return_id', prId);
  if (itemsErr || !items) return done(itemsErr ? [unreadableMovementError('the purchase return lines', itemsErr)] : []);
  let lineWh: Map<string, string | null>;
  try {
    lineWh = await resolvePrLineWarehouses(
      sb,
      items as Array<{ id: string; grn_item_id?: string | null }>,
      grnId,
      prCompanyId ?? undefined,
    );
  } catch (e) {
    if (e instanceof ReadFailedError) return done([e.message]);
    throw e;
  }

  const itemList = (items ?? []) as Array<{ id: string; grn_item_id?: string | null; item_code: string; material_name: string | null; qty_returned: number; item_group?: string | null; variants?: VariantAttrs | null }>;
  const lineGrnId = new Map<string, string | null>();
  {
    const giIds = [...new Set(itemList.map((it) => it.grn_item_id ?? null).filter((x): x is string => !!x))];
    const giToGrn = new Map<string, string | null>();
    if (giIds.length > 0) {
      const { data: giRows, error: giErr } = await sb.from('grn_items').select('id, grn_id').in('id', giIds);
      if (giErr) return done([unreadableMovementError('the receipt lines', giErr)]);
      for (const r of (giRows ?? []) as Array<{ id: string; grn_id: string | null }>) giToGrn.set(r.id, r.grn_id ?? null);
    }
    for (const it of itemList) {
      lineGrnId.set(it.id, (it.grn_item_id ? giToGrn.get(it.grn_item_id) : null) ?? grnId ?? null);
    }
  }
  const batchByBucket = new Map<string, string>();
  {
    const srcGrnIds = [...new Set([...lineGrnId.values()].filter((x): x is string => !!x))];
    if (srcGrnIds.length > 0) {
      let inRes = await sb.from('inventory_movements')
        .select('source_doc_id, item_code, variant_key, warehouse_id, batch_no')
        .eq('source_doc_type', 'GRN').eq('movement_type', 'IN').in('source_doc_id', srcGrnIds);
      if (inRes.error && (inRes.error.message ?? '').includes('batch_no')) {
        inRes = { data: [], error: null } as typeof inRes;
      }
      for (const m of (inRes.data ?? []) as Array<{ source_doc_id: string; item_code: string; variant_key: string | null; warehouse_id: string; batch_no?: string | null }>) {
        if (m.batch_no == null) continue;
        batchByBucket.set(`${m.source_doc_id}::${m.warehouse_id}::${m.item_code}::${bk.bucketIdFor(prCompanyId, m.variant_key)}`, m.batch_no);
      }
    }
  }

  const prKeyOf = await bk.stockBucketKeyResolver(sb, prCompanyId, itemList.map((it) => bk.stockKeyLine(it, lineWh.get(it.id) ?? null)));
  const movements = itemList
    .filter((it) => it.qty_returned > 0)
    .map((it) => {
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) return null;
      const variantKey = prKeyOf(bk.stockKeyLine(it, warehouseId));
      const srcGrn = lineGrnId.get(it.id) ?? null;
      const batchNo = srcGrn ? (batchByBucket.get(`${srcGrn}::${warehouseId}::${it.item_code}::${bk.bucketIdFor(prCompanyId, variantKey)}`) ?? null) : null;
      return {
        movement_type: 'OUT' as const,
        warehouse_id: warehouseId,
        item_code: it.item_code,
        variant_key: variantKey,
        product_name: it.material_name,
        qty: it.qty_returned,
        source_doc_type: 'PURCHASE_RETURN' as const,
        source_doc_id: prId,
        source_doc_no: returnNumber,
        ...(batchNo ? { batch_no: batchNo } : {}),
        performed_by: userId,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  const repairIns = repairWarehouseId
    ? movements.map((m) => ({ ...m, movement_type: 'IN' as const, warehouse_id: repairWarehouseId }))
    : [];
  const movementErrors: string[] = [];
  if (movements.length > 0) {
    const res = await writeMovements(sb, movements, prCompanyId);
    if (!res.ok) movementErrors.push(`OUT ${returnNumber}: ${res.reason ?? 'unknown'}`);
    if (repairIns.length > 0) {
      const inRes = await writeMovements(sb, repairIns, prCompanyId);
      if (!inRes.ok) movementErrors.push(`IN ${returnNumber}: ${inRes.reason ?? 'unknown'}`);
    }
  }
  return done(movementErrors, movements.length > 0);
}


export type PrStockFailure = { ok: false; reason: string; status: number; detail?: string };

function prCoreFailure(errors: string[]): PrStockFailure {
  return { ok: false, reason: hasUnreadableLines(errors) ? LINES_UNREADABLE : STOCK_TX_ROLLED_BACK, status: 503, detail: errors.join('; ') };
}

/** What the operator reads when an atomic return write rolled back. Nothing was written. */
export function prStockFailureBody(what: 'returned' | 'cancelled', f: { reason: string; detail?: string }): object {
  if (f.reason === LINES_UNREADABLE) {
    return { error: LINES_UNREADABLE, message: linesUnreadableMessage('the purchase return', what), ...(f.detail ? { detail: f.detail } : {}) };
  }
  return stockTxFailureBody(what, f);
}

async function prPostCore(t: Db, prId: string, returnNumber: string, grnId: string | null, userId: string, grnItemIds: ReadonlyArray<string | null | undefined>): Promise<{ ok: true; wrote: boolean } | PrStockFailure> {
  const out = await prStockOutCore(t, prId, returnNumber, grnId, userId);
  if (out.errors.length > 0) return prCoreFailure(out.errors);
  const recount = await recountGrnLines(t, grnItemIds);
  if (!recount.ok) return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, detail: `GRN returned recount: ${recount.reason}` };
  return { ok: true, wrote: out.wrote };
}

export type PrCreated = { id: string; return_number: string };

/**
 * The create's stock and ledger writes in ONE transaction: the OUT (and the
 * repair leg), each source GRN line's returned_qty / returned_closed_qty
 * (whether the supplier replaces) and the PO line received recount. The header
 * and lines were inserted POSTED before this runs, so when it rolls back no
 * stock moved and the just-created return is deleted again (lines first,
 * scoped to the company). `removed` false = the delete failed too; the body says so.
 */
export async function postCreatedPrAtomically(
  tx: StockTx, sb: Db, h: PrCreated, grnId: string | null, companyId: number | null, userId: string,
  grnItemIds: ReadonlyArray<string | null | undefined>,
): Promise<{ ok: true; wrote: boolean } | { ok: false; removed: boolean; body: object }> {
  const out = await tx((t) => prPostCore(t, h.id, h.return_number, grnId, userId, grnItemIds));
  if (out.ok) return out;
  let removed = false;
  try {
    const items = await scopeToCompanyIdOrOpen(sb.from('purchase_return_items').delete().eq('purchase_return_id', h.id), companyId);
    const head = items?.error ? items : await scopeToCompanyIdOrOpen(sb.from('purchase_returns').delete().eq('id', h.id), companyId);
    removed = !items?.error && !head?.error;
  } catch { }
  return {
    ok: false,
    removed,
    body: {
      ...(prStockFailureBody('returned', out) as object),
      message: removed
        ? `Nothing was returned: the stock change was rolled back and ${h.return_number} was not kept. Please try again.`
        : `Nothing was returned: the stock change was rolled back, but ${h.return_number} could not be removed. Cancel it before raising the return again.`,
      removed,
    },
  };
}

/** The cancel's status write (scoped CAS, refuses COMPLETED / CANCELLED). */
export type PrFlipResult = { data: { id: string } | null; error: { message: string; code?: string } | null };
export type PrFlipMiss = { ok: false; reason: 'flip'; status: 409; flip: PrFlipResult };
export type PrCancelOutcome =
  | { ok: true; reversed: number; openedLotRows: MovementRow[] }
  | PrFlipMiss
  | PrStockFailure;
export const isPrFlipMiss = (o: PrCancelOutcome): o is PrFlipMiss => !o.ok && 'flip' in o;

/**
 * The cancel in ONE transaction: the flip to CANCELLED, the reversing IN of
 * every OUT (and OUT of every repair IN) the return wrote, with the exact batch
 * and cost the OUT carried, and the GRN returned / PO received recount that
 * releases the lines. A partial reversal or a failed recount rolls the flip
 * back, so a return never reads CANCELLED with its stock still out.
 * `openedLotRows` is the after-commit retro-cost input.
 */
export async function cancelPrAtomically(tx: StockTx, prId: string, userId: string, flip: (t: StockTxClient) => Promise<PrFlipResult>): Promise<PrCancelOutcome> {
  return tx(async (t): Promise<PrCancelOutcome> => {
    const f = await flip(t);
    if (f.error || !f.data) return { ok: false, reason: 'flip', status: 409, flip: f };
    const rev = await reverseMovementsCore(t, 'PURCHASE_RETURN', prId, userId);
    if (!rev.ok) {
      return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, detail: `stock reversal: ${rev.reversed} reversed, ${rev.failed} failed${rev.reason ? ` (${rev.reason})` : ''}` };
    }
    const { data: lines, error: linesErr } = await t.from('purchase_return_items').select('grn_item_id').eq('purchase_return_id', prId);
    if (linesErr) return prCoreFailure([unreadableMovementError('the purchase return lines', linesErr)]);
    const recount = await recountGrnLines(t, ((lines ?? []) as Array<{ grn_item_id: string | null }>).map((l) => l.grn_item_id));
    if (!recount.ok) return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, detail: `GRN returned recount: ${recount.reason}` };
    return { ok: true, reversed: rev.reversed, openedLotRows: rev.openedLotRows };
  });
}
