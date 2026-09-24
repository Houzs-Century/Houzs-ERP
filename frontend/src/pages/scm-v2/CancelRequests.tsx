// ----------------------------------------------------------------------------
// CancelRequests — the cancellation-request inbox: every request to cancel a
// Sales Order or a Purchase Order, newest first, with the approver's actions
// on the row (owner 2026-09-08, 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」).
// Under All it is also the record of every Purchase Order and Delivery Order
// cancelled on its reason alone (2026-09-09 / 2026-09-14) — rows with nothing
// left to sign.
//
// ONE queue for BOTH documents, on purpose: the people who sign are the same
// desks whichever document it is, and an approver should not have to open two
// screens to find out what is waiting for them. Double-clicking a row opens
// the document itself, whose CancelRequestPanel carries the same actions.
//
// The level-2 approve runs the document's OWN cancel mutation afterwards —
// the same one the Cancel button always ran — so every guard the cancel
// carries stays where it is; if that cancel is refused the row stays APPROVED
// and says so, and the document page's "Cancel now" retries it.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDateTime } from '../../vendor/shared/format';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { STATUS_TONES } from '../../vendor/scm/lib/status-pill';
import {
  cancelRequestLine,
  docTypeOfRow,
  levelsFor,
  isOpenCancelStatus,
  useCancelRequests,
  viewerCanApprove,
  viewerCanReject,
  viewerCanWithdraw,
  type CancelRequestRow,
} from '../../vendor/scm/lib/document-cancel-queries';
/* The four actions are the SHARED flow — the SO Amendment queue (desktop and
   phone) puts the same buttons on the same rows since owner 2026-09-24, and a
   second hand-written copy of "the final approve must then run the document's
   own cancel" is exactly the copy that would forget to. */
import {
  approveButtonLabel,
  approveIsFinal,
  useCancelRequestActions,
} from '../../vendor/scm/lib/use-cancel-request-actions';

import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';

const STORAGE_KEY = 'cancel-request-list.layout.v1';

const CHIPS = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
] as const;

const DOC_LABEL: Record<CancelRequestRow['doc_type'], string> = { SO: 'Sales Order', PO: 'Purchase Order', DO: 'Delivery Order' };

/* doc_key is each document's own route key: the Sales Order's number, the
   Purchase Order's and the Delivery Order's id. */
const DOC_PATH: Record<CancelRequestRow['doc_type'], (key: string) => string> = {
  SO: (key) => `/scm/sales-orders/${encodeURIComponent(key)}`,
  PO: (key) => `/scm/purchase-orders/${key}`,
  DO: (key) => `/scm/delivery-orders/${key}`,
};

function StatusCell({ row }: { row: CancelRequestRow }) {
  const tone = row.status === 'APPROVED' || row.status === 'EXECUTED' ? STATUS_TONES.danger
    : row.status === 'REJECTED' || row.status === 'WITHDRAWN' ? STATUS_TONES.neutral
    : STATUS_TONES.pending;
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 'var(--fs-11)', fontWeight: 600, background: tone.bg, color: tone.fg }}>
      {cancelRequestLine(row)}
    </span>
  );
}

const who = (name: string | null | undefined, at: string | null | undefined) =>
  at ? `${(name ?? '').trim() || 'someone'} · ${fmtDateTime(at)}` : '—';

const actionBtn: React.CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11, 11px)', fontWeight: 700,
  padding: '3px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  border: '1px solid var(--line-strong)', background: 'var(--c-paper)', color: 'var(--c-ink)',
};

export const CancelRequests = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = searchParams.get('scope') === 'all' ? 'all' : 'open';
  const setScope = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'open') next.delete('scope'); else next.set('scope', s);
    setSearchParams(next, { replace: true });
  };

  const q = useCancelRequests(scope);
  const { user, can } = useHouzsAuth();
  const viewer = useMemo(() => ({ userId: user?.id ?? null, can }), [user?.id, can]);
  const actions = useCancelRequestActions();

  const openRow = (row: CancelRequestRow) => {
    navigate(DOC_PATH[row.doc_type](row.doc_key));
  };

  const columns = useMemo<DataGridColumn<CancelRequestRow>[]>(() => [
    {
      key: 'doc', label: 'Document', width: 200, sortable: true, groupable: true,
      accessor: (r) => (
        <span>
          <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginRight: 6 }}>{r.doc_type}</span>
          <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.doc_number}</span>
        </span>
      ),
      searchValue: (r) => `${r.doc_type} ${r.doc_number}`,
      exportValue: (r) => `${r.doc_type} ${r.doc_number}`,
      groupValue: (r) => DOC_LABEL[r.doc_type],
      sortFn: (a, b) => a.doc_number.localeCompare(b.doc_number),
    },
    {
      key: 'requested_by', label: 'Requested by', width: 170, sortable: true, groupable: true,
      accessor: (r) => r.requested_by_name ?? '—',
      searchValue: (r) => r.requested_by_name ?? '',
      sortFn: (a, b) => (a.requested_by_name ?? '').localeCompare(b.requested_by_name ?? ''),
    },
    {
      key: 'reason', label: 'Reason', width: 280, minWidth: 160, sortable: true,
      accessor: (r) => r.reason,
      searchValue: (r) => r.reason,
    },
    {
      key: 'status', label: 'Status', width: 250, sortable: true, groupable: true,
      accessor: (r) => <StatusCell row={r} />,
      searchValue: (r) => cancelRequestLine(r),
      exportValue: (r) => cancelRequestLine(r),
      groupValue: (r) => cancelRequestLine(r),
      sortFn: (a, b) => a.status.localeCompare(b.status),
    },
    {
      key: 'l1', label: 'Level 1 / Approval', width: 190, sortable: true, defaultHidden: false,
      accessor: (r) => who(r.l1_by_name, r.l1_at),
      searchValue: (r) => r.l1_by_name ?? '',
      sortFn: (a, b) => String(a.l1_at ?? '').localeCompare(String(b.l1_at ?? '')),
    },
    {
      key: 'l2', label: 'Level 2', width: 190, sortable: true,
      accessor: (r) => (levelsFor(docTypeOfRow(r)) > 1 ? who(r.l2_by_name, r.l2_at) : <span style={{ color: 'var(--fg-muted)' }}>n/a</span>),
      searchValue: (r) => r.l2_by_name ?? '',
      sortFn: (a, b) => String(a.l2_at ?? '').localeCompare(String(b.l2_at ?? '')),
    },
    {
      key: 'requested_at', label: 'Requested', width: 160, sortable: true,
      accessor: (r) => fmtDateTime(r.requested_at),
      searchValue: (r) => r.requested_at,
      sortFn: (a, b) => a.requested_at.localeCompare(b.requested_at),
      filterType: 'date', dateValue: (r) => r.requested_at,
    },
    {
      key: 'actions', label: 'Actions', width: 260,
      accessor: (r) => (
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }} onDoubleClick={(e) => e.stopPropagation()}>
          {viewerCanApprove(r, viewer) && (
            <button
              type="button"
              style={approveIsFinal(r) ? { ...actionBtn, borderColor: 'var(--c-festive-b, #B8331F)', color: 'var(--c-festive-b, #B8331F)' } : actionBtn}
              disabled={actions.busy}
              onClick={() => void actions.approve(r)}
            >{approveButtonLabel(r)}</button>
          )}
          {r.status === 'APPROVED' && (
            <button type="button" style={{ ...actionBtn, borderColor: 'var(--c-festive-b, #B8331F)', color: 'var(--c-festive-b, #B8331F)' }} disabled={actions.busy} onClick={() => void actions.executeNow(r)}>Cancel now</button>
          )}
          {viewerCanReject(r, viewer) && <button type="button" style={actionBtn} disabled={actions.busy} onClick={() => void actions.reject(r)}>Reject</button>}
          {viewerCanWithdraw(r, viewer) && <button type="button" style={actionBtn} disabled={actions.busy} onClick={() => void actions.withdraw(r)}>Withdraw</button>}
        </span>
      ),
      exportValue: () => '',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the action closures read the latest hooks on click; the column set itself is static
  ], [viewer, actions]);

  const rows = q.data?.requests ?? [];
  const openCount = rows.filter((r) => isOpenCancelStatus(r.status)).length;

  return (
    <div>
      <PageHeader
        eyebrow="Approval inbox"
        title="Cancellation Requests"
        description={
          q.isLoading
            ? 'Loading requests…'
            : `${openCount} open request${openCount === 1 ? '' : 's'} — a Sales Order is cancelled after two approvals; a Purchase Order or Delivery Order on its reason alone`
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

        <DataGrid<CancelRequestRow>
          rows={rows}
          columns={columns}
          storageKey={STORAGE_KEY}
          exportName="Cancellation Requests"
          rowKey={(r) => r.id}
          searchPlaceholder="Search document no, requested by, reason…"
          loadedSearchLimit={500}
          groupBanner={false}
          onRowDoubleClick={(r) => openRow(r)}
          rowStyle={(r) => (isOpenCancelStatus(r.status) ? undefined : { opacity: 0.6, filter: 'grayscale(0.4)' })}
          isLoading={q.isLoading}
          emptyMessage={scope === 'open' ? 'Nothing is waiting for approval.' : 'No cancellation requests yet — raise one from a Sales Order or a Purchase Order.'}
        />
      </div>
    </div>
  );
};

export default CancelRequests;
