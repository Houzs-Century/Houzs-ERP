// Mail Center personal mail (DEV-03 / PRD T-011 P3). Mounted at
// /api/mail-center next to the main router.
//   GET  /visibility              what the caller may read and send from (R12)
//   GET  /mail-host/pending       personal addresses not yet added in Google (R2)
//   POST /mail-host/:id/confirm   an admin marks one as added
//   GET  /directory               the org-chart recipient picker (P4, A5)
//   GET  /claim                   what the caller may claim (HC-0157 A)
//   POST /claim                   the caller claims their own address
import { Hono } from "hono";
import type { Env } from "../types";
import { activeCompanyId, activeCompanySql } from "../scm/lib/companyScope";
import { loadRoster, type RosterUser } from "../lib/announcementAudience";
import {
  AliasMailboxCollisionError,
  changePersonalMailboxAliasAtomically,
  companyMailboxDomain,
  freePersonalAddress,
  isPersonalAddressTaken,
  markMailHostPending,
} from "../lib/mail-provision";
import { subtreeUserIds, uplineChainSteps } from "../services/orgScope";
import { hasPermission } from "../services/permissions";
import { getMailScope, isMailAdmin, ownAliasFor } from "./mail-center";

const app = new Hono<{ Bindings: Env }>();

type Reach = "own" | "granted" | "department" | "company";

type DirectoryEntry = {
  key: string;
  userId: number | null;
  name: string;
  email: string;
  position: string;
  department: string;
};

// Same roster and reporting line as the org chart and announcements, so the
// picker never disagrees with them about who reports to whom.
app.get("/directory", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user.permissions_set, "mail_center.read")) {
    return c.json({ error: "You do not have access to Mail Center." }, 403);
  }
  const me = Number(c.get("userId") ?? NaN);
  const company = Number(activeCompanyId(c));
  const roster = await loadRoster(c.env, Number.isInteger(company) && company > 0 ? [company] : []);
  const byId = new Map(roster.map((u) => [u.id, u]));

  const boxes = await c.env.DB.prepare(
    `SELECT address, label, assigned_user_id, department_id FROM email_addresses
      WHERE active = 1${activeCompanySql(c)}
      ORDER BY lower(address)`,
  ).all<{
    address: string;
    label?: string | null;
    assigned_user_id?: number | null;
    assignedUserId?: number | null;
    department_id?: number | null;
    departmentId?: number | null;
  }>();
  const mailboxOf = new Map<number, string>();
  const sharedByDept = new Map<number, Array<{ address: string; label: string }>>();
  for (const b of boxes.results) {
    const uid = b.assignedUserId ?? b.assigned_user_id ?? null;
    if (uid != null) {
      if (!mailboxOf.has(Number(uid))) mailboxOf.set(Number(uid), b.address.toLowerCase());
      continue;
    }
    const deptRaw = b.departmentId ?? b.department_id ?? null;
    if (deptRaw == null) continue;
    const dept = Number(deptRaw);
    const list = sharedByDept.get(dept) ?? [];
    list.push({ address: b.address.toLowerCase(), label: (b.label ?? "").trim() });
    sharedByDept.set(dept, list);
  }

  const entry = (u: RosterUser): DirectoryEntry | null => {
    const email = mailboxOf.get(u.id) ?? u.email.trim().toLowerCase();
    if (!email) return null;
    return {
      key: `user:${u.id}`,
      userId: u.id,
      name: u.name || email,
      email,
      position: u.positionName ?? "",
      department: u.departmentName ?? "",
    };
  };
  const entries = (ids: Iterable<number>): DirectoryEntry[] => {
    const out: DirectoryEntry[] = [];
    for (const id of ids) {
      const u = id === me ? undefined : byId.get(id);
      const e = u ? entry(u) : null;
      if (e) out.push(e);
    }
    return out;
  };
  const byName = (a: DirectoryEntry, b: DirectoryEntry) => a.name.localeCompare(b.name);

  const self = byId.get(me) ?? null;
  const department: DirectoryEntry[] = [];
  const team: DirectoryEntry[] = [];
  let managers: DirectoryEntry[] = [];
  if (self) {
    const deptId = self.departmentId;
    if (deptId != null) {
      department.push(...entries(roster.filter((u) => u.departmentId === deptId).map((u) => u.id)));
      for (const box of sharedByDept.get(Number(deptId)) ?? []) {
        department.push({
          key: `mailbox:${box.address}`,
          userId: null,
          name: box.label || box.address,
          email: box.address,
          position: "Shared mailbox",
          department: self.departmentName ?? "",
        });
      }
    }
    // My team: everyone under me, plus the people who share my manager.
    const teamIds = new Set(await subtreeUserIds(c.env, me));
    if (self.managerId != null) {
      for (const u of roster) if (u.managerId === self.managerId) teamIds.add(u.id);
    }
    team.push(...entries(teamIds));
    managers = entries((await uplineChainSteps(c.env, me)).map((s) => s.userId));
  }
  const everyone = entries(roster.map((u) => u.id));
  department.sort(byName);
  team.sort(byName);
  everyone.sort(byName);

  c.header("Cache-Control", "no-store");
  return c.json({ me: self ? entry(self) : null, department, team, managers, everyone });
});

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

// HC-0157 A: a member with no company address claims one themselves, once.
// Changing it afterwards stays an admin action on the member screen. The
// department is only a request when the Org Chart has none for them yet: a
// department opens that department's mailboxes, so an admin applies it.
const LOCAL_PART_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

type ClaimCaller = {
  name: string | null;
  email_alias: string | null;
  department_id: number | null;
  department_name: string | null;
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
  c.header("Cache-Control", "no-store");
  return c.json({
    domain,
    address: alias.endsWith(`@${domain}`) ? alias : null,
    suggestion: (await freePersonalAddress(c.env, userId, me.name))?.split("@")[0] ?? "",
    department: me.department_id == null ? null : { id: Number(me.department_id), name: me.department_name ?? "" },
    departments: departments.results.map((d) => ({ id: Number(d.id), name: d.name })),
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

  if (await isPersonalAddressTaken(c.env.DB, address, userId)) {
    return c.json({ error: `${address} is already taken. Try another.` }, 409);
  }
  let change;
  try {
    change = await changePersonalMailboxAliasAtomically(c.env, userId, me.email_alias, address, me.name);
  } catch (e) {
    if (e instanceof AliasMailboxCollisionError) {
      return c.json({ error: `${address} is already taken. Try another.` }, 409);
    }
    throw e;
  }
  if (change?.mailbox_id) {
    await markMailHostPending(c.env.DB, change.mailbox_id);
    if (requestedDepartmentId != null) {
      await c.env.DB.prepare(`UPDATE email_addresses SET requested_department_id = ? WHERE id = ?`)
        .bind(requestedDepartmentId, change.mailbox_id)
        .run();
    }
  }
  return c.json({ ok: true, address, requestedDepartmentId }, 201);
});

app.get("/mail-host/pending", async (c) => {
  if (!isMailAdmin(c.get("user"))) return c.json({ error: "Mail Center admins only." }, 403);
  const res = await c.env.DB.prepare(
    `SELECT a.id, a.address, a.label, a.assigned_user_id, a.assigned_user_name, a.created_at,
            a.requested_department_id, rd.name AS requested_department_name,
            u.department_id AS user_department_id
       FROM email_addresses a
       LEFT JOIN departments rd ON rd.id = a.requested_department_id
       LEFT JOIN users u ON u.id = a.assigned_user_id
      WHERE a.mail_host_status = 'pending' AND a.active = 1${activeCompanySql(c, "a.company_id")}
      ORDER BY a.created_at ASC`,
  ).all<{
    id: string;
    address: string;
    label: string | null;
    assigned_user_id: number | null;
    assigned_user_name: string | null;
    created_at: string | null;
    requested_department_id: number | null;
    requested_department_name: string | null;
    user_department_id: number | null;
  }>();
  return c.json(
    res.results.map((r) => ({
      id: r.id,
      address: r.address,
      name: r.assigned_user_name ?? r.label ?? "",
      createdAt: r.created_at,
      userId: r.assigned_user_id,
      // Only while the person still has no department: once someone sets one,
      // the request is moot.
      requestedDepartment:
        r.requested_department_id != null && r.user_department_id == null
          ? { id: Number(r.requested_department_id), name: r.requested_department_name ?? "" }
          : null,
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
