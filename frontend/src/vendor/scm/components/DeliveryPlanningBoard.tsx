
import { useMemo, useState, useEffect, useRef, useCallback, createContext, useContext, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useUpdateTrip } from '../lib/trips-queries';
import { buildVariantSummary, fmtSen, fmtDate, fmtDateOrDash, fmtDateTime } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import { DataGridCompat, type GridColumn, type GridContextMenuItem } from '../../../components/DataGridCompat';
import { useConfirm } from './ConfirmDialog';
import { useNotify } from './NotifyDialog';
import { crewSaveFailed } from '../lib/crew-save-error';
import { serviceNotify } from '../lib/dialog-service';
import { Button } from '../../../components/Button';
import { MarkDeliveredCell } from './MarkDeliveredCell';
import { StockRemarkPill, stockRemarkSortFn } from '../../../components/StockRemarkPill';
import { badgeFor } from '../lib/category-badges';
import {
  useDeliveryPlanningLines,
  useScheduleDelivery,
  useUpdateDeliveryFields,
  useAssignDoCrew,
  useDpCrew,
  DELIVERY_STATES,
  DELIVERY_STATE_LABEL,
  sxeDateOf,
  MESSAGE_STATUSES,
  messageStatusChip,
  dpJobTypeLabel,
  assrJobKindLabel,
  dateArrangementOf,
  DATE_ARRANGEMENT_LABEL,
  ARRANGEMENT_STAGE_LABEL,
  type DeliveryState,
  type PlanningOrder,
} from '../lib/delivery-planning-queries';
import { compareByDeliverySlot, deliveryMonthKey, deliveryMonthLabel } from '../lib/delivery-date-group';
import type { LayoutSeed } from '../../../lib/tableLayouts';
import { type DriverRow } from '../lib/drivers-queries';
import { type LorryRow } from '../lib/lorries-queries';
import { useHelpers, type HelperRow } from '../lib/helpers-queries';
import { useStaffLookup } from '../../../hooks/useStaffLookup';
import styles from './DeliveryPlanningBoard.module.css';
import { DateField } from "./DateField";
import { deliveryDateChange, invalidDeliveryDate } from "../lib/delivery-date-edit";
import { SearchCombo } from "./SearchCombo";
import { crewToCopy, seatsForTarget, type CrewSeats } from "../lib/crew-paste";
import { useLocalities, postcodeIndex, postcodeLabel } from "../lib/localities-queries";
import { crewComboOptions, crewComboValue, latestDoId, KEEP_CURRENT } from "../lib/dispatch-cell";
import { useDeliveryRowMarks, rowMarkTint, useBulkSetRowMark, useBulkClearRowMark, ROW_MARK_PALETTE } from "../lib/delivery-row-mark";
import { useAmendReasonOptions } from "../lib/delivery-amend-reasons-queries";

const SUBSTATUS_TONE: Record<string, string> = {
  'Pending Pickup': '#767b6e',
  'Done Shipout': '#2f5d4f',
  'Arrives EM Warehouse': '#2f5d4f',
  'Done Delivered': '#2e7d32',
  'Confirm': '#2f5d4f',
  'House Not Ready': '#0c3f39',
  'Request Hold': '#0c3f39',
};
function SubstatusPill({ value }: { value: string | null }) {
  if (!value) return <span style={{ color: 'var(--hz-c-ink-muted)' }}>—</span>;
  const tone = SUBSTATUS_TONE[value] ?? '#767b6e';
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      border: `1px solid ${tone}`, color: tone, fontSize: 'var(--fs-10)',
      fontWeight: 600, whiteSpace: 'nowrap',
    }}>{value}</span>
  );
}
const dtOrDash = (iso: string | null): string => (iso ? fmtDateTime(iso) : '—');

function PodCell({ o }: { o: PlanningOrder }) {
  if (o.row_type !== 'so') return <NotApplicable />;
  if (o.has_pod) {
    const doId = o.delivery_orders[o.delivery_orders.length - 1]?.id;
    const chip = (
      <span style={{
        display: 'inline-block', padding: '1px 8px', borderRadius: 999,
        border: '1px solid #2e7d32', color: '#2e7d32', fontSize: 'var(--fs-10)',
        fontWeight: 600, whiteSpace: 'nowrap',
      }}>✓ POD</span>
    );
    return doId ? <Link to={`/scm/delivery-orders/${doId}`} title="View proof of delivery">{chip}</Link> : chip;
  }
  if (o.delivery_state === 'DELIVERED') {
    return (
      <span style={{
        display: 'inline-block', padding: '1px 8px', borderRadius: 999,
        border: '1px solid #b26a00', color: '#b26a00', fontSize: 'var(--fs-10)',
        fontWeight: 600, whiteSpace: 'nowrap',
      }}>No POD</span>
    );
  }
  return <NotApplicable />;
}

function CompanyBadge({ code }: { code: string | null }) {
  if (!code) return <span style={{ color: 'var(--hz-c-ink-muted)' }}>—</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      border: '1px solid #2f5d4f', color: 'var(--hz-dk-secondary-a, #2f5d4f)',
      fontSize: 'var(--fs-10)', fontWeight: 700, letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>{code}</span>
  );
}

export const isAssr = (o: PlanningOrder): boolean => o.row_type === 'assr';
export const isDp = (o: PlanningOrder): boolean => o.row_type === 'dp';
export const isProject = (o: PlanningOrder): boolean => o.row_type === 'project';
export const dpIdOf = (o: PlanningOrder): string => o.so_doc_no.replace(/^DP:/, '');
export const projectIdOf = (o: PlanningOrder): string => o.so_doc_no.replace(/^PRJ:/, '').replace(/#.*$/, '');
export const dpLabel = (o: PlanningOrder): string =>
  o.dp_job_type ? dpJobTypeLabel(o.dp_job_type) : 'DP job';
export const rowIdOf = (o: PlanningOrder): string =>
  isDp(o)
    ? `dp:${o.so_doc_no}`
    : isAssr(o)
      ? `assr:${o.assr_id ?? o.ref ?? ''}:${o.job_kind ?? ''}`
      : `so:${o.so_doc_no}`;

function TypeChip({ order }: { order: PlanningOrder }) {
  let label = 'SO delivery';
  let tone = '#767b6e';
  let bg = 'rgba(34, 31, 32, 0.06)';
  if (isDp(order)) {
    label = dpLabel(order);
    tone = '#8a2f66';
    bg = 'rgba(166, 50, 107, 0.12)';
  } else if (isProject(order)) {
    label = dpLabel(order);
    tone = '#1f5e73';
    bg = 'rgba(31, 94, 115, 0.12)';
  } else if (isAssr(order)) {
    label = assrJobKindLabel(order.job_kind);
    if (order.job_kind === 'customer_pickup') {
      tone = '#0c3f39';
      bg = 'rgba(232, 107, 58, 0.12)';
    } else if (order.job_kind === 'inspection') {
      tone = '#5a3fa0';
      bg = 'rgba(90, 63, 160, 0.12)';
    } else {
      tone = '#2f5d4f';
      bg = 'rgba(47, 93, 79, 0.12)';
    }
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 8px', borderRadius: 999,
      background: bg, color: tone,
      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
      fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

const NotApplicable = () => <span style={{ color: 'var(--hz-c-ink-muted)' }}>—</span>;

/* ── SO-list type ramp (owner 2026-08-19: "要和 sales order design 设计,字体,
   颜色一样") — the three cell voices the DataTable lists speak, mirrored here:
   doc numbers = Plex Mono 12.5 semibold ink (`font-docno`), primary names =
   13 semibold ink, detail text = 12.5 ink-secondary. Hexes written out for the
   usual vendor-cascade reason (several --c-* tokens resolve differently here). */
const DOCNO_STYLE: CSSProperties = {
  fontFamily: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace",
  fontSize: 12.5, fontWeight: 600, color: 'var(--hz-c-ink)',
};
const MONEY_STYLE: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--hz-c-ink)' };
const strong = (v: ReactNode) => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--hz-c-ink)' }}>{v}</span>;
const detail = (v: ReactNode) => (
  <span style={{ fontSize: 12.5, color: 'var(--hz-c-ink-secondary)', fontVariantNumeric: 'tabular-nums' }}>{v}</span>
);

export type RegionTab = { key: string; label: string; sg?: boolean };

export function regionTabsFrom(
  regions?: Array<{ key: string; label: string }>,
): RegionTab[] {
  const masters = regions ?? [
    { key: 'KL', label: 'KL/SEL' }, { key: 'NORTHERN', label: 'Northern' },
    { key: 'SOUTHERN', label: 'Southern' }, { key: 'EAST_COAST', label: 'East Coast' },
    { key: 'EM', label: 'East Malaysia' },
  ];
  return [
    { key: 'ALL', label: 'All' },
    ...masters.map((r) => ({ key: r.key, label: r.label, sg: r.key === 'SG' })),
  ];
}

const STATE_TABS = DELIVERY_STATES;

type SchedMutation = ReturnType<typeof useScheduleDelivery>;

const stopRow = {
  onClick: (e: ReactMouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: ReactMouseEvent) => e.stopPropagation(),
};

type UpdateFieldsMutation = ReturnType<typeof useUpdateDeliveryFields>;

type BoardPending = { fields: boolean; sched: boolean; crew: boolean };
const BoardPendingContext = createContext<BoardPending>({ fields: false, sched: false, crew: false });

type ScheduleMutate = SchedMutation['mutate'];
type UpdateFieldsMutate = UpdateFieldsMutation['mutate'];

const fieldNotSaved = (err: unknown) => serviceNotify({
  title: 'Not saved',
  body: err instanceof Error ? err.message : 'Something went wrong.',
  tone: 'error',
});

const plainOption = { backgroundColor: 'var(--hz-c-surface)', color: 'var(--hz-c-ink)' };

/* The "Delivery Status" column's inline editor — the customer-message follow-up
   workflow status (owner 2026-09-22), one of the 23 MESSAGE_STATUSES or blank.
   SO rows only; ASSR / DP / project rows show a dash (this is a customer-
   conversation field, not a fleet-job one). Writes delivery_message_status
   through useUpdateDeliveryFields; the blank option clears it. */
function MessageStatusEditCell({ order, onUpdateFields }: { order: PlanningOrder; onUpdateFields: UpdateFieldsMutate }) {
  const { fields } = useContext(BoardPendingContext);
  if (isProject(order)) return <NotApplicable />;
  /* SO rows write their own column; DP (manual job) rows write
     scm.dp_orders.delivery_message_status; service-case rows write
     assr_cases.delivery_message_status (owner 2026-10-29 — the non-SO job types
     adjust it too, so the ASSR row is an editable select, not a read-only chip).
     A service case's row shows the newest of send / customer tap / this pick. */
  const target = isDp(order) ? { type: 'dp' as const, id: dpIdOf(order) }
    : isAssr(order) ? { type: 'assr' as const, id: String(order.assr_id ?? ''), jobKind: order.job_kind ?? undefined }
    : { type: 'so' as const, id: order.so_doc_no };
  const chip = messageStatusChip(order.delivery_message_status);
  const chipStyle = chip ? { backgroundColor: chip.bg, color: chip.fg } : undefined;
  return (
    <select
      className={chip ? `${styles.inlineEdit} ${styles.messageChip}` : styles.inlineEdit}
      style={chipStyle}
      value={order.delivery_message_status ?? ''}
      disabled={fields}
      title="Customer-message workflow status"
      {...stopRow}
      onChange={(e) => {
        const next = e.target.value;
        if ((next || null) === (order.delivery_message_status ?? null)) return;
        onUpdateFields({ ...target, deliveryMessageStatus: next || null }, { onError: fieldNotSaved });
      }}
    >
      <option value="" style={plainOption}>—</option>
      {order.delivery_message_status
        && !(MESSAGE_STATUSES as readonly string[]).includes(order.delivery_message_status)
        ? <option value={order.delivery_message_status} style={plainOption}>{order.delivery_message_status}</option>
        : null}
      {MESSAGE_STATUSES.map((s) => {
        const c = messageStatusChip(s);
        return <option key={s} value={s} style={c && { backgroundColor: c.bg, color: c.fg }}>{s}</option>;
      })}
    </select>
  );
}

/* Delivery Date inline editor (owner 2026-09-25: 填写日期也能选日期) — the board's
   "Delivery Date" column is editable in place again, both by typing dd/mm/yyyy and
   by the calendar picker (the shared DateField does both). SO rows write
   amended_delivery_date via useScheduleDelivery, committing on BLUR so a half-typed
   year (31/03/20 → 31/03/2026) is never saved on the way. ASSR / DP / project rows
   keep their own scheduling entry (drawer / DP Order / read-only mirror). */
function DeliveryDateEditCell({ order, onSchedule }: { order: PlanningOrder; onSchedule: ScheduleMutate }) {
  const current = (order.amended_delivery_date ?? '').slice(0, 10);
  const [val, setVal] = useState(current);
  const { sched: schedPending } = useContext(BoardPendingContext);
  const notify = useNotify();
  useEffect(() => { setVal(current); }, [current]);
  if (isProject(order)) {
    return detail(fmtDateOrDash(order.amended_delivery_date));
  }
  /* A service case's Delivery Date is the date Logistics CONFIRMS (owner
     2026-10-26): typed here like an SO's, it moves the leg to Pending Delivery.
     A DP (manual job) row writes scm.dp_orders.requested_date (and moves its
     trip's date when it rides one) — owner 2026-10-29. */
  const commit = (value: string | null) => (isAssr(order)
    ? onSchedule({ type: 'assr', id: String(order.assr_id ?? ''), scheduleDate: value, jobKind: order.job_kind })
    : isDp(order)
      ? onSchedule({ type: 'dp', id: dpIdOf(order), scheduleDate: value })
      : onSchedule({ type: 'so', id: order.so_doc_no, scheduleDate: value }));
  return (
    <span {...stopRow} style={{ display: 'flex', width: '100%', minWidth: 0 }}>
      <DateField
        fullWidth
        value={val}
        disabled={schedPending}
        aria-label="Delivery date"
        onChange={setVal}
        onBlur={() => {
          const next = deliveryDateChange(current, val);
          if (next.changed) commit(next.value);
        }}
        /* HC-0164 (Syu, 2026-10-28): a wrong format pops up and empties the
           cell, as the HC Delivery sheet does. */
        onInvalid={(text) => {
          const { clear, body } = invalidDeliveryDate(current, text, order.so_doc_no);
          if (clear) commit(null);
          void notify({ title: 'Invalid date format', body, tone: 'error' });
        }}
      />
    </span>
  );
}

/* Amend Reason inline editor (owner 2026-09-22) — pick a preset reason or keep a
   free-text one. SO rows AND service-case legs (owner 2026-11-16: a postponed
   pickup / inspection / delivery needs its reason too); a DP job / project has no
   amend reason. SO writes mfg_sales_orders.amend_reason; an ASSR leg writes its
   own per-leg column (jobKind), both through useUpdateDeliveryFields. */
function AmendReasonEditCell({ order, onUpdateFields, options }: { order: PlanningOrder; onUpdateFields: UpdateFieldsMutate; options: readonly string[] }) {
  const { fields } = useContext(BoardPendingContext);
  if (isDp(order) || isProject(order)) return <NotApplicable />;
  const target = isAssr(order)
    ? { type: 'assr' as const, id: String(order.assr_id ?? ''), jobKind: order.job_kind ?? undefined }
    : { type: 'so' as const, id: order.so_doc_no };
  const current = order.amend_reason ?? '';
  return (
    <select
      className={styles.inlineEdit}
      value={current}
      disabled={fields}
      title="Amend / reschedule reason"
      {...stopRow}
      onChange={(e) => {
        const next = e.target.value;
        if ((next || null) === (order.amend_reason ?? null)) return;
        onUpdateFields({ ...target, amendReason: next || null }, { onError: fieldNotSaved });
      }}
    >
      <option value="">—</option>
      {current && !options.includes(current)
        ? <option value={current}>{current}</option>
        : null}
      {options.map((r) => (
        <option key={r} value={r}>{r}</option>
      ))}
    </select>
  );
}

/* A plain inline text editor for a free-text SO field (owner 2026-09-22:
   Disposal Request, Remarks). SO rows only, EXCEPT when allowNonSo — the Time Slot
   is editable on DP rows too (owner 2026-10-31, scm.dp_orders.time_range) and on
   service-case legs (HC-0194) — and allowProject (Remarks: the project's board
   remark). Commits on blur / Enter. */
function TextEditCell({ order, value, onCommit, placeholder, allowNonSo = false, allowProject = false }: {
  order: PlanningOrder; value: string | null; onCommit: (next: string | null) => void; placeholder?: string; allowNonSo?: boolean; allowProject?: boolean;
}) {
  if ((isProject(order) && !allowProject) || ((isAssr(order) || isDp(order)) && !allowNonSo)) return <NotApplicable />;
  return (
    <input
      key={value ?? ''}
      className={styles.inlineEdit}
      defaultValue={value ?? ''}
      placeholder={placeholder}
      {...stopRow}
      onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (value ?? null)) onCommit(v); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/* The inline schedule-date cell lived here until the owner's 2026-08-04 column
   pass removed its column ("删列但保留排期"). Scheduling did NOT go with it: an
   SO row opens ScheduleTripDrawer from its row menu (date + driver + lorry +
   trip), a service case opens SetJobDateDrawer, which makes the same
   type:'assr' + jobKind call this cell used to make. Either way the write still
   lands on the SO's amended_delivery_date — the customer's ORIGINAL
   customer_delivery_date is never overwritten. */

/* Write ONE crew seat on the row's latest DO (owner 2026-09-26). Returns false
   when the order has no DO yet — crew lives on delivery_order_crew, so there is
   nothing to write and the caller reverts its picker and prompts to open a DO. */
type CrewSeatWrite = (order: PlanningOrder, seat: {
  driver1Id?: string | null; driver2Id?: string | null;
  helper1Id?: string | null; helper2Id?: string | null; lorryId?: string | null;
}, onFail?: () => void) => boolean;

/* Driver — a type-to-search picker (owner 2026-09-26: 可以输入搜索). SO rows write
   the DO crew (delivery_order_crew) via useAssignDoCrew, which snapshots the
   driver's IC + contact from the master so the neighbouring Driver IC / Driver
   Contact columns fill in on the refetch. ASSR legs keep the trip-crew write
   (type:'assr') so the leg still consumes fleet capacity. DP → n/a; project →
   read-only mirror (edit in Projects). */
function DriverPickCell({ order, drivers, onSchedule, writeSeat }: {
  order: PlanningOrder; drivers: DriverRow[]; onSchedule: ScheduleMutate; writeSeat: CrewSeatWrite;
}) {
  // SCROLL PERF (owner 2026-10-21 "滚动变顺"): the board re-renders every visible
  // cell on each scroll frame / tick / keystroke. These option lists must be
  // MEMOISED — rebuilt per render they handed SearchCombo a new array identity
  // every time, forcing its own chosen/hits/rows useMemos to recompute on all
  // ~200 crew pickers on screen. drivers is react-query-stable, so this is free.
  const items = useMemo(() => drivers.map((d) => ({ id: d.id, label: d.name })), [drivers]);
  const currentName = order.crew?.driver_1_name ?? null;
  const options = useMemo(() => crewComboOptions(items, currentName), [items, currentName]);
  const chosen = useMemo(() => crewComboValue(items, currentName), [items, currentName]);
  const [val, setVal] = useState(chosen);
  const { crew: pending } = useContext(BoardPendingContext);
  useEffect(() => { setVal(chosen); }, [chosen]);
  // A DP job writes its RUN's crew via useDpCrew (writeSeat below), which puts a
  // trip-less job on a run first — so the cell is editable with or without a trip
  // (owner 2026-10-31), like an SO row.
  if (isProject(order)) return <span style={{ color: 'var(--hz-c-ink-muted)' }}>{order.crew?.driver_1_name || '—'}</span>;
  const assrLeg = isAssr(order);
  const typed = !!order.crew?.driver_1_typed;
  return (
    <span {...stopRow} style={{ display: 'flex', width: '100%', minWidth: 0, alignItems: 'center', gap: 4 }}
      title={typed ? 'Typed on the delivery order, not picked from Fleet: no IC or phone. Pick the driver here.' : undefined}>
      {typed && <span aria-label="Driver not linked to Fleet" style={{ color: 'var(--c-burnt)', fontWeight: 700 }}>!</span>}
      <SearchCombo
        fill aria-label="Driver" placeholder="— pick a driver —"
        options={options}
        value={val}
        disabled={pending}
        onChange={(picked) => {
          if (picked === KEEP_CURRENT) return;
          const driverId = picked || null;
          if (assrLeg) {
            setVal(picked);
            const driverNameOptimistic = driverId ? (drivers.find((d) => d.id === driverId)?.name ?? null) : null;
            onSchedule({ type: 'assr', id: String(order.assr_id ?? ''), jobKind: order.job_kind, driverId, driverNameOptimistic });
            return;
          }
          setVal(writeSeat(order, { driver1Id: driverId }, () => setVal(chosen)) ? picked : chosen);
        }}
      />
    </span>
  );
}

function LorryPickCell({ order, lorries, onSchedule, writeSeat }: {
  order: PlanningOrder; lorries: LorryRow[]; onSchedule: ScheduleMutate; writeSeat: CrewSeatWrite;
}) {
  const items = useMemo(() => lorries.map((l) => ({ id: l.id, label: l.plate })), [lorries]);
  const currentPlate = order.crew?.lorry_plate ?? null;
  const options = useMemo(() => crewComboOptions(items, currentPlate), [items, currentPlate]);
  const chosen = useMemo(() => crewComboValue(items, currentPlate), [items, currentPlate]);
  const [val, setVal] = useState(chosen);
  const { crew: pending } = useContext(BoardPendingContext);
  useEffect(() => { setVal(chosen); }, [chosen]);
  // A DP job's lorry is set on its RUN via useDpCrew (writeSeat below): picking a
  // lorry puts a trip-less job on a run and mints its DP number, so the cell is
  // editable with or without a trip (owner 2026-10-31), like an SO row.
  // Project rows are a read-only PMS mirror (edit in Projects).
  if (isProject(order)) return <span style={{ color: 'var(--hz-c-ink-muted)' }}>{order.crew?.lorry_plate || '—'}</span>;
  const assrLeg = isAssr(order);
  return (
    <span {...stopRow} style={{ display: 'flex', width: '100%', minWidth: 0 }}>
      <SearchCombo
        fill aria-label="Lorry plate" placeholder="— pick a lorry —"
        options={options}
        value={val}
        disabled={pending}
        onChange={(picked) => {
          if (picked === KEEP_CURRENT) return;
          const lorryId = picked || null;
          if (assrLeg) {
            setVal(picked);
            const lorryPlateOptimistic = lorryId ? (lorries.find((l) => l.id === lorryId)?.plate ?? null) : null;
            onSchedule({ type: 'assr', id: String(order.assr_id ?? ''), jobKind: order.job_kind, lorryId, lorryPlateOptimistic });
            return;
          }
          setVal(writeSeat(order, { lorryId }, () => setVal(chosen)) ? picked : chosen);
        }}
      />
    </span>
  );
}

/* Helper 1 / Helper 2 — a type-to-search picker. SO + DP(on a trip) write the
   crew seat (delivery_order_crew for an SO, the trip for a DP, both via
   writeSeat); a service-case leg writes the trip crew through the schedule path
   (type:'assr'), like its Driver / Lorry cells (owner 2026-10-29). A DP job with
   no trip yet, and project rows, have no seat — dash / read-only mirror. */
function HelperPickCell({ order, helpers, onSchedule, writeSeat, slot }: {
  order: PlanningOrder; helpers: HelperRow[]; onSchedule: ScheduleMutate; writeSeat: CrewSeatWrite; slot: 1 | 2;
}) {
  const items = useMemo(() => helpers.map((h) => ({ id: h.id, label: h.name })), [helpers]);
  const currentName = (slot === 1 ? order.crew?.helper_1_name : order.crew?.helper_2_name) ?? null;
  const options = useMemo(() => crewComboOptions(items, currentName), [items, currentName]);
  const chosen = useMemo(() => crewComboValue(items, currentName), [items, currentName]);
  const [val, setVal] = useState(chosen);
  const { crew: pending } = useContext(BoardPendingContext);
  useEffect(() => { setVal(chosen); }, [chosen]);
  // Project rows are a read-only PMS mirror — show the helper the project crewed
  // (owner 2026-10-21), like the Driver / Lorry cells.
  if (isProject(order)) return <span style={{ color: 'var(--hz-c-ink-muted)' }}>{currentName || '—'}</span>;
  // A DP job's helper is set on its RUN via useDpCrew (writeSeat below), which puts
  // a trip-less job on a run first — editable with or without a trip (owner 2026-10-31).
  const assrLeg = isAssr(order);
  return (
    <span {...stopRow} style={{ display: 'flex', width: '100%', minWidth: 0 }}>
      <SearchCombo
        fill aria-label={`Helper ${slot}`} placeholder="— pick a helper —"
        options={options}
        value={val}
        disabled={pending}
        onChange={(picked) => {
          if (picked === KEEP_CURRENT) return;
          const helperId = picked || null;
          if (assrLeg) {
            setVal(picked);
            onSchedule({
              type: 'assr', id: String(order.assr_id ?? ''), jobKind: order.job_kind,
              ...(slot === 1 ? { helper1Id: helperId } : { helper2Id: helperId }),
            });
            return;
          }
          const seat = slot === 1 ? { helper1Id: helperId } : { helper2Id: helperId };
          setVal(writeSeat(order, seat, () => setVal(chosen)) ? picked : chosen);
        }}
      />
    </span>
  );
}

const liveBalance = (o: PlanningOrder): number =>
  typeof o.balance_sen_live === 'number' ? o.balance_sen_live : o.balance_sen;

/* The ticked bills added up for the bulk bar (HC-0164, Syu: "see the total
   amount of bill I selected", as a sheet's status bar does). Sales orders only -
   a job row's total is a structural 0, as in the Total Amount column. */
export function selectedBillTotals(
  orders: readonly PlanningOrder[],
  selectedKeys: ReadonlySet<string>,
): { count: number; totalSen: number; balanceSen: number } {
  let count = 0;
  let totalSen = 0;
  let balanceSen = 0;
  for (const o of orders) {
    if (o.row_type !== 'so' || !selectedKeys.has(rowIdOf(o))) continue;
    count += 1;
    totalSen += o.local_total_sen;
    balanceSen += liveBalance(o);
  }
  return { count, totalSen, balanceSen };
}

/* The days_left cell renderer lived here until the owner's 2026-08-04 column
   pass removed that column. It is gone rather than left dangling — the Overdue
   state tab and the delivery_state derivation already act on the same number,
   so nothing lost the signal, only the column. The API still sends days_left. */

type DrillItem = {
  id: string;
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  variants: Record<string, unknown> | null;
  cancelled: boolean | null;
};

const CategoryPill = ({ group }: { group: string | null | undefined }) => {
  const spec = badgeFor(group);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 8px', borderRadius: 999,
      background: spec.bg, color: spec.fg,
      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
      fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      {spec.label}
    </span>
  );
};

const DRILLDOWN_COLUMNS: GridColumn<DrillItem>[] = [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <CategoryPill group={it.item_group} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--hz-c-primary-ink)' }}>{it.item_code ?? '—'}</span>,
    searchValue: (it) => it.item_code ?? '',
    sortFn: (a, b) => (a.item_code ?? '').localeCompare(b.item_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 240, minWidth: 180,
    accessor: (it) => {
      const manual = (it.description ?? '').trim();
      if (manual) return <div>{manual}</div>;
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : '—';
    },
    searchValue: (it) => `${it.description ?? ''} ${buildVariantSummary(it.item_group, it.variants)}`.trim(),
  },
  {
    key: 'description2', label: 'Description 2', width: 220, minWidth: 160,
    accessor: (it) => {
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : <span style={{ color: 'var(--hz-c-ink-muted)' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group, it.variants),
  },
];

const PlanningExpandedLines = ({ docNo }: { docNo: string }) => {
  const q = useDeliveryPlanningLines(docNo);
  if (q.isLoading) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)' }}>
        Loading lines for {docNo}…
      </div>
    );
  }
  if (q.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--hz-dk-festive-b, #b8331f)' }}>
        Failed to load lines: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const allItems = (q.data ?? []) as DrillItem[];
  const items = allItems.filter((it) => !it.cancelled);

  if (items.length === 0) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)' }}>
        No line items.
      </div>
    );
  }

  return (
    <div style={{
      padding: 'var(--space-2) var(--space-3) var(--space-2) 40px',
      background: 'var(--hz-c-surface)',
    }}>
      <DataGridCompat<DrillItem>
        rows={items}
        columns={DRILLDOWN_COLUMNS}
        storageKey="delivery-planning-drilldown-grid.v1"
        rowKey={(it) => it.id}
        embedded
        groupBanner={false}
      />
    </div>
  );
};

type ContextMenuItems = GridContextMenuItem[];

export type DeliveryBoardStateTabs = {
  activeState: string;
  onStateChange: (state: string) => void;
};

export type DeliveryPlanningBoardProps = {
  orders: PlanningOrder[];
  counts: Record<string, number>;
  regionTabs: RegionTab[];
  activeRegion: string;
  onRegionChange: (region: string) => void;
  isLoading?: boolean;
  error?: unknown;

  stateTabs?: DeliveryBoardStateTabs;

  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: (keys: string[], allSelected: boolean) => void;
  onClearSelection: () => void;

  sched: SchedMutation;
  drivers: DriverRow[];
  lorries: LorryRow[];
  msgStatuses?: Record<string, { success: boolean; http_code: number | null; created_at: string }>;

  bulkExtras?: ReactNode;

  onRowDoubleClick?: (order: PlanningOrder) => void;
  contextMenu?: (order: PlanningOrder) => ContextMenuItems;

  /* ── Option B side map (owner 2026-08-08) ─────────────────────────────────
     Single-click row hook (board row → map pin linkage; fires alongside the
     grid's own select/multi-select, changing nothing existing). */
  onRowClick?: (order: PlanningOrder) => void;
  scrollToRow?: { key: string; nonce: number } | null;
  visibleColumnsOverride?: readonly string[] | null;
  onUserAdjustColumns?: () => void;

  storageKey?: string;
  exportName?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  layoutPresets?: LayoutSeed[];
  onApplyLayoutPreset?: (presetId: string) => void;
  initialRowLimit?: number;
  /* Drag-to-reorder the board rows (owner 2026-09-26): called with the new order
     of the displayed rows. Passed only by the main Delivery Planning page, whose
     `defaultSort` reads the same persisted order back. */
  onRowReorder?: (orderedKeys: string[]) => void;

  /* Default ordering while NO column sort is active — forwarded to the
     DataGrid. The two arrangement queues pass arrangementQueueCompare
     (lib/arrangement-sort.ts: delivery date OLDEST first, then state, then
     postcode — owner 2026-08-07 "跟着 delivery date、state、postcode 去排").
     A clicked header still overrides as always. Omitted (the main Delivery
     Planning board), the rows render in the server's order exactly as before. */
  defaultSort?: (a: PlanningOrder, b: PlanningOrder) => number;
  /* The host page's own view state (state tab, region chip) behind the toolbar
     "Reset layout" button, which the grid shows whenever a funnel, the search
     box or this is active (owner 2026-10-05: same button as Sales Orders). */
  resetFilters?: { active: boolean; onReset: () => void };
};

export const soDocNosFromSelection = (selectedKeys: Set<string>): string[] =>
  [...selectedKeys].filter((k) => k.startsWith('so:')).map((k) => k.slice(3));

export function DeliveryPlanningBoard({
  orders,
  counts,
  regionTabs,
  activeRegion,
  onRegionChange,
  isLoading,
  error,
  stateTabs,
  selectedKeys,
  onToggle,
  onToggleAll,
  onClearSelection,
  sched,
  drivers,
  lorries,
  msgStatuses,
  bulkExtras,
  onRowDoubleClick,
  contextMenu,
  onRowClick,
  scrollToRow,
  visibleColumnsOverride,
  onUserAdjustColumns,
  storageKey = 'dg-delivery-planning-v2',
  exportName = 'DeliveryPlanning',
  searchPlaceholder = 'Search SO / ref / customer / phone…',
  emptyMessage = 'No orders need delivering in this view.',
  defaultSort,
  layoutPresets,
  onApplyLayoutPreset,
  initialRowLimit,
  onRowReorder,
  resetFilters,
}: DeliveryPlanningBoardProps) {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  /* Writes the customer-message workflow status (delivery_message_status) from
     the "Delivery Status" column's inline select (owner 2026-09-22). */
  const updateFields = useUpdateDeliveryFields();
  const assignCrew = useAssignDoCrew();
  const updateTrip = useUpdateTrip();
  const dpCrew = useDpCrew();
  const helpers = useHelpers().data ?? [];
  const amendReasonOptions = useAmendReasonOptions();
  const localities = useLocalities().data;
  const pcIndex = useMemo(() => postcodeIndex(localities ?? []), [localities]);

  const schedRef = useRef(sched); schedRef.current = sched;
  const updateFieldsRef = useRef(updateFields); updateFieldsRef.current = updateFields;
  const assignCrewRef = useRef(assignCrew); assignCrewRef.current = assignCrew;
  const updateTripRef = useRef(updateTrip); updateTripRef.current = updateTrip;
  const dpCrewRef = useRef(dpCrew); dpCrewRef.current = dpCrew;
  const notifyRef = useRef(notify); notifyRef.current = notify;
  const scheduleMutate = useCallback<ScheduleMutate>((...args) => schedRef.current.mutate(...args), []);
  const updateFieldsMutate = useCallback<UpdateFieldsMutate>((...args) => updateFieldsRef.current.mutate(...args), []);

  const writeCrewSeat = useCallback<CrewSeatWrite>((order, seat, onFail) => {
    /* A DP job has no DO: its crew IS its RUN's crew. The endpoint puts a trip-less
       job on a run first (owner 2026-10-31), so the cell writes with or without a
       trip — no "Schedule…" drawer. A DP run has one driver, so driver2Id is n/a. */
    if (isDp(order)) {
      dpCrewRef.current.mutate({
        id: dpIdOf(order),
        ...(seat.driver1Id !== undefined ? { driverId: seat.driver1Id } : {}),
        ...(seat.lorryId !== undefined ? { lorryId: seat.lorryId } : {}),
        ...(seat.helper1Id !== undefined ? { helper1Id: seat.helper1Id } : {}),
        ...(seat.helper2Id !== undefined ? { helper2Id: seat.helper2Id } : {}),
      }, {
        onSuccess: (res) => { if (res.tripStop.failed) void notifyRef.current({ title: 'Crew saved', body: `The crew saved but the job was NOT attached to its run: ${res.tripStop.reason ?? 'unknown error'}.`, tone: 'error' }); },
        onError: (e) => crewSaveFailed(notifyRef.current, onFail, e),
      });
      return true;
    }
    const doId = latestDoId(order.delivery_orders);
    if (!doId) {
      void notifyRef.current({ title: 'Create a delivery order first', body: 'This order has no delivery order yet, so crew cannot be saved. Create a DO first.' });
      return false;
    }
    assignCrewRef.current.mutate({ doId, ...seat }, { onError: (e) => crewSaveFailed(notifyRef.current, onFail, e) });
    return true;
  }, []);
  /* HC-0191 Copy / Paste crew: copy the one ticked row's lorry + driver(s) + helper(s),
     then tick the other bills and paste. Each target is written through the same
     paths as its own inline pick (writeCrewSeat / the schedule write), so the
     permission checks and audit are those of a normal edit. */
  const [copiedCrew, setCopiedCrew] = useState<{ seats: CrewSeats; fromKey: string; label: string } | null>(null);
  const copyCrew = () => {
    const src = orders.find((o) => selectedKeys.has(rowIdOf(o)));
    if (!src || selectedKeys.size !== 1 || isProject(src)) return;
    const { seats, unresolved } = crewToCopy(src, drivers, lorries, helpers);
    if (Object.keys(seats).length === 0) {
      void notify({ title: 'Nothing to copy', body: unresolved.length ? `${unresolved.join(', ')} could not be matched to the driver / lorry / helper lists.` : 'This row has no lorry, driver or helper yet.' });
      return;
    }
    const label = [src.crew?.lorry_plate, src.crew?.driver_1_name].filter(Boolean).join(' · ');
    setCopiedCrew({ seats, fromKey: rowIdOf(src), label });
    if (unresolved.length) void notify({ title: 'Copied (partly)', body: `${unresolved.join(', ')} could not be matched to the driver / lorry / helper lists and will not be pasted.` });
  };
  const pasteCrew = async () => {
    if (!copiedCrew) return;
    const targets = orders.filter((o) => selectedKeys.has(rowIdOf(o)) && rowIdOf(o) !== copiedCrew.fromKey && !isProject(o));
    if (targets.length === 0) return;
    const ok = await askConfirm({
      title: `Paste crew onto ${targets.length} row${targets.length === 1 ? '' : 's'}?`,
      body: `${copiedCrew.label || 'The copied crew'} replaces the lorry, driver and helper on the ticked rows.`,
      confirmLabel: 'Paste crew',
    });
    if (!ok) return;
    let noDo = 0;
    for (const o of targets) {
      const seats = seatsForTarget(copiedCrew.seats, o);
      if (isAssr(o)) {
        scheduleMutate({
          type: 'assr', id: String(o.assr_id ?? ''), jobKind: o.job_kind,
          ...(seats.driver1Id ? { driverId: seats.driver1Id } : {}), ...(seats.lorryId ? { lorryId: seats.lorryId } : {}),
          ...(seats.helper1Id ? { helper1Id: seats.helper1Id } : {}), ...(seats.helper2Id ? { helper2Id: seats.helper2Id } : {}),
        });
      } else if (!isDp(o) && !latestDoId(o.delivery_orders)) {
        noDo += 1;
      } else {
        writeCrewSeat(o, seats);
      }
    }
    if (noDo > 0) void notify({ title: 'Some rows skipped', body: `${noDo} row${noDo === 1 ? ' has' : 's have'} no delivery order yet, so crew cannot be saved there. Create the DO first, then paste again.` });
  };
  const crewPending = assignCrew.isPending || sched.isPending || updateTrip.isPending || dpCrew.isPending;
  const boardPending = useMemo<BoardPending>(
    () => ({ fields: updateFields.isPending, sched: sched.isPending, crew: crewPending }),
    [updateFields.isPending, sched.isPending, crewPending],
  );
  /* Manual colour marks (owner 2026-09-26): a Map<rowKey, colour token>, painted
     from the row context menu on the main page and tinted onto the row below. */
  const rowMarks = useDeliveryRowMarks().data;
  const bulkSetMark = useBulkSetRowMark();
  const bulkClearMark = useBulkClearRowMark();
  const markBusy = bulkSetMark.isPending || bulkClearMark.isPending;

  const isEmSg = activeRegion === 'EM' || activeRegion === 'SG';

  const activeState = stateTabs?.activeState ?? 'ALL';
  const rows = useMemo<PlanningOrder[]>(
    () => (!stateTabs || activeState === 'ALL' ? orders : orders.filter((o) => o.delivery_state === activeState)),
    [orders, stateTabs, activeState],
  );

  const selectedSoDocNos = (): string[] => soDocNosFromSelection(selectedKeys);
  const selectedTotals = useMemo(() => selectedBillTotals(orders, selectedKeys), [orders, selectedKeys]);

  /* ── Pending Schedule sub-split (owner pipeline, 2026-08-07) ────────────────
     Counts of the DERIVED arrangement stages across the Pending Schedule rows in
     view — shown as a muted line under the tab rail while that tab is active.
     Read off the server-stamped `arrangement_stage` (never re-derived);
     dateArrangementOf folds PENDING_TIME + TIME_ARRANGED into "Date arranged". */
  const pendingSplit = useMemo(() => {
    const split = { PENDING_DATE: 0, DATE_ARRANGED: 0, PENDING_TIME: 0, TIME_ARRANGED: 0 };
    for (const o of orders) {
      if (o.delivery_state !== 'PENDING_SCHEDULE') continue;
      const side = dateArrangementOf(o);
      if (side == null) continue;
      split[side] += 1;
      if (o.arrangement_stage === 'PENDING_TIME') split.PENDING_TIME += 1;
      else if (o.arrangement_stage === 'TIME_ARRANGED') split.TIME_ARRANGED += 1;
    }
    return split;
  }, [orders]);

  const columns = useMemo<GridColumn<PlanningOrder>[]>(() => {
    /* The DEFAULT header order (owner 2026-07-22 header tidy): identity →
       status → dates → fleet → documents → money, with every default-hidden
       HC / crew-detail column grouped after, so the Columns drawer reads in
       the same logical blocks. The array below stays grouped by DATA SOURCE
       (easier to maintain against the API shape); this list is what pristine
       layouts actually show. A user's saved layout.order still wins. A key
       missing here falls to the end in definition order. */
    const DP_DEFAULT_ORDER = [
      /* Owner's column pass, 2026-09-22 — he reordered the columns by hand in an
         Excel and set each Show Y/N. This array is the pristine ORDER; a column's
         own defaultHidden is what hides it, and a user's saved layout.order still
         wins. A key missing here falls to the end in definition order. */
      'delivery_message_status',
      'row_type', 'company_code', 'so_doc_no', 'do', 'so_date', 'so_ref', 'branding',
      'debtor_name', 'phone', 'venue', 'salesperson',
      'total_amount', 'balance_sen', 'stock_remark',
      'processing_date', 'customer_delivery_date', 'amended_delivery_date',
      'amend_date_from_customer', 'amend_reason_from_customer', 'amend_reason', 'time_confirmed',
      'house_type', 'replacement_disposal', 'disposal_request',
      'po_nos', 'address', 'postcode', 'region',
      'warehouse', 'time_range', 'departure_at', 'arrival_at',
      'eta_arriving_port', 'arrives_em_warehouse_date',
      // EM transport status (owner 2026-09-23) — the two 3PL legs, same
      // cross-border block (default-show only on the EM / SG tabs).
      'em_delivery_status', 'consignment_no', 'vessel_voyage', 'etd_port_klang',
      'bs_delivery_date', 'esb_remarks', 'bs_remarks', 'ctn',
      'trip_no', 'lorry', 'driver', 'driver_ic', 'driver_contact', 'driver_2', 'helper_1', 'helper_2',
      'dp_remark', 'do_date', 'delivered_at',
      'wa_message', 'pod', 'delivery_substatus',
    ];
    const pos = new Map(DP_DEFAULT_ORDER.map((k, i) => [k, i] as const));
    const cols: GridColumn<PlanningOrder>[] = [
    {
      key: 'row_type', label: 'Job Type', width: 130, groupable: true,
      accessor: (o) => <TypeChip order={o} />,
      searchValue: (o) => (isDp(o) || isProject(o) ? dpLabel(o)
        : isAssr(o) ? `${assrJobKindLabel(o.job_kind)} ${o.job_kind === 'customer_pickup' ? 'cust. pickup customer pickup' : o.job_kind === 'delivery' ? 'delivery' : ''}`.trim()
        : 'SO delivery'),
      groupValue: (o) => (isDp(o) || isProject(o) ? dpLabel(o) : isAssr(o) ? assrJobKindLabel(o.job_kind) : 'SO delivery'),
      exportValue: (o) => (isDp(o) || isProject(o) ? dpLabel(o) : isAssr(o) ? assrJobKindLabel(o.job_kind) : 'SO delivery'),
    },
    {
      key: 'so_doc_no', label: 'SO No.', width: 150, sortable: true,
      accessor: (o) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', ...DOCNO_STYLE }}>
          {isDp(o) ? (o.dp_no ?? '— not scheduled') : isAssr(o) ? (o.ref ?? '—') : o.so_doc_no}
        </span>
      ),
      searchValue: (o) => (isAssr(o) ? (o.ref ?? '') : o.so_doc_no),
      exportValue: (o) => (isAssr(o) ? (o.ref ?? '') : o.so_doc_no),
      sortFn: (a, b) => (isAssr(a) ? (a.ref ?? '') : a.so_doc_no).localeCompare(isAssr(b) ? (b.ref ?? '') : b.so_doc_no),
    },
    {
      key: 'company_code', label: 'Company', width: 90, groupable: true, defaultHidden: true,
      accessor: (o) => <CompanyBadge code={o.company_code ?? null} />,
      searchValue: (o) => o.company_code ?? '',
      groupValue: (o) => o.company_code ?? '(none)',
      exportValue: (o) => o.company_code ?? '',
    },
    {
      key: 'debtor_name', label: 'Customer Name', width: 200, sortable: true, groupable: true,
      accessor: (o) => strong(o.debtor_name ?? o.debtor_code ?? '—'),
      searchValue: (o) => `${o.debtor_name ?? ''} ${o.debtor_code ?? ''}`.trim(),
      groupValue: (o) => o.debtor_name ?? o.debtor_code ?? '(none)',
      exportValue: (o) => o.debtor_name ?? o.debtor_code ?? '',
      sortFn: (a, b) => (a.debtor_name ?? '').localeCompare(b.debtor_name ?? ''),
    },
    {
      /* Who SOLD the order (owner 2026-08-19) — same roster-resolved name the
         SO list shows (never a raw UUID). SO rows only; n/a on job rows. */
      key: 'salesperson', label: 'Salesperson', width: 150, sortable: true, groupable: true,
      accessor: (o) => (o.row_type !== 'so' ? <NotApplicable /> : detail(salespersonNameOf(o.agent, o.salesperson_id, '—'))),
      searchValue: (o) => (o.row_type !== 'so' ? '' : salespersonNameOf(o.agent, o.salesperson_id, '')),
      groupValue: (o) => (o.row_type !== 'so' ? '(n/a)' : salespersonNameOf(o.agent, o.salesperson_id, '(none)')),
      exportValue: (o) => (o.row_type !== 'so' ? '' : salespersonNameOf(o.agent, o.salesperson_id, '')),
      sortFn: (a, b) => salespersonNameOf(a.agent, a.salesperson_id, '').localeCompare(salespersonNameOf(b.agent, b.salesperson_id, '')),
    },
    {
      /* Where it was SOLD (owner 2026-08-19) — the SO's sales venue; PMS
         project rows carry their event venue. */
      key: 'venue', label: 'Venue', width: 160, groupable: true, defaultHidden: true,
      accessor: (o) => detail(o.venue?.trim() || '—'),
      searchValue: (o) => o.venue ?? '',
      groupValue: (o) => o.venue?.trim() || '(none)',
      exportValue: (o) => o.venue ?? '',
    },
    {
      key: 'phone', label: 'Phone', width: 150,
      accessor: (o) => detail(formatPhone(o.phone) || '—'),
      searchValue: (o) => o.phone ?? '',
      exportValue: (o) => formatPhone(o.phone) || '',
    },
    {
      key: 'wa_message', label: 'Send Status', width: 130,
      accessor: (o) => {
        if (o.row_type !== 'so' && o.row_type !== 'assr') return '—';
        const s = msgStatuses?.[o.so_doc_no];
        // Default "Done All" (owner 2026-09-22): no send needed, or the last send
        // was OK. Only a FAILED latest send shows a problem.
        const failed = s ? !s.success : false;
        return (
          <span style={{ fontWeight: 600, color: failed ? '#b3261e' : '#2e7d32' }}>
            {failed ? 'Failed' : 'Done All'}
          </span>
        );
      },
      searchValue: (o) => {
        if (o.row_type !== 'so' && o.row_type !== 'assr') return '';
        const s = msgStatuses?.[o.so_doc_no];
        return s && !s.success ? 'Failed' : 'Done All';
      },
      exportValue: (o) => {
        if (o.row_type !== 'so' && o.row_type !== 'assr') return '';
        const s = msgStatuses?.[o.so_doc_no];
        return s && !s.success ? 'Failed' : 'Done All';
      },
    },
    {
      key: 'pod', label: 'POD', width: 110, groupable: true,
      accessor: (o) => <PodCell o={o} />,
      groupValue: (o) => (o.row_type !== 'so' ? '(n/a)' : o.has_pod ? 'POD' : o.delivery_state === 'DELIVERED' ? 'No POD' : '—'),
      searchValue: (o) => (o.has_pod ? 'POD proof of delivery' : o.delivery_state === 'DELIVERED' ? 'No POD' : ''),
      exportValue: (o) => (o.has_pod ? 'POD' : o.delivery_state === 'DELIVERED' ? 'No POD' : ''),
    },
    {
      key: 'delivered_at', label: 'Delivered At', width: 150, sortable: true, defaultHidden: true,
      accessor: (o) => (o.row_type !== 'so' ? <NotApplicable /> : detail(dtOrDash(o.delivered_at ?? null))),
      searchValue: (o) => o.delivered_at ?? '',
      exportValue: (o) => (o.delivered_at ? fmtDateTime(o.delivered_at) : ''),
      sortFn: (a, b) => String(a.delivered_at ?? '').localeCompare(String(b.delivered_at ?? '')),
    },
    {
      /* Default-SHOWN again per the owner's 2026-09-22 column pass (it had been
         hidden since the 2026-07-22 header tidy). */
      key: 'branding', label: 'Branding', width: 130, groupable: true,
      accessor: (o) => detail(o.branding ?? '—'),
      searchValue: (o) => o.branding ?? '',
      groupValue: (o) => o.branding ?? '(none)',
      exportValue: (o) => o.branding ?? '',
    },
    /* Address + postcode default-SHOW since the owner's 2026-08-04 column pass:
       where the lorry is going is a planning question, not a detail lookup. */
    {
      key: 'address', label: 'Address', width: 220,
      accessor: (o) => detail(o.address ?? '—'),
      searchValue: (o) => o.address ?? '',
      exportValue: (o) => o.address ?? '',
    },
    {
      key: 'postcode', label: 'Postcode', width: 100,
      // HC-0196: the area name beside the number, from the localities table.
      accessor: (o) => detail(o.postcode ? postcodeLabel(pcIndex, o.postcode, o.customer_state) : '—'),
      searchValue: (o) => (o.postcode ? postcodeLabel(pcIndex, o.postcode, o.customer_state) : ''),
      exportValue: (o) => (o.postcode ? postcodeLabel(pcIndex, o.postcode, o.customer_state) : ''),
    },
    /* `building_type` ("Property") was REMOVED in the owner's 2026-08-04 column
       pass, and `house_type` took over its NAME — one "Building Type" column
       instead of two that nobody could tell apart. The API still sends
       building_type and PlanningOrder still types it; only this board stopped
       showing it. `possession_date` went the same way: it answers a sales
       question, not a dispatch one. `referral` went too, and came back on
       2026-09-15 as "Reference" — below. */
    {
      key: 'house_type', label: 'Building Type', width: 130, groupable: true,
      accessor: (o) => o.house_type ?? '—',
      searchValue: (o) => o.house_type ?? '',
      groupValue: (o) => o.house_type ?? '(none)',
      exportValue: (o) => o.house_type ?? '',
    },
    {
      key: 'replacement_disposal', label: 'New House / Replacement', width: 180,
      accessor: (o) => o.replacement_disposal ?? '—',
      searchValue: (o) => o.replacement_disposal ?? '',
      exportValue: (o) => o.replacement_disposal ?? '',
    },
    {
      /* Reference — the order's own reference, `mfg_sales_orders.ref` (AutoCount
         Ref, e.g. pg0791 on HC-SO-004574; the delivery sheet's Ref column).
         Owner 2026-09-15 ("delivery planning 没有 reference number 选项"). First
         shipped reading `referral` (#3961) — the HC referral CHANNEL, empty on
         every order — so the column was blank; docs/bugs/0934. Default-HIDDEN:
         it lives in the Columns panel, not the default view. SO rows only. */
      key: 'so_ref', label: 'Ref No.', width: 140, groupable: true,
      accessor: (o) => o.so_ref ?? '—',
      searchValue: (o) => o.so_ref ?? '',
      groupValue: (o) => o.so_ref ?? '(none)',
      exportValue: (o) => o.so_ref ?? '',
    },
    {
      key: 'region', label: 'State', width: 140, sortable: true, groupable: true,
      accessor: (o) => detail(o.customer_state?.trim() || '—'),
      searchValue: (o) => o.customer_state ?? '',
      groupValue: (o) => o.customer_state?.trim() || '(none)',
      exportValue: (o) => o.customer_state ?? '',
      sortFn: (a, b) => (a.customer_state ?? '').localeCompare(b.customer_state ?? ''),
    },
    {
      key: 'warehouse', label: 'Warehouse', width: 150, sortable: true, groupable: true, defaultHidden: true,
      accessor: (o) => o.warehouse_code ?? '—',
      searchValue: (o) => `${o.warehouse_code ?? ''} ${o.warehouse_name ?? ''}`.trim(),
      groupValue: (o) => o.warehouse_code ?? '(none)',
      exportValue: (o) => o.warehouse_code ?? '',
    },
    {
      key: 'so_date', label: 'SO Date', width: 120, sortable: true,
      accessor: (o) => detail(fmtDateOrDash(o.so_date)),
      searchValue: (o) => o.so_date ?? '',
      exportValue: (o) => (o.so_date ? fmtDate(o.so_date) : ''),      sortFn: (a, b) => String(a.so_date ?? '').localeCompare(String(b.so_date ?? '')),
      filterType: 'date', dateValue: (o) => o.so_date,
    },
    {
      /* Processing Date (owner 2026-08-19) — the internal expected delivery
         date (mfg_sales_orders.processing_date), the SAME field + name the SO
         list shows. Was on this board as "Internal Est." until the 2026-08-04
         column pass removed it; back by request. SO rows ONLY: the synthetic
         job rows mirror their leg date into the payload field for the
         effective-date fallback, but a job has no processing date, so the
         column must not dress that mirror up as one (delivery-tms.md §"
         processing_date is the SALES ORDER's Processing Date and nothing
         else"). */
      key: 'processing_date', label: 'Processing Date', width: 140, sortable: true,
      accessor: (o) => (o.row_type !== 'so' ? <NotApplicable /> : detail(fmtDateOrDash(o.processing_date))),
      searchValue: (o) => (o.row_type !== 'so' ? '' : (o.processing_date ?? '')),
      exportValue: (o) => (o.row_type !== 'so' || !o.processing_date ? '' : fmtDate(o.processing_date)),      sortFn: (a, b) => String(a.row_type === 'so' ? a.processing_date ?? '' : '').localeCompare(String(b.row_type === 'so' ? b.processing_date ?? '' : '')),
      filterType: 'date', dateValue: (o) => (o.row_type !== 'so' ? null : o.processing_date),
    },
    {
      /* BUG-51 repoint (owner 2026-10-15): the REAL AutoCount sales-exemption
         expiry, not the customer delivery date. SO rows only; blank off-book.
         EXCEPT ASSR rows (owner 2026-10-22): a service case has no AutoCount book,
         so its own SERVICE date shows here (sxeDateOf), and its "Delivery Date"
         column is left blank for admin to propose. DP / project rows stay blank.
         Grid key kept as customer_delivery_date so saved layouts keep the column. */
      key: 'customer_delivery_date', label: 'Sales Exemption Expiry Date', width: 170, sortable: true,
      accessor: (o) => detail(fmtDateOrDash(sxeDateOf(o))),
      searchValue: (o) => sxeDateOf(o) ?? '',
      exportValue: (o) => { const d = sxeDateOf(o); return d ? fmtDate(d) : ''; },      sortFn: (a, b) => String(sxeDateOf(a) ?? '').localeCompare(String(sxeDateOf(b) ?? '')),
      filterType: 'date', dateValue: (o) => sxeDateOf(o),
    },
    {
      key: 'amended_delivery_date', label: 'Delivery Date', width: 170, sortable: true, groupable: true,
      accessor: (o) => <DeliveryDateEditCell order={o} onSchedule={scheduleMutate} />,
      searchValue: (o) => o.amended_delivery_date ?? '',
      exportValue: (o) => (o.amended_delivery_date ? fmtDate(o.amended_delivery_date) : ''),      /* Group by the DAY (owner 2026-10-24: day/month toggle = group by this
         column for by-day, or "Delivery Month" for by-month). Formatted YYYY/MM/DD
         so the header reads in the app's date order; no date -> "No date" (sorts
         last, N > digits). */
      groupValue: (o) => (o.amended_delivery_date ? fmtDate(o.amended_delivery_date) : 'No date'),
      sortFn: (a, b) => String(a.amended_delivery_date ?? '').localeCompare(String(b.amended_delivery_date ?? '')),
      filterType: 'date', dateValue: (o) => o.amended_delivery_date,
    },
    {
      /* Derived month of the EFFECTIVE delivery date (amended ?? original). The
         BY-MONTH half of the owner's day/month grouping (2026-10-24): he groups by
         this column for by-month, or by "Delivery Date" above for by-day. Default-
         HIDDEN; it exists for grouping, not as a day-to-day column. The group value
         is the display label "2026/10" (digits in the app's date order — a month
         NAME is forbidden app-wide; see vendor/shared/format.ts) or "No date",
         which sorts/buckets last (N > digits). */
      key: 'delivery_month', label: 'Delivery Month', width: 130, groupable: true, defaultHidden: true,
      accessor: (o) => detail(deliveryMonthLabel(deliveryMonthKey(o))),
      searchValue: (o) => deliveryMonthLabel(deliveryMonthKey(o)),
      groupValue: (o) => deliveryMonthLabel(deliveryMonthKey(o)),
      exportValue: (o) => deliveryMonthLabel(deliveryMonthKey(o)),
    },
    {
      key: 'amend_date_from_customer', label: 'Customer Request Date', width: 140, sortable: true,
      accessor: (o) => detail(fmtDateOrDash(o.amend_date_from_customer)),
      searchValue: (o) => o.amend_date_from_customer ?? '',
      exportValue: (o) => (o.amend_date_from_customer ? fmtDate(o.amend_date_from_customer) : ''),      sortFn: (a, b) => String(a.amend_date_from_customer ?? '').localeCompare(String(b.amend_date_from_customer ?? '')),
      filterType: 'date', dateValue: (o) => o.amend_date_from_customer,
    },
    {
      key: 'amend_reason_from_customer', label: 'Customer Amend Reason', width: 170,
      accessor: (o) => detail(o.amend_reason_from_customer || '—'),
      searchValue: (o) => o.amend_reason_from_customer ?? '',
      exportValue: (o) => o.amend_reason_from_customer ?? '',
    },
    {
      key: 'amend_reason', label: 'Amend Reason', width: 220,
      accessor: (o) => <AmendReasonEditCell order={o} onUpdateFields={updateFieldsMutate} options={amendReasonOptions} />,
      searchValue: (o) => o.amend_reason ?? '',
      exportValue: (o) => o.amend_reason ?? '',
    },
    {
      key: 'disposal_request', label: 'Disposal Request', width: 180,
      accessor: (o) => <TextEditCell order={o} value={o.disposal_request} onCommit={(v) => updateFieldsMutate({ type: 'so', id: o.so_doc_no, disposalRequest: v }, { onError: fieldNotSaved })} placeholder="Disposal…" />,
      searchValue: (o) => o.disposal_request ?? '',
      exportValue: (o) => o.disposal_request ?? '',
    },
    {
      key: 'dp_remark', label: 'Remarks', width: 200, defaultHidden: true,
      accessor: (o) => (
        <TextEditCell order={o} value={o.dp_remark} placeholder="Remarks…" allowNonSo allowProject={!o.remark_locked}
          onCommit={(v) => updateFieldsMutate(
            isDp(o) ? { type: 'dp', id: dpIdOf(o), dpRemark: v }
              : isAssr(o) ? { type: 'assr', id: String(o.assr_id ?? ''), jobKind: o.job_kind ?? undefined, dpRemark: v }
              : isProject(o) ? { type: 'project', id: projectIdOf(o), dpRemark: v }
              : { type: 'so', id: o.so_doc_no, dpRemark: v },
            { onError: fieldNotSaved },
          )} />
      ),
      searchValue: (o) => o.dp_remark ?? '',
      exportValue: (o) => o.dp_remark ?? '',
    },
    {
      key: 'stock_remark', label: 'Stock', width: 170, groupable: true,
      accessor: (o) => (isAssr(o) || isDp(o) ? <NotApplicable /> : (
        <StockRemarkPill remark={o.stock_remark || o.stock_status} />
      )),
      searchValue: (o) => (isAssr(o) || isDp(o) ? '' : `${o.stock_remark} ${o.stock_status}`.trim()),
      sortFn: (a, b) => stockRemarkSortFn(a.stock_remark || a.stock_status, b.stock_remark || b.stock_status),
      groupValue: (o) => (isAssr(o) || isDp(o) ? '(n/a)' : o.stock_status),
      exportValue: (o) => (isAssr(o) || isDp(o) ? '' : (o.stock_remark || o.stock_status || '')),
    },
    {
      /* "Delivery Status" (owner 2026-09-22) = the customer-message follow-up
         workflow status (delivery_message_status): one of the 23 values or blank,
         inline-editable. The coarse scm.delivery_state that drives the top state
         tabs is the separate, default-hidden column below. */
      key: 'delivery_message_status', label: 'Delivery Message Status', width: 220, sortable: true, groupable: true,
      accessor: (o) => <MessageStatusEditCell order={o} onUpdateFields={updateFieldsMutate} />,
      searchValue: (o) => o.delivery_message_status ?? '',
      groupValue: (o) => o.delivery_message_status ?? '(none)',
      exportValue: (o) => o.delivery_message_status ?? '',
      sortFn: (a, b) => (a.delivery_message_status ?? '').localeCompare(b.delivery_message_status ?? ''),
    },
    {
      // Service-case per-leg "Mark Delivered" (owner 2026-11-06); ASSR legs only.
      key: 'assr_delivered', label: 'Delivered', width: 130, groupable: true,
      accessor: (o) => <MarkDeliveredCell order={o} onSchedule={scheduleMutate} />,
      searchValue: (o) => (isAssr(o) ? (o.delivery_state === 'DELIVERED' ? 'delivered done' : 'pending') : ''),
      groupValue: (o) => (!isAssr(o) ? '(n/a)' : o.delivery_state === 'DELIVERED' ? 'Delivered' : 'Pending'),
      exportValue: (o) => (isAssr(o) && o.delivery_state === 'DELIVERED' ? 'Delivered' : ''),
    },
    /* delivery_state (coarse Pending/Schedule/Overdue/Delivered) and
       arrangement_stage (its Pending-Schedule sub-state) are no longer board
       columns (owner 2026-09-24) — both are still derived server-side and drive
       the top state tabs; the manual state override lives on the bulk "Status"
       action. */
    {
      key: 'trip_no', label: 'Trip No.', width: 130, groupable: true, defaultHidden: true,
      accessor: (o) => (o.trip_no
        ? <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{o.trip_no}</span>
        : <NotApplicable />),
      searchValue: (o) => o.trip_no ?? '',
      groupValue: (o) => o.trip_no ?? '(no trip)',
      exportValue: (o) => o.trip_no ?? '',
    },
    /* HC DO-execution raw-data fields (migration 0197) — all default-HIDE since
       the owner's 2026-08-04 column pass (delivery_substatus joined them; the
       delivered date was removed outright). The cross-border ones (shipout_date,
       eta_arriving_port, arrives_em_warehouse_date) still default-SHOW when the
       active region is EM/SG. */
    {
      key: 'delivery_substatus', label: 'Remark 4', width: 150, groupable: true, defaultHidden: true,
      accessor: (o) => <SubstatusPill value={o.delivery_substatus} />,
      searchValue: (o) => o.delivery_substatus ?? '',
      groupValue: (o) => o.delivery_substatus ?? '(none)',
      exportValue: (o) => o.delivery_substatus ?? '',
    },
    {
      key: 'time_range', label: 'Time Slot', width: 130, sortable: true, defaultHidden: true,
      sortFn: compareByDeliverySlot,
      /* Inline free-text (owner 2026-09-26: 可以输入文本). SO rows write the DO's
         time_range via useUpdateDeliveryFields (no DO yet → the server saves
         nothing and returns no_do_hint, which we surface); a DP row (owner
         2026-10-31) writes scm.dp_orders.time_range the same way, no DO needed; a
         service-case leg (HC-0194) writes its own per-leg column on the case. */
      accessor: (o) => (
        <TextEditCell order={o} value={o.time_range} placeholder="e.g. 2-4pm" allowNonSo
          onCommit={(v) => updateFieldsMutate(
            isDp(o) ? { type: 'dp', id: dpIdOf(o), timeRange: v }
              : isAssr(o) ? { type: 'assr', id: String(o.assr_id ?? ''), jobKind: o.job_kind ?? undefined, timeRange: v }
              : { type: 'so', id: o.so_doc_no, timeRange: v },
            { onSuccess: (res) => { if (res.no_do_hint) void notifyRef.current({ title: 'Saved (partly)', body: res.no_do_hint }); }, onError: fieldNotSaved },
          )} />
      ),
      searchValue: (o) => o.time_range ?? '',
      exportValue: (o) => o.time_range ?? '',
    },
    {
      key: 'time_confirmed', label: 'Time Confirmed', width: 130, align: 'right', defaultHidden: true,
      accessor: (o) => (o.time_confirmed == null ? '—' : o.time_confirmed ? 'Yes' : 'No'),
      searchValue: (o) => (o.time_confirmed == null ? '' : o.time_confirmed ? 'Yes' : 'No'),
      exportValue: (o) => (o.time_confirmed == null ? '' : o.time_confirmed ? 'Yes' : 'No'),
    },
    {
      key: 'arrival_at', label: 'Arrived At', width: 150, sortable: true, defaultHidden: true,
      accessor: (o) => dtOrDash(o.arrival_at),
      searchValue: (o) => o.arrival_at ?? '',
      exportValue: (o) => (o.arrival_at ? fmtDateTime(o.arrival_at) : ''),
      sortFn: (a, b) => String(a.arrival_at ?? '').localeCompare(String(b.arrival_at ?? '')),
    },
    {
      key: 'departure_at', label: 'Departed At', width: 150, sortable: true, defaultHidden: true,
      accessor: (o) => dtOrDash(o.departure_at),
      searchValue: (o) => o.departure_at ?? '',
      exportValue: (o) => (o.departure_at ? fmtDateTime(o.departure_at) : ''),
      sortFn: (a, b) => String(a.departure_at ?? '').localeCompare(String(b.departure_at ?? '')),
    },
    /* "Ship-out Date" column removed (owner 2026-11-20): the DO / delivery date
       already carries the ship-out day, so a separate column was redundant. The
       shipout_date field still exists on the DO and in the fields drawer. */
    {
      key: 'eta_arriving_port', label: 'ETA Port', width: 150, defaultHidden: !isEmSg,
      accessor: (o) => o.eta_arriving_port ?? '—',
      searchValue: (o) => o.eta_arriving_port ?? '',
      exportValue: (o) => o.eta_arriving_port ?? '',
    },
    {
      key: 'arrives_em_warehouse_date', label: 'Arrives EM Warehouse', width: 150, sortable: true, defaultHidden: !isEmSg,
      accessor: (o) => detail(fmtDateOrDash(o.arrives_em_warehouse_date)),
      searchValue: (o) => o.arrives_em_warehouse_date ?? '',
      exportValue: (o) => (o.arrives_em_warehouse_date ? fmtDate(o.arrives_em_warehouse_date) : ''),      sortFn: (a, b) => String(a.arrives_em_warehouse_date ?? '').localeCompare(String(b.arrives_em_warehouse_date ?? '')),
      filterType: 'date', dateValue: (o) => o.arrives_em_warehouse_date,
    },
    /* EM cross-border transport (owner 2026-09-23) — the two 3PL legs (ESB
       sea-freight + BS last-mile), edited in the "Edit HC fields" drawer and
       read-only here. Auto-SHOW on the EM / SG region tabs (defaultHidden:
       !isEmSg), like shipout / ETA / arrives-warehouse. Costs are phase 2. */
    {
      key: 'em_delivery_status', label: 'EM Delivery Status', width: 170, groupable: true, defaultHidden: !isEmSg,
      accessor: (o) => o.em_delivery_status ?? '—',
      searchValue: (o) => o.em_delivery_status ?? '',
      exportValue: (o) => o.em_delivery_status ?? '',
    },
    {
      key: 'consignment_no', label: 'Consignment No', width: 150, defaultHidden: !isEmSg,
      accessor: (o) => o.consignment_no ?? '—',
      searchValue: (o) => o.consignment_no ?? '',
      exportValue: (o) => o.consignment_no ?? '',
    },
    {
      key: 'vessel_voyage', label: 'Vessel & Voyage', width: 170, defaultHidden: !isEmSg,
      accessor: (o) => o.vessel_voyage ?? '—',
      searchValue: (o) => o.vessel_voyage ?? '',
      exportValue: (o) => o.vessel_voyage ?? '',
    },
    {
      key: 'etd_port_klang', label: 'ETD Port Klang', width: 130, sortable: true, defaultHidden: !isEmSg,
      accessor: (o) => detail(fmtDateOrDash(o.etd_port_klang)),
      searchValue: (o) => o.etd_port_klang ?? '',
      exportValue: (o) => (o.etd_port_klang ? fmtDate(o.etd_port_klang) : ''),      sortFn: (a, b) => String(a.etd_port_klang ?? '').localeCompare(String(b.etd_port_klang ?? '')),
      filterType: 'date', dateValue: (o) => o.etd_port_klang,
    },
    {
      key: 'bs_delivery_date', label: 'BS Delivery Date', width: 140, sortable: true, defaultHidden: !isEmSg,
      accessor: (o) => detail(fmtDateOrDash(o.bs_delivery_date)),
      searchValue: (o) => o.bs_delivery_date ?? '',
      exportValue: (o) => (o.bs_delivery_date ? fmtDate(o.bs_delivery_date) : ''),      sortFn: (a, b) => String(a.bs_delivery_date ?? '').localeCompare(String(b.bs_delivery_date ?? '')),
      filterType: 'date', dateValue: (o) => o.bs_delivery_date,
    },
    {
      key: 'esb_remarks', label: 'ESB Remarks', width: 180, defaultHidden: !isEmSg,
      accessor: (o) => o.esb_remarks ?? '—',
      searchValue: (o) => o.esb_remarks ?? '',
      exportValue: (o) => o.esb_remarks ?? '',
    },
    {
      key: 'bs_remarks', label: 'BS Remarks', width: 180, defaultHidden: !isEmSg,
      accessor: (o) => o.bs_remarks ?? '—',
      searchValue: (o) => o.bs_remarks ?? '',
      exportValue: (o) => o.bs_remarks ?? '',
    },
    {
      /* CTN is filled on the board (owner 2026-11-20) and pushed to ESB/BS, so it
         is inline-editable here (writes the SO's latest live DO, like the drawer). */
      key: 'ctn', label: 'CTN', width: 90, defaultHidden: !isEmSg,
      accessor: (o) => <TextEditCell order={o} value={o.ctn} placeholder="CTN…" onCommit={(v) => updateFieldsMutate({ type: 'so', id: o.so_doc_no, ctn: v }, { onError: fieldNotSaved })} />,
      searchValue: (o) => o.ctn ?? '',
      exportValue: (o) => o.ctn ?? '',
    },
    /* Crew — split into the HC delivery-sheet columns. Default-HIDDEN per the
       owner's 2026-09-22 column pass (crew is assigned later, not at planning);
       re-show Driver / Lorry / helpers from the Columns drawer. */
    {
      /* Inline type-to-search (owner 2026-09-26). SO writes the DO crew (which
         snapshots the driver's IC + contact into the next two columns); an ASSR
         leg writes the trip crew so it still consumes fleet capacity. */
      key: 'driver', label: 'Driver', width: 170, defaultHidden: true,
      accessor: (o) => <DriverPickCell order={o} drivers={drivers} onSchedule={scheduleMutate} writeSeat={writeCrewSeat} />,
      searchValue: (o) => o.crew?.driver_1_name ?? '',
      exportValue: (o) => o.crew?.driver_1_name ?? '',
    },
    {
      key: 'driver_ic', label: 'Driver IC', width: 140, defaultHidden: true,
      accessor: (o) => o.crew?.driver_1_ic || (o.crew?.driver_1_typed
        ? <span style={{ color: 'var(--c-burnt)' }} title="The driver was typed on the delivery order, not picked from Fleet. Pick the driver to fill the IC.">Pick driver</span>
        : <span style={{ color: 'var(--hz-c-ink-muted)' }}>—</span>),
      searchValue: (o) => o.crew?.driver_1_ic ?? '',
      exportValue: (o) => o.crew?.driver_1_ic ?? '',
    },
    {
      key: 'driver_contact', label: 'Driver Contact', width: 150, defaultHidden: true,
      accessor: (o) => (o.crew?.driver_1_contact ? formatPhone(o.crew.driver_1_contact) || o.crew.driver_1_contact : <span style={{ color: 'var(--hz-c-ink-muted)' }}>—</span>),
      searchValue: (o) => o.crew?.driver_1_contact ?? '',
      exportValue: (o) => (o.crew?.driver_1_contact ? formatPhone(o.crew.driver_1_contact) || o.crew.driver_1_contact : ''),
    },
    {
      key: 'driver_2', label: 'Driver 2', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.driver_2_name || <span style={{ color: 'var(--hz-c-ink-muted)' }}>—</span>,
      searchValue: (o) => o.crew?.driver_2_name ?? '',
      exportValue: (o) => o.crew?.driver_2_name ?? '',
    },
    {
      key: 'helper_1', label: 'Helper 1', width: 160, defaultHidden: true,
      accessor: (o) => <HelperPickCell order={o} helpers={helpers} onSchedule={scheduleMutate} writeSeat={writeCrewSeat} slot={1} />,
      searchValue: (o) => o.crew?.helper_1_name ?? '',
      exportValue: (o) => o.crew?.helper_1_name ?? '',
    },
    {
      key: 'helper_2', label: 'Helper 2', width: 160, defaultHidden: true,
      accessor: (o) => <HelperPickCell order={o} helpers={helpers} onSchedule={scheduleMutate} writeSeat={writeCrewSeat} slot={2} />,
      searchValue: (o) => o.crew?.helper_2_name ?? '',
      exportValue: (o) => o.crew?.helper_2_name ?? '',
    },
    {
      /* Inline type-to-search (owner 2026-09-26). SO writes the DO crew lorry; an
         ASSR leg writes the trip lorry. */
      key: 'lorry', label: 'Lorry Plate', width: 160, defaultHidden: true,
      accessor: (o) => <LorryPickCell order={o} lorries={lorries} onSchedule={scheduleMutate} writeSeat={writeCrewSeat} />,
      searchValue: (o) => o.crew?.lorry_plate ?? '',
      exportValue: (o) => o.crew?.lorry_plate ?? '',
    },
    {
      /* Total Amount (owner 2026-08-19) — the SO's grand total (local_total_sen),
         same figure as the SO list's Amount column. Default-VISIBLE, unlike the
         Balance beside it: the outstanding balance is a finance lookup, but the
         order's value is a planning fact. n/a on job rows (their total is a
         structural 0, and RM 0.00 would read as a paid-up order). */
      key: 'total_amount', label: 'Total Amount', width: 140, align: 'right', sortable: true,
      accessor: (o) => (o.row_type !== 'so' ? <NotApplicable /> : (
        <span style={MONEY_STYLE}>{fmtSen(o.local_total_sen)}</span>
      )),
      searchValue: (o) => (o.row_type !== 'so' ? '' : String(o.local_total_sen)),
      exportValue: (o) => (o.row_type !== 'so' ? '' : o.local_total_sen / 100),
      exportFormat: 'money',
      sortFn: (a, b) => a.local_total_sen - b.local_total_sen,
      numberValue: (o) => (o.row_type !== 'so' ? null : o.local_total_sen / 100),
    },
    {
      key: 'balance_sen', label: 'Balance', width: 130, align: 'right', sortable: true,
      /* Below zero is an OVER-COLLECTION, not a settled row — it must not share
         the muted grey that means "nothing owed" (owner 2026-08-16); a live
         balance reads in the SO list's ink since the 2026-08-19 restyle. */
      accessor: (o) => (
        <span style={{
          ...MONEY_STYLE,
          color: liveBalance(o) < 0 ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : liveBalance(o) > 0 ? '#11140f' : '#767b6e',
        }}>
          {fmtSen(liveBalance(o))}
        </span>
      ),
      searchValue: (o) => String(liveBalance(o)),
      exportValue: (o) => liveBalance(o) / 100,
      exportFormat: 'money',
      sortFn: (a, b) => liveBalance(a) - liveBalance(b),
      numberValue: (o) => liveBalance(o) / 100,
    },
    {
      key: 'do', label: 'DO No.', width: 130, groupable: true,
      accessor: (o) => {
        const nums = o.delivery_orders.length > 0
          ? o.delivery_orders.map((d) => d.do_number)
          : (o.related_do_nos ?? []);
        return nums.length > 0 ? <span style={DOCNO_STYLE}>{nums.join(', ')}</span> : '—';
      },
      searchValue: (o) => [...o.delivery_orders.map((d) => d.do_number), ...(o.related_do_nos ?? [])].join(' '),
      exportValue: (o) => (o.delivery_orders.length > 0 ? o.delivery_orders.map((d) => d.do_number) : (o.related_do_nos ?? [])).join(', '),
    },
    {
      /* PO No. — the purchase orders RAISED from this SO, the SO list's muted
         raised-PO chips (same walk: backend lib/so-converted-po.ts, adapted per
         company by lib/planning-po-nos.ts). Owner 2026-09-15, asked for beside
         Reference. Default-hidden; SO rows only, a dash on the synthetic kinds. */
      key: 'po_nos', label: 'PO No.', width: 150, groupable: true,
      accessor: (o) => (o.po_nos?.length ? <span style={DOCNO_STYLE}>{o.po_nos.join(', ')}</span> : '—'),
      searchValue: (o) => (o.po_nos ?? []).join(' '),
      groupValue: (o) => (o.po_nos?.length ? o.po_nos.join(', ') : '(none)'),
      exportValue: (o) => (o.po_nos ?? []).join(', '),
    },
    {
      key: 'do_date', label: 'DO Date', width: 120, sortable: true, defaultHidden: true,
      accessor: (o) => detail(fmtDateOrDash(o.do_date)),
      searchValue: (o) => o.do_date ?? '',
      exportValue: (o) => (o.do_date ? fmtDate(o.do_date) : ''),      sortFn: (a, b) => String(a.do_date ?? '').localeCompare(String(b.do_date ?? '')),
      filterType: 'date', dateValue: (o) => o.do_date,
    },
    ];
    return cols.sort((a, b) => (pos.get(a.key) ?? 999) - (pos.get(b.key) ?? 999));
  }, [isEmSg, drivers, lorries, helpers, amendReasonOptions, msgStatuses, salespersonNameOf, pcIndex]); // eslint-disable-line react-hooks/exhaustive-deps -- columns rebuild only on these inputs

  const overlayHidden = useMemo<string[] | undefined>(() => {
    if (!visibleColumnsOverride || visibleColumnsOverride.length === 0) return undefined;
    const keep = new Set(visibleColumnsOverride);
    return columns.map((c) => c.key).filter((k) => !keep.has(k));
  }, [columns, visibleColumnsOverride]);

  return (
    <div className="space-y-4">
      {stateTabs && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-0.5">
          {([{ key: 'ALL' as const, label: 'All' },
             ...STATE_TABS.map((s) => ({ key: s, label: DELIVERY_STATE_LABEL[s] }))]
          ).map((t) => {
            const active = activeState === t.key;
            const overdue = t.key === 'OVERDUE';
            return (
              <button
                key={t.key}
                type="button"
                className={[
                  'inline-flex h-[34px] items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[12px] font-semibold transition-colors duration-150',
                  overdue
                    ? 'text-err'
                    : active
                      ? 'text-primary-ink'
                      : 'text-ink-muted hover:text-ink',
                  active
                    ? (overdue ? 'border-err' : 'border-primary-ink')
                    : 'border-transparent',
                ].join(' ')}
                onClick={() => stateTabs.onStateChange(t.key)}
              >
                {t.label}
                <span
                  className={[
                    'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] font-mono text-[11px] font-bold tabular-nums',
                    active
                      ? (overdue ? 'bg-err/10 text-err' : 'bg-primary-soft text-primary-ink')
                      : 'bg-surface-dim text-ink-muted',
                  ].join(' ')}
                >
                  {counts[t.key] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {stateTabs && activeState === 'PENDING_SCHEDULE' && (
        <div className="text-[12px] text-ink-muted">
          <span className="font-semibold text-ink-secondary">{DATE_ARRANGEMENT_LABEL.PENDING_DATE}</span>
          {' '}{pendingSplit.PENDING_DATE}
          <span className="px-1.5">&middot;</span>
          <span className="font-semibold text-ink-secondary">{DATE_ARRANGEMENT_LABEL.DATE_ARRANGED}</span>
          {' '}{pendingSplit.DATE_ARRANGED}
          {' '}
          <span>
            ({ARRANGEMENT_STAGE_LABEL.PENDING_TIME} {pendingSplit.PENDING_TIME}
            {' '}&middot; {ARRANGEMENT_STAGE_LABEL.TIME_ARRANGED} {pendingSplit.TIME_ARRANGED})
          </span>
        </div>
      )}

      <div className={styles.regionChips}>
        {regionTabs.map((r) => (
          <button
            key={r.key}
            type="button"
            className={[
              styles.regionChip,
              r.sg ? styles.regionChipSg : '',
              activeRegion === r.key ? styles.regionChipActive : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onRegionChange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {!!error && !isLoading && (
        <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-[13px] text-err">
          <strong>Failed to load delivery planning.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      {selectedKeys.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{selectedKeys.size} selected</span>
          {/* Colour marks (owner 2026-09-26): paint every selected row a palette
              colour, or clear it. Shared with the per-row right-click palette. */}
          <span className={styles.bulkSep}>·</span>
          <span className={styles.bulkLabel}>Colour</span>
          {ROW_MARK_PALETTE.map((p) => (
            <button
              key={p.token}
              type="button"
              title={`Mark ${p.label}`}
              aria-label={`Mark ${p.label}`}
              disabled={markBusy}
              onClick={() => bulkSetMark.mutate({ rowKeys: [...selectedKeys], colour: p.token })}
              style={{ width: 22, height: 22, borderRadius: '50%', background: p.swatch, border: '2px solid rgba(0,0,0,0.15)', cursor: 'pointer', padding: 0 }}
            />
          ))}
          <button
            type="button"
            title="Clear colour from the selected rows"
            aria-label="Clear colour"
            disabled={markBusy}
            onClick={() => bulkClearMark.mutate([...selectedKeys])}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-soft, #9a9a9a)', cursor: 'pointer', fontSize: 'var(--fs-12)', textDecoration: 'underline' }}
          >
            Clear
          </button>

          <span className={styles.bulkSep}>·</span>
          <span className={styles.bulkLabel}>Crew</span>
          <Button variant="ghost" disabled={selectedKeys.size !== 1} onClick={copyCrew} title="Copy the lorry, driver and helpers of the one ticked row">Copy crew</Button>
          <Button
            variant="ghost"
            disabled={!copiedCrew || [...selectedKeys].every((k) => k === copiedCrew.fromKey)}
            onClick={() => void pasteCrew()}
            title={copiedCrew ? `Paste ${copiedCrew.label || 'the copied crew'} onto the other ticked rows` : 'Copy a row crew first'}
          >
            Paste crew
          </Button>

          {selectedTotals.count > 0 && (
            <>
              <span className={styles.bulkSep}>·</span>
              <span className={styles.bulkLabel}>Total Amount</span>
              <span className={styles.bulkCount} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtSen(selectedTotals.totalSen)}</span>
              <span className={styles.bulkLabel}>Balance</span>
              <span className={styles.bulkCount} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtSen(selectedTotals.balanceSen)}</span>
            </>
          )}

          <span className={styles.bulkSpacer} />

          {bulkExtras}

          <Button variant="ghost" onClick={onClearSelection} title="Clear selection">x</Button>
        </div>
      )}

      <BoardPendingContext.Provider value={boardPending}>
      <DataGridCompat
        rows={rows}
        columns={columns}
        storageKey={storageKey}
        /* The queue a planner narrows is the queue they come back to: funnels on
           the four delivery boards survive a page load (owner 2026-10-05), unlike
           every other list, which opens clean. */
        persistFilters="always"
        resetFilters={{
          active: resetFilters?.active ?? false,
          onReset: resetFilters?.onReset ?? (() => undefined),
          label: 'Reset layout',
        }}
        layoutPresets={layoutPresets}
        onApplyLayoutPreset={onApplyLayoutPreset}
        initialRowLimit={initialRowLimit}
        onRowReorder={onRowReorder}
        /* Drag over the Total Amount / Balance cells to add them up, like Excel
           (HC-0164, Syu). */
        cellRangeSum
        fitToWidth
        exportName={exportName}
        rowKey={rowIdOf}
        /* The full board scrolls its tabs and toolbar away so the grid fills the
           screen (owner 2026-10-26); the embedded Trips panel keeps its toolbar. */
        freezeFrom={stateTabs ? 'table' : 'toolbar'}
        searchPlaceholder={searchPlaceholder}
        /* User-controlled grouping (owner 2026-10-24, "like Google Sheets"):
           default OFF (no forced group). The operator groups by a column of his
           choice — Delivery Message Status, or Delivery Date (by day) / Delivery
           Month (by month) — by dragging its header here or via the header menu,
           then folds groups with the per-group chevron or the Collapse-all control
           in the banner. The grouped list still virtualizes. */
        groupBanner
        isLoading={isLoading}
        emptyMessage={emptyMessage}
        selectable={{
          selectedKeys,
          onToggle,
          onToggleAll,
        }}
        onRowDoubleClick={onRowDoubleClick}
        expandable={{
          renderExpansion: (row) => (isAssr(row) || isDp(row) || isProject(row) ? null : <PlanningExpandedLines docNo={row.so_doc_no} />),
          rowExpansionKey: (row) => (isAssr(row) || isDp(row) || isProject(row) ? '' : row.so_doc_no),
        }}
        rowStyle={(o) => {
          const base = o.region === 'SG' ? { boxShadow: 'inset 3px 0 0 #2f5d4f' } : undefined;
          const tint = rowMarkTint(rowMarks?.get(rowIdOf(o)));
          return tint ? { ...(base ?? {}), background: tint } : base;
        }}
        contextMenu={contextMenu}
        defaultSort={defaultSort}
        onRowClick={onRowClick}
        scrollToRow={scrollToRow}
        overlayHidden={overlayHidden}
        onUserAdjustColumns={onUserAdjustColumns}
      />
      </BoardPendingContext.Provider>
    </div>
  );
}
