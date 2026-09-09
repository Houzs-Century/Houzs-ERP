// ─────────────────────────────────────────────────────────────────────────
// cancelRequestNotify.ts — in-app notices for the SO / PO cancellation
// approval (two signatures before a document may be cancelled).
//
// Owner 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」. A
// request that nobody is told about waits for somebody to open the inbox by
// chance; the approver is the one person who has to act, so they are the one
// person told. SAME DELIVERY MODEL AS amendmentNotify — a PRIVATE announcement
// per audience (postPersonalNotice) on the bell's system slice and its red
// unread count. No new table, no push, no email.
//
// WHO GETS WHAT:
//   raised    → the level-1 approvers for that document type
//   level1    → the level-2 approvers (level 1 has signed)
//   approved  → the person who raised it (both signatures are on it; the
//               cancel runs now)
//   rejected  → the person who raised it, with the approver's reason
// Nobody is notified of their OWN action. Withdraw stays silent, as it does
// for amendments.
//
// The permission keys are LITERALS here, not imported from
// scm/shared/document-cancel.ts — a Houzs-side service must not pull the SCM
// bundle in. cancelRequestNotify.test.ts asserts the two tables agree, so the
// desk that is notified is always the desk that can sign.
//
// NEVER THROWS. A notify failure must not fail the request write behind it.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { usersHoldingPermission } from "./permissionHolders";
import { postPersonalNotice } from "./personalNotice";

const SOURCE = "document_cancel";

export type CancelNotifyDocType = "SO" | "PO";
export type CancelNotifyEvent = "raised" | "level1" | "approved" | "rejected";

/** MUST match scm/shared/document-cancel.ts CANCEL_APPROVE_KEY. A Sales Order
 *  takes two signatures, a Purchase Order one (owner 2026-09-08) — so the PO
 *  has no level-2 desk to tell. */
export const CANCEL_APPROVE_PERM: Record<CancelNotifyDocType, Partial<Record<1 | 2, string>>> = {
  SO: { 1: "scm.so_cancel.approve_l1", 2: "scm.so_cancel.approve_l2" },
  PO: { 1: "scm.po_cancel.approve" },
};

const NOUN: Record<CancelNotifyDocType, string> = { SO: "Sales Order", PO: "Purchase Order" };

const cleanIds = (ids: Array<number | null | undefined>): number[] =>
  Array.from(new Set(ids.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)));

/** Free text flattened and clipped so a paste cannot swamp the card. */
function shortReason(reason: string | null | undefined): string {
  const r = (reason ?? "").replace(/\s+/g, " ").trim();
  if (!r) return "";
  return r.length > 200 ? `${r.slice(0, 199)}…` : r;
}

export type CancelNotifyOpts = {
  docType: CancelNotifyDocType;
  docNumber: string;
  reason?: string | null;
  companyId?: number | string | null;
  /** users.id of the person who raised the request. */
  requesterUserId?: number | null;
  requesterName?: string | null;
  /** users.id of whoever performed THIS step — excluded from every audience. */
  actorUserId?: number | null;
  actorName?: string | null;
};

export async function notifyCancelRequest(env: Env, event: CancelNotifyEvent, opts: CancelNotifyOpts): Promise<void> {
  try {
    const noun = NOUN[opts.docType];
    const actor = Number(opts.actorUserId) || 0;
    const reason = shortReason(opts.reason);
    const tail = reason ? ` Reason: ${reason}` : "";
    const by = (opts.actorName ?? "").trim();
    const byText = by ? ` by ${by}` : "";

    if (event === "raised" || event === "level1") {
      const level = event === "raised" ? 1 : 2;
      const perm = CANCEL_APPROVE_PERM[opts.docType][level];
      if (!perm) return; // this document has no such level — nobody to tell
      const twoLevels = CANCEL_APPROVE_PERM[opts.docType][2] != null;
      const approvers = await usersHoldingPermission(env, perm, { companyId: opts.companyId ?? null });
      const audience = cleanIds(approvers).filter((id) => id !== actor);
      if (audience.length === 0) return;
      const raisedBy = (opts.requesterName ?? "").trim();
      const levelWord = twoLevels ? `level-${level} ` : "";
      await postPersonalNotice(env, {
        userIds: audience,
        category: "GENERAL",
        title: `${noun} ${opts.docNumber} — cancellation needs ${levelWord}approval`,
        body:
          level === 1
            ? `A request to cancel ${noun} ${opts.docNumber} was raised${raisedBy ? ` by ${raisedBy}` : ""} and is waiting for your ${levelWord}approval.${tail}`
            : `Level 1 has approved cancelling ${noun} ${opts.docNumber}${byText}. It is now waiting for your level-2 approval.${tail}`,
        source: SOURCE,
      });
      return;
    }

    const requester = Number(opts.requesterUserId) || 0;
    if (requester <= 0 || requester === actor) return;
    await postPersonalNotice(env, {
      userIds: [requester],
      category: "GENERAL",
      title:
        event === "approved"
          ? `${noun} ${opts.docNumber} — cancellation approved`
          : `${noun} ${opts.docNumber} — cancellation rejected`,
      body:
        event === "approved"
          ? `${CANCEL_APPROVE_PERM[opts.docType][2] != null ? "Both approvals are" : "The approval is"} on your request to cancel ${noun} ${opts.docNumber}${byText}. The document is being cancelled.`
          : `Your request to cancel ${noun} ${opts.docNumber} was rejected${byText}.${tail}`,
      source: SOURCE,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[cancelRequestNotify] notify failed:", err);
  }
}
