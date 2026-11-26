import { Hono } from "hono";
import type { Env } from "../types";
import { allowedCompanyIds } from "../scm/lib/companyScope";
import { getDb, type DB } from "../db/client";
import {
  project_activity,
  project_reads,
  projects,
  users,
} from "../db/schema";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

export const UNREAD_WINDOW_DAYS = 30;
const STATEMENT_TIMEOUT = sql`SET LOCAL statement_timeout = '10s'`;

/** The window's first day as YYYY-MM-DD. created_at is TEXT holding either
 *  "YYYY-MM-DD HH:MM:SS" or ISO; a bare date compares correctly against both. */
export function unreadWindowStart(now: number, days: number = UNREAD_WINDOW_DAYS): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isStatementTimeout(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === "57014" || /statement timeout/i.test(String(e?.message ?? ""));
}

/**
 * GET /api/notifications
 * Aggregated activity feed for the current user's scoped projects +
 * an `unread_by_project` map the frontend uses to paint dots on the
 * Projects list.
 *
 * Scoping: re-uses the project ACL. Scoped users (sales reps) see
 * only activity on projects where they or their manager is the PIC,
 * AND whose brand is in the user's brand allow-list (mig 049).
 *
 * Query params:
 *   limit      — max feed items (default 20, max 100)
 *   offset     — pagination offset (default 0)
 *   since      — ISO timestamp; only items strictly newer than this.
 *                Independent of unread filter.
 *   unread     — "1" to filter to rows strictly newer than the
 *                caller's last_read_at for that project. Used by the
 *                bell; the /notifications page calls without it to
 *                see history.
 *
 * Access: ANY authenticated user. The notification bell/badge is
 * personal data (the caller's own company project activity + their own
 * Houzs Points snapshot) and must never 403 — a Sales user who lacks the
 * `projects.read` matrix permission still has a bell. The PIC/brand
 * row-level ACL was removed (owner decision 2026-08-19), so the feed now
 * covers every project in the caller's allowed companies; company scope
 * (below) is the only remaining boundary.
 */
app.get("/", async (c) => {
  const user = c.get("user");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10), 0);
  const since = c.req.query("since") || null;
  const unreadOnly = c.req.query("unread") === "1";

  const db = getDb(c.env);
  const windowStart = unreadWindowStart(Date.now());
  const bounded = <T>(run: (q: DB) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.execute(STATEMENT_TIMEOUT);
      return run(tx as unknown as DB);
    });

  const scopeConds: SQL[] = [];
  const allowedCo = allowedCompanyIds(c);
  if (allowedCo !== undefined) {
    scopeConds.push(
      allowedCo.length > 0 ? inArray(projects.company_id, allowedCo) : sql`1=0`,
    );
  }

  const feedConds = [
    isNull(projects.archived_at),
    isNull(project_activity.archived_at),
    or(
      isNull(project_activity.user_id),
      ne(project_activity.user_id, user.id)
    )!,
    ...scopeConds,
  ];
  if (since) feedConds.push(gt(project_activity.created_at, since));
  if (unreadOnly) {
    feedConds.push(
      gte(project_activity.created_at, windowStart),
      sql`${project_activity.created_at} > COALESCE(${project_reads.last_read_at}, '1970-01-01')`
    );
  }

  const feedRead = (q: DB) => {
    let feedQ = q
      .select({
        id: project_activity.id,
        project_id: project_activity.project_id,
        action: project_activity.action,
        from_value: project_activity.from_value,
        to_value: project_activity.to_value,
        note: project_activity.note,
        created_at: project_activity.created_at,
        user_id: project_activity.user_id,
        user_name: users.name,
        user_email: users.email,
        user_profile_pic_r2_key: users.profile_pic_r2_key,
        project_code: projects.code,
        project_name: projects.name,
        brand: projects.brand,
        project_start_date: projects.start_date,
        project_end_date: projects.end_date,
      })
      .from(project_activity)
      .innerJoin(projects, eq(projects.id, project_activity.project_id))
      .leftJoin(users, eq(users.id, project_activity.user_id))
      .$dynamic();

    if (unreadOnly) {
      feedQ = feedQ.leftJoin(
        project_reads,
        and(
          eq(project_reads.project_id, projects.id),
          eq(project_reads.user_id, user.id)
        )!
      );
    }

    return feedQ
      .where(and(...feedConds))
      .orderBy(desc(project_activity.created_at), desc(project_activity.id))
      .limit(limit + 1)
      .offset(offset);
  };

  const unreadRead = (q: DB) => q
    .select({
      project_id: projects.id,
      unread_count: sql<number>`COUNT(*)`,
    })
    .from(projects)
    .innerJoin(project_activity, eq(project_activity.project_id, projects.id))
    .leftJoin(
      project_reads,
      and(
        eq(project_reads.project_id, projects.id),
        eq(project_reads.user_id, user.id)
      )!
    )
    .where(
      and(
        isNull(projects.archived_at),
        isNull(project_activity.archived_at),
        or(
          isNull(project_activity.user_id),
          ne(project_activity.user_id, user.id)
        )!,
        gte(project_activity.created_at, windowStart),
        sql`${project_activity.created_at} > COALESCE(${project_reads.last_read_at}, '1970-01-01')`,
        ...scopeConds
      )
    )
    .groupBy(projects.id)
    .having(sql`COUNT(*) > 0`);

  let rawRows: Awaited<ReturnType<typeof feedRead>>;
  let unreadRows: Awaited<ReturnType<typeof unreadRead>>;
  try {
    [rawRows, unreadRows] = await Promise.all([bounded(feedRead), bounded(unreadRead)]);
  } catch (err) {
    if (!isStatementTimeout(err)) throw err;
    console.error("[notifications] read hit the statement timeout", { userId: user.id });
    return c.json({ error: "notifications_timeout" }, 504);
  }

  const hasMore = rawRows.length > limit;
  const trimmedRows = hasMore ? rawRows.slice(0, limit) : rawRows;

  const unread_by_project: Record<number, number> = {};
  let total_unread = 0;
  for (const r of unreadRows) {
    unread_by_project[r.project_id] = r.unread_count;
    total_unread += r.unread_count;
  }

  const me = await db
    .select({
      points_balance: users.points_balance,
      gifting_balance: users.gifting_balance,
      current_streak: users.current_streak,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .then((r) => r[0]);

  return c.json({
    feed: trimmedRows,
    unread_by_project,
    total_unread,
    has_more: hasMore,
    points_balance: me?.points_balance ?? 0,
    gifting_balance: me?.gifting_balance ?? 0,
    current_streak: me?.current_streak ?? 0,
  });
});

export default app;
