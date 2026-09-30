import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { activeCompanyId } from "../scm/lib/companyScope";
import { listOutstandingTasks } from "../services/outstandingTasks";

/**
 * Outstanding-task reminders feed (owner/admin Reminder view, owner 2026-09-30).
 *
 * Its own router, mounted at the EXACT path /api/projects/outstanding-tasks in
 * index.ts BEFORE the main projects router — otherwise the projects router's
 * `/:id` catch-all would swallow "outstanding-tasks" as an id. Kept out of the
 * big routes/projects.ts on purpose (that file is at its size ceiling).
 *
 * Gated on projects.reminders: Owner + Super Admin hold it via "*", so a regular
 * user can never trace another person's tasks here — their only cross-event view
 * stays the row-scoped my_pending filter on the project list.
 */
const app = new Hono<{ Bindings: Env }>();

app.get("/", requirePermission("projects.reminders"), async (c) => {
  const monthRaw = c.req.query("month");
  const month = monthRaw && /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : undefined;
  const result = await listOutstandingTasks(c.env, {
    companyId: activeCompanyId(c),
    month,
  });
  return c.json(result);
});

export default app;
