// Mail Center "needs acknowledgement" (DEV-03 / PRD T-011 P2, R10 / A3).
//
// The sender ticks it on compose / reply. Every To / Cc address that belongs to
// a staff member gets an email_message_acks row (acked_at NULL = still owed)
// and a bell notice. Bcc is left out: the thread lists who owes an
// acknowledgement, and a blind copy must stay blind. The overdue chase reuses
// the announcement window (ACK_OVERDUE_HOURS) and runs once per message: the
// people still owing and their supervisors are told.
//
// company-scope: ack rows hang off an email_messages row the caller already
// resolved in its company, or are keyed on the caller's own user id. The cron
// walks every company on purpose; each notice goes to one person.
import type { Env } from "../types";
import { ACK_OVERDUE_HOURS } from "./announcementAudience";
import { postPersonalNotice } from "../services/personalNotice";

export type StaffRecipient = { userId: number; name: string };

/** Active staff whose login email, alias or assigned mailbox is one of
 *  `addresses`; the sender is never asked to acknowledge their own mail. */
export async function staffRecipients(
  db: D1Database,
  addresses: string[],
  senderId: number | null,
): Promise<StaffRecipient[]> {
  const lc = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (lc.length === 0) return [];
  const ph = lc.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT u.id, u.name, u.email FROM users u
        WHERE u.status = 'active' AND (
          lower(u.email) IN (${ph}) OR lower(COALESCE(u.email_alias, '')) IN (${ph})
          OR u.id IN (SELECT a.assigned_user_id FROM email_addresses a
                       WHERE a.active = 1 AND lower(a.address) IN (${ph})))
        ORDER BY u.name`,
    )
    .bind(...lc, ...lc, ...lc)
    .all<{ id: number; name: string | null; email: string | null }>();
  return rows.results
    .filter((r) => Number(r.id) !== senderId)
    .map((r) => ({ userId: Number(r.id), name: r.name || r.email || String(r.id) }));
}

export async function requestAcks(
  env: Env,
  messageRowId: string,
  people: StaffRecipient[],
  notice: { subject: string; senderName: string },
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE email_messages SET needs_ack = 1 WHERE id = ?`).bind(messageRowId).run();
  for (const p of people) {
    await env.DB.prepare(
      `INSERT INTO email_message_acks (message_id, user_id, requested_at, acked_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT (message_id, user_id) DO NOTHING`,
    )
      .bind(messageRowId, p.userId, now)
      .run();
  }
  await postPersonalNotice(env, {
    userIds: people.map((p) => p.userId),
    category: "GENERAL",
    title: `Please acknowledge: ${notice.subject}`,
    body: `${notice.senderName} asked you to acknowledge this email. Open Mail Center, To acknowledge.`,
    source: "mail_ack",
  });
}

export type AckState = { userId: number; name: string; ackedAt: string | null; overdue: boolean };

function overdueSince(requestedAt: string, now: number): boolean {
  const t = Date.parse(requestedAt);
  return !Number.isNaN(t) && now - t > ACK_OVERDUE_HOURS * 3_600_000;
}

/** message row id -> everyone asked, acknowledged or not. */
export async function acksForMessages(db: D1Database, messageIds: string[]): Promise<Map<string, AckState[]>> {
  const out = new Map<string, AckState[]>();
  if (messageIds.length === 0) return out;
  const ph = messageIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT k.message_id, k.user_id, k.requested_at, k.acked_at, u.name, u.email
         FROM email_message_acks k JOIN users u ON u.id = k.user_id
        WHERE k.message_id IN (${ph}) ORDER BY u.name`,
    )
    .bind(...messageIds)
    .all<{ message_id: string; user_id: number; requested_at: string; acked_at: string | null; name: string | null; email: string | null }>();
  const now = Date.now();
  for (const r of rows.results) {
    const list = out.get(r.message_id) ?? [];
    list.push({
      userId: Number(r.user_id),
      name: r.name || r.email || String(r.user_id),
      ackedAt: r.acked_at,
      overdue: !r.acked_at && overdueSince(r.requested_at, now),
    });
    out.set(r.message_id, list);
  }
  return out;
}

export type OwedAck = {
  messageId: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  requestedAt: string;
  snippet: string;
  overdue: boolean;
};

/** What this person still owes, oldest first. */
export async function owedAcks(db: D1Database, userId: number): Promise<OwedAck[]> {
  const rows = await db
    .prepare(
      `SELECT k.message_id, k.requested_at, m.thread_id, m.subject, m.from_name, m.from_address, m.text_body
         FROM email_message_acks k JOIN email_messages m ON m.id = k.message_id
        WHERE k.user_id = ? AND k.acked_at IS NULL
        ORDER BY k.requested_at ASC LIMIT 200`,
    )
    .bind(userId)
    .all<{ message_id: string; requested_at: string; thread_id: string; subject: string | null; from_name: string | null; from_address: string | null; text_body: string | null }>();
  const now = Date.now();
  return rows.results.map((r) => ({
    messageId: r.message_id,
    threadId: r.thread_id,
    subject: r.subject ?? "(no subject)",
    fromName: r.from_name ?? "",
    fromAddress: r.from_address ?? "",
    requestedAt: r.requested_at,
    snippet: (r.text_body ?? "").slice(0, 200),
    overdue: overdueSince(r.requested_at, now),
  }));
}

/** false = this person was not asked, or already acknowledged. */
export async function acknowledge(db: D1Database, messageRowId: string, userId: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE email_message_acks SET acked_at = ? WHERE message_id = ? AND user_id = ? AND acked_at IS NULL`)
    .bind(new Date().toISOString(), messageRowId, userId)
    .run();
  return Number(res.meta.changes) > 0;
}

/** Which messages on a thread carry this person's owed acknowledgement: the
 *  sender's own row, or the person's inbound copy of it (same Message-ID).
 *  thread message row id -> the ack request's message row id. */
export async function myOwedOnThread(
  db: D1Database,
  userId: number,
  messages: Array<{ id: string; messageId?: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (messages.length === 0) return out;
  const rows = await db
    .prepare(
      `SELECT k.message_id AS request_id, m.message_id AS rfc_id
         FROM email_message_acks k JOIN email_messages m ON m.id = k.message_id
        WHERE k.user_id = ? AND k.acked_at IS NULL`,
    )
    .bind(userId)
    .all<{ request_id: string; rfc_id: string | null }>();
  for (const msg of messages) {
    const hit = rows.results.find((r) => r.request_id === msg.id || (!!msg.messageId && r.rfc_id === msg.messageId));
    if (hit) out.set(msg.id, hit.request_id);
  }
  return out;
}

export type AckEscalationRun = { scanned: number; chased: number; people: number; supervisors: number };

// The half-hourly cron: once per message, past the window, tell the people
// still owing and their supervisors.
export async function runMailAckEscalation(env: Env, now = Date.now()): Promise<AckEscalationRun> {
  const cutoff = new Date(now - ACK_OVERDUE_HOURS * 3_600_000).toISOString();
  const due = await env.DB.prepare(
    `SELECT m.id, m.subject, m.from_name FROM email_messages m
      WHERE m.needs_ack = 1 AND m.ack_escalated_at IS NULL AND m.created_at < ?
      ORDER BY m.created_at ASC LIMIT 50`,
  )
    .bind(cutoff)
    .all<{ id: string; subject: string | null; from_name: string | null }>();
  const out: AckEscalationRun = { scanned: due.results.length, chased: 0, people: 0, supervisors: 0 };
  for (const m of due.results) {
    const owing = await env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.manager_id FROM email_message_acks k JOIN users u ON u.id = k.user_id
        WHERE k.message_id = ? AND k.acked_at IS NULL`,
    )
      .bind(m.id)
      .all<{ id: number; name: string | null; email: string | null; manager_id: number | null }>();
    const subject = m.subject ?? "(no subject)";
    if (owing.results.length > 0) {
      await postPersonalNotice(env, {
        userIds: owing.results.map((u) => u.id),
        category: "WARNING",
        title: `Overdue acknowledgement: ${subject}`,
        body: `${m.from_name || "A colleague"} is still waiting for your acknowledgement. Open Mail Center, To acknowledge.`,
        source: "mail_ack",
      });
      const byManager = new Map<number, string[]>();
      for (const u of owing.results) {
        if (u.manager_id == null) continue;
        const list = byManager.get(Number(u.manager_id)) ?? [];
        list.push(u.name || u.email || String(u.id));
        byManager.set(Number(u.manager_id), list);
      }
      for (const [managerId, names] of byManager) {
        await postPersonalNotice(env, {
          userIds: [managerId],
          category: "GENERAL",
          title: `${names.length} of your team ${names.length === 1 ? "has" : "have"} not acknowledged "${subject}"`,
          body: `Still pending after ${ACK_OVERDUE_HOURS} hours: ${names.join(", ")}.`,
          source: "mail_ack_escalation",
        });
      }
      out.people += owing.results.length;
      out.supervisors += byManager.size;
    }
    await env.DB.prepare(`UPDATE email_messages SET ack_escalated_at = ? WHERE id = ?`)
      .bind(new Date(now).toISOString(), m.id)
      .run();
    out.chased += 1;
  }
  return out;
}
