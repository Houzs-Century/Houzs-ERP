// ----------------------------------------------------------------------------
// salesAttending — who the PMS "Sales Attending" picker may add, beyond the
// Sales Team roster (owner 2026-10-19: 「不需要改部门啊，就让他们可以去 sales
// attending 不就好了？」).
//
// The picker lists the sales_reps roster, which is made automatically only for
// Sales-department logins (services/salesTeam.ts syncSalesRepFromUser). Staff in
// other departments who stand at fairs — Lim (Management), Nancy and Syasya
// (Operation) on 2026-10-19 — could never be picked, so the orders they key
// could never be matched to a fair. These helpers offer them, and put a picked
// one on the roster (ensureSalesRepForUser) without touching their department.
//
// "Of this company" = granted the active company in user_companies, or granted
// no company at all (logins older than per-company grants).
// ----------------------------------------------------------------------------

import type { Env } from "../types";
import { ensureSalesRepForUser } from "./salesTeam";

export type StaffNotOnRoster = { user_id: number; name: string | null; email: string };

const OF_THIS_COMPANY = `(EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id AND uc.company_id = ?)
       OR NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id))`;

/**
 * Active staff of the company who are NOT on the roster, A–Z. A failed read
 * costs only this list — the picker still shows the roster — so it answers []
 * and says why in the log.
 */
export async function staffNotOnRoster(env: Env, companyId: number | null | undefined): Promise<StaffNotOnRoster[]> {
  try {
    const res = await env.DB.prepare(
      `SELECT u.id AS user_id, u.name, u.email
         FROM users u
        WHERE LOWER(COALESCE(u.status, '')) = 'active'
          AND NOT EXISTS (SELECT 1 FROM sales_reps r
                           WHERE r.user_id = u.id AND r.archived_at IS NULL AND r.status = 'active')${companyId != null ? `
          AND ${OF_THIS_COMPANY}` : ""}
        ORDER BY LOWER(COALESCE(u.name, u.email))`,
    ).bind(...(companyId != null ? [companyId] : [])).all<StaffNotOnRoster>();
    return res.results ?? [];
  } catch (e) {
    console.error("[sales-attending] staff not on the roster could not be read", e);
    return [];
  }
}

/**
 * The roster id a POST /projects/:id/sales-attendees body names: `sales_rep_id`
 * as before, or `user_id` for a staff member not on the roster yet — who is put
 * on it here. Refuses a login that is not active or not of this company.
 */
export async function attendeeRepId(
  env: Env,
  companyId: number | null | undefined,
  body: { sales_rep_id?: unknown; user_id?: unknown } | null,
  actorId: number | null,
  projectId: number,
): Promise<{ ok: true; repId: number } | { ok: false; error: string }> {
  const repId = Number(body?.sales_rep_id);
  if (Number.isInteger(repId) && repId > 0) return { ok: true, repId };
  const userId = Number(body?.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, error: "Please choose a sales attendee." };
  if (companyId != null) {
    const grant = await env.DB.prepare(
      `SELECT ${OF_THIS_COMPANY.replace(/u\.id/g, "?")} AS ok`,
    ).bind(userId, companyId, userId).first<{ ok: boolean | number }>();
    if (!grant?.ok) return { ok: false, error: "That staff member does not work in this company." };
  }
  const ensured = await ensureSalesRepForUser(env, userId, actorId, `Added to the Sales Team from Sales Attending on project #${projectId}`);
  if (!ensured) return { ok: false, error: "That staff member is not an active user." };
  return { ok: true, repId: ensured.repId };
}
