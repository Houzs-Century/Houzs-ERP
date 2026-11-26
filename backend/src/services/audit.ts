import type { Context } from "hono";
import type { Env } from "../types";
import { clientIp } from "../middleware/rateLimit";


export interface AuditInput {
  action: string;
  entityType?: string | null;
  entityId?: string | number | null;
  summary?: string | null;
  meta?: unknown;
  actorId?: number | null;
  actorEmail?: string | null;
  ip?: string | null;
  requestId?: string | null;
}

/** Low-level insert. Never throws. Prefer `audit(c, ...)` from a route. */
export async function writeAudit(env: Env, e: AuditInput): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_events
         (actor_id, actor_email, action, entity_type, entity_id, summary, meta, ip, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        e.actorId ?? null,
        e.actorEmail ?? null,
        e.action,
        e.entityType ?? null,
        e.entityId == null ? null : String(e.entityId),
        e.summary ?? null,
        e.meta == null ? null : JSON.stringify(e.meta),
        e.ip ?? null,
        e.requestId ?? null,
      )
      .run();
  } catch (err) {
    console.error("[audit] insert failed — row lost, replay from this line", {
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId == null ? null : String(e.entityId),
      summary: e.summary ?? null,
      actorId: e.actorId ?? null,
      actorEmail: e.actorEmail ?? null,
      requestId: e.requestId ?? null,
      hasMeta: e.meta != null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Route-level helper: fills actor / ip / request-id from the context. */
export async function audit(
  c: Context<{ Bindings: Env }>,
  e: AuditInput,
): Promise<void> {
  const user = c.get("user");
  await writeAudit(c.env, {
    ...e,
    actorId: e.actorId ?? user?.id ?? null,
    actorEmail: e.actorEmail ?? user?.email ?? null,
    ip: e.ip ?? clientIp(c),
    requestId: e.requestId ?? c.get("requestId") ?? null,
  });
}
