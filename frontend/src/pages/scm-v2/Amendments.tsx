// ----------------------------------------------------------------------------
// Amendments — the SO-amendment / revision inbox (Phase 1-C). A DataGrid queue
// of every amendment across all Sales Orders, Requested first, newest first
// within a status. HOUZS VENDOR port
// of 2990's apps/backend/src/pages/Amendments.tsx.
//
// Row-click routing (Houzs 2026-07-15): a double-click now opens the amendment
// job card (AmendmentDetailV2, /scm/amendments/:id) — the before/after diff +
// revision-status hero + gate actions. That detail page hands off into the SO
// editor (/scm/sales-orders/:docNo?edit=1, which hosts the pending banner + the
// legacy line editor) or the bound-PO editor for the later gates, so the queue
// no longer needs to resolve the bound PO itself. A SINGLE click opens the quick
// view drawer (AmendmentQuickView), like the Sales Order list (owner 2026-09-14).
//
// CANCELLATION REQUESTS SHOW HERE TOO (owner 2026-09-24: 「当有 SO request cancel
// bill - 需要在 SO amendment 出现」). A request to cancel a Sales Order waits on
// the same desks this queue serves, so it is a row in it, with its approve /
// reject / withdraw ON the row — an approver signs without leaving the queue.
// The merge + the row shape are shared with the phone (vendor/scm/lib/
// amendment-queue-rows.ts); the actions are the same flow the Cancellation
// Requests inbox and the document's own card run (use-cancel-request-actions).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AmendmentQuickView, amendmentJobCardPath, type AmendmentQuickViewTarget } from './AmendmentQuickView';
import { fmtDateTime } from '../../vendor/shared/format';
import { useAmendments, type AmendmentRow } from '../../vendor/scm/lib/so-amendment-queries';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { TonedPill } from '../../vendor/scm/components/StatusPill';
import { QueueApproverBadge } from '../../vendor/scm/components/AmendmentApproverBadge';
import {
  AMENDMENT_LIST_CHIPS,
  amendmentBucketLabel,
  amendmentBucketRank,
  compareAmendmentsForList,
  simplifiedAmendmentPill,
} from '../../vendor/scm/lib/status-pill';
import {
  buildAmendmentQueueRows,
  type AmendmentQueueRow,
} from '../../vendor/scm/lib/amendment-queue-rows';
import {
  useCancelRequests,
  viewerCanApprove,
  viewerCanReject,
  viewerCanWithdraw,
} from '../../vendor/scm/lib/document-cancel-queries';
import {
  approveButtonLabel,
  approveIsFinal,
  useCancelRequestActions,
} from '../../vendor/scm/lib/use-cancel-request-actions';
import { useRefreshApprovalBadges } from '../../hooks/useAmendmentApprovals';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import { customerRefOf } from '../../lib/customer-ref';

// SIMPLIFIED status filter (owner 2026-07-24; Rejected added 2026-09-17): Requested / Approved / Rejected / All.
// The backend so_amendment_status enum still carries the granular two-gate values
// (SUPPLIER_PENDING / SO_APPROVED / PO_APPROVED / SENT) the 2990 mirror + the SO
// detail stepper depend on — the queue just collapses them into the three buckets
// via amendmentBucketOf. A cancellation request's own statuses collapse the same
// way (cancelBucketOf), so one chip counts both kinds of row.
const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

/* New unique storage key — NEVER reuse another list's key. */
const AMENDMENT_LIST_STORAGE_KEY = 'so-amendment-list.layout.v1';

/* Opens with Requested on top (status-pill.ts owns the order), EVERY time: the
   grid is sortForSessionOnly, so a header click sorts this visit and is not
   remembered. A remembered Status sort had put Requested at the bottom
   (owner 2026-09-14). */
const OPEN_ORDER = compareAmendmentsForList<AmendmentQueueRow>((r) => r.bucket, (r) => r.createdAt);

/* The SO's own customer reference, by the rule the Sales Order list uses. */
const referenceOf = (a: AmendmentRow): string =>
  customerRefOf({ ref: a.so_ref, customer_so_no: a.so_customer_so_no });

const actionBtn: React.CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11, 11px)', fontWeight: 700,
  padding: '3px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  border: '1px solid var(--line-strong)', background: 'var(--c-paper)', color: 'var(--c-ink)',
};
const dangerBtn: React.CSSProperties = { ...actionBtn, borderColor: 'var(--c-festive-b, #B8331F)', color: 'var(--c-festive-b, #B8331F)' };

const badge = (tone: { bg: string; fg: string }): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 999,
  fontSize: 'var(--fs-11)', fontWeight: 700, background: tone.bg, color: tone.fg,
});

/* `requested_by` on an amendment is a bare scm.staff uuid (so_amendments
   .requested_by, FK -> scm.staff.id) — the list endpoint sends no name with it.
   Resolve through the shared staff roster exactly as the SO / DO / SI lists
   resolve salesperson_id; search / group / sort all key off the RESOLVED name so
   the column behaves as the person column it presents itself to be. A
   cancellation row already carries the name its own endpoint resolved. */
const buildAmendmentColumns = (
  actorNameOf: (id: string | null | undefined, empty?: string) => string,
  actions: (r: AmendmentQueueRow) => React.ReactNode,
): GridColumn<AmendmentQueueRow>[] => {
  const requesterOf = (r: AmendmentQueueRow, empty = '—'): string =>
    r.requestedByName ?? actorNameOf(r.requestedByStaffId, empty);
  return [
    {
      key: 'so_doc_no', label: 'SO No.', width: 140, sortable: true, groupable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.soDocNo}</span>,
      searchValue: (r) => r.soDocNo,
      // accessor is JSX → export the raw SO-no string so the column isn't blank.
      exportValue: (r) => r.soDocNo,
      groupValue: (r) => r.soDocNo,
      sortFn: (a, b) => a.soDocNo.localeCompare(b.soDocNo),
    },
    {
      // Owner 2026-09-14: 「要加上reference number」.
      key: 'reference', label: 'Ref No.', width: 140, sortable: true,
      accessor: (r) => r.reference || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
      searchValue: (r) => r.reference,
      exportValue: (r) => r.reference || '—',
      sortFn: (a, b) => a.reference.localeCompare(b.reference),
    },
    {
      /* Amendment or cancellation — the queue carries both since 2026-09-24,
         and the two are acted on in different places, so the row has to say
         which it is before anything else about it is read. */
      key: 'kind', label: 'Type', width: 120, sortable: true, groupable: true,
      accessor: (r) => (
        r.kind === 'CANCEL'
          ? <span style={badge(r.approverTone)}>{r.kindLabel}</span>
          : <span style={{ color: 'var(--fg-muted)' }}>{r.kindLabel}</span>
      ),
      searchValue: (r) => r.kindLabel,
      exportValue: (r) => r.kindLabel,
      groupValue: (r) => r.kindLabel,
      sortFn: (a, b) => a.kindLabel.localeCompare(b.kindLabel),
    },
    {
      key: 'amendment_no', label: 'Amendment No.', width: 140, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.numberLabel}</span>,
      searchValue: (r) => r.numberLabel,
      exportValue: (r) => r.numberLabel,
      sortFn: (a, b) => a.numberLabel.localeCompare(b.numberLabel),
    },
    {
      /* Two-lane rework — WHO this request is waiting on: product changes sign
         with Purchaser, delivery changes with Logistic. Pre-rework rows (lane
         NULL) show the legacy multi-gate chain as "Legacy". A cancellation
         waits on the Sales Director, then the Purchaser. A coloured badge since
         owner 2026-09-14 — grey text did not say whose it was at a glance. */
      key: 'lane', label: 'Approver', width: 140, sortable: true, groupable: true,
      accessor: (r) => <QueueApproverBadge approverKey={r.approverKey} label={r.approverLabel} tone={r.approverTone} />,
      searchValue: (r) => r.approverLabel,
      exportValue: (r) => r.approverLabel,
      groupValue: (r) => r.approverLabel,
      sortFn: (a, b) => a.approverLabel.localeCompare(b.approverLabel),
    },
    {
      key: 'requested_by', label: 'Requested by', width: 200, sortable: true, groupable: true,
      accessor: (r) => requesterOf(r),
      searchValue: (r) => requesterOf(r, ''),
      exportValue: (r) => requesterOf(r),
      groupValue: (r) => requesterOf(r, '(none)'),
      sortFn: (a, b) => requesterOf(a, '').localeCompare(requesterOf(b, '')),
    },
    {
      /* A cancellation's reason IS the request, so this column is no longer
         hidden by default the way an amendment's optional note was. */
      key: 'reason', label: 'Reason', width: 240, minWidth: 160, sortable: true,
      accessor: (r) => r.reason || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
      searchValue: (r) => r.reason,
      exportValue: (r) => r.reason || '—',
      sortFn: (a, b) => a.reason.localeCompare(b.reason),
    },
    {
      key: 'status', label: 'Status', width: 210, sortable: true, groupable: true,
      /* An amendment collapses to Requested / Approved / Rejected; a
         cancellation says which signature it is on ("waiting for level-2
         approval (1 of 2)") — the chips still group both by the same buckets. */
      accessor: (r) => <TonedPill label={r.statusLabel} tone={simplifiedAmendmentPill(r.bucket).tone} />,
      searchValue: (r) => r.statusLabel,
      groupValue: (r) => amendmentBucketLabel(r.bucket),
      exportValue: (r) => r.statusLabel,
      // Ascending = Requested -> Approved -> Rejected, not the bucket names A-Z.
      sortFn: (a, b) => amendmentBucketRank(a.bucket) - amendmentBucketRank(b.bucket),
    },
    {
      key: 'created_at', label: 'Created', width: 160, sortable: true,
      accessor: (r) => (r.createdAt ? fmtDateTime(r.createdAt) : '—'),
      searchValue: (r) => r.createdAt ?? '',
      sortFn: (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
      filterType: 'date', dateValue: (r) => r.createdAt,
    },
    {
      /* Only a cancellation row acts here. An amendment is approved on its job
         card, where the approver can first read the diff — a one-click approve
         in a list would be a signature given without seeing what was signed. */
      key: 'actions', label: 'Actions', width: 260,
      accessor: (r) => actions(r),
      exportValue: () => '',
    },
  ];
};

export const Amendments = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = useAmendments();
  /* 'all', not 'open': the queue's Approved / Rejected chips have to be true of
     cancellations too. A caller without the inbox's read permission simply gets
     no cancellation rows — this read must never fail the amendments queue, so
     its error is deliberately not surfaced in the banner below. */
  const cancels = useCancelRequests('all');
  const { actorNameOf } = useStaffLookup();
  const { user, can } = useHouzsAuth();
  const viewer = useMemo(() => ({ userId: user?.id ?? null, can }), [user?.id, can]);
  const refreshBadges = useRefreshApprovalBadges();
  const cancelActions = useCancelRequestActions(refreshBadges);

  const allRows = useMemo<AmendmentQueueRow[]>(
    () => buildAmendmentQueueRows(data?.amendments ?? [], cancels.data?.requests ?? [], referenceOf),
    [data, cancels.data],
  );
  const rows = useMemo<AmendmentQueueRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((r) => r.bucket === statusChip)),
    [allRows, statusChip],
  );

  /* Which buttons a person sees is decided by the same rules the server
     enforces (document-cancel-queries viewerCan*), and only so that nobody is
     shown a button that will 403 — the server's answer is the gate. */
  const renderActions = (r: AmendmentQueueRow): React.ReactNode => {
    const row = r.cancel;
    if (!row) return null;
    return (
      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }} onDoubleClick={(e) => e.stopPropagation()}>
        {viewerCanApprove(row, viewer) && (
          <button
            type="button"
            style={approveIsFinal(row) ? dangerBtn : actionBtn}
            disabled={cancelActions.busy}
            onClick={(e) => { e.stopPropagation(); void cancelActions.approve(row); }}
          >{approveButtonLabel(row)}</button>
        )}
        {row.status === 'APPROVED' && (
          <button
            type="button"
            style={dangerBtn}
            disabled={cancelActions.busy}
            onClick={(e) => { e.stopPropagation(); void cancelActions.executeNow(row); }}
          >Cancel now</button>
        )}
        {viewerCanReject(row, viewer) && (
          <button type="button" style={actionBtn} disabled={cancelActions.busy}
            onClick={(e) => { e.stopPropagation(); void cancelActions.reject(row); }}>Reject</button>
        )}
        {viewerCanWithdraw(row, viewer) && (
          <button type="button" style={actionBtn} disabled={cancelActions.busy}
            onClick={(e) => { e.stopPropagation(); void cancelActions.withdraw(row); }}>Withdraw</button>
        )}
      </span>
    );
  };

  // actorNameOf identity changes when the staff roster lands — rebuild so the
  // column re-renders with real names instead of staying on the loading dash.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- renderActions reads the latest hooks on click; the column set itself is static
  const columns = useMemo(() => buildAmendmentColumns(actorNameOf, renderActions), [actorNameOf, viewer, cancelActions.busy]);

  /* Row-click routing (2026-07-15) — open the amendment job card. The detail
     page owns the diff + revision-status hero + gate actions, and hands off
     into the SO / bound-PO editor for the deeper line edits. A cancellation has
     no job card: it opens the Sales Order, whose cancellation card carries the
     same actions beside the document itself. */
  const openRow = (r: AmendmentQueueRow) => {
    if (r.amendment) navigate(amendmentJobCardPath({ kind: 'so', id: r.amendment.id }));
    else navigate(`/scm/sales-orders/${encodeURIComponent(r.cancel?.doc_key ?? r.soDocNo)}`);
  };
  const [quick, setQuick] = useState<AmendmentQuickViewTarget | null>(null);

  return (
    <div className={quick ? 'md:pr-[540px]' : undefined}>
      <PageHeader
        eyebrow="Revision inbox"
        title="Amendments"
        description={
          isLoading
            ? 'Loading amendments…'
            : `${rows.length} amendment${rows.length === 1 ? '' : 's'} and cancellation request${rows.length === 1 ? '' : 's'} across all Sales Orders`
        }
      />

      <div className="space-y-4">
        {error && !isLoading && (
          <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-2.5 text-[12.5px] text-err">
            <strong className="font-semibold">Failed to load amendments.</strong>{' '}
            {/* authedFetch already ran this through humanApiError, so `message`
                is a plain sentence; the fallback covers a non-Error throw. */}
            {error instanceof Error ? error.message : 'Something went wrong.'}
          </div>
        )}

        {/* Status strip — the SO page's OWN FilterPills component (owner
            2026-07-26, red box on the SO ALL·73 strip: "amendment要和sales
            order红色标记那样"): the white slab with borderless pills, active
            petrol. Counted labels off the loaded set — this list filters
            client-side, so allRows is the whole population. Using the shared
            component (not a spec copy) so the two strips can never drift. */}
        <FilterPills
          options={STATUS_CHIPS.map((s) => ({
            value: s,
            label: amendmentBucketLabel(s),
            count: s === 'all' ? allRows.length : allRows.filter((r) => r.bucket === s).length,
          }))}
          value={statusChip}
          onChange={(v) => setStatusChip(v)}
        />

        <DataGridCompat<AmendmentQueueRow>
          rows={rows}
          columns={columns}
          storageKey={AMENDMENT_LIST_STORAGE_KEY}
          exportName="Amendments"
          rowKey={(r) => r.key}
          searchPlaceholder="Search SO no, reference, amendment no, requested by, reason…"
          loadedSearchLimit={500}
          groupBanner={false}
          defaultSort={OPEN_ORDER}
          sortForSessionOnly
          /* Single click: the quick view (amendments only — a cancellation's
             whole content is on the row already). Double-click: the job card,
             or the Sales Order for a cancellation. */
          onRowClick={(r) => { if (r.amendment) setQuick({ kind: 'so', id: r.amendment.id, label: String(r.amendment.amendment_no ?? r.soDocNo) }); }}
          onRowDoubleClick={(r) => openRow(r)}
          /* Closed rows (rejected / withdrawn) grey out so they read as dead
             (mirrors the GRN list's cancelled/closed treatment). Under the
             simplified buckets only REJECTED is dead — an applied (SENT)
             revision now reads as Approved, not closed. */
          rowStyle={(r) => (r.bucket === 'REJECTED' ? { opacity: 0.6, filter: 'grayscale(0.4)' } : undefined)}
          isLoading={isLoading}
          emptyMessage="No amendments yet — raise one from a processing-locked Sales Order."
        />
      </div>
      <AmendmentQuickView target={quick} onClose={() => setQuick(null)} />
    </div>
  );
};

export default Amendments;
