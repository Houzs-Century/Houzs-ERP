/* POST /api/fleet-maintenance/plans/:planId/service — record a service that was
   actually done against a preventive-maintenance plan.

   Owner, 2026-10-15: a plan is the RULE (every 10,000 km or every 6 months);
   the service is the RECORD (the day it went in, the odometer, the cost, the
   workshop). The plan form used to ask for both, so a rule could not be set
   without inventing a "last done", and a real service left no record of what
   it cost.

   A recorded service is a work order closed as COMPLETED — the one service
   history (HC-0031), so its cost lands in the lorry's repair spend with every
   other job — and it moves the plan's last-done date / km, from which the next
   due date and km are derived. Kept out of fleet-maintenance.ts, which is at its
   file-size ceiling; mounted on the same prefix in index.ts. */
import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { requireHouzsPerm } from "../lib/houzs-perms";
import { nextCode, CODE_PREFIX } from "../lib/fleet-code-mint";
import { activeCompanyId, scopeToCompanyIdOrOpen } from "../lib/companyScope";
import { PLAN_COMPONENT_LABELS, type PlanComponent } from "../../services/fleet-status";
import type { Env, Variables } from "../env";

export const fleetPlanService = new Hono<{ Bindings: Env; Variables: Variables }>();

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Auth on THIS route only: a use("*") here would run for every fleet request mounted after it.
fleetPlanService.post("/plans/:planId/service", supabaseAuth, requireHouzsPerm("fleet.write"), async (c) => {
  const sb = c.get("supabase");
  const planId = c.req.param("planId");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const doneDate = String(body.doneDate ?? "").trim();
  if (!ISO.test(doneDate)) return c.json({ error: "invalid_done_date", reason: "The service date is required." }, 400);
  const km = body.odometerKm == null || body.odometerKm === "" ? null : Number(body.odometerKm);
  if (km != null && !(Number.isInteger(km) && km >= 0)) return c.json({ error: "invalid_odometer_km" }, 400);
  const cost = body.costSen == null || body.costSen === "" ? 0 : Number(body.costSen);
  if (!(Number.isInteger(cost) && cost >= 0)) return c.json({ error: "invalid_cost" }, 400);
  const workshop = String(body.workshop ?? "").trim() || null;
  const notes = String(body.notes ?? "").trim() || null;

  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries (fleet-maintenance.ts).
  const { data: plan, error: pErr } = await sb.from("lorry_maintenance_plans")
    .select("id, lorry_id, component, last_done_date, last_done_km").eq("id", planId).maybeSingle();
  if (pErr) return c.json({ error: "load_failed", reason: pErr.message }, 500);
  if (!plan) return c.json({ error: "plan_not_found" }, 404);
  const p = plan as { id: string; lorry_id: string; component: PlanComponent; last_done_date: string | null; last_done_km: number | null };

  const companyId = activeCompanyId(c) ?? null;
  const { data: codes, error: cErr } = await scopeToCompanyIdOrOpen(sb.from("lorry_work_orders").select("wo_no"), companyId);
  if (cErr) return c.json({ error: "load_failed", reason: cErr.message }, 500);
  const label = PLAN_COMPONENT_LABELS[p.component] ?? p.component;
  const { data: wo, error: wErr } = await sb.from("lorry_work_orders").insert({
    company_id: companyId,
    lorry_id: p.lorry_id,
    wo_no: nextCode(CODE_PREFIX.WORK_ORDER, ((codes ?? []) as Array<{ wo_no: string | null }>).map((r) => r.wo_no)),
    status: "COMPLETED",
    problem: `Scheduled service: ${label}${km != null ? ` at ${km.toLocaleString("en-MY")} km` : ""}`,
    workshop,
    document_date: doneDate,
    outside_service_sen: cost,
    actual_complete: `${doneDate}T00:00:00+08:00`,
    notes,
    created_by: c.get("houzsUser")?.id ?? null,
  }).select("id, wo_no").single();
  if (wErr || !wo) return c.json({ error: "insert_failed", reason: wErr?.message ?? "no row" }, 500);

  /* The plan moves forward only: a back-dated record of an older service must
     not pull "last done" (and so the next due) backwards. */
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (!p.last_done_date || doneDate >= String(p.last_done_date).slice(0, 10)) patch.last_done_date = doneDate;
  if (km != null && (p.last_done_km == null || km >= p.last_done_km)) patch.last_done_km = km;
  const { error: uErr } = await sb.from("lorry_maintenance_plans").update(patch).eq("id", planId);
  if (uErr) return c.json({ error: "plan_update_failed", reason: uErr.message, workOrderId: (wo as { id: string }).id }, 500);

  return c.json({ ok: true, workOrder: wo, plan: { id: planId, ...patch } }, 201);
});
