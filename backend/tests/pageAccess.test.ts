import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";

// ── Test helpers (mirrors projects.test.ts shape) ─────────────────

async function seedUser(opts: {
  email: string;
  permissions: string[];
  scopeToPic?: boolean;
}): Promise<{ userId: number; roleId: number; bearer: string }> {
  const roleRes = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(
      `role_${opts.email}`,
      "test role",
      JSON.stringify(opts.permissions),
      opts.scopeToPic ? 1 : 0,
    )
    .run();
  const roleId = roleRes.meta.last_row_id as number;

  const userRes = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, ?, ?, 'active', datetime('now'))`,
  )
    .bind(opts.email, opts.email.split("@")[0], roleId)
    .run();
  const userId = userRes.meta.last_row_id as number;

  const token = `pa-${userId}-${Math.random().toString(36).slice(2)}`;
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userId, expires)
    .run();

  return { userId, roleId, bearer: `Bearer ${token}` };
}

async function api(
  method: string,
  path: string,
  bearer: string,
): Promise<{ status: number; json: any }> {
  const res = await SELF.fetch(`https://test.local${path}`, {
    method,
    headers: { Authorization: bearer },
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM sales_entries`);
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
});

// ── The smoke tests ───────────────────────────────────────────────

describe("requirePageAccess middleware — Sales pilot", () => {
  test("wildcard role short-circuits to full", async () => {
    const admin = await seedUser({
      email: "admin@test.local",
      permissions: ["*"],
    });
    const res = await api("GET", "/api/sales/entries", admin.bearer);
    expect(res.status).toBe(200);
  });

  test("sales partial-level (backfill from sales.read/write) is granted", async () => {
    // No explicit role_page_access row — falls back to backfill rule.
    // sales.write → 'partial' on the sales page.
    const rep = await seedUser({
      email: "rep@test.local",
      permissions: ["sales.read", "sales.write"],
      scopeToPic: true,
    });
    const res = await api("GET", "/api/sales/entries", rep.bearer);
    expect(res.status).toBe(200);
  });

  test("user with no sales perms is blocked", async () => {
    const outsider = await seedUser({
      email: "outsider@test.local",
      permissions: ["logs.read"], // unrelated page
    });
    const res = await api("GET", "/api/sales/entries", outsider.bearer);
    expect(res.status).toBe(403);
    // Plain-language 403 body (fix/zero-jargon-mopup): no longer leaks the
    // internal pageKey/level ("Forbidden: needs full access to sales").
    expect(String(res.json?.error ?? "")).toMatch(/permission to view this page/i);
  });

  test("manage-only endpoint requires full level — partial is rejected", async () => {
    // /entries/:id/push gates on requirePageAccess("sales", "full").
    // A partial user (sales.write but not sales.manage) is rejected.
    const rep = await seedUser({
      email: "partial@test.local",
      permissions: ["sales.read", "sales.write"],
    });
    const res = await api("POST", "/api/sales/entries/9999/push", rep.bearer);
    // 403 (not 404) — the gate fires before any row lookup.
    expect(res.status).toBe(403);
    // Plain-language 403 body (fix/zero-jargon-mopup): the manage-only gate
    // returns the same jargon-free message rather than naming the level.
    expect(String(res.json?.error ?? "")).toMatch(/permission to view this page/i);
  });
});
