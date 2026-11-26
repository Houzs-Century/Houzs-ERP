import type { CSSProperties, ReactNode } from "react";
import type { CSVColumn } from "../lib/csv";
import type { LayoutSeed } from "../lib/tableLayouts";
import type { DataTableLineExport, ExportCell, ExportFormat, TablePdfView } from "./dataTableLineExport";

export interface Column<T, L = never> {
  key: string;
  label: string;
  exportLabel?: string;
  width?: string;
  align?: "left" | "right" | "center";
  className?: string;
  render: (row: T) => ReactNode;
  renderHeader?: () => ReactNode;
  getValue?: (row: T) => string | number | boolean | null | undefined;
  sortValue?: (row: T) => string | number | boolean | null | undefined;
  sortCompare?: (a: T, b: T) => number;
  filterType?: "date" | "number";
  dateValue?: (row: T) => string | null | undefined;
  numberValue?: (row: T) => number | null | undefined;
  searchValue?: (row: T) => string | null | undefined;
  exportValue?: (row: T) => ExportCell;
  lineValue?(row: T, line: L): ExportCell;
  exportFormat?: ExportFormat;
  getFilterValues?: (row: T) => (string | number | null | undefined)[];
  filterSeedValues?: readonly string[];
  filterCounts?: readonly (readonly [string, number])[];
  filterLabel?: (value: string) => string;
  newestFirst?: boolean;
  alwaysVisible?: boolean;
  canHide?: boolean;
  /** Opt-out of sort for columns that have getValue but aren't meaningfully
   *  sortable (e.g. a selection checkbox column).
   *
   *  On a `serverSort` table this means "not in the backend sort whitelist",
   *  NOT "never sortable": the column still sorts, but CLIENT-side over the
   *  loaded page only (owner 2026-07-24: every column must sort). The sort is
   *  never reported to the parent, so the backend query is untouched. To make
   *  a server-sorted column truly unsortable, drop its `getValue`. */
  disableSort?: boolean;
  defaultHidden?: boolean;
  /**
   * @deprecated The funnel now shows on EVERY column that has `getValue`
   * (owner 2026-07-24: "所有list的headers都需要有filter功能"). This flag is
   * no longer the gate and is kept only so existing `filterable` call sites
   * keep compiling. To turn the funnel OFF for one column, use `disableFilter`.
   */
  filterable?: boolean;
  disableFilter?: boolean;
  group?: string;
  /**
   * Footer total (owner 2026-09-25). Called with the rows on screen after
   * search and filters, or only the ticked rows while any are ticked; returns
   * the formatted figure. A table with no `total` column has no footer.
   */
  total?: (rows: T[]) => ReactNode;
  description?: string;
}

export interface DataTableChildRow {
  key: string;
  cells: Readonly<Partial<Record<string, ReactNode>>>;
  lead?: ReactNode;
  caption?: ReactNode;
  className?: string;
}

/**
 * A named column layout — "which columns, in what order" — offered in the
 * Columns panel (owner 2026-08-01: the 2990 Sales Order list and the Houzs one
 * are the same table wanting two different working views, and each tenant's
 * users should be able to pick either).
 *
 * A preset is a BASELINE, never a lock: applying one writes the same per-user
 * `dt:*` prefs a hand-arranged layout writes, so the very next column toggle or
 * header drag edits it exactly as before. The one marked `isDefault` is what a
 * user who has never touched this table sees — that is how a company gets its
 * own default view without a stored pref per person.
 */
export interface ColumnLayoutPreset {
  id: string;
  label: string;
  hint?: string;
  columns: string[];
  companyCode?: string;
  isDefault?: boolean;
}

export interface DataTableProps<T, L = never> {
  tableId?: string;
  layoutFamily?: string;
  /**
   * Absent / `true`: the column funnels and the search text are kept for this
   * visit (a record opened and closed keeps them; a page load opens clean).
   * `false`: per mount, the table opens with no filter every time (SKU Master,
   * owner 2026-09-15: "每一次打开应该默认都是全部展开的"); a funnel an earlier
   * version saved for it is erased. `"always"`: the funnels are kept in
   * localStorage as well, so the table reopens as narrowed as it was left,
   * across page loads (the delivery planning boards, owner 2026-10-05).
   */
  persistFilters?: boolean | "always";
  persistSort?: boolean;
  layoutPresets?: ColumnLayoutPreset[];
  documentLabel?: string;
  columns: Column<T, L>[];
  rows: T[] | null;
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  onRowClick?: (row: T) => void;
  onRowDoubleClick?: (row: T) => void;
  getRowKey: (row: T) => string | number;
  getRowClassName?: (row: T) => string | undefined;
  getRowStyle?: (row: T) => CSSProperties | undefined;
  initialRowLimit?: number;
  defaultSort?: (a: T, b: T) => number;
  onRowReorder?: (orderedKeys: string[]) => void;
  /** Excel-style range on number cells (HC-0164): press a number cell and drag
   *  (or Shift+click) to mark a block; a pill shows its Sum / Count / Average. */
  cellRangeSum?: boolean;
  groupBanner?: boolean;
  legacyGridKey?: string;
  layoutSeeds?: LayoutSeed[];
  onApplyLayoutSeed?: (seedId: string) => void;
  overlayHidden?: readonly string[];
  onUserAdjustColumns?: () => void;
  scrollToRow?: { key: string; nonce: number } | null;
  embedded?: boolean;
  fitToWidth?: boolean;
  exportName?: string;
  exportLabel?: string;
  onExport?: (columns: CSVColumn<T>[]) => void;
  exportLines?: DataTableLineExport<T, L>;
  exportXlsx?: boolean;
  exportSheet?: (rows: readonly T[]) => { name: string; heading?: readonly string[] };
  onExportPdf?: (view: TablePdfView<T>) => void;
  /** Told the columns showing, in their order, whenever that changes — for a page
   *  whose export reaches past this one table: Payments not matched yet's "Export
   *  all" writes three tables, each with the columns its reader has showing (owner
   *  2026-11-10: 这个export可以根据我显示的column 来export). Keep it cheap: a ref, not state. */
  onShownColumnsChange?: (columns: Column<T, L>[]) => void;
  toolbarExtra?: React.ReactNode;
  onColFiltersChange?: (colFilters: Record<string, string[]>) => void;
  onImport?: (file: File) => void;
  caption?: string;
  udfTable?: string;
  udfTableLabel?: string;
  search?: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    searching?: boolean;
    searchingLabel?: string;
    countPending?: boolean;
    scope?: "server" | "loaded";
    totalRecords?: number;
    loadedLimit?: number;
    debounceMs?: number;
  };
  clientSearch?: {
    placeholder?: string;
    loadedLimit?: number;
  };
  focusSearchNonce?: number;
  resetFilters?: {
    active: boolean;
    onReset: () => void;
    label?: string;
  };
  serverSort?: boolean;
  onSortChange?: (sort: { key: string; dir: "asc" | "desc" } | null) => void;
  mobileCard?: {
    primary?: string;
    cells?: string[];
    layout?: "stack" | "grid-2";
    hideLabels?: boolean;
  };
  expandable?: {
    render?: (row: T) => ReactNode;
    childRows?: (row: T) => readonly DataTableChildRow[];
    rowKey?: (row: T) => string;
    expandedIds?: Set<string>;
    onExpandedChange?: (next: Set<string>) => void;
  };
  /**
   * The rows that survived the per-column funnels, post-sort (owner 2026-08-12).
   * Mirrors the DataGrid prop of the same name, deliberately down to the name,
   * so a page that swaps components does not have to relearn the contract.
   *
   * Exists because the column filters are CLIENT-side and were invisible above
   * this component: a Purchase Orders list with a stuck DATE funnel showed five
   * rows worth RM 9,112.50 under a "Sum on this page" card reading RM 164,349.70
   * — two contradictory numbers on one screen, which reads as a broken system
   * rather than an active filter. A page that summarises its rows needs to know
   * which rows the operator can actually see.
   *
   * Pass a STABLE setter (e.g. a useState dispatch); it fires in an effect.
   */
  onFilteredRowsChange?: (rows: T[]) => void;
  selection?: {
    selectedIds: Set<string>;
    onToggle: (id: string) => void;
    onToggleAll: (keys: string[], allSelected: boolean) => void;
    isDisabled?: (id: string) => boolean;
    toggleOnRowClick?: boolean;
    rowLabel?: (row: T) => string;
  };
  contextMenu?: (
    row: T
  ) => Array<{
    label: string;
    onClick: () => void;
    danger?: boolean;
    divider?: boolean;
  }>;
  /** What stays on screen once the page scrolls down: "toolbar" (default) keeps
   *  search / Export / Columns above the rows; "table" lets them scroll away so
   *  the grid fills the screen (Delivery Planning, owner 2026-10-26). */
  freezeFrom?: "toolbar" | "table";
  /** How tall a frozen table may be, for a page that stacks several tables:
   *  "screen" — it fills the screen below the page header. By default a table
   *  with more page below it shrinks (to the 240px minimum) so the page's scroll
   *  can end on it, which on a report of several tables left each one six rows
   *  in a box (owner on Event Commission 2026-10-26: 这个可以做宽一点吗？ → 做);
   *  "off" — never frozen: the rows run in the page (a table opened inside
   *  another table's row, whose own box already scrolls them). */
  freezeHeight?: "screen" | "off";
  groupBy?: {
    key: string;
    label?: (val: string) => string;
  };
  /**
   * Fixed-width column layout (opt-in, default off = byte-identical to before).
   * OFF: the table is `w-full` and column widths are suggestions the auto layout
   * redistributes to fill 100%, so resizing one column re-flows its neighbours.
   * ON: the table is `table-layout: fixed`, exactly as wide as the sum of the
   * column widths — each column holds its size, resizing one changes ONLY that
   * column (the table grows and the scroll container scrolls horizontally) and
   * nothing squeezes its neighbours (owner 2026-09-11, MRP). Every column
   * resolves to a px width (its own `width`, a user drag, else the 160 default),
   * so a caller turning this on should give its wide columns an explicit `width`.
   */
  fixedColumnWidths?: boolean;
}

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}
