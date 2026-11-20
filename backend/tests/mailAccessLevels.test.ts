import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";

// Owner 2026-11-21: mail access follows the Org Chart. Every department a person
// is in opens its department mailbox; "Whole department" adds the colleagues' own
// mailboxes; the Management department reads every mailbox; sharing is logged.

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;
const SALES = 211001;
const OPS = 211002;
const MGMT = 211003;
const TABLES = ["email_address_access", "email_addresses", "mail_user_scope", "user_departments", "mail_access_changes"];
let readerRole = 0;
let adminRole = 0;
const made: number[] = [];
const sessions: string[] = [];

async function user(name: string, roleId: number, departmentId: number | null): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, department_id, joined_at) VALUES (?, ?, 'unused', ?, 'active', ?, datetime('now'))`,
  )
    .bind(`acl-${crypto.randomUUID().slice(0, 8)}@test.local`, name, roleId, departmentId)
    .run();
  const id = Number(r.meta.last_row_id);
  made.push(id);
  return id;
}

async function session(userId: number): Promise<string> {
  const token = `acl-${crypto.randomUUID()}`;
  sessions.push(token);
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return token;
}

function call(token: string, path: string, method = "GET", body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    liveEnv,
  );
}

async function mailbox(address: string, ownerId: number | null, departmentId: number | null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO email_addresses (id, address, label, assigned_user_id, department_id, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(id, address, address, ownerId, departmentId, new Date().toISOString())
    .run();
  return id;
}

async function level(userId: number, value: string) {
  await env.DB.prepare(`INSERT OR REPLACE INTO mail_user_scope (user_id, level, created_at) VALUES (?, ?, ?)`)
    .bind(userId, value, new Date().toISOString())
    .run();
}

async function visible(token: string) {
  return (await (await call(token, "/api/mail-center/visibility")).json()) as {
    level: string;
    mailboxes: Array<{ address: string; reach: string }>;
  };
}

beforeAll(async () => {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, department_id INTEGER, requested_department_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1, mail_host_status TEXT, mail_host_confirmed_at TEXT, mail_host_confirmed_by INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_addr ON email_addresses (lower(address))`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS mail_user_scope (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL DEFAULT 'personal', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS user_departments (user_id INTEGER NOT NULL, department_id INTEGER NOT NULL, created_at TEXT, PRIMARY KEY (user_id, department_id))`,
    `CREATE TABLE IF NOT EXISTS mail_access_changes (id TEXT PRIMARY KEY, company_id INTEGER, changed_at TEXT NOT NULL DEFAULT (datetime('now')), by_user_id INTEGER, user_id INTEGER NOT NULL, change TEXT NOT NULL)`,
    `INSERT OR REPLACE INTO departments (id, name) VALUES (${SALES}, 'Aclsales'), (${OPS}, 'Aclops'), (${MGMT}, 'Management')`,
  ]) {
    await env.DB.prepare(statement).run();
  }
  const role = async (perms: string[]) =>
    Number(
      (
        await env.DB.prepare(`INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'acl', ?, 0)`)
          .bind(`acl-${crypto.randomUUID()}`, JSON.stringify(perms))
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
  for (const table of TABLES) await env.DB.exec(`DELETE FROM ${table}`);
  for (const id of made.reverse()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  }
  await env.DB.prepare(`DELETE FROM departments WHERE id IN (?, ?, ?)`).bind(SALES, OPS, MGMT).run();
  await env.DB.prepare(`DELETE FROM roles WHERE id IN (?, ?)`).bind(readerRole, adminRole).run();
});

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DELETE FROM ${table}`);
});

describe("mail access follows the Org Chart", () => {
  test("someone in two departments reaches both department mailboxes", async () => {
    const elvis = await user("Acl Elvis", readerRole, OPS);
    await env.DB.prepare(`INSERT INTO user_departments (user_id, department_id) VALUES (?, ?)`).bind(elvis, SALES).run();
    await mailbox("acl-ops@houzscentury.com", null, OPS);
    await mailbox("acl-sales@houzscentury.com", null, SALES);
    const vis = await visible(await session(elvis));
    expect(vis.level).toBe("department");
    expect(vis.mailboxes.map((m) => m.address).sort()).toEqual(["acl-ops@houzscentury.com", "acl-sales@houzscentury.com"]);
  });

  test("Whole department adds the colleagues' own mailboxes; Department mailbox does not", async () => {
    const manager = await user("Acl Manager", readerRole, SALES);
    const staff = await user("Acl Staff", readerRole, SALES);
    const colleague = await user("Acl Colleague", readerRole, SALES);
    const outsider = await user("Acl Outsider", readerRole, OPS);
    await mailbox("acl-sales@houzscentury.com", null, SALES);
    await mailbox("acl-colleague@houzscentury.com", colleague, null);
    await mailbox("acl-outsider@houzscentury.com", outsider, null);
    await level(manager, "department_all");

    const mgr = await visible(await session(manager));
    expect(mgr.level).toBe("department_all");
    expect(mgr.mailboxes.map((m) => [m.address, m.reach]).sort()).toEqual([
      ["acl-colleague@houzscentury.com", "department"],
      ["acl-sales@houzscentury.com", "department"],
    ]);
    const plain = await visible(await session(staff));
    expect(plain.mailboxes.map((m) => m.address)).toEqual(["acl-sales@houzscentury.com"]);
  });

  test("a member of the Management department reads every mailbox, whatever level is stored", async () => {
    const boss = await user("Acl Boss", readerRole, MGMT);
    const other = await user("Acl Other", readerRole, OPS);
    await level(boss, "personal");
    await mailbox("acl-ops@houzscentury.com", null, OPS);
    await mailbox("acl-other@houzscentury.com", other, null);
    const vis = await visible(await session(boss));
    expect(vis.level).toBe("company");
    expect(vis.mailboxes.map((m) => m.address).sort()).toEqual(["acl-ops@houzscentury.com", "acl-other@houzscentury.com"]);
  });
});

describe("sharing is logged", () => {
  test("sharing a colleague's own mailbox and the new level are both logged; an unknown level is refused", async () => {
    const admin = await user("Acl Admin", adminRole, OPS);
    const owner = await user("Acl Owner", readerRole, SALES);
    const cover = await user("Acl Cover", readerRole, SALES);
    const boxId = await mailbox("acl-owner@houzscentury.com", owner, null);
    const token = await session(admin);

    expect((await call(token, "/api/mail-center/access", "POST", { addressId: boxId, userId: cover })).status).toBe(201);
    expect((await call(token, "/api/mail-center/scope-level", "PUT", { userId: cover, level: "department_all" })).status).toBe(200);
    const cv = await visible(await session(cover));
    expect(cv.mailboxes.find((m) => m.address === "acl-owner@houzscentury.com")?.reach).toBe("granted");

    const changes = (await (await call(token, "/api/mail-center/access/changes")).json()) as Array<{ by: string; who: string; change: string }>;
    expect(changes.map((c) => c.change).sort()).toEqual(["set level to L3 · Whole department", "shared acl-owner@houzscentury.com"]);
    expect(changes.every((c) => c.by === "Acl Admin" && c.who === "Acl Cover")).toBe(true);

    expect((await call(token, "/api/mail-center/scope-level", "PUT", { userId: cover, level: "everything" })).status).toBe(400);
  });
});
