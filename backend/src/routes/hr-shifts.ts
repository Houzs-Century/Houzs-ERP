// ----------------------------------------------------------------------------
// hr-shifts — Employees & Attendance > Shifts (HC-0125): the shift groups that
// give each employee their own shift (start/end) for lateness and OT, plus the
// delivery-day shift used when DP sent a warehouse member on a delivery that
// day. An employee is assigned a group in Employee Master; no group falls back
// to the global Pay Rules shift. Mounted on /api/hr behind hr.employees.read /
// .manage.
//
//   GET    /shift-groups                 groups + canManage
//   POST   /shift-groups/seed-default     the three default groups when empty
//   POST   /shift-groups  PATCH|DELETE /shift-groups/:id
//
// Times are minutes from midnight (540 = 09:00).
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { hr_employees, hr_shift_groups } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { hasPermission } from "../services/permissions";
import { audit } from "../services/audit";
import { shiftWindowProblem } from "./lib/hr-shift";
import { loadShiftGroups } from "./lib/hr-shift-store";

type Ctx = Context<{ Bindings: Env }>;

export const hrShifts = new Hono<{ Bindings: Env }>();

const FORBIDDEN = { error: "forbidden", message: "You don't have permission to change HR records." } as const;

function canManage(c: Ctx): boolean {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, "hr.employees.manage");
}
const intParam = (c: Ctx, k: string) => {
  const n = Number(c.req.param(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v: unknown, max = 60) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const intOf = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Local 09:00-17:30 (delivery 08:30-17:00), Foreign worker 09:00-19:00 (delivery
// 08:30-18:30), Driver 08:30-17:00 (no delivery variation).
const DEFAULT_GROUPS = [
  { name: "Local staff", start: 9 * 60, end: 17 * 60 + 30, dStart: 8 * 60 + 30, dEnd: 17 * 60 },
  { name: "Foreign worker", start: 9 * 60, end: 19 * 60, dStart: 8 * 60 + 30, dEnd: 18 * 60 + 30 },
  { name: "Driver", start: 8 * 60 + 30, end: 17 * 60, dStart: null as number | null, dEnd: null as number | null },
];

hrShifts.get("/shift-groups", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const [groups, emps] = await Promise.all([
    loadShiftGroups(db, co.companyId),
    db
      .select({ id: hr_employees.id, emp_no: hr_employees.emp_no, name: hr_employees.name, status: hr_employees.status, shift_group_id: hr_employees.shift_group_id })
      .from(hr_employees)
      .where(eq(hr_employees.company_id, co.companyId))
      .orderBy(asc(hr_employees.emp_no)),
  ]);
  const employees = emps.filter((e) => e.status === "ACTIVE" || e.shift_group_id != null).map((e) => ({ id: e.id, empNo: e.emp_no, name: e.name, shiftGroupId: e.shift_group_id }));
  return c.json({ groups, employees, canManage: canManage(c) });
});

/** Assign (or clear, with null) an employee's shift group. */
hrShifts.put("/employees/:id/shift-group", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const raw = (await readBody(c)).shiftGroupId;
  const groupId = raw === null || raw === undefined || raw === "" ? null : intOf(raw);
  const db = getDb(c.env);
  if (groupId !== null) {
    if (!Number.isFinite(groupId)) return c.json({ error: "bad_group" }, 400);
    const hit = (await db.select({ id: hr_shift_groups.id }).from(hr_shift_groups).where(and(eq(hr_shift_groups.company_id, co.companyId), eq(hr_shift_groups.id, groupId))).limit(1)).at(0);
    if (!hit) return c.json({ error: "not_found_in_company", message: "That shift group is not in this company." }, 404);
  }
  const done = await db
    .update(hr_employees)
    .set({ shift_group_id: groupId, updated_at: new Date().toISOString(), updated_by: c.get("user").id })
    .where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, id)))
    .returning({ id: hr_employees.id });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.employee.shift_group", entityType: "hr_employee", entityId: id, summary: `Shift group set to ${groupId ?? "none"}` });
  return c.json({ ok: true });
});

hrShifts.post("/shift-groups/seed-default", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  if ((await loadShiftGroups(db, co.companyId)).length > 0) return c.json({ error: "not_empty", message: "Shift groups already exist. Edit them instead." }, 409);
  await db.insert(hr_shift_groups).values(
    DEFAULT_GROUPS.map((g, i) => ({
      company_id: co.companyId,
      name: g.name,
      start_min: g.start,
      end_min: g.end,
      delivery_start_min: g.dStart,
      delivery_end_min: g.dEnd,
      sort_order: i,
      created_by: c.get("user").id,
    })),
  );
  await audit(c, { action: "hr.shift_group.seed_default", entityType: "company", entityId: co.companyId, summary: "Loaded the default shift groups" });
  return c.json({ ok: true }, 201);
});

type ShiftInput = { name: string; startMin: number; endMin: number; deliveryStartMin: number | null; deliveryEndMin: number | null; sortOrder: number; active: boolean };

function parseShift(b: Record<string, unknown>): ShiftInput | string {
  const name = str(b.name);
  if (!name) return "Give the shift group a name.";
  const startMin = intOf(b.startMin);
  const endMin = intOf(b.endMin);
  const base = shiftWindowProblem(startMin, endMin);
  if (base) return base;
  const hasDelivery = b.deliveryStartMin !== null && b.deliveryStartMin !== undefined && b.deliveryEndMin !== null && b.deliveryEndMin !== undefined;
  let deliveryStartMin: number | null = null;
  let deliveryEndMin: number | null = null;
  if (hasDelivery) {
    deliveryStartMin = intOf(b.deliveryStartMin);
    deliveryEndMin = intOf(b.deliveryEndMin);
    const dp = shiftWindowProblem(deliveryStartMin, deliveryEndMin);
    if (dp) return `Delivery-day shift: ${dp}`;
  }
  return { name, startMin, endMin, deliveryStartMin, deliveryEndMin, sortOrder: Number.isFinite(intOf(b.sortOrder)) ? intOf(b.sortOrder) : 0, active: b.active !== false };
}

hrShifts.post("/shift-groups", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const s = parseShift(await readBody(c));
  if (typeof s === "string") return c.json({ error: "validation_failed", message: s }, 400);
  const db = getDb(c.env);
  const [row] = await db
    .insert(hr_shift_groups)
    .values({ company_id: co.companyId, name: s.name, start_min: s.startMin, end_min: s.endMin, delivery_start_min: s.deliveryStartMin, delivery_end_min: s.deliveryEndMin, sort_order: s.sortOrder, active: s.active, created_by: c.get("user").id })
    .returning({ id: hr_shift_groups.id });
  await audit(c, { action: "hr.shift_group.create", entityType: "hr_shift_group", entityId: row.id, summary: `Shift group ${s.name}` });
  return c.json({ id: row.id }, 201);
});

hrShifts.patch("/shift-groups/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const s = parseShift(await readBody(c));
  if (typeof s === "string") return c.json({ error: "validation_failed", message: s }, 400);
  const db = getDb(c.env);
  const done = await db
    .update(hr_shift_groups)
    .set({ name: s.name, start_min: s.startMin, end_min: s.endMin, delivery_start_min: s.deliveryStartMin, delivery_end_min: s.deliveryEndMin, sort_order: s.sortOrder, active: s.active, updated_at: new Date().toISOString() })
    .where(and(eq(hr_shift_groups.company_id, co.companyId), eq(hr_shift_groups.id, id)))
    .returning({ id: hr_shift_groups.id });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.shift_group.edit", entityType: "hr_shift_group", entityId: id, summary: `Shift group ${s.name}` });
  return c.json({ ok: true });
});

hrShifts.delete("/shift-groups/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const done = await db.delete(hr_shift_groups).where(and(eq(hr_shift_groups.company_id, co.companyId), eq(hr_shift_groups.id, id))).returning({ id: hr_shift_groups.id });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.shift_group.remove", entityType: "hr_shift_group", entityId: id, summary: `Shift group ${id} removed` });
  return c.json({ ok: true });
});
