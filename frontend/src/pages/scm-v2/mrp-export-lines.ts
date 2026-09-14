// MRP "Export lines" — staff request #28 (Sim, 2026-09-14): "need by row per SO
// per details ... to trace the problematic order why block the inventory".
//
// The page's own Export writes one row per TOP-LEVEL row (Model / SO / colour
// variant); the per-SO-line detail lived only in the drilldown. This flattens the
// SAME rows the table is showing — the caller passes DataTable's post-funnel,
// post-sort rows — into one row per SKU x SO line. It computes nothing: every
// figure is a field the engine already returned and the drilldown already
// renders, so the file and the screen cannot disagree.

import type { MrpLine, MrpSku } from '../../vendor/scm/lib/mrp-queries';
import type { CSVColumn } from '../../lib/csv';

/** The part of Mrp.tsx's ModelGroup this needs — its variants, and on the Sofa
 *  tab its itemCode, which IS the SO doc no that keys the accessory riders. */
export type MrpExportGroup = { itemCode: string; variants: MrpSku[] };
export type MrpExportRider = { sku: MrpSku; line: MrpLine };

export type MrpExportLineRow = {
  warehouse: string;
  itemCode: string;
  description: string;
  variant: string;
  soDocNo: string;
  customer: string;
  state: string;
  qty: number;
  processingDate: string;
  deliveryDate: string;
  coverage: 'Stock' | 'PO' | 'Shortage';
  shortageQty: number;
  poNumber: string;
  poEta: string;
  poSupplier: string;
  skuQtyNeeded: number;
  skuStock: number;
  skuPoOutstanding: number;
  skuShortage: number;
  rowType: 'SO line' | 'Accessory on sofa order';
};

const COVERAGE: Record<MrpLine['source'], MrpExportLineRow['coverage']> = {
  stock: 'Stock',
  po: 'PO',
  shortage: 'Shortage',
};

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

function toRow(sku: MrpSku, ln: MrpLine, rowType: MrpExportLineRow['rowType']): MrpExportLineRow {
  // Same condition as the drilldown's PO chip: a PO is named only where it covers.
  const covering = ln.source === 'po';
  return {
    warehouse: sku.warehouseCode ?? sku.warehouseName ?? '',
    itemCode: sku.itemCode,
    description: sku.description ?? '',
    variant: sku.variantLabel ?? '',
    soDocNo: ln.soDocNo,
    customer: ln.debtorName ?? '',
    state: ln.customerState ?? '',
    qty: ln.qty,
    processingDate: day(ln.processingDate),
    // The page tags an undated line "No date" rather than leaving it blank
    // (Mrp.tsx DeliveryCell) — it is planned LAST, which is often the answer.
    deliveryDate: ln.deliveryDate ? day(ln.deliveryDate) : 'No date',
    coverage: COVERAGE[ln.source],
    shortageQty: ln.source === 'shortage' ? ln.shortageQty : 0,
    poNumber: covering ? ln.poNumber ?? '' : '',
    poEta: covering ? day(ln.poEta) : '',
    poSupplier: covering ? ln.poSupplierName ?? '' : '',
    skuQtyNeeded: sku.qtyNeeded,
    skuStock: sku.stock,
    skuPoOutstanding: sku.poOutstanding,
    skuShortage: sku.shortage,
    rowType,
  };
}

/**
 * One row per SKU x SO line, in drilldown order. `ridersBySoDoc` is REQUIRED:
 * the Sofa tab passes the cover / pillow lines it renders under each SO, every
 * other tab passes `null` (nothing rides there).
 */
export function flattenMrpExportLines(
  groups: readonly MrpExportGroup[],
  ridersBySoDoc: ReadonlyMap<string, readonly MrpExportRider[]> | null,
): MrpExportLineRow[] {
  const out: MrpExportLineRow[] = [];
  for (const g of groups) {
    for (const v of g.variants) {
      for (const ln of v.lines) out.push(toRow(v, ln, 'SO line'));
    }
    for (const r of ridersBySoDoc?.get(g.itemCode) ?? []) {
      out.push(toRow(r.sku, r.line, 'Accessory on sofa order'));
    }
  }
  return out;
}

const col = <K extends keyof MrpExportLineRow>(key: K, label: string): CSVColumn<MrpExportLineRow> =>
  ({ key, label, getValue: (r) => r[key] });

export const MRP_EXPORT_LINE_COLUMNS: CSVColumn<MrpExportLineRow>[] = [
  col('warehouse', 'Warehouse'),
  col('itemCode', 'Item Code'),
  col('description', 'Description'),
  col('variant', 'Variant / Spec'),
  col('soDocNo', 'Sales Order'),
  col('customer', 'Customer'),
  col('state', 'State'),
  col('qty', 'SO Line Qty'),
  col('processingDate', 'Processing Date'),
  col('deliveryDate', 'Delivery Date'),
  col('coverage', 'Coverage'),
  col('shortageQty', 'Shortage Qty'),
  col('poNumber', 'PO No'),
  col('poEta', 'PO ETA'),
  col('poSupplier', 'PO Supplier'),
  col('skuQtyNeeded', 'SKU Qty Needed'),
  col('skuStock', 'SKU Stock'),
  col('skuPoOutstanding', 'SKU PO Outstanding'),
  col('skuShortage', 'SKU Shortage'),
  col('rowType', 'Row Type'),
];
