// ----------------------------------------------------------------------------
// PurchaseConsignmentOrders — Purchase Consignment Order list, cloned from the
// polished Purchase Orders list (PurchaseOrders.tsx). Same DataGrid UX:
//   • double-click a row → open the detail page
//   • right-click → context menu (View · Edit · Cancel)
//   • click a row → drill-down with full line items
//
// Reuses the shared DataGrid + ItemGroupPill + fmtDateOrDash UNCHANGED; only the
// queries are repointed at `/purchase-consignment-orders` (pc-order hooks) and
// navigation points at /purchase-consignment.
//
// Dropped from the PO clone (per scope): the "From Sales Order" button + the
// multi-select "Convert to GRN" batch flow + the per-line "Received (GRN)"
// breakdown column (consignment receiving lives on the parallel Purchase
// Consignment Receive flow).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash, fmtMoneyCenti } from '@2990s/shared';
import {
  usePurchaseConsignmentOrders,
  usePurchaseConsignmentOrderDetail,
  useCancelPurchaseConsignmentOrder,
} from '../../vendor/scm/lib/purchase-consignment-order-queries';
import {
  type PoHeaderRow,
  type PoItemRow,
  type Currency,
} from '../../vendor/scm/lib/suppliers-queries';
import { poStatusLabel } from '../../vendor/scm/lib/po-status';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type StatusFilter = 'all' | 'outstanding';
const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: 'outstanding', label: 'Outstanding' },
  { value: 'all', label: 'All' },
];

const fmtMoney = (centi: number, currency: Currency): string => fmtMoneyCenti(centi, currency);

// The backend PC-orders list returns pc_number (the consignment doc number),
// but the shared PoHeaderRow type carries po_number. Read pc_number first with
// a po_number fallback so the doc number renders instead of `undefined`.
const pcNo = (po: PoHeaderRow): string =>
  (po as { pc_number?: string }).pc_number ?? po.po_number ?? '';

const summarizeItems = (items: PoHeaderRow['items']): string | null => {
  if (!items || items.length === 0) return null;
  const HEAD = 3;
  const shown = items.slice(0, HEAD)
    .map((it) => `${it.material_code}×${it.qty}`)
    .join(' · ');
  const extra = items.length - HEAD;
  return extra > 0 ? `${shown} · +${extra} more` : shown;
};

const PC_ORDER_LIST_STORAGE_KEY = 'pc-order-list.layout.v1';

const buildColumns = (): DataGridColumn<PoHeaderRow>[] => [
  {
    key: 'pc_number', label: 'P/CO No.', width: 150, sortable: true,
    // Backend (purchase-consignment-orders list) returns pc_number, not the
    // PO's po_number — the PoHeaderRow type is shared with real POs, so read
    // pc_number with a po_number fallback.
    accessor: (po) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{pcNo(po)}</span>,
    searchValue: (po) => pcNo(po),
    /* Accessor is JSX → export the raw doc-no string or the cell exports blank. */
    exportValue: (po) => pcNo(po),
    sortFn: (a, b) => pcNo(a).localeCompare(pcNo(b)),
  },
  {
    // Owner 2026-07-24: supplier NAME and CODE are separate columns on every
    // procurement table — code is no longer buried as the name's fallback.
    key: 'supplier', label: 'Supplier', width: 200, sortable: true, groupable: true,
    accessor: (po) => po.supplier?.name ?? '—',
    searchValue: (po) => po.supplier?.name ?? '',
    groupValue: (po) => po.supplier?.name ?? po.supplier?.code ?? '(none)',
    sortFn: (a, b) =>
      (a.supplier?.name ?? '').localeCompare(b.supplier?.name ?? ''),
  },
  {
    key: 'supplier_code', label: 'Supplier Code', width: 120, sortable: true,
    accessor: (po) => po.supplier?.code
      ? <span className={styles.codeChip}>{po.supplier.code}</span>
      : '—',
    searchValue: (po) => po.supplier?.code ?? '',
    filterValue: (po) => po.supplier?.code ?? '—',
    sortFn: (a, b) => (a.supplier?.code ?? '').localeCompare(b.supplier?.code ?? ''),
  },
  {
    key: 'items', label: 'Items', width: 320, sortable: false, groupable: false,
    accessor: (po) => {
      const summary = summarizeItems(po.items);
      return (
        <span
          title={(po.items ?? []).map((it) => `${it.material_code} × ${it.qty}`).join('\n')}
          style={{
            display: 'block',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-12)',
            color: summary ? 'var(--c-ink)' : 'var(--fg-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {summary ?? '—'}
        </span>
      );
    },
    searchValue: (po) => (po.items ?? []).map((it) => `${it.material_code} ${it.qty}`).join(' '),
    /* Accessor is JSX → export the readable "code×qty · …" summary string. */
    exportValue: (po) => summarizeItems(po.items) ?? '',
  },
  {
    key: 'po_date', label: 'Date', width: 120, sortable: true,
    accessor: (po) => fmtDateOrDash(po.po_date),
    searchValue: (po) => po.po_date,
    sortFn: (a, b) => (a.po_date ?? '').localeCompare(b.po_date ?? ''),
    filterType: 'date', dateValue: (po) => po.po_date,
  },
  {
    key: 'expected_at', label: 'Expected', width: 120, sortable: true,
    accessor: (po) => fmtDateOrDash(po.expected_at),
    searchValue: (po) => po.expected_at ?? '',
    sortFn: (a, b) => (a.expected_at ?? '').localeCompare(b.expected_at ?? ''),
    filterType: 'date', dateValue: (po) => po.expected_at,
  },
  {
    key: 'currency', label: 'Currency', width: 90, sortable: true, groupable: true,
    accessor: (po) => po.currency,
    searchValue: (po) => po.currency,
    groupValue: (po) => po.currency,
  },
  {
    key: 'total_centi', label: 'Total', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (po) => (
      <span style={{ fontFamily: 'var(--font-mark)', color: 'var(--c-burnt)', fontWeight: 800 }}>
        {fmtMoney(po.total_centi, po.currency)}
      </span>
    ),
    searchValue: (po) => fmtMoney(po.total_centi, po.currency),
    /* Accessor is JSX → export the NUMBER in ringgit (not "MYR 1,234.00") so
       Excel can SUM the column. */
    exportValue: (po) => (po.total_centi ?? 0) / 100,
    sortFn: (a, b) => a.total_centi - b.total_centi,
  },
  {
    key: 'status', label: 'Status', width: 160, sortable: true, groupable: true,
    accessor: (po) => <StatusPill docType="po" status={po.status} />,
    searchValue: (po) => poStatusLabel(po.status),
    /* Accessor is JSX → export the human status label, not blank. */
    exportValue: (po) => poStatusLabel(po.status),
    groupValue: (po) => poStatusLabel(po.status),
    sortFn: (a, b) => poStatusLabel(a.status).localeCompare(poStatusLabel(b.status)),
  },
];

export const PurchaseConsignmentOrders = () => {
  const [status, setStatus] = useState<StatusFilter>('outstanding');
  const navigate = useNavigate();
  const cancelPo = useCancelPurchaseConsignmentOrder();
  const askConfirm = useConfirm();
  const notify = useNotify();

  const { data, isLoading, error } = usePurchaseConsignmentOrders();
  const rows = useMemo(() => {
    const all = data ?? [];
    if (status === 'all') return all;
    return all.filter((r) => r.status === 'SUBMITTED' || r.status === 'PARTIALLY_RECEIVED');
  }, [data, status]);

  const columns = useMemo(() => buildColumns(), []);

  const doCancelPo = async (po: PoHeaderRow) => {
    if (!(await askConfirm({
      title: `Cancel ${pcNo(po)}?`,
      body: 'It will stop proceeding.',
      confirmLabel: 'Cancel order',
      danger: true,
    }))) return;
    cancelPo.mutate(po.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Procurement"
        title="Purchase Consignment Orders"
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" size="sm" onClick={() => navigate('/scm/purchase-consignment-orders/new')}>
              <Plus {...ICON} />
              <span>New Purchase Consignment Order</span>
            </Button>
          </div>
        }
      />

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setStatus(c.value)}
            style={{
              fontFamily: 'var(--font-button)',
              fontSize: 'var(--fs-13)',
              fontWeight: 600,
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 'var(--radius-pill)',
              border: status === c.value ? '1px solid var(--c-ink)' : '1px solid var(--line)',
              background: status === c.value ? 'var(--c-ink)' : 'var(--c-paper)',
              color: status === c.value ? 'var(--c-cream)' : 'var(--c-ink)',
              cursor: 'pointer',
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${rows.length} purchase consignment orders`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <DataGrid<PoHeaderRow>
        rows={rows}
        columns={columns}
        storageKey={PC_ORDER_LIST_STORAGE_KEY}
        exportName="Purchase Consignment Orders"
        rowKey={(po) => po.id}
        searchPlaceholder="Search P/CO no, supplier, code…"
        loadedSearchLimit={1000}
        groupBanner={false}
        onRowDoubleClick={(po) => navigate(`/scm/purchase-consignment-orders/${po.id}`)}
        expandable={{
          renderExpansion: (po) => <ExpandedLines po={po} />,
          rowExpansionKey: (po) => po.id,
        }}
        rowStyle={(po) => po.status === 'CANCELLED'
          ? { opacity: 0.55, filter: 'grayscale(0.6)' }
          : undefined}
        contextMenu={(po) => {
          const hasChildren = Boolean(po.has_children);
          const menu: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'View', onClick: () => navigate(`/scm/purchase-consignment-orders/${po.id}`) },
          ];
          if (!hasChildren) {
            menu.push({ label: 'Edit', onClick: () => navigate(`/scm/purchase-consignment-orders/${po.id}?edit=1`) });
          }
          if (po.status !== 'CANCELLED' && po.status !== 'RECEIVED' && !hasChildren) {
            menu.push({ divider: true as const });
            menu.push({ label: 'Cancel', danger: true, onClick: () => doCancelPo(po) });
          }
          return menu;
        }}
        isLoading={isLoading}
        emptyMessage='No orders yet — click "New Purchase Consignment Order" to start.'
      />
    </div>
  );
};

/* ─────────────────── Expanded drill-down ────────────────────────────── */
const buildDrilldownColumns = (
  currency: Currency,
  headerExpectedAt: string | null,
): DataGridColumn<PoItemRow>[] => [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <ItemGroupPill group={it.item_group ?? null} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{it.material_code}</span>,
    searchValue: (it) => it.material_code,
    sortFn: (a, b) => (a.material_code ?? '').localeCompare(b.material_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 240, minWidth: 180,
    accessor: (it) => {
      const manual = (it.description ?? '').trim();
      if (manual) return <div>{manual}</div>;
      const summary = buildVariantSummary(it.item_group ?? null, it.variants ?? null);
      return summary || it.material_name || '—';
    },
    searchValue: (it) => `${it.description ?? ''} ${buildVariantSummary(it.item_group ?? null, it.variants ?? null)} ${it.material_name ?? ''}`.trim(),
  },
  {
    key: 'description2', label: 'Description 2', width: 220, minWidth: 160,
    accessor: (it) => {
      const summary = buildVariantSummary(it.item_group ?? null, it.variants ?? null);
      return summary ? <div>{summary}</div> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group ?? null, it.variants ?? null),
  },
  {
    key: 'uom', label: 'UOM', width: 70,
    accessor: (it) => it.uom || 'UNIT',
    searchValue: (it) => it.uom || 'UNIT',
  },
  {
    key: 'ordered', label: 'Ordered', width: 70, align: 'right',
    accessor: (it) => it.qty ?? 0,
    searchValue: (it) => String(it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
  },
  {
    key: 'delivery_date', label: 'Delivery Date', width: 120,
    accessor: (it) => {
      const due = it.delivery_date ?? headerExpectedAt ?? null;
      return due
        ? <span style={{ whiteSpace: 'nowrap' }}>{fmtDateOrDash(due)}</span>
        : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => it.delivery_date ?? headerExpectedAt ?? '',
    sortFn: (a, b) => (a.delivery_date ?? headerExpectedAt ?? '').localeCompare(b.delivery_date ?? headerExpectedAt ?? ''),
    filterType: 'date', dateValue: (it) => it.delivery_date ?? headerExpectedAt,
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 100, align: 'right',
    accessor: (it) => fmtMoney(Number(it.unit_price_centi ?? 0), currency),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'line_total', label: 'Line Total', width: 110, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{fmtMoney(Number(it.line_total_centi ?? 0), currency)}</span>,
    searchValue: (it) => String(it.line_total_centi ?? 0),
    sortFn: (a, b) => Number(a.line_total_centi ?? 0) - Number(b.line_total_centi ?? 0),
  },
];

const ExpandedLines = ({ po }: { po: PoHeaderRow }) => {
  const detail = usePurchaseConsignmentOrderDetail(po.id);

  if (detail.isLoading) {
    return (
      <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
        <p style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', margin: 0 }}>Loading lines for {pcNo(po)}…</p>
      </div>
    );
  }
  if (detail.error) {
    return (
      <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
        <p style={{ fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)', margin: 0 }}>
          Failed to load lines: {detail.error instanceof Error ? detail.error.message : String(detail.error)}
        </p>
      </div>
    );
  }

  const items = (detail.data?.items ?? []) as PoItemRow[];
  if (items.length === 0) {
    return (
      <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
        <p style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', margin: 0 }}>No line items.</p>
      </div>
    );
  }

  let subtotal = 0;
  for (const it of items) subtotal += Number(it.line_total_centi ?? 0);

  const columns = buildDrilldownColumns(po.currency, po.expected_at ?? null);

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<PoItemRow>
        rows={items}
        columns={columns}
        storageKey="pc-order-drilldown-grid.v1"
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
        <span>Total <strong style={{ color: 'var(--c-burnt)' }}>{fmtMoney(subtotal, po.currency)}</strong></span>
      </div>
    </div>
  );
};
