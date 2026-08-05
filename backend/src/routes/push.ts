// /api/push — device-token registry for the native iOS app.
//
// POST   /devices { token }   — upsert the CALLER's device. A token that moves
//                               between accounts (shared phone) follows the most
//                               recent signer: the unique token row is re-pointed
//                               at the new user and re-enabled.
// DELETE /devices/:token      — called on logout (the api client's del() takes
//                               no body; APNs tokens are hex, so path-safe).
//                               Scoped to the caller's own rows; deleting
//                               another user's token is a no-op.
//
// Both are personal-data operations on the caller's own device — any
// authenticated user, no matrix permission (same widening rationale as
// /api/notifications). What a push may CONTAIN is decided by the sender job
// (services/pushFleetReminders.ts), which checks permissions itself.

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { push_devices } from "../db/schema";

const app = new Hono<{ Bindings: Env }>();

const nowUtcText = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// APNs tokens are hex; length varies by OS era. Bound it rather than pinning an
// exact width Apple has changed before.
const TOKEN_RE = /^[0-9a-f]{16,512}$/i;

app.post("/devices", async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const token = String(body.token ?? "").trim();
  if (!TOKEN_RE.test(token)) return c.json({ error: "invalid_token" }, 400);

  const db = getDb(c.env);
  await db
    .insert(push_devices)
    .values({ user_id: user.id, platform: "ios", token })
    .onConflictDoUpdate({
      target: push_devices.token,
      set: {
        user_id: user.id,
        last_seen_at: nowUtcText(),
        disabled_at: null,
        last_error: null,
      },
    });
  return c.json({ ok: true });
});

app.delete("/devices/:token", async (c) => {
  const user = c.get("user");
  const token = c.req.param("token").trim();
  if (!TOKEN_RE.test(token)) return c.json({ error: "invalid_token" }, 400);

  const db = getDb(c.env);
  const res = await db
    .delete(push_devices)
    .where(and(eq(push_devices.token, token), eq(push_devices.user_id, user.id)))
    .returning({ id: push_devices.id });
  return c.json({ ok: true, removed: res.length });
});

export default app;
