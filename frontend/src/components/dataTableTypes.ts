import type { CSSProperties, ReactNode } from "react";
import type { CSVColumn } from "../lib/csv";
import type { LayoutSeed } from "../lib/tableLayouts";
import type { DataTableLineExport, ExportCell, ExportFormat } from "./dataTableLineExport";

export interface Column<T, L = never> {
  key: string;
  label: string;
  /** The exported header when it must differ from the on-screen label (an
   *  export that keeps AutoCount's caption, e.g. the SO list's "Ref."). */
  exportLabel?: string;
  width?: string;
  align?: "left" | "right" | "center";
  className?: string;
  /** Render the cell. */
  render: (row: T) => ReactNode;
  /** Optional custom header content (e.g. a select-all checkbox). When set,
   *  it replaces the label + sort affordance for this column. */
  renderHeader?: () => ReactNode;
  /** Raw value for CSV export, the funnel and sorting; without it a column is skipped by export and cannot be sorted. `sortValue` overrides the ORDER only, where alphabetical is the wrong priority (Stock Status) — CSV and the funnel stay on `getValue`, so omitting it sorts exactly as it did before `sortValue` existed. */
  getValue?: (row: T) => string | number | boolean | null | undefined;
  sortValue?: (row: T) => string | number | boolean | null | undefined;
  /** A comparator, for an order no single key expresses (the SCM DataGrid's
   *  `sortFn`). Wins over `sortValue`/`getValue` for ORDER only, and makes a
   *  column sortable even without `getValue`. Client-side only. */
  sortCompare?: (a: T, b: T) => number;
  /** The funnel shape (SCM DataGrid parity): "date" adds presets (Today, This
   *  Week, Overdue, ...) and a from/to range over `dateValue` (raw ISO); "number"
   *  adds a min/max over `numberValue`. The value checklist stays below either. */
  filterType?: "date" | "number";
  dateValue?: (row: T) => string | null | undefined;
  numberValue?: (row: T) => number | null | undefined;
  /** Text the toolbar's `clientSearch` matches, when `getValue` is not what the
   *  operator types (a doc number plus its customer name). */
  searchValue?: (row: T) => string | null | undefined;
  /** The value this column EXPORTS, when it differs from `getValue` (money in
   *  ringgit where getValue holds sen for sorting). Repeats on every line of a
   *  line export. See dataTableLineExport.ts. */
  exportValue?: (row: T) => ExportCell;
  /** Line export only: this column's cell for ONE line of the row. Method
   *  syntax on purpose — it keeps a Column<T, L> assignable where Column<T> is
   *  expected. */
  lineValue?(row: T, line: L): ExportCell;
  /** Line export only: the Excel cell type (date / money / rate / number). */
  exportFormat?: ExportFormat;
  /** For cells holding SEVERAL values (Bedframe AND Mattress): the menu lists
   *  each value separately, counts it per carrying row, and a row matches when
   *  ANY ticked value hits. `getValue` still required (sort + CSV). */
  getFilterValues?: (row: T) => (string | number | null | undefined)[];
  /** Values the filter menu ALWAYS lists, 0-count included — for enum-shaped
   *  columns whose full vocabulary must stay pickable (Nico 2026-09-04). */
  filterSeedValues?: readonly string[];
  /** Server option counts over every matching row (see dataTableRows). */
  filterCounts?: readonly (readonly [string, number])[];
  /** How the filter menu shows a value (e.g. 2026-09-22 -> 22/09/2026). */
  filterLabel?: (value: string) => string;
  /** Excluded from the column chooser AND pinned to the front (unreorderable). */
  alwaysVisible?: boolean;
  /** Opt-out of sort for columns that have getValue but aren't meaningfully
   *  sortable (e.g. a selection checkbox column).
   *
   *  On a `serverSort` table this means "not in the backend sort whitelist",
   *  NOT "never sortable": the column still sorts, but CLIENT-side over the
   *  loaded page only (owner 2026-07-24: every column must sort). The sort is
   *  never reported to the parent, so the backend query is untouched. To make
   *  a server-sorted column truly unsortable, drop its `getValue`. */
  disableSort?: boolean;
  /**
   * Hide on first load even though the column exists. The user can still
   * reveal it from the Columns panel (and that override is persisted).
   * Useful for "extended" columns that come from a wide upstream payload
   * — show a sane default subset, let power users opt-in to the rest.
   */
  defaultHidden?: boolean;
  /**
   * @deprecated The funnel now shows on EVERY column that has `getValue`
   * (owner 2026-07-24: "所有list的headers都需要有filter功能"). This flag is
   * no longer the gate and is kept only so existing `filterable` call sites
   * keep compiling. To turn the funnel OFF for one column, use `disableFilter`.
   */
  filterable?: boolean;
  /**
   * Opt a `getValue` column OUT of the header filter/sort menu. For columns
   * whose values are unique per row (a running total, a timestamp) where a
   * distinct-value checklist is just noise. The column can still be sorted by
   * clicking its header; only the funnel menu is suppressed.
   */
  disableFilter?: boolean;
  /**
   * Category this column belongs to in the Columns drawer — "Basic",
   * "Amounts", "Logistics", … A table that annotates NOTHING renders one flat
   * list, exactly as before, which is what let the grouped drawer ship to every
   * list page at once. UDF columns are grouped as "Custom fields" for free.
   */
  group?: string;
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
  /** Stable id. Only ever compared, never shown. */
  id: string;
  label: string;
  /** Optional one-liner under the label. */
  hint?: string;
  /**
   * Movable column keys, in display order. `alwaysVisible` columns are implicit
   * (they are pinned to the front by contract) and must NOT be listed. Keys that
   * don't exist for this user — a finance-only column for a non-finance viewer —
   * are dropped, so one preset can be shared across permission levels.
   */
  columns: string[];
  /**
   * The company this layout belongs to ('HOUZS' | '2990'). Naming one makes
   * this preset that company's SEED default — used until an admin saves a real
   * one from the Columns panel, at which point the saved layout takes this
   * row's place (lib/tableLayouts.ts). Leave unset for a layout that isn't
   * about a company.
   */
  companyCode?: string;
  /** The layout used when this user has no stored prefs for this table. Only
   *  consulted where the companies master isn't resolvable (tests,
   *  single-company installs); otherwise the ACTIVE company decides. */
  isDefault?: boolean;
}

export interface DataTableProps<T, L = never> {
  /** Stable identifier used for persisting column visibility, order, sort,
   *  and density per page (localStorage). */
  tableId?: string;
  /**
   * Optional stable layout family shared by many instances of the same table
   * schema. Detail pages must use this instead of embedding a document id in
   * every persisted key, otherwise browsing documents grows localStorage
   * forever. This affects layout preferences only; row identity still comes
   * from `getRowKey` and `tableId` remains available to the caller.
   */
  layoutFamily?: string;
  /**
   * `false` keeps the column funnels for this visit only: the table opens with
   * no filter every time, and any funnel an earlier version saved for it is
   * erased. Absent = the saved-view behaviour every other table has had since
   * 2026-07-29, so no existing table changes (SKU Master, owner 2026-09-15:
   * "每一次打开应该默认都是全部展开的").
   */
  persistFilters?: boolean;
  /**
   * `false` keeps a header sort for this visit only and erases one an earlier
   * version saved. For document LINE tables: their layout is shared by every
   * document of the kind, so a saved sort re-ordered the lines of every order
   * opened after it — away from the document order its editor shows (owner
   * 2026-09-15). Absent = the saved sort every other table keeps.
   */
  persistSort?: boolean;
  /**
   * Named column layouts offered at the top of the Columns panel. The preset
   * flagged `isDefault` is also the BASELINE this table renders with until the
   * user stores prefs of their own — so a page can hand each company its own
   * default view (see ColumnLayoutPreset). Omit for the historical behaviour:
   * the baseline is then the columns' own `defaultHidden` flags and no preset
   * section is shown.
   */
  layoutPresets?: ColumnLayoutPreset[];
  /** Document name for the Columns drawer eyebrow, e.g. "Sales Orders". */
  documentLabel?: string;
  columns: Column<T, L>[];
  rows: T[] | null;
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  onRowClick?: (row: T) => void;
  /** Double-click opens the document where a single click only selects. */
  onRowDoubleClick?: (row: T) => void;
  getRowKey: (row: T) => string | number;
  getRowClassName?: (row: T) => string | undefined;
  /** Inline row style, for a colour computed per row (a status tint). Prefer
   *  `getRowClassName` for a fixed set of tones. */
  getRowStyle?: (row: T) => CSSProperties | undefined;
  /** Show only the first N rows (after search / filter / sort) with a "Load more"
   *  affordance that reveals another N, instead of rendering the whole set at
   *  once. `undefined` renders everything (the default). The full filtered count
   *  is unchanged — search, filters and `onFilteredRowsChange` still see them all. */
  initialRowLimit?: number;
  /** The order rows open in while no header sort is active (client-side). */
  defaultSort?: (a: T, b: T) => number;
  /** Show the "drag a column header here to group" banner (SCM DataGrid
   *  parity): the user groups by any number of columns, outermost first, and
   *  the grouping is saved with the layout. Overrides `groupBy` while set. */
  groupBanner?: boolean;
  /** The `storageKey` this list had as an SCM DataGrid. Its saved layout (the
   *  user's own, and each company's default) is carried over the first time
   *  the DataTable opens. Set it on every page moved off DataGrid. */
  legacyGridKey?: string;
  /** Code-shipped FULL layouts (widths, frozen columns included) offered first
   *  in the Columns picker, team-wide. A layout manager may overwrite one for
   *  everyone ("Update with current columns") and reset it back. */
  layoutSeeds?: LayoutSeed[];
  /** Column keys hidden on screen only, never saved (a board narrowing itself
   *  while its map is open). */
  overlayHidden?: readonly string[];
  /** Fired on every explicit column-visibility choice (toggle, show all, reset,
   *  picking a layout), so a page can drop an `overlayHidden` it imposed. */
  onUserAdjustColumns?: () => void;
  /** Bump `nonce` to scroll the row with this key into view and highlight it. */
  scrollToRow?: { key: string; nonce: number } | null;
  /** Compact grid inside another table's expanded row: no toolbar, no card
   *  view, tighter cells. Header menus still work. */
  embedded?: boolean;
  /** Filename stem for CSV export, e.g. "orders". A date suffix is appended automatically. */
  exportName?: string;
  /** Toolbar button text, default "Export" — override when a second export
   *  button sits beside it (via `toolbarExtra`) and the two need distinct
   *  labels, e.g. MRP's "Export all" beside "Export current tab". */
  exportLabel?: string;
  /** If provided, the Export button calls this with the visible export columns instead of
   *  exporting the on-screen rows — so a server-paged list can export ALL pages with them. */
  onExport?: (columns: CSVColumn<T>[]) => void;
  /** One row per LINE over every row the server filter matches, with the grid's
   *  visible columns, funnels and sort (dataTableLineExport.ts). When set, the
   *  toolbar Export writes an .xlsx this way and `onExport` is not called. */
  exportLines?: DataTableLineExport<T, L>;
  /** Export the on-screen rows as .xlsx (each column's `exportFormat` kept)
   *  instead of CSV — what the SCM DataGrid lists always wrote. */
  exportXlsx?: boolean;
  /** Extra toolbar button(s) rendered beside Export/Columns, for a caller that
   *  needs a second export variant (e.g. MRP's per-tab export) without a whole
   *  second toolbar. */
  toolbarExtra?: React.ReactNode;
  /** Reports the per-column funnel state (the same `{ colKey: [values] }` the
   *  grid persists and applies) whenever it changes, so a server-paged list can
   *  push the SERVER-FILTERABLE columns into its list query and paginate over the
   *  filtered set — while the grid still owns and persists the funnels and
   *  applies them client-side on the loaded page. Mirrors `onSortChange` +
   *  `serverSort`: the grid stays the source of truth, the page drives the
   *  server. Columns the server cannot filter (line-level, MRP-derived) simply
   *  keep working client-side on the page. */
  onColFiltersChange?: (colFilters: Record<string, string[]>) => void;
  /** If provided, an Import button is shown that calls this with the parsed File. */
  onImport?: (file: File) => void;
  /** Optional eyebrow rendered next to the row count. */
  caption?: string;
  /**
   * Backend table identifier for user-defined fields. When set, the
   * Columns panel grows a "Custom Fields" section (add/delete), UDF
   * columns render alongside the static ones, and cells are editable
   * inline. UDFs are stored in worker D1 and never synced to AutoCount.
   */
  udfTable?: string;
  /** Friendly label used in the Custom Fields section heading. */
  udfTableLabel?: string;
  /**
   * When provided, renders a search input on the left side of the table
   * toolbar. The page is responsible for resetting pagination on change.
   */
  search?: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    /**
     * True while the visible term has not yet produced the rows below. This
     * keeps A results from being presented as if they belonged to A1.
     */
    searching?: boolean;
    searchingLabel?: string;
    /** True while totalRecords belongs to a placeholder/failed filter key. */
    countPending?: boolean;
    /**
     * Declares the data boundary of this search box. Defaults to `loaded`, so
     * a partial-page filter can never silently present itself as global.
     */
    scope?: "server" | "loaded";
    /** Settled result count. Hidden while a replacement search is pending. */
    totalRecords?: number;
    /** Known backend cap when scope is loaded rather than server-wide. */
    loadedLimit?: number;
    /**
     * Milliseconds to wait after the last keystroke before calling `onChange`.
     * Default 250. Pass 0 to propagate on every keystroke (only correct when
     * `onChange` does nothing but set local state).
     *
     * WHY THIS DEFAULTS TO ON: this input is fully controlled and used to call
     * `onChange` on EVERY keystroke. Several consumers map that value straight
     * into a server query key — `pages/ServiceCases.tsx` (`/api/assr?search=`)
     * and both `pages/Projects.tsx` lists — so typing an 8-character customer
     * name fired eight requests, of which seven were already stale on arrival.
     * Projects also writes the value into the URL, so each keystroke was a
     * `history.replaceState` too. Debouncing here fixes every DataTable
     * consumer at once rather than one page at a time.
     */
    debounceMs?: number;
  };
  /** The grid renders its own search box and filters the LOADED rows by each
   *  column's `searchValue` (else `getValue`, else a plain-text cell). For a
   *  list with no server search (SCM DataGrid parity). Ignored when `search`
   *  is set. */
  clientSearch?: {
    placeholder?: string;
    /** Known cap on the rows the page loaded, so the hint says the search
     *  covers only those (see `search.loadedLimit`). */
    loadedLimit?: number;
  };
  /** Bump to put the cursor in the search box (a page's "Find" button). */
  focusSearchNonce?: number;
  /**
   * When provided, renders a "Reset" button next to the search input
   * that is visible only while `filtersActive` is true. The page owns
   * the meaning of "active" and the actual clear logic (URL params,
   * sticky storage, pagination).
   */
  resetFilters?: {
    active: boolean;
    onReset: () => void;
    label?: string;
  };
  /**
   * Server-side sort. When true, clicking a header doesn't sort the
   * visible rows in-memory — instead the parent gets the new sort via
   * `onSortChange` and is expected to re-query with `sort_by` /
   * `sort_dir` so the ordering applies across the entire dataset
   * (not just the current page).
   */
  serverSort?: boolean;
  onSortChange?: (sort: { key: string; dir: "asc" | "desc" } | null) => void;
  /**
   * Customise the mobile (<sm) card layout. When omitted, the mobile
   * branch falls back to "first visible column = title; rest as label /
   * value rows", which is right for most heterogeneous tables. Some
   * dense list views (e.g. Trips Queue) want fewer cells laid out as a
   * value-only grid — that's what this opts into.
   */
  mobileCard?: {
    /** Column key used as the card title. Defaults to first visible column. */
    primary?: string;
    /** Ordered keys to show below the title. Defaults to remaining visible columns. */
    cells?: string[];
    /** "stack" (today) or "grid-2" — two equal columns, value-only. */
    layout?: "stack" | "grid-2";
    /** Hide the `<dt>` labels even in "stack" layout. Default false. */
    hideLabels?: boolean;
  };
  /**
   * Opt-in drill-down (2990 DataGrid parity). When set, a 32px chevron
   * column is prepended; clicking the chevron (or the chevron cell)
   * toggles an inline expanded sub-`<tr>` below the row that spans the
   * full width and renders `expandable.render(row)`. Expanded ids live in
   * a transient Set (not persisted — drill-downs reset on reload). Absent
   * (default) = no chevron column, layout byte-identical to before.
   */
  expandable?: {
    /** Render the expanded sub-row body. */
    render: (row: T) => ReactNode;
    /** Stable id for expansion state. Defaults to `getRowKey`. */
    rowKey?: (row: T) => string;
    /** Controlled expansion (opt-in). When BOTH are provided, DataTable renders
     *  exactly `expandedIds` instead of its own transient state and reports every
     *  chevron toggle through `onExpandedChange` — so a page can drive
     *  Expand/Collapse-all or auto-open its search hits (MRP). Omit both for the
     *  default transient behaviour (drill-downs reset on reload), byte-identical
     *  to before this option existed. */
    expandedIds?: Set<string>;
    onExpandedChange?: (next: Set<string>) => void;
  };
  /**
   * Opt-in row selection (2990 DataGrid `selectable` parity). When set, a
   * leading checkbox column is prepended (before any `expandable` chevron):
   * a header select-all with an indeterminate state, plus a per-row tick. Row
   * ids are `String(getRowKey(row))`. Selection state is owned by the parent
   * (so it survives re-render and drives a bulk-action bar) — the table only
   * renders the checkboxes and reports toggles. Ticking a box stops
   * propagation, so it never also fires `onRowClick`. Absent (default) = no
   * checkbox column, render path byte-identical to before. Desktop table only
   * — the mobile card branch is untouched.
   */
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
    /** Currently-selected row ids (stringified `getRowKey`). */
    selectedIds: Set<string>;
    /** Toggle one row's selection. */
    onToggle: (id: string) => void;
    /** Toggle all currently-rendered rows. `keys` = the row ids shown now;
     *  `allSelected` = whether they are all already selected (so the parent
     *  clears vs selects the batch). */
    onToggleAll: (keys: string[], allSelected: boolean) => void;
    /** A row that cannot be ticked (already converted, wrong status). Its box
     *  is disabled and select-all skips it. */
    isDisabled?: (id: string) => boolean;
    /** Clicking anywhere on the row ticks it (pickers). Default: only the box. */
    toggleOnRowClick?: boolean;
    /** The row's checkbox name, so a screen reader (and a test) can tell the
     *  rows apart: "Tick CN-2609-001". Default "Select row". */
    rowLabel?: (row: T) => string;
  };
  /**
   * Opt-in row right-click menu (2990 DataGrid parity). Receives the row
   * and returns the items to show. Returning an empty array suppresses
   * the menu for that row (the native menu is still suppressed once the
   * prop is present). A `divider: true` item renders a rule; `danger`
   * tints the item with the error token. Absent (default) = the browser's
   * native context menu, unchanged.
   */
  contextMenu?: (
    row: T
  ) => Array<{
    label: string;
    onClick: () => void;
    danger?: boolean;
    divider?: boolean;
  }>;
  /**
   * Opt-in single-level group-by (2990 DataGrid parity). Rows are bucketed
   * by `groupBy.key` (a column key; the column must expose `getValue` so we
   * have a stable group value). Each bucket gets a collapsible header row
   * with a count; collapse state is persisted per table. Grouping applies
   * to the desktop table only — the mobile card branch is untouched.
   * Absent (default) = flat rows, render path byte-identical to before.
   */
  groupBy?: {
    /** Column key to group on. Must match a column with `getValue`. */
    key: string;
    /** Pretty-print a raw group value for the header. */
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
