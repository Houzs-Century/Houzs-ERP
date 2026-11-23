import { Hono } from "hono";
import type { Env } from "../types";
import { requirePageAccess } from "../middleware/auth";
import { activeCompanyId } from "../scm/lib/companyScope";
import { listOpenDefects } from "../services/defectList";

/**
 * Cross-project Defect List (owner 2026-11-20) — every OPEN defect photo across
 * the active company in one feed, so the service team reviews defects without
 * opening each project one by one.
 *
 * Its own router, mounted at the EXACT path /api/projects/defect-list in
 * index.ts BEFORE the main projects router — otherwise the projects router's
 * `/:id` catch-all would swallow "defect-list" as an id (same reason
 * projectsOutstanding is mounted first).
 *
 * Read gate is projects.list (view): the Calendar-only cohort is the only
 * Projects viewer deliberately denied the list (positionPolicy.ts), while defect
 * reviewers, storekeepers, purchasers, ops and admins all inherit
 * projects.list=view. Acting on a defect is NOT granted here — it stays gated on
 * POST /checklist/attachments/:id/actions (reviewer / purchaser / admin).
 */
const app = new Hono<{ Bindings: Env }>();

app.get("/", requirePageAccess("projects.list"), async (c) => {
  const includeResolved = c.req.query("all") === "1";
  const result = await listOpenDefects(c.env, {
    companyId: activeCompanyId(c),
    includeResolved,
  });
  return c.json(result);
});

export default app;
