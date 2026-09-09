import type { Context } from "hono";
import type { Env } from "../types";

// KV-backed brute-force speed bump (ported from Hookka's rate-limit.ts onto the
// existing SESSION_CACHE binding). A simple per-key counter: `max` attempts per
// `windowSec`, then 429 until the TTL expires.
//
// Deliberately NOT a hard security boundary — KV is eventually consistent and
// can over-count under concurrency, which errs on the defender's side. Fails
// OPEN when KV is unbound (tests/dev) or on any KV blip, so it never blocks a
// legitimate login because of an infra hiccup.

const RL_PREFIX = "rl:";

/** Client IP from Cloudflare's edge headers. */
export function clientIp(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

const keyFor = (bucket: string, key: string) =>
  `${RL_PREFIX}${bucket}:${key.replace(/[^a-zA-Z0-9._@:-]/g, "_")}`;

/**
 * Check + increment the limiter for (bucket, key). Returns a 429 Response the
 * caller should `return` immediately when over the cap, else null (allowed).
 */
export async function checkRateLimit(
  c: Context<{ Bindings: Env }>,
  bucket: string,
  key: string,
  max = 10,
  windowSec = 900,
): Promise<Response | null> {
  const kv = c.env.SESSION_CACHE;
  if (!kv || !key) return null;
  const fullKey = keyFor(bucket, key);

  let current = 0;
  try {
    const raw = await kv.get(fullKey);
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) current = n;
    }
  } catch (e) {
    console.warn("[rate-limit] KV read failed, allowing:", e);
    return null;
  }

  if (current >= max) {
    return c.json(
      {
        error: "Too many attempts. Please wait a few minutes and try again.",
        retryAfterSec: windowSec,
      },
      429,
    );
  }

  try {
    await kv.put(fullKey, String(current + 1), { expirationTtl: windowSec });
  } catch (e) {
    console.warn("[rate-limit] KV write failed:", e);
  }
  return null;
}

/**
 * The limiter split in two, for routes where a request that PROVES itself must
 * not count. The public share links (2026-09-09): every page load, minute poll,
 * event tap and export from one address counted toward the 300-per-15-minute
 * brute-force cap, so an office with a few tabs open could lock every link out
 * of that address for 15 minutes — and a valid token is not a guess. Callers
 * ask `rateLimitExceeded` first, then `bumpRateLimit` ONLY when the token
 * turned out unknown or revoked, so a guesser still pays and a visitor never
 * does. Both fail OPEN on a KV blip, like `checkRateLimit`.
 */
export async function rateLimitExceeded(
  c: Context<{ Bindings: Env }>,
  bucket: string,
  key: string,
  max: number,
  windowSec: number,
): Promise<Response | null> {
  const kv = c.env.SESSION_CACHE;
  if (!kv || !key) return null;
  let current = 0;
  try {
    const raw = await kv.get(keyFor(bucket, key));
    const n = raw ? Number.parseInt(raw, 10) : 0;
    if (Number.isFinite(n)) current = n;
  } catch (e) {
    console.warn("[rate-limit] KV read failed, allowing:", e);
    return null;
  }
  if (current < max) return null;
  return c.json(
    { error: "Too many attempts. Please wait a few minutes and try again.", retryAfterSec: windowSec },
    429,
  );
}

export async function bumpRateLimit(
  c: Context<{ Bindings: Env }>,
  bucket: string,
  key: string,
  windowSec: number,
): Promise<void> {
  const kv = c.env.SESSION_CACHE;
  if (!kv || !key) return;
  try {
    const raw = await kv.get(keyFor(bucket, key));
    const n = raw ? Number.parseInt(raw, 10) : 0;
    await kv.put(keyFor(bucket, key), String((Number.isFinite(n) ? n : 0) + 1), { expirationTtl: windowSec });
  } catch (e) {
    console.warn("[rate-limit] KV write failed:", e);
  }
}

/** Fire-and-forget reset on a successful attempt (clears the counter). */
export async function clearRateLimit(
  c: Context<{ Bindings: Env }>,
  bucket: string,
  key: string,
): Promise<void> {
  const kv = c.env.SESSION_CACHE;
  if (!kv || !key) return;
  try {
    await kv.delete(keyFor(bucket, key));
  } catch (e) {
    console.warn("[rate-limit] KV delete failed:", e);
  }
}
