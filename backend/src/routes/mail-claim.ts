// Claiming a company address (HC-0157 A), now behind an admin's approval
// (owner 2026-11-24). Every address is a free alias of hello@ in Google
// Workspace, and an account holds a limited number of them, so a claim is a
// request until a Mail Center admin approves it; only then is the mailbox made
// and the person can send from it. Mounted at /api/mail-center.
//   GET  /claim                          what the caller may claim, and their latest request
//   POST /claim                          the caller asks for an address
//   GET  /mail-host/requests             admins: open requests and aliases used / limit
//   POST /mail-host/requests/:id/approve admins: make the mailbox (refused at the limit)
//   POST /mail-host/requests/:id/reject  admins: refuse, with a reason
//   GET  /mail-host/to-remove            admins: turned off here, still an alias in Google
//   POST /mail-host/:id/removed          admins: mark the Google alias deleted
// mail_host_status 'removed' = the alias is gone from Google. If such an address is
// turned back on it is waiting to be added again (mail-personal.ts lists it).
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { activeCompanyId, activeCompanySql } from "../scm/lib/companyScope";
import {
  AliasMailboxCollisionError,
  changePersonalMailboxAliasAtomically,
  companyMailboxDomain,
  freePersonalAddress,
  isPersonalAddressTaken,
  markMailHostPending,
} from "../lib/mail-provision";
import { hasPermission } from "../services/permissions";
import { isMailAdmin } from "./mail-center";

const app = new Hono<{ Bindings: Env }>();
type Ctx = Context<{ Bindings: Env }>;

const LOCAL_PART_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
/** Aliases one Google Workspace account takes; app_settings.mail_alias_limit overrides it. */
export const DEFAULT_ALIAS_LIMIT = 50;
const ADMINS_ONLY = "Mail Center admins only.";

type ClaimCaller = {
  name: string | null;
  email_alias: string | null;
  department_id: number | null;
  department_name: string | null;
};

type RequestRow = {
  id: string;
  user_id: number;
  address: string;
  requested_department_id: number | null;
  status: string;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
};

async function claimCaller(c: { env: Env }, userId: number): Promise<ClaimCaller | null> {
  return c.env.DB.prepare(
    `SELECT u.name, u.email_alias, u.department_id, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<ClaimCaller>();
}

/** How many aliases the company's addresses take in Google, and the ceiling: every
 *  active address, plus a turned-off one whose alias nobody has deleted from Google
 *  yet. The primary hello@ is the account itself, not an alias. */
export async function aliasUsage(c: Ctx): Promise<{ used: number; limit: number }> {
  const domain = await companyMailboxDomain(c.env);
  // company-scope: the active-company predicate narrows the count to this company's addresses.
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM email_addresses
      WHERE lower(address) LIKE ? AND lower(address) <> ?
        AND (active = 1 OR mail_host_status IS NULL OR mail_host_status = 'live')${activeCompanySql(c)}`,
  )
    .bind(`%@${domain}`, `hello@${domain}`)
    .first<{ n: number }>();
  const setting = await c.env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'mail_alias_limit'`).first<{ value: string | null }>();
  const configured = Number(setting?.value ?? NaN);
  return { used: Number(row?.n ?? 0), limit: Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_ALIAS_LIMIT };
}

async function requestedByAnother(c: Ctx, address: string, userId: number): Promise<boolean> {
  // company-scope: the active-company predicate on the request rows.
  const row = await c.env.DB
    .prepare(`SELECT 1 AS x FROM mail_address_requests WHERE lower(address) = ? AND status = 'requested' AND user_id <> ?${activeCompanySql(c)} LIMIT 1`)
    .bind(address, userId)
    .first();
  return row != null;
}

app.get("/claim", async (c) => {
  if (!hasPermission(c.get("user").permissions_set, "mail_center.read")) {
    return c.json({ error: "You do not have access to Mail Center." }, 403);
  }
  const userId = Number(c.get("userId"));
  const me = await claimCaller(c, userId);
  if (!me) return c.json({ error: "Account not found." }, 404);
  const domain = await companyMailboxDomain(c.env);
  const alias = (me.email_alias ?? "").trim().toLowerCase();
  const departments = await c.env.DB.prepare(`SELECT id, name FROM departments ORDER BY sort_order, name`).all<{
    id: number;
    name: string;
  }>();
  const latest = await c.env.DB.prepare(
    `SELECT id, address, status, reason, created_at, decided_at FROM mail_address_requests
      WHERE user_id = ?${activeCompanySql(c)} ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<Pick<RequestRow, "id" | "address" | "status" | "reason" | "created_at" | "decided_at">>();
  c.header("Cache-Control", "no-store");
  return c.json({
    domain,
    address: alias.endsWith(`@${domain}`) ? alias : null,
    suggestion: (await freePersonalAddress(c.env, userId, me.name))?.split("@")[0] ?? "",
    department: me.department_id == null ? null : { id: Number(me.department_id), name: me.department_name ?? "" },
    departments: departments.results.map((d) => ({ id: Number(d.id), name: d.name })),
    request: latest
      ? { id: latest.id, address: latest.address, status: latest.status, reason: latest.reason, createdAt: latest.created_at, decidedAt: latest.decided_at }
      : null,
  });
});

app.post("/claim", async (c) => {
  if (!hasPermission(c.get("user").permissions_set, "mail_center.read")) {
    return c.json({ error: "You do not have access to Mail Center." }, 403);
  }
  const userId = Number(c.get("userId"));
  const body = await c.req
    .json<{ localPart?: string; departmentId?: number | null }>()
    .catch(() => ({}) as { localPart?: string; departmentId?: number | null });
  const me = await claimCaller(c, userId);
  if (!me) return c.json({ error: "Account not found." }, 404);
  const domain = await companyMailboxDomain(c.env);
  const current = (me.email_alias ?? "").trim().toLowerCase();
  if (current.endsWith(`@${domain}`)) {
    return c.json({ error: `You already have ${current}. Ask an admin to change it.` }, 409);
  }
  const open = await c.env.DB.prepare(`SELECT address FROM mail_address_requests WHERE user_id = ? AND status = 'requested'${activeCompanySql(c)} LIMIT 1`)
    .bind(userId)
    .first<{ address: string }>();
  if (open) return c.json({ error: `You already asked for ${open.address}. An admin will approve it.` }, 409);

  const local = (body.localPart ?? "").trim().toLowerCase();
  if (local.length < 2 || local.length > 40 || !LOCAL_PART_RE.test(local)) {
    return c.json(
      { error: "Use 2 to 40 letters or digits, with single dots, dashes or underscores between them." },
      400,
    );
  }
  const address = `${local}@${domain}`;

  let requestedDepartmentId: number | null = null;
  if (me.department_id == null) {
    if (body.departmentId == null) return c.json({ error: "Pick the department you work in." }, 400);
    const dept = await c.env.DB.prepare(`SELECT id FROM departments WHERE id = ? LIMIT 1`)
      .bind(Number(body.departmentId))
      .first<{ id: number }>();
    if (!dept) return c.json({ error: "That department no longer exists." }, 400);
    requestedDepartmentId = Number(dept.id);
  }

  if ((await isPersonalAddressTaken(c.env.DB, address, userId)) || (await requestedByAnother(c, address, userId))) {
    return c.json({ error: `${address} is already taken. Try another.` }, 409);
  }
  await c.env.DB.prepare(
    `INSERT INTO mail_address_requests (id, company_id, user_id, address, requested_department_id, status, created_at)
     VALUES (?, COALESCE(?, 1), ?, ?, ?, 'requested', ?)`,
  )
    .bind(crypto.randomUUID(), activeCompanyId(c) ?? null, userId, address, requestedDepartmentId, new Date().toISOString())
    .run();
  return c.json({ ok: true, address, status: "requested", requestedDepartmentId }, 201);
});

app.get("/mail-host/requests", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: ADMINS_ONLY }, 403);
  // company-scope: the active-company predicate on the request rows.
  const res = await c.env.DB.prepare(
    `SELECT r.id, r.user_id, r.address, r.created_at, r.requested_department_id,
            u.name AS user_name, d.name AS department_name, rd.name AS requested_department_name
       FROM mail_address_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN departments rd ON rd.id = r.requested_department_id
      WHERE r.status = 'requested'${activeCompanySql(c, "r.company_id")}
      ORDER BY r.created_at ASC`,
  ).all<{
    id: string;
    user_id: number;
    address: string;
    created_at: string;
    requested_department_id: number | null;
    user_name: string | null;
    department_name: string | null;
    requested_department_name: string | null;
  }>();
  c.header("Cache-Control", "no-store");
  return c.json({
    usage: await aliasUsage(c),
    requests: res.results.map((r) => ({
      id: r.id,
      userId: Number(r.user_id),
      name: r.user_name ?? "",
      address: r.address,
      createdAt: r.created_at,
      department: r.department_name ?? r.requested_department_name ?? null,
    })),
  });
});

async function openRequest(c: Ctx, id: string): Promise<RequestRow | null> {
  // company-scope: by id, narrowed to the active company.
  return c.env.DB.prepare(
    `SELECT id, user_id, address, requested_department_id, status, reason, created_at, decided_at
       FROM mail_address_requests WHERE id = ? AND status = 'requested'${activeCompanySql(c)}`,
  )
    .bind(id)
    .first<RequestRow>();
}

async function decide(c: Ctx, id: string, status: "approved" | "rejected", reason: string | null): Promise<void> {
  // company-scope: the row was read above under the active-company predicate; repeat it on the write.
  await c.env.DB.prepare(
    `UPDATE mail_address_requests SET status = ?, reason = ?, decided_by = ?, decided_at = ?
      WHERE id = ? AND status = 'requested'${activeCompanySql(c)}`,
  )
    .bind(status, reason, c.get("userId") ?? null, new Date().toISOString(), id)
    .run();
}

app.post("/mail-host/requests/:id/approve", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: ADMINS_ONLY }, 403);
  const req = await openRequest(c, c.req.param("id"));
  if (!req) return c.json({ error: "That request is no longer waiting." }, 404);
  const usage = await aliasUsage(c);
  if (usage.used >= usage.limit) {
    return c.json(
      { error: `All ${usage.limit} Google aliases are in use. Turn off an address nobody uses, then approve again.` },
      409,
    );
  }
  const me = await claimCaller(c, req.user_id);
  if (!me) return c.json({ error: "That person no longer exists." }, 404);
  const domain = await companyMailboxDomain(c.env);
  const current = (me.email_alias ?? "").trim().toLowerCase();
  if (current.endsWith(`@${domain}`)) {
    return c.json({ error: `${me.name ?? "This person"} already has ${current}. Reject this request.` }, 409);
  }
  if (await isPersonalAddressTaken(c.env.DB, req.address, req.user_id)) {
    return c.json({ error: `${req.address} was taken meanwhile. Reject this request so they can pick another.` }, 409);
  }
  let change;
  try {
    change = await changePersonalMailboxAliasAtomically(c.env, req.user_id, me.email_alias, req.address, me.name);
  } catch (e) {
    if (e instanceof AliasMailboxCollisionError) {
      return c.json({ error: `${req.address} was taken meanwhile. Reject this request so they can pick another.` }, 409);
    }
    throw e;
  }
  if (change?.mailbox_id) {
    await markMailHostPending(c.env.DB, change.mailbox_id);
    if (req.requested_department_id != null) {
      // company-scope: the id is the mailbox this approval just provisioned.
      await c.env.DB.prepare(`UPDATE email_addresses SET requested_department_id = ? WHERE id = ?`)
        .bind(req.requested_department_id, change.mailbox_id)
        .run();
    }
  }
  await decide(c, req.id, "approved", null);
  return c.json({ ok: true, address: req.address });
});

app.post("/mail-host/requests/:id/reject", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: ADMINS_ONLY }, 403);
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const reason = (body.reason ?? "").trim().slice(0, 300);
  if (!reason) return c.json({ error: "Say why, so they know what to pick instead." }, 400);
  const req = await openRequest(c, c.req.param("id"));
  if (!req) return c.json({ error: "That request is no longer waiting." }, 404);
  await decide(c, req.id, "rejected", reason);
  return c.json({ ok: true });
});

app.get("/mail-host/to-remove", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: ADMINS_ONLY }, 403);
  const domain = await companyMailboxDomain(c.env);
  // company-scope: the active-company predicate on the mailbox rows.
  const res = await c.env.DB.prepare(
    `SELECT a.id, a.address, COALESCE(a.assigned_user_name, a.label) AS name, u.status AS user_status
       FROM email_addresses a LEFT JOIN users u ON u.id = a.assigned_user_id
      WHERE a.active = 0 AND (a.mail_host_status IS NULL OR a.mail_host_status = 'live')
        AND lower(a.address) LIKE ? AND lower(a.address) <> ?${activeCompanySql(c, "a.company_id")}
      ORDER BY a.address`,
  )
    .bind(`%@${domain}`, `hello@${domain}`)
    .all<{ id: string; address: string; name: string | null; user_status: string | null }>();
  c.header("Cache-Control", "no-store");
  return c.json(
    res.results.map((r) => ({ id: r.id, address: r.address, name: r.name ?? "", personLeft: r.user_status != null && r.user_status !== "active" })),
  );
});

app.post("/mail-host/:id/removed", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: ADMINS_ONLY }, 403);
  // company-scope: by id, narrowed to the active company.
  const res = await c.env.DB.prepare(
    `UPDATE email_addresses SET mail_host_status = 'removed', mail_host_confirmed_at = ?, mail_host_confirmed_by = ?
      WHERE id = ? AND active = 0 AND (mail_host_status IS NULL OR mail_host_status = 'live')${activeCompanySql(c)}`,
  )
    .bind(new Date().toISOString(), c.get("userId") ?? null, c.req.param("id"))
    .run();
  if (Number(res.meta.changes) === 0) return c.json({ error: "That address is not waiting to be removed from Google." }, 404);
  return c.json({ ok: true });
});

export default app;
