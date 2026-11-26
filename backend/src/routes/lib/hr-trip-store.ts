/* Loads a trip month and works out everyone's trip pay (HC-0125 phase 5):
 * the month's rows, who each name on them is, the rates in force on the 22nd,
 * and each driver's missed working days (no hours logged and no leave keyed
 * on the Attendance tab, or HR's own count when the punches cannot say). Used by the Trip Pay tab, by payroll
 * (the trip month of the same name lands on that payslip) and by My pay.
 * Also reads Delivery Planning's lorry runs and the delivery orders our lorries ran into rows. */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { APPROVED_LEAVE_STATUSES } from "../../scm/shared/hr-attendance";
import { asDate } from "./hr-attendance-view";
import { ASSR_LEG_BY_STOP, assrBoardLocation } from "../../scm/lib/assr-board-scope";
import { doRunDate, isOwnLorryDoRun } from "../../scm/lib/own-lorry-do-run";
import { getDb } from "../../db/client";
import { hr_attendance, hr_employees, hr_payslips, hr_public_holidays, hr_trip_missed_days, hr_trip_rate_versions, hr_trip_rows, hr_working_hours } from "../../db/schema";
import {
  TRIP_EVENT_TYPES,
  TRIP_JOB_TYPES,
  computeTripMonth,
  eventTypeOf,
  isFairJob,
  isHookkaSupplierName,
  jobTypeOfKind,
  kindOfJobType,
  missedWorkingDays,
  normName,
  resolveTripRatesAsOf,
  tripMonthBounds,
  type TripEventType,
  type TripJobType,
  type TripKind,
  type TripPay,
  type TripPunch,
  type TripRates,
  type TripRow,
  type TripRowPay,
} from "../../scm/shared/hr-trip-pay";

type Db = ReturnType<typeof getDb>;
type RowRecord = typeof hr_trip_rows.$inferSelect;

export async function tripRatesResolver(db: Db, companyId: number): Promise<(ymd: string) => TripRates> {
  const versions = await db
    .select({ effectiveFrom: hr_trip_rate_versions.effective_from, rates: hr_trip_rate_versions.rates })
    .from(hr_trip_rate_versions)
    .where(eq(hr_trip_rate_versions.company_id, companyId));
  return (ymd) => resolveTripRatesAsOf(versions, ymd);
}

export type Person = { id: number; empNo: string; name: string; tripNames: string | null; userId: number | null; joinDate: string | null; resignedOn: string | null };

/** Name -> employee: the sheet names HR typed on the employee, then the full name. A name two people share resolves to nobody. */
export function nameIndex(people: ReadonlyArray<Person>): (name: string) => number | null {
  const by = new Map<string, number | null>();
  const put = (key: string, id: number) => {
    if (!key) return;
    const had = by.get(key);
    by.set(key, had === undefined || had === id ? id : null);
  };
  for (const p of people) for (const n of (p.tripNames ?? "").split(",")) put(normName(n), p.id);
  for (const p of people) if (!by.has(normName(p.name))) put(normName(p.name), p.id);
  return (name) => by.get(normName(name)) ?? null;
}

/** A row's job type: its own, else (a row stored before the redesign) read from its old kind. */
export function jobTypeOfRow(r: Pick<RowRecord, "job_type" | "kind" | "doc_no" | "ref_no">): TripJobType {
  return TRIP_JOB_TYPES.includes(r.job_type as TripJobType) ? (r.job_type as TripJobType) : jobTypeOfKind(r.kind as TripKind, r.doc_no, r.ref_no);
}

/** HR changed this row by hand, so no read from Delivery Planning overwrites it. A
 *  Planning row stored before the redesign (no job_type) and touched after it was
 *  written was edited the only way there was: by HR. */
export function rowHrEdited(r: Pick<RowRecord, "hr_edited" | "source" | "job_type" | "created_at" | "updated_at">): boolean {
  return r.hr_edited || (r.source === "PLANNING" && r.job_type == null && Date.parse(r.updated_at) > Date.parse(r.created_at));
}

export function tripRowOf(r: RowRecord): TripRow {
  const person = (name: string, employeeId: number | null) => ({ name, employeeId });
  return {
    tripDate: r.trip_date,
    docNo: r.doc_no,
    transferTo: r.transfer_to,
    refNo: r.ref_no,
    kind: r.kind as TripKind,
    jobType: jobTypeOfRow(r),
    eventType: TRIP_EVENT_TYPES.includes(r.event_type as TripEventType) ? (r.event_type as TripEventType) : null,
    localTotalSen: Number(r.local_total_sen),
    state: r.state,
    postcode: r.postcode,
    lorryPlate: r.lorry_plate,
    tripRef: r.trip_ref,
    venueKey: r.venue_key,
    drivers: [person(r.driver_1_name, r.driver_1_employee_id), person(r.driver_2_name, r.driver_2_employee_id)].filter((p) => p.name || p.employeeId != null),
    helpers: [person(r.helper_1_name, r.helper_1_employee_id), person(r.helper_2_name, r.helper_2_employee_id)].filter((p) => p.name || p.employeeId != null),
  };
}

export type MissedInfo = { days: number; dates: string[]; override: number | null; note: string | null; noAttendance: boolean };

export type TripMonth = {
  month: string;
  first: string;
  last: string;
  rows: RowRecord[];
  rowPay: TripRowPay[];
  people: Person[];
  rates: TripRates;
  pay: Map<number, TripPay>;
  missed: Map<number, MissedInfo>;
  unmatched: { name: string; rows: number }[];
};

export async function loadTripMonth(db: Db, companyId: number, month: string, today: string): Promise<TripMonth> {
  const { first, last } = tripMonthBounds(month);
  const [rows, people, holidays, worked, leave, overrides, ratesOn, punches] = await Promise.all([
    db
      .select()
      .from(hr_trip_rows)
      .where(and(eq(hr_trip_rows.company_id, companyId), eq(hr_trip_rows.trip_month, month), isNull(hr_trip_rows.removed_at)))
      .orderBy(asc(hr_trip_rows.trip_date), asc(hr_trip_rows.id)),
    db
      .select({
        id: hr_employees.id,
        empNo: hr_employees.emp_no,
        name: hr_employees.name,
        tripNames: hr_employees.trip_names,
        userId: hr_employees.user_id,
        joinDate: hr_employees.join_date,
        resignedOn: hr_employees.resigned_on,
      })
      .from(hr_employees)
      .where(eq(hr_employees.company_id, companyId)),
    db
      .select({ d: hr_public_holidays.holiday_date })
      .from(hr_public_holidays)
      .where(and(eq(hr_public_holidays.company_id, companyId), gte(hr_public_holidays.holiday_date, first), lte(hr_public_holidays.holiday_date, last))),
    db
      .selectDistinct({ employee_id: hr_working_hours.employee_id, date: hr_working_hours.work_date })
      .from(hr_working_hours)
      .where(and(eq(hr_working_hours.company_id, companyId), gte(hr_working_hours.work_date, first), lte(hr_working_hours.work_date, last))),
    db
      .select({ employee_id: hr_attendance.employee_id, date: hr_attendance.work_date })
      .from(hr_attendance)
      .where(
        and(
          eq(hr_attendance.company_id, companyId),
          inArray(hr_attendance.status, [...APPROVED_LEAVE_STATUSES]),
          gte(hr_attendance.work_date, first),
          lte(hr_attendance.work_date, last),
        ),
      ),
    db
      .select()
      .from(hr_trip_missed_days)
      .where(and(eq(hr_trip_missed_days.company_id, companyId), eq(hr_trip_missed_days.trip_month, month))),
    tripRatesResolver(db, companyId),
    db
      .select({ employee_id: hr_attendance.employee_id, workDate: hr_attendance.work_date, inAt: hr_attendance.clock_in_at, outAt: hr_attendance.clock_out_at })
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, companyId), gte(hr_attendance.work_date, first), lte(hr_attendance.work_date, last), isNotNull(hr_attendance.clock_out_at))),
  ]);
  const rates = ratesOn(last);
  const byName = nameIndex(people);
  const ids = new Set(people.map((p) => p.id));
  const employeeOf = (p: { name: string; employeeId: number | null }) => (p.employeeId != null && ids.has(p.employeeId) ? p.employeeId : p.name ? byName(p.name) : null);
  const tripRows = rows.map(tripRowOf);

  const unmatchedCount = new Map<string, number>();
  for (const r of tripRows) {
    for (const p of [...r.drivers, ...r.helpers]) {
      if (employeeOf(p) != null) continue;
      const key = p.name || "(no name)";
      unmatchedCount.set(key, (unmatchedCount.get(key) ?? 0) + 1);
    }
  }

  const holidaySet = new Set(holidays.map((h) => h.d));
  const group = (list: { employee_id: number; date: string }[]) => {
    const m = new Map<number, Set<string>>();
    for (const r of list) m.set(r.employee_id, (m.get(r.employee_id) ?? new Set()).add(r.date));
    return m;
  };
  const workedBy = group(worked);
  const leaveBy = group(leave);
  const overrideBy = new Map(overrides.map((o) => [o.employee_id, o]));
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const missed = new Map<number, MissedInfo>();
  const missedOf = (id: number): MissedInfo => {
    const had = missed.get(id);
    if (had) return had;
    const p = people.find((x) => x.id === id);
    const from = p?.joinDate && p.joinDate > first ? p.joinDate : first;
    const toCap = p?.resignedOn && p.resignedOn < last ? p.resignedOn : last;
    const to = toCap < yesterday ? toCap : yesterday;
    const o = overrideBy.get(id);
    const workedDates = workedBy.get(id) ?? new Set<string>();
    const dates = from <= to ? missedWorkingDays({ from, to, workedDates, leaveDates: leaveBy.get(id) ?? new Set(), holidays: holidaySet }) : [];
    const info: MissedInfo = {
      days: o ? o.missed_days : workedDates.size === 0 ? 0 : dates.length,
      dates,
      override: o ? o.missed_days : null,
      note: o?.note ?? null,
      noAttendance: workedDates.size === 0,
    };
    missed.set(id, info);
    return info;
  };

  const punchesBy = new Map<number, TripPunch[]>();
  for (const p of punches) {
    const iso = (v: string | null) => (v ? asDate(v).toISOString() : null);
    punchesBy.set(p.employee_id, [...(punchesBy.get(p.employee_id) ?? []), { workDate: p.workDate, inAt: iso(p.inAt), outAt: iso(p.outAt) }]);
  }
  const { pay, rows: rowPay } = computeTripMonth({ rows: tripRows, rates, employeeOf, missedDaysOf: (id) => missedOf(id).days, punches: punchesBy });
  for (const [id, p] of pay) if (p.drove) missedOf(id);
  return {
    month,
    first,
    last,
    rows,
    rowPay,
    people,
    rates,
    pay,
    missed,
    unmatched: [...unmatchedCount.entries()].map(([name, n]) => ({ name, rows: n })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}


const STOP_KIND: Partial<Record<string, TripJobType>> = {
  DELIVERY: "DELIVERY_ORDER",
  PICKUP: "ASSR_PICKUP",
  SERVICE: "ASSR_SERVICE",
  INSPECTION: "ASSR_INSPECTION",
  SETUP: "SETUP",
  DISMANTLE: "DISMANTLE",
  SUPPLIER_PICKUP: "SUPPLIER",
  TRANSFER: "TRANSFER",
  LORRY_SERVICE: "LORRY_SERVICE",
};
const CASE_LEG_KIND: Partial<Record<string, TripJobType>> = { customer_pickup: "ASSR_PICKUP", delivery: "ASSR_SERVICE", inspection: "ASSR_INSPECTION" };

export type PlanningStop = {
  stop_id: string;
  do_id: string | null;
  stop_type: string;
  trip_id: string;
  trip_date: string;
  trip_no: string;
  plate: string | null;
  revenue_sen: string | number | null;
  dp_sales_sen?: string | number | null;
  customer_name: string | null;
  stop_dp_no: string | null;
  do_number: string | null;
  so_doc_no: string | null;
  do_status: string | null;
  local_total_sen: string | number | null;
  do_state: string | null;
  do_postcode: string | null;
  dp_state: string | null;
  dp_postcode: string | null;
  dp_no: string | null;
  dp_supplier_name: string | null;
  project_id: string | null;
  event_slug: string | null;
  event_name: string | null;
  assr_case_id: string | number | null;
  assr_no: string | null;
  case_addr3: string | null;
  case_addr4: string | null;
  case_own_postcode: string | null;
  case_own_state: string | null;
  case_so_state: string | null;
  case_so_postcode: string | null;
  d1: string | null;
  d2: string | null;
  h1: string | null;
  h2: string | null;
};

type Seat = { name: string; employeeId: number | null };

/** What a read from Delivery Planning writes into hr_trip_rows (the source columns only). */
export type SourceRow = {
  source: "PLANNING";
  source_ref: string;
  trip_date: string;
  doc_no: string;
  transfer_to: string;
  ref_no: string;
  kind: TripKind;
  job_type: TripJobType;
  event_type: TripEventType | null;
  local_total_sen: number;
  state: string;
  postcode: string;
  lorry_plate: string;
  trip_ref: string;
  venue_key: string;
  driver_1_name: string;
  driver_2_name: string;
  helper_1_name: string;
  helper_2_name: string;
  driver_1_employee_id: number | null;
  driver_2_employee_id: number | null;
  helper_1_employee_id: number | null;
  helper_2_employee_id: number | null;
};

/** One stop as a trip row. The amount is the DO's Local Total, else the stop's
 *  own snapshot (an SO scheduled before its DO is never linked to it afterwards);
 *  the state and postcode are the DO's, else the service case's (its address,
 *  then its order, as the board shows it), else the manual job's. A row with no
 *  state earns no outstation until HR fills it. Pure. */
export function planningRowOf(s: PlanningStop, who: (id: string | null) => Seat): SourceRow {
  const [d1, d2, h1, h2] = [who(s.d1), who(s.d2), who(s.h1), who(s.h2)];
  const isCase = s.assr_case_id != null;
  const caseLoc = isCase ? assrBoardLocation(s.case_addr3, s.case_addr4, s.case_so_state, s.case_so_postcode, { postcode: s.case_own_postcode, state: s.case_own_state }) : null;
  /* A delivery with no SO carries its own amount on the DP job (owner 2026-11-20). */
  const amount = s.local_total_sen ?? (isCase ? 0 : s.dp_sales_sen ?? s.revenue_sen);
  const jobType0 = (isCase ? CASE_LEG_KIND[ASSR_LEG_BY_STOP[s.stop_type] ?? ""] : undefined) ?? STOP_KIND[s.stop_type] ?? "NONE";
  /* A Supplier pickup from Hookka's own factories pays the "Supplier (Hookka)" rate (owner 2026-11-26). */
  const jobType = jobType0 === "SUPPLIER" && isHookkaSupplierName(s.dp_supplier_name) ? "SUPPLIER_HOOKKA" : jobType0;
  return {
    source: "PLANNING",
    source_ref: s.stop_id,
    trip_date: s.trip_date,
    doc_no: (isCase ? s.assr_no : s.so_doc_no) ?? s.dp_no ?? s.stop_dp_no ?? s.customer_name ?? "",
    transfer_to: s.do_number ?? "",
    ref_no: s.stop_dp_no ?? s.trip_no,
    kind: kindOfJobType(jobType),
    job_type: jobType,
    event_type: isFairJob(jobType) ? eventTypeOf(s.event_slug, s.event_name) : null,
    local_total_sen: Math.max(0, Math.round(Number(amount ?? 0)) || 0),
    state: s.do_state || caseLoc?.state || s.dp_state || "",
    postcode: s.do_postcode || caseLoc?.postcode || s.dp_postcode || "",
    lorry_plate: s.plate ?? "",
    trip_ref: s.trip_id,
    venue_key: s.project_id ? `P${s.project_id}` : "",
    driver_1_name: d1.name,
    driver_2_name: d2.name,
    helper_1_name: h1.name,
    helper_2_name: h2.name,
    driver_1_employee_id: d1.employeeId,
    driver_2_employee_id: d2.employeeId,
    helper_1_employee_id: h1.employeeId,
    helper_2_employee_id: h2.employeeId,
  };
}

/** A delivery order as Trip Pay reads it: the DO itself, its crew record
 *  (scm.delivery_order_crew) and the lorry that crew names. */
export type PlanningDo = {
  do_id: string;
  do_number: string | null;
  so_doc_no: string | null;
  debtor_name: string | null;
  do_status: string | null;
  so_due_date: string | null;
  is_latest_live: boolean | null;
  delivered_day: string | null;
  do_date: string | null;
  local_total_sen: string | number | null;
  do_state: string | null;
  do_postcode: string | null;
  is_dropship: boolean | null;
  has_3pl: boolean | null;
  on_live_trip: boolean | null;
  crew_plate: string | null;
  lorry_plate: string | null;
  lorry_internal: boolean | null;
  d1: string | null;
  d2: string | null;
  h1: string | null;
  h2: string | null;
  d1_name: string | null;
  d2_name: string | null;
  h1_name: string | null;
  h2_name: string | null;
};

export { doRunDate, isOwnLorryDoRun };

/** Each delivery order our own lorries ran on a day of [first, last], as a
 *  Delivery order row: the date is its run date (doRunDate), the amount its Local
 *  Total, state and postcode its own, crew its crew record (driver 1 falling back
 *  to the DO's own driver; a seat with no master id keeps the name typed on the
 *  record). Delivery orders reach Last Mile through their crew, not through trip
 *  stops, so this is where commission comes from. Pure. */
export function deliveryOrderRows(
  dos: ReadonlyArray<PlanningDo>,
  first: string,
  last: string,
  stopDoIds: ReadonlySet<string>,
  who: (id: string | null, name: string | null) => Seat,
): SourceRow[] {
  return dos
    .filter((d) => isOwnLorryDoRun(d, stopDoIds))
    .flatMap((d): SourceRow[] => {
      const date = doRunDate(d) ?? "";
      if (date < first || date > last) return [];
      const [d1, d2, h1, h2] = [who(d.d1, d.d1_name), who(d.d2, d.d2_name), who(d.h1, d.h1_name), who(d.h2, d.h2_name)];
      const plate = (d.lorry_plate || d.crew_plate || "").trim();
      return [{
        source: "PLANNING",
        source_ref: `do:${d.do_id}`,
        trip_date: date,
        doc_no: d.so_doc_no ?? d.do_number ?? d.debtor_name ?? "",
        transfer_to: d.do_number ?? "",
        ref_no: d.do_number ?? "",
        kind: kindOfJobType("DELIVERY_ORDER"),
        job_type: "DELIVERY_ORDER",
        event_type: null,
        local_total_sen: Math.max(0, Math.round(Number(d.local_total_sen ?? 0)) || 0),
        state: d.do_state ?? "",
        postcode: d.do_postcode ?? "",
        lorry_plate: plate,
        trip_ref: `do-run:${plate.replace(/\s+/g, "").toUpperCase()}:${date}`,
        venue_key: "",
        driver_1_name: d1.name,
        driver_2_name: d2.name,
        helper_1_name: h1.name,
        helper_2_name: h2.name,
        driver_1_employee_id: d1.employeeId,
        driver_2_employee_id: d2.employeeId,
        helper_1_employee_id: h1.employeeId,
        helper_2_employee_id: h2.employeeId,
      }];
    });
}

/** The crew the Projects module stored for one phase (projects.setup_crew /
 *  dismantle_crew), one entry per lorry: the per-lorry arm when present, else
 *  the flattened top-level arrays as one lorry. Names only; any parse failure
 *  yields none. Same JSON flattenProjectCrew reads for the board. Pure. */
export function projectCrewLorries(json: string | null): { plate: string; drivers: string[]; helpers: string[] }[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const o = parsed as Record<string, unknown>;
  const names = (v: unknown) =>
    (Array.isArray(v) ? (v as unknown[]) : [])
      .map((p) => (p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string" ? (p as { name: string }).name.trim() : ""))
      .filter(Boolean);
  const lorries = Array.isArray(o.lorry_crew) ? (o.lorry_crew as Array<Record<string, unknown>>) : [];
  if (lorries.length) {
    return lorries
      .map((l) => ({ plate: typeof l.plate === "string" ? l.plate.trim() : "", drivers: names(l.drivers), helpers: names(l.helpers) }))
      .filter((l) => l.drivers.length || l.helpers.length);
  }
  const plates = (Array.isArray(o.lorries) ? (o.lorries as unknown[]) : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
  const one = { plate: plates[0] ?? "", drivers: names(o.drivers), helpers: names(o.helpers) };
  return one.drivers.length || one.helpers.length ? [one] : [];
}

export type ProjectLeg = {
  id: string;
  code: string | null;
  name: string | null;
  venue: string | null;
  state: string | null;
  setup_start_at: string | null;
  dismantle_start_at: string | null;
  setup_crew: string | null;
  dismantle_crew: string | null;
  event_slug: string | null;
  event_name: string | null;
  setup_driver_name: string | null;
  dismantle_driver_name: string | null;
};

/** A project's Setup and Dismantle, scheduled in the Projects module, as trip
 *  rows: one per lorry of the phase's crew (the legacy single driver when no
 *  crew was stored). Crew are names, matched to employees by name. A phase
 *  Delivery Planning already carries as a stop (`planned`, keyed
 *  "<project id>|<job type>|<date>") is left to that stop. Pure. */
export function projectLegRows(p: ProjectLeg, first: string, last: string, planned: ReadonlySet<string>, byName: (name: string) => number | null): SourceRow[] {
  const out: SourceRow[] = [];
  for (const jobType of ["SETUP", "DISMANTLE"] as const) {
    const at = jobType === "SETUP" ? p.setup_start_at : p.dismantle_start_at;
    const date = String(at ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < first || date > last || planned.has(`${p.id}|${jobType}|${date}`)) continue;
    let lorries = projectCrewLorries(jobType === "SETUP" ? p.setup_crew : p.dismantle_crew);
    const legacyDriver = (jobType === "SETUP" ? p.setup_driver_name : p.dismantle_driver_name)?.trim();
    if (!lorries.length && legacyDriver) lorries = [{ plate: "", drivers: [legacyDriver], helpers: [] }];
    lorries.forEach((l, i) => {
      const seat = (name: string | undefined): Seat => ({ name: name ?? "", employeeId: name ? byName(name) : null });
      const [d1, d2, h1, h2] = [seat(l.drivers[0]), seat(l.drivers[1]), seat(l.helpers[0]), seat(l.helpers[1])];
      const ref = `project:${p.id}:${jobType}:${i + 1}`;
      out.push({
        source: "PLANNING",
        source_ref: ref,
        trip_date: date,
        doc_no: p.code || p.name || "",
        transfer_to: "",
        ref_no: p.venue ?? "",
        kind: kindOfJobType(jobType),
        job_type: jobType,
        event_type: eventTypeOf(p.event_slug, p.event_name),
        local_total_sen: 0,
        state: p.state ?? "",
        postcode: "",
        lorry_plate: l.plate,
        trip_ref: ref,
        venue_key: `P${p.id}`,
        driver_1_name: d1.name,
        driver_2_name: d2.name,
        helper_1_name: h1.name,
        helper_2_name: h2.name,
        driver_1_employee_id: d1.employeeId,
        driver_2_employee_id: d2.employeeId,
        helper_1_employee_id: h1.employeeId,
        helper_2_employee_id: h2.employeeId,
      });
    });
  }
  return out;
}

const doRunCandidates = (companyId: number) => sql`
    live AS (
      SELECT l.id, ROW_NUMBER() OVER (PARTITION BY l.so_doc_no ORDER BY l.created_at DESC, l.id DESC) AS rn
        FROM scm.delivery_orders l
       WHERE l.company_id = ${companyId} AND l.status::text <> 'CANCELLED' AND l.so_doc_no IS NOT NULL),
    runs AS (
      SELECT d.id,
             LEFT(COALESCE(so.amended_delivery_date::text, NULLIF(so.customer_delivery_date::text, '')), 10) AS so_due_date,
             (lv.rn = 1) AS is_latest_live,
             LEFT((d.delivered_at::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur')::text, 10) AS delivered_day,
             LEFT(d.do_date::text, 10) AS do_date
        FROM scm.delivery_orders d
        LEFT JOIN live lv ON lv.id = d.id
        LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = d.so_doc_no AND so.company_id = d.company_id
       WHERE d.company_id = ${companyId} AND d.status::text NOT IN ('DRAFT', 'CANCELLED'))`;

/** Everything Delivery Planning and the Projects module say a trip month's crews
 *  did: each stop of our own lorry runs (crew from the DO's crew record, else the
 *  run's; outsourced and cancelled runs and cancelled DOs left out), each
 *  delivery order our own lorries ran that no stop carries (deliveryOrderRows),
 *  and each project Setup / Dismantle no stop carries. */
export async function planningRows(db: Db, companyId: number, month: string, people: ReadonlyArray<Person>): Promise<SourceRow[]> {
  const { first, last } = tripMonthBounds(month);
  const [stops, projects, dos] = await Promise.all([
    // company-scope: trips and trip_stops are both joined on company_id = ${companyId} (the JOIN below).
    db.execute<PlanningStop>(sql`
    SELECT s.id::text AS stop_id, s.do_id::text AS do_id, s.stop_type::text AS stop_type, t.id::text AS trip_id, t.trip_date::text AS trip_date, t.trip_no,
           l.plate, s.revenue_sen, s.customer_name, s.dp_no AS stop_dp_no,
           d.do_number, d.so_doc_no, d.status::text AS do_status, d.local_total_sen,
           COALESCE(NULLIF(d.state, ''), d.customer_state) AS do_state, d.postcode AS do_postcode,
           dp.state AS dp_state, dp.postcode AS dp_postcode, dp.dp_no, dp.project_id::text AS project_id,
           dp.sales_amount_sen AS dp_sales_sen, sup.name AS dp_supplier_name,
           et.slug AS event_slug, et.name AS event_name,
           s.assr_case_id, ac.assr_no, ac.addr3 AS case_addr3, ac.addr4 AS case_addr4,
           so.customer_state AS case_so_state, so.postcode AS case_so_postcode,
           ca.postcode AS case_own_postcode, ca.state AS case_own_state,
           COALESCE(cr.driver_1_id, t.driver_id)::text AS d1, cr.driver_2_id::text AS d2,
           COALESCE(cr.helper_1_id, t.helper_1_id)::text AS h1, COALESCE(cr.helper_2_id, t.helper_2_id)::text AS h2
      FROM scm.trip_stops s
      JOIN scm.trips t ON t.id = s.trip_id AND t.company_id = ${companyId} AND s.company_id = ${companyId}
      LEFT JOIN scm.delivery_orders d ON d.id = s.do_id
      LEFT JOIN scm.delivery_order_crew cr ON cr.do_id = s.do_id
      LEFT JOIN scm.dp_orders dp ON dp.trip_stop_id = s.id
      LEFT JOIN scm.suppliers sup ON sup.id = dp.supplier_id
      LEFT JOIN public.projects pj ON pj.id = dp.project_id
      LEFT JOIN public.project_event_types et ON et.id = pj.event_type_id
      LEFT JOIN scm.lorries l ON l.id = t.lorry_id
      LEFT JOIN public.assr_cases ac ON ac.id = s.assr_case_id
      LEFT JOIN public.assr_case_address ca ON ca.assr_id = ac.id
      LEFT JOIN LATERAL (
           SELECT o.customer_state, o.postcode FROM scm.mfg_sales_orders o
            WHERE o.doc_no = ac.doc_no OR o.linked_ac_docno = ac.doc_no
            ORDER BY (o.doc_no = ac.doc_no) DESC
            LIMIT 1) so ON ac.id IS NOT NULL
     WHERE t.trip_date BETWEEN ${first} AND ${last}
       AND t.status::text <> 'CANCELLED' AND t.is_outsourced = false
     ORDER BY t.trip_date, t.trip_no, s.stop_no`),
    db.execute<ProjectLeg>(sql`
    SELECT p.id::text AS id, p.code, p.name, p.venue, p.state, p.setup_start_at, p.dismantle_start_at,
           p.setup_crew, p.dismantle_crew, et.slug AS event_slug, et.name AS event_name,
           sd.name AS setup_driver_name, dd.name AS dismantle_driver_name
      FROM public.projects p
      LEFT JOIN public.project_event_types et ON et.id = p.event_type_id
      LEFT JOIN public.users sd ON sd.id = p.setup_driver_user_id
      LEFT JOIN public.users dd ON dd.id = p.dismantle_driver_user_id
     WHERE p.company_id = ${companyId} AND p.archived_at IS NULL
       AND (LEFT(p.setup_start_at, 10) BETWEEN ${first} AND ${last} OR LEFT(p.dismantle_start_at, 10) BETWEEN ${first} AND ${last})
     ORDER BY p.id`),
    db.execute<PlanningDo>(sql`
    WITH ${doRunCandidates(companyId)}
    SELECT d.id::text AS do_id, d.do_number, d.so_doc_no, d.debtor_name, d.status::text AS do_status,
           r.so_due_date, r.is_latest_live, r.delivered_day, r.do_date, d.local_total_sen,
           COALESCE(NULLIF(d.state, ''), d.customer_state) AS do_state, d.postcode AS do_postcode, d.is_dropship,
           EXISTS (SELECT 1 FROM scm.threepl_do_charges x WHERE x.do_id = d.id) AS has_3pl,
           EXISTS (SELECT 1 FROM scm.trip_stops s JOIN scm.trips t ON t.id = s.trip_id
                    WHERE s.do_id = d.id AND s.company_id = ${companyId} AND t.status::text <> 'CANCELLED') AS on_live_trip,
           cr.lorry_plate AS crew_plate, lm.plate AS lorry_plate, lm.is_internal AS lorry_internal,
           COALESCE(cr.driver_1_id::text, d.driver_id::text) AS d1, cr.driver_2_id::text AS d2,
           cr.helper_1_id::text AS h1, cr.helper_2_id::text AS h2,
           cr.driver_1_name AS d1_name, cr.driver_2_name AS d2_name, cr.helper_1_name AS h1_name, cr.helper_2_name AS h2_name
      FROM runs r
      JOIN scm.delivery_orders d ON d.id = r.id
      LEFT JOIN scm.delivery_order_crew cr ON cr.do_id = d.id
      LEFT JOIN LATERAL (
           SELECT l.plate, l.is_internal FROM scm.lorries l
            WHERE l.id = cr.lorry_id
               OR (cr.lorry_id IS NULL AND UPPER(REPLACE(l.plate, ' ', '')) = UPPER(REPLACE(cr.lorry_plate, ' ', '')))
            ORDER BY (l.id = cr.lorry_id) DESC NULLS LAST
            LIMIT 1) lm ON cr.do_id IS NOT NULL
     WHERE r.so_due_date BETWEEN ${first} AND ${last} OR r.delivered_day BETWEEN ${first} AND ${last} OR r.do_date BETWEEN ${first} AND ${last}
     ORDER BY d.do_number`),
  ]);
  const crewIds = [...new Set([...stops, ...dos].flatMap((s) => [s.d1, s.d2, s.h1, s.h2]).filter((x): x is string => !!x))];
  const crew = crewIds.length
    ? await db.execute<{ id: string; name: string; user_id: number | null }>(sql`
        SELECT id::text, name, user_id FROM scm.drivers WHERE company_id = ${companyId} AND id::text IN ${crewIds}
        UNION ALL
        SELECT id::text, name, user_id FROM scm.helpers WHERE company_id = ${companyId} AND id::text IN ${crewIds}`)
    : [];
  const crewBy = new Map(crew.map((c) => [c.id, c]));
  const employeeOfUser = new Map(people.filter((p) => p.userId != null).map((p) => [p.userId!, p.id]));
  const who = (id: string | null): Seat => {
    const c = id ? crewBy.get(id) : undefined;
    return { name: c?.name ?? "", employeeId: c?.user_id != null ? (employeeOfUser.get(c.user_id) ?? null) : null };
  };
  const stopRows = stops.filter((s) => s.do_status !== "CANCELLED").map((s) => planningRowOf(s, who));
  const planned = new Set(stopRows.filter((r) => isFairJob(r.job_type) && r.venue_key).map((r) => `${r.venue_key.slice(1)}|${r.job_type}|${r.trip_date}`));
  const byName = nameIndex(people);
  const stopDoIds = new Set(stops.map((s) => s.do_id).filter((x): x is string => !!x));
  const doSeat = (id: string | null, typed: string | null): Seat => {
    const seat = who(id);
    const name = typed?.trim() ?? "";
    return seat.name || !name ? seat : { name, employeeId: byName(name) };
  };
  return [...stopRows, ...deliveryOrderRows(dos, first, last, stopDoIds, doSeat), ...projects.flatMap((p) => projectLegRows(p, first, last, planned, byName))];
}

/** The days of [first, last] whose Delivery Planning / delivery order / Projects source changed after `since`. */
export async function changedSourceDays(db: Db, companyId: number, first: string, last: string, since: string): Promise<Set<string>> {
  const rows = await db.execute<{ d: string }>(sql`
    WITH ${doRunCandidates(companyId)}
    SELECT DISTINCT t.trip_date::text AS d
      FROM scm.trips t
      JOIN scm.trip_stops s ON s.trip_id = t.id AND s.company_id = ${companyId}
      LEFT JOIN scm.dp_orders dp ON dp.trip_stop_id = s.id
      LEFT JOIN scm.delivery_order_crew cr ON cr.do_id = s.do_id
     WHERE t.company_id = ${companyId} AND t.trip_date BETWEEN ${first} AND ${last}
       AND (t.updated_at > ${since}::timestamptz OR s.created_at > ${since}::timestamptz
            OR dp.updated_at > ${since}::timestamptz OR cr.updated_at > ${since}::timestamptz)
    UNION
    SELECT x.day AS d
      FROM runs r
      JOIN scm.delivery_orders d ON d.id = r.id
      LEFT JOIN scm.delivery_order_crew cr ON cr.do_id = d.id
      CROSS JOIN LATERAL (VALUES (r.so_due_date), (r.delivered_day), (r.do_date)) AS x(day)
     WHERE (d.updated_at > ${since}::timestamptz OR cr.updated_at > ${since}::timestamptz)
       AND x.day BETWEEN ${first} AND ${last}
    UNION
    SELECT LEFT(x.at, 10) AS d
      FROM public.projects p
      CROSS JOIN LATERAL (VALUES (p.setup_start_at), (p.dismantle_start_at)) AS x(at)
     WHERE p.company_id = ${companyId}
       AND p.updated_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND p.updated_at::timestamptz > ${since}::timestamptz
       AND LEFT(x.at, 10) BETWEEN ${first} AND ${last}`);
  return new Set(rows.map((r) => r.d));
}

/** A trip month is frozen once the payslip month of the same name is approved or paid. */
export async function tripMonthLocked(db: Db, companyId: number, month: string): Promise<boolean> {
  const rows = await db
    .select({ id: hr_payslips.id })
    .from(hr_payslips)
    .where(and(eq(hr_payslips.company_id, companyId), eq(hr_payslips.period, month), ne(hr_payslips.status, "DRAFT")))
    .limit(1);
  return rows.length > 0;
}
