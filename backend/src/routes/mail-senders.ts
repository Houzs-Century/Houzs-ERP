import { Hono } from "hono";
import type { Env } from "../types";
import { getMailScope, ownAliasFor } from "./mail-center";

const app = new Hono<{ Bindings: Env }>();

app.get("/compose/senders", async (c) => {
  c.header("Cache-Control", "no-store");
  const scope = await getMailScope(c);
  const alias = await ownAliasFor(c);
  const senders = [...new Set([...scope.addresses, ...(alias ? [alias] : [])].map((a) => a.toLowerCase()).filter(Boolean))];
  return c.json({ senders, any: scope.isAdmin });
});

export default app;
