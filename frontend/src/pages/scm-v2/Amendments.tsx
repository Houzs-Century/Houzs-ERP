// ----------------------------------------------------------------------------
// Amendments — the SO-amendment / revision inbox (Phase 1-C). A DataGrid queue
// of every amendment across all Sales Orders, newest first. HOUZS VENDOR port
// of 2990's apps/backend/src/pages/Amendments.tsx.
//
// Row-click routing (Houzs 2026-07-15): a double-click now opens the amendment
// job card (AmendmentDetailV2, /scm/amendments/:id) — the before/after diff +
// revision-status hero + gate actions. That detail page hands off into the SO
// editor (/scm/sales-orders/:docNo?edit=1, which hosts the pending banner + the
// legacy line editor) or the bound-PO editor for the later gates, so the queue
// no longer needs to resolve the bound PO itself.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDateTime } from '@2990s/shared';
import { useAmendments, type AmendmentRow } from '../../vendor/scm/lib/so-amendment-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { AmendmentStatusPill } from '../../vendor/scm/components/StatusPill';
import {
  simplifiedAmendmentPill,
  amendmentBucketOf,
  AMENDMENT_LIST_CHIPS,
  amendmentBucketLabel,
} from '../../vendor/scm/lib/status-pill';
import { PageHeader } from '../../components/Layout';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import { cn } from '../../lib/utils';

// SIMPLIFIED status filter (owner 2026-07-24): Requested / Approved / All only.
// The backend so_amendment_status enum still carries the granular two-gate values
// (SUPPLIER_PENDING / SO_APPROVED / PO_APPROVED / SENT) the 2990 mirror + the SO
// detail stepper depend on — the queue just collapses them into the two buckets
// via amendmentBucketOf, and reaches the closed (REJECTED) rows through "All".
const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

/* New unique storage key — NEVER reuse another list's key. */
const AMENDMENT_LIST_STORAGE_KEY = 'so-amendment-list.layout.v1';

/* `requested_by` is a bare scm.staff uuid (so_amendments.requested_by, FK ->
   scm.staff.id) — the list endpoint sends no name with it. Resolve through the
   shared staff roster exactly as the SO / DO / SI lists resolve salesperson_id;
   search / group / sort all key off the RESOLVED name so the column behaves as
   the person column it presents itself to be. */
const buildAmendmentColumns = (
  actorNameOf: (id: string | null | undefined, empty?: string) => string,
): DataGridColumn<AmendmentRow>[] => [
  {
    key: 'so_doc_no', label: 'SO No.', width: 140, sortable: true, groupable: true,
    accessor: (a) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{a.so_doc_no}</span>,
    searchValue: (a) => a.so_doc_no,
    // accessor is JSX → export the raw SO-no string so the column isn't blank.
    exportValue: (a) => a.so_doc_no,
    groupValue: (a) => a.so_doc_no,
    sortFn: (a, b) => a.so_doc_no.localeCompare(b.so_doc_no),
  },
  {
    key: 'amendment_no', label: 'Amendment No.', width: 140, sortable: true,
    accessor: (a) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{a.amendment_no ?? '—'}</span>,
    searchValue: (a) => String(a.amendment_no ?? ''),
    exportValue: (a) => String(a.amendment_no ?? '—'),
    sortFn: (a, b) => Number(a.amendment_no ?? 0) - Number(b.amendment_no ?? 0),
  },
  {
    key: 'requested_by', label: 'Requested by', width: 200, sortable: true, groupable: true,
    accessor: (a) => actorNameOf(a.requested_by),
    searchValue: (a) => actorNameOf(a.requested_by, ''),
    exportValue: (a) => actorNameOf(a.requested_by),
    groupValue: (a) => actorNameOf(a.requested_by, '(none)'),
    sortFn: (a, b) =>
      actorNameOf(a.requested_by, '').localeCompare(actorNameOf(b.requested_by, '')),
  },
  {
    key: 'reason', label: 'Reason', width: 240, minWidth: 160, sortable: true, defaultHidden: true,
    accessor: (a) => (a.reason ?? '').trim() || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
    searchValue: (a) => a.reason ?? '',
  },
  {
    key: 'status', label: 'Status', width: 150, sortable: true, groupable: true,
    // SIMPLIFIED list pill — Requested / Approved / Rejected (see simplifiedAmendmentPill).
    accessor: (a) => <AmendmentStatusPill status={a.status} />,
    searchValue: (a) => simplifiedAmendmentPill(a.status).label,
    groupValue: (a) => simplifiedAmendmentPill(a.status).label,
    exportValue: (a) => simplifiedAmendmentPill(a.status).label,
    sortFn: (a, b) => amendmentBucketOf(a.status).localeCompare(amendmentBucketOf(b.status)),
  },
  {
    key: 'created_at', label: 'Created', width: 160, sortable: true,
    accessor: (a) => (a.created_at ? fmtDateTime(a.created_at) : '—'),
    searchValue: (a) => a.created_at ?? '',
    sortFn: (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
    filterType: 'date', dateValue: (a) => a.created_at,
  },
];

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
  const { actorNameOf } = useStaffLookup();

  const allRows = useMemo<AmendmentRow[]>(() => (data?.amendments ?? []) as AmendmentRow[], [data]);
  const rows = useMemo<AmendmentRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((a) => amendmentBucketOf(a.status) === statusChip)),
    [allRows, statusChip],
  );
  // actorNameOf identity changes when the staff roster lands — rebuild so the
  // column re-renders with real names instead of staying on the loading dash.
  const columns = useMemo(() => buildAmendmentColumns(actorNameOf), [actorNameOf]);

  /* Row-click routing (2026-07-15) — open the amendment job card. The detail
     page owns the diff + revision-status hero + gate actions, and hands off
     into the SO / bound-PO editor for the deeper line edits. */
  const openRow = (a: AmendmentRow) => {
    navigate(`/scm/amendments/${a.id}`);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Revision inbox"
        title="Amendments"
        description={
          isLoading
            ? 'Loading amendments…'
            : `${rows.length} sales order amendment${rows.length === 1 ? '' : 's'}`
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

        {/* Status chips — matches the GRN / DR / SI list filter style. */}
        <div className="flex flex-wrap gap-1.5">
          {STATUS_CHIPS.map((s) => {
            const active = statusChip === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusChip(s)}
                className={cn(
                  'h-7 rounded-full border px-3 text-[11px] font-semibold transition-colors',
                  active
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border bg-surface text-ink-secondary hover:border-primary/40 hover:text-primary',
                )}
              >
                {amendmentBucketLabel(s)}
              </button>
            );
          })}
        </div>

        <DataGrid<AmendmentRow>
        rows={rows}
        columns={columns}
        storageKey={AMENDMENT_LIST_STORAGE_KEY}
        exportName="Amendments"
        rowKey={(a) => a.id}
        searchPlaceholder="Search amendments…"
        loadedSearchLimit={500}
        groupBanner={false}
        /* Open on DOUBLE-click (mirrors the GRN / PO list). */
        onRowDoubleClick={(a) => openRow(a)}
        /* Closed amendments (rejected / withdrawn) grey out so they read as dead
           (mirrors the GRN list's cancelled/closed treatment). Under the
           simplified buckets only REJECTED is dead — an applied (SENT) revision
           now reads as Approved, not closed. */
        rowStyle={(a) => amendmentBucketOf(a.status) === 'REJECTED'
          ? { opacity: 0.6, filter: 'grayscale(0.4)' }
          : undefined}
        isLoading={isLoading}
        emptyMessage="No amendments yet — raise one from a processing-locked Sales Order."
        />
      </div>
    </div>
  );
};

export default Amendments;
