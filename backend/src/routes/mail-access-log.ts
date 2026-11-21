// GET /api/mail-center/access/changes - who changed whose mail access, newest 50
// of the active company (owner 2026-11-21). Written by lib/mail-access.ts.
import { Hono } from "hono";
import type { Env } from "../types";
import { activeCompanyId, activeCompanySql } from "../scm/lib/companyScope";
import { recordAccessChange } from "../lib/mail-access";
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

const DENIED = "You do not have permission to manage the Mail Center.";

// GET /scope-departments - the OTHER departments ticked for L2 people (owner 2026-11-21).
// Departments are a shared master; the mailboxes they open are filtered by company in getMailScope.
app.get("/scope-departments", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: DENIED }, 403);
  c.header("Cache-Control", "no-store");
  // company-scope: users and departments are shared masters, like mail_user_scope; the mailboxes they open are company-filtered.
  const res = await c.env.DB.prepare(`SELECT user_id, department_id FROM mail_scope_departments`).all<{
    user_id: number;
    department_id: number;
  }>();
  return c.json(res.results.map((r) => ({ userId: Number(r.user_id), departmentId: Number(r.department_id) })));
});

// PUT /scope-departments {userId, departmentIds} - replace one person's ticked departments.
app.put("/scope-departments", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: DENIED }, 403);
  const body = await c.req
    .json<{ userId?: number; departmentIds?: number[] }>()
    .catch(() => ({}) as { userId?: number; departmentIds?: number[] });
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || !Array.isArray(body.departmentIds)) {
    return c.json({ error: "userId and departmentIds are required" }, 400);
  }
  const want = [...new Set(body.departmentIds.map(Number).filter((n) => Number.isInteger(n)))];
  // company-scope: per-person ticks over shared masters (see GET above).
  const before = await c.env.DB.prepare(`SELECT department_id FROM mail_scope_departments WHERE user_id = ?`)
    .bind(userId)
    .all<{ department_id: number }>();
  const have = new Set(before.results.map((r) => Number(r.department_id)));
  const added = want.filter((d) => !have.has(d));
  const removed = [...have].filter((d) => !want.includes(d));
  const me = c.get("userId") ?? null;
  for (const d of removed) {
    await c.env.DB.prepare(`DELETE FROM mail_scope_departments WHERE user_id = ? AND department_id = ?`).bind(userId, d).run();
  }
  for (const d of added) {
    await c.env.DB.prepare(
      `INSERT INTO mail_scope_departments (user_id, department_id, company_id, created_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, department_id) DO NOTHING`,
    )
      .bind(userId, d, activeCompanyId(c) ?? null, me)
      .run();
  }
  if (added.length || removed.length) {
    const ids = [...added, ...removed];
    const names = await c.env.DB.prepare(`SELECT id, name FROM departments WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .bind(...ids)
      .all<{ id: number; name: string }>();
    const name = (d: number) => names.results.find((r) => Number(r.id) === d)?.name ?? `department ${d}`;
    const parts = [
      added.length ? `opened ${added.map(name).join(", ")}` : "",
      removed.length ? `closed ${removed.map(name).join(", ")}` : "",
    ].filter(Boolean);
    await recordAccessChange(c.env.DB, { companyId: activeCompanyId(c) ?? null, byUserId: me, userId, change: parts.join("; ") });
  }
  return c.json({ ok: true, added: added.length, removed: removed.length });
});

// GET /sync-status - per active mailbox of the active company: the newest mail
// received and how many threads it holds. Only facts the ERP has: it cannot see
// a Gmail account directly, so "never" means no mail has reached the ERP yet.
app.get("/sync-status", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: DENIED }, 403);
  c.header("Cache-Control", "no-store");
  // company-scope: both reads carry the active-company predicate.
  const boxes = await c.env.DB.prepare(
    `SELECT address, mail_host_status FROM email_addresses WHERE active = 1${activeCompanySql(c)} ORDER BY address`,
  ).all<{ address: string; mail_host_status: string | null }>();
  const threads = await c.env.DB.prepare(
    `SELECT lower(mailbox_address) AS box, COUNT(*) AS n, MAX(last_inbound_at) AS last_in
       FROM email_threads WHERE 1=1${activeCompanySql(c)} GROUP BY lower(mailbox_address)`,
  ).all<{ box: string | null; n: number; last_in: string | null }>();
  const byBox = new Map(threads.results.map((r) => [r.box ?? "", r]));
  return c.json(
    boxes.results.map((b) => {
      const t = byBox.get(b.address.toLowerCase());
      return {
        address: b.address,
        pending: b.mail_host_status === "pending",
        lastInboundAt: t?.last_in ?? null,
        threads: Number(t?.n ?? 0),
      };
    }),
  );
});

export default app;
