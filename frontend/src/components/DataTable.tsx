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
import {
  Download,
  Upload,
  Search,
  ArrowUp,
  ArrowDown,
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronsUpDown,
  ChevronRight,
  LayoutList,
  Table as TableIcon,
  Pin,
  PinOff,
  EyeOff,
  MoveHorizontal,
  Filter,
} from "lucide-react";
import { cn } from "../lib/utils";
import { ResetFiltersButton } from "./ResetFiltersButton";
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
import { useInVisitColFilters } from "./dataTableColFilterMemory";
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
  serializeLayout,
  subscribeTableLayouts,
  type StoredLayout,
} from "../lib/tableLayouts";
import { useUdf, type UseUdfResult } from "../hooks/useUdf";
import { downloadCSV, isoForExport, toCSV, type CSVColumn } from "../lib/csv";
import { applyColumnFilters, facetedFilterValues, sortTableRows } from "./dataTableRows";
import {
  buildLineExportMatrix,
  exportableColumns,
  writeLineExportFile,
  type DataTableLineExport,
  type ExportCell,
  type ExportFormat,
} from "./dataTableLineExport";
import { SearchScopeHint } from "./SearchScopeHint";
import { MobileVirtualList } from "../mobile/MobileVirtualList";

import type { Column, DataTableProps, SortDir, SortState } from "./dataTableTypes";
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

export type { Column, ColumnLayoutPreset, DataTableProps } from "./dataTableTypes";

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
  exportName,
  exportLabel = "Export",
  onExport,
  exportLines,
  toolbarExtra,
  onColFiltersChange,
  onImport,
  caption,
  udfTable,
  udfTableLabel,
  search,
  resetFilters,
  serverSort,
  onSortChange,
  mobileCard,
  expandable,
  fixedColumnWidths,
  contextMenu,
  groupBy,
  selection,
  onFilteredRowsChange,
}: Props<T, L>) {
  const isSmallViewport = useSmallViewport();
  const [searchDraftPending, setSearchDraftPending] = useState(false);
  const searchBusy = Boolean(
    search?.searching || (search?.searching !== undefined && searchDraftPending),
  );
  const effectiveLoading = Boolean(loading || searchBusy);
  const rowActionsDisabled = effectiveLoading || Boolean(error);
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
  /* Server-side layouts: this user's own (synced across their machines) and
     each company's admin-set default. Inert until the boot fetch lands, so a
     table behaves exactly as it always did offline or logged out. */
  const layoutStore = useSyncExternalStore(
    subscribeTableLayouts,
    getTableLayoutsSnapshot,
    getTableLayoutsSnapshot,
  );
  const baseIdKey = layoutFamily || tableId || "_";
  /* When a company is resolved, prefix it. When NONE is (single-company Houzs,
     the historical default) the key is byte-identical to before — those installs
     are unchanged, and the layoutFamily/tableId migration below still applies. */
  const idKey = activeCompany != null ? `c${activeCompany}:${baseIdKey}` : baseIdKey;
  /* Company-scoped keys fall back to the pre-scoping UNSCOPED key, so a user's
     existing columns carry over on first load instead of resetting to defaults
     (both tenants start from the shared value, then diverge as each writes its
     own bucket — nothing writes back to the shared key, so the bleed stops). */
  const legacyIdKey = activeCompany != null
    ? baseIdKey
    : (layoutFamily && tableId && layoutFamily !== tableId ? tableId : undefined);
  const legacyStorageKey = (part: string) => legacyIdKey ? `dt:${part}:${legacyIdKey}` : undefined;
  const [hiddenList, setHiddenList] = useLocalStorage<string[]>(
    `dt:hidden:${idKey}`,
    [],
    legacyStorageKey("hidden"),
    sanitizeStringList,
  );
  // `shownList` lets the user opt-IN to a column that's defaultHidden=true.
  // We need a separate set (rather than relying on hiddenList alone) so a
  // defaultHidden column stays hidden until the user explicitly enables it.
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
  // Same erase as the non-persisted funnels below, for the same reason.
  const storedSortValue = storedSort[0];
  const legacySortKey = legacyStorageKey("sort");
  useEffect(() => {
    if (persistSort) return;
    try {
      localStorage.removeItem(`dt:sort:${idKey}`);
      if (legacySortKey) localStorage.removeItem(legacySortKey);
    } catch {
      // storage unavailable: nothing was persisted to erase
    }
  }, [persistSort, idKey, legacySortKey, storedSortValue]);
  // Mobile-only view preference. "cards" renders the stacked cards
  // (default for `<sm`); "table" forces the desktop table with a
  // horizontal scroll. Persisted per-table so each list page
  // remembers the user's choice.
  const [mobileView, setMobileView] = useLocalStorage<"cards" | "table">(
    `dt:mview:${idKey}`,
    "cards",
    legacyStorageKey("mview"),
    sanitizeMobileView,
  );
  const showTable = !isSmallViewport || mobileView === "table";
  const showMobileCards = isSmallViewport && mobileView === "cards";
  // Per-column user widths (px). Overrides the column's `width` default.
  // Keyed by column key; absent = use the column default. Desktop-only —
  // the mobile card branch ignores widths entirely.
  const widthStorageKey = `dt:widths:${idKey}`;
  const [storedWidths, setStoredWidths] = useLocalStorage<Record<string, number>>(
    widthStorageKey,
    {},
    legacyStorageKey("widths"),
    sanitizeColumnWidths,
  );
  // Column resizing needs live state for immediate visual feedback, but
  // localStorage is synchronous. Keep the drag width in memory and commit the
  // final layout only when the gesture ends (matching DataGrid's behaviour).
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
  // Pinned (frozen-left) column keys. Pinned columns render at the front
  // (after any alwaysVisible columns) and stick during horizontal scroll.
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
  // Header right-click menu — transient (not persisted). Holds the anchor
  // point and the column it was opened on. null = closed.
  const [headerMenu, setHeaderMenu] = useState<{
    x: number;
    y: number;
    colKey: string;
  } | null>(null);

  // ── Header drag-to-reorder (see reorderTo / onHeaderDrag*) ──
  // `dragCol` is the column being dragged, `dropCol` the header it is hovering
  // over. Both transient. `draggedRef` swallows the click the browser fires
  // after a drag gesture so releasing a column never also toggles its sort.
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const draggedRef = useRef(false);

  /* Per-column value filters (the funnel popover). `colFilters[key]` = the set
     of allowed values; absent/empty = no filter on that column. The funnel icon
     stays highlighted while a filter is set, and each column's popover Clear
     (or the page's reset control) drops its entry.

     Three sources, by design (owner 2026-09-16, reconciling 2026-07-29 /
     2026-08-19):
     - default (`persistFilters` true): IN-VISIT memory (dataTableColFilterMemory).
       A funnel survives drilling into a record and back, but a fresh page load /
       new tab / F5 opens clean — it never reaches localStorage.
     - `persistFilters={false}` (SKU Master, document line tables): per-mount
       useState, clean on EVERY mount — a remembered funnel there hid a
       just-renamed row.
     There is no longer a localStorage-backed funnel path; the old dt:filters:*
     keys are erased on mount below so a stale one cannot re-narrow a list. */
  const visitColFilters = useInVisitColFilters(idKey);
  const sessionColFilters = useState<Record<string, string[]>>({});
  const [colFilters, setColFilters] = persistFilters ? visitColFilters : sessionColFilters;
  /* Erase the pre-2026-09-16 localStorage funnel key (both modes now — funnels
     no longer persist to disk at all). Re-runs when idKey gains its `c<company>:`
     prefix after the company resolves, so both the scoped and legacy keys go. */
  const legacyFilterKey = legacyStorageKey("filters");
  useEffect(() => {
    try {
      localStorage.removeItem(`dt:filters:${idKey}`);
      if (legacyFilterKey) localStorage.removeItem(legacyFilterKey);
    } catch {
      // storage unavailable: nothing was persisted to erase
    }
  }, [idKey, legacyFilterKey]);
  // The filter BUTTON's rect, not a click point: the positioner needs both edges.
  const [filterMenu, setFilterMenu] = useState<{ left: number; top: number; bottom: number; colKey: string } | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  // Menu DOM nodes, for viewport clamping and (filter popover only) telling
  // an inside-the-menu scroll apart from a page scroll in the close handler.
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  /* Opens on whichever side of the button has more room, never taller than that
     room (lib/anchoredPanel). It used to hang DOWNWARD always, so on a table
     whose header sits low the value checklist and the Select all / Invert /
     Clear bar fell off the bottom. 236 is the popover's own `w-[236px]`. */
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

  // Replace a column's whole allow-list at once — the Select all / Invert /
  // Clear actions in the funnel. An empty list means "no filter" and drops the
  // key, so the funnel de-highlights and every row shows again. De-duped so a
  // repeated value can never inflate the stored set.
  function setColumnFilter(colKey: string, values: string[]) {
    setColFilters((prev) => {
      const out = { ...prev };
      if (values.length === 0) delete out[colKey];
      else out[colKey] = [...new Set(values)];
      return out;
    });
  }

  // Sticky funnels count for the toolbar Reset — see ResetFiltersButton for why.
  const colFiltersActive = Object.values(colFilters).some((values) => values.length > 0);
  function handleResetFilters() {
    if (colFiltersActive) setColFilters({});
    resetFilters?.onReset();
  }

  /* Report funnel changes so a server-paged page can push its server-filterable
     columns into the list query (mirrors onSortChange). Published only on an
     actual value change, in an effect, so a parent that stores the report cannot
     re-enter this render — same guard as onFilteredRowsChange. */
  const reportedColFiltersRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onColFiltersChange) return;
    const serialized = JSON.stringify(colFilters);
    if (reportedColFiltersRef.current === serialized) return;
    reportedColFiltersRef.current = serialized;
    onColFiltersChange(colFilters);
  }, [colFilters, onColFiltersChange]);

  // Expanded drill-down rows (opt-in `expandable`). Transient — a Set of
  // expansion ids so the chevron toggle is O(1) and reloads start collapsed.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  // Controlled expansion (opt-in): when the caller supplies `expandedIds`, that
  // Set is the source of truth everywhere below; otherwise the transient
  // `expandedRows` above is. `onExpandedChange` reports toggles in controlled
  // mode. A caller that passes neither is byte-identical to before.
  const expandedRowsEffective = expandable?.expandedIds ?? expandedRows;
  const expansionId = useCallback(
    (row: T) =>
      expandable?.rowKey ? expandable.rowKey(row) : String(getRowKey(row)),
    [expandable, getRowKey]
  );
  const toggleExpand = useCallback((id: string) => {
    const controlled = expandable?.expandedIds;
    // `controlled` truthy already narrows `expandable` to non-null.
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

  // Row right-click menu (opt-in `contextMenu`). Transient — anchor point
  // plus the items resolved at open time. null = closed.
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

  // Collapsed group keys (opt-in `groupBy`). Persisted per table so a
  // user's collapse choices survive reloads, mirroring the other dt:* prefs.
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage<string[]>(
    `dt:groups:${idKey}`,
    [],
    legacyStorageKey("groups"),
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

  // ── UDF integration ─────────────────────────────────────
  const udf: UseUdfResult = useUdf(udfTable);

  /**
   * Build synthetic Column<T> entries from the UDF field definitions so they
   * slot into the same rendering pipeline as the static columns. Cells edit
   * via UdfCell, which writes through the hook's setValue.
   */
  const udfColumns: Column<T>[] = useMemo(() => {
    return udf.fields.map<Column<T>>((field) => ({
      key: `udf:${field.key}`,
      label: field.label,
      // Every user-defined column belongs to one group by construction — the
      // page never has to say so.
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

  // Unordered universe of columns (static + UDF).
  const rawColumns = useMemo(() => [...columns, ...udfColumns], [columns, udfColumns]);

  /* Every named layout on offer, in panel order. A COMPANY row wins its slot
     from the server (an admin's saved default) and falls back to the page's
     seed preset for that company code until one is saved — so the panel shows
     both companies' views whichever company you are in, which is the whole ask.
     Where the companies master isn't resolvable (unit tests, single-company
     installs, a failed/absent boot fetch) this degrades to exactly the
     page-declared list, `isDefault` and all. */
  const resolvedPresets = useMemo(() => {
    const declared = layoutPresets ?? [];
    if (declared.length === 0 && layoutStore.companies.length === 0) return [];
    const seedByCode = new Map(
      declared
        .filter((p) => p.companyCode)
        .map((p) => [p.companyCode!.toUpperCase(), p] as const),
    );
    const out: Array<{
      id: string;
      label: string;
      hint?: string;
      /** Full layout when it came from the server; column list when it is a
       *  page seed (normalised against the live columns below). */
      layout?: StoredLayout;
      columns?: string[];
      isDefault: boolean;
      fromServer: boolean;
      /** Set only for the user's own saved layouts — what CRUD acts on. */
      savedId?: number;
      /** Set only for a company-default row — renaming it goes to /default. */
      companyId?: number;
    }> = [];
    for (const co of layoutStore.companies) {
      const saved = layoutStore.defaults[String(co.id)]?.[baseIdKey];
      const seed = seedByCode.get(co.code.toUpperCase());
      if (!saved && !seed) continue;
      const savedName = layoutStore.defaultNames[String(co.id)]?.[baseIdKey];
      out.push({
        id: `company:${co.id}`,
        // Named by an admin, or called after the company until one does.
        label: savedName || `${shortCompanyName(co.name)} Layout`,
        companyId: co.id,
        // The seed's hint describes the SEED. Once an admin has saved a real
        // default it would be describing a layout that no longer exists —
        // "Sales desk" over the production columns somebody just published.
        hint: saved ? undefined : seed?.hint,
        layout: saved,
        columns: saved ? undefined : seed?.columns,
        isDefault: co.id === layoutStore.activeCompanyId,
        fromServer: Boolean(saved),
      });
    }
    /* The user's OWN saved layouts (mig 0239) — offered after the company
       rows, and the only ones that can be renamed or deleted. */
    for (const saved of layoutStore.myLayouts[baseIdKey] ?? []) {
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
    // Page presets that aren't about a company (and, when there is no company
    // list at all, the whole declared set) keep their own identity.
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
  }, [layoutPresets, layoutStore, baseIdKey]);

  /* Turn a preset into the same shape a saved layout has, so ONE rule renders
     both: a column list means "show exactly these, in this order" — which for
     the stored form is an explicit hidden list plus an opt-in for any
     defaultHidden column it names. */
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
        // A seed preset carries no sizes or frozen columns: those belong to the
        // screen you are on, not to the view.
        widths: {},
        pinned: [],
        pinnedRight: [],
        groupBy: [],
      };
    },
    [rawColumns],
  );

  /* The default layout, but ONLY while this table is untouched — no stored
     order, no stored visibility. One gate for both dimensions on purpose: a
     user who has only ever ticked a column would otherwise keep their column
     SET while the default silently rearranged it. The first pref of any kind
     ends the baseline for good, which is what makes changing a company default
     safe: it reaches only the people who never arranged this table.

     Widths and pinning are deliberately NOT imposed here even when the saved
     default carries them — an admin's 1920px column widths are not a good
     default on a 13" laptop. Clicking the layout in the panel applies them. */
  const baselineLayout = useMemo(() => {
    const untouched =
      order.length === 0 && hiddenList.length === 0 && shownList.length === 0;
    if (!untouched) return null;
    const preset = resolvedPresets.find((p) => p.isDefault);
    if (!preset) return null;
    const layout = presetLayout(preset);
    return { order: layout.order, hidden: new Set(layout.hidden), shown: new Set(layout.shown) };
  }, [resolvedPresets, presetLayout, order, hiddenList, shownList]);

  // Apply persisted order. alwaysVisible columns are pinned at the front
  // in their definition order (not reorderable); everything else follows
  // the user's order, then anything new that isn't yet in the stored
  // order gets appended (so new columns appear at the end without the
  // user losing their arrangement).
  const allColumns = useMemo(() => {
    const alwaysFirst = rawColumns.filter((c) => c.alwaysVisible);
    const movable = rawColumns.filter((c) => !c.alwaysVisible);
    /* Nothing stored → the default preset's order, when one is in play. Its
       unlisted columns still land at the end via the loop below, exactly like a
       stored order that predates a newly added column, so a preset only has to
       name the columns it actually wants up front. */
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
    // Any movable columns not mentioned in the stored order (e.g. newly
    // added UDFs) land at the end.
    for (const c of movable) {
      if (byKey.has(c.key)) ordered.push(c);
    }
    return [...alwaysFirst, ...ordered];
  }, [rawColumns, order, baselineLayout]);

  /* Effective hidden = hidden ∪ defaultHidden-not-explicitly-shown, reading the
     BASELINE's two lists while it is in play and the user's own otherwise. One
     rule, two sources — a preset that names a defaultHidden column shows it,
     exactly as a user ticking that column does. */
  const effectiveHidden = useMemo(() => {
    const hiddenSource = baselineLayout ? baselineLayout.hidden : userHidden;
    const shownSource = baselineLayout ? baselineLayout.shown : userShown;
    const set = new Set(hiddenSource);
    for (const c of allColumns) {
      if (c.defaultHidden && !shownSource.has(c.key)) set.add(c.key);
    }
    return set;
  }, [allColumns, userHidden, userShown, baselineLayout]);

  const visibleColumns = useMemo(
    () => allColumns.filter((c) => c.alwaysVisible || !effectiveHidden.has(c.key)),
    [allColumns, effectiveHidden]
  );

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

  // Render order with pinned columns hoisted to the front. alwaysVisible
  // columns keep their existing front position; pinned-but-not-always
  // columns slot in directly after them (preserving each group's relative
  // order). Everything else follows. When nothing is pinned this is
  // identical to `visibleColumns`, so the default render is unchanged.
  const displayColumns = useMemo(() => {
    if (pinnedSet.size === 0 && pinnedRightSet.size === 0) return visibleColumns;
    const always = visibleColumns.filter((c) => c.alwaysVisible);
    const pinnedCols = visibleColumns.filter(
      (c) => !c.alwaysVisible && pinnedSet.has(c.key)
    );
    const rightCols = visibleColumns.filter(
      (c) => !c.alwaysVisible && !pinnedSet.has(c.key) && pinnedRightSet.has(c.key)
    );
    const rest = visibleColumns.filter(
      (c) =>
        !c.alwaysVisible && !pinnedSet.has(c.key) && !pinnedRightSet.has(c.key)
    );
    // Left run · the scrolling middle · right run. A column pinned to both
    // sides cannot exist — the cycle moves it, it never adds.
    return [...always, ...pinnedCols, ...rest, ...rightCols];
  }, [visibleColumns, pinnedSet, pinnedRightSet]);

  // Display index of the header being dragged — decides which side of the drop
  // target the insertion bar is drawn on. -1 when no drag is in flight.
  const dragIndex = useMemo(
    () => (dragCol ? displayColumns.findIndex((c) => c.key === dragCol) : -1),
    [displayColumns, dragCol]
  );

  // The contiguous run of sticky (frozen) columns at the front: every
  // alwaysVisible column plus any pinned column. They render with
  // `position: sticky` and cumulative `left` offsets. We treat the
  // leading alwaysVisible columns as sticky too so a pinned column never
  // scrolls "under" an unpinned-but-leading one. `stickyCount` is how many
  // of the leading `displayColumns` are sticky.
  const stickyCount = useMemo(() => {
    let n = 0;
    for (const c of displayColumns) {
      if (c.alwaysVisible || pinnedSet.has(c.key)) n++;
      else break;
    }
    // Only freeze the run if at least one column is *explicitly* pinned —
    // alwaysVisible alone shouldn't start sticking (that would change every
    // existing caller's scroll behaviour). When nothing is pinned, no
    // column is sticky.
    return pinnedSet.size === 0 ? 0 : n;
  }, [displayColumns, pinnedSet]);

  // Resolve a column's effective pixel width: user width wins, else the
  // column's own `width` if it parses as px, else a sane default. Used both
  // for the inline width style and for computing sticky-left offsets.
  const resolveWidth = useCallback(
    (col: Column<T>): number => {
      const user = widths[col.key];
      if (typeof user === "number" && user > 0) return user;
      const parsed = parsePxWidth(col.width);
      return parsed ?? DEFAULT_COL_WIDTH;
    },
    [widths]
  );

  /* Total table width for the fixed-width layout (opt-in `fixedColumnWidths`):
     the leading select/expand gutters plus every display column's resolved px
     width. Recomputes as a drag mutates `widths` (via resolveWidth), so the
     table grows live while a column is resized. undefined when the flag is off. */
  const fixedTableWidth = useMemo(() => {
    if (!fixedColumnWidths) return undefined;
    const lead = (selection ? 36 : 0) + (expandable ? 32 : 0);
    return lead + displayColumns.reduce((acc, c) => acc + resolveWidth(c), 0);
  }, [fixedColumnWidths, selection, expandable, displayColumns, resolveWidth]);

  /* How many TRAILING display columns are frozen to the right. Mirror image
     of stickyCount: a contiguous run, because a gap in it would let an
     unfrozen column scroll underneath one that is frozen. */
  const stickyRightCount = useMemo(() => {
    if (pinnedRightSet.size === 0) return 0;
    let n = 0;
    for (let i = displayColumns.length - 1; i >= 0; i--) {
      if (pinnedRightSet.has(displayColumns[i].key)) n++;
      else break;
    }
    return n;
  }, [displayColumns, pinnedRightSet]);

  /* Cumulative RIGHT offset per trailing sticky column. Accumulated from the
     last column backwards, which is why this cannot reuse stickyLeft's loop:
     the offset of a right-frozen column is the total width of everything to
     its right, not to its left. */
  const stickyRight = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (let i = displayColumns.length - 1; i >= displayColumns.length - stickyRightCount; i--) {
      out[i] = acc;
      acc += resolveWidth(displayColumns[i]);
    }
    return out;
  }, [displayColumns, stickyRightCount, resolveWidth]);

  // Cumulative left offset (px) for each sticky column, by index into
  // `displayColumns`. Index >= stickyCount → not sticky (offset unused).
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

  /* Preset rows for the panel, each already told whether the table currently
     MATCHES it. Match is computed from the visible key sequence, never from a
     stored preset id: a stored id goes stale the moment a column is toggled and
     would then label a hand-edited layout as one of the presets. */
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
      // What this layout WOULD render, resolved the same way the table resolves
      // its own — so "active" means the two agree, not that an id was stored.
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
        active:
          wouldShow.length === current.length &&
          wouldShow.every((k, i) => current[i] === k),
      };
    });
    return withSingleActive(rows);
  }, [resolvedPresets, presetLayout, allColumns, visibleColumns]);

  /* Visibility gestures live in dataTableColumnPrefs: under a default layout the
     two lists below are read PAST, so a gesture that edits only them can write
     nothing at all. `order` comes back set exactly when that baseline was banked. */
  function writeColumnPrefs(next: ColumnPrefs) {
    if (next.order) setOrder(next.order);
    setHiddenList(next.hidden);
    setShownList(next.shown);
  }

  function toggleColumn(key: string) {
    const seen = { hidden: hiddenList, shown: shownList };
    writeColumnPrefs(toggleColumnPrefs(allColumns, effectiveHidden, key, seen, !!baselineLayout));
  }

  function resetVisibility() {
    setHiddenList([]);
    setShownList([]);
  }

  /* Applying a layout writes exactly the prefs a hand-arranged one writes —
     order + hidden/shown (+ widths/pinned when the saved layout carries them) —
     so the table never enters a "preset mode" the next column toggle would have
     to escape from. The hidden list is written in FULL rather than only where it
     differs from the column flags: a layout that happens to equal the flag
     defaults would otherwise store two empty lists, read as "untouched", and
     snap the table to the OTHER company's default — precisely the cross-company
     pick this feature exists to allow. */
  function applyPreset(id: string) {
    const preset = resolvedPresets.find((p) => p.id === id);
    if (!preset) return;
    const layout = presetLayout(preset);
    const known = new Set(allColumns.filter((c) => !c.alwaysVisible).map((c) => c.key));
    const keep = (keys: string[]) => keys.filter((k) => known.has(k));
    const ordered = keep(layout.order);
    const orderedSet = new Set(ordered);
    setOrder([
      ...ordered,
      // Columns the saved layout predates (a newer release added them) go last
      // rather than vanishing from the order entirely.
      ...[...known].filter((k) => !orderedSet.has(k)),
    ]);
    setShownList(keep(layout.shown));
    setHiddenList(keep(layout.hidden));
    // A frozen column this layout hides would hold a slot in the freeze run it
    // can never fill again.
    const hiddenSet = new Set(keep(layout.hidden));
    setPinned(keep(layout.pinned).filter((k) => !hiddenSet.has(k)));
    setPinnedRight(keep(layout.pinnedRight).filter((k) => !hiddenSet.has(k)));
    if (Object.keys(layout.widths).length > 0) updateWidths(layout.widths, true);
  }

  /* ── Sync this table's layout to the account ──────────────────────────────
     The store debounces and no-ops until the boot fetch landed. The MOUNT pass
     is skipped deliberately: merely opening a list must not create a saved
     layout for a table the user never arranged — and an all-empty layout is a
     delete, so a Reset propagates instead of being undone by the next
     hydration. */
  const myLayout = useMemo<StoredLayout>(
    () => ({
      order,
      hidden: hiddenList,
      shown: shownList,
      widths: storedWidths,
      pinned,
      pinnedRight,
      // DataTable has no grouping of its own; the field exists for the
      // vendored DataGrid, which shares this store.
      groupBy: [],
    }),
    [order, hiddenList, shownList, storedWidths, pinned, pinnedRight],
  );
  const myLayoutSignature = serializeLayout(myLayout);
  const syncedRef = useRef<{ key: string; signature: string } | null>(null);
  useEffect(() => {
    const previous = syncedRef.current;
    syncedRef.current = { key: baseIdKey, signature: myLayoutSignature };
    // First render, or this instance switched tables: nothing changed HERE.
    if (!previous || previous.key !== baseIdKey) return;
    if (previous.signature === myLayoutSignature) return;
    saveMyLayout(baseIdKey, myLayout);
  }, [baseIdKey, myLayoutSignature, myLayout]);

  /* Admin-only: publish the arrangement on screen as this company's default
     view — the thing that used to be a code constant and a deploy. Reaches
     only users who have never arranged this table themselves. */
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
  /* What is ON SCREEN, materialised — which is what "save these columns as the
     default" has to publish. The user's own prefs are the wrong source: an
     admin who is happy with the layout they inherited has empty prefs, and
     saving those would publish nothing at all. */
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
      groupBy: [],
    };
  }, [allColumns, effectiveHidden, storedWidths, pinned, pinnedRight]);

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
    // Resetting order also clears widths + pinned so the table returns to a
    // clean default layout (no orphaned per-column sizes or frozen columns
    // left pointing at a now-rearranged set).
    setOrder([]);
    updateWidths({}, true);
    setPinned([]);
    setPinnedRight([]);
  }

  /* ── Columns drawer ──────────────────────────────────────────────────────
     One row per movable column, in TABLE order, carrying everything the
     drawer draws: its group, whether it shows, its effective width and
     whether it is frozen. Derived — the drawer holds no column state of its
     own, so every gesture lands on the same prefs a header drag writes. */
  const drawerColumns = useMemo<DrawerColumn[]>(
    () =>
      allColumns
        .filter((c) => !c.alwaysVisible)
        .map((c) => ({
          key: c.key,
          label: c.label || c.key,
          /* Explicit beats inferred: a page that sorted its columns by hand
             (Sales Orders) keeps that sort; every other list gets the shared
             classifier rather than one flat scroll. */
          group: c.group || inferColumnGroup(c.key, c.label || c.key) || "",
          visible: !effectiveHidden.has(c.key),
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
    writeColumnPrefs(showAllColumnPrefs(allColumns, effectiveHidden, Boolean(baselineLayout)));
  }

  /** Back to the active layout: its columns, its order, its widths. */
  function resetLayout() {
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
  }

  /** True when the columns on screen match no offered layout — the "· edited"
   *  in the footer. With no layouts to compare against there is nothing to be
   *  dirty against, so it stays false. */
  const layoutDirty = Boolean(
    presetOptions && presetOptions.length > 0 && !presetOptions.some((p) => p.active)
  );

  /* ── Named layouts (mig 0239) ────────────────────────────────────────────
     Saving one snapshots the arrangement ON SCREEN, which is the only reading
     that matches the control's name ("New layout from current columns"). The
     drawer owns the naming prompt; here we just write. */
  const saveNamedLayout = useCallback(
    (name: string) => createNamedLayout(baseIdKey, name, renderedLayout).then(() => undefined),
    [baseIdKey, renderedLayout]
  );
  const duplicateNamedLayout = useCallback(
    (id: string, name: string) => {
      const source = resolvedPresets.find((p) => p.id === id);
      // Duplicating a COMPANY row is allowed on purpose: "start from the 2990
      // view and tweak it" is the same gesture as duplicating your own.
      return createNamedLayout(baseIdKey, name, source ? presetLayout(source) : renderedLayout).then(
        () => undefined
      );
    },
    [baseIdKey, resolvedPresets, presetLayout, renderedLayout]
  );
  /* One handler, two destinations: a layout the user saved is renamed by id;
     a COMPANY row has no id of its own — its name lives on the default row, so
     it goes to /default. The drawer doesn't need to know which. */
  const renameLayout = useCallback(
    (id: string, name: string) => {
      const target = resolvedPresets.find((p) => p.id === id);
      if (target?.savedId != null) return renameNamedLayout(baseIdKey, target.savedId, name);
      if (target?.companyId != null) return renameCompanyDefault(baseIdKey, name);
      return Promise.resolve();
    },
    [baseIdKey, resolvedPresets]
  );
  /* "Edit this layout" (owner 2026-08-02: default layout 需要可以 edit) — one
     handler, two destinations again: a saved layout is replaced by id, the
     COMPANY row goes through the same publish path the footer button uses. */
  const updateLayout = useCallback(
    (id: string) => {
      const target = resolvedPresets.find((p) => p.id === id);
      if (target?.savedId != null) {
        return updateNamedLayout(baseIdKey, target.savedId, renderedLayout);
      }
      if (target?.companyId != null) return saveCompanyDefault(baseIdKey, renderedLayout);
      return Promise.resolve();
    },
    [baseIdKey, resolvedPresets, renderedLayout]
  );

  const deleteSavedLayout = useCallback(
    (savedId: number) => deleteNamedLayout(baseIdKey, savedId),
    [baseIdKey]
  );

  /** Download the arrangement as JSON — the drawer's "Export column config".
   *  Column KEYS and sizes only; no rows, nothing from the data. */
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
      // Blob/URL unavailable (very old browser, locked-down webview): the menu
      // item simply does nothing rather than throwing through the drawer.
    }
  }

  // ── Column resize ──────────────────────────────────────────
  // Dragging the right-edge handle updates `widths[key]`. The handle is a
  // dedicated element that stops propagation so it never triggers the
  // header's sort-on-click. Double-clicking the handle auto-fits (clears
  // the column's stored width). Pointer events + capture give us a clean
  // drag without a global listener leak.
  const resizeRef = useRef<{ key: string; startX: number; startW: number } | null>(
    null
  );
  const endResizeRef = useRef<((persistDirectly?: boolean) => void) | null>(null);

  useEffect(() => {
    return () => {
      // A route change can unmount the table before mouseup. React state
      // updates made from an unmount cleanup do not reach useLocalStorage's
      // persistence effect, so write the last in-memory width directly.
      endResizeRef.current?.(true);
    };
  }, [widthStorageKey]);

  function onResizeStart(e: React.MouseEvent, col: Column<T>) {
    e.preventDefault();
    e.stopPropagation();
    // End an interrupted gesture before replacing its listener closures.
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
      const next = Math.max(MIN_COL_WIDTH, r.startW + (ev.clientX - r.startX));
      updateWidths((prev) => ({ ...prev, [r.key]: next }), false);
    };
    const onUp = () => finish();
    const onBlur = () => finish();
    const finish = (persistDirectly = false) => {
      if (resizeRef.current !== gesture) return;
      // Persist once, after the last visual update. Never write synchronous
      // storage from mousemove: that path runs at pointer-frame frequency.
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
      if (endResizeRef.current === finish) endResizeRef.current = null;
      if (persistDirectly) {
        try {
          localStorage.setItem(widthStorageKey, JSON.stringify(widthsRef.current));
        } catch {
          // quota / privacy mode — match useLocalStorage's best-effort policy
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

  // Auto-fit = clear the stored width so the column falls back to its
  // natural / default size. (We don't measure the DOM; clearing is the
  // predictable, persistence-friendly behaviour.)
  function autoFitColumn(key: string) {
    updateWidths((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    }, true);
  }

  // ── Pin / freeze (left) ────────────────────────────────────
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

  // ── Column reorder ─────────────────────────────────────────
  // Shared by the Columns drawer and by dragging a header directly. Moves
  // `key` to `targetKey`'s slot in the persisted order. The stored order
  // covers EVERY movable column, hidden ones included, so a hidden column
  // keeps its place and reappears where the user left it.
  //
  // Index-before-removal (not after) is deliberate: it matches the drawer's
  // long-standing behaviour, so the two gestures can never disagree.
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

  /* A header can be picked up unless it is `alwaysVisible` — those are pinned
     to the front by contract and "can't be reordered past" (see the Column
     type), so letting one be dragged would promise a move we won't honour. */
  const canDragHeader = (c: Column<T>) => !c.alwaysVisible;

  /* Refuse drops ACROSS the pinned/unpinned divide. Pinned columns are hoisted
     to the front at render time (displayColumns), so dropping an unpinned
     column onto a pinned one would faithfully rewrite the stored order and
     then still render in the old place — a gesture that silently does nothing
     is worse than one that visibly declines. Within a group, order is honoured
     verbatim, so those drops are allowed. */
  /** Which edge a column is frozen to — the thing a drop may not cross. */
  const freezeSideOf = (key: string) =>
    pinnedSet.has(key) ? "left" : pinnedRightSet.has(key) ? "right" : "none";

  const canDropHeader = (c: Column<T>) =>
    !!dragCol &&
    dragCol !== c.key &&
    canDragHeader(c) &&
    /* SIDE, not "is it left-pinned": with right-freeze, an unfrozen column and
       a right-frozen one both answer false to pinnedSet.has, so comparing that
       would let a right-frozen header be dropped into the scrolling middle —
       rewriting the stored order while the column stayed put, which is the
       silent no-op this guard exists to prevent. */
    freezeSideOf(dragCol) === freezeSideOf(c.key);

  function endHeaderDrag() {
    setDragCol(null);
    setDropCol(null);
  }

  const [exporting, setExporting] = useState(false);
  async function handleLineExport(spec: DataTableLineExport<T, L>) {
    if (exporting) return;
    setExporting(true);
    try {
      const cols = exportableColumns(visibleColumns as Column<T, L>[]);
      const filterKeys = Object.entries(colFilters).filter(([, v]) => v.length > 0).map(([k]) => k);
      const fetched = await spec.fetchRows({ exportKeys: cols.map((c) => c.key), filterKeys });
      const kept = sortTableRows(applyColumnFilters(fetched, colFilters, allColumns), sort, allColumns, Boolean(serverSort));
      const matrix = buildLineExportMatrix(kept, spec.linesOf, cols);
      const date = new Date().toISOString().slice(0, 10);
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
    // Optional override: the caller exports a broader/full dataset (e.g. all
    // pages, ignoring a screen-only filter) with the same columns.
    const csvCols: CSVColumn<T>[] = visibleColumns
      .filter((c) => typeof c.getValue === "function" || typeof c.exportValue === "function")
      .map((c) => ({
        key: c.key,
        label: c.exportLabel || c.label || c.key,
        getValue: (r: T) => (c.exportValue ? c.exportValue(r) : isoForExport(c.getValue!(r) as string | number | null)),
      }));
    if (onExport) { onExport(csvCols); return; }
    if (!sortedRows || sortedRows.length === 0 || csvCols.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV(`${exportName || tableId || "export"}-${date}.csv`, toCSV(sortedRows, csvCols));
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && onImport) onImport(f);
    e.target.value = "";
  }

  // ── Sorting ────────────────────────────────────────────
  // Clicking a sortable header cycles: none → asc → desc → none.
  // - Default (client mode): sort applies in-memory to the rows passed in.
  // - Server mode (serverSort): for columns the backend can sort (no
  //   `disableSort`), in-memory sort is skipped and the new sort state is
  //   reported via onSortChange so the parent can re-query with
  //   sort_by/sort_dir — ordering applies across the full dataset. Columns
  //   marked `disableSort` (= not in the backend's sort whitelist) fall back
  //   to CLIENT-side sorting of the loaded page and are NEVER reported, so
  //   the server query (and pagination) is untouched.

  // Every getValue column is sortable. On client tables `disableSort` opts
  // out entirely; on server tables it only demotes the column to the
  // client-side fallback (see above).
  const canSortColumn = useCallback(
    (col: Column<T>) => !!col.getValue && (!col.disableSort || !!serverSort),
    [serverSort]
  );

  // A sort the parent's backend understands: a sort on a non-disableSort
  // column. Anything else maps to null (backend default order).
  const serverReportable = useCallback(
    (s: SortState | null): SortState | null => {
      if (!s) return null;
      const col = allColumns.find((c) => c.key === s.key);
      return col?.getValue && !col.disableSort ? s : null;
    },
    [allColumns]
  );

  // Report a sort change to a server-sorted parent, de-duplicated: switching
  // between two client-fallback columns both maps to null, and re-reporting
  // null would needlessly reset the parent's pagination on every click. The
  // `undefined` sentinel guarantees exactly ONE call on mount (the parent's
  // sortSyncedRef handshake relies on it).
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

  // Set an explicit sort direction for a column (used by the header
  // context menu's "Sort ascending / descending"). Mirrors onHeaderClick's
  // server-mode reporting so server-sorted tables re-query.
  function applySort(col: Column<T>, dir: SortDir) {
    if (!canSortColumn(col)) return;
    const next: SortState = { key: col.key, dir };
    setSort(next);
    reportServerSort(next);
  }

  // On mount, if the parent is in server-sort mode and we restored a
  // sort from localStorage, push it up so the initial query matches.
  // A restored sort on a client-fallback column reports null — the backend
  // never saw that key; the loaded page is re-sorted in memory instead.
  // (Effect, not render, so we don't fire during render.)
  useEffect(() => {
    reportServerSort(sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the header context menu on any outside click, Escape, or scroll
  // (the menu is positioned at fixed page coordinates, so a scroll would
  // detach it from its anchor). Clicks inside the menu stop propagation.
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

  // Close the filter popover on outside click, Escape, or scroll — same
  // pattern as the header menu. Clicks inside stop propagation so ticking
  // checkboxes doesn't dismiss it. Scrolls are heard in the CAPTURE phase
  // (scroll doesn't bubble), which also catches the popover's own value
  // checklist — but scrolling INSIDE the popover must not dismiss it (owner
  // 2026-07-29: the list past ~240px was unreachable, any wheel closed the
  // menu), so scrolls originating within the menu are let through.
  useEffect(() => {
    if (!filterMenu) return;
    const close = () => setFilterMenu(null);
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && filterMenuRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterMenu]);

  // Close the row context menu on outside click, Escape, or scroll — same
  // detach-from-anchor reasoning as the header menu (it's fixed-positioned).
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

  // Per-column filters apply first (client-side, loaded rows only), then
  // sort — the SAME functions the line export runs over every fetched row
  // (dataTableRows.ts).
  const filteredRows = useMemo(
    () => (rows ? applyColumnFilters(rows, colFilters, allColumns) : rows),
    [rows, colFilters, allColumns],
  );

  const sortedRows = useMemo(
    () => (filteredRows ? sortTableRows(filteredRows, sort, allColumns, Boolean(serverSort)) : filteredRows),
    [filteredRows, sort, allColumns, serverSort],
  );

  /* Report what the operator can actually see (owner 2026-08-12) — see the
     onFilteredRowsChange prop doc. In an effect, not during render, so a parent
     that stores these in state cannot re-enter this render pass. `rows` is
     undefined while loading; skip rather than publish an empty set, or a
     summary card would blink to zero on every refetch. */
  /* Published only when the rows actually CHANGED, not when the array is new.
     A funnel yields a fresh filtered array whenever the memo recomputes, and
     it recomputes whenever the caller passes new column objects — which every
     list page does on every render. A parent storing the report then rendered,
     rebuilt its columns, got a new array, stored it again: an endless render
     loop on any list with a saved funnel (docs/bugs, 2026-09-15). */
  const reportedRowsRef = useRef<T[] | null>(null);
  useEffect(() => {
    if (!sortedRows) return;
    const prev = reportedRowsRef.current;
    if (prev && prev.length === sortedRows.length && prev.every((r, i) => r === sortedRows[i])) return;
    reportedRowsRef.current = sortedRows;
    onFilteredRowsChange?.(sortedRows);
  }, [sortedRows, onFilteredRowsChange]);

  // Total column span for full-width body cells (skeleton / error / empty /
  // expansion). The chevron column (when `expandable`) adds one leading
  // column that isn't in `displayColumns`. When no chevron, this equals
  // `displayColumns.length`, so non-expandable callers are unchanged.
  const expandColCount = expandable ? 1 : 0;
  const selectColCount = selection ? 1 : 0;
  const totalColSpan = displayColumns.length + expandColCount + selectColCount;

  // ── Group-by (opt-in) ──────────────────────────────────────
  // Flatten the sorted rows into a list of render instructions — a group
  // header followed by its rows (unless collapsed). Single level only (the
  // prop is a single key). When `groupBy` is unset we keep a plain
  // `{ kind: "row" }` stream so the tbody map below is identical to the old
  // flat render. Grouping needs a `getValue` on the target column for a
  // stable bucket key; if that's missing we silently fall back to flat.
  type RenderItem =
    | { kind: "group"; value: string; label: string; count: number; collapsed: boolean }
    | { kind: "row"; row: T; rowIdx: number };
  const groupCol = useMemo(
    () =>
      groupBy ? allColumns.find((c) => c.key === groupBy.key) ?? null : null,
    [groupBy, allColumns]
  );
  const renderList = useMemo<RenderItem[]>(() => {
    if (!sortedRows) return [];
    if (!groupBy || !groupCol || !groupCol.getValue) {
      return sortedRows.map((row, rowIdx) => ({ kind: "row", row, rowIdx }));
    }
    const getter = groupCol.getValue;
    // Preserve first-seen group order (sortedRows already reflects any active
    // sort), bucketing rows by their stringified group value.
    const order: string[] = [];
    const buckets = new Map<string, T[]>();
    for (const row of sortedRows) {
      const raw = getter(row);
      const val = raw == null || raw === "" ? "" : String(raw);
      if (!buckets.has(val)) {
        buckets.set(val, []);
        order.push(val);
      }
      buckets.get(val)!.push(row);
    }
    const out: RenderItem[] = [];
    let rowIdx = 0;
    for (const val of order) {
      const bucket = buckets.get(val)!;
      const collapsed = collapsedGroupSet.has(val);
      out.push({
        kind: "group",
        value: val,
        label: groupBy.label ? groupBy.label(val) : val || "(blank)",
        count: bucket.length,
        collapsed,
      });
      if (!collapsed) {
        for (const row of bucket) {
          out.push({ kind: "row", row, rowIdx });
          rowIdx++;
        }
      } else {
        // Keep the zebra index advancing past collapsed rows so re-expanding
        // doesn't shift the stripe pattern of later rows.
        rowIdx += bucket.length;
      }
    }
    return out;
  }, [sortedRows, groupBy, groupCol, collapsedGroupSet]);

  // Density-aware cell padding. Tightened on 2026-05-08 — every row
  // is one line of data, full stop. Old comfy (py-3.5) and old
  // compact (py-2) both wasted vertical space; the new values
  // collapse to a single 13px line + minimal cushion on each side.
  // Headers stay one notch taller so the column boundary still reads.
  // Permanently comfy (density toggle removed 2026-06).
  const cellPad = "px-3 py-1.5 leading-tight";
  const headPad = "px-3 py-2 leading-tight";

  // Common toolbar button class — used by Import / Export / Density / Columns.
  // 44 px on mobile (touch-target floor), compresses to 32 px on sm+ where
  // mouse precision is available.
  const toolbarBtn =
    "inline-flex h-11 sm:h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-surface disabled:hover:text-ink-secondary";

  const rowCount = sortedRows?.length ?? 0;
  const visibleCount = chooserOptions.filter((o) => !effectiveHidden.has(o.key)).length;

  // ── Row selection (opt-in `selection`) ─────────────────────────────────────
  // Select-all operates over the currently-rendered rows (post filter + sort).
  const selectableKeys = useMemo(
    () => (selection && sortedRows ? sortedRows.map((r) => String(getRowKey(r))) : []),
    [selection, sortedRows, getRowKey]
  );
  const allRowsSelected =
    !!selection &&
    selectableKeys.length > 0 &&
    selectableKeys.every((k) => selection.selectedIds.has(k));
  const someRowsSelected =
    !!selection &&
    !allRowsSelected &&
    selectableKeys.some((k) => selection.selectedIds.has(k));

  // ── Row windowing (page-scroll-preserving) ─────────────────────────────────
  // Only the common flat case: grouped / expandable tables and short lists render
  // in full (unchanged). The tbody is measured against the viewport on scroll
  // (from ANY ancestor — a capturing window listener catches non-bubbling scroll
  // events) and on resize; only the visible slice of rows is rendered, bracketed
  // by two spacer <tr>s that reserve the off-screen height so the page scrollbar
  // and sticky header behave exactly as before. Row height is measured from a
  // real row so the spacers can't drift (avoids the HOOKKA getTotalSize lag).
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
    showTable && !effectiveLoading && !error && !groupBy &&
    (!expandable || expandedRowsEffective.size === 0) &&
    renderList.length > VIRTUAL_ROW_THRESHOLD;
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const rowHeightRef = useRef(ROW_HEIGHT_ESTIMATE);
  const [winRange, setWinRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: VIRTUAL_ROW_THRESHOLD * 2,
  });
  useEffect(() => {
    if (!canVirtualize) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = tbodyRef.current;
      if (!el) return;
      const firstRow = el.querySelector<HTMLElement>("tr[data-vrow]");
      if (firstRow && firstRow.offsetHeight > 0) rowHeightRef.current = firstRow.offsetHeight;
      const rh = rowHeightRef.current || ROW_HEIGHT_ESTIMATE;
      const top = el.getBoundingClientRect().top; // tbody top relative to viewport
      const vh = window.innerHeight;
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
  }, [canVirtualize, renderList.length]);
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
  } = useFrozenTableHeader(showTable);

  return (
    <div ref={freezeRootRef}>
      {/* ── Toolbar (always rendered) ──────────────────────── */}
      <div className="mb-2.5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2 sm:gap-3">
          {search && (
            <div className="w-full sm:w-72 sm:max-w-full">
              <div className="relative">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
                />
                <DebouncedSearchInput
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
            active={colFiltersActive || (resetFilters?.active ?? false)}
            onReset={handleResetFilters}
            label={resetFilters?.label}
          />
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
            {exporting ? "Exporting…" : exportLabel}
          </button>
          {toolbarExtra}
          {/* Density toggle removed 2026-06 — layout is permanently comfy. */}
          {/* Mobile-only: flip between cards and the desktop-style table
              (horizontally scrollable). Hidden on `sm+` because the
              table is already the default there. */}
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
          <ColumnsButton
            visibleCount={visibleCount}
            totalCount={chooserOptions.length}
            onClick={() => setChooserOpen(true)}
            active={chooserOpen}
          />
        </div>
      </div>

      {/* Columns drawer (design handoff "Direction A", 2026-08-01). Mounted
          only while open: its hooks (viewport media query, key handler) would
          otherwise run for every table on the page that nobody has opened. */}
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
        defaultManager={defaultManager}
        dirty={layoutDirty}
        onExport={exportColumnConfig}
        udf={udfTable ? udf : undefined}
        udfTableLabel={udfTableLabel || udfTable}
      />
      )}

      {/* ── Table (sm+ always; on `<sm` only when mobileView=table). The
            outer wrapper drops `overflow-hidden` when forced on mobile
            so the rounded corners don't clip the horizontal scroll
            shadow at the right edge. */}
      {showTable && (
        <div
          className="rounded-lg border border-border bg-surface shadow-stone sm:block sm:overflow-hidden"
          style={freezeBoxStyle}
        >
          <div
            ref={scrollWrapRef}
            className="thin-scroll overflow-x-auto overflow-y-auto"
            style={freezeScrollStyle}
          >
          <table
            className={cn(
              "border-separate border-spacing-0 text-sm",
              // Fixed layout sizes the table to the sum of its columns (below);
              // otherwise fill the container and let the auto layout distribute.
              !fixedColumnWidths && "w-full",
            )}
            style={fixedColumnWidths ? { tableLayout: "fixed", width: fixedTableWidth } : undefined}
          >
            <thead className="sticky top-0 z-10">
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
                  // The left EDGE of the right run gets the divider, mirroring
                  // the right edge of the left run.
                  const isFirstStickyRight =
                    isStickyRight && i === displayColumns.length - stickyRightCount;
                  const userW = widths[c.key];
                  // Inline sizing: a user width (px) always wins; otherwise
                  // fall through to the column's own `width` string. When a
                  // width is in force we also pin min/max to it so the cell
                  // actually holds the size instead of the browser
                  // redistributing free space.
                  const cellStyle: React.CSSProperties = {};
                  if (fixedColumnWidths) {
                    // Fixed layout: pin every column to its resolved width so the
                    // table-layout:fixed grid honours it exactly (widths come from
                    // this header row) and a resize grows ONLY this column, never
                    // its neighbours. resolveWidth already folds in a user drag.
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
                    // A declared px width is a CAP, not a suggestion: without
                    // maxWidth the auto table layout stretches the column to
                    // its longest nowrap cell, and a long value in a squeezed
                    // layout paints over the neighbouring column (owner
                    // 2026-07-24 screenshot — cells must clip, system-wide).
                    const px = parsePxWidth(c.width);
                    if (px != null) cellStyle.maxWidth = px;
                  }
                  if (isSticky) {
                    cellStyle.position = "sticky";
                    cellStyle.left = stickyLeft[i];
                    // Above body sticky cells (z-20) and the sticky header
                    // baseline (the thead is z-10); 30 keeps frozen headers
                    // on top of everything during a two-axis scroll.
                    cellStyle.zIndex = 30;
                  } else if (isStickyRight) {
                    cellStyle.position = "sticky";
                    cellStyle.right = stickyRight[i];
                    cellStyle.zIndex = 30;
                  }
                  return (
                    <th
                      key={c.key}
                      style={cellStyle}
                      /* Drag the header itself to reorder. HTML5 DnD, same as
                         the Columns drawer. The resize strip preventDefaults
                         its mousedown, which stops a drag from starting there,
                         so resizing the edge still resizes. */
                      draggable={canDragHeader(c)}
                      onDragStart={(e) => {
                        if (!canDragHeader(c)) return;
                        draggedRef.current = true;
                        setDragCol(c.key);
                        // Firefox refuses to start a drag with no payload.
                        e.dataTransfer.effectAllowed = "move";
                        try {
                          e.dataTransfer.setData("text/plain", c.key);
                        } catch {
                          // Locked-down dataTransfer — the drag still works in
                          // Chromium, which reads our React state instead.
                        }
                      }}
                      onDragOver={(e) => {
                        if (!canDropHeader(c)) return;
                        // Without preventDefault the browser refuses the drop.
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
                        // A drag ends in a click on some browsers; that click
                        // must not also cycle the sort.
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
                        "group/th relative overflow-hidden border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink",
                        headPad,
                        c.align === "right" && "text-right",
                        c.align === "center" && "text-center",
                        (c.align === "left" || !c.align) && "text-left",
                        // First real column owns the left edge gutter only
                        // when there's no leading select / chevron column
                        // ahead of it.
                        i === 0 && !expandable && !selection && "pl-5",
                        i === displayColumns.length - 1 && "pr-5",
                        sortable && "cursor-pointer select-none hover:text-primary",
                        active && "text-primary",
                        // The column being carried dims; everything else stays
                        // put so the insertion bar is the only thing moving.
                        dragCol === c.key && "opacity-40",
                        // Delineate the frozen region: a right border on the
                        // last sticky column reads as the freeze line.
                        isLastSticky && "border-r border-border",
                        isFirstStickyRight && "border-l border-border"
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
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
                            {c.label}
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
                                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                  setFilterQuery("");
                                  setFilterMenu((cur) =>
                                    cur?.colKey === c.key
                                      ? null
                                      : { left: rect.left, top: rect.top, bottom: rect.bottom, colKey: c.key }
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
                      {/* Resize handle — a dedicated right-edge strip. It
                          stops click/contextmenu propagation so dragging it
                          never sorts or opens the column menu. Double-click
                          auto-fits (clears the stored width). */}
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
                        className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none opacity-0 transition-opacity hover:bg-primary/40 group-hover/th:opacity-100"
                      />
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
                  );
                })}
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
                    <div className="font-semibold">Failed to load</div>
                    <div className="mt-1 text-xs text-ink-muted">{error}</div>
                  </td>
                </tr>
              )}
              {!effectiveLoading && !error && sortedRows && sortedRows.length === 0 && (
                <tr>
                  <td
                    colSpan={totalColSpan}
                    className="px-3 py-20 text-center text-sm text-ink-muted"
                  >
                    {emptyLabel}
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
                  // ── Group header row (opt-in `groupBy`) ──
                  if (item.kind === "group") {
                    return (
                      <tr
                        key={`grp:${item.value}`}
                        onClick={() => toggleGroup(item.value)}
                        className="cursor-pointer select-none bg-surface-dim/70 transition-colors hover:bg-surface-dim"
                      >
                        <td
                          colSpan={totalColSpan}
                          className={cn(
                            "border-b border-border-subtle pr-5 text-[11px] font-semibold uppercase tracking-brand text-ink",
                            cellPad
                          )}
                        >
                          <span className="inline-flex items-center gap-1.5 pl-5">
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

                  // ── Data row ──
                  const { row, rowIdx } = item;
                  const customClass = getRowClassName?.(row);
                  // Opaque zebra background for sticky cells. A sticky cell
                  // must occlude the body content scrolling beneath it, so
                  // it needs a solid fill (the row's own bg sits on the
                  // <tr>, which doesn't paint over the sliding siblings).
                  // Odd-row value = `surface-dim` (#ecebe2) at 35% over the
                  // white surface, pre-blended so there's no visible seam.
                  const stickyBg =
                    rowIdx % 2 === 0 ? "#ffffff" : "#f8f8f5";
                  const expId = expandable ? expansionId(row) : null;
                  const isExpanded = expId != null && expandedRowsEffective.has(expId);
                  const selKey = selection ? String(getRowKey(row)) : null;
                  const isRowSelected =
                    selKey != null && selection!.selectedIds.has(selKey);
                  return (
                    <Fragment key={getRowKey(row)}>
                      <tr
                        data-vrow=""
                        onClick={onRowClick ? () => onRowClick(row) : undefined}
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
                          /* The zebra only where the row has no colour of its own: the built
                             CSS emits .bg-surface AFTER .bg-primary/10 / .bg-err-bg, so on one
                             <tr> the zebra won and a ticked or toned row never painted. */
                          isRowSelected ? "bg-primary/10"
                            : customClass && /(^|\s)!?bg-/.test(customClass) ? null
                            : rowIdx % 2 === 0 ? "bg-surface" : "bg-surface-dim/35",
                          onRowClick && "cursor-pointer",
                          customClass
                        )}
                      >
                        {/* Selection checkbox cell (opt-in `selection`). Stops
                            click propagation so ticking never also fires
                            onRowClick (which typically opens a drawer). */}
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
                              aria-label="Select row"
                              checked={isRowSelected}
                              onChange={() => {
                                if (selKey != null) selection.onToggle(selKey);
                              }}
                              className="cursor-pointer accent-primary"
                            />
                          </td>
                        )}
                        {/* Chevron drill-down cell (opt-in `expandable`).
                            Stops click propagation so toggling the row's
                            expansion never also fires onRowClick. */}
                        {expandable && (
                          <td
                            style={{ width: 32, minWidth: 32, maxWidth: 32 }}
                            className={cn(
                              "border-b border-border-subtle align-middle text-ink transition-colors group-hover:bg-[#3f6b53]/25",
                              selection ? "pl-3" : "pl-5",
                              cellPad
                            )}
                          >
                            <button
                              type="button"
                              aria-label={isExpanded ? "Collapse row" : "Expand row"}
                              aria-expanded={isExpanded}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (expId != null) toggleExpand(expId);
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
                          </td>
                        )}
                        {displayColumns.map((c, i) => {
                          const isSticky = i < stickyCount;
                          const isLastSticky = isSticky && i === stickyCount - 1;
                          const isStickyRight = stickyRight[i] !== undefined;
                          const isFirstStickyRight =
                            isStickyRight && i === displayColumns.length - stickyRightCount;
                          const userW = widths[c.key];
                          const cellStyle: React.CSSProperties = {};
                          if (typeof userW === "number") {
                            cellStyle.width = userW;
                            cellStyle.minWidth = userW;
                            cellStyle.maxWidth = userW;
                          } else if (c.width) {
                            cellStyle.width = c.width;
                            // Same cap as the header cell: a px width means
                            // "clip here", never "stretch to the longest value".
                            const px = parsePxWidth(c.width);
                            if (px != null) cellStyle.maxWidth = px;
                          }
                          if (isSticky) {
                            cellStyle.position = "sticky";
                            cellStyle.left = stickyLeft[i];
                            cellStyle.zIndex = 20;
                            cellStyle.background = stickyBg;
                          } else if (isStickyRight) {
                            cellStyle.position = "sticky";
                            cellStyle.right = stickyRight[i];
                            cellStyle.zIndex = 20;
                            // Opaque for the same reason the left run is: the
                            // scrolling middle passes UNDER these cells.
                            cellStyle.background = stickyBg;
                          }
                          // Full raw value as a native tooltip so a clipped
                          // cell is still readable on hover. Strings only:
                          // numeric getValues are raw centi/ISO shapes that
                          // would contradict the formatted cell text.
                          const rawVal = c.getValue?.(row);
                          const cellTitle =
                            typeof rawVal === "string" && rawVal !== ""
                              ? rawVal
                              : undefined;
                          return (
                            <td
                              key={c.key}
                              style={cellStyle}
                              title={cellTitle}
                              className={cn(
                                "border-b border-border-subtle text-[13px] text-ink transition-colors",
                                cellPad,
                                // Single-line rule (2026-05-08) + clip rule
                                // (owner 2026-07-24). Cells stop wrapping AND
                                // stop painting past their own column: a value
                                // longer than the column is cropped with an
                                // ellipsis (full text in the title tooltip)
                                // instead of overlapping the neighbour cell.
                                // Render functions that genuinely need
                                // multi-line wrap via an inner block element
                                // or `c.className` ("whitespace-normal") —
                                // still overflow-hidden within the column.
                                "overflow-hidden text-ellipsis whitespace-nowrap",
                                // Pine-green tint on hover (matches the
                                // calendar's "on track" green). Reads clearly
                                // on both zebra shades. (Was a pale brass
                                // `accent-soft` wash that looked yellow.)
                                "group-hover:bg-[#3f6b53]/25",
                                c.align === "right" && "text-right",
                                c.align === "center" && "text-center",
                                // Leading gutter belongs to the select /
                                // chevron cell when present; otherwise the
                                // first column.
                                i === 0 && !expandable && !selection && "pl-5",
                                i === displayColumns.length - 1 && "pr-5",
                                // Freeze line on the last sticky column.
                                isLastSticky && "border-r border-border",
                                isFirstStickyRight && "border-l border-border",
                                c.className
                              )}
                            >
                              {c.render(row)}
                            </td>
                          );
                        })}
                      </tr>
                      {/* Inline expanded sub-row (opt-in `expandable`). Spans
                          the full width; renders the caller's drill-down.
                          Carries the parent row's getRowClassName class so a
                          state the page paints on the row (e.g. the muted
                          cancelled-row treatment) covers the drill-down too —
                          a full-strength expansion under a faded row would
                          read as live lines on a dead document. */}
                      {isExpanded && expandable && (
                        <tr className={cn("bg-surface-dim/20", customClass)}>
                          <td
                            colSpan={totalColSpan}
                            className="border-b border-border-subtle px-5 py-3 text-[13px] text-ink"
                          >
                            {expandable.render(row)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              {canVirtualize && vEnd < renderList.length && (
                <tr aria-hidden>
                  <td colSpan={totalColSpan} style={{ height: (renderList.length - vEnd) * rowHeightRef.current, padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* ── Mobile card list (<sm) ─────────────────────────────
          Same data, stacked-card layout. The first visible column
          becomes the card title; subsequent columns render as
          label/value rows. Skips the row entirely if the user
          intentionally hid the first column. */}
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
            <div className="font-semibold">Failed to load</div>
            <div className="mt-1 text-xs text-ink-muted">{error}</div>
          </div>
        )}
        {!effectiveLoading && !error && sortedRows && sortedRows.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-ink-muted">
            {emptyLabel}
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
                    // Same rule as the table row: a card's own background replaces the default.
                    !(customClass && /(^|\s)!?bg-/.test(customClass)) && "bg-surface",
                    onRowClick &&
                      "cursor-pointer active:bg-primary/15 hover:border-primary/40",
                    customClass,
                  )}
                >
                {/* Petrol accent rail — subtle anchor on the left edge of a
                    clickable row card, matches the IdeaList card pattern. */}
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
                            // Always left-align in card view so cells
                            // don't zig-zag between the left and right
                            // edges of their column. `tabular-nums`
                            // still keeps numeric digits in lockstep.
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
                              // Always left-align in card view. The
                              // desktop column's `align: "right"` only
                              // gets us tabular-nums + a heavier weight
                              // here — flipping the entire cell to the
                              // right edge creates a jagged value
                              // column when stacked with left-aligned
                              // siblings.
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

      {/* ── Header right-click context menu — portalled to <body> (escapes
          overflow clip + sticky stacking); closes on outside/Esc/scroll. */}
      {/* ── Column filter + sort popover — every getValue column (owner
          2026-07-24), portalled like the menu. Sort A→Z/Z→A, live search over
          distinct getValue results across LOADED rows (pre-filter so unticking
          works), Select all / Invert / Clear, checklist with counts. */}
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
          const selected = new Set(colFilters[col.key] ?? []);
          const q = filterQuery.trim().toLowerCase();
          const shown = q
            ? values.filter(([v]) => (col.filterLabel?.(v) ?? v).toLowerCase().includes(q))
            : values;
          const shownValues = shown.map(([v]) => v);
          const canSort = canSortColumn(col);
          const sortActive = sort?.key === col.key ? sort.dir : null;

          // Select all / Invert operate on the CURRENTLY SHOWN values (i.e.
          // respect an active search), leaving any selection outside the
          // search untouched — so you can search "KL", tick those, clear the
          // search, search "Selangor", tick those, and keep both.
          const selectAll = () =>
            setColumnFilter(col.key, [...selected, ...shownValues]);
          const invert = () => {
            const shownSet = new Set(shownValues);
            const keptOutsideSearch = [...selected].filter((v) => !shownSet.has(v));
            const flippedWithinSearch = shownValues.filter((v) => !selected.has(v));
            setColumnFilter(col.key, [...keptOutsideSearch, ...flippedWithinSearch]);
          };

          const sortBtn =
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-surface-dim disabled:cursor-not-allowed disabled:text-ink-muted disabled:hover:bg-transparent";
          if (!filterMenuPos) return null;
          return createPortal(
            <div
              ref={filterMenuRef}
              className="fixed z-[120] flex w-[236px] flex-col overflow-hidden rounded-md border border-border bg-surface shadow-slab"
              style={{ top: filterMenuPos.top, bottom: filterMenuPos.bottom, left: filterMenuPos.left, maxHeight: filterMenuPos.maxHeight }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="shrink-0 border-b border-border-subtle px-3 py-2">
                <span className="text-[10px] font-bold uppercase tracking-brand text-ink-secondary">
                  {col.label || col.key}
                </span>
              </div>

              {/* Sort */}
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
                  Sort A → Z
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
                  Sort Z → A
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
              </div>

              {/* Search */}
              <div className="shrink-0 border-b border-border-subtle px-3 py-1.5">
                <input
                  autoFocus
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="Search values…"
                  className="w-full rounded border border-border bg-bg px-2 py-1 text-[12px] outline-none focus:border-primary"
                />
              </div>

              {/* Bulk actions */}
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
                  disabled={selected.size === 0}
                  className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-dim disabled:text-ink-muted/50 disabled:hover:bg-transparent"
                >
                  Clear
                </button>
              </div>

              {/* Value checklist — its own scroller. `overscroll-contain` so a
                  wheel that hits the top/bottom of the list doesn't chain into
                  a page scroll (which closes the popover); `min-h-0` lets it
                  shrink when the viewport-capped flex column runs short. */}
              <div className="max-h-[240px] min-h-0 overflow-y-auto overscroll-contain py-1">
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
          const canHide = !col.alwaysVisible;
          const itemCls =
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-surface-dim disabled:cursor-not-allowed disabled:text-ink-muted disabled:hover:bg-transparent";
          const pos = headerMenuPos ?? { top: headerMenu.y, left: headerMenu.x };
          return createPortal(
            <div
              ref={headerMenuRef}
              className="fixed z-[120] min-w-[176px] overflow-hidden rounded-md border border-border bg-surface py-1 shadow-slab"
              style={{ top: pos.top, left: pos.left }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
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
            </div>,
            document.body
          );
        })()}

      {/* ── Row right-click context menu (opt-in `contextMenu`) ──────
          Portalled to <body> — same escape-the-overflow/stacking reasoning
          as the header menu, but at a higher z so it clears the sticky
          <thead>. Items + danger/divider come from `contextMenu(row)`,
          resolved when the menu opened. Closes on outside click / Esc /
          scroll (effect above). */}
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
                    // Close before firing — a handler may navigate or open a
                    // dialog, and we don't want a stale menu lingering.
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
      {/* Runway spacer — see the frozen-header block above: restores exactly
          the page-scroll distance the height cap removed, so scrolling always
          carries the table box up to the pinned page header before the page
          runs out. Desktop freeze mode only; costs nothing else. */}
      {showTable && freezeBox && freezeBox.runway > 0 && (
        <div ref={runwaySpacerRef} aria-hidden style={{ height: freezeBox.runway }} />
      )}
    </div>
  );
}

// ── Sort comparator ──────────────────────────────────────────
// Handles the common shapes getValue returns: null/undefined last,
// then numbers numerically, then strings case-insensitively, then
// booleans (false < true).
