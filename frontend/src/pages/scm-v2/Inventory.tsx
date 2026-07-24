// ----------------------------------------------------------------------------
// Inventory — AutoCount-style stock view (PR #38).
//
// 4 tabs:
//   1. Balances     — one row per SKU, Total Bal Qty + Main Supplier.
//                      Double-click row → per-warehouse breakdown drawer
//                      (Location | Qty | Unit Cost), like AutoCount's
//                      "Up To Date Cost" panel.
//   2. Movements    — append-only ledger (every GRN/DO/PR post)
//   3. COGS (FIFO)  — FIFO consumption stream
//   4. Warehouses   — CRUD for stock locations (merged from old /warehouses page)
//
// IN  events: GRN posted
// OUT events: DO dispatched, Purchase Return posted
// COGS auto-posted via DB trigger trg_inventory_movement_fifo (migration 0053).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Search, ArrowUpRight, ArrowDownLeft, DollarSign, Star, X, Plus,
  Warehouse as WarehouseIcon, ChevronRight, ChevronDown,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { SearchProgress } from '../../components/SearchProgress';
import { SearchScopeHint } from '../../components/SearchScopeHint';
import { useDebouncedSearchTerm, useSearchResultTransition } from '../../hooks/useServerSearch';
import { adjustmentReasonLabel, formatVariantKey, fmtCenti, fmtDate, fmtQty } from '@2990s/shared';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useWarehouses,
  useInventoryProductTotals,
  useInventoryProductBreakdown,
  useInventoryMovements,
  useInventoryLots,
  useInventoryBatches,
  useCogsEntries,
  useInventoryAnalytics,
  useInventoryReservations,
  useCreateWarehouse,
  useUpdateWarehouse,
  type CogsEntry,
  type InventoryBatch,
  type InventoryIncomingPo,
  type InventoryMovement,
  type InventoryProductTotal,
  type InventoryReservation,
  type Warehouse,
} from '../../vendor/scm/lib/inventory-queries';

/** Best-effort route for a movement's source doc. Mirrors StockCard's
 *  docHrefFor so every IN/OUT/ADJUSTMENT row on the Movements ledger can be
 *  clicked through to the document that drove it. ADJUSTMENT has no per-doc
 *  detail page — link to the list. */
const docHrefFor = (m: InventoryMovement): string | null => {
  switch (m.source_doc_type) {
    case 'GRN':              return m.source_doc_id ? `/scm/grns/${m.source_doc_id}` : null;
    case 'DO':               return m.source_doc_id ? `/mfg-delivery-orders/${m.source_doc_id}` : null;
    case 'DR':               return m.source_doc_id ? `/delivery-returns/${m.source_doc_id}` : null;
    case 'PURCHASE_RETURN':  return m.source_doc_id ? `/scm/purchase-returns/${m.source_doc_id}` : null;
    case 'STOCK_TRANSFER':   return m.source_doc_id ? `/scm/stock-transfers/${m.source_doc_id}` : null;
    case 'STOCK_TAKE':       return m.source_doc_id ? `/scm/stock-takes/${m.source_doc_id}` : null;
    case 'ADJUSTMENT':       return '/scm/stock-adjustments';
    default:                 return null;
  }
};
import styles from './Inventory.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const ICON_MD = { size: 16, strokeWidth: 1.75 } as const;

/* KPI tile grid — replaces the bespoke .statGrid (auto-fit minmax(220px)).
   Mirrors the SalesOrderDetailListing reskin: a plain Tailwind grid that
   holds the shared <StatCard>s, 2-up on a phone (the old 600px media rule). */
const STAT_GRID = 'grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4';

/* Same grid, capped at 3 columns for the 3-tile clusters. */
const STAT_GRID_3 = 'grid grid-cols-2 gap-3 md:grid-cols-3';

/* "Failed to load" banner — err tokens (was the bespoke .bannerWarn, whose
   colours only resolved via the removed .page cascade). */
const BANNER_ERR =
  'rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-[13px] text-err';

type Tab = 'balances' | 'batches' | 'reservations' | 'warehouses' | 'analytics';
type Category = 'all' | 'ACCESSORY' | 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'SERVICE';

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'ACCESSORY', label: 'Accessory' },
  { value: 'BEDFRAME',  label: 'Bedframe' },
  { value: 'SOFA',      label: 'Sofa' },
  { value: 'MATTRESS',  label: 'Mattress' },
  { value: 'SERVICE',   label: 'Service' },
];

const fmtRm = (sen: number | null | undefined): string => fmtCenti(sen);

/* Age of the stock — days since the oldest open FIFO lot was received
   (Commander 2026-05-29: "寿命" replaces Last Movement). */
const fmtAgeDays = (iso: string | null): string => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const d = Math.floor(ms / 86_400_000);
  return d === 0 ? 'today' : `${d}d`;
};

/* ETA display for an incoming PO line (date only). */
const fmtEta = (iso: string | null): string => {
  if (!iso) return 'no ETA';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return fmtDate(d);
};

/* One-per-line "PO-2606-001 · ETA 21/06/2026 · +6" summary, for the Incoming
   cell tooltip. The same list renders as the row drill (IncomingPoPanel). */
const incomingPoSummary = (pos: InventoryIncomingPo[]): string =>
  pos.length === 0
    ? '—'
    : pos.map((p) => `${p.po_number} · ETA ${fmtEta(p.eta)} · +${fmtQty(p.qty)}`).join('\n');

export const Inventory = () => {
  const [tab, setTab] = useState<Tab>('balances');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>('all');
  const [search, setSearch] = useState('');

  const warehouses = useWarehouses();
  const [breakdownFor, setBreakdownFor] = useState<{ code: string; name: string } | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Stock"
        title="Inventory"
        /* Owner 2026-07-24 (ask B) — the default brochure h1 (28px) read too big
           and, with the tab rail in the actions slot, pushed the header into
           overflow. `sm` is the owner-approved 17px document title. */
        titleSize="sm"
        actions={
          /* Tab rail — reskinned to the reference FilterPills slab. Rides in
             the header's actions slot, the same seat the bespoke .tabRow had
             inside the old sticky .headerRow (PageHeader is sticky too). */
          <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-surface p-1 shadow-stone [&>*]:shrink-0">
            {([
              { value: 'balances' as const, label: 'Balances' },
              { value: 'batches' as const, label: 'Batches' },
              { value: 'reservations' as const, label: 'Reservations' },
              { value: 'warehouses' as const, label: 'Warehouses' },
              { value: 'analytics' as const, label: 'Analytics' },
            ]).map((t) => (
              <button
                key={t.value}
                type="button"
                data-active={tab === t.value}
                onClick={() => setTab(t.value)}
                className={
                  tab === t.value
                    ? 'whitespace-nowrap rounded bg-primary px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white shadow-sm transition-all duration-150'
                    : 'whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-all duration-150 hover:bg-primary-soft hover:text-primary'
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />

      {/* Category chips — only for Balances tab */}
      {tab === 'balances' && (
        <div className={styles.warehouseChips}>
          {CATEGORIES.map((cat) => (
            <button key={cat.value} type="button" className={styles.chip}
              data-active={category === cat.value} onClick={() => setCategory(cat.value)}>
              {cat.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'balances' && (
        <>
          <div className={styles.filterRow}>
            {/* ask A (2026-07-24) — compact SEARCHABLE warehouse filter (was a
                big-card / chip rail). Scopes Stock / Incoming / Committed /
                Unscheduled to one warehouse. */}
            <WarehouseFilter
              warehouses={warehouses.data ?? []}
              value={warehouseId}
              onChange={setWarehouseId}
            />
            <div className={styles.searchBox} style={{ width: '100%' }}>
              <Search {...ICON} className={styles.searchIcon} />
              <input
                type="search"
                className={styles.searchInput}
                placeholder="Search code / description…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <BalancesTab category={category} search={search} warehouseId={warehouseId}
            onDrilldown={(code, name) => setBreakdownFor({ code, name })} />
        </>
      )}
      {tab === 'batches' && (
        <BatchesTab
          warehouseId={warehouseId}
          setWarehouseId={setWarehouseId}
          warehouses={warehouses.data ?? []}
          search={search}
          setSearch={setSearch}
        />
      )}
      {tab === 'reservations' && (
        <ReservationsTab
          warehouseId={warehouseId}
          setWarehouseId={setWarehouseId}
          warehouses={warehouses.data ?? []}
          search={search}
          setSearch={setSearch}
        />
      )}
      {tab === 'warehouses' && (
        <WarehousesTab />
      )}
      {tab === 'analytics' && (
        <AnalyticsTab warehouseId={warehouseId} />
      )}

      {breakdownFor && (
        <ProductBreakdownDrawer
          code={breakdownFor.code}
          name={breakdownFor.name}
          onClose={() => setBreakdownFor(null)}
        />
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   WarehouseFilter — compact SEARCHABLE single-select for the Balances view
   (ask A, owner 2026-07-24 "compact searchable dropdown, not big cards").
   Shows the warehouse SHORT code-name (`code`, e.g. "KL WAREHOUSE") as the
   label; the long `name` rides along as a muted sub-line inside the picker
   only. Click to open, type to filter in place, pick or "All warehouses".
   ════════════════════════════════════════════════════════════════════════ */
const WarehouseFilter = ({
  warehouses, value, onChange,
}: {
  warehouses: Warehouse[];
  value: string | null;
  onChange: (id: string | null) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = warehouses.find((w) => w.id === value) ?? null;
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? warehouses.filter((w) => w.code.toLowerCase().includes(ql) || (w.name ?? '').toLowerCase().includes(ql))
    : warehouses;
  const close = () => { setOpen(false); setQ(''); };
  return (
    <div className={styles.whFilter}>
      <button type="button" className={styles.whFilterButton} data-active={value !== null}
        onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <WarehouseIcon {...ICON} />
        <span className={styles.whFilterLabel}>{selected ? selected.code : 'All warehouses'}</span>
        <ChevronDown size={14} strokeWidth={1.75} />
      </button>
      {open && (
        <>
          <div className={styles.whFilterBackdrop} onClick={close} />
          <div className={styles.whFilterPanel} role="listbox">
            <input autoFocus className={styles.whFilterSearch} placeholder="Search warehouse…"
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') close(); }} />
            <div className={styles.whFilterList}>
              <button type="button" className={styles.whFilterOption} data-active={value === null}
                onClick={() => { onChange(null); close(); }}>
                All warehouses
              </button>
              {filtered.map((w) => (
                <button key={w.id} type="button" className={styles.whFilterOption} data-active={value === w.id}
                  onClick={() => { onChange(w.id); close(); }}>
                  <span className={styles.whFilterOptionCode}>{w.code}</span>
                  {w.name && w.name !== w.code && <span className={styles.whFilterOptionSub}>{w.name}</span>}
                </button>
              ))}
              {filtered.length === 0 && <div className={styles.whFilterEmpty}>No warehouse matches.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Analytics tab — read-only inventory KPI board: aging, turnover, dead stock,
   ABC. Computed server-side from open lots + COGS stream (GET /inventory/
   analytics). Wei Siang 2026-06-04.
   ════════════════════════════════════════════════════════════════════════ */
const WINDOWS = [30, 90, 180, 365];
const fmtDay = (iso: string | null): string => {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const AnalyticsTab = ({ warehouseId }: { warehouseId: string | null }) => {
  const [days, setDays] = useState(90);
  const { data, isLoading, error } = useInventoryAnalytics({ days, warehouseId });

  if (isLoading) return <div className={styles.emptyRow} style={{ padding: 'var(--space-6)' }}>Loading analytics…</div>;
  if (error || !data) return <div className={styles.emptyRow} style={{ padding: 'var(--space-6)' }}>Couldn't load analytics.</div>;

  const agingMax = Math.max(1, ...data.aging.map((b) => b.valueSen));
  const turns = data.turnover.annualizedTurns;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* Window selector */}
      <div className={styles.warehouseChips}>
        {WINDOWS.map((w) => (
          <button key={w} type="button" className={styles.chip}
            data-active={days === w} onClick={() => setDays(w)}>
            Last {w} days
          </button>
        ))}
      </div>

      {/* KPI cards — shared <StatCard> */}
      <div className={STAT_GRID}>
        <StatCard label="Inventory Value" value={fmtRm(data.totalValueSen)} />
        <StatCard label="Distinct SKUs in stock" value={fmtQty(data.distinctSkus)} />
        <StatCard label="Stock Turn (annualised)" value={turns > 0 ? `${turns.toFixed(1)}×` : '—'} />
        <StatCard
          label="Days of Stock on Hand"
          value={data.turnover.daysOnHand != null ? `${Math.round(data.turnover.daysOnHand)}d` : '—'}
        />
      </div>

      {/* Stock aging */}
      <p className={styles.eyebrow}>Stock Aging — by date received</p>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Age Bucket</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Value</th>
              <th style={{ width: '34%' }}>Share of value</th>
            </tr>
          </thead>
          <tbody>
            {data.aging.map((b) => (
              <tr key={b.key}>
                <td>{b.label}</td>
                <td className={`${styles.numCell} ${b.qty > 0 ? styles.numCellPos : styles.numCellZero}`}>{fmtQty(b.qty)}</td>
                <td className={styles.numCell} style={{ fontWeight: 700 }}>{b.valueSen > 0 ? fmtRm(b.valueSen) : '—'}</td>
                <td>
                  <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full bg-primary" style={{ width: `${(b.valueSen / agingMax) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ABC classification */}
      <p className={styles.eyebrow}>ABC Classification — by sales value over the window</p>
      <div className={STAT_GRID}>
        {(['A', 'B', 'C'] as const).map((cls) => (
          <StatCard
            key={cls}
            label={`Class ${cls} ${cls === 'A' ? '· top sellers' : cls === 'B' ? '· steady' : '· slow / idle'}`}
            value={data.abc.summary[cls].count}
            subtitle={`${fmtRm(data.abc.summary[cls].valueSen)} on hand`}
          />
        ))}
      </div>

      {/* Dead stock */}
      <p className={styles.eyebrow}>Dead Stock — has stock, no sale in {days} days</p>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Product</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Value</th>
              <th>Last Sold</th>
            </tr>
          </thead>
          <tbody>
            {data.deadStock.length === 0 && (
              <tr><td colSpan={4} className={styles.emptyRow}>No dead stock — every SKU in stock sold within {days} days.</td></tr>
            )}
            {data.deadStock.map((d) => (
              <tr key={d.product_code}>
                <td><span className={styles.codeChip}>{d.product_code}</span> {d.product_name}</td>
                <td className={`${styles.numCell} ${styles.numCellPos}`}>{fmtQty(d.qty)}</td>
                <td className={styles.numCell} style={{ fontWeight: 700 }}>{fmtRm(d.valueSen)}</td>
                <td className={styles.numCellZero}>{fmtDay(d.lastSoldAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Balances tab — AutoCount-style: one row per SKU + Total Qty + Main Supplier
   Double-click row → per-warehouse breakdown drawer
   ════════════════════════════════════════════════════════════════════════ */
const BalancesTab = ({
  category, search, warehouseId, onDrilldown,
}: {
  category: Category;
  search: string;
  warehouseId: string | null;
  onDrilldown: (code: string, name: string) => void;
}) => {
  const { requestTerm } = useDebouncedSearchTerm(search);
  const { data, isLoading, isFetching, isPlaceholderData, error } = useInventoryProductTotals({
    search: requestTerm.trim() || undefined,
    category: category === 'all' ? undefined : category,
    warehouseId: warehouseId ?? undefined,
  });
  const rows: InventoryProductTotal[] = useMemo(() => data ?? [], [data]);
  const searchTransition = useSearchResultTransition({
    inputTerm: search,
    requestTerm,
    isFetching,
    isPlaceholderData,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  // Category changes also change the query key. React Query deliberately keeps
  // the previous category as placeholderData, so treat that payload as stale
  // even when the search term itself did not change.
  const resultsAreStale = searchTransition.resultsAreStale || isPlaceholderData;
  const searching = searchTransition.isSearching || (isPlaceholderData && !error);
  const visibleRows = resultsAreStale ? [] : rows;

  const stats = useMemo(() => ({
    totalQty: visibleRows.reduce((s, r) => s + (r.total_qty ?? 0), 0),
    distinctSku: visibleRows.length,
    totalValue: visibleRows.reduce((s, r) => s + (r.total_value_sen ?? 0), 0),
  }), [visibleRows]);

  // `visibleRows` is deliberately EMPTY while a search/filter is in flight, so
  // these three aggregates are all 0 — and "Inventory Value RM 0.00" is a
  // sentence, not a spinner. Mark them unknown until the rows they summarise are
  // the rows actually on screen. An error is unknown too: the aggregate would
  // otherwise describe a list that failed to load.
  const statsPending = isLoading || searching || resultsAreStale || Boolean(error);

  return (
    <>
      <div className={STAT_GRID_3}>
        <StatCard label="Total Qty" value={fmtQty(stats.totalQty)} pending={statsPending} />
        <StatCard label="Distinct SKUs" value={stats.distinctSku} pending={statsPending} />
        <StatCard label="Inventory Value" value={fmtRm(stats.totalValue)} pending={statsPending} />
      </div>

      <p className={styles.eyebrow}>
        {isLoading || searching ? 'Loading…' : `${visibleRows.length} SKU rows · double-click a row to see per-warehouse breakdown`}
      </p>
      <SearchProgress active={searching} label={search.trim() ? searchTransition.statusText : 'Loading inventory…'} />
      <SearchScopeHint
        scope="server"
        searching={searching}
        countPending={isLoading || Boolean(error) || resultsAreStale}
        resultCount={visibleRows.length}
        term={search}
      />

      {error && !isLoading && (
        <div className={BANNER_ERR}>
          <strong className="font-semibold">Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <DataGrid<InventoryProductTotal>
        rows={visibleRows}
        columns={BALANCE_COLUMNS}
        storageKey="dg-inventory-balances"
        exportName="Inventory Balances"
        rowKey={(r) => r.product_code}
        searchPlaceholder="Search SKUs…"
        hideSearch
        groupBanner={false}
        isLoading={isLoading || searching}
        emptyMessage="No SKUs match the filters."
        onRowDoubleClick={(r) => onDrilldown(r.product_code, r.product_name)}
        rowStyle={() => ({ cursor: 'pointer' })}
        /* Variant drill (Commander 2026-05-29, ported to DataGrid.expandable):
           click a row / its chevron to expand the SKU into its attribute-
           composition buckets. Lazy: only fetches when expanded. Double-click
           still opens the per-warehouse breakdown drawer. */
        expandable={{
          renderExpansion: (r) => (
            <>
              <IncomingPoPanel pos={r.incoming_pos} />
              <SkuVariantPanel code={r.product_code} />
            </>
          ),
          rowExpansionKey: (r) => r.product_code,
        }}
      />
    </>
  );
};

/* DataGrid columns for the Balances tab — module scope so the grid's memo
   gets a stable reference. Mirrors the legacy <table> 1:1; the chevron the
   old markup hand-rolled is now DataGrid's synthetic expand column. */
const BALANCE_COLUMNS: DataGridColumn<InventoryProductTotal>[] = [
  {
    key: 'code',
    label: 'Product Code',
    width: 160,
    accessor: (r) => (
      <Link
        to={`/scm/inventory/stock-card/${encodeURIComponent(r.product_code)}`}
        className={styles.codeChip}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Open Stock Card"
        style={{ textDecoration: 'none' }}
      >
        {r.product_code}
      </Link>
    ),
    searchValue: (r) => r.product_code,
    filterValue: (r) => r.product_code,
    sortFn: (a, b) => (a.product_code ?? '').localeCompare(b.product_code ?? ''),
  },
  {
    key: 'desc',
    label: 'Description',
    width: 240,
    accessor: (r) => (
      <>
        {r.product_name}
        {r.branding && <span className={styles.numCellZero}> · {r.branding}</span>}
      </>
    ),
    searchValue: (r) => `${r.product_name} ${r.branding ?? ''}`,
    filterValue: (r) => r.product_name,
    sortFn: (a, b) => (a.product_name ?? '').localeCompare(b.product_name ?? ''),
  },
  {
    key: 'category',
    label: 'Category',
    width: 100,
    accessor: (r) => <span className={styles.numCellZero}>{r.category}</span>,
    searchValue: (r) => r.category,
    filterValue: (r) => r.category,
  },
  {
    key: 'stock',
    label: 'Stock',
    width: 80,
    align: 'right',
    accessor: (r) => {
      const qtyClass = r.total_qty > 0 ? styles.numCellPos
        : r.total_qty < 0 ? styles.numCellNeg
        : styles.numCellZero;
      return <span className={`${styles.numCell} ${qtyClass}`}>{fmtQty(r.total_qty)}</span>;
    },
    searchValue: (r) => String(r.total_qty),
    filterValue: (r) => String(r.total_qty),
    sortFn: (a, b) => a.total_qty - b.total_qty,
  },
  {
    key: 'incoming',
    label: 'Incoming',
    width: 100,
    align: 'right',
    // Owner 2026-07-24 — PO qty ARRIVING WITHIN ~30 days. The tooltip + the row
    // drill name WHICH PO(s) and their ETA (incoming_pos); the cell stays a
    // scannable "+N".
    accessor: (r) => (
      <span
        className={`${styles.numCell} ${r.incoming_qty > 0 ? styles.numCellPos : styles.numCellZero}`}
        title={r.incoming_qty > 0
          ? `Arriving within ~30 days:\n${incomingPoSummary(r.incoming_pos)}`
          : 'No PO arriving within ~30 days.'}
      >
        {r.incoming_qty > 0 ? `+${fmtQty(r.incoming_qty)}` : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.incoming_qty),
    sortFn: (a, b) => a.incoming_qty - b.incoming_qty,
  },
  {
    key: 'committed',
    label: 'Committed',
    width: 100,
    align: 'right',
    // Demand from open SO lines that HAVE a delivery date (scheduled to ship).
    accessor: (r) => (
      <span
        className={`${styles.numCell} ${r.committed_scheduled > 0 ? styles.numCellNeg : styles.numCellZero}`}
        title="Committed = open Sales-Order demand that has a delivery date (scheduled to ship). Delivered/cancelled lines are already netted out. This is subtracted from Stock + Incoming to give Available."
      >
        {r.committed_scheduled > 0 ? `−${fmtQty(r.committed_scheduled)}` : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.committed_scheduled),
    sortFn: (a, b) => a.committed_scheduled - b.committed_scheduled,
  },
  {
    key: 'available',
    label: 'Available',
    width: 100,
    align: 'right',
    // Available = Stock + Incoming − Committed (owner 2026-07-24 — Incoming is
    // now INCLUDED; the on-screen equation is spelled out in the tooltip).
    accessor: (r) => (
      <span
        className={`${styles.numCell} ${r.available_qty < 0 ? styles.numCellNeg : r.available_qty > 0 ? styles.numCellPos : styles.numCellZero}`}
        title={`${fmtQty(r.total_qty)} stock + ${fmtQty(r.incoming_qty)} incoming − ${fmtQty(r.committed_scheduled)} committed = ${fmtQty(r.available_qty)} available`}
      >
        {fmtQty(r.available_qty)}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.available_qty),
    sortFn: (a, b) => a.available_qty - b.available_qty,
  },
  {
    key: 'unscheduled',
    label: 'Unscheduled',
    width: 105,
    align: 'right',
    // Demand from open SO lines with NO delivery date (future / uncertain).
    accessor: (r) => (
      <span
        className={`${styles.numCell} ${r.unscheduled_qty > 0 ? '' : styles.numCellZero}`}
        title="Unscheduled = open Sales-Order demand with no delivery date yet (future / uncertain). Not subtracted from Available, but eats into Surplus."
      >
        {r.unscheduled_qty > 0 ? fmtQty(r.unscheduled_qty) : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.unscheduled_qty),
    sortFn: (a, b) => a.unscheduled_qty - b.unscheduled_qty,
  },
  {
    key: 'surplus',
    label: 'Surplus',
    width: 95,
    align: 'right',
    // Surplus = Available − Unscheduled. Negative = even undated demand can't be
    // met; positive = genuinely spare stock (dead-stock signal).
    accessor: (r) => (
      <span
        className={`${styles.numCell} ${r.surplus_qty < 0 ? styles.numCellNeg : r.surplus_qty > 0 ? styles.numCellPos : styles.numCellZero}`}
        title={`${fmtQty(r.available_qty)} available − ${fmtQty(r.unscheduled_qty)} unscheduled = ${fmtQty(r.surplus_qty)} surplus`}
      >
        {fmtQty(r.surplus_qty)}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.surplus_qty),
    sortFn: (a, b) => a.surplus_qty - b.surplus_qty,
  },
  {
    key: 'value',
    label: 'Value',
    width: 110,
    align: 'right',
    accessor: (r) => (
      <span className={`${styles.numCell} ${styles.numCellZero}`}>
        {r.total_value_sen > 0 ? fmtRm(r.total_value_sen) : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => r.total_value_sen > 0 ? fmtRm(r.total_value_sen) : '—',
    sortFn: (a, b) => a.total_value_sen - b.total_value_sen,
  },
  {
    key: 'unitCost',
    label: 'Unit Cost',
    width: 100,
    align: 'right',
    accessor: (r) => (
      <span className={`${styles.numCell} ${styles.numCellZero}`}>
        {r.total_qty > 0 && r.total_value_sen > 0 ? fmtRm(Math.round(r.total_value_sen / r.total_qty)) : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => r.total_qty > 0 && r.total_value_sen > 0 ? fmtRm(Math.round(r.total_value_sen / r.total_qty)) : '—',
    sortFn: (a, b) => {
      const ua = a.total_qty > 0 && a.total_value_sen > 0 ? a.total_value_sen / a.total_qty : 0;
      const ub = b.total_qty > 0 && b.total_value_sen > 0 ? b.total_value_sen / b.total_qty : 0;
      return ua - ub;
    },
  },
  {
    key: 'age',
    label: 'Age',
    width: 70,
    accessor: (r) => (
      <span className={styles.numCellZero} title={r.oldest_lot_at ?? undefined}>{fmtAgeDays(r.oldest_lot_at)}</span>
    ),
    searchValue: () => '',
    filterValue: (r) => fmtAgeDays(r.oldest_lot_at),
    /* Oldest lot first when ascending — null (no lots) sorts last. */
    sortFn: (a, b) => (a.oldest_lot_at ?? '9999-12-31').localeCompare(b.oldest_lot_at ?? '9999-12-31'),
  },
];

/* Incoming PO drill inside a Balances row expansion (owner 2026-07-24 — the
   Incoming column must name WHICH PO(s) bring the stock + their ETA, not just a
   count). Rendered above the variant panel; hidden when nothing is inbound. */
const IncomingPoPanel = ({ pos }: { pos: InventoryIncomingPo[] }) => {
  if (pos.length === 0) return null;
  return (
    <table className={`${styles.table} bg-surface-2`}>
      <tbody>
        {pos.map((p) => (
          <tr key={p.po_number}>
            <td style={{ paddingLeft: 22, width: 200 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className={styles.numCellZero}>↳ incoming</span>
                {/* PO number only (the detail route keys on the PO's UUID, which
                    this per-SKU roll-up doesn't carry) — shown as a code chip,
                    not a link, so it never routes to a broken page. */}
                <span className={styles.codeChip}>{p.po_number}</span>
              </span>
            </td>
            <td className={styles.numCellZero}>ETA {fmtEta(p.eta)}</td>
            <td className={`${styles.numCell} ${styles.numCellPos}`} style={{ width: 90, textAlign: 'right' }}>
              +{fmtQty(p.qty)}
            </td>
            <td />
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/* Variant breakdown panel inside a row's DataGrid expansion (was inline
   <tr>s pre-DataGrid). Sums each attribute composition (variant_key) across
   warehouses → one row per variant type, so the list shows "what variants
   this SKU has" without opening the drawer (Commander 2026-05-29). Lazy:
   only mounts (and fetches) when expanded. */
const SkuVariantPanel = ({ code }: { code: string }) => {
  const bd = useInventoryProductBreakdown(code);
  const balances = (bd.data?.balances ?? []).filter((b) => b.product_code === code);
  const variants = useMemo(() => {
    const m = new Map<string, { vk: string; sup: string | null; qty: number; value: number }>();
    for (const b of balances) {
      const vk = b.variant_key ?? '';
      const cur = m.get(vk) ?? { vk, sup: null, qty: 0, value: 0 };
      cur.qty += b.qty ?? 0;
      cur.value += b.value_sen ?? 0;
      // Same vk = same fabric = same supplier code — keep the first stamp seen.
      cur.sup = cur.sup ?? b.fabric_supplier_code ?? null;
      m.set(vk, cur);
    }
    return [...m.values()].sort((a, b) =>
      (formatVariantKey(a.vk) || 'Standard').localeCompare(formatVariantKey(b.vk) || 'Standard'));
  }, [balances]);

  if (bd.isLoading) {
    return <div className={styles.numCellZero} style={{ padding: '8px 16px' }}>Loading variants…</div>;
  }
  if (variants.length === 0) {
    return <div className={styles.numCellZero} style={{ padding: '8px 16px' }}>No stock buckets yet.</div>;
  }
  return (
    <table className={`${styles.table} bg-surface-2`}>
      <tbody>
        {variants.map((v) => {
          const qtyClass = v.qty > 0 ? styles.numCellPos : v.qty < 0 ? styles.numCellNeg : styles.numCellZero;
          return (
            <tr key={v.vk}>
              <td style={{ width: 280 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 22 }}>
                  <span className={styles.numCellZero}>↳</span>
                  <span>{formatVariantKey(v.vk, v.sup) || 'Standard'}</span>
                </span>
              </td>
              <td className={`${styles.numCell} ${qtyClass}`} style={{ width: 100, textAlign: 'right' }}>
                {fmtQty(v.qty)}
              </td>
              <td className={`${styles.numCell} ${styles.numCellZero}`} style={{ width: 130, textAlign: 'right' }}>
                {v.value > 0 ? fmtRm(v.value) : '—'}
              </td>
              <td />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Batches tab (Stage 4 — Commander 2026-05-31)
   ───────────────────────────────────────────────────────────────────────
   Sofa is colour-matched, produced as a SET on ONE PO = ONE dye lot = ONE
   batch (batch_no = source PO number). To ship a set with no colour diff the
   whole set must leave from ONE batch. This view shows, per warehouse, every
   open batch and the surviving component SKUs inside it — the raw material the
   allocator binds and the DO consumes from. Only produced-to-PO stock carries a
   batch; free / un-batched GRN stock never appears here (by design).
   ════════════════════════════════════════════════════════════════════════ */
const BatchesTab = ({
  warehouseId, setWarehouseId, warehouses, search, setSearch,
}: {
  warehouseId: string | null;
  setWarehouseId: (id: string | null) => void;
  warehouses: Warehouse[];
  search: string;
  setSearch: (s: string) => void;
}) => {
  const { data, isLoading, error } = useInventoryBatches({
    warehouseId: warehouseId ?? undefined,
  });
  const allBatches: InventoryBatch[] = useMemo(() => data ?? [], [data]);

  /* Client-side search across batch no / supplier / component code+name. */
  const q = search.trim().toLowerCase();
  const batches = useMemo(() => {
    if (!q) return allBatches;
    return allBatches.filter((b) =>
      b.batchNo.toLowerCase().includes(q) ||
      (b.supplierName ?? '').toLowerCase().includes(q) ||
      b.components.some((c) =>
        c.productCode.toLowerCase().includes(q) ||
        (c.productName ?? '').toLowerCase().includes(q)),
    );
  }, [allBatches, q]);

  const stats = useMemo(() => ({
    batchCount: batches.length,
    totalQty: batches.reduce((s, b) => s + b.totalRemaining, 0),
    skuCount: new Set(batches.flatMap((b) => b.components.map((c) => c.productCode))).size,
  }), [batches]);

  return (
    <>
      {/* Warehouse filter chips */}
      <div className={styles.warehouseChips}>
        <button type="button" className={styles.chip}
          data-active={warehouseId === null} onClick={() => setWarehouseId(null)}>
          All warehouses
        </button>
        {warehouses.map((w) => (
          <button key={w.id} type="button" className={styles.chip}
            data-active={warehouseId === w.id} onClick={() => setWarehouseId(w.id)}>
            {w.name}
          </button>
        ))}
      </div>

      <div className={styles.filterRow}>
        <div className={styles.searchBox} style={{ width: '100%' }}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search batch / PO / supplier / component…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <p className="text-[10px] text-ink-muted" data-search-scope>
        Searches batches assembled from up to 1,000 loaded lot rows only
        {q ? ` · ${batches.length.toLocaleString()} matches` : ''}
      </p>

      <div className={STAT_GRID_3}>
        <StatCard label="Open Batches" value={stats.batchCount} />
        <StatCard label="Modules On Hand" value={fmtQty(stats.totalQty)} />
        <StatCard label="Distinct SKUs" value={stats.skuCount} />
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${batches.length} open batch${batches.length === 1 ? '' : 'es'} · click a row to see component SKUs`}
      </p>

      {error && !isLoading && (
        <div className={BANNER_ERR}>
          <strong className="font-semibold">Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <DataGrid<InventoryBatch>
        rows={batches}
        columns={BATCH_COLUMNS}
        storageKey="dg-inventory-batches"
        exportName="Inventory Batches"
        rowKey={(b) => `${b.warehouseId}|${b.batchNo}`}
        searchPlaceholder="Search batches…"
        hideSearch
        groupBanner={false}
        isLoading={isLoading}
        emptyMessage={`No open batches${q ? ' match the search' : ''}.`}
        rowStyle={() => ({ cursor: 'pointer' })}
        /* Click a row / its chevron to expand the batch into its surviving
           component SKUs — same behavior as the legacy click-to-expand rows. */
        expandable={{
          renderExpansion: (b) => <BatchComponentsPanel batch={b} />,
          rowExpansionKey: (b) => `${b.warehouseId}|${b.batchNo}`,
        }}
      />
    </>
  );
};

/* DataGrid columns for the Batches tab — module scope for a stable
   reference. Chevron comes from DataGrid's synthetic expand column. */
const BATCH_COLUMNS: DataGridColumn<InventoryBatch>[] = [
  {
    key: 'batch',
    label: 'Batch / PO',
    width: 160,
    accessor: (b) => <span className={styles.codeChip}>{b.batchNo}</span>,
    /* Search must keep matching component SKUs inside the batch (legacy
       page-level search semantics). */
    searchValue: (b) =>
      `${b.batchNo} ${b.supplierName ?? ''} ${b.components.map((c) => `${c.productCode} ${c.productName ?? ''}`).join(' ')}`,
    filterValue: (b) => b.batchNo,
    sortFn: (a, b) => (a.batchNo ?? '').localeCompare(b.batchNo ?? ''),
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    width: 150,
    accessor: (b) => b.warehouseName ?? '—',
  },
  {
    key: 'supplier',
    label: 'Supplier',
    width: 170,
    accessor: (b) => b.supplierName ?? <span className={styles.numCellZero}>—</span>,
    searchValue: (b) => b.supplierName ?? '',
    filterValue: (b) => b.supplierName ?? '—',
  },
  {
    key: 'components',
    label: 'Components',
    width: 100,
    align: 'right',
    accessor: (b) => <span className={`${styles.numCell} ${styles.numCellZero}`}>{b.components.length}</span>,
    searchValue: () => '',
    filterValue: (b) => String(b.components.length),
    sortFn: (a, b) => a.components.length - b.components.length,
  },
  {
    key: 'modules',
    label: 'Modules',
    width: 90,
    align: 'right',
    accessor: (b) => (
      <span className={`${styles.numCell} ${b.totalRemaining > 0 ? styles.numCellPos : styles.numCellZero}`}>
        {fmtQty(b.totalRemaining)}
      </span>
    ),
    searchValue: () => '',
    filterValue: (b) => String(b.totalRemaining),
    sortFn: (a, b) => a.totalRemaining - b.totalRemaining,
  },
  {
    key: 'received',
    label: 'Received',
    width: 90,
    accessor: (b) => (
      <span className={styles.numCellZero} title={b.receivedAt ?? undefined}>{fmtAgeDays(b.receivedAt)}</span>
    ),
    searchValue: () => '',
    filterValue: (b) => fmtAgeDays(b.receivedAt),
    sortFn: (a, b) => (a.receivedAt ?? '9999-12-31').localeCompare(b.receivedAt ?? '9999-12-31'),
  },
];

/* Component SKUs inside a batch — rendered in the row's DataGrid expansion
   (was inline cream <tr>s pre-DataGrid). */
const BatchComponentsPanel = ({ batch }: { batch: InventoryBatch }) => (
  <table className={`${styles.table} bg-surface-2`}>
    <tbody>
      {batch.components.map((c) => (
        <tr key={`${c.productCode}|${c.variantKey ?? ''}`}>
          <td style={{ paddingLeft: 28, width: 190 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className={styles.numCellZero}>↳</span>
              <Link
                to={`/scm/inventory/stock-card/${encodeURIComponent(c.productCode)}`}
                className={styles.codeChip}
                onClick={(e) => e.stopPropagation()}
                title="Open Stock Card"
                style={{ textDecoration: 'none' }}
              >
                {c.productCode}
              </Link>
            </span>
          </td>
          <td>
            {c.productName ?? '—'}
            {c.variantKey && <span className={styles.numCellZero}> · {formatVariantKey(c.variantKey, c.fabric_supplier_code) || 'Standard'}</span>}
          </td>
          <td className={`${styles.numCell} ${styles.numCellZero}`} style={{ width: 110, textAlign: 'right' }}>
            {fmtRm(c.unitCostSen)}
          </td>
          <td className={`${styles.numCell} ${c.qtyRemaining > 0 ? styles.numCellPos : styles.numCellZero}`} style={{ width: 90, textAlign: 'right' }}>
            {fmtQty(c.qtyRemaining)}
          </td>
          <td className={styles.numCellZero} style={{ width: 90 }} title={c.receivedAt ?? undefined}>
            {fmtAgeDays(c.receivedAt)}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

/* ════════════════════════════════════════════════════════════════════════
   Reservations tab — reserved-but-unshipped visibility
   ───────────────────────────────────────────────────────────────────────
   Every OPEN FIFO lot (stock physically on the shelf) with the READY sales-
   order demand claiming it (GET /inventory/reservations). Answers the owner's
   question: for a lot sitting unshipped, which SO reserved it — vs which stock
   is free (no order). "Reserved since" is the reserving SO's created_at (no
   allocation timestamp exists — an honest proxy for the age of the claim).
   ════════════════════════════════════════════════════════════════════════ */
const ReservationsTab = ({
  warehouseId, setWarehouseId, warehouses, search, setSearch,
}: {
  warehouseId: string | null;
  setWarehouseId: (id: string | null) => void;
  warehouses: Warehouse[];
  search: string;
  setSearch: (s: string) => void;
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'RESERVED' | 'FREE'>('all');
  const { data, isLoading, error } = useInventoryReservations({
    warehouseId: warehouseId ?? undefined,
  });
  const all: InventoryReservation[] = useMemo(() => data ?? [], [data]);

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => all.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (!q) return true;
    return r.product_code.toLowerCase().includes(q) ||
      (r.product_name ?? '').toLowerCase().includes(q) ||
      (r.batch_no ?? '').toLowerCase().includes(q) ||
      r.reserved_by.some((x) => x.doc_no.toLowerCase().includes(q));
  }), [all, q, statusFilter]);

  const stats = useMemo(() => ({
    reservedQty: rows.filter((r) => r.status === 'RESERVED').reduce((s, r) => s + r.qty_remaining, 0),
    freeQty: rows.filter((r) => r.status === 'FREE').reduce((s, r) => s + r.qty_remaining, 0),
    lotCount: rows.length,
  }), [rows]);

  return (
    <>
      {/* Warehouse filter chips */}
      <div className={styles.warehouseChips}>
        <button type="button" className={styles.chip}
          data-active={warehouseId === null} onClick={() => setWarehouseId(null)}>
          All warehouses
        </button>
        {warehouses.map((w) => (
          <button key={w.id} type="button" className={styles.chip}
            data-active={warehouseId === w.id} onClick={() => setWarehouseId(w.id)}>
            {w.name}
          </button>
        ))}
      </div>

      <div className={STAT_GRID_3}>
        <StatCard label="Reserved (on shelf, claimed)" value={fmtQty(stats.reservedQty)} pending={isLoading} />
        <StatCard label="Free (no order)" value={fmtQty(stats.freeQty)} pending={isLoading} />
        <StatCard label="Open lots" value={stats.lotCount} pending={isLoading} />
      </div>

      <div className={styles.warehouseChips} style={{ marginTop: 'var(--space-3)' }}>
        {([
          { value: 'all' as const, label: 'All' },
          { value: 'RESERVED' as const, label: 'Reserved' },
          { value: 'FREE' as const, label: 'Free (no order)' },
        ]).map((f) => (
          <button key={f.value} type="button" className={styles.chip}
            data-active={statusFilter === f.value} onClick={() => setStatusFilter(f.value)}>
            {f.label}
          </button>
        ))}
      </div>

      <div className={styles.filterRow}>
        <div className={styles.searchBox} style={{ width: '100%' }}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search SKU / batch / SO doc no…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${rows.length} open lot${rows.length === 1 ? '' : 's'} · a RESERVED lot is claimed by a READY sales order; FREE stock has no order yet`}
      </p>

      {error && !isLoading && (
        <div className={BANNER_ERR}>
          <strong className="font-semibold">Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Product</th>
              <th>Warehouse</th>
              <th>Batch</th>
              <th style={{ textAlign: 'right' }}>Qty on Shelf</th>
              <th>Reserved For (SO)</th>
              <th>Reserved Since</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className={styles.emptyRow}>Loading…</td></tr>}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={7} className={styles.emptyRow}>No open lots match the filters.</td></tr>
            )}
            {!isLoading && rows.map((r, i) => (
              <tr key={`${r.warehouse_id}|${r.product_code}|${r.variant_key}|${r.batch_no ?? ''}|${i}`}>
                <td>
                  <span className={`${styles.movementPill} ${r.status === 'RESERVED' ? styles.movementOut : styles.movementIn}`}>
                    {r.status === 'RESERVED' ? 'Reserved' : 'Free'}
                  </span>
                </td>
                <td>
                  <div>
                    <Link
                      to={`/scm/inventory/stock-card/${encodeURIComponent(r.product_code)}`}
                      className={styles.codeChip}
                      style={{ textDecoration: 'none' }}
                    >
                      {r.product_code}
                    </Link>
                  </div>
                  <div className={styles.numCellZero} style={{ fontSize: 'var(--fs-11)' }}>
                    {r.product_name ?? '—'}
                    {r.variant_key ? ` · ${formatVariantKey(r.variant_key) || 'Standard'}` : ''}
                  </div>
                </td>
                <td>{r.warehouse_code ?? r.warehouse_name ?? '—'}</td>
                <td className={styles.numCellZero}>{r.batch_no ?? '—'}</td>
                <td className={`${styles.numCell} ${r.qty_remaining > 0 ? styles.numCellPos : styles.numCellZero}`}>
                  {fmtQty(r.qty_remaining)}
                </td>
                <td>
                  {r.reserved_by.length === 0
                    ? <span className={styles.numCellZero}>No order</span>
                    : r.reserved_by.map((x, j) => (
                        <span key={x.doc_no}>
                          {j > 0 ? ', ' : ''}
                          <Link to={`/scm/sales-orders/${encodeURIComponent(x.doc_no)}`} className={styles.docLink}>
                            {x.doc_no}
                          </Link>
                        </span>
                      ))}
                </td>
                <td className={styles.numCellZero} title={r.reserved_since ?? undefined}>
                  {r.reserved_since ? fmtAgeDays(r.reserved_since) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Product breakdown drawer — AutoCount-style "Up To Date Cost" panel:
   per-warehouse Location | Qty | Unit Cost  +  FIFO lots underneath
   ════════════════════════════════════════════════════════════════════════ */
const ProductBreakdownDrawer = ({
  code, name, onClose,
}: { code: string; name: string; onClose: () => void }) => {
  const breakdown = useInventoryProductBreakdown(code);
  const lots = useInventoryLots(code);
  const movements = useInventoryMovements({ productCode: code });
  const cogs = useCogsEntries({ productCode: code });
  const warehouses = useWarehouses();
  /* Item 4 (owner 2026-07-24) — which Sales Order(s) this SKU's stock is
     reserved to. Same company-scoped READY-SO ↔ open-lot matching the
     Reservations tab uses (GET /inventory/reservations), narrowed to this SKU. */
  const reservations = useInventoryReservations({ productCode: code });

  /* Movements + COGS sections are collapsed by default (Commander 2026-05-30).
     Operator opens what they want to see — keeps the drawer scannable. */
  const [movementsOpen, setMovementsOpen] = useState(false);
  const [cogsOpen, setCogsOpen] = useState(false);
  const [reservedOpen, setReservedOpen] = useState(false);

  /* Warehouse lookup (UUID → row). The tables below render the SHORT code-name
     (`code`, "KL WAREHOUSE"), the ONE canonical warehouse label the owner
     wants — never the long `name` ("BALAKONG WAREHOUSE") or a code+name concat. */
  const whById = useMemo(
    () => new Map((warehouses.data ?? []).map((w) => [w.id, w])),
    [warehouses.data],
  );

  /* Running-balance computation for Movements (same pattern as Stock Card):
     API returns DESC, reverse to ASC, accumulate signed qty, then render DESC.
     OUT subtracts, IN/ADJUSTMENT/TRANSFER add as-is (ADJUSTMENT carries a
     signed qty per inventory_movements convention). */
  const movementsWithBalance = useMemo(() => {
    const desc = movements.data ?? [];
    const asc = [...desc].reverse();
    let running = 0;
    const out: Array<typeof desc[number] & { runningBalance: number }> = [];
    for (const m of asc) {
      running += m.movement_type === 'OUT' ? -m.qty : m.qty;
      out.push({ ...m, runningBalance: running });
    }
    return out.reverse();
  }, [movements.data]);

  const balances = (breakdown.data?.balances ?? []).filter((b) => b.product_code === code);
  const totalQty = balances.reduce((s, b) => s + (b.qty ?? 0), 0);
  const totalVal = balances.reduce((s, b) => s + (b.value_sen ?? 0), 0);
  const breakdownPending = breakdown.data === undefined || Boolean(breakdown.error);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 50,
        display: 'flex', justifyContent: 'flex-end',
      }}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-[720px] max-w-[95vw] overflow-auto bg-bg p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-3">
          <div>
            <h2 className="font-display text-[17px] font-extrabold leading-tight tracking-tight text-ink">Stock Breakdown</h2>
            <p className="mt-1 text-[12px] text-ink-secondary">
              <span className={styles.codeChip}>{code}</span> {name}
            </p>
          </div>
          <button type="button" className={styles.chip} onClick={onClose}>
            <X {...ICON} />
            <span>Close</span>
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          {/* Both are reduces over `balances`, which is [] until the breakdown
              resolves — so the drawer would open on a confident "RM 0.00" for a
              SKU that may well hold stock. Unknown until it is known. */}
          <StatCard label="Total Qty" value={fmtQty(totalQty)} pending={breakdownPending} />
          <StatCard label="Total Value" value={fmtRm(totalVal)} pending={breakdownPending} />
        </div>

        {/* Per-warehouse × attribute-composition breakdown. One row per
            (warehouse, variant); identical attributes are already pooled, so
            this is the SKU split into its real stock buckets (migration 0095). */}
        <p className={styles.eyebrow} style={{ marginTop: 'var(--space-4)' }}>
          Stock by Warehouse &amp; Attributes
        </p>
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Location</th>
                <th>Attributes</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Avg Unit Cost</th>
                <th style={{ textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.isLoading && <tr><td colSpan={5} className={styles.emptyRow}>Loading…</td></tr>}
              {!breakdown.isLoading && balances.length === 0 && (
                <tr><td colSpan={5} className={styles.emptyRow}>No stock rows yet.</td></tr>
              )}
              {!breakdown.isLoading && balances.map((b) => {
                const avgCost = b.qty > 0 && b.value_sen ? b.value_sen / b.qty : 0;
                const attrs = formatVariantKey(b.variant_key, b.fabric_supplier_code);
                return (
                  <tr key={`${b.warehouse_id}|${b.variant_key ?? ''}`}>
                    {/* #1214 unified Location to warehouse_name (the LONG form,
                        "BALAKONG WAREHOUSE") while FIFO + Movements below show
                        warehouse_code (the SHORT code-name, "KL WAREHOUSE") —
                        two names for one warehouse. Owner wants the SHORT
                        code-name EVERYWHERE, so Location is now code-first too. */}
                    <td>{b.warehouse_code ?? b.warehouse_name ?? '—'}</td>
                    <td>{attrs || <span className={styles.numCellZero}>Standard</span>}</td>
                    <td className={`${styles.numCell} ${b.qty > 0 ? styles.numCellPos : styles.numCellZero}`}>
                      {fmtQty(b.qty)}
                    </td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>
                      {avgCost > 0 ? fmtRm(avgCost) : '—'}
                    </td>
                    <td className={styles.numCell} style={{ fontWeight: 700 }}>
                      {b.value_sen && b.value_sen > 0 ? fmtRm(b.value_sen) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* FIFO lots — oldest first */}
        <p className={styles.eyebrow} style={{ marginTop: 'var(--space-4)' }}>
          FIFO Lots (oldest first — these are consumed first on the next DO)
        </p>
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Received</th>
                <th>Warehouse</th>
                <th style={{ textAlign: 'right' }}>Qty Left</th>
                <th style={{ textAlign: 'right' }}>Unit Cost</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {lots.isLoading && <tr><td colSpan={5} className={styles.emptyRow}>Loading lots…</td></tr>}
              {!lots.isLoading && (lots.data ?? []).length === 0 && (
                <tr><td colSpan={5} className={styles.emptyRow}>No open lots.</td></tr>
              )}
              {(lots.data ?? []).map((l) => (
                <tr key={l.id}>
                  <td className={styles.numCellZero}>{fmtDateTime(l.received_at)}</td>
                  <td>{l.warehouse_code ?? '—'}</td>
                  <td className={`${styles.numCell} ${styles.numCellPos}`}>{fmtQty(l.qty_remaining)}</td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(l.unit_cost_sen)}</td>
                  <td className={styles.numCellZero}>{l.source_doc_no ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Reserved-for-SO — item 4. Which Sales Order(s) this SKU's stock is
            allocated to (so a lot sitting many days reads as spoken-for vs
            free). Collapsed by default; count in the header. */}
        <button type="button"
          onClick={() => setReservedOpen((v) => !v)}
          style={{
            marginTop: 'var(--space-4)', cursor: 'pointer', background: 'transparent',
            border: 'none', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
          <span className={styles.eyebrow} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {reservedOpen ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
            Reserved for Sales Orders ({(reservations.data ?? []).filter((r) => r.status === 'RESERVED').length}) — which SO holds this stock
          </span>
        </button>
        {reservedOpen && (
          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Warehouse</th>
                  <th>Batch</th>
                  <th style={{ textAlign: 'right' }}>Qty on Shelf</th>
                  <th>Reserved For (SO)</th>
                  <th>Reserved Since</th>
                </tr>
              </thead>
              <tbody>
                {reservations.isLoading && <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>}
                {!reservations.isLoading && (reservations.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className={styles.emptyRow}>No open lots for this SKU.</td></tr>
                )}
                {!reservations.isLoading && (reservations.data ?? []).map((r, i) => (
                  <tr key={`${r.warehouse_id}|${r.variant_key}|${r.batch_no ?? ''}|${i}`}>
                    <td>
                      <span className={`${styles.movementPill} ${r.status === 'RESERVED' ? styles.movementOut : styles.movementIn}`}>
                        {r.status === 'RESERVED' ? 'Reserved' : 'Free'}
                      </span>
                    </td>
                    {/* SHORT code-name, consistent with every other warehouse cell. */}
                    <td>{r.warehouse_code ?? r.warehouse_name ?? '—'}</td>
                    <td className={styles.numCellZero}>{r.batch_no ?? '—'}</td>
                    <td className={`${styles.numCell} ${r.qty_remaining > 0 ? styles.numCellPos : styles.numCellZero}`}>
                      {fmtQty(r.qty_remaining)}
                    </td>
                    <td>
                      {r.reserved_by.length === 0
                        ? <span className={styles.numCellZero}>No order</span>
                        : r.reserved_by.map((x, j) => (
                            <span key={x.doc_no}>
                              {j > 0 ? ', ' : ''}
                              <Link to={`/scm/sales-orders/${encodeURIComponent(x.doc_no)}`} className={styles.docLink}>
                                {x.doc_no}
                              </Link>
                            </span>
                          ))}
                    </td>
                    <td className={styles.numCellZero} title={r.reserved_since ?? undefined}>
                      {r.reserved_since ? fmtAgeDays(r.reserved_since) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Movements ledger — collapsed by default. Header is a button. */}
        <button type="button"
          onClick={() => setMovementsOpen((v) => !v)}
          style={{
            marginTop: 'var(--space-4)', cursor: 'pointer', background: 'transparent',
            border: 'none', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
          <span className={styles.eyebrow} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {movementsOpen ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
            Movements ({(movements.data ?? []).length}) — every stock change for this SKU
          </span>
        </button>
        {movementsOpen && (
          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Warehouse</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Running</th>
                  <th>Source Doc</th>
                  <th>Reason</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {movements.isLoading && <tr><td colSpan={8} className={styles.emptyRow}>Loading…</td></tr>}
                {!movements.isLoading && movementsWithBalance.length === 0 && (
                  <tr><td colSpan={8} className={styles.emptyRow}>No movements yet for this SKU.</td></tr>
                )}
                {movementsWithBalance.map((m) => {
                  const href = docHrefFor(m);
                  const qtySign = m.movement_type === 'IN' ? '+' : m.movement_type === 'OUT' ? '−' : (m.qty > 0 ? '+' : m.qty < 0 ? '−' : '');
                  const qtyClass = m.qty > 0 ? styles.numCellPos : m.qty < 0 ? styles.numCellNeg : styles.numCellZero;
                  const wh = m.warehouse_id ? whById.get(m.warehouse_id) : null;
                  return (
                    <tr key={m.id}>
                      <td className={styles.numCellZero}>{fmtDateTime(m.created_at)}</td>
                      <td>
                        <span className={`${styles.movementPill} ${
                          m.movement_type === 'IN' ? styles.movementIn
                          : m.movement_type === 'OUT' ? styles.movementOut
                          : styles.movementAdj}`}>{m.movement_type}</span>
                      </td>
                      <td>{wh ? wh.code : (m.warehouse_id ? '—' : '—')}</td>
                      <td className={`${styles.numCell} ${qtyClass}`}>{qtySign}{fmtQty(Math.abs(m.qty))}</td>
                      <td className={`${styles.numCell}`} style={{ fontWeight: 700 }}>
                        {fmtQty(m.runningBalance)}
                      </td>
                      <td>
                        {m.source_doc_no ? (
                          href
                            ? <Link to={href} className={styles.docLink}>{m.source_doc_no}</Link>
                            : <span className={styles.docLink}>{m.source_doc_no}</span>
                        ) : <span className={styles.numCellZero}>—</span>}
                      </td>
                      <td className={styles.numCellZero}>
                        {m.reason_code ? adjustmentReasonLabel(m.reason_code) : '—'}
                      </td>
                      <td className={`${styles.numCellZero} ${styles.notesCell}`} title={m.notes ?? ''}>{m.notes ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* COGS — collapsed by default. */}
        <button type="button"
          onClick={() => setCogsOpen((v) => !v)}
          style={{
            marginTop: 'var(--space-4)', cursor: 'pointer', background: 'transparent',
            border: 'none', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
          <span className={styles.eyebrow} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {cogsOpen ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
            COGS ({(cogs.data ?? []).length}) — FIFO consumptions for this SKU
          </span>
        </button>
        {cogsOpen && (
          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Consumed at</th>
                  <th>Source Doc</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Unit Cost</th>
                  <th style={{ textAlign: 'right' }}>Total Cost</th>
                  <th>From Lot</th>
                </tr>
              </thead>
              <tbody>
                {cogs.isLoading && <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>}
                {!cogs.isLoading && (cogs.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className={styles.emptyRow}>No COGS entries yet for this SKU.</td></tr>
                )}
                {(cogs.data ?? []).map((c) => (
                  <tr key={c.id}>
                    <td className={styles.numCellZero}>{fmtDateTime(c.consumed_at)}</td>
                    <td><span className={styles.docLink}>{c.source_doc_no ?? '—'}</span></td>
                    <td className={`${styles.numCell} ${styles.numCellNeg}`}>−{fmtQty(c.qty_consumed)}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(c.unit_cost_sen)}</td>
                    <td className={styles.numCell} style={{ fontWeight: 700 }}>{fmtRm(c.total_cost_sen)}</td>
                    <td className={styles.numCellZero}>{c.lot_source_doc_no ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Movements tab
   ════════════════════════════════════════════════════════════════════════ */
const MovementsTab = ({
  warehouseId, search, warehouses,
}: {
  warehouseId: string | null;
  search: string;
  warehouses: Array<{ id: string; code: string; name: string }>;
}) => {
  const [docType, setDocType] = useState<string | null>(null);
  const { data, isLoading, error } = useInventoryMovements({
    warehouseId: warehouseId ?? undefined,
    productCode: search.trim() || undefined,
    docType: docType ?? undefined,
  });
  const movements = data ?? [];
  const wmap = useMemo(() => new Map(warehouses.map((w) => [w.id, w])), [warehouses]);

  const DOC_TYPES = [
    { value: null,                label: 'All' },
    { value: 'GRN',               label: 'GRN (IN)' },
    { value: 'DO',                label: 'DO (OUT)' },
    { value: 'DR',                label: 'DR (IN)' },
    { value: 'PURCHASE_RETURN',   label: 'PR (OUT)' },
    { value: 'STOCK_TRANSFER',    label: 'Transfer' },
    { value: 'STOCK_TAKE',        label: 'Stock Take' },
    { value: 'ADJUSTMENT',        label: 'Adjustment' },
  ];

  return (
    <>
      <div className={styles.warehouseChips}>
        {DOC_TYPES.map((t) => (
          <button key={t.value ?? 'all'} type="button" className={styles.chip}
            data-active={docType === t.value}
            onClick={() => setDocType(t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${movements.length} movements (latest first)`}
      </p>

      {error && !isLoading && (
        <div className={BANNER_ERR}>
          <strong className="font-semibold">Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Warehouse</th>
              <th>Product</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Unit Cost</th>
              <th style={{ textAlign: 'right' }}>Line Cost</th>
              <th>Source Doc</th>
              <th>Reason</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={10} className={styles.emptyRow}>Loading…</td></tr>
            )}
            {!isLoading && movements.length === 0 && (
              <tr><td colSpan={10} className={styles.emptyRow}>No movements match the filters.</td></tr>
            )}
            {!isLoading && movements.map((m) => {
              const w = wmap.get(m.warehouse_id);
              return (
                <tr key={m.id}>
                  <td className={styles.numCellZero}>{fmtDateTime(m.created_at)}</td>
                  <td>
                    <span className={`${styles.movementPill} ${
                      m.movement_type === 'IN' ? styles.movementIn
                      : m.movement_type === 'OUT' ? styles.movementOut
                      : styles.movementAdj}`}>
                      {m.movement_type === 'IN' && <ArrowDownLeft size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                      {m.movement_type === 'OUT' && <ArrowUpRight size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                      {m.movement_type}
                    </span>
                  </td>
                  <td>{w ? w.code : '—'}</td>
                  <td>
                    <div><span className={styles.codeChip}>{m.product_code}</span></div>
                    <div className={styles.numCellZero} style={{ fontSize: 'var(--fs-11)' }}>{m.product_name ?? '—'}</div>
                  </td>
                  <td className={`${styles.numCell} ${m.movement_type === 'IN' ? styles.numCellPos : styles.numCellNeg}`}>
                    {m.movement_type === 'IN' ? '+' : m.movement_type === 'OUT' ? '−' : ''}
                    {fmtQty(Math.abs(m.qty))}
                  </td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`}>
                    {m.unit_cost_sen && m.unit_cost_sen > 0 ? fmtRm(m.unit_cost_sen) : '—'}
                  </td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`}>
                    {m.total_cost_sen && m.total_cost_sen > 0 ? fmtRm(m.total_cost_sen) : '—'}
                  </td>
                  <td>
                    {m.source_doc_no ? (() => {
                      const href = docHrefFor(m);
                      return href
                        ? <Link to={href} className={styles.docLink}>{m.source_doc_no}</Link>
                        : <span className={styles.docLink}>{m.source_doc_no}</span>;
                    })() : <span className={styles.numCellZero}>—</span>}
                  </td>
                  <td className={styles.numCellZero}>
                    {m.reason_code ? adjustmentReasonLabel(m.reason_code) : '—'}
                  </td>
                  <td className={`${styles.numCellZero} ${styles.notesCell}`} title={m.notes ?? ''}>{m.notes ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   COGS tab — FIFO consumption stream
   ════════════════════════════════════════════════════════════════════════ */
const CogsTab = ({
  warehouseId, search,
}: {
  warehouseId: string | null;
  search: string;
}) => {
  const { data, isLoading } = useCogsEntries({
    warehouseId: warehouseId ?? undefined,
    productCode: search.trim() || undefined,
  });
  const cogs: CogsEntry[] = useMemo(() => data ?? [], [data]);
  const totalCogs = useMemo(() => cogs.reduce((s, r) => s + r.total_cost_sen, 0), [cogs]);

  return (
    <>
      <div className={STAT_GRID_3}>
        <StatCard
          label="Total COGS"
          value={fmtRm(totalCogs)}
          subtitle={`${cogs.length} consumptions`}
          /* Sum over an empty-because-unloaded list. RM 0.00 for "we haven't
             fetched the consumptions yet" is a lie the operator can act on. */
          pending={isLoading}
        />
      </div>

      <p className={styles.eyebrow}>{isLoading ? 'Loading…' : `${cogs.length} consumption entries`}</p>

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>Warehouse</th>
              <th>Product</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Unit Cost</th>
              <th style={{ textAlign: 'right' }}>COGS</th>
              <th>Doc</th>
              <th>Lot Received</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={8} className={styles.emptyRow}>Loading…</td></tr>}
            {!isLoading && cogs.length === 0 && (
              <tr><td colSpan={8} className={styles.emptyRow}>
                <DollarSign size={32} strokeWidth={1.5} />
                <div style={{ marginTop: 8 }}>No COGS entries yet.</div>
                <div style={{ marginTop: 4, fontSize: 'var(--fs-12)' }}>
                  COGS is auto-posted when a DO or Purchase Return consumes a lot.
                </div>
              </td></tr>
            )}
            {!isLoading && cogs.map((c) => (
              <tr key={c.id}>
                <td className={styles.numCellZero}>{fmtDateTime(c.consumed_at)}</td>
                <td>{c.warehouse_code}</td>
                <td><span className={styles.codeChip}>{c.product_code}</span></td>
                <td className={`${styles.numCell} ${styles.numCellNeg}`}>−{fmtQty(c.qty_consumed)}</td>
                <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(c.unit_cost_sen)}</td>
                <td className={`${styles.numCell}`} style={{ fontWeight: 700 }}>{fmtRm(c.total_cost_sen)}</td>
                <td>{c.source_doc_no ? <span className={styles.docLink}>{c.source_doc_no}</span> : '—'}</td>
                <td className={styles.numCellZero}>
                  {fmtDateTime(c.lot_received_at)}{c.lot_source_doc_no ? ` · ${c.lot_source_doc_no}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Warehouses tab — moved from standalone /warehouses page (PR #38)
   ════════════════════════════════════════════════════════════════════════ */
const WarehousesTab = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const warehouses = useWarehouses({ includeInactive });

  return (
    <>
      <div className={styles.filterRow} style={{ justifyContent: 'space-between' }}>
        <label className="inline-flex items-center gap-1.5 text-[13px] text-ink">
          <input type="checkbox" checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus {...ICON_MD} />
          <span>New Warehouse</span>
        </Button>
      </div>

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Location</th>
              <th>Default</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {warehouses.isLoading && (
              <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>
            )}
            {!warehouses.isLoading && (warehouses.data?.length ?? 0) === 0 && (
              <tr><td colSpan={6} className={styles.emptyRow}>
                <WarehouseIcon size={32} strokeWidth={1.5} />
                <div style={{ marginTop: 8 }}>No warehouses yet.</div>
              </td></tr>
            )}
            {warehouses.data?.map((w) => (
              <tr key={w.id}>
                <td><span className={styles.codeChip}>{w.code}</span></td>
                <td>{w.name}</td>
                <td className={styles.numCellZero}>{w.location ?? '—'}</td>
                <td>{w.is_default ? <Star size={12} strokeWidth={2}
                  className="fill-primary text-primary" /> : '—'}</td>
                <td>
                  <span className={`${styles.movementPill} ${w.is_active ? styles.movementIn : styles.movementAdj}`}>
                    {w.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <Button variant="ghost" onClick={() => setEditing(w)}>Edit</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <WarehouseDrawer
          editing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </>
  );
};

const WarehouseDrawer = ({
  editing, onClose,
}: {
  editing: Warehouse | null;
  onClose: () => void;
}) => {
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const notify = useNotify();
  const [form, setForm] = useState({
    code: editing?.code ?? '',
    name: editing?.name ?? '',
    location: editing?.location ?? '',
    isActive: editing?.is_active ?? true,
    isDefault: editing?.is_default ?? false,
  });

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) {
      notify({ title: 'Code and Name are required.', tone: 'error' });
      return;
    }
    if (editing) {
      update.mutate({
        id: editing.id,
        code: form.code, name: form.name, location: form.location,
        isActive: form.isActive, isDefault: form.isDefault,
      }, { onSuccess: onClose });
    } else {
      create.mutate({
        code: form.code, name: form.name,
        location: form.location || undefined,
        isDefault: form.isDefault,
      }, { onSuccess: onClose });
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 50,
        display: 'flex', justifyContent: 'flex-end',
      }}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-[480px] max-w-[95vw] overflow-auto bg-bg p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-3">
          <h2 className="font-display text-[20px] font-extrabold leading-tight tracking-tight text-ink">
            {editing ? 'Edit Warehouse' : 'New Warehouse'}
          </h2>
          <button type="button" className={styles.chip} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>

        <label style={{ display: 'block', marginTop: 'var(--space-4)' }}>
          <div className={styles.eyebrow}>Code *</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.code} placeholder="KL / PJ / JB"
            onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} />
        </label>
        <label style={{ display: 'block', marginTop: 'var(--space-3)' }}>
          <div className={styles.eyebrow}>Name *</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.name} placeholder="KL Warehouse / 2990 PJ"
            onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} />
        </label>
        <label style={{ display: 'block', marginTop: 'var(--space-3)' }}>
          <div className={styles.eyebrow}>Location</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.location ?? ''} placeholder="Address / area"
            onChange={(e) => setForm((s) => ({ ...s, location: e.target.value }))} />
        </label>
        <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.isDefault}
              onChange={(e) => setForm((s) => ({ ...s, isDefault: e.target.checked }))} />
            Default warehouse
          </label>
          {editing && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.isActive}
                onChange={(e) => setForm((s) => ({ ...s, isActive: e.target.checked }))} />
              Active
            </label>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', marginTop: 'var(--space-5)' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending || update.isPending}>
            {(create.isPending || update.isPending) ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};

const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = fmtDate(d);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
};
