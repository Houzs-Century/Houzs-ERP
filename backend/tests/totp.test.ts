import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  verifyTotp,
  currentTotp,
  generateSecret,
  generateBackupCodes,
  consumeBackupCode,
  otpauthUri,
} from "../src/services/totp";
import { hashPassword } from "../src/services/auth";

// TOTP 2FA (mig 097 / 0007). Two layers:
//   1. pure crypto in services/totp.ts — checked against RFC 6238 vectors.
//   2. the enroll + 2-step login HTTP flow (routes/totp.ts + routes/auth.ts).

// RFC 6238 Appendix B reference secret ("12345678901234567890" ASCII).
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp crypto (RFC 6238 vectors)", () => {
  test("verifies the published SHA1 vectors (low 6 digits)", async () => {
    // 8-digit RFC values 94287082 @59s and 07081804 @1111111109s.
    expect(await verifyTotp(RFC_SECRET, "287082", 0, 59_000)).toBe(true);
    expect(await verifyTotp(RFC_SECRET, "081804", 0, 1_111_111_109_000)).toBe(true);
  });

  test("rejects a wrong code and a malformed code", async () => {
    expect(await verifyTotp(RFC_SECRET, "000000", 0, 59_000)).toBe(false);
    expect(await verifyTotp(RFC_SECRET, "12", 0, 59_000)).toBe(false);
  });

  test("currentTotp round-trips through verifyTotp", async () => {
    const secret = generateSecret();
    const code = await currentTotp(secret);
    expect(await verifyTotp(secret, code)).toBe(true);
  });

  test("accepts ±1 step of drift, rejects 2 steps out", async () => {
    const secret = generateSecret();
    const t = 1_700_000_000_000;
    const prev = await currentTotp(secret, t - 30_000);
    const next = await currentTotp(secret, t + 30_000);
    const far = await currentTotp(secret, t + 60_000);
    expect(await verifyTotp(secret, prev, 1, t)).toBe(true);
    expect(await verifyTotp(secret, next, 1, t)).toBe(true);
    expect(await verifyTotp(secret, far, 1, t)).toBe(false);
  });

  test("otpauth uri carries the secret + issuer", () => {
    const uri = otpauthUri("ABC234", "a@test.local");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=ABC234");
    expect(uri).toContain("issuer=Houzs+ERP");
  });

  test("backup codes are single-use and normalize case/format", async () => {
    const { plain, hashes } = await generateBackupCodes(3);
    expect(plain).toHaveLength(3);
    expect(hashes).toHaveLength(3);
    // Wrong code → null.
    expect(await consumeBackupCode("NOPE-NOPE", hashes)).toBeNull();
    // Right code (lower-cased, spaces) → array with that one removed.
    const after = await consumeBackupCode(plain[0].toLowerCase().replace("-", " - "), hashes);
    expect(after).not.toBeNull();
    expect(after).toHaveLength(2);
    // The consumed hash is gone, so re-consuming against the trimmed set fails.
    expect(await consumeBackupCode(plain[0], after!)).toBeNull();
  });
});

// ── HTTP enroll + login flow ──────────────────────────────────

const PW = "Sup3r-Secret-Pw!";
let bearer: string;
let userEmail: string;

async function seedUser(): Promise<{ id: number; email: string; bearer: string }> {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'test', ?, 0)`,
  )
    .bind(`role_${Math.random().toString(36).slice(2)}`, JSON.stringify(["*"]))
    .run();
  const roleId = role.meta.last_row_id as number;

  const email = `u_${Math.random().toString(36).slice(2)}@test.local`;
  const hash = await hashPassword(PW);
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'TwoFA User', ?, ?, 'active', datetime('now'))`,
  )
    .bind(email, hash, roleId)
    .run();
  const id = user.meta.last_row_id as number;

  const token = `tok-${id}-${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, id, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return { id, email, bearer: `Bearer ${token}` };
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM audit_events`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
  const s = await seedUser();
  bearer = s.bearer;
  userEmail = s.email;
});

async function postJson(path: string, body: unknown, auth?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  const res = await SELF.fetch(`https://test.local${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

describe("totp enroll + 2-step login", () => {
  test("setup → enable → status, then login requires a code", async () => {
    // 1. setup
    const setup = await postJson("/api/totp/setup", {}, bearer);
    expect(setup.status).toBe(200);
    const secret: string = setup.json.secret;
    expect(secret).toBeTruthy();
    expect(setup.json.otpauth_uri).toContain("otpauth://");

    // 2. enable with a valid code → get backup codes
    const enable = await postJson("/api/totp/enable", { code: await currentTotp(secret) }, bearer);
    expect(enable.status).toBe(200);
    expect(enable.json.backup_codes).toHaveLength(10);
    const backup: string[] = enable.json.backup_codes;

    // 3. status reflects it
    const status = await SELF.fetch("https://test.local/api/totp/status", {
      headers: { Authorization: bearer },
    });
    const sbody = (await status.json()) as any;
    expect(sbody.enabled).toBe(true);
    expect(sbody.backup_codes_remaining).toBe(10);

    // 4. password login no longer returns a session — it returns a challenge
    const login = await postJson("/api/auth/login", { email: userEmail, password: PW });
    expect(login.status).toBe(200);
    expect(login.json.token).toBeUndefined();
    expect(login.json.totp_required).toBe(true);
    const challenge: string = login.json.challenge;
    expect(challenge).toBeTruthy();

    // 5. wrong code is rejected
    const bad = await postJson("/api/auth/totp/login", { challenge, code: "000000" });
    expect(bad.status).toBe(401);

    // 6. correct code completes the login
    const good = await postJson("/api/auth/totp/login", {
      challenge,
      code: await currentTotp(secret),
    });
    expect(good.status).toBe(200);
    expect(good.json.token).toBeTruthy();

    // 7. a backup code also works (fresh challenge), and burns one code
    const login2 = await postJson("/api/auth/login", { email: userEmail, password: PW });
    const c2 = await postJson("/api/auth/totp/login", {
      challenge: login2.json.challenge,
      code: backup[0],
    });
    expect(c2.status).toBe(200);
    expect(c2.json.token).toBeTruthy();
    const status2 = await SELF.fetch("https://test.local/api/totp/status", {
      headers: { Authorization: bearer },
    });
    expect(((await status2.json()) as any).backup_codes_remaining).toBe(9);
  });

  test("a consumed/expired challenge cannot be reused", async () => {
    const setup = await postJson("/api/totp/setup", {}, bearer);
    const secret: string = setup.json.secret;
    await postJson("/api/totp/enable", { code: await currentTotp(secret) }, bearer);

    const login = await postJson("/api/auth/login", { email: userEmail, password: PW });
    const challenge: string = login.json.challenge;
    // First use succeeds.
    const first = await postJson("/api/auth/totp/login", { challenge, code: await currentTotp(secret) });
    expect(first.status).toBe(200);
    // Replay with the same (now-deleted) challenge → 401.
    const replay = await postJson("/api/auth/totp/login", { challenge, code: await currentTotp(secret) });
    expect(replay.status).toBe(401);
  });

  test("self-disable needs a valid code; afterwards login is password-only", async () => {
    const setup = await postJson("/api/totp/setup", {}, bearer);
    const secret: string = setup.json.secret;
    await postJson("/api/totp/enable", { code: await currentTotp(secret) }, bearer);

    // Wrong code refused.
    const bad = await postJson("/api/totp/disable", { code: "000000" }, bearer);
    expect(bad.status).toBe(400);

    // Correct code disables it.
    const ok = await postJson("/api/totp/disable", { code: await currentTotp(secret) }, bearer);
    expect(ok.status).toBe(200);

    // Login now returns a session directly (no 2FA).
    const login = await postJson("/api/auth/login", { email: userEmail, password: PW });
    expect(login.json.token).toBeTruthy();
    expect(login.json.totp_required).toBeUndefined();
  });
});
