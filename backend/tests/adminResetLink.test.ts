import { describe, expect, test } from "vitest";

/* POST /api/users/:id/reset-password — the admin "send reset link" button.
 *
 * The owner's rule for this control is one sentence: "如果他们没有点击，状态就保持
 * 不变" — if the member never clicks, NOTHING about their account changes. The
 * handler used to break that twice over: it deleted every session at send time,
 * and it returned the live token to the caller (which the Team screen then
 * copied to the admin's clipboard, making `users.manage` a silent
 * account-takeover primitive against any account, including more privileged
 * ones).
 *
 * WHY THIS IS A SOURCE TEST AND NOT A ROUTE TEST. I wrote the route test first.
 * It cannot run: this handler is Drizzle/Postgres (`getDb(c.env)`), and the
 * suite's isolated environment binds D1 only — every request 500s on
 * "DATABASE_URL / HYPERDRIVE.connectionString is empty" before reaching a line
 * worth asserting on. Rather than leave the invariant unpinned, or refactor a
 * live auth path onto env.DB purely to make it testable, the two regressions
 * are pinned against the handler's SOURCE. Both would read as perfectly
 * reasonable code in review — a re-added `DELETE FROM sessions` looks like
 * hygiene, and a re-added `token` in the response looks like a convenience —
 * which is exactly why they need a red test rather than a comment.
 *
 * WHY import.meta.glob AND NOT readFileSync: this suite runs in workerd, where
 * fs throws "not yet implemented in Workers". import.meta.glob with `?raw` is
 * expanded by Vite at TRANSFORM time, in Node, so the file contents are baked
 * into the bundle and readable inside the isolate. Same technique, and same
 * reason, as tests/migrationNumbers.test.ts. The emptiness assertions below
 * exist so that a glob which stops resolving fails LOUD instead of silently
 * passing on an empty string.
 */

const sources = import.meta.glob("../src/routes/users.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const usersRoute = Object.values(sources)[0] ?? "";

/** Strip comments so the assertions below read CODE, not prose. This is load-
 *  bearing, not tidiness: the handler's own comment explains WHY it no longer
 *  calls bustUserSessions, and naming the thing you removed is exactly how a
 *  source test starts reporting a phantom. (It did — this function exists
 *  because the first run failed on its own explanatory comment.) */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The body of the reset-password handler: from its route registration to the
 *  next top-level `app.<verb>(` registration. Slicing it out matters — asserting
 *  over the whole 1900-line file would let a `delete(sessions)` belonging to the
 *  DISABLE handler (which legitimately has one) mask a re-added one here. */
function resetHandlerSource(): string {
  const start = usersRoute.indexOf('app.post("/:id/reset-password"');
  expect(start, "reset-password handler not found — did the route move?").toBeGreaterThan(-1);
  const rest = usersRoute.slice(start + 1);
  const next = rest.search(/\napp\.(post|get|patch|put|delete)\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
}

describe("the source is actually readable (guards against a silent empty glob)", () => {
  test("users.ts loaded and contains the handler", () => {
    expect(usersRoute.length).toBeGreaterThan(10_000);
    expect(usersRoute).toContain('app.post("/:id/reset-password"');
  });

  test("the slice is a plausible handler, not the whole file", () => {
    const body = resetHandlerSource();
    expect(body.length).toBeGreaterThan(500);
    expect(body.length).toBeLessThan(usersRoute.length / 2);
    // Anchor: this really is the reset handler.
    expect(body).toContain("password_resets");
  });
});

describe("sending a reset link does not change the account", () => {
  test("the handler does NOT revoke the target's sessions", () => {
    const body = resetHandlerSource();
    // Both spellings the codebase uses for killing sessions.
    expect(body).not.toMatch(/delete\(sessions\)/);
    expect(body).not.toMatch(/DELETE FROM sessions/i);
    expect(body).not.toMatch(/bustUserSessions/);
  });

  test("the handler does NOT write a password hash or a status", () => {
    const body = resetHandlerSource();
    expect(body).not.toMatch(/hashPassword/);
    expect(body).not.toMatch(/password_hash/);
    // It reads users (to find the target) but must not update them.
    expect(body).not.toMatch(/update\(users\)/);
  });

  test("the only row it writes is the reset token itself", () => {
    const body = resetHandlerSource();
    expect(body).toMatch(/insert\(password_resets\)/);
  });
});

describe("the token never leaves the mailbox", () => {
  test("the response body carries neither the token nor a path built from it", () => {
    const body = resetHandlerSource();
    const ret = body.slice(body.lastIndexOf("return c.json("));
    expect(ret.length).toBeGreaterThan(20);
    expect(ret).not.toMatch(/\btoken\b/);
    expect(ret).not.toMatch(/reset_path/);
    // The delivery status IS returned — that is how the UI reports a disabled
    // channel instead of falsely claiming "sent".
    expect(ret).toMatch(/email_status/);
  });

  test("the token is still minted and still goes into the email link", () => {
    const body = resetHandlerSource();
    expect(body).toMatch(/generateToken\(\)/);
    expect(body).toMatch(/publicUrl\([^)]*\/reset\/\$\{token\}/);
  });

  test("the audit trail records the send without recording the token", () => {
    const body = resetHandlerSource();
    const auditCall = body.slice(body.indexOf("await audit(c, {"));
    expect(auditCall.length).toBeGreaterThan(20);
    expect(auditCall).toMatch(/user\.reset_password/);
    // who/whom/when: audit() stamps the actor + time; entityId names the target.
    expect(auditCall).toMatch(/entityId: id/);
    // …but never the credential.
    expect(auditCall.slice(0, auditCall.indexOf("});"))).not.toMatch(/\btoken\b/);
  });
});

describe("the button is rate-limited", () => {
  test("the handler checks a limiter keyed on the TARGET before sending", () => {
    const body = resetHandlerSource();
    expect(body).toMatch(/checkRateLimit\(/);
    // Keyed on the recipient, not the admin — so two admins, or the bulk
    // action, still cannot flood one person's inbox.
    expect(body).toMatch(/checkRateLimit\(\s*c,\s*"admin-reset",\s*String\(id\)/);
  });

  test("the limiter runs BEFORE the email is sent, not after", () => {
    const body = resetHandlerSource();
    expect(body.indexOf("checkRateLimit(")).toBeLessThan(body.indexOf("sendEmail("));
  });
});

/* The client half of this invariant — that neither admin screen copies the
   reset link to the clipboard — is pinned in the FRONTEND suite, at
   frontend/src/pages/adminResetLink.test.ts. It cannot live here: Vite's fs
   allow-list is rooted at backend/, so globbing ../../frontend is a hard
   "Denied ID" at transform time. */
