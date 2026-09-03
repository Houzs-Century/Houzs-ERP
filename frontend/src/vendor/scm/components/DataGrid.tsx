// DataGrid — reusable AutoCount-style data grid primitive.
//
// Built for high-density ERP list views (Sales Orders, Purchase Orders, etc.).
// Features:
//   - Drag column headers to reorder
//   - Right-click header → context menu (hide / pin left / auto-fit width)
//   - Resize columns via right-edge drag handle
//   - Sort: click sort arrow per column (asc / desc / off)
//   - Global search across all string-coercible cells
//   - Group-by zone: drag a column header onto the banner to group rows;
//     multiple group levels supported; rows collapse with caret
//   - Layout persisted to localStorage[storageKey]:
//       { order, hidden, widths, groupBy, sort }
//   - Sticky header. Density: row height ~28px, body fs-12, header fs-10
//     uppercase letter-spacing 0.06em.
//
// Pure React + HTML5 drag-and-drop. No new deps.
//
// The toolbar (New / Edit / View / etc.) is rendered by the calling page —
// DataGrid keeps the search box on the right of its own toolbar slot and
// accepts arbitrary toolbar children on the left.

import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  type MouseEvent,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Search, Filter, Download, GripVertical, X, ChevronsUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { isoForExport } from '../../shared/format'; // a date cell exports as ISO, never as displayed
import { useDebouncedValue } from '../lib/hooks';
import { SkeletonRows } from './Skeleton';
import { DateField } from './DateField';
import {
  DEFAULT_DATA_GRID_LAYOUT,
  type DataGridLayout, isSharedDataGridStorageKey,
  materializeDataGridLayout,
  useCompanyScopedDataGridLayout,
  writeDataGridLayout,
} from './dataGridLayoutStorage';
import { readDataGridFilters, writeDataGridFilters } from './dataGridFilterStorage';
import { subscribeActiveCompany, getActiveCompanySnapshot } from '../../../lib/activeCompany';
import {
  EMPTY_LAYOUT,
  createNamedLayout,
  dataGridTableKey,
  deleteNamedLayout,
  renameCompanyDefault,
  renameNamedLayout,
  updateNamedLayout,
  getTableLayoutsSnapshot,
  saveCompanyDefault,
  saveMyLayout,
  serializeLayout,
  subscribeTableLayouts,
  type StoredLayout,
} from '../../../lib/tableLayouts';
import { shortCompanyName } from '../../../lib/branding';
import { inferColumnGroup } from '../../../lib/columnGroups';
import { withSingleActive, type LayoutPresetOption } from '../../../components/LayoutSection';
import { ColumnsDrawer, ColumnsButton, type DrawerColumn } from '../../../components/ColumnsDrawer';
import { ResetFiltersButton } from '../../../components/ResetFiltersButton';
import styles from './DataGrid.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

export type DataGridColumn<T> = {
  key: string;
  label: string;
  /** Category this column sits under in the Columns drawer — same opt-in field
   *  DataTable's Column carries. Unannotated grids render one flat list. */
  group?: string;
  accessor: (row: T) => ReactNode;
  /** default width in px */
  width?: number;
  minWidth?: number;
  align?: 'left' | 'right';
  sortable?: boolean;
  groupable?: boolean;
  sortFn?: (a: T, b: T) => number;
  /** value used when grouping (defaults to String(accessor(row))) */
  groupValue?: (row: T) => string;
  /** value used by global search (defaults to String(accessor(row))) */
  searchValue?: (row: T) => string;
  /** Text value written to Excel by the toolbar "Export Excel" button. Lets a
      caller override the exported cell when the cell renders JSX or when the
      search/filter value bundles extra tokens. Falls back, in order, to
      searchValue → filterValue → groupValue → '' (cells are ReactNode, so we
      never read the rendered node). */
  exportValue?: (row: T) => string | number;
  /** Header text written to Excel for this column. Defaults to `label`. Use this
      ONLY when the on-screen `label` is intentionally blank (a pure icon /
      checkbox / indicator column) so the exported sheet still gets a real,
      non-empty header cell instead of a blank one (anchoring sync 2026-06-25). */
  exportLabel?: string;
  /** Clean single value shown in (and matched by) the per-column filter
      dropdown. Use this when `searchValue` deliberately bundles several
      tokens (e.g. "SO-2605-001 CONFIRMED") so the funnel still lists the one
      value the operator sees in the cell. Falls back to groupValue, then the
      cell text — never to searchValue. */
  filterValue?: (row: T) => string;
  /** Per-column filter UX (Commander 2026-06-18 — one unified filter spec):
      - 'date'      → quick presets (Today/This week/This month/…) + a custom
                      from→to range. `dateValue` returns the row's RAW ISO date.
      - 'number'    → min/max range inputs. `numberValue` returns the raw number.
      - 'numbering' → searchable distinct-value list (type-to-find over doc
                      codes like PO-2606-001), backed by `filterValue`.
      - 'enum' | 'text' | undefined → the classic checkbox value list. */
  filterType?: 'date' | 'number' | 'numbering' | 'enum' | 'text';
  dateValue?: (row: T) => string | null | undefined;
  /** Raw numeric value for `filterType: 'number'` min/max matching. */
  numberValue?: (row: T) => number | null | undefined;
  /**
   * HOUZS port (so-list-houzs-port) — when true and the user hasn't manually
   * hidden/shown anything yet (no persisted `layout.hidden` for this key),
   * the column is hidden by default. User can show it via right-click "Show
   * column" menu; the choice persists in localStorage from then on.
   * Used to match Houzs "19 of 25 columns visible by default" semantics.
   */
  defaultHidden?: boolean;
};

/** A single entry in a row's right-click context menu. `divider: true`
    renders a horizontal rule (the other fields are then ignored). */
export type DataGridContextMenuItem = {
  label?: string;
  onClick?: () => void;
  /** Renders with `var(--c-festive-b)` color and a danger hover state. */
  danger?: boolean;
  /** When true, this entry renders as a `<hr>` divider between groups. */
  divider?: boolean;
};

export type DataGridProps<T> = {
  rows: T[];
  columns: DataGridColumn<T>[];
  /** localStorage key for column layout persistence */
  storageKey: string;
  /** row id accessor — required for selection + key */
  rowKey: (row: T) => string;
  searchPlaceholder?: string;
  /** Optional exact loaded-set count for the client search hint. Defaults to
      rows.length; pass a pre-filter count when the caller already narrowed rows. */
  loadedSearchCount?: number;
  /** Known upstream cap; makes client-only search scope explicit to operators. */
  loadedSearchLimit?: number;
  /** Human filename stem for the "Export Excel" button, e.g. "Purchase Orders".
      Falls back to a cleaned storageKey when omitted. A YYYY-MM-DD date is
      appended automatically. (Wei Siang 2026-06-20 — storageKey filenames like
      "pr-g-so-list-layout-v1" read like junk.) */
  exportName?: string;
  onRowDoubleClick?: (row: T) => void;
  /** Commander 2026-05-28 — single-click anywhere on a row fires this (in
      addition to the highlight). Cells that stopPropagation (checkboxes,
      inline inputs) won't trigger it. Used by PO-from-SO to toggle a pick. */
  onRowClick?: (row: T) => void;
  /** Commander 2026-05-29 — optional per-row inline style. Used by PO-from-SO
      to grey out rows whose supplier conflicts with the locked one. Returns
      undefined for the default look. */
  rowStyle?: (row: T) => CSSProperties | undefined;
  onSelectionChange?: (rows: T[]) => void;
  /** Fires with the rows currently visible after search + column filters
      (post-sort) — lets a parent print/export exactly what's filtered, no
      row-ticking. Pass a STABLE setter (e.g. a useState dispatch). (2026-06-16) */
  onFilteredRowsChange?: (rows: T[]) => void;
  toolbar?: ReactNode;
  /** controlled focus for the "Find" button — bump to focus the search box */
  focusSearchNonce?: number;
  /** bump to collapse every expanded drill-down row ("Collapse all") */
  collapseAllNonce?: number;
  /** show "Drag a column header here to group by that column" banner */
  groupBanner?: boolean;
  emptyMessage?: string;
  isLoading?: boolean;
  /**
   * Right-click row menu. Receives the row and returns the items to show.
   * Opening selects the row (single-row select). `null`/empty array
   * suppresses the menu (browser default also suppressed).
   */
  contextMenu?: (row: T) => DataGridContextMenuItem[];
  /**
   * Optional inline-expand row support (HOUZS SO Listing pattern).
   *   - prepends a 32px chevron column at the left
   *   - clicking the chevron toggles an inline sub-row below the parent
   *     (rendered by `renderExpansion(row)` spanning all visible columns)
   *   - chevron rotates 90deg when expanded
   * Pass `undefined` (default) to keep the legacy chevron-less layout
   * untouched — existing callers (PO list, etc.) require no changes.
   */
  expandable?: {
    /** Render the sub-row body. Return null to render an empty row. */
    renderExpansion: (row: T) => ReactNode;
    /** Optional: derive a stable row id for expansion state. Defaults to rowKey. */
    rowExpansionKey?: (row: T) => string;
  };
  /**
   * First-class multi-select (Commander 2026-06-19). Prepends a synthetic
   * `__select__` checkbox column (mirrors `__expand__`); the header checkbox
   * selects/clears all currently-visible rows. Selection state lives in the
   * parent so it survives re-render + drives batch actions.
   */
  selectable?: {
    selectedKeys: Set<string>;
    onToggle: (key: string) => void;
    /** Toggle all visible rows. `keys` = the keys currently shown; `allSelected`
        = whether they are all already selected (so the parent clears vs selects).
        Keys vetoed by `isDisabled` are NOT included — the header checkbox must
        never tick a row the operator cannot tick by hand. */
    onToggleAll: (keys: string[], allSelected: boolean) => void;
    /** Optional per-row veto (2026-08-03). A row whose key returns true renders a
        disabled checkbox and drops out of the header checkbox's set. Used by the
        DO-from-SO picker, where picking one customer locks out every other
        customer's lines (one Delivery Order ships to ONE customer). */
    isDisabled?: (key: string) => boolean;
    /** Tick ONLY via the checkbox cell (owner 2026-09-03, on the PV list:
        这个我一点就直接tick 了…做成一定要点那个tick 的格子, 然后我要点开
        pv 时就是点两次打开). With this set, a row click just highlights —
        selection needs the checkbox, opening needs the double-click /
        right-click the page wires. Default OFF: the Commander rule
        (点行=multi-select) stands everywhere that hasn't asked. */
    checkboxOnly?: boolean;
  };
  /**
   * Compact mode for grids embedded inside another grid's expansion row
   * (the SO drill-down). Suppresses the search box and the bottom
   * "N of M rows / Reset layout" status line — both read as heavy chrome
   * inside a small sub-table. The Columns popover button, header drag-
   * reorder, resize and right-click menu stay, so add/remove/reorder
   * columns still work. Pair with `groupBanner={false}`.
   */
  embedded?: boolean;
  /**
   * Suppress ONLY the grid's built-in client-side search box (keeps the status
   * line, Columns popover, etc. — unlike `embedded`). Used by pages that drive
   * search SERVER-SIDE from a page-level input (e.g. the paginated Suppliers
   * list): the grid's client search would otherwise only filter the loaded
   * page, silently hiding matches on other pages. Default false — existing
   * callers keep their in-grid search box.
   */
  hideSearch?: boolean;
  /**
   * Default ordering while NO column sort is active (arrangement queues,
   * owner 2026-08-07). `layout.sort` is single-key; a multi-key default like
   * "date → state → postcode" therefore arrives as ONE pure comparator, applied
   * to the filtered rows only while `layout.sort` is null. A header the
   * operator clicks overrides as always, and cycling that header back to "off"
   * returns HERE (the same relationship DataTable's null sort has to its
   * backend default order). Opt-in per grid: omitted (every existing caller),
   * rows render exactly as passed — byte-identical behaviour.
   */
  defaultSort?: (a: T, b: T) => number;
  /**
   * RENDER-TIME hide overlay (Option B map narrowing, owner 2026-08-08). Keys
   * listed here are hidden IN ADDITION to the user's own hidden set, without
   * ever writing the persisted layout — drop the prop and the user's own
   * column prefs return exactly as saved. Used by the delivery boards to
   * auto-narrow to the essential columns while the side map is open. The
   * Columns drawer keeps showing the user's REAL prefs (the overlay is a
   * temporary state, not a choice of theirs to persist).
   */
  overlayHidden?: readonly string[];
  /**
   * Fired on every EXPLICIT column-visibility choice the user makes — the
   * Columns drawer's toggle / Show all / Reset, the header context menu's
   * Hide/Show column, and applying a saved layout. The Option-B map pages
   * listen so their compact-columns overlay yields the moment the user picks
   * columns by hand (owner bug 2026-08-08: the overlay must be a DEFAULT,
   * never a lock — "已经添加了 column 可是它却没有出来"). Reorder / pin /
   * width gestures do NOT fire it: they never conflict with a hide overlay.
   */
  onUserAdjustColumns?: () => void;
  /**
   * Imperative scroll-to-row (map pin → board linkage, owner 2026-08-08).
   * Bump `nonce` with the target row's key: the grid selects (highlights) the
   * row and scrolls it into view — via the virtualizer when windowed, via
   * scrollIntoView otherwise. Same pin clicked twice re-scrolls (the nonce is
   * the trigger, the key just names the row).
   */
  scrollToRow?: { key: string; nonce: number } | null;
};

type Layout = DataGridLayout;

const coerceSearchString = (v: ReactNode): string => {
  if (v == null || v === false) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  // for ReactNode (e.g., a span with a pill), best-effort: skip — caller can supply searchValue
  return '';
};

/* Date-filter quick presets for `filterType: 'date'` columns (Commander
   2026-06-16). Evaluated in MYT (UTC+8) to match the rest of the app — a Date
   shifted by +8h has its UTC fields equal to the MYT wall clock, so date-only
   math via the getUTCDate / setUTCDate family is correct. */
export type DatePreset = 'today' | 'tomorrow' | 'thisWeek' | 'thisMonth' | 'lastMonth' | 'overdue';
const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'today',     label: 'Today' },
  { key: 'tomorrow',  label: 'Tomorrow' },
  { key: 'thisWeek',  label: 'This week' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'overdue',   label: 'Overdue' },
];
const dateMatchesPreset = (iso: string | null | undefined, preset: DatePreset): boolean => {
  if (!iso) return false;
  const d = String(iso).slice(0, 10);
  if (d.length < 10) return false;
  const nowMyt = new Date(Date.now() + 8 * 3600 * 1000);
  const today = nowMyt.toISOString().slice(0, 10);
  switch (preset) {
    case 'today':    return d === today;
    case 'overdue':  return d < today;
    case 'tomorrow': {
      const t = new Date(nowMyt); t.setUTCDate(t.getUTCDate() + 1);
      return d === t.toISOString().slice(0, 10);
    }
    case 'thisWeek': {
      const dow = (nowMyt.getUTCDay() + 6) % 7; // 0 = Monday
      const mon = new Date(nowMyt); mon.setUTCDate(mon.getUTCDate() - dow);
      const sun = new Date(mon);   sun.setUTCDate(sun.getUTCDate() + 6);
      return d >= mon.toISOString().slice(0, 10) && d <= sun.toISOString().slice(0, 10);
    }
    case 'thisMonth': return d.slice(0, 7) === today.slice(0, 7);
    case 'lastMonth': {
      const lm = new Date(nowMyt); lm.setUTCDate(1); lm.setUTCMonth(lm.getUTCMonth() - 1);
      return d.slice(0, 7) === lm.toISOString().slice(0, 7);
    }
    default:          return false;
  }
};

/* Task #99 (UI perf) — Inner implementation, kept generic. Exported
   `DataGrid` below is the same function wrapped in React.memo so a parent
   re-render with unchanged props (rows, columns, etc.) skips the whole
   sort/filter/group recompute pipeline. Each list page now memoizes its
   `columns` array + handlers so the memo actually hits. */
function DataGridInner<T>({
  rows,
  columns,
  storageKey,
  rowKey,
  searchPlaceholder = 'Search…',
  loadedSearchCount,
  exportName,
  onRowDoubleClick,
  onRowClick,
  rowStyle,
  onSelectionChange,
  onFilteredRowsChange,
  toolbar,
  focusSearchNonce,
  collapseAllNonce,
  groupBanner = true,
  emptyMessage = 'No data.',
  isLoading = false,
  contextMenu,
  expandable,
  selectable,
  embedded = false,
  hideSearch = false,
  loadedSearchLimit,
  defaultSort,
  overlayHidden,
  onUserAdjustColumns,
  scrollToRow,
}: DataGridProps<T>) {
  /* HOUZS-style inline expansion (PR so-list-houzs-port). Tracks the set of
     expanded row ids; rendering inserts a colSpan sub-<tr> directly under
     each expanded parent. Stored as a Set so the chevron column accessor
     can read state in O(1). */
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const expansionId = expandable?.rowExpansionKey ?? rowKey;
  const toggleExpand = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);
  /* Per-company column layout (owner 2026-07-24 bug: "在 2990 sales order list
     点选 column 会影响我在 Houzs 的 column"). storageKey alone keyed every tenant's
     layout to ONE localStorage entry, so the 2990 and Houzs windows of the same
     grid trampled each other. Bucket by the tab's active company; when none is
     resolved (single-company Houzs default) the key is unchanged. Still
     per-user (localStorage) — never a shared server-side view. */
  const activeCompany = useSyncExternalStore(
    subscribeActiveCompany,
    getActiveCompanySnapshot,
    getActiveCompanySnapshot,
  );
  // EXCEPTION: shared cross-company queue boards stay UNscoped — per-company slots forked ONE board's layout (owner 2026-08-19 "keeps resetting"; doctrine on SHARED_DATA_GRID_STORAGE_KEYS). Their read-only seed is the CURRENT company's slot (reverse migration); a scoped grid's is the pre-scoping key. Primary owns writes.
  const sharedAcrossCompanies = isSharedDataGridStorageKey(storageKey);
  const scopedStorageKey = !sharedAcrossCompanies && activeCompany != null ? `${storageKey}::c${activeCompany}` : storageKey;
  const legacyStorageKey = activeCompany != null ? (sharedAcrossCompanies ? `${storageKey}::c${activeCompany}` : storageKey) : undefined;
  const [storedLayout, setLayoutRaw] = useCompanyScopedDataGridLayout(scopedStorageKey, legacyStorageKey);

  /* ── Account-level layouts (lib/tableLayouts.ts) ──────────────────────────
     The same store the DataTable lists use, so this grid gets the same two
     things: the COMPANY's default view (published by an admin from the drawer
     below) and the USER's own arrangement, hydrated into the very localStorage
     key read above so a machine they have never arranged still opens right.
     The 'dg:' prefix on the server key is what keeps the two grids' storage
     shapes apart on the way back down — see LayoutFamily in the store. */
  const layoutStore = useSyncExternalStore(
    subscribeTableLayouts,
    getTableLayoutsSnapshot,
    getTableLayoutsSnapshot,
  );
  const serverTableKey = useMemo(() => dataGridTableKey(storageKey), [storageKey]);

  /* The company default applies ONLY while nothing is stored locally — the same
     rule as DataTable: the first pref of any kind ends it for good, which is
     what lets an admin change a default without moving anyone's columns. Sort
     is never taken from a default; it is working state, not layout. */
  const companyDefault = useMemo(() => {
    const pristine =
      storedLayout.order.length === 0 &&
      storedLayout.hidden.length === 0 &&
      storedLayout.pinned.length === 0 &&
      storedLayout.groupBy.length === 0 &&
      Object.keys(storedLayout.widths).length === 0;
    if (!pristine) return null;
    const cid = layoutStore.activeCompanyId;
    if (cid == null) return null;
    return layoutStore.defaults[String(cid)]?.[serverTableKey] ?? null;
  }, [storedLayout, layoutStore, serverTableKey]);

  const layout = useMemo<Layout>(
    () =>
      companyDefault
        ? {
            order: companyDefault.order,
            hidden: companyDefault.hidden,
            widths: companyDefault.widths,
            pinned: companyDefault.pinned,
            groupBy: companyDefault.groupBy,
            sort: storedLayout.sort,
          }
        : storedLayout,
    [companyDefault, storedLayout],
  );

  /* Edits start from what is ON SCREEN, not from the empty stored value — so
     the first toggle on an inherited company default keeps the rest of that
     default instead of snapping back to the grid's own. Same "materialise
     before mutating" rule the pristine defaultHidden overlay already follows. */
  const effectiveLayoutRef = useRef(layout);
  effectiveLayoutRef.current = layout;
  const setLayout = useCallback((updater: (l: Layout) => Layout) => {
    setLayoutRaw((prev) => {
      const next = updater(effectiveLayoutRef.current ?? prev);
      writeDataGridLayout(scopedStorageKey, next);
      return next;
    });
  }, [scopedStorageKey]);

  /* Mirror this grid's layout to the account, debounced in the store. The MOUNT
     pass is skipped: opening a list must not create a saved layout for a table
     nobody arranged. What goes up is the STORED value, never the inherited
     company default — otherwise merely visiting a page would claim that default
     as the user's own and freeze them out of later changes to it. */
  const gridSyncRef = useRef<{ key: string; signature: string } | null>(null);
  useEffect(() => {
    const mine: StoredLayout = {
      ...EMPTY_LAYOUT,
      order: storedLayout.order,
      hidden: storedLayout.hidden,
      widths: storedLayout.widths,
      pinned: storedLayout.pinned,
      groupBy: storedLayout.groupBy,
    };
    const signature = serializeLayout(mine);
    const previous = gridSyncRef.current;
    gridSyncRef.current = { key: serverTableKey, signature };
    if (!previous || previous.key !== serverTableKey) return;
    if (previous.signature === signature) return;
    saveMyLayout(serverTableKey, mine);
  }, [storedLayout, serverTableKey]);

  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [ctx, setCtx] = useState<{ x: number; y: number; colKey: string } | null>(null);
  /** Right-click row menu — anchor point + the menu items resolved at open time. */
  const [rowCtx, setRowCtx] = useState<{ x: number; y: number; items: DataGridContextMenuItem[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [groupZoneActive, setGroupZoneActive] = useState(false);
  /* HOUZS-parity Columns popover — commander 2026-05-27: "为什么不是跟houzs的一样".
     The right-click header menu still works (backwards compat); this adds a
     discoverable toolbar button + popover with a per-column checkbox + Reset
     link, matching houzs-erp/src/pages/SalesOrderPage.tsx lines 576-624. */
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  /* The Columns popover is fixed-positioned (not absolute) so it escapes the
     grid card's `overflow: hidden`, which otherwise clips the dropdown when the
     card is short (few rows). Anchor it to the toolbar button's live rect. */
  const columnsBtnRef = useRef<HTMLDivElement>(null);
  /* Ref on the drawer panel (kept for element queries; the old scroll-to-close
     guard is gone — the drawer is non-modal, see the close effect below). */
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  /* Drag-to-reorder INSIDE the Columns drawer (unified column UX, owner
     2026-07-22): dragging a row writes the same layout.order the header drag
     writes, so the drawer and the header are two views of one order. */
  const [columnsMenuDragKey, setColumnsMenuDragKey] = useState<string | null>(null);
  const [columnsMenuOverKey, setColumnsMenuOverKey] = useState<string | null>(null);
  /* Per-column filters (Commander 2026-05-29): value sets, date presets,
     number ranges, custom date ranges; filterMenu anchors the open dropdown.
     PERSISTED per grid since 2026-08-19 (dataGridFilterStorage, keyed like the
     layout blob) — DataTable's funnels have been a saved view since 2026-07-29,
     while these cleared whenever opening a record replaced the workspace tab. */
  const [filters, setFilters] = useState<Record<string, string[]>>(() => readDataGridFilters(scopedStorageKey).values);
  const [dateFilters, setDateFilters] = useState<Record<string, DatePreset>>(() => readDataGridFilters(scopedStorageKey).dates as Record<string, DatePreset>);
  const [numberFilters, setNumberFilters] = useState<Record<string, { min?: number; max?: number }>>(() => readDataGridFilters(scopedStorageKey).numbers);
  const [dateRangeFilters, setDateRangeFilters] = useState<Record<string, { from?: string; to?: string }>>(() => readDataGridFilters(scopedStorageKey).dateRanges);
  useEffect(() => { writeDataGridFilters(scopedStorageKey, { values: filters, dates: dateFilters, numbers: numberFilters, dateRanges: dateRangeFilters }); }, [scopedStorageKey, filters, dateFilters, numberFilters, dateRangeFilters]);
  const [filterMenu, setFilterMenu] = useState<{ colKey: string; x: number; y: number } | null>(null);
  // Type-to-find text for `filterType: 'numbering'` (filters the value list).
  const [filterSearch, setFilterSearch] = useState('');
  /* Same inside-vs-outside scroll guard as the Columns popover — the filter
     dropdown has its own scrollable value list (maxHeight 320 / overflow auto). */
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Refocus search when parent bumps focusSearchNonce ("Find" button).
  useEffect(() => {
    if (focusSearchNonce != null) searchRef.current?.focus();
  }, [focusSearchNonce]);

  // Collapse every expanded drill-down when the parent bumps collapseAllNonce.
  useEffect(() => {
    if (collapseAllNonce != null) setExpandedRows(new Set());
  }, [collapseAllNonce]);

  // Close context menu on outside click.
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [ctx]);

  /* Close the row context menu on outside click, scroll, or Escape — same
     UX as the header context menu but rendered at a higher z-index so it
     clears the sticky <thead>. */
  useEffect(() => {
    if (!rowCtx) return;
    const close = () => setRowCtx(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [rowCtx]);

  /* The Columns drawer is NON-MODAL (owner 2026-07-22: the grid must stay
     fully interactive — including HORIZONTAL scroll — while the drawer is
     open, so reorder / show-hide changes land visibly live). So: no backdrop,
     no outside-click close, no scroll-close. It closes only via its ✕, the
     toolbar button toggle, or Escape — the same contract as the shared
     right-side <Panel/> the DataTable pages use. */
  useEffect(() => {
    if (!columnsMenuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setColumnsMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [columnsMenuOpen]);

  /* Close the per-column filter dropdown on outside click / Escape. */
  useEffect(() => {
    if (!filterMenu) return;
    const close = () => setFilterMenu(null);
    /* Same inside-scroll guard as the Columns menu: scrolling the filter
       dropdown's own list shouldn't dismiss it. */
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && filterMenuRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [filterMenu]);

  // Reset the numbering type-to-find when the open column changes / closes.
  useEffect(() => { setFilterSearch(''); }, [filterMenu?.colKey]);

  // Value a column reports for grouping/sorting (groupValue → searchValue → text).
  const colValue = useCallback((c: DataGridColumn<T>, row: T): string => {
    if (c.groupValue) return c.groupValue(row);
    if (c.searchValue) return c.searchValue(row);
    return coerceSearchString(c.accessor(row));
  }, []);

  // Clean value the per-column filter dropdown shows + matches on. Prefers the
  // value the operator sees in the cell (filterValue → groupValue → cell text)
  // and only falls back to searchValue — a broad multi-token blob — when the
  // cell is JSX with no clean value to offer, so the funnel is never blank.
  const filterColValue = useCallback((c: DataGridColumn<T>, row: T): string => {
    // Always coerce to a string — a column callback may hand back undefined/null
    // for some rows, and a non-string here can crash downstream string ops.
    if (c.filterValue) return String(c.filterValue(row) ?? '');
    if (c.groupValue) return String(c.groupValue(row) ?? '');
    const text = coerceSearchString(c.accessor(row));
    if (text) return text;
    return String((c.searchValue ? c.searchValue(row) : '') ?? '');
  }, []);

  const toggleFilterValue = useCallback((colKey: string, val: string) => {
    setFilters((prev) => {
      const cur = prev[colKey] ?? [];
      const next = cur.includes(val) ? cur.filter((v) => v !== val) : [...cur, val];
      const out = { ...prev };
      if (next.length === 0) delete out[colKey]; else out[colKey] = next;
      return out;
    });
  }, []);
  // Bulk select / invert for the per-column value checkbox list (Commander
  // 2026-06-18). `vals` is the column's full distinct-value list (filterValues).
  const selectAllFilterValues = useCallback((colKey: string, vals: string[]) => {
    setFilters((prev) => (vals.length === 0 ? prev : { ...prev, [colKey]: [...vals] }));
  }, []);
  const invertFilterValues = useCallback((colKey: string, vals: string[]) => {
    setFilters((prev) => {
      const cur = prev[colKey] ?? [];
      const next = vals.filter((v) => !cur.includes(v));
      const out = { ...prev };
      if (next.length === 0) delete out[colKey]; else out[colKey] = next;
      return out;
    });
  }, []);
  const clearFilter = useCallback((colKey: string) => {
    setFilters((prev) => { const o = { ...prev }; delete o[colKey]; return o; });
    setDateFilters((prev) => { const o = { ...prev }; delete o[colKey]; return o; });
    setNumberFilters((prev) => { const o = { ...prev }; delete o[colKey]; return o; });
    setDateRangeFilters((prev) => { const o = { ...prev }; delete o[colKey]; return o; });
  }, []);
  // Number-range bound setter — '' / NaN clears that bound; both empty drops the filter.
  const setNumberBound = useCallback((colKey: string, bound: 'min' | 'max', value: string) => {
    setNumberFilters((prev) => {
      const cur = { ...(prev[colKey] ?? {}) };
      if (value.trim() === '' || Number.isNaN(Number(value))) delete cur[bound];
      else cur[bound] = Number(value);
      const out = { ...prev };
      if (cur.min == null && cur.max == null) delete out[colKey]; else out[colKey] = cur;
      return out;
    });
  }, []);
  // Custom date-range bound setter — '' clears that bound; both empty drops the filter.
  const setDateBound = useCallback((colKey: string, bound: 'from' | 'to', value: string) => {
    setDateRangeFilters((prev) => {
      const cur = { ...(prev[colKey] ?? {}) };
      if (value === '') delete cur[bound];
      else cur[bound] = value;
      const out = { ...prev };
      if (!cur.from && !cur.to) delete out[colKey]; else out[colKey] = cur;
      return out;
    });
  }, []);
  // Date-preset toggle: clicking the active preset again clears it.
  const toggleDatePreset = useCallback((colKey: string, preset: DatePreset) => {
    setDateFilters((prev) => {
      const out = { ...prev };
      if (out[colKey] === preset) delete out[colKey]; else out[colKey] = preset;
      return out;
    });
  }, []);
  // One reset for every filter kind — shared by the toolbar "Clear filters"
  // pill and the chip row's "Clear all".
  const clearAllFilters = useCallback(() => {
    setFilters({});
    setDateFilters({});
    setNumberFilters({});
    setDateRangeFilters({});
  }, []);

  /* ── Active-filter chips (owner 2026-08-07: stacked multi-column filters
     must be VISIBLE and individually removable). Filters already AND across
     columns; the funnel highlight alone doesn't show WHICH columns are
     narrowing the list once two or three stack. One chip per active filter —
     column label + a short value summary + its own clear — rendered in a row
     under the toolbar only while at least one filter is active, so a grid with
     no filters set renders exactly as before. A column carrying both a date
     preset and a custom range yields two chips (they AND together, and each
     clears on its own). */
  const activeFilterChips = useMemo(() => {
    const labelOf = (k: string) => {
      const c = columns.find((cc) => cc.key === k);
      return c?.label || c?.exportLabel || k;
    };
    const chips: Array<{ id: string; label: string; summary: string; clear: () => void }> = [];
    for (const [k, vals] of Object.entries(filters)) {
      if (vals.length === 0) continue;
      chips.push({
        id: `values:${k}`,
        label: labelOf(k),
        summary: vals.length === 1 ? (vals[0] || '(blank)') : `${vals.length} values`,
        clear: () => setFilters((prev) => { const o = { ...prev }; delete o[k]; return o; }),
      });
    }
    for (const [k, preset] of Object.entries(dateFilters)) {
      chips.push({
        id: `preset:${k}`,
        label: labelOf(k),
        summary: DATE_PRESETS.find((p) => p.key === preset)?.label ?? preset,
        clear: () => setDateFilters((prev) => { const o = { ...prev }; delete o[k]; return o; }),
      });
    }
    for (const [k, range] of Object.entries(dateRangeFilters)) {
      chips.push({
        id: `range:${k}`,
        label: labelOf(k),
        summary: `${range.from ?? 'start'} - ${range.to ?? 'end'}`,
        clear: () => setDateRangeFilters((prev) => { const o = { ...prev }; delete o[k]; return o; }),
      });
    }
    for (const [k, range] of Object.entries(numberFilters)) {
      const parts: string[] = [];
      if (range.min != null) parts.push(`min ${range.min}`);
      if (range.max != null) parts.push(`max ${range.max}`);
      chips.push({
        id: `number:${k}`,
        label: labelOf(k),
        summary: parts.join(', '),
        clear: () => setNumberFilters((prev) => { const o = { ...prev }; delete o[k]; return o; }),
      });
    }
    return chips;
  }, [filters, dateFilters, dateRangeFilters, numberFilters, columns]);

  /* HOUZS-parity column show/hide actions for the Columns popover. Reset
     clears hidden + order + widths (preserving groupBy + sort so search
     state survives). toggleColumn flips a column's presence in `hidden`. */
  const resetColumns = useCallback(() => {
    onUserAdjustColumns?.();
    setLayout((l) => ({ ...l, hidden: [], order: [], widths: {} }));
    setColumnsMenuOpen(false);
  }, [setLayout, onUserAdjustColumns]);
  /* Shared materialisation of the pristine-defaults overlay (see
     materializeDataGridLayout) — every layout mutator below starts from it. */
  const materialize = useCallback((l: DataGridLayout) => materializeDataGridLayout(l, columns), [columns]);
  const toggleColumn = useCallback((colKey: string) => {
    onUserAdjustColumns?.();
    setLayout((raw) => {
      const l = materialize(raw);
      const hidden = l.hidden.includes(colKey)
        ? l.hidden.filter((k) => k !== colKey)
        : [...l.hidden, colKey];
      return { ...l, hidden };
    });
  }, [materialize, setLayout, onUserAdjustColumns]);
  /* "Show all" — every column visible. Materializes the order when the layout
     is still pristine: an empty order + empty hidden would put the layout back
     on the defaults overlay and instantly re-hide every defaultHidden column. */
  /* ── Layout section (shared with the DataTable drawer) ────────────────────
     One row per company that has a saved default for THIS grid, so a Houzs
     user can take 2990's view and back. There are no code-declared seeds here:
     these lists never had per-company column sets, so every row comes from
     something an admin actually saved. */
  const gridLayoutPresets = useMemo<LayoutPresetOption[] | undefined>(() => {
    const rows: LayoutPresetOption[] = [];
    const currentSignature = serializeLayout({
      ...EMPTY_LAYOUT,
      order: layout.order,
      hidden: layout.hidden,
      widths: layout.widths,
      pinned: layout.pinned,
      groupBy: layout.groupBy,
    });
    for (const co of layoutStore.companies) {
      const saved = layoutStore.defaults[String(co.id)]?.[serverTableKey];
      if (!saved) continue;
      rows.push({
        id: `company:${co.id}`,
        label: `${shortCompanyName(co.name)} Layout`,
        count: Math.max(0, columns.length - saved.hidden.length),
        isDefault: co.id === layoutStore.activeCompanyId,
        active: serializeLayout(saved) === currentSignature,
      });
    }
    /* The user's OWN saved layouts belong in this picker too — without them
       the grid could save a layout it then never offered back. */
    for (const saved of layoutStore.myLayouts[serverTableKey] ?? []) {
      rows.push({
        id: `saved:${saved.id}`,
        label: saved.name,
        hint: 'Saved by you',
        count: Math.max(0, columns.length - saved.layout.hidden.length),
        isDefault: false,
        active: serializeLayout(saved.layout) === currentSignature,
        savedId: saved.id,
      });
    }
    return rows.length > 0 ? withSingleActive(rows) : undefined;
  }, [layoutStore, serverTableKey, layout, columns.length]);

  const applyGridPreset = useCallback((id: string) => {
    const [kind, rawId] = id.split(':');
    const saved = kind === 'saved'
      ? layoutStore.myLayouts[serverTableKey]?.find((l) => l.id === Number(rawId))?.layout
      : layoutStore.defaults[String(Number(rawId))]?.[serverTableKey];
    if (!saved) return;
    onUserAdjustColumns?.();
    setLayout((l) => ({
      order: saved.order,
      hidden: saved.hidden,
      widths: saved.widths,
      pinned: saved.pinned,
      groupBy: saved.groupBy,
      // Picking a layout must not re-sort the list under the operator.
      sort: l.sort,
    }));
  }, [layoutStore, serverTableKey, setLayout, onUserAdjustColumns]);


  const showAllColumns = useCallback(() => {
    onUserAdjustColumns?.();
    setLayout((l) => ({
      ...l,
      hidden: [],
      order: l.order.length ? l.order : columns.map((c) => c.key),
    }));
  }, [columns, setLayout, onUserAdjustColumns]);

  // ── Resolve visible/ordered columns ───────────────────────────────
  // If `expandable` is set, prepend a synthetic 32px chevron column that
  // can't be reordered/hidden via the layout (filtered out of order /
  // hidden persistence on read). The accessor is built per-row inside
  // the tbody render so it can read expandedRows + call toggleExpand.
  /* HOUZS port — when the persisted layout is pristine (no order +
     no hidden customisations yet) apply `defaultHidden: true` from the
     column spec so the grid starts with Houzs's 19-of-25 / 34-of-44
     visible-by-default semantics. Once the user shows/hides anything,
     the persisted `hidden` array takes precedence and we stop overlaying
     defaults (their explicit choice wins). Lifted out of the visibleColumns
     memo so the Columns popover can read the same set without recomputing. */
  const effectiveHidden = useMemo(() => {
    const pristineLayout = layout.order.length === 0 && layout.hidden.length === 0;
    return pristineLayout
      ? new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key))
      : new Set(layout.hidden);
  }, [columns, layout.order, layout.hidden]);

  /* The FULL resolved column order — the user's saved order merged with the
     current column set. A column added AFTER the user last customised their
     layout isn't in `layout.order`; instead of dumping it at the far-right end
     (where it's easy to miss), splice it in at its DEFINITION position — right
     after its nearest preceding sibling from `columns` that's already in the
     order. So a newly-shipped column (e.g. the Delivery-Planning "Company"
     column) appears where the developer placed it, visible, without the user
     having to Reset layout. Shared by the table AND the Columns popover, so the
     popover lists rows (including hidden ones, in place) in on-grid order. */
  const resolvedOrder = useMemo(() => {
    const byKey = new Map(columns.map((c) => [c.key, c]));
    if (!layout.order.length) return columns.map((c) => c.key);
    const result = layout.order.filter((k) => byKey.has(k));
    const present = new Set(result);
    columns.forEach((c, idx) => {
      if (present.has(c.key)) return;
      let insertAt = 0;
      for (let j = idx - 1; j >= 0; j -= 1) {
        const pos = result.indexOf(columns[j]!.key);
        if (pos >= 0) { insertAt = pos + 1; break; }
      }
      result.splice(insertAt, 0, c.key);
      present.add(c.key);
    });
    return result;
  }, [columns, layout.order]);

  const [defaultSaveState, setDefaultSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  /* ── Drawer translation ──────────────────────────────────────────────────
     One row per real column (the synthetic chevron the `expandable` option
     prepends is not the operator's to hide), carrying what the shared drawer
     draws. Derived, so every gesture lands on this grid's own layout state. */
  const drawerColumns = useMemo<DrawerColumn[]>(
    () =>
      columns.map((c) => ({
        key: c.key,
        label: c.label || c.key,
        // Explicit beats inferred — same rule as the DataTable lists.
        group: c.group || inferColumnGroup(c.key, c.label || c.key) || "",
        visible: !effectiveHidden.has(c.key),
        width: layout.widths[c.key] ?? c.width ?? 140,
        /* This grid freezes to the LEFT only; the drawer's three-state cycle
           degrades to left ⇄ none here rather than offering a Right the grid
           would not honour. Bringing right-freeze to the vendored grid is its
           own change. */
        pinned: layout.pinned.includes(c.key) ? ('left' as const) : null,
      })),
    [columns, effectiveHidden, layout.widths, layout.pinned],
  );

  /** Move `key` into `targetKey`'s slot — the drawer's single reorder rule. */
  const reorderColumn = useCallback(
    (key: string, targetKey: string) => {
      setLayout((l) => {
        const order = (l.order.length ? l.order : columns.map((c) => c.key)).filter(
          (k) => k !== key,
        );
        const at = order.indexOf(targetKey);
        order.splice(at < 0 ? order.length : at, 0, key);
        return { ...l, order };
      });
    },
    [columns, setLayout],
  );

  const togglePinnedColumn = useCallback(
    (key: string) => {
      setLayout((l) => ({
        ...l,
        pinned: l.pinned.includes(key)
          ? l.pinned.filter((k) => k !== key)
          : [...l.pinned, key],
      }));
    },
    [setLayout],
  );

  /** What is ON SCREEN, materialised — for publishing and for saving a named
   *  layout. The stored value is the wrong source: inherit a company default,
   *  save it, and you would save nothing. */
  const gridRenderedLayout = useCallback(
    (): StoredLayout => ({
      ...EMPTY_LAYOUT,
      order: resolvedOrder,
      hidden: [...effectiveHidden],
      widths: layout.widths,
      pinned: layout.pinned,
      groupBy: layout.groupBy,
    }),
    [resolvedOrder, effectiveHidden, layout],
  );

  const saveGridLayout = useCallback(
    (name: string) => createNamedLayout(serverTableKey, name, gridRenderedLayout()).then(() => undefined),
    [serverTableKey, gridRenderedLayout],
  );
  const duplicateGridLayout = useCallback(
    (id: string, name: string) => {
      const source = gridLayoutPresets?.find((p) => p.id === id);
      const saved = source?.savedId != null
        ? layoutStore.myLayouts[serverTableKey]?.find((l) => l.id === source.savedId)?.layout
        : undefined;
      const fromCompany = source?.id.startsWith("company:")
        ? layoutStore.defaults[source.id.slice("company:".length)]?.[serverTableKey]
        : undefined;
      return createNamedLayout(
        serverTableKey,
        name,
        saved ?? fromCompany ?? gridRenderedLayout(),
      ).then(() => undefined);
    },
    [serverTableKey, gridLayoutPresets, layoutStore, gridRenderedLayout],
  );
  const renameGridLayout = useCallback(
    (id: string, name: string) => {
      const target = gridLayoutPresets?.find((p) => p.id === id);
      if (target?.savedId != null) return renameNamedLayout(serverTableKey, target.savedId, name);
      if (target?.id.startsWith("company:")) return renameCompanyDefault(serverTableKey, name);
      return Promise.resolve();
    },
    [serverTableKey, gridLayoutPresets],
  );
  const updateGridLayout = useCallback(
    (id: string) => {
      const target = gridLayoutPresets?.find((p) => p.id === id);
      if (target?.savedId != null) {
        return updateNamedLayout(serverTableKey, target.savedId, gridRenderedLayout());
      }
      if (target?.id.startsWith('company:')) {
        return saveCompanyDefault(serverTableKey, gridRenderedLayout());
      }
      return Promise.resolve();
    },
    [serverTableKey, gridLayoutPresets, gridRenderedLayout],
  );

  const deleteGridLayout = useCallback(
    (savedId: number) => deleteNamedLayout(serverTableKey, savedId),
    [serverTableKey],
  );

  const exportGridColumnConfig = useCallback(() => {
    const payload = {
      table: storageKey,
      exportedAt: new Date().toISOString(),
      columns: drawerColumns,
    };
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `columns-${storageKey}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Blob/URL unavailable — the menu item does nothing rather than throwing.
    }
  }, [storageKey, drawerColumns]);

  const gridDefaultManager = useMemo(() => {
    if (!layoutStore.ready || !layoutStore.canManageDefaults) return undefined;
    const cid = layoutStore.activeCompanyId;
    if (cid == null) return undefined;
    const company = layoutStore.companies.find((c) => c.id === cid);
    if (!company) return undefined;
    const publish = async (next: StoredLayout) => {
      setDefaultSaveState('saving');
      try {
        await saveCompanyDefault(serverTableKey, next);
        setDefaultSaveState('saved');
      } catch {
        setDefaultSaveState('error');
      }
    };
    return {
      companyLabel: shortCompanyName(company.name),
      hasSaved: Boolean(layoutStore.defaults[String(cid)]?.[serverTableKey]),
      state: defaultSaveState,
      /* Publishes what is ON SCREEN, materialised. The stored value is the
         wrong source: an admin happy with what they inherited has nothing
         stored, and saving that would publish an empty layout. */
      onSave: () =>
        void publish({
          ...EMPTY_LAYOUT,
          order: resolvedOrder,
          hidden: [...effectiveHidden],
          widths: layout.widths,
          pinned: layout.pinned,
          groupBy: layout.groupBy,
        }),
      onClear: () => void publish(EMPTY_LAYOUT),
    };
  }, [layoutStore, serverTableKey, defaultSaveState, resolvedOrder, effectiveHidden, layout]);

  const visibleColumns = useMemo(() => {
    const byKey = new Map(columns.map((c) => [c.key, c]));
    /* Render-time overlay (map narrowing) — hides ON TOP of the user's set,
       never written to the layout, so closing the map restores their prefs. */
    const overlay = overlayHidden && overlayHidden.length > 0 ? new Set(overlayHidden) : null;
    const base = resolvedOrder
      .filter((k) => !effectiveHidden.has(k) && !(overlay?.has(k) ?? false))
      .map((k) => byKey.get(k)!)
      .filter(Boolean);
    const synthetic: DataGridColumn<T>[] = [];
    /* Synthetic select column — checkbox rendered in a dedicated <td>/<th>. */
    if (selectable) {
      synthetic.push({
        key: '__select__', label: '', width: 30, minWidth: 30,
        sortable: false, groupable: false, accessor: () => null, searchValue: () => '',
      });
    }
    /* Synthetic chevron column — accessor is a placeholder; the actual chevron
       is rendered in a dedicated <td> in the tbody so it can wire click handlers
       without leaking `toggleExpand` into the column spec. */
    if (expandable) {
      synthetic.push({
        key: '__expand__', label: '', width: 32, minWidth: 32,
        sortable: false, groupable: false, accessor: () => null, searchValue: () => '',
      });
    }
    return synthetic.length ? [...synthetic, ...base] : base;
  }, [columns, resolvedOrder, effectiveHidden, expandable, selectable, overlayHidden]);

  // ── Filtered + sorted + grouped rows ──────────────────────────────
  /* Precompute one lowercased search blob per row (once per rows/columns
     change) so a keystroke is a single substring test instead of
     rows × columns work that re-builds each cell's search value (and, for
     JSX cells, constructs React nodes) on every character. */
  const searchBlobs = useMemo(() => {
    const m = new Map<T, string>();
    for (const row of rows) {
      let blob = '';
      for (const c of columns) {
        const sv = c.searchValue ? c.searchValue(row) : coerceSearchString(c.accessor(row));
        // Coerce defensively: a custom `searchValue` may return undefined/null or
        // a non-string for some rows — that must NEVER crash the whole grid (it
        // took the page down with "Cannot read properties of undefined (reading
        // 'toLowerCase')"). '\n' separator so adjacent columns can't form a false
        // cross-boundary match.
        blob += `${String(sv ?? '').toLowerCase()}\n`;
      }
      m.set(row, blob);
    }
    return m;
  }, [rows, columns]);

  /* Debounce the value that drives filtering (the input itself stays bound to
     `search`, so typing is instant) — keeps large lists responsive while
     typing. Separate from the autocomplete debounce elsewhere. */
  const debouncedSearch = useDebouncedValue(search, 150);

  const filteredRows = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const active = Object.entries(filters).filter(([, vals]) => vals.length > 0);
    const activeDates = Object.entries(dateFilters);
    const activeNumbers = Object.entries(numberFilters);
    const activeDateRanges = Object.entries(dateRangeFilters);
    if (!q && active.length === 0 && activeDates.length === 0
      && activeNumbers.length === 0 && activeDateRanges.length === 0) return rows;
    return rows.filter((row) => {
      if (q && !(searchBlobs.get(row) ?? '').includes(q)) return false;
      for (const [colKey, vals] of active) {
        const c = columns.find((cc) => cc.key === colKey);
        if (!c) continue;
        if (!vals.includes(filterColValue(c, row))) return false;
      }
      // Date-preset filters — match on the column's raw ISO dateValue (falls
      // back to the displayed value if a date column didn't supply one).
      for (const [colKey, preset] of activeDates) {
        const c = columns.find((cc) => cc.key === colKey);
        if (!c) continue;
        const iso = c.dateValue ? c.dateValue(row) : filterColValue(c, row);
        if (!dateMatchesPreset(iso, preset)) return false;
      }
      // Custom date range (from/to inclusive, ISO YYYY-MM-DD string compare).
      for (const [colKey, range] of activeDateRanges) {
        const c = columns.find((cc) => cc.key === colKey);
        if (!c) continue;
        const raw = c.dateValue ? c.dateValue(row) : filterColValue(c, row);
        const d = String(raw ?? '').slice(0, 10);
        if (!d) return false;
        if (range.from && d < range.from) return false;
        if (range.to && d > range.to) return false;
      }
      // Number range (min/max inclusive).
      for (const [colKey, range] of activeNumbers) {
        const c = columns.find((cc) => cc.key === colKey);
        if (!c) continue;
        const n = c.numberValue ? c.numberValue(row) : Number(filterColValue(c, row));
        if (n == null || Number.isNaN(n)) return false;
        if (range.min != null && n < range.min) return false;
        if (range.max != null && n > range.max) return false;
      }
      return true;
    });
  }, [rows, columns, debouncedSearch, filters, dateFilters, numberFilters, dateRangeFilters, filterColValue, searchBlobs]);

  // Distinct values for the currently-open filter dropdown.
  const filterValues = useMemo(() => {
    if (!filterMenu) return [];
    const c = columns.find((cc) => cc.key === filterMenu.colKey);
    if (!c) return [];
    const set = new Set<string>();
    for (const row of rows) set.add(filterColValue(c, row));
    return [...set].sort((a, b) => (a || '~').localeCompare(b || '~'));
  }, [filterMenu, columns, rows, filterColValue]);

  const sortedRows = useMemo(() => {
    /* No active column sort → the grid's default order: the caller's
       `defaultSort` comparator when provided (arrangement queues), otherwise
       the rows exactly as passed (every other grid, unchanged). */
    if (!layout.sort) return defaultSort ? [...filteredRows].sort(defaultSort) : filteredRows;
    const col = columns.find((c) => c.key === layout.sort!.key);
    if (!col) return defaultSort ? [...filteredRows].sort(defaultSort) : filteredRows;
    const cmp = col.sortFn ?? ((a: T, b: T) => {
      // Fall back to the column's group/search value when the cell is JSX
      // (accessor text is empty for a ReactNode) so columns without an
      // explicit sortFn — e.g. Doc No — still sort instead of silently no-op.
      const va = coerceSearchString(col.accessor(a)) || colValue(col, a);
      const vb = coerceSearchString(col.accessor(b)) || colValue(col, b);
      // numeric-aware
      const na = Number(va), nb = Number(vb);
      if (Number.isFinite(na) && Number.isFinite(nb) && va !== '' && vb !== '') return na - nb;
      return (va ?? '').localeCompare(vb ?? '');
    });
    const dir = layout.sort.dir === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => cmp(a, b) * dir);
  }, [filteredRows, columns, layout.sort, colValue, defaultSort]);

  // Selection callback when row changes.
  useEffect(() => {
    if (!onSelectionChange) return;
    if (selectedKey == null) { onSelectionChange([]); return; }
    const found = rows.find((r) => rowKey(r) === selectedKey);
    onSelectionChange(found ? [found] : []);
  }, [selectedKey, rows, rowKey, onSelectionChange]);

  /* Filtered-rows callback (Commander 2026-06-16) — hand the parent exactly the
     rows visible after search + column filters (post-sort), so a "Print all
     (filtered)" button prints what the operator sees with no row-ticking. */
  useEffect(() => {
    onFilteredRowsChange?.(sortedRows);
  }, [sortedRows, onFilteredRowsChange]);

  // ── Group rendering ───────────────────────────────────────────────
  // Multi-level groups produced as a flat list of render instructions.
  type Render =
    | { kind: 'group'; level: number; path: string; label: string; count: number; collapsed: boolean }
    | { kind: 'row'; row: T };

  const renderList: Render[] = useMemo(() => {
    if (layout.groupBy.length === 0) return sortedRows.map((row) => ({ kind: 'row' as const, row }));

    const out: Render[] = [];
    const groupKeys = layout.groupBy
      .map((k) => columns.find((c) => c.key === k))
      .filter((c): c is DataGridColumn<T> => Boolean(c));

    const buildGroupValue = (col: DataGridColumn<T>, row: T): string => {
      if (col.groupValue) return col.groupValue(row);
      return coerceSearchString(col.accessor(row)) || '(blank)';
    };

    // Tree-style traversal
    type Node = { value: string; rows: T[]; children: Map<string, Node> };
    const root: Node = { value: '', rows: [], children: new Map() };
    for (const row of sortedRows) {
      let node = root;
      for (const col of groupKeys) {
        const v = buildGroupValue(col, row);
        if (!node.children.has(v)) node.children.set(v, { value: v, rows: [], children: new Map() });
        node = node.children.get(v)!;
      }
      node.rows.push(row);
    }

    // Recursive row count — sum direct rows + all descendants
    const collectRows = (n: Node): T[] => {
      const acc: T[] = [...n.rows];
      for (const c of n.children.values()) acc.push(...collectRows(c));
      return acc;
    };

    const walk = (node: Node, level: number, parentPath: string) => {
      for (const child of node.children.values()) {
        const path = parentPath ? `${parentPath}${child.value}` : child.value;
        const totalRows = collectRows(child).length;
        const collapsed = collapsedGroups.has(path);
        out.push({ kind: 'group', level, path, label: `${groupKeys[level]?.label ?? ''}: ${child.value}`, count: totalRows, collapsed });
        if (!collapsed) {
          if (level + 1 < groupKeys.length) walk(child, level + 1, path);
          else for (const row of child.rows) out.push({ kind: 'row', row });
        }
      }
    };
    walk(root, 0, '');
    return out;
  }, [sortedRows, layout.groupBy, columns, collapsedGroups]);

  // ── Column DnD (reorder) ──────────────────────────────────────────
  const onDragStartHeader = (e: DragEvent<HTMLTableCellElement>, key: string) => {
    e.dataTransfer.setData('text/x-datagrid-col', key);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOverHeader = (e: DragEvent<HTMLTableCellElement>, key: string) => {
    e.preventDefault();
    setDropTarget(key);
  };
  const onDropHeader = (e: DragEvent<HTMLTableCellElement>, targetKey: string) => {
    e.preventDefault();
    setDropTarget(null);
    const sourceKey = e.dataTransfer.getData('text/x-datagrid-col');
    if (!sourceKey || sourceKey === targetKey) return;
    setLayout((l) => {
      /* Commander 2026-05-28: dragging a column left/right used to "invert"
         (it always inserted BEFORE the target, so a rightward drag landed on
         the wrong side). Fix: resolve the FULL current order first, then do a
         direction-aware move — drag right ⇒ land AFTER the target, drag left ⇒
         land BEFORE it. Inserting at the target's ORIGINAL index (after
         removing the source) yields exactly that in both directions. */
      const full = l.order.length
        ? [
            ...l.order.filter((k) => columns.some((c) => c.key === k)),
            ...columns.filter((c) => !l.order.includes(c.key)).map((c) => c.key),
          ]
        : columns.map((c) => c.key);
      const to = full.indexOf(targetKey);
      if (to === -1) return l;
      const next = full.filter((k) => k !== sourceKey);
      next.splice(to, 0, sourceKey);
      return { ...l, order: next };
    });
  };

  // ── Group-by drop zone ───────────────────────────────────────────
  const onGroupZoneDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setGroupZoneActive(true);
  };
  const onGroupZoneDragLeave = () => setGroupZoneActive(false);
  const onGroupZoneDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setGroupZoneActive(false);
    const sourceKey = e.dataTransfer.getData('text/x-datagrid-col');
    if (!sourceKey) return;
    const col = columns.find((c) => c.key === sourceKey);
    if (!col || col.groupable === false) return;
    setLayout((l) => l.groupBy.includes(sourceKey) ? l : { ...l, groupBy: [...l.groupBy, sourceKey] });
  };
  const removeGroup = (key: string) =>
    setLayout((l) => ({ ...l, groupBy: l.groupBy.filter((k) => k !== key) }));

  // ── Column resize ────────────────────────────────────────────────
  const resizingRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const onResizeStart = (e: MouseEvent<HTMLDivElement>, key: string, currentW: number) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { key, startX: e.clientX, startW: currentW };
    const onMove = (ev: globalThis.MouseEvent) => {
      const r = resizingRef.current; if (!r) return;
      const delta = ev.clientX - r.startX;
      const next = Math.max(40, r.startW + delta);
      setLayoutRaw((prev) => ({ ...prev, widths: { ...prev.widths, [r.key]: next } }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // persist final widths (company-scoped, same key the rest of the grid uses)
      setLayoutRaw((prev) => { writeDataGridLayout(scopedStorageKey, prev); return prev; });
      resizingRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Header context menu actions ──────────────────────────────────
  /* All three materialize first — see materialize, above. */
  const hideColumn = (key: string) => {
    onUserAdjustColumns?.();
    setLayout((raw) => { const l = materialize(raw);
      return { ...l, hidden: l.hidden.includes(key) ? l.hidden : [...l.hidden, key] }; });
  };
  const showColumn = (key: string) => {
    onUserAdjustColumns?.();
    setLayout((raw) => { const l = materialize(raw);
      return { ...l, hidden: l.hidden.filter((k) => k !== key) }; });
  };
  const pinLeft = (key: string) =>
    setLayout((raw) => {
      const l = materialize(raw); // pin = move to front of order
      const orderNow = (l.order.length ? l.order : columns.map((c) => c.key)).filter((k) => k !== key);
      orderNow.unshift(key);
      return { ...l, order: orderNow };
    });
  const autoFit = (key: string) => {
    // ~8.5px per character heuristic — good enough without measuring DOM.
    const col = columns.find((c) => c.key === key);
    if (!col) return;
    let max = col.label.length;
    for (const row of rows) {
      const s = coerceSearchString(col.accessor(row));
      if (s.length > max) max = s.length;
    }
    const w = Math.max(60, Math.min(420, Math.round(max * 7.5 + 20)));
    setLayout((l) => ({ ...l, widths: { ...l.widths, [key]: w } }));
  };
  /* (The one-click whole-layout reset left with the footer button, 2026-08-19 —
     column-layout resets live in the Columns drawer's Reset, like the SO list.) */

  /* ── Export to Excel (system-wide via DataGrid) ───────────────────────
     Exports exactly what the operator sees: the post-filter + post-search +
     post-sort `sortedRows`, across the visible DATA columns in their on-screen
     order (the synthetic __select__ / __expand__ columns are skipped). Cells
     render ReactNode, so we derive a text value per cell. xlsx is dynamic-
     imported (mirrors the jspdf generators) to keep it out of the main bundle. */
  const exportRows = useCallback(async () => {
    if (sortedRows.length === 0) return;
    const cols = visibleColumns.filter((c) => !c.key.startsWith('__'));
    if (cols.length === 0) return;
    const cellText = (c: DataGridColumn<T>, row: T): string | number => {
      // Export the CLEAN cell value — NOT the global-search blob. searchValue is
      // built for the search box and often concatenates several representations of
      // one cell (doc-no + status, phone, label + value); dumping it made every
      // cell look duplicated/merged ("SO-2606-031 CONFIRMED", "Installment
      // installment", doubled phone — Wei Siang 2026-06-20). Prefer exportValue,
      // then filterValue, then what the cell renders; searchValue is NEVER
      // exported. A DATE leaves as ISO — sheets sort text. See isoForExport.
      if (c.exportValue) return isoForExport(c.exportValue(row));
      if (c.filterValue) return isoForExport(c.filterValue(row));
      const rendered = coerceSearchString(c.accessor(row)).trim();
      if (rendered) return isoForExport(rendered);
      if (c.groupValue) return isoForExport(c.groupValue(row));
      return '';
    };
    // Header for a column in the sheet: an explicit exportLabel (used by pure
    // icon/checkbox columns whose on-screen label is blank) else the on-screen
    // label. Falls back to the column key so a blank header never leaves an
    // unnamed/duplicate-'' column in Excel (anchoring sync 2026-06-25).
    const header = (c: DataGridColumn<T>): string =>
      (c.exportLabel && c.exportLabel.trim()) || (c.label && c.label.trim()) || c.key;
    const data = sortedRows.map((row) => {
      const o: Record<string, string | number> = {};
      for (const c of cols) o[header(c)] = cellText(c, row);
      return o;
    });
    const XLSX = await import('../../../lib/xlsx-runtime');
    const ws = XLSX.utils.json_to_sheet(data, { header: cols.map((c) => header(c)) });
    // Auto-size each column to its widest cell (header included) so the sheet is
    // legible instead of squished into one default width (Wei Siang 2026-06-20
    // "很乱很难看"). Capped so a stray long value can't blow a column out.
    ws['!cols'] = cols.map((c) => {
      const h = header(c);
      let w = h.length;
      for (const o of data) w = Math.max(w, String(o[h] ?? '').length);
      return { wch: Math.min(60, Math.max(8, w + 2)) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    // Filename: prefer the caller's human exportName ("Purchase Orders"); else
    // clean the storageKey down to something legible (strip dg-/pr-g- prefixes,
    // -v1 / layout suffixes, dashes→spaces). A YYYY-MM-DD date is appended so
    // repeated exports are self-dating and don't silently overwrite.
    const stem = (exportName && exportName.trim())
      || (storageKey || 'export')
        .replace(/[:.]/g, '-')
        .replace(/-?v\d+$/i, '')
        .replace(/-?(grid|layout|columns|list|table|datagrid)$/i, '')
        .replace(/^(dg|pr-g)-/i, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      || `export-${sortedRows.length}`;
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFileXLSX(wb, `${stem} ${stamp}.xlsx`);
  }, [sortedRows, visibleColumns, storageKey, exportName]);

  // ── Sort handlers ─────────────────────────────────────────────────
  const toggleSort = (key: string) => {
    setLayout((l) => {
      if (!l.sort || l.sort.key !== key) return { ...l, sort: { key, dir: 'asc' } };
      if (l.sort.dir === 'asc') return { ...l, sort: { key, dir: 'desc' } };
      return { ...l, sort: null };
    });
  };

  // ── Group toggle ─────────────────────────────────────────────────
  const toggleGroup = (path: string) =>
    setCollapsedGroups((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });

  // ── Render ────────────────────────────────────────────────────────
  const totalCols = visibleColumns.length;
  const groupedCount = layout.groupBy.length;

  /* Windowed rendering for large FLAT lists only. Skipped when grouped, when
     the list is small, or while ≥1 row is actually expanded — an open expansion
     panel is variable-height and the virtualizer sizes every row uniformly, so
     its spacers would mis-reserve the scroll height.
     The gate keys off `expandedRows`, NOT off the `expandable` prop: a grid that
     merely OFFERS a chevron still renders uniform rows while collapsed, which is
     how it sits nearly all the time (Inventory Balances = ~1100 SKUs). Keying off
     the prop dropped every such grid to a full unwindowed render permanently. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const VIRTUAL_THRESHOLD = 25;
  const ROW_HEIGHT_ESTIMATE = 30;
  const canVirtualize = !isLoading && !embedded && groupedCount === 0 && expandedRows.size === 0 && renderList.length > VIRTUAL_THRESHOLD;
  /* Row height is measured off a real row rather than assumed (same reason as
     components/DataTable: assumed heights let the spacers drift). Here it also
     carries the expand/collapse flip: an exact height makes the windowed and the
     full render reserve identical scroll height, so toggling a chevron keeps
     scrollTop pointing at the same row instead of jumping. Measured once per
     mount — feeding a re-measure back into the spacers that position the row
     being measured can oscillate on subpixel rounding. */
  const rowHeightMeasured = useRef(false);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT_ESTIMATE);
  useLayoutEffect(() => {
    if (!canVirtualize || rowHeightMeasured.current) return;
    const h = tbodyRef.current?.querySelector<HTMLElement>('tr[data-vrow]')?.offsetHeight ?? 0;
    if (h > 0) { rowHeightMeasured.current = true; setRowHeight(h); }
  });
  const rowVirtualizer = useVirtualizer({
    count: canVirtualize ? renderList.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 14,
  });
  const virtualItems = canVirtualize ? rowVirtualizer.getVirtualItems() : [];
  const padTop = virtualItems.length ? virtualItems[0]!.start : 0;
  const padBottom = virtualItems.length
    ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
    : 0;

  /* Map pin → board row linkage (Option B, owner 2026-08-08): the parent bumps
     `scrollToRow.nonce` with a row key; the grid selects (the existing
     single-row highlight) and scrolls the row into view. Virtualized lists go
     through the virtualizer (the row may not be mounted); plain lists find the
     <tr> by its data-rowkey. A key not in the current view (filtered out /
     other tab) just highlights nothing — never a crash. */
  useEffect(() => {
    const target = scrollToRow;
    if (!target || !target.key) return;
    setSelectedKey(target.key);
    if (canVirtualize) {
      const idx = renderList.findIndex((it) => it.kind === 'row' && rowKey(it.row) === target.key);
      if (idx >= 0) rowVirtualizer.scrollToIndex(idx, { align: 'center' });
    } else {
      const el = tbodyRef.current?.querySelector(`tr[data-rowkey="${target.key.replace(/"/g, '\\"')}"]`);
      (el as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    // The nonce is the trigger — the same pin clicked twice must re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToRow?.nonce]);

  /* One grid row (group banner OR data row + optional expansion). Extracted so
     the normal path and the virtualized window render through the same code. */
  const renderGridRow = (item: Render, idx: number) => {
    if (item.kind === 'group') {
      return (
        <tr key={`g-${item.path}`} className={styles.groupRow} onClick={() => toggleGroup(item.path)}>
          <td className={styles.groupRowCell} colSpan={totalCols || 1} style={{ paddingLeft: 8 + item.level * 16 }}>
            <span className={styles.groupCaret}>{item.collapsed ? '>' : 'v'}</span>
            {item.label}
            <span className={styles.groupCount}>({item.count})</span>
          </td>
        </tr>
      );
    }
    const row = item.row;
    const key = rowKey(row);
    const expandKey = expandable ? expansionId(row) : null;
    const isExpanded = expandKey != null && expandedRows.has(expandKey);
    return (
      <Fragment key={`f-${key}-${idx}`}>
        <tr
          /* Marks a plain data row as the row-height measuring sample — group
             banners and the virtual spacers are deliberately not tagged. */
          data-vrow=""
          /* The scroll-to-row target (map pin → board linkage). */
          data-rowkey={key}
          className={`${styles.tr} ${selectedKey === key ? styles.trSelected : ''}`}
          style={{ ...(rowStyle?.(row)), ...((selectable || onRowClick || expandKey != null) ? { cursor: 'pointer' } : {}) }}
          /* Row-click = multi-select (Commander rule: "点行=multi-select"); L2
             drill-down opens ONLY via the left ▸ chevron (its own handler below,
             with stopPropagation). Row-click no longer expands. checkboxOnly
             (owner 2026-09-03) turns the toggle half off: the tick then lives
             in the checkbox cell alone. */
          onClick={() => { setSelectedKey(key); onRowClick?.(row); if (selectable && !selectable.checkboxOnly) selectable.onToggle(key); }}
          onDoubleClick={() => onRowDoubleClick?.(row)}
          onContextMenu={(e) => {
            if (!contextMenu) return;
            const items = contextMenu(row);
            if (!items || items.length === 0) return;
            e.preventDefault();
            setSelectedKey(key);
            setRowCtx({ x: e.clientX, y: e.clientY, items });
          }}
        >
          {visibleColumns.map((col) => {
            const w = layout.widths[col.key] ?? col.width ?? 140;
            if (col.key === '__select__' && selectable) {
              return (
                <td
                  key={col.key}
                  className={styles.td}
                  style={{ width: w, maxWidth: w, padding: '4px 6px', textAlign: 'center' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    aria-label="Select row"
                    checked={selectable.selectedKeys.has(key)}
                    disabled={selectable.isDisabled?.(key) ?? false}
                    onChange={() => selectable.onToggle(key)}
                    style={selectable.isDisabled?.(key) ? { cursor: 'not-allowed' } : undefined}
                  />
                </td>
              );
            }
            if (col.key === '__expand__' && expandable && expandKey) {
              return (
                <td
                  key={col.key}
                  className={styles.td}
                  style={{ width: w, maxWidth: w, padding: '4px 6px', textAlign: 'center' }}
                >
                  <button
                    type="button"
                    aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                    onClick={(e) => { e.stopPropagation(); toggleExpand(expandKey); }}
                    style={{
                      background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
                      color: 'var(--c-burnt)', fontSize: 12, lineHeight: 1,
                      display: 'inline-block',
                      transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform 120ms ease',
                    }}
                  >&#9656;</button>
                </td>
              );
            }
            /* Empty-cell standard (Commander 2026-06-18) — render an em-dash
               for a primitive-empty cell (null / undefined / '') so the whole
               system stops mixing blanks and dashes. 0 / false / JSX elements
               are preserved (a real 0 must show as 0); synthetic columns
               (__expand__ / __select__) render nothing, not a dash. */
            const content = col.accessor(row);
            const isEmpty = content == null || content === '';
            /* Cells clip (.td: overflow hidden + ellipsis) — surface the full
               value as a native tooltip so a cropped cell stays readable.
               Primitive cells only: JSX cells have no cheap text identity. */
            const tip =
              typeof content === 'string' || typeof content === 'number'
                ? String(content)
                : undefined;
            return (
              <td
                key={col.key}
                className={`${styles.td} ${col.align === 'right' ? styles.tdAlignRight : ''}`}
                style={{ width: w, maxWidth: w }}
                title={tip}
              >
                {isEmpty ? (col.key.startsWith('__') ? null : '—') : content}
              </td>
            );
          })}
        </tr>
        {isExpanded && expandable && (
          <tr className={styles.tr} style={{ background: 'var(--c-cream)' }}>
            <td colSpan={visibleColumns.length} style={{ padding: 0, borderTop: '1px solid var(--line)' }}>
              {expandable.renderExpansion(row)}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className={`${styles.root} ${embedded ? styles.rootEmbedded : ''}`}>
      {/* Toolbar — caller's actions + global search + Columns popover.
          Commander 2026-05-27 ("为什么不是跟houzs的一样"): Houzs surfaces
          column show/hide as a visible pill button. The right-click header
          menu is preserved (backwards compat — both write to layout.hidden). */}
      <div className={styles.toolbar}>
        {/* Search sits on the LEFT like the Sales Orders sample (owner
            2026-07-25: "search 要在左边白底"); caller actions follow, the
            spacer pushes clear-filters / Export / Columns to the right. */}
        {!embedded && !hideSearch && (
          <div className={styles.searchGroup}>
            <div className={styles.searchWrap}>
              <Search {...ICON} aria-hidden />
              <input
                ref={searchRef}
                className={styles.searchInput}
                type="search"
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className={styles.searchScope} data-search-scope>
              {loadedSearchLimit
                ? `Searches up to ${loadedSearchLimit.toLocaleString()} loaded rows only`
                : `Searches ${(loadedSearchCount ?? rows.length).toLocaleString()} loaded rows only`}
            </div>
          </div>
        )}
        {/* "Reset layout" — the EXACT button the Sales Orders list carries in
            this slot (owner 2026-08-19: "我要和Sales order一样的button和位置和
            design"): the shared ResetFiltersButton, which clears the grid's
            filters + search and hides itself while nothing is active. It
            replaced both this grid's right-side "Clear filters" pill and the
            old footer column-layout reset (column layout resets live in the
            Columns drawer, same as the SO list). */}
        {!embedded && (
          <ResetFiltersButton
            active={activeFilterChips.length > 0 || search.trim() !== ''}
            onReset={() => { clearAllFilters(); setSearch(''); }}
            label="Reset layout"
          />
        )}
        {/* SO-sample row/column caption AFTER the reset button (owner
            2026-08-19 position parity): "N rows · X of Y cols", numbers in
            ink, labels muted — same composition as the DataTable toolbar's.
            Data columns only (synthetic __expand__/__select__ are not
            user-facing columns). */}
        {!embedded && (
          <span className={styles.rowColCaption}>
            <span className={styles.rowColNum}>{filteredRows.length.toLocaleString()}</span>
            {` ${filteredRows.length === 1 ? 'row' : 'rows'} · `}
            <span className={styles.rowColNum}>
              {visibleColumns.filter((c) => !c.key.startsWith('__')).length}
            </span>
            {` of ${columns.length} cols`}
          </span>
        )}
        {toolbar}
        <div className={styles.toolbarSpacer} />
        {/* Export Excel — exports the currently visible rows (post search +
            filter + sort) across the visible data columns. System-wide: every
            list rendered through DataGrid gets it for free. Wei Siang 2026-06-19. */}
        <button
          type="button"
          className={styles.toolbarPill}
          onClick={() => { void exportRows(); }}
          disabled={sortedRows.length === 0}
          title={sortedRows.length === 0 ? 'No rows to export' : 'Export the visible rows to Excel'}
        >
          <Download size={13} strokeWidth={1.75} aria-hidden />
          {/* "Export", not "Export Excel" — the SO list's label (2026-08-19). */}
          <span>Export</span>
        </button>
        <div className={styles.columnsAnchor} ref={columnsBtnRef}>
          {/* The SAME ColumnsButton the DataTable toolbar renders (owner
              2026-08-19 button parity) — "Columns · N", not a N/M badge pill. */}
          <ColumnsButton
            visibleCount={visibleColumns.filter((c) => !c.key.startsWith('__')).length}
            totalCount={columns.length}
            active={columnsMenuOpen}
            onClick={() => setColumnsMenuOpen((v) => !v)}
          />
          {columnsMenuOpen && (
            /* ONE columns panel for the whole app (owner 2026-08-02: 需要应用到
               全系统 column panel). This grid used to carry its own drawer —
               a second set of column affordances, missing search, grouping,
               32px rows, the width chip and the mobile sheet. It now mounts the
               same ColumnsDrawer every DataTable list uses; everything below is
               translation between this grid's layout shape and the drawer's. */
            <ColumnsDrawer
              open
              onClose={() => setColumnsMenuOpen(false)}
              columns={drawerColumns}
              onToggle={toggleColumn}
              onReorder={reorderColumn}
              onTogglePin={togglePinnedColumn}
              onSetWidth={(key, px) =>
                setLayout((l) => ({ ...l, widths: { ...l.widths, [key]: px } }))
              }
              onShowAll={showAllColumns}
              onReset={resetColumns}
              layouts={gridLayoutPresets}
              onApplyLayout={applyGridPreset}
              onSaveLayout={layoutStore.canManageLayouts ? saveGridLayout : undefined}
              onDuplicateLayout={layoutStore.canManageLayouts ? duplicateGridLayout : undefined}
              onRenameLayout={layoutStore.canManageLayouts ? renameGridLayout : undefined}
              onDeleteLayout={layoutStore.canManageLayouts ? deleteGridLayout : undefined}
              onUpdateLayout={layoutStore.canManageLayouts ? updateGridLayout : undefined}
              defaultManager={gridDefaultManager}
              dirty={Boolean(gridLayoutPresets && !gridLayoutPresets.some((p) => p.active))}
              onExport={exportGridColumnConfig}
            />
          )}
        </div>
      </div>

      {/* Active-filter chips — the visible face of the AND-stack (see the
          activeFilterChips memo above). Absent while no filter is active, so
          every existing grid renders byte-identically until an operator
          actually stacks one. */}
      {activeFilterChips.length > 0 && (
        <div className={styles.filterBar} data-filter-bar>
          <span className={styles.filterBarLabel}>Filtered by</span>
          {activeFilterChips.map((chip) => (
            <span key={chip.id} className={styles.groupChip} title={`${chip.label}: ${chip.summary}`}>
              <span className={styles.filterChipCol}>{chip.label}</span>
              <span className={styles.filterChipVal}>{chip.summary}</span>
              <button
                type="button"
                className={styles.groupChipRemove}
                onClick={chip.clear}
                title={`Clear the ${chip.label} filter`}
                aria-label={`Clear the ${chip.label} filter`}
              >x</button>
            </span>
          ))}
          <button type="button" className={styles.filterBarClear} onClick={clearAllFilters}>
            Clear all
          </button>
        </div>
      )}

      {/* Group-by zone */}
      {groupBanner && (
        <div
          className={`${styles.groupZone} ${groupZoneActive ? styles.groupZoneActive : ''}`}
          onDragOver={onGroupZoneDragOver}
          onDragLeave={onGroupZoneDragLeave}
          onDrop={onGroupZoneDrop}
        >
          {groupedCount === 0 ? (
            <span>Drag a column header here to group by that column.</span>
          ) : (
            <>
              <span>Grouped by:</span>
              {layout.groupBy.map((k) => {
                const c = columns.find((cc) => cc.key === k);
                return (
                  <span key={k} className={styles.groupChip}>
                    {c?.label ?? k}
                    <button className={styles.groupChipRemove} onClick={() => removeGroup(k)} title="Remove group">x</button>
                  </span>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* Table */}
      <div ref={scrollRef} className={`${styles.scroll} ${embedded ? styles.scrollEmbedded : ''}`}>
        <table className={styles.table}>
          <thead className={`${styles.thead} ${embedded ? styles.theadEmbedded : ''}`}>
            <tr>
              {visibleColumns.map((col) => {
                const w = layout.widths[col.key] ?? col.width ?? 140;
                const style: CSSProperties = { width: w, minWidth: col.minWidth ?? 40 };
                const isSorted = layout.sort?.key === col.key;
                const arrow = isSorted ? (layout.sort!.dir === 'asc' ? 'A' : 'V') : '';
                if (col.key === '__select__' && selectable) {
                  /* The header checkbox acts on WHAT THE OPERATOR SEES — the
                     post-search, post-filter, post-sort rows — minus any row
                     the per-row veto has disabled. Ticking it must never reach
                     a row that is off-screen behind a search term. */
                  const keys = sortedRows.map(rowKey).filter((k) => !(selectable.isDisabled?.(k) ?? false));
                  const allSel = keys.length > 0 && keys.every((k) => selectable.selectedKeys.has(k));
                  const someSel = !allSel && keys.some((k) => selectable.selectedKeys.has(k));
                  return (
                    <th key={col.key} className={styles.th} style={style}>
                      <span className={styles.thInner}>
                        <input
                          type="checkbox"
                          aria-label="Select all rows"
                          checked={allSel}
                          ref={(el) => { if (el) el.indeterminate = someSel; }}
                          onChange={() => selectable.onToggleAll(keys, allSel)}
                        />
                      </span>
                    </th>
                  );
                }
                return (
                  <th
                    key={col.key}
                    className={`${styles.th} ${col.align === 'right' ? styles.thAlignRight : ''} ${dropTarget === col.key ? styles.thDragOver : ''}`}
                    style={style}
                    draggable
                    onDragStart={(e) => onDragStartHeader(e, col.key)}
                    onDragOver={(e) => onDragOverHeader(e, col.key)}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => onDropHeader(e, col.key)}
                    onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, colKey: col.key }); }}
                    title={col.label}
                  >
                    <span className={styles.thInner}>
                      {col.sortable !== false ? (
                        <button type="button" className={styles.sortBtn} onClick={(e) => { e.stopPropagation(); toggleSort(col.key); }}>
                          {col.label}
                          {/* SO-sample sort affordance: idle double chevron on
                              every sortable header, solid arrow when active
                              (the bare '^'/'v' text glyphs read as noise). */}
                          <span className={styles.sortArrow} style={arrow ? undefined : { color: '#767b6e' }}>
                            {arrow === 'A' ? <ArrowUp size={10} /> : arrow === 'V' ? <ArrowDown size={10} /> : <ChevronsUpDown size={10} />}
                          </span>
                        </button>
                      ) : col.label}
                      {/* Funnel on every DATA column. Synthetic columns
                          (__expand__ chevron, __select__ checkbox) carry no
                          filterable value — a funnel there is pure noise. */}
                      {!col.key.startsWith('__') && (
                        <button
                          type="button"
                          title="Filter this column"
                          aria-label={`Filter ${col.label}`}
                          onClick={(e) => { e.stopPropagation(); setFilterMenu({ colKey: col.key, x: e.clientX, y: e.clientY }); }}
                          style={{
                            background: 'transparent', border: 0, padding: '0 2px', marginLeft: 2,
                            cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
                            color: ((filters[col.key]?.length ?? 0) > 0 || dateFilters[col.key] || numberFilters[col.key] || dateRangeFilters[col.key]) ? 'var(--c-orange)' : 'var(--fg-soft, #9a9a9a)',
                          }}
                        >
                          <Filter size={11} strokeWidth={2} aria-hidden />
                        </button>
                      )}
                    </span>
                    <div
                      className={styles.resizeHandle}
                      onMouseDown={(e) => onResizeStart(e, col.key, w)}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={tbodyRef} className={styles.tbody}>
            {isLoading && <SkeletonRows cols={totalCols || 1} rows={12} />}
            {!isLoading && renderList.length === 0 && (
              <tr><td className={styles.empty} colSpan={totalCols || 1}>{emptyMessage}</td></tr>
            )}
            {/* Small / grouped lists, and any list with a row expanded: render every row. */}
            {!isLoading && !canVirtualize && renderList.map((item, idx) => renderGridRow(item, idx))}
            {/* Large flat lists: windowed — only the visible slice is in the DOM,
               with spacer rows reserving the scroll height above and below. */}
            {!isLoading && canVirtualize && (
              <>
                {padTop > 0 && (
                  <tr aria-hidden="true"><td colSpan={totalCols || 1} style={{ height: padTop, padding: 0, border: 0 }} /></tr>
                )}
                {virtualItems.map((vi) => renderGridRow(renderList[vi.index]!, vi.index))}
                {padBottom > 0 && (
                  <tr aria-hidden="true"><td colSpan={totalCols || 1} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Status / footer — hidden in embedded (drill-down) mode where the
          "N of M rows / Reset layout" line reads as heavy chrome. */}
      {!embedded && (
        <div className={styles.statusLine}>
          {/* Reset layout moved to the toolbar (2026-08-19) — the footer keeps
              only the row count, like the SO list's pagination line. */}
          <span>{isLoading ? 'Loading…' : `${filteredRows.length} of ${rows.length} rows`}</span>
        </div>
      )}

      {/* Context menu */}
      {ctx && (() => {
        const col = columns.find((c) => c.key === ctx.colKey);
        const hidden = layout.hidden.includes(ctx.colKey);
        const grouped = layout.groupBy.includes(ctx.colKey);
        return (
          <div className={styles.ctxMenu} style={{ top: ctx.y, left: ctx.x }} onClick={(e) => e.stopPropagation()}>
            <button className={styles.ctxItem} onClick={() => { hideColumn(ctx.colKey); setCtx(null); }}>Hide column</button>
            <button className={styles.ctxItem} onClick={() => { pinLeft(ctx.colKey); setCtx(null); }}>Pin left</button>
            <button className={styles.ctxItem} onClick={() => { autoFit(ctx.colKey); setCtx(null); }}>Auto-fit width</button>
            {col?.groupable !== false && (
              <button className={styles.ctxItem} onClick={() => {
                if (!grouped) setLayout((l) => ({ ...l, groupBy: [...l.groupBy, ctx.colKey] }));
                setCtx(null);
              }}>{grouped ? 'Already grouped' : 'Group by this column'}</button>
            )}
            {(() => {
              /* HOUZS port — surface BOTH explicitly hidden columns and
                 the pristine-default-hidden set so the user can reveal
                 the optional 10 columns Houzs ships hidden by default. */
              const pristine = layout.order.length === 0 && layout.hidden.length === 0;
              const hiddenKeys = pristine
                ? columns.filter((c) => c.defaultHidden).map((c) => c.key)
                : layout.hidden;
              if (hiddenKeys.length === 0) return null;
              return (
                <>
                  <div className={styles.ctxDivider} />
                  <div style={{ padding: '4px 10px', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)' }}>Hidden:</div>
                  {hiddenKeys.map((k) => {
                    const c = columns.find((cc) => cc.key === k);
                    return (
                      <button key={k} className={styles.ctxItem} onClick={() => { showColumn(k); setCtx(null); }}>
                        Show {c?.label ?? k}
                      </button>
                    );
                  })}
                </>
              );
            })()}
            {hidden && (
              <button className={styles.ctxItem} onClick={() => { showColumn(ctx.colKey); setCtx(null); }}>
                Show column
              </button>
            )}
          </div>
        );
      })()}

      {/* Per-column filter dropdown — pick which values to keep (Commander
          2026-05-29). Distinct values come from the column's groupValue /
          searchValue / text. */}
      {filterMenu && (() => {
        const col = columns.find((c) => c.key === filterMenu.colKey);
        const sel = filters[filterMenu.colKey] ?? [];
        const q = filterSearch.trim().toLowerCase();
        const visibleFilterValues = q ? filterValues.filter((v) => v.toLowerCase().includes(q)) : filterValues;
        return (
          <div
            ref={filterMenuRef}
            className={styles.ctxMenu}
            style={{ top: filterMenu.y, left: filterMenu.x, maxHeight: 320, overflowY: 'auto', minWidth: 200 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 10px', borderBottom: '1px solid var(--line)' }}>
              <strong style={{ fontSize: 'var(--fs-11)' }}>Filter: {col?.label}</strong>
              {(sel.length > 0 || dateFilters[filterMenu.colKey] || numberFilters[filterMenu.colKey] || dateRangeFilters[filterMenu.colKey]) && (
                <button type="button" onClick={() => clearFilter(filterMenu.colKey)}
                  style={{ background: 'transparent', border: 0, color: 'var(--c-orange)', cursor: 'pointer', fontSize: 'var(--fs-11)', fontWeight: 600 }}>
                  Clear
                </button>
              )}
            </div>
            {col?.filterType === 'number' ? (
              /* ── Number: min / max range ── */
              <div style={{ display: 'grid', gap: 8, padding: '10px' }}>
                <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                  Min
                  <input type="number" inputMode="decimal" placeholder="–"
                    value={numberFilters[filterMenu.colKey]?.min ?? ''}
                    onChange={(e) => setNumberBound(filterMenu.colKey, 'min', e.target.value)}
                    style={{ fontSize: 'var(--fs-12)', padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm, 6px)' }} />
                </label>
                <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                  Max
                  <input type="number" inputMode="decimal" placeholder="–"
                    value={numberFilters[filterMenu.colKey]?.max ?? ''}
                    onChange={(e) => setNumberBound(filterMenu.colKey, 'max', e.target.value)}
                    style={{ fontSize: 'var(--fs-12)', padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm, 6px)' }} />
                </label>
              </div>
            ) : col?.filterType === 'date' ? (
              /* ── Date: quick presets + custom from→to range ── */
              <div style={{ display: 'grid', gap: 8, padding: '8px 10px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {DATE_PRESETS.map((p) => {
                    const on = dateFilters[filterMenu.colKey] === p.key;
                    return (
                      <button key={p.key} type="button"
                        onClick={() => toggleDatePreset(filterMenu.colKey, p.key)}
                        style={{
                          fontSize: 'var(--fs-11)', fontWeight: 600, padding: '3px 9px',
                          borderRadius: '999px', cursor: 'pointer',
                          border: `1px solid ${on ? 'var(--c-orange)' : 'var(--line)'}`,
                          background: on ? 'var(--c-orange)' : 'var(--c-paper)',
                          color: on ? '#fff' : 'var(--c-ink)',
                        }}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                  From
                  <DateField fullWidth aria-label="From date"
                    value={dateRangeFilters[filterMenu.colKey]?.from ?? ''}
                    onChange={(iso) => setDateBound(filterMenu.colKey, 'from', iso)} />
                </label>
                <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                  To
                  <DateField fullWidth aria-label="To date"
                    value={dateRangeFilters[filterMenu.colKey]?.to ?? ''}
                    onChange={(iso) => setDateBound(filterMenu.colKey, 'to', iso)} />
                </label>
              </div>
            ) : (
              /* ── Numbering / enum / text: searchable value checkbox list. The
                 type-to-find box shows for 'numbering' and any long value list. */
              <>
                {(col?.filterType === 'numbering' || filterValues.length > 8) && (
                  <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--line)' }}>
                    <input type="search" value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)}
                      placeholder="Find…"
                      style={{ width: '100%', boxSizing: 'border-box', fontSize: 'var(--fs-12)', padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm, 6px)' }} />
                  </div>
                )}
                {visibleFilterValues.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, padding: '6px 10px', borderBottom: '1px solid var(--line)' }}>
                    <button type="button" onClick={() => selectAllFilterValues(filterMenu.colKey, visibleFilterValues)}
                      style={{ fontSize: 'var(--fs-11)', fontWeight: 600, padding: '3px 9px', borderRadius: '999px', cursor: 'pointer', border: '1px solid var(--line)', background: 'var(--c-paper)', color: 'var(--c-ink)' }}>
                      Select all
                    </button>
                    <button type="button" onClick={() => invertFilterValues(filterMenu.colKey, visibleFilterValues)}
                      style={{ fontSize: 'var(--fs-11)', fontWeight: 600, padding: '3px 9px', borderRadius: '999px', cursor: 'pointer', border: '1px solid var(--line)', background: 'var(--c-paper)', color: 'var(--c-ink)' }}>
                      Select invert
                    </button>
                  </div>
                )}
                {visibleFilterValues.length === 0 && (
                  <div style={{ padding: '6px 10px', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)' }}>No values.</div>
                )}
                {visibleFilterValues.map((v) => (
                  <label key={v} className={styles.ctxItem} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={sel.includes(v)} onChange={() => toggleFilterValue(filterMenu.colKey, v)} />
                    <span>{v || '(blank)'}</span>
                  </label>
                ))}
              </>
            )}
          </div>
        );
      })()}

      {/* Row context menu — opened on right-click via the row's onContextMenu.
          Rendered after the header ctx menu so its z-index naturally wins
          if both ever opened simultaneously. */}
      {rowCtx && (
        <div
          className={styles.contextMenu}
          style={{ top: rowCtx.y, left: rowCtx.x }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {rowCtx.items.map((it, i) => {
            if (it.divider) return <div key={`d-${i}`} className={styles.contextMenuDivider} />;
            return (
              <button
                key={`i-${i}-${it.label}`}
                className={`${styles.contextMenuItem} ${it.danger ? styles.contextMenuDanger : ''}`}
                onClick={() => {
                  // Close before firing — handlers may navigate or open
                  // dialogs, and we don't want a stale menu lingering.
                  setRowCtx(null);
                  it.onClick?.();
                }}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Task #99 (UI perf) — `memo` strips the generic parameter from the function
   type, so we cast back to the original signature. Behaviour identical;
   the only difference is the default shallow-prop bail out. Pages calling
   <DataGrid> MUST pass a stable `columns` reference (define at module
   scope or wrap in useMemo) for the memo to actually hit — see the
   listing pages where columns are already memoized. */
const DataGridMemo = memo(DataGridInner) as typeof DataGridInner;

/**
 * Hydration writes the account's saved layout into the very localStorage key
 * this grid reads ONCE, in its `useState` initialiser — that read-at-mount is
 * what makes the first paint correct. Remounting on the layout store's epoch is
 * how a grid already on screen when the boot fetch lands picks it up. The epoch
 * bumps at most once per session, and only when hydration actually moved
 * something, so this is a no-op on every warm load. (Mirrors DataTable.)
 */
export const DataGrid = (<T,>(props: DataGridProps<T>) => {
  const { epoch } = useSyncExternalStore(
    subscribeTableLayouts,
    getTableLayoutsSnapshot,
    getTableLayoutsSnapshot,
  );
  return <DataGridMemo<T> key={`layout-epoch:${epoch}`} {...props} />;
}) as typeof DataGridInner;
