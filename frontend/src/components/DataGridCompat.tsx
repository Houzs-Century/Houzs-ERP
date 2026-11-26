/**
 * The retired SCM DataGrid's props, rendered by DataTable (one-table plan,
 * owner 2026-09-25: "整个系统统一用 data table").
 *
 * 37 list files spoke DataGrid. Rewriting ~500 column definitions by hand is
 * where transcription bugs come from, so the translation lives HERE, once: a
 * page swaps `DataGrid` for `DataGridCompat` and keeps its columns. Every page
 * then renders the same component, with one set of behaviours (freeze, resize,
 * funnels, layouts). The rules below reproduce what DataGrid did for each
 * field, so a page reads the same values it always did.
 */
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { DataTable, type Column } from "./DataTable";
import type { DataTableLineExport, ExportCell, TablePdfView } from "./dataTableLineExport";
import { gridLayoutToTableLayout } from "./dataTableLegacyGridLayout";
import type { LayoutSeed } from "../lib/tableLayouts";
import { isoForExport } from "../../../shared/src/vendor/shared/format";

export type GridColumn<T> = {
  key: string;
  label: string;
  group?: string;
  accessor: (row: T) => ReactNode;
  width?: number;
  minWidth?: number;
  align?: "left" | "right";
  sortable?: boolean;
  groupable?: boolean;
  sortFn?: (a: T, b: T) => number;
  groupValue?: (row: T) => string | null | undefined;
  searchValue?: (row: T) => string | null | undefined;
  exportValue?: (row: T) => string | number;
  exportFormat?: "money" | "rate";
  exportLabel?: string;
  filterValue?: (row: T) => string | null | undefined;
  filterType?: "date" | "number" | "numbering" | "enum" | "text";
  dateValue?: (row: T) => string | null | undefined;
  numberValue?: (row: T) => number | null | undefined;
  defaultHidden?: boolean;
  total?: (rows: T[]) => ReactNode;
};

export type GridContextMenuItem = {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  divider?: boolean;
};

export type DataGridCompatProps<T> = {
  rows: T[];
  columns: GridColumn<T>[];
  storageKey: string;
  rowKey: (row: T) => string;
  searchPlaceholder?: string;
  loadedSearchLimit?: number;
  hideSearch?: boolean;
  exportName?: string;
  exportLines?: DataTableLineExport<T, never>;
  onExportPdf?: (view: TablePdfView<T>) => void;
  onRowClick?: (row: T) => void;
  onRowDoubleClick?: (row: T) => void;
  rowStyle?: (row: T) => CSSProperties | undefined;
  getRowClassName?: (row: T) => string | undefined;
  initialRowLimit?: number;
  onRowReorder?: (orderedKeys: string[]) => void;
  cellRangeSum?: boolean;
  fitToWidth?: boolean;
  onFilteredRowsChange?: (rows: T[]) => void;
  toolbar?: ReactNode;
  focusSearchNonce?: number;
  groupBanner?: boolean;
  emptyMessage?: string;
  isLoading?: boolean;
  contextMenu?: (row: T) => GridContextMenuItem[];
  expandable?: {
    renderExpansion: (row: T) => ReactNode;
    rowExpansionKey?: (row: T) => string;
  };
  selectable?: {
    selectedKeys: Set<string>;
    onToggle: (key: string) => void;
    onToggleAll: (keys: string[], allSelected: boolean) => void;
    isDisabled?: (key: string) => boolean;
    checkboxOnly?: boolean;
  };
  embedded?: boolean;
  groupBy?: { key: string; label?: (val: string) => string };
  freezeFrom?: "toolbar" | "table";
  defaultSort?: (a: T, b: T) => number;
  sortForSessionOnly?: boolean;
  persistFilters?: boolean | "always";
  resetFilters?: { active: boolean; onReset: () => void; label?: string };
  layoutPresets?: LayoutSeed[];
  onApplyLayoutPreset?: (presetId: string) => void;
  overlayHidden?: readonly string[];
  onUserAdjustColumns?: () => void;
  scrollToRow?: { key: string; nonce: number } | null;
};

const cellText = (v: ReactNode): string =>
  typeof v === "string" || typeof v === "number" ? String(v) : "";

function sortText<T>(c: GridColumn<T>, row: T): string {
  if (c.groupValue) return c.groupValue(row) ?? "";
  if (c.searchValue) return c.searchValue(row) ?? "";
  return cellText(c.accessor(row));
}

function filterText<T>(c: GridColumn<T>, row: T): string {
  if (c.filterValue) return String(c.filterValue(row) ?? "");
  if (c.groupValue) return String(c.groupValue(row) ?? "");
  const text = cellText(c.accessor(row));
  if (text) return text;
  return String((c.searchValue ? c.searchValue(row) : "") ?? "");
}

function defaultCompare<T>(c: GridColumn<T>): (a: T, b: T) => number {
  return (a, b) => {
    const va = cellText(c.accessor(a)) || sortText(c, a);
    const vb = cellText(c.accessor(b)) || sortText(c, b);
    const na = Number(va);
    const nb = Number(vb);
    if (Number.isFinite(na) && Number.isFinite(nb) && va !== "" && vb !== "") return na - nb;
    return va.localeCompare(vb);
  };
}

function exportCell<T>(c: GridColumn<T>, row: T): ExportCell {
  if (c.exportValue) return isoForExport(c.exportValue(row));
  if (c.filterValue) return isoForExport(c.filterValue(row) ?? "");
  const rendered = cellText(c.accessor(row)).trim();
  if (rendered) return isoForExport(rendered);
  if (c.groupValue) return isoForExport(c.groupValue(row) ?? "");
  return "";
}

export function gridColumnToTableColumn<T>(c: GridColumn<T>): Column<T> {
  const sortable = c.sortable !== false;
  return {
    key: c.key,
    label: c.label,
    group: c.group,
    align: c.align,
    width: c.width != null ? `${c.width}px` : undefined,
    render: c.accessor,
    getValue: (r) => filterText(c, r),
    ...(sortable ? { sortCompare: c.sortFn ?? defaultCompare(c) } : { disableSort: true }),
    searchValue: c.searchValue ?? ((r) => cellText(c.accessor(r))),
    exportValue: (r) => exportCell(c, r),
    exportFormat: c.exportFormat,
    exportLabel: c.exportLabel || c.label || c.key,
    ...(c.filterType === "date" ? { filterType: "date" as const, dateValue: c.dateValue } : {}),
    ...(c.filterType === "number" ? { filterType: "number" as const, numberValue: c.numberValue } : {}),
    defaultHidden: c.defaultHidden,
    ...(c.total ? { total: c.total } : {}),
  };
}

export function DataGridCompat<T>({
  rows,
  columns,
  storageKey,
  rowKey,
  searchPlaceholder = "Search…",
  loadedSearchLimit,
  hideSearch = false,
  exportName,
  exportLines,
  onExportPdf,
  onRowClick,
  onRowDoubleClick,
  rowStyle,
  getRowClassName,
  onFilteredRowsChange,
  toolbar,
  focusSearchNonce,
  groupBanner = true,
  emptyMessage = "No data.",
  isLoading = false,
  contextMenu,
  expandable,
  selectable,
  embedded = false,
  groupBy,
  freezeFrom,
  defaultSort,
  sortForSessionOnly = false,
  persistFilters,
  resetFilters,
  layoutPresets,
  onApplyLayoutPreset,
  overlayHidden,
  onUserAdjustColumns,
  scrollToRow,
  initialRowLimit,
  onRowReorder,
  cellRangeSum,
  fitToWidth,
}: DataGridCompatProps<T>) {
  const tableColumns = useMemo(() => columns.map(gridColumnToTableColumn), [columns]);
  const layoutSeeds = useMemo(
    () => layoutPresets?.map((s) => ({ ...s, layout: gridLayoutToTableLayout(s.layout, columns) })),
    [layoutPresets, columns],
  );
  return (
    <DataTable<T>
      tableId={storageKey}
      legacyGridKey={storageKey}
      columns={tableColumns}
      rows={rows}
      loading={isLoading}
      emptyLabel={emptyMessage}
      getRowKey={rowKey}
      onRowClick={onRowClick}
      onRowDoubleClick={onRowDoubleClick}
      getRowStyle={rowStyle}
      getRowClassName={getRowClassName}
      initialRowLimit={initialRowLimit}
      onRowReorder={onRowReorder}
      cellRangeSum={cellRangeSum}
      fitToWidth={fitToWidth}
      onFilteredRowsChange={onFilteredRowsChange}
      toolbarExtra={toolbar}
      clientSearch={
        hideSearch || embedded ? undefined : { placeholder: searchPlaceholder, loadedLimit: loadedSearchLimit }
      }
      focusSearchNonce={focusSearchNonce}
      exportName={exportName ?? storageKey}
      exportXlsx
      exportLines={exportLines}
      onExportPdf={onExportPdf}
      groupBanner={groupBanner && !embedded}
      embedded={embedded}
      groupBy={groupBy}
      freezeFrom={freezeFrom}
      defaultSort={defaultSort}
      persistSort={!sortForSessionOnly}
      persistFilters={persistFilters}
      resetFilters={resetFilters}
      layoutSeeds={layoutSeeds}
      onApplyLayoutSeed={onApplyLayoutPreset}
      overlayHidden={overlayHidden}
      onUserAdjustColumns={onUserAdjustColumns}
      scrollToRow={scrollToRow}
      contextMenu={
        contextMenu
          ? (row) =>
              contextMenu(row).map((it) => ({
                label: it.label ?? "",
                onClick: it.onClick ?? (() => undefined),
                danger: it.danger,
                divider: it.divider,
              }))
          : undefined
      }
      expandable={
        expandable ? { render: expandable.renderExpansion, rowKey: expandable.rowExpansionKey } : undefined
      }
      selection={
        selectable
          ? {
              selectedIds: selectable.selectedKeys,
              onToggle: selectable.onToggle,
              onToggleAll: selectable.onToggleAll,
              isDisabled: selectable.isDisabled,
              toggleOnRowClick: !selectable.checkboxOnly,
            }
          : undefined
      }
    />
  );
}
