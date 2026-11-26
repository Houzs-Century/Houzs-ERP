// ----------------------------------------------------------------------------
// StockTakeApprovals — the supervisor inbox for over-limit stock-take counts a
// non-supervisor submitted (status PENDING_APPROVAL). Owner 2026-11-24: 「像
// payment backdate request」 — same shape as PaymentBackdateRequests: a sidebar
// red count, inline Approve / Return in the row, a SINGLE click opens the count
// on the right (StockTakeApprovalQuickView), a double-click opens the full stock
// take. Approve posts it; Return hands it back to Open for a recount. Only a
// `scm.stock_take.supervise` holder reaches the page (route + sidebar + server).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDate, fmtDateTime, fmtQty } from '../../../../shared/src/vendor/shared/format';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { warehouseLabel } from '../../vendor/scm/lib/warehouse-label';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useStockTakes, useApproveStockTake, useRejectStockTake, type StockTakeRow,
} from '../../vendor/scm/lib/stock-queries';
import { StockTakeApprovalQuickView, stockTakePath } from './StockTakeApprovalQuickView';

const STORAGE_KEY = 'stock-take-approvals.layout.v1';

const CHIPS = [
  { value: 'pending', label: 'Pending' },
  { value: 'all', label: 'All' },
] as const;

const scopeLabel = (scopeType: string, scopeValue: string | null): string => {
  if (scopeType === 'CATEGORY') return `Category · ${scopeValue ?? ''}`;
  if (scopeType === 'CODE_PREFIX') return `Code · ${scopeValue ?? ''}`;
  if (scopeType === 'NONZERO') return 'Only SKUs with stock';
  return 'All SKUs';
};

const actionBtn: React.CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11, 11px)', fontWeight: 700,
  padding: '3px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  border: '1px solid var(--line-strong)', background: 'var(--c-paper)', color: 'var(--c-ink)',
};

export const StockTakeApprovals = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = searchParams.get('scope') === 'all' ? 'all' : 'pending';
  const setScope = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'pending') next.delete('scope'); else next.set('scope', s);
    setSearchParams(next, { replace: true });
  };

  const q = useStockTakes(scope === 'all' ? { submitted: true } : { status: 'PENDING_APPROVAL' });
  const approve = useApproveStockTake();
  const reject = useRejectStockTake();
  const notify = useNotify();
  const { actorNameOf } = useStaffLookup();
  const busy = approve.isPending || reject.isPending;
  const [quickId, setQuickId] = useState<string | null>(null);

  const decide = (r: StockTakeRow, action: 'approve' | 'reject') => {
    const m = action === 'approve' ? approve : reject;
    m.mutate(r.id, {
      onError: (err) => { void notify({ title: action === 'approve' ? "Couldn't approve" : "Couldn't return", body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }); },
    });
  };

  const columns = useMemo<GridColumn<StockTakeRow>[]>(() => [
    {
      key: 'take_no', label: 'Stock Take', width: 170, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.take_no}</span>,
      searchValue: (r) => r.take_no,
      exportValue: (r) => r.take_no,
      sortFn: (a, b) => a.take_no.localeCompare(b.take_no),
    },
    {
      key: 'warehouse', label: 'Warehouse', width: 180, sortable: true, groupable: true,
      accessor: (r) => warehouseLabel(r.warehouse) ?? r.warehouse_id,
      searchValue: (r) => warehouseLabel(r.warehouse) ?? '',
      groupValue: (r) => warehouseLabel(r.warehouse) ?? r.warehouse_id,
    },
    {
      key: 'scope', label: 'Scope', width: 180,
      accessor: (r) => scopeLabel(r.scope_type, r.scope_value),
      searchValue: (r) => `${r.scope_type} ${r.scope_value ?? ''}`,
    },
    {
      key: 'submitted_by', label: 'Submitted by', width: 160, sortable: true, groupable: true,
      accessor: (r) => (r.submitted_by ? actorNameOf(r.submitted_by) : '—'),
      searchValue: (r) => (r.submitted_by ? actorNameOf(r.submitted_by) : ''),
    },
    {
      key: 'submitted_at', label: 'Submitted', width: 160, sortable: true,
      accessor: (r) => (r.submitted_at ? fmtDateTime(r.submitted_at) : '—'),
      sortFn: (a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''),
      filterType: 'date', dateValue: (r) => r.submitted_at ?? undefined,
    },
    {
      key: 'take_date', label: 'Take date', width: 120, sortable: true,
      accessor: (r) => fmtDate(r.take_date),
      sortFn: (a, b) => a.take_date.localeCompare(b.take_date),
      filterType: 'date', dateValue: (r) => r.take_date,
    },
    {
      key: 'variance', label: 'Net variance', width: 120, align: 'right', sortable: true,
      accessor: (r) => (r.variance_total == null ? '—' : `${r.variance_total > 0 ? '+' : ''}${fmtQty(r.variance_total)}`),
      sortFn: (a, b) => (a.variance_total ?? 0) - (b.variance_total ?? 0),
      exportValue: (r) => r.variance_total ?? 0,
    },
    {
      key: 'status', label: 'Status', width: 150, sortable: true, groupable: true,
      accessor: (r) => <StatusPill docType="stockTake" status={r.status} />,
      searchValue: (r) => r.status,
      groupValue: (r) => r.status,
      sortFn: (a, b) => a.status.localeCompare(b.status),
    },
    {
      key: 'actions', label: 'Actions', width: 180,
      accessor: (r) => (r.status !== 'PENDING_APPROVAL' ? null : (
        <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button type="button" style={actionBtn} disabled={busy} onClick={() => decide(r, 'approve')}>Approve</button>
          <button type="button" style={actionBtn} disabled={busy} onClick={() => decide(r, 'reject')}>Return</button>
        </span>
      )),
      exportValue: () => '',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the action closures read the latest hooks on click; the column set itself is static
  ], [busy]);

  const rows = q.data ?? [];
  const pendingCount = rows.filter((r) => r.status === 'PENDING_APPROVAL').length;
  const quick = quickId ? (rows.find((r) => r.id === quickId) ?? null) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Approval inbox"
        title="Stock Take Approvals"
        description={
          q.isLoading
            ? 'Loading…'
            : `${pendingCount} waiting — over-limit counts a supervisor must approve before they post`
        }
      />

      <div className="space-y-4">
        {q.isError && (
          <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-2.5 text-[12.5px] text-err">
            <strong className="font-semibold">Failed to load.</strong>{' '}
            {q.error instanceof Error ? q.error.message : 'Something went wrong.'}
          </div>
        )}

        <FilterPills
          options={CHIPS.map((c) => ({ value: c.value, label: c.label, count: c.value === 'pending' ? pendingCount : undefined }))}
          value={scope}
          onChange={(v) => setScope(v)}
        />

        <DataGridCompat<StockTakeRow>
          rows={rows}
          columns={columns}
          storageKey={STORAGE_KEY}
          exportName="Stock Take Approvals"
          rowKey={(r) => r.id}
          searchPlaceholder="Search take no, warehouse, submitted by…"
          loadedSearchLimit={500}
          groupBanner={false}
          onRowClick={(r) => setQuickId(r.id)}
          onRowDoubleClick={(r) => navigate(stockTakePath(r))}
          rowStyle={(r) => (r.status === 'PENDING_APPROVAL' ? undefined : { opacity: 0.6, filter: 'grayscale(0.4)' })}
          isLoading={q.isLoading}
          emptyMessage={scope === 'pending' ? 'Nothing is waiting for approval.' : 'No submitted counts yet.'}
        />
      </div>

      <StockTakeApprovalQuickView row={quick} onClose={() => setQuickId(null)} />
    </div>
  );
};

export default StockTakeApprovals;
