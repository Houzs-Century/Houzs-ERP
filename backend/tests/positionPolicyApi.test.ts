import { SELF, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

/* Roles & Permissions › Titles (part B, 2026-09-16): the per-Title policy row.
 * Pins the loop end to end: a stored row decides the hydrated session (page
 * access, wildcard, scm_l2_configured), an edit reaches a LIVE session without
 * re-login (the row rides the authz fingerprint), the API validates and
 * audits, and a Title with no row keeps the name rule. */

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

  const token = `ppol-${userId}-${Math.random().toString(36).slice(2)}`;
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

describe("position_policy — a Title's row decides the session", () => {
  test("no row: the name rule (an unclassified Title is full); a restricted row narrows a LIVE session", async () => {
    const member = await seedPositionedUser({
      email: "ppol-member@test.local",
      permissions: ["users.read"],
      positionName: "Regional Stock Clerk",
      positionSlug: "regional_stock_clerk",
    });

    const before = await api("GET", "/api/auth/me", member.bearer);
    expect(before.status).toBe(200);
    expect(before.json.user.page_access["scm.warehouse.transfers"]).toBe("full");
    expect(before.json.user.scm_l2_configured).toBe(false);

    await env.DB.prepare(
      `INSERT INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
       VALUES (?, 'restricted', 'storekeeper', 0, 0, 0)`,
    )
      .bind(member.positionId)
      .run();

    // Same bearer, no re-login: the row is in the authz fingerprint.
    const after = await api("GET", "/api/auth/me", member.bearer);
    expect(after.status).toBe(200);
    expect(after.json.user.page_access["scm.warehouse.inventory"]).toBe("view");
    expect(after.json.user.page_access["scm.warehouse.transfers"]).toBe("none");
    expect(after.json.user.scm_l2_configured).toBe(true);
    expect(after.json.user.permissions).not.toContain("*");
  });

  test("a god row grants the wildcard by id, whatever the Title is called", async () => {
    const member = await seedPositionedUser({
      email: "ppol-god@test.local",
      permissions: ["users.read"],
      positionName: "Deputy Chief",
      positionSlug: "deputy_chief",
    });
    const before = await api("GET", "/api/auth/me", member.bearer);
    expect(before.json.user.permissions).not.toContain("*");

    await env.DB.prepare(
      `INSERT INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
       VALUES (?, 'god', NULL, 1, 1, 0)`,
    )
      .bind(member.positionId)
      .run();
    const after = await api("GET", "/api/auth/me", member.bearer);
    expect(after.json.user.permissions).toContain("*");
    expect(after.json.user.page_access["scm.finance.accounting"]).toBe("full");
  });

  test("PUT validates, upserts, audits; GET reports source row|name; DELETE returns to the name rule", async () => {
    const admin = await seedPositionedUser({
      email: "ppol-admin@test.local",
      permissions: ["users.read", "users.manage", "roles.manage"],
      positionName: "Test Policy Admin",
      positionSlug: "test_policy_admin",
    });
    const target = await seedPositionedUser({
      email: "ppol-target@test.local",
      permissions: ["users.read"],
      positionName: "Test Policy Target",
      positionSlug: "test_policy_target",
    });
    const reader = await seedPositionedUser({
      email: "ppol-reader@test.local",
      permissions: ["users.read"],
      positionName: "Test Policy Reader",
      positionSlug: "test_policy_reader",
    });

    const listBefore = await api("GET", "/api/position-policy", reader.bearer);
    expect(listBefore.status).toBe(200);
    const entryBefore = listBefore.json.positions.find((p: any) => p.id === target.positionId);
    expect(entryBefore.source).toBe("name");
    expect(entryBefore.row).toBeNull();
    expect(entryBefore.effective.cohort).toBe("full");

    // Reads do not write.
    const forbidden = await api("PUT", `/api/position-policy/${target.positionId}`, reader.bearer, {
      cohort: "full", profile: null, can_move_money: false, can_write_config: true, is_fleet: false,
    });
    expect(forbidden.status).toBe(403);

    const bad = await api("PUT", `/api/position-policy/${target.positionId}`, admin.bearer, {
      cohort: "restricted", profile: null, can_move_money: false, can_write_config: false, is_fleet: true,
    });
    expect(bad.status).toBe(400);

    const ok = await api("PUT", `/api/position-policy/${target.positionId}`, admin.bearer, {
      cohort: "sales", profile: "director", can_move_money: false, can_write_config: false, is_fleet: false,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.source).toBe("row");
    expect(ok.json.row.cohort).toBe("sales");
    expect(ok.json.row.profile).toBe("director");

    const targetMe = await api("GET", "/api/auth/me", target.bearer);
    expect(targetMe.json.user.page_access["scm.sales"]).toBe("full");
    expect(targetMe.json.user.page_access["scm.sales.returns"]).toBe("none");
    expect(targetMe.json.user.scm_l2_configured).toBe(true);

    const audited = await env.DB.prepare(
      `SELECT count(*) AS n FROM audit_events WHERE action = 'position_policy.update' AND entity_id = ?`,
    )
      .bind(String(target.positionId))
      .first<{ n: number }>();
    expect(Number(audited?.n ?? 0)).toBeGreaterThanOrEqual(1);

    const reset = await api("DELETE", `/api/position-policy/${target.positionId}`, admin.bearer);
    expect(reset.status).toBe(200);
    expect(reset.json.source).toBe("name");
    const targetAfterReset = await api("GET", "/api/auth/me", target.bearer);
    expect(targetAfterReset.json.user.page_access["scm.sales.returns"]).toBe("full");

    const missing = await api("PUT", `/api/position-policy/999999`, admin.bearer, {
      cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false,
    });
    expect(missing.status).toBe(404);
  });
});
