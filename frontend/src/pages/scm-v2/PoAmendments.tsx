// ----------------------------------------------------------------------------
// PoAmendments — the PO-amendment / revision inbox. A DataGrid queue of every
// Purchase Order revision, newest first — BOTH kinds (owner 2026-07-27,
// "这个应该出现在 PO Amendment"):
//   · direct po_amendments (raised from a PO — the single-approver flow), AND
//   · SO amendments that revise a BOUND PO (the SO-driven flow: once the SO
//     side approves, the bound PO must be revised + re-sent to the supplier —
//     purchasing needs those in ITS queue, not only on the SO side).
// The PO-side sibling of pages/scm-v2/Amendments.tsx, built to the owner's
// SIMPLIFIED model: the status filter is just Requested / Approved / All.
//
// Double-clicking a row opens its job card: a direct amendment opens
// PoAmendmentDetailV2 (/scm/po-amendments/:id); an SO-driven row opens the SO
// amendment job card (/scm/amendments/:id) — the before/after diff + revision
// stepper + "Revise the bound PO" gate the owner pointed at.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDateTime } from '@2990s/shared';
import { usePoAmendments, type PoAmendmentRow } from '../../vendor/scm/lib/po-amendment-queries';
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
import { FilterPills } from '../../components/FilterPills';
import { useStaffLookup } from '../../hooks/useStaffLookup';

// SIMPLIFIED status filter (owner 2026-07-24): Requested / Approved / All only.
// The backend enum still carries REJECTED (a rejected/withdrawn amendment), but
// the queue is about what is open vs applied, so the closed rows are reached via
// "All" rather than their own chip — mirrors the SO amendment simplification.
const STATUS_CHIPS = AMENDMENT_LIST_CHIPS;

/* New unique storage key — NEVER reuse another list's key. (v2: the merged
   two-source inbox replaced the po_amendments-only grid; new column set.) */
const PO_AMENDMENT_LIST_STORAGE_KEY = 'po-amendment-list.layout.v2';

/* One flattened row shape for both sources, so the columns stay dumb. `id`
   navigates within the row's OWN module (see openRow); `key` is unique across
   the merged set. */
type InboxRow = {
  key: string;
  kind: 'po' | 'so';
  id: string;
  poLabel: string;
  amendmentNo: string;
  requestedBy: string | null;
  reason: string | null;
  status: string;
  createdAt: string | null;
};

const SOURCE_LABEL: Record<InboxRow['kind'], string> = {
  po: 'PO amendment',
  so: 'From SO amendment',
};

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
    sortFn: (a, b) => amendmentBucketOf(a.status).localeCompare(amendmentBucketOf(b.status)),
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

  const allRows = useMemo<InboxRow[]>(() => {
    const direct: InboxRow[] = ((poQ.data?.amendments ?? []) as PoAmendmentRow[]).map((a) => ({
      key: `po:${a.id}`,
      kind: 'po',
      id: a.id,
      poLabel: a.po_number ?? '',
      amendmentNo: String(a.amendment_no ?? ''),
      requestedBy: a.requested_by ?? null,
      reason: a.reason ?? null,
      status: a.status,
      createdAt: a.created_at ?? null,
    }));
    /* SO-driven rows = SO amendments with a bound PO (the list endpoint
       resolves bound_pos through purchase_order_items.so_item_id). Pure-sales
       amendments (no purchase leg) stay in the SO queue only. */
    const soDriven: InboxRow[] = ((soQ.data?.amendments ?? []) as AmendmentRow[])
      .filter((a) => (a.bound_pos?.length ?? 0) > 0)
      .map((a) => ({
        key: `so:${a.id}`,
        kind: 'so',
        id: a.id,
        poLabel: (a.bound_pos ?? []).map((p) => p.po_number).join(', '),
        amendmentNo: String(a.amendment_no ?? ''),
        requestedBy: a.requested_by ?? null,
        reason: a.reason ?? null,
        status: a.status,
        createdAt: a.created_at ?? null,
      }));
    return [...direct, ...soDriven].sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  }, [poQ.data, soQ.data]);

  const rows = useMemo<InboxRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((a) => amendmentBucketOf(a.status) === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildColumns(actorNameOf), [actorNameOf]);

  /* A direct amendment opens its own job card; an SO-driven row opens the SO
     amendment job card (diff + stepper + "Revise the bound PO" gate). */
  const openRow = (a: InboxRow) => {
    navigate(a.kind === 'so' ? `/scm/amendments/${a.id}` : `/scm/po-amendments/${a.id}`);
  };

  return (
    <div>
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
            label: `${amendmentBucketLabel(s)} · ${
              s === 'all'
                ? allRows.length
                : allRows.filter((a) => amendmentBucketOf(a.status) === s).length
            }`,
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
    </div>
  );
};

export default PoAmendments;
