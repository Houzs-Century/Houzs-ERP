// ----------------------------------------------------------------------------
// hr-payroll — Employees & Attendance > Payroll, Advances, Penalties (HC-0125
// phase 4), ported from Hookka's payslips.ts, employee-advances.ts and
// worker-penalties.ts. Mounted on /api/hr behind hr.employees.read / .manage;
// approving a month or a penalty needs hr.payroll.approve.
//
//   GET    /payroll?period=YYYY-MM          stored slips, or a projection when none
//   POST   /payroll/generate {period, regenerate}
//   POST   /payroll/status {period, status}  DRAFT <-> APPROVED, APPROVED -> PAID
//   GET    /payroll/:id                      one slip (print)
//   GET    /advances?period   POST /advances   PATCH|DELETE /advances/:id
//   GET    /penalties         POST /penalties  PATCH|DELETE /penalties/:id
//   POST   /penalties/:id/submit | approve | reject | revoke
//
// A month locks when it is approved: Generate refuses it, advances of it
// settle, its penalty lines post to their slips. Back to DRAFT undoes both.
// Hookka had no un-approve or mark-paid button; both are here.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { hr_advances, hr_employees, hr_payslips, hr_penalties, hr_penalty_lines } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { hasPermission } from "../services/permissions";
import { audit } from "../services/audit";
import { computePeriod, lockedPeriods, payslipRow, periodBounds } from "./lib/hr-payroll-store";
import { penaltyPeriod, type AllowanceLine } from "./lib/hr-payslip";
import type { TripCommission, TripPayLine } from "../scm/shared/hr-trip-pay";

type Ctx = Context<{ Bindings: Env }>;
type Db = ReturnType<typeof getDb>;

export const hrPayroll = new Hono<{ Bindings: Env }>();

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN = { error: "forbidden", message: "You don't have permission to change HR records." } as const;
const NOT_APPROVER = { error: "forbidden", message: "Approving needs the Approve payroll permission." } as const;

function has(c: Ctx, key: string): boolean {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, key);
}
const canManage = (c: Ctx) => has(c, "hr.employees.manage");
const canApprove = (c: Ctx) => has(c, "hr.payroll.approve");

export type SlipRow = ReturnType<typeof payslipRow> & { id?: number; status: string; approved_at?: string | null; paid_at?: string | null };
export function slipOut(r: SlipRow) {
  return {
    id: r.id ?? null,
    employeeId: r.employee_id,
    period: r.period,
    status: r.status,
    empNo: r.emp_no,
    employeeName: r.employee_name,
    departmentName: r.department_name,
    payMode: r.pay_mode,
    fullSalarySen: Number(r.full_salary_sen),
    dayRateSen: Number(r.day_rate_sen),
    hourRateSen: Number(r.hour_rate_sen),
    daysWorked: r.days_worked,
    absentDays: r.absent_days,
    absenceDeductionSen: Number(r.absence_deduction_sen),
    shortHours: Number(r.short_hours),
    shortHourDeductionSen: Number(r.short_hour_deduction_sen),
    basicEarnedSen: Number(r.basic_earned_sen),
    otWeekdayHours: Number(r.ot_weekday_hours),
    otSundayHours: Number(r.ot_sunday_hours),
    otHolidayHours: Number(r.ot_holiday_hours),
    otWeekdayPaySen: Number(r.ot_weekday_pay_sen),
    otSundayPaySen: Number(r.ot_sunday_pay_sen),
    otHolidayPaySen: Number(r.ot_holiday_pay_sen),
    otPaySen: Number(r.ot_pay_sen),
    allowancesSen: Number(r.allowances_sen),
    commissionSen: Number(r.commission_sen),
    tripAllowanceSen: Number(r.trip_allowance_sen),
    backpaySen: Number(r.backpay_sen),
    grossSen: Number(r.gross_sen),
    epfEmployeeSen: Number(r.epf_employee_sen),
    epfEmployerSen: Number(r.epf_employer_sen),
    socsoEmployeeSen: Number(r.socso_employee_sen),
    socsoEmployerSen: Number(r.socso_employer_sen),
    eisEmployeeSen: Number(r.eis_employee_sen),
    eisEmployerSen: Number(r.eis_employer_sen),
    pcbSen: Number(r.pcb_sen),
    pcbStatus: r.pcb_status,
    statutoryEmployeeSen: Number(r.statutory_employee_sen),
    advanceSen: Number(r.advance_sen),
    penaltySen: Number(r.penalty_sen),
    netSen: Number(r.net_sen),
    paymentMethod: r.payment_method,
    bankName: r.bank_name,
    bankAccount: r.bank_account,
    detail: r.detail as {
      absentDates: string[];
      paidLeaveDates?: string[];
      otDays: { date: string; hours: number; kind: string }[];
      advanceDates: string[];
      pcbNote: string;
      allowances?: AllowanceLine[];
      trip?: { commission: TripCommission; lines: TripPayLine[] } | null;
    },
    approvedAt: r.approved_at ?? null,
    paidAt: r.paid_at ?? null,
  };
}

/* ── payroll ───────────────────────────────────────────────────────────── */

hrPayroll.get("/payroll", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const period = c.req.query("period") ?? todayMyt().slice(0, 7);
  if (!PERIOD.test(period)) return c.json({ error: "bad_period", message: "Pick a month." }, 400);
  const db = getDb(c.env);
  const stored = await db.select().from(hr_payslips).where(and(eq(hr_payslips.company_id, co.companyId), eq(hr_payslips.period, period))).orderBy(asc(hr_payslips.emp_no));
  const today = todayMyt();
  const slips = stored.length ? stored.map((r) => slipOut(r as SlipRow)) : (await computePeriod(db, co.companyId, period, today)).map((s) => slipOut(payslipRow(co.companyId, period, s, null) as SlipRow));
  const statuses = new Set(stored.map((r) => r.status));
  return c.json({
    period,
    stored: stored.length > 0,
    projected: stored.length === 0,
    locked: stored.some((r) => r.status !== "DRAFT"),
    status: statuses.size === 1 ? [...statuses][0] : statuses.size ? "MIXED" : null,
    monthFinished: periodBounds(period).last < today,
    slips,
    canManage: canManage(c),
    canApprove: canApprove(c),
  });
});

hrPayroll.post("/payroll/generate", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { period?: unknown; regenerate?: unknown };
  const period = typeof body.period === "string" ? body.period : "";
  if (!PERIOD.test(period)) return c.json({ error: "validation_failed", message: "Pick a month." }, 400);
  const today = todayMyt();
  if (`${period}-01` > today) return c.json({ error: "validation_failed", message: "That month has not started." }, 400);
  const db = getDb(c.env);
  const existing = await db.select({ status: hr_payslips.status }).from(hr_payslips).where(and(eq(hr_payslips.company_id, co.companyId), eq(hr_payslips.period, period)));
  if (existing.some((r) => r.status !== "DRAFT")) return c.json({ error: "locked", message: `${period} is approved. Set it back to draft before regenerating.` }, 409);
  if (existing.length && body.regenerate !== true) return c.json({ error: "exists", message: `${period} is already generated. Use Regenerate to work it out again.` }, 409);
  const slips = await computePeriod(db, co.companyId, period, today);
  const by = c.get("user").id;
  await db.delete(hr_payslips).where(and(eq(hr_payslips.company_id, co.companyId), eq(hr_payslips.period, period), eq(hr_payslips.status, "DRAFT")));
  if (slips.length) await db.insert(hr_payslips).values(slips.map((s) => payslipRow(co.companyId, period, s, by)));
  await audit(c, { action: "hr.payroll.generate", entityType: "hr_period", entityId: period, summary: `${existing.length ? "Regenerated" : "Generated"} ${period}: ${slips.length} slips` });
  return c.json({ ok: true, count: slips.length });
});

async function setAdvancesSettled(db: Db, companyId: number, period: string, settled: boolean) {
  const { first, last } = periodBounds(period);
  await db
    .update(hr_advances)
    .set({ status: settled ? "SETTLED" : "UNSETTLED", settled_period: settled ? period : null, updated_at: new Date().toISOString() })
    .where(and(eq(hr_advances.company_id, companyId), gte(hr_advances.advance_date, first), lte(hr_advances.advance_date, last)));
}

/* Approving posts the month's penalty lines to their slips; a line whose
 * employee has no slip that month rolls to the next month (Hookka). Back to
 * draft un-posts them. */
async function postPenalties(db: Db, companyId: number, period: string, post: boolean) {
  const now = new Date().toISOString();
  const lines = await db
    .select({ id: hr_penalty_lines.id, employee_id: hr_penalty_lines.employee_id, penalty_id: hr_penalty_lines.penalty_id })
    .from(hr_penalty_lines)
    .innerJoin(hr_penalties, eq(hr_penalties.id, hr_penalty_lines.penalty_id))
    .where(and(eq(hr_penalty_lines.company_id, companyId), eq(hr_penalty_lines.payroll_period, period), inArray(hr_penalties.status, ["APPROVED", "POSTED"])));
  if (!lines.length) return;
  if (!post) {
    await db.update(hr_penalty_lines).set({ payslip_id: null, posted_at: null }).where(inArray(hr_penalty_lines.id, lines.map((l) => l.id)));
    await db.update(hr_penalties).set({ status: "APPROVED", updated_at: now }).where(and(inArray(hr_penalties.id, [...new Set(lines.map((l) => l.penalty_id))]), eq(hr_penalties.status, "POSTED")));
    return;
  }
  const slips = await db.select({ id: hr_payslips.id, employee_id: hr_payslips.employee_id }).from(hr_payslips).where(and(eq(hr_payslips.company_id, companyId), eq(hr_payslips.period, period)));
  const slipBy = new Map(slips.map((s) => [s.employee_id, s.id]));
  const [y, m] = period.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  for (const l of lines) {
    const slip = slipBy.get(l.employee_id);
    await db
      .update(hr_penalty_lines)
      .set(slip ? { payslip_id: slip, posted_at: now } : { payroll_period: next })
      .where(eq(hr_penalty_lines.id, l.id));
  }
  const penaltyIds = [...new Set(lines.map((l) => l.penalty_id))];
  for (const pid of penaltyIds) {
    const open = await db.select({ id: hr_penalty_lines.id }).from(hr_penalty_lines).where(and(eq(hr_penalty_lines.penalty_id, pid), isNull(hr_penalty_lines.posted_at))).limit(1);
    if (!open.length) await db.update(hr_penalties).set({ status: "POSTED", updated_at: now }).where(eq(hr_penalties.id, pid));
  }
}

hrPayroll.post("/payroll/status", async (c) => {
  if (!canApprove(c)) return c.json(NOT_APPROVER, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { period?: unknown; status?: unknown };
  const period = typeof body.period === "string" ? body.period : "";
  const to = body.status === "DRAFT" || body.status === "APPROVED" || body.status === "PAID" ? body.status : null;
  if (!PERIOD.test(period) || !to) return c.json({ error: "validation_failed", message: "Pick a month and a status." }, 400);
  const db = getDb(c.env);
  const rows = await db.select({ status: hr_payslips.status }).from(hr_payslips).where(and(eq(hr_payslips.company_id, co.companyId), eq(hr_payslips.period, period)));
  if (!rows.length) return c.json({ error: "not_generated", message: `${period} has not been generated.` }, 409);
  const from = new Set(rows.map((r) => r.status));
  const allowed = (to === "APPROVED" && from.has("DRAFT") && !from.has("PAID")) || (to === "DRAFT" && from.has("APPROVED") && !from.has("PAID")) || (to === "PAID" && from.has("APPROVED") && !from.has("DRAFT"));
  if (!allowed) return c.json({ error: "bad_transition", message: `${period} is ${[...from].join(" / ")}; it cannot go to ${to}.` }, 409);
  const now = new Date().toISOString();
  const by = c.get("user").id;
  const set =
    to === "APPROVED"
      ? { status: to, approved_at: now, approved_by: by, updated_at: now }
      : to === "PAID"
        ? { status: to, paid_at: now, paid_by: by, updated_at: now }
        : { status: to, approved_at: null, approved_by: null, updated_at: now };
  await db.update(hr_payslips).set(set).where(and(eq(hr_payslips.company_id, co.companyId), eq(hr_payslips.period, period)));
  if (to === "APPROVED") {
    await setAdvancesSettled(db, co.companyId, period, true);
    await postPenalties(db, co.companyId, period, true);
  } else if (to === "DRAFT") {
    await setAdvancesSettled(db, co.companyId, period, false);
    await postPenalties(db, co.companyId, period, false);
  }
  await audit(c, { action: "hr.payroll.status", entityType: "hr_period", entityId: period, summary: `${period}: ${[...from].join("/")} -> ${to}` });
  return c.json({ ok: true });
});

hrPayroll.get("/payroll/:id", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const row = (await getDb(c.env).select().from(hr_payslips).where(and(eq(hr_payslips.company_id, co.companyId), eq(hr_payslips.id, id))).limit(1)).at(0);
  if (!row) return c.json({ error: "not_found_in_company" }, 404);
  return c.json({ slip: slipOut(row as SlipRow) });
});

/* ── advances ──────────────────────────────────────────────────────────── */

hrPayroll.get("/advances", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const period = c.req.query("period") ?? todayMyt().slice(0, 7);
  if (!PERIOD.test(period)) return c.json({ error: "bad_period", message: "Pick a month." }, 400);
  const { first, last } = periodBounds(period);
  const rows = await getDb(c.env)
    .select({ a: hr_advances, emp_no: hr_employees.emp_no, name: hr_employees.name })
    .from(hr_advances)
    .innerJoin(hr_employees, eq(hr_employees.id, hr_advances.employee_id))
    .where(and(eq(hr_advances.company_id, co.companyId), gte(hr_advances.advance_date, first), lte(hr_advances.advance_date, last)))
    .orderBy(desc(hr_advances.advance_date), asc(hr_employees.emp_no));
  return c.json({
    period,
    advances: rows.map(({ a, emp_no, name }) => ({ id: a.id, employeeId: a.employee_id, empNo: emp_no, name, date: a.advance_date, amountSen: Number(a.amount_sen), note: a.note, status: a.status })),
    totalSen: rows.reduce((s, r) => s + Number(r.a.amount_sen), 0),
    canManage: canManage(c),
  });
});

async function periodLocked(db: Db, companyId: number, ymd: string): Promise<boolean> {
  return (await lockedPeriods(db, companyId)).has(ymd.slice(0, 7));
}

function parseAdvance(raw: Record<string, unknown>): { employeeId: number; date: string; amountSen: number; note: string | null } | string {
  const employeeId = Number(raw.employeeId);
  const date = typeof raw.date === "string" ? raw.date : "";
  const amountSen = Number(raw.amountSen);
  if (!Number.isInteger(employeeId) || employeeId <= 0) return "Pick the employee.";
  if (!YMD.test(date)) return "Pick the date the money was given.";
  if (!Number.isInteger(amountSen) || amountSen <= 0) return "The amount must be more than RM 0.00.";
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 200) : null;
  return { employeeId, date, amountSen, note };
}

hrPayroll.post("/advances", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const a = parseAdvance((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  if (typeof a === "string") return c.json({ error: "validation_failed", message: a }, 400);
  const db = getDb(c.env);
  const emp = (await db.select({ emp_no: hr_employees.emp_no }).from(hr_employees).where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, a.employeeId))).limit(1)).at(0);
  if (!emp) return c.json({ error: "not_found_in_company", message: "That employee isn't in the company you're working in." }, 404);
  if (await periodLocked(db, co.companyId, a.date)) return c.json({ error: "locked", message: `Payroll for ${a.date.slice(0, 7)} is approved; date the advance in an open month.` }, 409);
  const [row] = await db
    .insert(hr_advances)
    .values({ company_id: co.companyId, employee_id: a.employeeId, advance_date: a.date, amount_sen: a.amountSen, note: a.note, created_by: c.get("user").id })
    .returning({ id: hr_advances.id });
  await audit(c, { action: "hr.advance.create", entityType: "hr_employee", entityId: a.employeeId, summary: `${emp.emp_no} advance ${a.date}`, meta: a });
  return c.json({ id: row.id }, 201);
});

hrPayroll.patch("/advances/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  const a = parseAdvance((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  if (typeof a === "string") return c.json({ error: "validation_failed", message: a }, 400);
  const db = getDb(c.env);
  if (await periodLocked(db, co.companyId, a.date)) return c.json({ error: "locked", message: `Payroll for ${a.date.slice(0, 7)} is approved.` }, 409);
  const done = await db
    .update(hr_advances)
    .set({ employee_id: a.employeeId, advance_date: a.date, amount_sen: a.amountSen, note: a.note, updated_at: new Date().toISOString() })
    .where(and(eq(hr_advances.company_id, co.companyId), eq(hr_advances.id, id), eq(hr_advances.status, "UNSETTLED")))
    .returning({ id: hr_advances.id });
  if (!done.length) return c.json({ error: "settled", message: "Only an unsettled advance can be changed." }, 409);
  await audit(c, { action: "hr.advance.edit", entityType: "hr_employee", entityId: a.employeeId, summary: `Advance ${id}`, meta: a });
  return c.json({ ok: true });
});

hrPayroll.delete("/advances/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  const done = await getDb(c.env)
    .delete(hr_advances)
    .where(and(eq(hr_advances.company_id, co.companyId), eq(hr_advances.id, id), eq(hr_advances.status, "UNSETTLED")))
    .returning({ employee_id: hr_advances.employee_id, amount_sen: hr_advances.amount_sen, advance_date: hr_advances.advance_date });
  if (!done.length) return c.json({ error: "settled", message: "Only an unsettled advance can be removed." }, 409);
  await audit(c, { action: "hr.advance.delete", entityType: "hr_employee", entityId: done[0].employee_id, summary: `Removed advance ${done[0].advance_date}`, meta: done[0] });
  return c.json({ ok: true });
});

/* ── penalties ─────────────────────────────────────────────────────────── */

type PenaltyIn = { date: string; reference: string | null; reason: string; remarks: string | null; lines: { employeeId: number; amountSen: number }[] };
function parsePenalty(raw: Record<string, unknown>): PenaltyIn | string {
  const date = typeof raw.date === "string" ? raw.date : "";
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 300) : "";
  if (!YMD.test(date)) return "Pick the date of the incident.";
  if (!reason) return "Give the reason.";
  const lines = Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]).map((l) => ({ employeeId: Number(l.employeeId), amountSen: Number(l.amountSen) })) : [];
  if (!lines.length) return "Add at least one person.";
  if (lines.some((l) => !Number.isInteger(l.employeeId) || l.employeeId <= 0 || !Number.isInteger(l.amountSen) || l.amountSen <= 0)) return "Each person needs an amount more than RM 0.00.";
  if (new Set(lines.map((l) => l.employeeId)).size !== lines.length) return "A person appears twice.";
  const s = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  return { date, reference: s(raw.reference, 120), reason, remarks: s(raw.remarks, 500), lines };
}

async function nextPenaltyNo(db: Db, companyId: number, date: string): Promise<string> {
  const prefix = `PN-${date.slice(2, 4)}${date.slice(5, 7)}-`;
  const rows = await db.select({ no: hr_penalties.penalty_no }).from(hr_penalties).where(eq(hr_penalties.company_id, companyId));
  const max = rows.reduce((m, r) => (r.no.startsWith(prefix) ? Math.max(m, Number(r.no.slice(prefix.length)) || 0) : m), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

hrPayroll.get("/penalties", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const [heads, lines] = await Promise.all([
    db.select().from(hr_penalties).where(eq(hr_penalties.company_id, co.companyId)).orderBy(desc(hr_penalties.penalty_date), desc(hr_penalties.id)),
    db
      .select({ l: hr_penalty_lines, emp_no: hr_employees.emp_no, name: hr_employees.name })
      .from(hr_penalty_lines)
      .innerJoin(hr_employees, eq(hr_employees.id, hr_penalty_lines.employee_id))
      .where(eq(hr_penalty_lines.company_id, co.companyId)),
  ]);
  const linesBy = new Map<number, typeof lines>();
  for (const l of lines) linesBy.set(l.l.penalty_id, [...(linesBy.get(l.l.penalty_id) ?? []), l]);
  return c.json({
    penalties: heads.map((p) => ({
      id: p.id,
      penaltyNo: p.penalty_no,
      date: p.penalty_date,
      reference: p.reference,
      reason: p.reason,
      remarks: p.remarks,
      status: p.status,
      createdBy: p.created_by,
      createdByName: p.created_by_name,
      approvedByName: p.approved_by_name,
      approvedAt: p.approved_at,
      rejectedReason: p.rejected_reason,
      lines: (linesBy.get(p.id) ?? []).map(({ l, emp_no, name }) => ({ id: l.id, employeeId: l.employee_id, empNo: emp_no, name, amountSen: Number(l.amount_sen), payrollPeriod: l.payroll_period, posted: !!l.posted_at })),
    })),
    me: c.get("user").id,
    canManage: canManage(c),
    canApprove: canApprove(c),
  });
});

hrPayroll.post("/penalties", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = parsePenalty(body);
  if (typeof p === "string") return c.json({ error: "validation_failed", message: p }, 400);
  const db = getDb(c.env);
  const known = await db.select({ id: hr_employees.id }).from(hr_employees).where(and(eq(hr_employees.company_id, co.companyId), inArray(hr_employees.id, p.lines.map((l) => l.employeeId))));
  if (known.length !== p.lines.length) return c.json({ error: "validation_failed", message: "Someone on the penalty isn't in this company." }, 400);
  const u = c.get("user");
  const submit = body.submit === true;
  const [row] = await db
    .insert(hr_penalties)
    .values({
      company_id: co.companyId,
      penalty_no: await nextPenaltyNo(db, co.companyId, p.date),
      penalty_date: p.date,
      reference: p.reference,
      reason: p.reason,
      remarks: p.remarks,
      status: submit ? "PENDING_APPROVAL" : "DRAFT",
      submitted_at: submit ? new Date().toISOString() : null,
      created_by: u.id,
      created_by_name: u.name ?? u.email,
    })
    .returning({ id: hr_penalties.id, no: hr_penalties.penalty_no });
  await db.insert(hr_penalty_lines).values(p.lines.map((l) => ({ company_id: co.companyId, penalty_id: row.id, employee_id: l.employeeId, amount_sen: l.amountSen })));
  await audit(c, { action: "hr.penalty.create", entityType: "hr_penalty", entityId: row.id, summary: `${row.no} ${p.reason}`, meta: p });
  return c.json({ id: row.id, penaltyNo: row.no }, 201);
});

async function loadPenalty(db: Db, companyId: number, id: number) {
  return (await db.select().from(hr_penalties).where(and(eq(hr_penalties.company_id, companyId), eq(hr_penalties.id, id))).limit(1)).at(0);
}

hrPayroll.patch("/penalties/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  const p = parsePenalty((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  if (typeof p === "string") return c.json({ error: "validation_failed", message: p }, 400);
  const db = getDb(c.env);
  const head = await loadPenalty(db, co.companyId, id);
  if (!head) return c.json({ error: "not_found_in_company" }, 404);
  if (head.status !== "DRAFT") return c.json({ error: "not_draft", message: "Only a draft penalty can be changed." }, 409);
  await db.update(hr_penalties).set({ penalty_date: p.date, reference: p.reference, reason: p.reason, remarks: p.remarks, updated_at: new Date().toISOString() }).where(eq(hr_penalties.id, id));
  await db.delete(hr_penalty_lines).where(eq(hr_penalty_lines.penalty_id, id));
  await db.insert(hr_penalty_lines).values(p.lines.map((l) => ({ company_id: co.companyId, penalty_id: id, employee_id: l.employeeId, amount_sen: l.amountSen })));
  await audit(c, { action: "hr.penalty.edit", entityType: "hr_penalty", entityId: id, summary: `${head.penalty_no} edited`, meta: p });
  return c.json({ ok: true });
});

hrPayroll.delete("/penalties/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  const done = await getDb(c.env)
    .delete(hr_penalties)
    .where(and(eq(hr_penalties.company_id, co.companyId), eq(hr_penalties.id, id), eq(hr_penalties.status, "DRAFT")))
    .returning({ no: hr_penalties.penalty_no });
  if (!done.length) return c.json({ error: "not_draft", message: "Only a draft penalty can be removed." }, 409);
  await audit(c, { action: "hr.penalty.delete", entityType: "hr_penalty", entityId: id, summary: `${done[0].no} removed` });
  return c.json({ ok: true });
});

hrPayroll.post("/penalties/:id/:action{submit|approve|reject|revoke}", async (c) => {
  const action = c.req.param("action");
  const approving = action === "approve" || action === "reject" || action === "revoke";
  if (approving ? !canApprove(c) : !canManage(c)) return c.json(approving ? NOT_APPROVER : FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  const db = getDb(c.env);
  const head = await loadPenalty(db, co.companyId, id);
  if (!head) return c.json({ error: "not_found_in_company" }, 404);
  const u = c.get("user");
  const now = new Date().toISOString();
  if (action === "submit") {
    if (head.status !== "DRAFT") return c.json({ error: "bad_state", message: "Only a draft can be submitted." }, 409);
    await db.update(hr_penalties).set({ status: "PENDING_APPROVAL", submitted_at: now, rejected_reason: null, updated_at: now }).where(eq(hr_penalties.id, id));
  } else if (action === "approve") {
    if (head.status !== "PENDING_APPROVAL") return c.json({ error: "bad_state", message: "Only a submitted penalty can be approved." }, 409);
    /* Not your own: the person who raised a penalty does not approve it
       (Hookka; it let SUPER_ADMIN through, Century has no such bypass). */
    if (head.created_by === u.id) return c.json({ error: "own_penalty", message: "Someone other than the person who raised it must approve it." }, 409);
    const period = penaltyPeriod(todayMyt(), await lockedPeriods(db, co.companyId));
    await db.update(hr_penalties).set({ status: "APPROVED", approved_by: u.id, approved_by_name: u.name ?? u.email, approved_at: now, updated_at: now }).where(eq(hr_penalties.id, id));
    await db.update(hr_penalty_lines).set({ payroll_period: period }).where(eq(hr_penalty_lines.penalty_id, id));
  } else if (action === "reject") {
    if (head.status !== "PENDING_APPROVAL") return c.json({ error: "bad_state", message: "Only a submitted penalty can be rejected." }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
    if (!reason) return c.json({ error: "validation_failed", message: "Say why it is rejected." }, 400);
    await db.update(hr_penalties).set({ status: "DRAFT", rejected_reason: reason, updated_at: now }).where(eq(hr_penalties.id, id));
  } else {
    if (head.status !== "APPROVED") return c.json({ error: "bad_state", message: "Only an approved penalty not yet in a payslip can be revoked." }, 409);
    const posted = await db.select({ id: hr_penalty_lines.id }).from(hr_penalty_lines).where(and(eq(hr_penalty_lines.penalty_id, id), isNotNull(hr_penalty_lines.posted_at))).limit(1);
    if (posted.length) return c.json({ error: "posted", message: "Part of it is already in an approved payslip." }, 409);
    await db.update(hr_penalties).set({ status: "DRAFT", approved_by: null, approved_by_name: null, approved_at: null, updated_at: now }).where(eq(hr_penalties.id, id));
    await db.update(hr_penalty_lines).set({ payroll_period: null }).where(eq(hr_penalty_lines.penalty_id, id));
  }
  await audit(c, { action: `hr.penalty.${action}`, entityType: "hr_penalty", entityId: id, summary: `${head.penalty_no} ${action}` });
  return c.json({ ok: true });
});
