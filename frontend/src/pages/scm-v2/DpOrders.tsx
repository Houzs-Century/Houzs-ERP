// ----------------------------------------------------------------------------
// DpOrders — the raw DP Order registry (/scm/dp-orders).
//
// The optional P3 item of docs/delivery-planning-jobtypes-spec.md: GET
// /api/scm/dp-orders had no consumer, so a DP order was reachable ONLY through
// the Delivery Planning board's union — which deliberately SUPPRESSES any
// dp_order carrying a source ref (the anti-double-count guard) and drops
// cancelled jobs entirely. Those rows weren't gone, just unreachable. This list
// is the flat registry: every DP order, every status, schedulable and
// cancellable in place via the same drawer/hooks the board uses.
//
// Nav: Transportation > DP Orders, right after Delivery Planning. Same
// scm.transportation.drivers gate as the board; the backend list additionally
// row-scopes field crew to their own jobs (dp-orders.ts).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { CalendarClock, Plus, XCircle } from 'lucide-react';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDate } from '../../vendor/shared/format';
import {
  useDpOrders,
  useCancelDpOrder,
  dpJobTypeLabel,
  type DpOrderRow,
} from '../../vendor/scm/lib/delivery-planning-queries';
import { NewDpOrderDrawer } from '../../vendor/scm/components/NewDpOrderDrawer';
import {
  ScheduleDpOrderDrawer,
  type ScheduleDpOrderTarget,
} from '../../vendor/scm/components/ScheduleDpOrderDrawer';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const joinedAddress = (r: DpOrderRow): string =>
  [r.address1, r.address2, r.address3, r.address4, r.city, r.postcode, r.state]
    .filter(Boolean).join(', ');

/* Provenance, humanised. party_name already carries the resolved party, so the
   supplier/project/case refs only need to say WHERE the snapshot came from. */
const sourceRef = (r: DpOrderRow): string => {
  if (r.so_doc_no) return r.so_doc_no;
  if (r.project_id != null) return `Project #${r.project_id}`;
  if (r.assr_case_id != null) return `Case #${r.assr_case_id}`;
  if (r.supplier_id) return 'Supplier master';
  return 'Manual';
};

/* The drawer reads a board-row subset; synthesize it from the raw registry row.
   `DP:<id>` mirrors how the board stamps the DP id onto so_doc_no. */
const asScheduleTarget = (r: DpOrderRow): ScheduleDpOrderTarget => ({
  so_doc_no: `DP:${r.id}`,
  dp_job_type: r.job_type,
  debtor_name: r.party_name,
  address: joinedAddress(r) || null,
  effective_delivery_date: r.requested_date,
  customer_delivery_date: null,
});

export const DpOrders = () => {
  const list = useDpOrders();
  const cancelDp = useCancelDpOrder();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const [searchTerm, setSearchTerm] = useState('');
  const [showNewDp, setShowNewDp] = useState(false);
  const [scheduling, setScheduling] = useState<DpOrderRow | null>(null);

  const rows = useMemo(() => {
    const all = list.data?.dpOrders ?? [];
    const term = searchTerm.trim().toLowerCase();
    if (!term) return all;
    return all.filter((r) =>
      [
        r.dp_no, r.party_name, r.contact_name, r.contact_phone, r.remark,
        r.city, r.state, r.postcode, joinedAddress(r), sourceRef(r),
        dpJobTypeLabel(r.job_type), statusLabel('dpOrder', r.status),
      ].some((v) => (v ?? '').toLowerCase().includes(term)),
    );
  }, [list.data, searchTerm]);

  const cancel = async (r: DpOrderRow) => {
    const ok = await askConfirm({
      title: 'Cancel this DP order?',
      body: `${dpJobTypeLabel(r.job_type)}${r.dp_no ? ` ${r.dp_no}` : ''} — ${r.party_name ?? 'no party'}. ${r.trip_stop_id ? 'Its trip stop is removed too.' : ''}`,
      confirmLabel: 'Cancel job',
    });
    if (!ok) return;
    cancelDp.mutate(r.id, {
      onSuccess: (res) => {
        if (res?.stopRemoved?.failed) {
          notify({
            title: 'Cancelled, but the trip stop remains',
            body: `Remove it from the trip manually: ${res.stopRemoved.reason ?? 'unknown error'}.`,
            tone: 'error',
          });
        } else if (res?.lorryUnblocked?.failed) {
          // The mirror of the stop-left-behind case: a cancelled service that
          // kept its availability window holds a perfectly free lorry off the
          // board, and nothing else would ever say so.
          notify({
            title: 'Cancelled, but the lorry is still blocked',
            body: `Clear its unavailable window in Fleet Maintenance: ${res.lorryUnblocked.reason ?? 'unknown error'}.`,
            tone: 'error',
          });
        } else {
          notify({ title: 'DP order cancelled' });
        }
      },
      onError: (err) => notify({
        title: 'Could not cancel',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      }),
    });
  };

  const columns: Column<DpOrderRow>[] = [
    {
      key: 'dp_no', label: 'DP No', width: '150px',
      getValue: (r) => r.dp_no ?? '',
      render: (r) => r.dp_no
        ? <span style={{ fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'nowrap' }}>{r.dp_no}</span>
        : <span style={{ color: 'var(--fg-muted)' }}>—</span>,
    },
    {
      key: 'status', label: 'Status', width: '140px',
      getValue: (r) => statusLabel('dpOrder', r.status),
      render: (r) => <StatusPill docType="dpOrder" status={r.status} />,
    },
    {
      key: 'job_type', label: 'Type', width: '130px',
      getValue: (r) => dpJobTypeLabel(r.job_type),
      render: (r) => dpJobTypeLabel(r.job_type),
    },
    {
      key: 'party', label: 'Party',
      getValue: (r) => r.party_name ?? '',
      render: (r) => r.party_name ? <strong>{r.party_name}</strong> : '—',
    },
    {
      key: 'contact', label: 'Contact', width: '140px',
      getValue: (r) => r.contact_name ?? '',
      render: (r) => r.contact_name ?? '—',
    },
    {
      key: 'phone', label: 'Phone', width: '130px', defaultHidden: true,
      getValue: (r) => r.contact_phone ?? '',
      render: (r) => r.contact_phone ?? '—',
    },
    {
      key: 'requested_date', label: 'Requested', width: '110px',
      getValue: (r) => r.requested_date ?? '',
      render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{r.requested_date ? fmtDate(r.requested_date) : '—'}</span>,
    },
    {
      key: 'source', label: 'Source', width: '140px',
      getValue: (r) => sourceRef(r),
      render: (r) => sourceRef(r),
    },
    {
      key: 'trip', label: 'Trip', width: '90px',
      getValue: (r) => (r.trip_id ? 'On trip' : ''),
      render: (r) => r.trip_id
        ? <span style={{ color: 'var(--c-secondary-a, #2F5D4F)' }}>On trip</span>
        : <span style={{ color: 'var(--fg-muted)' }}>—</span>,
    },
    {
      key: 'address', label: 'Address', defaultHidden: true,
      getValue: (r) => joinedAddress(r),
      render: (r) => joinedAddress(r) || '—',
    },
    {
      key: 'city', label: 'City', width: '120px', defaultHidden: true,
      getValue: (r) => r.city ?? '',
      render: (r) => r.city ?? '—',
    },
    {
      key: 'state', label: 'State', width: '120px', defaultHidden: true,
      getValue: (r) => r.state ?? '',
      render: (r) => r.state ?? '—',
    },
    {
      key: 'remark', label: 'Remark', defaultHidden: true,
      getValue: (r) => r.remark ?? '',
      render: (r) => r.remark ?? '—',
    },
    {
      key: 'created_at', label: 'Created', width: '110px',
      getValue: (r) => r.created_at ?? '',
      render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'actions', label: '', width: '190px', disableSort: true,
      render: (r) => (
        <div style={{ display: 'inline-flex', gap: 4 }}>
          {r.status === 'PENDING_SCHEDULE' && (
            <Button variant="ghost" onClick={() => setScheduling(r)}>
              <CalendarClock {...ICON} /><span>Schedule…</span>
            </Button>
          )}
          {r.status !== 'CANCELLED' && (
            <Button variant="ghost" onClick={() => void cancel(r)} disabled={cancelDp.isPending}>
              <XCircle {...ICON} /><span>Cancel</span>
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="DP Orders"
        description="Every delivery-planning job order — setup, dismantle, supplier pickup — across all statuses. The board only shows plannable jobs; this registry keeps cancelled and source-linked orders reachable. Schedule a pending job to mint its DP number."
        actions={(
          <Button variant="primary" onClick={() => setShowNewDp(true)}>
            <Plus {...ICON} /><span>New DP order</span>
          </Button>
        )}
      />

      <DataTable<DpOrderRow>
        tableId="scm-dp-orders"
        exportName="dp-orders"
        rows={list.isLoading ? null : rows}
        loading={list.isLoading}
        error={list.error ? (list.error instanceof Error ? list.error.message : 'Failed to load DP orders.') : undefined}
        emptyLabel={searchTerm ? 'No DP orders match this search.' : 'No DP orders yet. Create one with “New DP order”.'}
        getRowKey={(r) => r.id}
        search={{
          value: searchTerm,
          onChange: setSearchTerm,
          placeholder: 'Search DP no / party / contact / source…',
          scope: 'loaded',
          loadedLimit: 500,
          totalRecords: rows.length,
        }}
        resetFilters={{ active: searchTerm.trim() !== '', onReset: () => setSearchTerm('') }}
        contextMenu={(r) => [
          ...(r.status === 'PENDING_SCHEDULE'
            ? [{ label: 'Schedule…', onClick: () => setScheduling(r) }]
            : []),
          ...(r.status !== 'CANCELLED'
            ? [{ label: 'Cancel job', onClick: () => void cancel(r), danger: true }]
            : []),
        ]}
        columns={columns}
      />

      {showNewDp && <NewDpOrderDrawer onClose={() => setShowNewDp(false)} />}
      {scheduling && (
        <ScheduleDpOrderDrawer dpRow={asScheduleTarget(scheduling)} onClose={() => setScheduling(null)} />
      )}
    </div>
  );
};

export default DpOrders;
