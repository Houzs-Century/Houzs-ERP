// ----------------------------------------------------------------------------
// Delivery Planning — STAGE 4 (the core) of the Delivery / TMS module.
//
// The planning board: which live Sales Orders still need delivering, organised
// by a top row of 4 DELIVERY-STATE tabs (Pending Delivery / Pending Schedule /
// Overdue / Delivered, each with a live count) and a region chip row of
// CONFIG-DRIVEN buckets classified by customer STATE (All · KL/SEL ·
// Northern · Southern · East Coast · East Malaysia — owner-maintained in
// Delivery Regions).
// Both the active state tab and the active region (bucket key) live in the URL
// (useSearchParams) so a link / refresh keeps the view.
//
// The board itself — the region chip row, the state-tab rail, the bulk bar, the
// inline cell editors, the SO line-item drill-down and the full HC column set —
// now lives in the SHARED <DeliveryPlanningBoard> (vendor/scm/components), so the
// exact same board is reused by the Trips "To schedule" panel (scoped to
// PENDING_SCHEDULE). This page owns the data fetch (region stays server-side),
// the selection, the drawers, and the page header.
//
// Backend-derived: delivery_state, region grouping, readiness, crew, and
// days_left all come from GET /delivery-planning — this page only filters by
// the active state/region and renders. Schedule editing calls the PATCH
// endpoints via the queries hook.
//
// SHARED-QUEUE NOTE (multi-company): the board reads BOTH companies' SOs. Row
// expand uses useDeliveryPlanningLines (GET /delivery-planning/:docNo/lines,
// scoped to ALLOWED companies) — NOT the per-company SO detail hook, which 404s
// a cross-company row. A default-visible Company column tags each row.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MapPinned, Truck, Plus, MessageSquare, CalendarClock } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { DeliveryFieldsDrawer } from '../../vendor/scm/components/DeliveryFieldsDrawer';
import { NewDpOrderDrawer } from '../../vendor/scm/components/NewDpOrderDrawer';
import { SetJobDateDrawer } from '../../vendor/scm/components/SetJobDateDrawer';
import { ScheduleDpOrderDrawer } from '../../vendor/scm/components/ScheduleDpOrderDrawer';
import { ScheduleTripDrawer } from '../../vendor/scm/components/ScheduleTripDrawer';
import { SendDeliveryMessageModal } from '../../vendor/scm/components/SendDeliveryMessageModal';
import {
  DeliveryPlanningBoard,
  regionTabsFrom,
  isDp,
  isAssr,
  isProject,
  dpLabel,
  soDocNosFromSelection,
} from '../../vendor/scm/components/DeliveryPlanningBoard';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { transferToLabel } from '../../lib/convertScope';
import {
  useDeliveryPlanning,
  useConvertSosToDo,
  useCancelDpOrder,
  useScheduleDelivery,
  useDeliveryMessageStatuses,
  type PlanningOrder,
} from '../../vendor/scm/lib/delivery-planning-queries';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';
import { useAuth } from '../../auth/AuthContext';
import { canOperateDeliveryOrders } from '../../auth/salesAccess';

export const DeliveryPlanning = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { user, can, pageAccess } = useAuth();
  /* Creating a DO is the Office department's job (owner 2026-07-17), and the
     backend now 403s the Sales cohort on every /delivery-orders-mfg write. This
     board is reachable on scm.transportation.*, so the convert actions carried no
     DO gate of their own — same ONE helper as every other DO control. */
  const canConvertToDo = canOperateDeliveryOrders(user, can, pageAccess);
  const [params, setParams] = useSearchParams();
  const activeState = (params.get('state') ?? 'ALL').toUpperCase();
  const activeRegion = (params.get('region') ?? 'ALL').toUpperCase();

  /* The order whose HC fields are being edited (drawer open when non-null). */
  const [editing, setEditing] = useState<PlanningOrder | null>(null);
  const [showNewDp, setShowNewDp] = useState(false);
  /* The DP job being scheduled (Schedule drawer open when non-null). */
  const [schedulingDp, setSchedulingDp] = useState<PlanningOrder | null>(null);
  /* Single-row scheduling, from the row menu. The board's "Sched. Date" column
     was removed in the owner's 2026-08-04 column pass ("删列但保留排期") — an SO
     goes to the full trip drawer, a service case to the one-field date drawer. */
  const [schedulingOne, setSchedulingOne] = useState<PlanningOrder | null>(null);
  const [datingAssr, setDatingAssr] = useState<PlanningOrder | null>(null);
  const cancelDp = useCancelDpOrder();

  /* Cancel a DP job. The row's so_doc_no is the synthetic `DP:<id>` key, so the
     id comes back off it. Confirm first — cancelling drops its trip stop too. */
  const cancelDpRow = async (o: PlanningOrder) => {
    const id = String(o.so_doc_no ?? '').replace(/^DP:/, '');
    if (!id) return;
    const ok = await askConfirm({
      title: `Cancel this ${dpLabel(o).toLowerCase()} job?`,
      body: o.dp_no
        ? `${o.dp_no} will be cancelled and removed from its trip.`
        : 'The job will be cancelled. It has not been scheduled yet.',
      confirmLabel: 'Cancel job',
    });
    if (!ok) return;
    try {
      const res = await cancelDp.mutateAsync(id);
      if (res?.stopRemoved?.failed) {
        notify({ title: 'Cancelled, but the trip stop stayed', body: res.stopRemoved.reason ?? 'Remove it from the trip manually.', tone: 'error' });
      } else if (res?.lorryUnblocked?.failed) {
        // A cancelled lorry service that kept its availability window holds a
        // free lorry off the board, and nothing else would ever report it.
        notify({ title: 'Cancelled, but the lorry is still blocked', body: `Clear its unavailable window in Fleet Maintenance: ${res.lorryUnblocked.reason ?? 'unknown error'}.`, tone: 'error' });
      } else {
        notify({ title: 'Job cancelled', body: 'It is off the board and off its trip.' });
      }
    } catch (e) {
      notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* Multi-select → bulk actions. Selection keys are prefixed (`so:<docNo>` /
     `assr:<id>` / `dp:<id>`) — the DataGrid rowKey. */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const convertSos = useConvertSosToDo();

  /* Phase-2 scheduling drawer (resizable): open from the multiselect bar. It
     schedules the selected SO orders onto a lorry-day trip via the existing
     schedule path — no leaving the board. */
  const [scheduling, setScheduling] = useState(false);

  /* Inline-cell + bulk-edit write path (shared). The backend schedule endpoint
     already accepts scheduleDate / deliveryState / driverId / lorryId. */
  const sched = useScheduleDelivery();
  /* Option lists for the Driver / Lorry inline selects + the bulk value control.
     Active-only (the pickers offer current crew); an existing off-list assignment
     stays selectable via the cell's fallback <option>. */
  const { data: drivers = [] } = useDrivers();
  const { data: lorries = [] } = useLorries();

  /* Convert a set of SOs → DOs (single row or the bulk selection). Skips SOs
     with no deliverable remaining (already fully delivered); reports the result
     via the in-app NotifyDialog. Reused by the row action + the selection bar. */
  const runConvert = async (docNos: string[]) => {
    const wanted = [...new Set(docNos.filter(Boolean))];
    if (wanted.length === 0 || convertSos.isPending) return;
    try {
      const res = await convertSos.mutateAsync({ docNos: wanted });
      setSel(new Set());
      const parts: string[] = [];
      if (res.converted.length > 0) {
        parts.push(`Transferred ${res.converted.length} sales order${res.converted.length === 1 ? '' : 's'} to Delivery Order (${res.converted.map((r) => r.doNumber).join(', ')}).`);
      }
      if (res.skipped.length > 0) {
        parts.push(`Skipped ${res.skipped.length} already fully delivered: ${res.skipped.map((r) => r.docNo).join(', ')}.`);
      }
      if (res.failed.length > 0) {
        parts.push(`Failed ${res.failed.length}: ${res.failed.map((r) => `${r.docNo} (${r.message})`).join('; ')}.`);
      }
      notify({
        title: res.converted.length > 0 ? 'Transfer complete' : 'Nothing transferred',
        body: parts.join(' ') || 'No deliverable lines were found.',
        tone: res.failed.length > 0 ? 'error' : 'info',
      });
    } catch (e) {
      notify({ title: 'Transfer failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* Single-row convert (context-menu action). */
  const convertOne = (o: PlanningOrder) => { void runConvert([o.so_doc_no]); };

  /* Open a row's underlying document: an ASSR row goes to the SERVICE CASE detail
     (/assr/:id, keyed on the numeric case id); an SO row keeps its Sales Order
     route. Shared by the row double-click + the context-menu "Open" action. */
  const openRow = (o: PlanningOrder) => {
    // DP-Order rows have no SO/ASSR document to open (their so_doc_no is a
    // synthetic `DP:<id>` key) — no navigation.
    if (isDp(o) || isProject(o)) return;
    if (isAssr(o)) {
      if (o.assr_id != null) navigate(`/assr/${o.assr_id}`);
    } else {
      navigate('/scm/sales-orders/' + o.so_doc_no);
    }
  };

  /* Selection keys are prefixed (`so:<docNo>` / `assr:<id>`). The bulk actions
     (Convert-to-DO, Schedule, Send) are SO-only, so extract the SO doc_nos. */
  const selectedSoDocNos = (): string[] => soDocNosFromSelection(sel);

  /* Bulk convert (selection bar) — confirm first (useConfirm, no window.*). */
  const convertSelected = async () => {
    const docNos = selectedSoDocNos();
    if (docNos.length === 0) return;
    if (!(await askConfirm({
      /* SINGULAR "Delivery Order" even for many sources: the label names the
         document TYPE being produced, not the count (owner rule 2026-08-17). */
      title: `Transfer ${docNos.length} sales order${docNos.length === 1 ? '' : 's'} to Delivery Order?`,
      body: 'Each selected Sales Order’s still-undelivered lines become a new Delivery Order (one DO per SO). Fully delivered orders are skipped.',
      confirmLabel: `Transfer ${docNos.length}`,
    }))) return;
    await runConvert(docNos);
  };

  /* Fetch scoped to the active REGION; counts come back region-scoped so the
     state-tab badges are stable as the operator flips state tabs. We pass the
     state to the server too (it filters), but render-time we already have the
     region-filtered orders so switching states is instant via the cache key. */
  const { data, isLoading, error } = useDeliveryPlanning({ region: activeRegion, state: 'ALL' });

  /* Region chips = the CONFIG-DRIVEN buckets from the API master (+ "All"
     prepended). Falls back to the five geographic defaults if the API hasn't
     returned the list yet. */
  const regionTabs = useMemo(() => regionTabsFrom(data?.regions), [data?.regions]);
  const activeRegionLabel = regionTabs.find((r) => r.key === activeRegion)?.label ?? 'All';

  const setState = (s: string) => {
    const next = new URLSearchParams(params);
    if (s === 'ALL') next.delete('state'); else next.set('state', s);
    setParams(next, { replace: true });
  };
  const setRegion = (r: string) => {
    const next = new URLSearchParams(params);
    if (r === 'ALL') next.delete('region'); else next.set('region', r);
    setParams(next, { replace: true });
  };

  const allOrders = useMemo<PlanningOrder[]>(() => data?.orders ?? [], [data]);
  const counts = data?.counts ?? { ALL: 0, PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0 };

  /* The SO order objects behind the current selection — fed to the scheduling
     drawer as its ordered stop list. Resolved from the region-scoped board (all
     states) by so_doc_no, so a selection made under one state tab still resolves
     after a tab switch. */
  const selectedOrders = useMemo<PlanningOrder[]>(() => {
    const docs = new Set(selectedSoDocNos());
    return allOrders.filter((o) => o.row_type === 'so' && docs.has(o.so_doc_no));
    // selectedSoDocNos reads `sel`; recompute when either the board or the
    // selection changes.
  }, [allOrders, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Latest WhatsApp (Seampify) send per SO — drives the "Message" column.
     Doc list from the WHOLE region fetch (not the state tab) so switching tabs
     never refires the statuses query. */
  const soDocNos = useMemo(
    () => allOrders.filter((o) => o.row_type === 'so').map((o) => o.so_doc_no).sort(),
    [allOrders],
  );
  const { data: msgStatuses } = useDeliveryMessageStatuses(soDocNos);

  /* The rows the Send-Message modal previews (open when non-null). SO-only,
     like every bulk action on this board. */
  const [sendingRows, setSendingRows] = useState<PlanningOrder[] | null>(null);
  const openSendModal = () => {
    const docs = new Set(selectedSoDocNos());
    if (docs.size === 0) return;
    setSendingRows(allOrders.filter((o) => o.row_type === 'so' && docs.has(o.so_doc_no)));
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Delivery Planning"
        description={`Orders that need delivering · grouped by region (customer state) · ${counts.ALL} in ${activeRegionLabel}`}
        primaryAction={
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            {/* Send Message — standing header button (owner picked design B,
                2026-07-22): always visible, WhatsApp green, counts the selected
                SO rows; disabled until something is ticked. */}
            <Button
              variant="primary"
              style={{ background: '#1D9E75', borderColor: '#1D9E75' }}
              disabled={selectedSoDocNos().length === 0}
              title={selectedSoDocNos().length === 0
                ? 'Tick the orders to message first'
                : 'WhatsApp the delivery details to the selected customers (one message per phone)'}
              onClick={openSendModal}
            >
              <MessageSquare size={16} strokeWidth={1.75} />
              Send Message ({selectedSoDocNos().length})
            </Button>
            {/* New DP Order — manual setup / dismantle / supplier-pickup jobs (and
                any ad-hoc delivery), created straight onto the board. */}
            <Button variant="primary" onClick={() => setShowNewDp(true)}>
              <Plus size={16} strokeWidth={1.75} />
              New DP Order
            </Button>
            <Button variant="secondary" onClick={() => navigate('/scm/delivery-planning-regions')}>
              <MapPinned size={16} strokeWidth={1.75} />
              Manage regions
            </Button>
          </span>
        }
      />

      <DeliveryPlanningBoard
        orders={allOrders}
        counts={counts}
        regionTabs={regionTabs}
        activeRegion={activeRegion}
        onRegionChange={setRegion}
        isLoading={isLoading}
        error={error}
        stateTabs={{ activeState, onStateChange: setState }}
        selectedKeys={sel}
        onToggle={(k) => setSel((p) => {
          const n = new Set(p);
          if (n.has(k)) n.delete(k); else n.add(k);
          return n;
        })}
        onToggleAll={(keys, allSel) => setSel((p) => {
          const n = new Set(p);
          if (allSel) { for (const k of keys) n.delete(k); }
          else { for (const k of keys) n.add(k); }
          return n;
        })}
        onClearSelection={() => setSel(new Set())}
        sched={sched}
        drivers={drivers}
        lorries={lorries}
        msgStatuses={msgStatuses}
        onRowDoubleClick={openRow}
        bulkExtras={
          <>
            {/* Schedule — open the resizable scheduling drawer for the selected SO
                orders (Phase 2). SO-only, like the other bulk actions. */}
            <Button
              variant="secondary"
              disabled={selectedSoDocNos().length === 0}
              onClick={() => setScheduling(true)}
              title={selectedSoDocNos().length === 0 ? 'Select one or more sales orders first' : 'Schedule the selected orders onto a trip'}
            >
              <CalendarClock size={14} strokeWidth={1.75} />
              <span>Schedule ({selectedSoDocNos().length})</span>
            </Button>

            {canConvertToDo && (
              <Button variant="secondary" disabled={convertSos.isPending} onClick={() => void convertSelected()}>
                <Truck size={14} strokeWidth={1.75} />
                <span>{convertSos.isPending ? 'Transferring…' : `Transfer ${sel.size} to Delivery Order`}</span>
              </Button>
            )}
          </>
        }
        contextMenu={(row) => (isProject(row) ? [] : isDp(row)
          ? [
              ...(!row.dp_no ? [{ label: 'Schedule…', onClick: () => setSchedulingDp(row) }] : []),
              { label: 'Cancel job', onClick: () => void cancelDpRow(row) },
            ]
          : isAssr(row)
          ? [
              { label: 'Set job date…', onClick: () => setDatingAssr(row) },
              { divider: true },
              { label: 'Open Service Case', onClick: () => openRow(row) },
            ]
          : [
              { label: 'Schedule…', onClick: () => setSchedulingOne(row) },
              { label: 'Edit HC fields…', onClick: () => setEditing(row) },
              { label: 'Send WhatsApp…', onClick: () => setSendingRows([row]) },
              ...(canConvertToDo
                ? [{ label: transferToLabel('do'), onClick: () => convertOne(row) }]
                : []),
              { divider: true },
              { label: 'Open Sales Order', onClick: () => openRow(row) },
            ])}
      />

      {/* Per-row HC fields editor (right-click → Edit HC fields). SO-context
          always editable; DO-execution editable only when the order has a DO. */}
      {showNewDp && <NewDpOrderDrawer onClose={() => setShowNewDp(false)} />}

      {schedulingDp && (
        <ScheduleDpOrderDrawer dpRow={schedulingDp} onClose={() => setSchedulingDp(null)} />
      )}

      {scheduling && (
        <ScheduleTripDrawer
          orders={selectedOrders}
          onClose={() => setScheduling(false)}
          onOpenTrips={() => navigate('/scm/trips')}
        />
      )}

      {/* Same drawer as the bulk bar, handed a single row from its menu. */}
      {schedulingOne && (
        <ScheduleTripDrawer
          orders={[schedulingOne]}
          onClose={() => setSchedulingOne(null)}
          onOpenTrips={() => navigate('/scm/trips')}
        />
      )}

      {datingAssr && (
        <SetJobDateDrawer order={datingAssr} onClose={() => setDatingAssr(null)} />
      )}

      {sendingRows && sendingRows.length > 0 && (
        <SendDeliveryMessageModal rows={sendingRows} onClose={() => setSendingRows(null)} />
      )}

      {editing && (
        <DeliveryFieldsDrawer order={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
};
