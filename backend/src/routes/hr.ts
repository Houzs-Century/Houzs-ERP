// ----------------------------------------------------------------------------
// hr — Employees & Attendance, ported from Hookka for HC-0125. Phase 1: the
// master data the punch clock, working hours and payroll read later.
//
//   GET    /employees                     list, with the linked ERP account
//   GET    /employees/options             ERP accounts, departments, next Emp No
//   POST   /employees                     add (writes the first salary row)
//   PATCH  /employees/:id                 edit; a salary change needs
//                                         salaryEffectiveFrom
//   DELETE /employees/:id                 deactivate (status INACTIVE)
//   GET    /employees/:id/salary-history
//   DELETE /employees/:id/salary-history/:rowId
//   GET    /holidays                      POST /holidays   DELETE /holidays/:date
//   GET    /pay-rules                     POST /pay-rules  DELETE /pay-rules/:id
//
// Reads need hr.employees.read or hr.employees.manage (the mount in index.ts);
// every write needs hr.employees.manage. Salaries and bank accounts, so the
// SCM umbrella never admits anyone here.
//
// COMPANY SCOPE: every table carries company_id and every read and write
// requires the active company (409 company_unresolved otherwise).
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { departments, hr_employee_salary_history, hr_employees, hr_pay_rule_versions, hr_public_holidays, positions, users } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { hasPermission } from "../services/permissions";
import { audit } from "../services/audit";
import { employeeInputProblem, nextEmpNo, parseEmployeeInput } from "../scm/shared/hr-employee";
import { DEFAULT_PAY_RULES, normalizePayRules, payRulesProblem, resolvePayRulesAsOf } from "../scm/shared/hr-pay-rules";
import { employeeColumns, employeeDiff, rowToEmployee, salaryAsOf, type EmployeeOut, type EmployeeRow } from "./lib/hr-rules";

type Ctx = Context<{ Bindings: Env }>;
type Db = ReturnType<typeof getDb>;

const MANAGE = "hr.employees.manage";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const hr = new Hono<{ Bindings: Env }>();

function canManage(c: Ctx): boolean {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, MANAGE);
}
const FORBIDDEN = { error: "forbidden", message: "You don't have permission to change HR records." } as const;

function intParam(c: Ctx, name: string): number | null {
  const n = Number(c.req.param(name));
  return Number.isInteger(n) && n > 0 ? n : null;
}

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === "23505" || String((e as Error | null)?.message ?? "").includes("duplicate key");

async function loadEmployees(db: Db, companyId: number, ids: number[] | null): Promise<EmployeeOut[]> {
  const rows = await db
    .select()
    .from(hr_employees)
    .where(ids ? and(eq(hr_employees.company_id, companyId), inArray(hr_employees.id, ids)) : eq(hr_employees.company_id, companyId))
    .orderBy(asc(hr_employees.emp_no));
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((v): v is number => v != null))];
  const deptIds = [...new Set(rows.map((r) => r.department_id).filter((v): v is number => v != null))];
  const [us, ds] = await Promise.all([
    userIds.length ? db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, userIds)) : Promise.resolve([]),
    deptIds.length ? db.select({ id: departments.id, name: departments.name }).from(departments).where(inArray(departments.id, deptIds)) : Promise.resolve([]),
  ]);
  const userById = new Map(us.map((u) => [u.id, u]));
  const deptById = new Map(ds.map((d) => [d.id, d.name]));
  return rows.map((r) => rowToEmployee(r as EmployeeRow, r.user_id != null ? userById.get(r.user_id) ?? null : null, r.department_id != null ? deptById.get(r.department_id) ?? null : null));
}

/** Keep hr_employees.basic_salary_sen equal to the salary in force today, so
 *  the list shows what they earn now and a future-dated raise waits its day. */
async function syncCurrentSalary(db: Db, companyId: number, employeeId: number): Promise<void> {
  const history = await db
    .select({ effective_from: hr_employee_salary_history.effective_from, basic_salary_sen: hr_employee_salary_history.basic_salary_sen })
    .from(hr_employee_salary_history)
    .where(and(eq(hr_employee_salary_history.company_id, companyId), eq(hr_employee_salary_history.employee_id, employeeId)));
  const current = salaryAsOf(history, todayMyt());
  if (current == null) return;
  await db.update(hr_employees).set({ basic_salary_sen: current }).where(and(eq(hr_employees.company_id, companyId), eq(hr_employees.id, employeeId)));
}

/** The ERP account and department must exist, and one account is one employee per company. */
async function linkProblem(db: Db, companyId: number, userId: number | null, departmentId: number | null, selfId: number | null): Promise<string | null> {
  if (userId != null) {
    const found = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!found.length) return "That ERP account no longer exists.";
    const clash = await db
      .select({ emp_no: hr_employees.emp_no })
      .from(hr_employees)
      .where(and(eq(hr_employees.company_id, companyId), eq(hr_employees.user_id, userId), selfId ? ne(hr_employees.id, selfId) : sql`true`))
      .limit(1);
    if (clash.length) return `That ERP account is already linked to ${clash[0].emp_no}.`;
  }
  if (departmentId != null) {
    const found = await db.select({ id: departments.id }).from(departments).where(eq(departments.id, departmentId)).limit(1);
    if (!found.length) return "That department no longer exists.";
  }
  return null;
}

/* ── employees ─────────────────────────────────────────────────────────── */

hr.get("/employees", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const employees = await loadEmployees(getDb(c.env), co.companyId, null);
  return c.json({ employees, canManage: canManage(c) });
});

hr.get("/employees/options", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const [accounts, depts, linked] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email, phone: users.phone, department_id: users.department_id, position: positions.name })
      .from(users)
      .leftJoin(positions, eq(positions.id, users.position_id))
      .where(eq(users.status, "active"))
      .orderBy(asc(users.name)),
    db.select({ id: departments.id, name: departments.name }).from(departments).orderBy(asc(departments.sort_order), asc(departments.name)),
    db.select({ user_id: hr_employees.user_id, emp_no: hr_employees.emp_no }).from(hr_employees).where(eq(hr_employees.company_id, co.companyId)),
  ]);
  const empNoByUser = new Map(linked.filter((l) => l.user_id != null).map((l) => [l.user_id as number, l.emp_no]));
  const empNos = linked.map((l) => l.emp_no);
  return c.json({
    accounts: accounts.map((a) => ({ ...a, linkedEmpNo: empNoByUser.get(a.id) ?? null })),
    departments: depts,
    nextEmpNo: { staff: nextEmpNo(empNos, false), outsource: nextEmpNo(empNos, true) },
  });
});

hr.post("/employees", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const today = todayMyt();
  const input = parseEmployeeInput(await c.req.json().catch(() => ({})), today);
  if (!input.joinDate) input.joinDate = today;
  const problem = employeeInputProblem(input);
  if (problem) return c.json({ error: "validation_failed", message: problem }, 400);
  const db = getDb(c.env);
  const link = await linkProblem(db, co.companyId, input.userId, input.departmentId, null);
  if (link) return c.json({ error: "validation_failed", message: link }, 400);
  const by = c.get("user").id;
  let id: number;
  try {
    const [row] = await db
      .insert(hr_employees)
      .values({ ...employeeColumns(input), company_id: co.companyId, basic_salary_sen: input.basicSalarySen, created_by: by, updated_by: by })
      .returning({ id: hr_employees.id });
    id = row.id;
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate", message: `Employee No ${input.empNo} or that ERP account is already in use.` }, 409);
    throw e;
  }
  await db.insert(hr_employee_salary_history).values({
    company_id: co.companyId,
    employee_id: id,
    basic_salary_sen: input.basicSalarySen,
    effective_from: input.joinDate,
    note: "Starting salary",
    created_by: by,
  });
  await audit(c, { action: "hr.employee.create", entityType: "hr_employee", entityId: id, summary: `Added ${input.empNo} ${input.name}` });
  const [employee] = await loadEmployees(db, co.companyId, [id]);
  return c.json({ employee }, 201);
});

hr.patch("/employees/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const before = (await loadEmployees(db, co.companyId, [id])).at(0);
  if (!before) return c.json({ error: "not_found_in_company", message: "That employee isn't in the company you're working in." }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const today = todayMyt();
  const input = parseEmployeeInput(body, today);
  const problem = employeeInputProblem(input);
  if (problem) return c.json({ error: "validation_failed", message: problem }, 400);
  const salaryFrom = typeof body.salaryEffectiveFrom === "string" ? body.salaryEffectiveFrom.trim() : "";
  const salaryChanged = input.basicSalarySen !== before.basicSalarySen;
  if (salaryChanged && !YMD.test(salaryFrom)) {
    return c.json({ error: "salary_effective_from_required", message: "The salary changed: pick the date the new salary takes effect." }, 400);
  }
  const link = await linkProblem(db, co.companyId, input.userId, input.departmentId, id);
  if (link) return c.json({ error: "validation_failed", message: link }, 400);
  const by = c.get("user").id;
  try {
    await db
      .update(hr_employees)
      .set({ ...employeeColumns(input), updated_by: by, updated_at: new Date().toISOString() })
      .where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, id)));
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate", message: `Employee No ${input.empNo} or that ERP account is already in use.` }, 409);
    throw e;
  }
  if (salaryChanged) {
    const note = typeof body.salaryNote === "string" && body.salaryNote.trim() ? body.salaryNote.trim() : null;
    await db
      .insert(hr_employee_salary_history)
      .values({ company_id: co.companyId, employee_id: id, basic_salary_sen: input.basicSalarySen, effective_from: salaryFrom, note, created_by: by })
      .onConflictDoUpdate({
        target: [hr_employee_salary_history.employee_id, hr_employee_salary_history.effective_from],
        set: { basic_salary_sen: input.basicSalarySen, note, created_by: by, created_at: new Date().toISOString() },
      });
    await syncCurrentSalary(db, co.companyId, id);
  }
  const diff = employeeDiff(before, input);
  if (salaryChanged) diff.basicSalarySen = { from: before.basicSalarySen, to: `${input.basicSalarySen} from ${salaryFrom}` };
  if (Object.keys(diff).length) {
    await audit(c, { action: "hr.employee.update", entityType: "hr_employee", entityId: id, summary: `Edited ${input.empNo} ${input.name}`, meta: diff });
  }
  const [employee] = await loadEmployees(db, co.companyId, [id]);
  return c.json({ employee });
});

hr.delete("/employees/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const done = await db
    .update(hr_employees)
    .set({ status: "INACTIVE", resigned_on: null, updated_by: c.get("user").id, updated_at: new Date().toISOString() })
    .where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, id)))
    .returning({ emp_no: hr_employees.emp_no, name: hr_employees.name });
  if (!done.length) return c.json({ error: "not_found_in_company", message: "That employee isn't in the company you're working in." }, 404);
  await audit(c, { action: "hr.employee.deactivate", entityType: "hr_employee", entityId: id, summary: `Deactivated ${done[0].emp_no} ${done[0].name}` });
  return c.json({ ok: true });
});

hr.get("/employees/:id/salary-history", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const rows = await getDb(c.env)
    .select()
    .from(hr_employee_salary_history)
    .where(and(eq(hr_employee_salary_history.company_id, co.companyId), eq(hr_employee_salary_history.employee_id, id)))
    .orderBy(desc(hr_employee_salary_history.effective_from));
  return c.json({
    history: rows.map((r) => ({ id: r.id, effectiveFrom: r.effective_from, basicSalarySen: Number(r.basic_salary_sen), note: r.note, createdAt: r.created_at })),
  });
});

hr.delete("/employees/:id/salary-history/:rowId", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  const rowId = intParam(c, "rowId");
  if (!id || !rowId) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const scope = and(eq(hr_employee_salary_history.company_id, co.companyId), eq(hr_employee_salary_history.employee_id, id));
  const rows = await db.select({ id: hr_employee_salary_history.id }).from(hr_employee_salary_history).where(scope);
  if (!rows.some((r) => r.id === rowId)) return c.json({ error: "not_found_in_company" }, 404);
  if (rows.length === 1) return c.json({ error: "last_salary_row", message: "This is the only salary on record. Change the salary instead of removing it." }, 409);
  await db.delete(hr_employee_salary_history).where(and(scope, eq(hr_employee_salary_history.id, rowId)));
  await syncCurrentSalary(db, co.companyId, id);
  await audit(c, { action: "hr.employee.salary_remove", entityType: "hr_employee", entityId: id, summary: `Removed salary row ${rowId}` });
  return c.json({ ok: true });
});

/* ── public holidays ───────────────────────────────────────────────────── */

hr.get("/holidays", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rows = await getDb(c.env).select().from(hr_public_holidays).where(eq(hr_public_holidays.company_id, co.companyId)).orderBy(asc(hr_public_holidays.holiday_date));
  return c.json({ holidays: rows.map((r) => ({ date: r.holiday_date, name: r.name })) });
});

hr.post("/holidays", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { date?: unknown; name?: unknown };
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!YMD.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return c.json({ error: "validation_failed", message: "Pick a date." }, 400);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;
  const db = getDb(c.env);
  await db
    .insert(hr_public_holidays)
    .values({ company_id: co.companyId, holiday_date: date, name, created_by: c.get("user").id })
    .onConflictDoUpdate({ target: [hr_public_holidays.company_id, hr_public_holidays.holiday_date], set: { name } });
  await audit(c, { action: "hr.holiday.add", entityType: "hr_public_holiday", entityId: date, summary: `Public holiday ${date}${name ? ` ${name}` : ""}` });
  return c.json({ ok: true }, 201);
});

hr.delete("/holidays/:date", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const date = c.req.param("date");
  if (!YMD.test(date)) return c.json({ error: "bad_date" }, 400);
  const done = await getDb(c.env)
    .delete(hr_public_holidays)
    .where(and(eq(hr_public_holidays.company_id, co.companyId), eq(hr_public_holidays.holiday_date, date)))
    .returning({ d: hr_public_holidays.holiday_date });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.holiday.remove", entityType: "hr_public_holiday", entityId: date, summary: `Removed public holiday ${date}` });
  return c.json({ ok: true });
});

/* ── pay rules (effective-dated) ───────────────────────────────────────── */

hr.get("/pay-rules", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rows = await getDb(c.env).select().from(hr_pay_rule_versions).where(eq(hr_pay_rule_versions.company_id, co.companyId)).orderBy(desc(hr_pay_rule_versions.effective_from));
  const versions = rows.map((r) => ({ id: r.id, effectiveFrom: r.effective_from, rules: normalizePayRules(r.rules), note: r.note, createdAt: r.created_at, createdBy: r.created_by }));
  const today = todayMyt();
  return c.json({ versions, defaults: DEFAULT_PAY_RULES, effectiveToday: resolvePayRulesAsOf(versions, today), today });
});

hr.post("/pay-rules", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { effectiveFrom?: unknown; rules?: unknown; note?: unknown };
  const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom.trim() : "";
  if (!YMD.test(effectiveFrom)) return c.json({ error: "validation_failed", message: "Pick the date the change takes effect." }, 400);
  const rules = normalizePayRules(body.rules);
  const problem = payRulesProblem(rules);
  if (problem) return c.json({ error: "validation_failed", message: problem }, 400);
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  const db = getDb(c.env);
  const today = todayMyt();
  const existing = (
    await db
    .select({ id: hr_pay_rule_versions.id })
    .from(hr_pay_rule_versions)
    .where(and(eq(hr_pay_rule_versions.company_id, co.companyId), eq(hr_pay_rule_versions.effective_from, effectiveFrom)))
    .limit(1)
  ).at(0);
  if (existing && effectiveFrom <= today) {
    return c.json({ error: "already_in_force", message: `A change from ${effectiveFrom} is already in force. Schedule a new one from a later date.` }, 409);
  }
  const by = c.get("user").id;
  const [row] = existing
    ? await db.update(hr_pay_rule_versions).set({ rules, note, created_by: by, created_at: new Date().toISOString() }).where(eq(hr_pay_rule_versions.id, existing.id)).returning({ id: hr_pay_rule_versions.id })
    : await db.insert(hr_pay_rule_versions).values({ company_id: co.companyId, effective_from: effectiveFrom, rules, note, created_by: by }).returning({ id: hr_pay_rule_versions.id });
  await audit(c, { action: "hr.pay_rules.schedule", entityType: "hr_pay_rule_version", entityId: row.id, summary: `Pay rules from ${effectiveFrom}`, meta: rules });
  return c.json({ id: row.id, effectiveFrom, rules }, existing ? 200 : 201);
});

hr.delete("/pay-rules/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const done = await getDb(c.env)
    .delete(hr_pay_rule_versions)
    .where(and(eq(hr_pay_rule_versions.company_id, co.companyId), eq(hr_pay_rule_versions.id, id), gt(hr_pay_rule_versions.effective_from, todayMyt())))
    .returning({ effective_from: hr_pay_rule_versions.effective_from });
  if (!done.length) return c.json({ error: "in_force", message: "Only a change that has not started yet can be removed; rules already in force are the payroll record." }, 409);
  await audit(c, { action: "hr.pay_rules.remove", entityType: "hr_pay_rule_version", entityId: id, summary: `Removed pay rules from ${done[0].effective_from}` });
  return c.json({ ok: true });
});
