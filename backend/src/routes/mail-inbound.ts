// ---------------------------------------------------------------------------
// Mail Center inbound ingest — PRE-AUTH, machine-to-machine.
//
// The standalone houzs-mail-inbound CF Email Worker (or the IMAP mail-sync
// bridge) POSTs every received email here as JSON. There is no staff session;
// the route authenticates the CALLER with a shared secret in the x-mail-secret
// header, compared in constant time against env.MAIL_INBOUND_SECRET.
//
// Mounted in index.ts at /api/mail-center/inbound BEFORE the /api/* auth
// middleware (alongside /api/auth, /api/track, /api/portal). Owner-gated: until
// MAIL_INBOUND_SECRET is set (>= 16 chars) the route returns 503, so it stays
// inert through the build until the owner wires MX + the secret.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../types";
import { ingestInboundEmail, type InboundEmailPayload } from "./mail-center";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";

const app = new Hono<{ Bindings: Env }>();

// mail-sync caps attachments at 15 MB a message; base64 adds a third, plus the
// bodies. Anything larger did not come from it.
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

// Length-independent constant-time string compare. Returns false fast on a
// length mismatch (length is not secret here — the secret's value is), else
// XORs every byte so timing doesn't leak how many chars matched.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// POST /api/mail-center/inbound — ingest one inbound email.
app.post("/", async (c) => {
  const secret = c.env.MAIL_INBOUND_SECRET ?? "";
  // Gate: refuse until a real secret is configured. >= 16 chars so a short or
  // placeholder value can't accidentally open the door (Hookka semantics).
  if (secret.length < 16) {
    return c.json({ error: "inbound mail not configured" }, 503);
  }
  // Only wrong secrets are counted. The secret holder (mail-sync) posts every
  // message of the last 3 days each run, sequentially, faster than KV accepts
  // writes to one key, so a per-call counter there would not hold anyway.
  const provided = c.req.header("x-mail-secret") ?? "";
  if (!timingSafeEqual(provided, secret)) {
    return (await checkRateLimit(c, "mail-inbound-auth", clientIp(c), 20, 900)) ?? c.json({ error: "Unauthorized" }, 401);
  }

  if (Number(c.req.header("content-length") ?? 0) > MAX_INBOUND_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  const raw = await c.req.text().catch(() => "");
  if (raw.length > MAX_INBOUND_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  let payload: InboundEmailPayload | null = null;
  try {
    payload = JSON.parse(raw) as InboundEmailPayload;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "invalid payload" }, 400);
  }

  const result = await ingestInboundEmail(c.env.DB, payload, c.env);
  if (!result.ok) {
    return c.json(result, 400);
  }
  return c.json(result);
});

export default app;
