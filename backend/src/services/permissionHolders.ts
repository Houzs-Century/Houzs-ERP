// ─────────────────────────────────────────────────────────────────────────
// permissionHolders.ts — the reverse of a permission check: "WHO holds this
// key?", answered as a list of public.users ids.
//
// Every gate in the app asks the forward question (does THIS caller hold the
// key — services/permissions.ts + scm/lib/houzs-perms.ts). A notification has
// to ask it backwards: an SO amendment lands in the queue of whoever can sign
// the lane, and nobody knows who that is until we look it up.
//
// WHERE PERMISSIONS LIVE. `roles.permissions` is a TEXT column holding a JSON
// array of flat keys (mig 001; the two-lane grants in mig 0216/0225 union into
// the same array). `users.role_id` points at one role. That is the whole model
// — hydrateAuthUser reads exactly this and adds nothing per-user, so a role
// scan IS the audience.
//
// THE WILDCARD IS DELIBERATELY EXCLUDED. Owner / IT Admin carry '["*"]', and a
// position-tier super admin gets '*' injected at hydration. They CAN approve
// anything, so a literal reading would put them on every amendment notice ever
// raised — which is how a notification channel becomes something people mute.
// This helper answers "whose desk is this on", not "who is technically able".
// Wildcard holders still see every amendment in the module itself.
// ─────────────────────────────────────────────────────────────────────────

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
  const roleRows = await env.DB.prepare(
    `SELECT id, permissions FROM roles`,
  ).all<{ id: number; permissions: string | null }>();
  const roleIds = roleRows.results
    .filter((r) => parsePermissions(r.permissions).includes(permKey))
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n) && n > 0);
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

  const companyId = Number(opts?.companyId);
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
