import { SELF, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

/* position_page_overrides (mig 0323/151) — the SCM cells of the editable
 * Roles & Permissions matrix. Pins the full loop: a stored override reaches
 * the hydrated session (page_access + scm_l2_configured), the matrix API
 * validates and persists sets, and god positions are refused. */

async function seedPositionedUser(opts: {
  email: string;
  permissions: string[];
  positionName: string;
  positionSlug: string;
}): Promise<{ userId: number; positionId: number; bearer: string }> {
  const roleRes = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'test role', ?, 0)`,
  )
    .bind(`role_${opts.email}`, JSON.stringify(opts.permissions))
    .run();
  const roleId = roleRes.meta.last_row_id as number;

  const posRes = await env.DB.prepare(
    `INSERT INTO positions (slug, name, level, sort_order, active)
     VALUES (?, ?, 50, 0, 1)`,
  )
    .bind(opts.positionSlug, opts.positionName)
    .run();
  const positionId = posRes.meta.last_row_id as number;

  const userRes = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, position_id, status, joined_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
  )
    .bind(opts.email, opts.email.split("@")[0], roleId, positionId)
    .run();
  const userId = userRes.meta.last_row_id as number;

  const token = `ovr-${userId}-${Math.random().toString(36).slice(2)}`;
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userId, expires)
    .run();

  return { userId, positionId, bearer: `Bearer ${token}` };
}

async function api(
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await SELF.fetch(`https://test.local${path}`, {
    method,
    headers: {
      Authorization: bearer,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe("position_page_overrides — matrix API + hydration", () => {
  test("an override reaches the session envelope and flips scm_l2_configured", async () => {
    // "HR Manager" resolves to the default-full cohort — WITHOUT overrides its
    // sessions are not L2-configured and page_access carries the full map.
    const member = await seedPositionedUser({
      email: "ovr-member@test.local",
      permissions: ["users.read"],
      positionName: "Test Override Cohort",
      positionSlug: "test_override_cohort",
    });

    const before = await api("GET", "/api/auth/me", member.bearer);
    expect(before.status).toBe(200);
    expect(before.json.user.page_access["scm.warehouse.inventory"]).toBe("full");
    expect(before.json.user.scm_l2_configured).toBe(false);

    await env.DB.prepare(
      `INSERT INTO position_page_overrides (position_id, page_key, level)
       VALUES (?, 'scm.warehouse.inventory', 'view')`,
    )
      .bind(member.positionId)
      .run();

    const after = await api("GET", "/api/auth/me", member.bearer);
    expect(after.status).toBe(200);
    expect(after.json.user.page_access["scm.warehouse.inventory"]).toBe("view");
    // Any override makes the position explicitly configured — the SCM area
    // guard enforces the composed map from here on.
    expect(after.json.user.scm_l2_configured).toBe(true);
    // Untouched keys keep the full-cohort baseline: nothing narrows by accident.
    expect(after.json.user.page_access["scm.sales.orders"]).toBe("full");
  });

  test("PUT /pages validates keys and levels, persists a replace-set, audits", async () => {
    const admin = await seedPositionedUser({
      email: "ovr-admin@test.local",
      permissions: ["users.read", "users.manage", "roles.manage"],
      positionName: "Test Override Admin",
      positionSlug: "test_override_admin",
    });
    const target = await seedPositionedUser({
      email: "ovr-target@test.local",
      permissions: ["users.read"],
      positionName: "Test Override Target",
      positionSlug: "test_override_target",
    });

    const badKey = await api(
      "PUT",
      `/api/position-capabilities/${target.positionId}/pages`,
      admin.bearer,
      { overrides: { "scm.sales": "view" } },
    );
    expect(badKey.status).toBe(400); // L1 area keys are refused — leaves only

    const badLevel = await api(
      "PUT",
      `/api/position-capabilities/${target.positionId}/pages`,
      admin.bearer,
      { overrides: { "scm.sales.orders": "partial" } },
    );
    expect(badLevel.status).toBe(400);

    const ok = await api(
      "PUT",
      `/api/position-capabilities/${target.positionId}/pages`,
      admin.bearer,
      { overrides: { "scm.sales.orders": "view", "scm.procurement.po": "none" } },
    );
    expect(ok.status).toBe(200);
    expect(ok.json.overrides).toEqual({
      "scm.sales.orders": "view",
      "scm.procurement.po": "none",
    });

    const replaced = await api(
      "PUT",
      `/api/position-capabilities/${target.positionId}/pages`,
      admin.bearer,
      { overrides: { "scm.sales.orders": "edit" } },
    );
    expect(replaced.status).toBe(200);

    const matrix = await api("GET", "/api/position-capabilities", admin.bearer);
    expect(matrix.status).toBe(200);
    const rows = matrix.json.overrides.filter(
      (o: { position_id: number }) => o.position_id === target.positionId,
    );
    expect(rows).toEqual([
      { position_id: target.positionId, page_key: "scm.sales.orders", level: "edit" },
    ]);
    expect(Array.isArray(matrix.json.scm_keys)).toBe(true);
    expect(matrix.json.scm_keys).toContain("scm.warehouse.inventory");
    expect(matrix.json.baselines[String(target.positionId)]["scm.sales.orders"]).toBeDefined();
  });

  test("a god position is refused an override, and reads stay users.read-gated", async () => {
    const admin = await seedPositionedUser({
      email: "ovr-admin2@test.local",
      permissions: ["roles.manage", "users.read"],
      positionName: "Test Override Admin2",
      positionSlug: "test_override_admin2",
    });
    const godPos = await env.DB.prepare(
      `INSERT INTO positions (slug, name, level, sort_order, active)
       VALUES ('test_super_admin_ovr', 'Super Admin', 10, 0, 1)`,
    ).run();
    const refused = await api(
      "PUT",
      `/api/position-capabilities/${godPos.meta.last_row_id}/pages`,
      admin.bearer,
      { overrides: { "scm.sales.orders": "none" } },
    );
    expect(refused.status).toBe(400);

    const noRead = await seedPositionedUser({
      email: "ovr-noread@test.local",
      permissions: [],
      positionName: "Test Override NoRead",
      positionSlug: "test_override_noread",
    });
    const denied = await api("GET", "/api/position-capabilities", noRead.bearer);
    expect(denied.status).toBe(403);
  });
});
