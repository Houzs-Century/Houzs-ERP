import { Hono } from "hono";
import type { Env } from "../types";
import {
  generateSecret,
  otpauthUri,
  verifyTotp,
  generateBackupCodes,
  consumeBackupCode,
} from "../services/totp";
import { audit } from "../services/audit";

// Authenticated TOTP self-service (mounted at /api/totp, INSIDE the auth
// middleware so c.get("user") is the enrolling user). The login second-step
// itself is public and lives in routes/auth.ts (/api/auth/totp/login).
const app = new Hono<{ Bindings: Env }>();

type TotpRow = {
  totp_secret: string | null;
  totp_enabled: number;
  totp_backup_codes: string | null;
};

async function loadTotp(env: Env, userId: number): Promise<TotpRow | null> {
  return env.DB.prepare(
    `SELECT totp_secret, totp_enabled, totp_backup_codes FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<TotpRow>();
}

/** GET /api/totp/status — does the current user have 2FA on, codes left? */
app.get("/status", async (c) => {
  const user = c.get("user");
  const row = await loadTotp(c.env, user.id);
  let remaining = 0;
  try {
    remaining = row?.totp_backup_codes ? JSON.parse(row.totp_backup_codes).length : 0;
  } catch {
    remaining = 0;
  }
  return c.json({
    enabled: !!row?.totp_enabled,
    enrolled: !!row?.totp_secret,
    backup_codes_remaining: remaining,
  });
});

/**
 * POST /api/totp/setup — mint a fresh secret (replaces any un-confirmed one)
 * and hand back the otpauth URI + the secret for manual entry. Does NOT enable
 * 2FA; the user must confirm with a code via /enable. Refused once enabled
 * (disable first) so an attacker on a live session can't silently re-key.
 */
app.post("/setup", async (c) => {
  const user = c.get("user");
  const row = await loadTotp(c.env, user.id);
  if (row?.totp_enabled) {
    return c.json({ error: "2FA is already enabled — disable it first to re-enroll" }, 409);
  }
  const secret = generateSecret();
  await c.env.DB.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`)
    .bind(secret, user.id)
    .run();
  return c.json({ secret, otpauth_uri: otpauthUri(secret, user.email) });
});

/**
 * POST /api/totp/enable  Body: { code }
 * Confirms the enrolling code, flips totp_enabled, and returns 10 one-time
 * backup codes (shown ONCE). From here on the user needs a code at login.
 */
app.post("/enable", async (c) => {
  const user = c.get("user");
  const { code } = await c.req.json<{ code?: string }>();
  if (!code) return c.json({ error: "code is required" }, 400);

  const row = await loadTotp(c.env, user.id);
  if (!row?.totp_secret) {
    return c.json({ error: "Run /setup first" }, 400);
  }
  if (row.totp_enabled) {
    return c.json({ error: "2FA is already enabled" }, 409);
  }
  if (!(await verifyTotp(row.totp_secret, code))) {
    return c.json({ error: "That code didn't match — check your authenticator and try again" }, 400);
  }

  const { plain, hashes } = await generateBackupCodes(10);
  await c.env.DB.prepare(
    `UPDATE users
        SET totp_enabled = 1,
            totp_enrolled_at = datetime('now'),
            totp_backup_codes = ?
      WHERE id = ?`,
  )
    .bind(JSON.stringify(hashes), user.id)
    .run();

  await audit(c, {
    action: "user.totp.enable",
    entityType: "user",
    entityId: user.id,
    summary: `Enabled 2FA on own account (${user.email})`,
  });

  return c.json({ ok: true, backup_codes: plain });
});

/**
 * POST /api/totp/disable  Body: { code }
 * Self-disable. Requires a current TOTP (or backup) code so a hijacked session
 * can't quietly turn 2FA off. Lost-device recovery is the admin reset
 * (POST /api/users/:id/totp/disable, users.manage).
 */
app.post("/disable", async (c) => {
  const user = c.get("user");
  const { code } = await c.req.json<{ code?: string }>();
  const row = await loadTotp(c.env, user.id);
  if (!row?.totp_enabled || !row.totp_secret) {
    return c.json({ error: "2FA is not enabled" }, 400);
  }
  if (!code) return c.json({ error: "code is required to disable 2FA" }, 400);

  let ok = await verifyTotp(row.totp_secret, code);
  if (!ok && row.totp_backup_codes) {
    // Allow a backup code too (the user may be disabling because the device is gone).
    try {
      const remaining = await consumeBackupCode(code, JSON.parse(row.totp_backup_codes));
      ok = remaining !== null;
    } catch {
      ok = false;
    }
  }
  // Backup codes are accepted here too (device may be gone) — say so.
  if (!ok) {
    return c.json(
      { error: "That code didn't match — try the current code from your authenticator app, or a backup code." },
      400,
    );
  }

  await c.env.DB.prepare(
    `UPDATE users
        SET totp_enabled = 0, totp_secret = NULL,
            totp_enrolled_at = NULL, totp_backup_codes = NULL
      WHERE id = ?`,
  )
    .bind(user.id)
    .run();

  await audit(c, {
    action: "user.totp.disable",
    entityType: "user",
    entityId: user.id,
    summary: `Disabled 2FA on own account (${user.email})`,
  });

  return c.json({ ok: true });
});

export default app;
