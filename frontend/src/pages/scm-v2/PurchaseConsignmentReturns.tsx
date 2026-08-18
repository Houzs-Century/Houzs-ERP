// ----------------------------------------------------------------------------
// PurchaseConsignmentReturns — Purchase Consignment Return list, cloned from the
// polished Purchase Returns list (PurchaseReturnsList.tsx). Same DataGrid UX:
//   • double-click a row → open the detail page
//   • right-click → context menu (View · Edit · Cancel)
//   • click a row → drill-down with full line items
//
// Reuses the shared DataGrid + fmtDateOrDash + buildVariantSummary UNCHANGED;
// only the queries are repointed at `/purchase-consignment-returns` (pc-return
// hooks) and navigation points at /purchase-consignment-return.
//
// Dropped from the PR clone (per scope): the "From Goods Receipt" button that
// routes to the real GRN list. A new return is raised from the New page (or
// pre-filled from a Purchase Consignment Receive / Order). The Transfer-From
// (GRN) column is relabelled to the source Purchase Consignment Receive.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  usePurchaseConsignmentReturns,
  useCancelPurchaseConsignmentReturn,
  usePurchaseConsignmentReturnDetail,
} from '../../vendor/scm/lib/purchase-consignment-return-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtDateOrDash, buildVariantSummary } from '@2990s/shared';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { transferFromColumnLabel } from "../../lib/convertScope";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_COLOR: Record<string, string> = {
  POSTED: 'rgba(166, 71, 30, 0.12)',
  COMPLETED: 'rgba(47, 93, 79, 0.28)',
  CANCELLED: 'rgba(184, 51, 31, 0.10)',
};
const STATUS_LABEL: Record<string, string> = {
  POSTED: 'Confirmed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};
const STATUS_CHIPS = ['all', 'POSTED', 'COMPLETED', 'CANCELLED'] as const;

const fmtMoney = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PCT_LIST_STORAGE_KEY = 'pc-return-list.layout.v1';

type PrRow = Record<string, unknown> & {
  id: string;
  return_number: string;
  status: string;
  return_date: string | null;
  refund_centi?: number;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_order?: { id: string; po_number: string } | null;
  pc_receive?: { id: string; receive_number: string } | null;
};

const buildColumns = (): DataGridColumn<PrRow>[] => [
  {
    key: 'return_number', label: 'Return No.', width: 150, sortable: true,
    accessor: (r) => <span style={{ fontWeight: 700, color: '#16695f', fontVariantNumeric: 'tabular-nums' }}>{r.return_number}</span>,
    searchValue: (r) => r.return_number,
    /* Accessor is JSX → export the raw doc-no string or the cell exports blank. */
    exportValue: (r) => r.return_number,
    sortFn: (a, b) => a.return_number.localeCompare(b.return_number),
  },
  {
    // Owner 2026-07-24: supplier NAME and CODE are separate columns on every
    // procurement table — code is no longer buried as the name's fallback.
    key: 'supplier', label: 'Supplier', width: 220, sortable: true, groupable: true,
    accessor: (r) => r.supplier?.name ?? '—',
    searchValue: (r) => r.supplier?.name ?? '',
    groupValue: (r) => r.supplier?.name ?? r.supplier?.code ?? '(none)',
    sortFn: (a, b) =>
      (a.supplier?.name ?? '').localeCompare(b.supplier?.name ?? ''),
  },
  {
    key: 'supplier_code', label: 'Supplier Code', width: 120, sortable: true,
    accessor: (r) => r.supplier?.code
      ? <span className={styles.codeChip}>{r.supplier.code}</span>
      : '—',
    searchValue: (r) => r.supplier?.code ?? '',
    filterValue: (r) => r.supplier?.code ?? '—',
    sortFn: (a, b) => (a.supplier?.code ?? '').localeCompare(b.supplier?.code ?? ''),
  },
  {
    key: 'receive_number', label: transferFromColumnLabel('pcr'), width: 170, sortable: true, groupable: true,
    accessor: (r) => <span style={{ fontWeight: 700, color: '#16695f', fontVariantNumeric: 'tabular-nums' }}>{r.pc_receive?.receive_number ?? '—'}</span>,
    searchValue: (r) => r.pc_receive?.receive_number ?? '',
    /* Accessor is JSX → export the source receive doc-no string. */
    exportValue: (r) => r.pc_receive?.receive_number ?? '',
    groupValue: (r) => r.pc_receive?.receive_number ?? '(none)',
  },
  {
    key: 'return_date', label: 'Return Date', width: 120, sortable: true,
    accessor: (r) => fmtDateOrDash(r.return_date),
    searchValue: (r) => r.return_date ?? '',
    sortFn: (a, b) => String(a.return_date ?? '').localeCompare(String(b.return_date ?? '')),
    filterType: 'date', dateValue: (r) => r.return_date,
  },
  {
    key: 'refund_centi', label: 'Refund', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (r) => (
      <span style={{ fontFamily: 'var(--font-mark)', color: '#16695f', fontWeight: 800 }}>
        {fmtMoney(Number(r.refund_centi ?? 0))}
      </span>
    ),
    searchValue: (r) => fmtMoney(Number(r.refund_centi ?? 0)),
    /* Accessor is JSX → export the NUMBER in ringgit so Excel can SUM it. */
    exportValue: (r) => Number(r.refund_centi ?? 0) / 100,
    sortFn: (a, b) => Number(a.refund_centi ?? 0) - Number(b.refund_centi ?? 0),
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    accessor: (r) => (
      <span className={styles.statusPill} style={{ background: STATUS_COLOR[r.status] }}>
        {STATUS_LABEL[r.status] ?? r.status.replace('_', ' ')}
      </span>
    ),
    searchValue: (r) => STATUS_LABEL[r.status] ?? r.status.replace('_', ' '),
    /* Accessor is JSX → export the human status label, not blank. */
    exportValue: (r) => STATUS_LABEL[r.status] ?? r.status.replace(/_/g, ' '),
    groupValue: (r) => STATUS_LABEL[r.status] ?? r.status,
    sortFn: (a, b) => a.status.localeCompare(b.status),
  },
];

/* ── Drill-down — per-line breakdown for one return ── */
type PrItem = Record<string, unknown> & {
  id: string;
  material_code?: string | null;
  material_name?: string | null;
  description?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  qty_returned?: number | null;
  unit_price_centi?: number | null;
  line_refund_centi?: number | null;
};

const buildDrilldownColumns = (): DataGridColumn<PrItem>[] => [
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f' }}>{it.material_code ?? '—'}</span>,
    searchValue: (it) => it.material_code ?? '',
    sortFn: (a, b) => (a.material_code ?? '').localeCompare(b.material_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 260, minWidth: 180,
    accessor: (it) => (it.description ?? '').trim() || it.material_name || '—',
    searchValue: (it) => `${it.description ?? ''} ${it.material_name ?? ''}`.trim(),
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
    key: 'qty_returned', label: 'Qty Returned', width: 100, align: 'right',
    accessor: (it) => it.qty_returned ?? 0,
    searchValue: (it) => String(it.qty_returned ?? 0),
    sortFn: (a, b) => Number(a.qty_returned ?? 0) - Number(b.qty_returned ?? 0),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 110, align: 'right',
    accessor: (it) => fmtMoney(Number(it.unit_price_centi ?? 0)),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'line_total', label: 'Line Total', width: 120, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f' }}>{fmtMoney(Number(it.line_refund_centi ?? 0))}</span>,
    searchValue: (it) => String(it.line_refund_centi ?? 0),
    sortFn: (a, b) => Number(a.line_refund_centi ?? 0) - Number(b.line_refund_centi ?? 0),
  },
];

const ExpandedLines = ({ pr }: { pr: PrRow }) => {
  const detail = usePurchaseConsignmentReturnDetail(pr.id);

  if (detail.isLoading) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>Loading lines…</div>;
  }
  if (detail.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)' }}>
        Failed to load lines: {detail.error instanceof Error ? detail.error.message : String(detail.error)}
      </div>
    );
  }
  const items = (detail.data?.items ?? []) as PrItem[];
  if (items.length === 0) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>No line items.</div>;
  }
  let subtotal = 0;
  for (const it of items) subtotal += Number(it.line_refund_centi ?? 0);

  const columns = buildDrilldownColumns();

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<PrItem>
        rows={items}
        columns={columns}
        storageKey="pc-return-drilldown-grid.v1"
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
        <span>Total <strong style={{ color: '#16695f' }}>{fmtMoney(subtotal)}</strong></span>
      </div>
    </div>
  );
};

export const PurchaseConsignmentReturns = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePurchaseConsignmentReturns();
  const cancelPr = useCancelPurchaseConsignmentReturn();
  const askConfirm = useConfirm();
  const notify = useNotify();

  const allRows = useMemo<PrRow[]>(() => (data?.purchaseReturns ?? []) as PrRow[], [data]);
  const rows = useMemo<PrRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((r) => r.status === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildColumns(), []);

  const doCancelPr = async (r: PrRow) => {
    if (!(await askConfirm({
      title: `Cancel return ${r.return_number}?`,
      body: 'This reverses the return — the goods are put back into stock. Line items stay for audit.',
      confirmLabel: 'Cancel return',
      danger: true,
    }))) return;
    cancelPr.mutate(r.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Procurement"
        title="Purchase Consignment Returns"
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" size="sm" onClick={() => navigate('/scm/purchase-consignment-returns/new')}>
              <Plus {...ICON} />
              <span>New Purchase Consignment Return</span>
            </Button>
          </div>
        }
      />

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${rows.length} purchase consignment returns`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      {/* The SO strip's own FilterPills slab (owner 2026-07-26). */}
      <FilterPills
        options={STATUS_CHIPS.map((s) => ({ value: s as string, label: s === 'all' ? 'All' : STATUS_LABEL[s] ?? s }))}
        value={statusChip}
        onChange={(v) => setStatusChip(v)}
      />

      <DataGrid<PrRow>
        rows={rows}
        columns={columns}
        storageKey={PCT_LIST_STORAGE_KEY}
        exportName="Purchase Consignment Returns"
        rowKey={(r) => r.id}
        searchPlaceholder="Search return no, supplier…"
        loadedSearchLimit={300}
        groupBanner={false}
        onRowDoubleClick={(r) => navigate(`/scm/purchase-consignment-returns/${r.id}`)}
        rowStyle={(r) => r.status === 'COMPLETED' || r.status === 'CANCELLED'
          ? { opacity: 0.6, filter: 'grayscale(0.4)' }
          : undefined}
        expandable={{
          renderExpansion: (r) => <ExpandedLines pr={r} />,
          rowExpansionKey: (r) => r.id,
        }}
        contextMenu={(r) => {
          const menu: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'View', onClick: () => navigate(`/scm/purchase-consignment-returns/${r.id}`) },
            { label: 'Edit', onClick: () => navigate(`/scm/purchase-consignment-returns/${r.id}?edit=1`) },
          ];
          if (r.status !== 'CANCELLED' && r.status !== 'COMPLETED') {
            menu.push({ divider: true as const });
            menu.push({ label: 'Cancel', danger: true, onClick: () => doCancelPr(r) });
          }
          return menu;
        }}
        isLoading={isLoading}
        emptyMessage='No returns yet — click "New Purchase Consignment Return" to raise one.'
      />
    </div>
  );
};
