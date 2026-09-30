// ----------------------------------------------------------------------------
// PaymentBackdateRequests — the admin inbox for Sales Order payments whose slip
// date is more than 14 days old (owner 2026-09-30: 「balance collection 需要
// request key in 如果是超过14天 from today - 只有 admin 可以看到 request」).
// Only a holder of `scm.payment.backdate` reaches it (route, sidebar and the
// server all ask that key). Approve books the payment; Reject records nothing.
// Double-clicking a row opens the Sales Order.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDate, fmtDateTime, fmtMoneySen } from '../../vendor/shared/format';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { PAYMENT_METHOD_CODE_TO_VALUE } from '../../vendor/scm/lib/payment-methods';
import { useBackdateDecisions } from '../../vendor/scm/components/BackdateRequestsPanel';
import { backdateStatusLabel, useBackdateInbox, type BackdateRequestRow } from '../../vendor/scm/lib/payment-backdate-queries';

const STORAGE_KEY = 'payment-backdate-requests.layout.v1';

const CHIPS = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
] as const;

const methodLabel = (code: string): string =>
  (PAYMENT_METHOD_CODE_TO_VALUE as Record<string, string>)[code] ?? code;

const actionBtn: React.CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11, 11px)', fontWeight: 700,
  padding: '3px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  border: '1px solid var(--line-strong)', background: 'var(--c-paper)', color: 'var(--c-ink)',
};

export const PaymentBackdateRequests = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = searchParams.get('scope') === 'all' ? 'all' : 'open';
  const setScope = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'open') next.delete('scope'); else next.set('scope', s);
    setSearchParams(next, { replace: true });
  };

  const q = useBackdateInbox(scope);
  const { run, busy } = useBackdateDecisions();

  const columns = useMemo<GridColumn<BackdateRequestRow>[]>(() => [
    {
      key: 'so', label: 'Sales Order', width: 170, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.so_doc_no}</span>,
      searchValue: (r) => r.so_doc_no,
      exportValue: (r) => r.so_doc_no,
      sortFn: (a, b) => a.so_doc_no.localeCompare(b.so_doc_no),
    },
    {
      key: 'paid_at', label: 'Slip Date', width: 120, sortable: true,
      accessor: (r) => fmtDate(r.paid_at),
      searchValue: (r) => r.paid_at,
      sortFn: (a, b) => a.paid_at.localeCompare(b.paid_at),
      filterType: 'date', dateValue: (r) => r.paid_at,
    },
    {
      key: 'amount', label: 'Amount', width: 130, sortable: true, align: 'right',
      accessor: (r) => fmtMoneySen(r.amount_sen),
      exportValue: (r) => Number(r.amount_sen) / 100,
      exportFormat: 'money',
      sortFn: (a, b) => Number(a.amount_sen) - Number(b.amount_sen),
    },
    {
      key: 'method', label: 'Method', width: 150, sortable: true, groupable: true,
      accessor: (r) => [methodLabel(r.method), r.merchant_provider ?? r.online_type].filter(Boolean).join(' · '),
      searchValue: (r) => `${methodLabel(r.method)} ${r.merchant_provider ?? ''} ${r.online_type ?? ''}`,
      groupValue: (r) => methodLabel(r.method),
    },
    {
      key: 'requested_by', label: 'Requested by', width: 160, sortable: true, groupable: true,
      accessor: (r) => r.requested_by_name ?? '—',
      searchValue: (r) => r.requested_by_name ?? '',
      sortFn: (a, b) => (a.requested_by_name ?? '').localeCompare(b.requested_by_name ?? ''),
    },
    {
      key: 'reason', label: 'Reason', width: 280, minWidth: 160,
      accessor: (r) => r.reason,
      searchValue: (r) => r.reason,
    },
    {
      key: 'status', label: 'Status', width: 140, sortable: true, groupable: true,
      accessor: (r) => backdateStatusLabel(r.status),
      groupValue: (r) => backdateStatusLabel(r.status),
      sortFn: (a, b) => a.status.localeCompare(b.status),
    },
    {
      key: 'decided', label: 'Decided', width: 220,
      accessor: (r) => (r.decided_at ? `${r.decided_by_name ?? 'someone'} · ${fmtDateTime(r.decided_at)}${r.decision_note ? ` — ${r.decision_note}` : ''}` : '—'),
      searchValue: (r) => `${r.decided_by_name ?? ''} ${r.decision_note ?? ''}`,
    },
    {
      key: 'requested_at', label: 'Requested', width: 160, sortable: true,
      accessor: (r) => fmtDateTime(r.requested_at),
      sortFn: (a, b) => a.requested_at.localeCompare(b.requested_at),
      filterType: 'date', dateValue: (r) => r.requested_at,
    },
    {
      key: 'actions', label: 'Actions', width: 170,
      accessor: (r) => (r.status !== 'REQUESTED' ? null : (
        <span style={{ display: 'inline-flex', gap: 6 }} onDoubleClick={(e) => e.stopPropagation()}>
          <button type="button" style={actionBtn} disabled={busy} onClick={() => void run(r, 'approve')}>Approve</button>
          <button type="button" style={actionBtn} disabled={busy} onClick={() => void run(r, 'reject')}>Reject</button>
        </span>
      )),
      exportValue: () => '',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the action closures read the latest hooks on click; the column set itself is static
  ], [busy]);

  const rows = q.data?.requests ?? [];
  const openCount = rows.filter((r) => r.status === 'REQUESTED').length;

  return (
    <div>
      <PageHeader
        eyebrow="Approval inbox"
        title="Payment Backdate Requests"
        description={
          q.isLoading
            ? 'Loading requests…'
            : `${openCount} waiting — payments whose slip date is more than 14 days old; approving records the payment on its Sales Order`
        }
      />

      <div className="space-y-4">
        {q.isError && (
          <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-2.5 text-[12.5px] text-err">
            <strong className="font-semibold">Failed to load requests.</strong>{' '}
            {q.error.message || 'Something went wrong.'}
          </div>
        )}

        <FilterPills
          options={CHIPS.map((c) => ({ value: c.value, label: c.label, count: c.value === 'open' ? openCount : undefined }))}
          value={scope}
          onChange={(v) => setScope(v)}
        />

        <DataGridCompat<BackdateRequestRow>
          rows={rows}
          columns={columns}
          storageKey={STORAGE_KEY}
          exportName="Payment Backdate Requests"
          rowKey={(r) => r.id}
          searchPlaceholder="Search SO no, requested by, reason…"
          loadedSearchLimit={500}
          groupBanner={false}
          onRowDoubleClick={(r) => navigate(`/scm/sales-orders/${encodeURIComponent(r.so_doc_no)}`)}
          rowStyle={(r) => (r.status === 'REQUESTED' ? undefined : { opacity: 0.6, filter: 'grayscale(0.4)' })}
          isLoading={q.isLoading}
          emptyMessage={scope === 'open' ? 'Nothing is waiting for approval.' : 'No backdate requests yet.'}
        />
      </div>
    </div>
  );
};

export default PaymentBackdateRequests;
