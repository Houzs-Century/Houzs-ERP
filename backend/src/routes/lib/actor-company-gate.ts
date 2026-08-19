import type { Context } from "hono";
import type { Env } from "../../types";
import { allowedCompanyIds } from "../../scm/lib/companyScope";

/**
 * Owner decision 2026-08-19: the ACTOR's granted companies are the boundary on
 * any route that hands the caller control of someone else's account, never the
 * active company. Reasoning and the two deliberate edge cases live in
 * docs/modules/team-members.md, "Taking over an account".
 *
 * The rule is the one PUT /users/:id/companies already enforces — a grantor can
 * only ever pass on what they hold — so the target's companies must be a SUBSET
 * of the actor's.
 */
export async function targetWithinActorCompanies(
  c: Context<{ Bindings: Env }>,
  targetUserId: number,
): Promise<{ ok: true } | { ok: false; body: { error: string; message: string } }> {
  const mine = allowedCompanyIds(c);
  if (mine === undefined) return { ok: true }; // context unreadable — degrade
  const r = await c.env.DB.prepare(
    `SELECT company_id FROM user_companies WHERE user_id = ?`,
  )
    .bind(targetUserId)
    .all<{ company_id: number | string }>();
  const theirs = (r.results ?? [])
    .map((x) => Number(x.company_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  // A target with NO grants is the WIDEST reach, not the safest — see the guide.
  const held = new Set(mine);
  const outside = theirs.length === 0 ? [-1] : theirs.filter((cid) => !held.has(cid));
  if (outside.length === 0) return { ok: true };
  return {
    ok: false,
    body: {
      error: "not_in_your_companies",
      message:
        "That account belongs to a company you are not assigned to. Ask someone who holds it, or have your own access extended first.",
    },
  };
}
