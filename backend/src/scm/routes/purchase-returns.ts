
import { yymmFor } from '../../services/documentRefs';
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { repairHeldQty, editLineCapRefusal, addLineCapRefusal } from '../lib/purchase-return-repair-held';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { writeMovements, reverseMovements } from '../lib/inventory-movements';
import { cancelPrAtomically, isPrFlipMiss, postCreatedPrAtomically, prStockFailureBody, prStockOutCore, recountGrnReturned, resolvePrLineWarehouses, type PrCreated, type PrFlipResult } from '../lib/purchase-return-stock';
import { stockTxFor } from '../lib/stock-post-tx';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { warehouseLabel } from '../lib/warehouse-label';
import { buildVariantSummary, computeVariantKey, type VariantAttrs } from '../shared';
import * as bk from '../lib/stock-bucket-key';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { resolvePoBatchByItem } from './grns';
import { assertSourceLinesInCompany } from '../lib/ref-in-company';
import { assertLinkedLineItemsMatch } from '../lib/line-link-item-identity';
import { findUnlinkedPrLines, unlinkedReturnResponse } from '../lib/return-unlinked-lines';
import { unlinkedEditRefusal, unlinkedScanRefusal } from '../lib/unlinked-line-edit-guard';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
  isCrossCompanySource, crossCompanyConversionBlocked } from '../lib/companyScope';
import {
  checkStockAvailability,
  shortStockResponse,
  type StockLineRequest,
  type StockShortage,
} from '../lib/check-stock-availability';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';
import { recordEntityAudit } from '../lib/entity-audit';
import { buildReturnablePool, buildPiReturnablePool, type GrnLineRow } from '../lib/returnable-grn-lines';
import {
  isPurchaseReturnReasonCode, isPurchaseReturnKind, kindMatchesReason,
  PURCHASE_RETURN_REASON_CODES,
} from '../shared/purchase-return-reasons';
import { chunkIn } from '../lib/paginate-all';
import { linesUnreadableBody } from '../lib/failed-read-refusal';
import {
  PR_HEADER_COLS,
  PR_LIST_SELECT,
  attachPurchaseReturnLines,
  filterPurchaseReturnList,
  orderPurchaseReturnList,
  readPurchaseReturnListFilters,
  type PrLineHeader,
} from '../lib/purchase-return-list-read';

export const purchaseReturns = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseReturns.use('*', supabaseAuth);

const HEADER = PR_HEADER_COLS;
const ITEM =
  'id, purchase_return_id, grn_item_id, material_kind, item_code, ' +
  'material_name, qty_returned, unit_price_sen, line_refund_sen, reason, notes, ' +
  'item_group, variants, created_at';

const nextNum = async (sb: any, c: any): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'purchase_returns', 'return_number', `${p}PRT-${yymm}`);
};

async function recomputePrTotals(sb: any, prId: string) {
  const { data: items, error: itemsErr } = await sb.from('purchase_return_items')
    .select('line_refund_sen')
    .eq('purchase_return_id', prId);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pr-recompute] item read failed — header left unchanged:', prId, itemsErr.message);
    return;
  }
  const refund = (items ?? []).reduce((s: number, r: any) => s + (r.line_refund_sen ?? 0), 0);
  const { error: updErr } = await sb.from('purchase_returns').update({
    refund_sen: refund,
    updated_at: new Date().toISOString(),
  }).eq('id', prId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pr-recompute] header update failed — refund left STALE:', prId, updErr.message);
  }
}

export async function adjustGrnReturnedQty(sb: any, grnItemId: string, _delta?: number) {
  const r = await recountGrnReturned(sb, grnItemId);
  /* eslint-disable-next-line no-console */
  if (!r.ok) console.error('[adjustGrnReturnedQty]', r.reason);
}

export async function purchaseReturnListHandler(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const sb = c.get('supabase');
  const filters = readPurchaseReturnListFilters((k) => c.req.query(k));
  const { data, error } = await orderPurchaseReturnList(
    filterPurchaseReturnList(sb.from('purchase_returns').select(PR_LIST_SELECT), filters, c),
  ).limit(300);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const attached = await attachPurchaseReturnLines(sb, c, (data ?? []) as unknown as PrLineHeader[]);
  if (attached.error !== null) return c.json({ error: 'load_failed', reason: attached.error }, 500);
  return c.json({ purchaseReturns: attached.rows });
}
purchaseReturns.get('/', purchaseReturnListHandler);

/* The lines a PO-sourced return may draw from (2026-08-21, audit B6). The PO
   detail's "Raise Return" used to prefill the PO's OWN lines with no
   grn_item_id — which made every line "manual": uncapped, consuming nothing,
   and deducting the company DEFAULT warehouse instead of the receiving one. A
   return of received goods draws from RECEIPTS, so this read answers the
   POSTED GRN lines received against the PO with remaining (accepted − returned)
   above zero — the same pool /from-grn offers, keyed by PO.

   KEYED ON THE LINE LINK since 2026-09-28 (owner, HC-PO-010114: 「系统找不到 GRN
   - 但是现实已经received stock」). Matching `grns.purchase_order_id` alone hid
   every unit received on a receipt HEADED at another purchase order — the same
   header-FK-only blind spot #4199 fixed for the PO list and the relationship
   map. One receipt carrying several suppliers' orders is deliberate here (one
   group, one lorry), so the line link is the truth and the supplier answered is
   the PO's own. Rules + the legacy header case: lib/returnable-grn-lines.ts.
   Registered BEFORE '/:id' or that route swallows the literal path. */
purchaseReturns.get('/returnable-grn-lines', async (c) => {
  const sb = c.get('supabase');
  const poId = c.req.query('poId');
  if (!poId) return c.json({ error: 'po_id_required' }, 400);

  /* The purchase order itself — scoped, so another company's PO answers no row
     and this read can say nothing about it. Its supplier is the one the return
     is raised against: the goods were bought on THIS order, whoever's receipt
     they happened to arrive on (owner 2026-09-28 — one lorry, one receipt, two
     suppliers, deliberately). The old read answered the RECEIPT's supplier,
     which on a shared receipt is the wrong counterparty to send goods back to. */
  const { data: poRow, error: poErr } = await scopeToCompany(sb.from('purchase_orders')
    .select('id, supplier_id')
    .eq('id', poId), c).maybeSingle();
  if (poErr) return c.json({ error: 'load_failed', reason: poErr.message }, 500);
  if (!poRow) return c.json({ error: 'po_not_found' }, 404);
  const supplierId = (poRow as { supplier_id: string | null }).supplier_id ?? null;

  const { data: poItems, error: piErr } = await sb.from('purchase_order_items')
    .select('id').eq('purchase_order_id', poId);
  if (piErr) return c.json({ error: 'load_failed', reason: piErr.message }, 500);
  const poItemIds = new Set(((poItems ?? []) as Array<{ id: string }>).map((r) => r.id));

  const { data: headerGrns, error: hgErr } = await scopeToCompany(sb.from('grns')
    .select('id, grn_number, status')
    .eq('purchase_order_id', poId)
    .eq('status', 'POSTED'), c);
  if (hgErr) return c.json({ error: 'load_failed', reason: hgErr.message }, 500);
  const headerGrnIds = new Set(((headerGrns ?? []) as Array<{ id: string }>).map((g) => g.id));

  const rows: GrnLineRow[] = [];
  if (poItemIds.size > 0) {
    const { data, error } = await chunkIn([...poItemIds], (batch, from, to) =>
      sb.from('grn_items').select('id, grn_id, purchase_order_item_id, material_kind, item_code, material_name, item_group, variants, qty_accepted, returned_qty, unit_price_sen, rejection_reason').in('purchase_order_item_id', batch).range(from, to));
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    rows.push(...((data ?? []) as GrnLineRow[]));
  }
  if (headerGrnIds.size > 0) {
    const { data, error } = await chunkIn([...headerGrnIds], (batch, from, to) =>
      sb.from('grn_items').select('id, grn_id, purchase_order_item_id, material_kind, item_code, material_name, item_group, variants, qty_accepted, returned_qty, unit_price_sen, rejection_reason').in('grn_id', batch).is('purchase_order_item_id', null).range(from, to));
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    rows.push(...((data ?? []) as GrnLineRow[]));
  }
  if (rows.length === 0) return c.json({ lines: [], supplierId });

  const grnIds = [...new Set(rows.map((r) => r.grn_id))];
  const { data: grnRows, error: gErr } = await chunkIn(grnIds, (batch, from, to) =>
    scopeToCompany(sb.from('grns').select('id, grn_number, status').in('id', batch), c).range(from, to));
  if (gErr) return c.json({ error: 'load_failed', reason: gErr.message }, 500);
  const postedGrnNumberById = new Map<string, string>();
  for (const g of ((grnRows ?? []) as Array<{ id: string; grn_number: string; status: string }>)) {
    if (g.status === 'POSTED') postedGrnNumberById.set(g.id, g.grn_number);
  }

  const lines = buildReturnablePool(rows, postedGrnNumberById, poItemIds, headerGrnIds);
  return c.json({ lines, supplierId });
});

/* HC-0227 (Sim, AutoCount in hand: "Transfer to new Purchase Return" from a
   Purchase Invoice). The pool is the receipt lines this invoice's LINES bill,
   capped at what this invoice bills for each; the supplier is the invoice's.
   Invoice-only lines (no receipt behind them) were never received, so they
   cannot go back. Registered BEFORE '/:id' or that route swallows the path. */
purchaseReturns.get('/returnable-pi-lines', async (c) => {
  const sb = c.get('supabase');
  const piId = c.req.query('piId');
  if (!piId) return c.json({ error: 'pi_id_required' }, 400);

  const { data: piRow, error: piErr } = await scopeToCompany(sb.from('purchase_invoices')
    .select('id, invoice_number, supplier_id, purchase_order_id')
    .eq('id', piId), c).maybeSingle();
  if (piErr) return c.json({ error: 'load_failed', reason: piErr.message }, 500);
  if (!piRow) return c.json({ error: 'pi_not_found' }, 404);
  const pi = piRow as { invoice_number: string; supplier_id: string | null; purchase_order_id: string | null };

  const { data: piLines, error: plErr } = await sb.from('purchase_invoice_items')
    .select('grn_item_id, qty').eq('purchase_invoice_id', piId).not('grn_item_id', 'is', null);
  if (plErr) return c.json({ error: 'load_failed', reason: plErr.message }, 500);
  const invoicedQtyByGrnItem = new Map<string, number>();
  for (const l of (piLines as Array<{ grn_item_id: string; qty: number | null }>)) {
    invoicedQtyByGrnItem.set(l.grn_item_id, (invoicedQtyByGrnItem.get(l.grn_item_id) ?? 0) + Number(l.qty ?? 0));
  }
  const empty = { lines: [], invoiceNumber: pi.invoice_number, supplierId: pi.supplier_id, purchaseOrderId: pi.purchase_order_id };
  if (invoicedQtyByGrnItem.size === 0) return c.json(empty);

  const { data: rowData, error: rErr } = await chunkIn([...invoicedQtyByGrnItem.keys()], (batch, from, to) =>
    sb.from('grn_items').select('id, grn_id, purchase_order_item_id, material_kind, item_code, material_name, item_group, variants, qty_accepted, returned_qty, unit_price_sen, rejection_reason').in('id', batch).range(from, to));
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
  const rows = rowData as GrnLineRow[];
  if (rows.length === 0) return c.json(empty);

  const grnIds = [...new Set(rows.map((r) => r.grn_id))];
  const { data: grnRows, error: gErr } = await chunkIn(grnIds, (batch, from, to) =>
    scopeToCompany(sb.from('grns').select('id, grn_number, status').in('id', batch), c).range(from, to));
  if (gErr) return c.json({ error: 'load_failed', reason: gErr.message }, 500);
  const postedGrnNumberById = new Map<string, string>();
  for (const g of (grnRows as Array<{ id: string; grn_number: string; status: string }>)) {
    if (g.status === 'POSTED') postedGrnNumberById.set(g.id, g.grn_number);
  }

  const lines = buildPiReturnablePool(rows, postedGrnNumberById, invoicedQtyByGrnItem);
  return c.json({ ...empty, lines });
});

purchaseReturns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('purchase_returns')
      .select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, email2, email3, address), purchase_order:purchase_orders(id, po_number), grn:grns(id, grn_number)`)
      .eq('id', id), c).maybeSingle(),
    sb.from('purchase_return_items').select(ITEM).eq('purchase_return_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  type PrItemRow = Record<string, unknown> & { id: string; grn_item_id?: string | null; item_code: string };
  const rawItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((i.data ?? []) as unknown as Array<{ id: string; grn_item_id?: string | null; item_code: string } & Record<string, unknown>>)
        .map((it): PrItemRow => ({ ...it, item_code: it.item_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  const headerGrnId = (h.data as { grn_id?: string | null }).grn_id ?? null;
  const lineWh = await resolvePrLineWarehouses(sb, rawItems, headerGrnId, activeCompanyId(c));
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    return { ...it, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
  });
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ purchaseReturn: h.data, items });
});

purchaseReturns.get('/:id/linked', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await scopeToCompany(
    sb
      .from('purchase_returns')
      .select(`
        id,
        grn:grns(id, grn_number),
        purchase_order:purchase_orders(id, po_number)
      `)
      .eq('id', id),
    c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const raw = data as unknown as {
    grn?: { id: string; grn_number: string } | Array<{ id: string; grn_number: string }> | null;
    purchase_order?: { id: string; po_number: string } | Array<{ id: string; po_number: string }> | null;
  };
  const grn: { id: string; grn_number: string } | null =
    Array.isArray(raw.grn) ? (raw.grn[0] ?? null) : (raw.grn ?? null);
  const po: { id: string; po_number: string } | null =
    Array.isArray(raw.purchase_order) ? (raw.purchase_order[0] ?? null) : (raw.purchase_order ?? null);
  return c.json({ grn, purchaseOrder: po });
});

export async function writePurchaseReturnMovements(sb: any, prId: string, returnNumber: string, grnId: string | null, userId: string): Promise<string[]> {
  const out = await prStockOutCore(sb, prId, returnNumber, grnId, userId);
  if (out.wrote) await afterPrStockOut(sb);
  return out.errors;
}
async function afterPrStockOut(sb: any): Promise<void> {
  try {
    const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'post-pr');
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-pr-post failed:', e); }
}

async function postCreatedPr(c: any, sb: any, h: PrCreated, grnId: string | null, userId: string, grnItemIds: Array<string | null | undefined>): Promise<{ refused: Response } | { done: true } | null> {
  const prTx = stockTxFor(c.env, 'PURCHASE_RETURN_MODE');
  if (!prTx) return null;
  const out = await postCreatedPrAtomically(prTx, sb, h, grnId, activeCompanyId(c) ?? null, userId, grnItemIds);
  if (!out.ok) {
    if (out.removed) markIdempotencyNoWrite(c);
    return { refused: c.json(out.body, 503) };
  }
  if (out.wrote) await afterPrStockOut(sb);
  return { done: true };
}

async function warehouseCodeMap(
  sb: any,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return out;
  const { data } = await sb.from('warehouses').select('id, code, name').in('id', uniq);
  for (const w of (data ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
    out.set(w.id, warehouseLabel(w) ?? '');
  }
  return out;
}


async function checkPrStockAvailability(
  sb: any,
  lines: Array<{
    id: string; grn_item_id?: string | null; item_code: string;
    material_name?: string | null; item_group?: string | null;
    variants?: VariantAttrs | null; qty: number;
  }>,
  headerGrnId: string | null,
  companyId: number | undefined,
): Promise<StockShortage[]> {
  const active = lines.filter((l) => Number(l.qty) > 0);
  if (active.length === 0) return [];
  const lineWh = await resolvePrLineWarehouses(
    sb, active.map((l) => ({ id: l.id, grn_item_id: l.grn_item_id ?? null })), headerGrnId, companyId,
  );
  const byWh = new Map<string, StockLineRequest[]>();
  for (const l of active) {
    const wh = lineWh.get(l.id) ?? null;
    if (!wh) continue;
    const arr = byWh.get(wh) ?? [];
    arr.push({
      itemCode: l.item_code,
      productName: l.material_name ?? null,
      variantKey: computeVariantKey(l.item_group ?? null, l.variants ?? null),
      qty: Number(l.qty),
    });
    byWh.set(wh, arr);
  }
  const shortages: StockShortage[] = [];
  for (const [wh, reqs] of byWh) {
    shortages.push(...(await checkStockAvailability(sb, wh, reqs, companyId)));
  }
  return shortages;
}

async function writePrLineDeltaMovement(
  sb: any,
  args: {
    prId: string; returnNumber: string; headerGrnId: string | null; userId: string;
    companyId: number | undefined;
    line: { id: string; grn_item_id?: string | null; item_code: string;
            material_name: string | null; item_group?: string | null; variants?: VariantAttrs | null };
    deltaQty: number;
  },
): Promise<string[]> {
  if (!args.deltaQty) return [];
  const isOut = args.deltaQty > 0;
  const dir = isOut ? 'OUT' : 'IN';
  let wrote = false;
  try {
    const lineWh = await resolvePrLineWarehouses(
      sb, [{ id: args.line.id, grn_item_id: args.line.grn_item_id ?? null }], args.headerGrnId, args.companyId,
    );
    const warehouseId = lineWh.get(args.line.id) ?? null;
    if (!warehouseId) return [];
    const variantKey = isOut ? await bk.stockBucketKeyOne(sb, args.companyId ?? null, bk.stockKeyLine(args.line, warehouseId)) : await bk.ownDocBucketKey(sb, { type: 'PURCHASE_RETURN', id: args.prId, movement: 'OUT', companyId: args.companyId ?? null }, args.line.item_code, computeVariantKey(args.line.item_group, args.line.variants ?? null));
    let batchNo: string | null = null;
    if (args.line.grn_item_id) {
      const { data: gi } = await sb.from('grn_items')
        .select('purchase_order_item_id').eq('id', args.line.grn_item_id).maybeSingle();
      const poItemId = (gi as { purchase_order_item_id: string | null } | null)?.purchase_order_item_id ?? null;
      if (poItemId) batchNo = (await resolvePoBatchByItem(sb, [poItemId])).get(poItemId) ?? null;
    }
    let unitCostSen = 0;
    if (!isOut) {
      const inRes = await sb.from('inventory_movements')
        .select('unit_cost_sen')
        .eq('source_doc_type', 'PURCHASE_RETURN').eq('source_doc_id', args.prId)
        .eq('movement_type', 'OUT').eq('warehouse_id', warehouseId)
        .eq('item_code', args.line.item_code).eq('variant_key', variantKey)
        .limit(1);
      const row = ((inRes.data ?? []) as Array<{ unit_cost_sen?: number | null }>)[0];
      unitCostSen = Number(row?.unit_cost_sen ?? 0);
    }
    const { data: prHeader } = await sb.from('purchase_returns')
      .select('company_id').eq('id', args.prId).maybeSingle();
    const deltaRows: Parameters<typeof writeMovements>[1] = [{
      movement_type: isOut ? 'OUT' : 'IN',
      warehouse_id: warehouseId,
      item_code: args.line.item_code,
      variant_key: variantKey,
      product_name: args.line.material_name,
      qty: Math.abs(args.deltaQty),
      ...(isOut ? {} : { unit_cost_sen: unitCostSen }),
      ...(batchNo ? { batch_no: batchNo } : {}),
      source_doc_type: 'PURCHASE_RETURN' as const,
      source_doc_id: args.prId,
      source_doc_no: args.returnNumber,
      performed_by: args.userId,
      notes: isOut ? 'PR line added/increased' : 'PR line reduced/removed — reversing return',
    }];
    const movementCompanyId = (prHeader as { company_id?: number | null } | null)?.company_id ?? null;
    const res = await writeMovements(sb, deltaRows, movementCompanyId);
    if (!res.ok) {
      /* eslint-disable-next-line no-console */
      console.error('[pr-line-delta] stock movement NOT written — PR line changed, inventory did not:',
        args.returnNumber, 'line', args.line.id, dir, Math.abs(args.deltaQty), res.reason ?? 'unknown');
      try {
        await recordEntityAudit(sb, {
          entityType: 'PURCHASE_RETURN',
          entityId: args.prId,
          entityDocNo: args.returnNumber,
          action: 'RECOUNT_FAILED',
          companyId: movementCompanyId ?? args.companyId ?? null,
          source: 'writePrLineDeltaMovement',
          note:
            `Line change committed on this return but its ${dir} delta movement ` +
            `(qty ${Math.abs(args.deltaQty)}, line ${args.line.id}) was NOT written: ${res.reason ?? 'unknown'}. ` +
            `The ledger does not reflect this change until /inventory/reconcile repairs it.`,
        });
      } catch { }
      return [`${dir} ${args.returnNumber}: ${res.reason ?? 'unknown'}`];
    }
    wrote = true;
    await reconcileUncostedAfterIn(sb, deltaRows, args.userId);
    try {
      const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
      await recomputeAllocationAfterSave(sb, 'post-pr-line-delta');
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-pr-line-delta failed:', e); }
    return [];
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.error('[pr-line-delta] movement failed:', e);
    return wrote ? [] : [`${dir} ${args.returnNumber}: ${(e as Error)?.message ?? 'unknown'}`];
  }
}

purchaseReturns.post('/', async (c) => {
  /* company-scope: the source GRN is checked against the active company below
     (header grnId AND every line's grn_item_id, via isCrossCompanySource), and
     the only by-id write is the ROLLBACK of the header this handler inserted
     moments earlier. Verified 2026-08-13. */
  const refuse = (status: 400 | 404 | 409 | 500, bodyOut: object) => { markIdempotencyNoWrite(c); return c.json(bodyOut, status); };
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return refuse(400, { error: 'invalid_json' }); }
  if (body.status === 'DRAFT') return refuse(400, { error: 'draft_status_not_supported', message: 'DRAFT was removed in migration 0078 — PRs post immediately on create.' });
  if (!body.supplierId) return refuse(400, { error: 'supplier_required' });
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return refuse(400, { error: 'items_required' });

  /* WHY a return happens is now part of raising one (owner 2026-09-28: 「when
     raise purchase return need input reason and put in remark」). A CODE from
     the shared catalogue, so the answers can be counted later; the operator's
     own words ride in `notes` beside it, and the per-line `reason` stays free
     text for the one line that differs. Refused HERE, before any write: a
     return that cannot say why is the document nobody can read six months on. */
  const reasonCode = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reasonCode) return refuse(400, { error: 'reason_required', message: 'Pick a reason for the return.' });
  if (!isPurchaseReturnReasonCode(reasonCode)) {
    return refuse(400, {
      error: 'reason_invalid',
      message: `Not a return reason. One of: ${PURCHASE_RETURN_REASON_CODES.join(', ')}.`,
    });
  }

  const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'CREDIT';
  if (!isPurchaseReturnKind(kind)) return refuse(400, { error: 'kind_invalid', message: 'A return is CREDIT or REPAIR.' });
  if (!kindMatchesReason(kind, reasonCode)) {
    return refuse(400, {
      error: 'kind_reason_mismatch',
      message: kind === 'REPAIR'
        ? 'The reason for a repair return is Send for repair.'
        : 'Send for repair is the reason for a repair return — switch the type.',
    });
  }

  const repairWarehouseId = typeof body.repairWarehouseId === 'string' && body.repairWarehouseId
    ? body.repairWarehouseId : null;
  if (kind === 'REPAIR' && !repairWarehouseId) {
    return refuse(400, { error: 'repair_warehouse_required', message: 'Say which warehouse holds the goods while they are being repaired.' });
  }
  if (kind !== 'REPAIR' && repairWarehouseId) {
    return refuse(400, { error: 'repair_warehouse_not_applicable', message: 'Only a repair return names a repair warehouse.' });
  }

  const sb = c.get('supabase'); const user = c.get('user');

  if (body.grnId) {
    const { data: srcGrn, error: srcErr } = await sb.from('grns')
      .select('grn_number, company_id, status').eq('id', body.grnId as string).maybeSingle();
    if (srcErr) { markIdempotencyNoWrite(c); return c.json({ error: 'source_check_failed', reason: srcErr.message }, 500); }
    const src = srcGrn as { grn_number?: string | null; company_id?: number | null; status?: string | null } | null;
    if (!src) { markIdempotencyNoWrite(c); return c.json({ error: 'grn_not_found' }, 404); }
    if (isCrossCompanySource(src.company_id, c)) {
      markIdempotencyNoWrite(c);
      return c.json(crossCompanyConversionBlocked(src.grn_number ?? null, src.company_id, c), 409);
    }
    if (src.status !== 'POSTED') {
      markIdempotencyNoWrite(c);
      return c.json({ error: 'grn_not_posted', status: src.status ?? null }, 409);
    }
  }

  {
    const unlinked = await findUnlinkedPrLines(
      sb,
      (body.grnId as string | undefined) ?? null,
      (body.grnNumber as string | undefined) ?? null,
      items.map((it, idx) => ({
        lineRef: String(idx),
        itemCode: String(it.itemCode ?? ''),
        qty: Number(it.qtyReturned ?? it.qty ?? 0),
        soItemId: (it.grnItemId as string | undefined) ?? null,
      })),
    );
    const bad = unlinkedScanRefusal(unlinked, (o) => unlinkedReturnResponse(o, 'purchase'));
    if (bad) return refuse(409, bad);
  }

  const preGrnItemIds = [...new Set(items
    .map((it) => (it.grnItemId as string | undefined) ?? null)
    .filter((x): x is string => !!x))];
  const remainingByGrnItem = new Map<string, number>();
  if (preGrnItemIds.length > 0) {
    const { data: giRows, error: giErr } = await sb.from('grn_items')
      .select('id, qty_accepted, returned_qty, grn:grns!inner ( grn_number, company_id, status )').in('id', preGrnItemIds);
    if (giErr) { markIdempotencyNoWrite(c); return c.json({ error: 'cap_check_failed', reason: giErr.message }, 500); }
    type GiRow = {
      id: string; qty_accepted: number; returned_qty: number;
      grn?: { grn_number?: string | null; company_id?: number | null; status?: string | null } | Array<{ grn_number?: string | null; company_id?: number | null; status?: string | null }> | null;
    };
    const giList = (giRows ?? []) as unknown as GiRow[];
    const parentOf = (g: GiRow) => (Array.isArray(g.grn) ? g.grn[0] : g.grn) ?? null;
    const foreign = giList.find((g) => isCrossCompanySource(parentOf(g)?.company_id, c));
    if (foreign) {
      const p = parentOf(foreign);
      markIdempotencyNoWrite(c);
      return c.json(crossCompanyConversionBlocked(p?.grn_number ?? null, p?.company_id, c), 409);
    }
    const badParent = giList.find((g) => (parentOf(g)?.status ?? null) !== 'POSTED');
    if (badParent) {
      const p = parentOf(badParent);
      markIdempotencyNoWrite(c);
      return c.json({ error: 'grn_not_posted', grnNumber: p?.grn_number ?? null, status: p?.status ?? null }, 409);
    }
    const repairHeld = await repairHeldQty(sb, preGrnItemIds, null);
    if (!repairHeld) { markIdempotencyNoWrite(c); return c.json({ error: 'cap_check_failed', reason: 'repair returns unreadable' }, 500); }
    for (const r of giList) {
      remainingByGrnItem.set(r.id, Math.max(0, (r.qty_accepted ?? 0) - (r.returned_qty ?? 0) - (repairHeld.get(r.id) ?? 0)));
    }
    const missing = preGrnItemIds.find((id) => !remainingByGrnItem.has(id));
    if (missing) { markIdempotencyNoWrite(c); return c.json({ error: 'grn_item_not_found', grnItemId: missing }, 409); }
  }
  for (const it of items) {
    const grnItemId = (it.grnItemId as string | undefined) ?? null;
    if (!grnItemId) continue;
    const requested = Number(it.qtyReturned ?? 0);
    const remaining = remainingByGrnItem.get(grnItemId) ?? 0;
    if (requested > remaining) {
      markIdempotencyNoWrite(c);
      return c.json({ error: 'qty_exceeds_remaining', requested, remaining }, 409);
    }
  }

  /* IDENTITY, not just the key — docs/bugs/0672 site 15. The checks around this
     one prove the GRN line's company, that its parent receipt is POSTED and that
     the returned quantity fits; none proves it is the SAME PRODUCT.
     `adjustGrnReturnedQty` writes `grn_items.returned_qty` by `.eq('id', …)` and
     `writePurchaseReturnMovements` books the stock OUT from this line, so a
     wrong link returns stock against the wrong receipt line. */
  {
    const idc = await assertLinkedLineItemsMatch(sb, 'grn_items',
      items.map((it) => ({ linkId: (it.grnItemId as string | undefined) ?? null, itemCode: it.itemCode })),
      { source: 'Goods Receipt line' });
    if (!idc.ok) { markIdempotencyNoWrite(c); return c.json(idc.body, idc.status); }
  }

  let totalRefund = 0;
  const itemRows = items.map((it) => {
    const grnItemId = (it.grnItemId as string | undefined) ?? null;
    const qty = Number(it.qtyReturned ?? 0);
    const unit = Number(it.unitPriceSen ?? 0);
    const lineRefund = qty * unit;
    totalRefund += lineRefund;
    return {
      grn_item_id: grnItemId,
      material_kind: it.materialKind,
      item_code: it.itemCode,
      material_name: it.materialName,
      qty_returned: qty,
      unit_price_sen: unit,
      line_refund_sen: lineRefund,
      reason: (it.reason as string | undefined) ?? null,
      notes: (it.notes as string | undefined) ?? null,
      item_group: (it.itemGroup as string | null | undefined) ?? null,
      variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
    };
  }).filter((r) => Number(r.qty_returned) > 0);

  if (itemRows.length === 0) {
    return refuse(400, { error: 'no_returnable_qty', message: 'No line in this request carries a quantity to return. Enter a quantity above zero on at least one line.' });
  }

  const grnId = (body.grnId as string | undefined) ?? null;

  if (!(body.confirmShortStock as boolean | undefined)) {
    const shortages = await checkPrStockAvailability(
      sb,
      itemRows.map((r, idx) => ({
        id: `new-${idx}`,
        grn_item_id: r.grn_item_id,
        item_code: String(r.item_code),
        material_name: (r.material_name as string | null | undefined) ?? null,
        item_group: r.item_group,
        variants: r.variants as VariantAttrs | null,
        qty: Number(r.qty_returned),
      })),
      grnId,
      activeCompanyId(c),
    );
    if (shortages.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(shortStockResponse(shortages), 409);
    }
  }

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('purchase_returns').insert({
    company_id: activeCompanyId(c),
    return_number: returnNumber,
    purchase_order_id: (body.purchaseOrderId as string | undefined) ?? null,
    grn_id: grnId,
    supplier_id: body.supplierId,
    return_date: dateOrNull(body.returnDate) ?? todayMyt(),
    reason: reasonCode,
    kind,
    repair_warehouse_id: repairWarehouseId,
    supplier_replaces: kind === 'REPAIR' || body.supplierReplaces !== false,
    refund_sen: totalRefund,
    notes: (body.notes as string | undefined) ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rowsWithId = itemRows.map((r) => ({ ...r, purchase_return_id: h.id }));
  const { error: iErr } = await sb.from('purchase_return_items').insert(stampCompany(rowsWithId, c));
  if (iErr) {
    await sb.from('purchase_returns').delete().eq('id', h.id);
    return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  }

  {
    const linkedIds = [...new Set(rowsWithId.map((r) => r.grn_item_id).filter((x): x is string => !!x))];
    if (linkedIds.length > 0) {
      const rollback = async () => {
        await sb.from('purchase_return_items').delete().eq('purchase_return_id', h.id);
        await sb.from('purchase_returns').delete().eq('id', h.id);
        markIdempotencyNoWrite(c);
      };
      const { data: caps, error: capErr } = await sb.from('grn_items')
        .select('id, qty_accepted').in('id', linkedIds);
      const { data: sib, error: sibErr } = await sb.from('purchase_return_items')
        .select('grn_item_id, qty_returned, pr:purchase_returns!inner ( status )').in('grn_item_id', linkedIds);
      if (capErr || sibErr) {
        await rollback();
        return c.json({ error: 'over_return_recheck_failed', reason: (capErr ?? sibErr)?.message }, 500);
      }
      const capById = new Map(((caps ?? []) as Array<{ id: string; qty_accepted: number }>)
        .map((r) => [r.id, Number(r.qty_accepted ?? 0)]));
      const liveById = new Map<string, number>();
      for (const r of (sib ?? []) as Array<{ grn_item_id: string; qty_returned: number; pr?: { status?: string } | Array<{ status?: string }> | null }>) {
        const st = (Array.isArray(r.pr) ? r.pr[0] : r.pr)?.status ?? '';
        if (st === 'CANCELLED') continue;
        liveById.set(r.grn_item_id, (liveById.get(r.grn_item_id) ?? 0) + Number(r.qty_returned ?? 0));
      }
      const broken = linkedIds.find((id) => (liveById.get(id) ?? 0) > (capById.get(id) ?? 0));
      if (broken) {
        await rollback();
        return c.json({
          error: 'qty_exceeds_remaining',
          grnItemId: broken,
          message: 'Another return consumed this receipt line at the same moment — nothing was written; re-check the remaining quantity and submit again.',
        }, 409);
      }
    }
  }

  const atomic = await postCreatedPr(c, sb, h, grnId, user.id, itemRows.map((r) => r.grn_item_id));
  if (atomic && 'refused' in atomic) return atomic.refused;
  let movementErrors: string[] = [];
  if (!atomic) {
    movementErrors = await writePurchaseReturnMovements(sb, h.id, h.return_number, grnId, user.id);
    for (const r of itemRows) {
      if (r.grn_item_id) await adjustGrnReturnedQty(sb, r.grn_item_id, Number(r.qty_returned));
    }
  }

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

export const createPurchaseReturnFromGrnsHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: both source reads below are SCOPED, so another company's GRN
     is not visible here at all; the by-id write is this handler's own rollback. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { grnIds?: string[]; reason?: string; notes?: string; confirmShortStock?: boolean; supplierReplaces?: boolean };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const grnIds = body.grnIds ?? [];
  if (grnIds.length === 0) return c.json({ error: 'grn_ids_required' }, 400);

  const { data: grns, error: grnErr } = await scopeToCompany(sb.from('grns')
    .select('id, grn_number, supplier_id, purchase_order_id, status, company_id')
    .in('id', grnIds), c);
  if (grnErr) { markIdempotencyNoWrite(c); return c.json({ error: 'load_failed', reason: grnErr.message }, 500); }
  const grnList = (grns ?? []) as Array<{ id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; company_id?: number | null }>;
  if (grnList.length === 0) { markIdempotencyNoWrite(c); return c.json({ error: 'grns_not_found' }, 404); }

  const notPosted = grnList.filter((g) => g.status !== 'POSTED');
  if (notPosted.length > 0) {
    markIdempotencyNoWrite(c);
    return c.json({ error: 'not_all_posted', message: `These GRNs are not POSTED: ${notPosted.map((g) => g.grn_number).join(', ')}` }, 400);
  }
  const supplierIds = new Set(grnList.map((g) => g.supplier_id));
  if (supplierIds.size > 1) {
    return c.json({ error: 'mixed_suppliers', message: 'All selected GRNs must be from the same supplier' }, 400);
  }
  const supplierId = [...supplierIds][0]!;

  const { data: items } = await scopeToCompany(sb.from('grn_items')
    .select('id, grn_id, material_kind, item_code, material_name, qty_accepted, qty_rejected, returned_qty, rejection_reason, unit_price_sen, item_group, variants, description, description2, uom')
    .in('grn_id', grnIds)
    .gt('qty_rejected', 0), c);
  const heldA = await repairHeldQty(sb, ((items ?? []) as Array<{ id: string }>).map((i) => i.id), null);
  if (!heldA) { markIdempotencyNoWrite(c); return c.json({ error: 'cap_check_failed', reason: 'repair returns unreadable' }, 500); }
  const rejectedItems = ((items ?? []) as Array<{
    id: string; grn_id: string; material_kind: string; item_code: string; material_name: string;
    qty_accepted: number; qty_rejected: number; returned_qty: number; rejection_reason: string | null; unit_price_sen: number;
    item_group: string | null; variants: Record<string, unknown> | null; description: string | null; description2: string | null; uom: string | null;
  }>)
    .map((it) => {
      const remaining = (it.qty_accepted ?? 0) - (it.returned_qty ?? 0) - (heldA.get(it.id) ?? 0);
      return { ...it, _qty: Math.min(it.qty_rejected ?? 0, Math.max(0, remaining)) };
    })
    .filter((it) => it._qty > 0);
  if (rejectedItems.length === 0) {
    return c.json({ error: 'no_rejected_qty', message: 'None of the selected GRNs have remaining rejected qty to return' }, 400);
  }

  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  const nextPrtNumber = async (): Promise<string> =>
    mintMonthlyDocNo(sb, 'purchase_returns', 'return_number', `${p}PRT-${yymm}`);

  const grnNumbersJoined = grnList.map((g) => g.grn_number).join(', ');
  const totalRefund = rejectedItems.reduce((s, it) => s + (it._qty * it.unit_price_sen), 0);

  const primaryGrnId = grnList[0]!.id;

  if (!body.confirmShortStock) {
    const shortages = await checkPrStockAvailability(
      sb,
      rejectedItems.map((it, idx) => ({
        id: `new-${idx}`,
        grn_item_id: it.id,
        item_code: it.item_code,
        material_name: it.material_name,
        item_group: it.item_group,
        variants: (it.variants as VariantAttrs | null) ?? null,
        qty: it._qty,
      })),
      primaryGrnId,
      activeCompanyId(c),
    );
    if (shortages.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(shortStockResponse(shortages), 409);
    }
  }

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    nextPrtNumber,
    (returnNumber) => sb.from('purchase_returns').insert({
    company_id: activeCompanyId(c),
    return_number: returnNumber,
    purchase_order_id: grnList[0]!.purchase_order_id,
    grn_id: primaryGrnId,
    supplier_id: supplierId,
    return_date: todayMyt(),
    reason: body.reason ?? `Batch from ${grnList.length} GRNs: ${grnNumbersJoined}`,
    supplier_replaces: body.supplierReplaces !== false,
    refund_sen: totalRefund,
    notes: body.notes ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select('id, return_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rows = rejectedItems.map((it) => ({
    purchase_return_id: h.id,
    grn_item_id: it.id,
    material_kind: it.material_kind,
    item_code: it.item_code,
    material_name: it.material_name,
    qty_returned: it._qty,
    unit_price_sen: it.unit_price_sen,
    line_refund_sen: it._qty * it.unit_price_sen,
    reason: it.rejection_reason,
    item_group: it.item_group,
    variants: it.variants,
    description: it.description,
    description2: it.description2 ?? (buildVariantSummary(String(it.item_group ?? ''), it.variants ?? null) || null),
    uom: it.uom ?? 'UNIT',
  }));
  const { error: iErr } = await sb.from('purchase_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('purchase_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  const atomic = await postCreatedPr(c, sb, h, primaryGrnId, user.id, rejectedItems.map((it) => it.id));
  if (atomic && 'refused' in atomic) return atomic.refused;
  let movementErrors: string[] = [];
  if (!atomic) {
    for (const it of rejectedItems) await adjustGrnReturnedQty(sb, it.id, it._qty);
    movementErrors = await writePurchaseReturnMovements(sb, h.id, h.return_number, primaryGrnId, user.id);
  }

  return c.json({ id: h.id, returnNumber: h.return_number, grnCount: grnList.length, lineCount: rejectedItems.length, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
purchaseReturns.post('/from-grns', createPurchaseReturnFromGrnsHandler);

export const createPurchaseReturnFromGrnHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: both source reads below are SCOPED, so another company's GRN
     is not visible here at all; the remaining by-id statements read that same
     GRN's own lines and roll back this handler's own header. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { grnId?: string; reason?: string; notes?: string; confirmShortStock?: boolean; supplierReplaces?: boolean };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const grnId = body.grnId;
  if (!grnId) return c.json({ error: 'grn_id_required' }, 400);

  const { data: grn, error: grnErr } = await scopeToCompany(sb.from('grns')
    .select('id, grn_number, supplier_id, purchase_order_id, status, company_id')
    .eq('id', grnId), c).maybeSingle();
  if (grnErr) { markIdempotencyNoWrite(c); return c.json({ error: 'load_failed', reason: grnErr.message }, 500); }
  if (!grn) { markIdempotencyNoWrite(c); return c.json({ error: 'grn_not_found' }, 404); }
  const g = grn as { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; company_id?: number | null };
  if (g.status !== 'POSTED') { markIdempotencyNoWrite(c); return c.json({ error: 'grn_not_posted', status: g.status }, 409); }

  const { data: items } = await scopeToCompany(sb.from('grn_items')
    .select('id, material_kind, item_code, material_name, qty_accepted, qty_rejected, returned_qty, rejection_reason, unit_price_sen, item_group, variants, description, description2, uom')
    .eq('grn_id', grnId)
    .gt('qty_accepted', 0), c);
  const heldB = await repairHeldQty(sb, ((items ?? []) as Array<{ id: string }>).map((i) => i.id), null);
  if (!heldB) { markIdempotencyNoWrite(c); return c.json({ error: 'cap_check_failed', reason: 'repair returns unreadable' }, 500); }
  const allLines = ((items ?? []) as Array<{
    id: string; material_kind: string; item_code: string; material_name: string;
    qty_accepted: number; qty_rejected: number; returned_qty: number; rejection_reason: string | null; unit_price_sen: number;
    item_group: string | null; variants: Record<string, unknown> | null; description: string | null; description2: string | null; uom: string | null;
  }>);
  const lines = allLines
    .map((it) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.returned_qty ?? 0) - (heldB.get(it.id) ?? 0) }))
    .filter((it) => it._remaining > 0);
  if (lines.length === 0) { markIdempotencyNoWrite(c); return c.json({ error: 'nothing_to_return', message: 'No returnable lines came back for this GRN. Open it and check its returned balance before treating it as returned in full.' }, 400); }

  if (!body.confirmShortStock) {
    const shortages = await checkPrStockAvailability(
      sb,
      lines.map((it, idx) => ({
        id: `new-${idx}`,
        grn_item_id: it.id,
        item_code: it.item_code,
        material_name: it.material_name,
        item_group: it.item_group,
        variants: (it.variants as VariantAttrs | null) ?? null,
        qty: it._remaining,
      })),
      g.id,
      activeCompanyId(c),
    );
    if (shortages.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(shortStockResponse(shortages), 409);
    }
  }

  const totalRefund = lines.reduce((s, it) => s + (it._remaining * it.unit_price_sen), 0);

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('purchase_returns').insert({
    company_id: activeCompanyId(c),
    return_number: returnNumber,
    purchase_order_id: g.purchase_order_id,
    grn_id: g.id,
    supplier_id: g.supplier_id,
    return_date: todayMyt(),
    reason: body.reason ?? `From ${g.grn_number}`,
    supplier_replaces: body.supplierReplaces !== false,
    refund_sen: totalRefund,
    notes: body.notes ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select('id, return_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rows = lines.map((it) => ({
    purchase_return_id: h.id,
    grn_item_id: it.id,
    material_kind: it.material_kind,
    item_code: it.item_code,
    material_name: it.material_name,
    qty_returned: it._remaining,
    unit_price_sen: it.unit_price_sen,
    line_refund_sen: it._remaining * it.unit_price_sen,
    reason: it.rejection_reason,
    item_group: it.item_group,
    variants: it.variants,
    description: it.description,
    description2: it.description2 ?? (buildVariantSummary(String(it.item_group ?? ''), it.variants ?? null) || null),
    uom: it.uom ?? 'UNIT',
  }));
  const { error: iErr } = await sb.from('purchase_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('purchase_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  const atomic = await postCreatedPr(c, sb, h, g.id, user.id, lines.map((it) => it.id));
  if (atomic && 'refused' in atomic) return atomic.refused;
  let movementErrors: string[] = [];
  if (!atomic) {
    for (const it of lines) await adjustGrnReturnedQty(sb, it.id, it._remaining);
    movementErrors = await writePurchaseReturnMovements(sb, h.id, h.return_number, g.id, user.id);
  }
  await recomputePrTotals(sb, h.id);

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
purchaseReturns.post('/from-grn', createPurchaseReturnFromGrnHandler);

purchaseReturns.patch('/:id/post', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(sb.from('purchase_returns').select('id, status, posted_at, return_number, grn_id').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const row = cur as { id: string; status: string; posted_at: string | null; return_number: string; grn_id: string | null };
  if (row.status === 'POSTED' || row.status === 'COMPLETED') {
    return c.json({ purchaseReturn: row });
  }
  return c.json({ error: 'cannot_post', message: `Cannot post a ${row.status} return.` }, 409);
});

export const completePurchaseReturnHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { creditNoteRef?: string };
  try { body = (await c.req.json()) as typeof body; } catch { body = {}; }

  const { data: owned } = await scopeToCompanyId(sb.from('purchase_returns').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!owned) return c.json(NOT_THIS_COMPANY, 404);

  const updates: Record<string, unknown> = {
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (body.creditNoteRef) updates.credit_note_ref = body.creditNoteRef;

  const { data, error } = await scopeToCompanyId(sb.from('purchase_returns').update(updates)
    .eq('id', id), co.companyId).eq('status', 'POSTED').select('id, status, completed_at').maybeSingle();
  if (error) return c.json({ error: 'complete_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_posted' }, 409);
  return c.json({ purchaseReturn: data });
};
purchaseReturns.patch('/:id/complete', completePurchaseReturnHandler);

export const cancelPurchaseReturnHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const user = c.get('user');
  const reversalErrors: string[] = [];
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: cur, error: readErr } = await scopeToCompanyId(sb.from('purchase_returns')
    .select('id, status, return_number, grn_id')
    .eq('id', id), co.companyId).maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const head = cur as { id: string; status: string; return_number: string; grn_id: string | null };
  if (head.status === 'COMPLETED') return c.json({ error: 'cannot_cancel', message: 'Already completed' }, 409);
  if (head.status === 'CANCELLED') return c.json({ purchaseReturn: { id, status: 'CANCELLED' } });

  const flip = (db: any): Promise<PrFlipResult> => scopeToCompanyId(db.from('purchase_returns').update({
    status: 'CANCELLED', updated_at: new Date().toISOString(),
  }).eq('id', id), co.companyId).neq('status', 'CANCELLED').neq('status', 'COMPLETED').select('id').maybeSingle()
    .then((r: unknown) => r as PrFlipResult, (e: { message: string; code?: string }) => ({ data: null, error: e }));
  const prTx = stockTxFor(c.env, 'PURCHASE_RETURN_MODE');
  let atomicDone: { reversed: number; openedLotRows: Parameters<typeof reconcileUncostedAfterIn>[1] } | null = null;
  let flipped: PrFlipResult;
  if (prTx) {
    const out = await cancelPrAtomically(prTx, id, user.id, flip);
    if (out.ok) { flipped = { data: { id }, error: null }; atomicDone = out; }
    else if (isPrFlipMiss(out)) flipped = out.flip;
    else return c.json(prStockFailureBody('cancelled', out), 503);
  } else flipped = await flip(sb);
  const { data: updRow, error: updErr } = flipped;
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) {
    const { data: now } = await scopeToCompanyId(sb.from('purchase_returns').select('id, status').eq('id', id), co.companyId).maybeSingle();
    const st = (now as { status: string } | null)?.status;
    if (st === 'CANCELLED') return c.json({ purchaseReturn: { id, status: 'CANCELLED' } });
    if (st === 'COMPLETED') return c.json({ error: 'cannot_cancel', message: 'Already completed' }, 409);
    return c.json({ error: 'cannot_cancel' }, 409);
  }

  let reversed = 0;
  if (atomicDone) {
    reversed = atomicDone.reversed;
    await reconcileUncostedAfterIn(sb, atomicDone.openedLotRows, user.id);
  } else {
    try {
      const rev = await reverseMovements(sb, 'PURCHASE_RETURN', id, user.id);
      reversed = rev.reversed;
      if (!rev.ok) {
        reversalErrors.push(
          `Stock reversal incomplete: ${rev.reversed} reversed, ${rev.failed} failed` +
          (rev.reason ? ` (${rev.reason})` : '') +
          '. The return is cancelled; run /inventory/reconcile to repair the ledger.',
        );
      }
    } catch { }
    try {
      const { data: relLines } = await sb.from('purchase_return_items')
        .select('qty_returned, grn_item_id').eq('purchase_return_id', id);
      for (const l of (relLines ?? []) as Array<{ qty_returned: number; grn_item_id: string | null }>) {
        if (l.grn_item_id) await adjustGrnReturnedQty(sb, l.grn_item_id, -(l.qty_returned ?? 0));
      }
    } catch { }
  }
  if (reversed > 0) {
    try {
      const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
      await recomputeAllocationAfterSave(sb, 'post-pr-cancel');
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-pr-cancel failed:', e); }
  }

  return c.json({
    purchaseReturn: { id, status: 'CANCELLED' },
    ...(reversalErrors.length ? { reversalErrors } : {}),
  });
};
purchaseReturns.patch('/:id/cancel', cancelPurchaseReturnHandler);


purchaseReturns.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of [
    ['supplierId', 'supplier_id'], ['returnDate', 'return_date'],
    ['reason', 'reason'], ['creditNoteRef', 'credit_note_ref'],
    ['notes', 'notes'],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  coerceEmptyDates(updates);
  if (body.supplierReplaces !== undefined && typeof body.supplierReplaces !== 'boolean') {
    return c.json({ error: 'supplier_replaces_invalid', message: 'Supplier sends a replacement is Yes or No.' }, 400);
  }
  if (typeof body.supplierReplaces === 'boolean') updates.supplier_replaces = body.supplierReplaces;
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (body.supplierReplaces === false) {
    const { data: cur, error: curErr } = await scopeToCompanyId(sb.from('purchase_returns').select('kind').eq('id', id), co.companyId).maybeSingle();
    if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
    if (!cur) return c.json(NOT_THIS_COMPANY, 404);
    if ((cur as { kind: string | null }).kind === 'REPAIR') {
      return c.json({ error: 'repair_always_replaced', message: 'A repair return expects its goods back — the replacement question does not apply.' }, 409);
    }
  }
  const { data, error } = await scopeToCompanyId(sb.from('purchase_returns').update(updates).eq('id', id), co.companyId).select(HEADER).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  /* The answer decides whether the returned units re-open the PO line, so a
     change re-runs the same recount a cancel does (HC-0221). */
  if (typeof body.supplierReplaces === 'boolean') {
    const { data: lines, error: linesErr } = await sb.from('purchase_return_items').select('grn_item_id').eq('purchase_return_id', id);
    if (linesErr) return c.json({ error: 'recount_failed', reason: linesErr.message, purchaseReturn: data }, 500);
    for (const l of (lines ?? []) as Array<{ grn_item_id: string | null }>) {
      if (l.grn_item_id) await adjustGrnReturnedQty(sb, l.grn_item_id);
    }
  }
  return c.json({ purchaseReturn: data });
});

async function prLineLock(sb: any, prId: string): Promise<{ error: string; message: string } | null> {
  const { data } = await sb.from('purchase_returns').select('status').eq('id', prId).maybeSingle();
  const st = (data as { status: string } | null)?.status;
  if (st === 'CANCELLED') return { error: 'pr_cancelled', message: 'This purchase return is cancelled — its lines can no longer be changed.' };
  if (st === 'COMPLETED') return { error: 'pr_completed', message: 'This purchase return is completed — its lines can no longer be changed.' };
  return null;
}

export const addPurchaseReturnItemHandler = async (c: any) => {
  const prId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: parent } = await scopeToCompanyId(sb.from('purchase_returns').select('id, grn_id').eq('id', prId), co.companyId).maybeSingle();
  if (!parent) return c.json(NOT_THIS_COMPANY, 404);
  { const lock = await prLineLock(sb, prId); if (lock) return c.json(lock, 409); }

  {
    const unlinked = await findUnlinkedPrLines(
      sb, (parent as { grn_id?: string | null } | null)?.grn_id ?? null, null,
      [{
        lineRef: 'add',
        itemCode: String(it.itemCode ?? ''),
        qty: Number(it.qty ?? 1),
        soItemId: (it.grnItemId as string | undefined) ?? null,
      }],
    );
    const bad = unlinkedScanRefusal(unlinked, (o) => unlinkedReturnResponse(o, 'purchase'));
    if (bad) return c.json(bad, 409);
  }

  const qtyReturned = Number(it.qty ?? 1);
  const unitPriceSen = Number(it.unitPriceSen ?? 0);
  const lineRefund = qtyReturned * unitPriceSen;

  const grnItemId = (it.grnItemId as string) ?? null;
  if (grnItemId) {
    const xl = await assertSourceLinesInCompany(sb, c, 'grn_items', [grnItemId]);
    if (!xl.ok) return c.json(xl.body, xl.status);
    const { data: srcRow, error: srcErr } = await sb.from('grn_items')
      .select('grn:grns!inner ( grn_number, status )').eq('id', grnItemId).maybeSingle();
    if (srcErr) return c.json({ error: 'source_check_failed', reason: srcErr.message }, 500);
    const srcParent = (Array.isArray((srcRow as { grn?: unknown } | null)?.grn)
      ? ((srcRow as { grn: Array<{ grn_number?: string | null; status?: string | null }> }).grn[0])
      : (srcRow as { grn?: { grn_number?: string | null; status?: string | null } | null } | null)?.grn) ?? null;
    if ((srcParent?.status ?? null) !== 'POSTED') {
      return c.json({ error: 'grn_not_posted', grnNumber: srcParent?.grn_number ?? null, status: srcParent?.status ?? null }, 409);
    }
    const capLock = await addLineCapRefusal(sb, { grnItemId, qtyReturned });
    if (capLock) return c.json(capLock, capLock.error === 'cap_check_failed' ? 500 : 409);
  }

  /* IDENTITY, not just the key — docs/bugs/0672 site 15. The checks around this
     one prove the GRN line's company, that its parent receipt is POSTED and that
     the returned quantity fits; none proves it is the SAME PRODUCT.
     `adjustGrnReturnedQty` writes `grn_items.returned_qty` by `.eq('id', …)` and
     `writePurchaseReturnMovements` books the stock OUT from this line, so a
     wrong link returns stock against the wrong receipt line. */
  if (grnItemId) {
    const idc = await assertLinkedLineItemsMatch(sb, 'grn_items',
      [{ linkId: grnItemId, itemCode: it.itemCode }],
      { source: 'Goods Receipt line' });
    if (!idc.ok) return c.json(idc.body, idc.status);
  }

  const row: Record<string, unknown> = {
    purchase_return_id: prId,
    grn_item_id: grnItemId,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    item_code: it.itemCode,
    material_name: it.materialName,
    qty_returned: qtyReturned,
    unit_price_sen: unitPriceSen,
    line_refund_sen: lineRefund,
    reason: (it.reason as string) ?? null,
    notes: (it.notes as string) ?? null,
    gap_inches: (it.gapInches as number) ?? null,
    divan_height_inches: (it.divanHeightInches as number) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    variants: (it.variants as unknown) ?? null,
    item_group: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
    uom: (it.uom as string) ?? 'UNIT',
  };
  const { data, error } = await sb.from('purchase_return_items').insert({ company_id: activeCompanyId(c), ...row }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  if (grnItemId) {
    const inserted = data as unknown as { id: string } | null;
    const { data: gi } = await sb.from('grn_items')
      .select('qty_accepted').eq('id', grnItemId).maybeSingle();
    if (gi) {
      const cap = (gi as { qty_accepted: number }).qty_accepted ?? 0;
      const { data: sib } = await sb.from('purchase_return_items')
        .select('qty_returned, purchase_return_id').eq('grn_item_id', grnItemId);
      const sibRows = (sib ?? []) as Array<{ qty_returned: number; purchase_return_id: string }>;
      const prIds = [...new Set(sibRows.map((r) => r.purchase_return_id))];
      const cancelled = new Set<string>();
      if (prIds.length > 0) {
        const { data: prs } = await sb.from('purchase_returns').select('id, status').in('id', prIds);
        for (const p of (prs ?? []) as Array<{ id: string; status: string }>) {
          if (p.status === 'CANCELLED') cancelled.add(p.id);
        }
      }
      const liveReturned = sibRows
        .filter((r) => !cancelled.has(r.purchase_return_id))
        .reduce((s, r) => s + Number(r.qty_returned ?? 0), 0);
      if (liveReturned > cap && inserted?.id) {
        await sb.from('purchase_return_items').delete().eq('id', inserted.id);
        return c.json({ error: 'qty_exceeds_remaining', requested: qtyReturned, remaining: cap - (liveReturned - qtyReturned) }, 409);
      }
    }
  }

  if (grnItemId) await adjustGrnReturnedQty(sb, grnItemId, qtyReturned);
  await recomputePrTotals(sb, prId);

  let movementErrors: string[] = [];
  if (qtyReturned > 0) {
    const { data: hdr } = await sb.from('purchase_returns')
      .select('return_number, grn_id').eq('id', prId).maybeSingle();
    const inserted = data as unknown as { id: string } | null;
    if (hdr && inserted?.id) {
      movementErrors = await writePrLineDeltaMovement(sb, {
        prId,
        returnNumber: (hdr as { return_number: string }).return_number,
        headerGrnId: (hdr as { grn_id: string | null }).grn_id ?? null,
        userId: c.get('user').id,
        companyId: activeCompanyId(c),
        line: {
          id: inserted.id,
          grn_item_id: grnItemId,
          item_code: String(it.itemCode),
          material_name: (it.materialName as string | null) ?? null,
          item_group: (it.itemGroup as string | null) ?? null,
          variants: (it.variants as VariantAttrs | null) ?? null,
        },
        deltaQty: qtyReturned,
      });
    }
  }
  return c.json({ item: data, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
purchaseReturns.post('/:id/items', addPurchaseReturnItemHandler);

export const patchPurchaseReturnItemHandler = async (c: any) => {
  const prId = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  { const lock = await prLineLock(sb, prId); if (lock) return c.json(lock, 409); }

  const { data: prev } = await scopeToCompanyId(sb.from('purchase_return_items')
    .select('qty_returned, unit_price_sen, item_group, variants, grn_item_id, item_code, material_name')
    .eq('id', itemId).eq('purchase_return_id', prId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);

  const prevQty = (prev as { qty_returned: number }).qty_returned;
  const grnItemId = (prev as { grn_item_id: string | null }).grn_item_id ?? null;
  const qtyReturned = it.qty !== undefined ? Number(it.qty) : prevQty;
  const unit = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : (prev as { unit_price_sen: number }).unit_price_sen;
  const lineRefund = qtyReturned * unit;

  const updates: Record<string, unknown> = {
    qty_returned: qtyReturned,
    unit_price_sen: unit,
    line_refund_sen: lineRefund,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['materialName', 'material_name'],
    ['itemGroup', 'item_group'], ['description', 'description'], ['uom', 'uom'],
    ['reason', 'reason'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const delta = qtyReturned - prevQty;
  if (grnItemId && delta !== 0) {
    const capLock = await editLineCapRefusal(sb, { prId, itemId, grnItemId, qtyReturned, prevQty });
    if (capLock) return c.json(capLock, capLock.error === 'cap_check_failed' ? 500 : 409);
  }

  {
    const repoint = await unlinkedEditRefusal(sb, 'purchase-return', {
      parent: { table: 'purchase_returns', column: 'grn_id', id: prId, companyId: co.companyId },
      storedLink: grnItemId,
      storedCode: (prev as { item_code: string | null }).item_code,
      patchCode: it.itemCode,
    });
    if (repoint) return c.json(repoint, 409);
  }

  const { error } = await scopeToCompanyId(sb.from('purchase_return_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (grnItemId && delta !== 0) await adjustGrnReturnedQty(sb, grnItemId, delta);
  await recomputePrTotals(sb, prId);

  let movementErrors: string[] = [];
  if (delta !== 0) {
    const { data: hdr } = await sb.from('purchase_returns')
      .select('return_number, grn_id').eq('id', prId).maybeSingle();
    if (hdr) {
      const effGroup = (it.itemGroup ?? (prev as { item_group?: string | null }).item_group) as string | null | undefined;
      const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as VariantAttrs | null | undefined;
      movementErrors = await writePrLineDeltaMovement(sb, {
        prId,
        returnNumber: (hdr as { return_number: string }).return_number,
        headerGrnId: (hdr as { grn_id: string | null }).grn_id ?? null,
        userId: c.get('user').id,
        companyId: activeCompanyId(c),
        line: {
          id: itemId,
          grn_item_id: grnItemId,
          item_code: String((it.itemCode ?? (prev as { item_code: string }).item_code)),
          material_name: ((it.materialName ?? (prev as { material_name: string | null }).material_name) as string | null) ?? null,
          item_group: effGroup ?? null,
          variants: effVariants ?? null,
        },
        deltaQty: delta,
      });
    }
  }
  return c.json({ ok: true, movementErrors: movementErrors.length ? movementErrors : undefined });
};
purchaseReturns.patch('/:id/items/:itemId', patchPurchaseReturnItemHandler);

export const deletePurchaseReturnItemHandler = async (c: any) => {
  const prId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  { const lock = await prLineLock(sb, prId); if (lock) return c.json(lock, 409); }
  const { data: line, error: lineErr } = await scopeToCompanyId(sb.from('purchase_return_items')
    .select('qty_returned, grn_item_id, item_code, material_name, item_group, variants')
    .eq('id', itemId).eq('purchase_return_id', prId), co.companyId).maybeSingle();
  const { data: hdr, error: hdrErr } = await scopeToCompanyId(sb.from('purchase_returns').select('return_number, grn_id').eq('id', prId), co.companyId).maybeSingle();
  if (lineErr || hdrErr) return c.json(linesUnreadableBody('the purchase return line', 'deleted', lineErr ?? hdrErr), 503);
  if (!line) return c.json(NOT_THIS_COMPANY, 404);
  const { error } = await scopeToCompanyId(sb.from('purchase_return_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  let movementErrors: string[] = [];
  if (line) {
    const l = line as { qty_returned: number; grn_item_id: string | null; item_code: string; material_name: string | null; item_group: string | null; variants: VariantAttrs | null };
    if (l.grn_item_id) await adjustGrnReturnedQty(sb, l.grn_item_id, -(l.qty_returned ?? 0));

    const qty = Number(l.qty_returned ?? 0);
    if (qty > 0) {
      if (hdr) {
        movementErrors = await writePrLineDeltaMovement(sb, {
          prId,
          returnNumber: (hdr as { return_number: string }).return_number,
          headerGrnId: (hdr as { grn_id: string | null }).grn_id ?? null,
          userId: c.get('user').id,
          companyId: activeCompanyId(c),
          line: {
            id: itemId,
            grn_item_id: l.grn_item_id,
            item_code: l.item_code,
            material_name: l.material_name,
            item_group: l.item_group,
            variants: l.variants,
          },
          deltaQty: -qty,
        });
      }
    }
  }
  await recomputePrTotals(sb, prId);
  return c.json({ ok: true, movementErrors: movementErrors.length ? movementErrors : undefined });
};
purchaseReturns.delete('/:id/items/:itemId', deletePurchaseReturnItemHandler);
