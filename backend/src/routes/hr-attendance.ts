// ----------------------------------------------------------------------------
// hr-attendance — Employees & Attendance > Attendance and Punch Sites
// (HC-0125 phase 2). Mounted on /api/hr beside routes/hr.ts, behind the same
// hr.employees.read / .manage gate in index.ts; writes check manage here.
//
//   GET    /attendance?date=YYYY-MM-DD   every active employee with that day
//   PUT    /attendance                   HR sets or corrects a day (times, status, note)
//   DELETE /attendance/:id               remove a day
//   GET    /attendance/:id/photo?which=  a punch selfie
//   GET    /punch-sites   POST /punch-sites   PATCH /punch-sites/:id
//
// Hookka's tab only showed phone punches; Century's lists everyone active, so
// "not punched yet" is visible, and HR can key a forgotten punch or a leave
// day (Hookka needed a separate POST for that and had no edit).
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { departments, hr_attendance, hr_employees, hr_punch_sites, hr_working_hours } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { hasPermission } from "../services/permissions";
import { audit } from "../services/audit";
import { ATTENDANCE_STATUSES, instantOnWorkDate, type AttendanceStatus } from "../scm/shared/hr-attendance";
import { asDate, attendanceView, correctionTimes, type AttendanceRow } from "./lib/hr-attendance-view";
import { loadSites, rulesResolver } from "./lib/hr-attendance-store";
import { applyDayDock, closeForgottenAndSync, syncDayFromPunch } from "./lib/hr-labor-store";

type Ctx = Context<{ Bindings: Env }>;

export const hrAttendance = new Hono<{ Bindings: Env }>();

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN = { error: "forbidden", message: "You don't have permission to change HR records." } as const;

function canManage(c: Ctx): boolean {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, "hr.employees.manage");
}

/* ── attendance ────────────────────────────────────────────────────────── */

hrAttendance.get("/attendance", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const date = c.req.query("date") ?? todayMyt();
  if (!YMD.test(date)) return c.json({ error: "bad_date", message: "Pick a date." }, 400);
  const db = getDb(c.env);
  const now = new Date();
  await closeForgottenAndSync(db, co.companyId, null, now);
  const [rows, employees, rulesFor, sites] = await Promise.all([
    db.select().from(hr_attendance).where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.work_date, date))),
    db
      .select({
        id: hr_employees.id,
        emp_no: hr_employees.emp_no,
        name: hr_employees.name,
        position: hr_employees.position,
        status: hr_employees.status,
        user_id: hr_employees.user_id,
        department: departments.name,
      })
      .from(hr_employees)
      .leftJoin(departments, eq(departments.id, hr_employees.department_id))
      .where(eq(hr_employees.company_id, co.companyId))
      .orderBy(asc(hr_employees.emp_no)),
    rulesResolver(db, co.companyId),
    loadSites(db, co.companyId),
  ]);
  const byEmployee = new Map(rows.map((r) => [r.employee_id, r]));
  const rules = rulesFor(date);
  const list = employees
    .filter((e) => e.status === "ACTIVE" || byEmployee.has(e.id))
    .map((e) => {
      const r = byEmployee.get(e.id);
      return {
        employee: { id: e.id, empNo: e.emp_no, name: e.name, position: e.position ?? "", department: e.department ?? null, linked: e.user_id != null, status: e.status },
        day: r ? attendanceView(r as AttendanceRow, rules, sites.names, now) : null,
      };
    });
  return c.json({
    date,
    today: todayMyt(),
    shift: { startMin: rules.startMin, endMin: rules.endMin, lateGraceMin: rules.lateGraceMin },
    rows: list,
    sitesConfigured: sites.active.length,
    canManage: canManage(c),
  });
});

hrAttendance.put("/attendance", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const employeeId = Number(body.employeeId);
  const date = typeof body.date === "string" ? body.date : "";
  const status = (ATTENDANCE_STATUSES.map((s) => s.value) as string[]).includes(String(body.status)) ? (body.status as AttendanceStatus) : null;
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;
  if (!Number.isInteger(employeeId) || employeeId <= 0) return c.json({ error: "validation_failed", message: "Pick the employee." }, 400);
  if (!status) return c.json({ error: "validation_failed", message: "Pick a status." }, 400);
  const times = correctionTimes(date, typeof body.clockIn === "string" ? body.clockIn : "", typeof body.clockOut === "string" ? body.clockOut : "");
  if (!times.ok) return c.json({ error: "validation_failed", message: times.message }, 400);
  if (status === "PRESENT" && times.inMin == null) return c.json({ error: "validation_failed", message: "Present needs a clock-in time." }, 400);
  if (date > todayMyt()) return c.json({ error: "validation_failed", message: "That date has not happened yet." }, 400);

  const db = getDb(c.env);
  const emp = (
    await db
      .select({ id: hr_employees.id, emp_no: hr_employees.emp_no })
      .from(hr_employees)
      .where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, employeeId)))
      .limit(1)
  ).at(0);
  if (!emp) return c.json({ error: "not_found_in_company", message: "That employee isn't in the company you're working in." }, 404);
  const existing = (
    await db
      .select()
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.employee_id, employeeId), eq(hr_attendance.work_date, date)))
      .limit(1)
  ).at(0);
  const inAt = times.inMin != null ? instantOnWorkDate(date, times.inMin).toISOString() : null;
  const outAt = times.outMin != null ? instantOnWorkDate(date, times.outMin).toISOString() : null;
  const same = (a: string | null, b: string | null) => (a && b ? asDate(a).getTime() === new Date(b).getTime() : a === b);
  const by = c.get("user").id;
  const now = new Date().toISOString();
  /* A phone punch HR leaves untouched keeps its source, selfie and GPS; a
     time HR changes becomes MANUAL, and the evidence of the phone punch it
     replaced stays on the row for the record. */
  const values = {
    status,
    clock_in_at: inAt,
    clock_out_at: outAt,
    in_source: inAt == null ? null : existing && same(existing.clock_in_at, inAt) ? existing.in_source : "MANUAL",
    out_source: outAt == null ? null : existing && same(existing.clock_out_at, outAt) ? existing.out_source : "MANUAL",
    notes,
    updated_at: now,
    updated_by: by,
  };
  const attendanceId = existing
    ? (await db.update(hr_attendance).set(values).where(eq(hr_attendance.id, existing.id)).returning({ id: hr_attendance.id }))[0].id
    : (await db.insert(hr_attendance).values({ ...values, company_id: co.companyId, employee_id: employeeId, work_date: date }).returning({ id: hr_attendance.id }))[0].id;
  /* The day's Working Hours follow the corrected punch; a day with no times
     (leave, absent) loses its AUTO hours and so its dock. HR-typed hours stay. */
  if (inAt && outAt) {
    await syncDayFromPunch(db, co.companyId, attendanceId);
  } else {
    await db.delete(hr_working_hours).where(and(eq(hr_working_hours.attendance_id, attendanceId), eq(hr_working_hours.source, "AUTO")));
    await applyDayDock(db, co.companyId, employeeId, date, 0, "");
  }
  await audit(c, {
    action: "hr.attendance.set",
    entityType: "hr_employee",
    entityId: employeeId,
    summary: `${emp.emp_no} ${date}: ${status}${inAt ? ` ${String(body.clockIn)}` : ""}${outAt ? ` to ${String(body.clockOut)}` : ""}`,
    meta: { before: existing ? { status: existing.status, clock_in_at: existing.clock_in_at, clock_out_at: existing.clock_out_at, notes: existing.notes } : null },
  });
  return c.json({ ok: true });
});

hrAttendance.delete("/attendance/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const done = await getDb(c.env)
    .delete(hr_attendance)
    .where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.id, id)))
    .returning({ employee_id: hr_attendance.employee_id, work_date: hr_attendance.work_date, clock_in_at: hr_attendance.clock_in_at, clock_out_at: hr_attendance.clock_out_at });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await applyDayDock(getDb(c.env), co.companyId, done[0].employee_id, done[0].work_date, 0, "");
  await audit(c, { action: "hr.attendance.delete", entityType: "hr_employee", entityId: done[0].employee_id, summary: `Removed attendance ${done[0].work_date}`, meta: done[0] });
  return c.json({ ok: true });
});

hrAttendance.get("/attendance/:id/photo", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const row = (
    await getDb(c.env)
      .select({ in_photo_key: hr_attendance.in_photo_key, out_photo_key: hr_attendance.out_photo_key })
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.id, id)))
      .limit(1)
  ).at(0);
  const key = (c.req.query("which") === "out" ? row?.out_photo_key : row?.in_photo_key) ?? null;
  const obj = key ? await c.env.POD_BUCKET.get(key) : null;
  if (!obj) return c.json({ error: "not_found", message: "No photo for that punch." }, 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "image/jpeg", "cache-control": "private, max-age=300" } });
});

/* ── punch sites ───────────────────────────────────────────────────────── */

type SiteInput = { name: string; lat: number; lng: number; radiusM: number; active: boolean };

function parseSite(raw: unknown): SiteInput | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 80) : "";
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  const radiusM = r.radiusM === undefined || r.radiusM === "" ? 200 : Number(r.radiusM);
  if (!name) return "Give the site a name.";
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return "Latitude and longitude are numbers, e.g. 3.0738, 101.5183.";
  if (!Number.isInteger(radiusM) || radiusM < 20 || radiusM > 5000) return "Radius is a whole number of metres from 20 to 5000.";
  return { name, lat, lng, radiusM, active: r.active !== false };
}

hrAttendance.get("/punch-sites", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rows = await getDb(c.env).select().from(hr_punch_sites).where(eq(hr_punch_sites.company_id, co.companyId)).orderBy(asc(hr_punch_sites.name));
  return c.json({ sites: rows.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, radiusM: r.radius_m, active: r.active })), canManage: canManage(c) });
});

hrAttendance.post("/punch-sites", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const site = parseSite(await c.req.json().catch(() => ({})));
  if (typeof site === "string") return c.json({ error: "validation_failed", message: site }, 400);
  const by = c.get("user").id;
  const [row] = await getDb(c.env)
    .insert(hr_punch_sites)
    .values({ company_id: co.companyId, name: site.name, lat: site.lat, lng: site.lng, radius_m: site.radiusM, active: site.active, created_by: by, updated_by: by })
    .returning({ id: hr_punch_sites.id });
  await audit(c, { action: "hr.punch_site.create", entityType: "hr_punch_site", entityId: row.id, summary: `Punch site ${site.name}`, meta: site });
  return c.json({ id: row.id }, 201);
});

hrAttendance.patch("/punch-sites/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const site = parseSite(await c.req.json().catch(() => ({})));
  if (typeof site === "string") return c.json({ error: "validation_failed", message: site }, 400);
  const done = await getDb(c.env)
    .update(hr_punch_sites)
    .set({ name: site.name, lat: site.lat, lng: site.lng, radius_m: site.radiusM, active: site.active, updated_by: c.get("user").id, updated_at: new Date().toISOString() })
    .where(and(eq(hr_punch_sites.company_id, co.companyId), eq(hr_punch_sites.id, id)))
    .returning({ id: hr_punch_sites.id });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.punch_site.update", entityType: "hr_punch_site", entityId: id, summary: `Punch site ${site.name}`, meta: site });
  return c.json({ ok: true });
});
