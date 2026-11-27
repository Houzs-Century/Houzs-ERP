// ----------------------------------------------------------------------------
// RefundApprovals — refund requests waiting for their one approval (owner
// 2026-11-27: 「只要一级，但这一级的权限和cancel 的第二级一样」), on the desks that
// sign a Sales Order cancellation's second level: the Cancellation Requests
// inbox and the Sales Order Amendment queue. Only a viewer who may approve sees
// it; the requester follows their own on Payment Requests and on the order.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fmtDate, fmtDateTime, fmtSen } from '../../../../shared/src/vendor/shared/format';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { FilterPills } from '../../components/FilterPills';
import {
  STAGE, refundApprovalText, stageLabel, useRefundApprovals, viewerMayApproveRefund, type PaymentRequest,
} from '../../vendor/scm/lib/payment-request-queries';
import { useRefundApprovalActions } from '../../vendor/scm/lib/use-refund-approval-actions';

const STORAGE_KEY = 'refund-approval-list.layout.v1';

const actionBtn: React.CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11, 11px)', fontWeight: 700,
  padding: '3px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  border: '1px solid var(--line-strong)', background: 'var(--c-paper)', color: 'var(--c-ink)',
};

/** Where a refund request stands for its approver: waiting for them, approved and with Finance, or what Finance did since. */
export function refundStatusText(r: PaymentRequest): string {
  return r.stage === 'SUBMITTED' && r.refund_approved_at ? 'Approved — with Finance' : stageLabel(r);
}

/** Who approved it and when — "Purchaser A · 21/11/2026" — or a dash before anyone has. */
export function refundApproverText(r: PaymentRequest): string {
  return refundApprovalText(r, fmtDate)?.replace(/^Approved by /, '') ?? '—';
}

/** `onlyWhenWaiting`: the Amendment queue shows the section only while a refund waits, the Cancellation inbox always. */
export function RefundApprovals({ onlyWhenWaiting }: { onlyWhenWaiting: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = searchParams.get('refunds') === 'all' ? 'all' : 'open';
  const setScope = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'open') next.delete('refunds'); else next.set('refunds', s);
    setSearchParams(next, { replace: true });
  };

  const q = useRefundApprovals(scope);
  const actions = useRefundApprovalActions(null);
  const me = q.data?.me ?? null;
  const mayApprove = q.data?.mayApprove ?? false;

  const columns = useMemo<GridColumn<PaymentRequest>[]>(() => [
    {
      key: 'order', label: 'Sales Order', width: 170, sortable: true,
      accessor: (r) => (r.refund_source_doc_no
        ? <Link to={`/scm/sales-orders/${encodeURIComponent(r.refund_source_doc_no)}`} style={{ fontWeight: 700 }}>{r.refund_source_doc_no}</Link>
        : '—'),
      searchValue: (r) => `${r.refund_source_doc_no ?? ''} ${r.request_no}`,
      exportValue: (r) => r.refund_source_doc_no ?? '',
      sortFn: (a, b) => String(a.refund_source_doc_no ?? '').localeCompare(String(b.refund_source_doc_no ?? '')),
    },
    {
      key: 'request', label: 'Request', width: 150, sortable: true,
      accessor: (r) => r.request_no, searchValue: (r) => r.request_no,
      sortFn: (a, b) => a.request_no.localeCompare(b.request_no),
    },
    {
      key: 'customer', label: 'Refund to', width: 180, sortable: true,
      accessor: (r) => r.payee_name, searchValue: (r) => r.payee_name,
      sortFn: (a, b) => a.payee_name.localeCompare(b.payee_name),
    },
    {
      key: 'amount', label: 'Amount', width: 120, sortable: true,
      accessor: (r) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtSen(r.amount_sen)}</span>,
      exportValue: (r) => r.amount_sen / 100,
      sortFn: (a, b) => a.amount_sen - b.amount_sen,
    },
    {
      key: 'reason', label: 'Reason', width: 260, minWidth: 160,
      accessor: (r) => r.purpose, searchValue: (r) => r.purpose,
    },
    {
      key: 'requested_by', label: 'Requested by', width: 150, sortable: true,
      accessor: (r) => r.requested_by_name ?? '—', searchValue: (r) => r.requested_by_name ?? '',
      sortFn: (a, b) => (a.requested_by_name ?? '').localeCompare(b.requested_by_name ?? ''),
    },
    {
      key: 'requested_at', label: 'Requested', width: 160, sortable: true,
      accessor: (r) => fmtDateTime(r.created_at), searchValue: (r) => r.created_at,
      sortFn: (a, b) => a.created_at.localeCompare(b.created_at),
      filterType: 'date', dateValue: (r) => r.created_at,
    },
    {
      key: 'approved_by', label: 'Approved by', width: 190, sortable: true,
      accessor: (r) => refundApproverText(r), searchValue: (r) => refundApproverText(r),
      sortFn: (a, b) => String(a.refund_approved_at ?? '').localeCompare(String(b.refund_approved_at ?? '')),
    },
    {
      key: 'status', label: 'Status', width: 200, sortable: true,
      accessor: (r) => <span style={{ color: STAGE[r.stage].tone, fontWeight: 600 }}>{refundStatusText(r)}</span>,
      searchValue: (r) => refundStatusText(r), exportValue: (r) => refundStatusText(r),
      sortFn: (a, b) => a.stage.localeCompare(b.stage),
    },
    {
      key: 'actions', label: 'Actions', width: 230,
      accessor: (r) => (viewerMayApproveRefund(r, me, mayApprove)
        ? (
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" style={actionBtn} disabled={actions.busy} onClick={() => void actions.approve(r)}>Approve</button>
            <button type="button" style={actionBtn} disabled={actions.busy} onClick={() => void actions.reject(r)}>Reject</button>
          </span>
        )
        : r.stage === 'AWAITING_APPROVAL' && Number(r.requested_by) === me
          ? <span style={{ color: 'var(--fg-muted)' }}>Your request — someone else approves it</span>
          : null),
      exportValue: () => '',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the action closures read the latest hooks on click; the columns change only with who is looking
  ], [me, mayApprove, actions]);

  if (q.isError) {
    return (
      <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-2.5 text-[12.5px] text-err">
        <strong className="font-semibold">Failed to load refund requests.</strong>{' '}
        {q.error.message || 'Something went wrong.'}
      </div>
    );
  }
  if (!mayApprove) return null;
  const rows = q.data?.requests ?? [];
  if (onlyWhenWaiting && scope === 'open' && rows.length === 0) return null;

  return (
    <section aria-label="Refund requests" className="space-y-3" style={{ marginTop: 28 }}>
      <div>
        <h2 style={{ fontSize: 'var(--fs-16, 16px)', fontWeight: 700, margin: 0 }}>Refund requests</h2>
        <p style={{ margin: '4px 0 0', fontSize: 'var(--fs-12, 12px)', color: 'var(--fg-muted)' }}>
          A customer refund is approved here once, by the people who give a cancellation its second approval, before Finance pays it back.
        </p>
      </div>
      <FilterPills
        options={[
          { value: 'open', label: 'Waiting approval', count: scope === 'open' ? rows.length : undefined },
          { value: 'all', label: 'All' },
        ]}
        value={scope}
        onChange={(v) => setScope(v)}
      />
      <DataGridCompat<PaymentRequest>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        exportName="Refund requests"
        rowKey={(r) => r.id}
        searchPlaceholder="Search order, request no, customer, reason…"
        loadedSearchLimit={200}
        groupBanner={false}
        isLoading={q.isLoading}
        emptyMessage={scope === 'open' ? 'No refund is waiting for approval.' : 'No refund requests yet.'}
      />
    </section>
  );
}

export default RefundApprovals;
