import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { createSession, getUserBySession, REMEMBER_TTL_SECONDS } from "../src/services/auth";

/**
 * "Remember me on this device" — the ROLLING session (owner 2026-09-02:
 * "why all save email password gone" → "cant keep permanently?" → "i remember
 * me on app on pc").
 *
 * Every session was a flat 7 days and the checkbox never reached the server, so
 * the whole company was signed out weekly. A ticked box now mints a session
 * carrying its own renewal window: any authenticated request made once the
 * window is more than half spent pushes the expiry back to a full window. Used
 * weekly, it never expires; abandoned, it still does.
 *
 * The three properties that matter, and the one that must NOT change:
 *   1. remember=null (the default) never renews — a 7-day session stays 7 days.
 *   2. A rolling session that is still FRESH is not written to (the renewal
 *      must not cost a DB write on every request).
 *   3. A rolling session past the half-way mark renews on use.
 *   4. An EXPIRED rolling session is not resurrected — it is deleted, as before.
 */

let roleId = 0;
let userId = 0;

async function seedUser(): Promise<void> {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'remember-me test', ?, 0)`,
  )
    .bind(`remember-role-${crypto.randomUUID()}`, JSON.stringify(["*"]))
    .run();
  roleId = Number(role.meta.last_row_id);
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'Remember Test', 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`remember-${crypto.randomUUID()}@test.local`, roleId)
    .run();
  userId = Number(user.meta.last_row_id);
}

const expiryOf = async (token: string): Promise<string | null> =>
  (
    await env.DB.prepare(`SELECT expires_at FROM sessions WHERE token = ?`)
      .bind(token)
      .first<{ expires_at: string | null }>()
  )?.expires_at ?? null;

/** Move a session's stored expiry, simulating the passage of time without one. */
async function setExpiry(token: string, msFromNow: number): Promise<void> {
  await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`)
    .bind(new Date(Date.now() + msFromNow).toISOString(), token)
    .run();
}

beforeEach(seedUser);

describe("remember me = a rolling session", () => {
  test("a plain session never renews, however little life is left", async () => {
    const token = await createSession(env as never, userId);
    // One hour left of a 7-day session: past half-way for any window, yet this
    // session carries no renewal window at all.
    await setExpiry(token, 60 * 60 * 1000);
    const before = await expiryOf(token);

    expect((await getUserBySession(env as never, token))?.id).toBe(userId);

    expect(await expiryOf(token)).toBe(before);
  });

  test("a rolling session with most of its window left is not written to", async () => {
    const token = await createSession(
      env as never,
      userId,
      undefined,
      REMEMBER_TTL_SECONDS,
      REMEMBER_TTL_SECONDS,
    );
    const before = await expiryOf(token);

    expect((await getUserBySession(env as never, token))?.id).toBe(userId);

    // Untouched: renewal costs a write only once per half-window, not per request.
    expect(await expiryOf(token)).toBe(before);
  });

  test("a rolling session past half-way renews to a full window on use", async () => {
    const token = await createSession(
      env as never,
      userId,
      undefined,
      REMEMBER_TTL_SECONDS,
      REMEMBER_TTL_SECONDS,
    );
    // A day left of a year — the state a device reaches after ~364 days of use.
    await setExpiry(token, 24 * 60 * 60 * 1000);

    expect((await getUserBySession(env as never, token))?.id).toBe(userId);

    const after = Date.parse((await expiryOf(token)) ?? "");
    const fullWindowFromNow = Date.now() + REMEMBER_TTL_SECONDS * 1000;
    // Back to a full year, within a minute of "now + window".
    expect(Math.abs(after - fullWindowFromNow)).toBeLessThan(60_000);
  });

  test("an EXPIRED rolling session is rejected and deleted, never renewed", async () => {
    const token = await createSession(
      env as never,
      userId,
      undefined,
      REMEMBER_TTL_SECONDS,
      REMEMBER_TTL_SECONDS,
    );
    await setExpiry(token, -60_000); // a minute ago

    expect(await getUserBySession(env as never, token)).toBeNull();

    expect(await expiryOf(token)).toBeNull(); // row gone
  });
});
