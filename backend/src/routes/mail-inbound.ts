import { Hono } from "hono";
import type { Env } from "../types";
import { ingestInboundEmail, type InboundEmailPayload } from "./mail-center";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";

const app = new Hono<{ Bindings: Env }>();

export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

app.post("/", async (c) => {
  const secret = c.env.MAIL_INBOUND_SECRET ?? "";
  if (secret.length < 16) {
    return c.json({ error: "inbound mail not configured" }, 503);
  }
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
