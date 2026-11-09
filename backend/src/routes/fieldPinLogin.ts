import type { Context } from "hono";
import type { Env } from "../types";
import {
  createSession,
  generateToken,
  mintSessionPass,
  SESSION_ORIGIN_FIELD,
  verifyPassword,
} from "../services/auth";
import { checkRateLimit, clearRateLimit, clientIp } from "../middleware/rateLimit";
import { recordFailedLogin, recordRateLimitedOnce } from "../services/failedLogins";
import { writeAudit } from "../services/audit";
import {
  FIELD_PIN_FAIL_SQL,
  FIELD_PIN_IP_MAX,
  FIELD_PIN_LOCK_MINUTES,
  FIELD_PIN_LOOKUP_SQL,
  FIELD_PIN_MAX_FAILURES,
  FIELD_PIN_RESET_SQL,
  FIELD_PIN_WINDOW_SECONDS,
  isFieldPinEligible,
  isFieldPinShape,
  isLocked,
  normaliseFieldLogin,
} from "../services/fieldPin";
import type { PositionCohort, PositionProfile } from "../services/positionPolicyRows";

/* Same throwaway record routes/auth.ts uses: a login for a staff code with no
   PIN still pays the full PBKDF2 derivation, so timing does not say which
   codes hold a PIN. Never compared against successfully. */
const TIMING_EQUALISER_HASH =
  "BF3yX+3ocRPnH9KBKydn5A==$5iHFIc7Z3t8/vEm8jA4GuwdjcaL5/yajl4dWitx/PBU=";
const TOTP_CHALLENGE_TTL_SECONDS = 5 * 60;

export const WRONG_PIN_MESSAGE = "Staff code or PIN is incorrect.";
/* ONE body for the durable lock and the per-code speed bump, so a locked real
   account and a hammered unknown code read the same. */
export const LOCKED_MESSAGE = `Too many wrong PINs. Wait ${FIELD_PIN_LOCK_MINUTES} minutes, or ask the office to set a new PIN.`;

type PinRow = {
  id: number;
  status: string;
  totp_enabled: number | boolean | null;
  staff_id: string;
  pin_hash: string | null;
  failed_count: number | null;
  locked_until: string | Date | null;
  cohort: PositionCohort | null;
  profile: PositionProfile | null;
};

const lockedResponse = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: LOCKED_MESSAGE, code: "field_pin_locked", retryAfterSec: FIELD_PIN_WINDOW_SECONDS }, 429);

/**
 * POST /api/auth/pin-login { login, pin } — crew sign-in (services/fieldPin.ts).
 *
 * Order matters and each step is there for a reason:
 *   1. per-IP speed bump (KV) — bounds one address walking many codes;
 *   2. per-code speed bump (KV) — answers an unknown code exactly as the lock
 *      below answers a real one, after the same number of tries;
 *   3. the durable lock on the PIN row — holds when KV is down, which is the
 *      only reason the KV limits may fail open;
 *   4. the PIN check, always paid in full;
 *   5. status, then Title eligibility — AFTER the PIN, so neither discloses
 *      anything to someone who does not already hold the PIN.
 * The session is stamped origin 'field', which is what confines it.
 */
export async function fieldPinLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
  let body: { login?: unknown; pin?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Enter your staff code and PIN." }, 400);
  }
  const code = normaliseFieldLogin(body.login);
  if (!code || !isFieldPinShape(body.pin)) {
    return c.json({ error: "Enter your staff code and your 6-digit PIN." }, 400);
  }
  const pin = body.pin;
  const ip = clientIp(c);

  const ipLimited = await checkRateLimit(c, "pin-ip", ip, FIELD_PIN_IP_MAX, FIELD_PIN_WINDOW_SECONDS);
  if (ipLimited) {
    recordRateLimitedOnce(c, code, "rate_limited", `pin-ip:${ip}`, FIELD_PIN_WINDOW_SECONDS);
    return ipLimited;
  }
  const codeLimited = await checkRateLimit(c, "pin-code", code, FIELD_PIN_MAX_FAILURES, FIELD_PIN_WINDOW_SECONDS);
  if (codeLimited) {
    recordRateLimitedOnce(c, code, "rate_limited", `pin-code:${code}`, FIELD_PIN_WINDOW_SECONDS);
    return lockedResponse(c);
  }

  const row = await c.env.DB.prepare(FIELD_PIN_LOOKUP_SQL).bind(code).first<PinRow>();

  if (row?.pin_hash && isLocked(row.locked_until, Date.now())) {
    recordFailedLogin(c, code, row.id, "rate_limited");
    return lockedResponse(c);
  }

  const ok = await verifyPassword(pin, row?.pin_hash || TIMING_EQUALISER_HASH);
  if (!row || !row.pin_hash || !ok) {
    if (row?.pin_hash) {
      const after = await c.env.DB.prepare(FIELD_PIN_FAIL_SQL)
        .bind(row.id)
        .first<{ failed_count: number; locked_until: string | Date | null }>();
      if (after && Number(after.failed_count) === FIELD_PIN_MAX_FAILURES) {
        await writeAudit(c.env, {
          action: "auth.field_pin.locked",
          entityType: "user",
          entityId: row.id,
          summary: `Crew PIN locked after ${FIELD_PIN_MAX_FAILURES} wrong tries (${code})`,
          meta: { staff_code: code, locked_until: after.locked_until },
          ip,
          requestId: c.get("requestId"),
        });
      }
    }
    recordFailedLogin(c, code, row?.id ?? null, !row ? "unknown_email" : !row.pin_hash ? "no_password" : "wrong_password");
    return c.json({ error: WRONG_PIN_MESSAGE }, 401);
  }

  if (row.status !== "active") {
    recordFailedLogin(c, code, row.id, "disabled");
    return c.json({ error: "Account is disabled" }, 403);
  }
  if (!isFieldPinEligible(row.cohort && { cohort: row.cohort, profile: row.profile })) {
    recordFailedLogin(c, code, row.id, "disabled");
    return c.json(
      { error: "This account cannot sign in with a crew PIN. Sign in with your email, or ask the office.", code: "field_pin_not_eligible" },
      403,
    );
  }

  await c.env.DB.prepare(FIELD_PIN_RESET_SQL).bind(row.id).run();
  await clearRateLimit(c, "pin-code", code);

  if (row.totp_enabled) {
    const kv = c.env.SESSION_CACHE;
    if (!kv) return c.json({ error: "Two-factor is temporarily unavailable. Try again shortly." }, 503);
    const challenge = generateToken();
    try {
      // Third field carries the door through the 2FA step, so the session
      // /totp/login mints is a field one too — never an unconfined ERP one.
      await kv.put(`2fa:${challenge}`, `${row.id}:0:field`, { expirationTtl: TOTP_CHALLENGE_TTL_SECONDS });
    } catch (e) {
      console.error("[2fa] challenge store failed", e);
      return c.json({ error: "Two-factor is temporarily unavailable. Try again shortly." }, 503);
    }
    return c.json({ totp_required: true, challenge });
  }

  await c.env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(row.id).run();
  const token = await createSession(c.env, row.id, SESSION_ORIGIN_FIELD);
  const sessionPass = await mintSessionPass(c.env, token, Date.now());
  await writeAudit(c.env, {
    action: "auth.field_pin.login",
    entityType: "user",
    entityId: row.id,
    summary: `Crew PIN sign-in (${code})`,
    actorId: row.id,
    ip,
    requestId: c.get("requestId"),
  });
  return c.json({
    token,
    user_id: row.id,
    staffId: row.staff_id,
    session_origin: SESSION_ORIGIN_FIELD,
    ...(sessionPass ? { session_pass: sessionPass } : {}),
  });
}
