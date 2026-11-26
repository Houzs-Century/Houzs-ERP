// GET /api/mail-center/compose/senders — the addresses the caller may send FROM.
// Mounted at /api/mail-center (index.ts), next to the other Mail Center routers.
//
// The AI Connector's propose_email (routes/mcp.ts) reads it so a proposal never
// names a mailbox the person may not use. It is the same rule as Compose's
// canSendFrom in mail-center.ts — the caller's scoped mailboxes plus their own
// outward alias — and Compose still checks it again when the email is sent.
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
