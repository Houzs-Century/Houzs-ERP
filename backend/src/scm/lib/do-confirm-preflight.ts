// ----------------------------------------------------------------------------
// do-confirm-preflight — the two "are the goods here?" questions, asked where a
// DRAFT Delivery Order's stock actually leaves: Confirm (pre-ship -> shipped).
//
// Owner 2026-11-18: a DO is opened as a DRAFT before the goods arrive, the GR
// is done that night, the lorry delivers on the draft and the office presses
// Confirm. So a draft is saved without either question (create paths skip them
// on `asDraft`), and Confirm asks both against the stock as it is NOW:
//   1. Item Not Ready (BUG-59) — a linked SO line whose stored stock verdict is
//      not READY -> 409 items_not_ready, replayed with confirmNotReady.
//   2. Short stock — checkDoStockAvailability against on-hand -> 409
//      short_stock, replayed with confirmShortStock ("ship anyway").
// Both are warnings the operator may answer, never blocks. A drop-ship or
// migrated-no-stock DO is not asked about stock (it ships before receipt by
// choice / moves none). A failed header or line read is 503
// stock_check_unavailable; a failed not-ready read flags nothing (its own rule).
// ----------------------------------------------------------------------------

import { computeVariantKey, type VariantAttrs } from '../shared/variant-key';
import { scopeToCompanyId } from './companyScope';
import { findNotReadySoLines, itemsNotReadyResponse } from './do-not-ready-lines';
import { shortStockResponse, type StockShortage } from './check-stock-availability';
import { isMigratedNoStock } from './migrated-no-stock';

export type DoStockLine = {
  lineRef: string; soItemId: string | null; itemCode: string; itemGroup?: string | null;
  productName: string | null; variantKey: string; qty: number;
};

/** The route's per-warehouse on-hand check, passed in (it is private to the route file). */
export type CheckDoStock = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped SCM client
  sb: any, lines: DoStockLine[], headerWarehouseId: string | null, companyId: number | undefined,
) => Promise<StockShortage[]>;

export type ConfirmPreflightRefusal = { status: 409 | 503; body: Record<string, unknown> };

type LineRow = {
  id: string; so_item_id: string | null; item_code: string | null; item_group: string | null;
  description: string | null; variants: VariantAttrs | null; qty: number | null;
};

export async function doConfirmPreflight(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped SCM client
  sb: any,
  doId: string,
  companyId: number,
  answered: { confirmShortStock: boolean; confirmNotReady: boolean },
  checkStock: CheckDoStock,
): Promise<ConfirmPreflightRefusal | null> {
  if (answered.confirmShortStock && answered.confirmNotReady) return null;
  const unavailable = (reason: string): ConfirmPreflightRefusal => ({ status: 503, body: { error: 'stock_check_unavailable', reason } });

  const { data: head, error: headErr } = await scopeToCompanyId(sb.from('delivery_orders')
    .select('warehouse_id, is_dropship, migrated_no_stock').eq('id', doId), companyId).maybeSingle();
  if (headErr) return unavailable(headErr.message);
  const h = head as { warehouse_id: string | null; is_dropship: boolean | null; migrated_no_stock: boolean | null } | null;
  if (!h || isMigratedNoStock(h)) return null;

  /* company-scope: the header above was read under the company predicate and
     answered, so this DO is the caller's; its lines are read by the order id as
     the route always has (an older line row may carry no company_id of its own,
     and a stock check that silently drops it would wave a shortage through). */
  const { data: lineData, error: linesErr } = await sb.from('delivery_order_items')
    .select('id, so_item_id, item_code, item_group, description, variants, qty').eq('delivery_order_id', doId);
  if (linesErr) return unavailable(linesErr.message);
  const lines = (lineData ?? []) as LineRow[];

  if (!answered.confirmNotReady) {
    const notReady = await findNotReadySoLines(sb, lines.map((l) => l.so_item_id ?? '').filter(Boolean), companyId);
    if (notReady.length > 0) return { status: 409, body: itemsNotReadyResponse(notReady) };
  }

  if (!answered.confirmShortStock && h.is_dropship !== true) {
    const shortages = await checkStock(sb, lines.map((l) => ({
      lineRef: l.id, soItemId: l.so_item_id, itemCode: l.item_code ?? '', itemGroup: l.item_group, productName: l.description,
      variantKey: computeVariantKey(l.item_group, l.variants), qty: Number(l.qty ?? 0),
    })), h.warehouse_id, companyId);
    if (shortages.length > 0) return { status: 409, body: shortStockResponse(shortages, []) };
  }
  return null;
}
