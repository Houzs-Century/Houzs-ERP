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
import { hr_attendance, hr_employees, hr_hour_deductions, hr_ot_claims, hr_public_holidays, hr_working_hours } from "../../db/schema";
import { minutesFromWorkDate } from "../../scm/shared/hr-attendance";
import { MIN_DOCK_HOURS, isWorkingDay, punchDayHours, punchShortfallHours, rulesForEmployeeHours } from "../../scm/shared/hr-labor";
import { isDriverPosition, planAutoOtClaim, punchOtMinutes } from "./hr-ot";
import { asDate } from "./hr-attendance-view";
import type { AttendanceRules } from "../../scm/shared/hr-attendance";
import { closeForgottenPunches, payRulesResolver } from "./hr-attendance-store";
import { shiftRulesResolver } from "./hr-shift-store";

type Db = ReturnType<typeof getDb>;

const round2 = (n: number) => Math.round(n * 100) / 100;

export type DockReason = "applied" | "manual-exists" | "absent-day" | "no-shortfall";

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

/* HC-0125 hybrid overtime (owner 2026-11-20): a closed punch on a working day
 * earns overtime automatically — the span present over the standard day and the
 * break — kept as ONE pending AUTO claim a supervisor still confirms before it
 * pays. Suppressed when a human reported overtime for the day (their precise
 * windows own it), and never over a supervisor's own confirm/reject, so payroll
 * (which pays every confirmed claim) sees at most one live figure a day and
 * never double-pays. Company-scoped on the write as well as the read. */
async function syncAutoOtClaim(
  db: Db,
  companyId: number,
  employeeId: number,
  workDate: string,
  rules: AttendanceRules,
  otMin: number,
  isDriver: boolean,
): Promise<void> {
  const claims = await db
    .select({ id: hr_ot_claims.id, status: hr_ot_claims.status, source: hr_ot_claims.source })
    .from(hr_ot_claims)
    .where(and(eq(hr_ot_claims.company_id, companyId), eq(hr_ot_claims.employee_id, employeeId), eq(hr_ot_claims.work_date, workDate)));
  const existingAuto = claims.find((r) => r.source === "AUTO") ?? null;
  const reportedOwnsDay = claims.some((r) => r.source === "REPORTED" && (r.status === "PENDING" || r.status === "CONFIRMED"));
  const plan = planAutoOtClaim({ existingAuto, reportedOwnsDay, isDriver, shiftEndMin: rules.endMin, otMin });
  if (plan.kind === "none") return;
  if (plan.kind === "delete") {
    await db.delete(hr_ot_claims).where(and(eq(hr_ot_claims.id, plan.id), eq(hr_ot_claims.company_id, companyId)));
    return;
  }
  const note = `Auto from punch (${round2(otMin / 60)}h past the shift)`;
  if (plan.kind === "update") {
    await db
      .update(hr_ot_claims)
      .set({ start_min: plan.startMin, end_min: plan.endMin, note, updated_at: new Date().toISOString() })
      .where(and(eq(hr_ot_claims.id, plan.id), eq(hr_ot_claims.company_id, companyId), eq(hr_ot_claims.status, "PENDING")));
    return;
  }
  try {
    await db
      .insert(hr_ot_claims)
      .values({ company_id: companyId, employee_id: employeeId, work_date: workDate, start_min: plan.startMin, end_min: plan.endMin, note, status: "PENDING", source: "AUTO", created_by: null });
  } catch (e) {
    if ((e as { code?: string } | null)?.code !== "23505" && !String((e as Error | null)?.message ?? "").includes("duplicate key")) throw e;
  }
}

export async function syncDayFromPunch(db: Db, companyId: number, attendanceId: number): Promise<void> {
  const day = (await db.select().from(hr_attendance).where(and(eq(hr_attendance.company_id, companyId), eq(hr_attendance.id, attendanceId))).limit(1)).at(0);
  if (!day?.clock_in_at || !day.clock_out_at) return;
  const emp = (
    await db
      .select({ department_id: hr_employees.department_id, hours: hr_employees.working_hours_per_day, position: hr_employees.position })
      .from(hr_employees)
      .where(and(eq(hr_employees.company_id, companyId), eq(hr_employees.id, day.employee_id)))
      .limit(1)
  ).at(0);
  if (!emp) return;
  const cfg = (await payRulesResolver(db, companyId))(day.work_date);
  const shift = await shiftRulesResolver(db, companyId, day.work_date, day.work_date);
  const base = shift.rulesFor(day.work_date, day.employee_id);
  const rules = shift.hasGroup(day.employee_id) ? base : rulesForEmployeeHours(base, Number(emp.hours));
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
  const holiday = await db
    .select({ d: hr_public_holidays.holiday_date })
    .from(hr_public_holidays)
    .where(and(eq(hr_public_holidays.company_id, companyId), eq(hr_public_holidays.holiday_date, day.work_date)))
    .limit(1);
  const workingDay = isWorkingDay(day.work_date, new Set(holiday.map((h) => h.d)));
  const short = forgotten || broken || !workingDay ? 0 : punchShortfallHours(inMin, outMin, rules);
  const late = Math.max(0, inMin - rules.startMin);
  await applyDayDock(db, companyId, day.employee_id, day.work_date, short, `Auto: short ${short}h${late > rules.lateGraceMin ? `, late ${late} min` : ""} (from punch)`);

  /* Overtime from the same punch (HC-0125 hybrid). A forgotten or broken punch,
     and Sunday / holiday work (all OT via the hours path), earn no weekday claim. */
  const otMin = forgotten || broken || !workingDay ? 0 : punchOtMinutes(outMin - inMin, rules.standardWorkMin, rules.lunchMin);
  await syncAutoOtClaim(db, companyId, day.employee_id, day.work_date, rules, otMin, isDriverPosition(emp.position));
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

export async function settlePeriod(db: Db, companyId: number, period: string, today: string): Promise<SettleResult> {
  const [y, m] = period.split("-").map(Number);
  const first = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${period}-${String(lastDay).padStart(2, "0")}`;
  const until = last < today ? last : today;
  const [employees, holidays, hours, days, shift] = await Promise.all([
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
    shiftRulesResolver(db, companyId, first, until),
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
      const base = shift.rulesFor(ymd, e.id);
      const rules = shift.hasGroup(e.id) ? base : rulesForEmployeeHours(base, Number(e.hours));
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
