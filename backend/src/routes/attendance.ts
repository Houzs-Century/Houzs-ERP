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
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { hr_attendance, hr_employees, hr_leave_requests, hr_ot_claims, hr_punch_corrections, hr_payslips, hr_working_hours } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { hasPermission } from "../services/permissions";
import { checkPunchLocation, instantOnWorkDate } from "../scm/shared/hr-attendance";
import { attendanceView, planPunch, punchGateRefusal, type AttendanceRow } from "./lib/hr-attendance-view";
import { loadSites, loadAttendanceSettings } from "./lib/hr-attendance-store";
import { parseOtSegment } from "./lib/hr-ot";
import { parsePunchFix } from "./lib/hr-punch";
import { APPLICABLE_LEAVE_TYPES, parseLeaveRequest } from "./lib/hr-leave";
import { scopedEmployeeIds } from "./lib/hr-confirmer-scope";
import { shiftRulesResolver } from "./lib/hr-shift-store";
import { applyDayDock, closeForgottenAndSync, syncDayFromPunch } from "./lib/hr-labor-store";
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
  const [rows, shiftRes, sites] = await Promise.all([
    db
      .select()
      .from(hr_attendance)
      .where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.employee_id, emp.id), gte(hr_attendance.work_date, since)))
      .orderBy(desc(hr_attendance.work_date)),
    shiftRulesResolver(db, co.companyId, since, todayMyt()),
    loadSites(db, co.companyId),
  ]);
  const views = rows.map((r) => attendanceView(r as AttendanceRow, shiftRes.rulesFor(r.work_date, emp.id), sites.names, now));
  const today = todayMyt();
  const shift = shiftRes.rulesFor(today, emp.id);
  return c.json({
    linked: true,
    employee: { empNo: emp.emp_no, name: emp.name },
    today,
    shift: { startMin: shift.startMin, endMin: shift.endMin },
    open: views.find((v) => v.open) ?? null,
    todayDay: views.find((v) => v.workDate === today) ?? null,
    recent: views,
    sitesConfigured: sites.active.length,
    // Active sites' coordinates so the phone can show the live distance to the
    // nearest one before a punch (HC-0125; needed once require_on_site is on).
    sites: sites.active,
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

  const [sites, settings] = await Promise.all([loadSites(db, co.companyId), loadAttendanceSettings(db, co.companyId)]);
  const loc = checkPunchLocation(hasGps ? lat : null, hasGps ? lng : null, sites.active);
  /* HC-0125 punch gates: when HR turns a gate on, a recording punch is REFUSED
     (hard block) unless it carries a selfie / is within a site. */
  const refusal = punchGateRefusal(settings, plan.kind, !!photo, loc);
  if (refusal) return c.json(refusal, 422);
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

// ── Overtime claims (HC-0125) ────────────────────────────────────────────────
// A worker reports OT as one or more windows on a work date; a supervisor with
// hr.ot.confirm confirms or rejects. Confirmed OT is what payroll pays (a punch
// past the shift end no longer auto-grants OT). Account-based like /punch; only
// review is gated, in-handler, so a floor supervisor needs just hr.ot.confirm.
type OtRow = { id: number; work_date: string; start_min: number; end_min: number; note: string; status: string; source: string; reject_reason: string | null };
const otOut = (r: OtRow) => ({ id: r.id, workDate: r.work_date, startMin: r.start_min, endMin: r.end_min, note: r.note, status: r.status, source: r.source, rejectReason: r.reject_reason });
const canConfirmOt = (c: Ctx): boolean => {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, "hr.ot.confirm");
};
// A confirmer pinned to specific employees (hr-confirmer-scope) only ever sees
// or reviews their own; an unrestricted confirmer gets `undefined` here, which
// drizzle's and() drops, so the query is company-wide as before.
const otScopeCond = (c: Ctx) => {
  const scope = scopedEmployeeIds(c.get("user").id);
  return scope ? inArray(hr_ot_claims.employee_id, [...scope]) : undefined;
};

attendance.get("/ot", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const canConfirm = canConfirmOt(c);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  const since = todayMyt(-45);
  const mine = emp
    ? (
        await db
          .select()
          .from(hr_ot_claims)
          .where(and(eq(hr_ot_claims.company_id, co.companyId), eq(hr_ot_claims.employee_id, emp.id), gte(hr_ot_claims.work_date, since)))
          .orderBy(desc(hr_ot_claims.work_date), desc(hr_ot_claims.id))
      ).map(otOut)
    : [];
  let pending: Array<ReturnType<typeof otOut> & { employeeName: string; empNo: string }> = [];
  if (canConfirm) {
    const rows = await db
      .select({ c: hr_ot_claims, name: hr_employees.name, emp_no: hr_employees.emp_no })
      .from(hr_ot_claims)
      .innerJoin(hr_employees, eq(hr_employees.id, hr_ot_claims.employee_id))
      .where(and(eq(hr_ot_claims.company_id, co.companyId), eq(hr_ot_claims.status, "PENDING"), otScopeCond(c)))
      .orderBy(asc(hr_ot_claims.work_date), asc(hr_ot_claims.id));
    pending = rows.map((r) => ({ ...otOut(r.c), employeeName: r.name, empNo: r.emp_no }));
  }
  return c.json({ canConfirm, mine, pending });
});

/* Desktop month view (HC-0125): every OT claim in a month across the company,
   any status, so HR confirms on the computer and can review a whole month at
   once. Same hr.ot.confirm gate as the phone's review; company-scoped. */
attendance.get("/ot/admin", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!canConfirmOt(c)) return c.json({ error: "forbidden", message: "You cannot review overtime." }, 403);
  const month = c.req.query("month") ?? todayMyt().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "bad_month", message: "Pick a month as YYYY-MM." }, 400);
  const db = getDb(c.env);
  const rows = await db
    .select({ c: hr_ot_claims, name: hr_employees.name, emp_no: hr_employees.emp_no })
    .from(hr_ot_claims)
    .innerJoin(hr_employees, eq(hr_employees.id, hr_ot_claims.employee_id))
    .where(and(eq(hr_ot_claims.company_id, co.companyId), gte(hr_ot_claims.work_date, `${month}-01`), lte(hr_ot_claims.work_date, `${month}-31`), otScopeCond(c)))
    .orderBy(asc(hr_ot_claims.work_date), asc(hr_ot_claims.id));
  const claims = rows.map((r) => ({ ...otOut(r.c), employeeName: r.name, empNo: r.emp_no, reviewedAt: r.c.reviewed_at ?? null }));
  return c.json({ month, claims });
});

attendance.post("/ot", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const userId = c.get("user").id;
  const emp = await myEmployee(db, co.companyId, userId);
  if (!emp) return c.json(NOT_LINKED, 403);
  if (emp.status !== "ACTIVE") return c.json({ error: "not_active", message: "Your employee record is not active. Ask HR." }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const workDate = typeof body.workDate === "string" ? body.workDate : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return c.json({ error: "bad_date", message: "Pick the day the overtime was on." }, 400);
  const seg = parseOtSegment(String(body.startHHMM ?? ""), String(body.endHHMM ?? ""));
  if (!seg.ok) return c.json({ error: "bad_segment", message: seg.message }, 400);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  /* A reported window and the punch-derived AUTO claim must never both pay for
     one day. The AUTO claim is removed below; but if a supervisor already
     CONFIRMED it, the day's overtime is settled — refuse the report and send
     the worker to HR rather than silently voiding an approved figure. */
  const confirmedAuto = (
    await db
      .select({ id: hr_ot_claims.id })
      .from(hr_ot_claims)
      .where(and(eq(hr_ot_claims.company_id, co.companyId), eq(hr_ot_claims.employee_id, emp.id), eq(hr_ot_claims.work_date, workDate), eq(hr_ot_claims.source, "AUTO"), eq(hr_ot_claims.status, "CONFIRMED")))
      .limit(1)
  ).at(0);
  if (confirmedAuto) return c.json({ error: "ot_already_confirmed", message: "Overtime for that day is already confirmed from your punch. Ask HR to adjust it." }, 409);
  const [row] = await db
    .insert(hr_ot_claims)
    .values({ company_id: co.companyId, employee_id: emp.id, work_date: workDate, start_min: seg.startMin, end_min: seg.endMin, note, status: "PENDING", source: "REPORTED", created_by: userId })
    .returning({ id: hr_ot_claims.id });
  /* A reported window is the precise record for the day, so the crude punch-
     derived AUTO claim steps aside — removed here too (not only on the next
     punch sync) so the two never both reach a supervisor for one day. */
  await db
    .delete(hr_ot_claims)
    .where(and(eq(hr_ot_claims.company_id, co.companyId), eq(hr_ot_claims.employee_id, emp.id), eq(hr_ot_claims.work_date, workDate), eq(hr_ot_claims.source, "AUTO"), eq(hr_ot_claims.status, "PENDING")));
  return c.json({ id: row.id }, 201);
});

attendance.delete("/ot/:id", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  if (!emp) return c.json(NOT_LINKED, 403);
  const done = await db
    .delete(hr_ot_claims)
    .where(and(eq(hr_ot_claims.id, id), eq(hr_ot_claims.company_id, co.companyId), eq(hr_ot_claims.employee_id, emp.id), eq(hr_ot_claims.status, "PENDING")))
    .returning({ id: hr_ot_claims.id });
  if (!done.length) return c.json({ error: "not_found", message: "That overtime is gone or already reviewed." }, 404);
  return c.json({ ok: true });
});

attendance.post("/ot/:id/review", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!canConfirmOt(c)) return c.json({ error: "forbidden", message: "You cannot confirm overtime." }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const decision = body.decision === "confirm" || body.decision === "reject" ? body.decision : null;
  if (!decision) return c.json({ error: "bad_decision", message: "Confirm or reject the overtime?" }, 400);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  const at = new Date().toISOString();
  const done = await getDb(c.env)
    .update(hr_ot_claims)
    .set({
      status: decision === "confirm" ? "CONFIRMED" : "REJECTED",
      reject_reason: decision === "reject" ? reason || null : null,
      reviewed_by: c.get("user").id,
      reviewed_at: at,
      updated_at: at,
    })
    .where(and(eq(hr_ot_claims.id, id), eq(hr_ot_claims.company_id, co.companyId), eq(hr_ot_claims.status, "PENDING"), otScopeCond(c)))
    .returning({ id: hr_ot_claims.id });
  if (!done.length) return c.json({ error: "not_found", message: "That overtime is gone or already reviewed." }, 404);
  return c.json({ ok: true });
});

/* ── make-up punch (补卡) ──────────────────────────────────────────────────
   A worker who forgot to clock in or out files the in and out time they worked
   on a past date plus a reason; a supervisor with hr.punch.approve approves or
   rejects. An approval writes that day's attendance exactly as an HR correction
   does — status PRESENT, the stated times, MANUAL source, working hours
   re-synced. Account-based like /punch; only the review is gated, in-handler,
   so a floor supervisor needs just hr.punch.approve. */
const canApprovePunch = (c: Ctx): boolean => {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, "hr.punch.approve");
};

type PcRow = { id: number; work_date: string; req_in_min: number | null; req_out_min: number | null; reason: string; status: string; reject_reason: string | null };
const pcOut = (r: PcRow) => ({ id: r.id, workDate: r.work_date, reqInMin: r.req_in_min, reqOutMin: r.req_out_min, reason: r.reason, status: r.status, rejectReason: r.reject_reason });

attendance.get("/punch-fix", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const canApprove = canApprovePunch(c);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  const since = todayMyt(-60);
  const mine = emp
    ? (
        await db
          .select()
          .from(hr_punch_corrections)
          .where(and(eq(hr_punch_corrections.company_id, co.companyId), eq(hr_punch_corrections.employee_id, emp.id), gte(hr_punch_corrections.work_date, since)))
          .orderBy(desc(hr_punch_corrections.work_date), desc(hr_punch_corrections.id))
      ).map((r) => pcOut(r as PcRow))
    : [];
  let pending: Array<ReturnType<typeof pcOut> & { employeeName: string; empNo: string }> = [];
  if (canApprove) {
    const rows = await db
      .select({ c: hr_punch_corrections, name: hr_employees.name, emp_no: hr_employees.emp_no })
      .from(hr_punch_corrections)
      .innerJoin(hr_employees, eq(hr_employees.id, hr_punch_corrections.employee_id))
      .where(and(eq(hr_punch_corrections.company_id, co.companyId), eq(hr_punch_corrections.status, "PENDING")))
      .orderBy(asc(hr_punch_corrections.work_date), asc(hr_punch_corrections.id));
    pending = rows.map((r) => ({ ...pcOut(r.c as PcRow), employeeName: r.name, empNo: r.emp_no }));
  }
  return c.json({ canApprove, mine, pending });
});

attendance.post("/punch-fix", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const userId = c.get("user").id;
  const emp = await myEmployee(db, co.companyId, userId);
  if (!emp) return c.json(NOT_LINKED, 403);
  if (emp.status !== "ACTIVE") return c.json({ error: "not_active", message: "Your employee record is not active. Ask HR." }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const workDate = typeof body.workDate === "string" ? body.workDate : "";
  const fix = parsePunchFix(workDate, String(body.clockIn ?? ""), String(body.clockOut ?? ""), todayMyt());
  if (!fix.ok) return c.json({ error: "bad_fix", message: fix.message }, 400);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  // One open request per day: a re-filing replaces the pending one (a reviewed
  // one stays, for the record).
  await db
    .delete(hr_punch_corrections)
    .where(and(eq(hr_punch_corrections.company_id, co.companyId), eq(hr_punch_corrections.employee_id, emp.id), eq(hr_punch_corrections.work_date, workDate), eq(hr_punch_corrections.status, "PENDING")));
  const [row] = await db
    .insert(hr_punch_corrections)
    .values({ company_id: co.companyId, employee_id: emp.id, work_date: workDate, req_in_min: fix.inMin, req_out_min: fix.outMin, reason, status: "PENDING", created_by: userId })
    .returning({ id: hr_punch_corrections.id });
  return c.json({ id: row.id }, 201);
});

attendance.delete("/punch-fix/:id", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  if (!emp) return c.json(NOT_LINKED, 403);
  const done = await db
    .delete(hr_punch_corrections)
    .where(and(eq(hr_punch_corrections.id, id), eq(hr_punch_corrections.company_id, co.companyId), eq(hr_punch_corrections.employee_id, emp.id), eq(hr_punch_corrections.status, "PENDING")))
    .returning({ id: hr_punch_corrections.id });
  if (!done.length) return c.json({ error: "not_found", message: "That request is gone or already reviewed." }, 404);
  return c.json({ ok: true });
});

attendance.post("/punch-fix/:id/review", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!canApprovePunch(c)) return c.json({ error: "forbidden", message: "You cannot approve make-up punches." }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
  if (!decision) return c.json({ error: "bad_decision", message: "Approve or reject the make-up punch?" }, 400);
  const rejectReason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  const db = getDb(c.env);
  const at = new Date().toISOString();
  const by = c.get("user").id;
  // Claim the pending row atomically, so two approvers cannot both act on it.
  const claimed = await db
    .update(hr_punch_corrections)
    .set({
      status: decision === "approve" ? "APPROVED" : "REJECTED",
      reject_reason: decision === "reject" ? rejectReason || null : null,
      reviewed_by: by,
      reviewed_at: at,
      updated_at: at,
    })
    .where(and(eq(hr_punch_corrections.id, id), eq(hr_punch_corrections.company_id, co.companyId), eq(hr_punch_corrections.status, "PENDING")))
    .returning();
  const pc = claimed.at(0) as PcRow & { employee_id: number } | undefined;
  if (!pc) return c.json({ error: "not_found", message: "That request is gone or already reviewed." }, 404);
  if (decision === "approve") {
    // Write the day's attendance like an HR correction: PRESENT, the stated
    // times (MANUAL), and re-sync the working hours the day pays from.
    const inAt = pc.req_in_min != null ? instantOnWorkDate(pc.work_date, pc.req_in_min).toISOString() : null;
    const outAt = pc.req_out_min != null ? instantOnWorkDate(pc.work_date, pc.req_out_min).toISOString() : null;
    const existing = (
      await db
        .select({ id: hr_attendance.id })
        .from(hr_attendance)
        .where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.employee_id, pc.employee_id), eq(hr_attendance.work_date, pc.work_date)))
        .limit(1)
    ).at(0);
    const values = {
      status: "PRESENT",
      clock_in_at: inAt,
      clock_out_at: outAt,
      in_source: inAt ? "MANUAL" : null,
      out_source: outAt ? "MANUAL" : null,
      notes: pc.reason || null,
      updated_at: at,
      updated_by: by,
    };
    const attendanceId = existing
      ? (await db.update(hr_attendance).set(values).where(eq(hr_attendance.id, existing.id)).returning({ id: hr_attendance.id }))[0].id
      : (await db.insert(hr_attendance).values({ ...values, company_id: co.companyId, employee_id: pc.employee_id, work_date: pc.work_date }).returning({ id: hr_attendance.id }))[0].id;
    if (inAt && outAt) await syncDayFromPunch(db, co.companyId, attendanceId);
  }
  return c.json({ ok: true });
});

/* ── self-service leave (请假) ─────────────────────────────────────────────
   A worker files a leave type (annual / medical / unpaid), a date range and a
   reason; a supervisor with hr.leave.approve approves or rejects. An approval
   stamps each day in the range onto hr_attendance with that leave status, which
   payroll already prices — paid leave is not docked, unpaid is not paid. The
   leave types ARE the attendance leave statuses, so there is no second list to
   keep in step. Account-based like /punch; only the review is gated, in-handler. */
const canApproveLeave = (c: Ctx): boolean => {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, "hr.leave.approve");
};

type LrRow = { id: number; leave_status: string; start_date: string; end_date: string; reason: string; status: string; reject_reason: string | null };
const lrOut = (r: LrRow) => ({ id: r.id, leaveStatus: r.leave_status, startDate: r.start_date, endDate: r.end_date, reason: r.reason, status: r.status, rejectReason: r.reject_reason });

attendance.get("/leave", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const canApprove = canApproveLeave(c);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  const since = todayMyt(-120);
  const mine = emp
    ? (
        await db
          .select()
          .from(hr_leave_requests)
          .where(and(eq(hr_leave_requests.company_id, co.companyId), eq(hr_leave_requests.employee_id, emp.id), gte(hr_leave_requests.start_date, since)))
          .orderBy(desc(hr_leave_requests.start_date), desc(hr_leave_requests.id))
      ).map((r) => lrOut(r as LrRow))
    : [];
  let pending: Array<ReturnType<typeof lrOut> & { employeeName: string; empNo: string }> = [];
  if (canApprove) {
    const rows = await db
      .select({ c: hr_leave_requests, name: hr_employees.name, emp_no: hr_employees.emp_no })
      .from(hr_leave_requests)
      .innerJoin(hr_employees, eq(hr_employees.id, hr_leave_requests.employee_id))
      .where(and(eq(hr_leave_requests.company_id, co.companyId), eq(hr_leave_requests.status, "PENDING")))
      .orderBy(asc(hr_leave_requests.start_date), asc(hr_leave_requests.id));
    pending = rows.map((r) => ({ ...lrOut(r.c as LrRow), employeeName: r.name, empNo: r.emp_no }));
  }
  return c.json({ types: APPLICABLE_LEAVE_TYPES, canApprove, mine, pending });
});

attendance.post("/leave", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const userId = c.get("user").id;
  const emp = await myEmployee(db, co.companyId, userId);
  if (!emp) return c.json(NOT_LINKED, 403);
  if (emp.status !== "ACTIVE") return c.json({ error: "not_active", message: "Your employee record is not active. Ask HR." }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseLeaveRequest(String(body.leaveType ?? ""), String(body.startDate ?? ""), String(body.endDate ?? ""));
  if (!parsed.ok) return c.json({ error: "bad_leave", message: parsed.message }, 400);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const [row] = await db
    .insert(hr_leave_requests)
    .values({ company_id: co.companyId, employee_id: emp.id, leave_status: parsed.leaveStatus, start_date: parsed.days[0], end_date: parsed.days[parsed.days.length - 1], reason, status: "PENDING", created_by: userId })
    .returning({ id: hr_leave_requests.id });
  return c.json({ id: row.id }, 201);
});

attendance.delete("/leave/:id", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const emp = await myEmployee(db, co.companyId, c.get("user").id);
  if (!emp) return c.json(NOT_LINKED, 403);
  const done = await db
    .delete(hr_leave_requests)
    .where(and(eq(hr_leave_requests.id, id), eq(hr_leave_requests.company_id, co.companyId), eq(hr_leave_requests.employee_id, emp.id), eq(hr_leave_requests.status, "PENDING")))
    .returning({ id: hr_leave_requests.id });
  if (!done.length) return c.json({ error: "not_found", message: "That request is gone or already reviewed." }, 404);
  return c.json({ ok: true });
});

attendance.post("/leave/:id/review", async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!canApproveLeave(c)) return c.json({ error: "forbidden", message: "You cannot approve leave." }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
  if (!decision) return c.json({ error: "bad_decision", message: "Approve or reject the leave?" }, 400);
  const rejectReason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  const db = getDb(c.env);
  const at = new Date().toISOString();
  const by = c.get("user").id;
  // Claim the pending row atomically, so two approvers cannot both act on it.
  const claimed = await db
    .update(hr_leave_requests)
    .set({ status: decision === "approve" ? "APPROVED" : "REJECTED", reject_reason: decision === "reject" ? rejectReason || null : null, reviewed_by: by, reviewed_at: at, updated_at: at })
    .where(and(eq(hr_leave_requests.id, id), eq(hr_leave_requests.company_id, co.companyId), eq(hr_leave_requests.status, "PENDING")))
    .returning();
  const lr = claimed.at(0) as (LrRow & { employee_id: number }) | undefined;
  if (!lr) return c.json({ error: "not_found", message: "That request is gone or already reviewed." }, 404);
  if (decision === "approve") {
    // Stamp each day as the leave status, no times — payroll reads the status,
    // and a leave day carries no worked hours and no short-hour dock.
    const parsed = parseLeaveRequest(lr.leave_status, lr.start_date, lr.end_date);
    const days = parsed.ok ? parsed.days : [];
    for (const d of days) {
      const existing = (
        await db.select({ id: hr_attendance.id }).from(hr_attendance).where(and(eq(hr_attendance.company_id, co.companyId), eq(hr_attendance.employee_id, lr.employee_id), eq(hr_attendance.work_date, d))).limit(1)
      ).at(0);
      const values = { status: lr.leave_status, clock_in_at: null, clock_out_at: null, in_source: null, out_source: null, updated_at: at, updated_by: by };
      const attId = existing
        ? (await db.update(hr_attendance).set(values).where(eq(hr_attendance.id, existing.id)).returning({ id: hr_attendance.id }))[0].id
        : (await db.insert(hr_attendance).values({ ...values, company_id: co.companyId, employee_id: lr.employee_id, work_date: d }).returning({ id: hr_attendance.id }))[0].id;
      await db.delete(hr_working_hours).where(and(eq(hr_working_hours.attendance_id, attId), eq(hr_working_hours.source, "AUTO")));
      await applyDayDock(db, co.companyId, lr.employee_id, d, 0, "");
    }
  }
  return c.json({ ok: true });
});
