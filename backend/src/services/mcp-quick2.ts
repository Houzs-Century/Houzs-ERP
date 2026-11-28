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
