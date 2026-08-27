// Consignment Notes list — DataGrid clone of the Delivery Orders list
// (MfgDeliveryOrdersList.tsx), which is itself an SO-clone. Same chrome:
// 4 KPI tiles, shared ColumnFilterBar (quick search + add-a-column filters),
// status chips, ~visible/hidden column set, right-click context menu,
// click-to-expand line drill-down, and double-click-to-open. Wired to the
// consignment-note list hook + the parallel /consignment-notes API.
//
// The DO-specific "From Sales Order" toolbar button and the SI / DR convert
// menu entries are intentionally DROPPED — a consignment note is free-entry.
//
// UNIQUE localStorage keys ('pr-g.cn-list.layout.v1' /
// 'pr-g.cn-list.filters.v1') — never reuse the DO/SO/DR keys.

import { useEffect, useMemo, useState } from 'react';
import { canViewScmCosting } from "../../auth/salesAccess";
import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary, fmtQty } from '@2990s/shared';
import {
  useConsignmentNotesPaged, useUpdateConsignmentNoteStatus, useConsignmentNoteDetail,
} from '../../vendor/scm/lib/consignment-note-queries';
import { SearchProgress } from '../../components/SearchProgress';
import { ListPager } from '../../components/ListPager';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useDebouncedSearchTerm, useSearchResultTransition } from '../../hooks/useServerSearch';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { useAuth } from '../../auth/AuthContext';
import { BrandingPill, badgeFor } from '../../vendor/scm/lib/category-badges';
import styles from './MfgSalesOrdersList.module.css';
import soDetailStyles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { FilterPills } from '../../components/FilterPills';

/* ── Row shape (CN header — mirrors the DO header) ─────────────────────── */
type CnRow = {
  id: string;
  do_number: string;
  do_date: string;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  sales_location: string | null;
  ref: string | null;
  customer_so_no: string | null;
  branding: string | null;
  venue: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  building_type: string | null;
  address1: string | null;
  address2: string | null;
  customer_state: string | null;
  customer_country: string | null;
  city: string | null;
  postcode: string | null;
  driver_name: string | null;
  vehicle: string | null;
  local_total_sen: number;
  mattress_sofa_sen?: number;
  bedframe_sen?: number;
  accessories_sen?: number;
  others_sen?: number;
  total_cost_sen?: number;
  total_margin_sen?: number;
  status: string;
  currency: string;
  note: string | null;
  line_count?: number;
};

const fmtRm = (centi: number): string =>
  (centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const compactDate = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}/${m[2]}/${m[3]}`;
};

const STATUS_CLASS: Record<string, string> = {
  LOADED:      soDetailStyles.statusConfirmed ?? '',
  DISPATCHED:  soDetailStyles.statusShipped ?? '',
  IN_TRANSIT:  soDetailStyles.statusInProd ?? '',
  SIGNED:      soDetailStyles.statusReady ?? '',
  DELIVERED:   soDetailStyles.statusDelivered ?? '',
  INVOICED:    soDetailStyles.statusInvoiced ?? '',
  RETURNED:    soDetailStyles.statusReturned ?? '',
  CANCELLED:   soDetailStyles.statusCancelled ?? '',
};
const STATUS_LABEL: Record<string, string> = {
  LOADED:     'Confirmed',
  DISPATCHED: 'Loaded',
  IN_TRANSIT: 'In Transit',
  SIGNED:     'Signed',
  DELIVERED:  'Delivered',
  INVOICED:   'Invoiced',
  RETURNED:   'Returned',
  CANCELLED:  'Cancelled',
};
const STATUS_CHIPS = ['all', 'DISPATCHED', 'DELIVERED', 'CANCELLED'] as const;

const StatusPill = ({ status }: { status: string }) => (
  <span className={`${soDetailStyles.statusPill} ${STATUS_CLASS[status] ?? ''}`}>
    {STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
  </span>
);

const deriveBranding = (r: CnRow): string => r.branding ?? '';

/* ── Drilldown — per-line breakdown for one CN, mirrors ExpandedDoLines ─── */
type CnItem = {
  id: string;
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  variants: Record<string, unknown> | null;
  uom: string | null;
  qty: number | null;
  unit_price_sen: number | null;
  unit_cost_sen: number | null;
  line_cost_sen: number | null;
  line_margin_sen: number | null;
  line_total_sen: number | null;
};

const CategoryPill = ({ group }: { group: string | null | undefined }) => {
  const spec = badgeFor(group);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 999,
      background: spec.bg, color: spec.fg, fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
      fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      {spec.label}
    </span>
  );
};

const cnLineTotalOf = (it: CnItem): number => Number(it.line_total_sen ?? 0);
const cnLineCostOf = (it: CnItem): number =>
  it.line_cost_sen != null
    ? Number(it.line_cost_sen)
    : Number(it.qty ?? 0) * Number(it.unit_cost_sen ?? 0);
const cnLineMarginOf = (it: CnItem): number =>
  it.line_margin_sen != null
    ? Number(it.line_margin_sen)
    : cnLineTotalOf(it) - cnLineCostOf(it);

/* canFinance — the finance-viewer gate (auth/me = isFinanceViewer, the same
   signal the SO/DO/SI/DR surfaces use, #574/#589). The cost/margin columns are
   only DECLARED for a finance-viewer: off, not hidden — no column, no "—"
   placeholder, no RM 0.00. The backend also omits the keys from the payload
   (canViewScmFinance), so rendering them for a non-finance user could only ever
   print zeros. */
const buildCnDrilldownColumns = (canFinance: boolean): DataGridColumn<CnItem>[] => [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <CategoryPill group={it.item_group} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f' }}>{it.item_code ?? '—'}</span>,
    searchValue: (it) => it.item_code ?? '',
    sortFn: (a, b) => (a.item_code ?? '').localeCompare(b.item_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 240, minWidth: 180,
    accessor: (it) => {
      const manual = (it.description ?? '').trim();
      if (manual) return <div>{manual}</div>;
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : '—';
    },
    searchValue: (it) => `${it.description ?? ''} ${buildVariantSummary(it.item_group, it.variants)}`.trim(),
  },
  {
    key: 'description2', label: 'Description 2', width: 220, minWidth: 160,
    accessor: (it) => {
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group, it.variants),
  },
  {
    key: 'uom', label: 'UOM', width: 70,
    accessor: (it) => it.uom || 'UNIT',
    searchValue: (it) => it.uom || 'UNIT',
  },
  {
    key: 'qty', label: 'Qty', width: 60, align: 'right',
    accessor: (it) => it.qty ?? 0,
    searchValue: (it) => String(it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 100, align: 'right',
    accessor: (it) => fmtRm(Number(it.unit_price_sen ?? 0)),
    searchValue: (it) => String(it.unit_price_sen ?? 0),
    sortFn: (a, b) => Number(a.unit_price_sen ?? 0) - Number(b.unit_price_sen ?? 0),
  },
  {
    key: 'total', label: 'Total', width: 100, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f' }}>{fmtRm(cnLineTotalOf(it))}</span>,
    searchValue: (it) => String(cnLineTotalOf(it)),
    sortFn: (a, b) => cnLineTotalOf(a) - cnLineTotalOf(b),
  },
  ...(canFinance
    ? ([
        {
          key: 'unit_cost', label: 'Unit Cost', width: 100, align: 'right',
          accessor: (it) => fmtRm(Number(it.unit_cost_sen ?? 0)),
          searchValue: (it) => String(it.unit_cost_sen ?? 0),
          sortFn: (a, b) => Number(a.unit_cost_sen ?? 0) - Number(b.unit_cost_sen ?? 0),
        },
        {
          key: 'line_cost', label: 'Line Cost', width: 100, align: 'right',
          accessor: (it) => fmtRm(cnLineCostOf(it)),
          searchValue: (it) => String(cnLineCostOf(it)),
          sortFn: (a, b) => cnLineCostOf(a) - cnLineCostOf(b),
        },
        {
          key: 'margin', label: 'Margin', width: 100, align: 'right',
          accessor: (it) => {
            const m = cnLineMarginOf(it);
            const c = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
            return <span style={{ color: c, fontWeight: 600 }}>{fmtRm(m)}</span>;
          },
          searchValue: (it) => String(cnLineMarginOf(it)),
          sortFn: (a, b) => cnLineMarginOf(a) - cnLineMarginOf(b),
        },
      ] as DataGridColumn<CnItem>[])
    : []),
];

const ExpandedCnLines = ({ id, canFinance }: { id: string; canFinance: boolean }) => {
  const q = useConsignmentNoteDetail(id);
  if (q.isLoading) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>Loading lines…</div>;
  }
  if (q.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)' }}>
        Failed to load lines: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const items = (q.data?.items ?? []) as CnItem[];
  if (items.length === 0) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>No line items.</div>;
  }
  let totalSen = 0, costSen = 0;
  for (const it of items) {
    totalSen += cnLineTotalOf(it);
    costSen  += Number(it.line_cost_sen ?? 0);
  }
  const marginSen = totalSen - costSen;
  const marginColor = marginSen > 0 ? 'var(--c-secondary-a, #2F5D4F)'
    : marginSen < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';

  const columns = buildCnDrilldownColumns(canFinance);

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<CnItem>
        rows={items}
        columns={columns}
        storageKey="cn-drilldown-grid.v1"
        rowKey={(it) => it.id}
        embedded
        groupBanner={false}
      />
      <div style={{
        display: 'flex', gap: 'var(--space-4)', justifyContent: 'flex-end',
        alignItems: 'baseline', padding: '8px 8px 2px',
        fontSize: 'var(--fs-11)', fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)',
      }}>
        <span style={{
          fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Subtotal</span>
        <span>Total <strong style={{ color: '#16695f' }}>{fmtRm(totalSen)}</strong></span>
        {canFinance && <span>Line Cost <strong style={{ color: 'var(--c-ink)' }}>{fmtRm(costSen)}</strong></span>}
        {canFinance && <span>Margin <strong style={{ color: marginColor }}>{fmtRm(marginSen)}</strong></span>}
      </div>
    </div>
  );
};

const STORAGE_KEY = 'pr-g.cn-list.layout.v1';

export const ConsignmentNotes = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  /* Finance-viewer gate — same signal the SO/DO/SI/DR surfaces use
     (auth/me = isFinanceViewer, #574 / #589). Consignment never got this gate:
     the three consignment routes declared no finance keys at all and all six
     consignment pages rendered cost/margin to everyone. */
  const { user } = useAuth();
  const canFinance = canViewScmCosting(user);

  const [pageSize, setPageSize] = useLocalStorage<number>('scm:perpage:consignment-notes', 50);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  // Debounce the search box so each keystroke doesn't fire a server round-trip.
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  /* Server-side pagination + search (mirrors Suppliers.tsx). Status chip +
     free-text search drive the SERVER query; reset to page 0 whenever either
     changes so we never strand the operator on an out-of-range page. */
  useEffect(() => { setPage(0); }, [statusChip, debouncedSearch]);

  const { data, isLoading, isFetching, isPlaceholderData, error } = useConsignmentNotesPaged({
    page,
    pageSize: pageSize,
    status: statusChip === 'all' ? undefined : statusChip,
    q: debouncedSearch.trim() || undefined,
  });
  const searchTransition = useSearchResultTransition({
    inputTerm: search,
    requestTerm: debouncedSearch,
    isFetching,
    isPlaceholderData,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  const listLoading = isLoading || searchTransition.isSearching;

  /* Server page rows + grand total. Status + search are resolved server-side;
     the DataGrid's own per-column funnel filters + grouping now operate on the
     LOADED PAGE only (documented reduction). The KPI tiles below stay FULL-SET
     via `aggregates`, so page-scoped funnels never distort the headline money. */
  const rows = useMemo<CnRow[]>(() => (data?.deliveryOrders ?? []) as CnRow[], [data]);
  const total = data?.total ?? 0;

  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  // Row-click multi-select (mirrors the DO / GRN lists) — ticks the row; the
  // ▸ chevron still drills down via its own stopPropagation handler.
  const [sel, setSel] = useState<Set<string>>(new Set());
  /* Clear the selection whenever the visible row set shifts (page / status /
     search) — a lingering selection would act on rows no longer on screen. */
  useEffect(() => { setSel(new Set()); }, [page, statusChip, debouncedSearch]);

  /* KPI tiles — FULL-SET via the server `aggregates` (summed over the same
     status + search filters as the page). Defensive fallback: if aggregates is
     absent (old backend / mid-deploy) sum the loaded page and flag it.
     Cost / Margin resolve to 0 for a non-finance viewer (the server omits both
     the aggregate and the row keys) — their tiles are not rendered at all, so
     the zeros never reach the page. */
  const kpis = useMemo(() => {
    const agg = data?.aggregates;
    if (agg) return { revenue: agg.revenueSen, cost: agg.costSen ?? 0, margin: agg.marginSen ?? 0, fullSet: true };
    let revenue = 0, cost = 0, margin = 0;
    for (const r of rows) {
      revenue += r.local_total_sen ?? 0;
      cost += r.total_cost_sen ?? 0;
      margin += r.total_margin_sen ?? 0;
    }
    return { revenue, cost, margin, fullSet: false };
  }, [data?.aggregates, rows]);

  const staffQ = useStaff();
  const staffById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (staffQ.data ?? [])) if (s.id) m.set(s.id, s.name ?? s.staffCode ?? s.id);
    return m;
  }, [staffQ.data]);
  const COLUMNS = useMemo(() => buildColumns(staffById, canFinance), [staffById, canFinance]);

  const updateStatus = useUpdateConsignmentNoteStatus();

  const onNew = () => navigate('/scm/consignment-notes/new');
  const openDetail = (row: CnRow, edit = false) =>
    navigate(`/scm/consignment-notes/${row.id}${edit ? '?edit=1' : ''}`);

  const doCancel = async (row: CnRow) => {
    if (!(await askConfirm({
      title: `Cancel consignment note ${row.do_number}?`,
      body: 'This sets status = CANCELLED.',
      confirmLabel: 'Cancel note',
      danger: true,
    }))) return;
    updateStatus.mutate({ id: row.id, status: 'CANCELLED' },
      { onError: (e) => notify({ title: 'Failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }) });
  };

  /* KPI tiles are the shared <StatCard/> now (owner 2026-07-26). */

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Supply Chain"
        title="Consignment Notes"
        actions={
          <div style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" size="sm" onClick={onNew}>
              <Plus size={14} strokeWidth={1.75} />
              <span>New Consignment Note</span>
            </Button>
          </div>
        }
      />

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      {/* SO StatCard family (owner 2026-07-26). Cost / Margin cards stay CUT
          for a non-finance viewer (off, not hidden — no card, no RM 0.00);
          the server also omits costSen / marginSen for such a caller. */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard pending={isLoading} label="Total Notes" value={fmtQty(total)} subtitle="All matching notes" rail="bg-primary" active />
        <StatCard pending={isLoading} label="Revenue" value={`RM ${fmtRm(kpis.revenue)}`} subtitle="All matching notes" rail="bg-accent" />
        {canFinance && (
          <StatCard pending={isLoading} label="Cost" value={`RM ${fmtRm(kpis.cost)}`} subtitle="Cost of goods" rail="bg-accent-bright" />
        )}
        {canFinance && (
          <StatCard
            pending={isLoading}
            label="Margin"
            value={`RM ${fmtRm(kpis.margin)}`}
            subtitle="Revenue − cost"
            tone={kpis.margin > 0 ? 'success' : kpis.margin < 0 ? 'error' : 'default'}
            rail={kpis.margin > 0 ? 'bg-synced' : kpis.margin < 0 ? 'bg-err' : 'bg-border-strong'}
          />
        )}
      </div>

      {/* Status chips + page-level search. Both drive the SERVER query (the
          DataGrid's own search is hidden via `hideSearch` so it can't silently
          filter just the loaded page). SO composition (owner 2026-07-25):
          chips on their own row, the search on the NEXT row at the LEFT -
          not squeezed to the right of the chips. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
        {/* The SO strip's own FilterPills slab (owner 2026-07-26). */}
        <FilterPills
          options={STATUS_CHIPS.map((s) => ({ value: s as string, label: s === 'all' ? 'All' : STATUS_LABEL[s] ?? s }))}
          value={statusChip}
          onChange={(v) => setStatusChip(v)}
        />
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Search size={14} strokeWidth={1.75} style={{ position: 'absolute', left: 10, color: 'var(--fg-muted)' }} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search note no / customer…"
            style={{
              height: 32, padding: '0 12px 0 30px', width: 288,
              borderRadius: 6, border: '1px solid #d6d9d2',
              background: '#ffffff', color: 'var(--c-ink)', fontSize: 12,
            }}
          />
          <SearchProgress active={searchTransition.isSearching} className="ml-2" />
        </div>
      </div>

      <DataGrid<CnRow>
        rows={searchTransition.resultsAreStale ? [] : rows}
        columns={COLUMNS}
        storageKey={STORAGE_KEY}
        exportName="Consignment Notes"
        searchPlaceholder="Search note no, customer, reference…"
        rowKey={(r) => r.id}
        selectable={{
          selectedKeys: sel,
          onToggle: (k) => setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, allSel) => setSel((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); } else { for (const k of keys) n.add(k); }
            return n;
          }),
        }}
        hideSearch
        groupBanner={false}
        onRowDoubleClick={(r) => openDetail(r)}
        rowStyle={(r) => r.status === 'CANCELLED' ? { opacity: 0.55, filter: 'grayscale(0.6)' } : undefined}
        isLoading={listLoading}
        emptyMessage='No consignment notes yet — click "New Consignment Note" to start.'
        expandable={{
          renderExpansion: (row) => <ExpandedCnLines id={row.id} canFinance={canFinance} />,
          rowExpansionKey: (row) => row.id,
        }}
        contextMenu={(row) => {
          const status = row.status;
          const items: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'Edit', onClick: () => openDetail(row, true) },
            { label: 'View', onClick: () => openDetail(row) },
            { divider: true as const },
          ];
          if (status !== 'CANCELLED') {
            items.push({ label: 'Cancel Note', danger: true, onClick: () => doCancel(row) });
          }
          if (status === 'CANCELLED') {
            items.push({
              label: 'Reopen Note',
              onClick: async () => {
                if (!(await askConfirm({
                  title: `Reopen ${row.do_number} back to LOADED?`,
                  confirmLabel: 'Reopen',
                }))) return;
                updateStatus.mutate({ id: row.id, status: 'LOADED' });
              },
            });
          }
          return items;
        }}
      />

      {!searchTransition.resultsAreStale && <ListPager
        page={page}
        pageSize={pageSize}
        total={total}
        noun="notes"
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
      />}
    </div>
  );
};

/* ── Columns — mirrors the DO list set, adapted to CN fields. ───────────── */
const buildColumns = (staffById: Map<string, string>, canFinance: boolean): DataGridColumn<CnRow>[] => [
  {
    key: 'do_number', label: 'Note No.', width: 150, sortable: true,
    accessor: (r) => (
      <span style={{ fontWeight: 700, color: '#16695f', fontVariantNumeric: 'tabular-nums' }}>{r.do_number}</span>
    ),
    searchValue: (r) => `${r.do_number} ${r.status ?? ''}`,
    filterValue: (r) => r.do_number,
    filterType: 'numbering',
  },
  {
    key: 'do_date', label: 'Date', width: 110, sortable: true,
    accessor: (r) => compactDate(r.do_date),
    searchValue: (r) => `${r.do_date ?? ''} ${compactDate(r.do_date)}`,
    sortFn: (a, b) => (a.do_date ?? '').localeCompare(b.do_date ?? ''),
    filterType: 'date', dateValue: (r) => r.do_date,
  },
  {
    key: 'debtor_name', label: 'Customer', width: 220, sortable: true, groupable: true,
    accessor: (r) => r.debtor_name,
    searchValue: (r) => r.debtor_name,
  },
  {
    key: 'salesperson_id', label: 'Salesperson', width: 140, sortable: true, groupable: true,
    accessor: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '—' : '—'),
    searchValue: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '' : ''),
    groupValue: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '(none)' : '(none)'),
  },
  {
    key: 'sales_location', label: 'Location', width: 100, sortable: true, groupable: true,
    accessor: (r) => r.sales_location ?? '—',
    searchValue: (r) => r.sales_location ?? '',
    groupValue: (r) => r.sales_location ?? '(none)',
  },
  {
    key: 'expected_delivery_at', label: 'Expected', width: 110, sortable: true,
    accessor: (r) => compactDate(r.expected_delivery_at),
    searchValue: (r) => r.expected_delivery_at ?? '',
    sortFn: (a, b) => (a.expected_delivery_at ?? '').localeCompare(b.expected_delivery_at ?? ''),
    filterType: 'date', dateValue: (r) => r.expected_delivery_at,
  },
  {
    key: 'customer_so_no', label: 'Reference', width: 130, sortable: true,
    accessor: (r) => r.customer_so_no ?? r.ref ?? '—',
    searchValue: (r) => `${r.customer_so_no ?? ''} ${r.ref ?? ''}`,
    sortFn: (a, b) => (a.customer_so_no ?? a.ref ?? '').localeCompare(b.customer_so_no ?? b.ref ?? ''),
  },
  {
    key: 'branding', label: 'Branding', width: 130, sortable: true, groupable: true,
    accessor: (r) => {
      const b = deriveBranding(r);
      return b ? <BrandingPill branding={b} /> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (r) => deriveBranding(r),
    exportValue: (r) => deriveBranding(r),
    groupValue: (r) => deriveBranding(r) || '(none)',
    sortFn: (a, b) => deriveBranding(a).localeCompare(deriveBranding(b)),
  },
  {
    key: 'venue', label: 'Venue', width: 180, sortable: true, groupable: true,
    accessor: (r) => r.venue ?? '—',
    searchValue: (r) => r.venue ?? '',
    groupValue: (r) => r.venue ?? '(none)',
  },
  {
    key: 'driver_name', label: 'Driver', width: 130, sortable: true, groupable: true,
    accessor: (r) => r.driver_name ?? '—',
    searchValue: (r) => r.driver_name ?? '',
    groupValue: (r) => r.driver_name ?? '(none)',
  },
  {
    key: 'local_total_sen', label: 'Local Total', width: 120, sortable: true, align: 'right',
    accessor: (r) => (
      <span style={{ fontWeight: 700, color: 'var(--c-ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtRm(r.local_total_sen)}</span>
    ),
    searchValue: (r) => fmtRm(r.local_total_sen),
    /* Export the NUMBER in ringgit so Excel can SUM the column. */
    exportValue: (r) => (r.local_total_sen ?? 0) / 100,
    sortFn: (a, b) => a.local_total_sen - b.local_total_sen,
  },
  {
    key: 'phone', label: 'Phone', width: 130, sortable: true,
    accessor: (r) => formatPhone(r.phone) || '',
    searchValue: (r) => `${r.phone ?? ''} ${formatPhone(r.phone) ?? ''}`,
  },
  {
    key: 'address1', label: 'Address 1', width: 180, sortable: true,
    accessor: (r) => r.address1 ?? '',
    searchValue: (r) => r.address1 ?? '',
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    accessor: (r) => <StatusPill status={r.status} />,
    searchValue: (r) => STATUS_LABEL[r.status] ?? r.status,
    exportValue: (r) => STATUS_LABEL[r.status] ?? r.status.replace(/_/g, ' '),
    groupValue: (r) => r.status,
    sortFn: (a, b) => (a.status ?? '').localeCompare(b.status ?? ''),
  },
  /* ── Default-hidden long-tail ── */
  {
    key: 'debtor_code', label: 'Customer Code', width: 120, sortable: true, defaultHidden: true,
    accessor: (r) => r.debtor_code ?? '',
    searchValue: (r) => r.debtor_code ?? '',
  },
  {
    key: 'email', label: 'Email', width: 180, sortable: true, defaultHidden: true,
    accessor: (r) => r.email ?? '',
    searchValue: (r) => r.email ?? '',
  },
  {
    key: 'customer_type', label: 'Customer Type', width: 120, sortable: true, groupable: true, defaultHidden: true,
    accessor: (r) => r.customer_type ?? '',
    searchValue: (r) => r.customer_type ?? '',
  },
  {
    key: 'building_type', label: 'Building Type', width: 120, sortable: true, groupable: true, defaultHidden: true,
    accessor: (r) => r.building_type ?? '',
    searchValue: (r) => r.building_type ?? '',
  },
  {
    key: 'address2', label: 'Address 2', width: 180, sortable: true, defaultHidden: true,
    accessor: (r) => r.address2 ?? '',
    searchValue: (r) => r.address2 ?? '',
  },
  {
    key: 'customer_state', label: 'State', width: 130, sortable: true, groupable: true, defaultHidden: true,
    accessor: (r) => r.customer_state ?? '',
    searchValue: (r) => r.customer_state ?? '',
  },
  {
    key: 'city', label: 'City', width: 130, sortable: true, groupable: true, defaultHidden: true,
    accessor: (r) => r.city ?? '',
    searchValue: (r) => r.city ?? '',
  },
  {
    key: 'postcode', label: 'Postcode', width: 100, sortable: true, defaultHidden: true,
    accessor: (r) => r.postcode ?? '',
    searchValue: (r) => r.postcode ?? '',
  },
  {
    key: 'customer_delivery_date', label: 'Delivery Date', width: 130, sortable: true, defaultHidden: true,
    accessor: (r) => compactDate(r.customer_delivery_date),
    searchValue: (r) => `${r.customer_delivery_date ?? ''} ${compactDate(r.customer_delivery_date)}`,
    filterType: 'date', dateValue: (r) => r.customer_delivery_date,
  },
  {
    key: 'vehicle', label: 'Vehicle', width: 120, sortable: true, defaultHidden: true,
    accessor: (r) => r.vehicle ?? '',
    searchValue: (r) => r.vehicle ?? '',
  },
  {
    key: 'note', label: 'Note', width: 200, sortable: true, defaultHidden: true,
    accessor: (r) => r.note ?? '',
    searchValue: (r) => r.note ?? '',
  },
  /* FINANCE columns — DECLARED ONLY for a finance-viewer so the column chooser
     never lists an always-empty finance column for a non-finance user; the
     backend also omits these keys from the payload (canViewScmFinance). Same
     rule + shape as the SO list (#574 / #589). */
  ...(canFinance
    ? ([
        {
          key: 'total_cost_sen', label: 'Cost Total', width: 120, sortable: true, align: 'right', defaultHidden: true,
          accessor: (r) => <span className={styles.money}>{fmtRm(r.total_cost_sen ?? 0)}</span>,
          searchValue: (r) => fmtRm(r.total_cost_sen ?? 0),
          exportValue: (r) => (r.total_cost_sen ?? 0) / 100,
          sortFn: (a, b) => (a.total_cost_sen ?? 0) - (b.total_cost_sen ?? 0),
        },
        {
          key: 'total_margin_sen', label: 'Margin', width: 120, sortable: true, align: 'right', defaultHidden: true,
          accessor: (r) => {
            const m = r.total_margin_sen ?? 0;
            if ((r.local_total_sen ?? 0) <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
            const color = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
            return <span className={styles.money} style={{ color, fontWeight: 600 }}>{fmtRm(m)}</span>;
          },
          searchValue: (r) => fmtRm(r.total_margin_sen ?? 0),
          exportValue: (r) => (r.total_margin_sen ?? 0) / 100,
          sortFn: (a, b) => (a.total_margin_sen ?? 0) - (b.total_margin_sen ?? 0),
        },
      ] as DataGridColumn<CnRow>[])
    : []),
];
