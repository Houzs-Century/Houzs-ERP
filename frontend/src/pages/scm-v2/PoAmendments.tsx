// ----------------------------------------------------------------------------
// PoAmendments — the PO-amendment / revision inbox. A DataGrid queue of every
// Purchase Order revision, Requested first — BOTH kinds (owner 2026-07-27,
// "这个应该出现在 PO Amendment"):
//   · direct po_amendments (raised from a PO — the single-approver flow), AND
//   · SO amendments that revise a BOUND PO (the SO-driven flow: once the SO
//     side approves, the bound PO must be revised + re-sent to the supplier —
//     purchasing needs those in ITS queue, not only on the SO side).
// The PO-side sibling of pages/scm-v2/Amendments.tsx, built to the owner's
// SIMPLIFIED model: the status filter is just Requested / Approved / Rejected / All.
//
// Double-clicking a row opens its job card: a direct amendment opens
// PoAmendmentDetailV2 (/scm/po-amendments/:id); an SO-driven row opens the SO
// amendment job card (/scm/amendments/:id) — the before/after diff + revision
// stepper + "Revise the bound PO" gate the owner pointed at. A SINGLE click opens
// the quick view drawer (AmendmentQuickView) for the same row, like the Sales
// Order list (owner 2026-09-14).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AmendmentQuickView, amendmentJobCardPath, type AmendmentQuickViewTarget } from './AmendmentQuickView';
import { fmtDateTime } from '../../vendor/shared/format';
import { usePoAmendments } from '../../vendor/scm/lib/po-amendment-queries';
import { useAmendments } from '../../vendor/scm/lib/so-amendment-queries';
import {
  buildPoAmendmentInbox,
  PO_AMENDMENT_INBOX_SOURCE_LABEL as SOURCE_LABEL,
  type PoAmendmentInboxRow as InboxRow,
} from '../../vendor/scm/lib/po-amendment-inbox';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { AmendmentStatusPill } from '../../vendor/scm/components/StatusPill';
import {
  simplifiedAmendmentPill,
  amendmentBucketOf,
  AMENDMENT_LIST_CHIPS,
  amendmentBucketLabel,
  amendmentBucketRank,
  compareAmendmentsForList,
} from '../../vendor/scm/lib/status-pill';
import { AmendmentApproverBadge } from '../../vendor/scm/components/AmendmentApproverBadge';
import { AMENDMENT_APPROVER_LABEL } from '../../vendor/scm/lib/amendment-approver';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { useStaffLookup } from '../../hooks/useStaffLookup';

// SIMPLIFIED status filter (owner 2026-07-24; Rejected added 2026-09-17): Requested /
// Approved / Rejected / All — the same shared chip list as the SO amendment queue.
const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

/* New unique storage key — NEVER reuse another list's key. (v2: the merged
   two-source inbox replaced the po_amendments-only grid; new column set.) */
const PO_AMENDMENT_LIST_STORAGE_KEY = 'po-amendment-list.layout.v2';

/* Opens with Requested on top across both sources (status-pill.ts owns the
   order), EVERY time: the grid is sortForSessionOnly, so a header click sorts
   this visit and is not remembered (owner 2026-09-14). */
const OPEN_ORDER = compareAmendmentsForList<InboxRow>((a) => a.status, (a) => a.createdAt);

/* `requestedBy` is a bare scm.staff uuid on both sources — resolve through the
   shared staff roster exactly as the SO amendment / PO lists resolve their
   people columns; search / group / sort all key off the RESOLVED name. */
const buildColumns = (
  actorNameOf: (id: string | null | undefined, empty?: string) => string,
): DataGridColumn<InboxRow>[] => [
  {
    key: 'po_number', label: 'PO No.', width: 150, sortable: true, groupable: true,
    accessor: (a) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{a.poLabel || '—'}</span>,
    searchValue: (a) => a.poLabel,
    exportValue: (a) => a.poLabel || '—',
    groupValue: (a) => a.poLabel || '(none)',
    sortFn: (a, b) => a.poLabel.localeCompare(b.poLabel),
  },
  {
    key: 'amendment_no', label: 'Amendment No.', width: 190, sortable: true,
    accessor: (a) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{a.amendmentNo || '—'}</span>,
    searchValue: (a) => a.amendmentNo,
    exportValue: (a) => a.amendmentNo || '—',
    sortFn: (a, b) => a.amendmentNo.localeCompare(b.amendmentNo),
  },
  {
    /* Which flow the row belongs to — a direct PO amendment vs the PO leg of an
       SO amendment. Doubles as the visual cue for where double-click lands. */
    key: 'source', label: 'Source', width: 160, sortable: true, groupable: true,
    accessor: (a) => (
      <span style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: 999,
        fontSize: 'var(--fs-11)', fontWeight: 600,
        background: a.kind === 'so' ? 'rgba(47, 93, 79, 0.12)' : 'var(--c-cream)',
        color: a.kind === 'so' ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--fg-muted)',
      }}>
        {SOURCE_LABEL[a.kind]}
      </span>
    ),
    searchValue: (a) => SOURCE_LABEL[a.kind],
    exportValue: (a) => SOURCE_LABEL[a.kind],
    groupValue: (a) => SOURCE_LABEL[a.kind],
    sortFn: (a, b) => a.kind.localeCompare(b.kind),
  },
  {
    /* Who signs it (owner 2026-09-14) — the same badge as the SO queue. A
       direct PO amendment has one approve key, Purchaser's; an SO-driven row
       follows its lane (DELIVERY rows never reach this queue, see
       po-amendment-inbox.ts). */
    key: 'approver', label: 'Approver', width: 130, sortable: true, groupable: true,
    accessor: (a) => <AmendmentApproverBadge approver={a.approver} />,
    searchValue: (a) => AMENDMENT_APPROVER_LABEL[a.approver],
    exportValue: (a) => AMENDMENT_APPROVER_LABEL[a.approver],
    groupValue: (a) => AMENDMENT_APPROVER_LABEL[a.approver],
    sortFn: (a, b) => AMENDMENT_APPROVER_LABEL[a.approver].localeCompare(AMENDMENT_APPROVER_LABEL[b.approver]),
  },
  {
    key: 'requested_by', label: 'Requested by', width: 180, sortable: true, groupable: true,
    accessor: (a) => actorNameOf(a.requestedBy),
    searchValue: (a) => actorNameOf(a.requestedBy, ''),
    exportValue: (a) => actorNameOf(a.requestedBy),
    groupValue: (a) => actorNameOf(a.requestedBy, '(none)'),
    sortFn: (a, b) =>
      actorNameOf(a.requestedBy, '').localeCompare(actorNameOf(b.requestedBy, '')),
  },
  {
    key: 'reason', label: 'Reason', width: 240, minWidth: 160, sortable: true, defaultHidden: true,
    accessor: (a) => (a.reason ?? '').trim() || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
    searchValue: (a) => a.reason ?? '',
  },
  {
    key: 'status', label: 'Status', width: 150, sortable: true, groupable: true,
    accessor: (a) => <AmendmentStatusPill status={a.status} />,
    searchValue: (a) => simplifiedAmendmentPill(a.status).label,
    groupValue: (a) => simplifiedAmendmentPill(a.status).label,
    exportValue: (a) => simplifiedAmendmentPill(a.status).label,
    // Ascending = Requested -> Approved -> Rejected, not the bucket names A-Z.
    sortFn: (a, b) => amendmentBucketRank(a.status) - amendmentBucketRank(b.status),
  },
  {
    key: 'created_at', label: 'Created', width: 160, sortable: true,
    accessor: (a) => (a.createdAt ? fmtDateTime(a.createdAt) : '—'),
    searchValue: (a) => a.createdAt ?? '',
    sortFn: (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
    filterType: 'date', dateValue: (a) => a.createdAt,
  },
];

export const PoAmendments = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const poQ = usePoAmendments();
  const soQ = useAmendments();
  const { actorNameOf } = useStaffLookup();
  const isLoading = poQ.isLoading || soQ.isLoading;
  const error = poQ.error ?? soQ.error;

  const allRows = useMemo<InboxRow[]>(
    () => buildPoAmendmentInbox(poQ.data?.amendments ?? [], soQ.data?.amendments ?? []),
    [poQ.data, soQ.data],
  );

  const rows = useMemo<InboxRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((a) => amendmentBucketOf(a.status) === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildColumns(actorNameOf), [actorNameOf]);

  /* A direct amendment opens its own job card; an SO-driven row opens the SO
     amendment job card (diff + stepper + "Revise the bound PO" gate). */
  const openRow = (a: InboxRow) => {
    navigate(amendmentJobCardPath(a));
  };
  const [quick, setQuick] = useState<AmendmentQuickViewTarget | null>(null);

  return (
    <div className={quick ? 'md:pr-[540px]' : undefined}>
      <PageHeader
        eyebrow="Revision inbox"
        title="PO Amendments"
        description={
          isLoading
            ? 'Loading amendments…'
            : `${rows.length} purchase order revision${rows.length === 1 ? '' : 's'} — raised from a PO or flowing from a Sales Order amendment`
        }
      />

      <div className="space-y-4">
        {error && !isLoading && (
          <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-2.5 text-[12.5px] text-err">
            <strong className="font-semibold">Failed to load amendments.</strong>{' '}
            {error instanceof Error ? error.message : 'Something went wrong.'}
          </div>
        )}

        {/* Status strip — the SO page's OWN FilterPills component with
            counted labels (owner 2026-07-26, same ruling as the SO
            Amendments page). Shared component, so the strips never drift. */}
        <FilterPills
          options={STATUS_CHIPS.map((s) => ({
            value: s,
            label: amendmentBucketLabel(s),
            count:
              s === 'all'
                ? allRows.length
                : allRows.filter((a) => amendmentBucketOf(a.status) === s).length,
          }))}
          value={statusChip}
          onChange={(v) => setStatusChip(v)}
        />

        <DataGrid<InboxRow>
          rows={rows}
          columns={columns}
          storageKey={PO_AMENDMENT_LIST_STORAGE_KEY}
          exportName="PO Amendments"
          rowKey={(a) => a.key}
          searchPlaceholder="Search PO no, amendment no, requested by…"
          loadedSearchLimit={500}
          groupBanner={false}
          defaultSort={OPEN_ORDER}
          sortForSessionOnly
          /* Single click: the quick view. Double-click: the job card. */
          onRowClick={(a) => setQuick({ kind: a.kind, id: a.id, label: a.amendmentNo || a.poLabel })}
          onRowDoubleClick={(a) => openRow(a)}
          /* Closed amendments (REJECTED / withdrawn) grey out so they read as
             dead — mirrors the SO amendment queue + the GRN cancelled treatment. */
          rowStyle={(a) => amendmentBucketOf(a.status) === 'REJECTED'
            ? { opacity: 0.6, filter: 'grayscale(0.4)' }
            : undefined}
          isLoading={isLoading}
          emptyMessage="No amendments yet — raise one from a Purchase Order, or revise a Sales Order with a bound PO."
        />
      </div>
      <AmendmentQuickView target={quick} onClose={() => setQuick(null)} />
    </div>
  );
};

export default PoAmendments;
