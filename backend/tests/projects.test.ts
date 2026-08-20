import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";

// ── Test helpers ─────────────────────────────────────────────────

/**
 * Each test seeds its own admin so the FK to users(id) holds for
 * `created_by`. Using the dashboard-key escape hatch would give a
 * fake user with id=0 that has no row in `users`.
 */
let adminBearer: string;

/**
 * Insert a role + user + active session, return the bearer token a
 * test can use to authenticate as that user. Permissions are stored
 * as a JSON-encoded array; scope_to_pic forces the rep-style
 * subtree-only scope used by the audit's ACL boundary case.
 */
async function seedUser(opts: {
  email: string;
  permissions: string[];
  scopeToPic?: boolean;
  manager_id?: number | null;
}): Promise<{ userId: number; bearer: string }> {
  // Role row. Unique name keeps multiple seeds in one test isolated.
  const roleRes = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, ?, ?, ?)`
  )
    .bind(
      `bd role_${opts.email}`,
      "test role",
      JSON.stringify(opts.permissions),
      opts.scopeToPic ? 1 : 0,
    )
    .run();
  const roleId = roleRes.meta.last_row_id as number;

  const userRes = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, manager_id, joined_at)
     VALUES (?, ?, ?, 'active', ?, datetime('now'))`
  )
    .bind(opts.email, opts.email.split("@")[0], roleId, opts.manager_id ?? null)
    .run();
  const userId = userRes.meta.last_row_id as number;

  const token = `test-token-${userId}-${Math.random().toString(36).slice(2)}`;
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(token, userId, expires)
    .run();

  return { userId, bearer: `Bearer ${token}` };
}

async function api(
  method: string,
  path: string,
  bearer: string,
  body?: any,
): Promise<{ status: number; json: any }> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: bearer,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await SELF.fetch(`https://test.local${path}`, init);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ── Setup: clean state between tests ─────────────────────────────

beforeEach(async () => {
  // Wipe rows that any test might create. Order respects FKs.
  await env.DB.exec(`DELETE FROM project_activity`);
  await env.DB.exec(`DELETE FROM project_finance`);
  await env.DB.exec(`DELETE FROM sales_entries`);
  await env.DB.exec(`DELETE FROM projects`);
  await env.DB.exec(`DELETE FROM sessions`);
  // user_brands + users get wiped to keep seedUser() idempotent.
  await env.DB.exec(`DELETE FROM user_brands`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);

  // Seed a fresh admin per test so the created_by FK holds.
  const admin = await seedUser({
    email: "admin@test.local",
    permissions: ["*"],
    scopeToPic: false,
  });
  adminBearer = admin.bearer;
});

// ── The five smoke tests ─────────────────────────────────────────

describe("Projects module — smoke pack", () => {
  test("POST /api/projects creates row + finance + activity", async () => {
    const res = await api("POST", "/api/projects", adminBearer, {
      name: "Test project",
      brand: "AKEMI",
      state: "SELANGOR",
      venue: "TEST VENUE",
      organizer: "TEST ORG",
    });
    expect(res.status).toBe(201);
    expect(res.json.id).toBeGreaterThan(0);
    expect(typeof res.json.code).toBe("string");

    const row = await env.DB.prepare(
      `SELECT id, name, brand, archived_at FROM projects WHERE id = ?`,
    )
      .bind(res.json.id)
      .first<{ id: number; name: string; brand: string; archived_at: string | null }>();
    expect(row).toBeTruthy();
    expect(row!.brand).toBe("AKEMI");
    expect(row!.archived_at).toBeNull();

    const finance = await env.DB.prepare(
      `SELECT project_id FROM project_finance WHERE project_id = ?`,
    )
      .bind(res.json.id)
      .first();
    expect(finance).toBeTruthy();

    const activity = await env.DB.prepare(
      `SELECT action FROM project_activity WHERE project_id = ?`,
    )
      .bind(res.json.id)
      .all<{ action: string }>();
    const actions = (activity.results ?? []).map((r) => r.action);
    expect(actions).toContain("created");
  });

  test("POST /api/projects/:id/archive soft-deletes and list filter respects archived_at", async () => {
    const created = await api("POST", "/api/projects", adminBearer, {
      name: "Archivable",
      brand: "AKEMI",
      state: "SELANGOR",
      venue: "TEST VENUE",
    });
    expect(created.status).toBe(201);
    const id = created.json.id;

    const archived = await api("POST", `/api/projects/${id}/archive`, adminBearer);
    expect(archived.status).toBeLessThan(400);

    const row = await env.DB.prepare(
      `SELECT archived_at FROM projects WHERE id = ?`,
    )
      .bind(id)
      .first<{ archived_at: string | null }>();
    expect(row!.archived_at).not.toBeNull();

    // Default list excludes archived.
    const defaultList = await api("GET", "/api/projects?per_page=200", adminBearer);
    expect(defaultList.status).toBe(200);
    const ids = (defaultList.json?.data ?? []).map((p: any) => p.id);
    expect(ids).not.toContain(id);

    // Opt-in surfaces it.
    const withArchived = await api(
      "GET",
      "/api/projects?per_page=200&include_archived=1",
      adminBearer,
    );
    expect(withArchived.status).toBe(200);
    const allIds = (withArchived.json?.data ?? []).map((p: any) => p.id);
    expect(allIds).toContain(id);
  });

  test("PIC assignment no longer requires the picked user's brand allow-list (ACL removed 2026-08-19)", async () => {
    const rep = await seedUser({
      email: "rep_a@test.local",
      permissions: ["projects.read", "projects.write"],
      scopeToPic: true,
    });

    // The rep has NO user_brands row for AKEMI. Before the PIC/brand ACL was
    // removed this returned 403; now the assignment succeeds — brand no longer
    // gates who can be a project's PIC.
    const ok = await api("POST", "/api/projects", adminBearer, {
      name: "Brand-gated no more",
      brand: "AKEMI",
      state: "SELANGOR",
      venue: "TEST VENUE",
      pic_id: rep.userId,
    });
    expect(ok.status).toBe(201);
    const row = await env.DB.prepare(`SELECT pic_id FROM projects WHERE id = ?`)
      .bind(ok.json.id)
      .first<{ pic_id: number }>();
    expect(row!.pic_id).toBe(rep.userId);
  });

  test("a projects.write holder can now PATCH any project in their company (row ACL removed 2026-08-19)", async () => {
    const repA = await seedUser({
      email: "rep_a@test.local",
      permissions: ["projects.read", "projects.write"],
      scopeToPic: true,
    });
    const repB = await seedUser({
      email: "rep_b@test.local",
      permissions: ["projects.read", "projects.write"],
      scopeToPic: true,
    });

    const created = await api("POST", "/api/projects", adminBearer, {
      name: "rep B's project",
      brand: "AKEMI",
      state: "SELANGOR",
      venue: "TEST VENUE",
      pic_id: repB.userId,
    });
    expect(created.status).toBe(201);
    const projectId = created.json.id;

    // rep A is NOT the PIC and has no brand rows, yet — with the row-level ACL
    // gone — a projects.write holder may edit any project in the same company.
    const ok = await api(
      "PATCH",
      `/api/projects/${projectId}`,
      repA.bearer,
      { name: "edited by a non-PIC rep" },
    );
    expect(ok.status).toBeLessThan(400);
    const row = await env.DB.prepare(`SELECT name FROM projects WHERE id = ?`)
      .bind(projectId)
      .first<{ name: string }>();
    expect(row!.name).toBe("edited by a non-PIC rep");
  });

  test("Finance rollup — sales entry bumps project_finance.total_sales", async () => {
    const created = await api("POST", "/api/projects", adminBearer, {
      name: "Rollup target",
      brand: "AKEMI",
      state: "SELANGOR",
      venue: "TEST VENUE",
    });
    expect(created.status).toBe(201);
    const projectId = created.json.id;

    const entry = await api("POST", "/api/sales/entries", adminBearer, {
      project_id: projectId,
      customer_name: "Test Customer",
      amount: 1500,
      occurred_at: new Date().toISOString().slice(0, 10),
    });
    expect(entry.status).toBe(201);

    const finance = await env.DB.prepare(
      `SELECT total_sales FROM project_finance WHERE project_id = ?`,
    )
      .bind(projectId)
      .first<{ total_sales: number | null }>();
    expect(finance?.total_sales ?? 0).toBe(1500);
  });
});
