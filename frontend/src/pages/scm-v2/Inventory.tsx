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
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import {
  Search, ArrowUpRight, ArrowDownLeft, Star, X, Plus,
  Warehouse as WarehouseIcon, ChevronRight, ChevronDown,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { SearchProgress } from '../../components/SearchProgress';
import { SearchScopeHint } from '../../components/SearchScopeHint';
import { useDebouncedSearchTerm, useSearchResultTransition } from '../../hooks/useServerSearch';
import { adjustmentReasonLabel, fmtSen, fmtDate, fmtDateTime, fmtQty, formatVariantKey } from '@2990s/shared';
import { DataTable, type Column } from '../../components/DataTable';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useWarehouses,
  useInventoryProductTotals,
  useInventoryProductBreakdown,
  useInventoryMovements,
  useInventoryBatches,
  useCogsEntries,
  useInventoryAnalytics,
  useInventoryReservations,
  useCreateWarehouse,
  useUpdateWarehouse,
  buildStockBreakdown,
  lotAssignedQty,
  lotFreeQty,
  isMakeToOrderCategory,
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

const fmtRm = (sen: number | null | undefined): string => fmtSen(sen);

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
   cell tooltip. The same list renders as the row drill (IncomingPoPanel).
   Null-safe: the API field can be absent on an older/partial payload — treat a
   missing list as empty rather than reading `.length` off undefined. */
const incomingPoSummary = (pos: InventoryIncomingPo[] | null | undefined): string => {
  const list = pos ?? [];
  return list.length === 0
    ? '—'
    : list.map((p) => `${p.po_number} · ETA ${fmtEta(p.eta)} · +${fmtQty(p.qty)}`).join('\n');
};

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
                big-card / chip rail). Scopes Stock / Incoming / Scheduled /
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
/* 'never' rather than '—' is this screen's wording for "no count has ever
   happened", not a second date format — the date itself is the one rule. */
const fmtDay = (iso: string | null): string => (iso ? fmtDate(iso) : 'never');

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

      {/* Stock aging — batch 2: DataTable, aging-bucket order preserved (the
          buckets arrive youngest→oldest from the server; keep insertion order,
          so no default sort). */}
      <p className={styles.eyebrow}>Stock Aging — by date received</p>
      <DataTable<(typeof data.aging)[number]>
        tableId="inventory-analytics-aging"
        layoutFamily="inventory-analytics-aging"
        exportName="stock-aging"
        rows={data.aging}
        loading={false}
        emptyLabel="No open lots."
        getRowKey={(b) => b.key}
        columns={[
          { key: 'bucket', label: 'Age Bucket', getValue: (b) => b.label, render: (b) => b.label },
          { key: 'qty', label: 'Qty', align: 'right', width: '110px', getValue: (b) => b.qty, render: (b) => <span className={`${styles.numCell} ${b.qty > 0 ? styles.numCellPos : styles.numCellZero}`}>{fmtQty(b.qty)}</span> },
          { key: 'value', label: 'Value', align: 'right', width: '140px', getValue: (b) => b.valueSen / 100, render: (b) => <span className={styles.numCell} style={{ fontWeight: 700 }}>{b.valueSen > 0 ? fmtRm(b.valueSen) : '—'}</span> },
          {
            key: 'share', label: 'Share of value', width: '34%', disableSort: true,
            getValue: (b) => b.valueSen,
            render: (b) => (
              <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-primary" style={{ width: `${(b.valueSen / agingMax) * 100}%` }} />
              </div>
            ),
          },
        ] satisfies Column<(typeof data.aging)[number]>[]}
      />

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

      {/* Dead stock — batch 2: DataTable. */}
      <p className={styles.eyebrow}>Dead Stock — has stock, no sale in {days} days</p>
      <DataTable<(typeof data.deadStock)[number]>
        tableId="inventory-analytics-dead"
        layoutFamily="inventory-analytics-dead"
        exportName="dead-stock"
        rows={data.deadStock}
        loading={false}
        emptyLabel={`No dead stock — every SKU in stock sold within ${days} days.`}
        getRowKey={(d) => d.item_code}
        columns={[
          { key: 'product', label: 'Product', getValue: (d) => `${d.item_code} ${d.product_name}`, render: (d) => <><span className={styles.codeChip}>{d.item_code}</span> {d.product_name}</> },
          { key: 'qty', label: 'Qty', align: 'right', width: '110px', getValue: (d) => d.qty, render: (d) => <span className={`${styles.numCell} ${styles.numCellPos}`}>{fmtQty(d.qty)}</span> },
          { key: 'value', label: 'Value', align: 'right', width: '140px', getValue: (d) => d.valueSen / 100, render: (d) => <span className={styles.numCell} style={{ fontWeight: 700 }}>{fmtRm(d.valueSen)}</span> },
          { key: 'lastSold', label: 'Last Sold', width: '130px', getValue: (d) => d.lastSoldAt ?? '', render: (d) => <span className={styles.numCellZero}>{fmtDay(d.lastSoldAt)}</span> },
        ] satisfies Column<(typeof data.deadStock)[number]>[]}
      />
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
  /* 选日期 (GL redesign item 5): a date here swaps the live planning list for
     the AS-OF photograph — per-product qty and value replayed on the business
     date, category subtotals included. Clearing the date returns to live. */
  const [asOf, setAsOf] = useState('');
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
  // Owner 2026-07-25 — a "Dead stock only" view over the SAME set-based rows:
  // SKUs with idle Spare > 0, i.e. on-hand stock beyond all demand. Reads the
  // SELLABLE figure so the filter and the badge agree — a showroom/display/
  // service piece is where it belongs and must not appear here either.
  // Client-side (no extra query); the badge column emphasises make-to-order.
  const [deadOnly, setDeadOnly] = useState(false);
  const baseRows = resultsAreStale ? [] : rows;
  const visibleRows = deadOnly
    ? baseRows.filter((r) => (r.sellable_surplus_qty ?? r.surplus_qty ?? 0) > 0)
    : baseRows;

  /* Own vs consignment, SEPARATED end to end (owner, 2026-08-06: "分成两个
     value：一个是 inventory value,一个是 consignment value…stock 也可以分成
     自己的 stock 和 consignment stock"). The drawer already speaks this
     language; the list and the cards now match it. */
  const stats = useMemo(() => ({
    ownQty: visibleRows.reduce((s, r) => s + (r.owned_qty ?? r.total_qty ?? 0), 0),
    heldQty: visibleRows.reduce((s, r) => s + (r.held_qty ?? 0), 0),
    distinctSku: visibleRows.length,
    totalValue: visibleRows.reduce((s, r) => s + (r.total_value_sen ?? 0), 0),
    heldValue: visibleRows.reduce((s, r) => s + (r.held_value_sen ?? 0), 0),
  }), [visibleRows]);

  // `visibleRows` is deliberately EMPTY while a search/filter is in flight, so
  // these three aggregates are all 0 — and "Inventory Value RM 0.00" is a
  // sentence, not a spinner. Mark them unknown until the rows they summarise are
  // the rows actually on screen. An error is unknown too: the aggregate would
  // otherwise describe a list that failed to load.
  const statsPending = isLoading || searching || resultsAreStale || Boolean(error);

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
        <label htmlFor="inv-asof" style={{ fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' }}>As of date</label>
        <input id="inv-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
          style={{ padding: '4px 8px', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 'var(--radius-sm, 6px)', fontSize: 'var(--fs-13)', background: 'white' }} />
        {asOf && (
          <button type="button" className={styles.chip} onClick={() => setAsOf('')}>Back to live</button>
        )}
      </div>

      {asOf ? (
        <AsOfView asOf={asOf} category={category} search={search} />
      ) : (
      <>
      <div className={STAT_GRID}>
        <StatCard label="Own Stock Qty" value={fmtQty(stats.ownQty)} pending={statsPending} />
        <StatCard label="Consignment Qty" value={fmtQty(stats.heldQty)} pending={statsPending} />
        <StatCard label="Inventory Value" value={fmtRm(stats.totalValue)} pending={statsPending} />
        <StatCard label="Consignment Value" value={fmtRm(stats.heldValue)} pending={statsPending} />
      </div>

      {/* Dead-stock view — SKUs with Spare (surplus) stock beyond all demand.
          Make-to-order (SOFA/BEDFRAME) rows are the abnormal ones (red badge). */}
      <div className={styles.warehouseChips} style={{ marginTop: 'var(--space-3)' }}>
        <button type="button" className={styles.chip}
          data-active={!deadOnly} onClick={() => setDeadOnly(false)}>
          All SKUs
        </button>
        <button type="button" className={styles.chip}
          data-active={deadOnly} onClick={() => setDeadOnly(true)}
          title="Show only SKUs with spare stock (Spare > 0) — the dead-stock candidates.">
          Dead stock only
        </button>
      </div>

      <p className={styles.eyebrow}>
        {isLoading || searching ? 'Loading…' : `${visibleRows.length} SKU rows · click a row for the per-warehouse breakdown · chevron for variants`}
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

      {/* Batch 2: DataTable. The old DataGrid bound double-click to the
          drawer and row-click to expansion; DataTable splits them cleanly —
          row CLICK opens the per-warehouse breakdown drawer (better
          discoverability than double-click), the chevron owns the variant
          expansion. Page-level search stays server-scoped (contract above),
          so no DataTable search config. */}
      <DataTable<InventoryProductTotal>
        tableId="inventory-balances"
        layoutFamily="inventory-balances"
        exportName="inventory-balances"
        rows={isLoading || searching ? null : visibleRows}
        loading={isLoading || searching}
        emptyLabel="No SKUs match the filters."
        getRowKey={(r) => r.item_code}
        columns={BALANCE_COLUMNS}
        onRowClick={(r) => onDrilldown(r.item_code, r.product_name)}
        /* Variant drill (Commander 2026-05-29): chevron expands the SKU into
           its attribute-composition buckets. Lazy: only fetches when expanded. */
        expandable={{
          render: (r) => (
            <>
              <IncomingPoPanel pos={r.incoming_pos} />
              <SkuVariantPanel code={r.item_code} />
            </>
          ),
          rowKey: (r) => r.item_code,
        }}
      />
      </>
      )}
    </>
  );
};

/* ── The as-of photograph (GL redesign item 5) ────────────────────────────
   Replay per product on the BUSINESS date (backend /inventory/valuation —
   the same engine the month-end close reads), with category subtotals. */
type AsOfRow = { item_code: string; product_name: string | null; category: string | null; qty: number; value_sen: number };

/** Rows → per-category subtotal lines, largest value first. Exported for its
    test: the subtotals must always sum back to the grand total. */
export const categorySubtotals = (rows: AsOfRow[]): Array<{ category: string; qty: number; valueSen: number }> => {
  const at = new Map<string, { qty: number; valueSen: number }>();
  for (const r of rows) {
    const key = r.category ?? '(no category)';
    const cur = at.get(key) ?? { qty: 0, valueSen: 0 };
    cur.qty += r.qty;
    cur.valueSen += r.value_sen;
    at.set(key, cur);
  }
  return [...at.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.valueSen - a.valueSen);
};

const AsOfView = ({ asOf, category, search }: { asOf: string; category: Category; search: string }) => {
  const q = useQuery({
    queryKey: ['inventory-valuation', asOf],
    queryFn: () => authedFetch<{ asOf: string; totalQty: number; totalValueSen: number; rows: AsOfRow[] }>(
      `/inventory/valuation?asOf=${encodeURIComponent(asOf)}`,
    ),
    staleTime: 60_000,
  });
  if (q.isLoading) return <div style={{ fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' }}>Replaying {asOf}…</div>;
  if (q.isError || !q.data) return <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The {asOf} snapshot did not load. Pick the date again to retry.</div>;

  const needle = search.trim().toLowerCase();
  const rows = q.data.rows
    .filter((r) => category === 'all' || r.category === category)
    .filter((r) => !needle || r.item_code.toLowerCase().includes(needle) || String(r.product_name ?? '').toLowerCase().includes(needle));
  const subtotals = categorySubtotals(rows);
  const shownQty = rows.reduce((s, r) => s + r.qty, 0);
  const shownValue = rows.reduce((s, r) => s + r.value_sen, 0);

  return (
    <>
      <div className={STAT_GRID}>
        <StatCard label={`Qty as of ${asOf}`} value={fmtQty(shownQty)} />
        <StatCard label={`Value as of ${asOf}`} value={fmtRm(shownValue)} />
        <StatCard label="Products" value={String(rows.length)} />
      </div>
      <div style={{ margin: 'var(--space-2) 0', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {subtotals.map((s) => (
          <span key={s.category} className={styles.chip} data-active={category === s.category}>
            {s.category}: {fmtQty(s.qty)} · {fmtRm(s.valueSen)}
          </span>
        ))}
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--c-line, rgba(34,31,32,0.12))', borderRadius: 'var(--radius-md)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Item</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Description</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Category</th>
              <th style={{ textAlign: 'right', padding: '8px 10px' }}>Qty</th>
              <th style={{ textAlign: 'right', padding: '8px 10px' }}>Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item_code} style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.item_code}</td>
                <td style={{ padding: '6px 10px' }}>{r.product_name ?? '—'}</td>
                <td style={{ padding: '6px 10px' }}>{r.category ?? '—'}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtQty(r.qty)}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtRm(r.value_sen)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '10px', color: 'var(--text-soft, #8a8578)' }}>Nothing held on {asOf} under this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
};

/* Balances columns — batch 2: DataTable `Column`s at module scope. Sorting
   derives from `getValue` (numbers for qty/money, strings for text); the
   chevron is DataTable's synthetic expand column. */
const BALANCE_COLUMNS: Column<InventoryProductTotal>[] = [
  {
    key: 'code',
    label: 'Product Code',
    width: '160px',
    getValue: (r) => r.item_code,
    render: (r) => (
      <Link
        to={`/scm/inventory/stock-card/${encodeURIComponent(r.item_code)}`}
        className={styles.codeChip}
        onClick={(e) => e.stopPropagation()}
        title="Open Stock Card"
        style={{ textDecoration: 'none' }}
      >
        {r.item_code}
      </Link>
    ),
  },
  {
    key: 'desc',
    label: 'Description',
    width: '240px',
    getValue: (r) => `${r.product_name} ${r.branding ?? ''}`,
    render: (r) => (
      <>
        {r.product_name}
        {r.branding && <span className={styles.numCellZero}> · {r.branding}</span>}
      </>
    ),
  },
  {
    key: 'category',
    label: 'Category',
    width: '100px',
    getValue: (r) => r.category,
    render: (r) => <span className={styles.numCellZero}>{r.category}</span>,
  },
  {
    key: 'stock',
    label: 'Stock',
    width: '85px',
    align: 'right',
    /* OWN stock only — one clean number, nothing to mentally add up. Owner,
       2026-08-05: "consignment 的东西怎么可以放进 my stocks 里面…我会以为我有货";
       2026-08-06: "stock 也可以分成自己的 stock 和 consignment stock…就不用去
       算 2 加 2 了". Consignment moved to its OWN column, mirroring the Stock
       Breakdown drawer's split. */
    getValue: (r) => r.owned_qty ?? r.total_qty,
    render: (r) => {
      const owned = r.owned_qty ?? r.total_qty;
      const qtyClass = owned > 0 ? styles.numCellPos
        : owned < 0 ? styles.numCellNeg
        : styles.numCellZero;
      return (
        <span className={`${styles.numCell} ${qtyClass}`}>
          {fmtQty(owned)}
          {/* The two ledgers disagree for this SKU. Marked, not hidden — Actions
              -> "Reconcile a SKU" settles it from the documents. */}
          {r.ledger_mismatch && (
            <span
              className={styles.numCellNeg}
              title={`Ledgers disagree: the movement ledger says ${fmtQty(r.movement_qty ?? 0)}, the lot ledger says ${fmtQty(owned + (r.held_qty ?? 0))}. This row uses the lot ledger. Run Actions → "Reconcile a SKU" to settle it against the documents.`}
            >{' ⚠'}</span>
          )}
        </span>
      );
    },
  },
  {
    key: 'consignment',
    label: 'Consignment',
    width: '105px',
    align: 'right',
    /* Somebody else's goods standing with us — findable, sortable, and never
       mixed into Stock, Available, Spare or any value figure. */
    getValue: (r) => r.held_qty ?? 0,
    render: (r) => {
      const held = r.held_qty ?? 0;
      return (
        <span
          className={`${styles.numCell} ${styles.numCellZero}`}
          title={held > 0 ? `${fmtQty(held)} held on consignment — not owned; value ${fmtRm(r.held_value_sen ?? 0)} excluded from inventory value` : undefined}
        >
          {held > 0 ? fmtQty(held) : '—'}
        </span>
      );
    },
  },
  {
    key: 'incoming',
    label: 'Incoming',
    width: '100px',
    align: 'right',
    // Owner 2026-07-24 — PO qty ARRIVING WITHIN ~30 days. The tooltip + the row
    // drill name WHICH PO(s) and their ETA (incoming_pos); the cell stays a
    // scannable "+N".
    getValue: (r) => r.incoming_qty,
    render: (r) => (
      <span
        className={`${styles.numCell} ${r.incoming_qty > 0 ? styles.numCellPos : styles.numCellZero}`}
        title={r.incoming_qty > 0
          ? `Arriving within ~30 days:\n${incomingPoSummary(r.incoming_pos)}`
          : 'No PO arriving within ~30 days.'}
      >
        {r.incoming_qty > 0 ? `+${fmtQty(r.incoming_qty)}` : '—'}
      </span>
    ),
  },
  {
    key: 'committed',
    label: 'Scheduled',
    width: '100px',
    align: 'right',
    // Demand from open SO lines that HAVE a delivery date (scheduled to ship).
    // Backend field stays `committed_scheduled`; the on-screen label is "Scheduled".
    getValue: (r) => r.committed_scheduled,
    render: (r) => (
      <span
        className={`${styles.numCell} ${r.committed_scheduled > 0 ? styles.numCellNeg : styles.numCellZero}`}
        title="Scheduled = open Sales-Order demand that has a delivery date (scheduled to ship). Delivered/cancelled lines are already netted out. This is subtracted from Stock + Incoming to give Available."
      >
        {r.committed_scheduled > 0 ? `−${fmtQty(r.committed_scheduled)}` : '—'}
      </span>
    ),
  },
  {
    key: 'available',
    label: 'Available',
    width: '100px',
    align: 'right',
    // Available = Stock + Incoming − Scheduled (owner 2026-07-24 — Incoming is
    // now INCLUDED; the on-screen equation is spelled out in the tooltip).
    getValue: (r) => r.available_qty,
    render: (r) => (
      <span
        className={`${styles.numCell} ${r.available_qty < 0 ? styles.numCellNeg : r.available_qty > 0 ? styles.numCellPos : styles.numCellZero}`}
        title={`${fmtQty(r.owned_qty ?? r.total_qty)} owned + ${fmtQty(r.incoming_qty)} incoming − ${fmtQty(r.committed_scheduled)} scheduled = ${fmtQty(r.available_qty)} available` +
          ((r.held_qty ?? 0) > 0 ? ` (held ${fmtQty(r.held_qty ?? 0)} on consignment — not ours, excluded)` : '')}
      >
        {fmtQty(r.available_qty)}
      </span>
    ),
  },
  {
    key: 'unscheduled',
    label: 'Unscheduled',
    width: '105px',
    align: 'right',
    // Demand from open SO lines with NO delivery date (future / uncertain).
    getValue: (r) => r.unscheduled_qty,
    render: (r) => (
      <span
        className={`${styles.numCell} ${r.unscheduled_qty > 0 ? '' : styles.numCellZero}`}
        title="Unscheduled = open Sales-Order demand with no delivery date yet (future / uncertain). Not subtracted from Available, but eats into Spare."
      >
        {r.unscheduled_qty > 0 ? fmtQty(r.unscheduled_qty) : '—'}
      </span>
    ),
  },
  {
    key: 'surplus',
    label: 'Spare',
    width: '95px',
    align: 'right',
    // Spare = Available − Unscheduled. Negative = even undated demand can't be
    // met (reads as short); positive = genuinely spare / idle stock (dead-stock
    // signal). Backend field stays `surplus_qty`; the on-screen label is "Spare".
    getValue: (r) => r.surplus_qty,
    render: (r) => (
      <span
        className={`${styles.numCell} ${r.surplus_qty < 0 ? styles.numCellNeg : r.surplus_qty > 0 ? styles.numCellPos : styles.numCellZero}`}
        title={`${fmtQty(r.available_qty)} available − ${fmtQty(r.unscheduled_qty)} unscheduled = ${fmtQty(r.surplus_qty)} spare`}
      >
        {fmtQty(r.surplus_qty)}
      </span>
    ),
  },
  {
    // Owner 2026-07-25 — per-SKU dead-stock indicator. Reconciles with the Spare
    // column (surplus_qty > 0 = idle stock, the owner's dead-stock signal): make-
    // to-order (SOFA/BEDFRAME) idle stock is ABNORMAL (built against an SO), shown
    // red; make-to-stock (MATTRESS) idle stock is expected, shown soft. Derived
    // from the SAME set-based Scheduled/Unscheduled aggregates — NO per-SKU MRP on
    // list load (the crash guard). The drawer gives the exact per-lot split.
    key: 'deadstock',
    label: 'Dead stock',
    width: '110px',
    /* Reads sellable_surplus_qty, NOT surplus_qty. A piece standing in a showroom
       or at the supplier for service is doing its job, so "no sale in the window"
       says nothing about it — the badge must not call it dead. Owner, 2026-08-05:
       "我的 dead stock 里面怎么会有 dead stock 呢？因为它明明是 showroom 的 display
       啊". The same day's fix reached only the Analytics dead-stock list, so THIS
       badge — the one on the screen he looks at — kept flagging them.
       Falls back to surplus_qty so a cached pre-fix payload renders as before. */
    getValue: (r) => {
      const idle = r.sellable_surplus_qty ?? r.surplus_qty;
      return idle > 0 ? (isMakeToOrderCategory(r.category) ? `dead ${idle}` : `spare ${idle}`) : '';
    },
    render: (r) => {
      const idle = r.sellable_surplus_qty ?? r.surplus_qty;
      const parked = r.non_selling_qty ?? 0;
      if (idle <= 0) {
        return (
          <span
            className={styles.numCellZero}
            title={parked > 0
              ? `${fmtQty(parked)} standing in a showroom / display / service warehouse — where it is meant to be, so it is not a dead-stock candidate.`
              : undefined}
          >—</span>
        );
      }
      const mto = isMakeToOrderCategory(r.category);
      const parkedNote = parked > 0
        ? ` (${fmtQty(parked)} more is on display / at service and excluded)`
        : '';
      return (
        <span
          className={`${styles.movementPill} ${mto ? styles.pillDeadStock : styles.pillFreeSoft}`}
          title={mto
            ? `Make-to-order (${r.category}): ${fmtQty(idle)} spare on hand with no Sales Order — dead-stock candidate${parkedNote}. Open the drawer for the exact assigned/free lots.`
            : `Make-to-stock (${r.category}): ${fmtQty(idle)} spare is expected for a shelf item${parkedNote}. Softer signal.`}
        >
          {mto ? 'Dead' : 'Spare'} {fmtQty(idle)}
        </span>
      );
    },
  },
  {
    key: 'value',
    label: 'Value',
    width: '110px',
    align: 'right',
    getValue: (r) => r.total_value_sen / 100,
    render: (r) => (
      <span className={`${styles.numCell} ${styles.numCellZero}`}>
        {r.total_value_sen > 0 ? fmtRm(r.total_value_sen) : '—'}
      </span>
    ),
  },
  {
    key: 'unitCost',
    label: 'Unit Cost',
    width: '100px',
    align: 'right',
    getValue: (r) => ((r.owned_qty ?? r.total_qty) > 0 && r.total_value_sen > 0 ? r.total_value_sen / (r.owned_qty ?? r.total_qty) / 100 : 0),
    render: (r) => (
      <span className={`${styles.numCell} ${styles.numCellZero}`}>
        {(r.owned_qty ?? r.total_qty) > 0 && r.total_value_sen > 0 ? fmtRm(Math.round(r.total_value_sen / (r.owned_qty ?? r.total_qty))) : '—'}
      </span>
    ),
  },
  {
    key: 'age',
    label: 'Age',
    width: '70px',
    /* Oldest lot first when ascending — null (no lots) sorts last. */
    getValue: (r) => r.oldest_lot_at ?? '9999-12-31',
    render: (r) => (
      <span className={styles.numCellZero} title={r.oldest_lot_at ?? undefined}>{fmtAgeDays(r.oldest_lot_at)}</span>
    ),
  },
];

/* Incoming PO drill inside a Balances row expansion (owner 2026-07-24 — the
   Incoming column must name WHICH PO(s) bring the stock + their ETA, not just a
   count). Rendered above the variant panel; hidden when nothing is inbound. */
const IncomingPoPanel = ({ pos }: { pos: InventoryIncomingPo[] | null | undefined }) => {
  const list = pos ?? [];
  if (list.length === 0) return null;
  return (
    <table className={`${styles.table} bg-surface-2`}>
      <tbody>
        {list.map((p) => (
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
  const balances = (bd.data?.balances ?? []).filter((b) => b.item_code === code);
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
      (b.batchNo ?? '').toLowerCase().includes(q) ||
      (b.supplierName ?? '').toLowerCase().includes(q) ||
      (b.components ?? []).some((c) =>
        c.itemCode.toLowerCase().includes(q) ||
        (c.productName ?? '').toLowerCase().includes(q)),
    );
  }, [allBatches, q]);

  const stats = useMemo(() => ({
    batchCount: batches.length,
    totalQty: batches.reduce((s, b) => s + b.totalRemaining, 0),
    skuCount: new Set(batches.flatMap((b) => (b.components ?? []).map((c) => c.itemCode))).size,
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
            {w.code}
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

      {/* Batch 2: DataTable — the page's own search box above stays (its
          scope line is a contract string); the chevron expands the batch into
          its surviving component SKUs. */}
      <DataTable<InventoryBatch>
        tableId="inventory-batches"
        layoutFamily="inventory-batches"
        exportName="inventory-batches"
        rows={isLoading ? null : batches}
        loading={isLoading}
        emptyLabel={`No open batches${q ? ' match the search' : ''}.`}
        getRowKey={(b) => `${b.warehouseId}|${b.batchNo}`}
        columns={BATCH_COLUMNS}
        expandable={{
          render: (b) => <BatchComponentsPanel batch={b} />,
          rowKey: (b) => `${b.warehouseId}|${b.batchNo}`,
        }}
      />
    </>
  );
};

/* Batches columns — batch 2: DataTable `Column`s at module scope. The
   chevron comes from DataTable's synthetic expand column; page-level search
   already matches component SKUs inside the batch, so no per-column search. */
const BATCH_COLUMNS: Column<InventoryBatch>[] = [
  {
    key: 'batch',
    label: 'Batch / PO',
    width: '160px',
    getValue: (b) => b.batchNo ?? '',
    render: (b) => <span className={styles.codeChip}>{b.batchNo}</span>,
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    width: '150px',
    getValue: (b) => b.warehouseName ?? '—',
    render: (b) => b.warehouseName ?? '—',
  },
  {
    key: 'supplier',
    label: 'Supplier',
    width: '170px',
    getValue: (b) => b.supplierName ?? '',
    render: (b) => b.supplierName ?? <span className={styles.numCellZero}>—</span>,
  },
  {
    key: 'components',
    label: 'Components',
    width: '100px',
    align: 'right',
    getValue: (b) => (b.components ?? []).length,
    render: (b) => <span className={`${styles.numCell} ${styles.numCellZero}`}>{(b.components ?? []).length}</span>,
  },
  {
    key: 'modules',
    label: 'Modules',
    width: '90px',
    align: 'right',
    getValue: (b) => b.totalRemaining,
    render: (b) => (
      <span className={`${styles.numCell} ${b.totalRemaining > 0 ? styles.numCellPos : styles.numCellZero}`}>
        {fmtQty(b.totalRemaining)}
      </span>
    ),
  },
  {
    key: 'received',
    label: 'Received',
    width: '90px',
    getValue: (b) => b.receivedAt ?? '9999-12-31',
    render: (b) => (
      <span className={styles.numCellZero} title={b.receivedAt ?? undefined}>{fmtAgeDays(b.receivedAt)}</span>
    ),
  },
];

/* Component SKUs inside a batch — rendered in the row's DataGrid expansion
   (was inline cream <tr>s pre-DataGrid). */
const BatchComponentsPanel = ({ batch }: { batch: InventoryBatch }) => (
  <table className={`${styles.table} bg-surface-2`}>
    <tbody>
      {(batch.components ?? []).map((c) => (
        <tr key={`${c.itemCode}|${c.variantKey ?? ''}`}>
          <td style={{ paddingLeft: 28, width: 190 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className={styles.numCellZero}>↳</span>
              <Link
                to={`/scm/inventory/stock-card/${encodeURIComponent(c.itemCode)}`}
                className={styles.codeChip}
                onClick={(e) => e.stopPropagation()}
                title="Open Stock Card"
                style={{ textDecoration: 'none' }}
              >
                {c.itemCode}
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
/* Assigned-SO cell — the SO(s) this lot's ON-HAND units are allocated to by the
   ONE MRP engine (mrp_assigned_to), each with its qty + DELIVERY DATE. This is
   the owner's "which 3 of the 10 are assigned, to which SO" — NOT the hard READY
   reservation. Null-safe: absent fields (older/degraded payload) → free (no
   order). Shared by the drawer's owned/consignment rows + the Reservations tab. */
const renderAssignedFor = (r: InventoryReservation) => {
  const claims = r.mrp_assigned_to ?? [];
  if (claims.length === 0) return <span className={styles.numCellZero}>No order (free)</span>;
  return claims.map((x) => (
    <div key={x.doc_no} style={{ whiteSpace: 'nowrap' }}>
      <Link to={`/scm/sales-orders/${encodeURIComponent(x.doc_no)}`} className={styles.docLink}>
        {x.doc_no}
      </Link>
      <span className={styles.numCellZero}> · {fmtQty(x.qty)}</span>
      {x.delivery_date
        ? <span className={styles.numCellZero}> · {fmtDate(x.delivery_date)}</span>
        : <span className={styles.numCellZero}> · no date</span>}
    </div>
  ));
};

/* Status cell — the MRP-derived assigned/free split for one lot. A lot may be
   part assigned, part free; show both counts. FREE units are a dead-stock
   candidate, emphasised (red) for make-to-order SOFA/BEDFRAME where free stock is
   abnormal, soft (amber) for make-to-stock (MATTRESS) where it is normal.
   Consignment lots (held, not owned) never read as dead stock. */
const renderAssignedFreeStatus = (r: InventoryReservation) => {
  const assigned = lotAssignedQty(r);
  const free = lotFreeQty(r);
  const mto = r.make_to_order ?? isMakeToOrderCategory(r.category);
  const deadStock = !r.is_consignment && free > 0;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {assigned > 0 && (
        <span className={`${styles.movementPill} ${styles.pillAssigned}`}>{fmtQty(assigned)} assigned</span>
      )}
      {free > 0 && (
        <span
          className={`${styles.movementPill} ${deadStock && mto ? styles.pillDeadStock : styles.pillFreeSoft}`}
          title={deadStock
            ? (mto
                ? 'Make-to-order (SOFA/BEDFRAME): free stock is abnormal — dead-stock candidate.'
                : 'Make-to-stock: free stock is expected. Softer dead-stock signal.')
            : undefined}
        >
          {fmtQty(free)} free{deadStock && mto ? ' · dead' : ''}
        </span>
      )}
      {assigned === 0 && free === 0 && <span className={styles.numCellZero}>—</span>}
    </span>
  );
};

const ReservationsTab = ({
  warehouseId, setWarehouseId, warehouses, search, setSearch,
}: {
  warehouseId: string | null;
  setWarehouseId: (id: string | null) => void;
  warehouses: Warehouse[];
  search: string;
  setSearch: (s: string) => void;
}) => {
  // Owner 2026-07-25 — filter on the MRP-derived split (assigned / free) and a
  // Dead-stock view (free un-assigned OWNED stock), not the hard reservation.
  const [statusFilter, setStatusFilter] = useState<'all' | 'ASSIGNED' | 'FREE' | 'DEAD'>('all');
  const { data, isLoading, error } = useInventoryReservations({
    warehouseId: warehouseId ?? undefined,
  });
  const all: InventoryReservation[] = useMemo(() => data ?? [], [data]);

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => all.filter((r) => {
    if (statusFilter === 'ASSIGNED' && lotAssignedQty(r) <= 0) return false;
    if (statusFilter === 'FREE' && lotFreeQty(r) <= 0) return false;
    if (statusFilter === 'DEAD' && !(r.is_dead_stock ?? (!r.is_consignment && lotFreeQty(r) > 0))) return false;
    if (!q) return true;
    return r.item_code.toLowerCase().includes(q) ||
      (r.product_name ?? '').toLowerCase().includes(q) ||
      (r.batch_no ?? '').toLowerCase().includes(q) ||
      (r.mrp_assigned_to ?? []).some((x) => x.doc_no.toLowerCase().includes(q)) ||
      (r.reserved_by ?? []).some((x) => x.doc_no.toLowerCase().includes(q));
  }), [all, q, statusFilter]);

  const stats = useMemo(() => ({
    assignedQty: rows.reduce((s, r) => s + lotAssignedQty(r), 0),
    freeQty: rows.reduce((s, r) => s + lotFreeQty(r), 0),
    // Dead stock = free un-assigned units on OWNED lots (consignment excluded).
    deadQty: rows.reduce((s, r) => s + ((r.is_dead_stock ?? (!r.is_consignment && lotFreeQty(r) > 0)) ? lotFreeQty(r) : 0), 0),
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
            {w.code}
          </button>
        ))}
      </div>

      <div className={STAT_GRID_3}>
        <StatCard label="Assigned to SO (MRP)" value={fmtQty(stats.assignedQty)} pending={isLoading} />
        <StatCard label="Free (no order)" value={fmtQty(stats.freeQty)} pending={isLoading} />
        <StatCard label="Dead-stock candidate" value={fmtQty(stats.deadQty)} pending={isLoading} />
      </div>

      <div className={styles.warehouseChips} style={{ marginTop: 'var(--space-3)' }}>
        {([
          { value: 'all' as const, label: 'All' },
          { value: 'ASSIGNED' as const, label: 'Assigned' },
          { value: 'FREE' as const, label: 'Free (no order)' },
          { value: 'DEAD' as const, label: 'Dead stock' },
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
        {isLoading ? 'Loading…' : `${rows.length} open lot${rows.length === 1 ? '' : 's'} · ASSIGNED = MRP allocates on-hand stock to a Sales Order; FREE (un-assigned) stock is a dead-stock candidate, abnormal for make-to-order (SOFA/BEDFRAME)`}
      </p>

      {error && !isLoading && (
        <div className={BANNER_ERR}>
          <strong className="font-semibold">Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      {/* Batch 2: DataTable. Row identity includes the loop index in the old
          markup because (warehouse, product, variant, batch) can repeat across
          lots — keep the same composite via list position lookup. */}
      <DataTable<InventoryReservation>
        tableId="inventory-reservations"
        layoutFamily="inventory-reservations"
        exportName="inventory-reservations"
        rows={isLoading ? null : rows}
        loading={isLoading}
        emptyLabel="No open lots match the filters."
        getRowKey={(r) => `${r.warehouse_id}|${r.item_code}|${r.variant_key}|${r.batch_no ?? ''}|${rows.indexOf(r)}`}
        columns={[
          { key: 'status', label: 'Assigned / Free', width: '150px', getValue: (r) => (lotAssignedQty(r) > 0 ? 'assigned' : 'free'), render: (r) => renderAssignedFreeStatus(r) },
          {
            key: 'product', label: 'Product', width: '240px',
            getValue: (r) => `${r.item_code} ${r.product_name ?? ''}`,
            render: (r) => (
              <>
                <div>
                  <Link
                    to={`/scm/inventory/stock-card/${encodeURIComponent(r.item_code)}`}
                    className={styles.codeChip}
                    style={{ textDecoration: 'none' }}
                  >
                    {r.item_code}
                  </Link>
                </div>
                <div className={styles.numCellZero} style={{ fontSize: 'var(--fs-11)' }}>
                  {r.product_name ?? '—'}
                  {r.variant_key ? ` · ${formatVariantKey(r.variant_key) || 'Standard'}` : ''}
                </div>
              </>
            ),
          },
          { key: 'warehouse', label: 'Warehouse', width: '120px', getValue: (r) => r.warehouse_code ?? r.warehouse_name ?? '—', render: (r) => r.warehouse_code ?? r.warehouse_name ?? '—' },
          { key: 'batch', label: 'Batch', width: '140px', getValue: (r) => r.batch_no ?? '', render: (r) => <span className={styles.numCellZero}>{r.batch_no ?? '—'}</span> },
          {
            key: 'qty', label: 'Qty on Shelf', align: 'right', width: '110px',
            getValue: (r) => r.qty_remaining,
            render: (r) => (
              <span className={`${styles.numCell} ${r.qty_remaining > 0 ? styles.numCellPos : styles.numCellZero}`}>
                {fmtQty(r.qty_remaining)}
              </span>
            ),
          },
          {
            key: 'assigned', label: 'Assigned SO · Qty · Delivery', disableSort: true,
            getValue: (r) => (r.mrp_assigned_to ?? []).map((x) => x.doc_no).join(' '),
            render: (r) => renderAssignedFor(r),
          },
          {
            key: 'since', label: 'Reserved Since', width: '120px',
            getValue: (r) => r.reserved_since ?? '9999-12-31',
            render: (r) => (
              <span className={styles.numCellZero} title={r.reserved_since ?? undefined}>
                {r.reserved_since ? fmtAgeDays(r.reserved_since) : '—'}
              </span>
            ),
          },
        ] satisfies Column<InventoryReservation>[]}
      />
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
  const movements = useInventoryMovements({ itemCode: code });
  const cogs = useCogsEntries({ itemCode: code });
  const warehouses = useWarehouses();
  /* ONE per-lot feed (GET /inventory/reservations) powers the whole merged
     breakdown: each open lot with its warehouse, attributes, qty, unit cost,
     SOURCE doc (GRN / PCR), received date, reservation status + reserving SO(s)
     and that SO's delivery date. Owned vs consignment is split by the lot's
     SOURCE server-side (never the warehouse flag). Narrowed to this SKU. */
  const reservations = useInventoryReservations({ itemCode: code });

  /* Movements + COGS sections are collapsed by default (Commander 2026-05-30).
     Operator opens what they want to see — keeps the drawer scannable. */
  const [movementsOpen, setMovementsOpen] = useState(false);
  const [cogsOpen, setCogsOpen] = useState(false);

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

  /* CONSIGNMENT stock is held but NOT owned: its quantity shows, but it stays
     OUT of inventory VALUE (owner rule). The split is by each lot's SOURCE (a
     Purchase Consignment Receive fed it) — NEVER the warehouse flag, which
     leaked PCR stock mis-posted into a normal warehouse into owned value
     (BUG-HISTORY 2026-07-25). buildStockBreakdown is the SAME transform the
     mobile Stock Card uses — one logic layer, two presentations. */
  const lotRows = useMemo(() => reservations.data ?? [], [reservations.data]);
  const bd = useMemo(() => buildStockBreakdown(lotRows), [lotRows]);
  const breakdownPending = reservations.data === undefined || Boolean(reservations.error);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 50,
        display: 'flex', justifyContent: 'flex-end',
      }}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-[920px] max-w-[96vw] overflow-auto bg-bg p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 className="font-display text-[18px] font-extrabold leading-tight tracking-tight text-ink">Stock Breakdown</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">
              <span className={styles.codeChip}>{code}</span> {name}
            </p>
          </div>
          <button type="button" className={styles.chip} onClick={onClose}>
            <X {...ICON} />
            <span>Close</span>
          </button>
        </div>

        <div className={`mt-4 grid gap-2.5 ${bd.consignmentQty !== 0 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'}`}>
          {/* The totals reduce over the lot feed, which is [] until it resolves —
              so a confident "RM 0.00" before load would be a lie the operator can
              act on. Unknown until it is known. */}
          <StatCard label="Total Qty (owned)" value={fmtQty(bd.ownedQty)} pending={breakdownPending} />
          {/* Owner 2026-07-25 — the assigned/free split from the ONE MRP engine.
              Free (un-assigned) OWNED stock is the dead-stock slice; for a
              make-to-order SKU it is abnormal (emphasised in the lot rows). */}
          <StatCard
            label="Assigned / Free (owned)"
            value={`${fmtQty(bd.ownedAssignedQty)} / ${fmtQty(bd.ownedFreeQty)}`}
            pending={breakdownPending}
          />
          {bd.consignmentQty !== 0 && (
            <StatCard label="Consignment Qty (not owned)" value={fmtQty(bd.consignmentQty)} pending={breakdownPending} />
          )}
          {/* Value is OWNED stock only — consignment is excluded by SOURCE. */}
          <StatCard label="Total Value (owned)" value={fmtRm(bd.ownedValueSen)} pending={breakdownPending} />
        </div>
        {/* Dead-stock banner: free make-to-order (SOFA/BEDFRAME) on-hand stock is
            abnormal (built against an SO), so surface it prominently. Soft/absent
            for make-to-stock. */}
        {!breakdownPending && bd.ownedFreeQty > 0 && bd.ownedLots.some((l) => (l.make_to_order ?? isMakeToOrderCategory(l.category)) && lotFreeQty(l) > 0) && (
          <div className="mt-3 rounded-lg border border-err/40 bg-err/10 px-4 py-2.5 text-[13px] text-err">
            <strong className="font-semibold">Dead-stock candidate.</strong>{' '}
            {fmtQty(bd.ownedFreeQty)} free (un-assigned) unit{bd.ownedFreeQty === 1 ? '' : 's'} on hand — this is a make-to-order SKU, so free stock has no Sales Order claiming it.
          </div>
        )}

        {/* ── ONE merged per-lot table (owner request). The old "Stock by
            Warehouse", "FIFO Lots" and "Reserved for Sales Orders" tables shared
            warehouse / attributes / qty / cost and repeated them 3×. This is the
            SKU's real open-lot buckets in FIFO order (oldest received first — the
            next DO consumes them top-down), each row carrying its SOURCE doc
            (GRN / PCR), reservation status + reserving SO(s) and that SO's
            delivery date. Owned and consignment lots are separated; consignment
            is excluded from the owned value subtotal. The drawer body is the ONE
            scroll container (no nested-scroll jank); the wide table scrolls
            sideways inside its own card for long lists. */}
        <p className={styles.eyebrow} style={{ marginTop: 'var(--space-4)' }}>
          Stock Lots (oldest first — consumed first on the next DO)
        </p>
        <div className={`${styles.tableCard} ${styles.drawerScroll}`}>
          <table className={`${styles.table} ${styles.compactTable} ${styles.lotTable}`}>
            <thead>
              <tr>
                <th>Warehouse</th>
                <th>Attributes</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Unit Cost</th>
                <th style={{ textAlign: 'right' }}>Value</th>
                <th>Source</th>
                <th>Received</th>
                <th>Assigned SO &middot; Qty &middot; Delivery</th>
                <th>Assigned / Free</th>
              </tr>
            </thead>
            <tbody>
              {reservations.isLoading && <tr><td colSpan={9} className={styles.emptyRow}>Loading…</td></tr>}
              {!reservations.isLoading && lotRows.length === 0 && (
                <tr><td colSpan={9} className={styles.emptyRow}>No open lots for this SKU.</td></tr>
              )}

              {/* OWNED lots — counted in the value subtotal + header Total Value. */}
              {!reservations.isLoading && bd.ownedLots.map((r, i) => {
                const attrs = formatVariantKey(r.variant_key, r.fabric_supplier_code);
                const value = (r.qty_remaining ?? 0) * (r.unit_cost_sen ?? 0);
                return (
                  <tr key={r.id ?? `own|${r.warehouse_id}|${r.variant_key}|${r.batch_no ?? ''}|${i}`}>
                    {/* SHORT code-name everywhere (owner rule; BUG-HISTORY #63). */}
                    <td>{r.warehouse_code ?? r.warehouse_name ?? '—'}</td>
                    <td>{attrs || <span className={styles.numCellZero}>Standard</span>}</td>
                    <td className={`${styles.numCell} ${r.qty_remaining > 0 ? styles.numCellPos : styles.numCellZero}`}>{fmtQty(r.qty_remaining)}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{r.unit_cost_sen > 0 ? fmtRm(r.unit_cost_sen) : '—'}</td>
                    <td className={styles.numCell} style={{ fontWeight: 700 }}>{value > 0 ? fmtRm(value) : '—'}</td>
                    {/* SOURCE — the GRN (or PCR/adjustment) that fed this lot. A
                        GRN-sourced lot also traces to its originating PO. */}
                    <td className={styles.numCellZero}>
                      {r.source_doc_no ?? '—'}
                      {r.source_po_no && <span className={styles.sourcePo}>from {r.source_po_no}</span>}
                    </td>
                    <td className={styles.numCellZero}>{r.received_at ? fmtDate(r.received_at) : '—'}</td>
                    <td>{renderAssignedFor(r)}</td>
                    <td>{renderAssignedFreeStatus(r)}</td>
                  </tr>
                );
              })}

              {/* Owned value subtotal — what the header "Total Value (owned)" sums. */}
              {!reservations.isLoading && bd.ownedLots.length > 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'right', fontWeight: 700 }}>Owned value subtotal</td>
                  <td className={styles.numCell} style={{ fontWeight: 800 }}>{fmtRm(bd.ownedValueSen)}</td>
                  <td colSpan={4} />
                </tr>
              )}

              {/* CONSIGNMENT lots — held here but NOT owned: value shows "—" and
                  stays OUT of the owned subtotal + Total Value. Identified by the
                  lot's SOURCE (a PC Receive fed it), never the warehouse flag —
                  so a PCR mis-posted into a normal warehouse is still separated
                  (BUG-HISTORY 2026-07-25). */}
              {!reservations.isLoading && bd.consignmentLots.length > 0 && (
                <tr>
                  <td colSpan={9} style={{ paddingTop: 'var(--space-3)' }}>
                    <span className={styles.eyebrow}>Consignment — held, not owned (excluded from value)</span>
                  </td>
                </tr>
              )}
              {!reservations.isLoading && bd.consignmentLots.map((r, i) => {
                const attrs = formatVariantKey(r.variant_key, r.fabric_supplier_code);
                return (
                  <tr key={r.id ?? `con|${r.warehouse_id}|${r.variant_key}|${r.batch_no ?? ''}|${i}`}>
                    <td>
                      {r.warehouse_code ?? r.warehouse_name ?? '—'}
                      <span className={`${styles.movementPill} ${styles.movementAdj}`} style={{ marginLeft: 6 }}>Consignment</span>
                    </td>
                    <td>{attrs || <span className={styles.numCellZero}>Standard</span>}</td>
                    <td className={`${styles.numCell} ${r.qty_remaining > 0 ? styles.numCellPos : styles.numCellZero}`}>{fmtQty(r.qty_remaining)}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{r.unit_cost_sen > 0 ? fmtRm(r.unit_cost_sen) : '—'}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`} title="Consignment stock is excluded from inventory value.">—</td>
                    <td className={styles.numCellZero}>
                      {r.source_doc_no ?? '—'}
                      {r.source_po_no && <span className={styles.sourcePo}>from {r.source_po_no}</span>}
                    </td>
                    <td className={styles.numCellZero}>{r.received_at ? fmtDate(r.received_at) : '—'}</td>
                    <td>{renderAssignedFor(r)}</td>
                    <td>{renderAssignedFreeStatus(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

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
          <div className={`${styles.tableCard} ${styles.drawerScroll}`}>
            <table className={`${styles.table} ${styles.compactTable}`}>
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
          <div className={`${styles.tableCard} ${styles.drawerScroll}`}>
            <table className={`${styles.table} ${styles.compactTable}`}>
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
    itemCode: search.trim() || undefined,
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

      {/* Batch 2: DataTable — the append-only ledger, newest first from the
          server (no default sort). */}
      <DataTable<InventoryMovement>
        tableId="inventory-movements"
        layoutFamily="inventory-movements"
        exportName="inventory-movements"
        rows={isLoading ? null : movements}
        loading={isLoading}
        emptyLabel="No movements match the filters."
        getRowKey={(m) => m.id}
        columns={[
          { key: 'when', label: 'When', width: '150px', getValue: (m) => m.created_at, render: (m) => <span className={styles.numCellZero}>{fmtDateTime(m.created_at)}</span> },
          {
            key: 'type', label: 'Type', width: '110px',
            getValue: (m) => m.movement_type,
            render: (m) => (
              <span className={`${styles.movementPill} ${
                m.movement_type === 'IN' ? styles.movementIn
                : m.movement_type === 'OUT' ? styles.movementOut
                : styles.movementAdj}`}>
                {m.movement_type === 'IN' && <ArrowDownLeft size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                {m.movement_type === 'OUT' && <ArrowUpRight size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                {m.movement_type}
              </span>
            ),
          },
          { key: 'warehouse', label: 'Warehouse', width: '110px', getValue: (m) => wmap.get(m.warehouse_id)?.code ?? '—', render: (m) => wmap.get(m.warehouse_id)?.code ?? '—' },
          {
            key: 'product', label: 'Product', width: '200px',
            getValue: (m) => `${m.item_code} ${m.product_name ?? ''}`,
            render: (m) => (
              <>
                <div><span className={styles.codeChip}>{m.item_code}</span></div>
                <div className={styles.numCellZero} style={{ fontSize: 'var(--fs-11)' }}>{m.product_name ?? '—'}</div>
              </>
            ),
          },
          {
            key: 'qty', label: 'Qty', align: 'right', width: '90px',
            getValue: (m) => (m.movement_type === 'OUT' ? -Math.abs(m.qty) : Math.abs(m.qty)),
            render: (m) => (
              <span className={`${styles.numCell} ${m.movement_type === 'IN' ? styles.numCellPos : styles.numCellNeg}`}>
                {m.movement_type === 'IN' ? '+' : m.movement_type === 'OUT' ? '−' : ''}
                {fmtQty(Math.abs(m.qty))}
              </span>
            ),
          },
          { key: 'unitCost', label: 'Unit Cost', align: 'right', width: '100px', getValue: (m) => (m.unit_cost_sen ?? 0) / 100, render: (m) => <span className={`${styles.numCell} ${styles.numCellZero}`}>{m.unit_cost_sen && m.unit_cost_sen > 0 ? fmtRm(m.unit_cost_sen) : '—'}</span> },
          { key: 'lineCost', label: 'Line Cost', align: 'right', width: '110px', getValue: (m) => (m.total_cost_sen ?? 0) / 100, render: (m) => <span className={`${styles.numCell} ${styles.numCellZero}`}>{m.total_cost_sen && m.total_cost_sen > 0 ? fmtRm(m.total_cost_sen) : '—'}</span> },
          {
            key: 'source', label: 'Source Doc', width: '140px',
            getValue: (m) => m.source_doc_no ?? '',
            render: (m) => {
              if (!m.source_doc_no) return <span className={styles.numCellZero}>—</span>;
              const href = docHrefFor(m);
              return href
                ? <Link to={href} className={styles.docLink}>{m.source_doc_no}</Link>
                : <span className={styles.docLink}>{m.source_doc_no}</span>;
            },
          },
          { key: 'reason', label: 'Reason', width: '130px', getValue: (m) => (m.reason_code ? adjustmentReasonLabel(m.reason_code) : ''), render: (m) => <span className={styles.numCellZero}>{m.reason_code ? adjustmentReasonLabel(m.reason_code) : '—'}</span> },
          { key: 'notes', label: 'Notes', getValue: (m) => m.notes ?? '', render: (m) => <span className={`${styles.numCellZero} ${styles.notesCell}`} title={m.notes ?? ''}>{m.notes ?? '—'}</span> },
        ] satisfies Column<InventoryMovement>[]}
      />
    </>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   COGS tab — FIFO consumption stream
   ════════════════════════════════════════════════════════════════════════ */
export const CogsTab = ({
  warehouseId, search,
}: {
  warehouseId: string | null;
  search: string;
}) => {
  const { data, isLoading, isError, error } = useCogsEntries({
    warehouseId: warehouseId ?? undefined,
    itemCode: search.trim() || undefined,
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
          /* Sum over an empty-because-unloaded list. RM 0.00 for "we have not
             fetched the consumptions yet" is a lie the operator can act on —
             and `isLoading` is FALSE after a FAILED fetch, which is the other
             way this list is empty for a reason unrelated to cost of goods. */
          pending={isLoading || isError}
        />
      </div>

      <p className={styles.eyebrow} style={isError ? { color: 'var(--c-festive-b, #B8331F)' } : undefined}>
        {isLoading ? 'Loading…'
          : isError ? `Not loaded — the COGS entries could not be read, which is not the same as there being none. ${error instanceof Error ? error.message : ''}`
          : `${cogs.length} consumption entries`}
      </p>

      {/* Batch 2: DataTable. The icon-decorated empty state flattens to the
          shared emptyLabel sentence (same trade every converted page made). */}
      <DataTable<CogsEntry>
        tableId="inventory-cogs"
        layoutFamily="inventory-cogs"
        exportName="inventory-cogs"
        rows={isLoading || isError ? null : cogs}
        loading={isLoading}
        emptyLabel={isError ? 'The COGS entries could not be loaded.'
          : 'No COGS entries yet — COGS is auto-posted when a DO or Purchase Return consumes a lot.'}
        getRowKey={(c) => c.id}
        columns={[
          { key: 'when', label: 'When', width: '150px', getValue: (c) => c.consumed_at, render: (c) => <span className={styles.numCellZero}>{fmtDateTime(c.consumed_at)}</span> },
          { key: 'warehouse', label: 'Warehouse', width: '110px', getValue: (c) => c.warehouse_code, render: (c) => c.warehouse_code },
          { key: 'product', label: 'Product', width: '160px', getValue: (c) => c.item_code, render: (c) => <span className={styles.codeChip}>{c.item_code}</span> },
          { key: 'qty', label: 'Qty', align: 'right', width: '90px', getValue: (c) => -c.qty_consumed, render: (c) => <span className={`${styles.numCell} ${styles.numCellNeg}`}>−{fmtQty(c.qty_consumed)}</span> },
          { key: 'unitCost', label: 'Unit Cost', align: 'right', width: '100px', getValue: (c) => c.unit_cost_sen / 100, render: (c) => <span className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(c.unit_cost_sen)}</span> },
          { key: 'cogs', label: 'COGS', align: 'right', width: '110px', getValue: (c) => c.total_cost_sen / 100, render: (c) => <span className={styles.numCell} style={{ fontWeight: 700 }}>{fmtRm(c.total_cost_sen)}</span> },
          { key: 'doc', label: 'Doc', width: '140px', getValue: (c) => c.source_doc_no ?? '', render: (c) => c.source_doc_no ? <span className={styles.docLink}>{c.source_doc_no}</span> : '—' },
          {
            key: 'lot', label: 'Lot Received', width: '200px',
            getValue: (c) => c.lot_received_at,
            render: (c) => (
              <span className={styles.numCellZero}>
                {fmtDateTime(c.lot_received_at)}{c.lot_source_doc_no ? ` · ${c.lot_source_doc_no}` : ''}
              </span>
            ),
          },
        ] satisfies Column<CogsEntry>[]}
      />
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

      {/* Batch 2: DataTable. */}
      <DataTable<Warehouse>
        tableId="inventory-warehouses"
        layoutFamily="inventory-warehouses"
        exportName="warehouses"
        rows={warehouses.isLoading ? null : (warehouses.data ?? [])}
        loading={warehouses.isLoading}
        emptyLabel="No warehouses yet."
        getRowKey={(w) => w.id}
        columns={[
          { key: 'code', label: 'Code', width: '150px', getValue: (w) => w.code, render: (w) => <span className={styles.codeChip}>{w.code}</span> },
          { key: 'name', label: 'Name', getValue: (w) => w.name, render: (w) => w.name },
          { key: 'location', label: 'Location', getValue: (w) => w.location ?? '', render: (w) => <span className={styles.numCellZero}>{w.location ?? '—'}</span> },
          { key: 'default', label: 'Default', width: '90px', getValue: (w) => (w.is_default ? 1 : 0), render: (w) => w.is_default ? <Star size={12} strokeWidth={2} className="fill-primary text-primary" /> : '—' },
          {
            key: 'status', label: 'Status', width: '110px',
            getValue: (w) => (w.is_active ? 'Active' : 'Inactive'),
            render: (w) => (
              <span className={`${styles.movementPill} ${w.is_active ? styles.movementIn : styles.movementAdj}`}>
                {w.is_active ? 'Active' : 'Inactive'}
              </span>
            ),
          },
          {
            key: 'actions', label: '', width: '90px', disableSort: true,
            getValue: () => '',
            render: (w) => <Button variant="ghost" onClick={() => setEditing(w)}>Edit</Button>,
          },
        ] satisfies Column<Warehouse>[]}
      />

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

