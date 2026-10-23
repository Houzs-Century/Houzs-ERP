/* Loads a trip month and works out everyone's trip pay (HC-0125 phase 5):
 * the month's rows, who each name on them is, the rates in force on the 22nd,
 * and each driver's missed working days (no hours logged and no leave keyed
 * on the Attendance tab, or HR's own count when the punches cannot say). Used by the Trip Pay tab, by payroll
 * (the trip month of the same name lands on that payslip) and by My pay.
 * Also reads Delivery Planning's lorry runs into rows. */
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { APPROVED_LEAVE_STATUSES } from "../../scm/shared/hr-attendance";
import { ASSR_LEG_BY_STOP, assrBoardLocation } from "../../scm/lib/assr-board-scope";
import { getDb } from "../../db/client";
import { hr_attendance, hr_employees, hr_payslips, hr_public_holidays, hr_trip_missed_days, hr_trip_rate_versions, hr_trip_rows, hr_working_hours } from "../../db/schema";
import {
  computeTripPay,
  missedWorkingDays,
  normName,
  resolveTripRatesAsOf,
  tripMonthBounds,
  type TripKind,
  type TripPay,
  type TripRates,
  type TripRow,
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

type Person = { id: number; empNo: string; name: string; tripNames: string | null; userId: number | null; joinDate: string | null; resignedOn: string | null };

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

export function tripRowOf(r: RowRecord): TripRow {
  const person = (name: string, employeeId: number | null) => ({ name, employeeId });
  return {
    tripDate: r.trip_date,
    docNo: r.doc_no,
    transferTo: r.transfer_to,
    refNo: r.ref_no,
    kind: r.kind as TripKind,
    localTotalSen: Number(r.local_total_sen),
    state: r.state,
    lorryPlate: r.lorry_plate,
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
  people: Person[];
  rates: TripRates;
  pay: Map<number, TripPay>;
  missed: Map<number, MissedInfo>;
  /** Names on the rows that resolve to nobody, with how many rows carry each. */
  unmatched: { name: string; rows: number }[];
};

export async function loadTripMonth(db: Db, companyId: number, month: string, today: string): Promise<TripMonth> {
  const { first, last } = tripMonthBounds(month);
  const [rows, people, holidays, worked, leave, overrides, ratesOn] = await Promise.all([
    db
      .select()
      .from(hr_trip_rows)
      .where(and(eq(hr_trip_rows.company_id, companyId), eq(hr_trip_rows.trip_month, month)))
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
  /* Only days already gone count: today is still being worked. */
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

  const pay = computeTripPay({ rows: tripRows, rates, employeeOf, missedDaysOf: (id) => missedOf(id).days });
  for (const [id, p] of pay) if (p.drove) missedOf(id);
  return {
    month,
    first,
    last,
    rows,
    people,
    rates,
    pay,
    missed,
    unmatched: [...unmatchedCount.entries()].map(([name, n]) => ({ name, rows: n })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/* ── Delivery Planning -> rows ─────────────────────────────────────────── */

const STOP_KIND: Partial<Record<string, TripKind>> = {
  DELIVERY: "DO",
  PICKUP: "SERVICE_PICKUP",
  SERVICE: "SERVICE_DELIVERY",
  INSPECTION: "SERVICE_INSPECTION",
  SETUP: "FAIR",
  DISMANTLE: "FAIR",
  SUPPLIER_PICKUP: "SUPPLIER",
  TRANSFER: "TRANSFER",
  LORRY_SERVICE: "NONE",
};
/* A service case's legs ride stops carrying assr_case_id, typed by the board's
   own ASSR_LEG_BY_STOP, so its delivery leg is a DELIVERY stop that is NOT a DO. */
const CASE_LEG_KIND: Partial<Record<string, TripKind>> = { customer_pickup: "SERVICE_PICKUP", delivery: "SERVICE_DELIVERY", inspection: "SERVICE_INSPECTION" };

export type PlanningStop = {
  stop_id: string;
  stop_type: string;
  trip_date: string;
  trip_no: string;
  plate: string | null;
  /** The stop's own snapshot: the DO's or SO's total when it was scheduled. */
  revenue_sen: string | number | null;
  customer_name: string | null;
  stop_dp_no: string | null;
  do_number: string | null;
  so_doc_no: string | null;
  do_status: string | null;
  local_total_sen: string | number | null;
  do_state: string | null;
  dp_state: string | null;
  dp_no: string | null;
  assr_case_id: string | number | null;
  assr_no: string | null;
  case_addr3: string | null;
  case_addr4: string | null;
  case_so_state: string | null;
  d1: string | null;
  d2: string | null;
  h1: string | null;
  h2: string | null;
};

type Seat = { name: string; employeeId: number | null };

/** One stop as a trip row. The amount is the DO's Local Total, else the stop's
 *  own snapshot (an SO scheduled before its DO is never linked to it afterwards);
 *  the state is the DO's, else the service case's (its address, then its order,
 *  as the board shows it), else the manual job's. A row with no state earns no
 *  outstation until HR fills it. Pure. */
export function planningRowOf(s: PlanningStop, who: (id: string | null) => Seat) {
  const [d1, d2, h1, h2] = [who(s.d1), who(s.d2), who(s.h1), who(s.h2)];
  const isCase = s.assr_case_id != null;
  const caseState = isCase ? assrBoardLocation(s.case_addr3, s.case_addr4, s.case_so_state, null).state : null;
  const amount = s.local_total_sen ?? (isCase ? 0 : s.revenue_sen);
  return {
    source: "PLANNING",
    source_ref: s.stop_id,
    trip_date: s.trip_date,
    doc_no: (isCase ? s.assr_no : s.so_doc_no) ?? s.dp_no ?? s.stop_dp_no ?? s.customer_name ?? "",
    transfer_to: s.do_number ?? "",
    ref_no: s.stop_dp_no ?? s.trip_no,
    kind: (isCase ? CASE_LEG_KIND[ASSR_LEG_BY_STOP[s.stop_type] ?? ""] : undefined) ?? STOP_KIND[s.stop_type] ?? "NONE",
    local_total_sen: Math.max(0, Math.round(Number(amount ?? 0)) || 0),
    state: s.do_state || caseState || s.dp_state || "",
    lorry_plate: s.plate ?? "",
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

/** The month's lorry runs as trip rows: each stop one row, its crew from the DO's crew record, else the run's. Outsourced and cancelled runs are left out. */
export async function planningRows(db: Db, companyId: number, month: string, people: ReadonlyArray<Person>): Promise<Array<ReturnType<typeof planningRowOf>>> {
  const { first, last } = tripMonthBounds(month);
  const stops = await db.execute<PlanningStop>(sql`
    SELECT s.id::text AS stop_id, s.stop_type::text AS stop_type, t.trip_date::text AS trip_date, t.trip_no,
           l.plate, s.revenue_sen, s.customer_name, s.dp_no AS stop_dp_no,
           d.do_number, d.so_doc_no, d.status::text AS do_status, d.local_total_sen,
           COALESCE(NULLIF(d.state, ''), d.customer_state) AS do_state, dp.state AS dp_state, dp.dp_no,
           s.assr_case_id, ac.assr_no, ac.addr3 AS case_addr3, ac.addr4 AS case_addr4, so.customer_state AS case_so_state,
           COALESCE(cr.driver_1_id, t.driver_id)::text AS d1, cr.driver_2_id::text AS d2,
           COALESCE(cr.helper_1_id, t.helper_1_id)::text AS h1, COALESCE(cr.helper_2_id, t.helper_2_id)::text AS h2
      FROM scm.trip_stops s
      JOIN scm.trips t ON t.id = s.trip_id AND t.company_id = ${companyId} AND s.company_id = ${companyId}
      LEFT JOIN scm.delivery_orders d ON d.id = s.do_id
      LEFT JOIN scm.delivery_order_crew cr ON cr.do_id = s.do_id
      LEFT JOIN scm.dp_orders dp ON dp.trip_stop_id = s.id
      LEFT JOIN scm.lorries l ON l.id = t.lorry_id
      LEFT JOIN public.assr_cases ac ON ac.id = s.assr_case_id
      LEFT JOIN LATERAL (
           SELECT o.customer_state FROM scm.mfg_sales_orders o
            WHERE o.doc_no = ac.doc_no OR o.linked_ac_docno = ac.doc_no
            ORDER BY (o.doc_no = ac.doc_no) DESC
            LIMIT 1) so ON ac.id IS NOT NULL
     WHERE t.trip_date BETWEEN ${first} AND ${last}
       AND t.status::text <> 'CANCELLED' AND t.is_outsourced = false
     ORDER BY t.trip_date, t.trip_no, s.stop_no`);
  const crewIds = [...new Set(stops.flatMap((s) => [s.d1, s.d2, s.h1, s.h2]).filter((x): x is string => !!x))];
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
  return stops.filter((s) => s.do_status !== "CANCELLED").map((s) => planningRowOf(s, who));
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
