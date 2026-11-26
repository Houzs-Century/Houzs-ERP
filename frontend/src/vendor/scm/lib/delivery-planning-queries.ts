
import { rememberSavedCrew, withSavedCrew, type CrewSnapshot } from './saved-crew';
import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { scheduleRowRefresh } from './board-row-refresh';
import { invalidateSoLists } from './sales-order-queries';
import { serviceNotify } from './dialog-service';
import { idempotentInit, newIdempotencyKey } from '../../../lib/idempotency';
import { soExemptionExpiryOf } from '../../../lib/so-exemption-expiry';

export const DELIVERY_STATES = [
  'PENDING_DELIVERY', 'PENDING_SCHEDULE', 'OVERDUE', 'DELIVERED',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_STATE_LABEL: Record<DeliveryState, string> = {
  PENDING_DELIVERY: 'Pending Delivery',
  PENDING_SCHEDULE: 'Pending Schedule',
  OVERDUE: 'Overdue',
  DELIVERED: 'Delivered',
};

export const sxeDateOf = (o: PlanningOrder): string | null => {
  if (o.row_type === 'assr') return o.customer_delivery_date ?? null;
  if (o.row_type === 'so') return soExemptionExpiryOf(o) ?? null;
  return o.ac_sales_exemption_expiry ?? null;
};

/* The customer-message follow-up workflow statuses shown/edited in the "Delivery
   Status" column (owner 2026-09-22). The backend whitelists this exact set; the
   label IS the value. `(D)` = original delivery-date round, `(A)` = amended round.
   The coarse DELIVERY_STATES above (the top state tabs) is a SEPARATE, derived
   field — the tabs get their own rework later. */
export const MESSAGE_STATUSES = [
  'To Send Delivery Date', 'Done Send',
  'To Send Driver Info', 'Done Driver Information',
  'To Send Collect Balance', 'Done Balance Collection',
  'To Send Postpone Reason', 'Done Postpone Reason',
  'To Send Postage', 'Done Postage',
  'Done Amend', 'Done Delivered',
  'To Remind Customer Reply (1)', 'To Remind Customer Reply (2)', 'To Remind Customer Reply (3)',
  'Done Remind (1)', 'Done Remind (2)', 'Done Remind (3)',
  'Done Scheduling', 'Pending Reschedule (D)',
  'Not Sent (D)', 'Not Sent (A)', 'Invalid Data',
  // East Malaysia / Singapore shipping + the (A)-round reschedule and customer-reply
  // statuses the HC Delivery sheet actually uses — added so the sheet backfill's
  // real statuses are first-class dropdown values (owner 2026-10-22).
  'Done Shipout', 'Pending Delivery (EM)', 'Customer Confirm Shipment',
  'Pending Reschedule (A)', 'Pending Customer Reply (D)',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/* Chip colours copied from the HC Delivery sheet's dropdown (HC-0188, Syu
   2026-10-30) so the board reads the same at a glance. Sheet rule: "To Send ..."
   light yellow, "Done ..." dark brown, Pending Reschedule dark red, Not Sent light
   red, To Remind light purple. Statuses the sheet screenshot did not show follow
   the same rule. A Record so a new status cannot ship without a colour. */
type Chip = { bg: string; fg: string };
const BLUE: Chip = { bg: '#bfe1f6', fg: '#0a53a8' };
const TEAL: Chip = { bg: '#c6dbe1', fg: '#215a6c' };
const YELLOW: Chip = { bg: '#ffe5a0', fg: '#473822' };
const BROWN: Chip = { bg: '#473822', fg: '#ffe5a0' };
const RED: Chip = { bg: '#b10202', fg: '#ffcfc9' };
const PINK: Chip = { bg: '#ffcfc9', fg: '#b10202' };
const PURPLE: Chip = { bg: '#e6cff2', fg: '#5a3286' };
const RUST: Chip = { bg: '#753800', fg: '#ffc8aa' };
const ORANGE: Chip = { bg: '#ffc8aa', fg: '#753800' };
const GREEN: Chip = { bg: '#d4edbc', fg: '#11734b' };
export const MESSAGE_STATUS_CHIP: Record<MessageStatus, Chip> = {
  'To Send Delivery Date': BLUE, 'Done Send': BROWN,
  'To Send Driver Info': YELLOW, 'Done Driver Information': BROWN,
  'To Send Collect Balance': YELLOW, 'Done Balance Collection': BROWN,
  'To Send Postpone Reason': YELLOW, 'Done Postpone Reason': BROWN,
  'To Send Postage': YELLOW, 'Done Postage': BROWN,
  'Done Amend': BROWN, 'Done Delivered': BROWN,
  'To Remind Customer Reply (1)': PURPLE, 'To Remind Customer Reply (2)': PURPLE,
  'To Remind Customer Reply (3)': PURPLE,
  'Done Remind (1)': TEAL, 'Done Remind (2)': TEAL, 'Done Remind (3)': TEAL,
  'Done Scheduling': BROWN, 'Pending Reschedule (D)': RED,
  'Not Sent (D)': PINK, 'Not Sent (A)': PINK, 'Invalid Data': RUST,
  'Done Shipout': BROWN, 'Pending Delivery (EM)': ORANGE, 'Customer Confirm Shipment': GREEN,
  'Pending Reschedule (A)': RED, 'Pending Customer Reply (D)': TEAL,
};
export const messageStatusChip = (s: string | null | undefined): Chip | undefined =>
  s ? MESSAGE_STATUS_CHIP[s as MessageStatus] : undefined;

/* Preset amend / reschedule reasons (owner 2026-09-22) — the reason the amend
   message gives the customer. Picked from a dropdown; free text still allowed. */
export const AMEND_REASONS = [
  'Unexpected transport scheduling issues',
  'Unforeseen medical leave for our assigned driver',
  'Sudden mechanical breakdown of our delivery vehicle',
  'Unavoidable technical issues with our transport arrangement',
  'Our strict quality control checks',
  'Materials being temporarily out of stock',
  'Unforeseen production constraints',
] as const;

export type RegionCode = string;
export type RegionKey = 'ALL' | RegionCode;

export type PlanningRowType = 'so' | 'assr' | 'dp' | 'project';
export type AssrJobKind = 'customer_pickup' | 'delivery' | 'inspection';

export type PlanningOrder = {
  row_type: PlanningRowType;
  dp_job_type?: string | null;
  dp_no?: string | null;
  dp_from_name?: string | null;
  assr_id: number | null;
  ref: string | null;
  job_kind: AssrJobKind | null;
  so_doc_no: string;
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  /* Sales context (owner 2026-08-19) — who sold it + the sales venue. `agent`
     is free text (sometimes a raw UUID); resolve to a display name via
     useStaffLookup(agent, salesperson_id), never render either raw. null on
     ASSR / DP rows; project rows fill `venue` with the PMS event venue.
     Optional (`?`) so a cached pre-upgrade payload still typechecks. */
  agent?: string | null;
  salesperson_id?: string | null;
  venue?: string | null;
  branding: string | null;
  status: string;
  delivery_state: DeliveryState;
  delivery_state_override: string | null;
  /* The customer-message follow-up workflow status (owner 2026-09-22) — one of
     MESSAGE_STATUSES or null. SO rows only; null on ASSR / DP / project rows. */
  delivery_message_status: string | null;
  /* Delivery-planning admin free-text fields (owner 2026-09-22). SO rows only. */
  disposal_request: string | null;
  dp_remark: string | null;
  balance_sen: number;
  balance_sen_live: number | null;
  local_total_sen: number;
  so_date: string | null;
  customer_delivery_date: string | null;
  /* The REAL AutoCount sales-exemption expiry (public.sales_orders.expiry_date,
     keyed by linked_ac_docno), server-derived for SO rows; null off-book and on
     synthetic (ASSR/DP/project) rows. Drives the board's "Sales Exemption Expiry
     Date" column (owner 2026-10-15). */
  ac_sales_exemption_expiry?: string | null;
  /* The FROZEN original delivery date (BUG-51). With ac_sales_exemption_expiry and
     customer_delivery_date it feeds soExemptionExpiryOf — the SAME "Sales Exemption
     Expiry Date" value the SO list shows (owner 2026-10-22). Null off-book / on
     synthetic (ASSR / DP / project) rows. */
  sales_exemption_expiry?: string | null;
  amend_date_from_customer: string | null;
  amended_delivery_date: string | null;
  amend_reason: string | null;
  amend_reason_from_customer?: string | null;
  effective_delivery_date: string | null;
  processing_date: string | null;
  /* Owner 2026-08-12 (every company since 2026-11-09) — a live PO already claims one of this SO's
     lines, so the SO is soft-locked with no processing date involved. Read by
     DeliveryFieldsDrawer's procLockActive call to route a replacement_disposal
     change into an amendment instead of a direct save. */
  po_locked: boolean | null;
  days_left: number | null;
  address: string | null;
  postcode: string | null;
  building_type: string | null;
  possession_date: string | null;
  house_type: string | null;
  replacement_disposal: string | null;
  referral: string | null;
  /* Reference (owner 2026-09-15) — the order's own reference, `mfg_sales_orders.ref`
     (AutoCount Ref, e.g. pg0791; the delivery sheet's Ref column). NOT `referral`,
     which is the HC referral channel and is empty on every order. SO rows only. */
  so_ref?: string | null;
  /* A Service-Case row's ORIGINAL order DO numbers, back-filled (owner 2026-11-11):
     the DO No. column shows these when the row has no DO of its own. ASSR rows only
     (null on SO/DP/project). An SO row's own DOs stay in delivery_orders. */
  related_do_nos?: string[] | null;
  /* PO No. (owner 2026-09-15) — the purchase orders RAISED from this SO, the
     SO list's raised-PO chips. SO rows only; absent on ASSR / DP / project rows. */
  po_nos?: string[];
  time_range: string | null;
  time_confirmed: boolean | null;
  arrival_at: string | null;
  departure_at: string | null;
  shipout_date: string | null;
  customer_delivered_date: string | null;
  eta_arriving_port: string | null;
  delivery_substatus: string | null;
  arrives_em_warehouse_date: string | null;
  /* EM cross-border transport status (owner 2026-09-23) — the ESB sea-freight
     leg + the BS last-mile leg, back-filled by the two 3PL transporters. From
     the latest DO; null when no DO. */
  em_delivery_status: string | null;
  consignment_no: string | null;
  vessel_voyage: string | null;
  etd_port_klang: string | null;
  bs_delivery_date: string | null;
  esb_remarks: string | null;
  bs_remarks: string | null;
  ctn: string | null;
  em_delivered_date: string | null;
  do_date: string | null;
  has_pod?: boolean;
  delivered_at?: string | null;
  pod_r2_key?: string | null;
  pod_lat?: number | null;
  stock_status: string;
  stock_remark: string;
  is_main_ready: boolean;
  is_ship_ready: boolean;
  company_code?: string | null;
  remark_locked?: boolean;
  region: RegionCode;
  regions: RegionCode[];
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  customer_state: string | null;
  customer_country?: string | null;
  delivered_qty: number;
  remaining_qty: number;
  crew: {
    driver: string | null; helper: string | null; lorry: string | null;
    driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
    driver_2_name: string | null;
    helper_1_name: string | null; helper_2_name: string | null;
    lorry_plate: string | null;
    driver_1_typed?: boolean;
  } | null;
  delivery_orders: Array<{ id: string; do_number: string; status: string }>;
  /* ── Arrangement pipeline (owner spec 2026-08-07) — DERIVED server-side by
     backend lib/arrangement-stage.ts and stamped on every row; the frontends
     read the field and never re-derive (one shared logic layer):
       PENDING_DATE  — in Pending Schedule, delivery date not yet confirmed
                       (amended_delivery_date null) → Delivery Date Arrangement.
       PENDING_TIME  — date confirmed, not on a live trip → the Delivery Time
                       Arrangement inbox. (== "Date arranged" on the date side.)
       TIME_ARRANGED — assigned onto a non-CANCELLED trip.
     null outside Pending Schedule. Optional (`?`) so a cached pre-upgrade
     payload still typechecks; a missing field degrades to the un-split view. */
  arrangement_stage?: ArrangementStage | null;
  trip_id?: string | null;
  trip_no?: string | null;
  trip_date?: string | null;
  trip_stop_no?: number | null;
  trip_eta_offset_s?: number | null;
};

export type ArrangementStage = 'PENDING_DATE' | 'PENDING_TIME' | 'TIME_ARRANGED';

export const ARRANGEMENT_STAGE_LABEL: Record<ArrangementStage, string> = {
  PENDING_DATE: 'Pending Date Arrangement',
  PENDING_TIME: 'Pending Time Arrangement',
  TIME_ARRANGED: 'Time arranged',
};

export type DateArrangement = 'PENDING_DATE' | 'DATE_ARRANGED';
export const DATE_ARRANGEMENT_LABEL: Record<DateArrangement, string> = {
  PENDING_DATE: 'Pending Date Arrangement',
  DATE_ARRANGED: 'Date arranged',
};

export function dateArrangementOf(o: Pick<PlanningOrder, 'arrangement_stage'>): DateArrangement | null {
  const stage = o.arrangement_stage;
  if (stage === undefined) return 'PENDING_DATE';
  if (stage === null) return null;
  return stage === 'PENDING_DATE' ? 'PENDING_DATE' : 'DATE_ARRANGED';
}

export type TimeArrangement = 'PENDING_TIME' | 'TIME_ARRANGED';
export function timeArrangementOf(o: Pick<PlanningOrder, 'arrangement_stage'>): TimeArrangement | null {
  const stage = o.arrangement_stage;
  if (stage === undefined) return 'PENDING_TIME';
  if (stage === 'PENDING_TIME' || stage === 'TIME_ARRANGED') return stage;
  return null;
}

export function arrangementStageLabel(o: Pick<PlanningOrder, 'arrangement_stage'>): string {
  const stage = o.arrangement_stage;
  if (stage == null) return '';
  return ARRANGEMENT_STAGE_LABEL[stage] ?? '';
}

export type PlanningCounts = Record<'ALL' | DeliveryState, number>;

export type PlanningResponse = {
  orders: PlanningOrder[];
  counts: PlanningCounts;
  regions: Array<{ key: RegionKey; label: string }>;
  delivered_by_region?: Record<string, number>;
};

/* ── Client-side region bucketing (owner 2026-10-19 "filter 没反应") ───────────
   The board fetches EVERY region once (region=ALL) and filters by the active
   region chip HERE, in the browser — the same instant, no-refetch pattern the
   state tabs already use (DeliveryPlanningBoard filters delivery_state locally)
   and the mobile board already uses. A per-region fetch re-ran the whole server
   board assembly (~3.7k SOs + DOs + crew + trips) on every chip click, so the
   region row felt frozen; locally it is instant. Exact twin of the backend's
   matchesRegion (routes/delivery-planning.ts): 'ALL'/'' → no filter; a KNOWN
   bucket code → keep orders whose regions[] include it; an unknown code → no-op
   (defensive — a stale/renamed region param never blanks the board). */
export function filterOrdersByRegion<T extends { regions: RegionCode[] }>(
  orders: readonly T[],
  region: string,
  knownRegionKeys: ReadonlySet<string>,
): T[] {
  if (region === 'ALL' || region === '' || !knownRegionKeys.has(region)) return [...orders];
  return orders.filter((o) => o.regions.includes(region));
}

export function planningCountsFrom(
  orders: readonly Pick<PlanningOrder, 'delivery_state'>[],
): PlanningCounts {
  const counts = { ALL: orders.length } as PlanningCounts;
  for (const s of DELIVERY_STATES) counts[s] = 0;
  for (const o of orders) counts[o.delivery_state] += 1;
  return counts;
}

export function useDeliveryPlanning(opts: { region?: string; state?: string }) {
  const region = opts.region ?? 'ALL';
  const state = opts.state ?? 'ALL';
  return useQuery({
    queryKey: ['delivery-planning', region, state],
    queryFn: () => {
      const params = new URLSearchParams();
      if (region !== 'ALL') params.set('region', region);
      if (state !== 'ALL') params.set('state', state);
      const qs = params.toString();
      return authedFetch<PlanningResponse>(`/delivery-planning${qs ? `?${qs}` : ''}`);
    },
    placeholderData: (prev) => prev,
    select: withSavedCrew,
    staleTime: 30_000,
  });
}

export type PlanningLineItem = {
  id: string;
  doc_no: string | null;
  item_group: string | null;
  item_code: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number | null;
  unit_price_sen: number | null;
  discount_sen: number | null;
  total_sen: number | null;
  variants: Record<string, unknown> | null;
  stock_status: string | null;
  cancelled: boolean | null;
};

export function useDeliveryPlanningLines(docNo: string | null | undefined) {
  return useQuery({
    queryKey: ['delivery-planning', 'lines', docNo],
    enabled: !!docNo,
    queryFn: () =>
      authedFetch<{ items: PlanningLineItem[] }>(
        `/delivery-planning/${encodeURIComponent(docNo!)}/lines`,
      ).then((r) => r.items),
    staleTime: 30_000,
  });
}

export const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;
export type HcSubstatus = (typeof HC_SUBSTATUS_VALUES)[number];

export type HcFieldsPatch = {
  possessionDate?: string | null;
  houseType?: string | null;
  replacementDisposal?: string | null;
  referral?: string | null;
  deliveryMessageStatus?: string | null;
  disposalRequest?: string | null;
  dpRemark?: string | null;
  amendReason?: string | null;
  timeRange?: string | null;
  jobKind?: AssrJobKind;
  timeConfirmed?: boolean | null;
  arrivalAt?: string | null;
  departureAt?: string | null;
  shipoutDate?: string | null;
  customerDeliveredDate?: string | null;
  etaArrivingPort?: string | null;
  deliverySubstatus?: string | null;
  // EM cross-border transport status (owner 2026-09-23) — ESB + BS legs.
  emDeliveryStatus?: string | null;
  consignmentNo?: string | null;
  vesselVoyage?: string | null;
  etdPortKlang?: string | null;
  bsDeliveryDate?: string | null;
  esbRemarks?: string | null;
  bsRemarks?: string | null;
  ctn?: string | null;
  emDeliveredDate?: string | null;
};

export type HcFieldsResult = {
  ok: true;
  written: { so: boolean; do: boolean };
  do_id: string | null;
  so_doc_no: string | null;
  no_do_hint: string | null;
};

export const BOARD_REFRESH_MS = 500;
let boardRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let boardRefreshQc: QueryClient | null = null;
const boardRefreshKeys = new Map<string, readonly unknown[]>();

export function scheduleBoardRefresh(qc: QueryClient, keys: readonly (readonly unknown[])[]): void {
  boardRefreshQc = qc;
  for (const key of keys) boardRefreshKeys.set(JSON.stringify(key), key);
  if (boardRefreshTimer) clearTimeout(boardRefreshTimer);
  boardRefreshTimer = setTimeout(() => {
    boardRefreshTimer = null;
    const client = boardRefreshQc;
    const toInvalidate = [...boardRefreshKeys.values()];
    boardRefreshKeys.clear();
    boardRefreshQc = null;
    if (!client) return;
    for (const key of toInvalidate) void client.invalidateQueries({ queryKey: key });
  }, BOARD_REFRESH_MS);
}

const SO_FIELD_COLUMNS = [
  ['possessionDate', 'possession_date'],
  ['houseType', 'house_type'],
  ['replacementDisposal', 'replacement_disposal'],
  ['referral', 'referral'],
  ['deliveryMessageStatus', 'delivery_message_status'],
  ['disposalRequest', 'disposal_request'],
  ['dpRemark', 'dp_remark'],
  ['amendReason', 'amend_reason'],
] as const satisfies ReadonlyArray<readonly [keyof HcFieldsPatch, keyof PlanningOrder]>;

export function useUpdateDeliveryFields() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, ...body }: { type: 'so' | 'do' | 'dp' | 'assr' | 'project'; id: string } & HcFieldsPatch) =>
      authedFetch<HcFieldsResult>(`/delivery-planning/${type}/${encodeURIComponent(id)}/fields`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    /* HC-0175: without this the inline select snapped back to the old status and
       only showed the pick after the PATCH plus the row re-read, several seconds.
       SO-context fields only: they land on the SO whether or not a DO exists.
       A Service Case job takes the same patch: its re-read is the whole board. */
    onMutate: async (vars) => {
      if (vars.type !== 'so' && vars.type !== 'assr') return { snapshots: [] };
      const isTarget = (o: PlanningOrder) => (vars.type === 'so'
        ? o.row_type === 'so' && o.so_doc_no === vars.id
        : o.row_type === 'assr' && String(o.assr_id) === vars.id && o.job_kind === vars.jobKind);
      const patch: Partial<PlanningOrder> = {};
      for (const [from, to] of SO_FIELD_COLUMNS) {
        if (vars[from] !== undefined) (patch as Record<string, unknown>)[to] = vars[from] || null;
      }
      if (Object.keys(patch).length === 0) return { snapshots: [] };
      await qc.cancelQueries({ queryKey: ['delivery-planning'] });
      const snapshots: Array<[readonly unknown[], PlanningResponse]> = [];
      for (const [key, prev] of qc.getQueriesData<PlanningResponse>({ queryKey: ['delivery-planning'] })) {
        if (!prev || !Array.isArray(prev.orders)) continue;
        snapshots.push([key, prev]);
        qc.setQueryData<PlanningResponse>(key, {
          ...prev,
          orders: prev.orders.map((o) => (isTarget(o) ? { ...o, ...patch } : o)),
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, prev] of ctx?.snapshots ?? []) qc.setQueryData(key, prev);
    },
    onSuccess: (_res, vars) => (vars.type === 'so'
      ? scheduleRowRefresh(qc, [vars.id])
      : scheduleBoardRefresh(qc, [['delivery-planning']])),
  });
}

export const DP_JOB_TYPES = [
  'DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP', 'INSPECTION',
  /* Job types 8 and 9, from the owner's 2026-08-03 list (mig 0250). Listed here
     so the board LABELS them; what the create drawer offers is
     DP_CREATABLE_JOB_TYPES below, which they join with their pickers. */
  'TRANSFER', 'LORRY_SERVICE',
] as const;
export type DpJobType = (typeof DP_JOB_TYPES)[number];

export const DP_JOB_TYPE_LABEL: Record<DpJobType, string> = {
  DELIVERY: 'Delivery',
  PICKUP: 'Pickup',
  SERVICE: 'Service',
  SETUP: 'Setup',
  DISMANTLE: 'Dismantle',
  SUPPLIER_PICKUP: 'Supplier Pickup',
  INSPECTION: 'Inspection',
  TRANSFER: 'Transfer Item',
  LORRY_SERVICE: 'Lorry Service',
};

/* ── The nine things New DP Order can start ───────────────────────────────────
   Owner, 2026-08-03, in his own words and his own order: Setup / Dismantle /
   Supplier / Transfer item / Lorry service / ASSR-Inspection / ASSR-Pickup /
   ASSR-Service / Delivery order.

   FIVE OF THEM CREATE A JOB; FOUR SCHEDULE ONE THAT ALREADY EXISTS, and that
   split is the whole design. A delivery order and the three ASSR legs are
   already ON the board, synthesised from their own document (the SO/DO, or the
   service case's dates). Creating a dp_order for them would either double the
   line or — if it carried the source ref — be swallowed by the board's
   anti-double-count guard and vanish. So those four entries pick the existing
   document and write the date onto it through the same schedule path the board
   itself uses. Nothing is inserted, the guard is untouched, and the operator
   still gets one menu with nine things on it.

   ASSR-SERVICE IS THE DELIVERY LEG, RENAMED (owner's call, 2026-08-03): the
   trip where we bring a repaired item back to the customer. Same leg, same
   assr_cases.do_date, new name — see ASSR_JOB_KIND_LABEL. */
export type DpEntry =
  | { key: string; label: string; mode: 'create'; jobType: DpJobType }
  | { key: string; label: string; mode: 'schedule'; scheduleType: 'so' }
  | { key: string; label: string; mode: 'schedule'; scheduleType: 'assr'; jobKind: AssrJobKind };

export const DP_ENTRY_MENU: readonly DpEntry[] = [
  { key: 'SETUP',           label: 'Setup',            mode: 'create', jobType: 'SETUP' },
  { key: 'DISMANTLE',       label: 'Dismantle',        mode: 'create', jobType: 'DISMANTLE' },
  { key: 'SUPPLIER_PICKUP', label: 'Supplier',         mode: 'create', jobType: 'SUPPLIER_PICKUP' },
  { key: 'TRANSFER',        label: 'Transfer item',    mode: 'create', jobType: 'TRANSFER' },
  { key: 'LORRY_SERVICE',   label: 'Lorry service',    mode: 'create', jobType: 'LORRY_SERVICE' },
  { key: 'ASSR_INSPECTION', label: 'ASSR - Inspection', mode: 'schedule', scheduleType: 'assr', jobKind: 'inspection' },
  { key: 'ASSR_PICKUP',     label: 'ASSR - Pickup',    mode: 'schedule', scheduleType: 'assr', jobKind: 'customer_pickup' },
  { key: 'ASSR_SERVICE',    label: 'ASSR - Service',   mode: 'schedule', scheduleType: 'assr', jobKind: 'delivery' },
  { key: 'DELIVERY_ORDER',  label: 'Delivery order',   mode: 'schedule', scheduleType: 'so' },
  /* A delivery with no sales order (owner 2026-11-20, option A): a sample, a
     replacement part, a favour - typed customer, address and postcode, on Last
     Mile and Trip Pay like any job, no stock and no DO. Create-mode with NO
     so_doc_no, so the board lists it as a DP job (the union guard below). */
  { key: 'DELIVERY_MANUAL', label: 'Delivery (no SO)', mode: 'create', jobType: 'DELIVERY' },
] as const;

/* The create-mode job types, derived rather than listed twice — the menu above
   is the single place an entry is declared. Kept as an export because the
   "which types are safe to insert" question is asked in its own right: a
   create-mode entry's source must set project_id / supplier_id / workshop_id /
   lorry_id / stock_transfer_id / warehouse_id and NEVER so_doc_no, which is what
   the board's union guard filters on (delivery-planning.ts:
   `.is('so_doc_no', null)...`). That is exactly why an SO-backed DELIVERY and
   the ASSR legs are schedule-mode instead — a created one would vanish, the
   data sink #1416 closed. "Delivery (no SO)" is create-mode because it never
   carries a so_doc_no. */
export const DP_CREATABLE_JOB_TYPES = DP_ENTRY_MENU
  .filter((e): e is Extract<DpEntry, { mode: 'create' }> => e.mode === 'create')
  .map((e) => e.jobType);

export const ASSR_JOB_KIND_LABEL: Record<AssrJobKind, string> = {
  customer_pickup: 'Pickup',
  inspection: 'Inspection',
  delivery: 'Service',
};
export const assrJobKindLabel = (kind: AssrJobKind | null | undefined): string =>
  ASSR_JOB_KIND_LABEL[(kind ?? 'delivery') as AssrJobKind] ?? 'Service';

export const dpJobTypeLabel = (value: string | null | undefined): string => {
  const key = (value ?? '').toUpperCase();
  if (key in DP_JOB_TYPE_LABEL) return DP_JOB_TYPE_LABEL[key as DpJobType];
  return (value ?? '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
};

export type DpOrderCreate = {
  jobType: DpJobType;
  soDocNo?: string;
  supplierId?: string;
  projectId?: number;
  assrCaseId?: number;
  lorryId?: string;
  workshopId?: string;
  stockTransferId?: string;
  warehouseId?: string;
  /* TRANSFER to an OUTSOURCED warehouse (owner 2026-11-02): the destination is a
     3PL company we don't own, picked from the carrier master instead of our own
     warehouses. Mutually exclusive with warehouseId. */
  threeplCompanyId?: string;
  /* TRANSFER destination from the saved-locations address book (owner 2026-11-02
     方案2). Mutually exclusive with warehouseId / threeplCompanyId. */
  savedLocationId?: string;
  /* TRANSFER ORIGIN ("from", owner 2026-11-02 方案1): the pickup point — our
     warehouse, an outsourced 3PL, or a saved location (方案2). fromOverrides use
     snapshot keys (party_name, address1, address2, city, postcode, state) and win
     over the auto-fill. */
  fromWarehouseId?: string;
  fromThreeplCompanyId?: string;
  fromSavedLocationId?: string;
  fromOverrides?: Record<string, string | null>;
  requestedDate?: string;
  remark?: string;
  /* "Delivery (no SO)": its sales amount in sen, which Trip Pay's Delivery
     commission is worked out on (owner 2026-11-20). */
  salesAmountSen?: number | null;
  overrides?: Record<string, string | null>;
};
export function useCreateDpOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DpOrderCreate) =>
      authedFetch<{ dpOrder: unknown }>(`/dp-orders`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

/* Edit an unscheduled DP order's party / address / date / remark (PATCH
   /dp-orders/:id). The backend edits only PENDING_SCHEDULE rows — a scheduled job
   sits on a manifest a driver may hold, so it must be cancelled and re-raised. A
   field sent as null CLEARS it (the backend refuses a change that leaves the job
   with no address). Invalidates the board prefix the list query extends, so both
   refresh. First UI of the endpoint (owner 2026-11-02: "DP order maintenance"). */
export type DpOrderPatch = {
  partyName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  address1?: string | null;
  address2?: string | null;
  address3?: string | null;
  address4?: string | null;
  city?: string | null;
  postcode?: string | null;
  state?: string | null;
  // Origin ("from") fields — TRANSFER only (owner 2026-11-02 方案1).
  fromName?: string | null;
  fromAddress1?: string | null;
  fromAddress2?: string | null;
  fromCity?: string | null;
  fromPostcode?: string | null;
  fromState?: string | null;
  requestedDate?: string | null;
  remark?: string | null;
  salesAmountSen?: number | null;
};
export function useUpdateDpOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: DpOrderPatch & { id: string }) =>
      authedFetch<{ dpOrder: unknown; tripStop?: { updated: boolean; failed: boolean; reason?: string } }>(`/dp-orders/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
      qc.invalidateQueries({ queryKey: ['dp-order'] }),
      qc.invalidateQueries({ queryKey: ['delivery-job'] }),
    ]),
  });
}

export function useCancelDpOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{
        stopRemoved?: { failed?: boolean; reason?: string };
        lorryUnblocked?: { removed?: boolean; failed?: boolean; reason?: string };
      }>(
        `/dp-orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

export type ScheduleDpOrderVars = { id: string; lorryId: string; tripDate: string; tripId?: string; driverId?: string };
export type ScheduleDpOrderResult = {
  dpOrder: unknown;
  dp_no: string | null;
  tripStop: { id: string | null; failed: boolean; reason?: string };
  lorryBlocked?: { blocked: boolean; failed: boolean; reason?: string };
};
export function useScheduleDpOrder() {
  const qc = useQueryClient();
  return useMutation<ScheduleDpOrderResult, Error, ScheduleDpOrderVars>({
    mutationFn: ({ id, lorryId, tripDate, tripId, driverId }) =>
      authedFetch<ScheduleDpOrderResult>(`/dp-orders/${id}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ lorryId, tripDate, ...(tripId ? { tripId } : {}), ...(driverId ? { driverId } : {}) }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-planning'] });
      qc.invalidateQueries({ queryKey: ['scm-trips'] });
      qc.invalidateQueries({ queryKey: ['scm-trip'] });
    },
  });
}

/* ── Inline crew edit on a DP (manual job) row (owner 2026-10-31) ──────────────
   The board's Driver / Lorry / Helper cells on a DP row POST one seat here. A DP
   job's crew is its RUN's crew, so the endpoint puts the job on a run (its confirmed
   date — creating the run if there is none) before setting the seat, and mints the
   DP number once a lorry is on the run. So Driver / Lorry / Trip No. / the number
   all fill from one pick, like an SO row, with no "Schedule…" drawer. tripStop.failed
   is surfaced so the caller can tell "crew saved but the stop never attached" from a
   clean success (the #720 rule the endpoint documents). */
export type DpCrewVars = { id: string; driverId?: string | null; helper1Id?: string | null; helper2Id?: string | null; lorryId?: string | null };
export type DpCrewResult = { ok: true; trip_id: string | null; dp_no: string | null; tripStop: { id: string | null; failed: boolean; reason?: string } };
export function useDpCrew() {
  const qc = useQueryClient();
  return useMutation<DpCrewResult, Error, DpCrewVars>({
    mutationFn: ({ id, ...seat }) =>
      authedFetch<DpCrewResult>(`/dp-orders/${id}/crew`, {
        method: 'POST', body: JSON.stringify(seat),
      }),
    onSuccess: () => {
      scheduleBoardRefresh(qc, [['delivery-planning'], ['scm-trips'], ['scm-trip'], ['fleet-day']]);
    },
  });
}

export type DpOrderRow = {
  sales_amount_sen?: number | string | null;
  id: string;
  dp_no: string | null;
  job_type: string;
  party_type: string;
  so_doc_no: string | null;
  do_id: string | null;
  assr_case_id: number | null;
  supplier_id: string | null;
  project_id: number | null;
  /* Outsourced (3PL) transfer destination (owner 2026-11-02). Optional (`?`) so a
     cached pre-upgrade payload still typechecks. */
  threepl_company_id?: string | null;
  party_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  state: string | null;
  /* Origin ("from") — TRANSFER only (owner 2026-11-02 方案1). Optional (`?`) so a
     cached pre-upgrade payload still typechecks. */
  from_name?: string | null;
  from_address1?: string | null;
  from_address2?: string | null;
  from_city?: string | null;
  from_postcode?: string | null;
  from_state?: string | null;
  from_warehouse_id?: string | null;
  from_threepl_company_id?: string | null;
  /* Saved-location refs (owner 2026-11-02 方案2), destination + origin. */
  saved_location_id?: string | null;
  from_saved_location_id?: string | null;
  requested_date: string | null;
  trip_id: string | null;
  trip_stop_id: string | null;
  status: string;
  remark: string | null;
  created_at: string;
  updated_at: string;
  /* Sales context off the SOURCE SO (owner 2026-08-19) — stamped server-side on
     SO-sourced jobs only; null on manual / supplier / project / case rows.
     Resolve so_agent / so_salesperson_id to a name via useStaffLookup, never
     render either raw. Optional (`?`) so a cached pre-upgrade payload still
     typechecks. */
  so_agent?: string | null;
  so_salesperson_id?: string | null;
  so_venue?: string | null;
  so_processing_date?: string | null;
  so_total_sen?: number | null;
};
export function useDpOrders() {
  return useQuery({
    queryKey: ['delivery-planning', 'dp-orders'],
    queryFn: () => authedFetch<{ dpOrders: DpOrderRow[] }>(`/dp-orders`),
  });
}

export type SendDeliveryMessagesResult = {
  sent: Array<{ phone: string; docNos: string[]; httpCode: number }>;
  failed: Array<{ phone: string; docNos: string[]; error: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
  /* Sent orders whose Delivery Message Status the server could not move to its
     "Done X" (HC-0164) - e.g. 'lease' while someone has the SO open in the editor. */
  statusNotMoved?: Array<{ docNo: string; reason: string }>;
};
export type SendMessageKind =
  | 'delivery' | 'amend'
  | 'reminder_1' | 'reminder_2' | 'reminder_3'
  | 'driver_info' | 'delivery_completed' | 'balance_reminder' | 'postpone' | 'overdue_order' | 'postage'
  | 'eastmy_prep' | 'eastmy_shipped' | 'eastmy_arrived'
  | 'assr_arrangement';
export type SendDeliveryMessagesBody = {
  docNos: string[];
  kind?: SendMessageKind;
  driverInfo?: { driverName: string; driverContact: string; driverIc: string; carPlate: string; deliveryTime: string };
};
const ASSR_ROW_KEY_RE = /#(customer_pickup|inspection|delivery)$/;
export function useSendDeliveryMessages() {
  const qc = useQueryClient();
  return useMutation<SendDeliveryMessagesResult, Error, SendDeliveryMessagesBody>({
    mutationFn: (body) =>
      authedFetch<SendDeliveryMessagesResult>(`/delivery-messages/send`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (res, body) => {
      void qc.invalidateQueries({ queryKey: ['delivery-messages'] });
      const sent = res.sent.flatMap((s) => s.docNos);
      const assrStatus = body.kind === 'assr_arrangement' ? 'Done Send' : body.kind === 'driver_info' ? 'Done Driver Information' : null;
      const assrSent = sent.filter((d) => ASSR_ROW_KEY_RE.test(d));
      if (body.kind !== 'assr_arrangement' && assrSent.length === 0) { scheduleRowRefresh(qc, sent); return; }
      /* HC-0197: a Service Case leg's status after a send comes from the full
         board read (overlayAssrChatState), and the row refresh is SO-only. Show
         it now, then re-read the board (which re-reads any SO sent with it). */
      if (sent.length === 0) return;
      const keys = new Set(assrSent);
      for (const [key, prev] of qc.getQueriesData<PlanningResponse>({ queryKey: ['delivery-planning'] })) {
        if (!prev || !Array.isArray(prev.orders)) continue;
        qc.setQueryData<PlanningResponse>(key, {
          ...prev,
          orders: prev.orders.map((o) => (o.row_type === 'assr' && keys.has(o.so_doc_no)
            ? { ...o, delivery_message_status: assrStatus, amend_date_from_customer: null, amend_reason_from_customer: null }
            : o)),
        });
      }
      scheduleBoardRefresh(qc, [['delivery-planning']]);
    },
  });
}

export type SyncContactsResult = {
  synced: Array<{ phone: string; docNos: string[]; httpCode: number }>;
  failed: Array<{ phone: string; docNos: string[]; error: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
};
export function useSyncDeliveryContacts() {
  return useMutation<SyncContactsResult, Error, { docNos: string[] }>({
    mutationFn: (body) =>
      authedFetch<SyncContactsResult>(`/delivery-messages/sync`, {
        method: 'POST', body: JSON.stringify(body),
      }),
  });
}

export type DeliveryMessageStatus = { success: boolean; http_code: number | null; created_at: string };
export const STATUS_BATCH = 1000;
export function batchDocNos(docNos: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < docNos.length; i += STATUS_BATCH) out.push(docNos.slice(i, i + STATUS_BATCH));
  return out;
}
export function useDeliveryMessageStatuses(docNos: string[]) {
  return useQuery({
    queryKey: ['delivery-messages', 'statuses', docNos.join(',')],
    enabled: docNos.length > 0,
    queryFn: async () => {
      const parts = await Promise.all(batchDocNos(docNos).map((batch) =>
        authedFetch<{ statuses: Record<string, DeliveryMessageStatus> }>(`/delivery-messages/statuses`, {
          method: 'POST', body: JSON.stringify({ docNos: batch }),
        })));
      return Object.assign({}, ...parts.map((r) => r.statuses)) as Record<string, DeliveryMessageStatus>;
    },
    staleTime: 30_000,
  });
}

export type ScheduleDeliveryVars = {
  type: 'so' | 'do' | 'assr' | 'dp';
  id: string;
  scheduleDate?: string | null;
  deliveryState?: DeliveryState | null;
  driverId?: string | null;
  lorryId?: string | null;
  helper1Id?: string | null;
  helper2Id?: string | null;
  jobKind?: AssrJobKind | null;
  assrLegStatus?: 'delivered' | 'cancelled' | 'pending';
  warehouseId?: string | null;
  tripId?: string | null;
  tripDate?: string | null;
  stopNo?: number;
  etaOffsetS?: number | null;
  legDistanceM?: number | null;
  legDurationS?: number | null;
  threePlCostSen?: number | null;
  driverNameOptimistic?: string | null;
  lorryPlateOptimistic?: string | null;
};

export type ScheduleDeliveryResult = {
  ok: true;
  trip?: { id: string; trip_no: string } | null;
  tripWiring?: { failed: true; reason: string };
};

export function useScheduleDelivery() {
  const qc = useQueryClient();
  return useMutation<ScheduleDeliveryResult, Error, ScheduleDeliveryVars, { snapshots: Array<[readonly unknown[], PlanningResponse]> }>({
    mutationFn: ({ type, id, scheduleDate, deliveryState, assrLegStatus, driverId, lorryId, helper1Id, helper2Id, jobKind, warehouseId, tripId, tripDate, stopNo, etaOffsetS, legDistanceM, legDurationS, threePlCostSen }) => {
      const body: Record<string, unknown> = {};
      if (scheduleDate !== undefined) body.scheduleDate = scheduleDate;
      if (deliveryState !== undefined) body.deliveryState = deliveryState;
      if (assrLegStatus !== undefined) body.assrLegStatus = assrLegStatus;
      if (driverId !== undefined) body.driverId = driverId;
      if (lorryId !== undefined) body.lorryId = lorryId;
      if (helper1Id !== undefined) body.helper1Id = helper1Id;
      if (helper2Id !== undefined) body.helper2Id = helper2Id;
      if (jobKind !== undefined) body.jobKind = jobKind;
      if (warehouseId !== undefined) body.warehouseId = warehouseId;
      if (tripId !== undefined) body.tripId = tripId;
      if (tripDate !== undefined) body.tripDate = tripDate;
      if (stopNo !== undefined) body.stopNo = stopNo;
      if (etaOffsetS !== undefined) body.etaOffsetS = etaOffsetS;
      if (legDistanceM !== undefined) body.legDistanceM = legDistanceM;
      if (legDurationS !== undefined) body.legDurationS = legDurationS;
      if (threePlCostSen !== undefined) body.threePlCostSen = threePlCostSen;
      return authedFetch<ScheduleDeliveryResult>(`/delivery-planning/${type}/${id}/schedule`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['delivery-planning'] });
      const entries = qc.getQueriesData<PlanningResponse>({ queryKey: ['delivery-planning'] });
      const snapshots: Array<[readonly unknown[], PlanningResponse]> = [];
      for (const [key, prev] of entries) {
        if (!prev || !Array.isArray(prev.orders)) continue;
        snapshots.push([key, prev]);
        qc.setQueryData<PlanningResponse>(key, {
          ...prev,
          orders: prev.orders.map((o) => {
            const matches = vars.type === 'assr'
              ? o.row_type === 'assr' && String(o.assr_id ?? '') === vars.id && (vars.jobKind == null || o.job_kind === vars.jobKind)
              : vars.type === 'dp'
                ? o.row_type === 'dp' && o.so_doc_no === `DP:${vars.id}`
                : o.so_doc_no === vars.id;
            if (!matches) return o;
            const next: PlanningOrder = { ...o };
            if (vars.deliveryState !== undefined && vars.deliveryState !== null) next.delivery_state = vars.deliveryState;
            if (vars.assrLegStatus === 'delivered') next.delivery_state = 'DELIVERED';
            else if (vars.assrLegStatus === 'pending') next.delivery_state = 'PENDING_DELIVERY';
            if (vars.scheduleDate !== undefined) next.amended_delivery_date = vars.scheduleDate;
            if (vars.driverNameOptimistic !== undefined || vars.lorryPlateOptimistic !== undefined) {
              const crew = { ...(o.crew ?? { driver: null, helper: null, lorry: null, driver_1_name: null, driver_1_ic: null, driver_1_contact: null, driver_2_name: null, helper_1_name: null, helper_2_name: null, lorry_plate: null }) };
              if (vars.driverNameOptimistic !== undefined) crew.driver_1_name = vars.driverNameOptimistic;
              if (vars.lorryPlateOptimistic !== undefined) crew.lorry_plate = vars.lorryPlateOptimistic;
              next.crew = crew;
            }
            return next;
          }),
        });
      }
      return { snapshots };
    },
    onError: (err, _vars, ctx) => {
      for (const [key, prev] of ctx?.snapshots ?? []) qc.setQueryData(key, prev);
      serviceNotify({
        title: 'Schedule not saved',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      });
    },
    onSettled: (_res, _err, vars) => {
      if (vars.type === 'so') {
        scheduleRowRefresh(qc, [vars.id]);
        scheduleBoardRefresh(qc, [['fleet-day'], ['scm-trips']]);
        return;
      }
      scheduleBoardRefresh(qc, [['delivery-planning'], ['fleet-day'], ['scm-trips']]);
    },
  });
}

/* ── DO crew assignment (Last Mile "Propose crew", owner 2026-08-08) ──────────
   Writes the FULL crew record — up to 2 drivers + 2 helpers + 1 lorry — via the
   long-standing PUT /delivery-orders-mfg/:id/crew (mig 0053's
   scm.delivery_order_crew UPSERT; this is its first UI caller). That row is the
   snapshot THE BOARD's crew columns display (driver 1/2, helper 1/2, IC,
   contact, plate), and the handler also syncs the DO header's primary-driver
   quick-fields and records the audit trail. It is the ONLY store with a second
   DRIVER seat (scm.trips has one driver + two helpers by schema), which is why
   no migration accompanies the owner's two-driver rule: the two-driver-capable
   record already exists and every display reads it — adding trips.driver_2_id
   would be a second home for the same fact. */
export type DoCrewVars = {
  doId: string;
  driver1Id?: string | null;
  driver2Id?: string | null;
  helper1Id?: string | null;
  helper2Id?: string | null;
  lorryId?: string | null;
};
export function useAssignDoCrew() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ doId, ...body }: DoCrewVars) =>
      authedFetch<{ crew?: CrewSnapshot | null }>(`/delivery-orders-mfg/${doId}/crew`, {
        method: 'PUT', body: JSON.stringify(body),
      }),
    onSuccess: (res, vars) => {
      if (res.crew) {
        rememberSavedCrew(vars.doId, res.crew);
        qc.setQueriesData<PlanningResponse>({ queryKey: ['delivery-planning'] }, (d) => withSavedCrew(d));
        qc.setQueriesData<PlanningResponse>({ queryKey: ['mobile-delivery-planning'] }, (d) => withSavedCrew(d));
      }
      scheduleBoardRefresh(qc, [['delivery-planning'], ['mfg-delivery-orders'], ['fleet-day'], ['scm-trips']]);
    },
  });
}


type DeliverablePickLine = { soItemId: string; docNo: string; remaining: number };

export type ConvertSoResult = {
  converted: Array<{ docNo: string; doNumber: string }>;
  skipped: Array<{ docNo: string; reason: 'already_delivered' }>;
  failed: Array<{ docNo: string; message: string }>;
};

export function useConvertSosToDo() {
  const qc = useQueryClient();

  const keys = useRef(new Map<string, string>());
  const keyFor = (docNo: string): string => {
    const existing = keys.current.get(docNo);
    if (existing) return existing;
    const minted = newIdempotencyKey();
    keys.current.set(docNo, minted);
    return minted;
  };

  return useMutation<ConvertSoResult, Error, { docNos: string[] }>({
    mutationFn: async ({ docNos }) => {
      const wanted = [...new Set(docNos.filter(Boolean))];
      const out: ConvertSoResult = { converted: [], skipped: [], failed: [] };
      if (wanted.length === 0) return out;

      const qs = wanted.map((d) => encodeURIComponent(d)).join(',');
      const { lines } = await authedFetch<{ lines: DeliverablePickLine[] }>(
        `/delivery-orders-mfg/deliverable-so-lines?docNos=${qs}`,
      );
      const picksByDoc = new Map<string, Array<{ soItemId: string; qty: number }>>();
      for (const l of lines) {
        if (!l.soItemId || !(l.remaining > 0)) continue;
        const arr = picksByDoc.get(l.docNo) ?? [];
        arr.push({ soItemId: l.soItemId, qty: l.remaining });
        picksByDoc.set(l.docNo, arr);
      }

      for (const docNo of wanted) {
        if (!picksByDoc.has(docNo)) out.skipped.push({ docNo, reason: 'already_delivered' });
      }

      const jobs = [...picksByDoc.entries()];
      const LIMIT = 4;
      for (let i = 0; i < jobs.length; i += LIMIT) {
        const batch = jobs.slice(i, i + LIMIT);
        await Promise.all(batch.map(async ([docNo, picks]) => {
          try {
            const res = await authedFetch<{ id: string; doNumber: string }>(
              `/delivery-orders-mfg/from-sos`,
              idempotentInit(keyFor(docNo), { method: 'POST', body: JSON.stringify({ picks }) }),
            );
            out.converted.push({ docNo, doNumber: res.doNumber });
          } catch (e) {
            out.failed.push({ docNo, message: e instanceof Error ? e.message : 'Something went wrong.' });
          }
        }));
      }
      return out;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-planning'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'], refetchType: 'all' });
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

/** "350.50" / "1,200" -> sen; "" -> null; anything else -> undefined (not an amount). */
export function salesAmountSenOf(text: string): number | null | undefined {
  const t = text.replace(/,/g, '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}
