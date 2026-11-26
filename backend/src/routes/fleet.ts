import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermissionOrSalesView } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.get("/staff", requirePermissionOrSalesView("users.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.phone, u.company_phone, u.user_type,
            r.name as role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE r.name IN ('Driver','Helper','Storekeeper')
        AND u.status IN ('active','invited')
      ORDER BY r.name, u.name`,
  ).all();
  return c.json({ data: rows.results ?? [] });
});

export default app;
