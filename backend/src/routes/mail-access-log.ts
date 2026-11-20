// GET /api/mail-center/access/changes - who changed whose mail access, newest 50
// of the active company (owner 2026-11-21). Written by lib/mail-access.ts.
import { Hono } from "hono";
import type { Env } from "../types";
import { activeCompanySql } from "../scm/lib/companyScope";
import { isMailAdmin } from "./mail-center";

const app = new Hono<{ Bindings: Env }>();

app.get("/access/changes", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
  c.header("Cache-Control", "no-store");
  try {
    const res = await c.env.DB.prepare(
      `SELECT m.changed_at, m.change, b.name AS by_name, u.name AS who_name
         FROM mail_access_changes m
         LEFT JOIN users b ON b.id = m.by_user_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE 1=1${activeCompanySql(c, "m.company_id")}
        ORDER BY m.changed_at DESC
        LIMIT 50`,
    ).all<{ changed_at: string; change: string; by_name: string | null; who_name: string | null }>();
    return c.json(
      res.results.map((r) => ({ at: r.changed_at, by: r.by_name ?? "Someone", who: r.who_name ?? "a member", change: r.change })),
    );
  } catch {
    return c.json([]);
  }
});

export default app;
