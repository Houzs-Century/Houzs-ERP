import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { activeCompanyId } from "../scm/lib/companyScope";
import { listOutstandingTasks } from "../services/outstandingTasks";
import { canCompileReminders } from "./lib/named-tier";

/**
 * Outstanding-task reminders feed (owner/admin Reminder view, owner 2026-09-30).
 *
 * Its own router, mounted at the EXACT path /api/projects/outstanding-tasks in
 * index.ts BEFORE the main projects router — otherwise the projects router's
 * `/:id` catch-all would swallow "outstanding-tasks" as an id. Kept out of the
 * big routes/projects.ts on purpose (that file is at its size ceiling).
 *
 * Gated on the named tier (owner 2026-10-07: "full access for this only ummu,
 * owner, weisiang") — NOT on a role permission, because a role wildcard would
 * let every Super Admin in. A regular user can never trace another person's
 * tasks here; their only cross-event view stays the row-scoped my_pending
 * filter on the project list.
 */
const app = new Hono<{ Bindings: Env }>();

app.get("/", requirePermission("projects.read"), async (c) => {
  if (!canCompileReminders(c.get("user"))) {
    return c.json({ error: "Only BD, the owner, and weisiang can compile reminders." }, 403);
  }
  const monthRaw = c.req.query("month");
  const month = monthRaw && /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : undefined;
  const result = await listOutstandingTasks(c.env, {
    companyId: activeCompanyId(c),
    month,
  });
  return c.json(result);
});

export default app;
