// ----------------------------------------------------------------------------
// PoAmendments — the PO-amendment / revision inbox. A DataGrid queue of every
// Purchase Order amendment, newest first. The PO-side sibling of
// pages/scm-v2/Amendments.tsx (the SO amendment queue), built to the owner's
// SIMPLIFIED model: the status filter is just Requested / Approved / All.
//
// Double-clicking a row opens the amendment job card (PoAmendmentDetailV2,
// /scm/po-amendments/:id) — the before/after diff + revision-status hero + the
// single-approver gate actions (approve / reject / withdraw).
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDateTime } from '@2990s/shared';
import { usePoAmendments, type PoAmendmentRow } from '../../vendor/scm/lib/po-amendment-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { AmendmentStatusPill } from '../../vendor/scm/components/StatusPill';
import {
  simplifiedAmendmentPill,
  amendmentBucketOf,
  AMENDMENT_LIST_CHIPS,
  amendmentBucketLabel,
} from '../../vendor/scm/lib/status-pill';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import { cn } from '../../lib/utils';

// SIMPLIFIED status filter (owner 2026-07-24): Requested / Approved / All only.
// The backend enum still carries REJECTED (a rejected/withdrawn amendment), but
// the queue is about what is open vs applied, so the closed rows are reached via
// "All" rather than their own chip — mirrors the SO amendment simplification.
const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

/* New unique storage key — NEVER reuse another list's key. */
const PO_AMENDMENT_LIST_STORAGE_KEY = 'po-amendment-list.layout.v1';

/* `requested_by` is a bare scm.staff uuid (po_amendments.requested_by, FK ->
   scm.staff.id) — the list endpoint sends no name with it. Resolve through the
   shared staff roster exactly as the SO amendment / PO lists resolve their
   people columns; search / group / sort all key off the RESOLVED name. */
const buildColumns = (
  actorNameOf: (id: string | null | undefined, empty?: string) => string,
): DataGridColumn<PoAmendmentRow>[] => [
  {
    key: 'po_number', label: 'PO No.', width: 150, sortable: true, groupable: true,
    accessor: (a) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{a.po_number}</span>,
    searchValue: (a) => a.po_number ?? '',
    exportValue: (a) => a.po_number ?? '',
    groupValue: (a) => a.po_number ?? '',
    sortFn: (a, b) => String(a.po_number ?? '').localeCompare(String(b.po_number ?? '')),
  },
  {
    key: 'amendment_no', label: 'Amendment No.', width: 150, sortable: true,
    accessor: (a) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{a.amendment_no ?? '—'}</span>,
    searchValue: (a) => String(a.amendment_no ?? ''),
    exportValue: (a) => String(a.amendment_no ?? '—'),
    sortFn: (a, b) => String(a.amendment_no ?? '').localeCompare(String(b.amendment_no ?? '')),
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

export const PoAmendments = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePoAmendments();
  const { actorNameOf } = useStaffLookup();

  const allRows = useMemo<PoAmendmentRow[]>(() => (data?.amendments ?? []) as PoAmendmentRow[], [data]);
  const rows = useMemo<PoAmendmentRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((a) => amendmentBucketOf(a.status) === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildColumns(actorNameOf), [actorNameOf]);

  const openRow = (a: PoAmendmentRow) => {
    navigate(`/scm/po-amendments/${a.id}`);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Revision inbox"
        title="PO Amendments"
        description={
          isLoading
            ? 'Loading amendments…'
            : `${rows.length} purchase order amendment${rows.length === 1 ? '' : 's'}`
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
            label: `${amendmentBucketLabel(s)} · ${
              s === 'all'
                ? allRows.length
                : allRows.filter((a) => amendmentBucketOf(a.status) === s).length
            }`,
          }))}
          value={statusChip}
          onChange={(v) => setStatusChip(v)}
        />

        <DataGrid<PoAmendmentRow>
          rows={rows}
          columns={columns}
          storageKey={PO_AMENDMENT_LIST_STORAGE_KEY}
          exportName="PO Amendments"
          rowKey={(a) => a.id}
          searchPlaceholder="Search PO no, amendment no, requested by…"
          loadedSearchLimit={500}
          groupBanner={false}
          onRowDoubleClick={(a) => openRow(a)}
          /* Closed amendments (REJECTED / withdrawn) grey out so they read as
             dead — mirrors the SO amendment queue + the GRN cancelled treatment. */
          rowStyle={(a) => amendmentBucketOf(a.status) === 'REJECTED'
            ? { opacity: 0.6, filter: 'grayscale(0.4)' }
            : undefined}
          isLoading={isLoading}
          emptyMessage="No amendments yet — raise one from a Purchase Order."
        />
      </div>
    </div>
  );
};

export default PoAmendments;
