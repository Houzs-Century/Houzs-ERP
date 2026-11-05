import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";

// DEV-03 / PRD T-011 P4 (A5): the Mail Center recipient picker lists people
// by Department / My team / My managers off the org chart's reporting line.

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;
let readerRole = 0;
let noMailRole = 0;
const made: number[] = [];
const sessions: string[] = [];
const ids: Record<string, number> = {};

async function user(
  key: string,
  opts: { roleId?: number; managerKey?: string; deptId?: number | null; status?: string } = {},
): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, manager_id, department_id, joined_at)
     VALUES (?, ?, 'unused', ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      `p4-${key}-${crypto.randomUUID().slice(0, 6)}@login.test`,
      `P4 ${key}`,
      opts.roleId ?? readerRole,
      opts.status ?? "active",
      opts.managerKey ? ids[opts.managerKey] : null,
      opts.deptId === undefined ? 60 : opts.deptId,
    )
    .run();
  const id = Number(r.meta.last_row_id);
  made.push(id);
  ids[key] = id;
  return id;
}

async function session(userId: number): Promise<string> {
  const token = `p4-${crypto.randomUUID()}`;
  sessions.push(token);
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return token;
}

type Entry = { key: string; userId: number | null; name: string; email: string; position: string; department: string };
type Directory = { me: Entry | null; department: Entry[]; team: Entry[]; managers: Entry[]; everyone: Entry[] };

async function directory(userId: number): Promise<{ status: number; body: Directory }> {
  const res = await app.request(
    "/api/mail-center/directory",
    { headers: { Authorization: `Bearer ${await session(userId)}` } },
    liveEnv,
  );
  return { status: res.status, body: (await res.json()) as Directory };
}

const names = (list: Entry[]) => list.map((e) => e.name);

beforeAll(async () => {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, department_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1, mail_host_status TEXT, mail_host_confirmed_at TEXT, mail_host_confirmed_by INTEGER)`,
    `CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT)`,
    `CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY, slug TEXT, name TEXT)`,
    `INSERT OR REPLACE INTO departments (id, name) VALUES (60, 'P4 Sales'), (61, 'P4 Warehouse')`,
  ]) {
    await env.DB.prepare(statement).run();
  }
  // The roster carries users.division (PG-only mig 0021) and the user_companies grants (mig 0085).
  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN division TEXT").run(); } catch { /* already there */ }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_companies (user_id INTEGER NOT NULL, company_id INTEGER NOT NULL)`).run();
  const role = async (perms: string[]) =>
    Number(
      (
        await env.DB.prepare(`INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'p4', ?, 0)`)
          .bind(`p4-${crypto.randomUUID()}`, JSON.stringify(perms))
          .run()
      ).meta.last_row_id,
    );
  readerRole = await role(["mail_center.read"]);
  noMailRole = await role(["dashboard.read"]);

  // boss
  //  └ mgr
  //     ├ me ── rep ── junior
  //     └ peer
  // other (Warehouse, reports to boss); gone (disabled, under me)
  await user("boss", { deptId: 61 });
  await user("mgr", { managerKey: "boss" });
  await user("me", { managerKey: "mgr" });
  await user("peer", { managerKey: "mgr" });
  await user("rep", { managerKey: "me" });
  await user("junior", { managerKey: "rep", deptId: 61 });
  await user("other", { managerKey: "boss", deptId: 61 });
  await user("gone", { managerKey: "me", status: "disabled" });
  await user("nomail", { roleId: noMailRole, deptId: null });

  const box = (address: string, assignedUser: number | null, dept: string | null, deptId: number | null, label: string | null) =>
    env.DB.prepare(
      `INSERT INTO email_addresses (id, address, label, assigned_user_id, assigned_dept, department_id, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
      .bind(crypto.randomUUID(), address, label, assignedUser, dept, deptId, new Date().toISOString())
      .run();
  await box("P4.Rep@houzscentury.com", ids.rep, null, null, null);
  await box("p4-sales@houzscentury.com", null, "Sales", 60, "Sales team");
  await box("p4-wh@houzscentury.com", null, "P4 Warehouse", 61, "Warehouse");
});

afterAll(async () => {
  for (const t of sessions) {
    await env.SESSION_CACHE.delete(`sess:${t}`);
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(t).run();
  }
  await env.DB.exec(`DELETE FROM email_addresses WHERE address LIKE 'p4%'`);
  for (const id of made.reverse()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  }
  await env.DB.prepare(`DELETE FROM departments WHERE id IN (60, 61)`).run();
  await env.DB.prepare(`DELETE FROM roles WHERE id IN (?, ?)`).bind(readerRole, noMailRole).run();
});

describe("A5: pick recipients from the org chart", () => {
  test("My team is everyone under me plus my peers; My managers is the chain up, nearest first", async () => {
    const { status, body } = await directory(ids.me);
    expect(status).toBe(200);
    expect(body.me?.userId).toBe(ids.me);
    expect(names(body.team)).toEqual(["P4 junior", "P4 peer", "P4 rep"]);
    expect(names(body.managers)).toEqual(["P4 mgr", "P4 boss"]);
  });

  test("Department is my department's people plus its shared mailboxes", async () => {
    const { body } = await directory(ids.me);
    expect(names(body.department)).toEqual(["P4 mgr", "P4 peer", "P4 rep", "Sales team"]);
    const shared = body.department.find((e) => e.key === "mailbox:p4-sales@houzscentury.com");
    expect(shared).toMatchObject({ userId: null, email: "p4-sales@houzscentury.com", position: "Shared mailbox" });
    expect(body.department.some((e) => e.email === "p4-wh@houzscentury.com")).toBe(false);
  });

  test("a person is reached on their own mailbox when they have one, else their login", async () => {
    const { body } = await directory(ids.me);
    const rep = body.everyone.find((e) => e.userId === ids.rep);
    const peer = body.everyone.find((e) => e.userId === ids.peer);
    expect(rep?.email).toBe("p4.rep@houzscentury.com");
    expect(peer?.email).toMatch(/^p4-peer-.*@login\.test$/);
  });

  test("never lists me or a disabled account", async () => {
    const { body } = await directory(ids.me);
    for (const list of [body.department, body.team, body.managers, body.everyone]) {
      expect(list.some((e) => e.userId === ids.me)).toBe(false);
      expect(list.some((e) => e.userId === ids.gone)).toBe(false);
    }
    expect(body.everyone.some((e) => e.userId === ids.other)).toBe(true);
  });

  test("the top of the chart has no managers and the whole company under them", async () => {
    const res = await app.request(
      "/api/mail-center/directory",
      { headers: { Authorization: `Bearer ${await session(ids.boss)}` } },
      liveEnv,
    );
    const body = (await res.json()) as Directory;
    expect(res.status).toBe(200);
    expect(body.managers).toEqual([]);
    expect(names(body.team)).toEqual(["P4 junior", "P4 me", "P4 mgr", "P4 other", "P4 peer", "P4 rep"]);
  });

  test("needs mail_center.read", async () => {
    const { status } = await directory(ids.nomail);
    expect(status).toBe(403);
  });
});
