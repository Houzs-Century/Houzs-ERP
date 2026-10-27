/* Working Hours and short-hour docks from punches (HC-0125 phase 3), ported
 * from Hookka's punch-autofill.ts + attendance-deduct.ts + settle-period:
 *   syncDayFromPunch  a closed punch writes the day's AUTO hours and its dock
 *   applyDayDock      the one rule for an AUTO dock (Hookka maybeApplyAutoDayDock)
 *   settlePeriod      re-dock a month from the punches and the logged hours
 *   runAutoClockOut   the cron: close forgotten punches, then sync each day
 * An AUTO row is never written over a MANUAL one, hours or dock. */
import { and, eq, gte, lte, or, sql } from "drizzle-orm";
import type { Env } from "../../types";
import { getDb } from "../../db/client";
import { hr_attendance, hr_employees, hr_hour_deductions, hr_public_holidays, hr_working_hours } from "../../db/schema";
import { minutesFromWorkDate, toAttendanceRules } from "../../scm/shared/hr-attendance";
import { MIN_DOCK_HOURS, isWorkingDay, punchDayHours, punchShortfallHours, rulesForEmployeeHours } from "../../scm/shared/hr-labor";
import { asDate } from "./hr-attendance-view";
import { closeForgottenPunches, payRulesResolver, rulesResolver } from "./hr-attendance-store";

type Db = ReturnType<typeof getDb>;

const round2 = (n: number) => Math.round(n * 100) / 100;

export type DockReason = "applied" | "manual-exists" | "absent-day" | "no-shortfall";

/* Hookka's guards, in order: a MANUAL dock is HR's word and stays; a day with
 * no logged hours is an absence, charged in full by payroll, so an hour-dock
 * on top would charge it twice (any AUTO row is removed); under 0.05 h is
 * rounding (a stale AUTO row is removed); otherwise the AUTO row is set. */
export async function applyDayDock(db: Db, companyId: number, employeeId: number, workDate: string, shortfallHours: number, note: string): Promise<DockReason> {
  const existing = (
    await db
      .select({ id: hr_hour_deductions.id, source: hr_hour_deductions.source })
      .from(hr_hour_deductions)
      .where(and(eq(hr_hour_deductions.company_id, companyId), eq(hr_hour_deductions.employee_id, employeeId), eq(hr_hour_deductions.work_date, workDate)))
      .limit(1)
  ).at(0);
  if (existing?.source === "MANUAL") return "manual-exists";
  const [{ logged }] = await db
    .select({ logged: sql<string>`COALESCE(SUM(${hr_working_hours.hours}), 0)` })
    .from(hr_working_hours)
    .where(and(eq(hr_working_hours.company_id, companyId), eq(hr_working_hours.employee_id, employeeId), eq(hr_working_hours.work_date, workDate)));
  const removeAuto = async () => {
    if (existing) await db.delete(hr_hour_deductions).where(eq(hr_hour_deductions.id, existing.id));
  };
  if (Number(logged) <= 0) {
    await removeAuto();
    return "absent-day";
  }
  if (shortfallHours < MIN_DOCK_HOURS) {
    await removeAuto();
    return "no-shortfall";
  }
  const hours = String(round2(Math.min(24, shortfallHours)));
  if (existing) {
    await db.update(hr_hour_deductions).set({ hours, note, updated_at: new Date().toISOString() }).where(eq(hr_hour_deductions.id, existing.id));
  } else {
    await db.insert(hr_hour_deductions).values({ company_id: companyId, employee_id: employeeId, work_date: workDate, hours, source: "AUTO", note });
  }
  return "applied";
}

/* A closed punch puts its hours on Working Hours and docks its short hours.
 * One AUTO row in the employee's own department (Hookka split by production
 * line scans; Century has none). A forgotten clock-out closed by the system
 * counts the standard day and docks nothing, as in Hookka. A day HR has typed
 * hours for keeps them; its dock is still re-judged from the punch. */
export async function syncDayFromPunch(db: Db, companyId: number, attendanceId: number): Promise<void> {
  const day = (await db.select().from(hr_attendance).where(and(eq(hr_attendance.company_id, companyId), eq(hr_attendance.id, attendanceId))).limit(1)).at(0);
  if (!day?.clock_in_at || !day.clock_out_at) return;
  const emp = (
    await db
      .select({ department_id: hr_employees.department_id, hours: hr_employees.working_hours_per_day })
      .from(hr_employees)
      .where(and(eq(hr_employees.company_id, companyId), eq(hr_employees.id, day.employee_id)))
      .limit(1)
  ).at(0);
  if (!emp) return;
  const cfg = (await payRulesResolver(db, companyId))(day.work_date);
  const rules = rulesForEmployeeHours(toAttendanceRules(cfg), Number(emp.hours));
  const inMin = minutesFromWorkDate(day.work_date, asDate(day.clock_in_at));
  const outMin = minutesFromWorkDate(day.work_date, asDate(day.clock_out_at));
  const forgotten = day.out_source === "AUTO";
  const { hours, broken } = forgotten ? { hours: round2(rules.standardWorkMin / 60), broken: false } : punchDayHours(inMin, outMin, rules, cfg.brokenPunchCreditsFullDay);
  const note = forgotten ? "Auto from punch (no punch-out: standard shift)" : broken ? "Auto from punch (punched in and out at once: standard shift)" : "Auto from punch";

  const rows = await db.select({ id: hr_working_hours.id, source: hr_working_hours.source }).from(hr_working_hours).where(eq(hr_working_hours.attendance_id, attendanceId));
  if (!rows.some((r) => r.source === "MANUAL")) {
    if (rows.length) await db.delete(hr_working_hours).where(eq(hr_working_hours.attendance_id, attendanceId));
    if (hours > 0) {
      await db.insert(hr_working_hours).values({
        company_id: companyId,
        attendance_id: attendanceId,
        employee_id: day.employee_id,
        work_date: day.work_date,
        department_id: emp.department_id,
        hours: String(hours),
        source: "AUTO",
        notes: note,
      });
    }
  }
  /* Sunday and public-holiday work is all OT, so nothing is short. Hookka's
     punch dock missed this (only its settle skipped those days). */
  const holiday = await db
    .select({ d: hr_public_holidays.holiday_date })
    .from(hr_public_holidays)
    .where(and(eq(hr_public_holidays.company_id, companyId), eq(hr_public_holidays.holiday_date, day.work_date)))
    .limit(1);
  const workingDay = isWorkingDay(day.work_date, new Set(holiday.map((h) => h.d)));
  const short = forgotten || broken || !workingDay ? 0 : punchShortfallHours(inMin, outMin, rules);
  const late = Math.max(0, inMin - rules.startMin);
  await applyDayDock(db, companyId, day.employee_id, day.work_date, short, `Auto: short ${short}h${late > rules.lateGraceMin ? `, late ${late} min` : ""} (from punch)`);
}

/** Close forgotten punches for a company (or one employee) and put each closed day on Working Hours. */
export async function closeForgottenAndSync(db: Db, companyId: number, employeeId: number | null, now: Date): Promise<number> {
  const ids = await closeForgottenPunches(db, companyId, employeeId, now);
  for (const id of ids) await syncDayFromPunch(db, companyId, id);
  return ids.length;
}

/** The cron sweep: every company with an open punch. */
export async function runAutoClockOut(env: Env): Promise<{ companies: number; closed: number }> {
  const db = getDb(env);
  const companies = await db
    .selectDistinct({ company_id: hr_attendance.company_id })
    .from(hr_attendance)
    .where(sql`${hr_attendance.clock_in_at} IS NOT NULL AND ${hr_attendance.clock_out_at} IS NULL`);
  let closed = 0;
  const now = new Date();
  for (const c of companies) closed += await closeForgottenAndSync(db, c.company_id, null, now);
  return { companies: companies.length, closed };
}

export type SettleResult = { period: string; employees: number; days: number; docked: number; cleared: number; manualKept: number };

/* Settle a month (Hookka POST /settle-period): for every employee active in
 * it and every elapsed working day they logged hours on, dock the larger of
 * the punch shortfall and the under-logged hours (standard day minus logged).
 * Days with no hours are absences (payroll charges the day; no dock). Re-run
 * safe: only AUTO rows change. */
export async function settlePeriod(db: Db, companyId: number, period: string, today: string): Promise<SettleResult> {
  const [y, m] = period.split("-").map(Number);
  const first = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${period}-${String(lastDay).padStart(2, "0")}`;
  const until = last < today ? last : today;
  const [employees, holidays, hours, days, rulesFor] = await Promise.all([
    db
      .select({ id: hr_employees.id, status: hr_employees.status, resigned_on: hr_employees.resigned_on, join_date: hr_employees.join_date, hours: hr_employees.working_hours_per_day })
      .from(hr_employees)
      .where(and(eq(hr_employees.company_id, companyId), or(eq(hr_employees.status, "ACTIVE"), and(eq(hr_employees.status, "RESIGNED"), gte(hr_employees.resigned_on, first))))),
    db.select({ d: hr_public_holidays.holiday_date }).from(hr_public_holidays).where(and(eq(hr_public_holidays.company_id, companyId), gte(hr_public_holidays.holiday_date, first), lte(hr_public_holidays.holiday_date, last))),
    db
      .select({ employee_id: hr_working_hours.employee_id, work_date: hr_working_hours.work_date, hours: sql<string>`SUM(${hr_working_hours.hours})` })
      .from(hr_working_hours)
      .where(and(eq(hr_working_hours.company_id, companyId), gte(hr_working_hours.work_date, first), lte(hr_working_hours.work_date, until)))
      .groupBy(hr_working_hours.employee_id, hr_working_hours.work_date),
    db
      .select({ employee_id: hr_attendance.employee_id, work_date: hr_attendance.work_date, clock_in_at: hr_attendance.clock_in_at, clock_out_at: hr_attendance.clock_out_at, out_source: hr_attendance.out_source })
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, companyId), gte(hr_attendance.work_date, first), lte(hr_attendance.work_date, until))),
    rulesResolver(db, companyId),
  ]);
  const holidaySet = new Set(holidays.map((h) => h.d));
  const logged = new Map(hours.map((h) => [`${h.employee_id}|${h.work_date}`, Number(h.hours)]));
  const punches = new Map(days.map((d) => [`${d.employee_id}|${d.work_date}`, d]));
  const result: SettleResult = { period, employees: employees.length, days: 0, docked: 0, cleared: 0, manualKept: 0 };
  for (let d = 1; d <= lastDay; d++) {
    const ymd = `${period}-${String(d).padStart(2, "0")}`;
    if (ymd > until || !isWorkingDay(ymd, holidaySet)) continue;
    for (const e of employees) {
      if (e.join_date && ymd < e.join_date) continue;
      if (e.resigned_on && ymd > e.resigned_on) continue;
      const loggedHours = logged.get(`${e.id}|${ymd}`) ?? 0;
      if (loggedHours <= 0) continue;
      result.days++;
      const rules = rulesForEmployeeHours(rulesFor(ymd), Number(e.hours));
      const p = punches.get(`${e.id}|${ymd}`);
      const punchShort =
        p?.clock_in_at && p.clock_out_at && p.out_source !== "AUTO"
          ? punchShortfallHours(minutesFromWorkDate(ymd, asDate(p.clock_in_at)), minutesFromWorkDate(ymd, asDate(p.clock_out_at)), rules)
          : 0;
      const underLogged = Math.max(0, round2(rules.standardWorkMin / 60 - loggedHours));
      const short = Math.max(punchShort, underLogged);
      const reason = await applyDayDock(db, companyId, e.id, ymd, short, `Auto: short ${round2(short)}h (month settled ${today})`);
      if (reason === "applied") result.docked++;
      else if (reason === "manual-exists") result.manualKept++;
      else result.cleared++;
    }
  }
  return result;
}

/** Docks of a month with the employee, newest first. */
export async function loadDeductions(db: Db, companyId: number, first: string, last: string) {
  return db
    .select({
      id: hr_hour_deductions.id,
      employee_id: hr_hour_deductions.employee_id,
      emp_no: hr_employees.emp_no,
      name: hr_employees.name,
      work_date: hr_hour_deductions.work_date,
      hours: hr_hour_deductions.hours,
      source: hr_hour_deductions.source,
      note: hr_hour_deductions.note,
    })
    .from(hr_hour_deductions)
    .innerJoin(hr_employees, eq(hr_employees.id, hr_hour_deductions.employee_id))
    .where(and(eq(hr_hour_deductions.company_id, companyId), gte(hr_hour_deductions.work_date, first), lte(hr_hour_deductions.work_date, last)))
    .orderBy(sql`${hr_hour_deductions.work_date} DESC, ${hr_employees.emp_no}`);
}

/** Re-judge a day's dock after HR changed its hours (Hookka fired auto-from-punch on every save). */
export async function redockDay(db: Db, companyId: number, employeeId: number, workDate: string): Promise<void> {
  const att = (
    await db
      .select({ id: hr_attendance.id })
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, companyId), eq(hr_attendance.employee_id, employeeId), eq(hr_attendance.work_date, workDate)))
      .limit(1)
  ).at(0);
  if (att) await syncDayFromPunch(db, companyId, att.id);
}
