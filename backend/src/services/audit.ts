import type { Context } from "hono";
import type { Env } from "../types";
import { clientIp } from "../middleware/rateLimit";

// ── Audit trail ───────────────────────────────────────────────
//
// Append-only ledger of security-relevant mutations (role / permission edits,
// user invites + status flips, finance edits, order voids). One row per action
// in audit_events (mig 096 / 0006) carrying the actor, the entity, a one-line
// summary and a JSON before/after blob.
//
// Design:
//   • Best-effort. A failed audit insert is logged and swallowed — it must
//     never break the mutation it was recording. Callers don't await a result.
//   • Append-only. The app has no UPDATE/DELETE path on this table; tampering
//     would have to happen at the database, which is itself outside the app.
//   • Context-aware. audit(c, ...) lifts actor / ip / request-id off the Hono
//     context so call sites only spell out what's specific to the action.

export interface AuditInput {
  action: string; // 'role.update', 'user.invite', 'finance.update', ...
  entityType?: string | null; // 'role','position','user','project_finance','order'
  entityId?: string | number | null;
  summary?: string | null; // human one-liner
  meta?: unknown; // serialized to JSON (before/after, request detail)
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
    /* Audit must never break the request it records — so this stays swallowed.
       What changed is WHAT GETS SAID when it is swallowed.

       The failure mode this guards against is not one lost row, it is a lost
       row nobody notices for days. HOOKKA shipped a migration whose column type
       disagreed with the value the runtime supplied, and EVERY insert into the
       audited table failed from that deploy onward; the only trace was a
       payload-free "insert failed" line, so the gap was invisible until someone
       went looking for an audit trail that had never been written
       (BUG-2026-05-12-007, found via the swallow added in BUG-2026-04-27-007 —
       which is still open there for exactly this reason).

       Logging the payload turns an unrecoverable gap into a replayable one: the
       row can be reconstructed from Worker logs. The `[audit] insert failed`
       prefix is the string to alert on — a burst means schema drift, not a blip.

       meta is deliberately NOT expanded here: it carries before/after blobs that
       can be large and can hold customer data, and this line goes to a log sink
       with a wider audience than the audit table. The identifying fields are
       what make the row replayable; meta is summarised as present-or-absent. */
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
