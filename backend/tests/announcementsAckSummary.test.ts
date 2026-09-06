// Announcements redesign (design handoff 2026-09-04) — the backend half that
// the Manage drawer, the manage table, the dashboard's "My team's pending"
// card and the composer's new fields depend on:
//
//   · GET  /ack-summary        one { id → { total, acked } } map for the table
//   · GET  /:id/acks           gains byDepartment + each person's org fields
//                              and pending state (pending / reminded / overdue)
//   · GET  /team-pending       a supervisor's direct reports' unacked mandatory
//                              notices (users.manager_id = caller)
//   · POST /:id/escalate       one system notice per supervisor of the pending
//   · require_ack / scheduled_at (mig 20260905T1125): the category default on
//                              POST, and a scheduled notice held back from
//                              readers until its instant
//
// Harness mirrors announcementsListAccess.test.ts: a bare Hono app that stands
// in the user, the real router, and a minimal D1 mirror of the pg-only tables.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import announcementRoutes from "../src/routes/announcements";

const state = { user: undefined as unknown };
const app = new Hono();
app.use("*", async (c: never, next: never) => {
  (c as { set: (k: string, v: unknown) => void }).set("user", state.user);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/announcements", announcementRoutes);

const MANAGER = {
  id: 606,
  department_id: null,
  position_id: null,
  position_name: null,
  permissions: ["announcements.write"],
  permissions_set: new Set(["announcements.write"]),
};
// A rank-and-file reader in the Warehouse (dept 2) — no write verb.
const READER = {
  id: 11,
  department_id: 2,
  position_id: null,
  position_name: null,
  permissions: [] as string[],
  permissions_set: new Set<string>(),
};
// The Warehouse supervisor: users 11 + 12 report to them.
const SUPERVISOR = {
  id: 10,
  department_id: null,
  position_id: null,
  position_name: null,
  permissions: [] as string[],
  permissions_set: new Set<string>(),
};

async function call(user: unknown, path: string, init?: RequestInit) {
  state.user = user;
  const res = await app.request(path, init, env as never);
  return { status: res.status, body: (await res.json()) as any };
}

const DAY = 86_400_000;

describe("announcements — ack aggregation, team pending, escalation, require_ack + scheduled_at", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcements (
         id TEXT PRIMARY KEY, title TEXT, body TEXT, body_html TEXT, is_active INTEGER,
         expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
         updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
         target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
         target_user_ids TEXT, target_company_ids TEXT, category TEXT,
         source TEXT, company_id INTEGER, require_ack INTEGER, scheduled_at TEXT,
         target_divisions TEXT, excluded_user_ids TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_acks (
         announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, acked_at TEXT,
         company_id INTEGER, PRIMARY KEY (announcement_id, user_id))`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, role_id INTEGER, status TEXT,
         department_id INTEGER, position_id INTEGER, manager_id INTEGER, division TEXT)`,
    ).run();
    // The D1 test database is built from the D1 mirror migrations, which never
    // carried users.division (PG-only mig 0021); the roster query selects it.
    try { await env.DB.prepare("ALTER TABLE users ADD COLUMN division TEXT").run(); } catch { /* already there */ }
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY, slug TEXT, name TEXT)`,
    ).run();

    // Real D1 tables with real FKs: a role row for the users, and managers
    // inserted BEFORE the people who report to them.
    await env.DB.prepare(`INSERT OR IGNORE INTO roles (id, name, permissions) VALUES (1, 'Test', '[]')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO departments (id, name) VALUES (1, 'Sales'), (2, 'Warehouse')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO positions (id, slug, name) VALUES (7, 'storekeeper', 'Storekeeper'), (8, 'sales_executive', 'Sales Executive')`).run();
    const users: Array<[number, string, number | null, number | null, number | null]> = [
      [10, "Tan Boon Hooi", null, null, null],
      [11, "Siti Aminah", 2, 7, 10],
      [12, "Ravi Kumaran", 2, 7, 10],
      [14, "Wong Kah Seng", 1, null, null],
      [13, "Cheah Mei Ling", 1, 8, 14],
      [606, "Nico", null, null, null],
    ];
    for (const [id, name, dept, pos, mgr] of users) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO users (id, email, name, password_hash, role_id, status, department_id, position_id, manager_id)
         VALUES (?, ?, ?, 'x', 1, 'active', ?, ?, ?)`,
      )
        .bind(id, `${id}@example.my`, name, dept, pos, mgr)
        .run();
    }
    // A disabled account never counts in any roster.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO users (id, email, name, password_hash, role_id, status, department_id, position_id, manager_id)
       VALUES (99, '99@example.my', 'Gone', 'x', 1, 'disabled', 2, 7, 10)`,
    ).run();

    const ins = async (
      id: string,
      category: string,
      targetType: string,
      deptIds: string | null,
      createdAt: string,
      requireAck: number | null,
      extra: { scheduledAt?: string | null; remindedAt?: string | null; source?: string | null } = {},
    ) => {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO announcements
           (id, title, body, is_active, expires_at, reminded_at, created_by, created_at,
            target_type, target_dept_ids, category, source, require_ack, scheduled_at)
         VALUES (?, ?, 'b', 1, NULL, ?, 606, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          `Title ${id}`,
          extra.remindedAt ?? null,
          createdAt,
          targetType,
          deptIds,
          category,
          extra.source ?? null,
          requireAck,
          extra.scheduledAt ?? null,
        )
        .run();
    };
    const threeDaysAgo = new Date(Date.now() - 3 * DAY).toISOString();
    const now = new Date().toISOString();
    await ins("ann-warn", "WARNING", "ALL_USERS", null, threeDaysAgo, 1);
    await ins("ann-sop", "SOP", "DEPARTMENT_IDS", "[2]", now, 1);
    await ins("ann-notice", "GENERAL", "ALL_USERS", null, now, 0);
    await ins("ann-reminded", "WARNING", "DEPARTMENT_IDS", "[1]", threeDaysAgo, 1, { remindedAt: now });
    await ins("ann-later", "WARNING", "ALL_USERS", null, now, 1, {
      scheduledAt: new Date(Date.now() + DAY).toISOString(),
    });
    await ins("ann-sys", "GENERAL", "ALL_USERS", null, now, 0, { source: "scan" });
    // Siti has acknowledged the warning; nobody else has acked anything.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO announcement_acks (announcement_id, user_id, acked_at) VALUES ('ann-warn', 11, ?)`,
    )
      .bind(now)
      .run();
  });

  test("GET /ack-summary: one map for every human post, audience-sized, write-gated", async () => {
    const r = await call(MANAGER, "/api/announcements/ack-summary");
    expect(r.status).toBe(200);
    // 6 active users (the disabled one never counts); Siti acked.
    expect(r.body.data["ann-warn"]).toEqual({ total: 6, acked: 1 });
    // Warehouse-only SOP: Siti + Ravi.
    expect(r.body.data["ann-sop"]).toEqual({ total: 2, acked: 0 });
    expect(r.body.data["ann-later"]).toEqual({ total: 6, acked: 0 });
    // System notices are bell material, never in the manage table.
    expect(r.body.data["ann-sys"]).toBeUndefined();

    const denied = await call(READER, "/api/announcements/ack-summary");
    expect(denied.status).toBe(403);
  });

  test("GET /:id/acks: department buckets, org fields on each person, and the pending state", async () => {
    const warn = await call(MANAGER, "/api/announcements/ann-warn/acks");
    expect(warn.status).toBe(200);
    expect(warn.body.data.total).toBe(6);
    expect(warn.body.data.ackedCount).toBe(1);
    expect(warn.body.data.byDepartment).toEqual([
      { id: null, name: "No department", total: 2, acked: 0, pending: 2 },
      { id: 1, name: "Sales", total: 2, acked: 0, pending: 2 },
      { id: 2, name: "Warehouse", total: 2, acked: 1, pending: 1 },
    ]);
    const ravi = warn.body.data.pending.find((p: { id: number }) => p.id === 12);
    expect(ravi).toMatchObject({
      name: "Ravi Kumaran",
      departmentId: 2,
      departmentName: "Warehouse",
      positionName: "Storekeeper",
      managerId: 10,
      state: "overdue", // posted 3 days ago, window is 48h
    });
    expect(warn.body.data.acked[0]).toMatchObject({ id: 11, departmentName: "Warehouse" });
    expect(warn.body.data.overdueAfterHours).toBe(48);

    const sop = await call(MANAGER, "/api/announcements/ann-sop/acks");
    expect(sop.body.data.pending.map((p: { state: string }) => p.state)).toEqual(["pending", "pending"]);

    const reminded = await call(MANAGER, "/api/announcements/ann-reminded/acks");
    expect(reminded.body.data.pending.every((p: { state: string }) => p.state === "reminded")).toBe(true);
    expect(reminded.body.data.remindedAt).toBeTruthy();
  });

  test("GET /team-pending: the caller's direct reports' unacked MANDATORY notices only", async () => {
    const r = await call(SUPERVISOR, "/api/announcements/team-pending");
    expect(r.status).toBe(200);
    expect(r.body.data.reports).toBe(2);
    const rows = r.body.data.pending.map(
      (p: { userId: number; announcementId: string; state: string }) =>
        `${p.userId}:${p.announcementId}:${p.state}`,
    );
    rows.sort();
    // Siti acked the warning; the GENERAL notice (require_ack 0) and the
    // scheduled warning never appear; the Sales-only reminder is not theirs.
    expect(rows).toEqual([
      "11:ann-sop:pending",
      "12:ann-sop:pending",
      "12:ann-warn:overdue",
    ]);

    const nobody = await call(READER, "/api/announcements/team-pending");
    expect(nobody.body.data).toEqual({ reports: 0, pending: [] });

    const anon = await call(undefined, "/api/announcements/team-pending");
    expect(anon.status).toBe(401);
  });

  test("POST /:id/escalate: one system notice per supervisor of the pending people", async () => {
    const r = await call(MANAGER, "/api/announcements/ann-sop/escalate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, supervisors: 1, people: 2, unsupervised: 0 });
    const notice = await env.DB.prepare(
      `SELECT title, body, target_user_ids, source FROM announcements WHERE source = 'ack_escalation'`,
    ).first<{ title: string; body: string; target_user_ids: string; source: string }>();
    expect(notice?.target_user_ids).toBe("[10]");
    expect(notice?.title).toContain("2 of your team have not acknowledged");
    expect(notice?.body).toContain("Siti Aminah");
    expect(notice?.body).toContain("Ravi Kumaran");

    // Department-scoped: the warning's Sales pending (Cheah → manager 14).
    const sales = await call(MANAGER, "/api/announcements/ann-warn/escalate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ departmentId: 1 }),
    });
    // Cheah reports to Wong; Wong has no manager → unsupervised.
    expect(sales.body).toMatchObject({ supervisors: 1, people: 1, unsupervised: 1 });

    const denied = await call(READER, "/api/announcements/ann-sop/escalate", { method: "POST" });
    expect(denied.status).toBe(403);
  });

  test("require_ack defaults by category on POST, is patchable, and rides toPublic", async () => {
    const warn = await call(MANAGER, "/api/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Blocking by default", category: "WARNING" }),
    });
    expect(warn.status).toBe(201);
    expect(warn.body.data.requireAck).toBe(true);

    const notice = await call(MANAGER, "/api/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Not blocking", category: "GENERAL" }),
    });
    expect(notice.body.data.requireAck).toBe(false);

    const flagged = await call(MANAGER, "/api/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Flagged notice", category: "GENERAL", requireAck: true }),
    });
    expect(flagged.body.data.requireAck).toBe(true);

    const patched = await call(MANAGER, `/api/announcements/${flagged.body.data.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireAck: false }),
    });
    expect(patched.body.data.requireAck).toBe(false);
  });

  test("a scheduled notice is held back from readers and the banner until its instant; managers still list it", async () => {
    const later = new Date(Date.now() + DAY).toISOString();
    const created = await call(MANAGER, "/api/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Tomorrow", category: "WARNING", scheduledAt: later }),
    });
    expect(created.status).toBe(201);
    expect(created.body.data.scheduledAt).toBe(later);
    const id = created.body.data.id as string;

    const readerList = await call(READER, "/api/announcements");
    expect(readerList.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
    const banner = await call(READER, "/api/announcements/banner?scope=human");
    expect(banner.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
    const managerList = await call(MANAGER, "/api/announcements");
    expect(managerList.body.data.map((a: { id: string }) => a.id)).toContain(id);

    // Acking a not-yet-posted notice records nothing.
    const ack = await call(READER, `/api/announcements/${id}/ack`, { method: "POST" });
    expect(ack.body).toEqual({ success: true, acked: false });

    // A past instant posts at once (stored NULL).
    const past = await call(MANAGER, "/api/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Already", category: "GENERAL", scheduledAt: new Date(Date.now() - DAY).toISOString() }),
    });
    expect(past.body.data.scheduledAt).toBeNull();
  });

  test("the list and banner carry the author's name and the department names", async () => {
    const r = await call(READER, "/api/announcements");
    const sop = r.body.data.find((a: { id: string }) => a.id === "ann-sop");
    expect(sop).toMatchObject({ createdByName: "Nico", targetDeptNames: ["Warehouse"] });
    const banner = await call(READER, "/api/announcements/banner?scope=human");
    const warn = banner.body.data.find((a: { id: string }) => a.id === "ann-warn");
    expect(warn.createdByName).toBe("Nico");
  });
});
