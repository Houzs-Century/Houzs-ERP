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
import { JobDetailPanel, panelTargetOf, rowDocumentPath, type JobPanelTarget } from '../../components/scm-v2/JobDetailPanel';
import { useNavigate } from 'react-router-dom';
import { useStickyFilters } from '../../hooks/useStickyFilters';
import { MapPinned, Truck, Plus, MessageSquare, CalendarClock, ChevronDown } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { DeliveryFieldsDrawer } from '../../vendor/scm/components/DeliveryFieldsDrawer';
import { NewDpOrderDrawer } from '../../vendor/scm/components/NewDpOrderDrawer';
import { SetJobDateDrawer } from '../../vendor/scm/components/SetJobDateDrawer';
import { ScheduleDpOrderDrawer } from '../../vendor/scm/components/ScheduleDpOrderDrawer';
import { ScheduleTripDrawer } from '../../vendor/scm/components/ScheduleTripDrawer';
import { SendDeliveryMessageModal, KIND_AFTER_STATUS, SKIP_LABEL, type SendMessageKind } from '../../vendor/scm/components/SendDeliveryMessageModal';
import {
  DeliveryPlanningBoard,
  regionTabsFrom,
  isDp,
  isAssr,
  isProject,
  dpLabel,
  rowIdOf,
  soDocNosFromSelection,
} from '../../vendor/scm/components/DeliveryPlanningBoard';
import { DELIVERY_PLANNING_LAYOUT_PRESETS } from '../../vendor/scm/lib/deliveryPlanningLayouts';
import { RowColorModal } from './RowColorModal';
import { useDeliveryRowMarks, type RowMarkColour } from '../../vendor/scm/lib/delivery-row-mark';
import { useDeliveryRowOrder, useSetRowOrder, orderComparator } from '../../vendor/scm/lib/delivery-row-order';
import { compareByDeliveryDate } from '../../vendor/scm/lib/delivery-date-group';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { transferToLabel } from '../../lib/convertScope';
import {
  useDeliveryPlanning,
  useConvertSosToDo,
  useCancelDpOrder,
  useScheduleDelivery,
  useDeliveryMessageStatuses,
  useSendDeliveryMessages,
  useUpdateDeliveryFields,
  filterOrdersByRegion,
  planningCountsFrom,
  type PlanningOrder,
  type PlanningCounts,
  type SendDeliveryMessagesResult,
} from '../../vendor/scm/lib/delivery-planning-queries';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';
import { useAuth } from '../../auth/AuthContext';
import { canOperateDeliveryOrders } from '../../auth/salesAccess';

export const DeliveryPlanning = () => {
  const navigate = useNavigate();
  // Single click opens the job panel; double click goes to the document.
  const [jobPanel, setJobPanel] = useState<JobPanelTarget | null>(null);
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { user, can, pageAccess } = useAuth();
  /* Creating a DO is the Office department's job (owner 2026-07-17), and the
     backend now 403s the Sales cohort on every /delivery-orders-mfg write. This
     board is reachable on scm.transportation.*, so the convert actions carried no
     DO gate of their own — same ONE helper as every other DO control. */
  const canConvertToDo = canOperateDeliveryOrders(user, can, pageAccess);
  /* Sticky state/region tabs (owner 2026-08-19 "页签被清掉"): same layered
     rule the Projects / Sales lists use — the URL stays authoritative (links
     and refresh unchanged), and with NO param in the URL the last-used pair is
     restored, so opening an SO (which replaces this workspace tab) and coming
     back through the sidebar lands on the tabs the operator left. */
  const [params, setParams] = useStickyFilters('delivery-planning', ['state', 'region']);
  const activeState = (params.get('state') ?? 'ALL').toUpperCase();
  const activeRegion = (params.get('region') ?? 'ALL').toUpperCase();

  /* The order whose HC fields are being edited (drawer open when non-null). */
  const [editing, setEditing] = useState<PlanningOrder | null>(null);
  /* Manual colour marks (owner 2026-09-26): a row's context menu opens the
     palette; the board tints the row from the same shared query. */
  const [coloringRow, setColoringRow] = useState<PlanningOrder | null>(null);
  const rowMarks = useDeliveryRowMarks().data;
  /* Manual drag order (owner 2026-09-26): the board sorts by it while no column
     sort is active; a drag persists the new order of the displayed rows. The
     DEFAULT beneath it (owner follow-up 2026-10-23) is EFFECTIVE delivery date,
     earliest first — so a board nobody has dragged opens date-ordered, and
     within each All-view month bucket the rows stay date-ordered. A manual drag
     still wins for the rows it placed (orderComparator ranks them first; the
     rest, and a board with no saved order, fall through to the date sort), and a
     clicked column header overrides both as always. */
  const rowOrder = useDeliveryRowOrder().data;
  const setRowOrder = useSetRowOrder();
  const orderSort = useMemo(() => {
    const cmp = orderComparator(rowOrder ?? []);
    return (a: PlanningOrder, b: PlanningOrder) =>
      cmp(rowIdOf(a), rowIdOf(b)) || compareByDeliveryDate(a, b);
  }, [rowOrder]);
  const [showNewDp, setShowNewDp] = useState(false);
  /* The DP job being scheduled (Schedule drawer open when non-null). */
  const [schedulingDp, setSchedulingDp] = useState<PlanningOrder | null>(null);
  /* A service case's date is confirmed from its row menu (one-field drawer). An
     SO's date, driver and lorry are set in their own cells, so its row menu no
     longer opens the trip drawer (owner 2026-10-26); the bulk bar still does. */
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
  const moveState = async (o: PlanningOrder, state: 'PENDING_SCHEDULE' | null) => {
    try {
      await sched.mutateAsync({ type: 'so', id: o.so_doc_no, deliveryState: state });
      void notify({
        title: state ? 'Moved to Pending Schedule' : 'Back to Pending Delivery',
        body: state
          ? `${o.so_doc_no} can be arranged now; its Stock column still shows what is ready.`
          : `${o.so_doc_no} follows its stock again: if every item is still ready it stays in Pending Schedule.`,
      });
    } catch (e) {
      void notify({ title: 'Not moved', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* Open a row's underlying document: an ASSR row goes to the SERVICE CASE detail
     (/assr/:id, keyed on the numeric case id); an SO row keeps its Sales Order
     route. Shared by the row double-click + the context-menu "Open" action. */
  const openRow = (o: PlanningOrder) => {
    // DP-Order rows have no SO/ASSR document to open (their so_doc_no is a
    // synthetic `DP:<id>` key) — no navigation.
    // A project leg opens its project; a manual DP job has no document — its panel.
    if (isProject(o)) { const to = rowDocumentPath(o); if (to) navigate(to); return; }
    if (isDp(o)) { setJobPanel(panelTargetOf(o)); return; }
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

  /* Fetch EVERY region once (region=ALL) and filter by the active region chip in
     the browser (filterOrdersByRegion below) — the same instant, no-refetch
     pattern the state tabs already use, and the mobile board already uses. The
     old per-region fetch re-ran the whole server board assembly on every chip
     click, so the region row felt frozen (owner 2026-10-19 "filter 没反应");
     locally it is instant and the region chip no longer triggers a load. */
  const { data, isLoading, error } = useDeliveryPlanning({ region: 'ALL', state: 'ALL' });

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
  /* Toolbar "Reset layout": back to All / All. The grid clears its own funnels
     and search box in the same click. */
  const resetView = () => {
    const next = new URLSearchParams(params);
    next.delete('state');
    next.delete('region');
    setParams(next, { replace: true });
  };

  /* Every fetched order (all regions). The active region chip filters this
     locally; valid region keys come from the chip list (an unknown/stale key is
     a defensive no-op, never an empty board). */
  const fetchedOrders = useMemo<PlanningOrder[]>(() => data?.orders ?? [], [data]);
  const regionKeys = useMemo(() => new Set(regionTabs.map((r) => r.key)), [regionTabs]);
  const allOrders = useMemo<PlanningOrder[]>(
    () => filterOrdersByRegion(fetchedOrders, activeRegion, regionKeys),
    [fetchedOrders, activeRegion, regionKeys],
  );
  /* State-tab badges over the region-filtered set, so they reflect the active
     region exactly as the server's region-scoped counts did. */
  const counts = useMemo<PlanningCounts>(() => planningCountsFrom(allOrders), [allOrders]);

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
  const [sendKind, setSendKind] = useState<SendMessageKind>('delivery');
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [oneTimeOpen, setOneTimeOpen] = useState(false);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const openSendModal = (kind: SendMessageKind) => {
    const docs = new Set(selectedSoDocNos());
    if (docs.size === 0) return;
    setSendKind(kind);
    setSendingRows(allOrders.filter((o) => o.row_type === 'so' && docs.has(o.so_doc_no)));
  };

  /* Postpone sends with NO modal (owner 2026-10-15): the reason and the new
     date are the row's own Amend Reason + Delivery Date, so there is nothing to
     ask — the backend reads them per order and skips any missing either. Fire,
     move the status on the ones that went, and report the summary. */
  const sendMsg = useSendDeliveryMessages();
  const updateFields = useUpdateDeliveryFields();
  const sendPostponeDirect = () => {
    const docNos = selectedSoDocNos();
    if (docNos.length === 0 || sendMsg.isPending) return;
    void sendMsg.mutate({ docNos, kind: 'postpone' }, {
      onSuccess: (res: SendDeliveryMessagesResult) => {
        const after = KIND_AFTER_STATUS['postpone'];
        if (after) for (const g of res.sent) for (const id of g.docNos) void updateFields.mutate({ type: 'so', id, deliveryMessageStatus: after });
        const parts: string[] = [];
        if (res.sent.length) parts.push(`Sent ${res.sent.length} message${res.sent.length === 1 ? '' : 's'} (${res.sent.reduce((n, g) => n + g.docNos.length, 0)} orders).`);
        if (res.failed.length) parts.push(`Failed ${res.failed.length}: ${res.failed.map((f) => `${f.phone} (${f.error})`).join('; ')}.`);
        if (res.skipped.length) parts.push(`Skipped ${res.skipped.length}: ${res.skipped.map((sk) => `${sk.docNo} (${SKIP_LABEL[sk.reason] ?? sk.reason})`).join(', ')}.`);
        void notify({
          title: res.failed.length ? 'Postpone finished with failures' : res.sent.length ? 'Postpone notice sent' : 'Nothing sent',
          body: parts.join(' ') || 'Nothing to send.',
          tone: res.failed.length ? 'error' : 'info',
        });
        setSel(new Set());
      },
      onError: (err) => notify({ title: 'Send failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
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
            <div style={{ position: 'relative' }}>
              <Button
                variant="primary"
                style={{ background: '#1D9E75', borderColor: '#1D9E75' }}
                disabled={selectedSoDocNos().length === 0}
                title={selectedSoDocNos().length === 0 ? 'Tick the orders to message first' : 'Send a WhatsApp message to the selected customers'}
                onClick={() => { setSendMenuOpen((v) => !v); setOneTimeOpen(false); }}
              >
                <MessageSquare size={16} strokeWidth={1.75} />
                Send Message ({selectedSoDocNos().length})
                <ChevronDown size={14} strokeWidth={1.75} />
              </Button>
              {sendMenuOpen && (
                <>
                  <div onClick={() => { setSendMenuOpen(false); setOneTimeOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div
                    role="menu"
                    style={{
                      position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 41, minWidth: 220,
                      /* Expanding "One Time Send Now" makes this 11 items tall — cap it to
                         the viewport and scroll, so the bottom entries (Postage / Delivery
                         Completed) can't fall off-screen (owner 2026-10-23). */
                      maxHeight: '70vh', overflowY: 'auto',
                      background: '#fff', border: '1px solid var(--line)', borderRadius: 'var(--radius-md, 10px)',
                      boxShadow: '0 8px 28px rgba(34, 31, 32, 0.14)', padding: 4,
                    }}
                  >
                    {(() => {
                      const renderKind = (
                        [k, label, hint]: readonly [SendMessageKind, string, string],
                        sub: boolean,
                      ) => (
                        <button
                          key={k}
                          type="button"
                          role="menuitem"
                          onClick={() => { setSendMenuOpen(false); setOneTimeOpen(false); if (k === 'postpone') sendPostponeDirect(); else openSendModal(k); }}
                          style={{ display: 'block', width: '100%', padding: sub ? '8px 10px 8px 24px' : '8px 10px', background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg, #f4f2ec)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-13, 13px)', fontWeight: 600, color: 'var(--ink, #221f20)' }}>
                            <MessageSquare size={14} strokeWidth={1.75} /> {label}
                          </span>
                          <span style={{ display: 'block', marginLeft: 22, fontSize: 'var(--fs-12, 11px)', color: 'var(--c-muted, #767b6e)' }}>{hint}</span>
                        </button>
                      );
                      return (
                        <>
                          {([
                            ['delivery', 'Send Now', 'Delivery-date message (Confirm / Amend)'],
                            ['amend', 'Amend Now', 'Amend / reschedule message (Confirm / Amend)'],
                          ] as const).map((it) => renderKind(it, false))}
                          {/* One Time Send Now (owner 2026-10-21): the ad-hoc sends
                              fold under one entry, opened on demand. */}
                          <button
                            type="button"
                            role="menuitem"
                            aria-expanded={oneTimeOpen}
                            onClick={() => setOneTimeOpen((v) => !v)}
                            style={{ display: 'block', width: '100%', padding: '8px 10px', background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg, #f4f2ec)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-13, 13px)', fontWeight: 600, color: 'var(--ink, #221f20)' }}>
                              <MessageSquare size={14} strokeWidth={1.75} /> One Time Send Now
                              <ChevronDown size={13} strokeWidth={1.75} style={{ marginLeft: 'auto', transform: oneTimeOpen ? 'rotate(180deg)' : 'none' }} />
                            </span>
                            <span style={{ display: 'block', marginLeft: 22, fontSize: 'var(--fs-12, 11px)', color: 'var(--c-muted, #767b6e)' }}>Pick one: postpone, driver info, balance, reminders, postage, thanks</span>
                          </button>
                          {oneTimeOpen && ([
                            ['postpone', 'Postpone', 'Move the date - reads the order reason and new date'],
                            ['driver_info', 'Driver Info', 'Day-before: date, time, driver, lorry plate'],
                            ['balance_reminder', 'Balance Reminder', 'Outstanding balance + bank details (owing orders only)'],
                            ['reminder_1', 'Reminder 1', 'No reply yet - first nudge'],
                            ['reminder_2', 'Reminder 2', 'No reply yet - second nudge'],
                            ['reminder_3', 'Reminder 3', 'No reply yet - final nudge'],
                            ['postage', 'Postage Confirm', 'Confirm the postage address'],
                            ['delivery_completed', 'Delivery Completed', 'Thank-you after delivery'],
                          ] as const).map((it) => renderKind(it, true))}
                        </>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
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

      <JobDetailPanel target={jobPanel} onClose={() => setJobPanel(null)} />
      <DeliveryPlanningBoard
        orders={allOrders}
        resetFilters={{ active: activeState !== 'ALL' || activeRegion !== 'ALL', onReset: resetView }}
        layoutPresets={DELIVERY_PLANNING_LAYOUT_PRESETS}
        initialRowLimit={200}
        defaultSort={orderSort}
        onRowReorder={(keys) => setRowOrder.mutate(keys)}
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
        onRowClick={(o) => setJobPanel(panelTargetOf(o))}
        onRowDoubleClick={openRow}
        bulkExtras={
          /* The heavier actions (Schedule drawer, Transfer to Delivery Order)
             live in one "Actions" menu so the bulk bar is not a wall of buttons
             (owner 2026-10-15); the quick Set Status / Colour stay inline in the
             bar. Same dropdown pattern as Send Message above. */
          <div style={{ position: 'relative' }}>
            <Button
              variant="secondary"
              disabled={selectedSoDocNos().length === 0}
              onClick={() => setBulkMenuOpen((v) => !v)}
              title={selectedSoDocNos().length === 0 ? 'Select one or more sales orders first' : 'Scheduling and delivery-order actions'}
            >
              Actions ({selectedSoDocNos().length})
              <ChevronDown size={14} strokeWidth={1.75} />
            </Button>
            {bulkMenuOpen && (
              <>
                <div onClick={() => setBulkMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                <div
                  role="menu"
                  style={{
                    position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 41, minWidth: 240,
                    /* Short today, but cap + scroll so it can't fall off-screen either
                       if more bulk actions are added (twin of the Send Message menu). */
                    maxHeight: '70vh', overflowY: 'auto',
                    background: '#fff', border: '1px solid var(--line)', borderRadius: 'var(--radius-md, 10px)',
                    boxShadow: '0 8px 28px rgba(34, 31, 32, 0.14)', padding: 4,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setBulkMenuOpen(false); setScheduling(true); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontSize: 'var(--fs-13, 13px)', fontWeight: 600, color: 'var(--ink, #221f20)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg, #f4f2ec)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <CalendarClock size={14} strokeWidth={1.75} /> Schedule ({selectedSoDocNos().length})
                  </button>
                  {canConvertToDo && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={convertSos.isPending}
                      onClick={() => { setBulkMenuOpen(false); void convertSelected(); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', background: 'transparent', border: 'none', borderRadius: 8, cursor: convertSos.isPending ? 'default' : 'pointer', textAlign: 'left', fontSize: 'var(--fs-13, 13px)', fontWeight: 600, color: 'var(--ink, #221f20)', opacity: convertSos.isPending ? 0.6 : 1 }}
                      onMouseEnter={(e) => { if (!convertSos.isPending) e.currentTarget.style.background = 'var(--bg, #f4f2ec)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <Truck size={14} strokeWidth={1.75} /> {convertSos.isPending ? 'Transferring…' : `Transfer ${sel.size} to Delivery Order`}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        }
        contextMenu={(row) => {
          if (isProject(row)) return [];
          const mark = { label: 'Mark colour…', onClick: () => setColoringRow(row) };
          const rest = isDp(row)
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
                /* Arrange before the goods are ready (owner 2026-10-26): the row
                   moves to Pending Schedule while its Stock column stays live. */
                ...(row.delivery_state === 'PENDING_DELIVERY' || row.delivery_state === 'OVERDUE'
                  ? [{ label: 'Move to Pending Schedule', onClick: () => moveState(row, 'PENDING_SCHEDULE') }]
                  : []),
                ...(row.delivery_state_override
                  ? [{ label: 'Back to Pending Delivery', onClick: () => moveState(row, null) }]
                  : []),
                { label: 'Edit HC fields…', onClick: () => setEditing(row) },
                { label: 'Send WhatsApp…', onClick: () => { setSendKind('delivery'); setSendingRows([row]); } },
                ...(canConvertToDo
                  ? [{ label: transferToLabel('do'), onClick: () => convertOne(row) }]
                  : []),
                { divider: true },
                { label: 'Open Sales Order', onClick: () => openRow(row) },
              ];
          return [mark, { divider: true }, ...rest];
        }}
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

      {datingAssr && (
        <SetJobDateDrawer order={datingAssr} onClose={() => setDatingAssr(null)} />
      )}

      {sendingRows && sendingRows.length > 0 && (
        <SendDeliveryMessageModal rows={sendingRows} kind={sendKind} onClose={() => setSendingRows(null)} />
      )}

      {editing && (
        <DeliveryFieldsDrawer order={editing} onClose={() => setEditing(null)} />
      )}

      {coloringRow && (
        <RowColorModal
          rowKey={rowIdOf(coloringRow)}
          title={rowIdOf(coloringRow)}
          currentColour={(rowMarks?.get(rowIdOf(coloringRow)) as RowMarkColour | undefined) ?? null}
          onClose={() => setColoringRow(null)}
        />
      )}
    </div>
  );
};
