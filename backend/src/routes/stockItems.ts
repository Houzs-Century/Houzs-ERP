import { Hono } from "hono";
import type { Env } from "../types";
import { runStockItemsRefresh } from "../services/stockItems";
import { requireAnyPermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.post("/refresh", requireAnyPermission(["service_cases.manage", "settings.manage"]), async (c) => {
  let body: { item_codes?: string[] } = {};
  try {
    body = await c.req.json();
  } catch {
  }
  const result = await runStockItemsRefresh(c.env, { itemCodes: body.item_codes });
  return c.json(result);
});

export default app;
