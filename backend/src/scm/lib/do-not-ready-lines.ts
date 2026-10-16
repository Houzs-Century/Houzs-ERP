// ----------------------------------------------------------------------------
// do-not-ready-lines — "Item Not Ready" warning before a Delivery Order is cut
// from Sales Order lines (BUG-59, Azza 2026-10-06).
//
// The short-stock pre-flight asks "does the warehouse hold this SKU?". It never
// asked "has stock been set aside for THIS order's line?" — the READY / PENDING
// the operator reads on the SO's Stock column. So a line could be PENDING
// because an older order holds the units, the warehouse total still covered it,
// and the DO went out with no dialog at all, drawing goods promised elsewhere.
//
// A WARNING, NOT A BLOCK. Azza's answers: popup, operator may go back or
// continue (1A); drop-ship and same-day-PO orders warn the same way (3A, 4A).
// That keeps the owner's standing 不要拦 —— 人自己知道 posture.
//
// The verdict is the STORED one (`effectiveLineStockStatus` with no live MRP
// state), the same value the SO detail paints before its coverage call heals
// it. The live MRP run is ~100 round trips and does not belong on a create.
// A read failure answers "nothing flagged": a missed warning is the old
// behaviour, a refused delivery on a database blip is not.
// ----------------------------------------------------------------------------

import { isServiceLine } from '../shared';
import { SO_PROCESSING_DATE_COLUMN } from '../shared/so-processing-date';
import { effectiveLineStockStatus, type EffectiveStockStatus } from './so-line-effective-stock';
import { isHardBoundLine } from './so-stock-allocation';
import { loadNonSellingWarehouses, nonSellingWarehouseNotice, type NonSellingWarehouse } from './non-selling-warehouse';
import { chunkIn } from './paginate-all';
import { scopeToCompanyIdOrOpen } from './companyScope';

export type NotReadyLine = {
  soItemId: string;
  docNo: string;
  itemCode: string;
  description: string | null;
  status: Exclude<EffectiveStockStatus, 'READY'>;
  reason: string;
};

export type SoLineReadinessRow = {
  id: string;
  doc_no: string;
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  stock_status: string | null;
  warehouse_id: string | null;
};

/** PURE. The lines among `rows` that are not READY, with a plain reason. */
export function notReadyLines(
  rows: SoLineReadinessRow[],
  processedDocs: ReadonlySet<string>,
  nonSelling: ReadonlyMap<string, NonSellingWarehouse>,
): NotReadyLine[] {
  const out: NotReadyLine[] = [];
  for (const r of rows) {
    if (isServiceLine({ itemGroup: r.item_group, itemCode: r.item_code })) continue;
    const wh = nonSelling.get(String(r.warehouse_id ?? '')) ?? null;
    const processed = processedDocs.has(r.doc_no);
    const status = effectiveLineStockStatus(r.stock_status, null, {
      orderProcessed: processed,
      lineHardBound: isHardBoundLine(r.item_group, r.item_code),
      lineNonSellingWarehouse: wh !== null,
    });
    if (status === 'READY') continue;
    const reason = wh !== null
      ? nonSellingWarehouseNotice(wh)
      : !processed
        ? 'The order has no processing date, so no stock has been set aside for it yet.'
        : status === 'PARTIAL'
          ? 'Only part of this quantity has stock set aside.'
          : 'No stock has been set aside for this line yet (still waiting for goods, or the units on hand belong to earlier orders).';
    out.push({
      soItemId: r.id,
      docNo: r.doc_no,
      itemCode: r.item_code ?? '',
      description: r.description,
      status,
      reason,
    });
  }
  return out;
}

/** Read the picked SO lines and return the ones that are not READY. */
export async function findNotReadySoLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client, untyped across scm
  sb: any,
  soItemIds: string[],
  companyId: number | null,
): Promise<NotReadyLine[]> {
  const ids = [...new Set(soItemIds.filter(Boolean))];
  if (ids.length === 0) return [];
  try {
    const { data: rows, error } = await chunkIn<SoLineReadinessRow>(ids, (batch, from, to) => scopeToCompanyIdOrOpen(sb
      .from('mfg_sales_order_items')
      .select('id, doc_no, item_code, item_group, description, stock_status, warehouse_id')
      .in('id', batch), companyId)
      .order('id')
      .range(from, to));
    if (error) throw new Error(error.message);
    if (rows.length === 0) return [];
    const docNos = [...new Set(rows.map((r) => r.doc_no))];
    const { data: heads, error: headErr } = await chunkIn<Record<string, unknown>>(docNos, (batch, from, to) => scopeToCompanyIdOrOpen(sb
      .from('mfg_sales_orders')
      .select(`doc_no, ${SO_PROCESSING_DATE_COLUMN}`)
      .in('doc_no', batch), companyId)
      .order('doc_no')
      .range(from, to));
    if (headErr) throw new Error(headErr.message);
    const processed = new Set(
      heads.filter((h) => !!h[SO_PROCESSING_DATE_COLUMN]).map((h) => String(h.doc_no)),
    );
    return notReadyLines(rows, processed, await loadNonSellingWarehouses(sb));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[do-not-ready-lines] readiness read failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

/** The confirmable 409. The client replays with `confirmNotReady: true`. */
export function itemsNotReadyResponse(lines: NotReadyLine[]) {
  return {
    error: 'items_not_ready',
    message: `${lines.length} line${lines.length === 1 ? ' is' : 's are'} not ready to deliver: `
      + `${[...new Set(lines.map((l) => l.itemCode))].join(', ')}.`,
    lines,
  };
}
