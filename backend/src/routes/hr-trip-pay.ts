// ----------------------------------------------------------------------------
// hr-trip-pay — Employees & Attendance > Trip Pay and Allowances (HC-0125
// phase 5): the driver's commission and the trip allowances of drivers and
// helpers (Nico's "Driver Comm + Worker Allowance" sheet) and the monthly
// allowances. Leave is keyed on the Attendance tab (annual / medical / rest
// day / unpaid). Mounted on /api/hr behind hr.employees.read / .manage.
//
//   GET    /trip-pay?month=YYYY-MM          rows, everyone's pay, unmatched names
//   POST   /trip-pay/import {month, text}   paste the Trip Report (replaces SHEET + PLANNING rows)
//   POST   /trip-pay/pull {month}           read Delivery Planning's lorry runs (replaces them too)
//   POST   /trip-pay/rows                   add a row (MANUAL)
//   PATCH  /trip-pay/rows/:id   DELETE /trip-pay/rows/:id
//   PUT    /trip-pay/missed {employeeId, month, missedDays|null, note}
//   GET    /trip-rates   POST /trip-rates   DELETE /trip-rates/:id
//   GET    /allowances?period   POST /allowances   PATCH|DELETE /allowances/:id
//
// A trip month (23rd to 22nd) is paid on the payslip month of the same name;
// once that month is approved its rows, missed days and allowances freeze.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { hr_allowances, hr_employees, hr_trip_missed_days, hr_trip_rate_versions, hr_trip_rows } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { hasPermission } from "../services/permissions";
import { audit } from "../services/audit";
import {
  DEFAULT_TRIP_RATES,
  TRIP_KINDS,
  normalizeTripRates,
  parseTripReport,
  resolveTripRatesAsOf,
  tripMonthBounds,
  tripMonthOf,
  tripRatesProblem,
  type TripKind,
} from "../scm/shared/hr-trip-pay";
import { lockedPeriods } from "./lib/hr-payroll-store";
import { ALLOWANCE_KINDS, ALLOWANCE_LABEL, type AllowanceKind } from "./lib/hr-payslip";
import { loadTripMonth, nameIndex, planningRows, tripMonthLocked } from "./lib/hr-trip-store";

type Ctx = Context<{ Bindings: Env }>;

export const hrTripPay = new Hono<{ Bindings: Env }>();

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN = { error: "forbidden", message: "You don't have permission to change HR records." } as const;
const LOCKED = (month: string) => ({ error: "locked", message: `Payroll ${month} is approved, so its trip month is frozen. Set the payroll back to draft first.` }) as const;

function canManage(c: Ctx): boolean {
  const u = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
  return hasPermission(u.permissions_set ?? u.permissions, "hr.employees.manage");
}
const intParam = (c: Ctx, k: string) => {
  const n = Number(c.req.param(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ── trip pay ──────────────────────────────────────────────────────────── */

type RowRecord = typeof hr_trip_rows.$inferSelect;
const rowOut = (r: RowRecord) => ({
  id: r.id,
  source: r.source,
  tripDate: r.trip_date,
  docNo: r.doc_no,
  transferTo: r.transfer_to,
  refNo: r.ref_no,
  kind: r.kind,
  localTotalSen: Number(r.local_total_sen),
  state: r.state,
  lorryPlate: r.lorry_plate,
  driver1: { name: r.driver_1_name, employeeId: r.driver_1_employee_id },
  driver2: { name: r.driver_2_name, employeeId: r.driver_2_employee_id },
  helper1: { name: r.helper_1_name, employeeId: r.helper_1_employee_id },
  helper2: { name: r.helper_2_name, employeeId: r.helper_2_employee_id },
});

hrTripPay.get("/trip-pay", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const today = todayMyt();
  const month = c.req.query("month") ?? tripMonthOf(today);
  if (!PERIOD.test(month)) return c.json({ error: "bad_period", message: "Pick a month." }, 400);
  const db = getDb(c.env);
  const [t, locked] = await Promise.all([loadTripMonth(db, co.companyId, month, today), tripMonthLocked(db, co.companyId, month)]);
  const byName = nameIndex(t.people);
  const who = (id: number) => t.people.find((p) => p.id === id);
  const people = [...t.pay.values()]
    .map((p) => {
      const e = who(p.employeeId);
      const m = t.missed.get(p.employeeId);
      return { ...p, empNo: e?.empNo ?? "", name: e?.name ?? "", missed: p.drove ? (m ?? null) : null };
    })
    .sort((a, b) => Number(b.drove) - Number(a.drove) || a.name.localeCompare(b.name));
  const resolved = (p: { name: string; employeeId: number | null }) => (p.employeeId ?? (p.name ? byName(p.name) : null));
  return c.json({
    month,
    first: t.first,
    last: t.last,
    locked,
    rates: t.rates,
    rows: t.rows.map((r) => {
      const o = rowOut(r);
      return {
        ...o,
        matched: {
          driver1: o.driver1.name || o.driver1.employeeId != null ? resolved(o.driver1) : undefined,
          driver2: o.driver2.name || o.driver2.employeeId != null ? resolved(o.driver2) : undefined,
          helper1: o.helper1.name || o.helper1.employeeId != null ? resolved(o.helper1) : undefined,
          helper2: o.helper2.name || o.helper2.employeeId != null ? resolved(o.helper2) : undefined,
        },
      };
    }),
    people,
    unmatched: t.unmatched,
    totals: {
      commissionSen: people.reduce((s, p) => s + p.commission.amountSen, 0),
      allowanceSen: people.reduce((s, p) => s + p.allowanceSen, 0),
    },
    sources: [...new Set(t.rows.map((r) => r.source))],
    canManage: canManage(c),
  });
});

async function replaceGenerated(c: Ctx, companyId: number, month: string, rows: Array<Omit<typeof hr_trip_rows.$inferInsert, "company_id" | "trip_month" | "created_by">>) {
  const db = getDb(c.env);
  const by = c.get("user").id;
  await db.delete(hr_trip_rows).where(and(eq(hr_trip_rows.company_id, companyId), eq(hr_trip_rows.trip_month, month), inArray(hr_trip_rows.source, ["SHEET", "PLANNING"])));
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(hr_trip_rows).values(rows.slice(i, i + 200).map((r) => ({ ...r, company_id: companyId, trip_month: month, created_by: by })));
  }
}

hrTripPay.post("/trip-pay/import", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await readBody(c);
  const month = str(body.month);
  const text = typeof body.text === "string" ? body.text : "";
  if (!PERIOD.test(month)) return c.json({ error: "validation_failed", message: "Pick a month." }, 400);
  if (text.length > 2_000_000) return c.json({ error: "validation_failed", message: "That paste is too large; paste one month's Trip Report." }, 400);
  const db = getDb(c.env);
  if (await tripMonthLocked(db, co.companyId, month)) return c.json(LOCKED(month), 409);
  const { rows, skipped } = parseTripReport(text);
  if (!rows.length) return c.json({ error: "validation_failed", message: "No rows with a delivery date were found. Copy the Trip Report columns Doc. No. to Helper 2." }, 400);
  const { first, last } = tripMonthBounds(month);
  const outside = rows.filter((r) => r.tripDate < first || r.tripDate > last);
  if (outside.length) {
    return c.json({ error: "validation_failed", message: `${outside.length} row(s) fall outside ${first} to ${last}, the first on ${outside[0].tripDate}. Paste only this trip month.` }, 400);
  }
  await replaceGenerated(
    c,
    co.companyId,
    month,
    rows.map((r, i) => ({
      source: "SHEET",
      source_ref: String(i + 1),
      trip_date: r.tripDate,
      doc_no: r.docNo,
      transfer_to: r.transferTo,
      ref_no: r.refNo,
      kind: r.kind,
      local_total_sen: Math.max(0, r.localTotalSen),
      state: r.state,
      lorry_plate: r.lorryPlate,
      driver_1_name: r.drivers[0]?.name ?? "",
      helper_1_name: r.helpers[0]?.name ?? "",
      helper_2_name: r.helpers[1]?.name ?? "",
    })),
  );
  await audit(c, { action: "hr.trip.import", entityType: "hr_trip_month", entityId: month, summary: `Pasted ${rows.length} trip rows for ${month}`, meta: { skipped: skipped.length } });
  return c.json({ ok: true, count: rows.length, skipped });
});

hrTripPay.post("/trip-pay/pull", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const month = str((await readBody(c)).month);
  if (!PERIOD.test(month)) return c.json({ error: "validation_failed", message: "Pick a month." }, 400);
  const db = getDb(c.env);
  if (await tripMonthLocked(db, co.companyId, month)) return c.json(LOCKED(month), 409);
  const people = await db
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
    .where(eq(hr_employees.company_id, co.companyId));
  const rows = await planningRows(db, co.companyId, month, people);
  if (!rows.length) {
    const { first, last } = tripMonthBounds(month);
    return c.json({ error: "nothing_planned", message: `Delivery Planning has no lorry run of our own from ${first} to ${last}. Nothing was changed.` }, 409);
  }
  await replaceGenerated(c, co.companyId, month, rows);
  await audit(c, { action: "hr.trip.pull", entityType: "hr_trip_month", entityId: month, summary: `Read ${rows.length} stops from Delivery Planning for ${month}` });
  return c.json({ ok: true, count: rows.length });
});

type RowInput = {
  tripDate: string;
  docNo: string;
  transferTo: string;
  refNo: string;
  kind: TripKind;
  localTotalSen: number;
  state: string;
  lorryPlate: string;
  names: { driver_1_name: string; driver_2_name: string; helper_1_name: string; helper_2_name: string };
};

function parseRow(b: Record<string, unknown>): RowInput | string {
  const tripDate = str(b.tripDate);
  if (!YMD.test(tripDate)) return "Pick the date.";
  const kind = TRIP_KINDS.includes(b.kind as TripKind) ? (b.kind as TripKind) : null;
  if (!kind) return "Pick what the job was.";
  const sen = Number(b.localTotalSen ?? 0);
  if (!Number.isInteger(sen) || sen < 0) return "Local Total must be RM 0.00 or more.";
  const names = { driver_1_name: str(b.driver1, 80), driver_2_name: str(b.driver2, 80), helper_1_name: str(b.helper1, 80), helper_2_name: str(b.helper2, 80) };
  if (!names.driver_1_name && !names.driver_2_name) return "Name the driver.";
  return { tripDate, docNo: str(b.docNo), transferTo: str(b.transferTo), refNo: str(b.refNo), kind, localTotalSen: sen, state: str(b.state, 60), lorryPlate: str(b.lorryPlate, 30), names };
}

hrTripPay.post("/trip-pay/rows", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const r = parseRow(await readBody(c));
  if (typeof r === "string") return c.json({ error: "validation_failed", message: r }, 400);
  const month = tripMonthOf(r.tripDate);
  const db = getDb(c.env);
  if (await tripMonthLocked(db, co.companyId, month)) return c.json(LOCKED(month), 409);
  const [row] = await db
    .insert(hr_trip_rows)
    .values({
      company_id: co.companyId,
      trip_month: month,
      source: "MANUAL",
      trip_date: r.tripDate,
      doc_no: r.docNo,
      transfer_to: r.transferTo,
      ref_no: r.refNo,
      kind: r.kind,
      local_total_sen: r.localTotalSen,
      state: r.state,
      lorry_plate: r.lorryPlate,
      ...r.names,
      created_by: c.get("user").id,
    })
    .returning({ id: hr_trip_rows.id });
  await audit(c, { action: "hr.trip.row_add", entityType: "hr_trip_row", entityId: row.id, summary: `Added trip row ${r.tripDate} ${r.kind}`, meta: r });
  return c.json({ id: row.id, month }, 201);
});

hrTripPay.patch("/trip-pay/rows/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const cur = (await db.select().from(hr_trip_rows).where(and(eq(hr_trip_rows.company_id, co.companyId), eq(hr_trip_rows.id, id))).limit(1)).at(0);
  if (!cur) return c.json({ error: "not_found_in_company" }, 404);
  const r = parseRow(await readBody(c));
  if (typeof r === "string") return c.json({ error: "validation_failed", message: r }, 400);
  if (tripMonthOf(r.tripDate) !== cur.trip_month) return c.json({ error: "validation_failed", message: `The date must stay inside trip month ${cur.trip_month}.` }, 400);
  if (await tripMonthLocked(db, co.companyId, cur.trip_month)) return c.json(LOCKED(cur.trip_month), 409);
  /* A renamed person is matched by name again; an unchanged one keeps the employee Planning found. */
  const keep = (name: string, was: string, id: number | null) => (name === was ? id : null);
  await db
    .update(hr_trip_rows)
    .set({
      trip_date: r.tripDate,
      doc_no: r.docNo,
      transfer_to: r.transferTo,
      ref_no: r.refNo,
      kind: r.kind,
      local_total_sen: r.localTotalSen,
      state: r.state,
      lorry_plate: r.lorryPlate,
      ...r.names,
      driver_1_employee_id: keep(r.names.driver_1_name, cur.driver_1_name, cur.driver_1_employee_id),
      driver_2_employee_id: keep(r.names.driver_2_name, cur.driver_2_name, cur.driver_2_employee_id),
      helper_1_employee_id: keep(r.names.helper_1_name, cur.helper_1_name, cur.helper_1_employee_id),
      helper_2_employee_id: keep(r.names.helper_2_name, cur.helper_2_name, cur.helper_2_employee_id),
      updated_at: new Date().toISOString(),
    })
    .where(eq(hr_trip_rows.id, id));
  await audit(c, { action: "hr.trip.row_edit", entityType: "hr_trip_row", entityId: id, summary: `Edited trip row ${r.tripDate}`, meta: { before: rowOut(cur), after: r } });
  return c.json({ ok: true });
});

hrTripPay.delete("/trip-pay/rows/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const cur = (await db.select().from(hr_trip_rows).where(and(eq(hr_trip_rows.company_id, co.companyId), eq(hr_trip_rows.id, id))).limit(1)).at(0);
  if (!cur) return c.json({ error: "not_found_in_company" }, 404);
  if (await tripMonthLocked(db, co.companyId, cur.trip_month)) return c.json(LOCKED(cur.trip_month), 409);
  await db.delete(hr_trip_rows).where(eq(hr_trip_rows.id, id));
  await audit(c, { action: "hr.trip.row_remove", entityType: "hr_trip_row", entityId: id, summary: `Removed trip row ${cur.trip_date}`, meta: rowOut(cur) });
  return c.json({ ok: true });
});

hrTripPay.put("/trip-pay/missed", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const b = await readBody(c);
  const month = str(b.month);
  const employeeId = Number(b.employeeId);
  const clear = b.missedDays === null;
  const days = Number(b.missedDays);
  if (!PERIOD.test(month) || !Number.isInteger(employeeId) || employeeId <= 0) return c.json({ error: "validation_failed", message: "Pick a driver and a month." }, 400);
  if (!clear && (!Number.isInteger(days) || days < 0 || days > 31)) return c.json({ error: "validation_failed", message: "Missed days: a whole number from 0 to 31." }, 400);
  const db = getDb(c.env);
  const emp = (await db.select({ id: hr_employees.id, emp_no: hr_employees.emp_no }).from(hr_employees).where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, employeeId))).limit(1)).at(0);
  if (!emp) return c.json({ error: "not_found_in_company" }, 404);
  if (await tripMonthLocked(db, co.companyId, month)) return c.json(LOCKED(month), 409);
  if (clear) {
    await db.delete(hr_trip_missed_days).where(and(eq(hr_trip_missed_days.employee_id, employeeId), eq(hr_trip_missed_days.trip_month, month)));
  } else {
    const note = str(b.note) || null;
    const set = { missed_days: days, note, updated_at: new Date().toISOString(), updated_by: c.get("user").id };
    await db
      .insert(hr_trip_missed_days)
      .values({ company_id: co.companyId, employee_id: employeeId, trip_month: month, ...set })
      .onConflictDoUpdate({ target: [hr_trip_missed_days.employee_id, hr_trip_missed_days.trip_month], set });
  }
  await audit(c, { action: "hr.trip.missed", entityType: "hr_employee", entityId: employeeId, summary: `${emp.emp_no} missed days ${month}: ${clear ? "from punches" : days}` });
  return c.json({ ok: true });
});

/* ── trip rates (effective-dated) ──────────────────────────────────────── */

hrTripPay.get("/trip-rates", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rows = await getDb(c.env).select().from(hr_trip_rate_versions).where(eq(hr_trip_rate_versions.company_id, co.companyId)).orderBy(desc(hr_trip_rate_versions.effective_from));
  const versions = rows.map((r) => ({ id: r.id, effectiveFrom: r.effective_from, rates: normalizeTripRates(r.rates), note: r.note, createdAt: r.created_at }));
  const today = todayMyt();
  return c.json({ versions, defaults: DEFAULT_TRIP_RATES, effectiveToday: resolveTripRatesAsOf(versions, today), today, canManage: canManage(c) });
});

/* Rates may start on a past date (Nico sets September's after the fact), but
 * never inside a trip month whose payroll is approved. */
async function firstOpenDate(db: ReturnType<typeof getDb>, companyId: number): Promise<string | null> {
  const locked = [...(await lockedPeriods(db, companyId))].sort();
  return locked.length ? tripMonthBounds(locked[locked.length - 1]).last : null;
}

hrTripPay.post("/trip-rates", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await readBody(c);
  const effectiveFrom = str(body.effectiveFrom);
  if (!YMD.test(effectiveFrom)) return c.json({ error: "validation_failed", message: "Pick the date the rates take effect." }, 400);
  const rates = normalizeTripRates(body.rates);
  const problem = tripRatesProblem(rates);
  if (problem) return c.json({ error: "validation_failed", message: problem }, 400);
  const db = getDb(c.env);
  const frozenThrough = await firstOpenDate(db, co.companyId);
  if (frozenThrough && effectiveFrom <= frozenThrough) return c.json({ error: "locked", message: `Payroll is approved through ${frozenThrough}; start the rates after it.` }, 409);
  const note = str(body.note) || null;
  const by = c.get("user").id;
  const [row] = await db
    .insert(hr_trip_rate_versions)
    .values({ company_id: co.companyId, effective_from: effectiveFrom, rates, note, created_by: by })
    .onConflictDoUpdate({ target: [hr_trip_rate_versions.company_id, hr_trip_rate_versions.effective_from], set: { rates, note, created_by: by, created_at: new Date().toISOString() } })
    .returning({ id: hr_trip_rate_versions.id });
  await audit(c, { action: "hr.trip_rates.schedule", entityType: "hr_trip_rate_version", entityId: row.id, summary: `Trip rates from ${effectiveFrom}`, meta: rates });
  return c.json({ id: row.id, effectiveFrom, rates }, 201);
});

hrTripPay.delete("/trip-rates/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const frozenThrough = (await firstOpenDate(db, co.companyId)) ?? "0000-00-00";
  const done = await db
    .delete(hr_trip_rate_versions)
    .where(and(eq(hr_trip_rate_versions.company_id, co.companyId), eq(hr_trip_rate_versions.id, id), gt(hr_trip_rate_versions.effective_from, frozenThrough)))
    .returning({ effective_from: hr_trip_rate_versions.effective_from });
  if (!done.length) return c.json({ error: "in_force", message: "Rates an approved payroll was worked out with cannot be removed." }, 409);
  await audit(c, { action: "hr.trip_rates.remove", entityType: "hr_trip_rate_version", entityId: id, summary: `Removed trip rates from ${done[0].effective_from}` });
  return c.json({ ok: true });
});

/* ── monthly allowances ────────────────────────────────────────────────── */

hrTripPay.get("/allowances", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const period = c.req.query("period") ?? todayMyt().slice(0, 7);
  if (!PERIOD.test(period)) return c.json({ error: "bad_period", message: "Pick a month." }, 400);
  const rows = await getDb(c.env)
    .select({ a: hr_allowances, emp_no: hr_employees.emp_no, name: hr_employees.name })
    .from(hr_allowances)
    .innerJoin(hr_employees, eq(hr_employees.id, hr_allowances.employee_id))
    .where(and(eq(hr_allowances.company_id, co.companyId), lte(hr_allowances.from_period, period), or(isNull(hr_allowances.until_period), gte(hr_allowances.until_period, period))))
    .orderBy(asc(hr_employees.emp_no), asc(hr_allowances.id));
  const out = rows.map(({ a, emp_no, name }) => ({
    id: a.id,
    employeeId: a.employee_id,
    empNo: emp_no,
    name,
    kind: a.kind,
    label: ALLOWANCE_LABEL[a.kind as AllowanceKind],
    amountSen: Number(a.amount_sen),
    fromPeriod: a.from_period,
    untilPeriod: a.until_period,
    note: a.note,
  }));
  return c.json({
    period,
    allowances: out,
    paidSen: out.filter((a) => a.kind !== "BACKPAY").reduce((s, a) => s + a.amountSen, 0),
    deductedSen: out.filter((a) => a.kind === "BACKPAY").reduce((s, a) => s + a.amountSen, 0),
    locked: (await lockedPeriods(getDb(c.env), co.companyId)).has(period),
    canManage: canManage(c),
  });
});

function parseAllowance(b: Record<string, unknown>): { employeeId: number; kind: AllowanceKind; amountSen: number; fromPeriod: string; untilPeriod: string | null; note: string | null } | string {
  const employeeId = Number(b.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) return "Pick the employee.";
  const kind = ALLOWANCE_KINDS.includes(b.kind as AllowanceKind) ? (b.kind as AllowanceKind) : null;
  if (!kind) return "Pick the kind of allowance.";
  const amountSen = Number(b.amountSen);
  if (!Number.isInteger(amountSen) || amountSen <= 0) return "The amount must be above RM 0.00.";
  const fromPeriod = str(b.fromPeriod);
  if (!PERIOD.test(fromPeriod)) return "Pick the first month.";
  const untilPeriod = b.untilPeriod === null || b.untilPeriod === "" || b.untilPeriod === undefined ? null : str(b.untilPeriod);
  if (untilPeriod !== null && (!PERIOD.test(untilPeriod) || untilPeriod < fromPeriod)) return "The last month cannot be before the first.";
  return { employeeId, kind, amountSen, fromPeriod, untilPeriod, note: str(b.note) || null };
}

/** Months an allowance range touches that are already approved. */
async function lockedIn(c: Ctx, companyId: number, from: string, until: string | null): Promise<string | null> {
  const locked = [...(await lockedPeriods(getDb(c.env), companyId))].sort();
  return locked.find((p) => p >= from && (until === null || p <= until)) ?? null;
}

hrTripPay.post("/allowances", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const a = parseAllowance(await readBody(c));
  if (typeof a === "string") return c.json({ error: "validation_failed", message: a }, 400);
  const db = getDb(c.env);
  const emp = (await db.select({ emp_no: hr_employees.emp_no }).from(hr_employees).where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, a.employeeId))).limit(1)).at(0);
  if (!emp) return c.json({ error: "not_found_in_company" }, 404);
  const hit = await lockedIn(c, co.companyId, a.fromPeriod, a.untilPeriod);
  if (hit) return c.json(LOCKED(hit), 409);
  const [row] = await db
    .insert(hr_allowances)
    .values({ company_id: co.companyId, employee_id: a.employeeId, kind: a.kind, amount_sen: a.amountSen, from_period: a.fromPeriod, until_period: a.untilPeriod, note: a.note, created_by: c.get("user").id })
    .returning({ id: hr_allowances.id });
  await audit(c, { action: "hr.allowance.create", entityType: "hr_employee", entityId: a.employeeId, summary: `${emp.emp_no} ${ALLOWANCE_LABEL[a.kind]} from ${a.fromPeriod}`, meta: a });
  return c.json({ id: row.id }, 201);
});

hrTripPay.patch("/allowances/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const cur = (await db.select().from(hr_allowances).where(and(eq(hr_allowances.company_id, co.companyId), eq(hr_allowances.id, id))).limit(1)).at(0);
  if (!cur) return c.json({ error: "not_found_in_company" }, 404);
  const a = parseAllowance({ ...(await readBody(c)), employeeId: cur.employee_id });
  if (typeof a === "string") return c.json({ error: "validation_failed", message: a }, 400);
  /* Approved months keep what they paid: only the open end of a range may move, and only past them. */
  const hit = (await lockedIn(c, co.companyId, cur.from_period, cur.until_period)) ?? (await lockedIn(c, co.companyId, a.fromPeriod, a.untilPeriod));
  if (hit) {
    const onlyEndMoves = a.kind === cur.kind && a.amountSen === Number(cur.amount_sen) && a.fromPeriod === cur.from_period && a.untilPeriod !== null && a.untilPeriod >= hit;
    const lockedAfter = await lockedIn(c, co.companyId, a.untilPeriod ?? "9999-12", null);
    if (!onlyEndMoves || lockedAfter) return c.json({ error: "locked", message: `Payroll ${hit} is approved and paid this allowance. Set its last month instead, or add a new line.` }, 409);
  }
  await db
    .update(hr_allowances)
    .set({ kind: a.kind, amount_sen: a.amountSen, from_period: a.fromPeriod, until_period: a.untilPeriod, note: a.note, updated_at: new Date().toISOString() })
    .where(eq(hr_allowances.id, id));
  await audit(c, { action: "hr.allowance.edit", entityType: "hr_employee", entityId: cur.employee_id, summary: `Allowance ${id} edited`, meta: a });
  return c.json({ ok: true });
});

hrTripPay.delete("/allowances/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const cur = (await db.select().from(hr_allowances).where(and(eq(hr_allowances.company_id, co.companyId), eq(hr_allowances.id, id))).limit(1)).at(0);
  if (!cur) return c.json({ error: "not_found_in_company" }, 404);
  const hit = await lockedIn(c, co.companyId, cur.from_period, cur.until_period);
  if (hit) return c.json({ error: "locked", message: `Payroll ${hit} is approved and paid this allowance. Set its last month instead.` }, 409);
  await db.delete(hr_allowances).where(eq(hr_allowances.id, id));
  await audit(c, { action: "hr.allowance.remove", entityType: "hr_employee", entityId: cur.employee_id, summary: `Allowance ${id} removed` });
  return c.json({ ok: true });
});
