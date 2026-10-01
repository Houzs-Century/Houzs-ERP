// ─────────────────────────────────────────────────────────────────────────
// backdateRequestNotify.ts — in-app notices for SO payment backdate requests
// (a slip older than 14 days, keyed as a request an admin approves).
//
// Owner 2026-09-30: 「要加提醒, sidebar 红点 + 通知 admin」, and on who the admin
// is: Owner + Super Admin + Finance, then Logistic. So the audience is every
// active holder of `scm.payment.backdate` (Finance), of the approve-only
// `scm.payment.backdate.approve` (Logistic), AND every `*` holder.
// That second half is a deliberate exception to the literal-keys-only rule the
// amendment and cancellation notices follow (owner 2026-09-09): for THIS queue
// the owner named the wildcard roles as the approvers.
//
// WHO GETS WHAT:
//   raised    → the admins
//   approved  → the requester (the payment is now recorded)
//   rejected  → the requester, with the admin's reason
// Nobody is notified of their own action; a withdrawal is silent.
//
// NEVER THROWS. A notify failure must not fail the request write behind it.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { usersHoldingPermission } from "./permissionHolders";
import { postPersonalNotice } from "./personalNotice";

const SOURCE = "payment_backdate";
export const BACKDATE_ADMIN_PERM = "scm.payment.backdate";
/** Approve-only (Logistic, owner 2026-09-30). */
export const BACKDATE_APPROVE_PERM = "scm.payment.backdate.approve";

export type BackdateNotifyEvent = "raised" | "approved" | "rejected";

export type BackdateNotifyOpts = {
  docNo: string;
  /** Already formatted, e.g. "RM 1,250.00". */
  amount: string;
  slipDate: string;
  reason?: string | null;
  companyId?: number | string | null;
  requesterUserId?: number | null;
  requesterName?: string | null;
  actorUserId?: number | null;
  actorName?: string | null;
};

const clip = (s: string | null | undefined): string => {
  const r = (s ?? "").replace(/\s+/g, " ").trim();
  return r.length > 200 ? `${r.slice(0, 199)}…` : r;
};

/** Active users who may decide a backdate request — the literal key holders
 *  plus the wildcard roles (see the header). */
export async function backdateAdminIds(env: Env, companyId?: number | string | null): Promise<number[]> {
  const [literal, approveOnly, wildcard] = await Promise.all([
    usersHoldingPermission(env, BACKDATE_ADMIN_PERM, { companyId: companyId ?? null }),
    usersHoldingPermission(env, BACKDATE_APPROVE_PERM, { companyId: companyId ?? null }),
    usersHoldingPermission(env, "*", { companyId: companyId ?? null }),
  ]);
  return Array.from(new Set([...literal, ...approveOnly, ...wildcard].map(Number).filter((n) => Number.isFinite(n) && n > 0)));
}

export async function notifyBackdateRequest(env: Env, event: BackdateNotifyEvent, opts: BackdateNotifyOpts): Promise<void> {
  try {
    const actor = Number(opts.actorUserId) || 0;
    const reason = clip(opts.reason);
    const what = `${opts.amount} dated ${opts.slipDate} on ${opts.docNo}`;

    if (event === "raised") {
      const audience = (await backdateAdminIds(env, opts.companyId)).filter((id) => id !== actor);
      if (audience.length === 0) return;
      const by = (opts.requesterName ?? "").trim();
      await postPersonalNotice(env, {
        userIds: audience,
        category: "GENERAL",
        title: `${opts.docNo} — backdated payment needs approval`,
        body: `A payment of ${what} has a slip older than 14 days and was sent for approval${by ? ` by ${by}` : ""}.${reason ? ` Reason: ${reason}` : ""}`,
        source: SOURCE,
      });
      return;
    }

    const requester = Number(opts.requesterUserId) || 0;
    if (requester <= 0 || requester === actor) return;
    const by = (opts.actorName ?? "").trim();
    await postPersonalNotice(env, {
      userIds: [requester],
      category: "GENERAL",
      title: event === "approved"
        ? `${opts.docNo} — backdated payment approved`
        : `${opts.docNo} — backdated payment rejected`,
      body: event === "approved"
        ? `Your payment of ${what} was approved${by ? ` by ${by}` : ""} and is now recorded.`
        : `Your payment of ${what} was rejected${by ? ` by ${by}` : ""}.${reason ? ` Reason: ${reason}` : ""}`,
      source: SOURCE,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[backdateRequestNotify] notify failed:", err);
  }
}
