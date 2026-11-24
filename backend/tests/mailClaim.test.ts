import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { app } from "../src/index";
import { companyMailboxDomain } from "../src/lib/mail-provision";
import type { Env } from "../src/types";

// HC-0157 A: a member with no company address claims their own, once. When
// the Org Chart has no department for them, they say which one they work in;
// that stays a request until an admin puts them in it. Owner 2026-11-24: the
// claim itself is a request; the mailbox exists only once an admin approves it.

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;
const DEPT = 157101;
let domain = "";
let readerRole = 0;
let adminRole = 0;
let noMailRole = 0;
const made: number[] = [];
const sessions: string[] = [];

async function user(name: string, roleId: number, departmentId: number | null, alias: string | null = null): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, department_id, email_alias, joined_at) VALUES (?, ?, 'unused', ?, 'active', ?, ?, datetime('now'))`,
  )
    .bind(`hc157a-${crypto.randomUUID().slice(0, 8)}@test.local`, name, roleId, departmentId, alias)
    .run();
  const id = Number(r.meta.last_row_id);
  made.push(id);
  return id;
}

async function session(userId: number): Promise<string> {
  const token = `hc157a-${crypto.randomUUID()}`;
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

type Pending = Array<{ address: string; userId: number; requestedDepartment: { id: number; name: string } | null }>;

beforeAll(async () => {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, department_id INTEGER, requested_department_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1, mail_host_status TEXT, mail_host_confirmed_at TEXT, mail_host_confirmed_by INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_addr ON email_addresses (lower(address))`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_access_addr_user ON email_address_access (address_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, last_inbound_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `INSERT OR REPLACE INTO departments (id, name) VALUES (${DEPT}, 'Qzxclaim Department')`,
  ]) {
    await env.DB.prepare(statement).run();
  }
  domain = await companyMailboxDomain(liveEnv);
  const role = async (perms: string[]) =>
    Number(
      (
        await env.DB.prepare(`INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'hc157a', ?, 0)`)
          .bind(`hc157a-${crypto.randomUUID()}`, JSON.stringify(perms))
          .run()
      ).meta.last_row_id,
    );
  readerRole = await role(["mail_center.read"]);
  adminRole = await role(["mail_center.read", "mail_center.manage"]);
  noMailRole = await role(["dashboard.read"]);
});

afterAll(async () => {
  for (const t of sessions) {
    await env.SESSION_CACHE.delete(`sess:${t}`);
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(t).run();
  }
  await env.DB.exec(`DELETE FROM email_address_access`);
  await env.DB.exec(`DELETE FROM email_addresses`);
  await env.DB.exec(`DELETE FROM mail_address_requests`);
  await env.DB.exec(`DELETE FROM app_settings WHERE key = 'mail_alias_limit'`);
  for (const id of made.reverse()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  }
  await env.DB.prepare(`DELETE FROM departments WHERE id = ?`).bind(DEPT).run();
  await env.DB.prepare(`DELETE FROM roles WHERE id IN (?, ?, ?)`).bind(readerRole, adminRole, noMailRole).run();
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_address_access`);
  await env.DB.exec(`DELETE FROM email_addresses`);
  await env.DB.exec(`DELETE FROM mail_address_requests`);
  await env.DB.exec(`DELETE FROM app_settings WHERE key = 'mail_alias_limit'`);
});

type Requests = { usage: { used: number; limit: number }; requests: Array<{ id: string; userId: number; address: string }> };

async function approveAll(admin: string): Promise<Requests> {
  const list = (await (await call(admin, "/api/mail-center/mail-host/requests")).json()) as Requests;
  for (const r of list.requests) {
    expect((await call(admin, `/api/mail-center/mail-host/requests/${r.id}/approve`, "POST", {})).status).toBe(200);
  }
  return list;
}

describe("a member claims their own address", () => {
  test("someone already in a department claims once; the address waits to be added in Google", async () => {
    const id = await user("Kelly Wong", readerRole, DEPT);
    const token = await session(id);

    const offer = (await (await call(token, "/api/mail-center/claim")).json()) as {
      domain: string;
      address: string | null;
      suggestion: string;
      department: { id: number; name: string } | null;
    };
    expect(offer).toMatchObject({ domain, address: null, suggestion: "kelly.wong", department: { id: DEPT, name: "Qzxclaim Department" } });

    const res = await call(token, "/api/mail-center/claim", "POST", { localPart: "Kelly", departmentId: null });
    expect(res.status).toBe(201);
    // Only a request so far: no mailbox, no alias, nothing to send from.
    expect(await env.DB.prepare(`SELECT 1 FROM email_addresses WHERE address = ?`).bind(`kelly@${domain}`).first()).toBeNull();
    expect((await call(token, "/api/mail-center/claim", "POST", { localPart: "kelly.w", departmentId: null })).status).toBe(409);
    const mine = (await (await call(token, "/api/mail-center/claim")).json()) as { request: { address: string; status: string } };
    expect(mine.request).toMatchObject({ address: `kelly@${domain}`, status: "requested" });

    const admin = await session(await user("HC157 Approver", adminRole, null));
    const list = await approveAll(admin);
    expect(list.requests.map((r) => [r.address, r.userId])).toEqual([[`kelly@${domain}`, id]]);
    expect(list.usage).toEqual({ used: 0, limit: 50 });
    const row = await env.DB.prepare(
      `SELECT assigned_user_id, mail_host_status, requested_department_id FROM email_addresses WHERE address = ?`,
    )
      .bind(`kelly@${domain}`)
      .first();
    expect(row).toEqual({ assigned_user_id: id, mail_host_status: "pending", requested_department_id: null });
    const alias = await env.DB.prepare(`SELECT email_alias FROM users WHERE id = ?`).bind(id).first<{ email_alias: string }>();
    expect(alias?.email_alias).toBe(`kelly@${domain}`);

    const again = await call(token, "/api/mail-center/claim", "POST", { localPart: "kelly.w", departmentId: null });
    expect(again.status).toBe(409);
  });

  test("someone with no department must say which one, and the admin sees the request until it is set", async () => {
    const id = await user("Ahmad Zaki", readerRole, null);
    const token = await session(id);
    expect((await call(token, "/api/mail-center/claim", "POST", { localPart: "ahmad", departmentId: null })).status).toBe(400);
    expect((await call(token, "/api/mail-center/claim", "POST", { localPart: "ahmad", departmentId: DEPT })).status).toBe(201);
    const admin = await session(await user("HC157 Admin", adminRole, null));
    await approveAll(admin);

    // The request does not put them in the department.
    const dept = await env.DB.prepare(`SELECT department_id FROM users WHERE id = ?`).bind(id).first<{ department_id: number | null }>();
    expect(dept?.department_id).toBeNull();

    const pending = (await (await call(admin, "/api/mail-center/mail-host/pending")).json()) as Pending;
    expect(pending.map((p) => [p.address, p.userId, p.requestedDepartment])).toEqual([
      [`ahmad@${domain}`, id, { id: DEPT, name: "Qzxclaim Department" }],
    ]);

    await env.DB.prepare(`UPDATE users SET department_id = ? WHERE id = ?`).bind(DEPT, id).run();
    const after = (await (await call(admin, "/api/mail-center/mail-host/pending")).json()) as Pending;
    expect(after[0].requestedDepartment).toBeNull();
  });

  test("refuses a taken address, a department mailbox, and a malformed one", async () => {
    await user("Holder", readerRole, DEPT, `taken@${domain}`);
    await env.DB.prepare(
      `INSERT INTO email_addresses (id, address, label, assigned_dept, department_id, active, created_at) VALUES (?, ?, 'Sales', 'Sales', ?, 1, ?)`,
    )
      .bind(crypto.randomUUID(), `sales@${domain}`, DEPT, new Date().toISOString())
      .run();
    const token = await session(await user("Lee Chong", readerRole, DEPT));

    expect((await call(token, "/api/mail-center/claim", "POST", { localPart: "taken", departmentId: null })).status).toBe(409);
    expect((await call(token, "/api/mail-center/claim", "POST", { localPart: "sales", departmentId: null })).status).toBe(409);
    for (const bad of ["a", "lee chong", "lee..chong", ".lee", "lee@x", "lee-"]) {
      expect((await call(token, "/api/mail-center/claim", "POST", { localPart: bad, departmentId: null })).status).toBe(400);
    }
  });

  test("a rejected request carries its reason and the person can ask again", async () => {
    const id = await user("Rina Tan", readerRole, DEPT);
    const token = await session(id);
    expect((await call(token, "/api/mail-center/claim", "POST", { localPart: "boss", departmentId: null })).status).toBe(201);
    const admin = await session(await user("HC157 Rejecter", adminRole, null));
    const [req] = ((await (await call(admin, "/api/mail-center/mail-host/requests")).json()) as Requests).requests;
    expect((await call(admin, `/api/mail-center/mail-host/requests/${req.id}/reject`, "POST", { reason: "" })).status).toBe(400);
    expect((await call(admin, `/api/mail-center/mail-host/requests/${req.id}/reject`, "POST", { reason: "Use your name" })).status).toBe(200);
    const mine = (await (await call(token, "/api/mail-center/claim")).json()) as { address: string | null; request: { status: string; reason: string } };
    expect(mine.address).toBeNull();
    expect(mine.request).toMatchObject({ status: "rejected", reason: "Use your name" });
    expect((await call(token, "/api/mail-center/claim", "POST", { localPart: "rina", departmentId: null })).status).toBe(201);
    // Deciding twice is refused.
    expect((await call(admin, `/api/mail-center/mail-host/requests/${req.id}/approve`, "POST", {})).status).toBe(404);
  });

  test("approval stops at the alias limit, and an address another person asked for is taken", async () => {
    await env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('mail_alias_limit', '1')`).run();
    await env.DB.prepare(`INSERT INTO email_addresses (id, address, active, created_at) VALUES (?, ?, 1, ?), (?, ?, 1, ?)`)
      .bind(crypto.randomUUID(), `hello@${domain}`, new Date().toISOString(), crypto.randomUUID(), `sales@${domain}`, new Date().toISOString())
      .run();
    const a = await session(await user("First Asker", readerRole, DEPT));
    const b = await session(await user("Second Asker", readerRole, DEPT));
    expect((await call(a, "/api/mail-center/claim", "POST", { localPart: "same", departmentId: null })).status).toBe(201);
    expect((await call(b, "/api/mail-center/claim", "POST", { localPart: "same", departmentId: null })).status).toBe(409);

    const admin = await session(await user("HC157 Limit", adminRole, null));
    const list = (await (await call(admin, "/api/mail-center/mail-host/requests")).json()) as Requests;
    // hello@ is the account itself; sales@ is the one alias in use.
    expect(list.usage).toEqual({ used: 1, limit: 1 });
    const res = await call(admin, `/api/mail-center/mail-host/requests/${list.requests[0].id}/approve`, "POST", {});
    expect(res.status).toBe(409);
    expect(await env.DB.prepare(`SELECT 1 FROM email_addresses WHERE address = ?`).bind(`same@${domain}`).first()).toBeNull();
  });

  test("only Mail Center admins see and decide requests", async () => {
    const token = await session(await user("Plain Reader", readerRole, DEPT));
    expect((await call(token, "/api/mail-center/mail-host/requests")).status).toBe(403);
    expect((await call(token, "/api/mail-center/mail-host/requests/x/approve", "POST", {})).status).toBe(403);
    expect((await call(token, "/api/mail-center/mail-host/requests/x/reject", "POST", { reason: "no" })).status).toBe(403);
  });

  test("needs mail_center.read", async () => {
    const token = await session(await user("No Mail", noMailRole, DEPT));
    expect((await call(token, "/api/mail-center/claim")).status).toBe(403);
    expect((await call(token, "/api/mail-center/claim", "POST", { localPart: "nomail", departmentId: null })).status).toBe(403);
  });

});

describe("an address turned off here still holds a Google alias until it is removed there", () => {
  test("listed, counted, and freed once marked removed; turned back on it waits to be added again", async () => {
    const admin = await session(await user("HC157 Remover", adminRole, null));
    const left = await user("Left Company", readerRole, DEPT);
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).bind(left).run();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO email_addresses (id, address, assigned_user_id, assigned_user_name, active, created_at, mail_host_status) VALUES (?, ?, ?, 'Left Company', 0, ?, 'live')`,
    )
      .bind(id, `left@${domain}`, left, new Date().toISOString())
      .run();
    // Never added in Google: nothing to remove.
    await env.DB.prepare(`INSERT INTO email_addresses (id, address, active, created_at, mail_host_status) VALUES (?, ?, 0, ?, 'pending')`)
      .bind(crypto.randomUUID(), `never@${domain}`, new Date().toISOString())
      .run();

    const list = (await (await call(admin, "/api/mail-center/mail-host/to-remove")).json()) as Array<{ id: string; address: string; personLeft: boolean }>;
    expect(list.map((r) => [r.address, r.personLeft])).toEqual([[`left@${domain}`, true]]);
    const usage = async () => ((await (await call(admin, "/api/mail-center/mail-host/requests")).json()) as Requests).usage.used;
    expect(await usage()).toBe(1);

    expect((await call(admin, `/api/mail-center/mail-host/${id}/removed`, "POST", {})).status).toBe(200);
    expect((await call(admin, `/api/mail-center/mail-host/${id}/removed`, "POST", {})).status).toBe(404);
    expect(await (await call(admin, "/api/mail-center/mail-host/to-remove")).json()).toEqual([]);
    expect(await usage()).toBe(0);

    await env.DB.prepare(`UPDATE email_addresses SET active = 1 WHERE id = ?`).bind(id).run();
    const pending = (await (await call(admin, "/api/mail-center/mail-host/pending")).json()) as Pending;
    expect(pending.map((p) => p.address)).toEqual([`left@${domain}`]);
  });

  test("only Mail Center admins", async () => {
    const token = await session(await user("Plain Reader 2", readerRole, DEPT));
    expect((await call(token, "/api/mail-center/mail-host/to-remove")).status).toBe(403);
    expect((await call(token, "/api/mail-center/mail-host/x/removed", "POST", {})).status).toBe(403);
  });
});
