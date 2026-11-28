// ----------------------------------------------------------------------------
// projectForecast — set or clear the Forecast figure of one Financial Snapshot
// line on an event (owner 2026-11-18; the rules are services/eventForecast.ts).
//
//   PUT    /api/project-forecast/:projectId/:line   { amount }  (RM, >= 0)
//   DELETE /api/project-forecast/:projectId/:line
//
// GATE: `projects.write` (as the typed cost lines), and the caller must be one
// who sees the event's money — the same two rules the event page strips the
// Financial Snapshot by (financeHiddenForUser, then the PMS FINANCIAL section).
// COMPANY: the project is looked up in the ACTIVE company and its company_id
// is stamped on the row; a project of another company is 404.
//
// Its own prefix, not /api/projects: routes/projects.ts is at its size ceiling.
// ----------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { getDb } from "../db/client";
import { projects, project_forecast } from "../db/schema";
import { financeHiddenForUser, getPmsAccess } from "../services/pmsAccess";
import { isForecastLine } from "../services/eventForecast";
import { parseForecastAmount } from "./lib/forecast-amount";

export const projectForecast = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

async function gate(c: Ctx): Promise<{ ok: true; projectId: number; companyId: number; line: string } | { ok: false; res: Response }> {
  const user = c.get("user");
  if (financeHiddenForUser(user)) return { ok: false, res: c.json({ error: "You don't have permission to view financial information." }, 403) };
  const projectId = Number(c.req.param("projectId"));
  const line = c.req.param("line") ?? "";
  if (!Number.isInteger(projectId) || projectId <= 0) return { ok: false, res: c.json({ error: "Invalid project" }, 400) };
  if (!isForecastLine(line)) return { ok: false, res: c.json({ error: "Unknown line" }, 400) };
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, res: c.json(co.refusal, 409) };
  const db = getDb(c.env);
  const row = (await db.select({ id: projects.id, pic_id: projects.pic_id, brand: projects.brand })
    .from(projects).where(and(eq(projects.id, projectId), eq(projects.company_id, co.companyId))).limit(1)).at(0);
  if (!row) return { ok: false, res: c.json({ error: "Not found" }, 404) };
  if (user.position_id != null && !getPmsAccess(user, row).canFinancial) {
    return { ok: false, res: c.json({ error: "You don't have permission to view financial information." }, 403) };
  }
  return { ok: true, projectId, companyId: co.companyId, line };
}

projectForecast.put("/:projectId/:line", requirePermission("projects.write"), async (c) => {
  const g = await gate(c);
  if (!g.ok) return g.res;
  let body: { amount?: unknown } | null;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: `The amount could not be read (${e instanceof Error ? e.message : "bad body"})` }, 400);
  }
  const amount = parseForecastAmount(body?.amount);
  if (!amount.ok) return c.json({ error: amount.error }, 400);
  const userId = Number(c.get("user").id) || null;
  const db = getDb(c.env);
  await db.insert(project_forecast)
    .values({ company_id: g.companyId, project_id: g.projectId, line_key: g.line, amount_sen: amount.sen, updated_by: userId })
    .onConflictDoUpdate({
      target: [project_forecast.project_id, project_forecast.line_key],
      set: { amount_sen: amount.sen, updated_by: userId, updated_at: new Date().toISOString(), company_id: g.companyId },
    });
  return c.json({ ok: true, line: g.line, amount: amount.sen / 100 });
});

projectForecast.delete("/:projectId/:line", requirePermission("projects.write"), async (c) => {
  const g = await gate(c);
  if (!g.ok) return g.res;
  const db = getDb(c.env);
  await db.delete(project_forecast).where(and(
    eq(project_forecast.project_id, g.projectId),
    eq(project_forecast.line_key, g.line),
    eq(project_forecast.company_id, g.companyId),
  ));
  return c.json({ ok: true, line: g.line });
});
