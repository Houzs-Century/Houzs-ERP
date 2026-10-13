// ----------------------------------------------------------------------------
// defect-cleaning — the Sabah/Sarawak defect CLEANING mark (owner 2026-10-12/13).
// Mounted at /api/projects, behind `auth`.
//
// Lives in its own file rather than beside the defect routes in
// routes/projects.ts because that file is at its size ceiling
// (scripts/file-size-ceilings.json) — same pattern as routes/brandShare.ts.
//
// ONE button: the owner/BD marks a defect item "Cleaning done" once the on-site
// cleaning service is finished and the proof is back (owner 2026-10-13: no
// separate "in progress" — the cleaning happens during setup, so a second update
// is double work). Writes the cleaning_* columns on the defect checklist row
// (mig 20261013T0900); the detail GET returns them via `SELECT c.*`. Still-dirty
// items escalate to the purchaser through the existing per-photo Replace flow —
// this only marks completion. GATED: canCreateEvent (BD / owner / weisiang) + the
// project is in Sabah/Sarawak + the item is a Defect Item. 'done' marks it,
// 'none' clears a mis-tap.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { isEastMalaysiaState } from "../services/projectGates";
import { logProjectActivity } from "../services/projects";
import { refuseForeignChild, refuseForeignProject } from "./lib/project-company-gate";
import { canCreateEvent } from "./projects";

export const defectCleaning = new Hono<{ Bindings: Env }>();

defectCleaning.post(
  "/:id/checklist/:itemId/defect-cleaning",
  requirePermission("projects.write"),
  async (c) => {
    const user = c.get("user");
    if (!canCreateEvent(user)) {
      return c.json({ error: "Only BD and the owner can manage the cleaning stage." }, 403);
    }
    const projectId = parseInt(c.req.param("id"), 10);
    const itemId = parseInt(c.req.param("itemId"), 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(itemId)) {
      return c.json({ error: "Bad id" }, 400);
    }
    const body = await c.req.json<{ status?: string }>().catch(() => ({ status: undefined }));
    const status = (body.status ?? "").toLowerCase();
    if (status !== "done" && status !== "none") {
      return c.json({ error: "status must be done or none" }, 400);
    }
    // Company boundary for a child row reached by its own id (the guide's rule;
    // project-company-gate). The project AND the checklist item must both be in
    // the caller's active company before we read or write either.
    { const foreign = await refuseForeignProject(c, projectId); if (foreign) return foreign; }
    { const foreign = await refuseForeignChild(c, "project_checklist", itemId); if (foreign) return foreign; }
    // The item must belong to this project, be a Defect Item, and the project
    // must sit in Sabah/Sarawak — the only place this stage exists.
    // company-scope: refuseForeignProject + refuseForeignChild above already
    // proved both rows are in the caller's company; this read only fetches the
    // item's title + the project's state to validate the request.
    const row = await c.env.DB.prepare(
      `SELECT pc.id, pc.title, p.state
         FROM project_checklist pc
         JOIN projects p ON p.id = pc.project_id
        WHERE pc.id = ? AND pc.project_id = ?`
    )
      .bind(itemId, projectId)
      .first<{ id: number; title: string | null; state: string | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (!/^defect (list|item)/i.test((row.title ?? "").trim())) {
      return c.json({ error: "Cleaning applies only to a Defect Item." }, 400);
    }
    if (!isEastMalaysiaState(row.state)) {
      return c.json({ error: "The cleaning stage is for Sabah/Sarawak events only." }, 400);
    }
    const now = new Date().toISOString();
    const nextStatus = status === "done" ? "done" : null;
    // company-scope: the two guards above gated this exact item by company; the
    // WHERE re-pins the same id + project, so the write cannot cross companies.
    await c.env.DB.prepare(
      `UPDATE project_checklist
          SET cleaning_status = ?,
              cleaning_updated_at = ?,
              cleaning_updated_by = ?
        WHERE id = ? AND project_id = ?`
    )
      .bind(nextStatus, nextStatus ? now : null, nextStatus ? (user?.id ?? null) : null, itemId, projectId)
      .run();
    await logProjectActivity(
      c.env,
      projectId,
      "defect_cleaning",
      null,
      nextStatus,
      nextStatus ? "Defect cleaning marked done" : "Defect cleaning cleared",
      user?.id ?? null,
    );
    return c.json({ ok: true, cleaning_status: nextStatus, cleaning_updated_at: nextStatus ? now : null });
  }
);

export default defectCleaning;
