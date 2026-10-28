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
