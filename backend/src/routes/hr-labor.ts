// ----------------------------------------------------------------------------
// hr-labor — Employees & Attendance > Working Hours and Labor Cost (HC-0125
// phase 3), ported from Hookka's working-hour-entries.ts and
// payroll-hour-deductions.ts. Mounted on /api/hr behind the same
// hr.employees.read / .manage gate; writes check manage here.
//
//   GET    /working-hours?from&to            days, punches, logged hours
//   POST   /working-hours                    HR logs hours for a day (MANUAL)
//   PATCH  /working-hours/:id                edit a row (becomes MANUAL)
//   DELETE /working-hours/:id
//   GET    /labor-cost?from&to               cost and hours by department / employee
//   GET    /hour-deductions?period=YYYY-MM   the month's docks
//   POST   /hour-deductions/settle {period}  re-dock the month (Hookka settle-period)
//   DELETE /hour-deductions/:id              undo a dock
//
// Hookka's production-only pieces are not here: SOFA / BEDFRAME categories,
// production revenue, line-scan splits, non-production hour requests.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { departments, hr_attendance, hr_employee_salary_history, hr_employees, hr_hour_deductions, hr_public_holidays, hr_working_hours } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { hasPermission } from "../services/permissions";
import { audit } from "../services/audit";
import { minutesFromWorkDate, toAttendanceRules, workClock } from "../scm/shared/hr-attendance";
import { punchDayHours, rulesForEmployeeHours } from "../scm/shared/hr-labor";
import { asDate } from "./lib/hr-attendance-view";
import { payRulesResolver } from "./lib/hr-attendance-store";
import { loadDeductions, redockDay, settlePeriod } from "./lib/hr-labor-store";
import { laborCost } from "./lib/hr-labor-cost";

type Ctx = Context<{ Bindings: Env }>;
type Db = ReturnType<typeof getDb>;

export const hrLabor = new Hono<{ Bindings: Env }>();

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN = { error: "forbidden", message: "You don't have permission to change HR records." } as const;
const MAX_RANGE_DAYS = 62;

function canManage(c: Ctx): boolean {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, "hr.employees.manage");
}

function range(c: Ctx): { from: string; to: string } | string {
  const today = todayMyt();
  const from = c.req.query("from") ?? `${today.slice(0, 7)}-01`;
  const to = c.req.query("to") ?? today;
  if (!YMD.test(from) || !YMD.test(to) || from > to) return "Pick a date range (from on or before to).";
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) return `At most ${MAX_RANGE_DAYS} days at a time.`;
  return { from, to };
}

function monthBounds(period: string): { first: string; last: string } | null {
  if (!/^\d{4}-\d{2}$/.test(period)) return null;
  const [y, m] = period.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  return { first: `${period}-01`, last: `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` };
}

type HoursInput = { departmentId: number | null; hours: number; notes: string | null };
function parseHours(raw: Record<string, unknown>): HoursInput | string {
  const hours = Number(raw.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return "Hours must be more than 0 and at most 24.";
  if (Math.round(hours * 100) !== hours * 100) return "Hours: at most two decimals (7.75).";
  const dept = raw.departmentId === null || raw.departmentId === "" || raw.departmentId === undefined ? null : Number(raw.departmentId);
  if (dept !== null && (!Number.isInteger(dept) || dept <= 0)) return "Pick a department.";
  const notes = typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim().slice(0, 300) : null;
  return { departmentId: dept, hours, notes };
}

async function departmentExists(db: Db, id: number | null): Promise<boolean> {
  if (id == null) return true;
  return (await db.select({ id: departments.id }).from(departments).where(eq(departments.id, id)).limit(1)).length > 0;
}

/* ── working hours ─────────────────────────────────────────────────────── */

hrLabor.get("/working-hours", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = range(c);
  if (typeof r === "string") return c.json({ error: "bad_range", message: r }, 400);
  const db = getDb(c.env);
  const [employees, depts, days, entries, cfgFor] = await Promise.all([
    db
      .select({
        id: hr_employees.id,
        emp_no: hr_employees.emp_no,
        name: hr_employees.name,
        department_id: hr_employees.department_id,
        status: hr_employees.status,
        hours: hr_employees.working_hours_per_day,
      })
      .from(hr_employees)
      .where(eq(hr_employees.company_id, co.companyId))
      .orderBy(asc(hr_employees.emp_no)),
    db.select({ id: departments.id, name: departments.name }).from(departments).orderBy(asc(departments.sort_order), asc(departments.name)),
    db.select().from(hr_attendance).where(and(eq(hr_attendance.company_id, co.companyId), gte(hr_attendance.work_date, r.from), lte(hr_attendance.work_date, r.to))),
    db
      .select()
      .from(hr_working_hours)
      .where(and(eq(hr_working_hours.company_id, co.companyId), gte(hr_working_hours.work_date, r.from), lte(hr_working_hours.work_date, r.to)))
      .orderBy(asc(hr_working_hours.id)),
    payRulesResolver(db, co.companyId),
  ]);
  const hoursPerDay = new Map(employees.map((e) => [e.id, Number(e.hours)]));
  return c.json({
    ...r,
    employees: employees.map((e) => ({ id: e.id, empNo: e.emp_no, name: e.name, departmentId: e.department_id, status: e.status, hoursPerDay: Number(e.hours) })),
    departments: depts,
    days: days.map((d) => {
      const inMin = d.clock_in_at ? minutesFromWorkDate(d.work_date, asDate(d.clock_in_at)) : null;
      const outMin = d.clock_out_at ? minutesFromWorkDate(d.work_date, asDate(d.clock_out_at)) : null;
      const cfg = cfgFor(d.work_date);
      const punchHours =
        inMin != null && outMin != null ? punchDayHours(inMin, outMin, rulesForEmployeeHours(toAttendanceRules(cfg), hoursPerDay.get(d.employee_id) ?? 9), cfg.brokenPunchCreditsFullDay).hours : null;
      return {
        attendanceId: d.id,
        employeeId: d.employee_id,
        workDate: d.work_date,
        status: d.status,
        clockIn: inMin != null ? workClock(inMin) : null,
        clockOut: outMin != null ? workClock(outMin) : null,
        outSource: d.out_source,
        punchHours,
      };
    }),
    entries: entries.map((e) => ({
      id: e.id,
      attendanceId: e.attendance_id,
      employeeId: e.employee_id,
      workDate: e.work_date,
      departmentId: e.department_id,
      hours: Number(e.hours),
      source: e.source,
      notes: e.notes,
    })),
    canManage: canManage(c),
  });
});

hrLabor.post("/working-hours", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const employeeId = Number(body.employeeId);
  const date = typeof body.date === "string" ? body.date : "";
  if (!Number.isInteger(employeeId) || employeeId <= 0) return c.json({ error: "validation_failed", message: "Pick the employee." }, 400);
  if (!YMD.test(date) || date > todayMyt()) return c.json({ error: "validation_failed", message: "Pick a date up to today." }, 400);
  const input = parseHours(body);
  if (typeof input === "string") return c.json({ error: "validation_failed", message: input }, 400);
  const db = getDb(c.env);
  const emp = (await db.select({ id: hr_employees.id, emp_no: hr_employees.emp_no }).from(hr_employees).where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, employeeId))).limit(1)).at(0);
  if (!emp) return c.json({ error: "not_found_in_company", message: "That employee isn't in the company you're working in." }, 404);
  if (!(await departmentExists(db, input.departmentId))) return c.json({ error: "validation_failed", message: "That department no longer exists." }, 400);
  const by = c.get("user").id;
  /* Hookka's resolveOrCreateAttendance: hours belong to an attendance day, so
     logging hours for a day nobody punched makes it a PRESENT day. */
  let att = (
    await db
      .select({ id: hr_attendance.id })
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.employee_id, employeeId), eq(hr_attendance.work_date, date)))
      .limit(1)
  ).at(0);
  if (!att) {
    [att] = await db
      .insert(hr_attendance)
      .values({ company_id: co.companyId, employee_id: employeeId, work_date: date, status: "PRESENT", updated_by: by })
      .returning({ id: hr_attendance.id });
  }
  const [row] = await db
    .insert(hr_working_hours)
    .values({
      company_id: co.companyId,
      attendance_id: att.id,
      employee_id: employeeId,
      work_date: date,
      department_id: input.departmentId,
      hours: String(input.hours),
      source: "MANUAL",
      notes: input.notes,
      created_by: by,
      updated_by: by,
    })
    .returning({ id: hr_working_hours.id });
  await redockDay(db, co.companyId, employeeId, date);
  await audit(c, { action: "hr.working_hours.add", entityType: "hr_employee", entityId: employeeId, summary: `${emp.emp_no} ${date}: +${input.hours}h`, meta: input });
  return c.json({ id: row.id }, 201);
});

hrLabor.patch("/working-hours/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const input = parseHours((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  if (typeof input === "string") return c.json({ error: "validation_failed", message: input }, 400);
  const db = getDb(c.env);
  if (!(await departmentExists(db, input.departmentId))) return c.json({ error: "validation_failed", message: "That department no longer exists." }, 400);
  const done = await db
    .update(hr_working_hours)
    .set({ department_id: input.departmentId, hours: String(input.hours), notes: input.notes, source: "MANUAL", updated_by: c.get("user").id, updated_at: new Date().toISOString() })
    .where(and(eq(hr_working_hours.company_id, co.companyId), eq(hr_working_hours.id, id)))
    .returning({ employee_id: hr_working_hours.employee_id, work_date: hr_working_hours.work_date });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await redockDay(db, co.companyId, done[0].employee_id, done[0].work_date);
  await audit(c, { action: "hr.working_hours.edit", entityType: "hr_employee", entityId: done[0].employee_id, summary: `${done[0].work_date}: ${input.hours}h`, meta: input });
  return c.json({ ok: true });
});

hrLabor.delete("/working-hours/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const done = await db
    .delete(hr_working_hours)
    .where(and(eq(hr_working_hours.company_id, co.companyId), eq(hr_working_hours.id, id)))
    .returning({ employee_id: hr_working_hours.employee_id, work_date: hr_working_hours.work_date, hours: hr_working_hours.hours, source: hr_working_hours.source });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  /* Removing the last row of a punched day would let the next sync write it
     back from the punch; that is the "undo my edit" a user expects. */
  await redockDay(db, co.companyId, done[0].employee_id, done[0].work_date);
  await audit(c, { action: "hr.working_hours.delete", entityType: "hr_employee", entityId: done[0].employee_id, summary: `${done[0].work_date}: removed ${done[0].hours}h`, meta: done[0] });
  return c.json({ ok: true });
});

/* ── labor cost ────────────────────────────────────────────────────────── */

hrLabor.get("/labor-cost", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = range(c);
  if (typeof r === "string") return c.json({ error: "bad_range", message: r }, 400);
  const db = getDb(c.env);
  const yearStart = `${r.from.slice(0, 4)}-01-01`;
  const yearEnd = `${r.to.slice(0, 4)}-12-31`;
  const [employees, entries, depts, holidays, cfgFor] = await Promise.all([
    db.select().from(hr_employees).where(eq(hr_employees.company_id, co.companyId)),
    db
      .select({ employee_id: hr_working_hours.employee_id, work_date: hr_working_hours.work_date, department_id: hr_working_hours.department_id, hours: hr_working_hours.hours })
      .from(hr_working_hours)
      .where(and(eq(hr_working_hours.company_id, co.companyId), gte(hr_working_hours.work_date, r.from), lte(hr_working_hours.work_date, r.to))),
    db.select({ id: departments.id, name: departments.name }).from(departments),
    db
      .select({ d: hr_public_holidays.holiday_date })
      .from(hr_public_holidays)
      .where(and(eq(hr_public_holidays.company_id, co.companyId), gte(hr_public_holidays.holiday_date, yearStart), lte(hr_public_holidays.holiday_date, yearEnd))),
    payRulesResolver(db, co.companyId),
  ]);
  const ids = [...new Set(entries.map((e) => e.employee_id))];
  const history = ids.length
    ? await db
        .select({ employee_id: hr_employee_salary_history.employee_id, effective_from: hr_employee_salary_history.effective_from, basic_salary_sen: hr_employee_salary_history.basic_salary_sen })
        .from(hr_employee_salary_history)
        .where(and(eq(hr_employee_salary_history.company_id, co.companyId), inArray(hr_employee_salary_history.employee_id, ids)))
    : [];
  const salaryHistory = new Map<number, { effective_from: string; basic_salary_sen: number }[]>();
  for (const h of history) salaryHistory.set(h.employee_id, [...(salaryHistory.get(h.employee_id) ?? []), { effective_from: h.effective_from, basic_salary_sen: Number(h.basic_salary_sen) }]);
  const result = laborCost({
    employees: employees.map((e) => ({
      id: e.id,
      empNo: e.emp_no,
      name: e.name,
      departmentId: e.department_id,
      payMode: e.pay_mode as "MONTHLY" | "DAILY",
      dailyRateSen: Number(e.daily_rate_sen),
      workingHoursPerDay: Number(e.working_hours_per_day),
      workingDaysPerMonth: e.working_days_per_month,
      otMultiplier: Number(e.ot_multiplier),
      resignedOn: e.resigned_on ?? "",
    })),
    salaryHistory,
    entries: entries.map((e) => ({ employeeId: e.employee_id, workDate: e.work_date, departmentId: e.department_id, hours: Number(e.hours) })),
    holidays: new Set(holidays.map((h) => h.d)),
    cfgFor,
    departmentNames: new Map(depts.map((d) => [d.id, d.name])),
  });
  return c.json({ ...r, ...result, canManage: canManage(c) });
});

/* ── short-hour docks ──────────────────────────────────────────────────── */

hrLabor.get("/hour-deductions", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const period = c.req.query("period") ?? todayMyt().slice(0, 7);
  const b = monthBounds(period);
  if (!b) return c.json({ error: "bad_period", message: "Pick a month." }, 400);
  const rows = await loadDeductions(getDb(c.env), co.companyId, b.first, b.last);
  return c.json({
    period,
    deductions: rows.map((r) => ({ id: r.id, employeeId: r.employee_id, empNo: r.emp_no, name: r.name, workDate: r.work_date, hours: Number(r.hours), source: r.source, note: r.note })),
    totalHours: Math.round(rows.reduce((s, r) => s + Number(r.hours), 0) * 100) / 100,
    canManage: canManage(c),
  });
});

hrLabor.post("/hour-deductions/settle", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { period?: unknown };
  const period = typeof body.period === "string" ? body.period : "";
  if (!monthBounds(period)) return c.json({ error: "validation_failed", message: "Pick a month." }, 400);
  const today = todayMyt();
  if (`${period}-01` > today) return c.json({ error: "validation_failed", message: "That month has not started." }, 400);
  const result = await settlePeriod(getDb(c.env), co.companyId, period, today);
  await audit(c, { action: "hr.hour_deductions.settle", entityType: "hr_period", entityId: period, summary: `Settled ${period}: ${result.docked} docked`, meta: result });
  return c.json(result);
});

hrLabor.delete("/hour-deductions/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const done = await getDb(c.env)
    .delete(hr_hour_deductions)
    .where(and(eq(hr_hour_deductions.company_id, co.companyId), eq(hr_hour_deductions.id, id)))
    .returning({ employee_id: hr_hour_deductions.employee_id, work_date: hr_hour_deductions.work_date, hours: hr_hour_deductions.hours, source: hr_hour_deductions.source });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.hour_deductions.undo", entityType: "hr_employee", entityId: done[0].employee_id, summary: `Undid ${done[0].hours}h dock on ${done[0].work_date}`, meta: done[0] });
  return c.json({ ok: true });
});
