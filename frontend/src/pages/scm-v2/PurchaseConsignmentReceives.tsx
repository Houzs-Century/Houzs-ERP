// ----------------------------------------------------------------------------
// PurchaseConsignmentReceives — Purchase Consignment Receive list, cloned from
// the polished Goods Received list (GoodsReceivedList.tsx). Same DataGrid UX:
//   • double-click a row → open the detail page
//   • right-click → context menu (View · Edit · Cancel)
//   • click a row → drill-down with full line items
//
// Reuses the shared DataGrid + fmtDateOrDash + buildVariantSummary UNCHANGED;
// only the queries are repointed at `/purchase-consignment-receives`
// (pc-receive hooks) and navigation points at /purchase-consignment-receive.
//
// Dropped from the GRN clone (per scope): the From-PO header button + the
// right-click "Convert to PI / PR" actions (consignment receiving doesn't feed
// real purchase-invoice / purchase-return flows — the parallel Purchase
// Consignment Return flow handles returns). The Transfer-From (PO) column is
// relabelled to the source Purchase Consignment Order.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  usePurchaseConsignmentReceives,
  useCancelPurchaseConsignmentReceive,
  usePurchaseConsignmentReceiveDetail,
} from '../../vendor/scm/lib/purchase-consignment-receive-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { fmtDateOrDash, buildVariantSummary, fmtMoneyCenti } from '@2990s/shared';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// Colours + labels come from the canonical lib/status-pill map via <StatusPill>.
const STATUS_CHIPS = ['all', 'POSTED', 'CLOSED', 'CANCELLED'] as const;

const fmtMoney = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

const PCR_LIST_STORAGE_KEY = 'pc-receive-list.layout.v1';

type GrnRow = Record<string, unknown> & {
  id: string;
  receive_number: string;
  status: string;
  received_at: string | null;
  delivery_note_ref: string | null;
  total_centi?: number;
  currency?: string;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_consignment_order?: { id: string; pc_number: string } | null;
  has_children?: boolean;
};

const buildColumns = (): DataGridColumn<GrnRow>[] => [
  {
    key: 'receive_number', label: 'Receive No.', width: 150, sortable: true,
    accessor: (g) => <span style={{ fontWeight: 700, color: '#16695f', fontVariantNumeric: 'tabular-nums' }}>{g.receive_number}</span>,
    searchValue: (g) => g.receive_number,
    /* Accessor is JSX → export the raw doc-no string or the cell exports blank. */
    exportValue: (g) => g.receive_number,
    sortFn: (a, b) => a.receive_number.localeCompare(b.receive_number),
  },
  {
    // Owner 2026-07-24: supplier NAME and CODE are separate columns on every
    // procurement table — code is no longer buried as the name's fallback.
    key: 'supplier', label: 'Supplier', width: 220, sortable: true, groupable: true,
    accessor: (g) => g.supplier?.name ?? '—',
    searchValue: (g) => g.supplier?.name ?? '',
    groupValue: (g) => g.supplier?.name ?? g.supplier?.code ?? '(none)',
    sortFn: (a, b) =>
      (a.supplier?.name ?? '').localeCompare(b.supplier?.name ?? ''),
  },
  {
    key: 'supplier_code', label: 'Supplier Code', width: 120, sortable: true,
    accessor: (g) => g.supplier?.code
      ? <span className={styles.codeChip}>{g.supplier.code}</span>
      : '—',
    searchValue: (g) => g.supplier?.code ?? '',
    filterValue: (g) => g.supplier?.code ?? '—',
    sortFn: (a, b) => (a.supplier?.code ?? '').localeCompare(b.supplier?.code ?? ''),
  },
  {
    key: 'pc_number', label: 'Transfer From (Order)', width: 160, sortable: true, groupable: true,
    accessor: (g) => <span style={{ fontWeight: 700, color: '#16695f', fontVariantNumeric: 'tabular-nums' }}>{g.purchase_consignment_order?.pc_number ?? '—'}</span>,
    searchValue: (g) => g.purchase_consignment_order?.pc_number ?? '',
    /* Accessor is JSX → export the source order doc-no string. */
    exportValue: (g) => g.purchase_consignment_order?.pc_number ?? '',
    groupValue: (g) => g.purchase_consignment_order?.pc_number ?? '(none)',
  },
  {
    key: 'received_at', label: 'Received Date', width: 120, sortable: true,
    accessor: (g) => fmtDateOrDash(g.received_at),
    searchValue: (g) => g.received_at ?? '',
    sortFn: (a, b) => String(a.received_at ?? '').localeCompare(String(b.received_at ?? '')),
    filterType: 'date', dateValue: (g) => g.received_at,
  },
  {
    key: 'delivery_note_ref', label: 'DN Ref', width: 130, sortable: true,
    accessor: (g) => g.delivery_note_ref ?? '—',
    searchValue: (g) => g.delivery_note_ref ?? '',
  },
  {
    key: 'total_centi', label: 'Total', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (g) => (
      <span style={{ fontFamily: 'var(--font-mark)', color: '#16695f', fontWeight: 800 }}>
        {fmtMoney(Number(g.total_centi ?? 0), g.currency)}
      </span>
    ),
    searchValue: (g) => fmtMoney(Number(g.total_centi ?? 0), g.currency),
    /* Accessor is JSX → export the NUMBER in ringgit so Excel can SUM it. */
    exportValue: (g) => Number(g.total_centi ?? 0) / 100,
    sortFn: (a, b) => Number(a.total_centi ?? 0) - Number(b.total_centi ?? 0),
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    accessor: (g) => <StatusPill docType="grn" status={g.status} />,
    searchValue: (g) => statusLabel('grn', g.status),
    /* Accessor is JSX → export the human status label, not blank. */
    exportValue: (g) => statusLabel('grn', g.status),
    groupValue: (g) => statusLabel('grn', g.status),
    sortFn: (a, b) => a.status.localeCompare(b.status),
  },
];

/* ── Drill-down — per-line breakdown for one receive ── */
type GrnItem = Record<string, unknown> & {
  id: string;
  material_code?: string | null;
  material_name?: string | null;
  description?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  qty?: number | null;
  qty_received?: number | null;
  unit_price_centi?: number | null;
  line_total_centi?: number | null;
  source_po_number?: string | null;
  received_at?: string | null;
};

const buildDrilldownColumns = (currency: string): DataGridColumn<GrnItem>[] => [
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f' }}>{it.material_code ?? '—'}</span>,
    searchValue: (it) => it.material_code ?? '',
    sortFn: (a, b) => (a.material_code ?? '').localeCompare(b.material_code ?? ''),
  },
  {
    key: 'source_po', label: 'Transfer From (Order)', width: 160,
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f', fontVariantNumeric: 'tabular-nums' }}>{it.source_po_number ?? '—'}</span>,
    searchValue: (it) => it.source_po_number ?? '',
    sortFn: (a, b) => (a.source_po_number ?? '').localeCompare(b.source_po_number ?? ''),
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
    key: 'qty_received', label: 'Qty Received', width: 100, align: 'right',
    accessor: (it) => it.qty_received ?? it.qty ?? 0,
    searchValue: (it) => String(it.qty_received ?? it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty_received ?? a.qty ?? 0) - Number(b.qty_received ?? b.qty ?? 0),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 110, align: 'right',
    accessor: (it) => fmtMoney(Number(it.unit_price_centi ?? 0), currency),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'line_total', label: 'Line Total', width: 120, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: '#16695f' }}>{fmtMoney(Number(it.line_total_centi ?? 0), currency)}</span>,
    searchValue: (it) => String(it.line_total_centi ?? 0),
    sortFn: (a, b) => Number(a.line_total_centi ?? 0) - Number(b.line_total_centi ?? 0),
  },
  {
    key: 'received_at', label: 'Receive Date', width: 120,
    accessor: (it) => fmtDateOrDash((it.received_at ?? '').slice(0, 10) || null),
    searchValue: (it) => it.received_at ?? '',
    sortFn: (a, b) => String(a.received_at ?? '').localeCompare(String(b.received_at ?? '')),
    filterType: 'date', dateValue: (it) => it.received_at,
  },
];

const ExpandedLines = ({ grn }: { grn: GrnRow }) => {
  const detail = usePurchaseConsignmentReceiveDetail(grn.id);
  const currency = grn.currency ?? 'MYR';

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
  const items = (detail.data?.items ?? []) as GrnItem[];
  if (items.length === 0) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>No line items.</div>;
  }
  let subtotal = 0;
  for (const it of items) subtotal += Number(it.line_total_centi ?? 0);

  const columns = buildDrilldownColumns(currency);

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<GrnItem>
        rows={items}
        columns={columns}
        storageKey="pc-receive-drilldown-grid.v1"
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
        <span>Total <strong style={{ color: '#16695f' }}>{fmtMoney(subtotal, currency)}</strong></span>
      </div>
    </div>
  );
};

export const PurchaseConsignmentReceives = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePurchaseConsignmentReceives();
  const cancelReceive = useCancelPurchaseConsignmentReceive();
  const askConfirm = useConfirm();
  const notify = useNotify();

  const allRows = useMemo<GrnRow[]>(() => (data?.grns ?? []) as GrnRow[], [data]);
  const rows = useMemo<GrnRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((g) => g.status === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildColumns(), []);

  const doCancel = async (g: GrnRow) => {
    if (!(await askConfirm({
      title: `Cancel ${g.receive_number}?`,
      body: 'This reverses the receipt. Line items stay for audit.',
      confirmLabel: 'Cancel receipt',
      danger: true,
    }))) return;
    cancelReceive.mutate(g.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Procurement"
        title="Purchase Consignment Receives"
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" size="sm" onClick={() => navigate('/scm/purchase-consignment-receives/new')}>
              <Plus {...ICON} />
              <span>New Purchase Consignment Receive</span>
            </Button>
          </div>
        }
      />

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${rows.length} purchase consignment receives`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {STATUS_CHIPS.map((s) => (
          <button key={s} type="button" onClick={() => setStatusChip(s)}
            style={{
              height: 29, padding: '0 12px', borderRadius: 4, cursor: 'pointer',
              fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase',
              border: '1px solid #e5e7eb',
              background: statusChip === s ? '#16695f' : 'transparent',
              color: statusChip === s ? '#ffffff' : '#414539',
            }}>
            {s === 'all' ? 'All' : statusLabel('grn', s)}
          </button>
        ))}
      </div>

      <DataGrid<GrnRow>
        rows={rows}
        columns={columns}
        storageKey={PCR_LIST_STORAGE_KEY}
        exportName="Purchase Consignment Receives"
        rowKey={(g) => g.id}
        searchPlaceholder="Search receive no, supplier, DN ref…"
        loadedSearchLimit={1000}
        groupBanner={false}
        onRowDoubleClick={(g) => navigate(`/scm/purchase-consignment-receives/${g.id}`)}
        rowStyle={(g) => (g.status === 'CANCELLED' || g.status === 'CLOSED')
          ? { opacity: 0.55, filter: 'grayscale(0.6)' }
          : undefined}
        expandable={{
          renderExpansion: (g) => <ExpandedLines grn={g} />,
          rowExpansionKey: (g) => g.id,
        }}
        contextMenu={(g) => {
          const isPosted = g.status === 'POSTED';
          const hasChildren = Boolean(g.has_children);
          const menu: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'View', onClick: () => navigate(`/scm/purchase-consignment-receives/${g.id}`) },
          ];
          if (isPosted && !hasChildren) {
            menu.push({ label: 'Edit', onClick: () => navigate(`/scm/purchase-consignment-receives/${g.id}?edit=1`) });
            menu.push({ divider: true as const });
            menu.push({ label: 'Cancel', danger: true, onClick: () => doCancel(g) });
          }
          return menu;
        }}
        isLoading={isLoading}
        emptyMessage='No receives yet — click "New Purchase Consignment Receive" to receive goods.'
      />
    </div>
  );
};
