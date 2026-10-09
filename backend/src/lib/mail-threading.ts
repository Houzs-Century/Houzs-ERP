// Mail Center RFC threading (DEV-03 / PRD T-011 P1).
//
// A customer's mail client threads a reply by its In-Reply-To / References
// headers, and our inbound side finds the thread the same way (message_id).
// Resend assigns the Message-ID of what we send and does not take ours, so the
// outbound row gets it afterwards from GET /emails/:id. Until it has one, a
// reply to that message cannot find its thread.
import type { Env } from "../types";

const REFERENCES_CAP = 20;
const BACKFILL_WINDOW_MS = 3 * 86_400_000;

/** Headers for a reply, from the thread's known Message-IDs, oldest first. */
export function threadingHeaders(messageIds: string[]): Record<string, string> | null {
  const ids = messageIds.map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  return {
    "In-Reply-To": ids[ids.length - 1],
    References: ids.slice(-REFERENCES_CAP).join(" "),
  };
}

/** The thread's Message-IDs in the order the messages happened. */
export async function threadMessageIds(db: D1Database, threadId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT message_id FROM email_messages
        WHERE thread_id = ? AND message_id IS NOT NULL
        ORDER BY COALESCE(sent_at, received_at, created_at) ASC`,
    )
    .bind(threadId)
    .all<{ message_id: string }>();
  return rows.results.map((r) => r.message_id);
}

export async function resendMessageId(env: Env, providerId: string): Promise<string | null> {
  if (!env.RESEND_API_KEY) return null;
  try {
    const resp = await fetch(`https://api.resend.com/emails/${encodeURIComponent(providerId)}`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json().catch(() => ({}))) as { message_id?: string | null };
    const id = (data.message_id ?? "").trim();
    return id || null;
  } catch {
    return null;
  }
}

/** Copy Resend's Message-ID onto recent outbound rows that lack one. A queued
 *  row gets its provider id from the outbox once the retry delivers it.
 *  companyId null = every company (the cron). Returns rows filled. */
export async function backfillOutboundMessageIds(
  db: D1Database,
  env: Env,
  companyId: number | null,
  limit: number,
): Promise<number> {
  const since = new Date(Date.now() - BACKFILL_WINDOW_MS).toISOString();
  const rows = await db
    .prepare(
      `SELECT m.id, COALESCE(m.provider_message_id, o.provider_id) AS provider_id
         FROM email_messages m
         LEFT JOIN email_outbox o ON o.id = m.outbox_id
        WHERE m.direction = 'outbound' AND m.message_id IS NULL AND m.created_at >= ?
          AND COALESCE(m.provider_message_id, o.provider_id) IS NOT NULL
          ${companyId != null ? "AND m.company_id = ?" : ""}
        ORDER BY m.created_at DESC LIMIT ?`,
    )
    .bind(since, ...(companyId != null ? [companyId] : []), limit)
    .all<{ id: string; provider_id: string }>();
  let filled = 0;
  for (const r of rows.results) {
    const messageId = await resendMessageId(env, r.provider_id);
    if (!messageId) continue;
    await db
      .prepare(`UPDATE email_messages SET message_id = ?, provider_message_id = ? WHERE id = ?`)
      .bind(messageId, r.provider_id, r.id)
      .run();
    filled++;
  }
  return filled;
}

/** Thread id of the first referenced message in this company. null company =
 *  the companies master is absent (single-company), so no predicate. */
export async function threadForReferences(
  db: D1Database,
  refs: string[],
  companyId: number | null,
): Promise<string | null> {
  if (refs.length === 0) return null;
  const ph = refs.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT thread_id FROM email_messages WHERE message_id IN (${ph})${companyId != null ? " AND company_id = ?" : ""} LIMIT 1`,
    )
    .bind(...refs, ...(companyId != null ? [companyId] : []))
    .first<{ thread_id?: string }>();
  return row?.thread_id || null;
}

export type OutboundMessage = {
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  text: string | null;
  html: string;
  userId: number | null;
  providerId: string | null;
  outboxId: string | null;
  inReplyTo: string | null;
  references: string | null;
  companyId: number | null;
};

/** Store one sent (or queued) Mail Center message. Bcc is never stored: it was
 *  blind, and a thread anyone on the mailbox can open is the wrong place to
 *  record it. To/Cc are the full lists, which the thread view renders and the
 *  next reply-all reads back. */
export async function recordOutboundMessage(db: D1Database, m: OutboundMessage): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const stampCo = m.companyId != null;
  await db
    .prepare(
      `INSERT INTO email_messages
         (id, thread_id, direction, in_reply_to, reference_ids, from_address, from_name,
          to_addresses, cc_addresses, subject, text_body, html_body, sent_at, received_at,
          sent_by_user_id, sent_by_name, provider_message_id, outbox_id, created_at${stampCo ? ", company_id" : ""})
       VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
    )
    .bind(
      id,
      m.threadId,
      m.inReplyTo,
      m.references,
      m.fromAddress || null,
      m.fromName || null,
      JSON.stringify(m.to),
      JSON.stringify(m.cc),
      m.subject,
      m.text,
      m.html,
      now,
      now,
      m.userId,
      m.fromName || null,
      m.providerId,
      m.outboxId,
      now,
      ...(stampCo ? [m.companyId] : []),
    )
    .run();
  return id;
}

/** "queued" while the outbox retries it, "failed" once it gave up; null = sent
 *  (or a row from before the outbox link existed). */
export function deliveryStatus(outboxStatus: string | null | undefined): "queued" | "failed" | null {
  if (outboxStatus === "pending") return "queued";
  if (outboxStatus === "failed") return "failed";
  return null;
}
