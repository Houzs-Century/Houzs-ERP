import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createOutboundFetchMock } from "./outboundFetchMock";
import { app } from "../src/index";
import type { Env } from "../src/types";

// Owner 2026-11-21: two people must not both answer one customer email. A
// colleague opening the email sees who is writing; a reply that lands after the
// newest message I saw stops mine until I choose to send anyway; whoever answers
// an unassigned email gets it; the sidebar counts the emails waiting on me.

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;
const BOX = "rg-ops@houzscentury.com";
let roleId = 0;
const made: number[] = [];
const tokens: string[] = [];
let outbound: ReturnType<typeof createOutboundFetchMock>;

async function user(name: string): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at) VALUES (?, ?, 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`rg-${crypto.randomUUID().slice(0, 8)}@test.local`, name, roleId)
    .run();
  const id = Number(r.meta.last_row_id);
  made.push(id);
  await env.DB.prepare(`INSERT OR REPLACE INTO mail_user_scope (user_id, level) VALUES (?, 'company')`).bind(id).run();
  return id;
}

async function session(userId: number): Promise<string> {
  const t = `rg-${crypto.randomUUID()}`;
  tokens.push(t);
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(t, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return t;
}

function call(token: string, path: string, method = "GET", body?: unknown) {
  return app.request(
    path,
    { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    liveEnv,
  );
}

async function message(id: string, direction: string, minsAgo: number, by: number | null, byName: string | null) {
  await env.DB.prepare(
    `INSERT INTO email_messages (id, thread_id, direction, from_address, from_name, to_addresses, cc_addresses, subject, text_body, sent_by_user_id, sent_by_name, created_at)
     VALUES (?, 'rg-t1', ?, ?, ?, '[]', '[]', 'Sofa', 'x', ?, ?, ?)`,
  )
    .bind(id, direction, direction === "inbound" ? "kw@example.com" : BOX, byName ?? "Kok Wai", by, byName, new Date(Date.now() - minsAgo * 60_000).toISOString())
    .run();
}

beforeAll(async () => {
  outbound = createOutboundFetchMock();
  for (const s of [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, department_id INTEGER, requested_department_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1, mail_host_status TEXT, mail_host_confirmed_at TEXT, mail_host_confirmed_by INTEGER)`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS mail_user_scope (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL DEFAULT 'personal', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, subject TEXT, counterparty_email TEXT, counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to_user_id INTEGER, assigned_to_name TEXT, last_message_at TEXT, last_direction TEXT, last_snippet TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, labels TEXT, trashed_at TEXT, last_inbound_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, needs_ack INTEGER NOT NULL DEFAULT 0, ack_escalated_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_thread_reads (thread_id TEXT NOT NULL, user_id INTEGER NOT NULL, read_at TEXT, PRIMARY KEY (thread_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS email_message_acks (message_id TEXT NOT NULL, user_id INTEGER NOT NULL, requested_at TEXT NOT NULL, acked_at TEXT, PRIMARY KEY (message_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS email_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, content_type TEXT, size_bytes INTEGER, storage_path TEXT, content_id TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS mail_thread_replying (thread_id TEXT NOT NULL, user_id INTEGER NOT NULL, company_id INTEGER, at TEXT NOT NULL, PRIMARY KEY (thread_id, user_id))`,
  ]) {
    await env.DB.prepare(s).run();
  }
  roleId = Number(
    (
      await env.DB.prepare(`INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'rg', ?, 0)`)
        .bind(`rg-${crypto.randomUUID()}`, JSON.stringify(["mail_center.read"]))
        .run()
    ).meta.last_row_id,
  );
});

afterAll(async () => {
  outbound.assertDone();
  for (const t of tokens) {
    await env.SESSION_CACHE.delete(`sess:${t}`);
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(t).run();
  }
  for (const t of ["email_messages", "email_threads", "email_addresses", "mail_thread_replying", "email_thread_reads", "email_outbox", "email_log"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  for (const id of made) {
    await env.DB.prepare(`DELETE FROM mail_user_scope WHERE user_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  }
  await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
});

beforeEach(async () => {
  for (const t of ["email_messages", "email_threads", "email_addresses", "mail_thread_replying"]) await env.DB.exec(`DELETE FROM ${t}`);
  await env.DB.prepare(`INSERT INTO email_addresses (id, address, active) VALUES ('rg-a', ?, 1)`).bind(BOX).run();
  await env.DB.prepare(
    `INSERT INTO email_threads (id, mailbox_address, subject, counterparty_email, status, last_direction) VALUES ('rg-t1', ?, 'Sofa', 'kw@example.com', 'open', 'inbound')`,
  )
    .bind(BOX)
    .run();
});

describe("reply guard", () => {
  test("a colleague writing a reply shows to me, not to themselves, and clears when they stop", async () => {
    const ain = await user("Rg Ain");
    const azza = await user("Rg Azza");
    const ainT = await session(ain);
    const azzaT = await session(azza);
    expect((await call(ainT, "/api/mail-center/threads/rg-t1/replying", "POST", { drafting: true })).status).toBe(200);
    const seen = (await (await call(azzaT, "/api/mail-center/threads/rg-t1")).json()) as { replying: Array<{ name: string }> };
    expect(seen.replying).toEqual([{ name: "Rg Ain" }]);
    const own = (await (await call(ainT, "/api/mail-center/threads/rg-t1")).json()) as { replying: unknown[] };
    expect(own.replying).toEqual([]);
    await call(ainT, "/api/mail-center/threads/rg-t1/replying", "POST", { drafting: false });
    const after = (await (await call(azzaT, "/api/mail-center/threads/rg-t1")).json()) as { replying: unknown[] };
    expect(after.replying).toEqual([]);
  });

  test("a reply sent after the newest message I saw stops mine; force sends it and an unassigned email becomes mine", async () => {
    const ain = await user("Rg Ain");
    const azza = await user("Rg Azza");
    const azzaT = await session(azza);
    await message("rg-m1", "inbound", 30, null, null);
    await message("rg-m2", "outbound", 2, ain, "Rg Ain");

    const stopped = await call(azzaT, "/api/mail-center/threads/rg-t1/reply", "POST", { text: "Tuesday ok", afterMessageId: "rg-m1" });
    expect(stopped.status).toBe(409);
    const body = (await stopped.json()) as { code: string; by: string };
    expect(body).toMatchObject({ code: "already_replied", by: "Rg Ain" });

    outbound.replyOnce("https://api.resend.com/emails", "POST", 200, { id: "rg-sent" });
    const sent = await call(azzaT, "/api/mail-center/threads/rg-t1/reply", "POST", { text: "Tuesday ok", afterMessageId: "rg-m1", force: true });
    expect(sent.status).toBe(200);
    const t = await env.DB.prepare(`SELECT assigned_to_user_id FROM email_threads WHERE id = 'rg-t1'`).first<{ assigned_to_user_id: number }>();
    expect(Number(t?.assigned_to_user_id)).toBe(azza);
  });

  test("my own earlier reply, or a reply I had already seen, never stops me", async () => {
    const azza = await user("Rg Azza");
    const azzaT = await session(azza);
    await message("rg-m1", "inbound", 30, null, null);
    await message("rg-m2", "outbound", 2, azza, "Rg Azza");
    outbound.replyOnce("https://api.resend.com/emails", "POST", 200, { id: "rg-own" });
    expect((await call(azzaT, "/api/mail-center/threads/rg-t1/reply", "POST", { text: "one more", afterMessageId: "rg-m1" })).status).toBe(200);
  });

  test("the sidebar counts customer emails assigned to me or in my own mailbox", async () => {
    const azza = await user("Rg Azza");
    const azzaT = await session(azza);
    await env.DB.prepare(`UPDATE email_threads SET assigned_to_user_id = ? WHERE id = 'rg-t1'`).bind(azza).run();
    await env.DB.prepare(`INSERT INTO email_addresses (id, address, assigned_user_id, active) VALUES ('rg-own', 'rg-azza@houzscentury.com', ?, 1)`).bind(azza).run();
    await env.DB.prepare(
      `INSERT INTO email_threads (id, mailbox_address, subject, status, last_direction) VALUES
        ('rg-t2', 'rg-azza@houzscentury.com', 'Mine', 'open', 'inbound'),
        ('rg-t3', 'rg-azza@houzscentury.com', 'Answered', 'open', 'outbound'),
        ('rg-t4', ?, 'Unassigned team mail', 'open', 'inbound')`,
    )
      .bind(BOX)
      .run();
    const r = (await (await call(azzaT, "/api/mail-center/waiting-count")).json()) as { count: number };
    expect(r.count).toBe(2);
  });
});
