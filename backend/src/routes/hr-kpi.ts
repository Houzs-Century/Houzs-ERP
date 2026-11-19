// ----------------------------------------------------------------------------
// hr-kpi — Employees & Attendance > KPI (HC-0125): an in-ERP monthly KPI
// appraisal for a storekeeper supervisor and (same template) the storekeepers
// under them. HR rates each weighted KPI 1-5 per week; the system scores the
// weighted average, averages the fully rated weeks into a final score, maps it
// to a payout tier, and on Confirm books that tier's RM (by role) as the
// month's KPI allowance (hr_allowances, kind 'KPI' — already summed into
// payroll gross). Mounted on /api/hr behind hr.employees.read / .manage.
//
//   GET    /kpi/config                      metrics + tiers + canManage
//   POST   /kpi/config/seed-default         fill the default template when empty
//   POST   /kpi/metrics  PATCH|DELETE /kpi/metrics/:id
//   POST   /kpi/tiers    PATCH|DELETE /kpi/tiers/:id
//   GET    /kpi/reviews?period=YYYY-MM      everyone's appraisal that month
//   GET    /kpi/review?employeeId=&period=  one appraisal (grid + computed)
//   PUT    /kpi/review                      save a DRAFT (recomputed server-side)
//   POST   /kpi/review/confirm              book the KPI allowance, lock to CONFIRMED
//   POST   /kpi/review/unconfirm            remove the allowance, back to DRAFT
//
// A KPI allowance for a month an approved payroll already paid is frozen, same
// as any allowance.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { hr_allowances, hr_employees, hr_kpi_metrics, hr_kpi_reviews, hr_kpi_tiers } from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { hasPermission } from "../services/permissions";
import { audit } from "../services/audit";
import { lockedPeriods } from "./lib/hr-payroll-store";
import {
  computeKpi,
  KPI_RATING_MAX_X100,
  KPI_RATING_MIN_X100,
  KPI_WEEKS,
  type KpiMetricDef,
  type KpiRating,
  type KpiRole,
  type KpiTierDef,
} from "../scm/shared/hr-kpi";

type Ctx = Context<{ Bindings: Env }>;

export const hrKpi = new Hono<{ Bindings: Env }>();

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
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
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const intOf = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const roleOf = (v: unknown): KpiRole => (v === "STAFF" ? "STAFF" : "SUPERVISOR");

/* The default storekeeper-supervisor template. Metric names, targets and
 * weights are operational (safe in a public repo); the payout amounts are
 * pay-sensitive, so the default carries 0 and HR fills them in the app. */
const DEFAULT_METRICS: { name: string; target: string; weightBp: number }[] = [
  { name: "Inventory Accuracy Rate", target: "99.5%+ accuracy; zero errors", weightBp: 1500 },
  { name: "Damage Accountability & Product Integrity", target: "Zero internal breakage; solves stock hiccups without affecting trip targets", weightBp: 1500 },
  { name: "Picking Delivery Order (DO) Speed", target: "Average under 5-9 min per DO", weightBp: 1500 },
  { name: "Dock Utilization - 3 ton lorry", target: "Under 30 min per 3-ton lorry", weightBp: 1000 },
  { name: "Dock Utilization - 5 ton lorry", target: "Under 45 min per 5-ton lorry", weightBp: 1000 },
  { name: "Dock Utilization - 10 ton lorry", target: "Under 60 min per 10-ton lorry", weightBp: 1000 },
  { name: "Receiving Processing Time", target: "Goods allocated into rack within 4 hours", weightBp: 1500 },
  { name: "Warehouse Clean & Tidiness", target: "Consistent 100% standard", weightBp: 1000 },
];
const DEFAULT_TIERS: { minScoreX100: number; maxScoreX100: number; label: string }[] = [
  { minScoreX100: 450, maxScoreX100: 500, label: "Outstanding" },
  { minScoreX100: 400, maxScoreX100: 449, label: "Exceeds Expectations" },
  { minScoreX100: 300, maxScoreX100: 399, label: "Meets Expectations" },
  { minScoreX100: 200, maxScoreX100: 299, label: "Needs Improvement" },
  { minScoreX100: 0, maxScoreX100: 199, label: "Unsatisfactory" },
];

async function loadMetrics(db: ReturnType<typeof getDb>, companyId: number) {
  return db.select().from(hr_kpi_metrics).where(eq(hr_kpi_metrics.company_id, companyId)).orderBy(asc(hr_kpi_metrics.sort_order), asc(hr_kpi_metrics.id));
}
async function loadTiers(db: ReturnType<typeof getDb>, companyId: number) {
  return db.select().from(hr_kpi_tiers).where(eq(hr_kpi_tiers.company_id, companyId)).orderBy(asc(hr_kpi_tiers.sort_order), asc(hr_kpi_tiers.id));
}
const metricDefs = (rows: { id: number; weight_bp: number; active: boolean }[]): KpiMetricDef[] =>
  rows.filter((m) => m.active).map((m) => ({ id: m.id, weightBp: Number(m.weight_bp) }));
const tierDefs = (rows: { min_score_x100: number; max_score_x100: number; label: string; supervisor_amount_sen: number; staff_amount_sen: number }[]): KpiTierDef[] =>
  rows.map((t) => ({
    minScoreX100: Number(t.min_score_x100),
    maxScoreX100: Number(t.max_score_x100),
    label: t.label,
    supervisorAmountSen: Number(t.supervisor_amount_sen),
    staffAmountSen: Number(t.staff_amount_sen),
  }));

const metricOut = (m: typeof hr_kpi_metrics.$inferSelect) => ({
  id: m.id,
  name: m.name,
  target: m.target,
  weightBp: Number(m.weight_bp),
  sortOrder: m.sort_order,
  active: m.active,
});
const tierOut = (t: typeof hr_kpi_tiers.$inferSelect) => ({
  id: t.id,
  minScoreX100: Number(t.min_score_x100),
  maxScoreX100: Number(t.max_score_x100),
  label: t.label,
  supervisorAmountSen: Number(t.supervisor_amount_sen),
  staffAmountSen: Number(t.staff_amount_sen),
  sortOrder: t.sort_order,
});

/* ── config ────────────────────────────────────────────────────────────── */

hrKpi.get("/kpi/config", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const [metrics, tiers] = await Promise.all([loadMetrics(db, co.companyId), loadTiers(db, co.companyId)]);
  return c.json({ metrics: metrics.map(metricOut), tiers: tiers.map(tierOut), canManage: canManage(c) });
});

hrKpi.post("/kpi/config/seed-default", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const [metrics, tiers] = await Promise.all([loadMetrics(db, co.companyId), loadTiers(db, co.companyId)]);
  if (metrics.length > 0 || tiers.length > 0) return c.json({ error: "not_empty", message: "KPI settings already exist. Edit them instead." }, 409);
  await db.insert(hr_kpi_metrics).values(DEFAULT_METRICS.map((m, i) => ({ company_id: co.companyId, name: m.name, target: m.target, weight_bp: m.weightBp, sort_order: i, created_by: c.get("user").id })));
  await db.insert(hr_kpi_tiers).values(DEFAULT_TIERS.map((t, i) => ({ company_id: co.companyId, min_score_x100: t.minScoreX100, max_score_x100: t.maxScoreX100, label: t.label, sort_order: i })));
  await audit(c, { action: "hr.kpi.seed_default", entityType: "company", entityId: co.companyId, summary: "Loaded the default KPI template" });
  return c.json({ ok: true }, 201);
});

function parseMetric(b: Record<string, unknown>): { name: string; target: string; weightBp: number; sortOrder: number; active: boolean } | string {
  const name = str(b.name, 200);
  if (!name) return "Give the KPI a name.";
  const weightBp = intOf(b.weightBp);
  if (weightBp < 0 || weightBp > 10000) return "Weight is a share from 0 to 100%.";
  return { name, target: str(b.target), weightBp, sortOrder: intOf(b.sortOrder), active: b.active !== false };
}

hrKpi.post("/kpi/metrics", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const m = parseMetric(await readBody(c));
  if (typeof m === "string") return c.json({ error: "validation_failed", message: m }, 400);
  const db = getDb(c.env);
  const [row] = await db.insert(hr_kpi_metrics).values({ company_id: co.companyId, name: m.name, target: m.target, weight_bp: m.weightBp, sort_order: m.sortOrder, active: m.active, created_by: c.get("user").id }).returning({ id: hr_kpi_metrics.id });
  await audit(c, { action: "hr.kpi.metric.create", entityType: "hr_kpi_metric", entityId: row.id, summary: `KPI ${m.name}` });
  return c.json({ id: row.id }, 201);
});

hrKpi.patch("/kpi/metrics/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const m = parseMetric(await readBody(c));
  if (typeof m === "string") return c.json({ error: "validation_failed", message: m }, 400);
  const db = getDb(c.env);
  const done = await db
    .update(hr_kpi_metrics)
    .set({ name: m.name, target: m.target, weight_bp: m.weightBp, sort_order: m.sortOrder, active: m.active, updated_at: new Date().toISOString() })
    .where(and(eq(hr_kpi_metrics.company_id, co.companyId), eq(hr_kpi_metrics.id, id)))
    .returning({ id: hr_kpi_metrics.id });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.kpi.metric.edit", entityType: "hr_kpi_metric", entityId: id, summary: `KPI ${m.name}` });
  return c.json({ ok: true });
});

hrKpi.delete("/kpi/metrics/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const done = await db.delete(hr_kpi_metrics).where(and(eq(hr_kpi_metrics.company_id, co.companyId), eq(hr_kpi_metrics.id, id))).returning({ id: hr_kpi_metrics.id });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.kpi.metric.remove", entityType: "hr_kpi_metric", entityId: id, summary: `KPI ${id} removed` });
  return c.json({ ok: true });
});

function parseTier(b: Record<string, unknown>): { minScoreX100: number; maxScoreX100: number; label: string; supervisorAmountSen: number; staffAmountSen: number; sortOrder: number } | string {
  const label = str(b.label, 60);
  if (!label) return "Give the tier a name.";
  const minScoreX100 = intOf(b.minScoreX100);
  const maxScoreX100 = intOf(b.maxScoreX100);
  if (minScoreX100 < 0 || maxScoreX100 > 500 || minScoreX100 > maxScoreX100) return "The score range runs from 0 to 500 (1.00-5.00 x100), low to high.";
  const supervisorAmountSen = intOf(b.supervisorAmountSen);
  const staffAmountSen = intOf(b.staffAmountSen);
  if (supervisorAmountSen < 0 || staffAmountSen < 0) return "An amount cannot be negative.";
  return { minScoreX100, maxScoreX100, label, supervisorAmountSen, staffAmountSen, sortOrder: intOf(b.sortOrder) };
}

hrKpi.post("/kpi/tiers", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const t = parseTier(await readBody(c));
  if (typeof t === "string") return c.json({ error: "validation_failed", message: t }, 400);
  const db = getDb(c.env);
  const [row] = await db.insert(hr_kpi_tiers).values({ company_id: co.companyId, min_score_x100: t.minScoreX100, max_score_x100: t.maxScoreX100, label: t.label, supervisor_amount_sen: t.supervisorAmountSen, staff_amount_sen: t.staffAmountSen, sort_order: t.sortOrder }).returning({ id: hr_kpi_tiers.id });
  await audit(c, { action: "hr.kpi.tier.create", entityType: "hr_kpi_tier", entityId: row.id, summary: `KPI tier ${t.label}` });
  return c.json({ id: row.id }, 201);
});

hrKpi.patch("/kpi/tiers/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const t = parseTier(await readBody(c));
  if (typeof t === "string") return c.json({ error: "validation_failed", message: t }, 400);
  const db = getDb(c.env);
  const done = await db
    .update(hr_kpi_tiers)
    .set({ min_score_x100: t.minScoreX100, max_score_x100: t.maxScoreX100, label: t.label, supervisor_amount_sen: t.supervisorAmountSen, staff_amount_sen: t.staffAmountSen, sort_order: t.sortOrder, updated_at: new Date().toISOString() })
    .where(and(eq(hr_kpi_tiers.company_id, co.companyId), eq(hr_kpi_tiers.id, id)))
    .returning({ id: hr_kpi_tiers.id });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.kpi.tier.edit", entityType: "hr_kpi_tier", entityId: id, summary: `KPI tier ${t.label}` });
  return c.json({ ok: true });
});

hrKpi.delete("/kpi/tiers/:id", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const done = await db.delete(hr_kpi_tiers).where(and(eq(hr_kpi_tiers.company_id, co.companyId), eq(hr_kpi_tiers.id, id))).returning({ id: hr_kpi_tiers.id });
  if (!done.length) return c.json({ error: "not_found_in_company" }, 404);
  await audit(c, { action: "hr.kpi.tier.remove", entityType: "hr_kpi_tier", entityId: id, summary: `KPI tier ${id} removed` });
  return c.json({ ok: true });
});

/* ── reviews ───────────────────────────────────────────────────────────── */

const reviewOut = (r: typeof hr_kpi_reviews.$inferSelect) => ({
  id: r.id,
  employeeId: r.employee_id,
  period: r.period,
  role: roleOf(r.role),
  status: r.status,
  scores: r.scores,
  finalScoreX100: r.final_score_x100,
  tierLabel: r.tier_label,
  amountSen: r.amount_sen === null ? null : Number(r.amount_sen),
});

/** Recompute from stored metrics/tiers and the given ratings for a role. */
async function scoreReview(db: ReturnType<typeof getDb>, companyId: number, scores: KpiRating[], role: KpiRole) {
  const [metrics, tiers] = await Promise.all([loadMetrics(db, companyId), loadTiers(db, companyId)]);
  return computeKpi(metricDefs(metrics), scores, tierDefs(tiers), role);
}

hrKpi.get("/kpi/reviews", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const period = c.req.query("period") ?? todayMyt().slice(0, 7);
  if (!PERIOD.test(period)) return c.json({ error: "bad_period", message: "Pick a month." }, 400);
  const db = getDb(c.env);
  const rows = await db
    .select({ r: hr_kpi_reviews, emp_no: hr_employees.emp_no, name: hr_employees.name })
    .from(hr_kpi_reviews)
    .innerJoin(hr_employees, eq(hr_employees.id, hr_kpi_reviews.employee_id))
    .where(and(eq(hr_kpi_reviews.company_id, co.companyId), eq(hr_kpi_reviews.period, period)))
    .orderBy(asc(hr_employees.emp_no));
  const locked = (await lockedPeriods(db, co.companyId)).has(period);
  return c.json({
    period,
    reviews: rows.map(({ r, emp_no, name }) => ({ ...reviewOut(r), empNo: emp_no, name })),
    locked,
    canManage: canManage(c),
  });
});

hrKpi.get("/kpi/review", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const employeeId = Number(c.req.query("employeeId"));
  const period = c.req.query("period") ?? "";
  if (!Number.isInteger(employeeId) || employeeId <= 0) return c.json({ error: "bad_employee" }, 400);
  if (!PERIOD.test(period)) return c.json({ error: "bad_period", message: "Pick a month." }, 400);
  const db = getDb(c.env);
  const row = (await db.select().from(hr_kpi_reviews).where(and(eq(hr_kpi_reviews.company_id, co.companyId), eq(hr_kpi_reviews.employee_id, employeeId), eq(hr_kpi_reviews.period, period))).limit(1)).at(0);
  const locked = (await lockedPeriods(db, co.companyId)).has(period);
  return c.json({ review: row ? reviewOut(row) : null, locked, canManage: canManage(c) });
});

function parseScores(v: unknown): KpiRating[] {
  if (!Array.isArray(v)) return [];
  const out: KpiRating[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const week = intOf(o.week);
    const metricId = intOf(o.metricId);
    const ratingX100 = intOf(o.ratingX100);
    if (week < 1 || week > KPI_WEEKS || metricId <= 0) continue;
    if (ratingX100 < KPI_RATING_MIN_X100 || ratingX100 > KPI_RATING_MAX_X100) continue;
    out.push({ week, metricId, ratingX100 });
  }
  return out;
}

hrKpi.put("/kpi/review", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const b = await readBody(c);
  const employeeId = Number(b.employeeId);
  const period = str(b.period, 7);
  const role = roleOf(b.role);
  if (!Number.isInteger(employeeId) || employeeId <= 0) return c.json({ error: "bad_employee", message: "Pick the employee." }, 400);
  if (!PERIOD.test(period)) return c.json({ error: "bad_period", message: "Pick a month." }, 400);
  const db = getDb(c.env);
  const emp = (await db.select({ emp_no: hr_employees.emp_no }).from(hr_employees).where(and(eq(hr_employees.company_id, co.companyId), eq(hr_employees.id, employeeId))).limit(1)).at(0);
  if (!emp) return c.json({ error: "not_found_in_company" }, 404);
  if ((await lockedPeriods(db, co.companyId)).has(period)) return c.json({ error: "locked", message: `Payroll ${period} is approved, so its KPI is frozen.` }, 409);
  const existing = (await db.select().from(hr_kpi_reviews).where(and(eq(hr_kpi_reviews.company_id, co.companyId), eq(hr_kpi_reviews.employee_id, employeeId), eq(hr_kpi_reviews.period, period))).limit(1)).at(0);
  if (existing && existing.status === "CONFIRMED") return c.json({ error: "confirmed", message: "This month is confirmed. Reopen it before editing." }, 409);
  const scores = parseScores(b.scores);
  const computed = await scoreReview(db, co.companyId, scores, role);
  const userId = c.get("user").id;
  const now = new Date().toISOString();
  let reviewId = existing?.id ?? 0;
  if (existing) {
    await db
      .update(hr_kpi_reviews)
      .set({ role, scores, final_score_x100: computed.finalX100, tier_label: computed.tierLabel, amount_sen: computed.amountSen, updated_at: now, updated_by: userId })
      .where(eq(hr_kpi_reviews.id, existing.id));
  } else {
    const [row] = await db
      .insert(hr_kpi_reviews)
      .values({ company_id: co.companyId, employee_id: employeeId, period, role, status: "DRAFT", scores, final_score_x100: computed.finalX100, tier_label: computed.tierLabel, amount_sen: computed.amountSen, reviewer_user_id: userId, created_by: userId, updated_by: userId })
      .returning({ id: hr_kpi_reviews.id });
    reviewId = row.id;
  }
  return c.json({ ok: true, id: reviewId, computed });
});

async function loadReviewRow(db: ReturnType<typeof getDb>, companyId: number, id: number) {
  return (await db.select().from(hr_kpi_reviews).where(and(eq(hr_kpi_reviews.company_id, companyId), eq(hr_kpi_reviews.id, id))).limit(1)).at(0);
}

hrKpi.post("/kpi/review/confirm", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number((await readBody(c)).id);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const r = await loadReviewRow(db, co.companyId, id);
  if (!r) return c.json({ error: "not_found_in_company" }, 404);
  if ((await lockedPeriods(db, co.companyId)).has(r.period)) return c.json({ error: "locked", message: `Payroll ${r.period} is approved, so its KPI is frozen.` }, 409);
  const role = roleOf(r.role);
  const computed = await scoreReview(db, co.companyId, r.scores, role);
  const userId = c.get("user").id;
  const now = new Date().toISOString();
  const note = `KPI ${r.period}${computed.tierLabel ? ` (${computed.tierLabel})` : ""}`;
  let allowanceId = r.allowance_id;
  if (computed.amountSen > 0) {
    if (allowanceId) {
      await db.update(hr_allowances).set({ amount_sen: computed.amountSen, note, updated_at: now }).where(and(eq(hr_allowances.company_id, co.companyId), eq(hr_allowances.id, allowanceId)));
    } else {
      const [a] = await db.insert(hr_allowances).values({ company_id: co.companyId, employee_id: r.employee_id, kind: "KPI", amount_sen: computed.amountSen, from_period: r.period, until_period: r.period, note, created_by: userId }).returning({ id: hr_allowances.id });
      allowanceId = a.id;
    }
  } else if (allowanceId) {
    await db.delete(hr_allowances).where(and(eq(hr_allowances.company_id, co.companyId), eq(hr_allowances.id, allowanceId)));
    allowanceId = null;
  }
  await db
    .update(hr_kpi_reviews)
    .set({ status: "CONFIRMED", final_score_x100: computed.finalX100, tier_label: computed.tierLabel, amount_sen: computed.amountSen, allowance_id: allowanceId, updated_at: now, updated_by: userId })
    .where(eq(hr_kpi_reviews.id, id));
  await audit(c, { action: "hr.kpi.review.confirm", entityType: "hr_employee", entityId: r.employee_id, summary: `KPI ${r.period} confirmed: ${computed.tierLabel ?? "no tier"}`, meta: { reviewId: id, ...computed } });
  return c.json({ ok: true, amountSen: computed.amountSen, tierLabel: computed.tierLabel, allowanceId });
});

hrKpi.post("/kpi/review/unconfirm", async (c) => {
  if (!canManage(c)) return c.json(FORBIDDEN, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number((await readBody(c)).id);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const db = getDb(c.env);
  const r = await loadReviewRow(db, co.companyId, id);
  if (!r) return c.json({ error: "not_found_in_company" }, 404);
  if ((await lockedPeriods(db, co.companyId)).has(r.period)) return c.json({ error: "locked", message: `Payroll ${r.period} is approved and paid this KPI. Set the payroll back to draft first.` }, 409);
  if (r.allowance_id) await db.delete(hr_allowances).where(and(eq(hr_allowances.company_id, co.companyId), eq(hr_allowances.id, r.allowance_id)));
  await db.update(hr_kpi_reviews).set({ status: "DRAFT", allowance_id: null, updated_at: new Date().toISOString(), updated_by: c.get("user").id }).where(eq(hr_kpi_reviews.id, id));
  await audit(c, { action: "hr.kpi.review.unconfirm", entityType: "hr_employee", entityId: r.employee_id, summary: `KPI ${r.period} reopened` });
  return c.json({ ok: true });
});
