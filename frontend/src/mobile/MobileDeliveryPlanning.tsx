import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { withSavedCrew } from "../vendor/scm/lib/saved-crew";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orderLineIdentity } from "@2990s/shared";
import { invalidateDoShared, invalidateInventoryShared, invalidateSoShared } from "./sharedInvalidate";
import { useLiveDoStop, withLiveDo } from "../vendor/scm/lib/crew-stop-live";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { companyHeaderFor } from "../lib/activeCompany";
import { useUpdateMfgDeliveryOrderStatus } from "../vendor/scm/lib/delivery-order-queries";
import { idempotentInit, useIdempotencyKey } from "../lib/idempotency";
import { MobileVirtualList } from "./MobileVirtualList";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import {
  useDeliveryPlanningLines,
  type PlanningLineItem,
} from "../vendor/scm/lib/delivery-planning-queries";
import { useCreateAmendment } from "../vendor/scm/lib/so-amendment-queries";
import {
  DeliveryFieldsCard,
  EM,
  hhmm,
  pdRow,
} from "./MobileDeliveryFieldsCard";
import { fmtSen } from "../lib/scm";
import { formatDate } from "../lib/utils";
import { useAuth } from "../auth/AuthContext";
import { canOperateDeliveryOrders, canDriverCompleteDelivery } from "../auth/salesAccess";
import { MobileTrackingBanner } from "./MobileTrackingBanner";
import "./mobile.css";
import { MobileJobStop, jobRefOf, jobKey, jobLabelOf, useJobProgressMap } from "./MobileJobStop";
import { LEG_LABEL } from "../vendor/scm/lib/delivery-job";
import { useLocalities, postcodeIndex, postcodeLabel } from "../vendor/scm/lib/localities-queries";
import { isEastMalaysiaOrSingaporeStop } from "../vendor/scm/lib/last-mile";
import { isDispatched } from "./runSheetDispatch";
import { isSetupDismantleJob } from "./setupDismantleJob";
import { runSheetTieBreak, timeSlotEndMin } from "./runSheetOrder";
import { instantToMytLocal, mytDayOfValue, todayMyt } from "../vendor/scm/lib/dates";

/* ------------------------------------------------------------------ *
 * Mobile Delivery Planning — driver run-sheet screen (v2 job card).
 *
 * The design (day buckets, the job-card anatomy, which stop KINDS are
 * deliberately not built, how each per-stop action maps onto the real DO
 * status machine, and the real-data discipline that keeps invented fields
 * off the card) is documented in docs/modules/delivery-tms.md, under
 * "Mobile run-sheet — the v2 job card". Read it before adding a field:
 * most of what a driver asks for here has no backend source, and the rule
 * is to omit it, never to invent it.
 * ------------------------------------------------------------------ */

type Bucket = "PENDING_DELIVERY" | "PENDING_SCHEDULE" | "OVERDUE" | "DELIVERED";

type Crew = {
  driver: string | null;
  helper: string | null;
  lorry: string | null;
} | null;

type DeliveryOrderRef = {
  id?: string;
  do_number?: string | null;
  status?: string | null;
};

type BoardRow = {
  so_doc_no: string;
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  branding: string | null;
  status: string | null;
  delivery_state: Bucket;
  /* Customer-message follow-up workflow status (owner 2026-09-22) — one of the
     23 desktop MESSAGE_STATUSES or null. Read-only on the phone (dispatch edits
     it on the desktop board); shown as a small pill on the job card. */
  delivery_message_status: string | null;
  balance_sen: number | null;
  balance_sen_live: number | null;
  local_total_sen: number | null;
  so_date: string | null;
  customer_delivery_date: string | null;
  amended_delivery_date: string | null;
  effective_delivery_date: string | null;
  processing_date: string | null;
  trip_date?: string | null;
  trip_stop_no?: number | null;
  po_locked?: boolean | null;
  days_left: number | null;
  address: string | null;
  postcode: string | null;
  building_type: string | null;
  house_type: string | null;
  replacement_disposal: string | null;
  referral: string | null;
  so_ref?: string | null;
  po_nos?: string[];
  possession_date: string | null;
  company_code?: string | null;
  region: string | null;
  regions?: string[];
  warehouse_code: string | null;
  warehouse_name: string | null;
  customer_state: string | null;
  customer_country?: string | null;
  time_range?: string | null;
  time_confirmed?: boolean | null;
  arrival_at?: string | null;
  departure_at?: string | null;
  row_type?: string | null;
  dp_job_type?: string | null;
  assr_id?: number | null;
  job_kind?: string | null;
  shipout_date?: string | null;
  customer_delivered_date?: string | null;
  eta_arriving_port?: string | null;
  delivery_substatus?: string | null;
  do_date?: string | null;
  crew: Crew;
  delivery_orders?: DeliveryOrderRef[];
};

type Counts = {
  ALL: number;
  PENDING_DELIVERY: number;
  PENDING_SCHEDULE: number;
  OVERDUE: number;
  DELIVERED: number;
};

type RegionCfg = { key: string; label: string };

type BoardResponse = {
  orders?: BoardRow[];
  counts?: Counts;
  regions?: RegionCfg[];
};

type Day = "today" | "tomorrow" | "history";
const DAY_TABS: { key: Day; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "history", label: "History" },
];

const dm = (d: string | null | undefined) => formatDate(d);
// The Malaysian day a date-ish string falls on, not the phone's own zone
// (owner 2026-11-09: every date filter judges by the Malaysian day).
const dayKey = (d: string | null | undefined): string => mytDayOfValue(d) ?? "";

const effDateOf = (o: BoardRow): string | null =>
  o.effective_delivery_date ||
  o.customer_delivery_date ||
  o.processing_date ||
  null;

const runDateOf = (o: BoardRow): string | null => o.trip_date || effDateOf(o);

/* History reaches back only to the 1st of the CURRENT month (owner 2026-10-21):
   a run-sheet, not a ledger. The month floor is computed in `buckets`. */

const houseTypeOf = (o: BoardRow): string | null =>
  (o.house_type && o.house_type.trim()) ||
  (o.building_type && o.building_type.trim()) ||
  null;

const latestDo = (o: BoardRow): DeliveryOrderRef | null => {
  const dos = (o.delivery_orders ?? []).filter((d) => d && d.id);
  return dos.length ? dos[dos.length - 1]! : null;
};

type TrackState = "sched" | "otw" | "arrived" | "done" | "late";
const stopFlags = (
  o: BoardRow,
): { started: boolean; arrived: boolean; done: boolean } => {
  const doRef = latestDo(o);
  const st = (doRef?.status ?? "").toUpperCase();
  const done = doRef
    ? st === "DELIVERED" || st === "INVOICED" || st === "SIGNED" || !!o.customer_delivered_date
    : o.delivery_state === "DELIVERED" || !!o.customer_delivered_date;
  const arrived = done || !!o.arrival_at;
  const started =
    done ||
    arrived ||
    st === "IN_TRANSIT" ||
    st === "SIGNED" ||
    !!o.departure_at;
  return { started, arrived, done };
};

const windowEndMin = (o: BoardRow): number | null => timeSlotEndMin(o.time_range);
const isLate = (o: BoardRow, isToday: boolean): boolean => {
  if (!isToday) return false;
  if (stopFlags(o).done) return false;
  const em = windowEndMin(o);
  if (em == null) return false;
  const hm = instantToMytLocal(new Date().toISOString()).slice(11, 16);
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) > em;
};
const trackState = (o: BoardRow, isToday: boolean): TrackState => {
  const { started, arrived, done } = stopFlags(o);
  if (done) return "done";
  if (isLate(o, isToday)) return "late";
  if (arrived) return "arrived";
  if (started) return "otw";
  return "sched";
};

const STATE_COLORS: Record<TrackState, [string, string]> = {
  done: ["#e2f0e9", "#2f8a5b"],
  late: ["#f8eaea", "#b23a3a"],
  arrived: ["#e1efed", "#0c3f39"],
  otw: ["#e1efed", "#0c3f39"],
  sched: ["#f6efd9", "#8a6a2e"],
};
const STATE_LABELS: Record<TrackState, string> = {
  done: "Delivered",
  late: "Late",
  arrived: "Arrived",
  otw: "On the way",
  sched: "Scheduled",
};
const seqBgFor = (st: TrackState): string =>
  st === "done"
    ? "#2f8a5b"
    : st === "late"
      ? "#b23a3a"
      : st === "sched"
        ? "#16695f"
        : "#0c3f39";

export function MobileDeliveryPlanning({
  onBack,
  onOpen,
  onPod,
  completedDoNumber,
}: {
  onBack: () => void;
  onOpen?: (docNo: string) => void;
  onPod?: (doNumber: string, companyCode?: string | null) => void;
  completedDoNumber: string | null;
}) {
  const [day, setDay] = useState<Day>("today");
  const [openStop, setOpenStop] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-delivery-planning", "ALL"],
    queryFn: () =>
      authedFetch<BoardResponse>(`/delivery-planning?region=ALL&state=ALL`),
    select: (d: BoardResponse) => withSavedCrew(d),
    staleTime: 30_000,
  });

  const progressMap = useJobProgressMap();
  // East Malaysia + Singapore ride their own freight channel, not the local
  // lorry run, so they never belong on a driver's run-sheet (owner 2026-10-25).
  const allOrders = useMemo(() => (data?.orders ?? [])
    .filter((o) => !isEastMalaysiaOrSingaporeStop({ region: o.region, state: o.customer_state, country: o.customer_country }))
    .map((o) => {
    const ref = jobRefOf(o);
    const p = ref ? progressMap.get(jobKey(ref)) : undefined;
    return p ? { ...o, departure_at: p.departed_at ?? o.departure_at, arrival_at: p.arrived_at ?? o.arrival_at,
      customer_delivered_date: p.completed_at ?? o.customer_delivered_date } : o;
  }), [data, progressMap]);

  /* HC-0192: office staff watch one driver's day. The choices are the drivers on
     the rows the server already returned, so a driver (whose rows are only their
     own jobs, resolveDeliveryScope) gets a single name and no filter. */
  const [driverFilter, setDriverFilter] = useState("");
  const driverNames = useMemo(
    () => [...new Set(allOrders.filter(isDispatched).map((o) => o.crew?.driver).filter(Boolean) as string[])].sort(),
    [allOrders],
  );
  const shownOrders = useMemo(
    () => (driverFilter ? allOrders.filter((o) => o.crew?.driver === driverFilter) : allOrders),
    [allOrders, driverFilter],
  );

  const { todayKey, tomorrowKey } = useMemo(() => ({ todayKey: todayMyt(), tomorrowKey: todayMyt(1) }), []);

  const buckets = useMemo(() => {
    const today: BoardRow[] = [];
    const tomorrow: BoardRow[] = [];
    const history: BoardRow[] = [];
    // History = the CURRENT month only (owner 2026-10-21): floor at the 1st.
    const monthFloor = `${todayKey.slice(0, 8)}01`;
    for (const o of shownOrders) {
      if (!isDispatched(o)) continue;
      const k = dayKey(runDateOf(o));
      if (k && k === todayKey) {
        today.push(o);
      } else if (k && k === tomorrowKey) {
        tomorrow.push(o);
      } else if (k && k < todayKey && k >= monthFloor) {
        history.push(o);
      }
    }
    // Day first; within a day, the stop's place in its lorry run (Time
    // Arrangement's sequence), else the delivery time slot, else document number
    // — see runSheetTieBreak. Trips are not being filled in, so the time slot is
    // what actually orders the list today (owner 2026-11-01).
    const bySeq = (a: BoardRow, b: BoardRow) => {
      const ak = dayKey(runDateOf(a));
      const bk = dayKey(runDateOf(b));
      if (ak !== bk) return ak < bk ? -1 : 1;
      return runSheetTieBreak(a, b);
    };
    today.sort(bySeq);
    tomorrow.sort(bySeq);
    history.sort((a, b) => -bySeq(a, b));
    return { today, tomorrow, history };
  }, [shownOrders, todayKey, tomorrowKey]);

  const advancedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!completedDoNumber || !data || advancedFor.current === completedDoNumber) return;
    advancedFor.current = completedDoNumber;
    const run = buckets.today;
    const at = run.findIndex((o) => latestDo(o)?.do_number === completedDoNumber);
    const next = run.slice(at + 1).find((o) => !stopFlags(o).done) ?? run.find((o) => !stopFlags(o).done);
    setDay("today");
    setOpenStop(next ? next.so_doc_no : null);
  }, [completedDoNumber, data, buckets]);

  const [advanceAfter, setAdvanceAfter] = useState<string | null>(null);
  useEffect(() => {
    if (!advanceAfter) return;
    const run = buckets.today;
    const at = run.findIndex((o) => o.so_doc_no === advanceAfter);
    if (at >= 0 && !stopFlags(run[at]!).done) return;
    setAdvanceAfter(null);
    const next = run.slice(at + 1).find((o) => !stopFlags(o).done) ?? run.find((o) => !stopFlags(o).done);
    setOpenStop(next ? next.so_doc_no : null);
  }, [advanceAfter, buckets]);

  const list = buckets[day];
  const isToday = day === "today";
  const doneCount = useMemo(
    () => list.filter((o) => stopFlags(o).done).length,
    [list],
  );
  const total = list.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const crewLine = useMemo(() => {
    for (const o of list) {
      const bits = [o.crew?.driver, o.crew?.helper].filter(Boolean) as string[];
      if (bits.length)
        return {
          driver: o.crew?.driver ?? null,
          helper: o.crew?.helper ?? null,
        };
    }
    return null;
  }, [list]);

  const detailOrder = openStop
    ? (allOrders.find((o) => o.so_doc_no === openStop) ?? null)
    : null;
  const detailSeq = detailOrder
    ? Math.max(
        0,
        list.findIndex((o) => o.so_doc_no === detailOrder.so_doc_no),
      ) + 1
    : 0;

  const routeDate = day === "today" ? todayKey : day === "tomorrow" ? tomorrowKey : null;

  const detailJob = detailOrder ? jobRefOf(detailOrder) : null;
  const liveDo = useLiveDoStop(detailOrder && !detailJob ? (latestDo(detailOrder)?.do_number ?? null) : null).data?.deliveryOrder;
  if (detailOrder && detailJob) {
    return (
      <MobileJobStop key={jobKey(detailJob)} jobRef={detailJob} seq={detailSeq} onBack={() => setOpenStop(null)}
        onDone={() => setAdvanceAfter(detailOrder.so_doc_no)} />
    );
  }
  if (detailOrder) {
    return (
      <StopDetail
        order={withLiveDo(detailOrder, liveDo)}
        seq={detailSeq}
        isToday={isToday}
        onBack={() => setOpenStop(null)}
        onOpen={onOpen}
        onPod={onPod}
      />
    );
  }

  const dayLabel = DAY_TABS.find((t) => t.key === day)?.label;
  const routeWeekday = routeDate
    ? new Date(`${routeDate}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })
    : dayLabel;
  const routeDateStr = routeDate ? dm(routeDate) : null;

  return (
    <div
      className="hz-m"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--app-bg)",
      }}
    >
      <header className="hdr">
        <div className="hdr-row">
          <button
            onClick={onBack}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              fontWeight: 700,
              color: "var(--hz-c-primary)",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#16695f"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
            Menu
          </button>
          <span className="eyebrow">Transportation</span>
        </div>
        <div className="scr-title">Last Mile Delivery</div>
        <div
          className="tnum"
          style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}
        >
          {routeWeekday}
          {routeDateStr ? ` · ${routeDateStr}` : ""}
          {crewLine && (crewLine.driver || crewLine.helper) ? (
            <>
              {" · "}
              {crewLine.driver ?? ""}
              {crewLine.driver && crewLine.helper ? " + " : ""}
              {crewLine.helper ?? ""}
            </>
          ) : null}
        </div>

        {crewLine && (crewLine.driver || crewLine.helper) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 11,
              padding: "9px 11px",
              background: "var(--brand-bg)",
              border: "1px solid #cfe2dd",
              borderRadius: 11,
            }}
          >
            <svg
              width="16"
              height="16"
              style={{ flex: "none" }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--brand)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M22 21v-2a4 4 0 0 0-3-3.9"></path>
            </svg>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11.5,
                color: "var(--brand-d)",
                lineHeight: 1.4,
              }}
            >
              {crewLine.driver && (
                <>
                  Assigned to <b>{crewLine.driver}</b> (driver)
                </>
              )}
              {crewLine.driver && crewLine.helper ? " · " : ""}
              {crewLine.helper && (
                <>
                  <b>{crewLine.helper}</b> (helper)
                </>
              )}
            </div>
          </div>
        )}

        <MobileTrackingBanner />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            marginTop: 9,
          }}
        >
          <div
            style={{
              flex: 1,
              height: 7,
              borderRadius: 4,
              background: "var(--line)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: "var(--brand)",
                borderRadius: 4,
              }}
            />
          </div>
          <span
            className="tnum"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--brand-d)",
              whiteSpace: "nowrap",
            }}
          >
            {doneCount} / {total} delivered
          </span>
        </div>

        <div className="chips" style={{ marginTop: 11 }}>
          {DAY_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setDay(t.key)}
              className={day === t.key ? "chip on" : "chip"}
            >
              {t.label}
            </button>
          ))}
        </div>
        {driverNames.length > 1 && (
          <select
            aria-label="Filter by driver"
            value={driverFilter}
            onChange={(e) => setDriverFilter(e.target.value)}
            style={{ marginTop: 9, width: "100%", height: 34, borderRadius: 8, border: "1px solid var(--line)", padding: "0 8px", fontSize: 13, background: "var(--hz-c-surface)" }}
          >
            <option value="">All drivers</option>
            {driverNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
      </header>

      <div
        className="hz-scroll"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 14,
          paddingBottom: 120,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            color: "var(--mut2)",
            margin: "0 2px 12px",
            lineHeight: 1.4,
          }}
        >
          Stops are in delivery order. Tap{" "}
          <b style={{ color: "var(--brand)" }}>Take POD photo</b> when a stop is
          delivered — the photo time becomes the completion time.
        </div>

        {isLoading && (
          <div
            style={{
              textAlign: "center",
              color: "var(--mut2)",
              fontSize: 12,
              padding: "26px 0",
            }}
          >
            Loading…
          </div>
        )}
        {error && (
          <div
            style={{
              textAlign: "center",
              color: "var(--red)",
              fontSize: 12,
              padding: "26px 0",
            }}
          >
            Couldn't load delivery planning. Pull to retry.
          </div>
        )}

        {!isLoading && !error && (
          <>
            {list.length > 0 && (
              <MobileVirtualList
                items={list}
                getKey={(o) => o.so_doc_no}
                estimateHeight={120}
                renderItem={(o, i) => (
                  <StopCard
                    key={o.so_doc_no}
                    o={o}
                    seq={i + 1}
                    isToday={isToday}
                    onOpen={() => setOpenStop(o.so_doc_no)}
                  />
                )}
              />
            )}
            {!list.length && (
              <div className="empty">
                <div className="empty-t">
                  {day === "today"
                    ? "No stops on today's run."
                    : day === "tomorrow"
                      ? "Nothing scheduled for tomorrow."
                      : "No past deliveries."}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const BADGE_CLASS: Record<TrackState, string> = {
  done: "b-green",
  late: "b-red",
  arrived: "b-brand",
  otw: "b-brand",
  sched: "b-amber",
};

function StopPill({ o, isToday }: { o: BoardRow; isToday: boolean }) {
  const st = trackState(o, isToday);
  return (
    <span className={`badge ${BADGE_CLASS[st]}`}>{STATE_LABELS[st]}</span>
  );
}

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: "#5c6156",
        background: "var(--hz-dk-surface-2, #f0f1ed)",
        border: "1px solid var(--line)",
        padding: "3px 8px",
        borderRadius: 7,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/* The job type (owner 2026-10-21) — brand-tinted so a Setup / Dismantle /
   Supplier / Transfer / Lorry service / Service job is told apart from a plain
   delivery at a glance. Reuses the board's own leg -> label map (LEG_LABEL). */
function JobTypeChip({ o }: { o: BoardRow }) {
  const ref = jobRefOf(o);
  const label = ref ? (LEG_LABEL[ref.leg] ?? ref.leg) : "Delivery";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: ".02em",
        color: "var(--brand-d)",
        background: "var(--brand-bg)",
        border: "1px solid var(--line)",
        padding: "3px 8px",
        borderRadius: 7,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

const SUBSTATUS_TONE: Record<string, string> = {
  "Pending Pickup": "#767b6e",
  "Done Shipout": "#2f5d4f",
  "Arrives EM Warehouse": "#2f5d4f",
  "Done Delivered": "#2e7d32",
  Confirm: "#2f5d4f",
  "House Not Ready": "#0c3f39",
  "Request Hold": "#0c3f39",
};

function SubstatusChip({ value }: { value: string }) {
  const tone = SUBSTATUS_TONE[value] ?? "#767b6e";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: tone,
        background: "var(--hz-dk-surface-2, #f0f1ed)",
        border: `1px solid ${tone}`,
        padding: "3px 8px",
        borderRadius: 7,
        whiteSpace: "nowrap",
        flex: "none",
      }}
    >
      {value}
    </span>
  );
}

function DaysLeftChip({ days, done }: { days: number | null; done: boolean }) {
  if (done || days == null || days > 3) return null;
  const overdue = days < 0;
  const label = overdue
    ? `${Math.abs(days)}d overdue`
    : days === 0
      ? "today"
      : `${days}d`;
  return (
    <span className={`badge ${overdue ? "b-red" : "b-brand"}`} style={{ flex: "none" }}>
      {label}
    </span>
  );
}

function StopCard({
  o,
  seq,
  isToday,
  onOpen,
}: {
  o: BoardRow;
  seq: number;
  isToday: boolean;
  onOpen: () => void;
}) {
  const st = trackState(o, isToday);
  const [chipBg, chipFg] = STATE_COLORS[st];
  const seqBg = seqBgFor(st);
  const bal = o.balance_sen_live ?? o.balance_sen ?? 0;
  const fullyPaid = bal <= 0;
  const cust = o.debtor_name || o.so_doc_no || EM;
  const subId = latestDo(o)?.do_number || jobLabelOf(o) || o.so_doc_no || EM;
  const htype = houseTypeOf(o);
  const hasDisposal = !!(o.replacement_disposal && o.replacement_disposal.trim());
  const timeWindow = (o.time_range && o.time_range.trim()) || "";
  const addr = (o.address && o.address.trim()) || "";
  const pc = (o.postcode && o.postcode.trim()) || "";

  return (
    <div
      className="card"
      style={{ cursor: "pointer", padding: 13, marginBottom: 0 }}
      onClick={onOpen}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span
          style={{
            width: 26,
            height: 26,
            flex: "none",
            borderRadius: "50%",
            background: seqBg,
            color: "#fff",
            fontSize: 12,
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {seq}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {cust}
          </div>
          <div className="tnum" style={{ fontSize: 11, color: "var(--mut)" }}>
            {subId}
          </div>
        </div>
        {timeWindow ? (
          <span
            className="tnum"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
              fontWeight: 800,
              padding: "5px 10px",
              borderRadius: 9,
              background: chipBg,
              color: chipFg,
              whiteSpace: "nowrap",
              flex: "none",
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke={chipFg}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 7v5l3 2"></path>
            </svg>
            {timeWindow}
          </span>
        ) : (
          <StopPill o={o} isToday={isToday} />
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginTop: 9,
        }}
      >
        <JobTypeChip o={o} />
        <StopPill o={o} isToday={isToday} />
        <DaysLeftChip days={o.days_left} done={st === "done"} />
        {o.delivery_substatus && o.delivery_substatus.trim() ? (
          <SubstatusChip value={o.delivery_substatus.trim()} />
        ) : null}
        {htype && <MetaChip>{htype}</MetaChip>}
        {hasDisposal && <MetaChip>Disposal</MetaChip>}
      </div>
      {(addr || pc) && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 6,
            marginTop: 9,
            fontSize: 12,
            color: "var(--ink2)",
            lineHeight: 1.4,
          }}
        >
          <svg
            width="14"
            height="14"
            style={{ flex: "none", marginTop: 1 }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--gold)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path>
            <circle cx="12" cy="10" r="3"></circle>
          </svg>
          <span>
            {addr || EM}
            {pc ? (
              <>
                {" "}
                <span
                  className="tnum"
                  style={{ fontWeight: 700, color: "var(--ink)" }}
                >
                  {pc}
                </span>
              </>
            ) : null}
          </span>
        </div>
      )}
      {!fullyPaid && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 11,
            padding: "9px 11px",
            background: "var(--hz-c-accent-soft)",
            border: "1px solid #e8dcc5",
            borderRadius: 10,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: ".06em",
              color: "#8a6a2e",
            }}
          >
            Balance to collect
          </span>
          <span
            className="tnum"
            style={{ fontSize: 16, fontWeight: 800, color: "#8a4b12" }}
          >
            {fmtSen(bal)}
          </span>
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 3,
          marginTop: 10,
          fontSize: 11.5,
          fontWeight: 700,
          color: "var(--brand)",
        }}
      >
        View &amp; deliver <span style={{ fontSize: 15, lineHeight: 1 }}>›</span>
      </div>
    </div>
  );
}


function PdItem({
  n,
  spec,
  q,
}: {
  n: string;
  spec?: string | null;
  q?: number | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        padding: "11px 13px",
        borderBottom: "1px solid var(--line2)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{n}</div>
        {spec && (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--mut)",
              marginTop: 2,
              lineHeight: 1.4,
            }}
          >
            {spec}
          </div>
        )}
      </div>
      {q != null && (
        <span
          className="tnum"
          style={{
            fontSize: 12.5,
            fontWeight: 800,
            color: "var(--brand-d)",
            whiteSpace: "nowrap",
          }}
        >
          ×{q}
        </span>
      )}
    </div>
  );
}

function PdPhotoGroup({
  title,
  note,
  onCapture,
}: {
  title: string;
  note?: string;
  onCapture: () => void;
}) {
  return (
    <div style={{ marginBottom: 11 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 7,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: ".05em",
            color: "var(--hz-c-ink-muted)",
          }}
        >
          {title}
        </span>
        {note && (
          <span style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>{note}</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onCapture}
          style={{
            width: 64,
            height: 64,
            flex: "none",
            border: "1.5px dashed var(--hz-c-border-strong)",
            borderRadius: 11,
            background: "var(--hz-dk-surface-2, #f8f9f6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#16695f"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"></path>
            <circle cx="12" cy="13" r="3"></circle>
          </svg>
        </button>
        <div className="ph" style={{ width: 64, height: 64, borderRadius: 11, flex: "none" }} />
        <div className="ph" style={{ width: 64, height: 64, borderRadius: 11, flex: "none" }} />
      </div>
    </div>
  );
}

function PdAttach({
  title,
  sub,
  onOpen,
}: {
  title: string;
  sub: string;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 12,
        border: "1px solid var(--hz-c-border)",
        borderRadius: 11,
        background: "var(--hz-dk-surface-2, #f8f9f6)",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
        marginBottom: 8,
      }}
    >
      <span
        style={{
          width: 44,
          height: 44,
          flex: "none",
          borderRadius: 9,
          background: "var(--hz-c-primary-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#16695f"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 9l9-6 9 6-9 6-9-6Z"></path>
          <path d="M3 9v6l9 6 9-6V9"></path>
          <path d="M12 15v6"></path>
        </svg>
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-ink)" }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: "var(--hz-c-ink-muted)" }}>{sub}</div>
      </div>
      <span style={{ fontSize: 16, color: "var(--hz-c-primary)" }}>›</span>
    </button>
  );
}

function StopDetail({
  order,
  seq,
  isToday,
  onBack,
  onOpen,
  onPod,
}: {
  order: BoardRow;
  seq: number;
  isToday: boolean;
  onBack: () => void;
  onOpen?: (docNo: string) => void;
  onPod?: (doNumber: string, companyCode?: string | null) => void;
}) {
  const qc = useQueryClient();
  const notify = useNotify();
  const confirm = useConfirm();
  const localities = useLocalities().data;
  const pcIndex = useMemo(() => postcodeIndex(localities ?? []), [localities]);
  const { user, can, pageAccess } = useAuth();
  const canOperateDo = canOperateDeliveryOrders(user, can, pageAccess);
  const canDoSteps = canOperateDo || canDriverCompleteDelivery(user);
  const idemKey = useIdempotencyKey();

  const { started, arrived, done } = stopFlags(order);
  const st = trackState(order, isToday);
  const [chipBg, chipFg] = STATE_COLORS[st];
  const doRef = latestDo(order);
  const doId = doRef?.id || null;
  const bal = order.balance_sen_live ?? order.balance_sen ?? 0;
  const fullyPaid = bal <= 0;
  const eff = dm(effDateOf(order));
  const timeWindow = (order.time_range && order.time_range.trim()) || "";
  const phoneTel = (order.phone || "").replace(/[^0-9+]/g, "");
  const startAt = hhmm(order.departure_at || order.arrival_at);
  const arriveAt = hhmm(order.arrival_at);
  const doneAt = hhmm(order.customer_delivered_date);
  const htype = houseTypeOf(order);
  const moveInDate = order.possession_date ? dm(order.possession_date) : "";
  const referral = (order.so_ref && order.so_ref.trim()) || "";
  const disposal =
    (order.replacement_disposal && order.replacement_disposal.trim()) || "";
  const isSetup = isSetupDismantleJob(order);

  const invalidate = () => {
    invalidateDoShared(qc);
    invalidateInventoryShared(qc);
    invalidateSoShared(qc);
    return Promise.all([
      qc.invalidateQueries({ queryKey: ["mobile-delivery-planning"] }),
      qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] }),
    ]);
  };

  const convert = useMutation({
    mutationFn: async () => {
      const { lines } = await authedFetch<{
        lines: Array<{ soItemId: string; docNo: string; remaining: number }>;
      }>(
        `/delivery-orders-mfg/deliverable-so-lines?docNos=${encodeURIComponent(
          order.so_doc_no,
        )}`,
      );
      const picks = (lines ?? [])
        .filter((l) => l.soItemId && l.remaining > 0)
        .map((l) => ({ soItemId: l.soItemId, qty: l.remaining }));
      if (picks.length === 0) {
        throw new Error("already_delivered");
      }
      return authedFetch<{ id: string; doNumber: string }>(
        `/delivery-orders-mfg/from-sos`,
        idempotentInit(idemKey, { method: "POST", body: JSON.stringify({ picks }) }),
      );
    },
    onSuccess: async () => {
      await invalidate();
    },
  });

  const saveFields = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      authedFetch<{ ok: true; no_do_hint: string | null }>(
        `/delivery-planning/so/${encodeURIComponent(order.so_doc_no)}/fields`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: async () => {
      await invalidate();
    },
  });

  /* The disposal lane. `replacement_disposal` is a CONTROLLED SO field: on a
     processing- or PO-locked order the backend answers 409
     `so_locked_processing` to a direct write and the change has to arrive as an
     SO Amendment for Logistics to approve (owner 2026-07-27). The card decides
     WHICH lane a save takes; this is the second lane's writer. */
  const createAmendment = useCreateAmendment();

  const start = useUpdateMfgDeliveryOrderStatus();

  /* "Arrived" — stamps delivery_orders.arrival_at with the CURRENT time.
     
     The column, and the "Arrived" pill that reads it, both already existed. The
     only writer was a datetime field in the office's edit drawer — somebody
     typing a time after the fact — so a driver never stamped one and the pill
     only ever lit up once the delivery was already done. The button above,
     despite reading "Mark arrived", posts IN_TRANSIT, which is DEPARTURE.
     
     Owner, 2026-08-03: "肯定是要让顾客知道目前司机在哪里了、到达了没有". A customer
     cannot be told "he has arrived" from a field nobody fills in. */
  const arrive = useMutation({
    mutationFn: () => {
      if (!doId) throw new Error("no_do");
      return authedFetch<{ deliveryOrder: unknown }>(
        `/delivery-orders-mfg/${encodeURIComponent(doId)}/arrival`,
        { method: "PATCH", headers: companyHeaderFor(order.company_code) },
      );
    },
    onSuccess: async () => {
      await invalidate();
    },
    onError: async (e) => {
      await notify({
        title: "Couldn't mark arrival",
        body: e instanceof Error ? e.message : "Something went wrong. Please try again.",
      });
    },
  });


  const onConvert = async () => {
    if (convert.isPending) return;
    const go = await confirm({
      title: "Create delivery order?",
      body: "This turns this sales order's still-undelivered lines into a delivery order (one DO) so this stop can be started and delivered. Fully delivered orders are skipped.",
      confirmLabel: "Create DO",
    });
    if (!go) return;
    try {
      await convert.mutateAsync();
      await notify({ title: "Delivery order created", body: "You can now start and complete this stop." });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      if (msg === "already_delivered") {
        await notify({ title: "Nothing to deliver", body: "Every line on this order is already delivered." });
      } else {
        await notify({ title: "Couldn't create the delivery order", body: msg });
      }
    }
  };

  const requireDo = async (): Promise<boolean> => {
    if (doId) return true;
    if (!canOperateDo) {
      await notify({
        title: "No delivery order yet",
        body: "This stop has no delivery order, and creating one is handled by the Office team. Ask Office to raise the DO, then start this stop.",
      });
      return false;
    }
    await onConvert();
    return false;
  };

  const onStart = async () => {
    if (!canDoSteps) return;
    if (!(await requireDo())) return;
    if (!doId) return;
    start.mutate({ id: doId, status: "IN_TRANSIT", companyCode: order.company_code }, {
      onSuccess: async () => { await invalidate(); },
      onError: async (e) => {
        await notify({
          title: "Couldn't start the delivery",
          body: e instanceof Error ? e.message : "Something went wrong. Please try again.",
        });
      },
    });
  };

  const onArrive = async () => {
    if (!canDoSteps) return;
    if (!(await requireDo())) return;
    arrive.mutate();
  };

  const onComplete = async () => {
    if (!canDoSteps) return;
    if (!(await requireDo())) return;
    const doNumber = doRef?.do_number;
    if (!doNumber || !onPod) {
      await notify({
        title: "Can't open Proof of Delivery",
        body: "This stop's delivery order number isn't available yet. Pull to refresh, then try again.",
      });
      return;
    }
    onPod(String(doNumber), order.company_code ?? null);
  };

  const busy = start.isPending || arrive.isPending;
  const goToDo = () => onOpen?.(order.so_doc_no);
  const [editingFields, setEditingFields] = useState(false);

  return (
    <div
      className="hz-m"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--app-bg)",
      }}
    >
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Last Mile Delivery
          </button>
          <StopPill o={order} isToday={isToday} />
        </div>
        <div className="eyebrow" style={{ marginTop: 7 }}>
          Stop {seq} ·{" "}
          <span className="tnum">
            {doRef?.do_number || order.so_doc_no || EM}
          </span>
        </div>
        <div className="scr-title">
          {order.debtor_name || order.so_doc_no || EM}
        </div>
      </header>

      <div
        className="hz-scroll"
        style={{ flex: 1, overflowY: "auto", padding: 12, paddingBottom: 40 }}
      >
        {st === "late" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "10px 12px",
              background: "var(--hz-c-err-bg)",
              border: "1px solid #eccccc",
              borderRadius: 11,
              marginBottom: 12,
            }}
          >
            <svg
              width="16"
              height="16"
              style={{ flex: "none" }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="#b23a3a"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 8v4M12 16h.01"></path>
            </svg>
            <div
              style={{ fontSize: 11.5, color: "#8a2b2b", lineHeight: 1.4 }}
            >
              {timeWindow ? (
                <>
                  Past the {timeWindow} window — this stop is running{" "}
                  <b>late</b>.
                </>
              ) : (
                <>
                  This stop is past its delivery date and running <b>late</b>.
                </>
              )}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 9, marginBottom: 12 }}>
          {phoneTel ? (
            <a
              href={`tel:${phoneTel}`}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                height: 42,
                border: "1px solid var(--hz-c-border)",
                borderRadius: 11,
                background: "var(--hz-c-surface)",
                color: "var(--hz-c-primary)",
                fontSize: 12.5,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#16695f"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 11a16 16 0 0 0 6 6l1.6-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z"></path>
              </svg>
              Call customer
            </a>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                height: 42,
                border: "1px solid var(--hz-dk-border-subtle, #eceee9)",
                borderRadius: 11,
                background: "var(--hz-c-surface-2)",
                color: "var(--hz-c-ink-soft)",
                fontSize: 12.5,
                fontWeight: 700,
              }}
            >
              No phone
            </div>
          )}
          {order.address || order.postcode ? (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                [order.address, order.postcode].filter(Boolean).join(" "),
              )}`}
              target="_blank"
              rel="noreferrer"
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                height: 42,
                border: "1px solid var(--hz-c-border)",
                borderRadius: 11,
                background: "var(--hz-c-surface)",
                color: "var(--hz-c-primary)",
                fontSize: 12.5,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#16695f"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path>
                <circle cx="12" cy="10" r="3"></circle>
              </svg>
              Navigate
            </a>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                height: 42,
                border: "1px solid var(--hz-dk-border-subtle, #eceee9)",
                borderRadius: 11,
                background: "var(--hz-c-surface-2)",
                color: "var(--hz-c-ink-soft)",
                fontSize: 12.5,
                fontWeight: 700,
              }}
            >
              No address
            </div>
          )}
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-h">
            <span className="card-t">Delivery</span>
          </div>
          {pdRow(
            "Window",
            timeWindow ? (
              <>
                <span className="tnum">{timeWindow}</span> · {eff}
              </>
            ) : (
              eff
            ),
            true,
          )}
          {pdRow("House type", htype || EM, true)}
          {moveInDate ? pdRow("Move-in date", moveInDate, false) : null}
          {pdRow("Address", order.address || EM, false)}
          {pdRow(
            "Postcode",
            <span className="tnum">{order.postcode ? postcodeLabel(pcIndex, order.postcode, order.customer_state) : EM}</span>,
            true,
          )}
          {pdRow(
            "Location",
            order.customer_state || order.region || order.warehouse_code || order.warehouse_name || EM,
            false,
          )}
          {pdRow("Driver", order.crew?.driver || EM, true)}
          {pdRow("Helper", order.crew?.helper || EM, false, true)}
        </div>

        {!doId && canOperateDo && (
          <button
            onClick={onConvert}
            disabled={convert.isPending}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              height: 44,
              border: "1.5px solid var(--hz-c-primary)",
              borderRadius: 11,
              background: "var(--hz-c-surface)",
              color: "var(--hz-c-primary)",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 700,
              cursor: convert.isPending ? "default" : "pointer",
              opacity: convert.isPending ? 0.6 : 1,
              marginBottom: 12,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#16695f"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"></path>
              <circle cx="5.5" cy="18.5" r="2.5"></circle>
              <circle cx="18.5" cy="18.5" r="2.5"></circle>
            </svg>
            {convert.isPending ? "Creating delivery order…" : "Create delivery order"}
          </button>
        )}

        <DeliveryFieldsCard
          order={order}
          hasDo={!!doId}
          editing={editingFields}
          saving={saveFields.isPending || createAmendment.isPending}
          onEdit={() => setEditingFields(true)}
          onCancel={() => setEditingFields(false)}
          onSave={async (body, amendment) => {
            if (Object.keys(body).length > 0) {
              try {
                await saveFields.mutateAsync(body);
              } catch (e) {
                await notify({
                  title: "Couldn't save",
                  body: e instanceof Error ? e.message : "Something went wrong.",
                });
                return;
              }
            }
            if (amendment) {
              try {
                await createAmendment.mutateAsync({
                  docNo: order.so_doc_no,
                  reason: "Replacement / disposal update (mobile run sheet)",
                  lines: [],
                  headerChanges: { replacementDisposal: amendment.disposal },
                });
              } catch (e) {
                await notify({
                  title: "Disposal change NOT submitted",
                  body: `${
                    e instanceof Error ? e.message : "Something went wrong."
                  } The other fields were saved.`,
                  tone: "error",
                });
                return;
              }
              await notify({
                title: "Saved — disposal change sent for approval",
                body: "The Replacement / Disposal change was raised as an SO Amendment. Logistics reviews and approves it.",
              });
            }
            setEditingFields(false);
          }}
        />

        <GoodsToDeliverCard order={order} />

        {disposal && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 9,
              padding: "11px 12px",
              background: "var(--hz-c-accent-soft)",
              border: "1px solid #e8dcc5",
              borderRadius: 11,
              marginBottom: 12,
            }}
          >
            <svg
              width="16"
              height="16"
              style={{ flex: "none", marginTop: 1 }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="#8a4b12"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
            </svg>
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: ".05em",
                  color: "#8a4b12",
                }}
              >
                Disposal required
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "#6a4a1e",
                  marginTop: 2,
                  lineHeight: 1.4,
                }}
              >
                {disposal}
              </div>
            </div>
          </div>
        )}

        {isSetup && (
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-h">
              <span className="card-t">Setup &amp; dismantle photos</span>
              <span className="card-sub">POD · upload on site</span>
            </div>
            <div className="card-b">
              <PdPhotoGroup
                title="Overall booth"
                note="on arrival"
                onCapture={goToDo}
              />
              <PdPhotoGroup
                title="Setup complete (POD)"
                note="completion proof"
                onCapture={goToDo}
              />
              <PdAttach
                title="3D floor plan"
                sub="Open order to view the placement layout"
                onOpen={goToDo}
              />
            </div>
          </div>
        )}

        <div className="card" style={{ marginBottom: 12 }}>
          {pdRow(
            "Sales Order",
            <span className="tnum">{order.so_doc_no || EM}</span>,
            true,
          )}
          {pdRow(
            "Delivery Order",
            <span className="tnum">{doRef?.do_number || EM}</span>,
            true,
          )}
          {referral
            ? pdRow("Reference", <span className="tnum">{referral}</span>, false)
            : null}
          {order.po_nos?.length
            ? pdRow("PO No.", <span className="tnum">{order.po_nos.join(", ")}</span>, false)
            : null}
          {order.delivery_message_status
            ? pdRow("Delivery status", order.delivery_message_status, false)
            : null}
          {pdRow(
            "Branding",
            (order.branding && order.branding.trim()) || EM,
            false,
            true,
          )}
        </div>

        {fullyPaid ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              background: "var(--bg)",
              border: "1px solid var(--line)",
              borderRadius: 12,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                color: "var(--mut)",
              }}
            >
              Balance to collect
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--green)" }}>
              No balance — fully paid
            </span>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              background: "var(--hz-c-accent-soft)",
              border: "1px solid #e8dcc5",
              borderRadius: 12,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                color: "#8a6a2e",
              }}
            >
              Balance to collect
            </span>
            <span
              className="tnum"
              style={{ fontSize: 19, fontWeight: 800, color: "#8a4b12" }}
            >
              {fmtSen(bal)}
            </span>
          </div>
        )}

        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-h">
            <span className="card-t">Delivery tracking</span>
            <span className="card-sub">On the way → Arrived → POD</span>
          </div>
          <div className="card-b">
            {start.error && (
              <div
                style={{ fontSize: 12, color: "var(--red)", marginBottom: 9 }}
              >
                {(() => {
                  const e = start.error;
                  return e instanceof Error && e.message !== "no_do"
                    ? e.message
                    : "Couldn't update this stop. Please try again.";
                })()}
              </div>
            )}

            {started ? (
              <TrackStep
                tone="teal"
                label="On the way"
                time={startAt ? `${startAt} · ${eff}` : eff}
              />
            ) : canDoSteps ? (
              <TrackButton
                onClick={onStart}
                busy={busy}
                label={start.isPending ? "Starting…" : "Start — I'm on the way"}
                icon="arrow"
              />
            ) : null}

            {arrived ? (
              <TrackStep
                tone="teal"
                label="Arrived at location"
                time={arriveAt ? `${arriveAt} · ${eff}` : eff}
                border
              />
            ) : started && canDoSteps ? (
              <TrackButton
                onClick={onArrive}
                busy={busy}
                label={arrive.isPending ? "Marking…" : "Mark arrived"}
                icon="pin"
              />
            ) : null}

            {done ? (
              <TrackStep
                tone="green"
                label="Delivered — POD uploaded"
                time={doneAt ? `${doneAt} · ${eff}` : eff}
                border
                check
              />
            ) : arrived && canDoSteps ? (
              <TrackButton
                onClick={onComplete}
                busy={busy}
                label="Take POD photo — complete"
                icon="camera"
                primary
              />
            ) : null}

            {!canDoSteps && !done && (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--mut2)",
                  padding: "9px 0 2px",
                  lineHeight: 1.4,
                }}
              >
                Updating this stop&apos;s status is handled by the Office team.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GoodsToDeliverCard({ order }: { order: BoardRow }) {
  const linesQ = useDeliveryPlanningLines(order.so_doc_no);
  const lines = ((linesQ.data ?? []) as PlanningLineItem[]).filter((l) => !l.cancelled);
  const doNo = latestDo(order)?.do_number;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h">
        <span className="card-t">Goods to deliver</span>
        <span className="card-sub">
          {lines.length ? `${lines.length} line${lines.length === 1 ? "" : "s"}` : "open order for lines"}
        </span>
      </div>
      {linesQ.isLoading ? (
        <div style={{ fontSize: 11.5, color: "var(--mut2)", padding: "11px 13px" }}>Loading lines{"…"}</div>
      ) : lines.length ? (
        lines.map((l) => {
          const ident = orderLineIdentity({ code: l.item_code, description: l.description, variant: l.description2 });
          return <PdItem key={l.id} n={ident.primary || EM} spec={ident.secondary} q={l.qty} />;
        })
      ) : (
        <PdItem
          n={(order.branding && order.branding.trim()) || "Delivery order lines"}
          spec={doNo ? `Delivery order ${doNo}` : `Sales order ${order.so_doc_no}`}
        />
      )}
    </div>
  );
}

function TrackStep({
  tone,
  label,
  time,
  border,
  check,
}: {
  tone: "teal" | "green";
  label: string;
  time: string;
  border?: boolean;
  check?: boolean;
}) {
  const bg = tone === "green" ? "#e2f0e9" : "#e1efed";
  const fg = tone === "green" ? "#2f8a5b" : "#0c3f39";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 0",
        borderTop: border ? "1px solid #eceee9" : undefined,
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          flex: "none",
          borderRadius: "50%",
          background: bg,
          color: fg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {check ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke={fg}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5"></path>
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke={fg}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14M13 6l6 6-6 6"></path>
          </svg>
        )}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-ink)" }}>
          {label}
        </div>
        {time && (
          <div className="tnum" style={{ fontSize: 11, color: "var(--hz-c-ink-muted)" }}>
            {time}
          </div>
        )}
      </div>
    </div>
  );
}

function TrackButton({
  onClick,
  busy,
  label,
  icon,
  primary,
}: {
  onClick: () => void;
  busy: boolean;
  label: string;
  icon: "arrow" | "pin" | "camera";
  primary?: boolean;
}) {
  const stroke = primary ? "#fff" : "#16695f";
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        height: primary ? 46 : 44,
        border: primary ? "none" : "1.5px solid var(--hz-c-primary)",
        borderRadius: 11,
        background: primary ? (busy ? "#7fb4ad" : "var(--hz-c-primary)") : "var(--hz-c-surface)",
        color: primary ? "#fff" : "var(--hz-c-primary)",
        fontFamily: "inherit",
        fontSize: primary ? 13.5 : 13,
        fontWeight: primary ? 800 : 700,
        cursor: busy ? "default" : "pointer",
        marginTop: 9,
        opacity: busy && !primary ? 0.6 : 1,
      }}
    >
      {icon === "arrow" && (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14M13 6l6 6-6 6"></path>
        </svg>
      )}
      {icon === "pin" && (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path>
          <circle cx="12" cy="10" r="3"></circle>
        </svg>
      )}
      {icon === "camera" && (
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"></path>
          <circle cx="12" cy="13" r="3"></circle>
        </svg>
      )}
      {label}
    </button>
  );
}