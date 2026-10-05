import type { Context } from "hono";
import { lt, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { auth_failed_logins } from "../db/schema";
import { clientIp } from "../middleware/rateLimit";

/** Every failed branch of /api/auth/login and /api/auth/totp/login. */
export type FailedLoginReason =
  | "rate_limited"
  | "unknown_email"
  | "no_password"
  | "wrong_password"
  | "disabled"
  | "totp_rate_limited"
  | "totp_expired"
  | "totp_unavailable"
  | "totp_failed";

/**
 * Save one failed sign-in AFTER the response, never on its path: the caller's
 * status, body and timing stay exactly what they were, and a failed write is
 * only logged. Whichever of email / user id is missing is filled in by the
 * insert itself, so the request pays no extra lookup.
 * Never pass the attempted password or code here.
 */
export function recordFailedLogin(
  c: Context<{ Bindings: Env }>,
  email: string | null,
  userId: number | null,
  reason: FailedLoginReason,
): void {
  const write = insertFailedLogin(c.env, email, userId, clientIp(c), reason).catch((e) => {
    console.error("[failed-logins] record failed", e);
  });
  // c.executionCtx throws when the runtime supplied none (test harnesses).
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    void write;
  }
}

async function insertFailedLogin(
  env: Env,
  email: string | null,
  userId: number | null,
  ip: string,
  reason: FailedLoginReason,
): Promise<void> {
  await getDb(env)
    .insert(auth_failed_logins)
    .values({
      email: email ?? sql`(SELECT email FROM users WHERE id = ${userId})`,
      user_id: userId ?? sql`(SELECT id FROM users WHERE email = ${email})`,
      ip,
      reason,
    });
}

export const FAILED_LOGIN_RETENTION_DAYS = 90;

/** Daily retention sweep: deletes failed-login rows older than 90 days. */
export async function pruneFailedLogins(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - FAILED_LOGIN_RETENTION_DAYS * 86_400_000);
  const res = await getDb(env)
    .delete(auth_failed_logins)
    .where(lt(auth_failed_logins.created_at, cutoff));
  return res.count;
}

export type LoginsVerdict = "ok" | "warning" | "critical";

export const EMAIL_WARNING_24H = 10;
export const EMAIL_CRITICAL_24H = 30;
export const TOTAL_WARNING_24H = 100;

/** One email at >= 30 failures in 24 h is critical; >= 10, or > 100 in total, is a warning. */
export function loginsVerdict(total24h: number, topEmailFailures24h: number[]): LoginsVerdict {
  const worst = Math.max(0, ...topEmailFailures24h);
  if (worst >= EMAIL_CRITICAL_24H) return "critical";
  if (worst >= EMAIL_WARNING_24H || total24h > TOTAL_WARNING_24H) return "warning";
  return "ok";
}
