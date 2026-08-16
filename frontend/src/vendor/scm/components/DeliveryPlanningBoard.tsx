// ----------------------------------------------------------------------------
// DeliveryPlanningBoard — the shared Delivery Planning grid.
//
// The whole board body — the CONFIG-DRIVEN region chip row, the optional 4
// state-tab rail, the compact bulk-edit bar (multiselect), the inline Excel-
// style cell editors (Status / Sched. Date / Driver / Lorry), the SO line-item
// drill-down, and the DataGrid with its full HC column set — extracted verbatim
// from DeliveryPlanning.tsx so it can be reused UNCHANGED in two places:
//
//   1. DeliveryPlanning.tsx  — the full board: all 4 state tabs, every bulk
//      action (Convert to DO, Schedule), region chips, expand, multiselect.
//   2. Trips.tsx "To schedule" panel — the SAME board LOCKED to
//      state=PENDING_SCHEDULE (no state-tab row), still with the full column
//      set, region chips, expandable line-item detail and multiselect wired to
//      the Phase-2 ScheduleTripDrawer.
//
// The page owns the data fetch (so the region param stays server-side via
// useDeliveryPlanning), the selection Set, and any drawers/modals; the board
// renders and edits. No new endpoint, hook, or state derivation is introduced —
// it reuses useScheduleDelivery / useDeliveryPlanningLines exactly as before.
// ----------------------------------------------------------------------------

import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { fmtCenti, fmtDateOrDash, fmtDateTime, buildVariantSummary } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import { DataGrid, type DataGridColumn } from './DataGrid';
import { useConfirm } from './ConfirmDialog';
import { useNotify } from './NotifyDialog';
import { Button } from '../../../components/Button';
import { StockRemarkPill, stockRemarkSortFn } from '../../../components/StockRemarkPill';
import { badgeFor } from '../lib/category-badges';
import {
  useDeliveryPlanningLines,
  useScheduleDelivery,
  DELIVERY_STATES,
  DELIVERY_STATE_LABEL,
  dpJobTypeLabel,
  assrJobKindLabel,
  arrangementStageLabel,
  dateArrangementOf,
  DATE_ARRANGEMENT_LABEL,
  ARRANGEMENT_STAGE_LABEL,
  type DeliveryState,
  type PlanningOrder,
} from '../lib/delivery-planning-queries';
import { type DriverRow } from '../lib/drivers-queries';
import { type LorryRow } from '../lib/lorries-queries';
import styles from './DeliveryPlanningBoard.module.css';

/* HC "Remark 4" delivery sub-status → a small pill class (reuse the cream
   palette; unknown/blank → muted). Default-shown column. */
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
  if (!value) return <span style={{ color: '#767b6e' }}>—</span>;
  const tone = SUBSTATUS_TONE[value] ?? '#767b6e';
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      border: `1px solid ${tone}`, color: tone, fontSize: 'var(--fs-10)',
      fontWeight: 600, whiteSpace: 'nowrap',
    }}>{value}</span>
  );
}
/* A datetime-or-dash cell (TIMESTAMPTZ columns). */
const dtOrDash = (iso: string | null): string => (iso ? fmtDateTime(iso) : '—');

/* Company badge for the SHARED cross-company queue — a small code chip
   (HOUZS / 2990). null (e.g. ASSR rows / unresolved) renders a muted dash. */
function CompanyBadge({ code }: { code: string | null }) {
  if (!code) return <span style={{ color: '#767b6e' }}>—</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      border: '1px solid #2f5d4f', color: '#2f5d4f',
      fontSize: 'var(--fs-10)', fontWeight: 700, letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>{code}</span>
  );
}

/* ── Row-type helpers (SO delivery vs ASSR service-case job) ───────────────────
   The board mixes SO-delivery rows (the original) with Service-Case (ASSR)
   rows added by the backend. `isAssr` gates every ASSR-specific behaviour;
   `rowIdOf` is the stable DataGrid key (prefixed so SO doc_nos and ASSR case ids
   never collide). */
export const isAssr = (o: PlanningOrder): boolean => o.row_type === 'assr';
/* DP-Order rows (manual setup / dismantle / supplier-pickup jobs). */
export const isDp = (o: PlanningOrder): boolean => o.row_type === 'dp';
export const isProject = (o: PlanningOrder): boolean => o.row_type === 'project';
/* A friendly label for a DP job type — resolved from the SHARED canonical map
   (dpJobTypeLabel) so the board's Type chip and the New-DP-Order dropdown always
   read the same wording. Empty job_type falls back to a generic 'DP job'. */
export const dpLabel = (o: PlanningOrder): string =>
  o.dp_job_type ? dpJobTypeLabel(o.dp_job_type) : 'DP job';
/* ASSR key includes job_kind — a case with BOTH a customer-pickup and a
   delivery date emits TWO rows sharing one assr_id, so the key must carry the
   leg to stay unique (the backend's so_doc_no is already `<assrNo>#<jobKind>`). */
export const rowIdOf = (o: PlanningOrder): string =>
  isDp(o)
    ? `dp:${o.so_doc_no}` // distinct prefix → excluded from the SO-only bulk actions (which filter `so:`)
    : isAssr(o)
      ? `assr:${o.assr_id ?? o.ref ?? ''}:${o.job_kind ?? ''}`
      : `so:${o.so_doc_no}`;

/* The Type column's chip. SO rows read a neutral "SO delivery"; ASSR rows read
   their job kind — amber "Cust. pickup" for a pickup, green "Delivery" for a
   delivery. Same inline-pill shape the SO drill-down's CategoryPill / the
   SubstatusPill use, so it reads consistently across the board. */
function TypeChip({ order }: { order: PlanningOrder }) {
  let label = 'SO delivery';
  let tone = '#767b6e';
  let bg = 'rgba(34, 31, 32, 0.06)';
  if (isDp(order)) {
    label = dpLabel(order);
    tone = '#8a2f66';
    bg = 'rgba(166, 50, 107, 0.12)';
  } else if (isProject(order)) {
    // PMS project setup/dismantle — reuse the SETUP/DISMANTLE label, distinct tone.
    label = dpLabel(order);
    tone = '#1f5e73';
    bg = 'rgba(31, 94, 115, 0.12)';
  } else if (isAssr(order)) {
    // The three ASSR legs keep their own tones; the WORDS come from the shared
    // map so the chip, the search index and the export cannot drift (they did,
    // four ways, before the 2026-08-03 rename).
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

/* A muted em-dash cell — the shared "not applicable" render for columns that
   don't apply to an ASSR row (stock, driver, lorry). */
const NotApplicable = () => <span style={{ color: '#767b6e' }}>—</span>;

/* Region chips — CONFIG-DRIVEN buckets (migration 0053) classified by customer
   STATE. The bucket list comes from the API's `regions` master (owner-
   maintained in Delivery Regions), with an "All" tab prepended. SG is visually
   distinct (dashed teal chip — cross-border, no MY warehouse); that styling keys
   off the region CODE === 'SG', not a hardcoded position. The chip's key is sent
   verbatim as ?region= to the API, which buckets every order by customer state. */
export type RegionTab = { key: string; label: string; sg?: boolean };

/* Build the region chip list from the API `regions` master (+ "All" prepended).
   Falls back to the five geographic defaults until the API returns the list.
   Shared by both the board host pages so the chips are identical. */
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

/* The 4 state tabs (the top row). */
const STATE_TABS = DELIVERY_STATES;

/* Per-state tint for the Status cell's editable select — the same cream palette
   the old inline pill used, applied as the select's text/background so an
   overridden state still reads at a glance. */
const DSTATE_TONE: Record<DeliveryState, { bg: string; fg: string }> = {
  PENDING_DELIVERY: { bg: 'rgba(34, 31, 32, 0.06)', fg: '#767b6e' },
  PENDING_SCHEDULE: { bg: 'rgba(232, 107, 58, 0.12)', fg: '#0c3f39' },
  OVERDUE:          { bg: 'rgba(184, 51, 31, 0.12)', fg: '#b8331f' },
  DELIVERED:        { bg: 'rgba(47, 93, 79, 0.12)', fg: '#2f5d4f' },
};

/* ── Inline (Excel-style) cell editors ────────────────────────────────────────
   Each cell IS the control (no drill-in). All of them stopPropagation on click /
   double-click so editing a cell never selects the row or triggers the row's
   double-click → open-SO navigation. Every change persists immediately through
   useScheduleDelivery (shared `sched` mutation, optimistic + invalidate).

   Manual-override semantics (owner rule): the Status cell writes deliveryState —
   the backend treats this as the override that WINS over the derived state, so a
   coordinator can force e.g. an OVERDUE SO into PENDING_SCHEDULE. The real stock
   readiness stays visible in its own Stock column (never hidden by the override).

   SO rows write type:'so', id: so_doc_no — matching the amended_delivery_date /
   delivery_state override path on mfg_sales_orders. ASSR (service-case) rows are
   date-only for now: the Sched. Date cell writes type:'assr' (+ jobKind); their
   Status / Driver / Lorry cells are read-only / non-applicable (not wired yet). */
type SchedMutation = ReturnType<typeof useScheduleDelivery>;

/* Small shared wrapper so clicks inside an editor stay in the editor. */
const stopRow = {
  onClick: (e: ReactMouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: ReactMouseEvent) => e.stopPropagation(),
};

function StatusEditCell({ order, sched }: { order: PlanningOrder; sched: SchedMutation }) {
  const tone = DSTATE_TONE[order.delivery_state];
  /* ASSR + DP rows: the delivery-state override is not wired for these yet, so
     show the state read-only (as a tinted pill) instead of an editable select. */
  if (isAssr(order) || isDp(order) || isProject(order)) {
    return (
      <span
        className={styles.dstatePill}
        style={{ background: tone.bg, color: tone.fg }}
        title={isProject(order) ? 'PMS project window — scheduled in Projects' : isDp(order) ? 'DP-job state (schedule it from the DP Order)' : 'Service-case state (override not wired for ASSR)'}
      >
        {DELIVERY_STATE_LABEL[order.delivery_state]}
      </span>
    );
  }
  return (
    <select
      className={styles.inlineEdit}
      style={{ background: tone.bg, color: tone.fg, fontWeight: 600 }}
      value={order.delivery_state}
      disabled={sched.isPending}
      title="Manual delivery-state override (wins over the derived state)"
      {...stopRow}
      onChange={(e) => {
        const deliveryState = e.target.value as DeliveryState;
        if (deliveryState === order.delivery_state) return;
        sched.mutate({ type: 'so', id: order.so_doc_no, deliveryState });
      }}
    >
      {DELIVERY_STATES.map((s) => (
        <option key={s} value={s}>{DELIVERY_STATE_LABEL[s]}</option>
      ))}
    </select>
  );
}

/* The inline schedule-date cell lived here until the owner's 2026-08-04 column
   pass removed its column ("删列但保留排期"). Scheduling did NOT go with it: an
   SO row opens ScheduleTripDrawer from its row menu (date + driver + lorry +
   trip), a service case opens SetJobDateDrawer, which makes the same
   type:'assr' + jobKind call this cell used to make. Either way the write still
   lands on the SO's amended_delivery_date — the customer's ORIGINAL
   customer_delivery_date is never overwritten. */

/* Sentinel for an existing crew assignment whose name/plate is NOT in the active
   master list — shown as a selected option so the cell never blanks an existing
   assignment; picking it is a no-op (guarded in onChange). */
const KEEP_CURRENT = '__current__';

function DriverEditCell({ order, sched, drivers }: { order: PlanningOrder; sched: SchedMutation; drivers: DriverRow[] }) {
  /* DP rows carry no crew until scheduled from the DP Order → non-applicable. */
  if (isDp(order)) return <NotApplicable />;
  /* PMS project rows are a read-only mirror — show the crew PMS assigned (edit in Projects). */
  if (isProject(order)) return <span style={{ color: '#767b6e' }}>{order.crew?.driver_1_name || '—'}</span>;
  /* SO rows write type:'so'; ASSR legs write type:'assr' (+ jobKind) — the backend
     wires the leg onto a trip so it consumes fleet capacity (P3). No driver_id on
     the row (crew carries names only) → preselect by matching driver_1_name. */
  const assrLeg = isAssr(order);
  const currentName = order.crew?.driver_1_name ?? '';
  const matchedId = drivers.find((d) => d.name === currentName)?.id ?? '';
  const offList = currentName !== '' && matchedId === '';
  return (
    <select
      className={styles.inlineEdit}
      value={offList ? KEEP_CURRENT : matchedId}
      disabled={sched.isPending}
      {...stopRow}
      onChange={(e) => {
        const picked = e.target.value;
        if (picked === KEEP_CURRENT) return;   // re-picking the off-list current = no-op
        const driverId = picked || null;
        const driverNameOptimistic = driverId ? (drivers.find((d) => d.id === driverId)?.name ?? null) : null;
        sched.mutate(assrLeg
          ? { type: 'assr', id: String(order.assr_id ?? ''), jobKind: order.job_kind, driverId, driverNameOptimistic }
          : { type: 'so', id: order.so_doc_no, driverId, driverNameOptimistic });
      }}
    >
      <option value="">—</option>
      {/* Keep the current name selectable even if it's not (or no longer) in the
          active driver master, so an existing assignment never silently blanks. */}
      {offList && <option value={KEEP_CURRENT}>{currentName}</option>}
      {drivers.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
}

function LorryEditCell({ order, sched, lorries }: { order: PlanningOrder; sched: SchedMutation; lorries: LorryRow[] }) {
  /* DP rows carry no crew until scheduled from the DP Order → non-applicable. */
  if (isDp(order)) return <NotApplicable />;
  /* PMS project rows are a read-only mirror — show the assigned lorry (edit in Projects). */
  if (isProject(order)) return <span style={{ color: '#767b6e' }}>{order.crew?.lorry_plate || '—'}</span>;
  /* SO rows write type:'so'; ASSR legs write type:'assr' (+ jobKind) — wires the
     leg onto a trip (P3) so a lorry is a real fleet commitment. */
  const assrLeg = isAssr(order);
  const currentPlate = order.crew?.lorry_plate ?? '';
  const matchedId = lorries.find((l) => l.plate === currentPlate)?.id ?? '';
  const offList = currentPlate !== '' && matchedId === '';
  return (
    <select
      className={styles.inlineEdit}
      value={offList ? KEEP_CURRENT : matchedId}
      disabled={sched.isPending}
      {...stopRow}
      onChange={(e) => {
        const picked = e.target.value;
        if (picked === KEEP_CURRENT) return;
        const lorryId = picked || null;
        const lorryPlateOptimistic = lorryId ? (lorries.find((l) => l.id === lorryId)?.plate ?? null) : null;
        sched.mutate(assrLeg
          ? { type: 'assr', id: String(order.assr_id ?? ''), jobKind: order.job_kind, lorryId, lorryPlateOptimistic }
          : { type: 'so', id: order.so_doc_no, lorryId, lorryPlateOptimistic });
      }}
    >
      <option value="">—</option>
      {offList && <option value={KEEP_CURRENT}>{currentPlate}</option>}
      {lorries.map((l) => (
        <option key={l.id} value={l.id}>{l.plate}</option>
      ))}
    </select>
  );
}

/* Balance source-of-truth (mirrors the SO list's liveBalance, PR #83):
   the payment-totals view's balance_centi_live (local_total − Σpayments) when
   present, else the header's stored balance_centi. */
const liveBalance = (o: PlanningOrder): number =>
  typeof o.balance_centi_live === 'number' ? o.balance_centi_live : o.balance_centi;

/* The days_left cell renderer lived here until the owner's 2026-08-04 column
   pass removed that column. It is gone rather than left dangling — the Overdue
   state tab and the delivery_state derivation already act on the same number,
   so nothing lost the signal, only the column. The API still sends days_left. */

/* ── SO line-item drill-down (parity with the Sales Order list) ───────────────
   Each planning row expands (▼ caret on the left, added by DataGrid's
   `expandable` API) to show that SO's line items — same four columns the SO list
   drill-down shows: Group · Item Code · Description · Description 2.

   Items are fetched from the SHARED cross-company endpoint
   `useDeliveryPlanningLines(docNo)` (GET /delivery-planning/:docNo/lines), scoped
   to the caller's ALLOWED companies — lazy-fetched per row on expand and
   TanStack-cached by doc_no, so re-expanding the same SO is instant. This
   deliberately does NOT reuse the per-company SO detail hook: that scopes to the
   ACTIVE company and 404s a cross-company (e.g. 2990) row on the shared board.
   The planning row already carries `so_doc_no`, which keys the fetch. */
type DrillItem = {
  id: string;
  /* snake_case off the SO detail REST response (see SoItem in
     MfgSalesOrdersList) — the API never transforms these. */
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  variants: Record<string, unknown> | null;
  cancelled: boolean | null;
};

/* Inline category pill — same shape + shared `badgeFor` palette as the SO list
   drill-down's CategoryPill so the colours stay in lockstep across both pages. */
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

/* Four drill-down columns — Group · Item Code · Description · Description 2.
   Matches the SO list's accessors/markup verbatim. Shared layout key so the
   operator's column prefs persist across every SO they expand. */
const DRILLDOWN_COLUMNS: DataGridColumn<DrillItem>[] = [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <CategoryPill group={it.item_group} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: '#0c3f39' }}>{it.item_code ?? '—'}</span>,
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
      return summary ? <div>{summary}</div> : <span style={{ color: '#767b6e' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group, it.variants),
  },
];

const PlanningExpandedLines = ({ docNo }: { docNo: string }) => {
  /* SHARED-QUEUE line fetch — /delivery-planning/:docNo/lines, scoped to the
     caller's ALLOWED companies (not the active one). Lazy on expand, cached by
     doc_no. Using the cross-company endpoint (not the per-company SO detail)
     means a 2990 row opened while browsing as Houzs loads instead of 404ing. */
  const q = useDeliveryPlanningLines(docNo);
  if (q.isLoading) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: '#767b6e' }}>
        Loading lines for {docNo}…
      </div>
    );
  }
  if (q.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: '#b8331f' }}>
        Failed to load lines: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const allItems = (q.data ?? []) as DrillItem[];
  /* Filter cancelled lines client-side — the lines endpoint returns them too
     (matches the SO list drill-down). */
  const items = allItems.filter((it) => !it.cancelled);

  if (items.length === 0) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: '#767b6e' }}>
        No line items.
      </div>
    );
  }

  return (
    <div style={{
      padding: 'var(--space-2) var(--space-3) var(--space-2) 40px',
      background: '#fff',
    }}>
      <DataGrid<DrillItem>
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

/* Row-context-menu item shape (mirrors DataGrid's contextMenu return). */
type ContextMenuItems = ReturnType<NonNullable<Parameters<typeof DataGrid<PlanningOrder>>[0]['contextMenu']>>;

export type DeliveryBoardStateTabs = {
  activeState: string;               // 'ALL' | DeliveryState
  onStateChange: (state: string) => void;
};

export type DeliveryPlanningBoardProps = {
  /* Data — the page owns the useDeliveryPlanning fetch so the region stays a
     SERVER-SIDE filter (region is part of the query key). */
  orders: PlanningOrder[];
  counts: Record<string, number>;
  regionTabs: RegionTab[];
  activeRegion: string;
  onRegionChange: (region: string) => void;
  isLoading?: boolean;
  error?: unknown;

  /* The 4 state tabs. Present → the top state-tab rail renders and the board
     client-filters `orders` by the active tab (the full DeliveryPlanning board).
     Omitted → no state-tab row, `orders` shown as-is (the Trips "To schedule"
     panel, whose fetch is already LOCKED to state=PENDING_SCHEDULE). */
  stateTabs?: DeliveryBoardStateTabs;

  /* Selection — owned by the page (its drawers read the selected orders). */
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: (keys: string[], allSelected: boolean) => void;
  onClearSelection: () => void;

  /* Shared write path + option lists + the Message column data. */
  sched: SchedMutation;
  drivers: DriverRow[];
  lorries: LorryRow[];
  msgStatuses?: Record<string, { success: boolean; http_code: number | null; created_at: string }>;

  /* Extra buttons rendered at the right of the bulk bar (Convert to DO,
     Schedule, …). The page injects them since they open page-owned drawers. */
  bulkExtras?: ReactNode;

  /* Row interactions (page-specific side effects). */
  onRowDoubleClick?: (order: PlanningOrder) => void;
  contextMenu?: (order: PlanningOrder) => ContextMenuItems;

  /* ── Option B side map (owner 2026-08-08) ─────────────────────────────────
     Single-click row hook (board row → map pin linkage; fires alongside the
     grid's own select/multi-select, changing nothing existing). */
  onRowClick?: (order: PlanningOrder) => void;
  /* Map pin → board row: bump nonce with a rowIdOf key (`so:<docNo>`) to
     scroll + highlight that row. Forwarded to the DataGrid. */
  scrollToRow?: { key: string; nonce: number } | null;
  /* While the side map is OPEN the board narrows to these column KEYS — a
     RENDER-TIME overlay over the DataGrid's hidden set. The user's own saved
     column prefs are never written; pass null/undefined (map closed) and the
     full set returns exactly as the user left it. */
  visibleColumnsOverride?: readonly string[] | null;
  /* Explicit column-visibility choice made by the user (Columns drawer, header
     context menu, saved layout) — forwarded from the DataGrid so the map pages
     can switch their compact-columns overlay OFF the moment the user picks
     columns by hand (the narrowing is a default, never a lock). */
  onUserAdjustColumns?: () => void;

  storageKey?: string;
  exportName?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;

  /* Default ordering while NO column sort is active — forwarded to the
     DataGrid. The two arrangement queues pass arrangementQueueCompare
     (lib/arrangement-sort.ts: delivery date OLDEST first, then state, then
     postcode — owner 2026-08-07 "跟着 delivery date、state、postcode 去排").
     A clicked header still overrides as always. Omitted (the main Delivery
     Planning board), the rows render in the server's order exactly as before. */
  defaultSort?: (a: PlanningOrder, b: PlanningOrder) => number;
};

/* Selection keys are prefixed (`so:<docNo>` / `assr:<id>` / `dp:<id>`). The bulk
   actions are SO-only, so pull the SO doc_nos out of the selection. Exported so
   host pages resolve the same selected orders for their drawers. */
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
  storageKey = 'dg-delivery-planning',
  exportName = 'DeliveryPlanning',
  searchPlaceholder = 'Search SO / ref / customer / phone…',
  emptyMessage = 'No orders need delivering in this view.',
  defaultSort,
}: DeliveryPlanningBoardProps) {
  const askConfirm = useConfirm();
  const notify = useNotify();

  /* EM/SG nicety: when the active region is EM or SG, the cross-border columns
     (shipout date, port ref, customer-delivered date) default-SHOW; elsewhere
     they sit in the Columns menu like the rest. */
  const isEmSg = activeRegion === 'EM' || activeRegion === 'SG';

  const activeState = stateTabs?.activeState ?? 'ALL';
  /* Apply the active state tab in the client (the fetch already region-scoped).
     When there is no tab row (Trips), the passed orders are already the single
     PENDING_SCHEDULE set, so show them as-is. */
  const rows = useMemo<PlanningOrder[]>(
    () => (!stateTabs || activeState === 'ALL' ? orders : orders.filter((o) => o.delivery_state === activeState)),
    [orders, stateTabs, activeState],
  );

  const selectedSoDocNos = (): string[] => soDocNosFromSelection(selectedKeys);

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

  /* ── Bulk-edit bar state ────────────────────────────────────────────────────
     One field at a time: Status | Delivery date | Driver | Lorry. The second
     control's TYPE depends on the chosen field; `bulkValue` holds its raw value
     (state code / YYYY-MM-DD / driver id / lorry id). Apply fans out one
     useScheduleDelivery call per selected SO (capped concurrency), then clears
     the selection and reports a summary via the in-app NotifyDialog. */
  type BulkField = 'STATUS' | 'DATE' | 'DRIVER' | 'LORRY';
  const [bulkField, setBulkField] = useState<BulkField>('STATUS');
  const [bulkValue, setBulkValue] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState(false);

  /* Reset the value control whenever the field type changes (a date value makes
     no sense once the field is Driver, etc.). */
  const changeBulkField = (f: BulkField) => { setBulkField(f); setBulkValue(''); };

  const applyBulk = async () => {
    const docNos = selectedSoDocNos();
    if (docNos.length === 0 || bulkBusy) return;

    /* Build the single-field patch + a human label for the confirm/summary. */
    const patch: Partial<Parameters<typeof sched.mutateAsync>[0]> = {};
    let valueLabel = '';
    if (bulkField === 'STATUS') {
      if (!bulkValue) return;
      patch.deliveryState = bulkValue as DeliveryState;
      valueLabel = DELIVERY_STATE_LABEL[bulkValue as DeliveryState];
    } else if (bulkField === 'DATE') {
      patch.scheduleDate = bulkValue || null;   // empty → clear the amended date
      valueLabel = bulkValue || '(cleared)';
    } else if (bulkField === 'DRIVER') {
      patch.driverId = bulkValue || null;
      patch.driverNameOptimistic = bulkValue ? (drivers.find((d) => d.id === bulkValue)?.name ?? null) : null;
      valueLabel = bulkValue ? (drivers.find((d) => d.id === bulkValue)?.name ?? bulkValue) : '(none)';
    } else {
      patch.lorryId = bulkValue || null;
      patch.lorryPlateOptimistic = bulkValue ? (lorries.find((l) => l.id === bulkValue)?.plate ?? null) : null;
      valueLabel = bulkValue ? (lorries.find((l) => l.id === bulkValue)?.plate ?? bulkValue) : '(none)';
    }

    const fieldLabel = bulkField === 'STATUS' ? 'Status' : bulkField === 'DATE' ? 'Delivery date' : bulkField === 'DRIVER' ? 'Driver' : 'Lorry';
    if (!(await askConfirm({
      title: `Set ${fieldLabel} on ${docNos.length} order${docNos.length === 1 ? '' : 's'}?`,
      body: `${fieldLabel} → ${valueLabel} will be applied to every selected order.`,
      confirmLabel: `Apply to ${docNos.length}`,
    }))) return;

    setBulkBusy(true);
    let ok = 0;
    const failed: string[] = [];
    const LIMIT = 4;
    try {
      for (let i = 0; i < docNos.length; i += LIMIT) {
        const batch = docNos.slice(i, i + LIMIT);
        await Promise.all(batch.map(async (docNo) => {
          try {
            await sched.mutateAsync({ type: 'so', id: docNo, ...patch });
            ok += 1;
          } catch (e) {
            failed.push(`${docNo} (${e instanceof Error ? e.message : 'Something went wrong.'})`);
          }
        }));
      }
    } finally {
      setBulkBusy(false);
    }
    onClearSelection();
    setBulkValue('');
    const parts = [`${fieldLabel} set to ${valueLabel} on ${ok} order${ok === 1 ? '' : 's'}.`];
    if (failed.length > 0) parts.push(`Failed ${failed.length}: ${failed.join('; ')}.`);
    notify({
      title: failed.length > 0 ? 'Bulk update finished with errors' : 'Bulk update complete',
      body: parts.join(' '),
      tone: failed.length > 0 ? 'error' : 'info',
    });
  };

  const columns = useMemo<DataGridColumn<PlanningOrder>[]>(() => {
    /* The DEFAULT header order (owner 2026-07-22 header tidy): identity →
       status → dates → fleet → documents → money, with every default-hidden
       HC / crew-detail column grouped after, so the Columns drawer reads in
       the same logical blocks. The array below stays grouped by DATA SOURCE
       (easier to maintain against the API shape); this list is what pristine
       layouts actually show. A user's saved layout.order still wins. A key
       missing here falls to the end in definition order. */
    const DP_DEFAULT_ORDER = [
      /* ── SHOWN BY DEFAULT — the question each block answers ──────────────
         Owner's column pass, 2026-08-04 (he went through all 45 by hand). These
         columns were written for a board that carried SO deliveries only; it now
         also carries ASSR legs, DP orders and PMS project rows, on which most SO
         columns are structurally empty. Five columns were removed outright in
         that pass — Days Left, Delivered Date, Property, Possession, Referral,
         Internal Est. — and the address moved INTO the default view, because
         where the lorry is going is a planning question. */
      // What is this row, and who is it for
      'row_type', 'so_doc_no', 'company_code', 'debtor_name', 'phone', 'wa_message',
      // Where it is going
      'region', 'address', 'postcode',
      // Where it stands
      'delivery_state', 'stock_remark',
      // When
      'customer_delivery_date', 'amended_delivery_date',
      // Who takes it
      'driver', 'lorry',
      // What proves it
      'do',
      // Cross-border, shown ONLY on the EM / SG region tabs (defaultHidden:
      // !isEmSg) — noise on the other four, essential on those two.
      'shipout_date', 'eta_arriving_port', 'arrives_em_warehouse_date',

      /* ── DEFAULT-HIDDEN from here down, grouped by theme so the Columns
            drawer reads as blocks rather than one long alphabet. ──────────── */
      // Delivery detail
      'delivery_substatus',
      // Arrangement pipeline (derived) — the sub-state within Pending Schedule
      // and the live trip the order sits on. Default-hidden: the split already
      // reads off the sub-count row / the Date & Time Arrangement pages.
      'arrangement_stage', 'trip_no',
      // Amendment trail
      'amend_date_from_customer', 'amend_reason',
      // Execution times — filled in as the day happens, not while planning it
      'time_range', 'time_confirmed', 'arrival_at', 'departure_at',
      // Customer detail
      'house_type', 'replacement_disposal', 'branding',
      // Crew detail — the Driver / Lorry columns above carry the summary
      'driver_ic', 'driver_contact', 'driver_2', 'helper_1', 'helper_2',
      // Document + money
      'so_date', 'warehouse', 'do_date', 'balance_centi',
    ];
    const pos = new Map(DP_DEFAULT_ORDER.map((k, i) => [k, i] as const));
    const cols: DataGridColumn<PlanningOrder>[] = [
    {
      /* Row type — SO delivery vs ASSR (service-case) job. A chip per row so the
         two kinds read apart at a glance. */
      key: 'row_type', label: 'Job Type', width: 130, groupable: true,
      accessor: (o) => <TypeChip order={o} />,
      /* Search keeps the OLD words as aliases ("cust. pickup", "delivery"):
         the 2026-08-03 rename changed what the chip says, and someone who has
         typed "delivery" into this box for a year should still find the row. */
      searchValue: (o) => (isDp(o) || isProject(o) ? dpLabel(o)
        : isAssr(o) ? `${assrJobKindLabel(o.job_kind)} ${o.job_kind === 'customer_pickup' ? 'cust. pickup customer pickup' : o.job_kind === 'delivery' ? 'delivery' : ''}`.trim()
        : 'SO delivery'),
      groupValue: (o) => (isDp(o) || isProject(o) ? dpLabel(o) : isAssr(o) ? assrJobKindLabel(o.job_kind) : 'SO delivery'),
      exportValue: (o) => (isDp(o) || isProject(o) ? dpLabel(o) : isAssr(o) ? assrJobKindLabel(o.job_kind) : 'SO delivery'),
    },
    {
      /* SO No. for SO rows; the ASSR ref (assr_no) for service-case rows. */
      key: 'so_doc_no', label: 'SO No.', width: 150, sortable: true,
      accessor: (o) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', fontWeight: 700, color: '#0c3f39', fontVariantNumeric: 'tabular-nums' }}>
          {isDp(o) ? (o.dp_no ?? '— not scheduled') : isAssr(o) ? (o.ref ?? '—') : o.so_doc_no}
        </span>
      ),
      searchValue: (o) => (isAssr(o) ? (o.ref ?? '') : o.so_doc_no),
      exportValue: (o) => (isAssr(o) ? (o.ref ?? '') : o.so_doc_no),
      sortFn: (a, b) => (isAssr(a) ? (a.ref ?? '') : a.so_doc_no).localeCompare(isAssr(b) ? (b.ref ?? '') : b.so_doc_no),
    },
    {
      /* Company — the SHARED cross-company queue serves both HOUZS + 2990, so
         each row is tagged with its owning company. Default-VISIBLE so the two
         companies read apart at a glance. ASSR rows have no company (dash). */
      key: 'company_code', label: 'Company', width: 90, groupable: true,
      accessor: (o) => <CompanyBadge code={o.company_code ?? null} />,
      searchValue: (o) => o.company_code ?? '',
      groupValue: (o) => o.company_code ?? '(none)',
      exportValue: (o) => o.company_code ?? '',
    },
    {
      key: 'debtor_name', label: 'Customer', width: 200, sortable: true, groupable: true,
      accessor: (o) => o.debtor_name ?? o.debtor_code ?? '—',
      searchValue: (o) => `${o.debtor_name ?? ''} ${o.debtor_code ?? ''}`.trim(),
      groupValue: (o) => o.debtor_name ?? o.debtor_code ?? '(none)',
      sortFn: (a, b) => (a.debtor_name ?? '').localeCompare(b.debtor_name ?? ''),
    },
    {
      key: 'phone', label: 'Phone', width: 150,
      accessor: (o) => formatPhone(o.phone) || '—',
      searchValue: (o) => o.phone ?? '',
    },
    {
      /* Latest WhatsApp (Seampify) send for this SO, from scm.wa_message_log —
         '—' until a send exists. SO-only (the send action is SO-only too). */
      key: 'wa_message', label: 'Message', width: 110,
      accessor: (o) => {
        if (o.row_type !== 'so') return '—';
        const s = msgStatuses?.[o.so_doc_no];
        if (!s) return '—';
        return (
          <span style={{ fontWeight: 600, color: s.success ? '#2e7d32' : '#b3261e' }}>
            {s.success ? `Sent ${String(s.created_at).slice(5, 10)}` : 'Failed'}
          </span>
        );
      },
      searchValue: () => '',
      exportValue: (o) => {
        const s = o.row_type === 'so' ? msgStatuses?.[o.so_doc_no] : undefined;
        return s ? (s.success ? `Sent ${String(s.created_at).slice(0, 10)}` : 'Failed') : '';
      },
    },
    {
      /* Default-hidden since the 2026-07-22 header tidy — product brand rarely
         drives scheduling; re-show it from the Columns drawer when needed. */
      key: 'branding', label: 'Branding', width: 130, groupable: true, defaultHidden: true,
      accessor: (o) => o.branding ?? '—',
      searchValue: (o) => o.branding ?? '',
      groupValue: (o) => o.branding ?? '(none)',
    },
    /* Address + postcode default-SHOW since the owner's 2026-08-04 column pass:
       where the lorry is going is a planning question, not a detail lookup. */
    {
      key: 'address', label: 'Address', width: 220,
      accessor: (o) => o.address ?? '—',
      searchValue: (o) => o.address ?? '',
    },
    {
      key: 'postcode', label: 'Postcode', width: 100,
      accessor: (o) => o.postcode ?? '—',
      searchValue: (o) => o.postcode ?? '',
    },
    /* `building_type` ("Property") was REMOVED in the owner's 2026-08-04 column
       pass, and `house_type` took over its NAME — one "Building Type" column
       instead of two that nobody could tell apart. The API still sends
       building_type and PlanningOrder still types it; only this board stopped
       showing it. `possession_date` and `referral` went the same way: they
       answer a sales question, not a dispatch one. */
    {
      key: 'house_type', label: 'Building Type', width: 130, groupable: true, defaultHidden: true,
      accessor: (o) => o.house_type ?? '—',
      searchValue: (o) => o.house_type ?? '',
      groupValue: (o) => o.house_type ?? '(none)',
    },
    {
      key: 'replacement_disposal', label: 'Replacement / Disposal', width: 180, defaultHidden: true,
      accessor: (o) => o.replacement_disposal ?? '—',
      searchValue: (o) => o.replacement_disposal ?? '',
    },
    {
      /* The order's ACTUAL customer state (Kuala Lumpur / Selangor / Johor …).
         Key stays 'region' so existing saved column layouts keep this column
         visible in place — but it now shows the granular state, not the region
         BUCKET. The bucket is the tab row above; which states roll up into which
         bucket is owner-maintained in Delivery Regions. */
      key: 'region', label: 'State', width: 140, sortable: true, groupable: true,
      accessor: (o) => o.customer_state?.trim() || '—',
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
    },
    {
      key: 'so_date', label: 'SO Date', width: 120, sortable: true, defaultHidden: true,
      accessor: (o) => fmtDateOrDash(o.so_date),
      searchValue: (o) => o.so_date ?? '',
      sortFn: (a, b) => String(a.so_date ?? '').localeCompare(String(b.so_date ?? '')),
      filterType: 'date', dateValue: (o) => o.so_date,
    },
    {
      key: 'customer_delivery_date', label: 'Delivery Date', width: 130, sortable: true,
      accessor: (o) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtDateOrDash(o.customer_delivery_date)}
        </span>
      ),
      searchValue: (o) => o.customer_delivery_date ?? '',
      sortFn: (a, b) => String(a.customer_delivery_date ?? '').localeCompare(String(b.customer_delivery_date ?? '')),
      filterType: 'date', dateValue: (o) => o.customer_delivery_date,
    },
    /* Amendment dates (migration 0199). "Amended" (the date WE confirmed / the
       proposed delivery date) default-SHOWS — it's the firm date the board commits
       to. "Amend (Cust)" (the customer's requested new date) default-HIDES. The
       ORIGINAL "Delivery Date" column above is unchanged. */
    {
      key: 'amended_delivery_date', label: 'Est. New Delivery Date', width: 130, sortable: true,
      accessor: (o) => fmtDateOrDash(o.amended_delivery_date),
      searchValue: (o) => o.amended_delivery_date ?? '',
      sortFn: (a, b) => String(a.amended_delivery_date ?? '').localeCompare(String(b.amended_delivery_date ?? '')),
      filterType: 'date', dateValue: (o) => o.amended_delivery_date,
    },
    {
      key: 'amend_date_from_customer', label: 'Customer Request Date', width: 140, sortable: true, defaultHidden: true,
      accessor: (o) => fmtDateOrDash(o.amend_date_from_customer),
      searchValue: (o) => o.amend_date_from_customer ?? '',
      sortFn: (a, b) => String(a.amend_date_from_customer ?? '').localeCompare(String(b.amend_date_from_customer ?? '')),
      filterType: 'date', dateValue: (o) => o.amend_date_from_customer,
    },
    /* HC "Amend Client Date Reason" (migration 0201) — free-text reason paired
       with the amend dates above. default-HIDES (off in the Columns menu). */
    {
      key: 'amend_reason', label: 'Amend Reason', width: 200, defaultHidden: true,
      accessor: (o) => o.amend_reason ?? '—',
      searchValue: (o) => o.amend_reason ?? '',
    },
    {
      key: 'stock_remark', label: 'Stock', width: 170, groupable: true,
      /* ASSR + DP rows carry no stock/DO data → non-applicable. */
      /* The shared pill (components/StockRemarkPill.tsx), 2026-08-17. This cell
         used to carry its own third pair of hard-coded hexes keyed off
         stock_status while the SO list used grey text and ConsignmentOrders
         used the designed pill — one value, three looks. `|| o.stock_status`
         stays: readinessRowFields emits a remark for every stock-bearing row,
         and the fallback covers a row that predates it. */
      accessor: (o) => (isAssr(o) || isDp(o) ? <NotApplicable /> : (
        <StockRemarkPill remark={o.stock_remark || o.stock_status} />
      )),
      searchValue: (o) => (isAssr(o) || isDp(o) ? '' : `${o.stock_remark} ${o.stock_status}`.trim()),
      sortFn: (a, b) => stockRemarkSortFn(a.stock_remark || a.stock_status, b.stock_remark || b.stock_status),
      groupValue: (o) => (isAssr(o) || isDp(o) ? '(n/a)' : o.stock_status),
    },
    {
      /* "Delivery Status" on screen, `delivery_state` in the data (owner,
         2026-08-04). The column key, the stored column and DELIVERY_STATE_LABEL
         keep the old word — renaming those would touch the API contract and the
         override write path for a heading. */
      key: 'delivery_state', label: 'Delivery Status', width: 160, sortable: true, groupable: true,
      /* Inline-editable: writes a manual delivery_state override (wins over the
         derived state). Real stock readiness stays visible in the Stock column. */
      accessor: (o) => <StatusEditCell order={o} sched={sched} />,
      searchValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      groupValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      exportValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      sortFn: (a, b) => a.delivery_state.localeCompare(b.delivery_state),
    },
    /* ── Arrangement pipeline (derived server-side, lib/arrangement-stage.ts) —
       the sub-state WITHIN Pending Schedule (Pending Date Arrangement /
       Pending Time Arrangement / Time arranged) and the live trip the order
       sits on. Default-hidden (the Pending Schedule sub-count row and the Date /
       Time Arrangement pages carry the split); groupable so the board can be
       grouped by stage from the Columns menu. */
    {
      key: 'arrangement_stage', label: 'Arrangement', width: 180, groupable: true, defaultHidden: true,
      accessor: (o) => {
        const label = arrangementStageLabel(o);
        return label ? label : <NotApplicable />;
      },
      searchValue: (o) => arrangementStageLabel(o),
      groupValue: (o) => arrangementStageLabel(o) || '(not in pipeline)',
      exportValue: (o) => arrangementStageLabel(o),
    },
    {
      /* The live (non-CANCELLED) trip carrying this order's DELIVERY stop —
         "Time arranged" made concrete. '—' until the order is on a trip. */
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
      key: 'delivery_substatus', label: 'Sub-status', width: 150, groupable: true, defaultHidden: true,
      accessor: (o) => <SubstatusPill value={o.delivery_substatus} />,
      searchValue: (o) => o.delivery_substatus ?? '',
      groupValue: (o) => o.delivery_substatus ?? '(none)',
      exportValue: (o) => o.delivery_substatus ?? '',
    },
    {
      key: 'time_range', label: 'Time Slot', width: 120, defaultHidden: true,
      accessor: (o) => o.time_range ?? '—',
      searchValue: (o) => o.time_range ?? '',
    },
    {
      key: 'time_confirmed', label: 'Time Confirmed', width: 130, align: 'right', defaultHidden: true,
      accessor: (o) => (o.time_confirmed == null ? '—' : o.time_confirmed ? 'Yes' : 'No'),
      searchValue: (o) => (o.time_confirmed == null ? '' : o.time_confirmed ? 'Yes' : 'No'),
    },
    {
      key: 'arrival_at', label: 'Arrived At', width: 150, sortable: true, defaultHidden: true,
      accessor: (o) => dtOrDash(o.arrival_at),
      searchValue: (o) => o.arrival_at ?? '',
      sortFn: (a, b) => String(a.arrival_at ?? '').localeCompare(String(b.arrival_at ?? '')),
    },
    {
      key: 'departure_at', label: 'Departed At', width: 150, sortable: true, defaultHidden: true,
      accessor: (o) => dtOrDash(o.departure_at),
      searchValue: (o) => o.departure_at ?? '',
      sortFn: (a, b) => String(a.departure_at ?? '').localeCompare(String(b.departure_at ?? '')),
    },
    {
      key: 'shipout_date', label: 'Ship-out Date', width: 120, sortable: true, defaultHidden: !isEmSg,
      accessor: (o) => fmtDateOrDash(o.shipout_date),
      searchValue: (o) => o.shipout_date ?? '',
      sortFn: (a, b) => String(a.shipout_date ?? '').localeCompare(String(b.shipout_date ?? '')),
      filterType: 'date', dateValue: (o) => o.shipout_date,
    },
    {
      key: 'eta_arriving_port', label: 'ETA Port', width: 150, defaultHidden: !isEmSg,
      accessor: (o) => o.eta_arriving_port ?? '—',
      searchValue: (o) => o.eta_arriving_port ?? '',
    },
    /* EM-region cross-border transit-warehouse arrival date (migration 0199).
       Default-HIDDEN, but auto-SHOWS on the EM/SG region tabs like shipout / ETA
       (these cross-border columns only matter for the EM trip). */
    {
      key: 'arrives_em_warehouse_date', label: 'Arrives EM Warehouse', width: 150, sortable: true, defaultHidden: !isEmSg,
      accessor: (o) => fmtDateOrDash(o.arrives_em_warehouse_date),
      searchValue: (o) => o.arrives_em_warehouse_date ?? '',
      sortFn: (a, b) => String(a.arrives_em_warehouse_date ?? '').localeCompare(String(b.arrives_em_warehouse_date ?? '')),
      filterType: 'date', dateValue: (o) => o.arrives_em_warehouse_date,
    },
    /* Crew — split into the HC delivery-sheet columns. Driver + Lorry show by
       default; IC / contact / driver 2 / helpers are in the show/hide menu. */
    {
      /* Inline-editable: assigns the trip driver (writes driverId; the backend
         find-or-creates the trip + appends the stop). */
      key: 'driver', label: 'Driver', width: 160,
      accessor: (o) => <DriverEditCell order={o} sched={sched} drivers={drivers} />,
      searchValue: (o) => o.crew?.driver_1_name ?? '',
      exportValue: (o) => o.crew?.driver_1_name ?? '',
    },
    {
      key: 'driver_ic', label: 'Driver IC', width: 140, defaultHidden: true,
      accessor: (o) => o.crew?.driver_1_ic || <span style={{ color: '#767b6e' }}>—</span>,
      searchValue: (o) => o.crew?.driver_1_ic ?? '',
    },
    {
      key: 'driver_contact', label: 'Driver Contact', width: 150, defaultHidden: true,
      accessor: (o) => (o.crew?.driver_1_contact ? formatPhone(o.crew.driver_1_contact) || o.crew.driver_1_contact : <span style={{ color: '#767b6e' }}>—</span>),
      searchValue: (o) => o.crew?.driver_1_contact ?? '',
    },
    {
      key: 'driver_2', label: 'Driver 2', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.driver_2_name || <span style={{ color: '#767b6e' }}>—</span>,
      searchValue: (o) => o.crew?.driver_2_name ?? '',
    },
    {
      key: 'helper_1', label: 'Helper 1', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.helper_1_name || <span style={{ color: '#767b6e' }}>—</span>,
      searchValue: (o) => o.crew?.helper_1_name ?? '',
    },
    {
      key: 'helper_2', label: 'Helper 2', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.helper_2_name || <span style={{ color: '#767b6e' }}>—</span>,
      searchValue: (o) => o.crew?.helper_2_name ?? '',
    },
    {
      /* Inline-editable: assigns the trip lorry (writes lorryId). */
      key: 'lorry', label: 'Lorry', width: 150,
      accessor: (o) => <LorryEditCell order={o} sched={sched} lorries={lorries} />,
      searchValue: (o) => o.crew?.lorry_plate ?? '',
      exportValue: (o) => o.crew?.lorry_plate ?? '',
    },
    {
      /* Default-HIDDEN since the 2026-08-04 tidy-up. The release gate — which is
         what a dispatcher actually needs from the money side — already rides on
         the row; the raw balance is a finance figure, and it is 0 on every ASSR /
         DP / project row by construction. */
      key: 'balance_centi', label: 'Balance', width: 130, align: 'right', sortable: true, defaultHidden: true,
      /* Below zero is an OVER-COLLECTION, not a settled row — it must not share
         the muted grey that means "nothing owed" (owner 2026-08-16). */
      accessor: (o) => (
        <span style={{
          fontFamily: 'var(--font-mark)',
          fontWeight: 700,
          color: liveBalance(o) < 0 ? 'var(--c-festive-b, #B8331F)' : liveBalance(o) > 0 ? '#0c3f39' : '#767b6e',
        }}>
          {fmtCenti(liveBalance(o))}
        </span>
      ),
      searchValue: (o) => String(liveBalance(o)),
      exportValue: (o) => liveBalance(o) / 100,
      sortFn: (a, b) => liveBalance(a) - liveBalance(b),
      numberValue: (o) => liveBalance(o) / 100,
    },
    {
      key: 'do', label: 'DO No.', width: 130, groupable: true,
      accessor: (o) => (o.delivery_orders.length > 0 ? o.delivery_orders.map((d) => d.do_number).join(', ') : '—'),
      searchValue: (o) => o.delivery_orders.map((d) => d.do_number).join(' '),
    },
    /* DO Date — the latest DO's OWN document date (delivery_orders.do_date), from
       the same latest-DO lookup the crew / HC fields use. Default-HIDDEN since
       the 2026-08-04 tidy-up: the DO column beside it already says whether a DO
       exists, which is the planning question; its document date is a lookup, and
       it is blank on every ASSR / DP / project row. */
    {
      key: 'do_date', label: 'DO Date', width: 120, sortable: true, defaultHidden: true,
      accessor: (o) => fmtDateOrDash(o.do_date),
      searchValue: (o) => o.do_date ?? '',
      sortFn: (a, b) => String(a.do_date ?? '').localeCompare(String(b.do_date ?? '')),
      filterType: 'date', dateValue: (o) => o.do_date,
    },
    ];
    // Stable sort into the default header order above (unlisted keys keep
    // their definition order at the end).
    return cols.sort((a, b) => (pos.get(a.key) ?? 999) - (pos.get(b.key) ?? 999));
  // The EM/SG cross-border default-show (isEmSg) depends on activeRegion →
  // recompute the columns on region change. The editable Status/Date/Driver/Lorry
  // accessors close over `sched` + the driver/lorry option lists, so they join the
  // deps (a new driver/lorry list must re-render the pickers).
  }, [isEmSg, sched, drivers, lorries, msgStatuses]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Map-open column narrowing: everything NOT in the override hides at render
     time (DataGrid overlayHidden). The user's persisted layout is untouched —
     closing the map returns their own column set exactly as saved. */
  const overlayHidden = useMemo<string[] | undefined>(() => {
    if (!visibleColumnsOverride || visibleColumnsOverride.length === 0) return undefined;
    const keep = new Set(visibleColumnsOverride);
    return columns.map((c) => c.key).filter((k) => !keep.has(k));
  }, [columns, visibleColumnsOverride]);

  return (
    <div className="space-y-4">
      {/* 4 STATE TABS (top row) — only on the full board (DeliveryPlanning).
          Pending Delivery / Pending Schedule / Overdue / Delivered, with counts.
          OVERDUE keeps its red tone so a backlog reads at a glance. */}
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

      {/* Pending Schedule sub-split (derived arrangement stages) — visible only
          on that tab, in the tab-badge idiom: Pending Date Arrangement (needs a
          date → Delivery Date Arrangement page) vs Date arranged, with the time
          side's split in brackets. A count line, not a second tab rail. */}
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

      {/* REGION chip row — the CONFIG-DRIVEN buckets from the API master (All +
          whatever the owner maintains in Delivery Regions). SG (by code) is
          dashed-teal (cross-border). Classified by customer state. */}
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

      {/* Compact bulk-edit bar — appears once one or more rows are ticked.
          "<N> selected · Set [field] → [value] [Apply]" mass-writes one field
          across every selected SO via useScheduleDelivery; the value control's
          TYPE follows the chosen field. Page-specific actions (Convert to DO,
          Schedule) are injected via `bulkExtras` on the right. */}
      {selectedKeys.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{selectedKeys.size} selected</span>
          <span className={styles.bulkSep}>·</span>
          <span className={styles.bulkLabel}>Set</span>
          <select
            className={styles.bulkControl}
            style={{ minWidth: 130 }}
            value={bulkField}
            disabled={bulkBusy}
            onChange={(e) => changeBulkField(e.target.value as typeof bulkField)}
            aria-label="Bulk-edit field"
          >
            <option value="STATUS">Status</option>
            <option value="DATE">Delivery date</option>
            <option value="DRIVER">Driver</option>
            <option value="LORRY">Lorry</option>
          </select>
          <span className={styles.bulkLabel}>&rarr;</span>
          {/* Value control — type depends on the field. */}
          {bulkField === 'STATUS' && (
            <select
              className={styles.bulkControl}
              value={bulkValue}
              disabled={bulkBusy}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label="New status"
            >
              <option value="">Choose status…</option>
              {DELIVERY_STATES.map((s) => (
                <option key={s} value={s}>{DELIVERY_STATE_LABEL[s]}</option>
              ))}
            </select>
          )}
          {bulkField === 'DATE' && (
            <input
              type="date"
              className={styles.bulkControl}
              value={bulkValue}
              disabled={bulkBusy}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label="New delivery date"
            />
          )}
          {bulkField === 'DRIVER' && (
            <select
              className={styles.bulkControl}
              value={bulkValue}
              disabled={bulkBusy}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label="New driver"
            >
              <option value="">Unassign / choose driver…</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          {bulkField === 'LORRY' && (
            <select
              className={styles.bulkControl}
              value={bulkValue}
              disabled={bulkBusy}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label="New lorry"
            >
              <option value="">Unassign / choose lorry…</option>
              {lorries.map((l) => (
                <option key={l.id} value={l.id}>{l.plate}</option>
              ))}
            </select>
          )}
          <Button
            variant="primary"
            disabled={bulkBusy || (bulkField === 'STATUS' && !bulkValue)}
            onClick={() => void applyBulk()}
          >
            {bulkBusy ? 'Applying…' : 'Apply'}
          </Button>

          <span className={styles.bulkSpacer} />

          {bulkExtras}

          <Button variant="ghost" onClick={onClearSelection} title="Clear selection">x</Button>
        </div>
      )}

      <DataGrid
        rows={rows}
        columns={columns}
        storageKey={storageKey}
        exportName={exportName}
        rowKey={rowIdOf}
        searchPlaceholder={searchPlaceholder}
        groupBanner={false}
        isLoading={isLoading}
        emptyMessage={emptyMessage}
        /* First-class multi-select (prefixed so:/assr: keys) → the bulk bar. The
           bulk actions themselves are SO-only (see soDocNosFromSelection). */
        selectable={{
          selectedKeys,
          onToggle,
          onToggleAll,
        }}
        onRowDoubleClick={onRowDoubleClick}
        expandable={{
          /* Line-item drill-down is SO-only (ASSR/DP/project rows carry no SO lines). */
          renderExpansion: (row) => (isAssr(row) || isDp(row) || isProject(row) ? null : <PlanningExpandedLines docNo={row.so_doc_no} />),
          /* Falsy key suppresses the expand chevron for non-SO rows. */
          rowExpansionKey: (row) => (isAssr(row) || isDp(row) || isProject(row) ? '' : row.so_doc_no),
        }}
        rowStyle={(o) => (o.region === 'SG' ? { boxShadow: 'inset 3px 0 0 #2f5d4f' } : undefined)}
        contextMenu={contextMenu}
        defaultSort={defaultSort}
        onRowClick={onRowClick}
        scrollToRow={scrollToRow}
        overlayHidden={overlayHidden}
        onUserAdjustColumns={onUserAdjustColumns}
      />
    </div>
  );
}
