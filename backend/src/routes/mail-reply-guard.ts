// Mail Center reply guard (owner 2026-11-21): who is writing a reply right now,
// a reply a colleague sent after the newest message I had seen, and the count of
// customer emails waiting on me for the sidebar.
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { activeCompanyId, activeCompanySql } from "../scm/lib/companyScope";
import { getMailScope } from "./mail-center";

type C = Context<{ Bindings: Env }>;
type Db = Env["DB"];

/** A "writing" mark older than this is someone who left; the box beats every 20 s. */
export const REPLYING_FRESH_MS = 90_000;

/** Colleagues (not me) with text in this thread's reply box in the last 90 s. */
export async function replyingOn(db: Db, threadId: string, me: number | null): Promise<Array<{ name: string }>> {
  try {
    const since = new Date(Date.now() - REPLYING_FRESH_MS).toISOString();
    // company-scope: thread_id was already read inside the active company by the caller.
    const res = await db
      .prepare(
        `SELECT u.name, u.email FROM mail_thread_replying r JOIN users u ON u.id = r.user_id
          WHERE r.thread_id = ? AND r.at > ? AND r.user_id <> ? ORDER BY r.at`,
      )
      .bind(threadId, since, me ?? -1)
      .all<{ name: string | null; email: string | null }>();
    return res.results.map((r) => ({ name: r.name?.trim() || r.email || "A colleague" }));
  } catch {
    return []; // table not there yet (D1 test mirror): nobody shown
  }
}

/** An outbound reply someone else sent after `afterMessageId`, or null. */
export async function replyConflict(
  db: Db,
  threadId: string,
  afterMessageId: string | null,
  me: number | null,
): Promise<{ by: string; at: string } | null> {
  if (!afterMessageId) return null;
  // company-scope: thread_id was already read inside the active company by the caller.
  const row = await db
    .prepare(
      `SELECT m.created_at, m.sent_by_name, m.from_name FROM email_messages m
        WHERE m.thread_id = ? AND m.direction = 'outbound'
          AND m.created_at > (SELECT created_at FROM email_messages WHERE id = ? AND thread_id = ?)
          AND (m.sent_by_user_id IS NULL OR m.sent_by_user_id <> ?)
        ORDER BY m.created_at DESC LIMIT 1`,
    )
    .bind(threadId, afterMessageId, threadId, me ?? -1)
    .first<{ created_at: string; sent_by_name: string | null; from_name: string | null }>();
  if (!row) return null;
  return { by: row.sent_by_name?.trim() || row.from_name?.trim() || "A colleague", at: row.created_at };
}

/** After my reply: I am no longer writing, and an unassigned email becomes mine. */
export async function afterReplySent(c: C, threadId: string, assigned: number | null, me: number | null, name: string | null): Promise<void> {
  if (me == null) return;
  // Best effort: the reply is already sent, and a stale mark expires on its own in 90 s.
  await c.env.DB.prepare(`DELETE FROM mail_thread_replying WHERE thread_id = ? AND user_id = ?`)
    .bind(threadId, me)
    .run()
    .catch((e: unknown) => console.warn("[mail] could not clear replying mark", e));
  if (assigned != null) return;
  await c.env.DB.prepare(
    `UPDATE email_threads SET assigned_to_user_id = ?, assigned_to_name = ? WHERE id = ? AND assigned_to_user_id IS NULL${activeCompanySql(c)}`,
  )
    .bind(me, name, threadId)
    .run();
}

const app = new Hono<{ Bindings: Env }>();

// POST /api/mail-center/threads/:id/replying { drafting } - the reply box heartbeat.
app.post("/threads/:id/replying", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);
  if (scope.userId == null) return c.json({ error: "Sign in again." }, 401);
  const thread = await c.env.DB.prepare(`SELECT mailbox_address FROM email_threads WHERE id = ?${activeCompanySql(c)} LIMIT 1`)
    .bind(id)
    .first<{ mailbox_address: string | null }>();
  if (!thread || (!scope.isAdmin && !scope.addresses.includes((thread.mailbox_address ?? "").toLowerCase()))) {
    return c.json({ error: "Thread not found" }, 404);
  }
  const body = await c.req.json<{ drafting?: boolean }>().catch(() => ({}) as { drafting?: boolean });
  if (body.drafting) {
    await c.env.DB.prepare(
      `INSERT INTO mail_thread_replying (thread_id, user_id, company_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET at = excluded.at`,
    )
      .bind(id, scope.userId, activeCompanyId(c) ?? null, new Date().toISOString())
      .run();
  } else {
    await c.env.DB.prepare(`DELETE FROM mail_thread_replying WHERE thread_id = ? AND user_id = ?`).bind(id, scope.userId).run();
  }
  return c.json({ ok: true });
});

// GET /api/mail-center/waiting-count - open emails whose last word is the
// customer's, assigned to me or in my own mailbox (sidebar badge, owner A).
app.get("/waiting-count", async (c) => {
  const me = c.get("userId") ?? null;
  if (me == null) return c.json({ count: 0 });
  c.header("Cache-Control", "no-store");
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM email_threads t
      WHERE t.status = 'open' AND t.trashed_at IS NULL AND t.last_direction = 'inbound'${activeCompanySql(c, "t.company_id")}
        AND (t.assigned_to_user_id = ?
             OR (t.assigned_to_user_id IS NULL AND lower(t.mailbox_address) IN (
                 SELECT lower(a.address) FROM email_addresses a
                  WHERE a.assigned_user_id = ? AND a.active = 1${activeCompanySql(c, "a.company_id")})))`,
  )
    .bind(me, me)
    .first<{ n: number | string }>();
  return c.json({ count: Number(row?.n ?? 0) });
});

export default app;
