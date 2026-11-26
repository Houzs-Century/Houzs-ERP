import { Hono } from "hono";
import type { Env } from "../types";
import { hasPermission, holdsChecklistApproval } from "../services/permissions";
import { allowedCompanyIds } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";

const app = new Hono<{ Bindings: Env }>();

function companiesPred(allowedCo: number[] | undefined, col: string): string {
  if (allowedCo === undefined) return "";
  if (allowedCo.length === 0) return ` AND 1=0`;
  return ` AND ${col} IN (${allowedCo.join(",")})`;
}


interface InboxItem {
  type: string;
  id: number;
  title: string;
  subtitle: string;
  severity: "info" | "warning" | "error";
  due_date?: string | null;
  link: string;
  meta?: Record<string, any>;
}

export const inboxCacheKey = (userId: number | string) => `inbox:v1:${userId}`;

export async function bustInboxForUser(env: Env, userId: number | string): Promise<void> {
  if (!env.SESSION_CACHE || !userId) return;
  try {
    await env.SESSION_CACHE.delete(inboxCacheKey(userId));
  } catch {
  }
}

app.get("/", async (c) => {
  const user = c.get("user");
  const userId = user?.id ?? 0;
  const perms = user?.permissions ?? [];
  const isStar = perms.includes("*");

  const cacheKey = inboxCacheKey(userId);
  try {
    const cached = await c.env.SESSION_CACHE?.get(cacheKey);
    if (cached) return c.json(JSON.parse(cached));
  } catch {}

  async function safe<T>(label: string, fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn();
    } catch (e) {
      console.error(`[inbox] ${label} failed:`, e);
      return [];
    }
  }

  const allowedCo = allowedCompanyIds(c);
  const [myTasks, reviewQueue, blockers, thisWeek] = await Promise.all([
    safe("my_tasks", () => loadMyTasks(c.env, userId, perms, isStar, allowedCo)),
    safe("review_queue", () => loadReviewQueue(c.env, userId, perms, isStar, allowedCo)),
    safe("blockers", () => loadBlockers(c.env, userId, perms, isStar, allowedCo)),
    safe("this_week", () => loadThisWeek(c.env, userId, perms, isStar, allowedCo)),
  ]);

  const payload = {
    my_tasks: myTasks,
    review_queue: reviewQueue,
    blockers,
    this_week: thisWeek,
    counts: {
      my_tasks: myTasks.length,
      review_queue: reviewQueue.length,
      blockers: blockers.length,
      this_week: thisWeek.length,
    },
  };
  const fill = (async () => {
    try {
      await c.env.SESSION_CACHE?.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: 60,
      });
    } catch {}
  })();
  try {
    c.executionCtx.waitUntil(fill);
  } catch {
    void fill;
  }
  return c.json(payload);
});


async function loadMyTasks(env: Env, userId: number, perms: string[], isStar: boolean, allowedCo: number[] | undefined) {
  if (!userId) return [];
  const items: InboxItem[] = [];
  const today = todayMyt();

  if (isStar || hasPermission(perms, "service_cases.read")) {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.assr_no, c.customer_name, c.stage, c.priority,
              c.deadline_at,
              CASE
                WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at THEN 1
                ELSE 0
              END as is_breached,
              CAST((julianday(c.deadline_at) - julianday('now')) * 24 AS INTEGER) as hours_to_deadline
         FROM assr_cases c
        WHERE c.archived_at IS NULL
          AND c.stage NOT IN ('completed', 'voided')
          AND c.assigned_to = ?${companiesPred(allowedCo, "c.company_id")}
        ORDER BY
          CASE WHEN c.deadline_at IS NULL THEN 1 ELSE 0 END,
          c.deadline_at ASC
        LIMIT 15`
    )
      .bind(userId)
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        stage: string;
        priority: string;
        deadline_at: string | null;
        is_breached: number;
        hours_to_deadline: number | null;
      }>();
    for (const r of rows.results ?? []) {
      const severity: InboxItem["severity"] =
        r.is_breached ? "error" :
        (r.hours_to_deadline ?? 999) < 24 ? "warning" : "info";
      items.push({
        type: "assr",
        id: r.id,
        title: r.assr_no,
        subtitle: r.customer_name || r.stage,
        severity,
        due_date: r.deadline_at,
        link: `/assr`,
        meta: { stage: r.stage, priority: r.priority, breached: !!r.is_breached },
      });
    }
  }

  if (isStar || hasPermission(perms, "projects.read")) {
    const rows = await env.DB.prepare(
      `SELECT cl.id, cl.title, cl.due_date, cl.status,
              p.id as project_id, p.code as project_code, p.name as project_name
         FROM project_checklist cl
         JOIN projects p ON p.id = cl.project_id
        WHERE p.archived_at IS NULL${companiesPred(allowedCo, "p.company_id")}
          AND cl.owner_user_id = ?
          AND cl.status = 'pending'
          AND (cl.due_date IS NULL OR substr(cl.due_date, 1, 10) <= date('now', '+7 days'))
        ORDER BY
          CASE WHEN cl.due_date IS NULL THEN 1 ELSE 0 END,
          cl.due_date ASC
        LIMIT 15`
    )
      .bind(userId)
      .all<{
        id: number;
        title: string;
        due_date: string | null;
        status: string;
        project_id: number;
        project_code: string;
        project_name: string;
      }>();
    for (const r of rows.results ?? []) {
      const overdue = r.due_date && r.due_date.slice(0, 10) < today;
      items.push({
        type: "project_task",
        id: r.id,
        title: r.title,
        subtitle: r.project_name,
        severity: overdue ? "error" : "info",
        due_date: r.due_date,
        link: `/projects`,
        meta: { project_id: r.project_id },
      });
    }
  }

  return items;
}


async function loadReviewQueue(env: Env, userId: number, perms: string[], isStar: boolean, allowedCo: number[] | undefined) {
  if (!userId) return [];
  const items: InboxItem[] = [];

  if (isStar || hasPermission(perms, "projects.write")) {
    const rows = await env.DB.prepare(
      `SELECT cl.id, cl.title, cl.review_status, cl.required_perm,
              p.id as project_id, p.code as project_code, p.name as project_name
         FROM project_checklist cl
         JOIN projects p ON p.id = cl.project_id
        WHERE p.archived_at IS NULL${companiesPred(allowedCo, "p.company_id")}
          AND cl.review_status IN ('pending_review','amended')
        ORDER BY cl.updated_at DESC
        LIMIT 20`
    )
      .all<{
        id: number;
        title: string;
        review_status: string;
        required_perm: string | null;
        project_id: number;
        project_code: string;
        project_name: string;
      }>();
    for (const r of rows.results ?? []) {
      // Filter: can the current user actually approve this?
      // Approval keys are explicit-only (owner matrix 2026-07-21) — the `*`
      // wildcard no longer implies approver status for gated items.
      const canApprove = !r.required_perm || holdsChecklistApproval(perms, r.required_perm);
      if (!canApprove) continue;
      items.push({
        type: "project_review",
        id: r.id,
        title: r.title,
        subtitle: `${r.project_name} · ${r.review_status}`,
        severity: "warning",
        link: `/projects`,
        meta: {
          project_id: r.project_id,
          required_perm: r.required_perm,
          review_status: r.review_status,
        },
      });
    }
  }

  if (isStar || hasPermission(perms, "service_cases.manage")) {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.assr_no, c.customer_name, c.stage,
              c.quality_review_passed, c.approved_at
         FROM assr_cases c
        WHERE c.archived_at IS NULL
          AND c.stage = 'pending_delivery_service'
          AND c.approved_at IS NULL${companiesPred(allowedCo, "c.company_id")}
        ORDER BY c.updated_at DESC
        LIMIT 10`
    )
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        stage: string;
        quality_review_passed: number | null;
        approved_at: string | null;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "assr_review",
        id: r.id,
        title: r.assr_no,
        subtitle: `${r.customer_name || "—"} · awaiting manager approval`,
        severity: "warning",
        link: `/assr`,
        meta: { stage: r.stage },
      });
    }
  }

  return items;
}


async function loadBlockers(env: Env, userId: number, perms: string[], isStar: boolean, allowedCo: number[] | undefined) {
  if (!userId) return [];
  const items: InboxItem[] = [];

  if (isStar || hasPermission(perms, "service_cases.read")) {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.assr_no, c.customer_name, c.stage, c.deadline_at,
              CAST(julianday('now') - julianday(c.deadline_at) AS INTEGER) as days_overdue
         FROM assr_cases c
        WHERE c.archived_at IS NULL
          AND c.stage NOT IN ('completed', 'voided')
          AND c.deadline_at IS NOT NULL
          AND datetime('now') > c.deadline_at
          AND (c.assigned_to = ? OR c.assigned_to IS NULL)${companiesPred(allowedCo, "c.company_id")}
        ORDER BY c.deadline_at ASC
        LIMIT 10`
    )
      .bind(userId)
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        stage: string;
        deadline_at: string;
        days_overdue: number;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "assr_breach",
        id: r.id,
        title: r.assr_no,
        subtitle: `${r.customer_name || "—"} · SLA overdue ${r.days_overdue}d`,
        severity: "error",
        due_date: r.deadline_at,
        link: `/assr`,
        meta: { stage: r.stage, days_overdue: r.days_overdue },
      });
    }
  }

  if (isStar || hasPermission(perms, "projects.read")) {
    const rows = await env.DB.prepare(
      `SELECT d.id, d.phase, d.reported_by_role,
              d.item_code, d.item_description, d.reported_at,
              p.id as project_id, p.name as project_name
         FROM project_defects d
         JOIN projects p ON p.id = d.project_id
        WHERE p.archived_at IS NULL${companiesPred(allowedCo, "p.company_id")}
          AND d.archived_at IS NULL
          AND d.resolved = 0
        ORDER BY d.reported_at DESC
        LIMIT 10`
    )
      .all<{
        id: number;
        phase: string;
        reported_by_role: string;
        item_code: string | null;
        item_description: string | null;
        reported_at: string;
        project_id: number;
        project_name: string;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "project_defect",
        id: r.id,
        title: r.item_code || r.item_description || "(unnamed defect)",
        subtitle: `${r.project_name} · ${r.phase} · reported by ${r.reported_by_role}`,
        severity: "warning",
        link: `/projects`,
        meta: { project_id: r.project_id, phase: r.phase },
      });
    }
  }

  if (isStar || hasPermission(perms, "service_cases.read")) {
    const rows = await env.DB.prepare(
      `SELECT * FROM (
         SELECT c.id, c.assr_no, c.customer_name, c.stage,
                CAST(julianday('now') - julianday(
                  COALESCE(
                    (SELECT MAX(a.created_at) FROM assr_activity a
                      WHERE a.assr_id = c.id AND a.action = 'stage_change'
                        AND a.to_value = c.stage),
                    c.created_at
                  )
                ) AS INTEGER) as days_in_stage
           FROM assr_cases c
          WHERE c.archived_at IS NULL
            AND c.stage NOT IN ('completed', 'voided')
            AND c.assigned_to = ?${companiesPred(allowedCo, "c.company_id")}
       )
       WHERE days_in_stage > 3
       ORDER BY days_in_stage DESC
       LIMIT 10`
    )
      .bind(userId)
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        stage: string;
        days_in_stage: number;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "assr_stuck",
        id: r.id,
        title: r.assr_no,
        subtitle: `${r.customer_name || "—"} · stuck at ${r.stage} for ${r.days_in_stage}d`,
        severity: "warning",
        link: `/assr`,
        meta: { stage: r.stage, days_in_stage: r.days_in_stage },
      });
    }
  }

  return items;
}


async function loadThisWeek(env: Env, userId: number, perms: string[], isStar: boolean, allowedCo: number[] | undefined) {
  if (!userId) return [];
  const items: InboxItem[] = [];
  const today = todayMyt();

  if (isStar || hasPermission(perms, "projects.read")) {
    const rows = await env.DB.prepare(
      `SELECT p.id, p.code, p.name, p.brand, p.stage, p.venue,
              p.start_date, p.end_date
         FROM projects p
        WHERE p.archived_at IS NULL${companiesPred(allowedCo, "p.company_id")}
          AND p.stage NOT IN ('closed','cancelled')
          AND p.start_date IS NOT NULL
          AND substr(p.start_date, 1, 10) BETWEEN ? AND ?
        ORDER BY p.start_date ASC
        LIMIT 10`
    )
      .bind(today, todayMyt(7))
      .all<{
        id: number;
        code: string;
        name: string;
        brand: string | null;
        stage: string;
        venue: string | null;
        start_date: string;
        end_date: string | null;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "project_upcoming",
        id: r.id,
        title: r.name,
        subtitle: `${r.code} · ${r.brand || "—"}${r.venue ? ` · ${r.venue}` : ""}`,
        severity: "info",
        due_date: r.start_date,
        link: `/projects`,
        meta: { stage: r.stage },
      });
    }
  }

  return items;
}

export default app;
