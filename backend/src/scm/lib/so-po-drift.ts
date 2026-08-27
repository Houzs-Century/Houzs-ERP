// SO→PO drift — does the live SO line still match what this PO line snapshotted
// at proceed time? Extracted from routes/mfg-purchase-orders.ts (bug 0539) so
// the warehouse arm can resolve line→header without growing that already-large
// file, and so the whole rule is unit-testable.
//
// Three arms:
//   · item swap    — the SO now names a different SKU (maybe a different
//                    supplier): redo the PO, don't just re-print it.
//   · spec drift   — the variant summary changed (recomputed apples-to-apples so
//                    a formatter change can't false-trip it).
//   · warehouse    — the SO line's ship-from warehouse moved. This arm resolves
//                    the SO line's EFFECTIVE warehouse (its own, else the order
//                    header's) before comparing, and only flags two real,
//                    distinct warehouses — a NULL line warehouse INHERITS the
//                    header, it has not "moved" (see so-warehouse.ts). The old
//                    inline check compared the raw NULL against the PO's real
//                    warehouse and cried a false move on every such line.

import { buildVariantSummary } from '../shared';
import {
  resolveLineWarehouseId,
  warehousesDiffer,
  type SoWarehouseMasters,
  type SoWarehouseSource,
} from './so-warehouse';

export type SoDrift = {
  specPo: string;
  specSo: string;
  itemPo: string;
  itemSo: string;
  itemChanged: boolean;
  warehouseChanged: boolean;
  warehousePoId: string | null;
  warehouseSoId: string | null;
};

/** A line-level snapshot (PO line or SO line) the drift check reads. */
export type DriftLine = {
  item_code?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  warehouse_id?: string | null;
};

/** Null when the PO line still matches its source SO line; otherwise the drift.
 *  `soHeader` is the source SO's header warehouse fields, used to resolve a NULL
 *  line warehouse to the order's own before the warehouse comparison. */
export function computeSoDrift(
  poLine: DriftLine,
  soLine: DriftLine,
  soHeader: SoWarehouseSource | null | undefined,
  masters: SoWarehouseMasters,
): SoDrift | null {
  const specPo = buildVariantSummary(String(poLine.item_group ?? ''), poLine.variants ?? null);
  const specSo = buildVariantSummary(String(soLine.item_group ?? ''), soLine.variants ?? null);
  const itemPo = String(poLine.item_code ?? '');
  const itemSo = String(soLine.item_code ?? '');
  const itemChanged = itemPo !== itemSo;
  const warehousePoId = poLine.warehouse_id ?? null;
  const warehouseSoId = resolveLineWarehouseId(soLine.warehouse_id ?? null, soHeader ?? null, masters);
  const warehouseChanged = warehousesDiffer(warehousePoId, warehouseSoId);
  if (specPo !== specSo || itemChanged || warehouseChanged) {
    return { specPo, specSo, itemPo, itemSo, itemChanged, warehouseChanged, warehousePoId, warehouseSoId };
  }
  return null;
}
