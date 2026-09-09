// ----------------------------------------------------------------------------
// CancelRequests — the cancellation-request inbox: every request to cancel a
// Sales Order or a Purchase Order, newest first, with the approver's actions
// on the row (owner 2026-09-08, 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」).
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
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { usePrompt } from '../../vendor/scm/components/PromptDialog';
import { serviceNotify } from '../../vendor/scm/lib/dialog-service';
import { STATUS_TONES } from '../../vendor/scm/lib/status-pill';
import { useUpdateMfgSalesOrderStatus } from '../../vendor/scm/lib/sales-order-queries';
import { useCancelPurchaseOrder } from '../../vendor/scm/lib/suppliers-queries';
import {
  approveLabel,
  cancelRequestLine,
  docTypeOfRow,
  isFinalLevel,
  levelsFor,
  isOpenCancelStatus,
  pendingLevel,
  useApproveCancelRequest,
  useCancelRequests,
  useRejectCancelRequest,
  useWithdrawCancelRequest,
  viewerCanApprove,
  viewerCanReject,
  viewerCanWithdraw,
  type CancelRequestRow,
} from '../../vendor/scm/lib/document-cancel-queries';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';

const STORAGE_KEY = 'cancel-request-list.layout.v1';

const CHIPS = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
] as const;

const DOC_LABEL: Record<CancelRequestRow['doc_type'], string> = { SO: 'Sales Order', PO: 'Purchase Order' };

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
  const askPrompt = usePrompt();
  const askConfirm = useConfirm();

  const approveSo = useApproveCancelRequest('so');
  const approvePo = useApproveCancelRequest('po');
  const rejectSo = useRejectCancelRequest('so');
  const rejectPo = useRejectCancelRequest('po');
  const withdrawSo = useWithdrawCancelRequest('so');
  const withdrawPo = useWithdrawCancelRequest('po');
  const cancelSo = useUpdateMfgSalesOrderStatus();
  const cancelPo = useCancelPurchaseOrder();

  const fail = (title: string, err: unknown) =>
    serviceNotify({ title, body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });

  /** The document's own cancel — the executor behind a level-2 approve. */
  const execute = async (row: CancelRequestRow) => {
    if (row.doc_type === 'SO') {
      await cancelSo.mutateAsync({ docNo: row.doc_key, status: 'CANCELLED', expectedStatus: row.doc_status_at_request ?? null });
    } else {
      await cancelPo.mutateAsync(row.doc_key);
    }
    void serviceNotify({ title: `${DOC_LABEL[row.doc_type]} ${row.doc_number} cancelled`, body: 'The approval is complete and the cancellation has run.' });
  };

  const doApprove = async (row: CancelRequestRow) => {
    const level = pendingLevel(row.status);
    const final = level != null && isFinalLevel(docTypeOfRow(row), level);
    if (!(await askConfirm({
      title: final ? `Approve and cancel ${row.doc_number}?` : `Give level-1 approval to cancel ${row.doc_number}?`,
      body: final
        ? 'This is the final approval. The document is cancelled on your signature.'
        : 'Level 2 still has to approve after you. Nothing is cancelled yet.',
      confirmLabel: final ? 'Approve & cancel' : 'Approve (level 1)',
      danger: final,
    }))) return;
    try {
      const res = await (docTypeOfRow(row) === 'so' ? approveSo : approvePo).mutateAsync({ key: row.doc_key });
      if (res.execute) await execute(row);
    } catch (err) {
      void fail('Could not approve', err);
    }
  };

  const doReject = async (row: CancelRequestRow) => {
    const reason = await askPrompt({
      title: `Reject the cancellation of ${row.doc_number}?`,
      body: 'The document keeps its status. Say why, so the person who raised it knows — they will see this.',
      multiline: true,
      confirmLabel: 'Reject request',
      validate: (v) => (v.trim().length < 5 ? 'Give a reason the requester can act on — at least a few words.' : null),
    });
    if (reason == null) return;
    try { await (docTypeOfRow(row) === 'so' ? rejectSo : rejectPo).mutateAsync({ key: row.doc_key, reason: reason.trim() }); } catch (err) { void fail('Could not reject', err); }
  };

  const doWithdraw = async (row: CancelRequestRow) => {
    if (!(await askConfirm({ title: `Withdraw the cancellation request on ${row.doc_number}?`, confirmLabel: 'Withdraw request' }))) return;
    try { await (docTypeOfRow(row) === 'so' ? withdrawSo : withdrawPo).mutateAsync({ key: row.doc_key }); } catch (err) { void fail('Could not withdraw', err); }
  };

  const openRow = (row: CancelRequestRow) => {
    navigate(row.doc_type === 'SO' ? `/scm/sales-orders/${encodeURIComponent(row.doc_key)}` : `/scm/purchase-orders/${row.doc_key}`);
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
      accessor: (r) => {
        const level = pendingLevel(r.status);
        const final = level != null && isFinalLevel(docTypeOfRow(r), level);
        return (
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }} onDoubleClick={(e) => e.stopPropagation()}>
            {viewerCanApprove(r, viewer) && level != null && (
              <button type="button" style={{ ...actionBtn, ...(final ? { borderColor: 'var(--c-festive-b, #B8331F)', color: 'var(--c-festive-b, #B8331F)' } : {}) }} onClick={() => void doApprove(r)}>
                {final ? 'Approve & cancel' : approveLabel(docTypeOfRow(r), level)}
              </button>
            )}
            {r.status === 'APPROVED' && (
              <button type="button" style={{ ...actionBtn, borderColor: 'var(--c-festive-b, #B8331F)', color: 'var(--c-festive-b, #B8331F)' }} onClick={() => void execute(r).catch((err) => fail('Cancel failed', err))}>Cancel now</button>
            )}
            {viewerCanReject(r, viewer) && <button type="button" style={actionBtn} onClick={() => void doReject(r)}>Reject</button>}
            {viewerCanWithdraw(r, viewer) && <button type="button" style={actionBtn} onClick={() => void doWithdraw(r)}>Withdraw</button>}
          </span>
        );
      },
      exportValue: () => '',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the action closures read the latest hooks on click; the column set itself is static
  ], [viewer]);

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
            : `${openCount} open request${openCount === 1 ? '' : 's'} — a Sales Order is cancelled after two approvals, a Purchase Order after one`
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
