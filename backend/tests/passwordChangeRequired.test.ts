import { SELF, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { createSession, hashPassword } from "../src/services/auth";

/* Required password change (docs/staging-dump-artifact-exposure-coe.md: staff
 * password hashes were exposed, owner approved forcing admins + finance to pick
 * a new one, 2026-11-10).
 *
 * The properties that matter:
 *   1. A flagged member's correct password opens a session that reaches NOTHING
 *      but /api/auth (me, logout, change password).
 *   2. Changing the password clears the flag, ends every session the member
 *      held (the restricted one included) and hands back an ordinary session.
 *   3. An unflagged member signs in exactly as before.
 *   4. The admin action sets the flag and ends the member's sessions.
 *   5. The new password must differ from the old one.
 */

/* Any route behind the auth gate. id 0 is refused by the handler itself with a
   400 before it touches a table, so a 400 proves the gate LET THE REQUEST IN,
   while the restricted session is stopped at the gate with a 403. */
const PROTECTED = "/api/users/0/brands";
const PASSED_AUTH = 400;

const OLD_PW = "Old-Str0ng#Passw0rd-2025";
const NEW_PW = "New-Str0ng#Passw0rd-2026";

async function seedMember(opts: { flagged: boolean; permissions?: string[] }) {
  const tag = crypto.randomUUID();
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'pw-change test', ?, 0)`,
  )
    .bind(`pwchange-role-${tag}`, JSON.stringify(opts.permissions ?? ["*"]))
    .run();
  const email = `pwchange-${tag}@test.local`;
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at, password_change_required_at)
     VALUES (?, 'PW Change', ?, ?, 'active', datetime('now'), ?)`,
  )
    .bind(email, await hashPassword(OLD_PW), Number(role.meta.last_row_id), opts.flagged ? "2026-11-10 00:00:00" : null)
    .run();
  return { email, id: Number(user.meta.last_row_id) };
}

const login = (email: string, password: string) =>
  SELF.fetch("https://test.local/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

const authed = (token: string, path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://test.local${path}`, {
    ...init,
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

const sessionsOf = async (userId: number) =>
  (
    await env.DB.prepare(`SELECT token, origin FROM sessions WHERE user_id = ?`)
      .bind(userId)
      .all<{ token: string; origin: string | null }>()
  ).results ?? [];

const flagOf = async (userId: number) =>
  (
    await env.DB.prepare(`SELECT password_change_required_at AS f FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ f: string | null }>()
  )?.f ?? null;

describe("required password change", () => {
  test("a flagged member's sign-in is restricted to changing the password", async () => {
    const m = await seedMember({ flagged: true });
    const res = await login(m.email, OLD_PW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; password_change_required?: boolean; session_pass?: string };
    expect(body.password_change_required).toBe(true);
    expect(body.session_pass).toBeUndefined();
    expect((await sessionsOf(m.id)).map((s) => s.origin)).toEqual(["password_change"]);

    const blocked = await authed(body.token, PROTECTED);
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { code: string }).code).toBe("password_change_required");

    const me = await authed(body.token, "/api/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { password_change_required: boolean } }).user.password_change_required).toBe(true);

    const rename = await authed(body.token, "/api/auth/me", { method: "PATCH", body: JSON.stringify({ name: "x" }) });
    expect(rename.status).toBe(403);
  });

  test("a wrong password still gets the ordinary refusal, not a restricted session", async () => {
    const m = await seedMember({ flagged: true });
    const res = await login(m.email, "Wrong-Passw0rd#2025");
    expect(res.status).toBe(401);
    expect(await sessionsOf(m.id)).toEqual([]);
  });

  test("changing the password clears the flag, ends every session and returns an ordinary one", async () => {
    const m = await seedMember({ flagged: true });
    // A session that pre-dates the flag (e.g. one the script missed) must also end.
    const stale = await createSession(env as never, m.id);
    const { token } = (await (await login(m.email, OLD_PW)).json()) as { token: string };

    const same = await authed(token, "/api/auth/me/password", {
      method: "POST",
      body: JSON.stringify({ current: OLD_PW, next: OLD_PW }),
    });
    expect(same.status).toBe(400);
    expect(await flagOf(m.id)).not.toBeNull();

    const changed = await authed(token, "/api/auth/me/password", {
      method: "POST",
      body: JSON.stringify({ current: OLD_PW, next: NEW_PW }),
    });
    expect(changed.status).toBe(200);
    const out = (await changed.json()) as { ok: boolean; token?: string };
    expect(out.ok).toBe(true);
    expect(out.token).toBeTruthy();
    expect(await flagOf(m.id)).toBeNull();

    const left = await sessionsOf(m.id);
    expect(left).toEqual([{ token: out.token, origin: null }]);
    expect(left.some((s) => s.token === stale || s.token === token)).toBe(false);

    expect((await authed(out.token!, PROTECTED)).status).toBe(PASSED_AUTH);
    expect((await authed(token, "/api/auth/me")).status).toBe(401);

    // The new password signs in normally; the old one no longer does.
    expect((await login(m.email, OLD_PW)).status).toBe(401);
    const again = (await (await login(m.email, NEW_PW)).json()) as { password_change_required?: boolean };
    expect(again.password_change_required).toBeUndefined();
  });

  test("an unflagged member signs in exactly as before", async () => {
    const m = await seedMember({ flagged: false });
    const res = await login(m.email, OLD_PW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; password_change_required?: boolean };
    expect(body.password_change_required).toBeUndefined();
    expect((await sessionsOf(m.id)).map((s) => s.origin)).toEqual([null]);
    expect((await authed(body.token, PROTECTED)).status).toBe(PASSED_AUTH);
  });

  test("the admin action flags the member and ends their sessions", async () => {
    const admin = await seedMember({ flagged: false });
    const target = await seedMember({ flagged: false, permissions: ["projects.read"] });
    const adminToken = await createSession(env as never, admin.id);
    const targetToken = await createSession(env as never, target.id);

    const res = await authed(adminToken, `/api/users/${target.id}/require-password-change`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sessions_ended: number }).sessions_ended).toBe(1);
    expect(await flagOf(target.id)).not.toBeNull();
    expect(await sessionsOf(target.id)).toEqual([]);
    expect((await authed(targetToken, "/api/auth/me")).status).toBe(401);

    const audit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'user.require_password_change' AND entity_id = ?`,
    )
      .bind(String(target.id))
      .first<{ n: number }>();
    expect(Number(audit?.n)).toBe(1);

    const cleared = await authed(adminToken, `/api/users/${target.id}/require-password-change`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(await flagOf(target.id)).toBeNull();
  });

  test("a member without users.manage cannot flag anyone", async () => {
    const plain = await seedMember({ flagged: false, permissions: ["projects.read"] });
    const target = await seedMember({ flagged: false, permissions: ["projects.read"] });
    const token = await createSession(env as never, plain.id);
    const res = await authed(token, `/api/users/${target.id}/require-password-change`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(await flagOf(target.id)).toBeNull();
  });
});
