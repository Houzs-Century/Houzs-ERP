import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import authRoutes from "../src/routes/auth";
import {
  AUTHZ_ENVELOPE_VERSION,
  deleteSession,
  getUserBySession,
  type AuthUser,
} from "../src/services/auth";
import type { Env } from "../src/types";

let roleId = 0;
let userId = 0;
let managerUserId = 0;
let positionId = 0;
let departmentId = 0;
let token = "";

const sessionKey = () => `sess:${token}`;

async function seedSession(): Promise<void> {
  token = `session-revocation-${crypto.randomUUID()}`;
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'session revocation test', ?, 0)`,
  )
    .bind(`session-role-${crypto.randomUUID()}`, JSON.stringify(["*"]))
    .run();
  roleId = Number(role.meta.last_row_id);

  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'Session Test', 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`session-${crypto.randomUUID()}@test.local`, roleId)
    .run();
  userId = Number(user.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
}

async function warmHydratedCache(testEnv: Env = env as unknown as Env): Promise<AuthUser> {
  const user = await getUserBySession(testEnv, token);
  expect(user?.id).toBe(userId);
  expect(await env.SESSION_CACHE.get(sessionKey())).not.toBeNull();
  return user!;
}

beforeEach(async () => {
  await seedSession();
});

afterEach(async () => {
  await env.SESSION_CACHE.delete(sessionKey());
  if (userId || managerUserId) {
    await env.DB.prepare(`DELETE FROM user_brands WHERE user_id IN (?, ?)`)
      .bind(userId || -1, managerUserId || -1)
      .run();
  }
  if (roleId) {
    await env.DB.prepare(`DELETE FROM role_page_access WHERE role_id = ?`)
      .bind(roleId)
      .run();
  }
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  }
  if (userId) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
  }
  if (managerUserId) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(managerUserId).run();
  }
  if (positionId) {
    await env.DB.prepare(`DELETE FROM positions WHERE id = ?`).bind(positionId).run();
  }
  if (departmentId) {
    await env.DB.prepare(`DELETE FROM departments WHERE id = ?`).bind(departmentId).run();
  }
  if (roleId) {
    await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
  }
  roleId = 0;
  userId = 0;
  managerUserId = 0;
  positionId = 0;
  departmentId = 0;
  token = "";
});

describe("authoritative session revocation with a warm hydration cache", () => {
  test("a disabled user is rejected even while the cached AuthUser says active", async () => {
    await warmHydratedCache();
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`)
      .bind(userId)
      .run();

    expect(await getUserBySession(env as unknown as Env, token)).toBeNull();
  });

  test("a completed user deletion cannot be bypassed by the stale cache entry", async () => {
    await warmHydratedCache();
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();

    expect(await getUserBySession(env as unknown as Env, token)).toBeNull();
    userId = 0;
  });

  test("logout invalidates the next request after the cache was warmed", async () => {
    await warmHydratedCache();
    const response = await authRoutes.request(
      "/logout",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      env as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(await getUserBySession(env as unknown as Env, token)).toBeNull();
  });

  test("expiry is authoritative and removes the expired session", async () => {
    await warmHydratedCache();
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`)
      .bind(new Date(Date.now() - 60_000).toISOString(), token)
      .run();

    expect(await getUserBySession(env as unknown as Env, token)).toBeNull();
    const row = await env.DB.prepare(`SELECT token FROM sessions WHERE token = ?`)
      .bind(token)
      .first();
    expect(row).toBeNull();
  });

  test("a KV delete failure cannot keep a deleted session authenticated", async () => {
    await warmHydratedCache();
    const failingKv = {
      get: env.SESSION_CACHE.get.bind(env.SESSION_CACHE),
      put: env.SESSION_CACHE.put.bind(env.SESSION_CACHE),
      delete: async () => {
        throw new Error("injected KV delete failure");
      },
    } as unknown as KVNamespace;
    const failingEnv = {
      DB: env.DB,
      SESSION_CACHE: failingKv,
    } as unknown as Env;

    await deleteSession(failingEnv, token);
    expect(await env.SESSION_CACHE.get(sessionKey())).not.toBeNull();
    expect(await getUserBySession(failingEnv, token)).toBeNull();
  });

  test("role permissions and scope changes replace the cached envelope next request", async () => {
    const before = await warmHydratedCache();
    expect(before.permissions_set.has("*")).toBe(true);
    expect(before.scope_to_pic).toBe(false);

    await env.DB.prepare(
      `UPDATE roles SET permissions = ?, scope_to_pic = 1 WHERE id = ?`,
    )
      .bind(JSON.stringify([]), roleId)
      .run();

    const after = await getUserBySession(env as unknown as Env, token);
    expect(after?.permissions).toEqual([]);
    expect(after?.permissions_set.has("*")).toBe(false);
    expect(after?.scope_to_pic).toBe(true);
  });

  test("role page-access revocation replaces the cached matrix next request", async () => {
    await env.DB.prepare(`UPDATE roles SET permissions = ? WHERE id = ?`)
      .bind(JSON.stringify([]), roleId)
      .run();
    await env.DB.prepare(
      `INSERT INTO role_page_access (role_id, page_key, level) VALUES (?, 'projects', 'full')`,
    )
      .bind(roleId)
      .run();

    const before = await warmHydratedCache();
    expect(before.page_access.projects).toBe("full");

    await env.DB.prepare(
      `UPDATE role_page_access SET level = 'none' WHERE role_id = ? AND page_key = 'projects'`,
    )
      .bind(roleId)
      .run();

    const after = await getUserBySession(env as unknown as Env, token);
    expect(after?.page_access.projects).toBe("none");
  });

  test("position and department renames replace cached organization authority next request", async () => {
    const department = await env.DB.prepare(
      `INSERT INTO departments (name) VALUES (?)`,
    )
      .bind(`Warehouse-${crypto.randomUUID()}`)
      .run();
    departmentId = Number(department.meta.last_row_id);
    const position = await env.DB.prepare(
      `INSERT INTO positions (department_id, slug, name) VALUES (?, ?, 'Storekeeper')`,
    )
      .bind(departmentId, `storekeeper-${crypto.randomUUID()}`)
      .run();
    positionId = Number(position.meta.last_row_id);
    await env.DB.prepare(
      `UPDATE users SET position_id = ?, department_id = ? WHERE id = ?`,
    )
      .bind(positionId, departmentId, userId)
      .run();

    const before = await warmHydratedCache();
    expect(before.position_name).toBe("Storekeeper");

    const renamedDepartment = `Operations-${crypto.randomUUID()}`;
    await env.DB.prepare(`UPDATE positions SET name = 'Operations Manager' WHERE id = ?`)
      .bind(positionId)
      .run();
    await env.DB.prepare(`UPDATE departments SET name = ? WHERE id = ?`)
      .bind(renamedDepartment, departmentId)
      .run();

    const after = await getUserBySession(env as unknown as Env, token);
    expect(after?.position_name).toBe("Operations Manager");
    expect(after?.department_name).toBe(renamedDepartment);
  });

  // NOTE: the "user and manager brand changes replace cached project scope"
  // test was removed 2026-08-19 with the PIC/brand project ACL. brand_scope is
  // no longer hydrated from user_brands (auth.ts now sets it to null), so there
  // is nothing to re-resolve here. The session-cache invalidation mechanism it
  // exercised is still covered by the position/department and mail-identity
  // tests around it.

  test("email, name, and email alias changes replace the cached mail identity next request", async () => {
    const oldAlias = `old-${crypto.randomUUID()}@test.local`;
    await env.DB.prepare(`UPDATE users SET email_alias = ? WHERE id = ?`)
      .bind(oldAlias, userId)
      .run();
    const before = await warmHydratedCache();
    expect(before.email_alias).toBe(oldAlias);

    const newEmail = `renamed-${crypto.randomUUID()}@test.local`;
    const newAlias = `new-${crypto.randomUUID()}@test.local`;
    await env.DB.prepare(
      `UPDATE users SET email = ?, email_alias = ?, name = 'Renamed Session User' WHERE id = ?`,
    )
      .bind(newEmail, newAlias, userId)
      .run();

    const changed = await getUserBySession(env as unknown as Env, token);
    expect(changed?.email).toBe(newEmail);
    expect(changed?.email_alias).toBe(newAlias);
    expect(changed?.name).toBe("Renamed Session User");

    await env.DB.prepare(`UPDATE users SET email_alias = NULL WHERE id = ?`)
      .bind(userId)
      .run();
    const removed = await getUserBySession(env as unknown as Env, token);
    expect(removed?.email_alias).toBeNull();
  });

  test("an old authorization-envelope policy revision is rebuilt next request", async () => {
    const before = await warmHydratedCache();
    expect(before.authz_fingerprint).toBeTruthy();
    const cachedRaw = await env.SESSION_CACHE.get(sessionKey());
    expect(cachedRaw).not.toBeNull();
    const cached = JSON.parse(cachedRaw!) as AuthUser;
    const staleFingerprint = JSON.parse(cached.authz_fingerprint!) as {
      version: number;
    };
    staleFingerprint.version = AUTHZ_ENVELOPE_VERSION - 1;
    cached.authz_fingerprint = JSON.stringify(staleFingerprint);
    cached.name = "Stale Policy Cache";
    await env.SESSION_CACHE.put(sessionKey(), JSON.stringify(cached), {
      expirationTtl: 60,
    });

    const rebuilt = await getUserBySession(env as unknown as Env, token);
    expect(rebuilt?.name).toBe("Session Test");
    expect(JSON.parse(rebuilt!.authz_fingerprint!).version).toBe(
      AUTHZ_ENVELOPE_VERSION,
    );
  });
});
