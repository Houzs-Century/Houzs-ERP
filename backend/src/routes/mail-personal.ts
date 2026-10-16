// Mail Center personal mail (DEV-03 / PRD T-011 P3). Mounted at
// /api/mail-center next to the main router.
//   GET  /visibility              what the caller may read and send from (R12)
//   GET  /mail-host/pending       personal addresses not yet added in Google (R2)
//   POST /mail-host/:id/confirm   an admin marks one as added
import { Hono } from "hono";
import type { Env } from "../types";
import { activeCompanySql } from "../scm/lib/companyScope";
import { getMailScope, isMailAdmin, ownAliasFor } from "./mail-center";

const app = new Hono<{ Bindings: Env }>();

type Reach = "own" | "granted" | "department" | "company";

app.get("/visibility", async (c) => {
  const scope = await getMailScope(c);
  const me = scope.userId ?? 0;
  const alias = await ownAliasFor(c);
  let rows: Array<{ address: string; label: string | null; assigned_user_id: number | null; granted: number }> = [];
  if (scope.addresses.length > 0) {
    const ph = scope.addresses.map(() => "?").join(", ");
    // company-scope: scope.addresses already come from the active company; the predicate repeats it.
    const res = await c.env.DB.prepare(
      `SELECT a.address, a.label, a.assigned_user_id,
              CASE WHEN EXISTS (SELECT 1 FROM email_address_access g WHERE g.address_id = a.id AND g.user_id = ?) THEN 1 ELSE 0 END AS granted
         FROM email_addresses a
        WHERE a.active = 1 AND lower(a.address) IN (${ph})${activeCompanySql(c, "a.company_id")}
        ORDER BY lower(a.address)`,
    )
      .bind(me, ...scope.addresses)
      .all<{ address: string; label: string | null; assigned_user_id: number | null; granted: number }>();
    rows = res.results;
  }
  const reach = (r: (typeof rows)[number]): Reach =>
    Number(r.assigned_user_id) === me ? "own" : Number(r.granted) === 1 ? "granted" : scope.level === "company" ? "company" : "department";
  const mailboxes = rows.map((r) => ({ address: r.address.toLowerCase(), label: r.label ?? "", reach: reach(r) }));
  const order: Record<Reach, number> = { own: 0, granted: 1, department: 2, company: 3 };
  mailboxes.sort((a, b) => order[a.reach] - order[b.reach] || a.address.localeCompare(b.address));
  const sendFrom = [...new Set([...(alias ? [alias] : []), ...mailboxes.map((m) => m.address)])];
  return c.json({
    level: scope.level,
    manage: isMailAdmin(c.get("user")),
    myAddress: mailboxes.find((m) => m.reach === "own")?.address ?? (alias || null),
    mailboxes,
    sendFrom,
  });
});

app.get("/mail-host/pending", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: "Mail Center admins only." }, 403);
  const res = await c.env.DB.prepare(
    `SELECT id, address, label, assigned_user_name, created_at FROM email_addresses
      WHERE mail_host_status = 'pending' AND active = 1${activeCompanySql(c)}
      ORDER BY created_at ASC`,
  ).all<{ id: string; address: string; label: string | null; assigned_user_name: string | null; created_at: string | null }>();
  return c.json(
    res.results.map((r) => ({
      id: r.id,
      address: r.address,
      name: r.assigned_user_name ?? r.label ?? "",
      createdAt: r.created_at,
    })),
  );
});

app.post("/mail-host/:id/confirm", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: "Mail Center admins only." }, 403);
  const res = await c.env.DB.prepare(
    `UPDATE email_addresses SET mail_host_status = 'live', mail_host_confirmed_at = ?, mail_host_confirmed_by = ?
      WHERE id = ? AND mail_host_status = 'pending'${activeCompanySql(c)}`,
  )
    .bind(new Date().toISOString(), c.get("userId") ?? null, c.req.param("id"))
    .run();
  if (Number(res.meta.changes) === 0) return c.json({ error: "That address is not waiting to be added." }, 404);
  return c.json({ ok: true });
});

export default app;
