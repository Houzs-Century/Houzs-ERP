// ---------------------------------------------------------------------------
// mcp-quick2.ts — round-3 quick answers of the AI Connector (services/mcp-round3.ts):
// outlet_sales, pos_sales, after_sales_summary, attendance_today.
//
// Pure functions over the JSON of the ERP endpoints the pages themselves read
// (each read goes through routes/mcp.ts readValue as the person, so their
// permissions, company scope and the money redaction already applied).
// Money comes in as sen and goes out as RM (2 dp).
// ---------------------------------------------------------------------------
import { ATTENDANCE_STATUSES } from "../scm/shared/hr-attendance";
import { rm } from "./mcp-quick";

type Obj = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));

/** Whole days from `day` (YYYY-MM-DD or ISO) to `today`; null when unreadable. */
export function daysBetween(day: string, today: string): number | null {
  const a = Date.parse(day.slice(0, 10));
  const b = Date.parse(today);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

export const monthStartOf = (today: string): string => `${today.slice(0, 7)}-01`;

// ── outlet_sales ────────────────────────────────────────────────────────────

/**
 * Today and month-to-date by showroom from ONE read of the Sales Report's
 * Sales Order stage (GET /api/scm/reports/fair-report?stage=so, the 1st of the
 * month to today; rows carry venue, so_date and amount_sen).
 */
export function summariseOutletSales(fair: unknown, today: string) {
  const rows = arr(obj(fair).rows);
  const acc = new Map<string, { todayOrders: number; todaySen: number; mtdOrders: number; mtdSen: number }>();
  let todayOrders = 0;
  let todaySen = 0;
  let mtdSen = 0;
  for (const r of rows) {
    const venue = str(r.venue) || "(no showroom)";
    const g = acc.get(venue) ?? { todayOrders: 0, todaySen: 0, mtdOrders: 0, mtdSen: 0 };
    const sen = num(r.amount_sen);
    g.mtdOrders += 1;
    g.mtdSen += sen;
    mtdSen += sen;
    if (str(r.so_date).slice(0, 10) === today) {
      g.todayOrders += 1;
      g.todaySen += sen;
      todayOrders += 1;
      todaySen += sen;
    }
    acc.set(venue, g);
  }
  const outlets = [...acc.entries()]
    .map(([outlet, g]) => ({ outlet, todayOrders: g.todayOrders, todayRm: rm(g.todaySen), mtdOrders: g.mtdOrders, mtdRm: rm(g.mtdSen) }))
    .sort((a, b) => b.mtdRm - a.mtdRm || a.outlet.localeCompare(b.outlet));
  return {
    today,
    monthFrom: monthStartOf(today),
    note: "Money in RM. Sales = sales orders not draft or cancelled, by SO date, per showroom (the Sales Report's Sales Order stage), for the company you are working in.",
    totals: { todayOrders, todayRm: rm(todaySen), mtdOrders: rows.length, mtdRm: rm(mtdSen) },
    outlets: outlets.slice(0, 25),
    ...(outlets.length > 25 ? { moreOutlets: outlets.length - 25 } : {}),
  };
}

// ── pos_sales ───────────────────────────────────────────────────────────────

export const POS_EVENTS_MAX = 5;

/** The booth events worth reporting: on going, or ended this month; at most POS_EVENTS_MAX (on going first). */
export function pickPosEvents(events: unknown, today: string): { projectId: number; name: string; status: string; startDate: string; endDate: string }[] {
  const from = monthStartOf(today);
  const rows = arr(obj(events).data)
    .map((e) => ({ projectId: num(e.project_id), name: str(e.name) || str(e.code), status: str(e.status), startDate: str(e.start_date).slice(0, 10), endDate: str(e.end_date).slice(0, 10) }))
    .filter((e) => e.projectId > 0 && (e.status === "ON GOING" || (e.status === "DONE" && (e.endDate || e.startDate) >= from)));
  rows.sort((a, b) => (a.status === b.status ? b.startDate.localeCompare(a.startDate) : a.status === "ON GOING" ? -1 : 1));
  return rows.slice(0, POS_EVENTS_MAX);
}

/** One booth event's POS report (GET /api/pos-admin/report, this month to today) → today and month-to-date. */
export function summarisePosEvent(ev: { projectId: number; name: string; status: string }, report: unknown, today: string) {
  const t = obj(obj(report).totals);
  const day = arr(t.by_day).find((d) => str(d.day) === today);
  return {
    event: ev.name,
    status: ev.status,
    todayBills: num(day?.bills),
    todayNetRm: rm(day?.net_sen),
    mtdBills: num(t.bills),
    mtdNetRm: rm(t.net_sen),
    returnsRm: rm(t.return_sen),
    voids: num(t.void_count),
    byMethodRm: arr(t.by_method).slice(0, 6).map((m) => ({ method: str(m.method), amountRm: rm(m.amount_sen) })),
    topItems: arr(t.by_item)
      .sort((a, b) => num(b.net_sen) - num(a.net_sen))
      .slice(0, 5)
      .map((i) => ({ item: str(i.description) || str(i.item_code), qty: num(i.qty), netRm: rm(i.net_sen) })),
  };
}

export function summarisePosSales(events: ReturnType<typeof summarisePosEvent>[], unreadable: string[], today: string, eventsTotal: number) {
  return {
    today,
    monthFrom: monthStartOf(today),
    note: "Money in RM. The booth POS (Cash & Carry and fair terminals), receipts synced to the ERP for the company you are working in; net = sales minus returns, voids excluded. Receipts still on a device that has not synced are not counted yet.",
    totals: {
      todayBills: events.reduce((n, e) => n + e.todayBills, 0),
      todayNetRm: Math.round(events.reduce((n, e) => n + e.todayNetRm * 100, 0)) / 100,
      mtdBills: events.reduce((n, e) => n + e.mtdBills, 0),
      mtdNetRm: Math.round(events.reduce((n, e) => n + e.mtdNetRm * 100, 0)) / 100,
    },
    events,
    ...(eventsTotal > events.length + unreadable.length ? { note2: `Showing the ${POS_EVENTS_MAX} most recent events of ${eventsTotal}.` } : {}),
    ...(unreadable.length ? { couldNotRead: unreadable } : {}),
  };
}

// ── after_sales_summary ─────────────────────────────────────────────────────

export const AGE_BUCKETS = [
  { label: "0-7 days", max: 7 },
  { label: "8-30 days", max: 30 },
  { label: "31-90 days", max: 90 },
  { label: "over 90 days", max: Infinity },
] as const;

/**
 * Open service cases by stage and age: the Service Cases overview
 * (GET /api/assr/summary — live counts, the caller's own visibility) plus the
 * open-case list (GET /api/assr?exclude_stage=completed,voided, oldest first)
 * for ages and the oldest cases.
 */
export function summariseAfterSales(summary: unknown, openRows: readonly Obj[], openTotal: number, today: string, origin: string) {
  const s = obj(summary);
  const buckets = AGE_BUCKETS.map((b) => ({ age: b.label, cases: 0 }));
  const byStage = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const aged: { case: string; stage: string; status: string; customer: string; ageDays: number; daysInStage: number | null; breached: boolean; url: string }[] = [];
  for (const r of openRows) {
    const age = daysBetween(str(r.complained_date) || str(r.created_at), today);
    if (age !== null) {
      const i = AGE_BUCKETS.findIndex((b) => age <= b.max);
      buckets[i < 0 ? buckets.length - 1 : i].cases += 1;
    }
    const stage = str(r.stage) || "(none)";
    byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
    const status = str(r.status) || "(none)";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    aged.push({
      case: str(r.assr_no) || `#${str(r.id)}`,
      stage,
      status,
      customer: str(r.customer_name),
      ageDays: age ?? 0,
      daysInStage: r.days_in_stage === null || r.days_in_stage === undefined ? null : num(r.days_in_stage),
      breached: num(r.is_breached) === 1,
      url: `${origin}/assr?focus=${encodeURIComponent(str(r.id))}`,
    });
  }
  const counted = openRows.length;
  const sortDesc = (m: Map<string, number>) => [...m.entries()].map(([k, n]) => ({ name: k, cases: n })).sort((a, b) => b.cases - a.cases);
  return {
    today,
    note: "Open = not completed, not voided, not archived. Ages count from the complaint date (else the date the case was created). Only the cases you may see in the ERP.",
    openCases: num(s.active_count) || openTotal,
    pendingReview: num(s.pending_review_count),
    inStageOver3Days: num(s.aging_count),
    pastDeadline: num(s.breach_count),
    avgDaysToClose: s.avg_e2e_days === null || s.avg_e2e_days === undefined ? null : num(s.avg_e2e_days),
    byStage: sortDesc(byStage),
    byStatus: sortDesc(byStatus),
    byAge: buckets,
    oldest: aged.sort((a, b) => b.ageDays - a.ageDays).slice(0, 8),
    ...(openTotal > counted ? { ageNote: `Stage, status and age breakdowns cover the oldest ${counted} of ${openTotal} open cases.` } : {}),
  };
}

// ── attendance_today ────────────────────────────────────────────────────────

/** Away for (part of) the day: the HR vocabulary's statuses other than present, absent and rest day (scm/shared/hr-attendance.ts). */
const NOT_LEAVE = new Set(["PRESENT", "ABSENT", "REST_DAY"]);
const LEAVE = new Set(ATTENDANCE_STATUSES.map((x) => x.value as string).filter((v) => !NOT_LEAVE.has(v)));
const WORDS: Record<string, string> = Object.fromEntries(ATTENDANCE_STATUSES.map((x) => [x.value, x.label]));
const NAMES_MAX = 40;

/** HR attendance for one day (GET /api/hr/attendance?date=) → who is on leave, absent, late or has no record yet. */
export function summariseAttendance(body: unknown) {
  const b = obj(body);
  const onLeave: { name: string; department: string; leave: string }[] = [];
  const absent: { name: string; department: string }[] = [];
  const late: { name: string; department: string; lateMin: number }[] = [];
  const noRecord: { name: string; department: string }[] = [];
  let present = 0;
  let restDay = 0;
  const rows = arr(b.rows);
  for (const r of rows) {
    const e = obj(r.employee);
    if (str(e.status) && str(e.status) !== "ACTIVE") continue;
    const who = { name: str(e.name) || str(e.empNo), department: str(e.department) };
    const d = r.day && typeof r.day === "object" ? obj(r.day) : null;
    if (!d) {
      noRecord.push(who);
      continue;
    }
    const st = str(d.status);
    if (LEAVE.has(st)) onLeave.push({ ...who, leave: WORDS[st] ?? st });
    else if (st === "ABSENT") absent.push(who);
    else if (st === "REST_DAY") restDay += 1;
    else {
      present += 1;
      if (num(d.lateMin) > 0) late.push({ ...who, lateMin: num(d.lateMin) });
    }
  }
  late.sort((a, b2) => b2.lateMin - a.lateMin);
  const cap = <T>(xs: T[]) => xs.slice(0, NAMES_MAX);
  return {
    date: str(b.date),
    note: "From HR attendance (clock-ins and approved leave). 'noRecordYet' = no clock-in and no leave recorded so far today; they may still clock in, be on a rest day nobody recorded, or be absent.",
    staff: rows.length,
    present,
    onLeaveCount: onLeave.length,
    absentCount: absent.length,
    lateCount: late.length,
    restDay,
    noRecordYetCount: noRecord.length,
    onLeave: cap(onLeave),
    absent: cap(absent),
    late: cap(late),
    noRecordYet: cap(noRecord),
  };
}
