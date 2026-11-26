import { Hono } from "hono";
import type { Env } from "../types";
import { acknowledge, owedAcks } from "../lib/mail-acks";

const app = new Hono<{ Bindings: Env }>();

app.get("/acks/pending", async (c) => {
  const userId = c.get("userId") ?? null;
  if (userId == null) return c.json([]);
  return c.json(await owedAcks(c.env.DB, userId));
});

app.post("/messages/:id/ack", async (c) => {
  const userId = c.get("userId") ?? null;
  if (userId == null) return c.json({ error: "Not signed in" }, 401);
  const ok = await acknowledge(c.env.DB, c.req.param("id"), userId);
  if (!ok) return c.json({ error: "Nothing to acknowledge on this message." }, 404);
  return c.json({ ok: true });
});

export default app;
