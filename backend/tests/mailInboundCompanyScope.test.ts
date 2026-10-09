import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { app } from "../src/index";
import { ingestInboundEmail } from "../src/routes/mail-center";
import { MAX_INBOUND_BYTES } from "../src/routes/mail-inbound";
import type { Env } from "../src/types";

// DEV-03 / PRD T-011 P1. A6: a forged In-Reply-To cannot attach a message to
// the other company's thread, and one mail copied to both companies is kept by
// both. R8: the inbound endpoint refuses oversized bodies and slows secret
// guessing.

const SECRET = "inbound-secret-0123456789";
const inboundEnv = { ...env, MAIL_INBOUND_SECRET: SECRET } as unknown as Env;

beforeAll(async () => {
  const schema = [
    `CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY, code TEXT NOT NULL)`,
    `INSERT OR IGNORE INTO companies (id, code) VALUES (1, 'HOUZS'), (2, '2990')`,
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, subject TEXT, counterparty_email TEXT, counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to_user_id INTEGER, assigned_to_name TEXT, last_message_at TEXT, last_direction TEXT, last_snippet TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, labels TEXT, trashed_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, content_type TEXT, size_bytes INTEGER, storage_path TEXT, content_id TEXT, created_at TEXT)`,
  ];
  for (const s of schema) await env.DB.prepare(s).run();
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_messages`);
  await env.DB.exec(`DELETE FROM email_threads`);
});

async function ingest(deliveredTo: string, messageId: string, inReplyTo?: string) {
  const r = await ingestInboundEmail(
    env.DB,
    {
      from: "someone@example.com",
      to: ["hello@houzscentury.com", "hello@2990shome.com"],
      deliveredTo,
      subject: "Hello",
      text: "hi",
      messageId,
      ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}),
    },
    inboundEnv,
  );
  if (!r.ok) throw new Error(r.error);
  return r;
}

async function companyOf(threadId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT company_id FROM email_threads WHERE id = ?`)
    .bind(threadId)
    .first<{ company_id: number }>();
  return Number(row?.company_id);
}

describe("A6: inbound threading and de-duplication are per company", () => {
  test("an In-Reply-To pointing at the other company's message opens a new thread in this company", async () => {
    const houzs = await ingest("hello@houzscentury.com", "<houzs-1@example.com>");
    expect(await companyOf(houzs.threadId)).toBe(1);

    const forged = await ingest("hello@2990shome.com", "<forged-1@example.com>", "<houzs-1@example.com>");
    expect(forged.threadId).not.toBe(houzs.threadId);
    expect(await companyOf(forged.threadId)).toBe(2);
  });

  test("a reply inside the same company still threads", async () => {
    const first = await ingest("hello@2990shome.com", "<c2-1@example.com>");
    const next = await ingest("hello@2990shome.com", "<c2-2@example.com>", "<c2-1@example.com>");
    expect(next.threadId).toBe(first.threadId);
  });

  test("one mail copied to both companies is stored once in each, and a re-delivery is still deduped", async () => {
    const a = await ingest("hello@houzscentury.com", "<both-1@example.com>");
    const b = await ingest("hello@2990shome.com", "<both-1@example.com>");
    expect(a.deduped).toBeUndefined();
    expect(b.deduped).toBeUndefined();
    expect(await companyOf(a.threadId)).toBe(1);
    expect(await companyOf(b.threadId)).toBe(2);

    const again = await ingest("hello@2990shome.com", "<both-1@example.com>");
    expect(again.deduped).toBe(true);
    expect(again.threadId).toBe(b.threadId);
  });
});

describe("R8: inbound endpoint limits", () => {
  test("an oversized body is refused before it is read", async () => {
    const res = await app.request(
      "/api/mail-center/inbound",
      {
        method: "POST",
        headers: {
          "x-mail-secret": SECRET,
          "content-type": "application/json",
          "content-length": String(MAX_INBOUND_BYTES + 1),
        },
        body: "{}",
      },
      inboundEnv,
    );
    expect(res.status).toBe(413);
  });

  test("wrong secrets from one address are slowed to 429 after 20 tries", async () => {
    const headers = { "x-mail-secret": "wrong-secret-wrong-secret", "CF-Connecting-IP": "203.0.113.9" };
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request("/api/mail-center/inbound", { method: "POST", headers, body: "{}" }, inboundEnv);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  test("the right secret still ingests", async () => {
    const res = await app.request(
      "/api/mail-center/inbound",
      {
        method: "POST",
        headers: { "x-mail-secret": SECRET, "content-type": "application/json" },
        body: JSON.stringify({ from: "a@example.com", to: ["hello@houzscentury.com"], messageId: "<ok-1@example.com>" }),
      },
      inboundEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
