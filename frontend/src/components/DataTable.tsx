import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { TableLoadError } from "./TableLoadError";
import { scrollPanelNearRow } from "./dataTableScrollToRow";
import {
  Download, Upload, Search, ArrowUp, ArrowDown, ArrowDownAZ, ArrowUpAZ, ChevronsUpDown, ChevronRight, LayoutList,
  Table as TableIcon, Pin, PinOff, EyeOff, Eye, MoveHorizontal, Filter, Rows3, WrapText,
} from "lucide-react";
import { cn } from "../lib/utils";
import { headerLabel } from "../lib/columnHeaderLabel";
import { columnDescription } from "../lib/columnDescriptions";
import { rowsToTsv } from "./dataTableClipboard";
import { useCellRange } from "./dataTableCellRange";
import { tickedOrAll } from "./dataTableTicked";
import { DataTableFreezeItems, keysThrough } from "./DataTableFreezeItems";
import { DataTableExportItems, HEADER_MENU_ITEM_CLASS, sheetExportLabel } from "./DataTableExportItems";
import { parseUrlColFilters, serializeUrlColFilters, UrlFilterResync } from "./dataTableUrlFilters";
import { useInRouterContext } from "react-router-dom";
import { ResetFiltersButton } from "./ResetFiltersButton";
import { ActiveFiltersChip, FilteredEmptyNotice, activeFilterSummary } from "./DataTableFilterNotice";
import { TableSkeleton } from "./Skeleton";
import {
  CUSTOM_FIELDS_GROUP,
  ColumnsButton,
  ColumnsDrawer,
  type DrawerColumn,
} from "./ColumnsDrawer";
import { withSingleActive } from "./LayoutSection";
import { showAllColumnPrefs, toggleColumnPrefs, type ColumnPrefs } from "./dataTableColumnPrefs";
import { UdfCell } from "./UdfCell";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { FitWidthButton, useTableFitWidth } from "./useTableFitWidth";
import { useInVisitClientSearch, useInVisitColFilters, useKeptColFilters } from "./dataTableColFilterMemory";
import { useFrozenTableHeader } from "./useFrozenTableHeader";
import { useSmallViewport } from "../hooks/useSmallViewport";
import { inferColumnGroup } from "../lib/columnGroups";
import { useFixedWidthPanel } from "../lib/anchoredPanel";
import { subscribeActiveCompany, getActiveCompanySnapshot } from "../lib/activeCompany";
import { shortCompanyName } from "../lib/branding";
import {
  EMPTY_LAYOUT,
  createNamedLayout,
  deleteNamedLayout,
  getTableLayoutsSnapshot,
  renameCompanyDefault,
  renameNamedLayout,
  updateNamedLayout,
  saveCompanyDefault,
  saveMyLayout,
  saveSharedLayout,
  deleteSharedLayout,
  sharedPresetRows,
  makeLayoutShareActions,
  serializeLayout,
  dataGridIdKey,
  dataGridTableKey,
  subscribeTableLayouts,
  type NamedLayout,
  type StoredLayout,
} from "../lib/tableLayouts";
import { isSharedDataGridStorageKey } from "../vendor/scm/components/dataGridLayoutStorage";
import { useUdf, type UseUdfResult } from "../hooks/useUdf";
import { downloadCSV, toCSV } from "../lib/csv";
import { applyColumnFilters, facetedFilterValues, sortTableRows } from "./dataTableRows";
import {
  buildLineExportMatrix,
  csvColumnsOf,
  exportableColumns,
  tablePdfViewOf,
  writeLineExportFile,
  type DataTableLineExport,
  type ExportCell,
  type ExportFormat,
} from "./dataTableLineExport";
import { SearchScopeHint } from "./SearchScopeHint";
import { DataTableConditionSection } from "./DataTableConditionSection";
import { DataTableGroupBanner } from "./DataTableGroupBanner";
import { gridLayoutToTableLayout, readLegacyGridLayout } from "./dataTableLegacyGridLayout";
import { buildSearchBlob, conditionToken, isConditionToken, looksLikeDateColumn, parseCondition } from "./dataTableConditionFilters";
import { MobileVirtualList } from "../mobile/MobileVirtualList";
import { reorderKeys } from "../lib/reorder";
import { useDragAutoScroll } from "./useDragAutoScroll";
import type { Column, DataTableProps, SortDir, SortState } from "./dataTableTypes";
import { DataRowCells } from "./DataTableRowCells";
import { DataTableExpandedRows } from "./DataTableExpandedRows";
import {
  DEFAULT_COL_WIDTH,
  DebouncedSearchInput,
  MIN_COL_WIDTH,
  ROW_HEIGHT_ESTIMATE,
  VIRTUAL_OVERSCAN,
  VIRTUAL_ROW_THRESHOLD,
  parsePxWidth,
  sanitizeColumnWidths,
  sanitizeMobileView,
  sanitizeSortState,
  sanitizeStringList,
  useViewportClampedPos,
} from "./dataTableHelpers";
import { todayMyt } from "../vendor/scm/lib/dates";

export type { Column, ColumnLayoutPreset, DataTableChildRow, DataTableProps } from "./dataTableTypes";

type Props<T, L = never> = DataTableProps<T, L>;

/**
 * Hydration writes the account's saved layout into the same localStorage keys
 * the table reads ONCE per key (useLocalStorage re-reads only when the key
 * itself moves, never on a same-key write). Remounting on the epoch is how a
 * table already on screen when the boot fetch lands picks the layout up. The
 * epoch bumps at most once per session, and only when hydration actually moved
 * something, so this is a no-op on every warm load.
 */
export function DataTable<T, L = never>(props: Props<T, L>) {
  const { epoch } = useSyncExternalStore(
    subscribeTableLayouts,
    getTableLayoutsSnapshot,
    getTableLayoutsSnapshot,
  );
  return <DataTableInner<T, L> key={`layout-epoch:${epoch}`} {...props} />;
}

function DataTableInner<T, L>({
  tableId,
  layoutFamily,
  persistFilters = true,
  persistSort = true,
  layoutPresets,
  documentLabel,
  columns,
  rows,
  loading,
  error,
  emptyLabel = "No data",
  onRowClick,
  getRowKey,
  getRowClassName,
  onRowDoubleClick,
  getRowStyle,
  initialRowLimit,
  onRowReorder,
  cellRangeSum = false,
  defaultSort,
  embedded = false,
  fitToWidth = false,
  groupBanner = false,
  legacyGridKey,
  layoutSeeds,
  onApplyLayoutSeed,
  overlayHidden,
  onUserAdjustColumns,
  scrollToRow,
  exportName,
  exportLabel = "Export",
  onExport,
  exportLines,
  exportXlsx, exportSheet,
  onExportPdf, onShownColumnsChange,
  toolbarExtra,
  onColFiltersChange,
  onImport,
  caption,
  udfTable,
  udfTableLabel,
  search: searchProp,
  clientSearch,
  focusSearchNonce,
  resetFilters,
  serverSort,
  onSortChange,
  mobileCard,
  expandable,
  fixedColumnWidths,
  contextMenu,
  groupBy,
  freezeFrom,
  freezeHeight,
  selection,
  onFilteredRowsChange,
}: Props<T, L>) {
  const isSmallViewport = useSmallViewport();
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearchNonce != null) searchInputRef.current?.focus();
  }, [focusSearchNonce]);
  const [searchDraftPending, setSearchDraftPending] = useState(false);
  /* Per-company column prefs (owner 2026-07-24 bug: "在 2990 sales order list
     点选 column 会影响我在 Houzs 的 column"). The table id alone keyed every
     company's columns to the SAME localStorage entry, so the 2990 window and the
     Houzs window — two tenants of the same list — trampled each other's choice.
     Bucket the key by the tab's active company so each tenant keeps its own
     private layout. Still per-USER (localStorage), never a shared server view. */
  const activeCompany = useSyncExternalStore(
    subscribeActiveCompany,
    getActiveCompanySnapshot,
    getActiveCompanySnapshot,
  );
  const layoutStore = useSyncExternalStore(
    subscribeTableLayouts,
    getTableLayoutsSnapshot,
    getTableLayoutsSnapshot,
  );
  const baseIdKey = layoutFamily || tableId || "_";
  const sharedAcrossCompanies = isSharedDataGridStorageKey(baseIdKey);
  const idKey =
    activeCompany != null && !sharedAcrossCompanies ? `c${activeCompany}:${baseIdKey}` : baseIdKey;
  const legacyIdKey = activeCompany != null
    ? baseIdKey
    : (layoutFamily && tableId && layoutFamily !== tableId ? tableId : undefined);
  const legacyStorageKey = (part: string) => legacyIdKey ? `dt:${part}:${legacyIdKey}` : undefined;
  /* `clientSearch`: the grid owns the box and filters the loaded rows itself; a
     page-controlled `search` wins. Remembered for the visit like the funnels
     (owner 2026-10-05), except on per-mount tables. */
  const [clientQuery, setClientQuery] = useInVisitClientSearch(idKey, persistFilters !== false);
  const clientSearching = !!clientSearch && !searchProp;
  const search: Props<T, L>["search"] =
    searchProp ??
    (clientSearch
      ? {
          value: clientQuery,
          onChange: setClientQuery,
          placeholder: clientSearch.placeholder,
          debounceMs: 150,
          scope: "loaded",
          loadedLimit: clientSearch.loadedLimit,
        }
      : undefined);
  const searchBusy = Boolean(
    search?.searching || (search?.searching !== undefined && searchDraftPending),
  );
  const effectiveLoading = Boolean(loading || searchBusy);
  const rowActionsDisabled = effectiveLoading || Boolean(error);
  const [hiddenList, setHiddenList] = useLocalStorage<string[]>(
    `dt:hidden:${idKey}`,
    [],
    legacyStorageKey("hidden"),
    sanitizeStringList,
  );
  const [shownList, setShownList] = useLocalStorage<string[]>(
    `dt:shown:${idKey}`,
    [],
    legacyStorageKey("shown"),
    sanitizeStringList,
  );
  const [order, setOrder] = useLocalStorage<string[]>(
    `dt:order:${idKey}`,
    [],
    legacyStorageKey("order"),
    sanitizeStringList,
  );
  const storedSort = useLocalStorage<SortState | null>(
    `dt:sort:${idKey}`,
    null,
    legacyStorageKey("sort"),
    sanitizeSortState,
  );
  const sessionSort = useState<SortState | null>(null);
  const [sort, setSort] = persistSort ? storedSort : sessionSort;
  const storedSortValue = storedSort[0];
  const legacySortKey = legacyStorageKey("sort");
  useEffect(() => {
    if (persistSort) return;
    try {
      localStorage.removeItem(`dt:sort:${idKey}`);
      if (legacySortKey) localStorage.removeItem(legacySortKey);
    } catch {
    }
  }, [persistSort, idKey, legacySortKey, storedSortValue]);
  const [mobileView, setMobileView] = useLocalStorage<"cards" | "table">(
    `dt:mview:${idKey}`,
    "cards",
    legacyStorageKey("mview"),
    sanitizeMobileView,
  );
  const showTable = embedded || !isSmallViewport || mobileView === "table";
  const showMobileCards = !embedded && isSmallViewport && mobileView === "cards";
  const widthStorageKey = `dt:widths:${idKey}`;
  const [storedWidths, setStoredWidths] = useLocalStorage<Record<string, number>>(
    widthStorageKey,
    {},
    legacyStorageKey("widths"),
    sanitizeColumnWidths,
  );
  const [widths, setWidths] = useState<Record<string, number>>(storedWidths);
  const widthsRef = useRef(widths);
  useEffect(() => {
    widthsRef.current = storedWidths;
    setWidths(storedWidths);
  }, [storedWidths]);
  const updateWidths = useCallback(
    (
      nextOrUpdater:
        | Record<string, number>
        | ((prev: Record<string, number>) => Record<string, number>),
      persist: boolean,
    ) => {
      const next =
        typeof nextOrUpdater === "function"
          ? nextOrUpdater(widthsRef.current)
          : nextOrUpdater;
      widthsRef.current = next;
      setWidths(next);
      if (persist) setStoredWidths(next);
    },
    [setStoredWidths],
  );
  /* Every table is fixed-layout once it has rows (owner 2026-09-25: resizing
     one column must never move the others). The first paint uses the auto
     layout so columns open at their natural size; the header widths read off
     that paint become the fixed baseline. Not persisted (a user drag is), and
     keyed by idKey so a company switch measures again. */
  const [measured, setMeasured] = useState<{ idKey: string; widths: Record<string, number> } | null>(null);
  const measuredWidths = measured?.idKey === idKey ? measured.widths : null;
  const layoutFixed = !!fixedColumnWidths || measuredWidths !== null;
  /* Wrap long text onto more lines instead of clipping it (owner 2026-09-25).
     A personal preference per table, like the other dt:* keys. */
  const [wrapText, setWrapText] = useLocalStorage<boolean>(`dt:wrap:${idKey}`, false, undefined, (v) => v === true);
  const wrapOn = wrapText && layoutFixed;
  const [pinned, setPinned] = useLocalStorage<string[]>(
    `dt:pinned:${idKey}`,
    [],
    legacyStorageKey("pinned"),
    sanitizeStringList,
  );
  const [chooserOpen, setChooserOpen] = useState(false);
  const userHidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const userShown = useMemo(() => new Set(shownList), [shownList]);
  /* Right-frozen columns (owner 2026-08-03). A SECOND list rather than
     reshaping `pinned` into objects: `dt:pinned:*` is already on every
     operator's machine and in every saved layout, and a shape change would
     have to migrate both. Two flat lists read the same either way. */
  const [pinnedRight, setPinnedRight] = useLocalStorage<string[]>(
    `dt:pinnedr:${idKey}`,
    [],
    legacyStorageKey("pinnedr"),
    sanitizeStringList,
  );
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const pinnedRightSet = useMemo(() => new Set(pinnedRight), [pinnedRight]);
  const [headerMenu, setHeaderMenu] = useState<{
    x: number;
    y: number;
    colKey: string;
  } | null>(null);

  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const draggedRef = useRef(false);

  /* Per-column value filters (the funnel popover). `colFilters[key]` = the set
     of allowed values; absent/empty = no filter on that column. The funnel icon
     stays highlighted while a filter is set, and each column's popover Clear
     (or the page's reset control) drops its entry.

     Three sources (dataTableColFilterMemory): default = IN-VISIT memory, a
     funnel survives drilling into a record and back but a page load opens clean
     (owner 2026-09-16); `false` = per mount, clean on EVERY mount (SKU Master, a
     remembered funnel hid a just-renamed row); `"always"` = localStorage
     `dt:funnels:`, the delivery boards reopen as narrowed as they were left
     (owner 2026-10-05). The old dt:filters:* keys are erased on mount below. */
  const visitColFilters = useInVisitColFilters(idKey);
  const sessionColFilters = useState<Record<string, string[]>>({});
  const keptColFilters = useKeptColFilters(idKey, persistFilters === "always");
  const [colFilters, setColFilters] =
    persistFilters === "always" ? keptColFilters : persistFilters ? visitColFilters : sessionColFilters;
  /* Column filters ride in the address (owner 2026-09-25), so a filtered list
     can be sent as a link: one `cf.<tableId>` parameter holding the funnels.
     Read once on mount, where a link beats the in-visit memory; rewritten with
     replaceState on every change so Back is not filled with filter steps. Not
     for per-mount tables (persistFilters false), whose funnels never persist. */
  const urlFilterParam = tableId && persistFilters ? `cf.${tableId}` : null, inRouter = useInRouterContext();
  const urlSeedRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!urlFilterParam || urlSeedRef.current !== undefined) return;
    const seeded = parseUrlColFilters(new URLSearchParams(window.location.search).get(urlFilterParam));
    urlSeedRef.current = seeded ? JSON.stringify(seeded) : null;
    if (seeded) setColFilters(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per table; setColFilters is stable per mode
  }, [urlFilterParam]);
  useEffect(() => {
    if (!urlFilterParam || urlSeedRef.current === undefined) return;
    const next = serializeUrlColFilters(colFilters);
    if (urlSeedRef.current !== null && next !== urlSeedRef.current) return;
    urlSeedRef.current = null;
    const url = new URL(window.location.href);
    if (url.searchParams.get(urlFilterParam) === next) return;
    if (next) url.searchParams.set(urlFilterParam, next);
    else url.searchParams.delete(urlFilterParam);
    window.history.replaceState(window.history.state, "", url);
  }, [colFilters, urlFilterParam]);
  const legacyFilterKey = legacyStorageKey("filters");
  useEffect(() => {
    try {
      localStorage.removeItem(`dt:filters:${idKey}`);
      if (legacyFilterKey) localStorage.removeItem(legacyFilterKey);
    } catch {
    }
  }, [idKey, legacyFilterKey]);
  const [filterMenu, setFilterMenu] = useState<{ left: number; top: number; bottom: number; colKey: string; anchor: HTMLElement } | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  const filterMenuPos = useFixedWidthPanel(filterMenu, 236, window.innerHeight - 16);
  const headerMenuPos = useViewportClampedPos(headerMenu, headerMenuRef);

  function toggleFilterValue(colKey: string, value: string) {
    setColFilters((prev) => {
      const cur = prev[colKey] ?? [];
      const next = cur.includes(value)
        ? cur.filter((v) => v !== value)
        : [...cur, value];
      const out = { ...prev };
      if (next.length === 0) delete out[colKey];
      else out[colKey] = next;
      return out;
    });
  }

  function setColumnFilter(colKey: string, values: string[]) {
    setColFilters((prev) => {
      const out = { ...prev };
      if (values.length === 0) delete out[colKey];
      else out[colKey] = [...new Set(values)];
      return out;
    });
  }

  const colFiltersActive = Object.values(colFilters).some((values) => values.length > 0);
  const clientQueryActive = clientSearching && clientQuery.trim() !== "";
  function handleResetFilters() {
    if (colFiltersActive) setColFilters({});
    if (clientQueryActive) setClientQuery("");
    resetFilters?.onReset();
  }

  const reportedColFiltersRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onColFiltersChange) return;
    const serialized = JSON.stringify(colFilters);
    if (reportedColFiltersRef.current === serialized) return;
    reportedColFiltersRef.current = serialized;
    onColFiltersChange(colFilters);
  }, [colFilters, onColFiltersChange]);

  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const expandedRowsEffective = expandable?.expandedIds ?? expandedRows;
  const expansionId = useCallback(
    (row: T) =>
      expandable?.rowKey ? expandable.rowKey(row) : String(getRowKey(row)),
    [expandable, getRowKey]
  );
  const toggleExpand = useCallback((id: string) => {
    const controlled = expandable?.expandedIds;
    if (controlled && expandable.onExpandedChange) {
      const next = new Set(controlled);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      expandable.onExpandedChange(next);
      return;
    }
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [expandable]);

  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    items: Array<{
      label: string;
      onClick: () => void;
      danger?: boolean;
      divider?: boolean;
    }>;
  } | null>(null);
  const rowMenuPos = useViewportClampedPos(rowMenu, rowMenuRef);

  const [collapsedGroups, setCollapsedGroups] = useLocalStorage<string[]>(
    `dt:groups:${idKey}`,
    [],
    legacyStorageKey("groups"),
    sanitizeStringList,
  );
  const [userGroups, setUserGroups] = useLocalStorage<string[]>(
    `dt:groupby:${idKey}`,
    [],
    legacyStorageKey("groupby"),
    sanitizeStringList,
  );
  const collapsedGroupSet = useMemo(
    () => new Set(collapsedGroups),
    [collapsedGroups]
  );
  const toggleGroup = useCallback(
    (val: string) => {
      setCollapsedGroups((prev) =>
        prev.includes(val) ? prev.filter((k) => k !== val) : [...prev, val]
      );
    },
    [setCollapsedGroups]
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  const udf: UseUdfResult = useUdf(udfTable);

  const udfColumns: Column<T>[] = useMemo(() => {
    return udf.fields.map<Column<T>>((field) => ({
      key: `udf:${field.key}`,
      label: field.label,
      group: CUSTOM_FIELDS_GROUP,
      render: (row: T) => {
        const rowKey = String(getRowKey(row));
        const value = udf.values[rowKey]?.[field.key] ?? null;
        return (
          <UdfCell
            field={field}
            value={value}
            onSave={(next) => udf.setValue(rowKey, field.key, next)}
          />
        );
      },
      getValue: (row: T) => {
        const rowKey = String(getRowKey(row));
        return udf.values[rowKey]?.[field.key] ?? "";
      },
    }));
  }, [udf.fields, udf.values, getRowKey, udf.setValue]);

  const rawColumns = useMemo(() => [...columns, ...udfColumns], [columns, udfColumns]);

  const resolvedPresets = useMemo(() => {
    const declared = layoutPresets ?? [];
    if (declared.length === 0 && layoutStore.companies.length === 0 && !layoutSeeds?.length) return [];
    const seedByCode = new Map(
      declared
        .filter((p) => p.companyCode)
        .map((p) => [p.companyCode!.toUpperCase(), p] as const),
    );
    const out: Array<{
      id: string;
      label: string;
      hint?: string;
      layout?: StoredLayout;
      columns?: string[];
      isDefault: boolean;
      fromServer: boolean;
      savedId?: number;
      companyId?: number;
      tableKey?: string;
      seed?: boolean;
      overridden?: boolean;
      shared?: boolean;
    }> = [];
    const legacyTableKey = legacyGridKey ? dataGridTableKey(legacyGridKey) : null;
    const sharedLayouts = layoutStore.sharedLayouts as Record<string, NamedLayout[] | undefined>;
    for (const seed of layoutSeeds ?? []) {
      const own = sharedLayouts[baseIdKey]?.find((l) => l.name === seed.id)?.layout;
      const legacy = legacyTableKey
        ? sharedLayouts[legacyTableKey]?.find((l) => l.name === seed.id)?.layout
        : undefined;
      const override = own ?? (legacy ? gridLayoutToTableLayout(legacy, rawColumns) : undefined);
      out.push({
        id: `seed:${seed.id}`,
        label: seed.label,
        layout: override ?? seed.layout,
        isDefault: false,
        fromServer: override != null,
        seed: true,
        overridden: override != null,
      });
    }
    out.push(...sharedPresetRows(sharedLayouts, baseIdKey, new Set((layoutSeeds ?? []).map((s) => s.id))));
    type ByKey<V> = Record<string, Record<string, V | undefined> | undefined>;
    const defaults = layoutStore.defaults as ByKey<StoredLayout>;
    const names = layoutStore.defaultNames as ByKey<string>;
    for (const co of layoutStore.companies) {
      const own = defaults[String(co.id)]?.[baseIdKey];
      const legacy = legacyTableKey ? defaults[String(co.id)]?.[legacyTableKey] : undefined;
      const saved = own ?? (legacy ? gridLayoutToTableLayout(legacy, rawColumns) : undefined);
      const seed = seedByCode.get(co.code.toUpperCase());
      if (!saved && !seed) continue;
      const savedName =
        names[String(co.id)]?.[baseIdKey] ??
        (legacyTableKey ? names[String(co.id)]?.[legacyTableKey] : undefined);
      out.push({
        id: `company:${co.id}`,
        label: savedName || `${shortCompanyName(co.name)} Layout`,
        companyId: co.id,
        hint: saved ? undefined : seed?.hint,
        layout: saved,
        columns: saved ? undefined : seed?.columns,
        isDefault: co.id === layoutStore.activeCompanyId,
        fromServer: Boolean(saved),
      });
    }
    const myLayouts = layoutStore.myLayouts as Record<string, NamedLayout[] | undefined>;
    for (const saved of myLayouts[baseIdKey] ?? []) {
      out.push({
        id: `saved:${saved.id}`,
        label: saved.name,
        hint: "Saved by you",
        layout: saved.layout,
        isDefault: false,
        fromServer: true,
        savedId: saved.id,
      });
    }
    for (const saved of legacyTableKey ? myLayouts[legacyTableKey] ?? [] : []) {
      out.push({
        id: `saved:${saved.id}`,
        label: saved.name,
        hint: "Saved by you",
        layout: gridLayoutToTableLayout(saved.layout, rawColumns),
        isDefault: false,
        fromServer: true,
        savedId: saved.id,
        tableKey: legacyTableKey!,
      });
    }
    for (const p of declared) {
      if (p.companyCode && layoutStore.companies.length > 0) continue;
      out.push({
        id: p.id,
        label: p.label,
        hint: p.hint,
        columns: p.columns,
        isDefault: layoutStore.companies.length > 0 ? false : Boolean(p.isDefault),
        fromServer: false,
      });
    }
    return out;
  }, [layoutPresets, layoutSeeds, layoutStore, baseIdKey, legacyGridKey, rawColumns]);

  const presetLayout = useCallback(
    (preset: { layout?: StoredLayout; columns?: string[] }): StoredLayout => {
      if (preset.layout) return preset.layout;
      const movable = rawColumns.filter((c) => !c.alwaysVisible);
      const byKey = new Map(movable.map((c) => [c.key, c]));
      const wanted = (preset.columns ?? []).filter((k) => byKey.has(k));
      const wantedSet = new Set(wanted);
      const rest = movable.map((c) => c.key).filter((k) => !wantedSet.has(k));
      return {
        order: [...wanted, ...rest],
        hidden: rest,
        shown: wanted.filter((k) => byKey.get(k)?.defaultHidden),
        widths: {},
        pinned: [],
        pinnedRight: [],
        groupBy: [],
      };
    },
    [rawColumns],
  );

  const baselineLayout = useMemo(() => {
    const untouched =
      order.length === 0 && hiddenList.length === 0 && shownList.length === 0;
    if (!untouched) return null;
    const preset = resolvedPresets.find((p) => p.isDefault);
    if (!preset) return null;
    const layout = presetLayout(preset);
    return { order: layout.order, hidden: new Set(layout.hidden), shown: new Set(layout.shown) };
  }, [resolvedPresets, presetLayout, order, hiddenList, shownList]);

  const allColumns = useMemo(() => {
    const alwaysFirst = rawColumns.filter((c) => c.alwaysVisible);
    const movable = rawColumns.filter((c) => !c.alwaysVisible);
    const effectiveOrder = order && order.length > 0 ? order : baselineLayout?.order ?? [];
    if (effectiveOrder.length === 0) return [...alwaysFirst, ...movable];
    const byKey = new Map(movable.map((c) => [c.key, c]));
    const ordered: Column<T>[] = [];
    for (const k of effectiveOrder) {
      const col = byKey.get(k);
      if (col) {
        ordered.push(col);
        byKey.delete(k);
      }
    }
    for (const c of movable) {
      if (byKey.has(c.key)) ordered.push(c);
    }
    return [...alwaysFirst, ...ordered];
  }, [rawColumns, order, baselineLayout]);

  const effectiveHidden = useMemo(() => {
    const hiddenSource = baselineLayout ? baselineLayout.hidden : userHidden;
    const shownSource = baselineLayout ? baselineLayout.shown : userShown;
    const set = new Set(hiddenSource);
    for (const c of allColumns) {
      if (c.defaultHidden && !shownSource.has(c.key)) set.add(c.key);
      if (c.canHide === false) set.delete(c.key);
    }
    return set;
  }, [allColumns, userHidden, userShown, baselineLayout]);

  const visibleColumns = useMemo(() => allColumns.filter((c) => c.alwaysVisible || !effectiveHidden.has(c.key)), [allColumns, effectiveHidden]);
  useEffect(() => { onShownColumnsChange?.(visibleColumns); }, [visibleColumns, onShownColumnsChange]);

  const mobileColumns = useMemo(() => {
    const byKey = new Map(visibleColumns.map((column) => [column.key, column]));
    let primary = visibleColumns[0];
    if (mobileCard?.primary) primary = byKey.get(mobileCard.primary) ?? primary;

    const cells = mobileCard?.cells
      ? mobileCard.cells
          .map((key) => byKey.get(key))
          .filter((column): column is Column<T> => !!column)
      : visibleColumns.filter((column) => column.key !== primary?.key);

    const layout = mobileCard?.layout ?? "stack";
    return {
      primary,
      cells,
      layout,
      hideLabels: mobileCard?.hideLabels ?? layout === "grid-2",
      estimateHeight:
        layout === "grid-2"
          ? Math.max(88, 58 + Math.ceil(cells.length / 2) * 24)
          : Math.max(88, 58 + cells.length * 24),
    };
  }, [mobileCard, visibleColumns]);

  const onScreenColumns = useMemo(() => {
    if (!overlayHidden?.length) return visibleColumns;
    const off = new Set(overlayHidden);
    return visibleColumns.filter((c) => c.alwaysVisible || !off.has(c.key));
  }, [visibleColumns, overlayHidden]);
  const displayColumns = useMemo(() => {
    if (pinnedSet.size === 0 && pinnedRightSet.size === 0) return onScreenColumns;
    const always = onScreenColumns.filter((c) => c.alwaysVisible);
    const pinnedCols = onScreenColumns.filter(
      (c) => !c.alwaysVisible && pinnedSet.has(c.key)
    );
    const rightCols = onScreenColumns.filter(
      (c) => !c.alwaysVisible && !pinnedSet.has(c.key) && pinnedRightSet.has(c.key)
    );
    const rest = onScreenColumns.filter(
      (c) =>
        !c.alwaysVisible && !pinnedSet.has(c.key) && !pinnedRightSet.has(c.key)
    );
    return [...always, ...pinnedCols, ...rest, ...rightCols];
  }, [onScreenColumns, pinnedSet, pinnedRightSet]);

  const dragIndex = useMemo(
    () => (dragCol ? displayColumns.findIndex((c) => c.key === dragCol) : -1),
    [displayColumns, dragCol]
  );

  const stickyCount = useMemo(() => {
    let n = 0;
    for (const c of displayColumns) {
      if (c.alwaysVisible || pinnedSet.has(c.key)) n++;
      else break;
    }
    return pinnedSet.size === 0 ? 0 : n;
  }, [displayColumns, pinnedSet]);

  const resolveWidth = useCallback(
    (col: Column<T>): number => {
      const user = widths[col.key];
      if (typeof user === "number" && user > 0) return user;
      const seen = measuredWidths?.[col.key];
      if (typeof seen === "number" && seen > 0) return seen;
      const parsed = parsePxWidth(col.width);
      return parsed ?? DEFAULT_COL_WIDTH;
    },
    [widths, measuredWidths]
  );

  const fixedTableWidth = useMemo(() => {
    if (!layoutFixed) return undefined;
    const lead = (selection ? 36 : 0) + (expandable ? 32 : 0);
    return lead + displayColumns.reduce((acc, c) => acc + resolveWidth(c), 0);
  }, [layoutFixed, selection, expandable, displayColumns, resolveWidth]);

  const stickyRightCount = useMemo(() => {
    if (pinnedRightSet.size === 0) return 0;
    let n = 0;
    for (let i = displayColumns.length - 1; i >= 0; i--) {
      if (pinnedRightSet.has(displayColumns[i].key)) n++;
      else break;
    }
    return n;
  }, [displayColumns, pinnedRightSet]);

  const stickyRight = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (let i = displayColumns.length - 1; i >= displayColumns.length - stickyRightCount; i--) {
      out[i] = acc;
      acc += resolveWidth(displayColumns[i]);
    }
    return out;
  }, [displayColumns, stickyRightCount, resolveWidth]);

  const stickyLeft = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (let i = 0; i < stickyCount; i++) {
      out[i] = acc;
      acc += resolveWidth(displayColumns[i]);
    }
    return out;
  }, [displayColumns, stickyCount, resolveWidth]);

  const chooserOptions = useMemo(
    () =>
      allColumns
        .filter((c) => !c.alwaysVisible)
        .map((c) => ({ key: c.key, label: c.label || c.key })),
    [allColumns]
  );

  const presetOptions = useMemo(() => {
    if (resolvedPresets.length === 0) return undefined;
    const movable = allColumns.filter((c) => !c.alwaysVisible);
    const known = new Set(movable.map((c) => c.key));
    const defaultHiddenKeys = new Set(
      movable.filter((c) => c.defaultHidden).map((c) => c.key),
    );
    const current = visibleColumns
      .filter((c) => !c.alwaysVisible)
      .map((c) => c.key);
    const rows = resolvedPresets.map((p) => {
      const layout = presetLayout(p);
      const hidden = new Set(layout.hidden);
      const shown = new Set(layout.shown);
      const ordered = layout.order.filter((k) => known.has(k));
      const seen = new Set(ordered);
      const arranged = [...ordered, ...[...known].filter((k) => !seen.has(k))];
      const wouldShow = arranged.filter(
        (k) => !hidden.has(k) && !(defaultHiddenKeys.has(k) && !shown.has(k)),
      );
      return {
        id: p.id,
        label: p.label,
        hint: p.hint,
        count: wouldShow.length,
        isDefault: p.isDefault,
        savedId: p.savedId,
        companyId: p.companyId,
        seed: p.seed,
        overridden: p.overridden,
        shared: p.shared,
        readOnly: p.seed || p.shared ? !layoutStore.canManageLayouts : undefined,
        active:
          wouldShow.length === current.length &&
          wouldShow.every((k, i) => current[i] === k),
      };
    });
    return withSingleActive(rows);
  }, [resolvedPresets, presetLayout, allColumns, visibleColumns, layoutStore.canManageLayouts]);

  function writeColumnPrefs(next: ColumnPrefs) {
    if (next.order) setOrder(next.order);
    setHiddenList(next.hidden);
    setShownList(next.shown);
  }

  function toggleColumn(key: string) {
    onUserAdjustColumns?.();
    const seen = { hidden: hiddenList, shown: shownList };
    writeColumnPrefs(toggleColumnPrefs(allColumns, effectiveHidden, key, seen, !!baselineLayout));
  }

  function resetVisibility() {
    setHiddenList([]);
    setShownList([]);
  }

  function applyPreset(id: string) {
    onUserAdjustColumns?.();
    const preset = resolvedPresets.find((p) => p.id === id);
    if (!preset) return;
    const layout = presetLayout(preset);
    const known = new Set(allColumns.filter((c) => !c.alwaysVisible).map((c) => c.key));
    const keep = (keys: string[]) => keys.filter((k) => known.has(k));
    const ordered = keep(layout.order);
    const orderedSet = new Set(ordered);
    setOrder([
      ...ordered,
      ...[...known].filter((k) => !orderedSet.has(k)),
    ]);
    setShownList(keep(layout.shown));
    setHiddenList(keep(layout.hidden));
    const hiddenSet = new Set(keep(layout.hidden));
    setPinned(keep(layout.pinned).filter((k) => !hiddenSet.has(k)));
    setPinnedRight(keep(layout.pinnedRight).filter((k) => !hiddenSet.has(k)));
    if (Object.keys(layout.widths).length > 0) updateWidths(layout.widths, true);
    if (groupBanner) setUserGroups(keep(layout.groupBy));
    if (preset.seed) onApplyLayoutSeed?.(preset.id.slice("seed:".length));
  }

  const myLayout = useMemo<StoredLayout>(
    () => ({
      order,
      hidden: hiddenList,
      shown: shownList,
      widths: storedWidths,
      pinned,
      pinnedRight,
      groupBy: userGroups,
    }),
    [order, hiddenList, shownList, storedWidths, pinned, pinnedRight, userGroups],
  );
  const myLayoutSignature = serializeLayout(myLayout);
  const syncedRef = useRef<{ key: string; signature: string } | null>(null);
  useEffect(() => {
    const previous = syncedRef.current;
    syncedRef.current = { key: baseIdKey, signature: myLayoutSignature };
    if (!previous || previous.key !== baseIdKey) return;
    if (previous.signature === myLayoutSignature) return;
    saveMyLayout(baseIdKey, myLayout);
  }, [baseIdKey, myLayoutSignature, myLayout]);

  useEffect(() => {
    if (!legacyGridKey) return;
    const marker = `dt:legacy:${idKey}`;
    try {
      if (localStorage.getItem(marker)) return;
    } catch {
      return;
    }
    const mark = () => {
      try {
        localStorage.setItem(marker, "1");
      } catch {
      }
    };
    const own =
      order.length + hiddenList.length + shownList.length + pinned.length + pinnedRight.length +
      userGroups.length + Object.keys(storedWidths).length;
    if (own > 0) return mark();
    const grid = readLegacyGridLayout(dataGridIdKey(legacyGridKey, activeCompany));
    if (!grid) return;
    const layout = gridLayoutToTableLayout(grid, rawColumns);
    setOrder(layout.order);
    setHiddenList(layout.hidden);
    setShownList(layout.shown);
    setPinned(layout.pinned);
    if (Object.keys(layout.widths).length > 0) updateWidths(layout.widths, true);
    if (groupBanner) setUserGroups(layout.groupBy);
    if (grid.sort && persistSort && rawColumns.some((c) => c.key === grid.sort!.key)) setSort(grid.sort);
    mark();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per table key; state read is the mount snapshot
  }, [idKey, legacyGridKey]);

  const [defaultSaveState, setDefaultSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const activeCompanyName = useMemo(() => {
    const co = layoutStore.companies.find((x) => x.id === layoutStore.activeCompanyId);
    return co ? shortCompanyName(co.name) : "";
  }, [layoutStore]);
  const writeCompanyDefault = useCallback(
    async (layout: StoredLayout) => {
      setDefaultSaveState("saving");
      try {
        await saveCompanyDefault(baseIdKey, layout);
        setDefaultSaveState("saved");
      } catch {
        setDefaultSaveState("error");
      }
    },
    [baseIdKey],
  );
  const renderedLayout = useMemo<StoredLayout>(() => {
    const movable = allColumns.filter((c) => !c.alwaysVisible);
    return {
      order: movable.map((c) => c.key),
      hidden: movable.filter((c) => effectiveHidden.has(c.key)).map((c) => c.key),
      shown: movable
        .filter((c) => c.defaultHidden && !effectiveHidden.has(c.key))
        .map((c) => c.key),
      widths: storedWidths,
      pinned,
      pinnedRight,
      groupBy: userGroups,
    };
  }, [allColumns, effectiveHidden, storedWidths, pinned, pinnedRight, userGroups]);

  const defaultManager = useMemo(() => {
    if (!layoutStore.ready || !layoutStore.canManageDefaults) return undefined;
    if (layoutStore.activeCompanyId == null || !activeCompanyName) return undefined;
    return {
      companyLabel: activeCompanyName,
      hasSaved: Boolean(
        layoutStore.defaults[String(layoutStore.activeCompanyId)]?.[baseIdKey],
      ),
      state: defaultSaveState,
      onSave: () => writeCompanyDefault(renderedLayout),
      onClear: () =>
        writeCompanyDefault(EMPTY_LAYOUT),
    };
  }, [
    layoutStore,
    activeCompanyName,
    baseIdKey,
    defaultSaveState,
    renderedLayout,
    writeCompanyDefault,
  ]);

  function resetOrder() {
    setOrder([]);
    updateWidths({}, true);
    setPinned([]);
    setPinnedRight([]);
  }

  const drawerColumns = useMemo<DrawerColumn[]>(
    () =>
      allColumns
        .filter((c) => !c.alwaysVisible)
        .map((c) => ({
          key: c.key,
          label: headerLabel(c.label || c.key),
          group: c.group || inferColumnGroup(c.key, c.label || c.key) || "",
          visible: !effectiveHidden.has(c.key),
          canHide: c.canHide !== false,
          width: resolveWidth(c),
          pinned: pinnedSet.has(c.key)
            ? ("left" as const)
            : pinnedRightSet.has(c.key)
              ? ("right" as const)
              : null,
        })),
    [allColumns, effectiveHidden, resolveWidth, pinnedSet, pinnedRightSet]
  );

  function showAllColumns() {
    onUserAdjustColumns?.();
    writeColumnPrefs(showAllColumnPrefs(allColumns, effectiveHidden, Boolean(baselineLayout)));
  }

  function resetLayout() {
    onUserAdjustColumns?.();
    resetVisibility();
    resetOrder();
    /* Sort is persisted per table in `dt:sort:<id>` and replayed on every mount,
       so a column clicked once months ago becomes the permanent default. Owner,
       2026-08-04, on the Delivery Orders list opening oldest-first every time:
       "为什么当我打开这个系统的一瞬间，它不是默认自动 sort 那个 documentation 呢？"
       The backend's default IS newest-first (`do_date` DESC); the stored sort
       simply never let it apply.
       Reset must clear it too, or the one control named for undoing a layout
       cannot undo the most visible part of one. reportServerSort is called
       explicitly because the mount effect that normally pushes it up runs once
       with [] deps. */
    setSort(null);
    reportServerSort(null);
    setWrapText(false);
  }

  const layoutDirty = Boolean(
    presetOptions && presetOptions.length > 0 && !presetOptions.some((p) => p.active)
  );

  const saveNamedLayout = useCallback(
    (name: string) => createNamedLayout(baseIdKey, name, renderedLayout).then(() => undefined),
    [baseIdKey, renderedLayout]
  );
  const duplicateNamedLayout = useCallback(
    (id: string, name: string) => {
      const source = resolvedPresets.find((p) => p.id === id);
      return createNamedLayout(baseIdKey, name, source ? presetLayout(source) : renderedLayout).then(
        () => undefined
      );
    },
    [baseIdKey, resolvedPresets, presetLayout, renderedLayout]
  );
  const renameLayout = useCallback(
    (id: string, name: string) => {
      const target = resolvedPresets.find((p) => p.id === id);
      if (target?.savedId != null) return renameNamedLayout(target.tableKey ?? baseIdKey, target.savedId, name);
      if (target?.companyId != null) return renameCompanyDefault(baseIdKey, name);
      return Promise.resolve();
    },
    [baseIdKey, resolvedPresets]
  );
  /* "Edit this layout" (owner 2026-08-02: default layout 需要可以 edit) — one
     handler, two destinations again: a saved layout is replaced by id, the
     COMPANY row goes through the same publish path the footer button uses. */
  const updateLayout = useCallback(
    async (id: string) => {
      if (id.startsWith("shared:")) return saveSharedLayout(baseIdKey, id.slice("shared:".length), renderedLayout);
      if (id.startsWith("seed:")) return saveSharedLayout(baseIdKey, id.slice("seed:".length), renderedLayout);
      const target = resolvedPresets.find((p) => p.id === id);
      if (target?.savedId != null && target.tableKey) {
        await createNamedLayout(baseIdKey, target.label, renderedLayout);
        return deleteNamedLayout(target.tableKey, target.savedId);
      }
      if (target?.savedId != null) {
        return updateNamedLayout(baseIdKey, target.savedId, renderedLayout);
      }
      if (target?.companyId != null) return saveCompanyDefault(baseIdKey, renderedLayout);
      return Promise.resolve();
    },
    [baseIdKey, resolvedPresets, renderedLayout]
  );

  const deleteSavedLayout = useCallback(
    (savedId: number) =>
      deleteNamedLayout(resolvedPresets.find((p) => p.savedId === savedId)?.tableKey ?? baseIdKey, savedId),
    [baseIdKey, resolvedPresets]
  );
  const resetSeedLayout = useCallback(
    async (id: string) => {
      if (!id.startsWith("seed:")) return;
      const name = id.slice("seed:".length);
      const shared = layoutStore.sharedLayouts as Record<string, NamedLayout[] | undefined>;
      if (shared[baseIdKey]?.some((l) => l.name === name)) await deleteSharedLayout(baseIdKey, name);
      const legacyKey = legacyGridKey ? dataGridTableKey(legacyGridKey) : null;
      if (legacyKey && shared[legacyKey]?.some((l) => l.name === name)) await deleteSharedLayout(legacyKey, name);
    },
    [baseIdKey, legacyGridKey, layoutStore.sharedLayouts]
  );

  const { share: shareLayout, unshare: unshareLayout } = makeLayoutShareActions(baseIdKey, resolvedPresets, presetLayout);

  function exportColumnConfig() {
    const payload = {
      table: baseIdKey,
      exportedAt: new Date().toISOString(),
      columns: drawerColumns.map(({ key, label, group, visible, width, pinned }) => ({
        key,
        label,
        group: group || undefined,
        visible,
        width,
        pinned,
      })),
    };
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `columns-${baseIdKey}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
    }
  }

  const resizeRef = useRef<{ key: string; startX: number; startW: number } | null>(
    null
  );
  const endResizeRef = useRef<((persistDirectly?: boolean) => void) | null>(null);

  useEffect(() => {
    return () => {
      endResizeRef.current?.(true);
    };
  }, [widthStorageKey]);

  function onResizeStart(e: React.MouseEvent, col: Column<T>) {
    e.preventDefault();
    e.stopPropagation();
    endResizeRef.current?.();
    const gesture = {
      key: col.key,
      startX: e.clientX,
      startW: resolveWidth(col),
    };
    resizeRef.current = gesture;
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current;
      if (r !== gesture) return;
      const next = Math.max(MIN_COL_WIDTH, r.startW + (ev.clientX - r.startX) / fit.scaleRef.current);
      updateWidths((prev) => ({ ...prev, [r.key]: next }), false);
    };
    const onUp = () => finish();
    const onBlur = () => finish();
    const finish = (persistDirectly = false) => {
      if (resizeRef.current !== gesture) return;
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
      if (endResizeRef.current === finish) endResizeRef.current = null;
      if (persistDirectly) {
        try {
          localStorage.setItem(widthStorageKey, JSON.stringify(widthsRef.current));
        } catch {
        }
      } else {
        setStoredWidths(widthsRef.current);
      }
    };
    endResizeRef.current = finish;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
  }

  function autoFitColumn(key: string) {
    const cells = scrollWrapRef.current?.querySelectorAll<HTMLElement>(`[data-col-key="${CSS.escape(key)}"]`);
    let widest = 0;
    cells?.forEach((cell) => {
      const was = cell.style.whiteSpace;
      cell.style.whiteSpace = "nowrap";
      widest = Math.max(widest, cell.scrollWidth);
      cell.style.whiteSpace = was;
    });
    if (widest > 0) {
      const fit = Math.min(800, Math.max(MIN_COL_WIDTH, Math.ceil(widest) + 8));
      updateWidths((prev) => ({ ...prev, [key]: fit }), true);
      return;
    }
    updateWidths((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    }, true);
  }

  /**
   * none → left → right → none (design handoff; owner 2026-08-03).
   *
   * A column is only ever in ONE of the two lists — the cycle MOVES it. Being
   * frozen to both edges is not a state a table can render, so it is not a
   * state this can produce.
   */
  function togglePin(key: string) {
    const side = pinnedSet.has(key) ? "left" : pinnedRightSet.has(key) ? "right" : null;
    if (side === null) {
      setPinned((prev) => [...prev, key]);
    } else if (side === "left") {
      setPinned((prev) => prev.filter((k) => k !== key));
      setPinnedRight((prev) => (prev.includes(key) ? prev : [...prev, key]));
    } else {
      setPinnedRight((prev) => prev.filter((k) => k !== key));
    }
  }

  // Owner 2026-09-27: freeze the first N columns in one step (see DataTableFreezeItems).
  const freezeUpTo = (key: string) => { const keys = keysThrough(displayColumns, key); setPinned(keys); setPinnedRight((p) => p.filter((k) => !keys.includes(k))); };

  const reorderTo = useCallback(
    (key: string, targetKey: string) => {
      if (key === targetKey) return;
      const next = allColumns.filter((c) => !c.alwaysVisible).map((c) => c.key);
      const from = next.indexOf(key);
      const to = next.indexOf(targetKey);
      if (from < 0 || to < 0) return;
      next.splice(from, 1);
      next.splice(to, 0, key);
      setOrder(next);
    },
    [allColumns, setOrder]
  );

  const canDragHeader = (c: Column<T>) => !c.alwaysVisible;

  const freezeSideOf = (key: string) =>
    pinnedSet.has(key) ? "left" : pinnedRightSet.has(key) ? "right" : "none";

  const canDropHeader = (c: Column<T>) =>
    !!dragCol &&
    dragCol !== c.key &&
    canDragHeader(c) &&
    freezeSideOf(dragCol) === freezeSideOf(c.key);

  function endHeaderDrag() {
    setDragCol(null);
    setDropCol(null);
  }

  /* Ctrl+C (owner 2026-09-25): the ticked rows, or the row in focus, as cells
     Excel pastes. A text selection is the browser's own copy and is left alone,
     as is any key pressed inside a field. */
  const [copiedNote, setCopiedNote] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedNote) return;
    const t = setTimeout(() => setCopiedNote(null), 2500);
    return () => clearTimeout(t);
  }, [copiedNote]);
  function handleCopyKey(e: React.KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "c") return;
    const target = e.target as HTMLElement;
    if (target.closest("textarea, select, [contenteditable='true']")) return;
    if (target instanceof HTMLInputElement && target.type !== "checkbox") return;
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    if (!sortedRows?.length) return;
    let picked: T[] = actionRows?.picked ? actionRows.rows : [];
    if (picked.length === 0) {
      const key = target.closest<HTMLElement>("tr[data-rowkey]")?.dataset.rowkey;
      const row = key == null ? undefined : sortedRows.find((r) => String(getRowKey(r)) === key);
      if (row) picked = [row];
    }
    if (picked.length === 0 || !navigator.clipboard) return;
    e.preventDefault();
    const n = picked.length;
    navigator.clipboard.writeText(rowsToTsv(picked, visibleColumns)).then(
      () => setCopiedNote(`Copied ${n} row${n === 1 ? "" : "s"}`),
      () => setCopiedNote("The browser blocked the copy"),
    );
  }

  const [exporting, setExporting] = useState(false);
  async function handleLineExport(spec: DataTableLineExport<T, L>) {
    if (exporting) return;
    setExporting(true);
    try {
      const cols = exportableColumns(visibleColumns as Column<T, L>[]);
      const filterKeys = Object.entries(colFilters).filter(([, v]) => v.length > 0).map(([k]) => k);
      const fetched = await spec.fetchRows({ exportKeys: cols.map((c) => c.key), filterKeys });
      const kept = tickedOrAll(sortTableRows(applyColumnFilters(fetched, colFilters, allColumns), sort, allColumns, Boolean(serverSort), defaultSort ?? null), selection?.selectedIds, getRowKey).rows;
      const matrix = buildLineExportMatrix(kept, spec.linesOf, cols);
      const date = todayMyt();
      await writeLineExportFile(matrix, spec.sheetName, `${exportName || tableId || "export"}-${date}.xlsx`);
    } catch (e) {
      spec.onError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setExporting(false);
    }
  }

  function handleExport() {
    if (rowActionsDisabled) return;
    if (exportLines) { void handleLineExport(exportLines); return; }
    const csvCols = csvColumnsOf(visibleColumns as Column<T, L>[]);
    if (onExport) { onExport(csvCols); return; }
    if (!actionRows || actionRows.rows.length === 0 || csvCols.length === 0) return;
    const date = todayMyt(), outRows = actionRows.rows;
    if (exportXlsx) {
      const matrix = buildLineExportMatrix(outRows, () => [], exportableColumns(visibleColumns as Column<T, L>[]));
      const sheet = exportSheet?.(outRows);
      void writeLineExportFile(matrix, sheet?.name ?? "Sheet1", `${exportName || tableId || "export"}-${date}.xlsx`, sheet?.heading);
      return;
    }
    downloadCSV(`${exportName || tableId || "export"}-${date}.csv`, toCSV(outRows, csvCols));
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && onImport) onImport(f);
    e.target.value = "";
  }


  const canSortColumn = useCallback(
    (col: Column<T>) => !!col.sortCompare || (!!col.getValue && (!col.disableSort || !!serverSort)),
    [serverSort]
  );

  const serverReportable = useCallback(
    (s: SortState | null): SortState | null => {
      if (!s) return null;
      const col = allColumns.find((c) => c.key === s.key);
      return col?.getValue && !col.disableSort && !col.sortCompare ? s : null;
    },
    [allColumns]
  );

  const lastReportedSortRef = useRef<string | null | undefined>(undefined);
  const reportServerSort = useCallback(
    (next: SortState | null) => {
      if (!serverSort || !onSortChange) return;
      const reportable = serverReportable(next);
      const sig = reportable ? `${reportable.key}:${reportable.dir}` : null;
      if (lastReportedSortRef.current === sig) return;
      lastReportedSortRef.current = sig;
      onSortChange(reportable);
    },
    [serverSort, onSortChange, serverReportable]
  );

  function onHeaderClick(col: Column<T>) {
    if (!canSortColumn(col)) return;
    const cur = sort;
    let next: SortState | null;
    if (!cur || cur.key !== col.key) next = { key: col.key, dir: "asc" };
    else if (cur.dir === "asc") next = { key: col.key, dir: "desc" };
    else next = null;
    setSort(next);
    reportServerSort(next);
  }

  function applySort(col: Column<T>, dir: SortDir) {
    if (!canSortColumn(col)) return;
    const next: SortState = { key: col.key, dir };
    setSort(next);
    reportServerSort(next);
  }

  useEffect(() => {
    reportServerSort(sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!headerMenu) return;
    const close = () => setHeaderMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [headerMenu]);

  // Close the filter popover on outside click or Escape, like the header menu;
  // clicks inside stop propagation so ticking checkboxes doesn't dismiss it.
  // A scroll (heard in the CAPTURE phase: scroll doesn't bubble) never closes
  // it, it measures the funnel again and the popover moves with it. Closing on
  // scroll shut it after ONE tick (owner 2026-11-12, "filter 点一个会自动关"): a
  // tick shortens the table, the browser pulls a scrolled table box or page
  // back inside the shorter rows and fires `scroll` for that, exactly as if a
  // person had scrolled. Its own value list scrolls freely too (2026-07-29).
  const filterAnchor = filterMenu?.anchor ?? null;
  useEffect(() => {
    if (!filterAnchor) return;
    const close = () => setFilterMenu(null);
    const follow = () => {
      if (!filterAnchor.isConnected) return close();
      const { left, top, bottom } = filterAnchor.getBoundingClientRect();
      setFilterMenu((cur) => (cur && (cur.left !== left || cur.top !== top || cur.bottom !== bottom) ? { ...cur, left, top, bottom } : cur));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterAnchor]);

  useEffect(() => {
    if (!rowMenu) return;
    const close = () => setRowMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [rowMenu]);

  const searchBlobs = useMemo(() => {
    const q = clientQuery.trim();
    return clientSearching && rows && q ? new Map(rows.map((r) => [r, buildSearchBlob(r, allColumns)])) : null;
  }, [clientSearching, rows, allColumns, clientQuery]);
  const filteredRows = useMemo(() => {
    if (!rows) return rows;
    const q = clientQuery.trim().toLowerCase();
    const searched = searchBlobs && q ? rows.filter((r) => (searchBlobs.get(r) ?? "").includes(q)) : rows;
    return applyColumnFilters(searched, colFilters, allColumns);
  }, [rows, colFilters, allColumns, searchBlobs, clientQuery]);
  /* Rows exist but the funnels / search hide every one: say so and name them,
     never the page's "nothing here" label (DP Overdue, owner 2026-11-10). */
  const activeFilters = useMemo(() => activeFilterSummary(colFilters, allColumns), [colFilters, allColumns]);
  const clearFunnelsAndSearch = () => { setColFilters({}); if (clientQueryActive) setClientQuery(""); };
  const hiddenByFilters = (rows?.length ?? 0) > 0 && filteredRows?.length === 0 && (activeFilters.length > 0 || clientQueryActive);
  const emptyContent = hiddenByFilters
    ? <FilteredEmptyNotice hiddenCount={rows?.length ?? 0} filters={activeFilters} query={clientQueryActive ? clientQuery.trim() : null} onClear={clearFunnelsAndSearch} />
    : emptyLabel;

  const sortedRows = useMemo(
    () => (filteredRows ? sortTableRows(filteredRows, sort, allColumns, Boolean(serverSort), defaultSort ?? null) : filteredRows),
    [filteredRows, sort, allColumns, serverSort, defaultSort],
  );

  /* "Load more" (owner 2026-09-26): render only the first `rowLimit` of the
     sorted set, revealing another `initialRowLimit` per click. `null` = show all
     (the default and what "Load more" builds up to). Search / filters / sort and
     the reported count below still run over the WHOLE set — only the render is
     capped. State, so it resets to the first page each time the table remounts. */
  const [rowLimit, setRowLimit] = useState<number | null>(initialRowLimit ?? null);
  const limitedRows = useMemo(
    () => (sortedRows && rowLimit != null && sortedRows.length > rowLimit ? sortedRows.slice(0, rowLimit) : sortedRows),
    [sortedRows, rowLimit],
  );
  const hiddenByLimit = (sortedRows?.length ?? 0) - (limitedRows?.length ?? 0);
  const actionRows = useMemo(() => (sortedRows ? tickedOrAll(sortedRows, selection?.selectedIds, getRowKey) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getRowKey is an inline prop; keys are stable per row
    [sortedRows, selection?.selectedIds]);
  const footerTotals = actionRows?.rows.length && displayColumns.some((c) => c.total) ? actionRows : null;
  const loadMore = () => setRowLimit((n) => (n ?? 0) + (initialRowLimit ?? 200));
  const rowReorderable = !!onRowReorder && sort == null;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const dragScroll = useDragAutoScroll(() => scrollWrapRef.current);
  const onRowDrop = (toKey: string) => {
    dragScroll.stop();
    if (dragKey && dragKey !== toKey && sortedRows) {
      onRowReorder?.(reorderKeys(sortedRows.map((r) => String(getRowKey(r))), dragKey, toKey));
    }
    setDragKey(null);
    setDropKey(null);
  };

  /* Report what the operator can actually see (owner 2026-08-12) — see the
     onFilteredRowsChange prop doc. In an effect, not during render, so a parent
     that stores these in state cannot re-enter this render pass. `rows` is
     undefined while loading; skip rather than publish an empty set, or a
     summary card would blink to zero on every refetch. */
  const reportedRowsRef = useRef<T[] | null>(null);
  useEffect(() => {
    if (!sortedRows) return;
    const prev = reportedRowsRef.current;
    if (prev && prev.length === sortedRows.length && prev.every((r, i) => r === sortedRows[i])) return;
    reportedRowsRef.current = sortedRows;
    onFilteredRowsChange?.(sortedRows);
  }, [sortedRows, onFilteredRowsChange]);

  const expandColCount = expandable ? 1 : 0;
  const selectColCount = selection ? 1 : 0;
  const fillerCount = layoutFixed ? 1 : 0;
  const fillerAt = displayColumns.length - stickyRightCount;
  const totalColSpan = displayColumns.length + expandColCount + selectColCount + fillerCount;
  useLayoutEffect(() => {
    if (layoutFixed || !showTable || effectiveLoading || !sortedRows?.length) return;
    const heads = scrollWrapRef.current?.querySelectorAll<HTMLElement>("thead th[data-col-key]");
    if (!heads?.length) return;
    const next: Record<string, number> = {};
    for (const th of heads) {
      const w = th.getBoundingClientRect().width;
      if (w <= 0) return;
      next[th.dataset.colKey!] = Math.max(MIN_COL_WIDTH, Math.round(w));
    }
    setMeasured({ idKey, widths: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollWrapRef is a ref
  }, [layoutFixed, showTable, effectiveLoading, sortedRows, idKey]);

  const fit = useTableFitWidth(idKey, fitToWidth && showTable && !isSmallViewport, () => scrollWrapRef.current, fixedTableWidth);

  const headerText = (c: Column<T>) => c.label || c.key;
  type RenderItem =
    | { kind: "group"; path: string; level: number; label: string; count: number; collapsed: boolean }
    | { kind: "row"; row: T; rowIdx: number };
  const groupLevels = useMemo(() => {
    const byKey = new Map(allColumns.map((c) => [c.key, c]));
    if (groupBanner && userGroups.length > 0) {
      return userGroups
        .map((k) => byKey.get(k))
        .filter((c): c is Column<T> => !!c?.getValue)
        .map((c) => ({ col: c, label: (v: string) => `${headerText(c)}: ${v || "(blank)"}` }));
    }
    const code = groupBy ? byKey.get(groupBy.key) : undefined;
    if (!groupBy || !code?.getValue) return [];
    const fmt = groupBy.label;
    return [{ col: code, label: (v: string) => (fmt ? fmt(v) : v || "(blank)") }];
  }, [allColumns, groupBanner, userGroups, groupBy]);
  const renderList = useMemo<RenderItem[]>(() => {
    if (!limitedRows) return [];
    if (groupLevels.length === 0) {
      return limitedRows.map((row, rowIdx) => ({ kind: "row", row, rowIdx }));
    }
    const out: RenderItem[] = [];
    let rowIdx = 0;
    const walk = (rowsIn: T[], level: number, parentPath: string) => {
      const { col, label } = groupLevels[level];
      const order: string[] = [];
      const buckets = new Map<string, T[]>();
      for (const row of rowsIn) {
        const raw = col.getValue!(row);
        const val = raw == null || raw === "" ? "" : String(raw);
        if (!buckets.has(val)) {
          buckets.set(val, []);
          order.push(val);
        }
        buckets.get(val)!.push(row);
      }
      for (const val of order) {
        const bucket = buckets.get(val)!;
        const path = level === 0 ? val : `${parentPath}${val}`;
        const collapsed = collapsedGroupSet.has(path);
        out.push({ kind: "group", path, level, label: label(val), count: bucket.length, collapsed });
        if (collapsed) {
          rowIdx += bucket.length;
        } else if (level + 1 < groupLevels.length) {
          walk(bucket, level + 1, path);
        } else {
          for (const row of bucket) out.push({ kind: "row", row, rowIdx: rowIdx++ });
        }
      }
    };
    walk(limitedRows, 0, "");
    return out;
  }, [limitedRows, groupLevels, collapsedGroupSet]);

  /* Collapse-all / Expand-all (owner "like Google Sheets" row outline, 2026-10-24):
     one control to fold every group to its header row or open them all, on top of
     the existing per-group collapse (clicking a header). Folds the TOP level, so a
     nested outline collapses to its outermost groups, exactly as a sheet does. */
  const topGroupPaths = useMemo(
    () => renderList.flatMap((it) => (it.kind === "group" && it.level === 0 ? [it.path] : [])),
    [renderList],
  );
  const allGroupsCollapsed =
    topGroupPaths.length > 0 && topGroupPaths.every((p) => collapsedGroupSet.has(p));
  const collapseAllGroups = useCallback(
    () => setCollapsedGroups((prev) => [...new Set([...prev, ...topGroupPaths])]),
    [topGroupPaths, setCollapsedGroups],
  );
  const expandAllGroups = useCallback(() => setCollapsedGroups([]), [setCollapsedGroups]);

  const cellPad = embedded ? "px-2 py-1 leading-tight" : "px-3 py-1.5 leading-tight";
  const headPad = embedded ? "px-2 py-1.5 leading-tight" : "px-3 py-2 leading-tight";

  const toolbarBtn =
    "inline-flex h-11 sm:h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-surface disabled:hover:text-ink-secondary";

  const rowCount = sortedRows?.length ?? 0;
  const visibleCount = chooserOptions.filter((o) => !effectiveHidden.has(o.key)).length;

  const selectableKeys = useMemo(
    () =>
      selection && sortedRows
        ? sortedRows
            .map((r) => String(getRowKey(r)))
            .filter((k) => !selection.isDisabled?.(k))
        : [],
    [selection, sortedRows, getRowKey]
  );
  const rowClickTicks = !!selection?.toggleOnRowClick;
  const allRowsSelected =
    !!selection &&
    selectableKeys.length > 0 &&
    selectableKeys.every((k) => selection.selectedIds.has(k));
  const someRowsSelected =
    !!selection &&
    !allRowsSelected &&
    selectableKeys.some((k) => selection.selectedIds.has(k));

  // ── Row windowing (page-scroll-preserving) ─────────────────────────────────
  // Short lists and (while a row is open) expandable tables render in full. The
  // tbody is measured against the viewport on scroll (from ANY ancestor — a
  // capturing window listener catches non-bubbling scroll events) and on resize;
  // only the visible slice of `renderList` is rendered, bracketed by two spacer
  // <tr>s that reserve the off-screen height so the page scrollbar and sticky
  // header behave exactly as before. Row height is the AVERAGE of the drawn items
  // so the spacers can't drift (avoids the HOOKKA getTotalSize lag).
  //
  // GROUPED lists window too (owner follow-up 2026-10-23). `renderList` already
  // interleaves non-sticky group-header items with row items and already drops
  // collapsed groups' rows, so the slice path and collapse-shrinks-the-DOM both
  // work unchanged; the height average blends header (`data-vgrp`) and row
  // (`data-vrow`) heights (near-equal one-liners) so the per-item spacer estimate
  // stays honest. A flat list has no `data-vgrp` rows, so its behaviour is
  // byte-identical to before.
  // `expandable` used to disqualify a table outright. That excluded the single
  // largest list in the app: /scm/inventory's balances table is expandable (the
  // chevron opens per-warehouse / variant detail) and measured 2026-08-01 at
  // 344 rows in 11,963 DOM nodes, while every windowed table sat near 1,500.
  //
  // The exclusion existed for a real reason — an expanded row injects an extra
  // <tr> of unpredictable height, which breaks the uniform-row-height assumption
  // the spacers depend on. But that reason only holds WHILE something is
  // expanded. With nothing expanded, an expandable table's rows are as uniform
  // as any other table's, so it can window exactly like one.
  //
  // So: window while collapsed, and fall back to rendering in full the moment
  // any row opens. Expanding is then byte-identical to today's behaviour — the
  // risky state is simply never the windowed one. Collapsing the last row
  // returns it to the windowed path.
  const canVirtualize =
    showTable && !effectiveLoading && !error &&
    (!expandable || expandedRowsEffective.size === 0) &&
    renderList.length > VIRTUAL_ROW_THRESHOLD;
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const rowHeightRef = useRef(ROW_HEIGHT_ESTIMATE);
  const [winRange, setWinRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: VIRTUAL_ROW_THRESHOLD * 2,
  });

  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollToRow) return;
    const key = scrollToRow.key;
    setHighlightKey(key);
    const idx = renderList.findIndex((it) => it.kind === "row" && String(getRowKey(it.row)) === key);
    if (idx < 0) return;
    const find = () => tbodyRef.current?.querySelector<HTMLElement>(`tr[data-rowkey="${CSS.escape(key)}"]`);
    const settle = () => { find()?.scrollIntoView({ block: "center" }); };
    if (find()) { settle(); return; }
    const offset = idx * (rowHeightRef.current || ROW_HEIGHT_ESTIMATE);
    const wrap = scrollWrapRef.current;
    if (wrap && wrap.scrollHeight > wrap.clientHeight) {
      wrap.scrollTop = offset;
      wrap.dispatchEvent(new Event("scroll"));
    } else if (tbodyRef.current) {
      scrollPanelNearRow(tbodyRef.current, offset);
    }
    const raf = requestAnimationFrame(() => requestAnimationFrame(settle));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires per nonce, not per render
  }, [scrollToRow?.nonce]);
  useEffect(() => {
    if (!canVirtualize) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = tbodyRef.current;
      if (!el) return;
      const drawn = el.querySelectorAll<HTMLElement>("tr[data-vrow], tr[data-vgrp]");
      let sum = 0;
      drawn.forEach((tr) => { sum += tr.offsetHeight; });
      if (drawn.length > 0 && sum > 0) rowHeightRef.current = sum / drawn.length;
      const rh = rowHeightRef.current || ROW_HEIGHT_ESTIMATE;
      const top = el.getBoundingClientRect().top / fit.scaleRef.current;
      const vh = window.innerHeight / fit.scaleRef.current;
      const first = Math.max(0, Math.floor(-top / rh) - VIRTUAL_OVERSCAN);
      const count = Math.ceil(vh / rh) + VIRTUAL_OVERSCAN * 2;
      const last = Math.min(renderList.length, first + count);
      setWinRange((prev) => (prev.start === first && prev.end === last ? prev : { start: first, end: last }));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit.scaleRef is a ref
  }, [canVirtualize, renderList.length, fit.fitScale]);
  const vStart = canVirtualize ? winRange.start : 0;
  const vEnd = canVirtualize ? Math.min(renderList.length, winRange.end) : renderList.length;

  /* Frozen table header — owner 2026-07-24, "每个table的header都要freeze".
     The geometry moved to useFrozenTableHeader on 2026-09-09 so the MRP page's
     hand-built tree table freezes by the same mechanism; the reasoning, and the
     owner feedback each iteration came from, lives in that file. */
  const {
    rootRef: freezeRootRef,
    scrollWrapRef,
    spacerRef: runwaySpacerRef,
    freezeBox,
    boxStyle: freezeBoxStyle,
    scrollStyle: freezeScrollStyle,
  } = useFrozenTableHeader(showTable && freezeHeight !== "off", freezeFrom ?? "toolbar", freezeHeight === "screen");
  const shownRows = useMemo(() => renderList.flatMap((it) => (it.kind === "row" ? [it.row] : [])), [renderList]);
  const cellRange = useCellRange({ enabled: cellRangeSum, scrollRef: scrollWrapRef, rows: shownRows, columns: visibleColumns, getRowKey });

  return (
    <div ref={freezeRootRef}>
      {urlFilterParam && inRouter && <UrlFilterResync param={urlFilterParam} value={serializeUrlColFilters(colFilters)} />}
      <div className={cn("mb-2.5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between", embedded && "hidden")}>
        <div className="flex flex-1 flex-wrap items-center gap-2 sm:gap-3">
          {search && (
            <div className="w-full sm:w-72 sm:max-w-full">
              <div className="relative">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
                />
                <DebouncedSearchInput
                  inputRef={searchInputRef}
                  value={search.value}
                  onChange={search.onChange}
                  placeholder={search.placeholder || "Search…"}
                  delayMs={search.debounceMs ?? 250}
                  onPendingChange={search.searching !== undefined ? setSearchDraftPending : undefined}
                  className={cn(
                    "h-9 w-full rounded-md border border-border bg-surface pl-8 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20 sm:h-8 sm:text-[12px]",
                    searchBusy ? "pr-24" : "pr-3",
                  )}
                />
                {searchBusy && (
                  <span
                    role="status"
                    aria-live="polite"
                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-primary"
                  >
                    {search.searchingLabel ?? "Searching…"}
                  </span>
                )}
              </div>
              <SearchScopeHint
                scope={search.scope ?? "loaded"}
                searching={searchBusy}
                countPending={search.countPending}
                resultCount={search.totalRecords}
                loadedLimit={search.loadedLimit}
                term={search.value}
                className="mt-1 px-1"
              />
            </div>
          )}
          <ResetFiltersButton
            active={colFiltersActive || clientQueryActive || (resetFilters?.active ?? false)}
            onReset={handleResetFilters}
            label={resetFilters?.label}
          />
          <ActiveFiltersChip filters={activeFilters} onClear={() => setColFilters({})} />
          <div className="flex items-center gap-2 text-[11px] font-medium text-ink-secondary">
            {caption && (
              <>
                <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  {caption}
                </span>
                <span className="text-ink-muted">·</span>
              </>
            )}
            {rowActionsDisabled ? (
              <span className="text-ink-muted">{error ? "Unavailable" : "Loading…"}</span>
            ) : rows ? (
              <span>
                <span className="font-mono text-ink">{rowCount.toLocaleString()}</span>
                <span className="ml-1 text-ink-muted">{rowCount === 1 ? "row" : "rows"}</span>
                <span className="mx-2 text-ink-muted">·</span>
                <span className="font-mono text-ink">{visibleColumns.length}</span>
                <span className="ml-1 text-ink-muted">of {allColumns.length} cols</span>
                {copiedNote && <span role="status" className="ml-2 text-primary">{copiedNote}</span>}
                {onRowReorder && sort && <button type="button" className="ml-2 text-primary underline" onClick={() => { setSort(null); reportServerSort(null); }}>Clear sort to drag rows</button>}
              </span>
            ) : (
              <span className="text-ink-muted">Loading…</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onImport && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                className="hidden"
              />
              <button onClick={handleImportClick} className={toolbarBtn}>
                <Upload size={13} />
                Import
              </button>
            </>
          )}
          <button
            onClick={handleExport}
            disabled={rowActionsDisabled || exporting || !sortedRows || sortedRows.length === 0}
            className={toolbarBtn}
          >
            <Download size={13} />
            {exporting ? "Exporting…" : actionRows?.picked && !onExport ? `${exportLabel} (${actionRows.rows.length})` : exportLabel}
          </button>
          {toolbarExtra}
          <button
            onClick={() =>
              setMobileView(mobileView === "cards" ? "table" : "cards")
            }
            className={cn(toolbarBtn, "sm:hidden")}
            title={
              mobileView === "cards"
                ? "Switch to table view"
                : "Switch to card view"
            }
            aria-label={
              mobileView === "cards"
                ? "Switch to table view"
                : "Switch to card view"
            }
          >
            {mobileView === "cards" ? (
              <TableIcon size={13} />
            ) : (
              <LayoutList size={13} />
            )}
            {mobileView === "cards" ? "Table" : "Cards"}
          </button>
          <button
            type="button"
            onClick={() => setWrapText(!wrapText)}
            aria-pressed={wrapText}
            title={wrapText ? "Show each row on one line" : "Wrap long text onto more lines"}
            className={cn(toolbarBtn, "hidden sm:inline-flex", wrapText && "border-primary/40 bg-primary-soft text-primary")}
          >
            <WrapText size={13} />
            Wrap
          </button>
          {fitToWidth && <FitWidthButton fit={fit} className={toolbarBtn} />}
          <ColumnsButton
            visibleCount={visibleCount}
            totalCount={chooserOptions.length}
            onClick={() => setChooserOpen(true)}
            active={chooserOpen}
          />
        </div>
      </div>

      {chooserOpen && (
      <ColumnsDrawer
        open
        onClose={() => setChooserOpen(false)}
        docLabel={documentLabel}
        columns={drawerColumns}
        onToggle={toggleColumn}
        onReorder={reorderTo}
        onTogglePin={togglePin}
        onSetWidth={(key, px) => updateWidths((prev) => ({ ...prev, [key]: px }), true)}
        onShowAll={showAllColumns}
        onReset={resetLayout}
        layouts={presetOptions}
        onApplyLayout={applyPreset}
        onSaveLayout={layoutStore.canManageLayouts ? saveNamedLayout : undefined}
        onDuplicateLayout={layoutStore.canManageLayouts ? duplicateNamedLayout : undefined}
        onRenameLayout={layoutStore.canManageLayouts ? renameLayout : undefined}
        onDeleteLayout={layoutStore.canManageLayouts ? deleteSavedLayout : undefined}
        onUpdateLayout={layoutStore.canManageLayouts ? updateLayout : undefined}
        onResetLayout={layoutStore.canManageLayouts ? resetSeedLayout : undefined}
        onShareLayout={layoutStore.canManageLayouts ? shareLayout : undefined}
        onUnshareLayout={layoutStore.canManageLayouts ? unshareLayout : undefined}
        defaultManager={defaultManager}
        dirty={layoutDirty}
        onExport={exportColumnConfig}
        udf={udfTable ? udf : undefined}
        udfTableLabel={udfTableLabel || udfTable}
      />
      )}

      {showTable && groupBanner && !embedded && (
        <DataTableGroupBanner
          groups={userGroups}
          labelOf={(k) => {
            const c = allColumns.find((x) => x.key === k);
            return c ? headerLabel(headerText(c)) : k;
          }}
          dragKey={dragCol}
          canGroup={(k) => !!allColumns.find((x) => x.key === k)?.getValue}
          onAdd={(k) => {
            setUserGroups((prev) => (prev.includes(k) ? prev : [...prev, k]));
            endHeaderDrag();
          }}
          onRemove={(k) => setUserGroups((prev) => prev.filter((x) => x !== k))}
          allCollapsed={allGroupsCollapsed}
          onCollapseAll={collapseAllGroups}
          onExpandAll={expandAllGroups}
        />
      )}
      {showTable && (
        /* `isolate`: the thead/tfoot (z-30) and frozen body cells (z-20) stack
           INSIDE this box. Without it they joined the page's stacking context
           and painted over the pinned PageHeader (z-20) whenever an unfrozen
           table scrolled under it: the card hid, its header row floated on the
           page title (owner 2026-11-17, Trip Pay). */
        <div
          className="isolate rounded-lg border border-border bg-surface shadow-stone sm:block sm:overflow-hidden"
          style={freezeBoxStyle}
        >
          <div
            ref={scrollWrapRef}
            onKeyDown={handleCopyKey}
            {...cellRange.wrapProps}
            className="thin-scroll overflow-x-auto overflow-y-auto"
            style={freezeScrollStyle}
          >
          <table
            className="w-full border-separate border-spacing-0 text-sm"
            style={layoutFixed ? { tableLayout: "fixed", minWidth: fixedTableWidth, zoom: fit.fitOn ? fit.fitScale : undefined } : undefined}
          >
            <thead className="sticky top-0 z-30">
              <tr>
                {selection && (
                  <th
                    style={{ width: 36, minWidth: 36, maxWidth: 36 }}
                    className={cn(
                      "border-b-2 border-border bg-surface-dim pl-5 text-center align-middle",
                      headPad
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      checked={allRowsSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someRowsSelected;
                      }}
                      onChange={() =>
                        !rowActionsDisabled && selection.onToggleAll(selectableKeys, allRowsSelected)
                      }
                      disabled={rowActionsDisabled}
                      onClick={(e) => e.stopPropagation()}
                      className="cursor-pointer accent-primary"
                    />
                  </th>
                )}
                {expandable && (
                  <th
                    aria-hidden
                    style={{ width: 32, minWidth: 32, maxWidth: 32 }}
                    className={cn(
                      "border-b-2 border-border bg-surface-dim",
                      selection ? "pl-3" : "pl-5",
                      headPad
                    )}
                  />
                )}
                {displayColumns.map((c, i) => {
                  const sortable = canSortColumn(c);
                  const active = sort?.key === c.key;
                  const isSticky = i < stickyCount;
                  const isLastSticky = isSticky && i === stickyCount - 1;
                  const isStickyRight = stickyRight[i] !== undefined;
                  const isFirstStickyRight =
                    isStickyRight && i === displayColumns.length - stickyRightCount;
                  const userW = widths[c.key];
                  const cellStyle: React.CSSProperties = {};
                  if (layoutFixed) {
                    const w = resolveWidth(c);
                    cellStyle.width = w;
                    cellStyle.minWidth = w;
                    cellStyle.maxWidth = w;
                  } else if (typeof userW === "number") {
                    cellStyle.width = userW;
                    cellStyle.minWidth = userW;
                    cellStyle.maxWidth = userW;
                  } else if (c.width) {
                    cellStyle.width = c.width;
                    const px = parsePxWidth(c.width);
                    if (px != null) cellStyle.maxWidth = px;
                  }
                  if (isSticky) {
                    cellStyle.position = "sticky";
                    cellStyle.left = stickyLeft[i];
                    cellStyle.zIndex = 30;
                  } else if (isStickyRight) {
                    cellStyle.position = "sticky";
                    cellStyle.right = stickyRight[i];
                    cellStyle.zIndex = 30;
                  }
                  return (
                    <Fragment key={c.key}>
                    {i === fillerAt && fillerCount > 0 && <th aria-hidden className="border-b-2 border-border bg-surface-dim p-0" />}
                    <th
                      data-col-key={c.key}
                      style={cellStyle}
                      draggable={canDragHeader(c)}
                      onDragStart={(e) => {
                        if (!canDragHeader(c)) return;
                        draggedRef.current = true;
                        setDragCol(c.key);
                        e.dataTransfer.effectAllowed = "move";
                        try {
                          e.dataTransfer.setData("text/plain", c.key);
                        } catch {
                        }
                      }}
                      onDragOver={(e) => {
                        if (!canDropHeader(c)) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dropCol !== c.key) setDropCol(c.key);
                      }}
                      onDragLeave={() => {
                        if (dropCol === c.key) setDropCol(null);
                      }}
                      onDrop={(e) => {
                        if (!canDropHeader(c)) return;
                        e.preventDefault();
                        if (dragCol) reorderTo(dragCol, c.key);
                        endHeaderDrag();
                      }}
                      onDragEnd={endHeaderDrag}
                      onClick={() => {
                        if (draggedRef.current) {
                          draggedRef.current = false;
                          return;
                        }
                        if (sortable) onHeaderClick(c);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setHeaderMenu({ x: e.clientX, y: e.clientY, colKey: c.key });
                      }}
                      className={cn(
                        // overflow-hidden: a header must never paint over its
                        // neighbour either — crop the label when the column is
                        // narrower than it (same clip rule as body cells).
                        // English Title Case, not CSS capitals (owner 2026-09-25).
                        "group/th relative overflow-hidden border-b-2 border-border bg-surface-dim text-[11.5px] font-semibold text-ink",
                        wrapOn ? "whitespace-normal align-bottom" : "whitespace-nowrap",
                        headPad,
                        c.align === "right" && "text-right",
                        c.align === "center" && "text-center",
                        (c.align === "left" || !c.align) && "text-left",
                        i === 0 && !expandable && !selection && "pl-5",
                        i === displayColumns.length - 1 && "pr-5",
                        sortable && "cursor-pointer select-none hover:text-primary",
                        active && "text-primary",
                        dragCol === c.key && "opacity-40",
                        isLastSticky && "border-r border-border",
                        isFirstStickyRight && "border-l border-border"
                      )}
                    >
                      <span className="inline-flex items-center gap-1" title={c.description ?? columnDescription(tableId, c.key)}>
                        {c.renderHeader ? (
                          c.renderHeader()
                        ) : (
                          <>
                            {pinnedSet.has(c.key) && (
                              <Pin
                                size={9}
                                className="shrink-0 text-primary"
                                aria-label="Pinned"
                              />
                            )}
                            {c.description ?? columnDescription(tableId, c.key) ? (
                              <span className="underline decoration-ink-muted decoration-dotted underline-offset-2">{headerLabel(c.label)}</span>
                            ) : (
                              headerLabel(c.label)
                            )}
                            {sortable && (
                              <span
                                className={cn(
                                  "inline-flex transition-opacity",
                                  active ? "opacity-100" : "opacity-30"
                                )}
                              >
                                {active ? (
                                  sort!.dir === "asc" ? (
                                    <ArrowUp size={10} />
                                  ) : (
                                    <ArrowDown size={10} />
                                  )
                                ) : (
                                  <ChevronsUpDown size={10} />
                                )}
                              </span>
                            )}
                            {c.getValue && !c.disableFilter && (
                              <button
                                type="button"
                                title={`Filter & sort ${c.label}`}
                                aria-label={`Filter & sort ${c.label}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const anchor = e.currentTarget;
                                  const rect = anchor.getBoundingClientRect();
                                  setFilterQuery("");
                                  setFilterMenu((cur) =>
                                    cur?.colKey === c.key
                                      ? null
                                      : { left: rect.left, top: rect.top, bottom: rect.bottom, colKey: c.key, anchor }
                                  );
                                }}
                                className={cn(
                                  "inline-flex shrink-0 rounded p-0.5 transition-all",
                                  (colFilters[c.key]?.length ?? 0) > 0
                                    ? "text-accent opacity-100"
                                    : "opacity-0 hover:text-primary group-hover/th:opacity-40"
                                )}
                              >
                                <Filter
                                  size={10}
                                  fill={(colFilters[c.key]?.length ?? 0) > 0 ? "currentColor" : "none"}
                                />
                              </button>
                            )}
                          </>
                        )}
                      </span>
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize column"
                        onMouseDown={(e) => onResizeStart(e, c)}
                        onClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          autoFitColumn(c.key);
                        }}
                        className="group/rs absolute right-0 top-0 z-10 flex h-full w-1.5 cursor-col-resize touch-none select-none justify-end transition-colors hover:bg-primary/40"
                      >
                        {/* The column edge, always drawn (owner 2026-10-26:
                            header 之间调整的距离看不到线条) — a thin rule where a
                            drag widens the column; the strip lights up under
                            the pointer. */}
                        <span aria-hidden className="my-auto h-3/5 w-px bg-ink-muted/45 group-hover/rs:bg-transparent" />
                      </span>
                      {/* Insertion bar — where the carried column will land.
                          Owner 2026-07-24 asked for a BOLD line ("加粗线条"),
                          drawn on the side the column is arriving FROM so it
                          sits between the two headers it will separate.
                          Absolutely positioned (not a background tint) because
                          `cn` is a plain join: a conditional bg-* class would
                          race the th's own bg-surface-dim. */}
                      {dropCol === c.key && canDropHeader(c) && (
                        <span
                          aria-hidden
                          className={cn(
                            "pointer-events-none absolute top-0 z-20 h-full w-[3px] rounded-full bg-primary",
                            dragIndex >= 0 && dragIndex < i ? "right-0" : "left-0"
                          )}
                        />
                      )}
                    </th>
                    </Fragment>
                  );
                })}
                {fillerAt === displayColumns.length && fillerCount > 0 && (
                  <th aria-hidden className="border-b-2 border-border bg-surface-dim p-0" />
                )}
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {effectiveLoading && <TableSkeleton rows={8} cols={totalColSpan} />}
              {!effectiveLoading && error && (
                <tr>
                  <td
                    colSpan={totalColSpan}
                    className="px-3 py-14 text-center text-sm text-err"
                  >
                    <TableLoadError error={String(error)} />
                  </td>
                </tr>
              )}
              {!effectiveLoading && !error && sortedRows && sortedRows.length === 0 && (
                <tr>
                  <td
                    colSpan={totalColSpan}
                    className="px-3 py-20 text-center text-sm text-ink-muted"
                  >
                    {emptyContent}
                  </td>
                </tr>
              )}
              {canVirtualize && vStart > 0 && (
                <tr aria-hidden>
                  <td colSpan={totalColSpan} style={{ height: vStart * rowHeightRef.current, padding: 0, border: 0 }} />
                </tr>
              )}
              {!effectiveLoading &&
                !error &&
                sortedRows &&
                renderList.slice(vStart, vEnd).map((item) => {
                  if (item.kind === "group") {
                    return (
                      <tr
                        key={`grp:${item.path}`}
                        data-vgrp=""
                        onClick={() => toggleGroup(item.path)}
                        className="cursor-pointer select-none bg-surface-dim/70 transition-colors hover:bg-surface-dim"
                      >
                        <td
                          colSpan={totalColSpan}
                          className={cn(
                            "border-b border-border-subtle pr-5 text-[11px] font-semibold uppercase tracking-brand text-ink",
                            cellPad
                          )}
                        >
                          <span className="inline-flex items-center gap-1.5" style={{ paddingLeft: 20 + item.level * 16 }}>
                            <ChevronRight
                              size={12}
                              className={cn(
                                "shrink-0 text-ink-muted transition-transform",
                                !item.collapsed && "rotate-90"
                              )}
                              aria-hidden
                            />
                            <span>{item.label}</span>
                            <span className="font-mono text-[10px] font-normal text-ink-muted">
                              ({item.count})
                            </span>
                          </span>
                        </td>
                      </tr>
                    );
                  }

                  const { row, rowIdx } = item;
                  const customClass = getRowClassName?.(row);
                  const stickyBg =
                    rowIdx % 2 === 0 ? "var(--hz-c-surface)" : "var(--hz-dk-row-alt, #f8f8f5)";
                  const expId = expandable ? expansionId(row) || null : null;
                  const isExpanded = expId != null && expandedRowsEffective.has(expId);
                  const selKey = selection ? String(getRowKey(row)) : null;
                  const isRowSelected =
                    selKey != null && selection!.selectedIds.has(selKey);
                  return (
                    <Fragment key={getRowKey(row)}>
                      <tr
                        data-vrow=""
                        data-rowkey={String(getRowKey(row))}
                        draggable={rowReorderable}
                        onDragStart={rowReorderable ? (e) => { setDragKey(String(getRowKey(row))); e.dataTransfer.effectAllowed = "move"; } : undefined}
                        onDragOver={rowReorderable && dragKey ? (e) => { e.preventDefault(); dragScroll.at(e.clientY); const k = String(getRowKey(row)); if (k !== dragKey) setDropKey(k); } : undefined}
                        onDrop={rowReorderable && dragKey ? (e) => { e.preventDefault(); onRowDrop(String(getRowKey(row))); } : undefined}
                        onDragEnd={rowReorderable ? () => { dragScroll.stop(); setDragKey(null); setDropKey(null); } : undefined}
                        style={{
                          ...getRowStyle?.(row),
                          ...(rowReorderable ? { cursor: "grab" } : {}),
                          ...(dropKey === String(getRowKey(row)) ? { boxShadow: "inset 0 2px 0 0 var(--primary, #2f5d4f)" } : {}),
                        }}
                        onClick={
                          onRowClick || rowClickTicks
                            ? () => {
                                if (rowClickTicks && selKey != null && !selection.isDisabled?.(selKey)) {
                                  selection.onToggle(selKey);
                                }
                                onRowClick?.(row);
                              }
                            : undefined
                        }
                        onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
                        tabIndex={onRowClick || onRowDoubleClick ? 0 : -1}
                        onKeyDown={
                          onRowClick || onRowDoubleClick
                            ? (e) => {
                                if (e.key !== "Enter" || e.target !== e.currentTarget) return;
                                e.preventDefault();
                                if (e.shiftKey && onRowDoubleClick) onRowDoubleClick(row);
                                else if (onRowClick) onRowClick(row);
                                else onRowDoubleClick?.(row);
                              }
                            : undefined
                        }
                        onContextMenu={
                          contextMenu
                            ? (e) => {
                                const items = contextMenu(row);
                                if (!items || items.length === 0) return;
                                e.preventDefault();
                                e.stopPropagation();
                                setRowMenu({ x: e.clientX, y: e.clientY, items });
                              }
                            : undefined
                        }
                        className={cn(
                          "group transition-colors",
                          isRowSelected || highlightKey === String(getRowKey(row)) ? "bg-primary/10"
                            : customClass && /(^|\s)!?bg-/.test(customClass) ? null
                            : rowIdx % 2 === 0 ? "bg-surface" : "bg-surface-dim/35",
                          (onRowClick || onRowDoubleClick || rowClickTicks) && "cursor-pointer",
                          (onRowClick || onRowDoubleClick) && "focus:outline-none focus-visible:bg-primary/10",
                          customClass
                        )}
                      >
                        {selection && (
                          <td
                            style={{ width: 36, minWidth: 36, maxWidth: 36 }}
                            className={cn(
                              "border-b border-border-subtle pl-5 text-center align-middle transition-colors group-hover:bg-[#3f6b53]/25",
                              cellPad
                            )}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              aria-label={selection.rowLabel?.(row) ?? "Select row"}
                              checked={isRowSelected}
                              disabled={selKey != null && !!selection.isDisabled?.(selKey)}
                              onChange={() => {
                                if (selKey != null) selection.onToggle(selKey);
                              }}
                              className="cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                            />
                          </td>
                        )}
                        {expandable && (
                          <td
                            style={{ width: 32, minWidth: 32, maxWidth: 32 }}
                            className={cn(
                              "border-b border-border-subtle align-middle text-ink transition-colors group-hover:bg-[#3f6b53]/25",
                              selection ? "pl-3" : "pl-5",
                              cellPad
                            )}
                          >
                            {expId != null && (
                            <button
                              type="button"
                              aria-label={isExpanded ? "Collapse row" : "Expand row"}
                              aria-expanded={isExpanded}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(expId);
                              }}
                              className="inline-flex items-center justify-center rounded text-ink-muted transition-colors hover:text-primary"
                            >
                              <ChevronRight
                                size={14}
                                className={cn(
                                  "transition-transform",
                                  isExpanded && "rotate-90"
                                )}
                                aria-hidden
                              />
                            </button>
                            )}
                          </td>
                        )}
                        <DataRowCells
                          row={row}
                          columns={displayColumns}
                          widths={widths}
                          stickyLeft={stickyLeft}
                          stickyRight={stickyRight}
                          stickyCount={stickyCount}
                          stickyRightCount={stickyRightCount}
                          cellPad={cellPad}
                          wrapOn={wrapOn}
                          fillerAt={fillerAt}
                          fillerCount={fillerCount}
                          stickyBg={stickyBg}
                          firstColGutter={!expandable && !selection}
                        />
                      </tr>
                      {isExpanded && expandable && (
                        <DataTableExpandedRows
                          row={row} expandable={expandable} rowClassName={customClass}
                          columns={displayColumns} totalColSpan={totalColSpan} hasSelectionCell={!!selection}
                          widths={widths} stickyLeft={stickyLeft} stickyRight={stickyRight}
                          stickyCount={stickyCount} stickyRightCount={stickyRightCount}
                          cellPad={cellPad} fillerAt={fillerAt} fillerCount={fillerCount}
                        />
                      )}
                    </Fragment>
                  );
                })}
              {canVirtualize && vEnd < renderList.length && (
                <tr aria-hidden>
                  <td colSpan={totalColSpan} style={{ height: (renderList.length - vEnd) * rowHeightRef.current, padding: 0, border: 0 }} />
                </tr>
              )}
              {hiddenByLimit > 0 && (
                <tr>
                  <td colSpan={totalColSpan} className="p-0">
                    <button
                      type="button"
                      onClick={loadMore}
                      className="w-full border-t border-border py-2.5 text-[12px] font-semibold uppercase tracking-wider text-primary transition-colors hover:bg-primary-soft"
                    >
                      Load more — {hiddenByLimit} more row{hiddenByLimit === 1 ? "" : "s"}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
            {footerTotals && (
              <tfoot className="sticky bottom-0 z-30">
                <tr title={footerTotals.picked ? "Total of the ticked rows" : "Total of the rows shown"}>
                  {selectColCount + expandColCount > 0 && (
                    <td colSpan={selectColCount + expandColCount} className="border-t-2 border-border bg-surface-dim" />
                  )}
                  {displayColumns.map((c, i) => {
                    const cellStyle: React.CSSProperties = { width: resolveWidth(c) };
                    if (i < stickyCount) {
                      cellStyle.position = "sticky";
                      cellStyle.left = stickyLeft[i];
                      cellStyle.zIndex = 20;
                    } else if (stickyRight[i] !== undefined) {
                      cellStyle.position = "sticky";
                      cellStyle.right = stickyRight[i];
                      cellStyle.zIndex = 20;
                    }
                    const label =
                      i === 0 && !c.total
                        ? `${footerTotals.picked ? "Selected" : "Total"} · ${footerTotals.rows.length} row${footerTotals.rows.length === 1 ? "" : "s"}`
                        : null;
                    return (
                      <Fragment key={c.key}>
                        {i === fillerAt && fillerCount > 0 && <td aria-hidden className="border-t-2 border-border bg-surface-dim p-0" />}
                        <td
                          data-total-key={c.key}
                          style={cellStyle}
                          className={cn(
                            "overflow-hidden text-ellipsis whitespace-nowrap border-t-2 border-border bg-surface-dim text-[13px] font-semibold tabular-nums text-ink",
                            cellPad,
                            c.align === "right" && "text-right",
                            c.align === "center" && "text-center",
                            i === 0 && !expandable && !selection && "pl-5",
                            i === displayColumns.length - 1 && "pr-5",
                          )}
                        >
                          {c.total ? c.total(footerTotals.rows) : label}
                        </td>
                      </Fragment>
                    );
                  })}
                  {fillerAt === displayColumns.length && fillerCount > 0 && (
                    <td aria-hidden className="border-t-2 border-border bg-surface-dim p-0" />
                  )}
                </tr>
              </tfoot>
            )}
          </table>
          </div>
        </div>
      )}

      {showMobileCards && (
        <div className="space-y-2 sm:hidden">
        {effectiveLoading && (
          <>
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="rounded-lg border border-border bg-surface p-3 shadow-stone"
              >
                <div className="mb-2 h-4 w-2/3 animate-pulse rounded bg-bg/80" />
                <div className="space-y-1.5">
                  <div className="h-3 w-full animate-pulse rounded bg-bg/60" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-bg/60" />
                </div>
              </div>
            ))}
          </>
        )}
        {!effectiveLoading && error && (
          <div className="rounded-lg border border-err/40 bg-err/5 p-4 text-center text-sm text-err">
            <TableLoadError error={String(error)} />
          </div>
        )}
        {!effectiveLoading && !error && sortedRows && sortedRows.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-ink-muted">
            {emptyContent}
          </div>
        )}
        {!effectiveLoading && !error && sortedRows && sortedRows.length > 0 && (
          <MobileVirtualList
            items={sortedRows}
            getKey={getRowKey}
            estimateHeight={mobileColumns.estimateHeight}
            gap={8}
            ariaLabel={`${sortedRows.length} loaded records. Only visible records are mounted; scroll to browse this loaded set.`}
            renderItem={(row) => {
              const customClass = getRowClassName?.(row);
              const {
                primary: primaryCol,
                cells: cellCols,
                layout,
                hideLabels,
              } = mobileColumns;
              return (
                <div
                  key={getRowKey(row)}
                  data-mobile-card=""
                  style={{
                    contentVisibility: "auto",
                    containIntrinsicSize: `auto ${mobileColumns.estimateHeight}px`,
                  }}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  role={onRowClick ? "button" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    "relative overflow-hidden rounded-lg border border-border shadow-stone transition-colors",
                    !(customClass && /(^|\s)!?bg-/.test(customClass)) && "bg-surface",
                    onRowClick &&
                      "cursor-pointer active:bg-primary/15 hover:border-primary/40",
                    customClass,
                  )}
                >
                <span className="pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-gradient-to-b from-primary/0 via-primary/55 to-primary/0" />
                <div className="p-3">
                  {primaryCol && (
                    <div className="mb-1.5 flex items-start gap-3">
                      <div className="min-w-0 flex-1 font-display text-[14.5px] font-extrabold leading-snug tracking-tight text-ink">
                        {primaryCol.render(row)}
                      </div>
                      {onRowClick && (
                        <ChevronRight
                          size={14}
                          className="mt-1 shrink-0 text-ink-muted"
                          aria-hidden
                        />
                      )}
                    </div>
                  )}
                  {cellCols.length > 0 && layout === "grid-2" && (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
                      {cellCols.map((c) => (
                        <dd
                          key={c.key}
                          className={cn(
                            "min-w-0 break-words text-left text-ink-secondary",
                            c.align === "right" && "tabular-nums font-semibold",
                            c.className,
                          )}
                        >
                          {c.render(row)}
                        </dd>
                      ))}
                    </dl>
                  )}
                  {cellCols.length > 0 && layout === "stack" && (
                    <dl
                      className={cn(
                        "grid gap-x-3 gap-y-1 border-t border-border-subtle pt-2 text-[12.5px]",
                        hideLabels ? "grid-cols-1" : "grid-cols-[5.5rem_1fr]",
                      )}
                    >
                      {cellCols.map((c) => (
                        <Fragment key={c.key}>
                          {!hideLabels && (
                            <dt className="self-start pt-px font-mono text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted sm:text-[9.5px]">
                              {c.label}
                            </dt>
                          )}
                          <dd
                            className={cn(
                              "min-w-0 break-words text-left font-medium text-ink",
                              c.align === "right" &&
                                "tabular-nums font-semibold",
                              c.className,
                            )}
                          >
                            {c.render(row)}
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                  )}
                </div>
                </div>
              );
            }}
          />
        )}
        </div>
      )}

      {filterMenu &&
        (() => {
          const col = allColumns.find((c) => c.key === filterMenu.colKey);
          if (!col?.getValue) return null;
          /* FACETED value list (owner 2026-09-23, "越筛越少") — the options are
             counted over the rows that survive every OTHER active column filter,
             so once Date = 23/9 is picked the Creditor funnel lists only
             creditors present that day, and each further filter narrows the rest.
             See facetedFilterValues for the exact rule (0-count options drop
             unless they are fixed vocabulary or currently ticked). */
          const values = facetedFilterValues(rows ?? [], colFilters, col, allColumns);
          const filterType = col.filterType ?? (looksLikeDateColumn(values.map(([v]) => v)) ? "date" : undefined);
          const allTokens = colFilters[col.key] ?? [];
          const conditionTokens = allTokens.filter(isConditionToken);
          const selected = new Set(allTokens.filter((v) => !isConditionToken(v)));
          const currentCondition = conditionTokens.length > 0 ? parseCondition(conditionTokens[0]) : null;
          const q = filterQuery.trim().toLowerCase();
          const shown = q
            ? values.filter(([v]) => (col.filterLabel?.(v) ?? v).toLowerCase().includes(q))
            : values;
          const shownValues = shown.map(([v]) => v);
          const canSort = canSortColumn(col);
          const sortActive = sort?.key === col.key ? sort.dir : null;

          const selectAll = () =>
            setColumnFilter(col.key, [...conditionTokens, ...selected, ...shownValues]);
          const invert = () => {
            const shownSet = new Set(shownValues);
            const keptOutsideSearch = [...selected].filter((v) => !shownSet.has(v));
            const flippedWithinSearch = shownValues.filter((v) => !selected.has(v));
            setColumnFilter(col.key, [...conditionTokens, ...keptOutsideSearch, ...flippedWithinSearch]);
          };

          const sortBtn =
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-surface-dim disabled:cursor-not-allowed disabled:text-ink-muted disabled:hover:bg-transparent";
          if (!filterMenuPos) return null;
          return createPortal(
            <div
              className="fixed z-[120] flex w-[236px] flex-col overflow-y-auto overscroll-contain rounded-md border border-border bg-surface shadow-slab"
              style={{ top: filterMenuPos.top, bottom: filterMenuPos.bottom, left: filterMenuPos.left, maxHeight: filterMenuPos.maxHeight }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="shrink-0 border-b border-border-subtle px-3 py-2">
                <span className="text-[10px] font-bold uppercase tracking-brand text-ink-secondary">
                  {headerLabel(col.label || col.key)}
                </span>
              </div>

              <div className="shrink-0 border-b border-border-subtle py-1">
                <button
                  type="button"
                  className={cn(sortBtn, sortActive === "asc" && "text-primary")}
                  disabled={!canSort}
                  onClick={() => {
                    applySort(col, "asc");
                    setFilterMenu(null);
                  }}
                >
                  <ArrowDownAZ size={13} className="shrink-0 text-ink-muted" />
                  {col.newestFirst ? "Sort Oldest → Newest" : "Sort A → Z"}
                </button>
                <button
                  type="button"
                  className={cn(sortBtn, sortActive === "desc" && "text-primary")}
                  disabled={!canSort}
                  onClick={() => {
                    applySort(col, "desc");
                    setFilterMenu(null);
                  }}
                >
                  <ArrowUpAZ size={13} className="shrink-0 text-ink-muted" />
                  {col.newestFirst ? "Sort Newest → Oldest" : "Sort Z → A"}
                </button>
                {/* Pin — owner 2026-07-24 "需要pin到headers". Freezes the
                    column to the left so it stays put while the rest scrolls
                    horizontally. alwaysVisible columns are frozen already, so
                    the toggle is meaningless there and is left out. */}
                {!col.alwaysVisible && (
                  <button
                    type="button"
                    className={cn(sortBtn, pinnedSet.has(col.key) && "text-primary")}
                    onClick={() => {
                      togglePin(col.key);
                      setFilterMenu(null);
                    }}
                  >
                    {pinnedSet.has(col.key) ? (
                      <PinOff size={13} className="shrink-0 text-ink-muted" />
                    ) : (
                      <Pin size={13} className="shrink-0 text-ink-muted" />
                    )}
                    {pinnedSet.has(col.key)
                      ? "Freeze to the right"
                      : pinnedRightSet.has(col.key)
                        ? "Unfreeze column"
                        : "Freeze to the left"}
                  </button>
                )}
                <DataTableFreezeItems className={sortBtn} anyFrozen={pinnedSet.size > 0} onFreezeUpTo={() => { freezeUpTo(col.key); setFilterMenu(null); }} onUnfreezeAll={() => { setPinned([]); setFilterMenu(null); }} />
              </div>

              {filterType && (
                <DataTableConditionSection
                  key={col.key}
                  filterType={filterType}
                  current={currentCondition}
                  onChange={(next) =>
                    setColumnFilter(col.key, [...(next ? [conditionToken(next)] : []), ...selected])
                  }
                />
              )}

              <div className="shrink-0 border-b border-border-subtle px-3 py-1.5">
                <input
                  autoFocus
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="Search values…"
                  className="w-full rounded border border-border bg-bg px-2 py-1 text-[12px] outline-none focus:border-primary"
                />
              </div>

              <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 py-1.5 text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={selectAll}
                  disabled={shownValues.length === 0}
                  className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-dim disabled:text-ink-muted/50 disabled:hover:bg-transparent"
                >
                  Select all
                </button>
                <span className="text-ink-muted">·</span>
                <button
                  type="button"
                  onClick={invert}
                  disabled={shownValues.length === 0}
                  className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-dim disabled:text-ink-muted/50 disabled:hover:bg-transparent"
                >
                  Invert
                </button>
                <span className="text-ink-muted">·</span>
                <button
                  type="button"
                  onClick={() => setColumnFilter(col.key, [])}
                  disabled={allTokens.length === 0}
                  className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-dim disabled:text-ink-muted/50 disabled:hover:bg-transparent"
                >
                  Clear
                </button>
              </div>

              <div className="max-h-[240px] shrink-0 overflow-y-auto overscroll-contain py-1">
                {shown.length === 0 && (
                  <div className="px-3 py-2 text-[12px] text-ink-muted">No values</div>
                )}
                {shown.map(([v, n]) => (
                  <label
                    key={v}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12.5px] text-ink hover:bg-surface-dim"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(v)}
                      onChange={() => toggleFilterValue(col.key, v)}
                      className="accent-accent"
                    />
                    <span className="min-w-0 flex-1 truncate" title={v}>{col.filterLabel?.(v) ?? v}</span>
                    <span className="shrink-0 font-mono text-[10px] text-ink-muted">{n}</span>
                  </label>
                ))}
              </div>
            </div>,
            document.body
          );
        })()}

      {headerMenu &&
        (() => {
          const col = allColumns.find((c) => c.key === headerMenu.colKey);
          if (!col) return null;
          const sortable = canSortColumn(col);
          const isPinned = pinnedSet.has(col.key);
          const canHide = !col.alwaysVisible && col.canHide !== false;
          const itemCls = HEADER_MENU_ITEM_CLASS;
          const pos = headerMenuPos ?? { top: headerMenu.y, left: headerMenu.x };
          return createPortal(
            <div
              ref={headerMenuRef}
              className="fixed z-[120] min-w-[176px] overflow-y-auto overscroll-contain rounded-md border border-border bg-surface py-1 shadow-slab"
              // A board with ~20 hidden columns lists them all below: cap to the
              // viewport and scroll (#4290, the same bug on the old grid).
              style={{ top: pos.top, left: pos.left, maxHeight: "calc(100vh - 16px)" }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <DataTableExportItems className={itemCls} disabled={rowActionsDisabled || exporting || !sortedRows?.length} onSheet={() => { setHeaderMenu(null); handleExport(); }}
                sheetLabel={sheetExportLabel({ lines: Boolean(exportLines), custom: Boolean(onExport), xlsx: exportXlsx, exportLabel, picked: actionRows?.picked ? actionRows.rows.length : null })}
                onPdf={onExportPdf && actionRows ? () => { setHeaderMenu(null); onExportPdf(tablePdfViewOf(actionRows.rows, visibleColumns as Column<T, L>[])); } : undefined} />
              <button
                type="button"
                className={itemCls}
                disabled={!sortable}
                onClick={() => {
                  applySort(col, "asc");
                  setHeaderMenu(null);
                }}
              >
                <ArrowUp size={13} className="shrink-0 text-ink-muted" />
                Sort ascending
              </button>
              <button
                type="button"
                className={itemCls}
                disabled={!sortable}
                onClick={() => {
                  applySort(col, "desc");
                  setHeaderMenu(null);
                }}
              >
                <ArrowDown size={13} className="shrink-0 text-ink-muted" />
                Sort descending
              </button>
              <div className="my-1 border-t border-border-subtle" />
              <button
                type="button"
                className={itemCls}
                onClick={() => {
                  togglePin(col.key);
                  setHeaderMenu(null);
                }}
              >
                {isPinned ? (
                  <PinOff size={13} className="shrink-0 text-ink-muted" />
                ) : (
                  <Pin size={13} className="shrink-0 text-ink-muted" />
                )}
                {isPinned ? "Unpin left" : "Pin left"}
              </button>
                <DataTableFreezeItems className={itemCls} anyFrozen={pinnedSet.size > 0} onFreezeUpTo={() => { freezeUpTo(col.key); setHeaderMenu(null); }} onUnfreezeAll={() => { setPinned([]); setHeaderMenu(null); }} />
              <button
                type="button"
                className={itemCls}
                onClick={() => {
                  autoFitColumn(col.key);
                  setHeaderMenu(null);
                }}
              >
                <MoveHorizontal size={13} className="shrink-0 text-ink-muted" />
                Auto-fit width
              </button>
              {groupBanner && col.getValue && (
                <button
                  type="button"
                  className={itemCls}
                  onClick={() => {
                    setUserGroups((prev) =>
                      prev.includes(col.key) ? prev.filter((k) => k !== col.key) : [...prev, col.key],
                    );
                    setHeaderMenu(null);
                  }}
                >
                  <Rows3 size={13} className="shrink-0 text-ink-muted" />
                  {userGroups.includes(col.key) ? "Stop grouping by this column" : "Group by this column"}
                </button>
              )}
              <div className="my-1 border-t border-border-subtle" />
              <button
                type="button"
                className={itemCls}
                disabled={!canHide}
                onClick={() => {
                  if (canHide) toggleColumn(col.key);
                  setHeaderMenu(null);
                }}
              >
                <EyeOff size={13} className="shrink-0 text-ink-muted" />
                Hide column
              </button>
              {chooserOptions.some((o) => effectiveHidden.has(o.key)) && (
                <>
                  <div className="my-1 border-t border-border-subtle" />
                  <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-brand text-ink-muted">Hidden</div>
                  {chooserOptions
                    .filter((o) => effectiveHidden.has(o.key))
                    .map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        className={itemCls}
                        onClick={() => {
                          toggleColumn(o.key);
                          setHeaderMenu(null);
                        }}
                      >
                        <Eye size={13} className="shrink-0 text-ink-muted" />
                        Show {o.label}
                      </button>
                    ))}
                </>
              )}
            </div>,
            document.body
          );
        })()}

      {rowMenu &&
        createPortal(
          <div
            ref={rowMenuRef}
            className="fixed z-[130] min-w-[176px] overflow-hidden rounded-md border border-border bg-surface py-1 shadow-slab"
            style={{
              top: rowMenuPos?.top ?? rowMenu.y,
              left: rowMenuPos?.left ?? rowMenu.x,
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {rowMenu.items.map((it, i) => {
              if (it.divider) {
                return (
                  <div
                    key={`div-${i}`}
                    className="my-1 border-t border-border-subtle"
                  />
                );
              }
              return (
                <button
                  key={`item-${i}-${it.label}`}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors",
                    it.danger
                      ? "text-err hover:bg-err/10"
                      : "text-ink hover:bg-surface-dim"
                  )}
                  onClick={() => {
                    setRowMenu(null);
                    it.onClick();
                  }}
                >
                  {it.label}
                </button>
              );
            })}
          </div>,
          document.body
        )}
      {showTable && freezeBox && freezeBox.runway > 0 && (
        <div ref={runwaySpacerRef} aria-hidden style={{ height: freezeBox.runway }} />
      )}
      {cellRange.overlay}
    </div>
  );
}

