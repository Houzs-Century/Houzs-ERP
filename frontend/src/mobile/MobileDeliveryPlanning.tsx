import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orderLineIdentity } from "@2990s/shared";
import { invalidateDoShared, invalidateInventoryShared, invalidateSoShared } from "./sharedInvalidate";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { idempotentInit, useIdempotencyKey } from "../lib/idempotency";
import { MobileVirtualList } from "./MobileVirtualList";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import {
  HC_SUBSTATUS_VALUES,
  useDeliveryPlanningLines,
  type PlanningLineItem,
} from "../vendor/scm/lib/delivery-planning-queries";
import { fmtCenti } from "../lib/scm";
import { formatDate } from "../lib/utils";
import { useAuth } from "../auth/AuthContext";
import { canOperateDeliveryOrders } from "../auth/salesAccess";
import "./mobile.css";

/* ------------------------------------------------------------------ *
 * Mobile Delivery Planning — driver run-sheet screen (v2 job card).
 *
 * The owner's v2 mobile design turns each delivery stop into a full
 * JOB CARD run-sheet: a Today / Tomorrow / History day view, a per-stop
 * card (seq badge coloured by state, customer, kind/house-type chips, a
 * time window, house type, item list, balance to collect) and a per-stop
 * DETAIL (tracking timeline Start → Arrive → Done, Call + Navigate,
 * Emergency contact, balance block, item list, and for Setup jobs a
 * photo group + 3D floor-plan attach), plus a late banner.
 *
 * Wired to the SAME GET /delivery-planning the desktop board uses. The
 * route returns { orders, counts, regions }; we drop the region/state
 * chips and split `orders` into three day-buckets by their effective
 * delivery date:
 *   · Today    — effective delivery date == today
 *   · Tomorrow — effective delivery date == tomorrow
 *   · History  — delivered, OR effective delivery date in the past
 * Anything further out (and not delivered) is left off the driver
 * run-sheet; the desktop board owns long-range planning.
 *
 * v2 has three stop KINDS (delivery / service / project); the backend
 * /delivery-planning feed is Sales-Order deliveries only, so every stop
 * renders as the v2 DELIVERY job card. The service/project variants are
 * intentionally not built — there is no backend source for them.
 *
 * Per-stop actions map to the REAL DO status machine on the latest
 * (non-DRAFT/CANCELLED) delivery order for the SO:
 *   · Start / Mark arrived  → PATCH /delivery-orders-mfg/:id/status
 *                             { status: 'IN_TRANSIT' }
 *     (DOs are created at DISPATCHED, so goods are already OUT; IN_TRANSIT
 *      is inventory-idempotent and just flips the pill to "On the way".)
 *   · POD complete          → PATCH /delivery-orders-mfg/:id/status
 *                             { status: 'DELIVERED' }  (stamps delivered_at,
 *                             behind an in-app useConfirm). The FULL photo /
 *                             signature POD capture lives behind onOpen(doc).
 * A stop with no DO yet can't be started/completed here — it deep-links to
 * the SO via onOpen so the office cuts the DO first.
 *
 * REAL-DATA DISCIPLINE: fields the backend does NOT provide (emergency
 * contact, move type, per-item spec, sales-rep contact, 3D floor plan)
 * are omitted, never invented. Money is balance-only and never NaN.
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
  balance_centi: number | null;
  balance_centi_live: number | null;
  local_total_centi: number | null;
  so_date: string | null;
  customer_delivery_date: string | null;
  amended_delivery_date: string | null;
  effective_delivery_date: string | null;
  internal_expected_dd: string | null;
  days_left: number | null;
  address: string | null;
  postcode: string | null;
  building_type: string | null;
  house_type: string | null;
  replacement_disposal: string | null;
  // HC SO-context: the customer's referral / reference tag and the possession
  // ("move") date — both surfaced on the stop detail when present.
  referral: string | null;
  possession_date: string | null;
  region: string | null;
  regions?: string[];
  warehouse_code: string | null;
  warehouse_name: string | null;
  customer_state: string | null;
  time_range?: string | null;
  time_confirmed?: boolean | null;
  arrival_at?: string | null;
  departure_at?: string | null;
  // Cross-border (EM/SG) DO-execution dates — provided by /delivery-planning
  // from the latest DO. Needed so an EM/SG stop's shipout + arriving-port can be
  // entered on mobile (desktop parity with DeliveryFieldsDrawer).
  shipout_date?: string | null;
  customer_delivered_date?: string | null;
  eta_arriving_port?: string | null;
  delivery_substatus?: string | null;
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

// ── Day tabs ──
type Day = "today" | "tomorrow" | "history";
const DAY_TABS: { key: Day; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "history", label: "History" },
];

// ── Formatters — never render null / undefined / NaN. ──
const EM = "—";
// TZ-aware numeric DD/MM/YYYY via the shared helper (returns "—" for blank /
// unparseable), so date-only strings render in Asia/Kuala_Lumpur without an
// off-by-one on an off-zone device.
const dm = (d: string | null | undefined) => formatDate(d);
// Local YYYY-MM-DD key for a date-ish string.
const dayKey = (d: string | null | undefined): string => {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(+dt)) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
// Time-of-day HH:MM from an ISO timestamp (for the tracking timeline).
const hhmm = (ts: string | null | undefined): string => {
  if (!ts) return "";
  const dt = new Date(ts);
  if (isNaN(+dt)) return "";
  return `${String(dt.getHours()).padStart(2, "0")}:${String(
    dt.getMinutes(),
  ).padStart(2, "0")}`;
};

// The effective delivery date the run-sheet buckets on.
const effDateOf = (o: BoardRow): string | null =>
  o.effective_delivery_date ||
  o.customer_delivery_date ||
  o.internal_expected_dd ||
  null;

// House type — HC raw-data field, falling back to the SO building_type.
const houseTypeOf = (o: BoardRow): string | null =>
  (o.house_type && o.house_type.trim()) ||
  (o.building_type && o.building_type.trim()) ||
  null;

// The latest (last) DO reference — the crew / status source-of-truth, matching
// the board's "latest DO wins" convention.
const latestDo = (o: BoardRow): DeliveryOrderRef | null => {
  const dos = (o.delivery_orders ?? []).filter((d) => d && d.id);
  return dos.length ? dos[dos.length - 1]! : null;
};

// Stop tracking state derived from REAL data — DO status + timestamps.
// done    = latest DO is DELIVERED/INVOICED (or a delivered timestamp exists).
// arrived = an arrival timestamp exists (or done).
// started = "on the way": DO is IN_TRANSIT/SIGNED/…, a departure/arrival
//           timestamp exists, or the bucket says DELIVERED.
type TrackState = "sched" | "otw" | "arrived" | "done" | "late";
const stopFlags = (
  o: BoardRow,
): { started: boolean; arrived: boolean; done: boolean } => {
  const st = (latestDo(o)?.status ?? "").toUpperCase();
  const done =
    st === "DELIVERED" ||
    st === "INVOICED" ||
    o.delivery_state === "DELIVERED" ||
    !!o.customer_delivered_date;
  const arrived = done || !!o.arrival_at;
  const started =
    done ||
    arrived ||
    st === "IN_TRANSIT" ||
    st === "SIGNED" ||
    !!o.departure_at;
  return { started, arrived, done };
};

// Parse "HH:MM" → minutes; tolerant of the "09:00–10:00" window's end.
const toMin = (t: string | null | undefined): number | null => {
  if (!t) return null;
  const p = t.split(":");
  if (p.length < 2) return null;
  const h = Number(p[0]);
  const m = Number(p[1]);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
};
const windowEndMin = (o: BoardRow): number | null => {
  const w = o.time_range || "";
  const end = w.split(/[–-]/)[1];
  return toMin(end ? end.trim() : null);
};
// A today stop is "late" once we're past its delivery window and it isn't done.
const isLate = (o: BoardRow, isToday: boolean): boolean => {
  if (!isToday) return false;
  if (stopFlags(o).done) return false;
  const em = windowEndMin(o);
  if (em == null) return false;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() > em;
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
}: {
  onBack: () => void;
  onOpen?: (docNo: string) => void;
}) {
  const [day, setDay] = useState<Day>("today");
  // The stop currently open in the detail view (its SO doc_no).
  const [openStop, setOpenStop] = useState<string | null>(null);

  // Board fetch — all regions, all states; we bucket client-side by day.
  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-delivery-planning", "ALL"],
    queryFn: () =>
      authedFetch<BoardResponse>(`/delivery-planning?region=ALL&state=ALL`),
    staleTime: 30_000,
  });

  const allOrders = data?.orders ?? [];

  // today / tomorrow local day keys.
  const { todayKey, tomorrowKey } = useMemo(() => {
    const now = new Date();
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tm = new Date(t);
    tm.setDate(tm.getDate() + 1);
    return {
      todayKey: dayKey(t.toISOString()),
      tomorrowKey: dayKey(tm.toISOString()),
    };
  }, []);

  // Split into the three day-buckets, each ordered by effective date then doc.
  const buckets = useMemo(() => {
    const today: BoardRow[] = [];
    const tomorrow: BoardRow[] = [];
    const history: BoardRow[] = [];
    for (const o of allOrders) {
      const { done } = stopFlags(o);
      const k = dayKey(effDateOf(o));
      if (done) {
        history.push(o);
      } else if (k && k === todayKey) {
        today.push(o);
      } else if (k && k === tomorrowKey) {
        tomorrow.push(o);
      } else if (k && k < todayKey) {
        // past-due, still not delivered → keep on the driver's radar as History.
        history.push(o);
      }
      // else: further-out / undated → left off the run-sheet (desktop owns it).
    }
    const bySeq = (a: BoardRow, b: BoardRow) => {
      const ak = dayKey(effDateOf(a));
      const bk = dayKey(effDateOf(b));
      if (ak !== bk) return ak < bk ? -1 : 1;
      return (a.so_doc_no || "").localeCompare(b.so_doc_no || "");
    };
    today.sort(bySeq);
    tomorrow.sort(bySeq);
    // History newest-first.
    history.sort((a, b) => -bySeq(a, b));
    return { today, tomorrow, history };
  }, [allOrders, todayKey, tomorrowKey]);

  const list = buckets[day];
  const isToday = day === "today";
  const doneCount = useMemo(
    () => list.filter((o) => stopFlags(o).done).length,
    [list],
  );
  const total = list.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  // Crew line — from the first stop that carries one (single-lorry run-sheet).
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
  // 1-based sequence within the current day bucket for the open stop.
  const detailSeq = detailOrder
    ? Math.max(
        0,
        list.findIndex((o) => o.so_doc_no === detailOrder.so_doc_no),
      ) + 1
    : 0;

  // route_date = the date the active day bucket represents (today / tomorrow;
  // History has no single date, so we fall back to the tab label). MUST be
  // declared BEFORE the detailOrder early-return below, or opening a stop
  // renders fewer hooks than the list view and React throws error #300.
  const routeDate = useMemo(() => {
    const now = new Date();
    if (day === "today") return now;
    if (day === "tomorrow") {
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      return t;
    }
    return null;
  }, [day]);

  if (detailOrder) {
    return (
      <StopDetail
        order={detailOrder}
        seq={detailSeq}
        isToday={isToday}
        onBack={() => setOpenStop(null)}
        onOpen={onOpen}
      />
    );
  }

  const dayLabel = DAY_TABS.find((t) => t.key === day)?.label;
  const routeWeekday = routeDate
    ? routeDate.toLocaleDateString("en-GB", { weekday: "long" })
    : dayLabel;
  const routeDateStr = routeDate ? dm(routeDate.toISOString()) : null;

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
              color: "#16695f",
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
        <div className="scr-title">Delivery Planning</div>
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

// Track state → canonical badge variant (spec § States → badge).
const BADGE_CLASS: Record<TrackState, string> = {
  done: "b-green",
  late: "b-red",
  arrived: "b-brand",
  otw: "b-brand",
  sched: "b-amber",
};

// ── Status pill — canonical .badge tinted per track state. ──
function StopPill({ o, isToday }: { o: BoardRow; isToday: boolean }) {
  const st = trackState(o, isToday);
  return (
    <span className={`badge ${BADGE_CLASS[st]}`}>{STATE_LABELS[st]}</span>
  );
}

// ── A grey pill chip (house type / crew) — mirrors metaChip(). ──
function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: "#5c6156",
        background: "#f0f1ed",
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

/* HC "Remark 4" delivery sub-status → pill tone. Mirrors the desktop board's
   SUBSTATUS_TONE (pages/scm-v2/DeliveryPlanning.tsx) verbatim. The VALUES are
   already shared via HC_SUBSTATUS_VALUES, but the display tone is desktop-local,
   so it is replicated here rather than pulling the whole desktop screen into the
   mobile bundle. Unknown / blank → muted. */
const SUBSTATUS_TONE: Record<string, string> = {
  "Pending Pickup": "#767b6e",
  "Done Shipout": "#2f5d4f",
  "Arrives EM Warehouse": "#2f5d4f",
  "Done Delivered": "#2e7d32",
  Confirm: "#2f5d4f",
  "House Not Ready": "#0c3f39",
  "Request Hold": "#0c3f39",
};

// ── Sub-status chip — a MetaChip-shaped pill tinted with the desktop tone. ──
function SubstatusChip({ value }: { value: string }) {
  const tone = SUBSTATUS_TONE[value] ?? "#767b6e";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: tone,
        background: "#f0f1ed",
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

// ── days_left urgency micro-pill — the desktop board shows days_left in a
// column; here we raise only the URGENT states so a past-due History row reads
// as overdue instead of just "Scheduled". Reuses the canonical .badge tints: red
// for overdue, brand for today / due-soon. Delivered or far-out (>3d) → nothing.
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
  const bal = o.balance_centi_live ?? o.balance_centi ?? 0;
  const fullyPaid = bal <= 0;
  const cust = o.debtor_name || o.so_doc_no || EM;
  const subId = latestDo(o)?.do_number || o.so_doc_no || EM;
  const htype = houseTypeOf(o);
  const hasDisposal = !!(o.replacement_disposal && o.replacement_disposal.trim());
  const timeWindow = (o.time_range && o.time_range.trim()) || "";
  const addr = (o.address && o.address.trim()) || "";
  const pc = (o.postcode && o.postcode.trim()) || "";

  // Designer stop-card layout (planStopCard): seq circle + title + doc sub +
  // a state-tinted clock time-pill; then the status Badge + house-type / disposal
  // tag chips; then a pin address line + postcode; then the balance-only block;
  // then the "View & deliver ›" CTA. Real data + our track-state Late pill.
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
            background: "#f3ece0",
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
            {fmtCenti(bal)}
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

/* ── StopDetail — per-stop job-card detail: late banner, Call / Navigate,
   Emergency contact, the delivery-info card, goods-to-deliver item list,
   disposal callout, Setup photo group + 3D floor-plan attach, sales/doc
   rows, the balance-to-collect block, and the Delivery-tracking timeline
   (Start → Arrive → Done) wired to the DO status endpoint.
   ─────────────────────────────────────────────────────────────────────── */

// pdRow — a canonical label:value row (.row / .row-l / .row-v). `last` drops
// the divider (matches .row:last-child).
function pdRow(label: string, val: ReactNode, strong?: boolean, last?: boolean) {
  return (
    <div
      className="row"
      style={last ? { borderBottom: "none" } : undefined}
    >
      <span className="row-l">{label}</span>
      <span className={strong ? "row-v strong" : "row-v"}>{val}</span>
    </div>
  );
}

// pdItem — one goods line (name + optional spec + qty). Mirrors pdItem().
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

// pdPhotoGroup — a capture row (camera tile + placeholder slots). Mirrors
// pdPhotoGroup(); the real capture lives behind onOpen(doc).
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
            color: "#767b6e",
          }}
        >
          {title}
        </span>
        {note && (
          <span style={{ fontSize: 10.5, color: "#9aa093" }}>{note}</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onCapture}
          style={{
            width: 64,
            height: 64,
            flex: "none",
            border: "1.5px dashed #c2c6bd",
            borderRadius: 11,
            background: "#f8f9f6",
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

// pdAttach — an attachment row (icon + title + sub). Mirrors pdAttach().
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
        border: "1px solid #d6d9d2",
        borderRadius: 11,
        background: "#f8f9f6",
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
          background: "#e1efed",
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
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f" }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: "#767b6e" }}>{sub}</div>
      </div>
      <span style={{ fontSize: 16, color: "#16695f" }}>›</span>
    </button>
  );
}

function StopDetail({
  order,
  seq,
  isToday,
  onBack,
  onOpen,
}: {
  order: BoardRow;
  seq: number;
  isToday: boolean;
  onBack: () => void;
  onOpen?: (docNo: string) => void;
}) {
  const qc = useQueryClient();
  const notify = useNotify();
  const confirm = useConfirm();
  /* Operating a DO — cutting one (/from-sos) AND advancing its status
     (/status: IN_TRANSIT / DELIVERED) — is the Office department's job (owner
     2026-07-17), and the backend 403s the Sales cohort on BOTH. Drivers and
     Office are unaffected — they are not the Sales cohort. Same ONE helper the
     desktop board and every other DO control resolve through, so the Convert +
     Start/Arrived/POD actions share this single gate (was Convert-only, which
     left the status buttons ungated once a DO existed). */
  const { user, can, pageAccess } = useAuth();
  const canOperateDo = canOperateDeliveryOrders(user, can, pageAccess);
  /* One key for the one DO this stop can cut (lib/idempotency.ts). NOT on
     fix/so-idempotency's list — it names the DO hook, and this surface reaches
     /delivery-orders-mfg/from-sos through a bare authedFetch instead — but it is
     the same document and the same 4G driver, so it is fixed in the same PR.

     WHY PER-MOUNT IS PER-ORDER HERE, since this component takes `order` as a
     PROP rather than owning it — that would normally be the collapse trap (React
     reuses an instance at the same position and a lazy useState would then hand
     TWO stops ONE key, silently replaying stop A's DO for stop B). It cannot
     happen: MobileDeliveryPlanning renders this behind an EARLY RETURN (`if
     (detailOrder) return <StopDetail .../>`, :378), so the board is not mounted
     while a stop is open, and the only way to reach another stop is onBack →
     setOpenStop(null) → this unmounts. There is no order-A→order-B prop
     transition. If that early return is ever replaced by rendering StopDetail
     inside the list, this key MUST move onto the order identity — the invariant
     it rests on is that the mount is one stop. */
  const idemKey = useIdempotencyKey();

  const { started, arrived, done } = stopFlags(order);
  const st = trackState(order, isToday);
  const [chipBg, chipFg] = STATE_COLORS[st];
  const doRef = latestDo(order);
  const doId = doRef?.id || null;
  const bal = order.balance_centi_live ?? order.balance_centi ?? 0;
  const fullyPaid = bal <= 0;
  const eff = dm(effDateOf(order));
  const timeWindow = (order.time_range && order.time_range.trim()) || "";
  const phoneTel = (order.phone || "").replace(/[^0-9+]/g, "");
  const startAt = hhmm(order.departure_at || order.arrival_at);
  const arriveAt = hhmm(order.arrival_at);
  const doneAt = hhmm(order.customer_delivered_date);
  const htype = houseTypeOf(order);
  const moveInDate = order.possession_date ? dm(order.possession_date) : "";
  const referral = (order.referral && order.referral.trim()) || "";
  const disposal =
    (order.replacement_disposal && order.replacement_disposal.trim()) || "";
  const isSetup = !!disposal; // v2 "job" isn't in the feed; treat disposal as the setup/dismantle signal.

  // Invalidate the board AND every sibling mobile query that renders the same
  // DO/SO state, so a convert / start / complete on this board doesn't leave the
  // mobile POD screen or SO list showing pre-mutation status inside their 15-30s
  // staleTime window (the desktop board already invalidates all sibling keys).
  const invalidate = () => {
    // Shared/desktop DO, delivery-planning, inventory and SO caches too, so a
    // desktop board/list doesn't read stale after a mobile convert/status/deliver.
    // MobilePOD now reads through the SHARED DO hooks, so invalidateDoShared
    // reaches it — the ["mobile-do-list-for-pod"] / ["mobile-pod-detail"] keys
    // this used to bump no longer exist and bumping them refreshed nothing.
    invalidateDoShared(qc);
    invalidateInventoryShared(qc);
    invalidateSoShared(qc);
    return Promise.all([
      qc.invalidateQueries({ queryKey: ["mobile-delivery-planning"] }),
      qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] }),
    ]);
  };

  // ── Convert this Sales Order → a Delivery Order (identical endpoint to the
  // desktop board's Convert-to-DO: resolve the SO's still-deliverable lines via
  // /deliverable-so-lines, then POST /from-sos with those picks — one DO for
  // this SO). Unblocks a stop that has no DO cut yet so the driver can start it.
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

  // ── Save the HC delivery-execution fields on the latest DO (identical endpoint
  // to the desktop DeliveryFieldsDrawer: PATCH /delivery-planning/so/:id/fields).
  // Only the DO-execution subset a driver touches on the road — time window,
  // arrival/departure clock, delivered date, and the HC "Remark 4" sub-status.
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

  // "On the way" / "Mark arrived" → IN_TRANSIT. Inventory-idempotent (DO OUT).
  const start = useMutation({
    mutationFn: () => {
      if (!doId) throw new Error("no_do");
      return authedFetch<{ deliveryOrder: unknown }>(
        `/delivery-orders-mfg/${encodeURIComponent(doId)}/status`,
        { method: "PATCH", body: JSON.stringify({ status: "IN_TRANSIT" }) },
      );
    },
    onSuccess: async () => {
      await invalidate();
    },
  });

  // "POD complete" → DELIVERED (stamps delivered_at).
  const complete = useMutation({
    mutationFn: () => {
      if (!doId) throw new Error("no_do");
      return authedFetch<{ deliveryOrder: unknown }>(
        `/delivery-orders-mfg/${encodeURIComponent(doId)}/status`,
        { method: "PATCH", body: JSON.stringify({ status: "DELIVERED" }) },
      );
    },
    onSuccess: async () => {
      await invalidate();
    },
  });

  // Offer to CUT the DO on the spot (same endpoint the desktop board uses) when
  // a stop has none yet, instead of dead-ending at "ask the office".
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
    // Start/Arrive auto-cut the DO when there isn't one. A caller who may not
    // create a DO must be TOLD, not walked into a 403 they can't read.
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
    // Advancing DO status is Office-only (backend 403s the Sales cohort). The
    // button is already withheld for a view-only user; guard the handler too.
    if (!canOperateDo) return;
    if (!(await requireDo())) return;
    start.mutate();
  };

  const onComplete = async () => {
    if (!canOperateDo) return;
    if (!(await requireDo())) return;
    const go = await confirm({
      title: "Mark delivered?",
      body: "This records the stop as delivered and sends the completion time to the office. Open the order afterwards to attach the POD photo and signature.",
      confirmLabel: "Mark delivered",
    });
    if (!go) return;
    complete.mutate();
  };

  const busy = start.isPending || complete.isPending;
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
            <span className="chev">‹</span> Delivery Planning
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
        {/* Late banner (planLateBanner). */}
        {st === "late" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "10px 12px",
              background: "#f8eaea",
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

        {/* Call + Navigate (planCallNav → tel: / maps). */}
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
                border: "1px solid #d6d9d2",
                borderRadius: 11,
                background: "#fff",
                color: "#16695f",
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
                border: "1px solid #eceee9",
                borderRadius: 11,
                background: "#f4f6f3",
                color: "#9aa093",
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
                border: "1px solid #d6d9d2",
                borderRadius: 11,
                background: "#fff",
                color: "#16695f",
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
                border: "1px solid #eceee9",
                borderRadius: 11,
                background: "#f4f6f3",
                color: "#9aa093",
                fontSize: 12.5,
                fontWeight: 700,
              }}
            >
              No address
            </div>
          )}
        </div>

        {/* Delivery-info card (spec: .card + "Delivery" header + .row list). */}
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
          {/* Move-in / possession date — HC SO-context field. Real-data
              discipline: the row is dropped entirely when the feed carries no
              possession date (the prototype's free-text "Move" has no backing
              column). */}
          {moveInDate ? pdRow("Move-in date", moveInDate, false) : null}
          {pdRow("Address", order.address || EM, false)}
          {pdRow(
            "Postcode",
            <span className="tnum">{order.postcode || EM}</span>,
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

        {/* No DO yet → offer to cut one on the spot (desktop board's Convert-to-DO,
            identical endpoint) so the driver isn't dead-ended. */}
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
              border: "1.5px solid #16695f",
              borderRadius: 11,
              background: "#fff",
              color: "#16695f",
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

        {/* Delivery details (HC delivery-execution fields) — same endpoint as the
            desktop DeliveryFieldsDrawer: PATCH /delivery-planning/so/:id/fields.
            Editable only once a DO exists (the fields live on the DO), mirroring
            the desktop drawer's DO-execution group gating. */}
        {doId && (
          <DeliveryFieldsCard
            order={order}
            editing={editingFields}
            saving={saveFields.isPending}
            onEdit={() => setEditingFields(true)}
            onCancel={() => setEditingFields(false)}
            onSave={async (body) => {
              try {
                await saveFields.mutateAsync(body);
                setEditingFields(false);
              } catch (e) {
                await notify({
                  title: "Couldn't save",
                  body: e instanceof Error ? e.message : "Something went wrong.",
                });
              }
            }}
          />
        )}

        {/* Goods to deliver — per-line item + variant, fetched from the SHARED
            /delivery-planning/:docNo/lines endpoint (the SAME hook the desktop
            board's expand-row drill-down uses). See GoodsToDeliverCard. */}
        <GoodsToDeliverCard order={order} />

        {/* Disposal callout. */}
        {disposal && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 9,
              padding: "11px 12px",
              background: "#f3ece0",
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

        {/* Setup & dismantle photos — v4 unified 2-group POD structure: group 1
            "Overall booth" (on arrival) + group 2 "Setup complete (POD)"
            (completion proof). Section sub-label "POD · upload on site". */}
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

        {/* Sales-person + document rows. Sales-rep contact isn't in the feed,
            so that row is omitted; SO / DO / branding come straight off the row. */}
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
          {/* Reference — HC referral tag; dropped when the feed carries none. */}
          {referral
            ? pdRow("Reference", <span className="tnum">{referral}</span>, false)
            : null}
          {pdRow(
            "Branding",
            (order.branding && order.branding.trim()) || EM,
            false,
            true,
          )}
        </div>

        {/* Balance-to-collect block (balance-only per the new design). */}
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
              background: "#f3ece0",
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
              {fmtCenti(bal)}
            </span>
          </div>
        )}

        {/* Delivery tracking timeline — Start → Arrive → Done (planTracking). */}
        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-h">
            <span className="card-t">Delivery tracking</span>
            <span className="card-sub">On the way → Arrived → POD</span>
          </div>
          <div className="card-b">
            {(start.error || complete.error) && (
              <div
                style={{ fontSize: 12, color: "var(--red)", marginBottom: 9 }}
              >
                {(() => {
                  const e = start.error || complete.error;
                  return e instanceof Error && e.message !== "no_do"
                    ? e.message
                    : "Couldn't update this stop. Please try again.";
                })()}
              </div>
            )}

            {/* Step 1 — On the way. Action buttons are Office-only (canOperateDo);
                a view-only user sees the completed steps but no action. */}
            {started ? (
              <TrackStep
                tone="teal"
                label="On the way"
                time={startAt ? `${startAt} · ${eff}` : eff}
              />
            ) : canOperateDo ? (
              <TrackButton
                onClick={onStart}
                busy={busy}
                label={start.isPending ? "Starting…" : "Start — I'm on the way"}
                icon="arrow"
              />
            ) : null}

            {/* Step 2 — Arrived. */}
            {arrived ? (
              <TrackStep
                tone="teal"
                label="Arrived at location"
                time={arriveAt ? `${arriveAt} · ${eff}` : eff}
                border
              />
            ) : started && canOperateDo ? (
              <TrackButton
                onClick={onStart}
                busy={busy}
                label="Mark arrived"
                icon="pin"
              />
            ) : null}

            {/* Step 3 — Delivered (POD). */}
            {done ? (
              <TrackStep
                tone="green"
                label="Delivered — POD uploaded"
                time={doneAt ? `${doneAt} · ${eff}` : eff}
                border
                check
              />
            ) : arrived && canOperateDo ? (
              <TrackButton
                onClick={onComplete}
                busy={busy}
                label={
                  complete.isPending ? "Saving…" : "Take POD photo — complete"
                }
                icon="camera"
                primary
              />
            ) : null}

            {/* View-only (Sales cohort): status writes are the Office team's job.
                Say so plainly instead of leaving an empty timeline. */}
            {!canOperateDo && !done && (
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

/* ── GoodsToDeliver — per-line item + variant for the stop, from the SHARED
   /delivery-planning/:docNo/lines endpoint (the SAME hook the desktop board's
   expand-row drill-down uses; scoped to the caller's allowed companies so a
   cross-company row doesn't 404). Cancelled lines are filtered (desktop parity:
   PlanningExpandedLines filters `!it.cancelled`). Name + variant use the shared
   orderLineIdentity rule (code dropped, description2 kept) — the same rule the POD
   checklist + the DO detail use. Falls back to a single branded summary line
   when the lines can't be read, so this never regresses below the summary-only
   card it replaced.
   ─────────────────────────────────────────────────────────────────────────── */
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

/* ── DeliveryFieldsCard — the HC delivery-execution fields, read + Edit→Save.
   Mirrors the desktop DeliveryFieldsDrawer's DO-execution group: time window +
   confirmed, arrival/departure clock, SHIPOUT DATE + ARRIVING PORT (EM/SG
   cross-border), customer-delivered date, and the HC "Remark 4" delivery
   sub-status. Save posts ONLY the changed fields to PATCH
   /delivery-planning/so/:id/fields via the same camelCase keys the drawer sends
   (shipoutDate / etaArrivingPort are accepted by that endpoint). Blank clears
   (the endpoint stores '' → null). NOTE: arrives_em_warehouse_date is NOT edited
   here — the desktop drawer does not write it either (it is a read-only grid
   field; the FE HcFieldsPatch omits it), so adding it would create a new
   divergence rather than close one.
   ─────────────────────────────────────────────────────────────────────────── */
// A TIMESTAMPTZ ISO → the value <input type="datetime-local"> wants.
const toDtLocal = (iso: string | null | undefined): string =>
  iso ? String(iso).slice(0, 16) : "";
// A YYYY-MM-DD date-ish string → the value <input type="date"> wants.
const toDateInput = (d: string | null | undefined): string =>
  d ? String(d).slice(0, 10) : "";

function DeliveryFieldsCard({
  order,
  editing,
  saving,
  onEdit,
  onCancel,
  onSave,
}: {
  order: BoardRow;
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const initial = useMemo(
    () => ({
      timeRange: order.time_range ?? "",
      timeConfirmed: !!order.time_confirmed,
      arrivalAt: toDtLocal(order.arrival_at),
      departureAt: toDtLocal(order.departure_at),
      shipoutDate: toDateInput(order.shipout_date),
      customerDeliveredDate: toDateInput(order.customer_delivered_date),
      etaArrivingPort: order.eta_arriving_port ?? "",
      deliverySubstatus: order.delivery_substatus ?? "",
    }),
    [order],
  );
  const [form, setForm] = useState(initial);
  // Re-seed the draft each time the editor is (re)opened so a fresh board fetch
  // isn't shadowed by a stale draft.
  const startEdit = () => {
    setForm(initial);
    onEdit();
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const save = () => {
    const body: Record<string, unknown> = {};
    if (form.timeRange !== initial.timeRange) body.timeRange = form.timeRange || null;
    if (form.timeConfirmed !== initial.timeConfirmed) body.timeConfirmed = form.timeConfirmed;
    if (form.arrivalAt !== initial.arrivalAt) body.arrivalAt = form.arrivalAt || null;
    if (form.departureAt !== initial.departureAt) body.departureAt = form.departureAt || null;
    if (form.shipoutDate !== initial.shipoutDate) body.shipoutDate = form.shipoutDate || null;
    if (form.customerDeliveredDate !== initial.customerDeliveredDate)
      body.customerDeliveredDate = form.customerDeliveredDate || null;
    if (form.etaArrivingPort !== initial.etaArrivingPort)
      body.etaArrivingPort = form.etaArrivingPort || null;
    if (form.deliverySubstatus !== initial.deliverySubstatus)
      body.deliverySubstatus = form.deliverySubstatus || null;
    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    onSave(body);
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    fontFamily: "inherit",
    fontSize: 13,
    color: "var(--ink)",
    background: "var(--bg)",
    border: "1px solid var(--line)",
    borderRadius: 9,
    padding: "9px 10px",
    marginTop: 3,
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h">
        <span className="card-t">Delivery details</span>
        {!editing && (
          <span
            onClick={startEdit}
            className="card-sub"
            style={{ color: "var(--brand)", fontWeight: 700, cursor: "pointer" }}
          >
            Edit
          </span>
        )}
      </div>
      {editing ? (
        <div className="card-b">
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">Time window</span>
            <input
              value={form.timeRange}
              placeholder="e.g. 10am-12pm"
              onChange={(e) => set("timeRange", e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={form.timeConfirmed}
              onChange={(e) => set("timeConfirmed", e.target.checked)}
              style={{ width: 18, height: 18, accentColor: "#16695f" }}
            />
            <span style={{ fontSize: 12.5, color: "var(--ink2)" }}>Time confirmed with customer</span>
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">Departure</span>
            <input
              type="datetime-local"
              value={form.departureAt}
              onChange={(e) => set("departureAt", e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">Arrival</span>
            <input
              type="datetime-local"
              value={form.arrivalAt}
              onChange={(e) => set("arrivalAt", e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">Shipout date (EM/SG)</span>
            <input
              type="date"
              value={form.shipoutDate}
              onChange={(e) => set("shipoutDate", e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">Customer delivered date</span>
            <input
              type="date"
              value={form.customerDeliveredDate}
              onChange={(e) => set("customerDeliveredDate", e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">ETA / arriving port (EM/SG)</span>
            <input
              value={form.etaArrivingPort}
              placeholder="Port / shipment ref e.g. KUC3012008"
              onChange={(e) => set("etaArrivingPort", e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span className="fld-l">Delivery status</span>
            <select
              value={form.deliverySubstatus}
              onChange={(e) => set("deliverySubstatus", e.target.value)}
              style={inputStyle}
            >
              <option value="">—</option>
              {HC_SUBSTATUS_VALUES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onCancel}
              disabled={saving}
              style={{
                flex: 1,
                height: 42,
                border: "1px solid #d6d9d2",
                borderRadius: 11,
                background: "#fff",
                color: "var(--ink2)",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 700,
                cursor: saving ? "default" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              style={{
                flex: 1,
                height: 42,
                border: "none",
                borderRadius: 11,
                background: saving ? "#7fb4ad" : "#16695f",
                color: "#fff",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 800,
                cursor: saving ? "default" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <>
          {pdRow("Time window", (order.time_range && order.time_range.trim()) || EM, true)}
          {pdRow(
            "Time confirmed",
            order.time_confirmed == null ? EM : order.time_confirmed ? "Yes" : "No",
            true,
          )}
          {pdRow("Departure", order.departure_at ? hhmm(order.departure_at) : EM, false)}
          {pdRow("Arrival", order.arrival_at ? hhmm(order.arrival_at) : EM, true)}
          {pdRow("Shipout date", dm(order.shipout_date), false)}
          {pdRow("Delivered date", dm(order.customer_delivered_date), true)}
          {pdRow(
            "Arriving port",
            (order.eta_arriving_port && order.eta_arriving_port.trim()) || EM,
            false,
          )}
          {pdRow(
            "Delivery status",
            (order.delivery_substatus && order.delivery_substatus.trim()) || EM,
            true,
            true,
          )}
        </>
      )}
    </div>
  );
}

// A completed tracking step (stepDone). tone drives the badge colour.
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
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f" }}>
          {label}
        </div>
        {time && (
          <div className="tnum" style={{ fontSize: 11, color: "#767b6e" }}>
            {time}
          </div>
        )}
      </div>
    </div>
  );
}

// A tracking action button (stepBtn). primary = filled POD button.
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
        border: primary ? "none" : "1.5px solid #16695f",
        borderRadius: 11,
        background: primary ? (busy ? "#7fb4ad" : "#16695f") : "#fff",
        color: primary ? "#fff" : "#16695f",
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
