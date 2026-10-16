import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../src/index";
import { ingestInboundEmail } from "../src/routes/mail-center";
import { runMailAckEscalation } from "../src/lib/mail-acks";
import type { Env } from "../src/types";

// DEV-03 / PRD T-011 P2: opening a shared mailbox's thread marks it read for the
// opener only (A4), and a mail sent with "needs acknowledgement" shows who has
// and has not acknowledged it, then chases the rest and their supervisor (A3).

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;
const MAILBOX = `sales-${crypto.randomUUID().slice(0, 8)}@houzscentury.com`;

let roleId = 0;
const ids = { owner: 0, colleague: 0, manager: 0, recipient: 0 };
const tokens = { owner: "", colleague: "", manager: "", recipient: "" };
let recipientEmail = "";
let resendReplies = 0;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const mailSchema = [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS mail_user_scope (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL DEFAULT 'personal', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, subject TEXT, counterparty_email TEXT, counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to_user_id INTEGER, assigned_to_name TEXT, last_message_at TEXT, last_direction TEXT, last_snippet TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, labels TEXT, trashed_at TEXT, last_inbound_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, needs_ack INTEGER NOT NULL DEFAULT 0, ack_escalated_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_thread_reads (thread_id TEXT NOT NULL, user_id INTEGER NOT NULL, read_at TEXT, PRIMARY KEY (thread_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS email_message_acks (message_id TEXT NOT NULL, user_id INTEGER NOT NULL, requested_at TEXT NOT NULL, acked_at TEXT, PRIMARY KEY (message_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS email_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, content_type TEXT, size_bytes INTEGER, storage_path TEXT, content_id TEXT, created_at TEXT)`,
    // The bell notices are PG-only too; postPersonalNotice writes these columns.
    `CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT, body TEXT, is_active INTEGER, expires_at TEXT, created_by INTEGER, created_at TEXT, translations TEXT, attachments TEXT, target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT, target_user_ids TEXT, category TEXT, source TEXT)`,
    `CREATE TABLE IF NOT EXISTS announcement_acks (announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, acked_at TEXT, PRIMARY KEY (announcement_id, user_id))`,
  ];
  for (const statement of mailSchema) await env.DB.prepare(statement).run();

  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'mail reads acks test', ?, 0)`,
  )
    .bind(`mail-reads-acks-${crypto.randomUUID()}`, JSON.stringify(["mail_center.read"]))
    .run();
  roleId = Number(role.meta.last_row_id);

  const names = { manager: "Mona Manager", owner: "Olive Owner", colleague: "Colin Colleague", recipient: "Rita Recipient" };
  for (const key of ["manager", "owner", "colleague", "recipient"] as const) {
    const email = `mail-ack-${key}-${crypto.randomUUID().slice(0, 8)}@test.local`;
    if (key === "recipient") recipientEmail = email;
    const row = await env.DB.prepare(
      `INSERT INTO users (email, name, password_hash, role_id, status, joined_at, manager_id)
       VALUES (?, ?, 'unused', ?, 'active', datetime('now'), ?)`,
    )
      .bind(email, names[key], roleId, key === "manager" ? null : ids.manager)
      .run();
    ids[key] = Number(row.meta.last_row_id);
    tokens[key] = `mail-ack-${key}-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
      .bind(tokens[key], ids[key], new Date(Date.now() + 3_600_000).toISOString())
      .run();
  }

  const addressId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO email_addresses (id, address, label, assigned_user_id, active, created_at) VALUES (?, ?, 'Sales', ?, 1, ?)`,
  )
    .bind(addressId, MAILBOX, ids.owner, new Date().toISOString())
    .run();
  await env.DB.prepare(`INSERT INTO email_address_access (id, address_id, user_id, created_at) VALUES (?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), addressId, ids.colleague, new Date().toISOString())
    .run();
});

afterAll(async () => {
  for (const key of Object.keys(tokens) as Array<keyof typeof tokens>) {
    await env.SESSION_CACHE.delete(`sess:${tokens[key]}`);
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(tokens[key]).run();
  }
  await env.DB.prepare(`DELETE FROM email_address_access WHERE user_id = ?`).bind(ids.colleague).run();
  await env.DB.prepare(`DELETE FROM email_addresses WHERE address = ?`).bind(MAILBOX).run();
  await env.DB.prepare(`DELETE FROM users WHERE id IN (?, ?, ?)`).bind(ids.owner, ids.colleague, ids.recipient).run();
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(ids.manager).run();
  await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
});

beforeEach(async () => {
  resendReplies = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.resend.com/emails" || request.method !== "POST") {
      throw new Error(`Unexpected outbound fetch: ${request.method} ${request.url}`);
    }
    resendReplies += 1;
    return new Response(JSON.stringify({ id: `prov-${resendReplies}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  for (const t of ["email_messages", "email_threads", "email_thread_reads", "email_message_acks", "email_outbox", "email_log"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await env.DB.exec(`DELETE FROM announcements WHERE source IN ('mail_ack', 'mail_ack_escalation')`);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function as(who: keyof typeof tokens, init: { method?: string; body?: unknown } = {}): RequestInit {
  return {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
}

async function inbound(messageId: string) {
  const r = await ingestInboundEmail(
    env.DB,
    { from: "customer@example.com", to: [MAILBOX], subject: "Sofa delivery date", text: "When?", messageId },
    liveEnv,
  );
  if (!r.ok) throw new Error(r.error);
  return r.threadId;
}

async function unreadFor(who: keyof typeof tokens, threadId: string): Promise<boolean> {
  const res = await app.request(`/api/mail-center/threads`, as(who), liveEnv);
  expect(res.status).toBe(200);
  const list = (await res.json()) as Array<{ id: string; unread: boolean }>;
  const row = list.find((t) => t.id === threadId);
  if (!row) throw new Error(`${who} cannot see thread ${threadId}`);
  return row.unread;
}

type Detail = {
  readers: { members: Array<{ userId: number; readAt: string | null }>; others: unknown[] };
  messages: Array<{ id: string; direction: string; acks: Array<{ userId: number; ackedAt: string | null }>; ackRequestId: string | null }>;
};

async function open(who: keyof typeof tokens, threadId: string): Promise<Detail> {
  const res = await app.request(`/api/mail-center/threads/${threadId}`, as(who), liveEnv);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
}

describe("A4: read state is per person", () => {
  test("opening a shared thread does not clear a colleague's unread", async () => {
    const threadId = await inbound("<a4-1@example.com>");
    expect(await unreadFor("owner", threadId)).toBe(true);
    expect(await unreadFor("colleague", threadId)).toBe(true);

    const detail = await open("owner", threadId);
    expect(await unreadFor("owner", threadId)).toBe(false);
    expect(await unreadFor("colleague", threadId)).toBe(true);

    // "Read by 1 of 2": both members are listed, only the opener has read it.
    expect(detail.readers.members.map((m) => m.userId).sort()).toEqual([ids.owner, ids.colleague].sort());
    const after = await open("colleague", threadId);
    const readBy = after.readers.members.filter((m) => m.readAt != null).map((m) => m.userId).sort();
    expect(readBy).toEqual([ids.owner, ids.colleague].sort());
  });

  test("a new inbound mail is unread again; mark-unread changes only the caller", async () => {
    const threadId = await inbound("<a4-2@example.com>");
    await open("owner", threadId);
    await open("colleague", threadId);

    await new Promise((r) => setTimeout(r, 5));
    await ingestInboundEmail(
      env.DB,
      {
        from: "customer@example.com",
        to: [MAILBOX],
        subject: "Re: Sofa delivery date",
        text: "Any news?",
        messageId: "<a4-3@example.com>",
        inReplyTo: "<a4-2@example.com>",
        references: ["<a4-2@example.com>"],
      },
      liveEnv,
    );
    expect(await unreadFor("owner", threadId)).toBe(true);
    expect(await unreadFor("colleague", threadId)).toBe(true);

    await open("owner", threadId);
    await open("colleague", threadId);
    const patched = await app.request(
      `/api/mail-center/threads/${threadId}`,
      as("owner", { method: "PATCH", body: { unread: true } }),
      liveEnv,
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { unread: boolean }).unread).toBe(true);
    expect(await unreadFor("owner", threadId)).toBe(true);
    expect(await unreadFor("colleague", threadId)).toBe(false);
  });
});

describe("A3: needs acknowledgement", () => {
  async function composeWithAck(to: string): Promise<Response> {
    return app.request(
      `/api/mail-center/compose`,
      as("owner", {
        method: "POST",
        body: { fromAddress: MAILBOX, to, subject: "New price list", text: "Please read.", needsAck: true },
      }),
      liveEnv,
    );
  }

  test("only staff recipients owe it; the sender sees who has and has not acknowledged", async () => {
    const res = await composeWithAck(`${recipientEmail}, customer@example.com, ${MAILBOX}`);
    expect(res.status).toBe(201);
    const { threadId, messageId } = (await res.json()) as { threadId: string; messageId: string };

    const owed = await env.DB.prepare(`SELECT user_id FROM email_message_acks WHERE message_id = ? ORDER BY user_id`)
      .bind(messageId)
      .all<{ user_id: number }>();
    // The mailbox belongs to the sender, who is never asked; the customer is not staff.
    expect(owed.results.map((r) => Number(r.user_id))).toEqual([ids.recipient]);

    const notice = await env.DB.prepare(`SELECT target_user_ids FROM announcements WHERE source = 'mail_ack'`).first<{
      target_user_ids: string;
    }>();
    expect(JSON.parse(notice?.target_user_ids ?? "[]")).toEqual([ids.recipient]);

    const pending = await app.request(`/api/mail-center/acks/pending`, as("recipient"), liveEnv);
    expect(((await pending.json()) as Array<{ messageId: string; overdue: boolean }>).map((p) => [p.messageId, p.overdue])).toEqual([
      [messageId, false],
    ]);

    let detail = await open("owner", threadId);
    expect(detail.messages[0].acks).toEqual([expect.objectContaining({ userId: ids.recipient, ackedAt: null })]);
    expect(detail.messages[0].ackRequestId).toBeNull();

    const ack = await app.request(`/api/mail-center/messages/${messageId}/ack`, as("recipient", { method: "POST" }), liveEnv);
    expect(ack.status).toBe(200);
    const again = await app.request(`/api/mail-center/messages/${messageId}/ack`, as("recipient", { method: "POST" }), liveEnv);
    expect(again.status).toBe(404);
    const stranger = await app.request(`/api/mail-center/messages/${messageId}/ack`, as("colleague", { method: "POST" }), liveEnv);
    expect(stranger.status).toBe(404);

    const none = await app.request(`/api/mail-center/acks/pending`, as("recipient"), liveEnv);
    expect(await none.json()).toEqual([]);
    detail = await open("owner", threadId);
    expect(detail.messages[0].acks[0].ackedAt).not.toBeNull();
  });

  test("asking an outside-only list to acknowledge is refused before anything is sent", async () => {
    const res = await composeWithAck("customer@example.com");
    expect(res.status).toBe(400);
    expect(resendReplies).toBe(0);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_messages`).first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
  });

  test("past the window the people still owing and their supervisor are told, once", async () => {
    const res = await composeWithAck(recipientEmail);
    const { messageId } = (await res.json()) as { messageId: string };

    expect((await runMailAckEscalation(liveEnv)).chased).toBe(0);

    const later = Date.now() + 49 * 3_600_000;
    const run = await runMailAckEscalation(liveEnv, later);
    expect(run).toMatchObject({ chased: 1, people: 1, supervisors: 1 });
    const chases = await env.DB.prepare(
      `SELECT source, target_user_ids FROM announcements WHERE source IN ('mail_ack', 'mail_ack_escalation') AND title NOT LIKE 'Please acknowledge%' ORDER BY source`,
    ).all<{ source: string; target_user_ids: string }>();
    expect(chases.results.map((r) => [r.source, JSON.parse(r.target_user_ids)])).toEqual([
      ["mail_ack", [ids.recipient]],
      ["mail_ack_escalation", [ids.manager]],
    ]);

    expect((await runMailAckEscalation(liveEnv, later)).chased).toBe(0);
    const row = await env.DB.prepare(`SELECT ack_escalated_at FROM email_messages WHERE id = ?`).bind(messageId).first<{
      ack_escalated_at: string | null;
    }>();
    expect(row?.ack_escalated_at).not.toBeNull();
  });
});
