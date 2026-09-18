import { SELF, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

/* POST /api/auth/accept-invite used to write the INVITATION's role onto the
 * member, so a Role an admin had set on the profile between invite and sign-in
 * was silently reverted to the baseline placeholder (2026-09-16: seven open
 * invitations still pointed at the 0-key "Position Preview" role after their
 * members had been moved). The placeholder user already carries the
 * invitation's role from the moment it is created; accepting must keep the
 * row's current role and fill from the invitation only when the row has none. */

async function role(name: string, permissions: string[]): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'test', ?, 0)`,
  )
    .bind(name, JSON.stringify(permissions))
    .run();
  return r.meta.last_row_id as number;
}

async function invitedMember(email: string, roleId: number, token: string): Promise<number> {
  // The inviter — invitations.invited_by is NOT NULL.
  const admin = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status) VALUES (?, 'Inviter', ?, 'active')`,
  )
    .bind(`inviter-${token}@test.local`, roleId)
    .run();
  const u = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status) VALUES (?, ?, ?, 'invited')`,
  )
    .bind(email, email.split("@")[0], roleId)
    .run();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO invitations (email, role_id, token, expires_at, invited_by) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(email, roleId, token, expires, admin.meta.last_row_id as number)
    .run();
  return u.meta.last_row_id as number;
}

async function accept(token: string): Promise<number> {
  const res = await SELF.fetch("https://test.local/api/auth/accept-invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "Accepted Person", password: "Str0ng!Passw0rd#2026" }),
  });
  return res.status;
}

describe("accept-invite keeps the Role an admin assigned after the invite", () => {
  test("a role changed on the profile before sign-in survives acceptance", async () => {
    const placeholder = await role("Placeholder (0 keys)", []);
    const real = await role("Real Role", ["projects.read", "users.read"]);
    const token = `inv-keep-${Math.random().toString(36).slice(2)}`;
    const userId = await invitedMember("keep-role@test.local", placeholder, token);

    // The admin moves the member to a real role while the invite is still open.
    await env.DB.prepare(`UPDATE users SET role_id = ? WHERE id = ?`).bind(real, userId).run();

    expect(await accept(token)).toBe(200);

    const after = await env.DB.prepare(`SELECT role_id, status FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ role_id: number; status: string }>();
    expect(after?.status).toBe("active");
    expect(after?.role_id).toBe(real);
  });

  test("an untouched placeholder still ends up on the invitation's role", async () => {
    const baseline = await role("Baseline Role", ["projects.read"]);
    const token = `inv-base-${Math.random().toString(36).slice(2)}`;
    const userId = await invitedMember("base-role@test.local", baseline, token);

    expect(await accept(token)).toBe(200);

    const after = await env.DB.prepare(`SELECT role_id FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ role_id: number }>();
    expect(after?.role_id).toBe(baseline);
  });
});
