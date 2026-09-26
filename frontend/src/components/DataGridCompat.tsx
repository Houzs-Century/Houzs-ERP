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
import type { ExportCell } from "./dataTableLineExport";
import { isoForExport } from "../vendor/shared/format";

export type GridColumn<T> = {
  key: string;
  label: string;
  group?: string;
  accessor: (row: T) => ReactNode;
  /** Default width in px. */
  width?: number;
  minWidth?: number;
  align?: "left" | "right";
  sortable?: boolean;
  groupable?: boolean;
  sortFn?: (a: T, b: T) => number;
  groupValue?: (row: T) => string;
  searchValue?: (row: T) => string;
  exportValue?: (row: T) => string | number;
  exportFormat?: "money" | "rate";
  exportLabel?: string;
  filterValue?: (row: T) => string;
  filterType?: "date" | "number" | "numbering" | "enum" | "text";
  dateValue?: (row: T) => string | null | undefined;
  numberValue?: (row: T) => number | null | undefined;
  defaultHidden?: boolean;
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
  /** The DataGrid's storageKey. Becomes the table id, and its saved layouts
   *  are carried over on first open. */
  storageKey: string;
  rowKey: (row: T) => string;
  searchPlaceholder?: string;
  /** Known cap on the rows the page loaded (search hint). */
  loadedSearchLimit?: number;
  hideSearch?: boolean;
  exportName?: string;
  onRowClick?: (row: T) => void;
  onRowDoubleClick?: (row: T) => void;
  rowStyle?: (row: T) => CSSProperties | undefined;
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
  defaultSort?: (a: T, b: T) => number;
  sortForSessionOnly?: boolean;
};

/** A ReactNode cell as text: strings and numbers only, as DataGrid read it. */
const cellText = (v: ReactNode): string =>
  typeof v === "string" || typeof v === "number" ? String(v) : "";

/** DataGrid's value for grouping/sorting: groupValue, then searchValue, then text. */
function sortText<T>(c: GridColumn<T>, row: T): string {
  if (c.groupValue) return c.groupValue(row);
  if (c.searchValue) return c.searchValue(row);
  return cellText(c.accessor(row));
}

/** DataGrid's funnel value: filterValue, groupValue, the cell text, else searchValue. */
function filterText<T>(c: GridColumn<T>, row: T): string {
  if (c.filterValue) return String(c.filterValue(row) ?? "");
  if (c.groupValue) return String(c.groupValue(row) ?? "");
  const text = cellText(c.accessor(row));
  if (text) return text;
  return String((c.searchValue ? c.searchValue(row) : "") ?? "");
}

/** DataGrid's header-sort fallback: numeric when both sides are numbers. */
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

/** DataGrid's export cell: exportValue, filterValue, rendered text, groupValue.
 *  Never searchValue, which bundles several tokens. Dates leave as ISO. */
function exportCell<T>(c: GridColumn<T>, row: T): ExportCell {
  if (c.exportValue) return isoForExport(c.exportValue(row));
  if (c.filterValue) return isoForExport(c.filterValue(row));
  const rendered = cellText(c.accessor(row)).trim();
  if (rendered) return isoForExport(rendered);
  if (c.groupValue) return isoForExport(c.groupValue(row));
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
  onRowClick,
  onRowDoubleClick,
  rowStyle,
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
  defaultSort,
  sortForSessionOnly = false,
}: DataGridCompatProps<T>) {
  const tableColumns = useMemo(() => columns.map(gridColumnToTableColumn), [columns]);
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
      onFilteredRowsChange={onFilteredRowsChange}
      toolbarExtra={toolbar}
      clientSearch={
        hideSearch || embedded ? undefined : { placeholder: searchPlaceholder, loadedLimit: loadedSearchLimit }
      }
      focusSearchNonce={focusSearchNonce}
      exportName={exportName ?? storageKey}
      exportXlsx
      groupBanner={groupBanner && !embedded}
      embedded={embedded}
      defaultSort={defaultSort}
      persistSort={!sortForSessionOnly}
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
