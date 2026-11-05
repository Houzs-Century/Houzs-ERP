import { SELF, env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { app } from "../src/index";
import { ingestInboundEmail } from "../src/routes/mail-center";
import {
  companyMailboxDomain,
  defaultPersonalLocalPart,
  freePersonalAddress,
  provisionPersonalMailbox,
} from "../src/lib/mail-provision";
import type { Env } from "../src/types";

// DEV-03 / PRD T-011 P3 (A1): a new member gets their company address, it is
// listed as waiting to be added in Google until mail arrives or an admin marks
// it, and the person sees which mailboxes they may read and send from.

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;
let domain = "";
let readerRole = 0;
let adminRole = 0;
const made: number[] = [];
const sessions: string[] = [];

async function user(name: string, roleId: number, status = "active"): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at) VALUES (?, ?, 'unused', ?, ?, datetime('now'))`,
  )
    .bind(`p3-${crypto.randomUUID().slice(0, 8)}@test.local`, name, roleId, status)
    .run();
  const id = Number(r.meta.last_row_id);
  made.push(id);
  return id;
}

async function session(userId: number): Promise<string> {
  const token = `p3-${crypto.randomUUID()}`;
  sessions.push(token);
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return token;
}

function get(token: string, path: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } }, liveEnv);
}

beforeAll(async () => {
  const mailSchema = [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, department_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1, mail_host_status TEXT, mail_host_confirmed_at TEXT, mail_host_confirmed_by INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_addr ON email_addresses (lower(address))`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_access_addr_user ON email_address_access (address_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS mail_user_scope (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL DEFAULT 'personal', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, subject TEXT, counterparty_email TEXT, counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to_user_id INTEGER, assigned_to_name TEXT, last_message_at TEXT, last_direction TEXT, last_snippet TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, labels TEXT, trashed_at TEXT, last_inbound_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, needs_ack INTEGER NOT NULL DEFAULT 0, ack_escalated_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_thread_reads (thread_id TEXT NOT NULL, user_id INTEGER NOT NULL, read_at TEXT, PRIMARY KEY (thread_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS email_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, content_type TEXT, size_bytes INTEGER, storage_path TEXT, content_id TEXT, created_at TEXT)`,
  ];
  for (const statement of mailSchema) await env.DB.prepare(statement).run();
  domain = await companyMailboxDomain(liveEnv);
  const role = async (perms: string[]) =>
    Number(
      (
        await env.DB.prepare(`INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'p3', ?, 0)`)
          .bind(`p3-${crypto.randomUUID()}`, JSON.stringify(perms))
          .run()
      ).meta.last_row_id,
    );
  readerRole = await role(["mail_center.read"]);
  adminRole = await role(["mail_center.read", "mail_center.manage"]);
});

afterAll(async () => {
  for (const t of sessions) {
    await env.SESSION_CACHE.delete(`sess:${t}`);
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(t).run();
  }
  for (const t of ["email_address_access", "email_addresses", "email_messages", "email_threads", "email_thread_reads"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await env.DB.exec(`DELETE FROM invitations WHERE token LIKE 'p3-%'`);
  for (const id of made.reverse()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM invitations WHERE invited_by = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  }
  await env.DB.prepare(`DELETE FROM roles WHERE id IN (?, ?)`).bind(readerRole, adminRole).run();
});

beforeEach(async () => {
  for (const t of ["email_address_access", "email_addresses", "email_messages", "email_threads", "email_thread_reads"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
});

describe("the default address", () => {
  test("is first.last from the name, ASCII only", () => {
    expect(defaultPersonalLocalPart("Nur Aina Binti Rahman")).toBe("nur.rahman");
    expect(defaultPersonalLocalPart("  José  Ng ")).toBe("jose.ng");
    expect(defaultPersonalLocalPart("Samuel")).toBe("samuel");
    expect(defaultPersonalLocalPart("陈 ")).toBeNull();
  });

  test("takes the next number when someone already holds it, and never a department mailbox", async () => {
    const first = await user("Lim Wei Jie", readerRole);
    expect(await provisionPersonalMailbox(liveEnv, first)).toBe(`lim.jie@${domain}`);
    const second = await user("Lim Ah Jie", readerRole);
    expect(await freePersonalAddress(liveEnv, second, "Lim Ah Jie")).toBe(`lim.jie2@${domain}`);

    await env.DB.prepare(
      `INSERT INTO email_addresses (id, address, label, assigned_dept, active, created_at) VALUES (?, ?, 'Sales', 'Sales', 1, ?)`,
    )
      .bind(crypto.randomUUID(), `sales@${domain}`, new Date().toISOString())
      .run();
    expect(await freePersonalAddress(liveEnv, second, "Sales")).toBe(`sales2@${domain}`);
  });
});

describe("A1: a new member gets their own mailbox", () => {
  test("provisioning creates the owned mailbox, waiting at the mail host until mail arrives", async () => {
    const id = await user("Tan Mei Ling", readerRole);
    const address = await provisionPersonalMailbox(liveEnv, id);
    expect(address).toBe(`tan.ling@${domain}`);
    const row = await env.DB.prepare(`SELECT assigned_user_id, mail_host_status FROM email_addresses WHERE address = ?`)
      .bind(address)
      .first<{ assigned_user_id: number; mail_host_status: string }>();
    expect(row).toEqual({ assigned_user_id: id, mail_host_status: "pending" });
    const alias = await env.DB.prepare(`SELECT email_alias FROM users WHERE id = ?`).bind(id).first<{ email_alias: string }>();
    expect(alias?.email_alias).toBe(address);

    // Running again keeps the address it has.
    expect(await provisionPersonalMailbox(liveEnv, id)).toBe(address);

    const r = await ingestInboundEmail(
      env.DB,
      { from: "customer@example.com", to: [address!], subject: "Hello", text: "Hi", messageId: `<p3-${id}@example.com>` },
      liveEnv,
    );
    expect(r.ok).toBe(true);
    const after = await env.DB.prepare(`SELECT mail_host_status FROM email_addresses WHERE address = ?`)
      .bind(address)
      .first<{ mail_host_status: string }>();
    expect(after?.mail_host_status).toBe("live");
  });

  test("accepting an invitation provisions the address from the name given at sign-up", async () => {
    const inviter = await user("Inviter", readerRole);
    const email = `p3-new-${crypto.randomUUID().slice(0, 6)}@test.local`;
    const r = await env.DB.prepare(`INSERT INTO users (email, name, role_id, status) VALUES (?, NULL, ?, 'invited')`)
      .bind(email, readerRole)
      .run();
    made.push(Number(r.meta.last_row_id));
    const token = `p3-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO invitations (email, role_id, token, expires_at, invited_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(email, readerRole, token, new Date(Date.now() + 86_400_000).toISOString(), inviter)
      .run();
    const res = await SELF.fetch("https://test.local/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "Farah Hanim", password: "Str0ng!Passw0rd#2026" }),
    });
    expect(res.status).toBe(200);
    const alias = await env.DB.prepare(`SELECT email_alias FROM users WHERE email = ?`).bind(email).first<{ email_alias: string }>();
    expect(alias?.email_alias).toBe(`farah.hanim@${domain}`);
  });

  test("My mailbox: the person sees their own address first, and Sent by me lists only their sends", async () => {
    const id = await user("Wong Kar Wai", readerRole);
    const address = (await provisionPersonalMailbox(liveEnv, id))!;
    const sharedId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO email_addresses (id, address, label, active, created_at) VALUES (?, ?, 'Sales', 1, ?)`)
      .bind(sharedId, `shared-${id}@${domain}`, new Date().toISOString())
      .run();
    await env.DB.prepare(`INSERT INTO email_address_access (id, address_id, user_id, created_at) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), sharedId, id, new Date().toISOString())
      .run();
    const token = await session(id);

    const vis = (await (await get(token, "/api/mail-center/visibility")).json()) as {
      level: string;
      manage: boolean;
      myAddress: string;
      mailboxes: Array<{ address: string; reach: string }>;
      sendFrom: string[];
    };
    expect(vis.level).toBe("personal");
    expect(vis.manage).toBe(false);
    expect(vis.myAddress).toBe(address);
    expect(vis.mailboxes.map((m) => [m.address, m.reach])).toEqual([
      [address, "own"],
      [`shared-${id}@${domain}`, "granted"],
    ]);
    expect(vis.sendFrom).toEqual([address, `shared-${id}@${domain}`]);

    const now = new Date().toISOString();
    for (const [tid, by] of [
      ["t-mine", id],
      ["t-other", id + 100000],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO email_threads (id, mailbox_address, subject, last_message_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(tid, `shared-${id}@${domain}`, tid, now, now)
        .run();
      await env.DB.prepare(
        `INSERT INTO email_messages (id, thread_id, direction, sent_by_user_id, created_at) VALUES (?, ?, 'outbound', ?, ?)`,
      )
        .bind(`m-${tid}`, tid, by, now)
        .run();
    }
    const sent = (await (await get(token, "/api/mail-center/threads?sentBy=me")).json()) as Array<{ id: string }>;
    expect(sent.map((t) => t.id)).toEqual(["t-mine"]);
  });
});

describe("R2: addresses waiting to be added in Google", () => {
  test("an admin sees the list and marks one added; a member may not", async () => {
    const newcomer = await user("Ali Hassan", readerRole);
    const address = await provisionPersonalMailbox(liveEnv, newcomer);
    const admin = await user("Mail Admin", adminRole);
    const adminToken = await session(admin);
    const memberToken = await session(newcomer);

    expect((await get(memberToken, "/api/mail-center/mail-host/pending")).status).toBe(403);
    const pending = (await (await get(adminToken, "/api/mail-center/mail-host/pending")).json()) as Array<{
      id: string;
      address: string;
      name: string;
    }>;
    expect(pending.map((p) => [p.address, p.name])).toEqual([[address, "Ali Hassan"]]);

    const confirm = await app.request(
      `/api/mail-center/mail-host/${pending[0].id}/confirm`,
      { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } },
      liveEnv,
    );
    expect(confirm.status).toBe(200);
    expect(await (await get(adminToken, "/api/mail-center/mail-host/pending")).json()).toEqual([]);
    const again = await app.request(
      `/api/mail-center/mail-host/${pending[0].id}/confirm`,
      { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } },
      liveEnv,
    );
    expect(again.status).toBe(404);
  });
});
