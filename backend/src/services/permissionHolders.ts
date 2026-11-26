
import type { Env } from "../types";
import { parsePermissions } from "./permissions";

/**
 * public.users ids whose ROLE grants `permKey` (wildcard roles excluded — see
 * the header), narrowed to active accounts.
 *
 * `companyId` applies the same tenant rule companyContext uses for reads: a
 * user is in scope when they hold a `user_companies` grant for that company,
 * OR when they hold NO grants at all (single-company / pre-activation, where
 * the grant table is not consulted). A user granted only the OTHER company is
 * dropped — a 2990 amendment must not ping a Houzs-only desk.
 *
 * Throws on a DB error; callers decide their own fallback (the notify service
 * swallows it — a lookup failure must never fail the business write).
 */
export async function usersHoldingPermission(
  env: Env,
  permKey: string,
  opts?: { companyId?: number | string | null },
): Promise<number[]> {
  const roles = await readRoles(env);
  return activeUsersOfRoles(env, roleIdsWhere(roles, (p) => p.includes(permKey)), opts?.companyId);
}

/**
 * The people a piece of work waits on, for a notice a PERSON sends on purpose
 * (Remind approver on a payment voucher) — the Finance To do's own rule
 * (scm/routes/accounting-todo.ts readViewer: "Nobody holds it by role here: it
 * is on whoever may do it"):
 *
 *   · the users whose role holds `permKey` literally (usersHoldingPermission);
 *   · when no active user of the company does, the wildcard roles' users —
 *     whoever may do it — so the work is never addressed to nobody.
 *
 * `byRole` says which of the two answered. The automatic notices keep
 * usersHoldingPermission and its wildcard exclusion: they fire on every event,
 * while this answers one person asking, at most once an hour per document.
 * Throws on a DB error, like usersHoldingPermission.
 */
export async function usersOnDeskFor(
  env: Env,
  permKey: string,
  opts?: { companyId?: number | string | null },
): Promise<{ userIds: number[]; byRole: boolean }> {
  const roles = await readRoles(env);
  const literal = await activeUsersOfRoles(env, roleIdsWhere(roles, (p) => p.includes(permKey)), opts?.companyId);
  if (literal.length > 0) return { userIds: literal, byRole: true };
  const anyone = await activeUsersOfRoles(env, roleIdsWhere(roles, (p) => p.includes("*")), opts?.companyId);
  return { userIds: anyone, byRole: false };
}

type RoleRow = { id: number; permissions: string | null };

async function readRoles(env: Env): Promise<RoleRow[]> {
  const roleRows = await env.DB.prepare(
    `SELECT id, permissions FROM roles`,
  ).all<RoleRow>();
  return roleRows.results;
}

function roleIdsWhere(roles: RoleRow[], test: (perms: string[]) => boolean): number[] {
  return roles
    .filter((r) => test(parsePermissions(r.permissions)))
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function activeUsersOfRoles(
  env: Env,
  roleIds: number[],
  company: number | string | null | undefined,
): Promise<number[]> {
  if (roleIds.length === 0) return [];

  const userRows = await env.DB.prepare(
    `SELECT id FROM users
      WHERE status = 'active' AND role_id IN (${roleIds.map(() => "?").join(",")})`,
  )
    .bind(...roleIds)
    .all<{ id: number }>();
  const userIds = userRows.results
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (userIds.length === 0) return [];

  const companyId = Number(company);
  if (!Number.isFinite(companyId) || companyId <= 0) return userIds;

  const grantRows = await env.DB.prepare(
    `SELECT user_id, company_id FROM user_companies
      WHERE user_id IN (${userIds.map(() => "?").join(",")})`,
  )
    .bind(...userIds)
    .all<{ user_id: number; company_id: number | string }>();
  const grantedHere = new Set<number>();
  const hasAnyGrant = new Set<number>();
  for (const g of grantRows.results) {
    const uid = Number(g.user_id);
    hasAnyGrant.add(uid);
    if (Number(g.company_id) === companyId) grantedHere.add(uid);
  }
  return userIds.filter((id) => grantedHere.has(id) || !hasAnyGrant.has(id));
}
