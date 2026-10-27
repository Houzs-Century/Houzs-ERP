import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";

// HC-0157 B: a department mailbox is tied to an Org Chart department by id, and
// a member of that department reaches it without a per-person grant. The old
// rule compared the mailbox's "Sales" with the person's "Sales Department" and
// never matched.

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;
const DEPT_A = 157001;
const DEPT_B = 157002;
let readerRole = 0;
let adminRole = 0;
const made: number[] = [];
const sessions: string[] = [];

async function user(name: string, roleId: number, departmentId: number | null): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, department_id, joined_at) VALUES (?, ?, 'unused', ?, 'active', ?, datetime('now'))`,
  )
    .bind(`hc157-${crypto.randomUUID().slice(0, 8)}@test.local`, name, roleId, departmentId)
    .run();
  const id = Number(r.meta.last_row_id);
  made.push(id);
  return id;
}

async function session(userId: number): Promise<string> {
  const token = `hc157-${crypto.randomUUID()}`;
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

async function mailbox(address: string, ownerId: number | null, departmentId: number | null, active = 1) {
  await env.DB.prepare(
    `INSERT INTO email_addresses (id, address, label, assigned_user_id, assigned_dept, department_id, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), address, address, ownerId, departmentId == null ? null : "Sales", departmentId, active, new Date().toISOString())
    .run();
}

async function visible(token: string): Promise<{ level: string; mailboxes: Array<{ address: string; reach: string }> }> {
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
    `INSERT OR REPLACE INTO departments (id, name) VALUES (${DEPT_A}, 'Qzxsales Department'), (${DEPT_B}, 'Qzxfinance Department')`,
  ]) {
    await env.DB.prepare(statement).run();
  }
  const role = async (perms: string[]) =>
    Number(
      (
        await env.DB.prepare(`INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'hc157', ?, 0)`)
          .bind(`hc157-${crypto.randomUUID()}`, JSON.stringify(perms))
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
  await env.DB.exec(`DELETE FROM email_address_access`);
  await env.DB.exec(`DELETE FROM email_addresses`);
  await env.DB.exec(`DELETE FROM mail_user_scope`);
  for (const id of made.reverse()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  }
  await env.DB.prepare(`DELETE FROM departments WHERE id IN (?, ?)`).bind(DEPT_A, DEPT_B).run();
  await env.DB.prepare(`DELETE FROM roles WHERE id IN (?, ?)`).bind(readerRole, adminRole).run();
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_address_access`);
  await env.DB.exec(`DELETE FROM email_addresses`);
  await env.DB.exec(`DELETE FROM mail_user_scope`);
});

describe("a department mailbox follows the Org Chart", () => {
  test("a member reaches their own department's mailbox, not another department's, and never a colleague's personal mail", async () => {
    const me = await user("HC157 Me", readerRole, DEPT_A);
    const colleague = await user("HC157 Colleague", readerRole, DEPT_A);
    await mailbox("qzx-sales@houzscentury.com", null, DEPT_A);
    await mailbox("qzx-finance@houzscentury.com", null, DEPT_B);
    await mailbox("qzx-closed@houzscentury.com", null, DEPT_A, 0);
    // An owned row carrying a department (old data) must still stay personal.
    await mailbox("qzx-colleague@houzscentury.com", colleague, DEPT_A);

    const vis = await visible(await session(me));
    expect(vis.level).toBe("department");
    expect(vis.mailboxes.map((m) => [m.address, m.reach])).toEqual([["qzx-sales@houzscentury.com", "department"]]);
  });

  test("someone set to Personal, or with no department, reaches only their own and granted mailboxes", async () => {
    const restricted = await user("HC157 Restricted", readerRole, DEPT_A);
    const loose = await user("HC157 No Dept", readerRole, null);
    await env.DB.prepare(`INSERT INTO mail_user_scope (user_id, level, created_at) VALUES (?, 'personal', ?)`)
      .bind(restricted, new Date().toISOString())
      .run();
    await mailbox("qzx-sales@houzscentury.com", null, DEPT_A);

    expect((await visible(await session(restricted))).mailboxes).toEqual([]);
    const noDept = await visible(await session(loose));
    expect(noDept.level).toBe("personal");
    expect(noDept.mailboxes).toEqual([]);
  });
});

describe("an admin links a mailbox to a department", () => {
  test("by id, by a short name, and an owner clears the department", async () => {
    const admin = await session(await user("HC157 Admin", adminRole, null));

    const byId = await call(admin, "/api/mail-center/addresses", "POST", {
      address: "qzx-a@houzscentury.com",
      departmentId: DEPT_B,
    });
    expect(byId.status).toBe(201);
    const a = (await byId.json()) as { id: string; departmentId: number | null; assignedDept: string };
    expect([a.departmentId, a.assignedDept]).toEqual([DEPT_B, "Qzxfinance Department"]);

    const byName = (await (
      await call(admin, "/api/mail-center/addresses", "POST", { address: "qzx-b@houzscentury.com", assignedDept: "Qzxsales" })
    ).json()) as { id: string; departmentId: number | null; assignedDept: string };
    expect([byName.departmentId, byName.assignedDept]).toEqual([DEPT_A, "Qzxsales"]);

    const ambiguous = (await (
      await call(admin, "/api/mail-center/addresses", "POST", { address: "qzx-c@houzscentury.com", assignedDept: "Qzx" })
    ).json()) as { departmentId: number | null };
    expect(ambiguous.departmentId).toBeNull();

    const owner = await user("HC157 Owner", readerRole, DEPT_A);
    const owned = (await (
      await call(admin, `/api/mail-center/addresses/${a.id}`, "PATCH", { assignedUserId: owner, assignedUserName: "HC157 Owner" })
    ).json()) as { departmentId: number | null };
    expect(owned.departmentId).toBeNull();

    expect((await call(admin, `/api/mail-center/addresses/${byName.id}`, "PATCH", { departmentId: 999999 })).status).toBe(400);
  });
});
