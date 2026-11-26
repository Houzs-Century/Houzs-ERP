// MRP Stock Status Report — Excel export (v7 layout, owner-approved
// C:\...\MRP-Export-Layout-Mockup-v7.xlsx, 2026-09-16; v8 splits Coverage /
// PO Outstanding into two columns, 2026-09-17, to match the on-screen group
// row's own split).
//
// ONE workbook, one SHEET per category tab (Sofa, Bedframe, Mattress,
// Accessories, Others). Each sheet mirrors what that tab shows on screen
// ("我的 MRP 看到怎么样的 就出来怎么样的"):
//   • Mattress / Bedframe / Accessories / Others — grouped by SKU: a green
//     group-header row (code + description + qty/stock/shortage), then one
//     demand row per SO line under it.
//   • Sofa — grouped by SALES ORDER (a set): a green group-header row (SO no +
//     set composition + customer/state/dates + total qty), then the module
//     pieces (and any cover / pillow riders) underneath.
// The header row is dark green; group headers light green; any SHORTAGE demand
// row is tinted light red. Coverage and PO Outstanding are TWO columns (v8,
// owner-approved 2026-09-17 — matches the on-screen group row's own Stock /
// PO Outstanding / Shortage split), and each reads DIFFERENTLY on the two row
// kinds:
//   • Demand row — Coverage is the word ("stock" / "needs PO"); PO Outstanding
//     is that line's own PO + ETA string. Stock stays blank (it's a SKU-level
//     total, not a per-line one) and Shortage stays blank off an actual
//     shortage line, rather than printing 0.
//   • Group header (green) — Stock / PO Outstanding / Shortage are QTY
//     rollups for everything under it (PO Outstanding is g.poOutstanding, the
//     same figure the on-screen group row shows); Coverage stays blank on the
//     header — it only ever carries the demand-row word.
//
// Parity is by CONSTRUCTION: every sheet is fetched with that tab's OWN
// `?category=` (a category filter changes the allocation inputs, so the full
// plan cannot be safely post-filtered) and run through the SAME computeTabModels
// the screen renders, with the page's live warehouse / date / only-shortages /
// search filters. No figure is recomputed here.

import type { SheetData as WxlSheetData, Cell as WxlCell } from 'write-excel-file';
import type { MrpResponse, MrpSku, MrpLine } from '../../vendor/scm/lib/mrp-queries';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { fmtDate } from '../../../../shared/src/vendor/shared/format';
import { mrpViews, mrpCategoryOf, type MrpView } from './mrp-views';
import {
  computeTabModels, type ModelGroup, type MrpFilters, type AccessoryBySoDoc,
} from './mrp-model-pipeline';
import { todayMyt } from '../../vendor/scm/lib/dates';

/* Column order = the approved v8 layout (A..P), Customer moved to the last
   column (owner 2026-09-18: was F, wanted at the end). */
export const MRP_EXPORT_HEADERS = [
  'Warehouse', 'Item Code', 'Description', 'Item Description 2', 'SO No',
  'State', 'Processing Date', 'Delivery Date', 'Qty Needed',
  'Stock', 'Coverage', 'PO Outstanding', 'Shortage', 'Status', 'Supplier', 'Customer',
] as const;
const COL = MRP_EXPORT_HEADERS.length;

type Cell = string | number | null;
export type SheetRow =
  | { kind: 'group'; cells: Cell[] }
  | { kind: 'demand'; cells: Cell[]; shortage: boolean };

export function coverageText(l: Pick<MrpLine, 'source' | 'poNumber' | 'poEta'>): string {
  if (l.source === 'stock') return 'stock';
  if (l.source === 'shortage') return 'needs PO';
  return '';
}

export function poOutstandingText(l: Pick<MrpLine, 'source' | 'poNumber' | 'poEta'>): string {
  if (l.source !== 'po') return '';
  if (!l.poNumber) return '';
  return l.poEta ? `${l.poNumber}  ·  ETA ${fmtDate(l.poEta)}` : l.poNumber;
}

export function statusText(source: MrpLine['source']): string {
  return source === 'stock' ? 'READY' : source === 'po' ? 'IN PRODUCTION' : 'CONFIRMED';
}

export function supplierText(sku: MrpSku, l: Pick<MrpLine, 'source' | 'poSupplierName'>): string {
  if (l.source === 'po') return l.poSupplierName ?? '';
  if (l.source === 'shortage') {
    if (sku.mainSupplierName) return sku.mainSupplierName;
    if (sku.suppliers.length === 0) return '';
    return (sku.suppliers.find((s) => s.isMain) ?? sku.suppliers[0]).name;
  }
  return '';
}

export function sofaSpec(itemCode: string, variantLabel: string | null): string {
  if (!variantLabel || variantLabel === itemCode) return '';
  const pfx = `${itemCode} \u00b7 `;
  return variantLabel.startsWith(pfx) ? variantLabel.slice(pfx.length) : variantLabel;
}

const isoDay = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');
const blankRow = (): Cell[] => Array<Cell>(COL).fill(null);

function demandRow(opts: {
  warehouse: string; itemCode: Cell; spec: string; sku: MrpSku; line: MrpLine;
}): SheetRow {
  const { warehouse, itemCode, spec, sku, line } = opts;
  const cells = blankRow();
  cells[0] = warehouse;
  cells[1] = itemCode;
  cells[3] = spec;
  cells[4] = line.soDocNo;
  cells[5] = line.customerState ?? '';
  cells[6] = isoDay(line.processingDate);
  cells[7] = line.deliveryDate ? isoDay(line.deliveryDate) : 'No date';
  cells[8] = line.qty;
  cells[10] = coverageText(line);
  cells[11] = poOutstandingText(line);
  cells[12] = line.source === 'shortage' ? line.shortageQty : null;
  cells[13] = statusText(line.source);
  cells[14] = supplierText(sku, line);
  cells[15] = line.debtorName ?? '';
  return { kind: 'demand', cells, shortage: line.source === 'shortage' && line.shortageQty > 0 };
}

/**
 * Flatten one tab's grouped models into the v7 sheet rows (group header + its
 * demand rows). Pure — every value is one the engine already returned and the
 * screen already renders. `isSofa` picks the SO-grouped layout; the other tabs
 * use the SKU-grouped layout. `accessoryBySoDoc` supplies each sofa SO's cover /
 * pillow riders (empty / ignored off the sofa tab).
 */
export function buildSheetRows(
  isSofa: boolean,
  models: readonly ModelGroup[],
  accessoryBySoDoc: AccessoryBySoDoc,
): SheetRow[] {
  const out: SheetRow[] = [];
  for (const g of models) {
    if (isSofa) {
      const first = g.variants[0].lines[0];
      const head = blankRow();
      head[0] = g.warehouseCode ?? g.warehouseName ?? '';
      head[1] = g.itemCode;
      head[2] = g.description ?? '';
      head[5] = first.customerState ?? '';
      head[6] = isoDay(first.processingDate);
      head[7] = first.deliveryDate ? isoDay(first.deliveryDate) : 'No date';
      head[8] = g.qtyNeeded;
      head[9] = g.stock;
      head[11] = g.poOutstanding;
      head[12] = g.shortage;
      head[15] = first.debtorName ?? '';
      out.push({ kind: 'group', cells: head });
      for (const v of g.variants) {
        for (const l of v.lines) {
          out.push(demandRow({
            warehouse: v.warehouseCode ?? v.warehouseName ?? '',
            itemCode: v.itemCode, spec: sofaSpec(v.itemCode, v.variantLabel), sku: v, line: l,
          }));
        }
      }
      for (const { sku, line } of accessoryBySoDoc.get(g.itemCode) ?? []) {
        out.push(demandRow({
          warehouse: sku.warehouseCode ?? sku.warehouseName ?? '',
          itemCode: sku.itemCode,
          spec: sofaSpec(sku.itemCode, sku.variantLabel) || (sku.description ?? ''),
          sku, line,
        }));
      }
    } else {
      const head = blankRow();
      head[1] = g.itemCode;
      head[2] = g.description ?? '';
      head[8] = g.qtyNeeded;
      head[9] = g.stock;
      head[11] = g.poOutstanding;
      head[12] = g.shortage;
      out.push({ kind: 'group', cells: head });
      for (const v of g.variants) {
        for (const l of v.lines) {
          out.push(demandRow({
            warehouse: v.warehouseCode ?? v.warehouseName ?? '',
            itemCode: null, spec: v.variantLabel ?? '', sku: v, line: l,
          }));
        }
      }
    }
  }
  return out;
}

function apiCategoryOf(view: MrpView): string | null {
  return view.value === 'sofa' ? null : mrpCategoryOf(view.value);
}

const C_HEADER_FILL = '#14532D';
const C_HEADER_FONT = '#FFFFFF';
const C_GROUP_FILL = '#E4F0E9';
const C_GROUP_FONT = '#0C4D31';
const C_SHORT_FILL = '#F7E1DE';
const C_SHORT_FONT = '#9E2B22';
const C_TITLE_FONT = '#0C4D31';
const C_SUBTITLE_FONT = '#6A6F66';

const COL_WIDTHS = [11, 21, 32, 36, 15, 16, 15, 15, 11, 8, 12, 26, 10, 17, 30, 14];
const NUM_COLS = new Set([8, 9, 12]);

function subtitle(view: MrpView, asOf: string | null, warehouseLabel: string, filters: MrpFilters): string {
  const grouped = view.value === 'sofa'
    ? 'Grouped by SALES ORDER (a sofa set), module pieces underneath'
    : 'Grouped by SKU, then Warehouse then Delivery Date';
  const bits = [grouped, `as of ${asOf ? fmtDate(asOf) : fmtDate(new Date())}`, `Warehouse: ${warehouseLabel}`];
  if (filters.onlyShort) bits.push('Only shortages');
  if (filters.dateFrom || filters.dateTo) {
    const basis = filters.dateBasis === 'processing' ? 'Processing'
      : filters.dateBasis === 'soDate' ? 'SO'
      : filters.dateBasis === 'orderBy' ? 'Order-by' : 'Delivery';
    bits.push(`${basis} ${filters.dateFrom || '…'} → ${filters.dateTo || '…'}`);
  }
  if (filters.search.trim()) bits.push(`Search: "${filters.search.trim()}"`);
  return bits.join('  -  ');
}

export type WorkbookMeta = { asOf: string | null; warehouseLabel: string; filters: MrpFilters };
export type SheetSpec = { view: MrpView; rows: SheetRow[] };

function toXlsxCell(value: Cell, col: number, fill: string | null, groupBold: boolean): WxlCell {
  const has = value !== null && value !== '';
  const isNum = has ? typeof value === 'number' : NUM_COLS.has(col);
  if (!has && !fill) return null;
  const cell: NonNullable<WxlCell> = {};
  if (has) {
    cell.value = value as string | number;
    cell.type = isNum ? Number : String;
  }
  if (isNum) cell.align = 'right';
  if (fill) cell.backgroundColor = fill;
  if (groupBold) { cell.fontWeight = 'bold'; cell.color = C_GROUP_FONT; cell.fontSize = 10; }
  if (fill === C_SHORT_FILL && col === 12) { cell.fontWeight = 'bold'; cell.color = C_SHORT_FONT; }
  return cell;
}

function toSheetMatrix(view: MrpView, rows: SheetRow[], meta: WorkbookMeta): WxlSheetData {
  const pad = (): WxlCell[] => Array.from({ length: COL - 1 }, () => null);
  const titleRow: WxlCell[] = [
    { value: `MRP Stock Status  -  ${view.label}`, type: String, span: COL, fontWeight: 'bold', fontSize: 15, color: C_TITLE_FONT, height: 22 },
    ...pad(),
  ];
  const subRow: WxlCell[] = [
    { value: subtitle(view, meta.asOf, meta.warehouseLabel, meta.filters), type: String, span: COL, fontSize: 9.5, color: C_SUBTITLE_FONT },
    ...pad(),
  ];
  const headerRow: WxlCell[] = MRP_EXPORT_HEADERS.map((label) => ({
    value: label, type: String, fontWeight: 'bold', fontSize: 10, color: C_HEADER_FONT,
    backgroundColor: C_HEADER_FILL, align: 'center', alignVertical: 'center', height: 18,
  }));
  const dataRows: WxlCell[][] = rows.map((row) => {
    const fill = row.kind === 'group' ? C_GROUP_FILL : (row.shortage ? C_SHORT_FILL : null);
    const groupBold = row.kind === 'group';
    return row.cells.map((v, i) => toXlsxCell(v, i, fill, groupBold));
  });
  return [titleRow, subRow, headerRow, ...dataRows];
}

/**
 * Build the v7 workbook as an .xlsx Blob — one styled sheet per tab, frozen
 * header, coloured header / group / shortage rows. `write-excel-file` is loaded
 * lazily so it never touches the initial bundle.
 */
export async function buildMrpWorkbookBlob(sheets: SheetSpec[], meta: WorkbookMeta): Promise<Blob> {
  const writeXlsxFile = (await import('write-excel-file')).default;
  const data: WxlSheetData[] = sheets.map(({ view, rows }) => toSheetMatrix(view, rows, meta));
  const columns = sheets.map(() => COL_WIDTHS.map((w) => ({ width: w })));
  return writeXlsxFile(data, {
    sheets: sheets.map((s) => s.view.label),
    columns,
    stickyRowsCount: 3,
  });
}

export type ExportMrpWorkbookOptions = {
  views: MrpView[];
  warehouseId: string;
  includeUndated: boolean;
  filters: MrpFilters;
  asOf: string | null;
  warehouseLabel: string;
  onError: (e: Error) => void;
};

/**
 * Fetch each tab's plan, build the v7 sheets, and download the workbook. Throws
 * are routed to `onError` (CLAUDE.md: a failed export must reach the operator).
 */
export async function exportMrpWorkbook(opts: ExportMrpWorkbookOptions): Promise<void> {
  const { views, warehouseId, includeUndated, filters, asOf, warehouseLabel, onError } = opts;
  try {
    const planByCategory = new Map<string | null, Promise<MrpResponse>>();
    const planFor = (category: string | null): Promise<MrpResponse> => {
      const cached = planByCategory.get(category);
      if (cached) return cached;
      const q = new URLSearchParams();
      if (category && category !== 'all') q.set('category', category);
      if (warehouseId && warehouseId !== 'all') q.set('warehouseId', warehouseId);
      q.set('includeUndated', includeUndated ? 'true' : 'false');
      const p = authedFetch<MrpResponse>(`/mrp?${q.toString()}`);
      planByCategory.set(category, p);
      return p;
    };

    const sheets: SheetSpec[] = await Promise.all(
      views.map(async (view) => {
        const data = await planFor(apiCategoryOf(view));
        const { displayModels, accessoryBySoDoc } = computeTabModels(data, view, filters);
        return { view, rows: buildSheetRows(view.value === 'sofa', displayModels, accessoryBySoDoc) };
      }),
    );

    const blob = await buildMrpWorkbookBlob(sheets, { asOf, warehouseLabel, filters });
    const date = todayMyt();
    downloadBlob(blob, `mrp-stock-status-${date}.xlsx`);
  } catch (e) {
    onError(e instanceof Error ? e : new Error(String(e)));
  }
}

export { mrpViews };

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
