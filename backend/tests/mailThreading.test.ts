import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../src/index";
import { drainEmailOutbox } from "../src/services/email";
import { backfillOutboundMessageIds, threadingHeaders } from "../src/lib/mail-threading";
import { ingestInboundEmail } from "../src/routes/mail-center";
import type { Env } from "../src/types";

// DEV-03 / PRD T-011 P1: a customer's reply lands on the original thread (A2),
// and a send with an attachment that fails is retried WITH the attachment, from
// the same mailbox, still threaded (A7).

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;
const MAILBOX = `sales-${crypto.randomUUID().slice(0, 8)}@houzscentury.com`;

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let replies: Array<{ status: number; body: unknown }> = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

function reply(status: number, body: unknown) {
  replies.push({ status, body });
}

let roleId = 0;
let userId = 0;
let token = "";

beforeAll(async () => {
  const mailSchema = [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS mail_user_scope (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL DEFAULT 'personal', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, subject TEXT, counterparty_email TEXT, counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to_user_id INTEGER, assigned_to_name TEXT, last_message_at TEXT, last_direction TEXT, last_snippet TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, labels TEXT, trashed_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, content_type TEXT, size_bytes INTEGER, storage_path TEXT, content_id TEXT, created_at TEXT)`,
  ];
  for (const statement of mailSchema) await env.DB.prepare(statement).run();

  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'mail threading test', ?, 0)`,
  )
    .bind(`mail-threading-${crypto.randomUUID()}`, JSON.stringify(["mail_center.read"]))
    .run();
  roleId = Number(role.meta.last_row_id);
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'Sales Desk', 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`mail-threading-${crypto.randomUUID()}@test.local`, roleId)
    .run();
  userId = Number(user.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO email_addresses (id, address, label, assigned_user_id, active, created_at) VALUES (?, ?, 'Sales', ?, 1, ?)`,
  )
    .bind(crypto.randomUUID(), MAILBOX, userId, new Date().toISOString())
    .run();
  token = `mail-threading-${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
});

afterAll(async () => {
  await env.SESSION_CACHE.delete(`sess:${token}`);
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
  await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
});

beforeEach(async () => {
  calls = [];
  replies = [];
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    calls.push({ url: request.url, method: request.method, body: text ? JSON.parse(text) : null });
    const next = replies.shift();
    if (!next) throw new Error(`Unexpected outbound fetch: ${request.method} ${request.url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
  for (const t of ["email_messages", "email_threads", "email_attachments", "email_outbox", "email_log"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
});

afterEach(() => {
  fetchSpy.mockRestore();
  expect(replies).toEqual([]);
});

function authed(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function inbound(messageId: string, extra: Record<string, unknown> = {}) {
  const r = await ingestInboundEmail(
    env.DB,
    {
      from: "customer@example.com",
      to: [MAILBOX],
      subject: "Sofa delivery date",
      text: "When will it arrive?",
      messageId,
      ...extra,
    },
    liveEnv,
  );
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("threading headers", () => {
  test("In-Reply-To is the newest id and References carries the chain", () => {
    expect(threadingHeaders([])).toBeNull();
    expect(threadingHeaders(["<a@x>", "<b@x>"])).toEqual({
      "In-Reply-To": "<b@x>",
      References: "<a@x> <b@x>",
    });
  });
});

describe("A2: a customer's reply lands on the original thread", () => {
  test("our reply carries In-Reply-To / References and the customer's answer to it threads back", async () => {
    const first = await inbound("<cust-1@example.com>");

    reply(200, { id: "prov-reply-1" });
    const res = await app.request(
      `/api/mail-center/threads/${first.threadId}/reply`,
      authed({ text: "Next Tuesday.", fromAddress: MAILBOX }),
      liveEnv,
    );
    expect(res.status).toBe(200);
    const sent = calls[0];
    expect(sent.url).toBe("https://api.resend.com/emails");
    expect(sent.body.headers).toEqual({
      "In-Reply-To": "<cust-1@example.com>",
      References: "<cust-1@example.com>",
    });
    const stored = await env.DB.prepare(
      `SELECT in_reply_to, provider_message_id, message_id FROM email_messages WHERE direction = 'outbound'`,
    ).first<{ in_reply_to: string; provider_message_id: string; message_id: string | null }>();
    expect(stored).toEqual({
      in_reply_to: "<cust-1@example.com>",
      provider_message_id: "prov-reply-1",
      message_id: null,
    });

    // The customer answers OUR reply before the cron has fetched its id: the
    // ingest fills it in from Resend and finds the thread.
    reply(200, { id: "prov-reply-1", message_id: "<resend-out-1@houzscentury.com>" });
    const answer = await inbound("<cust-2@example.com>", {
      inReplyTo: "<resend-out-1@houzscentury.com>",
      references: ["<resend-out-1@houzscentury.com>"],
      subject: "Re: Sofa delivery date",
    });
    expect(calls[1].url).toBe("https://api.resend.com/emails/prov-reply-1");
    expect(answer.threadId).toBe(first.threadId);
    const threads = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_threads`).first<{ n: number }>();
    expect(Number(threads?.n)).toBe(1);
  });

  test("the cron backfill copies Resend's Message-ID onto the outbound row", async () => {
    const first = await inbound("<cust-3@example.com>");
    reply(200, { id: "prov-reply-2" });
    await app.request(
      `/api/mail-center/threads/${first.threadId}/reply`,
      authed({ text: "Noted.", fromAddress: MAILBOX }),
      liveEnv,
    );
    reply(200, { id: "prov-reply-2", message_id: "<resend-out-2@houzscentury.com>" });
    expect(await backfillOutboundMessageIds(env.DB, liveEnv, null, 10)).toBe(1);
    const row = await env.DB.prepare(
      `SELECT message_id FROM email_messages WHERE provider_message_id = 'prov-reply-2'`,
    ).first<{ message_id: string }>();
    expect(row?.message_id).toBe("<resend-out-2@houzscentury.com>");
  });
});

describe("A7: a failed send with an attachment is retried with it", () => {
  test("queued on the thread, then the drain sends the files, the mailbox From and the threading headers", async () => {
    const first = await inbound("<cust-4@example.com>");
    const pdf = btoa("%PDF-1.4 quotation");

    reply(500, { message: "provider down" });
    const res = await app.request(
      `/api/mail-center/threads/${first.threadId}/reply`,
      authed({
        text: "Quotation attached.",
        fromAddress: MAILBOX,
        attachments: [{ filename: "quote.pdf", contentBase64: pdf }],
      }),
      liveEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, queued: true });

    const view = await app.request(
      `/api/mail-center/threads/${first.threadId}`,
      { headers: { Authorization: `Bearer ${token}` } },
      liveEnv,
    );
    const detail = (await view.json()) as { messages: Array<{ direction: string; deliveryStatus: string | null }> };
    expect(detail.messages.find((m) => m.direction === "outbound")?.deliveryStatus).toBe("queued");

    reply(200, { id: "prov-retry-1" });
    const drained = await drainEmailOutbox(liveEnv);
    expect(drained).toEqual({ processed: 1, sent: 1, failed: 0 });
    const retry = calls[1];
    expect(retry.body.attachments).toEqual([{ filename: "quote.pdf", content: pdf }]);
    expect(retry.body.from).toContain(`<${MAILBOX}>`);
    expect(retry.body.headers["In-Reply-To"]).toBe("<cust-4@example.com>");

    const after = await app.request(
      `/api/mail-center/threads/${first.threadId}`,
      { headers: { Authorization: `Bearer ${token}` } },
      liveEnv,
    );
    const afterDetail = (await after.json()) as { messages: Array<{ direction: string; deliveryStatus: string | null }> };
    expect(afterDetail.messages.find((m) => m.direction === "outbound")?.deliveryStatus).toBeNull();

    // The retried send's Message-ID is picked up through the outbox row.
    reply(200, { id: "prov-retry-1", message_id: "<resend-retry-1@houzscentury.com>" });
    expect(await backfillOutboundMessageIds(env.DB, liveEnv, null, 10)).toBe(1);
  });

  test("a send that fails with no retry possible is still an error, and nothing is recorded", async () => {
    const first = await inbound("<cust-5@example.com>");
    const noBucket = { ...liveEnv, POD_BUCKET: undefined } as unknown as Env;
    reply(500, { message: "provider down" });
    const res = await app.request(
      `/api/mail-center/threads/${first.threadId}/reply`,
      authed({
        text: "Quotation attached.",
        fromAddress: MAILBOX,
        attachments: [{ filename: "quote.pdf", contentBase64: btoa("x") }],
      }),
      noBucket,
    );
    expect(res.status).toBe(502);
    const out = await env.DB.prepare(`SELECT status, last_error FROM email_outbox`).first<{ status: string; last_error: string }>();
    expect(out?.status).toBe("failed");
    expect(out?.last_error).toContain("attachments could not be stored");
    const outbound = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_messages WHERE direction = 'outbound'`,
    ).first<{ n: number }>();
    expect(Number(outbound?.n)).toBe(0);
  });
});
