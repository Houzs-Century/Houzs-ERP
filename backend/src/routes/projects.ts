import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { requirePermission, requireAnyPermission, requirePageAccess } from "../middleware/auth";
import { parseFairSheet, eventToFinanceLines } from "../services/agents/fair-report-parse";
import { buildFileBlocks } from "../services/vision-blocks";
import { recordAi, requestAiTag } from "../services/aiUsage";
import { reconcileSchedule, type ProjRow } from "../services/agents/schedule-reconcile";
import {
  DEFECT_REVIEW_REGION_STATES,
  approverBrandBlocked,
  isCrewScopedUser,
  isDefectReviewerPosition,
  isDefectRegionState,
  roleLabelAdmits,
  salesDirectorMayAttach,
} from "../services/projectGates";
import { detectFloorplanSize, isFloorplanTitle } from "../services/floorplanSize";
import {
  createProject,
  patchProject,
  getProjectDetail,
  listProjects,
  patchFinance,
  createChecklistItem,
  patchChecklistItem,
  setChecklistStatus,
  deleteChecklistItem,
  logProjectActivity,
  addChecklistComment,
  submitChecklistForReview,
  rejectChecklistItem,
  amendChecklistItem,
  approveChecklistItem,
  createDefect,
  patchDefect,
  archiveDefect,
  createSalesReport,
  archiveSalesReport,
  syncSalesTotalFromReports,
  createLedgerLine,
  patchLedgerLine,
  archiveLedgerLine,
  syncFinanceRollup,
  LEDGER_COST_CATEGORIES,
  LEDGER_INCOME_CATEGORIES,
  MALAYSIA_STATES,
  PAYMENT_STATUSES,
  setPaymentStatus,
  createStockTransfer,
  confirmStockTransfer,
  unconfirmStockTransfer,
  archiveStockTransfer,
  getUserPhasesOnProject,
  stripSensitiveChecklist,
  stripSetupDismantle,
} from "../services/projects";
import { autoTickChecklistOnUpload, autoTickPhasePhoto } from "../services/checklistAutoTick";
import { canCreateEvent, getPmsAccess, financeHiddenForUser, isFinanceViewer, isSalesUser } from "../services/pmsAccess";
import { scopeSalesReportsForUser } from "../services/orgScope";
import { audit } from "../services/audit";
import { hasPermission, holdsChecklistApproval, EXPLICIT_APPROVAL_KEYS } from "../services/permissions";
import { recomputeAutoCostLines } from "../services/projectCostRates";
import { attendeeRepId, staffNotOnRoster } from "../services/salesAttending";
import { issueShareToken, revokeShareTokens } from "../services/contractorShare";
import { todayMyt } from "../scm/lib/my-time";
import { canonicalizeVenue } from "../scm/lib/canonical-venue";
import { getDb } from "../db/client";
import {
  project_brands,
  project_finance,
  project_finance_lines,
  projects as projectsTable,
} from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { activeCompanyId, activeCompanySql, requireActiveCompanyId } from "../scm/lib/companyScope";
import { refuseForeignAttachmentKey, refuseForeignChild, refuseForeignProject } from "./lib/project-company-gate";
import { calendarCrewScope } from "./lib/calendar-visibility";
import { masterPostcodeError } from "../scm/shared/master-postcode-rule";

type HandlerCtx = Context<{ Bindings: Env }, "/brands/:id/logo">;
const app = new Hono<{ Bindings: Env }>();


function denyFinance(c: any): Response | null {
  if (financeHiddenForUser(c.get("user"))) {
    return c.json({ error: "You don't have permission to view financial information." }, 403);
  }
  return null;
}


app.get("/event-types", async (c) => {
  const includeInactive = c.req.query("include_inactive") === "1";
  const rows = await c.env.DB.prepare(
    `SELECT id, slug, name, default_template_id, sort_order, active
       FROM project_event_types
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY sort_order, name`
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.post("/event-types", requirePermission("projects.manage"), async (c) => {
  const body = await c.req.json<{
    slug?: string;
    name?: string;
    sort_order?: number;
    default_template_id?: number | null;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const slug =
    (body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")) ||
    "";
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(slug)) {
    return c.json({ error: "slug must be snake_case, start with a letter" }, 400);
  }
  const existing = await c.env.DB.prepare(
    `SELECT id FROM project_event_types WHERE slug = ?`
  )
    .bind(slug)
    .first<{ id: number }>();
  if (existing) return c.json({ error: "Slug already exists" }, 409);

  const r = await c.env.DB.prepare(
    `INSERT INTO project_event_types (slug, name, sort_order, default_template_id, active)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(slug, name, body.sort_order ?? 0, body.default_template_id ?? null)
    .run();
  return c.json({ id: r.meta.last_row_id, slug, name }, 201);
});

app.patch("/event-types/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const body = await c.req.json<{
    name?: string;
    sort_order?: number;
    default_template_id?: number | null;
    active?: boolean;
  }>();
  const sets: string[] = [];
  const binds: any[] = [];
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return c.json({ error: "name cannot be empty" }, 400);
    sets.push("name = ?");
    binds.push(n);
  }
  if (body.sort_order !== undefined) {
    sets.push("sort_order = ?");
    binds.push(body.sort_order);
  }
  if (body.default_template_id !== undefined) {
    sets.push("default_template_id = ?");
    binds.push(body.default_template_id);
  }
  if (body.active !== undefined) {
    sets.push("active = ?");
    binds.push(body.active ? 1 : 0);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  binds.push(id);
  const r = await c.env.DB.prepare(
    `UPDATE project_event_types SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/event-types/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  await c.env.DB.prepare(
    `UPDATE project_event_types SET active = 0 WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});


app.get("/brands", async (c) => {
  const includeInactive = c.req.query("include_inactive") === "1";
  const coSql = activeCompanySql(c);
  const whereClause = includeInactive
    ? (coSql ? `WHERE 1=1${coSql}` : "")
    : `WHERE active = 1${coSql}`;
  const rows = await c.env.DB.prepare(
    `SELECT id, name, color, sort_order, active, logo_r2_key
       FROM project_brands
      ${whereClause}
      ORDER BY sort_order, name`
  ).all<{ id: number; name: string; color: string; sort_order: number; active: number; logo_r2_key: string | null }>();
  const all = rows.results ?? [];
  if (c.req.query("full") !== "1") {
    return c.json({ data: all.map((r) => r.name) });
  }
  return c.json({ data: all });
});

app.post("/brands", requirePermission("projects.manage"), async (c) => {
  const body = await c.req.json<{
    name?: string;
    color?: string;
    sort_order?: number;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const color = normaliseHex(body.color) ?? "64748b";
  const activeCo = activeCompanyId(c);
  const existing = activeCo != null
    ? await c.env.DB.prepare(
        `SELECT id FROM project_brands WHERE LOWER(name) = LOWER(?) AND company_id = ?`
      )
        .bind(name, activeCo)
        .first<{ id: number }>()
    : await c.env.DB.prepare(
        `SELECT id FROM project_brands WHERE LOWER(name) = LOWER(?)`
      )
        .bind(name)
        .first<{ id: number }>();
  if (existing) return c.json({ error: "A brand with that name already exists" }, 409);
  const r = activeCo != null
    ? await c.env.DB.prepare(
        `INSERT INTO project_brands (name, color, sort_order, active, company_id)
         VALUES (?, ?, ?, 1, ?)`
      )
        .bind(name, color, body.sort_order ?? 0, activeCo)
        .run()
    : await c.env.DB.prepare(
        `INSERT INTO project_brands (name, color, sort_order, active)
         VALUES (?, ?, ?, 1)`
      )
        .bind(name, color, body.sort_order ?? 0)
        .run();
  return c.json({ id: r.meta.last_row_id, name, color }, 201);
});

app.patch("/brands/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const brandCoSql = activeCompanySql(c);
  const body = await c.req.json<{
    name?: string;
    color?: string;
    sort_order?: number;
    active?: boolean;
  }>();
  const sets: string[] = [];
  const binds: any[] = [];
  let oldName: string | null = null;
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return c.json({ error: "name cannot be empty" }, 400);
    const cur = await c.env.DB.prepare(
      `SELECT name FROM project_brands WHERE id = ?${brandCoSql}`
    )
      .bind(id)
      .first<{ name: string }>();
    oldName = cur?.name ?? null;
    sets.push("name = ?");
    binds.push(n);
  }
  if (body.color !== undefined) {
    const hex = normaliseHex(body.color);
    if (!hex) return c.json({ error: "color must be 6-char hex" }, 400);
    sets.push("color = ?");
    binds.push(hex);
  }
  if (body.sort_order !== undefined) {
    sets.push("sort_order = ?");
    binds.push(body.sort_order);
  }
  if (body.active !== undefined) {
    sets.push("active = ?");
    binds.push(body.active ? 1 : 0);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  binds.push(id);
  const r = await c.env.DB.prepare(
    `UPDATE project_brands SET ${sets.join(", ")} WHERE id = ?${brandCoSql}`
  )
    .bind(...binds)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);

  if (oldName && body.name && oldName !== body.name.trim()) {
    const newName = body.name.trim();
    await c.env.DB.prepare(
      `UPDATE projects SET brand = ?, updated_at = datetime('now') WHERE brand = ?${brandCoSql}`
    )
      .bind(newName, oldName)
      .run();
    // company-scope: deliberately cross-company — this asks whether ANY other
    // company still owns the old name, which a company predicate would hide,
    // and that answer is what decides the two unscoped cascades below.
    const otherOwner = await c.env.DB.prepare(
      `SELECT 1 AS hit FROM project_brands WHERE name = ? AND id <> ? LIMIT 1`
    )
      .bind(oldName, id)
      .first<{ hit: number }>();
    if (!otherOwner) {
      // company-scope: user_brands and project_cost_rates carry no company_id
      // (nor does users), so no predicate exists to write. The otherOwner check
      // above is what makes this safe: exactly one company owns the old name.
      await c.env.DB.prepare(`UPDATE user_brands SET brand = ? WHERE brand = ?`)
        .bind(newName, oldName)
        .run();
      await c.env.DB.prepare(`UPDATE project_cost_rates SET brand = ? WHERE brand = ?`)
        .bind(newName, oldName)
        .run();
    }
  }
  return c.json({ ok: true });
});

app.delete("/brands/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  // ?hard=1 removes the row entirely (owner 2026-07-23 asked for a real
  // delete on 2990's project_brands after the seed left duplicates like
  // "Happi.S" + "Happi.S Mattress" — soft-delete just hid them from the
  // picker but kept the row). Scoped so a 2990-context request can't
  // touch HOUZS brand rows. mfg_products.branding is free-text (not FK),
  // so an already-set SKU keeps its textual value; the BrandingInput
  // renders it as "(legacy)" until an operator picks a canonical brand.
  const hard = c.req.query("hard") === "1";
  if (hard) {
    await c.env.DB.prepare(
      `DELETE FROM project_brands WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(id)
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE project_brands SET active = 0 WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(id)
      .run();
  }
  return c.json({ ok: true });
});

app.put("/brands/reorder", requirePermission("projects.manage"), async (c) => {
  const body = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(body.ids) || !body.ids.every((n) => Number.isInteger(n))) {
    return c.json({ error: "ids must be an array of integers" }, 400);
  }
  const ids = body.ids as number[];
  if (ids.length === 0) return c.json({ ok: true });
  const coSql = activeCompanySql(c);
  await c.env.DB.batch(
    ids.map((id, idx) =>
      c.env.DB.prepare(`UPDATE project_brands SET sort_order = ? WHERE id = ?${coSql}`)
        .bind((idx + 1) * 10, id),
    ),
  );
  return c.json({ ok: true });
});


const BRAND_LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
};
const BRAND_LOGO_MAX_BYTES = 1 * 1024 * 1024;

const brandLogoKeyOf = (row: unknown): string | null => {
  const r = (row ?? {}) as Record<string, unknown>;
  const v = (r.logoR2Key ?? r.logo_r2_key) as string | null | undefined;
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
};

app.get("/brands/logo", async (c) => {
  const key = c.req.query("key") ?? "";
  if (!key.startsWith("brands/")) {
    return c.json({ error: "key must start with brands/" }, 400);
  }
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "Logo missing" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(obj.body, { headers });
});

app.post("/brands/:id/logo", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const contentType = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = BRAND_LOGO_TYPES[contentType];
  if (!ext) {
    return c.json({ error: "Logo must be a PNG or JPG image" }, 415);
  }
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > BRAND_LOGO_MAX_BYTES) {
    return c.json({ error: "Logo must be under 1 MB" }, 413);
  }

  const brandCoSql = activeCompanySql(c);
  const brand = await c.env.DB.prepare(
    `SELECT id, name, logo_r2_key FROM project_brands WHERE id = ?${brandCoSql}`
  )
    .bind(id)
    .first<{ id: number; name: string; logo_r2_key: string | null }>();
  if (!brand) return c.json({ error: "Not found" }, 404);

  const key = `brands/logo-${id}-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });

  const prevKey = brandLogoKeyOf(brand);
  await c.env.DB.prepare(
    `UPDATE project_brands SET logo_r2_key = ? WHERE id = ?${brandCoSql}`
  )
    .bind(key, id)
    .run();
  if (prevKey && prevKey !== key) {
    try { await c.env.POD_BUCKET.delete(prevKey); } catch { }
  }

  await audit(c, {
    action: "projects.brands",
    entityType: "project_brand",
    entityId: String(id),
    summary: `Brand logo uploaded (${(brand as { name?: string }).name ?? id})`,
    meta: { logo_r2_key: key, bytes: buf.byteLength },
  });
  return c.json({ ok: true, logo_r2_key: key });
});

/**
 * GET /brands/:id/logo
 * Streams the stored brand logo bytes. Any authed user — the Brands
 * manager thumbnail and the SO PDF are drawn client-side by every
 * signed-in user. 404 when no logo is set.
 */
export const getBrandLogoHandler = async (c: HandlerCtx) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const brand = await c.env.DB.prepare(
    `SELECT logo_r2_key FROM project_brands WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(id)
    .first<{ logo_r2_key: string | null }>();
  if (!brand) return c.json({ error: "Not found" }, 404);
  const key = brandLogoKeyOf(brand);
  if (!key) return c.json({ error: "No logo uploaded" }, 404);
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "Logo missing" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=300");
  return new Response(obj.body, { headers });
};
app.get("/brands/:id/logo", getBrandLogoHandler);

/**
 * DELETE /brands/:id/logo
 * Clears the logo pointer and best-effort deletes the object — the SO
 * PDF falls back to the company letterhead logo.
 */
export const deleteBrandLogoHandler = async (c: HandlerCtx) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const brandCoSql = activeCompanySql(c);
  const brand = await c.env.DB.prepare(
    `SELECT logo_r2_key FROM project_brands WHERE id = ?${brandCoSql}`
  )
    .bind(id)
    .first<{ logo_r2_key: string | null }>();
  if (!brand) return c.json({ error: "Not found" }, 404);
  const prevKey = brandLogoKeyOf(brand);
  if (prevKey) {
    await c.env.DB.prepare(
      `UPDATE project_brands SET logo_r2_key = NULL WHERE id = ?${brandCoSql}`
    )
      .bind(id)
      .run();
    try { await c.env.POD_BUCKET.delete(prevKey); } catch { }
  }
  await audit(c, {
    action: "projects.brands",
    entityType: "project_brand",
    entityId: String(id),
    summary: "Brand logo removed",
    meta: { logo_r2_key: prevKey },
  });
  return c.json({ ok: true });
};
app.delete("/brands/:id/logo", requirePermission("projects.manage"), deleteBrandLogoHandler);

app.put("/event-types/reorder", requirePermission("projects.manage"), async (c) => {
  const body = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(body.ids) || !body.ids.every((n) => Number.isInteger(n))) {
    return c.json({ error: "ids must be an array of integers" }, 400);
  }
  const ids = body.ids as number[];
  if (ids.length === 0) return c.json({ ok: true });
  await c.env.DB.batch(
    ids.map((id, idx) =>
      c.env.DB.prepare(`UPDATE project_event_types SET sort_order = ? WHERE id = ?`)
        .bind((idx + 1) * 10, id),
    ),
  );
  return c.json({ ok: true });
});

function normaliseHex(input: string | undefined | null): string | null {
  if (!input) return null;
  const v = String(input).trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(v)) return null;
  return v;
}


app.get("/cost-rates", requirePageAccess("projects.finances"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT cr.brand,
            cr.transport_pct, cr.merchandise_pct,
            cr.commission_normal_pct, cr.commission_boost_pct,
            cr.boost_min_gp_pct, cr.boost_min_sales,
            cr.updated_at
       FROM project_cost_rates cr
       JOIN project_brands pb ON pb.name = cr.brand
      WHERE pb.active = 1${(() => { const id = activeCompanyId(c); return id != null ? ` AND pb.company_id = ${id}` : ""; })()}
      ORDER BY pb.sort_order ASC, pb.name ASC`,
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.put("/cost-rates/:brand", requirePermission("projects.manage"), async (c) => {
  const brand = decodeURIComponent(c.req.param("brand")).trim();
  if (!brand) return c.json({ error: "brand required" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    transport_pct?: number;
    merchandise_pct?: number;
    commission_normal_pct?: number;
    commission_boost_pct?: number | null;
    boost_min_gp_pct?: number | null;
    boost_min_sales?: number | null;
  }>();

  const num = (v: unknown, fallback: number | null = null) => {
    if (v === null || v === "" || v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
  };
  const fields = {
    transport_pct: num(body.transport_pct, 0) ?? 0,
    merchandise_pct: num(body.merchandise_pct, 0) ?? 0,
    commission_normal_pct: num(body.commission_normal_pct, 0) ?? 0,
    commission_boost_pct: num(body.commission_boost_pct, null),
    boost_min_gp_pct: num(body.boost_min_gp_pct, null),
    boost_min_sales: num(body.boost_min_sales, null),
  };

  const upd = await c.env.DB.prepare(
    `UPDATE project_cost_rates
        SET transport_pct = ?, merchandise_pct = ?,
            commission_normal_pct = ?, commission_boost_pct = ?,
            boost_min_gp_pct = ?, boost_min_sales = ?,
            updated_at = datetime('now'), updated_by = ?
      WHERE brand = ?`,
  )
    .bind(
      fields.transport_pct, fields.merchandise_pct,
      fields.commission_normal_pct, fields.commission_boost_pct,
      fields.boost_min_gp_pct, fields.boost_min_sales,
      user?.id ?? null, brand,
    )
    .run();

  if ((upd.meta?.changes ?? 0) === 0) {
    await c.env.DB.prepare(
      `INSERT INTO project_cost_rates
         (brand, transport_pct, merchandise_pct,
          commission_normal_pct, commission_boost_pct,
          boost_min_gp_pct, boost_min_sales, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        brand,
        fields.transport_pct, fields.merchandise_pct,
        fields.commission_normal_pct, fields.commission_boost_pct,
        fields.boost_min_gp_pct, fields.boost_min_sales,
        user?.id ?? null,
      )
      .run();
  }

  // Recompute auto lines for every active project on this brand.
  // Done synchronously so the rate edit is visible immediately —
  // typical cohorts are small (≤ 50 projects per brand).
  //
  // Company scope (owner audit 2026-07-22): the recompute cascade was
  // cross-company — a brand rate edited in company A also re-costed A's
  // projects AND B's projects that happen to share the brand. Scope to the
  // caller's active company so only their own project cohort is touched.
  const projects = await c.env.DB.prepare(
    `SELECT id FROM projects WHERE brand = ? AND archived_at IS NULL${activeCompanySql(c)}`,
  )
    .bind(brand)
    .all<{ id: number }>();
  for (const p of projects.results ?? []) {
    await recomputeAutoCostLines(c.env, p.id, user?.id ?? 0);
  }

  return c.json({ ok: true, recomputed: projects.results?.length ?? 0 });
});

app.post("/fair-report/match", requirePermission("projects.read"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { sheets?: { name?: string; rows?: unknown[][] }[] };
  const sheets = Array.isArray(body.sheets) ? body.sheets : [];
  const projRes = await c.env.DB.prepare(
    `SELECT id, code, name, start_date, end_date, venue, brand
       FROM projects
      WHERE archived_at IS NULL${activeCompanySql(c, "company_id")}`
  ).all<{ id: number; code: string; name: string; start_date: string; end_date: string; venue: string; brand: string }>();
  const projects = projRes.results ?? [];

  const events = [];
  for (const s of sheets) {
    const ev = parseFairSheet(String(s.name ?? ""), (s.rows ?? []) as (string | number | null)[][]);
    if (!ev) continue;
    const evVenue = ev.venue.toUpperCase();
    const evBrand = ev.brand.toUpperCase();
    const candidates = projects
      .filter((p) => {
        const pv = String(p.venue ?? "").toUpperCase();
        const pb = String(p.brand ?? "").toUpperCase();
        if (!pb || pb !== evBrand) return false;
        if (!pv || !evVenue) return false;
        return pv.startsWith(evVenue) || evVenue.startsWith(pv) || pv.includes(evVenue) || evVenue.includes(pv);
      })
      .map((p) => ({ id: p.id, code: p.code, name: p.name, startDate: p.start_date, venue: p.venue }));
    events.push({ event: ev, financeLines: eventToFinanceLines(ev), candidates });
  }
  return c.json({ events, projectCount: projects.length });
});

app.post("/:id/fair-report/apply", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { lines?: { kind?: string; category?: string; amount?: number }[] };
  const lines = Array.isArray(body.lines) ? body.lines : [];

  const proj = await c.env.DB.prepare(
    `SELECT start_date FROM projects WHERE id = ?${activeCompanySql(c, "company_id")}`
  ).bind(id).first<{ start_date: string }>();
  if (!proj) return c.json({ error: "project not found" }, 404);

  const existing = await c.env.DB.prepare(
    `SELECT DISTINCT kind, category FROM project_finance_lines WHERE project_id = ? AND archived_at IS NULL`
  ).bind(id).all<{ kind: string; category: string }>();
  const have = new Set((existing.results ?? []).map((r) => `${r.kind}|${r.category}`));

  let created = 0;
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const ln of lines) {
    const kind = ln.kind === "income" ? "income" : ln.kind === "cost" ? "cost" : null;
    const category = String(ln.category ?? "").trim();
    const amount = Number(ln.amount);
    if (!kind || !category || !Number.isFinite(amount) || amount < 0) { errors.push(`invalid line: ${category || "?"}`); continue; }
    if (have.has(`${kind}|${category}`)) { skipped.push(category); continue; }
    try {
      await createLedgerLine(
        c.env,
        { project_id: id, kind, category, amount, description: "Fair report (agent)", occurred_at: proj.start_date ?? null, r2_key: null, file_name: null, mime_type: null, notes: null },
        user?.id ?? 0
      );
      created += 1;
    } catch (e: unknown) { errors.push(e instanceof Error ? e.message : "failed"); }
  }
  return c.json({ created, skipped, errors });
});

const RECONCILE_MODEL = "claude-sonnet-4-6";
const RECONCILE_URL = "https://api.anthropic.com/v1/messages";
app.post("/schedule-reconcile/scan", requirePermission("projects.write"), async (c) => {
  const apiKey = (c.env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
  if (!apiKey) return c.json({ error: "anthropic_key_missing", reason: "ANTHROPIC_API_KEY is not set." }, 400);

  let files: File[] = [];
  try {
    const form = await c.req.formData();
    files = form.getAll("file").filter((f): f is File => f instanceof File);
  } catch { return c.json({ error: "invalid_form" }, 400); }
  const { blocks, error: fileErr } = await buildFileBlocks(files);
  if (fileErr) return c.json({ error: "bad_file", reason: fileErr }, 400);
  if (blocks.length === 0) return c.json({ error: "no_file", reason: "Attach the schedule image." }, 400);

  const sys = `You read a Malaysian roadshow / exhibition ORGANIZER's event schedule (a poster or flyer image). Extract the organizer name and EVERY listed event. Return ONLY JSON of the shape {"organizer": string, "events": [{"venue": string, "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "status": "active"|"cancelled"|"postponed"|null}]}. A range like "13-15 MAR" means startDate = the 13th and endDate = the 15th; infer the YEAR from the image (e.g. a big "2026"). Use the venue text exactly as shown. If a row is struck out or marked cancelled/postponed, set status accordingly, else "active". No commentary, JSON only.`;

  let extract: { organizer: string; events: { venue: string; startDate: string | null; endDate: string | null; status?: string | null }[] };
  try {
    const resp = await recordAi(requestAiTag(c, "schedule_reconcile", RECONCILE_MODEL), fetch(RECONCILE_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: RECONCILE_MODEL, max_tokens: 2000, system: sys,
        messages: [{ role: "user", content: [...blocks, { type: "text", text: "Extract the schedule as JSON." }] }],
      }),
    }));
    if (!resp.ok) return c.json({ error: "extract_failed", reason: `vision ${resp.status}` }, 502);
    const data = (await resp.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const jsonStr = (text.match(/\{[\s\S]*\}/) ?? [text])[0];
    extract = JSON.parse(jsonStr);
  } catch (e) {
    return c.json({ error: "extract_failed", reason: e instanceof Error ? e.message : "vision failed" }, 502);
  }
  if (!extract || !Array.isArray(extract.events)) return c.json({ error: "extract_empty" }, 502);

  const org = String(extract.organizer ?? "").trim();
  const projRes = await c.env.DB.prepare(
    `SELECT id, code, name, venue, start_date, end_date, stage
       FROM projects
      WHERE archived_at IS NULL${activeCompanySql(c, "company_id")}
        AND UPPER(COALESCE(organizer,'')) LIKE ?`
  ).bind(`%${org.toUpperCase()}%`).all<{ id: number; code: string; name: string; venue: string; start_date: string; end_date: string; stage: string }>();
  const projects: ProjRow[] = (projRes.results ?? []).map((p) => ({
    id: p.id, code: p.code, name: p.name, venue: p.venue, startDate: p.start_date, endDate: p.end_date, stage: p.stage,
  }));

  const rows = reconcileSchedule({ organizer: org, events: extract.events }, projects);
  return c.json({ organizer: org, projectCount: projects.length, rows });
});

app.post("/setup-invoice/scan", requirePermission("projects.write"), async (c) => {
  const apiKey = (c.env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
  if (!apiKey) return c.json({ error: "anthropic_key_missing", reason: "ANTHROPIC_API_KEY is not set." }, 400);
  let files: File[] = [];
  try {
    const form = await c.req.formData();
    files = form.getAll("file").filter((f): f is File => f instanceof File);
  } catch { return c.json({ error: "invalid_form" }, 400); }
  const { blocks, error: fileErr } = await buildFileBlocks(files);
  if (fileErr) return c.json({ error: "bad_file", reason: fileErr }, 400);
  if (blocks.length === 0) return c.json({ error: "no_file", reason: "Attach the invoice image." }, 400);

  const sys = `You read a Malaysian booth / setup / renovation INVOICE or QUOTATION (usually a scanned photo). Extract ONLY JSON of the shape {"vendor": string|null, "currency": string, "totalRM": number, "items": [{"description": string, "amountRM": number}]}. "vendor" is the company that ISSUED the invoice (the supplier / contractor), NOT the recipient. "totalRM" is the GRAND TOTAL in Ringgit. If a value is unclear, use null / []. No commentary, JSON only.`;

  let parsed: { vendor?: string | null; currency?: string; totalRM?: number; items?: { description?: string; amountRM?: number }[] };
  try {
    const resp = await recordAi(requestAiTag(c, "setup_invoice_extract", RECONCILE_MODEL), fetch(RECONCILE_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: RECONCILE_MODEL, max_tokens: 2000, system: sys,
        messages: [{ role: "user", content: [...blocks, { type: "text", text: "Extract the invoice as JSON." }] }],
      }),
    }));
    if (!resp.ok) return c.json({ error: "extract_failed", reason: `vision ${resp.status}` }, 502);
    const data = (await resp.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const jsonStr = (text.match(/\{[\s\S]*\}/) ?? [text])[0];
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return c.json({ error: "extract_failed", reason: e instanceof Error ? e.message : "vision failed" }, 502);
  }

  const projRes = await c.env.DB.prepare(
    `SELECT id, code, name, start_date FROM projects
      WHERE archived_at IS NULL${activeCompanySql(c, "company_id")}
      ORDER BY COALESCE(start_date, created_at) DESC LIMIT 200`
  ).all<{ id: number; code: string; name: string; start_date: string }>();

  return c.json({
    vendor: parsed.vendor ?? null,
    currency: parsed.currency ?? "RM",
    totalRM: Number(parsed.totalRM) || 0,
    items: (Array.isArray(parsed.items) ? parsed.items : []).map((it) => ({ description: String(it.description ?? ""), amountRM: Number(it.amountRM) || 0 })),
    projects: (projRes.results ?? []).map((p) => ({ id: p.id, code: p.code, name: p.name, startDate: p.start_date })),
  });
});

app.post("/:id/setup-invoice/apply", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { vendor?: string; amountRM?: number; note?: string };
  const amount = Number(body.amountRM);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: "invalid_amount", reason: "amountRM must be a positive number" }, 400);

  const proj = await c.env.DB.prepare(
    `SELECT start_date FROM projects WHERE id = ?${activeCompanySql(c, "company_id")}`
  ).bind(id).first<{ start_date: string }>();
  if (!proj) return c.json({ error: "project not found" }, 404);

  const vendor = String(body.vendor ?? "").trim();
  try {
    const r = await createLedgerLine(
      c.env,
      { project_id: id, kind: "cost", category: "setup", amount, description: vendor ? `Setup - ${vendor}` : "Setup (invoice)", occurred_at: proj.start_date ?? null, notes: (body.note ?? null), r2_key: null, file_name: null, mime_type: null },
      user?.id ?? 0
    );
    return c.json({ id: r.id, created: 1 });
  } catch (e: unknown) {
    return c.json({ error: "apply_failed", reason: e instanceof Error ? e.message : "failed" }, 400);
  }
});

app.post("/:id/finance/recompute-auto", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  await recomputeAutoCostLines(c.env, id, user?.id ?? 0);
  return c.json({ ok: true });
});


app.get("/summary", requirePageAccess("projects.list"), async (c) => {
  const coSql = activeCompanySql(c);
  const byStage = await c.env.DB.prepare(
    `SELECT stage, COUNT(*) as count
       FROM projects WHERE archived_at IS NULL${coSql}
      GROUP BY stage`
  ).all();

  const upcoming = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM projects
      WHERE archived_at IS NULL${coSql}
        AND stage NOT IN ('closed','cancelled')
        AND start_date IS NOT NULL
        AND substr(start_date, 1, 10) >= ?
        AND substr(start_date, 1, 10) <= ?`
  )
    .bind(todayMyt(), todayMyt(30))
    .first<{ count: number }>();

  const live = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM projects
      WHERE archived_at IS NULL${coSql} AND stage = 'live'`
  ).first<{ count: number }>();

  const overdueTasks = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
      WHERE p.archived_at IS NULL${activeCompanySql(c, "p.company_id")}
        AND c.status = 'pending'
        AND c.due_date IS NOT NULL
        AND substr(c.due_date, 1, 10) < ?`
  )
    .bind(todayMyt())
    .first<{ count: number }>();

  return c.json({
    by_stage: byStage.results ?? [],
    upcoming_30d: upcoming?.count ?? 0,
    live_count: live?.count ?? 0,
    overdue_tasks: overdueTasks?.count ?? 0,
  });
});


app.get("/", requirePageAccess("projects.list"), async (c) => {
  const eventTypeParam = c.req.query("event_type_id");
  const yearParam = c.req.query("year");
  const monthParam = c.req.query("month");
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");
  const user = c.get("user");
  let pendingLabel: string | undefined;
  let pendingTitle: string | undefined;
  let pendingLogistic = false;
  let pendingApprove: string[] | undefined;
  let pendingDirector: { stock?: boolean; stock_titles?: string[]; agreement?: boolean; sales_attending?: boolean; sales_pic?: boolean } | undefined;
  /** Brands a brand-scoped approver owns (owner 2026-08-10). Empty = all. */
  let approverBrands: string[] | undefined;
  let pendingSalesAttending = false;
  let pendingAgreement = false;
  let pendingDefectReview = false;
  let pendingDefectReviewExclude = false;
  if (c.req.query("my_pending") === "1" && user) {
    // Owner 2026-07-13 — staged "My Pending". Approvers (anyone holding a
    // checklist approval permission, or `*`) see ONLY the items awaiting
    // their approval. Everyone else is mapped to their role's task scope.
    // listProjects then time-gates every lane (a task only surfaces once its
    // due date is reached) and applies the stage prerequisites.
    const granted = user.permissions_set ?? user.permissions;
    /* ONLY permissions that a checklist item can actually CARRY as
       required_perm belong in this list — taking the approver branch replaces
       the role fallback below, so a permission that gates nothing makes the
       EXISTS on pc.required_perm match zero rows and empties the holder's
       "My Pending" instead of showing them their role's tasks. Granting the
       permission BROKE the person (reported live: Peter, 2026-07-16).

       `projects.approve` is the ONLY value ever written to
       project_checklist.required_perm: migrations 021/050/066 seed it and
       nothing else, and instantiateChecklistFromEventType
       (services/projects.ts) derives it from requires_review. Every other row
       is NULL.

       `agreement.approve` and `stock_transfer.approve` are DECLARED in
       services/permissions.ts and stay toggleable in Team > Positions (owner
       2026-07-16 — keep the switches, the feature is "暂时没用"), but no
       checklist item carries them, so they were only ever able to subtract.
       DO NOT re-add a key here until an item actually seeds it as
       required_perm: the switch existing is not the same as the gate
       existing. */
    const GATING_APPROVE_PERMS = ["projects.approve"];
    const held = GATING_APPROVE_PERMS.filter((p) => hasPermission(granted, p));
    const heldExplicit = [...EXPLICIT_APPROVAL_KEYS].filter((k) =>
      holdsChecklistApproval(granted, k),
    );
    const r = (user.role_name || "").toLowerCase();
    if (r.includes("bd")) {
      // BD (owner 2026-07-29 "why empty my pending"): the BD role now holds
      // projects.approve (full grant 2026-07-23), so the approve-holder branch
      // below swallowed them and their OWN BD-badged work (License / Stamp
      // Duty / Agreement upload) never surfaced — My Pending showed only
      // things awaiting approval, usually nothing. BD gets BOTH: the BD task
      // lane AND the approver lanes.
      pendingLabel = "BD";
      if (held.length > 0 || heldExplicit.length > 0) pendingApprove = [...new Set([...held, ...heldExplicit])];
      pendingAgreement = true;
    } else if (held.length > 0) {
      // Super Admin / owner (weisiang): what they must approve, PLUS the
      // Agreement / Quotation once its timeline arrives (owner 2026-07-21).
      pendingApprove = [...new Set([...held, ...heldExplicit])];
      pendingAgreement = true;
    } else if (r.includes("sales director")) {
      // Peter / Kingsley (owner 2026-07-21, tightened 2026-07-23): exactly
      // three duties — approve submitted stock docs, set the Sales
      // PIC, set the Sales Attending reps. The staffing lanes wait for the
      // CONTRACT section to clear, so contract-stage projects stay out of
      // their list. (They do NOT hold projects.approve, so they previously
      // fell through to SALES PIC.)
      // Which stock documents = which keys this director explicitly holds
      // (2026-08-21): stock_transfer.approve -> Stock Out,
      // stock_in.approve -> Stock In. Historical default (no keys, legacy
      // config) keeps Stock Out only.
      const stockTitles = [
        ...(heldExplicit.includes("stock_transfer.approve") ? ["Stock Out Transfer Record"] : []),
        ...(heldExplicit.includes("stock_in.approve") ? ["Stock In Transfer Record"] : []),
      ];
      pendingDirector = {
        stock: true,
        stock_titles: stockTitles.length ? stockTitles : undefined,
        sales_attending: true,
        sales_pic: true,
      };
      // Brand split (owner 2026-08-10: Kris takes AKEMI + ERGOTEX stock-outs,
      // Peter takes ZANOTTI). A director configured with user_brands rows only
      // sees those brands in the APPROVAL lane; one with no rows keeps every
      // brand, so Peter / Kingsley are unaffected.
      const kb = await c.env.DB.prepare(
        `SELECT brand FROM user_brands WHERE user_id = ?`
      )
        .bind(user.id)
        .all<{ brand: string }>();
      const kbList = (kb.results ?? []).map((x) => (x.brand ?? "").trim()).filter(Boolean);
      if (kbList.length) approverBrands = kbList;
    } else if (r === "purchaser") pendingLabel = "PURCHASER";
    else if (r === "logistic") pendingLogistic = true;
    else if (r === "ops exec") {
      // Nancy (owner 2026-08-11): the Ops Exec reviews defects for the region
      // warehouse states (Penang/Kelantan/Terengganu/Perak) BEFORE they reach
      // the purchaser. Keyed on her UNIQUE role — her position "Operation
      // Executive" is shared with the purchasers Sim/Farra. Scoped to the region
      // states only (exclude = false).
      pendingDefectReview = true;
    } else if (isDefectReviewerPosition(user)) {
      // Shukor (owner 2026-08-07; region split 2026-08-11): the Storekeeper
      // Supervisor triages fresh defects for every state OUTSIDE Nancy's region
      // (the second warehouse). Keyed on POSITION, not role — his role is the
      // shared "Storekeeper", so the driver/helper/storekeeper arm below would
      // otherwise cage him to his own crewed events. NOT crew-scoped (see
      // assigned_user_id below).
      pendingDefectReview = true;
      pendingDefectReviewExclude = true;
    } else if (r === "driver" || r === "helper" || r === "storekeeper") pendingLabel = "DRIVER";
    else if (r.includes("sales")) {
      pendingLabel = "SALES PIC";
      pendingSalesAttending = true;
    } else if (r === "manager") pendingTitle = "Agreement / Quotation";
  }
  const result = await listProjects(c.env, {
    company_id: activeCompanyId(c),
    with_pnl: !financeHiddenForUser(user),
    pending_label: pendingLabel,
    pending_title: pendingTitle,
    pending_logistic: pendingLogistic,
    pending_approve: pendingApprove,
    pending_director: pendingDirector,
    approver_brands: approverBrands,
    pending_sales_attending: pendingSalesAttending || undefined,
    pending_agreement: pendingAgreement || undefined,
    pending_defect_review: pendingDefectReview || undefined,
    pending_defect_review_states: pendingDefectReview ? DEFECT_REVIEW_REGION_STATES : undefined,
    pending_defect_review_exclude: pendingDefectReviewExclude || undefined,
    stage: c.req.query("stage"),
    // Date-derived event phase for the field/sales slim bar (owner 2026-07-21).
    // Only "setup" | "dismantle" are honoured; anything else is ignored.
    phase:
      c.req.query("phase") === "setup" || c.req.query("phase") === "dismantle"
        ? (c.req.query("phase") as "setup" | "dismantle")
        : undefined,
    brand: c.req.query("brand"),
    organizer: c.req.query("organizer") || undefined,
    state: c.req.query("state") || undefined,
    event_type_id: eventTypeParam ? parseInt(eventTypeParam, 10) : undefined,
    section: c.req.query("section") || undefined,
    // Outstanding-task filter (owner 2026-08-05) — exact checklist title.
    task_pending: c.req.query("task_pending") || undefined,
    status: c.req.query("status") || undefined,
    exclude_done: c.req.query("exclude_done") === "1",
    search: c.req.query("search"),
    // Passed through as-is: may be a single value OR a comma-separated
    // multi-select list (owner 2026-08-07). listProjects validates each entry
    // (4-digit year / 1-12 month) and binds them individually.
    year: yearParam || undefined,
    month: monthParam || undefined,
    from: fromParam || undefined,
    to: toParam || undefined,
    page: parseInt(c.req.query("page") || "1", 10),
    per_page: parseInt(c.req.query("per_page") || "50", 10),
    include_archived: c.req.query("include_archived") === "1",
    sort_by: c.req.query("sort_by") || undefined,
    sort_dir: (c.req.query("sort_dir") || "").toLowerCase() === "asc" ? "asc" : "desc",
    // "Assigned to me" (owner 2026-07-16): drivers/helpers can pull just the
    // events they're crewed on (FK cols or crew JSON name match).
    // Owner 2026-07-21: for helpers/storekeepers this is FORCED — they only
    // ever see their assigned events (isCrewScopedUser).
    // The defect-review lane (Storekeeper Supervisor, owner 2026-08-07) is NOT
    // crew-caged: skip the forced assigned-to-me filter so Shukor sees every
    // event with a fresh defect, not only the ones he is crewed on.
    assigned_user_id:
      !pendingDefectReview && (isCrewScopedUser(user) || c.req.query("assigned_to_me") === "1")
        ? user?.id
        : undefined,
    assigned_user_name:
      !pendingDefectReview && (isCrewScopedUser(user) || c.req.query("assigned_to_me") === "1")
        ? user?.name ?? undefined
        : undefined,
    // Crew list cards show the caller's own due pending tasks (owner
    // 2026-07-21): drivers/helpers/storekeepers all work the DRIVER-badged
    // items, so every crew caller gets the DRIVER titles attached per row.
    // Owner 2026-07-22 (Syu report): in My Pending mode EVERY role-lane
    // caller gets their own titles — the cards tag the caller's pending
    // work, not the project's section. pendingLabel is only set when
    // my_pending=1; logistic pending isn't a checklist item, so it gets its
    // own derived-title flag.
    // Defect reviewer (Shukor) is crew-positioned but his chip is neither the
    // DRIVER title nor a role_label match — it is a derived "Review Defect
    // Items" step (pending_titles_defect_review), so suppress the DRIVER default.
    pending_titles_label: pendingDefectReview
      ? undefined
      : isCrewScopedUser(user) || /^(driver|helper|storekeeper)$/i.test(user?.role_name ?? "")
        ? "DRIVER"
        : pendingLabel,
    pending_titles_defect_review: pendingDefectReview || undefined,
    pending_titles_logistic: pendingLogistic || undefined,
  });
  if (financeHiddenForUser(user) && Array.isArray((result as any).data)) {
    (result as any).data = (result as any).data.map((r: any) => ({
      ...r,
      rental: null,
      total_sales: null,
      contractor_cost: null,
      fin_revenue: null,
      fin_cogs: null,
      fin_cogs_matt_sofa: null,
      fin_cogs_bedframe: null,
      fin_cogs_accessories: null,
      fin_rental: null,
      fin_total_cost: null,
    }));
  }
  return c.json(result);
});

app.get("/states", (c) => c.json({ data: MALAYSIA_STATES }));
app.get("/payment-statuses", (c) => c.json({ data: PAYMENT_STATUSES }));

app.get("/sections-distinct", requirePageAccess("projects"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.name, s.sort_order
       FROM project_checklist_template_sections s
      WHERE s.template_id = (
        SELECT MAX(t.id) FROM project_checklist_templates t
         WHERE t.active = 1${activeCompanySql(c, "t.company_id")}
      )
      ORDER BY s.sort_order, s.id`
  ).all<{ name: string; sort_order: number }>();
  return c.json({ data: (rows.results ?? []).map((r) => r.name) });
});

// Distinct TASK titles for the project-list "task not completed" filter (owner
// 2026-08-05: "booth layout for display, 3D, 2D, stock out transfer … make it
// drop down. and i can filter which task is not complete yet"). The pickable
// titles are every task that ACTUALLY EXISTS on a non-archived event of the
// active company — NOT just the newest template (owner 2026-11-23: Filled /
// Blank Floorplan were missing). Several templates are active at once and older
// events keep their own tasks, so a template-only list hid real pending work
// (e.g. 180 Filled Floorplan pending). Each title's section + order is resolved
// from the newest active template that still defines it; a title no template
// defines any more has a null section (the frontend buckets those under
// "Other" with no whole-section row).
app.get("/task-titles-distinct", requirePageAccess("projects"), async (c) => {
  const rows = await c.env.DB.prepare(
    `WITH live_titles AS (
       SELECT DISTINCT c.title AS title
         FROM project_checklist c
         JOIN projects p ON p.id = c.project_id
        WHERE p.archived_at IS NULL
          AND COALESCE(c.title, '') <> ''
          ${activeCompanySql(c, "p.company_id")}
     ),
     title_section AS (
       SELECT i.title AS title, s.name AS section_name,
              s.sort_order AS section_order, i.seq AS seq,
              ROW_NUMBER() OVER (
                PARTITION BY i.title
                ORDER BY t.id DESC, s.sort_order, i.seq
              ) AS rn
         FROM project_checklist_template_items i
         JOIN project_checklist_templates t ON t.id = i.template_id
         LEFT JOIN project_checklist_template_sections s ON s.id = i.section_id
        WHERE t.active = 1${activeCompanySql(c, "t.company_id")}
     )
     SELECT lt.title, ts.section_name, ts.section_order, ts.seq
       FROM live_titles lt
       LEFT JOIN title_section ts ON ts.title = lt.title AND ts.rn = 1
      ORDER BY COALESCE(ts.section_order, 9999), COALESCE(ts.seq, 9999), lt.title`
  ).all<{ title: string; section_name: string | null; section_order: number | null; seq: number }>();
  const seen = new Set<string>();
  const data: { title: string; section: string | null }[] = [];
  for (const r of rows.results ?? []) {
    const t = (r.title ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    data.push({ title: t, section: r.section_name ?? null });
  }
  return c.json({ data });
});


app.get("/organizers", requirePageAccess("projects"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, notes, active FROM project_organizers
      WHERE active = 1 ORDER BY name`
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.post("/organizers", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string; notes?: string }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const existing = await c.env.DB.prepare(
    `SELECT id, name FROM project_organizers WHERE LOWER(name) = LOWER(?)`
  )
    .bind(name)
    .first<{ id: number; name: string }>();
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE project_organizers SET active = 1 WHERE id = ?`
    )
      .bind(existing.id)
      .run();
    return c.json({ id: existing.id, name: existing.name }, 200);
  }
  const r = await c.env.DB.prepare(
    `INSERT INTO project_organizers (name, notes, created_by)
     VALUES (?, ?, ?)`
  )
    .bind(name, body.notes ?? null, user?.id ?? null)
    .run();
  return c.json({ id: r.meta.last_row_id, name }, 201);
});

app.patch("/organizers/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const clash = await c.env.DB.prepare(
    `SELECT id FROM project_organizers
      WHERE LOWER(name) = LOWER(?) AND id <> ? AND active = 1`
  )
    .bind(name, id)
    .first<{ id: number }>();
  if (clash) return c.json({ error: "An organizer with that name already exists" }, 409);
  const cur = await c.env.DB.prepare(
    `SELECT name FROM project_organizers WHERE id = ?`
  )
    .bind(id)
    .first<{ name: string }>();
  const oldName = cur?.name ?? null;
  await c.env.DB.prepare(
    `UPDATE project_organizers SET name = ? WHERE id = ?`
  )
    .bind(name, id)
    .run();
  if (oldName && oldName.trim() !== name) {
    const orgCoSql = activeCompanySql(c);
    await c.env.DB.prepare(
      `UPDATE projects SET organizer = ?, updated_at = datetime('now') WHERE organizer = ?${orgCoSql}`
    )
      .bind(name, oldName)
      .run();
  }
  return c.json({ id, name });
});

app.delete("/organizers/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await c.env.DB.prepare(
    `UPDATE project_organizers SET active = 0 WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});


app.get("/contractors", requirePageAccess("projects"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, notes, active, share_export_scope FROM project_contractors
      WHERE active = 1 ORDER BY name`
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.post("/contractors", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string; notes?: string }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const existing = await c.env.DB.prepare(
    `SELECT id, name FROM project_contractors WHERE LOWER(name) = LOWER(?)`
  )
    .bind(name)
    .first<{ id: number; name: string }>();
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE project_contractors SET active = 1 WHERE id = ?`
    )
      .bind(existing.id)
      .run();
    return c.json({ id: existing.id, name: existing.name }, 200);
  }
  const r = await c.env.DB.prepare(
    `INSERT INTO project_contractors (name, notes, created_by)
     VALUES (?, ?, ?)`
  )
    .bind(name, body.notes ?? null, user?.id ?? null)
    .run();
  return c.json({ id: r.meta.last_row_id, name }, 201);
});

app.delete("/contractors/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await c.env.DB.prepare(
    `UPDATE project_contractors SET active = 0 WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// What this contractor's public link exports on one press: the month on screen
// or the whole year (owner 2026-09-09; mig 20260909T0800). A row setting, not a
// list of names in code, so the office flips it from Project Maintenance.
app.patch("/contractors/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{ share_export_scope?: string }>();
  const scope = body.share_export_scope;
  if (scope !== "month" && scope !== "year") return c.json({ error: "share_export_scope must be month or year" }, 400);
  await c.env.DB.prepare(`UPDATE project_contractors SET share_export_scope = ? WHERE id = ?`).bind(scope, id).run();
  return c.json({ ok: true });
});


app.post("/contractors/:id/share-link", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT name FROM project_contractors WHERE id = ?`
  )
    .bind(id)
    .first<{ name: string }>();
  if (!row) return c.json({ error: "Contractor not found" }, 404);
  const token = await issueShareToken(c.env, row.name, user?.id ?? null);
  return c.json({ token });
});

app.delete("/contractors/:id/share-link", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT name FROM project_contractors WHERE id = ?`
  )
    .bind(id)
    .first<{ name: string }>();
  if (!row) return c.json({ error: "Contractor not found" }, 404);
  await revokeShareTokens(c.env, row.name);
  return c.json({ ok: true });
});

type VenueBody = { name?: string; state?: string | null; country?: string | null; city?: string | null; postcode?: string | null; size?: string | null; notes?: string | null };
const blankToNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);


app.get("/venues", requirePageAccess("projects"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, state, country, city, postcode, size, notes, active FROM project_venues
      WHERE active = 1${activeCompanySql(c)} ORDER BY name`
  ).all();
  type VenueOut = Record<string, unknown> & { name?: unknown; origin: 'PROJECT' | 'SHOWROOM' };
  const projectVenues: VenueOut[] = ((rows.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    origin: "PROJECT" as const,
  }));

  /* SHOWROOM VENUES (owner 2026-07-19) — "the Venue list should be fed from
     project venues AND from warehouses flagged as Showroom".
     OPT-IN via ?includeShowrooms=1, NOT on by default: this endpoint is also
     the Project Maintenance venue master's own CRUD list, and quietly mixing
     non-editable synthetic rows into it would make Project Maintenance offer to
     rename or delete things it does not own. Sales Maintenance and the SO venue
     picker pass the flag; PMS does not. */
  const includeShowrooms =
    c.req.query("includeShowrooms") === "1" || c.req.query("includeShowrooms") === "true";
  if (!includeShowrooms) return c.json({ data: projectVenues });

  let showroomVenues: VenueOut[] = [];
  try {
    /* Company-scoped, same rule as the project_venues half above. scm.warehouses
       carries company_id (mig 0086; 0087 made its code unique per company), and
       without the predicate a HOUZS user raising a project or an SO saw 2990's
       showrooms in the venue picker. Owner 2026-08-19: "客人开单不能看到 2990 的
       展厅啊。分开的公司都不一样啊，收入单也不一样。venue 都不一样啊" and "我们的
       Venue、我们的 Warehouse、我们的 Showroom 等等，都是跟着看到自己公司的".
       GET /staff/showrooms (scm/routes/staff.ts) already scoped its copy of this
       same list; this one was the half that was missed. */
    const shRows = await c.env.DB.prepare(
      `SELECT id, code, name, venue_name FROM scm.warehouses
        WHERE is_showroom = true AND is_active = true
          AND venue_name IS NOT NULL AND btrim(venue_name) <> ''
          ${activeCompanySql(c, "company_id")}
        ORDER BY venue_name`
    ).all();
    const seen = new Set(
      projectVenues.map((v) => String(v.name ?? "").trim().toLowerCase()).filter(Boolean),
    );
    showroomVenues = ((shRows.results ?? []) as Array<Record<string, unknown>>)
      .map((r) => {
        const venueName = String((r.venueName ?? r.venue_name) ?? "").trim();
        return {
          id: `showroom:${String(r.id ?? "")}`,
          name: venueName,
          state: null,
          size: null,
          notes: `Showroom · ${String(r.name ?? r.code ?? "").trim()}`,
          active: 1,
          origin: "SHOWROOM" as const,
          warehouseId: r.id ?? null,
        };
      })
      .filter((v) => v.name && !seen.has(v.name.toLowerCase()));
  } catch {
    showroomVenues = [];
  }

  const merged = [...projectVenues, ...showroomVenues].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? "")),
  );
  return c.json({ data: merged });
});

app.post("/venues", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<VenueBody>();
  const rawName = (body.name || "").trim();
  const [country, city, postcode] = [body.country, body.city, body.postcode].map(blankToNull);
  if (!rawName) return c.json({ error: "name required" }, 400);
  const name = canonicalizeVenue(rawName) ?? rawName;
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const existing = await c.env.DB.prepare(
    `SELECT id, name, state, country, postcode FROM project_venues
      WHERE LOWER(name) = LOWER(?) AND company_id = ?`
  )
    .bind(name, co.companyId)
    .first<{ id: number; name: string; state: string | null; country: string | null; postcode: string | null }>();
  /* A venue in Malaysia / Singapore needs a postcode (owner 2026-11-19); one
     re-added by name keeps the postcode it already has. */
  const pcErr = masterPostcodeError(country ?? existing?.country ?? null, postcode ?? existing?.postcode ?? null);
  if (pcErr) return c.json({ error: "postcode_required", message: pcErr }, 400);
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE project_venues
          SET active = 1,
              state    = COALESCE(?, state),
              country  = COALESCE(?, country),
              city     = COALESCE(?, city),
              postcode = COALESCE(?, postcode),
              size     = COALESCE(?, size),
              notes    = COALESCE(?, notes)
        WHERE id = ? AND company_id = ?`
    )
      .bind(body.state ?? null, country, city, postcode, body.size ?? null, body.notes ?? null, existing.id, co.companyId)
      .run();
    return c.json({ id: existing.id, name: existing.name, state: existing.state }, 200);
  }
  const r = await c.env.DB.prepare(
    `INSERT INTO project_venues (name, state, country, city, postcode, size, notes, created_by, company_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(name, body.state ?? null, country, city, postcode, body.size ?? null, body.notes ?? null, user?.id ?? null, co.companyId)
    .run();
  return c.json({ id: r.meta.last_row_id, name, state: body.state ?? null }, 201);
});

app.patch("/venues/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const venueCoSql = activeCompanySql(c);
  const body = await c.req.json<VenueBody>();
  const sets: string[] = [];
  const binds: any[] = [];
  if ("name" in body) {
    const next = (body.name || "").trim();
    if (!next) return c.json({ error: "name cannot be empty" }, 400);
    sets.push("name = ?");
    binds.push(next);
  }
  if ("state" in body) {
    sets.push("state = ?");
    binds.push(body.state ?? null);
  }
  if ("postcode" in body) {
    const pcErr = masterPostcodeError("country" in body ? blankToNull(body.country) : null, blankToNull(body.postcode));
    if (pcErr) return c.json({ error: "postcode_required", message: pcErr }, 400);
  }
  for (const col of ["country", "city", "postcode"] as const) {
    if (col in body) {
      sets.push(`${col} = ?`);
      binds.push(blankToNull(body[col]));
    }
  }
  if ("size" in body) {
    sets.push("size = ?");
    binds.push(body.size ?? null);
  }
  if ("notes" in body) {
    sets.push("notes = ?");
    binds.push(body.notes ?? null);
  }
  if (sets.length === 0) return c.json({ ok: true });
  /* company-scope: `venueCoSql` (activeCompanySql) is in the WHERE and
     `!r.meta.changes` makes a cross-company miss a 404. Flagged only because the
     checker's SQL window starts at .prepare( and cannot see a predicate
     composed above it. */
  const r = await c.env.DB.prepare(
    `UPDATE project_venues SET ${sets.join(", ")} WHERE id = ?${venueCoSql}`
  )
    .bind(...binds, id)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/venues/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await c.env.DB.prepare(`UPDATE project_venues SET active = 0 WHERE id = ?${activeCompanySql(c)}`)
    .bind(id)
    .run();
  return c.json({ ok: true });
});


async function findTemplateInCompany(
  c: { env: Env; get(key: string): unknown },
  templateId: number,
): Promise<{ id: number } | null> {
  return await c.env.DB.prepare(
    `SELECT id FROM project_checklist_templates WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(templateId)
    .first<{ id: number }>();
}

app.get("/checklist-templates", requirePageAccess("projects.list"), async (c) => {
  /* Company-scoped since mig 0288 (owner: 应该按公司分开). The template master
     was SHARED on read AND write, so both companies edited one set of rows. */
  const coSql = activeCompanySql(c, "t.company_id");
  const templates = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description,
            (SELECT COUNT(*) FROM project_checklist_template_items WHERE template_id = t.id) AS item_count,
            (SELECT string_agg(et.name, ', ')
               FROM project_event_types et
              WHERE et.default_template_id = t.id) AS used_by
       FROM project_checklist_templates t
      ${coSql ? `WHERE 1=1${coSql}` : ""}
      ORDER BY t.name`
  ).all();
  return c.json({ data: templates.results ?? [] });
});

app.get(
  "/checklist-templates/:id/items",
  requirePageAccess("projects.list"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    if (!(await findTemplateInCompany(c, id))) {
      return c.json({ error: "Not found" }, 404);
    }
    // Return items + sections together so the editor renders one
    // round-trip. mig 050: section_id + requires_review on items.
    // company-scope: gated by findTemplateInCompany above (template_id is ours); see the comment on why the children are keyed on it alone.
    const items = await c.env.DB.prepare(
      `SELECT id, seq, title, description, required_perm, role_label, crew_visible,
              due_offset_days, section_id, requires_review
         FROM project_checklist_template_items
        WHERE template_id = ?
        ORDER BY seq, id`
    )
      .bind(id)
      .all();
    // company-scope: same findTemplateInCompany gate as the items read above.
    const sections = await c.env.DB.prepare(
      `SELECT id, name, sort_order, display_mode
         FROM project_checklist_template_sections
        WHERE template_id = ?
        ORDER BY sort_order, id`
    )
      .bind(id)
      .all();
    return c.json({
      data: items.results ?? [],
      sections: sections.results ?? [],
    });
  }
);

app.post(
  "/checklist-templates/:id/items",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{
      title?: string;
      description?: string | null;
      required_perm?: string | null;
      role_label?: string | null;
      crew_visible?: boolean;
      due_offset_days?: number | null;
      seq?: number;
      section_id?: number | null;
      requires_review?: boolean;
    }>();
    const title = (body.title || "").trim();
    if (!title) return c.json({ error: "title required" }, 400);
    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);
    if (!(await findTemplateInCompany(c, id))) {
      return c.json({ error: "Not found" }, 404);
    }
    let seq = body.seq;
    if (seq == null) {
      const maxRow = await c.env.DB.prepare(
        `SELECT MAX(seq) AS s FROM project_checklist_template_items WHERE template_id = ?`
      )
        .bind(id)
        .first<{ s: number | null }>();
      seq = (maxRow?.s ?? 0) + 10;
    }
    const r = await c.env.DB.prepare(
      `INSERT INTO project_checklist_template_items
         (template_id, seq, title, description, required_perm, role_label,
          crew_visible, due_offset_days, section_id, requires_review, company_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        seq,
        title,
        body.description ?? null,
        body.required_perm ?? null,
        body.role_label ?? null,
        body.crew_visible ? 1 : 0,
        body.due_offset_days ?? null,
        body.section_id ?? null,
        body.requires_review ? 1 : 0,
        co.companyId
      )
      .run();
    return c.json({ id: r.meta.last_row_id, seq }, 201);
  }
);

app.patch(
  "/checklist-templates/items/:itemId",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("itemId"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{
      title?: string;
      description?: string | null;
      required_perm?: string | null;
      role_label?: string | null;
      crew_visible?: boolean | number;
      due_offset_days?: number | null;
      seq?: number;
      section_id?: number | null;
      requires_review?: boolean;
    }>();
    const sets: string[] = [];
    const binds: any[] = [];
    if ("title" in body) {
      const t = (body.title || "").trim();
      if (!t) return c.json({ error: "title cannot be empty" }, 400);
      sets.push("title = ?");
      binds.push(t);
    }
    for (const k of ["description", "required_perm", "role_label", "due_offset_days", "seq", "section_id"] as const) {
      if (k in body) {
        sets.push(`${k} = ?`);
        binds.push((body as any)[k] ?? null);
      }
    }
    if ("requires_review" in body) {
      sets.push("requires_review = ?");
      binds.push(body.requires_review ? 1 : 0);
    }
    if ("crew_visible" in body) {
      sets.push("crew_visible = ?");
      binds.push(body.crew_visible ? 1 : 0);
    }
    if (sets.length === 0) return c.json({ ok: true });
    // company-scope: no template id in this URL, so the row's OWN company_id is
    // the predicate.
    const itemCoSql = activeCompanySql(c);
    const r = await c.env.DB.prepare(
      `UPDATE project_checklist_template_items SET ${sets.join(", ")} WHERE id = ?${itemCoSql}`
    )
      .bind(...binds, id)
      .run();
    if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  }
);

app.delete(
  "/checklist-templates/items/:itemId",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("itemId"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    // company-scope: the row's own company_id, as in the PATCH above.
    const r = await c.env.DB.prepare(
      `DELETE FROM project_checklist_template_items WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(id)
      .run();
    if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  }
);

app.put(
  "/checklist-templates/:id/items/reorder",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{ ids?: unknown }>();
    if (!Array.isArray(body.ids) || !body.ids.every((n) => Number.isInteger(n))) {
      return c.json({ error: "ids must be an array of integers" }, 400);
    }
    const ids = body.ids as number[];
    if (ids.length === 0) return c.json({ ok: true });
    if (!(await findTemplateInCompany(c, id))) {
      return c.json({ error: "Not found" }, 404);
    }
    const coSql = activeCompanySql(c);
    const stmts = ids.map((itemId, idx) =>
      c.env.DB.prepare(
        `UPDATE project_checklist_template_items
            SET seq = ?
          WHERE id = ? AND template_id = ?${coSql}`
      ).bind((idx + 1) * 10, itemId, id)
    );
    await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  }
);

app.put(
  "/event-types/:id/default-template",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{ template_id: number | null }>();
    await c.env.DB.prepare(
      `UPDATE project_event_types SET default_template_id = ? WHERE id = ?`
    )
      .bind(body.template_id ?? null, id)
      .run();
    return c.json({ ok: true });
  }
);


app.get("/analytics/profitability", requirePageAccess("projects.finances"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");
  const brand = c.req.query("brand");
  const eventTypeParam = c.req.query("event_type_id");
  const organizer = c.req.query("organizer");
  const scope = c.req.query("scope") || "completed";

  const where: string[] = ["p.archived_at IS NULL"];
  const binds: any[] = [];
  if (scope === "started") {
    where.push("substr(p.start_date, 1, 10) <= ?");
    binds.push(todayMyt());
  } else if (scope === "completed") {
    where.push("p.stage = 'completed'");
  }
  const coSql = activeCompanySql(c, "p.company_id");
  if (dateFrom) {
    where.push("substr(p.start_date, 1, 10) >= substr(?, 1, 10)");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("substr(p.start_date, 1, 10) <= substr(?, 1, 10)");
    binds.push(dateTo);
  }
  if (brand) {
    where.push("p.brand = ?");
    binds.push(brand);
  }
  if (eventTypeParam) {
    where.push("p.event_type_id = ?");
    binds.push(parseInt(eventTypeParam, 10));
  }
  if (organizer) {
    where.push("p.organizer = ?");
    binds.push(organizer);
  }
  const whereSql = where.join(" AND ");

  // company-scope: the statement below ends `WHERE ${whereSql}${coSql}` (coSql = p.company_id); every finance-line subquery is keyed to that p.id.
  // Sum income and cost per project via a single query. Keep
  // project_finance as the rollup source — it's already kept in
  // sync by the ledger write path, and it's 1:1 with projects so
  // this joins clean.
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.organizer, p.venue,
            p.start_date, p.end_date, p.size_sqm,
            et.name as event_type_name,
            COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l
                       WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'income'), 0) as income,
            COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l
                       WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'cost'
                         AND l.category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')), 0) as cogs,
            COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l
                       WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'cost'
                         AND l.category NOT IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')), 0) as cost,
            -- Rental (category='rental') is a SUBSET of cost above — surfaced as
            -- its own figure so the owner can see it broken out in every group
            -- table, without changing NP (still income − cogs − cost).
            COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l
                       WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'cost'
                         AND l.category = 'rental'), 0) as rental,
            CASE WHEN p.end_date IS NOT NULL AND p.start_date IS NOT NULL
                 THEN CAST(julianday(p.end_date) - julianday(p.start_date) + 1 AS INTEGER)
                 ELSE NULL
            END as duration_days
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
      WHERE ${whereSql}${coSql}`
  )
    .bind(...binds)
    .all<{
      id: number;
      code: string;
      name: string;
      brand: string | null;
      organizer: string | null;
      venue: string | null;
      start_date: string | null;
      end_date: string | null;
      size_sqm: number | null;
      event_type_name: string | null;
      income: number;
      cogs: number;
      cost: number;
      rental: number;
      duration_days: number | null;
    }>();

  const projects = rows.results ?? [];

  const total_projects = projects.length;
  const total_income = projects.reduce((s, r) => s + (r.income || 0), 0);
  const total_cogs = projects.reduce((s, r) => s + (r.cogs || 0), 0);
  const total_cost = projects.reduce((s, r) => s + (r.cost || 0), 0);
  const total_rental = projects.reduce((s, r) => s + (r.rental || 0), 0);
  const total_gp = total_income - total_cogs;
  const total_profit = total_income - total_cogs - total_cost;
  const overall_margin = total_income > 0 ? (total_profit / total_income) * 100 : null;

  function groupBy<K extends string>(
    keyFn: (r: (typeof projects)[number]) => K | null
  ): { key: K; count: number; income: number; cogs: number; cost: number; rental: number; gp: number; profit: number; margin: number | null }[] {
    const map = new Map<K, { count: number; income: number; cogs: number; cost: number; rental: number }>();
    for (const r of projects) {
      const k = keyFn(r);
      if (!k) continue;
      const cur = map.get(k) ?? { count: 0, income: 0, cogs: 0, cost: 0, rental: 0 };
      cur.count += 1;
      cur.income += r.income || 0;
      cur.cogs += r.cogs || 0;
      cur.cost += r.cost || 0;
      cur.rental += r.rental || 0;
      map.set(k, cur);
    }
    return [...map.entries()]
      .map(([key, v]) => ({
        key,
        count: v.count,
        income: v.income,
        cogs: v.cogs,
        cost: v.cost,
        rental: v.rental,
        gp: v.income - v.cogs,
        profit: v.income - v.cogs - v.cost,
        margin: v.income > 0 ? ((v.income - v.cogs - v.cost) / v.income) * 100 : null,
      }))
      .sort((a, b) => b.profit - a.profit);
  }

  const by_brand = groupBy((r) => r.brand);
  const by_organizer = groupBy((r) => r.organizer);
  const by_venue = groupBy((r) => canonicalizeVenue(r.venue));
  const by_event_type = groupBy((r) => r.event_type_name);
  const by_month = groupBy((r) =>
    r.start_date ? r.start_date.slice(0, 7) : null
  ).sort((a, b) => a.key.localeCompare(b.key));

  const ranked = [...projects]
    .filter((r) => (r.income || 0) > 0 || (r.cogs || 0) > 0 || (r.cost || 0) > 0)
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      brand: r.brand,
      venue: r.venue,
      start_date: r.start_date,
      income: r.income,
      cogs: r.cogs,
      cost: r.cost,
      rental: r.rental,
      gp: r.income - r.cogs,
      profit: r.income - r.cogs - r.cost,
      margin: r.income > 0 ? ((r.income - r.cogs - r.cost) / r.income) * 100 : null,
    }))
    .sort((a, b) => b.profit - a.profit);
  const top = ranked.slice(0, 5);
  const bottom = ranked.slice(-5).reverse();

  return c.json({
    filters: {
      date_from: dateFrom ?? null,
      date_to: dateTo ?? null,
      brand: brand ?? null,
      event_type_id: eventTypeParam ?? null,
      organizer: organizer ?? null,
      scope,
    },
    totals: {
      projects: total_projects,
      income: total_income,
      cogs: total_cogs,
      cost: total_cost,
      rental: total_rental,
      gp: total_gp,
      profit: total_profit,
      margin_pct: overall_margin,
    },
    by_brand,
    by_organizer,
    by_event_type,
    by_venue,
    by_month,
    top,
    bottom,
  });
});

const PROFITABILITY_DIMENSION = {
  brand: "p.brand = ?",
  organizer: "p.organizer = ?",
  venue: "p.venue = ?",
  event_type: "et.name = ?",
  month: "substr(p.start_date, 1, 7) = ?",
} as const;
type ProfitabilityDimension = keyof typeof PROFITABILITY_DIMENSION;

const PROFIT_COGS_CATEGORIES = "('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')";
const PROFIT_MONTH_EXPR = "substr(COALESCE(l.occurred_at, l.created_at), 1, 7)";

app.get("/analytics/profitability/drill", requirePageAccess("projects.finances"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const dimensionParam = c.req.query("dimension") ?? "";
  const value = c.req.query("value");
  const month = c.req.query("month");
  if (!(dimensionParam in PROFITABILITY_DIMENSION)) {
    return c.json({ error: "Invalid dimension (expected brand|organizer|venue|event_type|month)" }, 400);
  }
  if (value == null || value === "") {
    return c.json({ error: "Missing value" }, 400);
  }
  const dimension = dimensionParam as ProfitabilityDimension;

  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");
  const brand = c.req.query("brand");
  const eventTypeParam = c.req.query("event_type_id");
  const organizer = c.req.query("organizer");

  const scope = c.req.query("scope") || "completed";
  const where: string[] = ["p.archived_at IS NULL"];
  const binds: any[] = [];
  if (scope === "started") {
    where.push("substr(p.start_date, 1, 10) <= ?");
    binds.push(todayMyt());
  } else if (scope === "completed") {
    where.push("p.stage = 'completed'");
  }
  const coSql = activeCompanySql(c, "p.company_id");
  if (dateFrom) {
    where.push("substr(p.start_date, 1, 10) >= substr(?, 1, 10)");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("substr(p.start_date, 1, 10) <= substr(?, 1, 10)");
    binds.push(dateTo);
  }
  if (brand) {
    where.push("p.brand = ?");
    binds.push(brand);
  }
  if (eventTypeParam) {
    where.push("p.event_type_id = ?");
    binds.push(parseInt(eventTypeParam, 10));
  }
  if (organizer) {
    where.push("p.organizer = ?");
    binds.push(organizer);
  }
  where.push(PROFITABILITY_DIMENSION[dimension]);
  binds.push(value);
  const whereSql = where.join(" AND ");

  if (dimension !== "month" && (month == null || month === "")) {
    const rows = await c.env.DB.prepare(
      `SELECT ${PROFIT_MONTH_EXPR} AS month,
              COUNT(DISTINCT p.id) AS count,
              COALESCE(SUM(CASE WHEN l.kind = 'income' THEN l.amount ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN l.kind = 'cost' AND l.category IN ${PROFIT_COGS_CATEGORIES} THEN l.amount ELSE 0 END), 0) AS cogs,
              COALESCE(SUM(CASE WHEN l.kind = 'cost' AND l.category NOT IN ${PROFIT_COGS_CATEGORIES} THEN l.amount ELSE 0 END), 0) AS cost,
              COALESCE(SUM(CASE WHEN l.kind = 'cost' AND l.category = 'rental' THEN l.amount ELSE 0 END), 0) AS rental
         FROM projects p
         JOIN project_finance_lines l ON l.project_id = p.id AND l.archived_at IS NULL
         LEFT JOIN project_event_types et ON et.id = p.event_type_id
        WHERE ${whereSql}${coSql}
          AND COALESCE(l.occurred_at, l.created_at) IS NOT NULL
        GROUP BY ${PROFIT_MONTH_EXPR}`
    )
      .bind(...binds)
      .all<{
        month: string;
        count: number;
        income: number;
        cogs: number;
        cost: number;
        rental: number;
      }>();

    const months = (rows.results ?? [])
      .map((r) => ({
        key: r.month,
        count: r.count,
        income: r.income,
        cogs: r.cogs,
        cost: r.cost,
        rental: r.rental,
        gp: r.income - r.cogs,
        profit: r.income - r.cogs - r.cost,
        margin: r.income > 0 ? ((r.income - r.cogs - r.cost) / r.income) * 100 : null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    return c.json({ level: "months", dimension, value, months });
  }

  const lineMonthFilter = dimension === "month" ? "" : ` AND ${PROFIT_MONTH_EXPR} = ?`;
  const lineJoin = dimension === "month" ? "LEFT JOIN" : "JOIN";
  const projBinds = dimension === "month" ? [...binds] : [month, ...binds];

  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.organizer, p.venue, p.start_date,
            et.name AS event_type_name,
            COALESCE(SUM(CASE WHEN l.kind = 'income' THEN l.amount ELSE 0 END), 0) AS income,
            COALESCE(SUM(CASE WHEN l.kind = 'cost' AND l.category IN ${PROFIT_COGS_CATEGORIES} THEN l.amount ELSE 0 END), 0) AS cogs,
            COALESCE(SUM(CASE WHEN l.kind = 'cost' AND l.category NOT IN ${PROFIT_COGS_CATEGORIES} THEN l.amount ELSE 0 END), 0) AS cost,
            COALESCE(SUM(CASE WHEN l.kind = 'cost' AND l.category = 'rental' THEN l.amount ELSE 0 END), 0) AS rental
       FROM projects p
       ${lineJoin} project_finance_lines l ON l.project_id = p.id AND l.archived_at IS NULL${lineMonthFilter}
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
      WHERE ${whereSql}${coSql}
      GROUP BY p.id, p.code, p.name, p.brand, p.organizer, p.venue, p.start_date, et.name`
  )
    .bind(...projBinds)
    .all<{
      id: number;
      code: string;
      name: string;
      brand: string | null;
      organizer: string | null;
      venue: string | null;
      start_date: string | null;
      event_type_name: string | null;
      income: number;
      cogs: number;
      cost: number;
      rental: number;
    }>();

  const projects = (rows.results ?? [])
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      brand: r.brand,
      organizer: r.organizer,
      venue: r.venue,
      start_date: r.start_date,
      event_type_name: r.event_type_name,
      income: r.income,
      cogs: r.cogs,
      cost: r.cost,
      rental: r.rental,
      gp: r.income - r.cogs,
      profit: r.income - r.cogs - r.cost,
      margin: r.income > 0 ? ((r.income - r.cogs - r.cost) / r.income) * 100 : null,
    }))
    .sort((a, b) => b.profit - a.profit);

  return c.json({ level: "projects", dimension, value, month: month ?? null, projects });
});

// Project-scoped sales-attending picker source — every active sales-team
// member regardless of sales position (owner 2026-07-13: managers and
// directors also do booth duty, so all of them must be assignable).
// Brand-relaxed (owner: Option A). MUST be registered BEFORE the "/:id" detail
// route below: it's a single-segment static path, so if "/:id" is matched
// first Hono treats "sales-rep-options" as a project id -> parseInt NaN -> 400
// "Invalid ID", which surfaced as the empty "No Sales Persons available"
// dropdown. Gated on projects.write (not sales_team.read, which project roles
// lack); legacy ?brand= accepted but ignored.
app.get("/sales-rep-options", requirePermission("projects.write"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.code, r.name, r.phone
       FROM sales_reps r
      WHERE r.archived_at IS NULL
        AND r.status = 'active'
      ORDER BY LOWER(r.name), r.code`
  ).all<{ id: number; code: string; name: string; phone: string | null }>();
  return c.json({ data: rows.results ?? [], others: await staffNotOnRoster(c.env, activeCompanyId(c)) });
});


app.get("/:id", requirePageAccess("projects.list"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const detail = await getProjectDetail(c.env, id, activeCompanyId(c));
  if (!detail) return c.json({ error: "Not found" }, 404);
  // Row-level PIC/brand visibility ACL removed (owner decision 2026-08-19): any
  // user with projects page access sees any project in their active company
  // (the getProjectDetail load above is company-scoped). Crew scoping below is
  // a separate axis and stays.
  // Owner 2026-07-21: helpers/storekeepers open ONLY events they're crewed on
  // (same 404-shape as the other row-ACL misses so ids aren't probeable).
  if (isCrewScopedUser(user)) {
    const phases = await getUserPhasesOnProject(c.env, id, user?.id ?? 0, user?.name);
    if (phases.length === 0) return c.json({ error: "Not found" }, 404);
  }
  // Row-level PIC/brand visibility ACL removed (owner decision 2026-08-19):
  // every viewer now gets the full row-level view of the project. `level` /
  // `level_v2` / `scoped` are kept for frontend compatibility but are now
  // constant. Section-level (PMS) access below still strips money / sensitive
  // panels by position — a separate, finer axis that is unaffected.
  const pms = getPmsAccess(user, detail.project);
  const access = {
    level: "full" as const,
    level_v2: "full" as const,
    is_pic: detail.project.pic_id === user.id,
    scoped: false,
    pms,
  };
  const stripFinance = user.position_id != null && !pms.canFinancial;
  const stripPayment = user.position_id != null && !pms.canPayment;
  let payload: any = detail;
  if (stripFinance) {
    payload = {
      ...payload,
      finance: null,
      finance_lines: [],
      finance_books: null,
      finance_pnl: null, finance_forecast: null,
    };
  }
  if (stripPayment) {
    payload = {
      ...payload,
      project: {
        ...payload.project,
        payment_status: null,
        payment_proof_r2_key: null,
        payment_proof_file_name: null,
        payment_notes: null,
        payment_updated_at: null,
        payment_updated_by: null,
      },
    };
  }
  const stripSensitive = user.position_id != null && !pms.canSensitive;
  if (stripSensitive) {
    payload = stripSensitiveChecklist(payload);
  }
  // Setup & Dismantle (owner 2026-07-15): the logistics crew-per-lorry editor
  // AND the "SETUP & DISMANTLE DOCUMENTS" checklist rows are hidden from every
  // non-director Sales user — even the project's own PIC. Strip the crew JSON
  // (setup_crew / dismantle_crew + scheduled times) and those checklist rows on
  // the wire for a position whose PMS role lacks SETUP_DISMANTLE — the same
  // defense-in-depth as finance / payment / sensitive above. Position-gated so
  // un-migrated users keep legacy access until positions are assigned.
  const stripSetupDismantleData = user.position_id != null && !pms.canSetupDismantle;
  if (stripSetupDismantleData) {
    payload = stripSetupDismantle(payload);
  }
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  const canSeeAllSalesReports =
    isFinanceViewer(user) || hasPermission(granted, "service_cases.manage");
  if (!canSeeAllSalesReports && Array.isArray(payload.sales_reports)) {
    payload = {
      ...payload,
      sales_reports: await scopeSalesReportsForUser(
        c.env,
        user?.id,
        payload.sales_reports,
        false,
      ),
    };
  }
  return c.json({ ...payload, _access: access });
});


app.post("/", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  if (!canCreateEvent(user)) {
    return c.json({ error: "Only BD, the owner, and weisiang can create events." }, 403);
  }
  const body = await c.req.json<{
    name?: string;
    event_type_id?: number;
    brand?: string;
    start_date?: string;
    end_date?: string;
    venue?: string;
    state?: string;
    organizer?: string;
    notion_url?: string;
    pic_id?: number | null;
  }>();
  if (!body.name || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  // Project creation is gated by projects.write + canCreateEvent (BD / owner)
  // above. The PIC/brand row-level ACL was removed (owner decision 2026-08-19),
  // so any submitted pic_id is honoured and there is no per-brand PIC gate — the
  // picker offers whoever it offers.
  const picId = body.pic_id ?? null;
  try {
    const result = await createProject(c.env, {
      name: body.name.trim(),
      event_type_id: body.event_type_id ?? null,
      brand: body.brand ?? null,
      start_date: body.start_date ?? null,
      end_date: body.end_date ?? null,
      venue: body.venue ?? null,
      state: body.state ?? null,
      organizer: body.organizer ?? null,
      notion_url: body.notion_url ?? null,
      pic_id: picId,
      created_by: user?.id ?? 0,
      company_id: activeCompanyId(c),
    });
    return c.json(result, 201);
  } catch (e: any) {
    const msg = e?.message || "Failed to create project";
    if (/required to generate a project code|end_date must be/i.test(msg)) {
      return c.json({ error: msg }, 400);
    }
    throw e;
  }
});


app.patch("/:id", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();

  const existing = await c.env.DB.prepare(
    `SELECT id FROM projects WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(id)
    .first<{ id: number }>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (isSalesUser(user)) {
    delete body.setup_crew;
    delete body.dismantle_crew;
    delete body.service_crew;
  }

  // Row-level PIC/brand visibility ACL removed (owner decision 2026-08-19): a
  // projects.write holder may patch any project in their active company (the
  // pre-patch fetch above is company-scoped and 404s a cross-company id) and may
  // (re)assign the PIC to anyone, with no per-brand PIC gate.

  const result = await patchProject(c.env, id, body, user?.id ?? 0);
  if (!result.ok) return c.json({ error: "No changes" }, 400);
  return c.json({
    ok: true,
    shifted_tasks: result.shifted_tasks,
    delta_days: result.delta_days,
  });
});


app.post("/:id/notes", requireAnyPermission(["projects.write", "projects.chat"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<{ note: string }>();
  if (!body.note?.trim()) return c.json({ error: "note is required" }, 400);
  await logProjectActivity(c.env, id, "note", null, null, body.note.trim(), user?.id);
  return c.json({ ok: true });
});


app.get("/:id/activity", requirePageAccess("projects.list"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const since = c.req.query("since") || "";
  const sinceClause = since ? " AND act.created_at > ?" : "";
  const sinceBinds = since ? [since] : [];

  const coSql = activeCompanySql(c, "p.company_id");
  const coGuard = coSql
    ? ` AND EXISTS (SELECT 1 FROM projects p WHERE p.id = act.project_id${coSql})`
    : "";
  const rows = await c.env.DB.prepare(
    `SELECT act.id, act.action, act.from_value, act.to_value, act.note,
            act.user_id, u.name AS user_name,
            u.email AS user_email,
            u.profile_pic_r2_key AS user_profile_pic_r2_key,
            act.created_at
       FROM project_activity act
       LEFT JOIN users u ON u.id = act.user_id
      WHERE act.project_id = ?
        AND act.archived_at IS NULL${sinceClause}${coGuard}
      ORDER BY act.created_at ASC, act.id ASC`
  )
    .bind(id, ...sinceBinds)
    .all();
  let activity = (rows.results ?? []) as any[];
  if (financeHiddenForUser(user)) {
    const HIDDEN_ACTIONS = new Set([
      "payment_status",
      "finance_edit",
      "finance_line_edit",
      "finance_line_remove",
    ]);
    activity = activity.filter((r) => !HIDDEN_ACTIONS.has(r.action));
  }
  return c.json({ data: activity });
});


app.post("/:id/read", requirePageAccess("projects.list"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  if (!user?.id) return c.json({ ok: true });
  await c.env.DB.prepare(
    `INSERT INTO project_reads (user_id, project_id, last_read_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id, project_id)
     DO UPDATE SET last_read_at = datetime('now')`
  )
    .bind(user.id, id)
    .run();
  return c.json({ ok: true });
});


app.post("/:id/archive", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  await c.env.DB.prepare(
    `UPDATE projects
        SET archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now')
      WHERE id = ? AND archived_at IS NULL${activeCompanySql(c)}`
  )
    .bind(user?.id ?? null, id)
    .run();
  await logProjectActivity(c.env, id, "archived", null, null, null, user?.id);
  return c.json({ ok: true });
});

app.post("/:id/unarchive", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  await c.env.DB.prepare(
    `UPDATE projects
        SET archived_at = NULL, archived_by = NULL, updated_at = datetime('now')
      WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(id)
    .run();
  await logProjectActivity(c.env, id, "restored", null, null, null, user?.id);
  return c.json({ ok: true });
});


app.patch("/:id/finance", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  // Company scope (owner audit 2026-07-22): the project is resolved in the
  // ACTIVE company FIRST, so a cross-company id 404s before patchFinance (which
  // CREATES the snapshot row when missing) can run. The PIC/brand row-level ACL
  // that used to further restrict finance writes was removed (owner decision
  // 2026-08-19); company scope + the projects.write + finance gates remain.
  {
    const row = await c.env.DB.prepare(
      `SELECT id FROM projects WHERE id = ?${activeCompanySql(c)}`
    ).bind(id).first<{ id: number }>();
    if (!row) return c.json({ error: "Not found" }, 404);
  }
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchFinance(c.env, id, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "No changes" }, 400);
  await recomputeAutoCostLines(c.env, id, user?.id ?? 0).catch(() => {});
  await audit(c, {
    action: "finance.update",
    entityType: "project_finance",
    entityId: id,
    summary: `Edited finance for project #${id}`,
    meta: { fields: Object.keys(body) },
  });
  return c.json({ ok: true });
});


app.get("/finance/categories", (c) => {
  return c.json({
    cost: LEDGER_COST_CATEGORIES,
    income: LEDGER_INCOME_CATEGORIES,
  });
});

app.get("/finance/by-project", requirePageAccess("projects.finances"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  // PIC/brand row-level ACL removed (owner decision 2026-08-19): the Finance
  // tab is gated by the projects.finances page-access + the denyFinance role
  // check above, and scoped to the active company below. No per-PIC row filter.
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const brand = c.req.query("brand") || "";
  const stage = c.req.query("stage") || "";
  const search = c.req.query("search") || "";
  const includeArchived = c.req.query("include_archived") === "1";
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(
    parseInt(c.req.query("per_page") || "50", 10),
    200
  );
  const offset = (page - 1) * perPage;

  const db = getDb(c.env);

  const projConds: any[] = [];
  if (dateFrom) {
    projConds.push(
      sql`substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ${dateFrom.slice(0, 10)}`
    );
  }
  if (dateTo) {
    projConds.push(sql`substr(p.start_date, 1, 10) <= ${dateTo.slice(0, 10)}`);
  }
  const dateClause = sql``;

  const rollupCompanyId = activeCompanyId(c);
  if (rollupCompanyId != null) projConds.push(sql`p.company_id = ${rollupCompanyId}`);
  if (!includeArchived) projConds.push(sql`p.archived_at IS NULL`);
  if (brand) projConds.push(sql`p.brand = ${brand}`);
  if (stage) projConds.push(sql`p.stage = ${stage}`);
  if (search) {
    const like = `%${search}%`;
    projConds.push(
      sql`(p.code ILIKE ${like} OR p.name ILIKE ${like} OR p.venue ILIKE ${like} OR p.organizer ILIKE ${like})`
    );
  }
  const whereClause = projConds.length
    ? sql`WHERE ${sql.join(projConds, sql` AND `)}`
    : sql``;

  const sortBy = c.req.query("sort_by") || "net";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortMap: Record<string, string> = {
    project: "code",
    brand: "brand",
    stage: "stage",
    start: "start_date",
    income: "income",
    sales: "sales",
    sales_per_day: "sales_per_day",
    cogs: "cogs",
    gp_pct: "gp_pct",
    rental: "rental",
    rent_per_sqm: "rent_per_sqm",
    setup: "setup_cost",
    transport: "transport_cost",
    commission: "commission_cost",
    merchandise: "merchandise_cost",
    others: "others_cost",
    cost: "cost",
    total_cost: "cost",
    net: "net",
    net_profit: "net_profit",
    margin_pct: "margin_pct",
    lines: "line_count",
  };
  const orderByClause = sql`ORDER BY ${sql.raw(`${sortMap[sortBy] ?? sortMap.net} ${sortDir}`)}, id DESC`;

  const baseSelect = sql`
    SELECT p.id,
           p.code,
           p.name,
           p.brand,
           p.stage,
           p.start_date,
           p.end_date,
           p.size_sqm,
           p.venue,
           p.organizer,
           COALESCE(SUM(CASE WHEN l.kind = 'income' AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS income,
           -- Same rule as the project page's P&L snapshot: individual sales
           -- lines when any exist, else the lump "Total Sales" box
           -- (project_finance.total_sales), which is where most events keep
           -- their sales. MAX(): pf is 1:1 with p but not in the GROUP BY.
           CASE WHEN COALESCE(SUM(CASE WHEN l.kind = 'income' AND l.category = 'sales' AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) > 0
                THEN COALESCE(SUM(CASE WHEN l.kind = 'income' AND l.category = 'sales' AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0)
                ELSE COALESCE(MAX(pf.total_sales), 0)
           END AS sales,
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS cost,
           -- COGS family (2026-05-08): legacy cogs slug + the three product
           -- sub-categories the boss requested. Sums into one column for the
           -- list view; the detail page breaks them out individually.
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories') AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS cogs,
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.category = 'rental'      AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS rental,
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.category = 'setup'       AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS setup_cost,
           -- Transport family (2026-05-08): legacy transport slug + the
           -- new transport_fee (auto rate) and transport_setup_dismantle
           -- (manual logistics cost) split.
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.category IN ('transport','transport_fee','transport_setup_dismantle') AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS transport_cost,
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.category = 'commission'  AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS commission_cost,
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.category = 'merchandise' AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS merchandise_cost,
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.archived_at IS NULL
                            AND l.category NOT IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories','rental','setup','transport','transport_fee','transport_setup_dismantle','commission','merchandise')
                            ${dateClause} THEN l.amount ELSE 0 END), 0) AS others_cost,
           COUNT(CASE WHEN l.archived_at IS NULL ${dateClause} THEN l.id END) AS line_count
      FROM ${projectsTable} p
      LEFT JOIN ${project_finance_lines} l ON l.project_id = p.id
      LEFT JOIN ${project_finance} pf ON pf.project_id = p.id
      ${whereClause}
      GROUP BY p.id
  `;

  const wrapped = sql`
    SELECT *,
           (income - cost) AS net,
           (sales - cost) AS net_profit,
           CASE WHEN income > 0
                THEN ((income - cost) * 100.0 / income)
                ELSE NULL
           END AS margin_pct,
           CASE WHEN sales > 0
                THEN ((sales - cogs) * 100.0 / sales)
                ELSE NULL
           END AS gp_pct,
           CASE WHEN start_date IS NOT NULL
                  AND end_date   IS NOT NULL
                  AND end_date::timestamptz >= start_date::timestamptz
                THEN sales / (extract(epoch from (end_date::timestamptz - start_date::timestamptz)) / 86400.0 + 1)
                ELSE NULL
           END AS sales_per_day,
           CASE WHEN size_sqm IS NOT NULL AND size_sqm > 0
                THEN rental * 1.0 / size_sqm
                ELSE NULL
           END AS rent_per_sqm
      FROM (${baseSelect}) sub
  `;

  const visible = wrapped;

  const totalRow = await db.get<{ count: number }>(
    sql`SELECT COUNT(*) AS count FROM (${visible}) outerSub`
  );

  const rows = await db.execute<any>(
    sql`${visible} ${orderByClause} LIMIT ${perPage} OFFSET ${offset}`
  );

  const totalsRow = await db.get<{
    total_income: number;
    total_sales: number;
    total_cost: number;
    total_cogs: number;
    total_rental: number;
  }>(sql`
    SELECT
      COALESCE(SUM(income),  0) AS total_income,
      COALESCE(SUM(sales),   0) AS total_sales,
      COALESCE(SUM(cost),    0) AS total_cost,
      COALESCE(SUM(cogs),    0) AS total_cogs,
      COALESCE(SUM(rental),  0) AS total_rental
    FROM (${visible}) tot
  `);

  return c.json({
    data: rows,
    page,
    per_page: perPage,
    total: totalRow?.count ?? 0,
    totals: {
      income: totalsRow?.total_income ?? 0,
      sales: totalsRow?.total_sales ?? 0,
      cost: totalsRow?.total_cost ?? 0,
      cogs: totalsRow?.total_cogs ?? 0,
      rental: totalsRow?.total_rental ?? 0,
      net: (totalsRow?.total_income ?? 0) - (totalsRow?.total_cost ?? 0),
      net_profit: (totalsRow?.total_sales ?? 0) - (totalsRow?.total_cost ?? 0),
    },
  });
});

app.get("/finance/lines", requirePageAccess("projects.finances"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  // PIC/brand row-level ACL removed (owner decision 2026-08-19): finance lines
  // are gated by projects.finances + denyFinance and scoped to the active
  // company below; no per-PIC row filter.
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const kindParam = (c.req.query("kind") || "all").toLowerCase();
  const brand = c.req.query("brand") || "";
  const category = c.req.query("category") || "";
  const projectId = parseInt(c.req.query("project_id") || "", 10);
  const search = c.req.query("search") || "";
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(
    parseInt(c.req.query("per_page") || "50", 10),
    200
  );
  const offset = (page - 1) * perPage;

  const db = getDb(c.env);

  const conds: any[] = [sql`l.archived_at IS NULL`];
  const linesCompanyId = activeCompanyId(c);
  if (linesCompanyId != null) conds.push(sql`p.company_id = ${linesCompanyId}`);
  if (dateFrom) {
    conds.push(sql`COALESCE(l.occurred_at, l.created_at) >= ${dateFrom}`);
  }
  if (dateTo) {
    conds.push(sql`COALESCE(l.occurred_at, l.created_at) <= ${`${dateTo}T23:59:59`}`);
  }
  if (kindParam === "income" || kindParam === "cost") {
    conds.push(sql`l.kind = ${kindParam}`);
  }
  if (brand) conds.push(sql`p.brand = ${brand}`);
  if (category) conds.push(sql`l.category = ${category}`);
  if (!isNaN(projectId)) conds.push(sql`l.project_id = ${projectId}`);
  if (search) {
    const like = `%${search}%`;
    conds.push(
      sql`(l.description ILIKE ${like} OR l.notes ILIKE ${like} OR p.code ILIKE ${like} OR p.name ILIKE ${like})`
    );
  }

  const sortBy = c.req.query("sort_by") || "occurred_at";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortMap: Record<string, string> = {
    occurred_at: "COALESCE(l.occurred_at, l.created_at)",
    amount: "l.amount",
    project: "p.code",
    category: "l.category",
    kind: "l.kind",
  };
  const orderByClause = sql`ORDER BY ${sql.raw(`${sortMap[sortBy] ?? sortMap.occurred_at} ${sortDir}`)}, l.id DESC`;

  const baseFrom = sql`
    FROM ${project_finance_lines} l
    JOIN ${projectsTable} p ON p.id = l.project_id
    WHERE ${sql.join(conds, sql` AND `)}
  `;

  const totalRow = await db.get<{ count: number }>(
    sql`SELECT COUNT(*) as count ${baseFrom}`
  );

  const rows = await db.execute<any>(sql`
    SELECT l.id,
           l.project_id,
           l.kind,
           l.category,
           l.description,
           l.amount,
           l.occurred_at,
           l.notes,
           l.created_at,
           l.r2_key,
           l.file_name,
           p.code   AS project_code,
           p.name   AS project_name,
           p.brand  AS project_brand
    ${baseFrom}
    ${orderByClause}
    LIMIT ${perPage} OFFSET ${offset}
  `);

  const totalsRow = await db.get<{ total_income: number; total_cost: number }>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN l.kind = 'income' THEN l.amount ELSE 0 END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN l.kind = 'cost'   THEN l.amount ELSE 0 END), 0) AS total_cost
    ${baseFrom}
  `);

  return c.json({
    data: rows,
    page,
    per_page: perPage,
    total: totalRow?.count ?? 0,
    totals: {
      income: totalsRow?.total_income ?? 0,
      cost: totalsRow?.total_cost ?? 0,
      net: (totalsRow?.total_income ?? 0) - (totalsRow?.total_cost ?? 0),
    },
  });
});

app.post("/:id/finance/lines", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<{
    kind?: string;
    category?: string;
    description?: string;
    amount?: number;
    occurred_at?: string;
    r2_key?: string;
    file_name?: string;
    mime_type?: string;
    notes?: string;
  }>();
  const kind = body.kind as "income" | "cost";
  if (!["income", "cost"].includes(kind)) {
    return c.json({ error: "kind must be 'income' or 'cost'" }, 400);
  }
  if (!body.category || !body.category.trim()) {
    return c.json({ error: "category required" }, 400);
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return c.json({ error: "amount must be a non-negative number" }, 400);
  }
  try {
    const result = await createLedgerLine(
      c.env,
      {
        project_id: id,
        kind,
        category: body.category,
        description: body.description ?? null,
        amount,
        occurred_at: body.occurred_at ?? null,
        r2_key: body.r2_key ?? null,
        file_name: body.file_name ?? null,
        mime_type: body.mime_type ?? null,
        notes: body.notes ?? null,
      },
      user?.id ?? 0
    );
    return c.json(result, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed" }, 400);
  }
});

app.patch("/finance/lines/:lineId", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const lineId = parseInt(c.req.param("lineId"), 10);
  if (isNaN(lineId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_finance_lines", lineId); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchLedgerLine(c.env, lineId, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found or no changes" }, 400);
  return c.json({ ok: true });
});

app.delete("/finance/lines/:lineId", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const lineId = parseInt(c.req.param("lineId"), 10);
  if (isNaN(lineId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_finance_lines", lineId); if (foreign) return foreign; }
  const user = c.get("user");
  const ok = await archiveLedgerLine(c.env, lineId, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.put("/:id/finance/upload", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp", "pdf", "xlsx"]);
  if (!allowed.has(ext)) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const mime =
    ext === "pdf"
      ? "application/pdf"
      : ext === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/ledger-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ key, mime_type: mime });
});


app.put("/:id/phase-photos/upload", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const phase = (c.req.query("phase") || "").toLowerCase();
  if (phase !== "setup" && phase !== "dismantle" && phase !== "service" && phase !== "schedule") {
    return c.json({ error: "phase must be setup, dismantle or service" }, 400);
  }

  const granted = user?.permissions_set ?? user?.permissions;
  const canManage = !!user && hasPermission(granted, "projects.write");
  if (!canManage) {
    // Service / Exchange photos are office/logistics-managed (owner 2026-07-22);
    // there is no crew self-serve path (getUserPhasesOnProject only knows the
    // setup/dismantle crews), so a non-writer can't upload them.
    if (phase === "service" || phase === "schedule") return c.json({ error: "Not allowed" }, 403);
    const phases = await getUserPhasesOnProject(c.env, id, user?.id ?? 0, user?.name);
    if (!phases.includes(phase as "setup" | "dismantle")) {
      return c.json({ error: "Not crewed on this phase" }, 403);
    }
  }

  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const MIME_BY_EXT: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    m4v: "video/x-m4v",
  };
  const mime = MIME_BY_EXT[ext];
  if (!mime) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 50 * 1024 * 1024) return c.json({ error: "Max 50MB" }, 400);
  const key = `project-phase-photos/${id}/${phase}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ key, mime_type: mime });
});

app.post("/:id/phase-photos", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    phase?: "setup" | "dismantle" | "service" | "schedule";
    r2_key?: string;
    content_type?: string;
    caption?: string | null;
  }>();
  const phase = body.phase;
  if (phase !== "setup" && phase !== "dismantle" && phase !== "service" && phase !== "schedule") {
    return c.json({ error: "Something went wrong. Please try again." }, 400);
  }
  if (!body.r2_key) return c.json({ error: "Something went wrong with the upload. Please try again." }, 400);

  const granted = user?.permissions_set ?? user?.permissions;
  const canManage = !!user && hasPermission(granted, "projects.write");
  if (!canManage) {
    if (phase === "service" || phase === "schedule") return c.json({ error: "Not allowed" }, 403);
    const phases = await getUserPhasesOnProject(c.env, id, user?.id ?? 0, user?.name);
    if (!phases.includes(phase)) {
      return c.json({ error: "Not crewed on this phase" }, 403);
    }
  }

  const owner = await c.env.DB.prepare(
    `SELECT id FROM projects WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(id)
    .first<{ id: number }>();
  if (!owner) return c.json({ error: "Not found" }, 404);

  const r = await c.env.DB.prepare(
    `INSERT INTO project_phase_photos
       (project_id, phase, r2_key, content_type, caption, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, phase, body.r2_key, body.content_type ?? null, body.caption ?? null, user?.id ?? null)
    .run();
  if (phase === "setup" || phase === "dismantle") {
    await autoTickPhasePhoto(c.env, id, phase, user?.id ?? 0);
  }
  return c.json({ id: r.meta.last_row_id });
});

app.get("/:id/phase-photos", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");

  const grantedR = user?.permissions_set ?? user?.permissions;
  const canRead =
    !!user &&
    (hasPermission(grantedR, "projects.read") || hasPermission(grantedR, "projects.write"));
  if (!canRead) {
    const phases = await getUserPhasesOnProject(c.env, id, user?.id ?? 0, user?.name);
    if (!phases.length) return c.json({ error: "You don't have permission to view this project." }, 403);
  }

  const photoCoSql = activeCompanySql(c, "p.company_id");
  const rows = await c.env.DB.prepare(
    `SELECT pp.id, pp.phase, pp.r2_key, pp.content_type, pp.caption,
            pp.uploaded_by, u.name as uploaded_by_name, pp.uploaded_at
       FROM project_phase_photos pp
       LEFT JOIN users u ON u.id = pp.uploaded_by
      WHERE pp.project_id = ?${
        photoCoSql ? ` AND EXISTS (SELECT 1 FROM projects p WHERE p.id = pp.project_id${photoCoSql})` : ""
      }
      ORDER BY pp.uploaded_at DESC, pp.id DESC`
  )
    .bind(id)
    .all();
  return c.json({ photos: rows.results ?? [] });
});

app.delete("/phase-photos/:photoId", async (c) => {
  const photoId = parseInt(c.req.param("photoId"), 10);
  if (isNaN(photoId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const photoCoSql = activeCompanySql(c, "p.company_id");
  const row = await c.env.DB.prepare(
    `SELECT project_id, phase, uploaded_by, r2_key FROM project_phase_photos WHERE id = ?${
      photoCoSql ? ` AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id${photoCoSql})` : ""
    }`
  )
    .bind(photoId)
    .first<{ project_id: number; phase: "setup" | "dismantle" | "service" | "schedule"; uploaded_by: number | null; r2_key: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);

  const granted = user?.permissions_set ?? user?.permissions;
  const canManage = !!user && hasPermission(granted, "projects.write");
  const isUploader = user?.id != null && row.uploaded_by === user.id;
  if (!canManage && !isUploader) {
    // Owner 2026-07-21: crew (helpers/storekeepers/drivers) manage the
    // setup/dismantle photos of events they're crewed on — including
    // removing a wrong shot someone else on the crew uploaded. Service /
    // Exchange photos are office-managed, so crew can't delete those.
    if (row.phase === "service" || row.phase === "schedule") {
      return c.json({ error: "You don't have permission to delete this photo." }, 403);
    }
    const phases = await getUserPhasesOnProject(c.env, row.project_id, user?.id ?? 0, user?.name);
    if (!phases.includes(row.phase)) {
      return c.json({ error: "You don't have permission to delete this photo." }, 403);
    }
  }

  await c.env.DB.prepare(`DELETE FROM project_phase_photos WHERE id = ?`)
    .bind(photoId)
    .run();
  await c.env.POD_BUCKET.delete(row.r2_key).catch(() => {});
  return c.json({ ok: true });
});

// Manual resync endpoint — rebuilds project_finance from the lines.
// ── Floorplan size auto-detect (owner 2026-08-04) ─────────────
// "add features can read measurement for total size (sqm) from display
// floorplan, once display floorplan uploaded, auto read the measurement and
// fill in in size box."
//
// Reads the latest Display Floor Plan attachment with Claude vision (the SAME
// ANTHROPIC_API_KEY + base64 pattern the scan-SO pipeline already uses) and
// returns the total booth area in m². Writes projects.size_sqm only when the
// box is empty (or ?overwrite=1), so a hand-typed value is never clobbered.
// ALWAYS returns what it read + how, so the UI can show it and the operator
// can correct it — this is an assist, not an authority.
// ArrayBuffer -> base64. Workers expose no Node Buffer; the chunked loop keeps
// stack usage bounded on multi-MB plans (same approach as scan-so's toBase64).
// Floorplan size reading (owner 2026-08-04) lives in services/floorplanSize.ts
// — the prompt, the per-kind size ceilings and the write policy are the parts
// worth reading, and they do not belong in a route file.
app.post("/:id/floorplan/detect-size", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const ow = c.req.query("overwrite");
  const result = await detectFloorplanSize(c.env, id, {
    overwrite: ow === "auto" ? "auto" : ow === "1",
    userId: user?.id ?? null,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

app.post("/:id/finance/resync", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await syncFinanceRollup(c.env, id);
  return c.json({ ok: true });
});


app.post("/:id/payment", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    status?: string;
    notes?: string;
    proof_r2_key?: string;
    proof_file_name?: string;
  }>();
  if (!body.status) return c.json({ error: "status required" }, 400);
  const prior = await c.env.DB.prepare(
    `SELECT payment_status FROM projects WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(id)
    .first<{ payment_status: string | null }>();
  if (!prior) return c.json({ error: "Not found" }, 404);
  try {
    await setPaymentStatus(
      c.env,
      id,
      body.status,
      {
        notes: body.notes ?? undefined,
        proof_r2_key: body.proof_r2_key ?? undefined,
        proof_file_name: body.proof_file_name ?? undefined,
      },
      user?.id ?? 0
    );
    await logProjectActivity(
      c.env,
      id,
      "payment_status",
      prior?.payment_status ?? null,
      body.status,
      body.notes ?? null,
      user?.id
    );
    return c.json({ ok: true });
  } catch (e: any) {
    console.error("[POST /:id/payment]", id, body.status, e);
    return c.json({ error: e?.message || "Failed" }, 400);
  }
});

app.put("/:id/payment/proof", requirePermission("projects.write"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);
  if (!allowed.has(ext)) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const mime = ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/payment-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ key, mime_type: mime });
});


app.post("/:id/stock-transfers", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<{
    direction?: string;
    transferred_at?: string;
    record_r2_key?: string;
    file_name?: string;
    mime_type?: string;
    notes?: string;
  }>();
  const dir = body.direction as "out" | "return";
  if (!["out", "return"].includes(dir)) {
    return c.json({ error: "direction must be 'out' or 'return'" }, 400);
  }
  const result = await createStockTransfer(
    c.env,
    {
      project_id: id,
      direction: dir,
      transferred_at: body.transferred_at ?? null,
      record_r2_key: body.record_r2_key ?? null,
      file_name: body.file_name ?? null,
      mime_type: body.mime_type ?? null,
      notes: body.notes ?? null,
    },
    user?.id ?? 0
  );
  return c.json(result, 201);
});

app.put("/:id/stock-transfers/upload", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp", "pdf", "xlsx"]);
  if (!allowed.has(ext)) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const mime =
    ext === "pdf"
      ? "application/pdf"
      : ext === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/stock-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ key, mime_type: mime });
});

app.post("/stock-transfers/:tid/confirm", requirePermission("projects.write"), async (c) => {
  const tid = parseInt(c.req.param("tid"), 10);
  if (isNaN(tid)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_stock_transfers", tid); if (foreign) return foreign; }
  const user = c.get("user");
  const xfer = await c.env.DB.prepare(
    `SELECT project_id, direction FROM project_stock_transfers WHERE id = ?`
  )
    .bind(tid)
    .first<{ project_id: number; direction: string }>();
  const ok = await confirmStockTransfer(c.env, tid, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found" }, 404);
  if (xfer) {
    await logProjectActivity(
      c.env,
      xfer.project_id,
      "stock_transfer_confirmed",
      null,
      String(tid),
      `direction=${xfer.direction}`,
      user?.id
    );
  }
  return c.json({ ok: true });
});

app.post("/stock-transfers/:tid/unconfirm", requirePermission("projects.write"), async (c) => {
  const tid = parseInt(c.req.param("tid"), 10);
  if (isNaN(tid)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_stock_transfers", tid); if (foreign) return foreign; }
  const user = c.get("user");
  const xfer = await c.env.DB.prepare(
    `SELECT project_id, direction FROM project_stock_transfers WHERE id = ?`
  )
    .bind(tid)
    .first<{ project_id: number; direction: string }>();
  await unconfirmStockTransfer(c.env, tid);
  if (xfer) {
    await logProjectActivity(
      c.env,
      xfer.project_id,
      "stock_transfer_unconfirmed",
      String(tid),
      null,
      `direction=${xfer.direction}`,
      user?.id
    );
  }
  return c.json({ ok: true });
});

app.delete("/stock-transfers/:tid", requirePermission("projects.write"), async (c) => {
  const tid = parseInt(c.req.param("tid"), 10);
  if (isNaN(tid)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_stock_transfers", tid); if (foreign) return foreign; }
  await archiveStockTransfer(c.env, tid);
  return c.json({ ok: true });
});


app.post("/:id/checklist", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<{
    title?: string;
    description?: string;
    required_perm?: string;
    due_date?: string;
    owner_user_id?: number;
    seq?: number;
    section_id?: number | null;
  }>();
  if (!body.title || !body.title.trim()) {
    return c.json({ error: "title is required" }, 400);
  }
  const result = await createChecklistItem(
    c.env,
    {
      project_id: id,
      title: body.title.trim(),
      description: body.description ?? null,
      required_perm: body.required_perm ?? null,
      due_date: body.due_date ?? null,
      owner_user_id: body.owner_user_id ?? null,
      seq: body.seq ?? null,
      section_id: body.section_id ?? null,
    },
    user?.id ?? 0
  );
  return c.json(result, 201);
});

app.patch("/checklist/:itemId", requireAnyPermission(["projects.write", "projects.checklist.tick"]), async (c) => {
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_checklist", itemId); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();
  const keys = Object.keys(body);
  const notesOnly = keys.length > 0 && keys.every((k) => k === "notes");
  const granted = user?.permissions_set ?? user?.permissions;
  if (!notesOnly && !hasPermission(granted, "projects.write")) {
    return c.json({ error: "Requires projects.write" }, 403);
  }
  const ok = await patchChecklistItem(c.env, itemId, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "No changes" }, 400);
  return c.json({ ok: true });
});


app.post("/checklist/:itemId/status", requireAnyPermission(["projects.write", "projects.checklist.tick"]), async (c) => {
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_checklist", itemId); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<{ status?: string }>();
  const status = body.status as "pending" | "done" | "na" | "blocked";
  if (!["pending", "done", "na", "blocked"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const item = await c.env.DB.prepare(
    `SELECT required_perm, role_label FROM project_checklist WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(itemId)
    .first<{ required_perm: string | null; role_label: string | null }>();
  if (!item) return c.json({ error: "Not found" }, 404);
  if (item.required_perm) {
    // Approval keys are explicit-only (owner matrix 2026-07-21) — `*` does
    // not pass; see EXPLICIT_APPROVAL_KEYS.
    const has = holdsChecklistApproval(user.permissions, item.required_perm);
    // N/A — and its undo back to 'pending' — is the DOCUMENT OWNER's call,
    // not an approval decision (owner 2026-08-17: "user sim cannot click N/A
    // on her task please allowed her to click N/A"). The purchaser lane's
    // whole design expects Sim/Farra to N/A Exchange List / Stock In / Stock
    // Out when an event doesn't need one, but every one of those rows is
    // gated (stock_transfer.approve / stock_in.approve / projects.approve),
    // so this key check 403'd the exact flow the lane asks for. The key now
    // gates only the decision-equivalent transitions ('done' / 'blocked');
    // 'na' and 'pending' fall through to the role-badge gate below, which
    // still restricts them to the badged function (or projects.write).
    if (!has && status !== "na" && status !== "pending") {
      return c.json({ error: `Requires ${item.required_perm}` }, 403);
    }
    if (!has) {
      // Keyless N/A is the BADGED function's call ONLY (owner 2026-08-21:
      // "dont allowed purchase (sim and farra) edit or can click any button
      // on other task") — projects.write does NOT extend it to other
      // functions' gated rows; projects.manage (BD / managers) still may.
      const g = user?.permissions_set ?? user?.permissions;
      if (
        !roleLabelAdmits(item.role_label, user?.role_name) &&
        !hasPermission(g, "projects.manage")
      ) {
        return c.json({ error: "You can only update tasks assigned to your role" }, 403);
      }
    }
    if (has) {
      // Same brand scope as the review route (owner 2026-08-10) — a
      // brand-configured approver can only tick their own brands' gated steps.
      const denied = await approverBrandBlocked(c.env, user?.id, itemId);
      if (denied) {
        return c.json(
          {
            error: `You approve ${denied.brands.join(" / ")} events only — this one is ${denied.brand || "unbranded"}.`,
          },
          403,
        );
      }
    }
  }
  {
    const granted = user?.permissions_set ?? user?.permissions;
    // An APPROVER of a gated step is exempt (owner 2026-08-10): the
    // required_perm + brand gate above already decided it, and the row is
    // badged for the SUBMITTER's function (Stock Out = PURCHASER), so the badge
    // test would otherwise block a view-only approver such as Kris.
    const isGatedApprover =
      !!item.required_perm && holdsChecklistApproval(user.permissions, item.required_perm);
    if (!hasPermission(granted, "projects.write") && !isGatedApprover) {
      if (!roleLabelAdmits(item.role_label, user?.role_name)) {
        return c.json({ error: "You can only update tasks assigned to your role" }, 403);
      }
    }
  }
  const ok = await setChecklistStatus(c.env, itemId, status, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});


app.post("/checklist/:itemId/review", requireAnyPermission(["projects.write", "projects.checklist.tick"]), async (c) => {
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_checklist", itemId); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<{ action?: string; reason?: string; note?: string }>();
  const action = body.action as "submit" | "reject" | "amend" | "approve" | "comment";
  const item = await c.env.DB.prepare(
    `SELECT required_perm, role_label FROM project_checklist WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(itemId)
    .first<{ required_perm: string | null; role_label: string | null }>();
  if (!item) return c.json({ error: "Not found" }, 404);

  if ((action === "approve" || action === "reject") && item.required_perm) {
    // Approval keys are explicit-only (owner matrix 2026-07-21) — `*` does
    // not pass; see EXPLICIT_APPROVAL_KEYS.
    const has = holdsChecklistApproval(user.permissions, item.required_perm);
    if (!has) return c.json({ error: `Requires ${item.required_perm}` }, 403);
    // BRAND-SCOPED approval (owner 2026-08-10): "kris approve stock out
    // transfer akemi and ergotex only, for zanotti peter approve". An approver
    // who has explicit brand rows may only decide on those brands; an approver
    // with NO rows (Peter, HQ) keeps every brand, so this only ever narrows the
    // people it is configured for.
    const denied = await approverBrandBlocked(c.env, user?.id, itemId);
    if (denied) {
      return c.json(
        {
          error: `You approve ${denied.brands.join(" / ")} events only — this one is ${denied.brand || "unbranded"}.`,
        },
        403,
      );
    }
  }
  // Per-function gate for tick-only roles (Sales-department visibility, rules
  // 4 & 6) — parity with the status / attachments routes, so the review loop
  // can't be used to progress another function's task. A user without
  // projects.write may only submit/amend a task badged for THEIR role.
  // `comment` stays open (collaboration); approve/reject are already
  // required_perm-gated above.
  // Owner 2026-08-10: approve/reject are EXEMPT — they are governed by the
  // required_perm gate above (plus the brand scope), not by the task's role
  // badge. Without this a permitted approver who lacks projects.write (a
  // view-only Sales Director such as Kris) was blocked here, because the Stock
  // Out row is badged PURCHASER, so granting the approval key alone did nothing.
  if (action === "submit" || action === "amend") {
    const granted = user?.permissions_set ?? user?.permissions;
    if (!hasPermission(granted, "projects.write")) {
      if (!roleLabelAdmits(item.role_label, user?.role_name)) {
        return c.json({ error: "You can only update tasks assigned to your role" }, 403);
      }
    }
  }

  try {
    switch (action) {
      case "submit":
        await submitChecklistForReview(c.env, itemId, user?.id ?? 0);
        break;
      case "reject":
        if (!body.reason || !body.reason.trim()) {
          return c.json({ error: "reason required" }, 400);
        }
        await rejectChecklistItem(c.env, itemId, body.reason.trim(), user?.id ?? 0);
        break;
      case "amend":
        await amendChecklistItem(c.env, itemId, body.note ?? null, user?.id ?? 0);
        break;
      case "approve":
        await approveChecklistItem(c.env, itemId, user?.id ?? 0);
        break;
      case "comment":
        await addChecklistComment(c.env, itemId, "note", body.note ?? null, user?.id ?? 0);
        break;
      default:
        return c.json({ error: "invalid action" }, 400);
    }
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed" }, 500);
  }
  return c.json({ ok: true });
});


app.post("/:id/sections", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const body = await c.req.json<{ name?: string; sort_order?: number }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  let order = body.sort_order;
  if (order == null) {
    const max = await c.env.DB.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) AS s
         FROM project_checklist_sections WHERE project_id = ?${activeCompanySql(c)}`
    )
      .bind(id)
      .first<{ s: number }>();
    order = (max?.s ?? 0) + 10;
  }
  const sectionCo = activeCompanyId(c);
  const r = await c.env.DB.prepare(
    `INSERT INTO project_checklist_sections (project_id, name, sort_order${sectionCo != null ? ", company_id" : ""})
     VALUES (?, ?, ?${sectionCo != null ? ", ?" : ""})`
  )
    .bind(id, name, order, ...(sectionCo != null ? [sectionCo] : []))
    .run();
  return c.json({ id: r.meta.last_row_id, name, sort_order: order }, 201);
});

app.patch("/sections/:sectionId", requirePermission("projects.write"), async (c) => {
  const sectionId = parseInt(c.req.param("sectionId"), 10);
  if (isNaN(sectionId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_checklist_sections", sectionId); if (foreign) return foreign; }
  const body = await c.req.json<{
    name?: string;
    sort_order?: number;
    display_mode?: "list" | "documents";
  }>();
  const sets: string[] = [];
  const binds: any[] = [];
  if ("name" in body) {
    const n = (body.name || "").trim();
    if (!n) return c.json({ error: "name cannot be empty" }, 400);
    sets.push("name = ?");
    binds.push(n);
  }
  if ("sort_order" in body) {
    sets.push("sort_order = ?");
    binds.push(body.sort_order ?? 0);
  }
  if ("display_mode" in body) {
    const mode = body.display_mode === "documents" ? "documents" : "list";
    sets.push("display_mode = ?");
    binds.push(mode);
  }
  if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);
  binds.push(sectionId);
  await c.env.DB.prepare(
    `UPDATE project_checklist_sections SET ${sets.join(", ")} WHERE id = ?${activeCompanySql(c)}`
  )
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

app.delete("/sections/:sectionId", requirePermission("projects.write"), async (c) => {
  const sectionId = parseInt(c.req.param("sectionId"), 10);
  if (isNaN(sectionId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_checklist_sections", sectionId); if (foreign) return foreign; }
  await c.env.DB.prepare(
    `UPDATE project_checklist SET section_id = NULL
      WHERE section_id IN (SELECT id FROM project_checklist_sections WHERE id = ?${activeCompanySql(c)})`,
  )
    .bind(sectionId)
    .run();
  await c.env.DB.prepare(`DELETE FROM project_checklist_sections WHERE id = ?${activeCompanySql(c)}`)
    .bind(sectionId)
    .run();
  return c.json({ ok: true });
});

app.put("/:id/sections/reorder", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const body = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(body.ids) || !body.ids.every((n) => Number.isInteger(n))) {
    return c.json({ error: "ids must be an array of integers" }, 400);
  }
  const ids = body.ids as number[];
  if (ids.length === 0) return c.json({ ok: true });
  const stmts = ids.map((sectionId, idx) =>
    c.env.DB
      .prepare(
        `UPDATE project_checklist_sections
            SET sort_order = ?
          WHERE id = ? AND project_id = ?${activeCompanySql(c)}`
      )
      .bind((idx + 1) * 10, sectionId, id)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});


const TASK_ATTACH_ALLOWED = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "heic", "mp4", "mov",
  "doc", "docx", "xls", "xlsx", "csv", "txt", "dwg", "skp",
]);
const TASK_ATTACH_MAX = 25 * 1024 * 1024;

function taskAttachmentKey(itemId: number, ext: string): string {
  return `task-attach/${itemId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

app.put(
  "/checklist/:itemId/attachments",
  requireAnyPermission(["projects.write", "projects.checklist.tick"]),
  async (c) => {
    const itemId = parseInt(c.req.param("itemId"), 10);
    if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
    { const foreign = await refuseForeignChild(c, "project_checklist", itemId); if (foreign) return foreign; }
    const user = c.get("user");
    const granted = user?.permissions_set ?? user?.permissions;
    const item = await c.env.DB.prepare(
      `SELECT title, required_perm, role_label, status, review_status FROM project_checklist WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(itemId)
      .first<{ title: string | null; required_perm: string | null; role_label: string | null; status: string | null; review_status: string | null }>();
    if (!item) return c.json({ error: "Not found" }, 404);
    // Owner 2026-07-21: required_perm gates the DECISION (approve/reject +
    // status flips), NOT the upload. The document's owner function uploads it
    // (e.g. the Purchaser files the Stock Out Transfer Record) and the
    // approvers decide on it — demanding the approval key here is what locked
    // purchasers out of their own documents. Uploads stay gated by
    // projects.write / the role_label rule below.
    // Tick-only roles (no projects.write — i.e. drivers) may only attach to
    // tasks badged for THEIR role (item.role_label vs the user's role name).
    // Mirrors the mobile UI rule; owner 2026-07-09.
    if (!hasPermission(granted, "projects.write") && !salesDirectorMayAttach(item.title, user?.position_name)) {
      if (!roleLabelAdmits(item.role_label, user?.role_name)) {
        return c.json({ error: "You can only attach files to tasks assigned to your role" }, 403);
      }
    }
    const ext = (c.req.query("ext") || "").toLowerCase();
    const fileName = c.req.query("name") || `attachment.${ext}`;
    const caption = (c.req.query("caption") || "").slice(0, 2000) || null;
    if (!TASK_ATTACH_ALLOWED.has(ext)) {
      return c.json({ error: `Extension '${ext}' not allowed` }, 400);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength > TASK_ATTACH_MAX) {
      return c.json({ error: "File too large (max 25MB)" }, 400);
    }
    const contentType =
      ext === "mp4" ? "video/mp4" :
      ext === "mov" ? "video/quicktime" :
      ext === "pdf" ? "application/pdf" :
      ext === "doc" ? "application/msword" :
      ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" :
      ext === "xls" ? "application/vnd.ms-excel" :
      ext === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :
      ext === "csv" ? "text/csv" :
      ext === "txt" ? "text/plain" :
      ext === "dwg" ? "application/acad" :
      ext === "skp" ? "application/vnd.sketchup.skp" :
      `image/${ext === "jpg" ? "jpeg" : ext}`;
    const key = taskAttachmentKey(itemId, ext);
    await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
    const attachCo = activeCompanyId(c);
    const coCol = attachCo != null ? ", company_id" : "";
    const coVal = attachCo != null ? ", ?" : "";
    const coBind = attachCo != null ? [attachCo] : [];
    const r = await c.env.DB.prepare(
      `INSERT INTO project_checklist_attachments
         (item_id, r2_key, file_name, content_type, size_bytes, uploaded_by, caption${coCol})
       VALUES (?, ?, ?, ?, ?, ?, ?${coVal})`
    )
      .bind(itemId, key, fileName, contentType, body.byteLength, user?.id ?? null, caption, ...coBind)
      .run();
    // Per-item history — record the upload as a comment so the task history
    // panel shows "Uploaded X.pdf · Sim · 06/08 10:34" alongside approve/reject.
    // Owner 2026-07-20: without this, the reviewer sees the Approve button reappear
    // after a re-upload with no explanation of WHY, then wonders "no new file
    // was uploaded but why approval reappear?". The comment closes that gap.
    // coCol / coVal stamp company_id here too, from the same resolved company.
    await c.env.DB.prepare(
      `INSERT INTO project_checklist_comments (item_id, kind, body, user_id${coCol})
       VALUES (?, 'upload', ?, ?${coVal})`
    )
      .bind(itemId, fileName, user?.id ?? null, ...coBind)
      .run();
    // SERVER-side auto-submit (owner 2026-08-21, docs/bugs/0490): uploading to
    // a gated document IS the submission. Desktop called /review submit after
    // upload but MOBILE never did, so phone uploads sat with review_status
    // NULL — excluded from no lane, routed to no approver, and stuck in the
    // uploader's own My Pending ("stock out transfer sim already uploaded but
    // still appear on my pending task sim"). Submitting here is
    // client-independent; a client's own submit right after is a no-op re-set.
    if (
      item.required_perm &&
      (item.status ?? "") === "pending" &&
      !["pending_review", "amended"].includes(item.review_status ?? "")
    ) {
      await submitChecklistForReview(c.env, itemId, user?.id ?? 0);
    }
    await autoTickChecklistOnUpload(c.env, item, itemId, user?.id ?? 0);
    const owner = await c.env.DB.prepare(
      `SELECT project_id, title FROM project_checklist WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(itemId)
      .first<{ project_id: number; title: string }>();
    if (owner) {
      await logProjectActivity(
        c.env,
        owner.project_id,
        "document_upload",
        null,
        fileName,
        owner.title,
        user?.id,
      );
      // Floorplan uploaded → read the m² and fill the Size box, server-side
      // (owner 2026-08-14: "button auto beside size i need to click manually?
      // once display floorplan uploaded make sure auto read the measurement and
      // fill in size box"). It ran in the DESKTOP upload handler only, so a
      // mobile upload never triggered it. Doing it here covers every client —
      // desktop, mobile, paste — and any future one.
      //
      // waitUntil: the model call takes seconds and must not hold the upload
      // response. "auto" leaves a hand-typed size alone but refreshes one a
      // previous read wrote, so re-uploading a corrected plan updates the box.
      if (isFloorplanTitle(owner.title)) {
        const uid = user?.id ?? null;
        const pid = owner.project_id;
        const run = detectFloorplanSize(c.env, pid, { overwrite: "auto", userId: uid }).catch((e) =>
          console.warn("[floorplan-size] auto-read failed", pid, e),
        );
        c.executionCtx?.waitUntil?.(run);
      }
    }
    return c.json(
      {
        id: r.meta.last_row_id,
        item_id: itemId,
        r2_key: key,
        file_name: fileName,
        content_type: contentType,
        size_bytes: body.byteLength,
        uploaded_at: new Date().toISOString(),
      },
      201
    );
  }
);

app.delete(
  "/checklist/attachments/:attId",
  // Crew (tick-only: drivers/helpers/storekeepers) may remove files from the
  // DRIVER-badged Setup/Dismantle tasks they upload to — mirrors the attach
  // gate above (owner 2026-07-16). Everything else stays projects.write-only.
  requireAnyPermission(["projects.write", "projects.checklist.tick"]),
  async (c) => {
    const attId = parseInt(c.req.param("attId"), 10);
    if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
    { const foreign = await refuseForeignChild(c, "project_checklist_attachments", attId); if (foreign) return foreign; }
    const user = c.get("user");
    const granted = user?.permissions_set ?? user?.permissions;
    if (!hasPermission(granted, "projects.write")) {
      const row = await c.env.DB.prepare(
        `SELECT pc.role_label
           FROM project_checklist_attachments a
           JOIN project_checklist pc ON pc.id = a.item_id
          WHERE a.id = ?${activeCompanySql(c, "a.company_id")}`
      )
        .bind(attId)
        .first<{ role_label: string | null }>();
      if (!row) return c.json({ error: "Not found" }, 404);
      if (!roleLabelAdmits(row.role_label, user?.role_name)) {
        return c.json(
          { error: "You can only remove files from tasks assigned to your role" },
          403,
        );
      }
    }
    // Fetch item_id + filename BEFORE archiving so we can log the removal to
    // the per-item history panel (owner 2026-07-20 — see the upload sibling).
    const rmMeta = await c.env.DB.prepare(
      `SELECT item_id, file_name FROM project_checklist_attachments WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(attId)
      .first<{ item_id: number; file_name: string }>();
    await c.env.DB.prepare(
      `UPDATE project_checklist_attachments
          SET archived_at = datetime('now')
        WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(attId)
      .run();
    if (rmMeta) {
      const rmCo = activeCompanyId(c);
      await c.env.DB.prepare(
        `INSERT INTO project_checklist_comments (item_id, kind, body, user_id${rmCo != null ? ", company_id" : ""})
         VALUES (?, 'remove', ?, ?${rmCo != null ? ", ?" : ""})`
      )
        .bind(rmMeta.item_id, rmMeta.file_name, user?.id ?? null, ...(rmCo != null ? [rmCo] : []))
        .run();
    }
    return c.json({ ok: true });
  }
);

// Per-attachment remark (owner 2026-07-16): each uploaded photo carries its own
// caption, edited inline from the Defect List / photo checklist rows. Same
// permission gate as delete — tick-only users may only edit files on tasks
// badged for their role.
app.patch(
  "/checklist/attachments/:attId",
  requireAnyPermission(["projects.write", "projects.checklist.tick"]),
  async (c) => {
    const attId = parseInt(c.req.param("attId"), 10);
    if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
    { const foreign = await refuseForeignChild(c, "project_checklist_attachments", attId); if (foreign) return foreign; }
    const user = c.get("user");
    const granted = user?.permissions_set ?? user?.permissions;
    const body = await c.req.json<{ caption?: string | null }>();
    const row = await c.env.DB.prepare(
      `SELECT pc.role_label, pc.title
         FROM project_checklist_attachments a
         JOIN project_checklist pc ON pc.id = a.item_id
        WHERE a.id = ?${activeCompanySql(c, "a.company_id")}`
    )
      .bind(attId)
      .first<{ role_label: string | null; title: string | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (
      !hasPermission(granted, "projects.write") &&
      !salesDirectorMayAttach(row.title, user?.position_name, user?.position_policy ?? null)
    ) {
      if (!roleLabelAdmits(row.role_label, user?.role_name)) {
        return c.json(
          { error: "You can only edit files on tasks assigned to your role" },
          403,
        );
      }
    }
    const caption =
      typeof body.caption === "string" ? body.caption.slice(0, 2000) : null;
    await c.env.DB.prepare(
      `UPDATE project_checklist_attachments SET caption = ? WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(caption, attId)
      .run();
    return c.json({ ok: true });
  }
);

// Per-attachment ACTION TIMELINE (owner 2026-07-29; five-state 2026-11-20):
// append-only — each click ADDS one entry (optional remark), history is never
// overwritten. The reviewer (Shukor/Nancy) triages a fresh defect with
// 'done_clean', 'exchange' or 'service'; the purchaser (Farra)/BD then works an
// escalation with 'in_progress' then 'done'. Lanes + stage: defectStage
// (frontend) and listProjects (DEFECT_REVIEW / PURCHASER arms). Admins act as either.
app.post(
  "/checklist/attachments/:attId/actions",
  requireAnyPermission(["projects.write", "projects.checklist.tick"]),
  async (c) => {
    const attId = parseInt(c.req.param("attId"), 10);
    if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
    { const foreign = await refuseForeignChild(c, "project_checklist_attachments", attId); if (foreign) return foreign; }
    const user = c.get("user");
    const granted = user?.permissions_set ?? user?.permissions;
    const role = (user?.role_name ?? "").toLowerCase();
    const isAdmin = hasPermission(granted, "*") || hasPermission(granted, "projects.manage");
    // Region split (owner 2026-08-11): Nancy the Ops Exec reviews the region
    // states, Shukor the Storekeeper Supervisor the rest; the purchaser/BD close.
    const isReviewer = isDefectReviewerPosition(user) || role === "ops exec";
    const isPurchaser = role.includes("purchaser") || role.includes("bd");
    if (!isAdmin && !isReviewer && !isPurchaser) return c.json({ error: "Only a defect reviewer, purchaser or BD can log defect actions" }, 403);
    const body = await c.req.json<{ status?: string; remark?: string | null }>();
    const status = (body.status ?? "").toLowerCase();
    const REVIEWER_STATUSES = new Set(["done_clean", "exchange", "service"]);
    const PURCHASER_STATUSES = new Set(["in_progress", "done"]);
    if (!REVIEWER_STATUSES.has(status) && !PURCHASER_STATUSES.has(status)) return c.json({ error: "status must be one of done_clean, exchange, service, in_progress, done" }, 400);
    if (REVIEWER_STATUSES.has(status) && !isReviewer && !isAdmin) return c.json({ error: "Only a defect reviewer can clean or escalate a defect" }, 403);
    if (PURCHASER_STATUSES.has(status) && !isPurchaser && !isAdmin) return c.json({ error: "Only the purchaser or BD can mark a defect in progress or done" }, 403);
    const att = await c.env.DB.prepare(
      `SELECT a.id, p.state
         FROM project_checklist_attachments a
         JOIN project_checklist pc ON pc.id = a.item_id
         JOIN projects p ON p.id = pc.project_id
        WHERE a.id = ? AND a.archived_at IS NULL${activeCompanySql(c, "p.company_id")}`
    )
      .bind(attId)
      .first<{ id: number; state: string | null }>();
    if (!att) return c.json({ error: "Not found" }, 404);
    // Region routing is a RULE, not a UI hint (owner 2026-08-14: "sabah sarawak
    // defect under shukor ya not nancy"). My Pending and the frontend buttons
    // already split by state, but this route accepted a stamp from either
    // reviewer on any project — so a mis-tap or a stale tab could still close a
    // Sarawak defect as Nancy. Each reviewer may act only on their own states;
    // admins and the purchaser/BD closing an escalation are unaffected.
    if (!isAdmin && isReviewer && !isPurchaser && REVIEWER_STATUSES.has(status)) {
      const inRegion = isDefectRegionState(att.state);
      const mine = role === "ops exec" ? inRegion : !inRegion;
      if (!mine) {
        return c.json(
          {
            error: inRegion
              ? "This state is reviewed by the Ops Exec, not the Storekeeper Supervisor"
              : "This state is reviewed by the Storekeeper Supervisor, not the Ops Exec",
          },
          403,
        );
      }
    }
    const remark =
      typeof body.remark === "string" && body.remark.trim()
        ? body.remark.slice(0, 2000)
        : null;
    await c.env.DB.prepare(
      `INSERT INTO project_checklist_attachment_actions (attachment_id, status, remark, user_id)
       VALUES (?, ?, ?, ?)`
    )
      .bind(attId, status, remark, user?.id ?? null)
      .run();
    return c.json({ ok: true });
  }
);


app.post(
  "/checklist-templates/:id/sections",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{ name?: string; sort_order?: number }>();
    const name = (body.name || "").trim();
    if (!name) return c.json({ error: "name is required" }, 400);
    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);
    if (!(await findTemplateInCompany(c, id))) {
      return c.json({ error: "Not found" }, 404);
    }
    let order = body.sort_order;
    if (order == null) {
      const max = await c.env.DB.prepare(
        `SELECT COALESCE(MAX(sort_order), 0) AS s
           FROM project_checklist_template_sections WHERE template_id = ?`
      )
        .bind(id)
        .first<{ s: number }>();
      order = (max?.s ?? 0) + 10;
    }
    const r = await c.env.DB.prepare(
      `INSERT INTO project_checklist_template_sections (template_id, name, sort_order, company_id)
       VALUES (?, ?, ?, ?)`
    )
      .bind(id, name, order, co.companyId)
      .run();
    return c.json({ id: r.meta.last_row_id, name, sort_order: order }, 201);
  }
);

app.patch(
  "/checklist-templates/sections/:sectionId",
  requirePermission("projects.manage"),
  async (c) => {
    const sectionId = parseInt(c.req.param("sectionId"), 10);
    if (isNaN(sectionId)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{
      name?: string;
      sort_order?: number;
      display_mode?: "list" | "documents";
    }>();
    const sets: string[] = [];
    const binds: any[] = [];
    if ("name" in body) {
      const n = (body.name || "").trim();
      if (!n) return c.json({ error: "name cannot be empty" }, 400);
      sets.push("name = ?");
      binds.push(n);
    }
    if ("sort_order" in body) {
      sets.push("sort_order = ?");
      binds.push(body.sort_order ?? 0);
    }
    if ("display_mode" in body) {
      const mode = body.display_mode === "documents" ? "documents" : "list";
      sets.push("display_mode = ?");
      binds.push(mode);
    }
    if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);
    binds.push(sectionId);
    // company-scope: no template id in this URL, so the row's own company_id is
    // the predicate.
    const sectionCoSql = activeCompanySql(c);
    const r = await c.env.DB.prepare(
      `UPDATE project_checklist_template_sections SET ${sets.join(", ")} WHERE id = ?${sectionCoSql}`
    )
      .bind(...binds)
      .run();
    if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  }
);

app.delete(
  "/checklist-templates/sections/:sectionId",
  requirePermission("projects.manage"),
  async (c) => {
    const sectionId = parseInt(c.req.param("sectionId"), 10);
    if (isNaN(sectionId)) return c.json({ error: "Invalid ID" }, 400);
    // company-scope: the row's own company_id, as in the PATCH above.
    const r = await c.env.DB.prepare(
      `DELETE FROM project_checklist_template_sections WHERE id = ?${activeCompanySql(c)}`
    )
      .bind(sectionId)
      .run();
    if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  }
);

app.put(
  "/checklist-templates/:id/sections/reorder",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{ ids?: unknown }>();
    if (!Array.isArray(body.ids) || !body.ids.every((n) => Number.isInteger(n))) {
      return c.json({ error: "ids must be an array of integers" }, 400);
    }
    const ids = body.ids as number[];
    if (ids.length === 0) return c.json({ ok: true });
    if (!(await findTemplateInCompany(c, id))) {
      return c.json({ error: "Not found" }, 404);
    }
    const coSql = activeCompanySql(c);
    const stmts = ids.map((sectionId, idx) =>
      c.env.DB
        .prepare(
          `UPDATE project_checklist_template_sections
              SET sort_order = ?
            WHERE id = ? AND template_id = ?${coSql}`
        )
        .bind((idx + 1) * 10, sectionId, id)
    );
    await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  }
);


app.post("/:id/defects", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<{
    phase?: string;
    reported_by_role?: string;
    item_code?: string;
    item_description?: string;
    size?: string;
    quantity?: number;
    reason?: string;
    photo_r2_key?: string;
  }>();
  const phase = body.phase as "setup" | "dismantle";
  const role = body.reported_by_role as "sales" | "logistic";
  if (!["setup", "dismantle"].includes(phase)) return c.json({ error: "Something went wrong. Please try again." }, 400);
  if (!["sales", "logistic"].includes(role)) return c.json({ error: "Something went wrong. Please try again." }, 400);
  const result = await createDefect(
    c.env,
    {
      project_id: id,
      phase,
      reported_by_role: role,
      item_code: body.item_code ?? null,
      item_description: body.item_description ?? null,
      size: body.size ?? null,
      quantity: body.quantity ?? 1,
      reason: body.reason ?? null,
      photo_r2_key: body.photo_r2_key ?? null,
    },
    user?.id ?? 0
  );
  return c.json(result, 201);
});

app.patch("/defects/:defectId", requirePermission("projects.write"), async (c) => {
  const defectId = parseInt(c.req.param("defectId"), 10);
  if (isNaN(defectId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_defects", defectId); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchDefect(c.env, defectId, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "No changes" }, 400);
  return c.json({ ok: true });
});

app.delete("/defects/:defectId", requirePermission("projects.write"), async (c) => {
  const defectId = parseInt(c.req.param("defectId"), 10);
  if (isNaN(defectId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_defects", defectId); if (foreign) return foreign; }
  await archiveDefect(c.env, defectId);
  return c.json({ ok: true });
});

app.put("/:id/defects/photo", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp"]);
  if (!allowed.has(ext)) return c.json({ error: "ext must be image" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const contentType = `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/defect-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  return c.json({ key });
});


app.post("/:id/sales-reports", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const user = c.get("user");
  const body = await c.req.json<{
    title?: string;
    sales_amount?: number;
    period_start?: string;
    period_end?: string;
    r2_key?: string;
    file_name?: string;
    mime_type?: string;
    sync_to_finance?: boolean;
  }>();
  const result = await createSalesReport(
    c.env,
    {
      project_id: id,
      title: body.title ?? null,
      sales_amount: typeof body.sales_amount === "number" ? body.sales_amount : null,
      period_start: body.period_start ?? null,
      period_end: body.period_end ?? null,
      r2_key: body.r2_key ?? null,
      file_name: body.file_name ?? null,
      mime_type: body.mime_type ?? null,
    },
    user?.id ?? 0,
    { syncToFinance: body.sync_to_finance !== false }
  );
  return c.json(result, 201);
});

app.delete("/sales-reports/:reportId", requirePermission("projects.write"), async (c) => {
  const reportId = parseInt(c.req.param("reportId"), 10);
  if (isNaN(reportId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_sales_reports", reportId); if (foreign) return foreign; }
  await archiveSalesReport(c.env, reportId, true);
  return c.json({ ok: true });
});

app.put("/:id/sales-reports/upload", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);
  if (!allowed.has(ext)) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const contentType =
    ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/sales-report-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  return c.json({ key, mime_type: contentType });
});

app.post("/:id/sales-reports/resync", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await syncSalesTotalFromReports(c.env, id);
  return c.json({ ok: true });
});

app.delete("/checklist/:itemId", requirePermission("projects.write"), async (c) => {
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_checklist", itemId); if (foreign) return foreign; }
  const user = c.get("user");
  const ok = await deleteChecklistItem(c.env, itemId, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});


app.post("/:id/team", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const body = await c.req.json<{ user_id?: number; role?: string }>();
  if (!body.user_id) return c.json({ error: "Please choose a team member." }, 400);
  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO project_team (project_id, user_id, role) VALUES (?, ?, ?)`
    )
      .bind(id, body.user_id, body.role || null)
      .run();
    return c.json({ id: r.meta.last_row_id }, 201);
  } catch {
    return c.json({ error: "This person is already on the team with that role." }, 409);
  }
});

app.delete("/team/:teamId", requirePermission("projects.write"), async (c) => {
  const teamId = parseInt(c.req.param("teamId"), 10);
  if (isNaN(teamId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_team", teamId); if (foreign) return foreign; }
  await c.env.DB.prepare(`DELETE FROM project_team WHERE id = ?`).bind(teamId).run();
  return c.json({ ok: true });
});



app.post("/:id/sales-attendees", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const user = c.get("user");
  // Owner 2026-07-20: reversed the 2026-07-18 block — a Sales Director may now
  // change Sales Attending, like everyone else holding projects.write.
  const picked = await attendeeRepId(c.env, activeCompanyId(c), await c.req.json(), user?.id ?? null, id);
  if (!picked.ok) return c.json({ error: picked.error }, 400);
  try {
    await c.env.DB.prepare(
      `INSERT INTO project_sales_attendees (project_id, sales_rep_id, created_by)
       VALUES (?, ?, ?)`
    )
      .bind(id, picked.repId, user?.id ?? null)
      .run();
    const rep = await c.env.DB.prepare(
      `SELECT code, name FROM sales_reps WHERE id = ?`
    )
      .bind(picked.repId)
      .first<{ code: string; name: string }>();
    await logProjectActivity(
      c.env,
      id,
      "sales_attendee_add",
      null,
      rep ? `${rep.code} ${rep.name}` : String(picked.repId),
      null,
      user?.id
    );
    return c.json({ ok: true }, 201);
  } catch {
    return c.json({ error: "That sales attendee is already assigned to this project." }, 409);
  }
});

app.delete(
  "/:id/sales-attendees/:repId",
  requirePermission("projects.write"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const repId = parseInt(c.req.param("repId"), 10);
    if (isNaN(id) || isNaN(repId)) return c.json({ error: "Invalid ID" }, 400);
    { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
    const user = c.get("user");
    // Owner 2026-07-20: reversed the 2026-07-18 block — a Sales Director may now
    // remove Sales Attending too, like everyone else holding projects.write.
    const rep = await c.env.DB.prepare(
      `SELECT code, name FROM sales_reps WHERE id = ?`
    )
      .bind(repId)
      .first<{ code: string; name: string }>();
    await c.env.DB.prepare(
      `DELETE FROM project_sales_attendees
        WHERE project_id = ? AND sales_rep_id = ?`
    )
      .bind(id, repId)
      .run();
    await logProjectActivity(
      c.env,
      id,
      "sales_attendee_remove",
      rep ? `${rep.code} ${rep.name}` : String(repId),
      null,
      null,
      user?.id
    );
    return c.json({ ok: true });
  }
);


const PROJECT_ATTACH_ALLOWED = new Set([
  "jpg", "jpeg", "png", "webp", "mp4", "pdf",
  "dwg", "skp",
]);
const PROJECT_ATTACH_MAX = 25 * 1024 * 1024;

function projectAttachmentKey(projectId: number, category: string, ext: string): string {
  return `projects/${projectId}/${category}-${Date.now()}.${ext}`;
}

const PROJECT_ATTACH_ROLES = new Set(["sales", "driver", "design", "office"]);

app.put("/:id/attachments", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignProject(c, id); if (foreign) return foreign; }
  const user = c.get("user");
  const category = (c.req.query("category") || "other").toLowerCase();
  const ext = (c.req.query("ext") || "").toLowerCase();
  const fileName = c.req.query("name") || null;
  const roleParam = (c.req.query("role") || "").toLowerCase();
  const role = PROJECT_ATTACH_ROLES.has(roleParam) ? roleParam : null;
  if (!PROJECT_ATTACH_ALLOWED.has(ext)) {
    return c.json({ error: `Extension '${ext}' not allowed` }, 400);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength > PROJECT_ATTACH_MAX) {
    return c.json({ error: "File too large (max 25MB)" }, 400);
  }
  const contentType =
    ext === "mp4" ? "video/mp4" :
    ext === "pdf" ? "application/pdf" :
    ext === "dwg" ? "application/acad" :
    ext === "skp" ? "application/vnd.sketchup.skp" :
    `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = projectAttachmentKey(id, category, ext);
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  const r = await c.env.DB.prepare(
    `INSERT INTO project_attachments
       (project_id, category, r2_key, file_name, mime_type, size_bytes,
        uploaded_by, uploaded_by_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, category, key, fileName, contentType, body.byteLength, user?.id ?? null, role)
    .run();
  await logProjectActivity(
    c.env,
    id,
    "attachment_add",
    role,
    fileName || category,
    null,
    user?.id
  );
  return c.json({ id: r.meta.last_row_id, key }, 201);
});

app.get("/attachments/:key{.+}", async (c) => {
  const key = c.req.param("key");
  { const foreign = await refuseForeignAttachmentKey(c, key); if (foreign) return foreign; }
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

app.post("/attachments/:attId/archive", requirePermission("projects.write"), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_attachments", attId); if (foreign) return foreign; }
  await c.env.DB.prepare(
    `UPDATE project_attachments SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(attId)
    .run();
  return c.json({ ok: true });
});

app.patch("/attachments/:attId", requirePermission("projects.write"), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  { const foreign = await refuseForeignChild(c, "project_attachments", attId); if (foreign) return foreign; }
  const body = await c.req.json<{
    file_name?: string | null;
    category?: string | null;
    uploaded_by_role?: string | null;
  }>();
  const sets: string[] = [];
  const binds: any[] = [];
  if ("file_name" in body) {
    const v = (body.file_name || "").toString().trim();
    if (!v) return c.json({ error: "file_name cannot be empty" }, 400);
    sets.push("file_name = ?");
    binds.push(v);
  }
  if ("category" in body) {
    sets.push("category = ?");
    binds.push((body.category || "").toString().trim() || null);
  }
  if ("uploaded_by_role" in body) {
    const r = (body.uploaded_by_role || "").toString().toLowerCase();
    sets.push("uploaded_by_role = ?");
    binds.push(["sales", "driver", "design", "office"].includes(r) ? r : null);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  binds.push(attId);
  const r = await c.env.DB.prepare(
    `UPDATE project_attachments SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});


app.get("/calendar/events", requirePageAccess("projects.calendar"), async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) return c.json({ error: "from & to required (YYYY-MM-DD)" }, 400);

  const { scopeWhere, scopeBinds } = calendarCrewScope(c);
  const coSql = activeCompanySql(c, "p.company_id");

  const projects = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.stage, p.status, p.brand, p.organizer,
            p.start_date, p.end_date, p.venue, p.state,
            et.name AS event_type_name,
            (SELECT s.name FROM project_checklist_sections s
              WHERE s.project_id = p.id
                AND EXISTS (
                  SELECT 1 FROM project_checklist c
                   WHERE c.project_id = p.id
                     AND c.section_id = s.id
                     AND c.status NOT IN ('done','na')
                )
              ORDER BY s.sort_order LIMIT 1) AS active_section_name,
            (SELECT COUNT(*) FROM project_checklist_sections s
              WHERE s.project_id = p.id) AS sections_total
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
      WHERE p.archived_at IS NULL
        AND p.start_date IS NOT NULL
        AND substr(p.start_date, 1, 10) <= substr(?, 1, 10)
        AND substr(COALESCE(p.end_date, p.start_date), 1, 10) >= substr(?, 1, 10)${scopeWhere}${coSql}`
  )
    .bind(to, from, ...scopeBinds)
    .all();

  const tasks = await c.env.DB.prepare(
    `SELECT c.id, c.project_id, c.title, c.due_date, c.status,
            c.required_perm, c.review_status,
            p.code as project_code, p.brand, p.organizer, p.status as project_status,
            p.name as project_name,
            u.name as owner_name,
            CASE WHEN substr(c.due_date, 1, 10) < ? THEN 1 ELSE 0 END as is_overdue
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE p.archived_at IS NULL
        AND c.status != 'done'
        AND c.status != 'na'
        AND c.due_date IS NOT NULL
        AND substr(c.due_date, 1, 10) BETWEEN substr(?, 1, 10) AND substr(?, 1, 10)${scopeWhere}${coSql}
      ORDER BY c.due_date, p.brand, c.id`
  )
    .bind(todayMyt(), from, to, ...scopeBinds)
    .all();

  return c.json({ projects: projects.results ?? [], tasks: tasks.results ?? [] });
});


app.post("/import/csv", requirePermission("projects.manage"), async (c) => {
  // company-scope: the two UPDATEs at :5066 and :5081 key on result.id, and result comes from createProject at :5038 — services/projects.ts INSERTs only (no upsert, no ON CONFLICT), so that row was created BY THIS REQUEST and stamped with activeCompanyId at :5050. A row you just minted needs no predicate to prove it is yours. Verified 2026-08-19.
  const user = c.get("user");
  const text = await c.req.text();
  const parsed = parseCsv(text);
  if (!parsed.rows.length) return c.json({ imported: 0, errors: ["Empty CSV"] });

  const etRows = await c.env.DB.prepare(
    `SELECT id, slug, name FROM project_event_types`
  ).all<{ id: number; slug: string; name: string }>();
  const etBySlug = new Map<string, number>();
  for (const r of etRows.results ?? []) {
    etBySlug.set(r.slug.toLowerCase(), r.id);
    etBySlug.set(r.name.toLowerCase(), r.id);
  }

  const brandRows = await getDb(c.env)
    .select({ name: project_brands.name })
    .from(project_brands);
  const ALLOWED_BRANDS = new Set(brandRows.map((b) => b.name));

  const { createProject } = await import("../services/projects");

  let imported = 0;
  const errors: string[] = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const name = (row.name || "").trim();
    if (!name) {
      errors.push(`Row ${i + 2}: name is empty, skipped`);
      continue;
    }
    const brand = (row.brand || "").trim().toUpperCase();
    const eventType = (row.event_type || "").trim().toLowerCase();
    const startDate = normalizeDate(row.start_date);
    const endDate = normalizeDate(row.end_date);
    try {
      const result = await createProject(c.env, {
        name,
        brand: ALLOWED_BRANDS.has(brand) ? brand : null,
        event_type_id: etBySlug.get(eventType) ?? null,
        start_date: startDate,
        end_date: endDate,
        venue: row.venue || null,
        state: row.state || null,
        organizer: row.organizer || null,
        notion_url: row.notion_url || null,
        created_by: user?.id ?? 0,
        company_id: activeCompanyId(c),
      });
      const numeric = (s: string | undefined): number | null => {
        if (!s) return null;
        const n = parseFloat(s.replace(/[,\s]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      const financeFields: Record<string, any> = {};
      if (row.rental) financeFields.rental = numeric(row.rental);
      if (row.total_sales) financeFields.total_sales = numeric(row.total_sales);
      if (row.contractor_cost) financeFields.contractor_cost = numeric(row.contractor_cost);
      if (row.license_fee) financeFields.license_fee = numeric(row.license_fee);
      if (Object.keys(financeFields).length) {
        const sets = Object.keys(financeFields).map((k) => `${k} = ?`).join(", ");
        const vals = Object.values(financeFields);
        await c.env.DB.prepare(
          `UPDATE project_finance SET ${sets}, updated_at = datetime('now') WHERE project_id = ?`
        )
          .bind(...vals, result.id)
          .run();
      }
      const boothPatch: Record<string, any> = {};
      if (row.booth_no) boothPatch.booth_no = row.booth_no;
      if (row.size_sqm) {
        const n = parseFloat(row.size_sqm.replace(/[,\s]/g, ""));
        if (Number.isFinite(n)) boothPatch.size_sqm = n;
      }
      if (Object.keys(boothPatch).length) {
        const sets = Object.keys(boothPatch).map((k) => `${k} = ?`).join(", ");
        const vals = Object.values(boothPatch);
        await c.env.DB.prepare(
          `UPDATE projects SET ${sets}, updated_at = datetime('now') WHERE id = ?${activeCompanySql(c)}`
        )
          .bind(...vals, result.id)
          .run();
      }
      imported++;
    } catch (e: any) {
      errors.push(`Row ${i + 2}: ${e?.message || String(e)}`);
    }
  }
  return c.json({ imported, errors, total_rows: parsed.rows.length });
});

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, "\n");
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === "," || ch === "\t") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      cur.push(field);
      lines.push(cur);
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length || cur.length) {
    cur.push(field);
    lines.push(cur);
  }
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < lines.length; r++) {
    const row = lines[r];
    if (row.length === 1 && row[0].trim() === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (row[c] ?? "").trim();
    }
    rows.push(obj);
  }
  return { headers, rows };
}

function normalizeDate(s: string | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export default app;
