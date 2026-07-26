// Vendored from apps/backend/src/lib/delivery-planning-queries.ts — Delivery
// Planning queries (STAGE 4 of the Delivery / TMS module). Reads the planning
// board (GET /delivery-planning) + the per-doc schedule date. Cloned from the
// drivers / lorries query pattern (TanStack Query + authedFetch). Rows are
// snake_case as the API emits them; consumers dual-read camelCase where the pg
// driver would camelCase a column.
//
// NOTE: the "delivery leg" (multi-hop / dual-trip) hooks were REMOVED — China-PO
// transit flow, not in use yet; re-add later.
//
// HOUZS VENDOR NOTE: the source has NO `import { supabase } from './supabase'`
// to drop (it only used authedFetch). Everything else is copied verbatim.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { invalidateSoLists } from './sales-order-queries';
import { serviceNotify } from './dialog-service';

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

// A region is a CONFIG-DRIVEN bucket code (migration 0053) derived from the
// customer's STATE (not the line warehouse). The live buckets are the geographic
// regions KL/SEL · Northern · Southern · East Coast · EM (East Malaysia:
// Sabah/Sarawak/Labuan) — Singapore folds into Southern — but the owner can add
// more in the Delivery Regions master, so a region code is an OPEN string (not a
// fixed union). 'ALL' is the no-filter param; the rest are bucket codes.
export type RegionCode = string;
export type RegionKey = 'ALL' | RegionCode;

/* A board row is either a Sales-Order delivery (the original rows) or a
   Service-Case (ASSR) job. row_type discriminates; it defaults to 'so' for the
   long-standing SO rows (the backend now stamps it explicitly on every row). */
export type PlanningRowType = 'so' | 'assr' | 'dp' | 'project';
/* ASSR job kind (only meaningful when row_type === 'assr'). */
export type AssrJobKind = 'customer_pickup' | 'delivery' | 'inspection';

export type PlanningOrder = {
  /* SO rows: 'so' (default). ASSR (service-case) rows: 'assr'. DP-Order jobs
     (manual setup / dismantle / supplier-pickup, no source SO) : 'dp'. */
  row_type: PlanningRowType;
  /* DP-only. The DP job type (DELIVERY/PICKUP/SERVICE/SETUP/DISMANTLE/
     SUPPLIER_PICKUP) and the minted DP number (null until scheduled). Null on
     SO/ASSR rows. */
  dp_job_type?: string | null;
  dp_no?: string | null;
  /* ASSR-only. The service case's NUMERIC id (drives the /assr/:id detail route)
     and its human ref (= assr_no, shown in the SO No. cell). null on SO rows. */
  assr_id: number | null;
  ref: string | null;
  /* ASSR-only. Whether the job is a customer pickup or a delivery. null on SO
     rows. */
  job_kind: AssrJobKind | null;
  so_doc_no: string;
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  branding: string | null;
  status: string;
  delivery_state: DeliveryState;
  delivery_state_override: string | null;
  balance_centi: number;
  /* Live balance (= local_total − Σpayments, from the SO-list payment-totals
     view); null when the view has no row → fall back to balance_centi. */
  balance_centi_live: number | null;
  local_total_centi: number;
  so_date: string | null;
  /* The customer's ORIGINAL delivery date — never overwritten (migration 0199). */
  customer_delivery_date: string | null;
  /* Amendment dates (migration 0199): the customer's requested NEW date and the
     date WE confirmed (the proposed/amended delivery date). effective = amended ??
     original, what Days Left / OVERDUE actually use. */
  amend_date_from_customer: string | null;
  amended_delivery_date: string | null;
  /* HC "Amend Client Date Reason" (migration 0201) — free-text reason paired
     with the amend dates above. */
  amend_reason: string | null;
  effective_delivery_date: string | null;
  internal_expected_dd: string | null;
  days_left: number | null;
  /* HC delivery-sheet address columns. */
  address: string | null;
  postcode: string | null;
  building_type: string | null;
  /* HC SO-context raw-data fields (migration 0197), always editable. */
  possession_date: string | null;
  house_type: string | null;
  replacement_disposal: string | null;
  referral: string | null;
  /* HC DO-execution raw-data fields (migration 0197), from the latest DO;
     null when this SO has no DO yet (editable only once a DO exists). */
  time_range: string | null;
  time_confirmed: boolean | null;
  arrival_at: string | null;
  departure_at: string | null;
  shipout_date: string | null;
  customer_delivered_date: string | null;
  eta_arriving_port: string | null;
  delivery_substatus: string | null;
  /* EM-region cross-border transit-warehouse arrival date (migration 0199),
     from the latest DO; null when no DO. */
  arrives_em_warehouse_date: string | null;
  /* The latest DO's OWN document date (delivery_orders.do_date); null when this
     SO has no (non-DRAFT/CANCELLED) DO yet — drives the "DO Date" grid column. */
  do_date: string | null;
  stock_status: string;
  stock_remark: string;
  is_main_ready: boolean;
  /* Multi-company: readable company code for the SHARED cross-company queue
     (e.g. 'HOUZS' / '2990'). null on ASSR rows or when unresolved. */
  company_code?: string | null;
  region: RegionCode;   // the order's primary bucket (from customer_state)
  regions: RegionCode[];  // primary + any leg buckets
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  customer_state: string | null;
  delivered_qty: number;
  remaining_qty: number;
  crew: {
    driver: string | null; helper: string | null; lorry: string | null;
    driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
    driver_2_name: string | null;
    helper_1_name: string | null; helper_2_name: string | null;
    lorry_plate: string | null;
  } | null;
  delivery_orders: Array<{ id: string; do_number: string; status: string }>;
};

export type PlanningCounts = Record<'ALL' | DeliveryState, number>;

export type PlanningResponse = {
  orders: PlanningOrder[];
  counts: PlanningCounts;
  regions: Array<{ key: RegionKey; label: string }>;
};

/* The board. region = ALL | KL | NORTHERN | SOUTHERN | EAST_COAST | EM; state = DeliveryState | 'ALL'.
   Counts come back scoped to the active region (not the state) so the 4 state
   tab badges stay stable as the operator switches between state tabs. */
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
    // Switching region / state tabs keeps the previous board on screen while the
    // next slice loads, instead of flashing an empty table (keepPreviousData).
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

/* One expand-row line item, as GET /delivery-planning/:docNo/lines emits it
   (snake_case, no transform). Mirrors the SO-detail item columns the board's
   drill-down consumes (group / code / description / variants / cancelled). */
export type PlanningLineItem = {
  id: string;
  doc_no: string | null;
  item_group: string | null;
  item_code: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  discount_centi: number | null;
  total_centi: number | null;
  variants: Record<string, unknown> | null;
  stock_status: string | null;
  cancelled: boolean | null;
};

/* Expand-row lines for one SO on the SHARED cross-company board. Uses the
   dedicated /delivery-planning/:docNo/lines endpoint (scoped to the caller's
   ALLOWED companies) instead of the PER-COMPANY SO detail — so expanding a
   cross-company (e.g. 2990) row while browsing as Houzs no longer 404s. Lazy
   (enabled only when a docNo is set) + cached by docNo. */
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

/* HC "Remark 4" delivery sub-status — the known values (must mirror the API
   whitelist). Blank ('') is always allowed (clears it). */
export const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;
export type HcSubstatus = (typeof HC_SUBSTATUS_VALUES)[number];

/* The editable HC fields (migration 0197), split by where they're owned. The
   SO-context fields always save; the DO-execution fields need a DO to land on. */
export type HcFieldsPatch = {
  // SO-context (→ mfg_sales_orders)
  possessionDate?: string | null;
  houseType?: string | null;
  replacementDisposal?: string | null;
  referral?: string | null;
  // DO-execution (→ delivery_orders, when a DO exists)
  timeRange?: string | null;
  timeConfirmed?: boolean | null;
  arrivalAt?: string | null;
  departureAt?: string | null;
  shipoutDate?: string | null;
  customerDeliveredDate?: string | null;
  etaArrivingPort?: string | null;
  deliverySubstatus?: string | null;
};

export type HcFieldsResult = {
  ok: true;
  written: { so: boolean; do: boolean };
  do_id: string | null;
  so_doc_no: string | null;
  /* Set when DO-execution fields were submitted but no DO exists yet. */
  no_do_hint: string | null;
};

/* Save the HC raw-data fields for an order. type = 'so' | 'do'; id = SO doc_no
   or DO id. Calls PATCH /delivery-planning/:type/:id/fields and invalidates the
   planning board. The result's no_do_hint tells the UI when DO-execution fields
   were skipped because there's no DO. */
export function useUpdateDeliveryFields() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, ...body }: { type: 'so' | 'do'; id: string } & HcFieldsPatch) =>
      authedFetch<HcFieldsResult>(`/delivery-planning/${type}/${id}/fields`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

/* The DP job-type vocabulary — the SINGLE source of truth for the set the whole
   Delivery Planning surface uses. Mirrors the `scm.trip_stop_type` enum (mig 0053
   + SUPPLIER_PICKUP in 0128), ORDERED as the enum declares them so the create
   dropdown and any future list read the same order. Both the New-DP-Order dropdown
   AND the board's Type chip resolve their label from DP_JOB_TYPE_LABEL below, so
   the value a user PICKS is byte-identical to what the board SHOWS — they can no
   longer drift (owner: the dropdown type must equal the type we normally show). */
export const DP_JOB_TYPES = [
  'DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP',
] as const;
export type DpJobType = (typeof DP_JOB_TYPES)[number];

export const DP_JOB_TYPE_LABEL: Record<DpJobType, string> = {
  DELIVERY: 'Delivery',
  PICKUP: 'Pickup',
  SERVICE: 'Service',
  SETUP: 'Setup',
  DISMANTLE: 'Dismantle',
  SUPPLIER_PICKUP: 'Supplier Pickup',
};

/* The job types the New-DP-Order drawer OFFERS to create. DELIVERY / PICKUP /
   SERVICE are deliberately EXCLUDED: they are represented natively by SO / DO /
   ASSR board rows, and a source-backed DP order of those types is suppressed by
   the board's anti-double-count union guard — so it would silently vanish (a data
   sink). The drawer's real job is the "extra" fleet jobs with no native document.
   DP_JOB_TYPES (the full set) is still used to LABEL any existing/legacy dp_order
   the board renders. */
export const DP_CREATABLE_JOB_TYPES = ['SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP'] as const;

/* The label the board / dropdown show for a DP job type. Reads the canonical map;
   falls back to a Title-Cased prettify for any value not in the set (defensive —
   the board's Type chip previously prettified inline, so unknown/legacy stored
   values keep rendering rather than blanking). */
export const dpJobTypeLabel = (value: string | null | undefined): string => {
  const key = (value ?? '').toUpperCase();
  if (key in DP_JOB_TYPE_LABEL) return DP_JOB_TYPE_LABEL[key as DpJobType];
  return (value ?? '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
};

/* Create a DP Order (delivery-planning job). The server auto-fills the party from
   whichever source ref is given (SO / supplier / project / service case); manual
   `overrides` win over the auto-fill. POST /dp-orders, then the board refreshes. */
export type DpOrderCreate = {
  jobType: DpJobType;
  soDocNo?: string;
  supplierId?: string;
  projectId?: number;
  assrCaseId?: number;
  requestedDate?: string;
  remark?: string;
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

/* Cancel a DP Order (and drop its trip stop, backend-side). */
export function useCancelDpOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ stopRemoved?: { failed?: boolean; reason?: string } }>(
        `/dp-orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

/* Schedule a DP Order onto a lorry + date — this MINTS its DP number (from the
   lorry plate + date) and, when a trip is given, appends it as a stop on that
   trip. POST /dp-orders/:id/schedule. The endpoint has always existed; this is
   the first UI caller (P0 of docs/delivery-planning-jobtypes-spec.md), so setup /
   dismantle / supplier-pickup jobs can finally leave "Pending Schedule".

   `tripStop.failed` is surfaced so the caller can tell "scheduled but the stop
   never attached" from a clean success — a wiring failure must never look like a
   plain success (the #720 lesson the endpoint documents). A header-only schedule
   (no tripId) is valid: the number is minted, no stop is written. */
export type ScheduleDpOrderVars = { id: string; lorryId: string; tripDate: string; tripId?: string };
export type ScheduleDpOrderResult = {
  dpOrder: unknown;
  dp_no: string | null;
  tripStop: { id: string | null; failed: boolean; reason?: string };
};
export function useScheduleDpOrder() {
  const qc = useQueryClient();
  return useMutation<ScheduleDpOrderResult, Error, ScheduleDpOrderVars>({
    mutationFn: ({ id, lorryId, tripDate, tripId }) =>
      authedFetch<ScheduleDpOrderResult>(`/dp-orders/${id}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ lorryId, tripDate, ...(tripId ? { tripId } : {}) }),
      }),
    onSuccess: () => {
      // Refresh the board AND the trips views — a new stop landed on a trip.
      qc.invalidateQueries({ queryKey: ['delivery-planning'] });
      qc.invalidateQueries({ queryKey: ['scm-trips'] });
      qc.invalidateQueries({ queryKey: ['scm-trip'] });
    },
  });
}

/* ── WhatsApp (Seampify) sends — the board's "Send Message" action ────────────
   One WhatsApp per CUSTOMER PHONE bundling all their selected orders (the
   sheet-era BulkSend shape). The backend groups by phone; the caller just posts
   the SO doc numbers. While the Seampify secrets are unset the endpoint answers
   503 not_configured — surfaced to the operator via the thrown error message. */
export type SendDeliveryMessagesResult = {
  sent: Array<{ phone: string; docNos: string[]; httpCode: number }>;
  failed: Array<{ phone: string; docNos: string[]; error: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
};
export function useSendDeliveryMessages() {
  const qc = useQueryClient();
  return useMutation<SendDeliveryMessagesResult, Error, { docNos: string[] }>({
    mutationFn: (body) =>
      authedFetch<SendDeliveryMessagesResult>(`/delivery-messages/send`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-messages'] }),
  });
}

/* Latest send status per SO doc — drives the board's "Message" column. POST
   (not GET) because a full board is ~600 doc numbers, far past URL limits. */
export type DeliveryMessageStatus = { success: boolean; http_code: number | null; created_at: string };
export function useDeliveryMessageStatuses(docNos: string[]) {
  return useQuery({
    queryKey: ['delivery-messages', 'statuses', docNos.join(',')],
    enabled: docNos.length > 0,
    queryFn: () =>
      authedFetch<{ statuses: Record<string, DeliveryMessageStatus> }>(`/delivery-messages/statuses`, {
        method: 'POST', body: JSON.stringify({ docNos }),
      }).then((r) => r.statuses),
    staleTime: 30_000,
  });
}

/* Set the concrete schedule date (+ optional manual delivery_state override,
   + optional driver / lorry trip-wiring) on an SO or DO. type = 'so' | 'do';
   id = SO doc_no or DO id.

   NOTE (Delivery Planning inline-edit, 2026-07): the board's inline cells write
   through THIS hook. The backend schedule endpoint already accepts driverId /
   lorryId / tripId / tripDate / warehouseId (it find-or-creates a trip and
   appends a stop); the previous frontend signature dropped them, so we widen it
   here to forward driverId / lorryId. The `*Optimistic` fields are DISPLAY-ONLY
   values (driver name / lorry plate / the effective delivery date) used purely
   for the optimistic cache patch — they are NOT sent to the API. */
export type ScheduleDeliveryVars = {
  /* 'so' | 'do' are the original SO/DO schedule paths. 'assr' schedules a
     service-case job (Delivery Planning ASSR rows) — the backend now accepts it;
     for ASSR the id is the service case's id and jobKind carries the row's kind. */
  type: 'so' | 'do' | 'assr';
  id: string;
  scheduleDate?: string | null;
  deliveryState?: DeliveryState | null;
  driverId?: string | null;
  lorryId?: string | null;
  /* Fleet A2: the helper crew the assigner (or a dispatcher override) paired to
     the trip. Persisted onto scm.trips helper_1_id / helper_2_id on a trip
     CREATE, via the same schedule path (additive — omitted = unchanged). */
  helper1Id?: string | null;
  helper2Id?: string | null;
  /* ASSR-only: forwarded so the backend knows which job (pickup vs delivery) is
     being scheduled. Ignored for 'so' | 'do'. */
  jobKind?: AssrJobKind | null;
  /* Trip wiring: the origin warehouse for a find-or-created trip, or an explicit
     trip to append to. warehouseId lets the Phase 3 drawer pin the trip origin to
     the routed depot; both were already accepted by the backend schedule schema. */
  warehouseId?: string | null;
  tripId?: string | null;
  tripDate?: string | null;
  /* Phase 3 "Propose times + route" apply: the stop's 1-based position in the
     proposed sequence + its ETA (seconds from the trip's depart) + leg metrics,
     so the stop lands in order with its computed times. Optional — a normal
     schedule omits them and behaves exactly as before. */
  stopNo?: number;
  etaOffsetS?: number | null;
  legDistanceM?: number | null;
  legDurationS?: number | null;
  /* Fleet A3: the captured cost (integer sen) when the chosen lorry is a 3PL
     carrier (OUTSOURCE). Written on a trip CREATE; ignored for an own-fleet
     lorry. This is the seam Module C's rate-card will compute against. */
  threePlCostCenti?: number | null;
  /* Display-only, for optimistic UI (never posted). */
  driverNameOptimistic?: string | null;
  lorryPlateOptimistic?: string | null;
};

/* The schedule endpoint's wire shape. `trip` is WIRED (the trip the order landed
   on) or null (NOT_REQUESTED — no lorry given — or FAILED). `tripWiring` is
   present ONLY on a FAILED wiring: the header date IS stored (still 200), but the
   find-or-create-a-trip step blew up, so a caller must be able to tell that apart
   from a clean "no trip asked for". REPORT, don't REPAIR — mirrors the backend's
   `tripFieldsFor` (delivery-planning.ts:1940). */
export type ScheduleDeliveryResult = {
  ok: true;
  trip?: { id: string; trip_no: string } | null;
  tripWiring?: { failed: true; reason: string };
};

export function useScheduleDelivery() {
  const qc = useQueryClient();
  return useMutation<ScheduleDeliveryResult, Error, ScheduleDeliveryVars, { snapshots: Array<[readonly unknown[], PlanningResponse]> }>({
    mutationFn: ({ type, id, scheduleDate, deliveryState, driverId, lorryId, helper1Id, helper2Id, jobKind, warehouseId, tripId, tripDate, stopNo, etaOffsetS, legDistanceM, legDurationS, threePlCostCenti }) => {
      /* Only include keys the caller actually set, so an unrelated field is never
         nulled out by an inline single-field edit. */
      const body: Record<string, unknown> = {};
      if (scheduleDate !== undefined) body.scheduleDate = scheduleDate;
      if (deliveryState !== undefined) body.deliveryState = deliveryState;
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
      if (threePlCostCenti !== undefined) body.threePlCostCenti = threePlCostCenti;
      return authedFetch<ScheduleDeliveryResult>(`/delivery-planning/${type}/${id}/schedule`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
    },
    /* Optimistic patch — reflect the edit immediately on every cached planning
       board (all region/state keys), then invalidate on settle for the truth. */
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
            /* Match by the row's identity: ASSR rows key on the numeric case id
               (vars.id is that id as a string); SO/DO rows key on so_doc_no. */
            const matches = vars.type === 'assr'
              ? o.row_type === 'assr' && String(o.assr_id ?? '') === vars.id
              : o.so_doc_no === vars.id;
            if (!matches) return o;
            const next: PlanningOrder = { ...o };
            if (vars.deliveryState !== undefined && vars.deliveryState !== null) next.delivery_state = vars.deliveryState;
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
      /* Roll every board back to its pre-edit snapshot. */
      for (const [key, prev] of ctx?.snapshots ?? []) qc.setQueryData(key, prev);
      /* The rollback is silent on its own, and this board is a scheduling
         surface: the coordinator sees the job land on a date/driver/lorry, then
         quietly jump back, with no way to tell a rejected save from a stale
         render. Assigning a delivery that was never persisted strands a real
         job. Same ambiguity class as the schedule endpoint that answered
         `ok: true, trip: null` for both "no trip wanted" and "the wiring blew
         up" — a failure must never be indistinguishable from a success. */
      serviceNotify({
        title: 'Schedule not saved',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

/* ── Convert SO → DO from the Delivery Planning board ──────────────────────────
   REUSES the existing line-level converter POST /delivery-orders-mfg/from-sos
   (the variant-carry fix already lives there). That endpoint is LINE-level —
   it takes picks: [{ soItemId, qty }] and creates ONE DO from those lines,
   MERGING into one DO when picks span >1 SO. To keep "one DO per Sales Order"
   semantics here (single + multi-select), we resolve each SO's still-deliverable
   lines and call from-sos ONCE PER SO (sequential with a small concurrency
   limit), never one merged call.

   The already-has-DO guard is intrinsic: from-sos only converts the line-level
   REMAINING (qty − delivered + returned), so an SO with every line fully
   delivered yields zero deliverable lines → it is reported as `skipped`
   (already_delivered) and never double-converted. */

type DeliverablePickLine = { soItemId: string; docNo: string; remaining: number };

export type ConvertSoResult = {
  /** SOs that produced a new DO. */
  converted: Array<{ docNo: string; doNumber: string }>;
  /** SOs with nothing left to deliver (no remaining lines) — not converted. */
  skipped: Array<{ docNo: string; reason: 'already_delivered' }>;
  /** SOs the endpoint rejected (e.g. sofa no-batch / short-stock / race). */
  failed: Array<{ docNo: string; message: string }>;
};

/* Resolve still-deliverable lines for the given SOs, then convert one DO per SO
   by reusing from-sos. Concurrency capped so a large bulk select doesn't fan out
   into a burst of Worker subrequests. */
export function useConvertSosToDo() {
  const qc = useQueryClient();
  return useMutation<ConvertSoResult, Error, { docNos: string[] }>({
    mutationFn: async ({ docNos }) => {
      const wanted = [...new Set(docNos.filter(Boolean))];
      const out: ConvertSoResult = { converted: [], skipped: [], failed: [] };
      if (wanted.length === 0) return out;

      // 1. One batched read of the deliverable (remaining > 0) lines for every
      //    selected SO, grouped by doc_no.
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

      // 2. SOs with no deliverable lines → already fully delivered (or no lines).
      for (const docNo of wanted) {
        if (!picksByDoc.has(docNo)) out.skipped.push({ docNo, reason: 'already_delivered' });
      }

      // 3. Convert one DO per SO, capped concurrency (4 at a time).
      const jobs = [...picksByDoc.entries()];
      const LIMIT = 4;
      for (let i = 0; i < jobs.length; i += LIMIT) {
        const batch = jobs.slice(i, i + LIMIT);
        await Promise.all(batch.map(async ([docNo, picks]) => {
          try {
            const res = await authedFetch<{ id: string; doNumber: string }>(
              `/delivery-orders-mfg/from-sos`,
              { method: 'POST', body: JSON.stringify({ picks }) },
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
      // The new DO(s) + their DO-execution data must appear on the planning rows.
      qc.invalidateQueries({ queryKey: ['delivery-planning'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'], refetchType: 'all' });
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}
