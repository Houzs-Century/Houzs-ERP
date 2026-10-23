// ----------------------------------------------------------------------------
// attendance — the phone punch clock (HC-0125 phase 2), ported from Hookka's
// POST /api/worker/clock. Drivers and warehouse crew punch with their own ERP
// account (Nico: option B), so this is NOT behind the hr.employees.* keys:
// any signed-in caller may use it, and every route answers only for the
// ACTIVE employee row linked to that account in the active company.
//
//   GET  /me                      my employee, today, an open punch, last 14 days
//   POST /punch                   multipart: action, lat, lng, accuracy, photo
//   GET  /me/photo/:id?which=in   my own selfie back
//   GET  /me/pay                  My pay: this month so far, and approved payslips
//   GET  /me/payslip/:period      one approved or paid payslip
//
// The selfie and GPS are evidence, not gates (as in Hookka): a punch with no
// photo or no location still records, and HR sees which.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { hr_attendance, hr_employees, hr_payslips } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { checkPunchLocation } from "../scm/shared/hr-attendance";
import { attendanceView, planPunch, type AttendanceRow } from "./lib/hr-attendance-view";
import { loadSites, rulesResolver } from "./lib/hr-attendance-store";
import { closeForgottenAndSync, syncDayFromPunch } from "./lib/hr-labor-store";
import { computePeriod } from "./lib/hr-payroll-store";
import { slipOut, type SlipRow } from "./hr-payroll";

type Ctx = Context<{ Bindings: Env }>;
type Db = ReturnType<typeof getDb>;

export const attendance = new Hono<{ Bindings: Env }>();

const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const NOT_LINKED = {
  error: "not_linked",
  message: "Your account is not linked to an employee yet. Ask HR to link it in Employees & Attendance.",
} as const;

async function myEmployee(db: Db, companyId: number, userId: number) {
  const rows = await db
    .select({ id: hr_employees.id, emp_no: hr_employees.emp_no, name: hr_employees.name, status: hr_employees.status })
    .from(hr_employees)
    .where(and(eq(hr_employees.company_id, companyId), eq(hr_employees.user_id, userId)))
    .limit(1);
  return rows.at(0);
}

async function openPunch(db: Db, companyId: number, employeeId: number) {
  const rows = await db
    .select()
    .from(hr_attendance)
    .where(and(eq(hr_attendance.company_id, companyId), eq(hr_attendance.employee_id, employeeId), isNotNull(hr_attendance.clock_in_at), isNull(hr_attendance.clock_out_at)))
    .orderBy(desc(hr_attendance.clock_in_at))
    .limit(1);
  return rows.at(0);
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

attendance.get("/me", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  if (!emp || emp.status !== "ACTIVE") return c.json({ linked: false });
  const now = new Date();
  await closeForgottenAndSync(db, co.companyId, emp.id, now);
  const since = todayMyt(-13);
  const [rows, rulesFor, sites] = await Promise.all([
    db
      .select()
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.employee_id, emp.id), gte(hr_attendance.work_date, since)))
      .orderBy(desc(hr_attendance.work_date)),
    rulesResolver(db, co.companyId),
    loadSites(db, co.companyId),
  ]);
  const views = rows.map((r) => attendanceView(r as AttendanceRow, rulesFor(r.work_date), sites.names, now));
  const today = todayMyt();
  const shift = rulesFor(today);
  return c.json({
    linked: true,
    employee: { empNo: emp.emp_no, name: emp.name },
    today,
    shift: { startMin: shift.startMin, endMin: shift.endMin },
    open: views.find((v) => v.open) ?? null,
    todayDay: views.find((v) => v.workDate === today) ?? null,
    recent: views,
    sitesConfigured: sites.active.length,
  });
});

attendance.post("/punch", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const userId = c.get("user").id;
  const emp = await myEmployee(db, co.companyId, userId);
  if (!emp) return c.json(NOT_LINKED, 403);
  if (emp.status !== "ACTIVE") return c.json({ error: "not_active", message: "Your employee record is not active. Ask HR." }, 403);

  let form: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json({ error: "bad_body", message: "The punch did not arrive. Please tap again." }, 400);
  }
  const action = form.action === "CLOCK_IN" || form.action === "CLOCK_OUT" ? form.action : null;
  if (!action) return c.json({ error: "bad_action", message: "Clock in or clock out?" }, 400);
  const lat = num(form.lat);
  const lng = num(form.lng);
  const hasGps = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const accuracy = num(form.accuracy);
  const photo = form.photo instanceof File && form.photo.size > 0 ? form.photo : null;
  if (photo && (!PHOTO_TYPES[photo.type] || photo.size > PHOTO_MAX_BYTES)) {
    return c.json({ error: "bad_photo", message: "The photo must be a JPEG, PNG or WebP under 2 MB." }, 400);
  }

  const now = new Date();
  const today = todayMyt();
  await closeForgottenAndSync(db, co.companyId, emp.id, now);
  const [todayRow, open] = await Promise.all([
    db
      .select()
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.employee_id, emp.id), eq(hr_attendance.work_date, today)))
      .limit(1)
      .then((r) => r.at(0)),
    openPunch(db, co.companyId, emp.id),
  ]);
  const plan = planPunch(action, todayRow ?? null, open ?? null);
  if (plan.kind === "already-out") {
    return c.json({ error: "already_out", message: `You already clocked out today at ${plan.clock}. Ask HR if that is wrong.` }, 409);
  }
  if (plan.kind === "no-open-punch") {
    return c.json({ error: "not_clocked_in", message: "You have not clocked in today, so there is nothing to clock out." }, 409);
  }

  const sites = await loadSites(db, co.companyId);
  const loc = checkPunchLocation(hasGps ? lat : null, hasGps ? lng : null, sites.active);
  let photoKey: string | null = null;
  if (photo && plan.kind !== "already-in") {
    photoKey = `hr-punch/${co.companyId}/${emp.id}/${today}-${action === "CLOCK_IN" ? "in" : "out"}-${crypto.randomUUID().slice(0, 8)}.${PHOTO_TYPES[photo.type]}`;
    await c.env.POD_BUCKET.put(photoKey, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } });
  }
  const at = now.toISOString();
  const evidence =
    action === "CLOCK_IN"
      ? { in_lat: hasGps ? lat : null, in_lng: hasGps ? lng : null, in_accuracy_m: accuracy != null ? Math.round(accuracy) : null, in_geo: loc.geo, in_site_id: loc.siteId, in_distance_m: loc.distanceM, in_photo_key: photoKey }
      : { out_lat: hasGps ? lat : null, out_lng: hasGps ? lng : null, out_accuracy_m: accuracy != null ? Math.round(accuracy) : null, out_geo: loc.geo, out_site_id: loc.siteId, out_distance_m: loc.distanceM, out_photo_key: photoKey };

  if (plan.kind === "insert") {
    try {
      await db.insert(hr_attendance).values({
        company_id: co.companyId,
        employee_id: emp.id,
        work_date: today,
        status: "PRESENT",
        clock_in_at: at,
        in_source: "PHONE",
        ...evidence,
        updated_by: userId,
      });
    } catch (e) {
      /* Two taps racing: the unique (employee, work date) row already exists,
         and the second tap is the no-op it would have been a second later. */
      if ((e as { code?: string } | null)?.code !== "23505" && !String((e as Error | null)?.message ?? "").includes("duplicate key")) throw e;
    }
  } else if (plan.kind === "stamp-in") {
    await db
      .update(hr_attendance)
      .set({ status: "PRESENT", clock_in_at: at, in_source: "PHONE", ...evidence, updated_at: at, updated_by: userId })
      .where(and(eq(hr_attendance.id, plan.rowId), isNull(hr_attendance.clock_in_at)));
  } else if (plan.kind === "stamp-out") {
    await db
      .update(hr_attendance)
      .set({ clock_out_at: at, out_source: "PHONE", ...evidence, updated_at: at, updated_by: userId })
      .where(and(eq(hr_attendance.id, plan.rowId), isNull(hr_attendance.clock_out_at)));
    await syncDayFromPunch(db, co.companyId, plan.rowId);
  }

  return c.json({
    ok: true,
    action,
    already: plan.kind === "already-in",
    location: { geo: loc.geo, siteName: loc.siteName, distanceM: loc.distanceM },
    photoSaved: !!photoKey,
  });
});

attendance.get("/me/photo/:id", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  if (!emp) return c.json(NOT_LINKED, 403);
  const row = (
    await db
      .select({ in_photo_key: hr_attendance.in_photo_key, out_photo_key: hr_attendance.out_photo_key })
      .from(hr_attendance)
      .where(and(eq(hr_attendance.id, id), eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.employee_id, emp.id)))
      .limit(1)
  ).at(0);
  const key = (c.req.query("which") === "out" ? row?.out_photo_key : row?.in_photo_key) ?? null;
  if (!key) return c.json({ error: "not_found", message: "No photo for that punch." }, 404);
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "not_found", message: "No photo for that punch." }, 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "image/jpeg", "cache-control": "private, max-age=300" } });
});

/* My pay (Hookka's worker pay screen): this month's running estimate (the
   same pipeline as Generate, nothing stored) and the slips HR has approved.
   A draft slip is not shown: the figures can still change. */
attendance.get("/me/pay", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  if (!emp) return c.json({ linked: false });
  const today = todayMyt();
  const period = today.slice(0, 7);
  const own = await db
    .select()
    .from(hr_payslips)
    .where(and(eq(hr_payslips.company_id, co.companyId), eq(hr_payslips.employee_id, emp.id), inArray(hr_payslips.status, ["APPROVED", "PAID"])))
    .orderBy(desc(hr_payslips.period))
    .limit(12);
  const currentFinal = own.find((s) => s.period === period);
  const estimate = currentFinal ? null : (await computePeriod(db, co.companyId, period, today, emp.id)).at(0) ?? null;
  return c.json({
    linked: true,
    employee: { empNo: emp.emp_no, name: emp.name },
    period,
    estimate: estimate && {
      period,
      fullSalarySen: estimate.pay.fullSalarySen,
      daysWorked: estimate.pay.daysWorked,
      absentDays: estimate.pay.absentDays,
      absentDates: estimate.pay.absentDates,
      absenceDeductionSen: estimate.pay.absenceDeductionSen,
      shortHours: estimate.pay.shortHours,
      shortHourDeductionSen: estimate.pay.shortHourDeductionSen,
      otPaySen: estimate.pay.otPaySen,
      otDays: estimate.pay.otDays,
      commissionSen: estimate.commissionSen,
      tripAllowanceSen: estimate.tripAllowanceSen,
      tripLines: estimate.trip?.lines.map((l) => ({ label: l.label, count: l.count, amountSen: l.amountSen })) ?? [],
      allowances: estimate.allowanceLines.filter((l) => l.kind !== "BACKPAY").map((l) => ({ label: l.label, amountSen: l.amountSen })),
      grossSen: estimate.grossSen,
      statutoryEmployeeSen: estimate.statutoryEmployeeSen,
      pcbKnown: estimate.pcbStatus !== "UNKNOWN",
      advanceSen: estimate.advanceSen,
      backpaySen: estimate.backpaySen,
      penaltySen: estimate.penaltySen,
      netSen: estimate.netSen,
    },
    payslips: own.map((s) => ({ period: s.period, status: s.status, grossSen: Number(s.gross_sen), netSen: Number(s.net_sen) })),
  });
});

attendance.get("/me/payslip/:period", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  if (!emp) return c.json(NOT_LINKED, 403);
  const row = (
    await db
      .select()
      .from(hr_payslips)
      .where(and(eq(hr_payslips.company_id, co.companyId), eq(hr_payslips.employee_id, emp.id), eq(hr_payslips.period, c.req.param("period")), inArray(hr_payslips.status, ["APPROVED", "PAID"])))
      .limit(1)
  ).at(0);
  if (!row) return c.json({ error: "not_found", message: "That payslip is not approved yet." }, 404);
  return c.json({ slip: slipOut(row as SlipRow) });
});
